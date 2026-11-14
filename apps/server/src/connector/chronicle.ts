import { z } from 'zod';
import {
  arcBacklog,
  chunkBacklog,
  notesBacklog,
  queueChronicleIfDue,
  saveArc,
  saveChunk,
  saveNotes,
  saveSession,
  sessionBacklog,
} from '../agent/summarize.js';
import { heldRequest } from './guide.js';
import { registerWork } from './handlers.js';
import { memorySchema, own, openTable, ToolError, workIdSchema, type ConnectorTool } from './toolkit.js';
import { addTools, afterNarrationHook } from './tools.js';
import { finishWork, setWorkPayload } from './work.js';

/**
 * The chronicle, written by Claude. Subjects: 'chunk' (a stretch of play),
 * 'session:<id>' (a finished session as a whole), 'arc' (old sessions merged)
 * and 'notes' (the durable notes tidied). What a request covers is fixed when
 * it is claimed and kept in its payload, so the save stores exactly what
 * Claude was shown.
 */

interface ChroniclePayload {
  text?: string;
  throughId?: number;
  sessionId?: string;
  chunkIds?: string[];
  summaryIds?: string[];
  memoryIds?: string[];
}

const LABEL: Record<string, string> = {
  chunk: 'The chronicle: a stretch of play to summarise',
  arc: 'The chronicle: old sessions to merge into an arc',
  notes: 'The chronicle: durable notes to tidy',
};

registerWork('chronicle', {
  label: (item) => LABEL[item.subjectId] ?? 'The chronicle: a finished session to summarise',

  async prepare(item) {
    const subject = item.subjectId;
    let payload: ChroniclePayload | null = null;
    if (subject === 'chunk') {
      const due = await chunkBacklog(item.campaignId, true);
      if (due) payload = { text: due.text, throughId: due.throughId };
    } else if (subject.startsWith('session:')) {
      const sessionId = subject.slice('session:'.length);
      const due = await sessionBacklog(item.campaignId, sessionId);
      if (due) payload = { text: due.text, sessionId, throughId: due.throughId, chunkIds: due.chunkIds };
    } else if (subject === 'arc') {
      const due = await arcBacklog(item.campaignId);
      if (due) payload = { text: due.text, summaryIds: due.summaryIds };
    } else if (subject === 'notes') {
      const due = await notesBacklog(item.campaignId);
      if (due) payload = { text: due.text, memoryIds: due.memoryIds };
    }
    if (!payload) return null;
    await setWorkPayload(item.id, payload as Record<string, unknown>);
    return { ...item, payload: payload as Record<string, unknown> };
  },

  async render(item) {
    const p = item.payload as ChroniclePayload;
    const notes = item.subjectId === 'notes';
    const ask = notes
      ? `Store the tidied list with save_memories (work_id ${item.id}).`
      : item.subjectId === 'arc'
        ? `Store the merged account with save_chronicle (work_id ${item.id}).`
        : `Store the summary, and up to five durable memories, with save_chronicle (work_id ${item.id}).`;
    return { text: `Chronicle request ${item.id}.\n\n${p.text ?? ''}\n\n${ask}` };
  },
});

export const CHRONICLE_TOOLS: ConnectorTool[] = [
  own({
    name: 'save_chronicle',
    description:
      'Store the summary a chronicle request asked for. It replaces that stretch of play in your brief, so ' +
      'later conversations start from it.',
    schema: z.object({
      work_id: workIdSchema,
      summary: z.string().trim().min(80).max(3000),
      memories: z.array(memorySchema).max(5).default([]),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    during: ['chronicle'],
    async run(input, call) {
      const t = await openTable(call);
      const item = await heldRequest(t, input.work_id, 'chronicle');
      const p = item.payload as ChroniclePayload;
      if (item.subjectId === 'chunk') {
        const n = await saveChunk(t.id, p.throughId ?? 0, input.summary, input.memories);
        await finishWork(item.id, { messages: n });
      } else if (item.subjectId.startsWith('session:') && p.sessionId) {
        await saveSession(
          t.id,
          p.sessionId,
          p.throughId ?? 0,
          p.chunkIds ?? [],
          input.summary,
          input.memories,
        );
        await finishWork(item.id, {});
        await queueChronicleIfDue(t.id);
      } else if (item.subjectId === 'arc') {
        if (!(await saveArc(t.id, p.summaryIds ?? [], input.summary))) {
          throw new ToolError(
            'That is too short to stand in for the summaries it replaces. Write 250 to 400 words.',
          );
        }
        await finishWork(item.id, {});
      } else {
        throw new ToolError('That request takes save_memories.');
      }
      return 'Stored in the chronicle. Call wait_for_work.';
    },
  }),

  own({
    name: 'save_memories',
    description:
      'Store the tidied list of durable notes a chronicle request asked for. It replaces the old list.',
    schema: z.object({
      work_id: workIdSchema,
      memories: z.array(memorySchema).min(5).max(60),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    during: ['chronicle'],
    async run(input, call) {
      const t = await openTable(call);
      const item = await heldRequest(t, input.work_id, 'chronicle');
      if (item.subjectId !== 'notes') throw new ToolError('That request takes save_chronicle.');
      const ids = (item.payload as ChroniclePayload).memoryIds ?? [];
      if (!(await saveNotes(t.id, ids, input.memories))) {
        throw new ToolError(
          `Keep at least 5 notes and fewer than the ${ids.length} there are now; drop only what is resolved.`,
        );
      }
      await finishWork(item.id, {});
      return 'The notes are tidied. Call wait_for_work.';
    },
  }),
];

addTools(...CHRONICLE_TOOLS);

// After each narrated turn, queue whatever part of the chronicle has become due.
afterNarrationHook(queueChronicleIfDue);
