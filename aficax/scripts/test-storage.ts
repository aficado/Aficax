// C:\Users\aficado\Desktop\Aficax\aficax\scripts\test-storage.ts
// Phase 4 smoke test: exercise the full storage stack end-to-end with an
// in-memory SQLite database.

import { openInMemoryDatabase } from '../packages/server/src/storage/db.js';
import { createMessageStorage } from '../packages/server/src/storage/messages.js';
import { createSessionStorage } from '../packages/server/src/storage/sessions.js';
import {
  appendTranscriptEvent,
  readAllTranscript,
  readRawTranscript,
} from '../packages/server/src/storage/transcripts.js';
import { createSessionManager, generateSessionTitle } from '../packages/server/src/session/manager.js';
import { listCheckpoints, rewindFile } from '../packages/server/src/storage/checkpoints.js';
import type { AnyAgentEvent, Message, Session, ToolCall, createSessionId } from '@aficax/core';

const SESSION_ID = 'aficax-sess-test-1' as unknown as ReturnType<typeof createSessionId>;

interface Step {
  label: string;
  ok: boolean;
  detail: string;
}

const steps: Step[] = [];
function check(label: string, ok: boolean, detail: string): void {
  steps.push({ label, ok, detail });
  console.log(`[${ok ? 'ok' : 'FAIL'}] ${label}: ${detail}`);
}

async function main(): Promise<void> {
  const handle = openInMemoryDatabase();
  const sessionStorage = createSessionStorage(handle.db);
  const messageStorage = createMessageStorage(handle.db);
  const manager = createSessionManager({ sessions: sessionStorage, messages: messageStorage });

  // 1. Create session
  const session = manager.create('/tmp', 'claude-sonnet-4-6', 'anthropic');
  check('create', session.id.length > 0, `id=${session.id}`);

  // 2. Get from manager (cache hit)
  const got = manager.get(session.id);
  check('get (cache)', got !== undefined && got.id === session.id, `id=${got?.id}`);

  // 3. Insert a user message → triggers title generation + transcript
  const userMessage: Message = {
    id: 'msg-user-1',
    role: 'user',
    content: { kind: 'text', text: 'Build a REST API with Express and TypeScript' },
    timestamp: Date.now(),
  };
  const updated = await manager.addMessage(session.id, userMessage);
  check('addMessage sets title', updated.title !== undefined, `title="${updated.title}"`);

  // 4. Append a few events to the transcript
  const events: AnyAgentEvent[] = [
    {
      type: 'session_start',
      sessionId: session.id,
      timestamp: Date.now(),
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      workingDir: '/tmp',
    },
    {
      type: 'status',
      sessionId: session.id,
      timestamp: Date.now(),
      status: 'thinking',
      detail: 'Turn 1',
    },
    {
      type: 'message_start',
      sessionId: session.id,
      timestamp: Date.now(),
      role: 'assistant',
    },
  ];
  for (const event of events) {
    await appendTranscriptEvent(session.id, event);
  }

  // 5. Read transcript back
  const raw = await readRawTranscript(session.id);
  check('readRawTranscript', raw !== null && raw.length > 0, `lines=${raw?.split('\n').length ?? 0}`);

  const all = await readAllTranscript(session.id);
  check('readAllTranscript', all.length === events.length, `events=${String(all.length)}`);

  // 6. Add a tool call via the message path
  const assistantMessage: Message = {
    id: 'msg-asst-1',
    role: 'assistant',
    content: {
      kind: 'tool_use',
      toolCallId: 'tc-1',
      toolName: 'read_file',
      input: { path: '/tmp/test.ts' },
    },
    timestamp: Date.now(),
  };
  await manager.addMessage(session.id, assistantMessage);
  const toolCall: ToolCall = {
    id: 'tc-1',
    toolName: 'read_file',
    input: { path: '/tmp/test.ts' },
    output: 'file contents here',
    status: 'done',
  };
  manager.addToolCall(session.id, toolCall, 'msg-asst-1');
  check('addToolCall', manager.get(session.id)?.toolCalls.length === 1, `tc=${manager.get(session.id)?.toolCalls.length}`);

  // 7. List sessions
  const summaries = manager.list();
  check('list', summaries.length === 1, `count=${String(summaries.length)}`);
  check('summary has title', summaries[0]?.title !== undefined, `title="${summaries[0]?.title}"`);
  check('summary counts', summaries[0]?.messageCount === 2 && summaries[0]?.toolCallCount === 1, `msgs=${summaries[0]?.messageCount} tcs=${summaries[0]?.toolCallCount}`);

  // 8. Hydrate from scratch
  manager.invalidate(session.id);
  const fresh = manager.get(session.id);
  check('hydrate from SQLite', fresh?.messages.length === 2, `msgs=${String(fresh?.messages.length)}`);
  check('hydrate tool calls', fresh?.toolCalls.length === 1, `tcs=${String(fresh?.toolCalls.length)}`);
  check('hydrate title preserved', fresh?.title === 'Build a REST API with Express and TypeScript', `title="${fresh?.title}"`);

  // 9. Resume
  manager.setStatus(session.id, 'paused');
  manager.resume(session.id);
  check('resume', manager.get(session.id)?.status === 'active', `status=${manager.get(session.id)?.status}`);

  // 10. generateSessionTitle
  const longTitle = generateSessionTitle('a'.repeat(100));
  check('title truncation', longTitle.length <= 50, `len=${longTitle.length}`);

  // 11. Checkpoints (none expected)
  const checkpoints = await listCheckpoints(session.id);
  check('checkpoints empty', checkpoints.length === 0, `count=${String(checkpoints.length)}`);

  // 12. Delete and re-verify
  await manager.delete(session.id);
  check('delete', manager.get(session.id) === undefined, 'session gone');
  const afterList = manager.list();
  check('list after delete', afterList.length === 0, `count=${String(afterList.length)}`);

  // 13. Checkpoints: rewind (no checkpoint → error)
  let rewindFailed = false;
  try {
    await rewindFile(session.id, '/tmp/nonexistent.txt');
  } catch {
    rewindFailed = true;
  }
  check('rewindFile without checkpoint', rewindFailed, 'expected error thrown');

  handle.close();

  const ok = steps.filter((s) => s.ok).length;
  console.log(`\nSummary: ${String(ok)}/${String(steps.length)} checks passed`);
  if (ok !== steps.length) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
