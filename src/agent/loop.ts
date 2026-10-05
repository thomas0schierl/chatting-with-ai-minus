import { App, Platform } from "obsidian";
import type {
  ChatSettings,
  UnifiedMessage,
  UnifiedResponse,
  ContentBlock,
  AgentCallbacks,
  SelectionScope,
  ImageAttachment,
  ToolResult,
} from "../types";
import { errorKind, resetProviderState, sendMessage } from "../api/client";
import { lastChunkAt } from "../api/stream";
import { appLifecycle } from "../platform/lifecycle";
import { TOOL_DEFINITIONS } from "../tools/registry";
import { executeTool } from "../tools/executor";
import { buildContext } from "./context";
import { buildSystemPrompt, buildContextMessage } from "./system-prompt";
import { trimHistory, cutBeforeTurn, newTurnId, HISTORY_MESSAGES } from "./history";
import { debugLog } from "../debug";

/**
 * What the chat view shows and saves for a tool result: the text and a
 * marker, never the image data, which lives only in the agent history
 * (otherwise chat-state.json would hold it twice).
 */
function displayResult(result: ToolResult): ToolResult {
  const count = result.images?.length ?? 0;
  if (!count) return result;
  return {
    result: `${result.result}\n\n[${count === 1 ? "1 image" : `${count} images`} sent to the model]`,
    isError: result.isError,
  };
}

/** Resuming after the background (ADR-15); tests shorten the wait. */
export const RESUME = {
  /** Requests resent per turn at most; after that the error is shown. */
  perTurn: 2,
  /**
   * Back in the foreground, an open request is given up after this long
   * (ms) without data, counted from the return or its last data.
   */
  stallMs: 10_000,
};

/**
 * Mobile (ADR-15): each time the app comes back while `request` is open,
 * give it up (abort) if no data arrives for `RESUME.stallMs`. A desktop
 * window keeps its requests running in the background, so it isn't
 * watched. Returns the function that stops watching.
 */
function watchForStall(request: AbortController): () => void {
  let timer = 0;
  let backAt = 0;
  const check = () => {
    const quietMs = Date.now() - Math.max(backAt, lastChunkAt(request.signal) ?? 0);
    if (quietMs >= RESUME.stallMs) request.abort();
    else timer = window.setTimeout(check, RESUME.stallMs - quietMs);
  };
  const offVisible = appLifecycle.onVisible(() => {
    if (!Platform.isMobileApp) return;
    backAt = Date.now();
    window.clearTimeout(timer);
    timer = window.setTimeout(check, RESUME.stallMs);
  });
  const offHidden = appLifecycle.onHidden(() => window.clearTimeout(timer));
  return () => {
    offVisible();
    offHidden();
    window.clearTimeout(timer);
  };
}

/**
 * The core agentic loop:
 * 1. Send user message + history to API
 * 2. If response contains tool_use, execute tools, append results, loop
 * 3. If response is end_turn, deliver text to user, done
 * 4. Safety: stop after maxIterations to prevent runaway loops
 */
export class AgentLoop {
  private messages: UnifiedMessage[] = [];
  private app: App;
  private settings: ChatSettings;
  /** Counts runs and stops; a run whose number is no longer current is stopped. */
  private runVersion = 0;
  /**
   * Cancels the open HTTP request (streamed answers, ADR-12). One per
   * request, so a request that stalled in the background can be given up
   * without stopping the turn (ADR-15).
   */
  private request: AbortController | null = null;
  /** The run whose loop is working now (0: none); `steer()` adds to it. */
  private loopVersion = 0;
  /** Requests the user added while the loop works; sent with its next request (`steer`). */
  private steered: string[] = [];

  constructor(app: App, settings: ChatSettings) {
    this.app = app;
    this.settings = settings;
  }

  /** Abort a running loop (e.g. user navigates away) */
  abort(): void {
    this.runVersion++;
    this.steered = [];
    this.request?.abort();
  }

  /**
   * Add a request to the running turn, as the chat apps let you steer a
   * running task: it goes with the loop's next request, after the current
   * step. False when no loop is working (start a turn instead). What
   * arrives after the last step is returned by `takeSteered()`.
   */
  steer(text: string): boolean {
    if (!this.loopVersion || this.loopVersion !== this.runVersion) return false;
    this.steered.push(text);
    debugLog(this.app, "STEER", { text });
    return true;
  }

  /** Steered requests the finished turn didn't get to; they need a turn of their own. */
  takeSteered(): string[] {
    return this.steered.splice(0);
  }

  /** Stop a running turn and clear the history. */
  clear(): void {
    this.abort();
    this.messages = [];
    resetProviderState();
  }

  /**
   * Stop a running turn and cut the history to just before the turn
   * `turnId` (editing a message, regenerating). The cut history is
   * a new array, so OpenAI replays it in full instead of chaining.
   */
  cutBeforeTurn(turnId: string): void {
    this.abort();
    this.messages = cutBeforeTurn(this.messages, turnId);
  }

  /** The API history as saved: the last `HISTORY_MESSAGES` messages, whole turns. */
  exportMessages(): UnifiedMessage[] {
    return trimHistory(this.messages, HISTORY_MESSAGES);
  }

  /** Continue from a saved API history (trimmed when it was saved). */
  importMessages(messages: UnifiedMessage[]): void {
    this.messages = [...messages];
    resetProviderState();
  }

  /** Nothing in the API history yet. */
  isEmpty(): boolean {
    return this.messages.length === 0;
  }

  /** The history ends in a user message or tool results: the model hasn't answered them. */
  owesAnswer(): boolean {
    return this.messages.at(-1)?.role === "user";
  }

  /** Export the full conversation as a readable markdown transcript */
  exportTranscript(): string {
    const systemPrompt = buildSystemPrompt();

    const parts: string[] = [
      `# Chatting with AI Minus Transcript`,
      ``,
      `**Date:** ${new Date().toISOString()}`,
      `**Provider:** ${this.settings.provider}`,
      `**Model:** ${this.settings.model}`,
      ``,
      `## System Prompt`,
      ``,
      "```",
      systemPrompt,
      "```",
      ``,
      `## Conversation`,
      ``,
    ];

    for (const msg of this.messages) {
      if (typeof msg.content === "string") {
        parts.push(`### ${msg.role === "user" ? "User" : "Assistant"}`);
        parts.push(``);
        parts.push(msg.content);
        parts.push(``);
      } else {
        // Content blocks
        for (const block of msg.content) {
          if (block.type === "text" && block.text) {
            parts.push(`### ${msg.role === "user" ? "User" : "Assistant"}`);
            parts.push(``);
            parts.push(block.text);
            parts.push(``);
          } else if (block.type === "image" && block.image) {
            parts.push(`[Image attachment: ${block.image.fileName}]`);
            parts.push(``);
          } else if (block.type === "tool_use") {
            parts.push(`### Tool Call: \`${block.name}\``);
            parts.push(``);
            parts.push("```json");
            parts.push(JSON.stringify(block.input, null, 2));
            parts.push("```");
            parts.push(``);
          } else if (block.type === "tool_result") {
            parts.push(`### Tool Result ${block.is_error ? "(ERROR)" : ""}`);
            parts.push(``);
            parts.push("```");
            parts.push(block.content || "(empty)");
            parts.push("```");
            parts.push(``);
            for (const image of block.images ?? []) {
              parts.push(`[Image: ${image.fileName}]`);
              parts.push(``);
            }
          }
        }
      }
    }

    return parts.join("\n");
  }

  /**
   * Run one user turn through the agentic loop; `turnId` marks where it
   * starts. `voice`: the turn comes from a voice conversation (its context
   * asks for a short, speakable answer).
   */
  async run(
    userMessage: string,
    callbacks: AgentCallbacks,
    selection?: SelectionScope | null,
    images: ImageAttachment[] = [],
    turnId: string = newTurnId(),
    { voice = false }: { voice?: boolean } = {}
  ): Promise<void> {
    const version = ++this.runVersion;
    // Keep one provider/model/credential configuration for this entire turn.
    const turnSettings = { ...this.settings };

    // Build context once per user turn and prepend to the user message
    const context = buildContext(this.app, voice);
    const contextPrefix = buildContextMessage(context);

    // If there's a selection, inject it as scoped context
    let fullMessage: string;
    if (selection) {
      fullMessage = [
        contextPrefix,
        "",
        `[Selection scope: The user has selected text in ${selection.filePath}. Work only within this selection. When using edit_document, use find_replace with text from within this selection. Do not modify text outside the selection.]`,
        "",
        `Selected text:`,
        selection.text.split(/\r?\n/).map((line) => `> ${line}`).join("\n"),
        "",
        userMessage,
      ].join("\n");
    } else {
      fullMessage = `${contextPrefix}\n\n${userMessage}`;
    }

    const content: string | ContentBlock[] = images.length > 0
      ? [
          ...images.map((image): ContentBlock => ({ type: "image", image })),
          { type: "text", text: fullMessage },
        ]
      : fullMessage;
    this.messages.push({ role: "user", content, turnId });

    // What is sent is capped like what is saved.
    this.messages = trimHistory(this.messages, HISTORY_MESSAGES);

    debugLog(this.app, "USER_MESSAGE", {
      userMessage,
      hasSelection: !!selection,
      imageCount: images.length,
      imageNames: images.map((image) => image.fileName),
    });

    await this.loop(version, callbacks, turnSettings);
  }

  /**
   * Continue the turn the history ends in, cut off before the model
   * answered (Obsidian was ended in the background, ADR-15): the loop
   * runs on the history as it is, without a new user message. Tool
   * results already there are sent, not run again.
   */
  async continueTurn(callbacks: AgentCallbacks): Promise<void> {
    const version = ++this.runVersion;
    if (!this.owesAnswer()) return;
    debugLog(this.app, "CONTINUE_TURN", { messages: this.messages.length });
    await this.loop(version, callbacks, { ...this.settings });
  }

  /** The agentic loop on the current history, for run `version`. */
  private async loop(version: number, callbacks: AgentCallbacks, turnSettings: ChatSettings): Promise<void> {
    this.loopVersion = version;
    try {
      await this.steps(version, callbacks, turnSettings);
    } finally {
      if (this.loopVersion === version) this.loopVersion = 0;
    }
  }

  private async steps(version: number, callbacks: AgentCallbacks, turnSettings: ChatSettings): Promise<void> {
    const isStopped = () => version !== this.runVersion;
    const onTextDelta = (text: string) => {
      if (!isStopped()) callbacks.onTextDelta?.(text);
    };
    // System prompt is static (cache-friendly). Built once, identical every call.
    const systemPrompt = buildSystemPrompt();
    const maxIterations = turnSettings.maxIterations || 20;
    let resumes = 0;

    for (let i = 0; i < maxIterations; i++) {
      if (isStopped()) return;

      callbacks.onThinking();
      if (isStopped()) return;

      let response: UnifiedResponse | undefined;
      while (!response) {
        const startedAt = Date.now();
        try {
          response = await this.send(turnSettings, systemPrompt, isStopped, onTextDelta);
        } catch (e) {
          if (isStopped()) return;
          const msg = e instanceof Error ? e.message : String(e);
          // Failed or given up while Obsidian was in the background: send
          // the same request again once it's back (ADR-15). The history
          // holds every completed step, so nothing runs twice.
          if (resumes < RESUME.perTurn && appLifecycle.hiddenSince(startedAt)) {
            resumes++;
            debugLog(this.app, "API_RESUME", { error: msg, resume: resumes });
            await appLifecycle.whenVisible();
            if (isStopped()) return;
            callbacks.onResuming?.();
            continue;
          }
          debugLog(this.app, "API_ERROR", { error: msg, model: this.settings.model, provider: this.settings.provider });
          callbacks.onError(msg, errorKind(e));
          return;
        }
      }

      debugLog(this.app, "API_RESPONSE", { stopReason: response.stopReason, contentTypes: response.content.map(b => b.type), usage: response.usage });

      if (isStopped()) return;

      // Do not execute or persist truncated tool arguments as a completed call.
      if (response.stopReason === "max_tokens") {
        const text = response.content.filter(block => block.type === "text").map(block => block.text).join("");
        if (text) callbacks.onResponse(text);
        callbacks.onError("The response reached its token limit before completing. Please try a smaller request.");
        return;
      }

      // Process response content blocks
      const toolCalls: ContentBlock[] = [];
      const textParts: string[] = [];

      for (const block of response.content) {
        if (block.type === "text" && block.text) {
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          toolCalls.push(block);
        }
      }

      // Emit any text before tool calls (skip if ask_user is coming to avoid
      // rendering the question twice: once as text and once via showAskUser)
      const hasAskUser = toolCalls.some((tc) => tc.name === "ask_user");
      if (textParts.length > 0 && toolCalls.length > 0 && !hasAskUser) {
        callbacks.onResponse(textParts.join(""));
      }

      if (isStopped()) return;

      // Append assistant message to history
      this.messages.push({ role: "assistant", content: response.content, replay: response.replay });

      // If no tool calls, we're done
      if (toolCalls.length === 0) {
        if (textParts.length > 0) {
          callbacks.onResponse(textParts.join(""));
        }
        if (response.stopReason === "pause_turn") continue;
        return;
      }

      // Execute tool calls and collect results
      // Install cancellation results immediately: Stop may allow another user
      // turn or persistence while a vault operation is still in flight.
      const resultBlocks: ContentBlock[] = toolCalls.map(tc => ({
        type: "tool_result", tool_use_id: tc.id,
        content: "Tool execution cancelled before completion.", is_error: true,
      }));
      this.messages.push({ role: "user", content: resultBlocks });

      for (const [index, tc] of toolCalls.entries()) {
        if (isStopped()) return;
        callbacks.onToolCall(tc.name!, tc.input!);
        if (isStopped()) return;

        const result = await executeTool(
          this.app,
          tc.name!,
          tc.input!,
          callbacks.onAskUser
        );

        if (isStopped()) return;
        resultBlocks[index] = {
          type: "tool_result",
          tool_use_id: tc.id,
          content: result.result,
          is_error: result.isError,
          ...(result.images?.length ? { images: result.images } : {}),
        };
        callbacks.onToolResult(tc.name!, displayResult(result));
      }

      if (isStopped()) return;
      // What the user added meanwhile goes with the next request, after the results.
      for (const text of this.steered.splice(0)) {
        resultBlocks.push({ type: "text", text: `[The user added while you were working:] ${text}` });
        callbacks.onSteered?.(text);
      }
    }

    // If we get here, we hit the iteration limit
    callbacks.onError(
      `Reached maximum iterations (${maxIterations}). The task may be too complex for a single conversation turn.`
    );
  }

  /** One request with its own abort controller, watched for a stall after the background. */
  private async send(
    settings: ChatSettings,
    systemPrompt: string,
    isStopped: () => boolean,
    onTextDelta: (text: string) => void,
  ): Promise<UnifiedResponse> {
    const request = new AbortController();
    this.request = request;
    const unwatch = watchForStall(request);
    try {
      return await sendMessage(settings, this.messages, TOOL_DEFINITIONS, systemPrompt, isStopped,
        { onTextDelta, signal: request.signal });
    } catch (e) {
      // Aborted, but not by Stop: the watchdog gave it up.
      if (request.signal.aborted && !isStopped()) {
        throw new Error("No answer arrived after Obsidian came back from the background. Please try again.");
      }
      throw e;
    } finally {
      unwatch();
      if (this.request === request) this.request = null;
    }
  }
}
