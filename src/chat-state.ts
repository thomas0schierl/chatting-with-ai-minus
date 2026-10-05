/**
 * The saved chat (`chat-state.json`): its format, the one-time migrations
 * from older formats, and storing each image once. Pure
 * functions; `main.ts` reads and writes the file.
 */
import type { ChatHistoryEntry, ImageAttachment, UnifiedMessage } from "./types";
import { assignLegacyTurnIds } from "./agent/history";

/** Current format version of `chat-state.json`. */
export const CHAT_STATE_VERSION = 2;

/** `chat-state.json` as written by this version. */
export interface ChatState {
  version: number;
  /** Visible history; images without their data. */
  chatHistory: ChatHistoryEntry[];
  /** API history; the only place with image data. */
  agentMessages: UnifiedMessage[];
}

type StateRecord = Record<string, unknown>;

/**
 * One-time repairs of the saved chat, keyed by the version they upgrade
 * from (a file without `version` is version 1). Each runs once: the next
 * save writes the new version.
 */
const CHAT_STATE_MIGRATIONS: Record<number, (state: StateRecord) => StateRecord> = {
  // 1 → 2: turn IDs for chats saved without them; image data only in the
  // API history.
  1: (state) => {
    const chatHistory = arrayOf<ChatHistoryEntry>(state.chatHistory);
    const agentMessages = arrayOf<UnifiedMessage>(state.agentMessages);
    assignLegacyTurnIds(chatHistory, agentMessages);
    return { ...state, version: 2, chatHistory: withoutImageData(chatHistory), agentMessages };
  },
};

/** The saved chat in the current format, or null if it isn't one. */
export function migrateChatState(value: unknown): ChatState | null {
  if (!isRecord(value)) return null;
  let state = value;
  let version = typeof state.version === "number" ? state.version : 1;
  while (version < CHAT_STATE_VERSION) {
    const migrate = CHAT_STATE_MIGRATIONS[version];
    if (!migrate) return null;
    state = migrate(state);
    version++;
  }
  return {
    version,
    chatHistory: arrayOf<ChatHistoryEntry>(state.chatHistory),
    agentMessages: arrayOf<UnifiedMessage>(state.agentMessages),
  };
}

/** Entries as saved: images keep their name, type and size, not their data. */
export function withoutImageData(entries: ChatHistoryEntry[]): ChatHistoryEntry[] {
  return entries.map((entry) => entry.images?.length
    ? { ...entry, images: entry.images.map(({ data: _data, ...image }) => image as ImageAttachment) }
    : entry);
}

/**
 * Entries with their images taken from the API history (same image ID).
 * An image the API history no longer holds (trimmed) gets empty data; the
 * view shows a chip with its name instead.
 */
export function restoreImages(entries: ChatHistoryEntry[], messages: UnifiedMessage[]): ChatHistoryEntry[] {
  const images = new Map<string, ImageAttachment>();
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block.type === "image" && block.image) images.set(block.image.id, block.image);
    }
  }
  return entries.map((entry) => entry.images?.length
    ? { ...entry, images: entry.images.map((image) => images.get(image.id) ?? { ...image, data: "" }) }
    : entry);
}

function arrayOf<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function isRecord(value: unknown): value is StateRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
