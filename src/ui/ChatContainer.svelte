<script lang="ts">
  import type { App } from "obsidian";
  import { Component, MarkdownRenderer, Notice } from "obsidian";
  import type { ToolResult, SelectionScope, ImageAttachment } from "../types";
  import { normalizeMathMarkdown } from "./math-markdown";

  const MAX_IMAGE_COUNT = 4;
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  const MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024;
  const SUPPORTED_IMAGE_TYPES = new Set([
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
  ]);

  interface ChatMessage {
    id: number;
    type: "user" | "assistant" | "tool-call" | "tool-result" | "error" | "thinking";
    text?: string;
    images?: ImageAttachment[];
    toolName?: string;
    toolInput?: Record<string, unknown>;
    toolResult?: ToolResult;
    /** User messages of a turn (not `ask_user` answers): editable. */
    turnId?: string;
    selection?: SelectionScope;
    /** Assistant messages: text still arriving (no actions yet). */
    streaming?: boolean;
  }

  interface Props {
    app: App;
    component: Component;
    provider: string;
    model: string;
    onSend: (text: string, selection: SelectionScope | null, images: ImageAttachment[]) => void;
    onClear: () => void;
    onStop: () => void;
    onEdit: (turnId: string, text: string) => void;
    onRegenerate: () => void;
    onCopy: (text: string) => void;
  }

  let { app, component, provider, model, onSend, onClear, onStop, onEdit, onRegenerate, onCopy }: Props = $props();

  let displayModel = $state("");
  let messages = $state<ChatMessage[]>([]);
  let inputText = $state("");
  let inputEnabled = $state(true);
  let placeholder = $state("Ask anything...");
  let messagesEl: HTMLElement | undefined = $state();
  let textareaEl: HTMLTextAreaElement | undefined = $state();
  let fileInputEl: HTMLInputElement | undefined = $state();
  let attachments = $state<ImageAttachment[]>([]);
  let nextId = 0;
  /** A turn is running (set by the view); regenerate waits for it. */
  let busy = $state(false);

  // Editing a user message in place
  let editingId = $state<number | null>(null);
  let editText = $state("");

  /** The last answer (no user turn after it): the one that can be regenerated. */
  const lastAnswerId = $derived.by(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type === "assistant") return msg.id;
      if (msg.type === "user" && msg.turnId) return -1;
    }
    return -1;
  });

  // Selection scope (shown as a pill above input)
  let selection = $state<SelectionScope | null>(null);

  // ask_user support
  let askUserResolve: ((value: string) => void) | null = $state(null);

  // Sync model prop to local state (also updateable via setModel)
  $effect(() => {
    displayModel = model;
  });

  // ─── Scrolling: the latest question stays at the top ──────────────────
  // When a question is added, it is scrolled to the top of the message
  // area and the answer reads downward from it (like chat apps). Temporary
  // bottom padding (the "tail") makes that position reachable while the
  // content below is still short; it shrinks as the answer grows. Once the
  // user scrolls by hand, the position is left alone until the next question.
  // Adapted from scrollToLastQuestion() in nagisa525/obsidian-chatting-plus (MIT).
  const MESSAGES_PADDING = 12; // matches .chatting-minus-messages padding
  let messageListEl: HTMLElement | undefined = $state();
  let anchoredQuestionId = -1;
  let followQuestion = false;
  let scrollTail = 0;

  // A new question starts a new turn.
  $effect(() => {
    let lastQuestionId = -1;
    for (const msg of messages) if (msg.type === "user") lastQuestionId = msg.id;
    if (lastQuestionId !== anchoredQuestionId) {
      anchoredQuestionId = lastQuestionId;
      followQuestion = true;
    }
    keepQuestionInView();
  });

  // Rendered Markdown, math, images and a resized panel or phone keyboard
  // change heights after the messages do.
  $effect(() => {
    const el = messagesEl;
    if (!el || !messageListEl) return;
    const observer = new ResizeObserver(() => keepQuestionInView());
    observer.observe(el, { box: "border-box" });
    observer.observe(messageListEl);
    const stopFollowing = () => {
      followQuestion = false;
    };
    const stopOnScrollbar = (e: PointerEvent) => {
      if (e.target === el) stopFollowing();
    };
    const stopOnScrollKey = (e: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(e.key)) stopFollowing();
    };
    el.addEventListener("wheel", stopFollowing, { passive: true });
    el.addEventListener("touchmove", stopFollowing, { passive: true });
    el.addEventListener("pointerdown", stopOnScrollbar);
    el.addEventListener("keydown", stopOnScrollKey);
    return () => {
      observer.disconnect();
      el.removeEventListener("wheel", stopFollowing);
      el.removeEventListener("touchmove", stopFollowing);
      el.removeEventListener("pointerdown", stopOnScrollbar);
      el.removeEventListener("keydown", stopOnScrollKey);
    };
  });

  function keepQuestionInView(): void {
    const el = messagesEl;
    if (!el || !messageListEl) return;
    const questions = el.querySelectorAll<HTMLElement>(".chatting-minus-user-msg");
    const question = questions.item(questions.length - 1);
    let tail = 0;
    let target = 0;
    if (question) {
      // Positions in scroll coordinates; scrollHeight can't be used because
      // it never drops below the visible height.
      const top = el.getBoundingClientRect().top - el.scrollTop;
      target = Math.max(0, Math.round(question.getBoundingClientRect().top - top - MESSAGES_PADDING));
      const contentHeight = messageListEl.getBoundingClientRect().bottom - top + MESSAGES_PADDING;
      if (target > 0) tail = Math.max(0, Math.ceil(target - (contentHeight - el.clientHeight)));
    }
    if (tail !== scrollTail) {
      scrollTail = tail;
      el.style.setProperty("--chatting-minus-scroll-tail", `${tail}px`);
    }
    if (question && followQuestion) el.scrollTop = target;
  }

  // ─── Public API (called from chat-view.ts / chat-modal.ts) ────────────

  export function addUserMessage(
    text: string,
    images: ImageAttachment[] = [],
    turnId?: string,
    selection?: SelectionScope,
  ): void {
    messages.push({ id: nextId++, type: "user", text, images: images.slice(), turnId, selection });
  }

  export function addAssistantMessage(text: string, streaming = false): number {
    const id = nextId++;
    messages.push({ id, type: "assistant", text, streaming });
    return id;
  }

  // ─── Streamed answers: Markdown is re-rendered at most every 100 ms ────
  const STREAM_RENDER_MS = 100;
  const pendingText = new Map<number, string>();
  let renderTimer: number | null = null;

  /** Replace an assistant message's text; `final` renders it at once. */
  export function updateAssistantMessage(id: number, text: string, final = false): void {
    pendingText.set(id, text);
    if (final) {
      flushPendingText();
      const msg = messages.find((m) => m.id === id);
      if (msg) msg.streaming = false;
    } else {
      renderTimer ??= window.setTimeout(flushPendingText, STREAM_RENDER_MS);
    }
  }

  function flushPendingText(): void {
    if (renderTimer !== null) window.clearTimeout(renderTimer);
    renderTimer = null;
    for (const [id, text] of pendingText) {
      const msg = messages.find((m) => m.id === id);
      if (msg) msg.text = text;
    }
    pendingText.clear();
  }

  export function removeMessage(id: number): void {
    pendingText.delete(id);
    const idx = messages.findIndex((m) => m.id === id);
    if (idx !== -1) messages.splice(idx, 1);
  }

  /** Remove the turn `turnId` and everything after it (edit, regenerate). */
  export function cutMessages(turnId: string): void {
    const idx = messages.findIndex((m) => m.type === "user" && m.turnId === turnId);
    if (idx === -1) return;
    for (const msg of messages.slice(idx)) pendingText.delete(msg.id);
    messages.splice(idx);
    editingId = null;
  }

  export function addToolCall(name: string, input: Record<string, unknown>): number {
    const id = nextId++;
    messages.push({ id, type: "tool-call", toolName: name, toolInput: input });
    return id;
  }

  export function updateToolResult(msgId: number, name: string, result: ToolResult): void {
    const msg = messages.find((m) => m.id === msgId);
    if (msg) {
      msg.type = "tool-result";
      msg.toolName = name;
      msg.toolResult = result;
    }
  }

  export function showThinking(): void {
    // Only add if not already showing
    if (!messages.some((m) => m.type === "thinking")) {
      messages.push({ id: nextId++, type: "thinking" });
    }
  }

  export function hideThinking(): void {
    const idx = messages.findIndex((m) => m.type === "thinking");
    if (idx !== -1) messages.splice(idx, 1);
  }

  export function addError(text: string): void {
    messages.push({ id: nextId++, type: "error", text });
  }

  export function showAskUser(question: string): Promise<string> {
    addAssistantMessage(question);
    placeholder = "Type your answer...";
    inputEnabled = true;
    textareaEl?.focus();

    return new Promise<string>((resolve) => {
      askUserResolve = resolve;
    });
  }

  export function setInputEnabled(enabled: boolean): void {
    inputEnabled = enabled;
    placeholder = enabled ? "Ask anything..." : "Waiting for response...";
  }

  export function setBusy(value: boolean): void {
    busy = value;
  }

  /** Drop a pending `ask_user` question (its turn was stopped). */
  export function cancelAskUser(): void {
    const resolve = askUserResolve;
    askUserResolve = null;
    resolve?.("");
  }

  export function clearMessages(): void {
    pendingText.clear();
    messages = [];
    editingId = null;
    attachments = [];
    if (fileInputEl) fileInputEl.value = "";
    selection = null;
    hideThinking();
  }

  export function focus(): void {
    textareaEl?.focus();
  }

  /** Update the model display name in the header */
  export function setModel(name: string): void {
    displayModel = name;
  }

  /** Set the selection scope (shows pill in UI) */
  export function setSelection(sel: SelectionScope): void {
    selection = sel;
  }

  /** Get the current selection scope */
  export function getSelection(): SelectionScope | null {
    return selection;
  }

  /** Clear the selection scope */
  export function clearSelection(): void {
    selection = null;
  }

  // ─── Internal handlers ────────────────────────────────────────────────

  function handleSend(): void {
    const text = inputText.trim();
    if (!text && attachments.length === 0) return;

    if (askUserResolve && attachments.length > 0) {
      new Notice("Image attachments are not supported when answering a tool question.");
      return;
    }

    inputText = "";
    resetHeight();
    const sentImages = attachments.slice();
    attachments = [];

    if (askUserResolve) {
      addUserMessage(text);
      const resolve = askUserResolve;
      askUserResolve = null;
      resolve(text);
      return;
    }

    // Pass current selection and consume it (one-shot per send)
    const currentSelection = selection;
    selection = null;
    onSend(text, currentSelection, sentImages);
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function startEdit(msg: ChatMessage): void {
    editingId = msg.id;
    editText = msg.text ?? "";
  }

  function saveEdit(msg: ChatMessage): void {
    const text = editText.trim();
    if (!msg.turnId || (!text && !msg.images?.length)) return;
    editingId = null;
    onEdit(msg.turnId, text);
  }

  function handleEditKeydown(e: KeyboardEvent, msg: ChatMessage): void {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      saveEdit(msg);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      editingId = null;
    }
  }

  /** The edit box: focused with the cursor at the end, grows with its text. */
  function editBox(node: HTMLTextAreaElement) {
    const grow = () => {
      node.style.height = "auto";
      node.style.height = Math.min(node.scrollHeight, 300) + "px";
    };
    node.addEventListener("input", grow);
    grow();
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
    return {
      destroy() {
        node.removeEventListener("input", grow);
      },
    };
  }

  function autoGrow(): void {
    if (!textareaEl) return;
    textareaEl.style.height = "auto";
    textareaEl.style.height = Math.min(textareaEl.scrollHeight, 300) + "px";
  }

  function resetHeight(): void {
    if (!textareaEl) return;
    textareaEl.style.height = "auto";
  }

  function imageDataUrl(image: ImageAttachment): string {
    return `data:${image.mediaType};base64,${image.data}`;
  }

  function openImagePicker(): void {
    if (inputEnabled) fileInputEl?.click();
  }

  async function handleImageSelection(event: Event): Promise<void> {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) return;
    const files = Array.from(input.files ?? []);
    input.value = "";
    await addImageFiles(files);
  }

  function handlePaste(event: ClipboardEvent): void {
    const files = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) return;
    event.preventDefault();
    void addImageFiles(files);
  }

  async function addImageFiles(files: File[]): Promise<void> {
    for (const file of files) {
      if (attachments.length >= MAX_IMAGE_COUNT) {
        new Notice(`Attach up to ${MAX_IMAGE_COUNT} images per message.`);
        return;
      }

      try {
        const image = await readImageAttachment(file);
        const currentBytes = attachments.reduce((total, item) => total + item.sizeBytes, 0);
        if (currentBytes + image.sizeBytes > MAX_TOTAL_IMAGE_BYTES) {
          new Notice("The combined image size must be 12 MB or less per message.");
          return;
        }
        attachments = [...attachments, image];
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        new Notice(`Could not attach ${file.name || "image"}: ${message}`);
      }
    }
  }

  async function readImageAttachment(file: File): Promise<ImageAttachment> {
    let mediaType = file.type.toLowerCase() || inferImageMimeType(file.name);
    const isHeic = mediaType === "image/heic" || mediaType === "image/heif" ||
      /\.(heic|heif)$/i.test(file.name);
    let source: Blob = file;

    if (mediaType === "image/svg+xml") {
      throw new Error("SVG images are not supported. Choose a raster image instead.");
    }
    if (!mediaType.startsWith("image/")) {
      throw new Error("Choose an image file.");
    }

    if (isHeic || !SUPPORTED_IMAGE_TYPES.has(mediaType) || file.size > MAX_IMAGE_BYTES) {
      if (mediaType === "image/gif") {
        throw new Error("GIF files must be 5 MB or smaller.");
      }
      try {
        const bitmap = await createImageBitmap(file);
        const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Image conversion is unavailable.");
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
        mediaType = mediaType === "image/png" ? "image/png" : "image/jpeg";
        source = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob(
            (blob) => blob ? resolve(blob) : reject(new Error("Image conversion failed.")),
            mediaType,
            0.85,
          );
        });
      } catch {
        throw new Error("This image could not be converted. Try JPEG or PNG instead.");
      }
    }

    if (!SUPPORTED_IMAGE_TYPES.has(mediaType)) {
      throw new Error("Use a JPEG, PNG, GIF, or WebP image.");
    }
    if (source.size > MAX_IMAGE_BYTES) {
      throw new Error("Images must be 5 MB or smaller after conversion.");
    }

    const dataUrl = await readAsDataUrl(source);
    const comma = dataUrl.indexOf(",");
    if (comma < 0) throw new Error("Image could not be read.");
    return {
      id: `image-${Date.now()}-${nextId++}`,
      fileName: file.name || `image.${mediaType.split("/")[1]}`,
      mediaType,
      data: dataUrl.slice(comma + 1),
      sizeBytes: source.size,
    };
  }

  function inferImageMimeType(fileName: string): string {
    const extension = fileName.split(".").pop()?.toLowerCase();
    const types: Record<string, string> = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      webp: "image/webp",
      heic: "image/heic",
      heif: "image/heif",
    };
    return extension ? types[extension] ?? "" : "";
  }

  function readAsDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("Image could not be read."));
      reader.onerror = () => reject(new Error("Image could not be read."));
      reader.readAsDataURL(blob);
    });
  }

  function removeAttachment(id: string): void {
    attachments = attachments.filter((image) => image.id !== id);
  }

  // Render markdown into a DOM node using Obsidian's renderer. Math
  // delimiters are normalized for display only; the message stays unchanged.
  // Each render gets its own child component, unloaded when the text changes
  // (streamed answers render many times) or the message goes away.
  function markdown(node: HTMLElement, text: string) {
    let child: Component | null = null;
    const render = (value: string) => {
      if (child) component.removeChild(child);
      child = component.addChild(new Component());
      node.empty();
      void MarkdownRenderer.render(app, normalizeMathMarkdown(value), node, "", child);
    };
    render(text);
    return {
      update: render,
      destroy() {
        if (child) component.removeChild(child);
      },
    };
  }

  function formatToolName(name: string): string {
    return name.replace(/_/g, " ");
  }

  function truncate(str: string, max: number): string {
    if (str.length <= max) return str;
    return str.substring(0, max) + "\n... (truncated)";
  }
</script>

<!-- A user message's images; one no longer saved shows as a chip with its name. -->
{#snippet userImages(images: ImageAttachment[])}
  <div class="chatting-minus-user-images">
    {#each images as image (image.id)}
      {#if image.data}
        <img src={imageDataUrl(image)} alt={image.fileName} />
      {:else}
        <span class="chatting-minus-image-chip" title="Image no longer saved">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
          <span>{image.fileName}</span>
        </span>
      {/if}
    {/each}
  </div>
{/snippet}

<div class="chatting-minus-container">
  <!-- Header -->
  <div class="chatting-minus-header">
    <div class="chatting-minus-header-left">
      <span class="chatting-minus-header-title">Chat</span>
      <span class="chatting-minus-header-model">{displayModel || "No model"}</span>
    </div>
    <button class="chatting-minus-clear-btn" onclick={onClear}>Clear</button>
  </div>

  <!-- Messages -->
  <div class="chatting-minus-messages" bind:this={messagesEl}>
    <div class="chatting-minus-message-list" bind:this={messageListEl}>
    {#each messages as msg (msg.id)}
      {#if msg.type === "user"}
        <div class="chatting-minus-user-turn" class:chatting-minus-editing={editingId === msg.id}>
          {#if editingId === msg.id}
            <div class="chatting-minus-msg chatting-minus-user-msg chatting-minus-user-edit">
              {#if msg.images?.length}
                {@render userImages(msg.images)}
              {/if}
              {#if msg.images?.some((image) => !image.data)}
                <div class="chatting-minus-edit-note">Images no longer saved are left out.</div>
              {/if}
              {#if msg.selection}
                <div class="chatting-minus-edit-note">Selection from {msg.selection.filePath.split("/").pop()}</div>
              {/if}
              <textarea
                class="chatting-minus-edit-input"
                bind:value={editText}
                use:editBox
                rows="1"
                aria-label="Edit message"
                onkeydown={(e) => handleEditKeydown(e, msg)}
              ></textarea>
              <div class="chatting-minus-edit-note">Changes the AI already made to notes stay.</div>
              <div class="chatting-minus-edit-buttons">
                <button type="button" onclick={() => editingId = null}>Cancel</button>
                <button type="button" class="mod-cta" onclick={() => saveEdit(msg)}>Save</button>
              </div>
            </div>
          {:else}
            <div class="chatting-minus-msg chatting-minus-user-msg">
              {#if msg.images?.length}
                {@render userImages(msg.images)}
              {/if}
              {#if msg.text}
                <div class="chatting-minus-msg-content">{msg.text}</div>
              {/if}
            </div>
            {#if msg.turnId}
              <div class="chatting-minus-msg-actions chatting-minus-hover-actions">
                <button
                  class="chatting-minus-action-btn"
                  type="button"
                  onclick={() => startEdit(msg)}
                  aria-label="Edit message"
                  title="Edit"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>
                </button>
              </div>
            {/if}
          {/if}
        </div>

      {:else if msg.type === "assistant"}
        <div class="chatting-minus-answer">
          <div class="chatting-minus-msg chatting-minus-assistant-msg">
            <div class="chatting-minus-msg-content" use:markdown={msg.text ?? ""}></div>
          </div>
          {#if !msg.streaming}
            <div class="chatting-minus-msg-actions" class:chatting-minus-hover-actions={msg.id !== lastAnswerId}>
              <button
                class="chatting-minus-action-btn"
                type="button"
                onclick={() => onCopy(msg.text ?? "")}
                aria-label="Copy answer"
                title="Copy"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
              </button>
              {#if msg.id === lastAnswerId && !busy}
                <button
                  class="chatting-minus-action-btn"
                  type="button"
                  onclick={onRegenerate}
                  aria-label="Regenerate answer"
                  title="Regenerate"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"></path><polyline points="21 3 21 8 16 8"></polyline></svg>
                </button>
              {/if}
            </div>
          {/if}
        </div>

      {:else if msg.type === "tool-call"}
        <div class="chatting-minus-tool-call">
          <div class="chatting-minus-tool-status">
            <span class="chatting-minus-spinner"></span>
            <span class="chatting-minus-tool-name">{formatToolName(msg.toolName ?? "")}</span>
          </div>
          <details class="chatting-minus-tool-details">
            <summary>Parameters</summary>
            <pre class="chatting-minus-tool-json">{JSON.stringify(msg.toolInput, null, 2)}</pre>
          </details>
        </div>

      {:else if msg.type === "tool-result"}
        <div class="chatting-minus-tool-call">
          <div class="chatting-minus-tool-status">
            <span class={msg.toolResult?.isError ? "chatting-minus-tool-error" : "chatting-minus-tool-success"}>
              {msg.toolResult?.isError ? "\u2718" : "\u2714"}
            </span>
            <span class="chatting-minus-tool-name">{formatToolName(msg.toolName ?? "")}</span>
          </div>
          <details class="chatting-minus-tool-details">
            <summary>{msg.toolResult?.isError ? "Error" : "Result"}</summary>
            <pre class="chatting-minus-tool-json">{truncate(msg.toolResult?.result ?? "", 2000)}</pre>
          </details>
        </div>

      {:else if msg.type === "error"}
        <div class="chatting-minus-msg chatting-minus-error-msg">
          <div class="chatting-minus-msg-content">{msg.text}</div>
        </div>

      {:else if msg.type === "thinking"}
        <div class="chatting-minus-thinking">
          <span class="chatting-minus-dot"></span>
          <span class="chatting-minus-dot"></span>
          <span class="chatting-minus-dot"></span>
        </div>
      {/if}
    {/each}
    </div>
  </div>

  <!-- Selection pill -->
  {#if selection}
    <div class="chatting-minus-selection-pill">
      <div class="chatting-minus-selection-content">
        <span class="chatting-minus-selection-label">Selection from {selection.filePath.split("/").pop()}</span>
        <span class="chatting-minus-selection-preview">{selection.text.substring(0, 80)}{selection.text.length > 80 ? "..." : ""}</span>
      </div>
      <button
        class="chatting-minus-selection-dismiss"
        onclick={() => selection = null}
        aria-label="Remove selection"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>
    </div>
  {/if}

  {#if attachments.length > 0}
    <div class="chatting-minus-attachment-tray" aria-label="Image attachments">
      {#each attachments as image (image.id)}
        <div class="chatting-minus-attachment-preview">
          <img src={imageDataUrl(image)} alt={image.fileName} />
          <span title={image.fileName}>{image.fileName}</span>
          <button
            class="chatting-minus-attachment-remove"
            type="button"
            onclick={() => removeAttachment(image.id)}
            disabled={!inputEnabled}
            aria-label={`Remove ${image.fileName}`}
          >×</button>
        </div>
      {/each}
    </div>
  {/if}

  <!-- Input bar -->
  <div class="chatting-minus-input-bar">
    <input
      bind:this={fileInputEl}
      class="chatting-minus-file-input"
      type="file"
      accept="image/jpeg,image/png,image/gif,image/webp,image/heic,image/heif"
      multiple
      onchange={handleImageSelection}
      aria-label="Choose images"
    />
    <button
      class="chatting-minus-attach-btn"
      type="button"
      onclick={openImagePicker}
      disabled={!inputEnabled || attachments.length >= MAX_IMAGE_COUNT}
      aria-label="Attach images"
      title="Attach images"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
    </button>
    <textarea
      class="chatting-minus-input"
      bind:this={textareaEl}
      bind:value={inputText}
      {placeholder}
      disabled={!inputEnabled}
      rows="1"
      onkeydown={handleKeydown}
      onpaste={handlePaste}
      oninput={autoGrow}
    ></textarea>
    {#if inputEnabled}
      <button
        class="chatting-minus-send-btn"
        onclick={handleSend}
        aria-label="Send message"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>
      </button>
    {:else}
      <button
        class="chatting-minus-send-btn chatting-minus-stop-btn"
        onclick={onStop}
        aria-label="Stop generation"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="4" y="4" width="16" height="16" rx="2"></rect></svg>
      </button>
    {/if}
  </div>
</div>

<style>
  /* ─── Container ─────────────────────────────────────────────────────── */
  .chatting-minus-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  /* ─── Header ────────────────────────────────────────────────────────── */
  .chatting-minus-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--background-modifier-border);
    flex-shrink: 0;
  }

  .chatting-minus-header-left {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }

  .chatting-minus-header-title {
    font-weight: var(--font-weight-bold, 600);
    font-size: var(--font-ui-medium);
    color: var(--text-normal);
  }

  .chatting-minus-header-model {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    /* Model name + thinking level can outgrow a phone-width panel */
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chatting-minus-clear-btn {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    background: none;
    border: none;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: var(--radius-s);
  }

  .chatting-minus-clear-btn:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }

  /* ─── Messages ──────────────────────────────────────────────────────── */
  .chatting-minus-messages {
    flex: 1 1 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    /* The tail lets the latest question scroll to the top (see keepQuestionInView). */
    padding: 12px 12px calc(12px + var(--chatting-minus-scroll-tail, 0px));
    -webkit-user-select: text;
    user-select: text;
  }

  .chatting-minus-message-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .chatting-minus-msg {
    max-width: 90%;
    padding: 8px 12px;
    border-radius: var(--radius-m);
    line-height: 1.5;
    word-wrap: break-word;
    -webkit-user-select: text;
    user-select: text;
  }

  .chatting-minus-user-msg {
    align-self: flex-end;
    background: var(--interactive-accent);
    color: var(--text-on-accent);
    border-bottom-right-radius: var(--radius-s);
  }

  /* A user message with its edit action, or its edit box */
  .chatting-minus-user-turn {
    align-self: flex-end;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    max-width: 90%;
  }

  .chatting-minus-user-turn.chatting-minus-editing {
    width: 90%;
  }

  .chatting-minus-user-turn > .chatting-minus-msg,
  .chatting-minus-answer > .chatting-minus-msg {
    max-width: 100%;
  }

  .chatting-minus-user-edit {
    width: 100%;
    background: var(--background-secondary);
    color: var(--text-normal);
    border: 1px solid var(--interactive-accent);
    border-bottom-right-radius: var(--radius-m);
  }

  .chatting-minus-edit-input {
    width: 100%;
    resize: none;
    max-height: 300px;
    padding: 6px 8px;
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-s);
    background: var(--background-primary);
    color: var(--text-normal);
    font-family: var(--font-interface);
    font-size: var(--font-ui-medium);
    line-height: 1.4;
  }

  .chatting-minus-edit-note {
    margin: 4px 0;
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
  }

  .chatting-minus-edit-buttons {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }

  /* An answer with its action row */
  .chatting-minus-answer {
    align-self: flex-start;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    max-width: 90%;
  }

  /* ─── Message actions (edit, copy, regenerate) ──────────────────────── */
  .chatting-minus-msg-actions {
    display: flex;
    gap: 2px;
    margin-top: 2px;
  }

  .chatting-minus-action-btn {
    width: 26px;
    height: 26px;
    padding: 0;
    border: none;
    border-radius: var(--radius-s);
    background: transparent;
    box-shadow: none;
    color: var(--text-faint);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .chatting-minus-action-btn:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }

  /* With a mouse, these appear on hover; on touch screens they stay visible. */
  @media (hover: hover) and (pointer: fine) {
    .chatting-minus-hover-actions {
      opacity: 0;
      transition: opacity 0.15s;
    }

    .chatting-minus-user-turn:hover .chatting-minus-hover-actions,
    .chatting-minus-answer:hover .chatting-minus-hover-actions,
    .chatting-minus-hover-actions:focus-within {
      opacity: 1;
    }
  }

  @media (hover: none) {
    .chatting-minus-action-btn {
      width: 32px;
      height: 32px;
    }
  }

  .chatting-minus-user-images {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 6px;
  }

  .chatting-minus-user-images img {
    max-width: min(100%, 280px);
    max-height: 220px;
    border-radius: var(--radius-s);
    object-fit: contain;
  }

  .chatting-minus-image-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    max-width: 100%;
    padding: 2px 8px;
    border-radius: var(--radius-s);
    background: rgba(0, 0, 0, 0.15);
    font-size: var(--font-ui-smaller);
  }

  .chatting-minus-image-chip span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chatting-minus-assistant-msg {
    align-self: flex-start;
    background: var(--background-secondary);
    color: var(--text-normal);
    border-bottom-left-radius: var(--radius-s);
  }

  .chatting-minus-assistant-msg :global(p:first-child) {
    margin-top: 0;
  }

  .chatting-minus-assistant-msg :global(p:last-child) {
    margin-bottom: 0;
  }

  .chatting-minus-error-msg {
    align-self: flex-start;
    background: var(--background-secondary);
    color: var(--text-error);
    border-left: 3px solid var(--text-error);
    font-size: var(--font-ui-smaller);
    max-width: 90%;
  }

  /* ─── Tool Calls ────────────────────────────────────────────────────── */
  .chatting-minus-tool-call {
    align-self: flex-start;
    padding: 6px 10px;
    background: var(--background-secondary-alt);
    border-radius: var(--radius-s);
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    max-width: 90%;
  }

  .chatting-minus-tool-status {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .chatting-minus-tool-name {
    font-weight: 500;
  }

  .chatting-minus-tool-success {
    color: var(--text-success);
  }

  .chatting-minus-tool-error {
    color: var(--text-error);
  }

  .chatting-minus-tool-details {
    margin-top: 4px;
  }

  .chatting-minus-tool-details summary {
    cursor: pointer;
    color: var(--text-faint);
    font-size: var(--font-ui-smaller);
  }

  .chatting-minus-tool-json {
    margin: 4px 0 0;
    padding: 6px 8px;
    background: var(--background-primary);
    border-radius: var(--radius-s);
    font-size: 11px;
    max-height: 150px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }

  /* ─── Spinner ───────────────────────────────────────────────────────── */
  .chatting-minus-spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid var(--text-faint);
    border-top-color: var(--interactive-accent);
    border-radius: 50%;
    animation: chatting-minus-spin 0.6s linear infinite;
  }

  @keyframes chatting-minus-spin {
    to { transform: rotate(360deg); }
  }

  /* ─── Thinking Dots ─────────────────────────────────────────────────── */
  .chatting-minus-thinking {
    align-self: flex-start;
    display: flex;
    gap: 4px;
    padding: 8px 12px;
  }

  .chatting-minus-dot {
    width: 8px;
    height: 8px;
    background: var(--text-faint);
    border-radius: 50%;
    animation: chatting-minus-pulse 1.4s ease-in-out infinite;
  }

  .chatting-minus-dot:nth-child(2) {
    animation-delay: 0.2s;
  }

  .chatting-minus-dot:nth-child(3) {
    animation-delay: 0.4s;
  }

  @keyframes chatting-minus-pulse {
    0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
    40% { opacity: 1; transform: scale(1); }
  }

  /* ─── Input Bar ─────────────────────────────────────────────────────── */
  .chatting-minus-file-input {
    display: none;
  }

  .chatting-minus-attachment-tray {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding: 8px 12px 0;
    flex-shrink: 0;
  }

  .chatting-minus-attachment-preview {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    width: 190px;
    min-width: 190px;
    padding: 5px 28px 5px 5px;
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-s);
    background: var(--background-secondary);
  }

  .chatting-minus-attachment-preview img {
    width: 38px;
    height: 38px;
    flex-shrink: 0;
    border-radius: 4px;
    object-fit: cover;
  }

  .chatting-minus-attachment-preview span {
    min-width: 0;
    overflow: hidden;
    color: var(--text-muted);
    font-size: var(--font-ui-smaller);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chatting-minus-attachment-remove {
    position: absolute;
    top: 3px;
    right: 3px;
    width: 20px;
    height: 20px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: var(--background-modifier-hover);
    color: var(--text-muted);
    cursor: pointer;
  }

  .chatting-minus-attachment-remove:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .chatting-minus-input-bar {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    padding: 8px 12px;
    padding-bottom: calc(8px + env(safe-area-inset-bottom, 0px));
    border-top: 1px solid var(--background-modifier-border);
    background: transparent;
    flex-shrink: 0;
  }

  .chatting-minus-attach-btn {
    width: 34px;
    height: 34px;
    min-width: 34px;
    min-height: 34px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .chatting-minus-attach-btn:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }

  .chatting-minus-attach-btn:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }

  .chatting-minus-input {
    flex: 1;
    resize: none;
    border: 1.5px solid var(--background-modifier-border-hover, var(--background-modifier-border));
    border-radius: 20px;
    padding: 8px 16px;
    font-size: var(--font-ui-medium);
    font-family: var(--font-interface);
    background-color: var(--background-secondary);
    color: var(--text-normal);
    line-height: 1.4;
    max-height: 300px;
    overflow-y: auto;
    box-shadow: none;
  }

  .chatting-minus-input:focus {
    outline: none;
    border-color: var(--interactive-accent);
    box-shadow: none;
  }

  .chatting-minus-input:disabled {
    opacity: 0.5;
  }

  .chatting-minus-send-btn {
    width: 34px;
    height: 34px;
    min-width: 34px;
    min-height: 34px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background-color: var(--interactive-accent);
    color: var(--text-on-accent);
    cursor: pointer;
    flex-shrink: 0;
    box-shadow: none;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 1px;
  }

  .chatting-minus-send-btn:hover {
    background-color: var(--interactive-accent-hover);
  }

  .chatting-minus-send-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .chatting-minus-stop-btn {
    background-color: var(--text-error);
  }

  .chatting-minus-stop-btn:hover {
    background-color: var(--text-error);
    opacity: 0.85;
  }

  /* ─── Selection Pill ─────────────────────────────────────────────────── */
  .chatting-minus-selection-pill {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 8px 8px 0;
    padding: 6px 10px;
    background: var(--background-secondary);
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-m);
    flex-shrink: 0;
  }

  .chatting-minus-selection-content {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .chatting-minus-selection-label {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    font-weight: 500;
  }

  .chatting-minus-selection-preview {
    font-size: var(--font-ui-smaller);
    color: var(--text-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .chatting-minus-selection-dismiss {
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: var(--background-modifier-hover);
    color: var(--text-muted);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .chatting-minus-selection-dismiss:hover {
    background: var(--background-modifier-border);
    color: var(--text-normal);
  }

  /* ─── Responsive ────────────────────────────────────────────────────── */
  @media (max-width: 768px) {
    .chatting-minus-msg,
    .chatting-minus-user-turn,
    .chatting-minus-answer {
      max-width: 95%;
    }

    .chatting-minus-user-turn.chatting-minus-editing {
      width: 95%;
    }

    .chatting-minus-edit-input {
      font-size: 16px; /* Prevents iOS zoom on focus */
    }

    .chatting-minus-input-bar {
      gap: 10px;
      padding: 10px 12px;
      padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px));
    }

    .chatting-minus-input {
      font-size: 16px; /* Prevents iOS zoom on focus */
      padding: 10px 16px;
      border-radius: 22px;
    }

    .chatting-minus-send-btn {
      width: 36px;
      height: 36px;
      min-width: 36px;
      min-height: 36px;
    }
  }
</style>
