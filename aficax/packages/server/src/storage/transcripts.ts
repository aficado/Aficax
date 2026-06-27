// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\storage\transcripts.ts
// JSONL transcripts: one event per line, append-only, never overwritten.
// Files live at ~/.aficax/sessions/<sessionId>/transcript.jsonl.

import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { AnyAgentEvent } from '@aficax/core';
import { sessionDir } from '@aficax/core';

/** Resolve the path of a session's transcript file. */
export function transcriptPath(sessionId: string): string {
  const base = sessionDir(sessionId);
  const sep = base.includes('\\') ? '\\' : '/';
  return `${base}${sep}transcript.jsonl`;
}

/** Resolve the directory that holds a session's transcript and checkpoints. */
export function transcriptDir(sessionId: string): string {
  return sessionDir(sessionId);
}

/** Append a single event to a session's JSONL transcript. */
export async function appendTranscriptEvent(
  sessionId: string,
  event: AnyAgentEvent,
): Promise<void> {
  const path = transcriptPath(sessionId);
  await mkdir(sessionDir(sessionId), { recursive: true });
  const line = JSON.stringify(event) + '\n';
  await appendFile(path, line, 'utf-8');
}

/** Read every line of a session's transcript as an async iterable. */
export async function* readTranscript(
  sessionId: string,
): AsyncGenerator<AnyAgentEvent, void, void> {
  const path = transcriptPath(sessionId);
  let info;
  try {
    info = await stat(path);
  } catch {
    return;
  }
  if (!info.isFile() || info.size === 0) {
    return;
  }
  const stream = createReadStream(path, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) {
      continue;
    }
    try {
      const event = JSON.parse(line) as AnyAgentEvent;
      yield event;
    } catch {
      // Skip malformed lines; the transcript is best-effort.
    }
  }
}

/** Read every line of a session's transcript and return them as an array. */
export async function readAllTranscript(sessionId: string): Promise<AnyAgentEvent[]> {
  const out: AnyAgentEvent[] = [];
  for await (const event of readTranscript(sessionId)) {
    out.push(event);
  }
  return out;
}

/** Return the raw text of the transcript (useful for streaming as a response). */
export async function readRawTranscript(sessionId: string): Promise<string | null> {
  try {
    return await readFile(transcriptPath(sessionId), 'utf-8');
  } catch {
    return null;
  }
}

/** Factory alias for callers that prefer an object handle. */
export class TranscriptWriter {
  constructor(private readonly sessionId: string) {}

  append(event: AnyAgentEvent): Promise<void> {
    return appendTranscriptEvent(this.sessionId, event);
  }
}
