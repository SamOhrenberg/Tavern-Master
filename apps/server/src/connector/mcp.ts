import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { q1 } from '../db/pool.js';
import { enforceLimit, rateLimiters } from '../http/security.js';
import { log } from '../log.js';
import { challengeHeader, resourceFor } from '../oauth/metadata.js';
import { SERVER_INSTRUCTIONS } from './instructions.js';
import './register.js';
import { resolveToken, type ConnectorUser } from './tokens.js';
import { connectorTools, runConnectorTool, type ConnectorCall } from './tools.js';

/** Where the connector is served. Clients are given BASE_URL + this path. */
export const CONNECTOR_PATH = '/mcp';
/** One campaign's own address. A client given it can never act on another campaign. */
export const pinnedPath = (campaignId: string) => `${CONNECTOR_PATH}/c/${campaignId}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bearer(header: string | undefined): string | undefined {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return m?.[1];
}

/** One MCP server per request: the transport is stateless, and everything lasting lives in the database. */
function buildServer(user: ConnectorUser, campaignId: string | null): Server {
  const server = new Server(
    { name: 'tavern-master', version: '0.1.0' },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: connectorTools().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as { type: 'object' },
      annotations: t.annotations,
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const call: ConnectorCall = { user, signal: extra.signal, campaignId, pinned: campaignId !== null };
    const out = await runConnectorTool(req.params.name, req.params.arguments ?? {}, call);
    return {
      content: [
        { type: 'text' as const, text: out.text },
        ...(out.images ?? []).map((i) => ({ type: 'image' as const, data: i.data, mimeType: i.mimeType })),
      ],
      isError: out.isError,
    };
  });
  return server;
}

function rpcError(reply: FastifyReply, status: number, message: string) {
  return reply.status(status).send({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });
}

/**
 * The connector: a remote MCP endpoint that lets Claude run campaigns as
 * every AI at their table. It sits outside /api, so the browser session,
 * cookie and CSRF rules do not apply; every request must carry a connector
 * token as a bearer token instead, and is rate limited like the API.
 */
export async function connectorRoutes(app: FastifyInstance): Promise<void> {
  const handle = async (req: FastifyRequest, reply: FastifyReply, campaignId: string | null) => {
    enforceLimit(rateLimiters().api, `ip:${req.ip}`);
    const path = campaignId ? pinnedPath(campaignId) : CONNECTOR_PATH;
    const user = await resolveToken(bearer(req.headers.authorization), resourceFor(path));
    if (!user) {
      // Points the client at the sign-in endpoints for this exact address.
      reply.header('WWW-Authenticate', challengeHeader(path));
      return rpcError(reply, 401, 'Sign in to Tavern Master to connect, or send a connector token.');
    }
    enforceLimit(rateLimiters().api, `connector:${user.tokenId}`);
    if (campaignId) {
      const owns =
        UUID.test(campaignId) &&
        (await q1(
          `SELECT 1 FROM campaign_members WHERE campaign_id = $1 AND user_id = $2 AND role = 'owner'`,
          [campaignId, user.userId],
        ));
      if (!owns) return rpcError(reply, 404, 'No such campaign.');
    }

    const server = buildServer(user, campaignId);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      log().error({ err }, 'connector request failed');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(
          JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }),
        );
      }
    }
  };

  app.post(CONNECTOR_PATH, (req, reply) => handle(req, reply, null));
  app.post<{ Params: { campaignId: string } }>(`${CONNECTOR_PATH}/c/:campaignId`, (req, reply) =>
    handle(req, reply, req.params.campaignId),
  );

  // Stateless: there is no event stream to open and no session to end.
  const notAllowed = (_req: unknown, reply: FastifyReply) =>
    reply
      .status(405)
      .header('Allow', 'POST')
      .send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  for (const path of [CONNECTOR_PATH, `${CONNECTOR_PATH}/c/:campaignId`]) {
    app.get(path, notAllowed);
    app.delete(path, notAllowed);
  }
}
