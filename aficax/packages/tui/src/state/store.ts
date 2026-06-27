// packages/tui/src/state/store.ts
import { create } from "zustand";

export type AgentMode = "plan" | "auto" | "full";

export type MessageRole = "user" | "assistant" | "system";

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  toolCalls?: ToolCallRecord[];
  streaming?: boolean;
}

export type ToolCallStatus = "pending" | "running" | "done" | "error" | "denied";

export interface ToolCallRecord {
  id: string;
  name: string;
  input: unknown;
  output?: string;
  status: ToolCallStatus;
  startedAt: number;
  finishedAt?: number;
  errorMessage?: string;
}

export interface ApprovalRequest {
  id: string;
  toolName: string;
  input: unknown;
  riskLevel: "low" | "medium" | "high";
  description?: string;
}

export interface SessionInfo {
  id: string;
  workingDir: string;
  model: string;
  provider: string;
  mode: AgentMode;
  createdAt: number;
}

export interface ModelUsage {
  used: number;
  limit: number;
}

export interface McpServerStatus {
  name: string;
  connected: boolean;
  toolCount: number;
  type?: "stdio" | "http" | "websocket";
  error?: string;
}

export interface ConnectionStatus {
  serverReachable: boolean;
  serverUrl: string;
  attempts: number;
  lastError?: string;
}

export interface TuiState {
  // Session
  session: SessionInfo | null;
  mode: AgentMode;

  // Messages
  messages: ChatMessage[];

  // Streaming state
  isStreaming: boolean;
  currentStreamingId: string | null;
  pendingApproval: ApprovalRequest | null;

  // Model info
  modelUsage: ModelUsage;
  mcpServers: McpServerStatus[];

  // Connection
  connection: ConnectionStatus;

  // UI
  inputHistory: string[];
  inputHistoryIndex: number;

  // Actions
  setSession: (session: SessionInfo | null) => void;
  setMode: (mode: AgentMode) => void;
  addMessage: (msg: ChatMessage) => void;
  appendToMessage: (id: string, chunk: string) => void;
  finalizeMessage: (id: string) => void;
  startToolCall: (record: ToolCallRecord) => void;
  updateToolCall: (id: string, patch: Partial<ToolCallRecord>) => void;
  setStreaming: (streaming: boolean, currentId?: string | null) => void;
  setPendingApproval: (req: ApprovalRequest | null) => void;
  setConnection: (conn: Partial<ConnectionStatus>) => void;
  setModelUsage: (usage: ModelUsage) => void;
  setMcpServers: (servers: McpServerStatus[]) => void;
  pushInputHistory: (entry: string) => void;
  moveInputHistory: (delta: number) => string | null;
  resetInputHistoryIndex: () => void;
  clearMessages: () => void;
}

const initialConnection: ConnectionStatus = {
  serverReachable: false,
  serverUrl: process.env.AFICAX_SERVER_URL ?? "http://127.0.0.1:7433",
  attempts: 0,
};

const initialUsage: ModelUsage = { used: 0, limit: 200000 };

export const useTuiStore = create<TuiState>((set, get) => ({
  session: null,
  mode: "auto",
  messages: [],
  isStreaming: false,
  currentStreamingId: null,
  pendingApproval: null,
  modelUsage: initialUsage,
  mcpServers: [],
  connection: initialConnection,
  inputHistory: [],
  inputHistoryIndex: -1,

  setSession: (session) => set({ session }),
  setMode: (mode) => set({ mode }),

  addMessage: (msg) =>
    set((state) => ({ messages: [...state.messages, msg] })),

  appendToMessage: (id, chunk) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === id ? { ...m, content: m.content + chunk } : m
      ),
    })),

  finalizeMessage: (id) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === id ? { ...m, streaming: false } : m
      ),
    })),

  startToolCall: (record) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.streaming
          ? { ...m, toolCalls: [...(m.toolCalls ?? []), record] }
          : m
      ),
    })),

  updateToolCall: (id, patch) =>
    set((state) => ({
      messages: state.messages.map((m) => {
        if (!m.toolCalls) return m;
        return {
          ...m,
          toolCalls: m.toolCalls.map((tc) =>
            tc.id === id ? { ...tc, ...patch } : tc
          ),
        };
      }),
    })),

  setStreaming: (streaming, currentId = null) =>
    set({ isStreaming: streaming, currentStreamingId: currentId }),

  setPendingApproval: (req) => set({ pendingApproval: req }),

  setConnection: (conn) =>
    set((state) => ({ connection: { ...state.connection, ...conn } })),

  setModelUsage: (usage) => set({ modelUsage: usage }),

  setMcpServers: (servers) => set({ mcpServers: servers }),

  pushInputHistory: (entry) =>
    set((state) => ({
      inputHistory: [...state.inputHistory, entry].slice(-200),
      inputHistoryIndex: -1,
    })),

  moveInputHistory: (delta) => {
    const { inputHistory, inputHistoryIndex } = get();
    if (inputHistory.length === 0) return null;
    let next = inputHistoryIndex + delta;
    // When the user starts at the fresh-input marker (-1) and presses
    // the up arrow, jump straight to the most recent entry. Without
    // this special case the cursor would be clamped back to -1 and
    // we'd return an empty string, hiding the history.
    if (inputHistoryIndex === -1 && delta < 0) {
      next = inputHistory.length - 1;
    } else if (next < 0) {
      // Walking past the oldest entry keeps the cursor pinned to 0.
      next = 0;
    } else if (next >= inputHistory.length) {
      // Walking forward past the most recent entry resets the cursor
      // to the fresh-input marker (-1) so the input box empties.
      next = -1;
    }
    set({ inputHistoryIndex: next });
    if (next === -1) return "";
    return inputHistory[next] ?? null;
  },

  resetInputHistoryIndex: () => set({ inputHistoryIndex: -1 }),

  clearMessages: () => set({ messages: [] }),
}));

export function selectIsBusy(state: TuiState): boolean {
  return state.isStreaming || state.pendingApproval !== null;
}
