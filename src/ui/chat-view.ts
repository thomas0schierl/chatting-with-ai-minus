import { ItemView, WorkspaceLeaf, Notice, type App } from "obsidian";
import { mount, unmount } from "svelte";
import type { Component } from "svelte";
import type ChatPlugin from "../main";
import ChatContainer from "./ChatContainer.svelte";
import type { ToolResult, SelectionScope, ImageAttachment } from "../types";
import { newTurnId } from "../agent/history";

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
}

interface ChatContainerApi extends Record<string, unknown> {
  addUserMessage(text: string, images?: ImageAttachment[], turnId?: string, selection?: SelectionScope): void;
  addAssistantMessage(text: string, streaming?: boolean): number;
  updateAssistantMessage(id: number, text: string, final?: boolean): void;
  removeMessage(id: number): void;
  cutMessages(turnId: string): void;
  addToolCall(name: string, input: Record<string, unknown>): number;
  updateToolResult(msgId: number, name: string, result: ToolResult): void;
  addError(text: string): void;
  showThinking(): void;
  hideThinking(): void;
  showAskUser(question: string): Promise<string>;
  setInputEnabled(enabled: boolean): void;
  setBusy(busy: boolean): void;
  cancelAskUser(): void;
  clearMessages(): void;
  focus(): void;
  setModel(name: string): void;
  setSelection(selection: SelectionScope): void;
  getSelection(): SelectionScope | null;
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
          chat.addError(msg.text!);
          break;
      }
    }
  }

  async onClose(): Promise<void> {
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

  /** Update the model display name in the header */
  updateModel(name: string): void {
    this.chatContainer?.setModel(name);
  }

  /** Clear conversation */
  clearConversation(): void {
    this.handleClear();
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

  private async handleUserMessage(
    text: string,
    selection: SelectionScope | null,
    images: ImageAttachment[] = [],
    turnId: string = newTurnId()
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
    chat.setInputEnabled(false);
    chat.setBusy(true);

    const toolCallIds = new Map<string, number>();
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
          const msgId = chat.addToolCall(name, input);
          toolCallIds.set(`latest-${name}`, msgId);
        },
        onToolResult: (name, result: ToolResult) => {
          if (name === "ask_user") return;
          const msgId = toolCallIds.get(`latest-${name}`);
          if (msgId !== undefined) {
            chat.updateToolResult(msgId, name, result);
          }
          history.push({ type: "tool-result", toolName: name, toolInput: {}, toolResult: result });
        },
        onResponse: (text) => {
          chat.hideThinking();
          // The whole text replaces the streamed one: same message as unstreamed.
          if (this.streaming) chat.updateAssistantMessage(this.streaming.id, text, true);
          else chat.addAssistantMessage(text);
          this.streaming = null;
          history.push({ type: "assistant", text });
        },
        onAskUser: async (question) => {
          chat.hideThinking();
          this.endStream(false);
          chat.setInputEnabled(true);
          const answer = await chat.showAskUser(question);
          chat.setInputEnabled(false);
          return answer;
        },
        onError: (error) => {
          chat.hideThinking();
          this.endStream(true);
          chat.addError(error);
          history.push({ type: "error", text: error });
        },
      }, selection, images, turnId);
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
    this.plugin.agent.abort();
    this.plugin.agent.clear();
    this.streaming = null;
    this.plugin.chatHistory = [];
    this.chatContainer?.clearMessages();
    this.running = false;
    this.chatContainer?.cancelAskUser();
    this.chatContainer?.setInputEnabled(true);
    this.chatContainer?.setBusy(false);
    // Clear persisted state
    void this.plugin.saveChatHistory();
  }
}
