// Bundled with the components' CSS into styles.css (esbuild.config.mjs).
import "./styles.css";
import {
  Plugin,
  Notice,
  type MarkdownFileInfo,
  type Editor,
  Menu,
  TFile,
  type TAbstractFile,
} from "obsidian";
import type { ChatSettings, SelectionScope, ChatHistoryEntry, ConversationSummary } from "./types";
import { DEFAULT_SETTINGS, DEFAULT_PROVIDER_MODELS } from "./types";
import { ChatSettingTab, getModelHeaderLabel } from "./settings";
import { ObsidianChatView, VIEW_TYPE_CHAT } from "./ui/chat-view";
import { AgentLoop } from "./agent/loop";
import {
  CHAT_STATE_VERSION,
  conversationTitle,
  isEmptyConversation,
  migrateChatState,
  newConversation,
  newestFirst,
  restoreImages,
  savedConversation,
  type ChatState,
  type ConversationRecord,
} from "./chat-state";
import { ChatGPTOAuthStore } from "./auth/chatgptOAuthStore";
import { ChatGPTOAuthService } from "./auth/chatgptOAuth";
import { cachedCatalog, catalogIdentity, codexClientVersion, normalizeCatalogState, secretIdentity } from "./api/model-catalog";
import { setChatGPTOAuthService } from "./api/chatgpt-oauth";
import { PLUGIN_ID } from "./plugin-id";
import { runCapabilityCheck } from "./diagnostics/capability-check";
import type { VoiceRoute } from "./voice/session";
import { openAILiveRoute } from "./voice/openai-live";
import { isRecord } from "./json";
import { CodexVoiceAuth, codexVoiceRoute } from "./voice/codex";
import { appLifecycle } from "./platform/lifecycle";
import { debugLog, readDebugLog, setDebugLogging } from "./debug";

export default class ChatPlugin extends Plugin {
  settings: ChatSettings = { ...DEFAULT_SETTINGS, modelCatalog: { entries: [] } };
  /** Shared agent loop that persists across view open/close cycles */
  agent!: AgentLoop;
  /** ChatGPT OAuth service (used by the chatgpt-oauth provider). */
  chatgptOAuth!: ChatGPTOAuthService;
  /** The Codex sign-in for voice; private builds only (ADR-14). */
  codexVoice?: CodexVoiceAuth;
  /**
   * All conversations. The active one's API history lives in `agent` and
   * is copied into its record when saving or switching.
   */
  conversations: ConversationRecord[] = [newConversation()];
  activeConversationId = this.conversations[0].id;
  /** Set once the saved chat has been read; saving earlier would overwrite it with an empty one. */
  private chatHistoryLoaded = false;
  /** The write of `chat-state.json` in progress, and the one queued after it. */
  private chatStateWrite: Promise<void> | null = null;
  private nextChatStateWrite: Promise<void> | null = null;

  get activeConversation(): ConversationRecord {
    return this.conversations.find((conversation) => conversation.id === this.activeConversationId)
      ?? this.conversations[0];
  }

  /** The active conversation's messages, for replaying into the UI when the view reopens. */
  get chatHistory(): ChatHistoryEntry[] {
    return this.activeConversation.chatHistory;
  }

  set chatHistory(entries: ChatHistoryEntry[]) {
    this.activeConversation.chatHistory = entries;
  }

  async onload(): Promise<void> {
    await this.loadSettings();

    // Wire ChatGPT OAuth before constructing the agent: the OAuth API client
    // looks up the service via setChatGPTOAuthService().
    const oauthStore = new ChatGPTOAuthStore(this.app);
    this.chatgptOAuth = new ChatGPTOAuthService(oauthStore);
    setChatGPTOAuthService(this.chatgptOAuth);
    if (__CODEX_VOICE__) this.codexVoice = new CodexVoiceAuth(this.app);
    // The chat header shows the thinking level from the saved catalog.
    await this.activateModelCatalog();

    this.agent = new AgentLoop(this.app, this.settings);

    // Restore persisted chat history
    await this.loadChatHistory();
    this.watchLifecycle();

    this.addSettingTab(new ChatSettingTab(this.app, this));

    // Register sidebar view (loads deferred by default in v1.7.2+)
    this.registerView(VIEW_TYPE_CHAT, (leaf) => new ObsidianChatView(leaf, this));

    // Ribbon icon (users can hide; commands are the primary access)
    this.addRibbonIcon("message-circle", "Open Chatting with AI Minus", (evt) => {
      if (evt.type === "contextmenu" || evt.button === 2) {
        // Right-click: show menu with options
        const menu = new Menu();
        menu.addItem((item) =>
          item.setTitle("Open chat").setIcon("message-circle").onClick(() => void this.openChat())
        );
        menu.addItem((item) =>
          item.setTitle("New chat").setIcon("square-pen").onClick(() => void this.newChat())
        );
        menu.addItem((item) =>
          item.setTitle("Chat about active note").setIcon("file-text").onClick(() => void this.chatAboutActiveNote())
        );
        menu.addItem((item) =>
          item.setTitle("Copy transcript").setIcon("clipboard").onClick(() => this.shareTranscript())
        );
        menu.showAtMouseEvent(evt);
      } else {
        void this.openChat();
      }
    });

    // ─── Commands ────────────────────────────────────────────────────────

    this.addCommand({
      id: "open-chat",
      name: "Open chat",
      callback: () => void this.openChat(),
    });

    this.addCommand({
      id: "new-chat",
      name: "New chat",
      callback: () => void this.newChat(),
    });

    this.addCommand({
      id: "copy-transcript",
      name: "Copy conversation transcript to clipboard",
      callback: () => this.shareTranscript(),
    });

    this.addCommand({
      id: "clear-chat",
      name: "Clear conversation",
      callback: () => this.clearChat(),
    });

    // Gets the debug log off a phone: paste it into a note or a message.
    this.addCommand({
      id: "copy-debug-log",
      name: "Copy debug log",
      callback: () => void this.copyDebugLog(),
    });

    // Diagnostics for live voice and streaming on this device (ADR-11, ADR-12)
    this.addCommand({
      id: "check-device-capabilities",
      name: "Check device capabilities (voice, streaming)",
      callback: () => void runCapabilityCheck(this.app, {
        openai: this.loadApiKey("openai"),
        anthropic: this.loadApiKey("anthropic"),
      }),
    });

    // Editor command: chat about the current note (only when editor is active)
    this.addCommand({
      id: "chat-about-note",
      name: "Chat about this note",
      editorCallback: (editor: Editor, ctx: MarkdownFileInfo) => {
        void this.openChatWithMessage(`Summarize this note: ${ctx.file?.path ?? "the active document"}`);
      },
    });

    // Editor command: chat about selected text (conditional, only when text is selected)
    this.addCommand({
      id: "send-selection",
      name: "Send selection to chat",
      editorCheckCallback: (checking: boolean, editor: Editor, ctx: MarkdownFileInfo) => {
        const sel = editor.getSelection();
        if (!sel || sel.length === 0) return false;
        if (checking) return true;
        const scope: SelectionScope = { text: sel, filePath: ctx.file?.path ?? "" };
        void this.openChatWithSelection(scope);
        return true;
      },
    });

    // ─── Context menus ──────────────────────────────────────────────────

    // File explorer context menu
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        menu.addItem((item) =>
          item
            .setTitle("Chat about this note")
            .setIcon("message-circle")
            .onClick(() => void this.openChatWithMessage(`Tell me about ${file.path}`))
        );
      })
    );

    // Editor right-click context menu
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, info: MarkdownFileInfo) => {
        const sel = editor.getSelection();
        if (sel && sel.length > 0) {
          menu.addItem((item) =>
            item
              .setTitle("Send selection to chat")
              .setIcon("message-circle")
              .onClick(() => {
                const scope: SelectionScope = { text: sel, filePath: info.file?.path ?? "" };
                void this.openChatWithSelection(scope);
              })
          );
        }
      })
    );
  }

  /**
   * Foreground or background (ADR-15). Leaving saves the chats: a phone
   * may end Obsidian in the background, even in the middle of a turn.
   */
  private watchLifecycle(): void {
    appLifecycle.watch(this, (hint, visibility) => debugLog(this.app, "LIFECYCLE", { hint, visibility }));
    this.register(appLifecycle.onHidden(() => void this.saveChatHistory()));
  }

  onunload(): void {
    this.getChatView()?.endVoice();
    void this.saveChatHistory();
  }

  /**
   * The voice route the settings choose, or null when it isn't set up: an
   * OpenAI API key (official), or in private builds the Codex sign-in
   * (ADR-14).
   */
  voiceRoute(): VoiceRoute | null {
    const s = this.settings;
    if (__CODEX_VOICE__ && s.voiceRoute === "codex") {
      const auth = this.codexVoice;
      if (!auth?.getCredential()) return null;
      return codexVoiceRoute(auth, s.codexVoice, () => codexClientVersion(s.modelCatalog, false));
    }
    const key = this.loadApiKey("openai");
    return key ? openAILiveRoute(key, s.voice) : null;
  }

  /**
   * Save the OpenAI API key from the voice settings. It is the OpenAI
   * provider's key too, so the provider's copy in the settings follows.
   */
  async saveOpenAIKey(key: string): Promise<void> {
    this.saveApiKey("openai", key);
    if (this.settings.provider === "openai") this.settings.apiKey = key;
    await this.saveSettings();
  }

  // ─── Chat operations ────────────────────────────────────────────────

  /**
   * Which account the current provider runs as (API key or ChatGPT
   * account); empty when it isn't set up. See `secretIdentity()`.
   */
  secretIdentity(): string {
    const { provider, apiKey } = this.settings;
    return secretIdentity(provider, apiKey, () => this.chatgptOAuth?.getCredential());
  }

  /** The active provider can send a message: an API key, or a ChatGPT sign-in. */
  private isProviderConfigured(): boolean {
    return !!this.secretIdentity();
  }

  private notConfiguredMessage(): string {
    if (this.settings.provider === "chatgpt-oauth") {
      return "Connect your ChatGPT account in Chatting with AI Minus settings.";
    }
    return "Please configure your API key in Chatting with AI Minus settings.";
  }

  /** Opens the chat view, ready for use; null (with a notice) when the provider isn't set up. */
  private async openChat(): Promise<ObsidianChatView | null> {
    if (!this.isProviderConfigured()) {
      new Notice(this.notConfiguredMessage());
      return null;
    }
    return this.activateView();
  }

  /** Open chat and immediately send a message */
  private async openChatWithMessage(message: string): Promise<void> {
    const view = await this.openChat();
    if (!view) return;
    // A new topic: in a new conversation, like the chat apps.
    view.newChat();
    view.sendMessage(message);
  }

  /** Open a new chat with a selection scope (shows pill, user types their own question) */
  private async openChatWithSelection(selection: SelectionScope): Promise<void> {
    const view = await this.openChat();
    if (!view) return;
    view.newChat();
    view.setSelection(selection);
    view.focus();
  }

  private async chatAboutActiveNote(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("No active note.");
      return;
    }
    await this.openChatWithMessage(`Tell me about ${file.path}`);
  }

  /**
   * Open or reveal the chat view in the right sidebar (both desktop and
   * mobile); resolves with the view once its UI is mounted.
   */
  private async activateView(): Promise<ObsidianChatView | null> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
    if (!leaf) {
      // Right sidebar on both desktop and mobile.
      // On mobile, this slides in as a panel from the right edge.
      const right = workspace.getRightLeaf(false);
      if (!right) return null;
      await right.setViewState({ type: VIEW_TYPE_CHAT, active: true });
      leaf = right;
    }
    // Also loads a deferred view (Obsidian 1.7.2+).
    await workspace.revealLeaf(leaf);
    if (!(leaf.view instanceof ObsidianChatView)) return null;
    await leaf.view.ready;
    return leaf.view;
  }

  /** Get the active ObsidianChatView using proper instanceof check (deferred view safe) */
  private getChatView(): ObsidianChatView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT);
    for (const leaf of leaves) {
      if (leaf.view instanceof ObsidianChatView) {
        return leaf.view;
      }
    }
    return null;
  }

  /** Copy the current conversation's API history as Markdown (for debugging). */
  private shareTranscript(): void {
    if (this.agent.isEmpty()) {
      new Notice("Conversation is empty.");
      return;
    }

    navigator.clipboard.writeText(this.agent.exportTranscript()).then(() => {
      new Notice("Transcript copied to clipboard.");
    }).catch(() => {
      new Notice("Failed to copy transcript.");
    });
  }

  private clearChat(): void {
    const view = this.getChatView();
    if (view) {
      view.clearConversation();
      new Notice("Conversation cleared.");
    } else {
      new Notice("No active conversation.");
    }
  }

  /** Opens the chat on a new conversation. */
  private async newChat(): Promise<void> {
    const view = this.getChatView();
    if (view) view.newChat();
    else this.startNewConversation();
    await this.openChat();
  }

  // ─── Conversations ──────────────────────────────────────────────────
  // The view stops a running turn before calling these.

  /** Conversations with content, most recently used first (the history list). */
  listConversations(): ConversationSummary[] {
    this.storeActiveMessages();
    return newestFirst(this.conversations)
      .filter((conversation) => !isEmptyConversation(conversation))
      .map(({ id, title, updatedAt }) => ({ id, title, updatedAt, active: id === this.activeConversationId }));
  }

  /** Makes a new empty conversation active; an empty active one is kept instead. */
  startNewConversation(): void {
    this.storeActiveMessages();
    if (isEmptyConversation(this.activeConversation)) return;
    const conversation = newConversation();
    this.conversations.push(conversation);
    this.activate(conversation);
  }

  /** Makes conversation `id` active. */
  openConversation(id: string): void {
    const next = this.conversations.find((conversation) => conversation.id === id);
    if (!next || next.id === this.activeConversationId) return;
    this.storeActiveMessages();
    this.activate(next);
  }

  /** Renames conversation `id`; an empty name goes back to the automatic title. */
  renameConversation(id: string, title: string): void {
    const conversation = this.conversations.find((item) => item.id === id);
    if (!conversation) return;
    const name = title.replace(/\s+/g, " ").trim();
    conversation.customTitle = name !== "";
    conversation.title = name || conversationTitle(conversation.chatHistory);
    void this.saveChatHistory();
  }

  /** Deletes conversation `id`; deleting the active one opens the most recent other, or a new one. */
  deleteConversation(id: string): void {
    const deleted = this.conversations.find((conversation) => conversation.id === id);
    if (!deleted) return;
    this.conversations = this.conversations.filter((conversation) => conversation !== deleted);
    if (deleted.id !== this.activeConversationId) {
      void this.saveChatHistory();
      return;
    }
    const next = newestFirst(this.conversations)[0] ?? newConversation();
    if (!this.conversations.includes(next)) this.conversations.push(next);
    this.activate(next);
  }

  /** Called when a turn starts or the conversation is cleared: order and title. */
  touchConversation(): void {
    const conversation = this.activeConversation;
    conversation.updatedAt = Date.now();
    if (!conversation.customTitle) conversation.title = conversationTitle(conversation.chatHistory);
  }

  /** Switches the agent to `next`; an empty conversation left behind is dropped. */
  private activate(next: ConversationRecord): void {
    // None when the active conversation was just deleted.
    const previous = this.conversations.find((conversation) => conversation.id === this.activeConversationId);
    this.agent.abort();
    this.activeConversationId = next.id;
    // A new history array: OpenAI can't chain to the other conversation's responses.
    this.agent.importMessages(next.agentMessages);
    if (previous && previous !== next && isEmptyConversation(previous)) {
      this.conversations = this.conversations.filter((conversation) => conversation !== previous);
    }
    void this.saveChatHistory();
  }

  /** Copies the agent's history into the active conversation's record. */
  private storeActiveMessages(): void {
    if (this.agent) this.activeConversation.agentMessages = this.agent.exportMessages();
  }

  // ─── Chat history persistence ─────────────────────────────────────────

  /**
   * Saves the chats. One write at a time: a save asked for while one is
   * being written waits for it, and all such calls share that one next
   * write, which takes the state when it starts.
   */
  saveChatHistory(): Promise<void> {
    if (!this.chatHistoryLoaded) return Promise.resolve();
    if (!this.chatStateWrite) return this.startChatStateWrite();
    this.nextChatStateWrite ??= this.chatStateWrite.then(() => {
      this.nextChatStateWrite = null;
      return this.startChatStateWrite();
    });
    return this.nextChatStateWrite;
  }

  private startChatStateWrite(): Promise<void> {
    const write: Promise<void> = this.writeChatState().finally(() => {
      if (this.chatStateWrite === write) this.chatStateWrite = null;
    });
    this.chatStateWrite = write;
    return write;
  }

  /** Writes the current state; it is taken before the first await. Never throws. */
  private async writeChatState(): Promise<void> {
    try {
      this.storeActiveMessages();
      const state: ChatState = {
        version: CHAT_STATE_VERSION,
        activeConversationId: this.activeConversationId,
        // Per conversation: the last 100 UI entries and 80 API messages
        // (complete turns); image data only in the API history.
        conversations: this.conversations
          .filter((conversation) => conversation.id === this.activeConversationId || !isEmptyConversation(conversation))
          .map(savedConversation),
      };
      await this.app.vault.adapter.write(
        this.chatStatePath,
        JSON.stringify(state)
      );
    } catch {
      // Persistence is best-effort
    }
  }

  private async loadChatHistory(): Promise<void> {
    const state = await this.readChatState();
    // Unreadable and not set aside: saving would overwrite it.
    if (state === undefined) return;
    if (state) {
      this.conversations = state.conversations;
      this.activeConversationId = state.activeConversationId;
      this.agent.importMessages(this.activeConversation.agentMessages);
    }
    this.chatHistoryLoaded = true;
  }

  /**
   * The saved chats in the current format; null when there are none yet
   * (first run, silent) or the file couldn't be read and was renamed to
   * `chat-state.corrupt-<time>.json` (with a notice); undefined when it
   * couldn't be read or renamed.
   */
  private async readChatState(): Promise<ChatState | null | undefined> {
    const { adapter } = this.app.vault;
    const path = this.chatStatePath;
    try {
      const state = migrateChatState(JSON.parse(await adapter.read(path)));
      if (state) {
        for (const conversation of state.conversations) {
          conversation.chatHistory = restoreImages(conversation.chatHistory, conversation.agentMessages);
        }
        return state;
      }
    } catch {
      if (!(await adapter.exists(path).catch(() => true))) return null;
    }
    const name = `chat-state.corrupt-${Date.now()}.json`;
    try {
      await adapter.rename(path, `${this.pluginDataDir}/${name}`);
    } catch {
      new Notice("Saved chats couldn't be read. The file is left as it is, and chats aren't saved until Obsidian restarts.");
      return undefined;
    }
    new Notice(`Saved chats couldn't be read. The file was kept as ${name} in the plugin folder; starting with a new chat.`);
    return null;
  }

  // ─── Settings persistence ────────────────────────────────────────────

  async loadSettings(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...normalizeSettings(await this.loadData()) };

    // Fall back to default model if saved model is empty
    if (!this.settings.model) {
      this.settings.model = DEFAULT_PROVIDER_MODELS[this.settings.provider];
    }

    // Load API key for the current provider from SecretStorage
    this.settings.apiKey = this.loadApiKey(this.settings.provider);
    setDebugLogging(this.settings.debugLog);
  }

  async saveSettings(): Promise<void> {
    // Store API key in SecretStorage keyed by provider
    this.saveApiKey(this.settings.provider, this.settings.apiKey || "");

    // Save all other settings to data.json (syncs), but strip the API key
    const toSave = { ...this.settings, apiKey: "" };
    await this.saveData(toSave);
    setDebugLogging(this.settings.debugLog);

    // Update the chat view header with the new model name and thinking level
    const view = this.getChatView();
    view?.updateModel(this.modelHeaderLabel(), this.settings.provider);
    view?.updateVoiceAvailable();
    view?.updateEnterSends();
  }

  /** Copy `debug.log` to the clipboard (the "Debug log" setting writes it). */
  async copyDebugLog(): Promise<void> {
    const log = await readDebugLog(this.app);
    if (!log) {
      new Notice(this.settings.debugLog ? "The debug log is empty." : "The debug log is empty. Turn on Debug log in settings first.");
      return;
    }
    try {
      await navigator.clipboard.writeText(log);
      new Notice(`Debug log copied (${Math.ceil(log.length / 1024)} KB).`);
    } catch {
      new Notice("Couldn't copy the debug log.");
    }
  }

  /** Model name and thinking level, as shown in the chat view header. */
  modelHeaderLabel(): string {
    const { provider, model, thinkingLevel } = this.settings;
    return getModelHeaderLabel(provider, model, thinkingLevel);
  }

  /** Activate the saved model catalog of the current provider and account (no network). */
  private async activateModelCatalog(): Promise<void> {
    const { provider, modelCatalog } = this.settings;
    const account = this.secretIdentity();
    if (!account) return;
    cachedCatalog(modelCatalog, provider, await catalogIdentity(provider, account));
  }

  /** Load the correct API key when provider changes */
  reloadApiKeyForProvider(): void {
    this.settings.apiKey = this.loadApiKey(this.settings.provider);
  }

  loadApiKey(provider: string): string {
    try {
      return this.app.secretStorage.getSecret(`${PLUGIN_ID}-api-key-${provider}`) || "";
    } catch {
      return "";
    }
  }

  private saveApiKey(provider: string, key: string): void {
    try {
      this.app.secretStorage.setSecret(`${PLUGIN_ID}-api-key-${provider}`, key);
    } catch {
      // SecretStorage not available
    }
  }

  private get pluginDataDir(): string {
    return `${this.app.vault.configDir}/plugins/${PLUGIN_ID}`;
  }

  private get chatStatePath(): string {
    return `${this.pluginDataDir}/chat-state.json`;
  }
}

/**
 * The saved settings, field by field; anything unexpected is dropped. The
 * API key never comes from here (SecretStorage). The iteration limit is
 * kept within the settings field's range, 1 to 100.
 */
function normalizeSettings(value: unknown): Partial<ChatSettings> & Pick<ChatSettings, "modelCatalog"> {
  if (!isRecord(value)) return { modelCatalog: normalizeCatalogState(undefined) };
  const settings: Partial<ChatSettings> & Pick<ChatSettings, "modelCatalog"> = {
    modelCatalog: normalizeCatalogState(value.modelCatalog),
  };
  if (isProvider(value.provider)) settings.provider = value.provider;
  if (typeof value.model === "string") settings.model = value.model;
  if (typeof value.thinkingLevel === "string") settings.thinkingLevel = value.thinkingLevel;
  if (typeof value.maxIterations === "number" && Number.isFinite(value.maxIterations)) {
    settings.maxIterations = Math.min(100, Math.max(1, Math.round(value.maxIterations)));
  }
  if (typeof value.enableWebSearch === "boolean") settings.enableWebSearch = value.enableWebSearch;
  if (typeof value.enterSends === "boolean") settings.enterSends = value.enterSends;
  if (typeof value.chatgptPlanWelcomeShown === "boolean") settings.chatgptPlanWelcomeShown = value.chatgptPlanWelcomeShown;
  if (typeof value.debugLog === "boolean") settings.debugLog = value.debugLog;
  if (value.voiceRoute === "openai" || value.voiceRoute === "codex") settings.voiceRoute = value.voiceRoute;
  if (typeof value.voice === "string" && value.voice) settings.voice = value.voice;
  if (typeof value.codexVoice === "string" && value.codexVoice) settings.codexVoice = value.codexVoice;
  if (value.voiceMicMode === "hands-free" || value.voiceMicMode === "hold") settings.voiceMicMode = value.voiceMicMode;
  return settings;
}

function isProvider(value: unknown): value is ChatSettings["provider"] {
  return value === "anthropic" || value === "openai" || value === "chatgpt-oauth";
}

