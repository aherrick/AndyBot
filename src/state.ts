import fs from "node:fs";
import path from "node:path";

// --- Types ---

export type RepoInfo = {
  index: number;
  name: string;
  path: string;
  lastCommitUnix: number;
  lastCommitText: string;
};

export type ChatState = {
  selectedRepoName?: string;
  selectedRepoPath?: string;
  threadIds: Record<string, string>; // repoPath → codex threadId
};

export type PersistedState = {
  chats: Record<string, ChatState>;
};

type WorkLogEntry = {
  ts: string;
  repoName: string;
  repoPath: string;
  type: "message" | "compact";
  summary: string;
  request?: string;
};

// --- File paths ---

const DATA_DIR = path.resolve("data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const WORKLOG_FILE = path.join(DATA_DIR, "worklog.jsonl");

class StateRepository {
  private ensureDataDir(): void {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  load(): PersistedState {
    this.ensureDataDir();
    try {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as PersistedState;
      return raw?.chats ? raw : { chats: {} };
    } catch {
      return { chats: {} };
    }
  }

  save(state: PersistedState): void {
    this.ensureDataDir();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  }

  appendWorkLog(entry: Omit<WorkLogEntry, "ts">): void {
    this.ensureDataDir();
    fs.appendFileSync(
      WORKLOG_FILE,
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n",
      "utf8"
    );
  }
}

const stateRepository = new StateRepository();

// --- State persistence ---

export function loadState(): PersistedState {
  return stateRepository.load();
}

export function saveState(state: PersistedState): void {
  stateRepository.save(state);
}

// --- Chat helpers ---

export function getChatState(state: PersistedState, chatId: number): ChatState {
  const key = String(chatId);
  if (!state.chats[key]) state.chats[key] = { threadIds: {} };
  if (!state.chats[key].threadIds) state.chats[key].threadIds = {};
  return state.chats[key];
}

export function setSelectedRepo(chat: ChatState, name: string, repoPath: string): void {
  chat.selectedRepoName = name;
  chat.selectedRepoPath = repoPath;
}

// --- Thread helpers (operate on the currently selected repo) ---

export function getThreadId(chat: ChatState): string | undefined {
  return chat.selectedRepoPath ? chat.threadIds[chat.selectedRepoPath] : undefined;
}

export function setThreadId(chat: ChatState, threadId: string): void {
  if (chat.selectedRepoPath) chat.threadIds[chat.selectedRepoPath] = threadId;
}

export function clearThreadId(chat: ChatState): void {
  if (chat.selectedRepoPath) delete chat.threadIds[chat.selectedRepoPath];
}

// --- Work log ---

export function appendWorkLog(entry: Omit<WorkLogEntry, "ts">): void {
  stateRepository.appendWorkLog(entry);
}
