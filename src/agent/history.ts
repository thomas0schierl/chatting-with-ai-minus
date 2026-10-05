import type { ChatHistoryEntry, UnifiedMessage } from "../types";

function startsUserTurn(message: UnifiedMessage): boolean {
  return message.role === "user" && (typeof message.content === "string" ||
    message.content.some(block => block.type === "text" || block.type === "image"));
}

/** Keep whole user turns so pruning/persistence cannot orphan tool results. */
export function trimHistory(messages: UnifiedMessage[], limit: number): UnifiedMessage[] {
  const firstTurn = messages.findIndex(startsUserTurn);
  if (firstTurn < 0) return [];
  let start = firstTurn;
  const cutoff = Math.max(0, messages.length - limit);
  for (let index = firstTurn; index <= cutoff; index++) {
    if (startsUserTurn(messages[index])) start = index;
  }
  return start === 0 ? messages : messages.slice(start);
}

let turnCount = 0;

/** A new ID for a user turn. */
export function newTurnId(): string {
  return `turn-${Date.now().toString(36)}-${(turnCount++).toString(36)}`;
}

/**
 * The agent history up to just before the turn `turnId`, as a new array
 * (so the OpenAI adapter can't chain to a response from the cut-off part).
 * A turn that isn't there was trimmed away, since every turn goes into both
 * histories: all of the history comes after it, and nothing is kept.
 */
export function cutBeforeTurn(messages: UnifiedMessage[], turnId: string): UnifiedMessage[] {
  const index = messages.findIndex(message => message.turnId === turnId && startsUserTurn(message));
  return index < 0 ? [] : messages.slice(0, index);
}

/**
 * Gives turns saved before turn IDs existed an ID in both histories, in
 * place. Each turn added one user entry to the view's history and one turn
 * start to the agent's, so they are paired from the end; where one list
 * reaches further back, its older turns get IDs of their own. Only missing
 * IDs are added; nothing else changes.
 */
export function assignLegacyTurnIds(entries: ChatHistoryEntry[], messages: UnifiedMessage[]): void {
  const users = entries.filter(entry => entry.type === "user");
  const starts = messages.filter(startsUserTurn);
  for (let back = 1; back <= Math.max(users.length, starts.length); back++) {
    const entry = users[users.length - back] as ChatHistoryEntry | undefined;
    const start = starts[starts.length - back] as UnifiedMessage | undefined;
    const turnId = entry?.turnId ?? start?.turnId ?? `legacy-${back}`;
    if (entry && !entry.turnId) entry.turnId = turnId;
    if (start && !start.turnId) start.turnId = turnId;
  }
}
