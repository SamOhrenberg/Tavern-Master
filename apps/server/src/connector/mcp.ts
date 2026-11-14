import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { enforceLimit, rateLimiters } from '../http/security.js';
import { log } from '../log.js';
import { SERVER_INSTRUCTIONS } from './instructions.js';
import { resolveToken, type ConnectorUser } from './tokens.js';
import { CONNECTOR_TOOLS, runConnectorTool } from './tools.js';

/** Where the connector is served. Clients are given BASE_URL + this path. */
export const CONNECTOR_PATH = '/mcp';

function bearer(header: string | undefined): string | undefined {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return m?.[1];
}

/** One MCP server per request: the transport is stateless, and everything lasting lives in the database. */
function buildServer(user: ConnectorUser): Server {
  const server = new Server(
    { name: 'tavern-master', version: '0.1.0' },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: CONNECTOR_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as { type: 'object' },
      annotations: t.annotations,
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const out = await runConnectorTool(req.params.name, req.params.arguments ?? {}, {
      user,
      signal: extra.signal,
    });
    return { content: [{ type: 'text', text: out.text }], isError: out.isError };
  });
  return server;
}

function rpcError(reply: FastifyReply, status: number, message: string) {
  return reply.status(status).send({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });
}

/**
 * The connector: a remote MCP endpoint that lets the Claude app run
 * campaigns as their Dungeon Master. It sits outside /api, so the browser
 * session, cookie and CSRF rules do not apply; every request must carry a
 * connector token as a bearer token instead, and is rate limited like the API.
 */
export async function connectorRoutes(app: FastifyInstance): Promise<void> {
  app.post(CONNECTOR_PATH, async (req, reply) => {
    enforceLimit(rateLimiters().api, `ip:${req.ip}`);
    const user = await resolveToken(bearer(req.headers.authorization));
    if (!user) {
      reply.header('WWW-Authenticate', 'Bearer realm="tavern-master"');
      return rpcError(
        reply,
        401,
        'Missing or invalid connector token. Make one in Tavern Master under Settings.',
      );
    }
    enforceLimit(rateLimiters().api, `connector:${user.tokenId}`);

    const server = buildServer(user);
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
  });

  // Stateless: there is no event stream to open and no session to end.
  const notAllowed = (_req: unknown, reply: FastifyReply) =>
    reply
      .status(405)
      .header('Allow', 'POST')
      .send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  app.get(CONNECTOR_PATH, notAllowed);
  app.delete(CONNECTOR_PATH, notAllowed);
}
