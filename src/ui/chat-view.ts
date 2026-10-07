import { ItemView, WorkspaceLeaf, Notice, Platform } from "obsidian";
import { mount, unmount } from "svelte";
import type ChatPlugin from "../main";
import ChatContainer from "./ChatContainer.svelte";
import type { AgentCallbacks, ToolResult, SelectionScope, ImageAttachment, FileAttachment, ChatErrorKind, ChatHistoryEntry, VoiceTurn, ViewTarget } from "../types";
import { showInView } from "./show-in-view";
import { confirmUndo } from "./undo-confirm";
import { mentionContext, mentionedFiles } from "./mentions";
import { ChangeLog } from "../tools/undo";
import { voiceTranscriptText } from "../agent/system-prompt";
import { newTurnId } from "../agent/history";
import { savedToolInput } from "../chat-state";
import { debugLog } from "../debug";
import { VoiceController, VOICE_TIMING, type VoiceTurnHooks, type VoiceViewState } from "../voice/controller";
import { appLifecycle } from "../platform/lifecycle";
import { screenAwake } from "../platform/screen-awake";

export const VIEW_TYPE_CHAT = "chatting-minus-view";

/** Voice bar controls and the microphone button. */
export type VoiceAction = "start" | "end" | "mute" | "talk-start" | "talk-end" | "play";

/**
 * What the view calls on ChatContainer.svelte. tsc sees `.svelte` imports
 * as untyped (Svelte's ambient module), so the exports are spelled out
 * here; svelte-check checks the props passed to `mount()`.
 */
interface ChatContainerApi extends Record<string, unknown> {
  addUserMessage(text: string, images?: ImageAttachment[], turnId?: string, selection?: SelectionScope, files?: FileAttachment[]): void;
  addAssistantMessage(text: string, streaming?: boolean): number;
  updateAssistantMessage(id: number, text: string, final?: boolean): void;
  removeMessage(id: number): void;
  cutMessages(turnId: string): void;
  addToolCall(name: string, input: Record<string, unknown>): number;
  updateToolResult(msgId: number, name: string, result: ToolResult): void;
  addError(text: string, kind?: ChatErrorKind): void;
  /** The thinking indicator, with a short label such as "Resuming…". */
  showThinking(label?: string): void;
  hideThinking(): void;
  showAskUser(): Promise<string>;
  setInputEnabled(enabled: boolean): void;
  setBusy(busy: boolean): void;
  setQueued(texts: string[]): void;
  cancelAskUser(): void;
  clearMessages(): void;
  focus(): void;
  setModel(name: string, provider: string): void;
  setTitle(title: string): void;
  setSelection(selection: SelectionScope): void;
  getSelection(): SelectionScope | null;
  setVoice(state: VoiceViewState | null): void;
  setVoiceAvailable(available: boolean): void;
  setEnterSends(on: boolean): void;
  setFollowEdits(on: boolean): void;
  /** Offer Continue for a turn that was cut off (ADR-15). */
  setContinue(show: boolean): void;
  /** The row of files a turn changed; "kept": its undo was lost when Obsidian closed. */
  addChanges(turnId: string, files: string[], state: ChangesState): void;
  setChangesUndone(turnId: string): void;
}

export type ChangesState = "undoable" | "undone" | "kept";

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
  /** Some of the running turn's answer is on screen (streamed or whole). */
  private answerShown = false;
  /** Typed while a turn ran, until the agent takes them in or they run next (shown as queued). */
  private queued: string[] = [];
  /** Typed when no loop step could take them (the turn was ending): they run next. */
  private unsteered: string[] = [];
  /** Counts turns started here; only the latest one may end the running state. */
  private turnCount = 0;
  /** The assistant message being streamed, until the loop delivers it whole. */
  private streaming: { id: number; text: string } | null = null;
  /** The live voice conversation, while one runs (ADR-11). */
  private voice: VoiceController | null = null;
  /** Stops following the background for voice; set once voice was first started. */
  private unwatchBackground?: () => void;
  private markReady!: () => void;
  /** Resolves once onOpen() has mounted the chat UI, or failed to. */
  readonly ready: Promise<void> = new Promise((resolve) => { this.markReady = resolve; });

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
    try {
      this.mountChat();
      this.followKeyboardOnPhone();
    } finally {
      // Also when mounting failed: commands waiting for the view go on
      // (its methods do nothing without the UI) instead of waiting forever.
      this.markReady();
    }
  }

  /**
   * Phones: Obsidian doesn't shrink the sidebar for the keyboard, it only
   * sets --keyboard-height (and drops the sidebar's bottom padding). With
   * the keyboard open, measure how much of the view it covers and lift the
   * chat by that (`--chatting-minus-lift`, styles.css). Measured, not
   * predicted: whatever lies below the view, the input ends at the keyboard.
   * Runs when Obsidian changes the keyboard state (its style and class on
   * <html> and <body>) and when the view's size changes.
   */
  private followKeyboardOnPhone(): void {
    if (!Platform.isPhone) return;
    const view = this.contentEl;
    const update = () => {
      const keyboard = Number.parseFloat(getComputedStyle(document.body).getPropertyValue("--keyboard-height")) || 0;
      const rect = view.getBoundingClientRect();
      const lift = keyboard > 0 && rect.height > 0 ? Math.max(0, Math.round(rect.bottom - (window.innerHeight - keyboard))) : 0;
      view.style.setProperty("--chatting-minus-lift", `${lift}px`);
    };
    const resize = new ResizeObserver(update);
    resize.observe(view);
    const keyboardState = new MutationObserver(update);
    for (const el of [document.documentElement, document.body]) {
      keyboardState.observe(el, { attributes: true, attributeFilter: ["style", "class"] });
    }
    this.register(() => {
      resize.disconnect();
      keyboardState.disconnect();
    });
  }

  private mountChat(): void {
    const container = this.contentEl;
    container.empty();
    container.addClass("chatting-minus-view-container");

    const chat = mount(ChatContainer, {
      target: container,
      props: {
        app: this.app,
        component: this,
        onSend: (text: string, selection: SelectionScope | null, images: ImageAttachment[], files: FileAttachment[]) => {
          void this.handleUserMessage(text, selection, images, newTurnId(), undefined, [], files);
        },
        onClear: () => this.handleClear(),
        onStop: () => this.handleStop(),
        onEdit: (turnId: string, text: string) => void this.editMessage(turnId, text),
        onRegenerate: () => void this.regenerate(),
        onCopy: (text: string) => this.copyAnswer(text),
        onNewChat: () => this.newChat(),
        listConversations: () => this.plugin.listConversations(),
        onOpenConversation: (id: string) => this.openConversation(id),
        onRenameConversation: (id: string, title: string) => this.renameConversation(id, title),
        onDeleteConversation: (id: string) => this.deleteConversation(id),
        onVoice: (action: VoiceAction) => this.handleVoice(action),
        onContinue: () => void this.continueTurn(),
        onToggleFollow: () => void this.toggleFollow(),
        onUndo: (turnId: string) => void this.undoChanges(turnId),
      },
    }) as ChatContainerApi;
    this.chatContainer = chat;
    chat.setModel(this.plugin.modelHeaderLabel(), this.plugin.settings.provider);
    chat.setTitle(this.plugin.activeConversation.title);
    this.updateVoiceAvailable();
    this.updateEnterSends();
    this.renderHistory();
    chat.focus();
  }

  /** Show the plugin's chat history in the UI, replacing what it shows. */
  renderHistory(): void {
    this.chatContainer?.clearMessages();
    for (const entry of this.plugin.chatHistory) this.render(entry);
    this.chatContainer?.setContinue(this.canContinue());
  }

  /**
   * The saved conversation's turn was cut off (Obsidian was ended in the
   * middle of it, ADR-15) and the model still owes an answer.
   */
  private canContinue(): boolean {
    return !this.running && !!this.plugin.activeConversation.pendingTurn && this.plugin.agent.owesAnswer();
  }

  /** Forget a cut-off turn: no Continue (Stop, Clear, switching). */
  private dismissContinue(): void {
    delete this.plugin.activeConversation.pendingTurn;
    this.chatContainer?.setContinue(false);
  }

  /** Show one history entry at the end of the chat. */
  private render(entry: ChatHistoryEntry): void {
    const chat = this.chatContainer;
    if (!chat) return;
    switch (entry.type) {
      case "user":
        chat.addUserMessage(entry.text ?? "", entry.images, entry.turnId, entry.selection, entry.attachedFiles);
        break;
      case "assistant":
        chat.addAssistantMessage(entry.text ?? "");
        break;
      case "tool-result":
        if (entry.toolName && entry.toolResult) {
          const id = chat.addToolCall(entry.toolName, entry.toolInput ?? {});
          chat.updateToolResult(id, entry.toolName, entry.toolResult);
        }
        break;
      case "error":
        chat.addError(entry.text ?? "", entry.errorKind);
        break;
      case "changes":
        if (entry.turnId) {
          const state = entry.undone ? "undone" : this.plugin.changeLogs.has(entry.turnId) ? "undoable" : "kept";
          chat.addChanges(entry.turnId, entry.files ?? [], state);
        }
        break;
    }
  }

  /**
   * Add `entry` to a conversation's history (the running turn's) and show
   * it the way a reload would. Only a streamed answer and a tool card, which
   * are shown while they arrive, are added to the history on their own.
   */
  private append(history: ChatHistoryEntry[], entry: ChatHistoryEntry): void {
    history.push(entry);
    this.render(entry);
  }

  async onClose(): Promise<void> {
    this.endVoice();
    this.unwatchBackground?.();
    this.plugin.agent.abort();
    if (this.chatContainer) {
      await unmount(this.chatContainer);
      this.chatContainer = undefined;
    }
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

  /** Enter sends, or starts a new line (the "Enter sends message" setting). */
  updateEnterSends(): void {
    this.chatContainer?.setEnterSends(this.plugin.settings.enterSends);
    this.chatContainer?.setFollowEdits(this.plugin.settings.followEdits);
  }

  /** The eye button: the "Follow the AI's edits" setting, on or off. */
  private async toggleFollow(): Promise<void> {
    this.plugin.settings.followEdits = !this.plugin.settings.followEdits;
    await this.plugin.saveSettings();
  }

  /** Show or hide the microphone button (a voice route is set up or not). */
  updateVoiceAvailable(): void {
    this.chatContainer?.setVoiceAvailable(this.plugin.voiceRoute() !== null);
  }

  /** Start a voice conversation in the current conversation. */
  startVoice(options: { reconnecting?: boolean; micOn?: boolean } = {}): void {
    if (this.voice) return;
    const route = this.plugin.voiceRoute();
    if (!route) {
      new Notice("Set up voice in Chatting with AI Minus settings.");
      return;
    }
    // The screen stays on during the call (released when it ends).
    const releaseScreen = screenAwake.hold();
    const controller: VoiceController = new VoiceController({
      runTurn: (text, hooks, context) => this.handleUserMessage(text, null, [], newTurnId(), hooks, context),
      // A spoken request while the voice turn runs is added to it.
      steerTurn: (text, context) => this.running && this.steerByVoice(text, context),
      takeSteered: () => this.takeLeftovers(),
      stopTurn: () => this.handleStop(),
      turnRunning: () => this.running,
      history: () => this.plugin.chatHistory,
      showError: (message) => {
        this.append(this.plugin.chatHistory, { type: "error", text: message });
        void this.plugin.saveChatHistory();
      },
      render: (state) => {
        if (this.voice !== controller) return;
        if (!state) {
          this.voice = null;
          releaseScreen();
        }
        this.chatContainer?.setVoice(state);
      },
      log: (label, data) => debugLog(this.app, label, data),
    }, route, this.plugin.settings.voiceMicMode === "hold", options);
    this.voice = controller;
    this.unwatchBackground ??= this.watchVoiceBackground();
    void controller.start();
  }

  /**
   * Mobile (ADR-15): in the background the microphone records only
   * silence and the call may drop. Leaving turns the microphone off and
   * ends the call after `endAfter` (nobody hears it, and it is billed by
   * the minute). Back sooner, a working call gets its microphone back;
   * one that dropped, or after more than `reconnectAfter`, is replaced.
   * Desktop: a minimised window keeps the call. Returns the unsubscribe.
   */
  private watchVoiceBackground(): () => void {
    let endTimer = 0;
    const offHidden = appLifecycle.onHidden(() => {
      if (!Platform.isMobileApp || !this.voice) return;
      this.voice.enterBackground();
      endTimer = window.setTimeout(() => this.endVoice(), VOICE_TIMING.endAfter);
    });
    const offVisible = appLifecycle.onVisible((hiddenMs) => {
      window.clearTimeout(endTimer);
      const voice = this.voice;
      if (!Platform.isMobileApp || !voice) return;
      if (hiddenMs >= VOICE_TIMING.endAfter) this.endVoice();
      else if (!voice.leaveBackground(hiddenMs)) this.reconnectVoice();
    });
    return () => {
      offHidden();
      offVisible();
      window.clearTimeout(endTimer);
    };
  }

  /**
   * Replace the voice conversation: the old call ends quietly, a new one
   * starts ("Reconnecting…"), seeded with the chat as it is now, so an
   * answer finished meanwhile is included. If it fails, the error shows.
   */
  private reconnectVoice(): void {
    const old = this.voice;
    if (!old) return;
    this.voice = null;
    void old.end();
    this.startVoice({ reconnecting: true, micOn: old.isMicOn() });
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
    this.dismissContinue();
    this.plugin.startNewConversation();
    this.showConversation();
  }

  /** Switch to conversation `id`. */
  openConversation(id: string): void {
    if (id === this.plugin.activeConversationId) return;
    this.endVoice();
    if (this.running) this.stopTurn();
    this.dismissContinue();
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
    const files = (history[index].attachedFiles ?? []).filter((file) => file.data || file.text);
    if (!text.trim() && images.length === 0 && files.length === 0) return;
    if (this.running) this.stopTurn();
    this.plugin.agent.cutBeforeTurn(turnId);
    this.plugin.chatHistory = this.plugin.chatHistory.slice(0, index);
    this.chatContainer?.cutMessages(turnId);
    // The saved state is taken now, before the new turn starts.
    void this.plugin.saveChatHistory();
    await this.handleUserMessage(text, selection, images, newTurnId(), undefined, [], files);
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

  /**
   * Run one turn; `voice`: it comes from the voice conversation, which gets
   * its progress and answer. `voiceContext`: what was said there since the
   * last request; the agent gets it all, the chat shows the user's words
   * before the request.
   */
  private async handleUserMessage(
    text: string,
    selection: SelectionScope | null,
    images: ImageAttachment[] = [],
    turnId: string = newTurnId(),
    voice?: VoiceTurnHooks,
    voiceContext: VoiceTurn[] = [],
    files: FileAttachment[] = []
  ): Promise<void> {
    // While a turn runs, a typed message is added to it (steering, as in voice).
    if (this.running) {
      this.addToRunningTurn(text);
      return;
    }
    const chat = this.chatContainer;
    if (!chat) return;
    // A user turn at the end is the request itself, as the voice put it.
    const said = voiceContext.at(-1)?.role === "user" ? voiceContext.slice(0, -1) : voiceContext;
    for (const turn of said) {
      if (turn.role === "user") this.append(this.plugin.chatHistory, { type: "user", text: turn.text });
    }
    this.append(this.plugin.chatHistory, { type: "user", text, images, turnId, ...(selection ? { selection } : {}), ...(files.length ? { attachedFiles: files } : {}) });
    this.plugin.touchConversation();
    const conversation = this.plugin.activeConversation;
    chat.setTitle(conversation.title);
    // Told once, with this turn.
    const notes = conversation.notes ?? [];
    delete conversation.notes;
    await this.runTurn(turnId, async (callbacks) => {
      // The files the message links to go along as they are now.
      const app = this.plugin.app;
      const source = app.workspace.getActiveFile()?.path ?? "";
      const mentioned = await mentionContext(app, mentionedFiles(app, text, source));
      await this.plugin.agent.run(text, callbacks, selection, images, turnId, { voice: !!voice, voiceTranscript: voiceContext, notes, mentioned, files });
    }, voice);
  }

  /**
   * Continue the turn that was cut off when Obsidian was ended in the
   * middle of it (ADR-15): the agent runs on its history as saved, with
   * no new user message; tool results already there aren't run again.
   */
  async continueTurn(): Promise<void> {
    const pending = this.plugin.activeConversation.pendingTurn;
    if (!pending || !this.canContinue()) return;
    await this.runTurn(pending.turnId, (callbacks) => this.plugin.agent.continueTurn(callbacks));
  }

  /**
   * Run turn `turnId` through `start` with the view's callbacks: progress,
   * tool cards and the answer go to the chat and its history; saved at the
   * end. While it runs the conversation carries it as its pending turn.
   */
  private async runTurn(
    turnId: string,
    start: (callbacks: AgentCallbacks) => Promise<void>,
    voice?: VoiceTurnHooks,
  ): Promise<void> {
    const chat = this.chatContainer;
    if (!chat) return;
    const history = this.plugin.chatHistory;
    const conversation = this.plugin.activeConversation;

    this.running = true;
    this.answerShown = false;
    const turn = ++this.turnCount;
    // The screen stays on while the answer is generated.
    const releaseScreen = screenAwake.hold();
    // Saved with the chat when the app goes to the background; still there
    // at the next start, the turn was cut off.
    conversation.pendingTurn = { turnId, startedAt: Date.now() };
    chat.setContinue(false);
    // The input stays usable: what is sent now is added to this turn.
    chat.setBusy(true);

    const toolCalls = new Map<string, { id: number; input: Record<string, unknown> }>();
    this.streaming = null;
    const changes = new ChangeLog();

    try {
      await start({
        changes,
        onThinking: () => {
          this.endStream(false);
          chat.showThinking();
        },
        // The failed attempt's streamed text goes; the answer streams anew.
        onResuming: () => {
          this.endStream(false);
          chat.showThinking("Resuming…");
        },
        onTextDelta: (delta) => {
          this.answerShown = true;
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
        onToolResult: (name, { focus, ...result }: ToolResult) => {
          if (name === "ask_user") return;
          const call = toolCalls.get(name);
          if (call) chat.updateToolResult(call.id, name, result);
          history.push({ type: "tool-result", toolName: name, toolInput: savedToolInput(call?.input ?? {}), toolResult: result });
          if (focus && !result.isError && this.plugin.settings.followEdits) this.follow(focus);
        },
        onResponse: (text) => {
          this.answerShown = true;
          chat.hideThinking();
          // The whole text replaces the streamed one: same message as unstreamed.
          if (this.streaming) {
            chat.updateAssistantMessage(this.streaming.id, text, true);
            history.push({ type: "assistant", text });
          } else {
            this.append(history, { type: "assistant", text });
          }
          this.streaming = null;
          voice?.onText(text);
        },
        onAskUser: async (question) => {
          chat.hideThinking();
          this.endStream(false);
          chat.setInputEnabled(true);
          // Question and answer stay in the history, the answer without a
          // turn ID: it isn't a turn of its own, so it can't be edited.
          this.append(history, { type: "assistant", text: question });
          const answer = await chat.showAskUser();
          // Empty: the question was dropped (Stop, Clear, switching).
          if (answer) this.append(history, { type: "user", text: answer });
          return answer;
        },
        onError: (error, kind) => {
          chat.hideThinking();
          this.endStream(true);
          this.append(history, { type: "error", text: error, ...(kind ? { errorKind: kind } : {}) });
          voice?.onError(error);
        },
        // Added to the running turn (typed or spoken): shown where the agent took it in.
        onSteered: (text) => {
          this.endStream(false);
          this.append(history, { type: "user", text });
          const index = this.queued.indexOf(text);
          if (index >= 0) {
            this.queued.splice(index, 1);
            chat.setQueued([...this.queued]);
          }
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.append(history, { type: "error", text: `Unexpected error: ${msg}` });
    } finally {
      releaseScreen();
      if (conversation.pendingTurn?.turnId === turnId) delete conversation.pendingTurn;
      if (!changes.isEmpty()) this.addChanges(history, turnId, changes);
      // A stopped turn can end after a newer one has started (edit, or Stop
      // and send again); only the latest turn ends the running state.
      if (turn === this.turnCount) {
        this.running = false;
        chat.setInputEnabled(true);
        chat.setBusy(false);
        chat.focus();
        // Persist after each turn
        void this.plugin.saveChatHistory();
        // Typed after the turn's last step: they run as the next turn. (A
        // voice turn's controller takes its leftovers itself, unless the
        // call has ended meanwhile.)
        if (!voice?.active()) {
          const later = this.takeLeftovers();
          if (later.length) void this.handleUserMessage(later.join("\n\n"), null);
        }
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
  /** A message typed while the turn runs: the agent takes it in after its current step. */
  private addToRunningTurn(text: string): void {
    this.queued.push(text);
    this.chatContainer?.setQueued([...this.queued]);
    if (!this.plugin.agent.steer(text)) this.unsteered.push(text);
  }

  /** A spoken request while the voice's turn runs: added to it with what was said before it. */
  private steerByVoice(text: string, context: VoiceTurn[] = []): boolean {
    if (!this.plugin.agent.steer(text, context.length ? voiceTranscriptText(context) : undefined)) return false;
    this.queued.push(text);
    this.chatContainer?.setQueued([...this.queued]);
    return true;
  }

  /** Added messages the turn didn't take in; they leave the queue (they run next). */
  private takeLeftovers(): string[] {
    const later = [...this.unsteered.splice(0), ...this.plugin.agent.takeSteered()];
    this.queued = this.queued.filter((text) => !later.includes(text));
    this.chatContainer?.setQueued([...this.queued]);
    return later;
  }

  /** Drop what was added to the running turn (Stop, Clear drop the turn too). */
  private dropQueued(): void {
    this.queued = [];
    this.unsteered = [];
    this.chatContainer?.setQueued([]);
  }

  // ─── Undo per answer ────────────────────────────────────────────────
  // A turn that changed the vault ends in a row listing its files, with
  // Undo while Obsidian runs (the snapshots are kept in memory only).

  /**
   * Add turn `turnId`'s changes row at the end of its turn: at the end of
   * `history`, or before a later turn that started meanwhile (Stop, then
   * send again).
   */
  private addChanges(history: ChatHistoryEntry[], turnId: string, changes: ChangeLog): void {
    this.plugin.changeLogs.set(turnId, changes);
    const entry: ChatHistoryEntry = { type: "changes", turnId, files: changes.files() };
    const start = history.findIndex((item) => item.type === "user" && item.turnId === turnId);
    const later = history.findIndex((item, i) => i > start && item.type === "user" && !!item.turnId && item.turnId !== turnId);
    const shown = history === this.plugin.chatHistory;
    if (later === -1) {
      history.push(entry);
      if (shown) this.render(entry);
    } else {
      history.splice(later, 0, entry);
      if (shown) this.renderHistory();
    }
  }

  /**
   * Undo the vault changes of turn `turnId`. Files changed since (by the
   * user or a later answer) are named first and change back only if the
   * user agrees. The model is told with the next turn.
   */
  async undoChanges(turnId: string): Promise<void> {
    const log = this.plugin.changeLogs.get(turnId);
    const entry = this.plugin.chatHistory.find((item) => item.type === "changes" && item.turnId === turnId);
    if (!log || !entry || entry.undone || this.running) return;
    const app = this.plugin.app;
    const changed = await log.conflicts(app);
    if (changed.length && !await confirmUndo(app, changed)) return;
    const failed = await log.undo(app);
    this.plugin.changeLogs.delete(turnId);
    entry.undone = true;
    const conversation = this.plugin.activeConversation;
    const files = (entry.files ?? []).join(", ");
    conversation.notes = [...conversation.notes ?? [], `The user undid the changes of one of your earlier answers in this chat: ${files} are back as they were before that answer.`];
    this.chatContainer?.setChangesUndone(turnId);
    if (failed.length) new Notice(`Couldn't undo all changes:\n${failed.join("\n")}`);
    void this.plugin.saveChatHistory();
  }

  /** Edits shown one after another, in the order the AI made them. */
  private following: Promise<unknown> = Promise.resolve();

  /** Show an edit the AI just made (setting "Follow the AI's edits"). */
  private follow(target: ViewTarget): void {
    this.following = this.following.then(() => showInView(this.plugin.app, target)).catch(() => undefined);
  }

  private stopTurn(): void {
    this.dropQueued();
    this.plugin.agent.abort();
    this.endStream(true);
    this.running = false;
    this.dismissContinue();
    this.chatContainer?.cancelAskUser();
    this.chatContainer?.hideThinking();
  }

  private handleStop(): void {
    // Without streaming (the ChatGPT plan on phones) nothing of the answer
    // is on screen yet: say that the turn was stopped.
    const silent = this.running && !this.answerShown;
    this.stopTurn();
    if (silent) this.append(this.plugin.chatHistory, { type: "error", text: "Stopped.", errorKind: "stopped" });
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
    this.dismissContinue();
    this.dropQueued();
    this.plugin.agent.clear();
    this.streaming = null;
    this.plugin.chatHistory = [];
    delete this.plugin.activeConversation.notes;
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
