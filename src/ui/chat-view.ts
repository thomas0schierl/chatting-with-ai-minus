import { ItemView, WorkspaceLeaf, Notice, type App } from "obsidian";
import { mount, unmount } from "svelte";
import type { Component } from "svelte";
import type ChatPlugin from "../main";
import ChatContainer from "./ChatContainer.svelte";
import type { ToolResult, SelectionScope, ImageAttachment, ConversationSummary, ChatErrorKind } from "../types";
import { newTurnId } from "../agent/history";
import { savedToolInput } from "../chat-state";
import { debugLog } from "../agent/loop";
import { VoiceController, type VoiceTurnHooks, type VoiceViewState } from "../voice/controller";

export const VIEW_TYPE_CHAT = "chatting-minus-view";

interface ChatContainerProps {
  app: App;
  component: ObsidianChatView;
  provider: string;
  model: string;
  onSend: (text: string, selection: SelectionScope | null, images: ImageAttachment[]) => void;
  onClear: () => void;
  onStop: () => void;
  onEdit: (turnId: string, text: string) => void;
  onRegenerate: () => void;
  onCopy: (text: string) => void;
  title: string;
  onNewChat: () => void;
  listConversations: () => ConversationSummary[];
  onOpenConversation: (id: string) => void;
  onRenameConversation: (id: string, title: string) => void;
  onDeleteConversation: (id: string) => void;
  voiceAvailable: boolean;
  onVoice: (action: VoiceAction) => void;
}

/** Voice bar controls and the microphone button. */
export type VoiceAction = "start" | "end" | "mute" | "talk-start" | "talk-end" | "play";

interface ChatContainerApi extends Record<string, unknown> {
  addUserMessage(text: string, images?: ImageAttachment[], turnId?: string, selection?: SelectionScope): void;
  addAssistantMessage(text: string, streaming?: boolean): number;
  updateAssistantMessage(id: number, text: string, final?: boolean): void;
  removeMessage(id: number): void;
  cutMessages(turnId: string): void;
  addToolCall(name: string, input: Record<string, unknown>): number;
  updateToolResult(msgId: number, name: string, result: ToolResult): void;
  addError(text: string, kind?: ChatErrorKind): void;
  showThinking(): void;
  hideThinking(): void;
  showAskUser(question: string): Promise<string>;
  setInputEnabled(enabled: boolean): void;
  setBusy(busy: boolean): void;
  cancelAskUser(): void;
  clearMessages(): void;
  focus(): void;
  setModel(name: string, provider: string): void;
  setTitle(title: string): void;
  setSelection(selection: SelectionScope): void;
  getSelection(): SelectionScope | null;
  setVoice(state: VoiceViewState | null): void;
  setVoiceAvailable(available: boolean): void;
}

/**
 * Chat view for Chatting with AI Minus.
 * Desktop: right sidebar. Mobile: right sidebar (slides in from edge).
 * Uses the plugin's shared AgentLoop and chatHistory so conversations
 * survive the view being closed and reopened (e.g. sidebar toggle).
 */
export class ObsidianChatView extends ItemView {
  private plugin: ChatPlugin;
  private chatContainer: ChatContainerApi | undefined;
  private running = false;
  /** Counts turns started here; only the latest one may end the running state. */
  private turnCount = 0;
  /** The assistant message being streamed, until the loop delivers it whole. */
  private streaming: { id: number; text: string } | null = null;
  /** The live voice conversation, while one runs (ADR-11). */
  private voice: VoiceController | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: ChatPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_CHAT;
  }

  getDisplayText(): string {
    // Distinct from upstream "Chat" tab so users running both plugins
    // side-by-side can tell the workspace tabs apart.
    return "Chatting with AI Minus";
  }

  getIcon(): string {
    return "message-circle";
  }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass("chatting-minus-view-container");

    this.chatContainer = mount<ChatContainerProps, ChatContainerApi>(
      ChatContainer as unknown as Component<ChatContainerProps, ChatContainerApi>,
      {
      target: container,
      props: {
        app: this.app,
        component: this,
        provider: this.plugin.settings.provider,
        model: this.plugin.modelHeaderLabel(),
        onSend: (text: string, selection: SelectionScope | null, images: ImageAttachment[]) => {
          void this.handleUserMessage(text, selection, images);
        },
        onClear: () => this.handleClear(),
        onStop: () => this.handleStop(),
        onEdit: (turnId: string, text: string) => void this.editMessage(turnId, text),
        onRegenerate: () => void this.regenerate(),
        onCopy: (text: string) => this.copyAnswer(text),
        title: this.plugin.activeConversation.title,
        onNewChat: () => this.newChat(),
        listConversations: () => this.plugin.listConversations(),
        onOpenConversation: (id: string) => this.openConversation(id),
        onRenameConversation: (id: string, title: string) => this.renameConversation(id, title),
        onDeleteConversation: (id: string) => this.deleteConversation(id),
        voiceAvailable: this.plugin.voiceRoute() !== null,
        onVoice: (action: VoiceAction) => this.handleVoice(action),
      },
    });

    this.renderHistory();
    this.chatContainer.focus();
  }

  /** Show the plugin's chat history in the UI, replacing what it shows. */
  renderHistory(): void {
    const chat = this.chatContainer;
    if (!chat) return;
    chat.clearMessages();
    for (const msg of this.plugin.chatHistory) {
      switch (msg.type) {
        case "user":
          chat.addUserMessage(msg.text ?? "", msg.images, msg.turnId, msg.selection);
          break;
        case "assistant":
          chat.addAssistantMessage(msg.text!);
          break;
        case "tool-result":
          if (msg.toolName && msg.toolResult) {
            const id = chat.addToolCall(msg.toolName, msg.toolInput || {});
            chat.updateToolResult(id, msg.toolName, msg.toolResult);
          }
          break;
        case "error":
          chat.addError(msg.text!, msg.errorKind);
          break;
      }
    }
  }

  async onClose(): Promise<void> {
    this.endVoice();
    this.plugin.agent.abort();
    if (this.chatContainer) {
      await unmount(this.chatContainer);
      this.chatContainer = undefined;
    }
  }

  /** Export the full transcript for debugging */
  getTranscript(): string {
    return this.plugin.agent.exportTranscript();
  }

  /** Programmatically send a message */
  sendMessage(text: string): void {
    void this.handleUserMessage(text, this.chatContainer?.getSelection() ?? null);
  }

  /** Set the selection scope and show the pill */
  setSelection(selection: SelectionScope): void {
    this.chatContainer?.setSelection(selection);
  }

  /** Focus the input */
  focus(): void {
    this.chatContainer?.focus();
  }

  /** Update the model display name in the header (and the ChatGPT plan line) */
  updateModel(name: string, provider: string): void {
    this.chatContainer?.setModel(name, provider);
  }

  /** Clear conversation */
  clearConversation(): void {
    this.handleClear();
  }

  // ─── Voice ──────────────────────────────────────────────────────────
  // A voice conversation belongs to the shown conversation: switching,
  // a new chat, clearing or closing the view ends it.

  /** Show or hide the microphone button (a voice route is set up or not). */
  updateVoiceAvailable(): void {
    this.chatContainer?.setVoiceAvailable(this.plugin.voiceRoute() !== null);
  }

  /** Start a voice conversation in the current conversation. */
  startVoice(): void {
    if (this.voice) return;
    const route = this.plugin.voiceRoute();
    if (!route) {
      new Notice("Set up voice in Chatting with AI Minus settings.");
      return;
    }
    const controller: VoiceController = new VoiceController({
      runTurn: (text, hooks) => this.handleUserMessage(text, null, [], newTurnId(), hooks),
      stopTurn: () => this.handleStop(),
      turnRunning: () => this.running,
      history: () => this.plugin.chatHistory,
      showError: (message) => {
        this.chatContainer?.addError(message);
        this.plugin.chatHistory.push({ type: "error", text: message });
        void this.plugin.saveChatHistory();
      },
      render: (state) => {
        if (this.voice !== controller) return;
        if (!state) this.voice = null;
        this.chatContainer?.setVoice(state);
      },
      log: (label, data) => debugLog(this.app, label, data),
    }, route, this.plugin.settings.voiceMicMode === "hold");
    this.voice = controller;
    void controller.start();
  }

  /** End the voice conversation, if one runs. */
  endVoice(): void {
    const voice = this.voice;
    if (!voice) return;
    this.voice = null;
    this.chatContainer?.setVoice(null);
    void voice.end();
  }

  private handleVoice(action: VoiceAction): void {
    if (action === "start") this.startVoice();
    else if (action === "end") this.endVoice();
    else if (action === "mute") this.voice?.toggleMute();
    else if (action === "talk-start") this.voice?.setTalking(true);
    else if (action === "talk-end") this.voice?.setTalking(false);
    else this.voice?.resumeAudio();
  }

  // ─── Conversations ──────────────────────────────────────────────────
  // Switching stops a running turn (as Stop does); what it showed stays in
  // its conversation.

  /** Start a new conversation (an empty current one is kept instead). */
  newChat(): void {
    this.endVoice();
    if (this.running) this.stopTurn();
    this.plugin.startNewConversation();
    this.showConversation();
  }

  /** Switch to conversation `id`. */
  openConversation(id: string): void {
    if (id === this.plugin.activeConversationId) return;
    this.endVoice();
    if (this.running) this.stopTurn();
    this.plugin.openConversation(id);
    this.showConversation();
  }

  /** Rename conversation `id` (empty: back to the automatic title). */
  renameConversation(id: string, title: string): void {
    this.plugin.renameConversation(id, title);
    this.chatContainer?.setTitle(this.plugin.activeConversation.title);
  }

  /** Delete conversation `id`; for the current one, show the next. */
  deleteConversation(id: string): void {
    const active = id === this.plugin.activeConversationId;
    if (active) this.endVoice();
    if (active && this.running) this.stopTurn();
    this.plugin.deleteConversation(id);
    if (active) this.showConversation();
  }

  /** Show the active conversation, ready for input. */
  private showConversation(): void {
    const chat = this.chatContainer;
    this.streaming = null;
    if (!chat) return;
    chat.cancelAskUser();
    this.renderHistory();
    chat.setTitle(this.plugin.activeConversation.title);
    chat.setInputEnabled(true);
    chat.setBusy(false);
    chat.focus();
  }

  /**
   * Edit and continue: stop a running turn, cut both histories to
   * just before the turn `turnId`, save, and run `text` as a new turn with
   * that turn's images and selection scope. Vault changes stay. Resolves
   * when the new turn has ended.
   */
  async editMessage(turnId: string, text: string): Promise<void> {
    const history = this.plugin.chatHistory;
    const index = history.findIndex((entry) => entry.type === "user" && entry.turnId === turnId);
    if (index < 0) return;
    const { selection = null } = history[index];
    // Images the API history no longer holds can't be sent again.
    const images = (history[index].images ?? []).filter((image) => image.data);
    if (!text.trim() && images.length === 0) return;
    if (this.running) this.stopTurn();
    this.plugin.agent.cutBeforeTurn(turnId);
    this.plugin.chatHistory = this.plugin.chatHistory.slice(0, index);
    this.chatContainer?.cutMessages(turnId);
    // The saved state is taken now, before the new turn starts.
    void this.plugin.saveChatHistory();
    await this.handleUserMessage(text, selection, images);
  }

  /** Regenerate the last answer: run the last user turn again, unchanged. */
  async regenerate(): Promise<void> {
    const last = this.plugin.chatHistory.filter((entry) => entry.type === "user" && entry.turnId).pop();
    if (last?.turnId) await this.editMessage(last.turnId, last.text ?? "");
  }

  /** Copy an answer's Markdown source. */
  copyAnswer(text: string): void {
    void navigator.clipboard.writeText(text).then(
      () => new Notice("Copied"),
      () => new Notice("Couldn't copy the answer."),
    );
  }

  /** Run one turn; `voice`: it comes from the voice conversation, which gets its progress and answer. */
  private async handleUserMessage(
    text: string,
    selection: SelectionScope | null,
    images: ImageAttachment[] = [],
    turnId: string = newTurnId(),
    voice?: VoiceTurnHooks
  ): Promise<void> {
    if (this.running) {
      new Notice("Please wait for the current response to complete.");
      return;
    }

    const chat = this.chatContainer!;
    const history = this.plugin.chatHistory;

    this.running = true;
    const turn = ++this.turnCount;
    chat.addUserMessage(text, images, turnId, selection ?? undefined);
    history.push({ type: "user", text, images, turnId, ...(selection ? { selection } : {}) });
    this.plugin.touchConversation();
    chat.setTitle(this.plugin.activeConversation.title);
    chat.setInputEnabled(false);
    chat.setBusy(true);

    const toolCalls = new Map<string, { id: number; input: Record<string, unknown> }>();
    this.streaming = null;

    try {
      await this.plugin.agent.run(text, {
        onThinking: () => {
          this.endStream(false);
          chat.showThinking();
        },
        onTextDelta: (delta) => {
          chat.hideThinking();
          if (this.streaming) {
            this.streaming.text += delta;
            chat.updateAssistantMessage(this.streaming.id, this.streaming.text);
          } else {
            this.streaming = { id: chat.addAssistantMessage(delta, true), text: delta };
          }
        },
        onToolCall: (name, input) => {
          chat.hideThinking();
          // Streamed text the loop didn't deliver (it precedes ask_user,
          // which shows the question itself) is dropped, as before streaming.
          this.endStream(false);
          if (name === "ask_user") return;
          voice?.onToolCall(name);
          toolCalls.set(name, { id: chat.addToolCall(name, input), input });
        },
        onToolResult: (name, result: ToolResult) => {
          if (name === "ask_user") return;
          const call = toolCalls.get(name);
          if (call) chat.updateToolResult(call.id, name, result);
          history.push({ type: "tool-result", toolName: name, toolInput: savedToolInput(call?.input ?? {}), toolResult: result });
        },
        onResponse: (text) => {
          chat.hideThinking();
          // The whole text replaces the streamed one: same message as unstreamed.
          if (this.streaming) chat.updateAssistantMessage(this.streaming.id, text, true);
          else chat.addAssistantMessage(text);
          this.streaming = null;
          history.push({ type: "assistant", text });
          voice?.onText(text);
        },
        onAskUser: async (question) => {
          chat.hideThinking();
          this.endStream(false);
          chat.setInputEnabled(true);
          voice?.onAskUser(question);
          // Question and answer stay in the history, the answer without a
          // turn ID: it isn't a turn of its own, so it can't be edited.
          history.push({ type: "assistant", text: question });
          const answer = await chat.showAskUser(question);
          // Empty: the question was dropped (Stop, Clear, switching).
          if (answer) history.push({ type: "user", text: answer });
          chat.setInputEnabled(false);
          return answer;
        },
        onError: (error, kind) => {
          chat.hideThinking();
          this.endStream(true);
          chat.addError(error, kind);
          history.push({ type: "error", text: error, ...(kind ? { errorKind: kind } : {}) });
          voice?.onError(error);
        },
      }, selection, images, turnId, { voice: !!voice });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      chat.addError(`Unexpected error: ${msg}`);
      history.push({ type: "error", text: `Unexpected error: ${msg}` });
    } finally {
      // A stopped turn can end after a newer one has started (edit, or Stop
      // and send again); only the latest turn ends the running state.
      if (turn === this.turnCount) {
        this.running = false;
        chat.setInputEnabled(true);
        chat.setBusy(false);
        chat.focus();
        // Persist after each turn
        void this.plugin.saveChatHistory();
      }
    }
  }

  /**
   * Ends the streamed message the loop hasn't delivered whole: kept (and
   * saved for display) when the turn was stopped or failed, else removed.
   */
  private endStream(keep: boolean): void {
    const stream = this.streaming;
    if (!stream) return;
    this.streaming = null;
    if (keep) {
      this.chatContainer?.updateAssistantMessage(stream.id, stream.text, true);
      this.plugin.chatHistory.push({ type: "assistant", text: stream.text });
    } else {
      this.chatContainer?.removeMessage(stream.id);
    }
  }

  /** Stops the running turn; text already shown stays. */
  private stopTurn(): void {
    this.plugin.agent.abort();
    this.endStream(true);
    this.running = false;
    this.chatContainer?.cancelAskUser();
    this.chatContainer?.hideThinking();
  }

  private handleStop(): void {
    this.stopTurn();
    const chat = this.chatContainer;
    if (chat) {
      chat.setInputEnabled(true);
      chat.setBusy(false);
      chat.focus();
    }
    void this.plugin.saveChatHistory();
  }

  private handleClear(): void {
    this.endVoice();
    this.plugin.agent.abort();
    this.plugin.agent.clear();
    this.streaming = null;
    this.plugin.chatHistory = [];
    this.plugin.touchConversation();
    this.chatContainer?.setTitle(this.plugin.activeConversation.title);
    this.chatContainer?.clearMessages();
    this.running = false;
    this.chatContainer?.cancelAskUser();
    this.chatContainer?.setInputEnabled(true);
    this.chatContainer?.setBusy(false);
    // Clear persisted state
    void this.plugin.saveChatHistory();
  }
}
