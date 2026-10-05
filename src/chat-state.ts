/**
 * The saved chats (`chat-state.json`): the conversation records, their
 * format, the one-time migrations from older formats, and storing each
 * image once. Pure functions; `main.ts` reads and writes the file.
 */
import type { ChatHistoryEntry, ImageAttachment, UnifiedMessage } from "./types";
import { assignLegacyTurnIds, trimHistory } from "./agent/history";

/** Current format version of `chat-state.json`. */
export const CHAT_STATE_VERSION = 3;

/** Saved per conversation: the last 100 visible entries and 80 API messages. */
export const SAVED_ENTRIES = 100;
export const SAVED_MESSAGES = 80;

/** The title of a conversation without a user message yet. */
export const NEW_CHAT_TITLE = "New chat";
const TITLE_LENGTH = 40;

/** One conversation, in memory and as saved. */
export interface ConversationRecord {
  id: string;
  /** The first user message (shortened) until renamed. */
  title: string;
  /** Set when the user renamed the conversation; the title then stays. */
  customTitle: boolean;
  createdAt: number;
  /** When a turn last started or the conversation was cleared; orders the list. */
  updatedAt: number;
  /** Visible history; saved with images without their data. */
  chatHistory: ChatHistoryEntry[];
  /** API history; the only place with image data. */
  agentMessages: UnifiedMessage[];
}

/** `chat-state.json` as written by this version. */
export interface ChatState {
  version: number;
  activeConversationId: string;
  conversations: ConversationRecord[];
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
  // 2 → 3: the single chat becomes the first (and active) conversation.
  2: (state) => {
    const conversation = newConversation();
    conversation.chatHistory = arrayOf<ChatHistoryEntry>(state.chatHistory);
    conversation.agentMessages = arrayOf<UnifiedMessage>(state.agentMessages);
    conversation.title = conversationTitle(conversation.chatHistory);
    return { version: 3, activeConversationId: conversation.id, conversations: [conversation] };
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
  const conversations = arrayOf<unknown>(state.conversations)
    .filter((item): item is StateRecord => isRecord(item) && typeof item.id === "string")
    .map((item): ConversationRecord => {
      const chatHistory = arrayOf<ChatHistoryEntry>(item.chatHistory);
      const customTitle = item.customTitle === true && typeof item.title === "string";
      return {
        id: item.id as string,
        title: customTitle ? item.title as string : conversationTitle(chatHistory),
        customTitle,
        createdAt: typeof item.createdAt === "number" ? item.createdAt : 0,
        updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : 0,
        chatHistory,
        agentMessages: arrayOf<UnifiedMessage>(item.agentMessages),
      };
    });
  if (conversations.length === 0) conversations.push(newConversation());
  const active = conversations.find((conversation) => conversation.id === state.activeConversationId)
    ?? newestFirst(conversations)[0];
  return { version, activeConversationId: active.id, conversations };
}

/** A new, empty conversation. */
export function newConversation(now = Date.now()): ConversationRecord {
  return {
    id: `chat-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    title: NEW_CHAT_TITLE,
    customTitle: false,
    createdAt: now,
    updatedAt: now,
    chatHistory: [],
    agentMessages: [],
  };
}

/**
 * The title taken from the first user message: one line, at most 40
 * characters (an image's name when there is no text).
 */
export function conversationTitle(entries: ChatHistoryEntry[]): string {
  const first = entries.find((entry) => entry.type === "user");
  const text = (first?.text ?? "").replace(/\s+/g, " ").trim() || first?.images?.[0]?.fileName || "";
  if (!text) return NEW_CHAT_TITLE;
  return text.length > TITLE_LENGTH ? `${text.slice(0, TITLE_LENGTH - 1).trimEnd()}…` : text;
}

/** Nothing said yet. */
export function isEmptyConversation(conversation: ConversationRecord): boolean {
  return conversation.chatHistory.length === 0 && conversation.agentMessages.length === 0;
}

/** Most recently used first. */
export function newestFirst(conversations: ConversationRecord[]): ConversationRecord[] {
  return [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** A conversation as saved: capped, image data only in the API history. */
export function savedConversation(conversation: ConversationRecord): ConversationRecord {
  return {
    ...conversation,
    chatHistory: withoutImageData(conversation.chatHistory.slice(-SAVED_ENTRIES)),
    agentMessages: trimHistory(conversation.agentMessages, SAVED_MESSAGES),
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
