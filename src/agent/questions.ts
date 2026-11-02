/**
 * `ask_user` with questions and answer options, as Codex's
 * `request_user_input_async`: the call returns at once and the agent goes on
 * working. The questions join the conversation's queue, shown one at a time
 * in a card above the input. The user picks an option, types an own answer
 * or skips, and can go back and forth; once every question in the queue has
 * an answer, they all go to the model as one user message (added to the
 * running turn, or as the next turn), in Codex's reply envelope; the chat
 * shows each question, faded like a quote, with its answer below.
 */
import { isRecord } from "../json";
import { newTurnId } from "./history";

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface UserQuestion {
  id: string;
  header?: string;
  question: string;
  options: QuestionOption[];
}

/** The user's answer to one question: an option's label or what they typed; null: skipped. */
export type QuestionPick = { label?: string; note?: string } | null;

/** A question in the conversation's queue, until the answers are sent. */
export interface QueuedQuestion extends UserQuestion {
  /** Unique in the queue (the model's IDs may repeat across calls). */
  key: string;
  /** The turn that asked it: editing or regenerating that turn drops it. */
  turnId: string;
  /** Undefined until answered. */
  answer?: QuestionPick;
  /** The model has the answer (the chat shows it as sent): out of the card, kept until the asking turn goes. */
  delivered?: true;
}

export const MAX_QUESTIONS = 3;
// The schema asks for 2-3 options; a fourth is still shown.
const MAX_OPTIONS = 4;

/** The tool result: the questions wait for the user; the answers come later. */
export const QUESTIONS_ASKED = "The questions are shown to the user. Their answers arrive later as a user message, while you work or after you finish. Go on with what doesn't depend on them; if nothing can go on without them, end your answer and say that you are waiting for the answers.";

const REPLY_OPEN = "<send_user_message_question_reply>";
const REPLY_CLOSE = "</send_user_message_question_reply>";
const REPLY = /<send_user_message_question_reply>([\s\S]*?)<\/send_user_message_question_reply>/;

/**
 * The questions of an `ask_user` call: undefined when it has none (a single
 * free-text `question`), an error text when they can't be asked.
 */
export function parseQuestions(value: unknown): UserQuestion[] | string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) return `'questions' needs 1 to ${MAX_QUESTIONS} questions.`;
  if (value.length > MAX_QUESTIONS) return `At most ${MAX_QUESTIONS} questions per call; ask the others with another call.`;
  const ids = new Set<string>();
  const questions: UserQuestion[] = [];
  for (const [index, item] of value.entries()) {
    const question = isRecord(item) && typeof item.question === "string" ? item.question.trim() : "";
    if (!isRecord(item) || !question) return `Question ${index + 1} has no 'question' text.`;
    let id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : `question_${index + 1}`;
    if (ids.has(id)) id = `${id}_${index + 1}`;
    ids.add(id);
    const options = (Array.isArray(item.options) ? item.options : [])
      .filter(isRecord)
      .filter((option) => typeof option.label === "string" && option.label.trim())
      .slice(0, MAX_OPTIONS)
      .map((option): QuestionOption => ({
        label: (option.label as string).trim(),
        ...(typeof option.description === "string" && option.description.trim() ? { description: option.description.trim() } : {}),
      }));
    const header = typeof item.header === "string" ? item.header.trim() : "";
    questions.push({ id, ...(header ? { header } : {}), question, options });
  }
  return questions;
}

/**
 * Asked questions as they join the queue of `turnId`. An ID already in the
 * conversation's queue (`queued`) or in answers it sent (`sent`, the chat's
 * messages; the model may reuse one, e.g. asking the same thing again) gets
 * a suffix, so each answer names one question.
 */
export function queuedQuestions(questions: UserQuestion[], turnId: string, queued: QueuedQuestion[] = [], sent = ""): QueuedQuestion[] {
  const ids = new Set(queued.map((question) => question.id));
  const taken = (id: string) => ids.has(id) || sent.includes(`"questionItemId":${envelopeJson(id)}`);
  return questions.map((question) => {
    let id = question.id;
    for (let n = 2; taken(id); n++) id = `${question.id}_${n}`;
    ids.add(id);
    return { ...question, id, key: newTurnId(), turnId };
  });
}

/** Every question in the queue has an answer (or was skipped): they can go. */
export function allAnswered(queue: QueuedQuestion[]): boolean {
  return queue.length > 0 && queue.every((question) => question.answer !== undefined);
}

/** One answer as the envelope lists it; an empty answer: skipped. */
function reply(question: QueuedQuestion): { answer: string; question: string; questionItemId: string } {
  return {
    answer: question.answer?.label ?? question.answer?.note ?? "",
    question: question.question.replace(/[\r\n]+/g, " "),
    questionItemId: question.id,
  };
}

/** JSON whose text can't close the envelope (a "<" in a question or answer). */
const envelopeJson = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c");

/**
 * The answers as one user message, in Codex's reply envelope: each question
 * with its ID (the model's) and answer, the option's label or what the user
 * typed; an empty answer: skipped.
 */
export function answersMessage(queue: QueuedQuestion[]): string {
  return `${REPLY_OPEN}\n${envelopeJson(queue.map(reply))}\n${REPLY_CLOSE}`;
}

/** `text` carries this question's answer (in a reply envelope). */
export function answeredIn(text: string, question: QueuedQuestion): boolean {
  return question.answer !== undefined && text.includes(envelopeJson(reply(question)));
}

/** `text` has a reply envelope. */
export function hasReplies(text: string): boolean {
  return text.includes(REPLY_OPEN);
}

/**
 * The answers in a user message's reply envelopes, and the text typed with
 * them (sent together, after the turn's last step); null without an envelope.
 */
export function questionReplies(text: string): { replies: { question: string; answer: string }[]; text: string } | null {
  const replies: { question: string; answer: string }[] = [];
  for (const match of text.matchAll(new RegExp(REPLY.source, "g"))) {
    let list: unknown;
    try {
      list = JSON.parse(match[1]);
    } catch {
      return null;
    }
    const items = Array.isArray(list) ? list : [list];
    if (!items.length || !items.every((item) => isRecord(item) && typeof item.question === "string" && typeof item.answer === "string")) return null;
    replies.push(...(items as { question: string; answer: string }[]).map(({ question, answer }) => ({ question, answer })));
  }
  return replies.length ? { replies, text: withoutReplies(text) } : null;
}

/** A message without its reply envelopes: what the user typed (its links and /skills count). */
export function withoutReplies(text: string): string {
  return text.replace(new RegExp(REPLY.source, "g"), "").trim();
}

/** A user message as text (the queued list, the edit box): a reply envelope as each question with its answer below. */
export function shownText(text: string): string {
  const parsed = questionReplies(text);
  if (!parsed) return text;
  const answers = parsed.replies.map((reply) => `${reply.question}\n${reply.answer || "(skipped)"}`).join("\n\n");
  return parsed.text ? `${answers}\n\n${parsed.text}` : answers;
}

/** A saved queue, as far as it is still a queue. */
export function savedQuestions(value: unknown): QueuedQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).flatMap((item): QueuedQuestion[] => {
    const parsed = parseQuestions([item]);
    if (!Array.isArray(parsed) || typeof item.key !== "string" || typeof item.turnId !== "string") return [];
    const answer = item.answer === null ? null
      : isRecord(item.answer) && (typeof item.answer.label === "string" || typeof item.answer.note === "string")
        ? { ...typeof item.answer.label === "string" ? { label: item.answer.label } : {}, ...typeof item.answer.note === "string" ? { note: item.answer.note } : {} }
        : undefined;
    return [{ ...parsed[0], key: item.key, turnId: item.turnId, ...(answer !== undefined ? { answer } : {}), ...(answer !== undefined && item.delivered === true ? { delivered: true as const } : {}) }];
  });
}

/** What a voice turn says for an `ask_user` call: its questions with their options, or its question. */
export function spokenQuestion(input: Record<string, unknown>): string {
  const questions = parseQuestions(input.questions);
  if (Array.isArray(questions)) {
    return questions.map((q) => {
      const labels = q.options.map((option) => option.label);
      const choices = labels.length > 1 ? `${labels.slice(0, -1).join(", ")} or ${labels.at(-1)}` : labels[0];
      return choices ? `${q.question} Options: ${choices}.` : q.question;
    }).join("\n\n");
  }
  return typeof input.question === "string" ? input.question.trim() : "";
}
