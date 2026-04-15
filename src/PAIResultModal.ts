import { App, MarkdownRenderer, Modal, Notice, TFile } from "obsidian";
import { PAIClient } from "./PAIClient";
import { PAIResultWriter } from "./PAIResultWriter";
import { ConversationTurn, InvokeRequest, SSEDoneEvent } from "./types";
import { t } from "./i18n";

export class PAIResultModal extends Modal {
  private outputEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private createNoteBtn!: HTMLButtonElement;
  private appendBtn!: HTMLButtonElement;
  private history: ConversationTurn[] = [];
  private lastDoneEvent: SSEDoneEvent | null = null;
  private isStreaming = false;
  private abortController: AbortController | null = null;
  private fullDialogText = "";
  private scrollPending = false;

  constructor(
    app: App,
    private client: PAIClient,
    private writer: PAIResultWriter,
    private req: InvokeRequest,
    private sourceFile: TFile,
    private label: string,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.modalEl.addClass("memex-pai-modal-container");
    contentEl.addClass("memex-pai-modal");

    contentEl.createEl("h2", {
      text: t("modalTitle", { label: this.label }),
      cls: "memex-pai-modal-title",
    });

    this.outputEl = contentEl.createEl("div", { cls: "memex-pai-modal-output" });

    // Input row
    const inputRow = contentEl.createEl("div", { cls: "memex-pai-modal-input-row" });
    this.inputEl = inputRow.createEl("textarea", {
      cls: "memex-pai-modal-textarea",
      attr: { placeholder: t("modalPlaceholder"), rows: "3" },
    }) as HTMLTextAreaElement;
    this.sendBtn = inputRow.createEl("button", {
      text: t("modalSend"),
      cls: "memex-pai-modal-send",
    }) as HTMLButtonElement;
    this.sendBtn.addEventListener("click", () => this.sendFollowUp());
    this.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.sendFollowUp();
      }
    });

    // Action buttons
    const actionRow = contentEl.createEl("div", { cls: "memex-pai-modal-actions" });
    const copyBtn = actionRow.createEl("button", {
      text: t("modalCopy"),
    }) as HTMLButtonElement;
    this.createNoteBtn = actionRow.createEl("button", {
      text: t("modalCreateNote"),
      cls: "mod-cta",
    }) as HTMLButtonElement;
    this.appendBtn = actionRow.createEl("button", {
      text: t("modalAppend"),
    }) as HTMLButtonElement;
    const cancelBtn = actionRow.createEl("button", {
      text: t("modalCancel"),
    }) as HTMLButtonElement;

    copyBtn.addEventListener("click", () => this.copyDialog());
    this.createNoteBtn.addEventListener("click", () => this.writeResult("new-note"));
    this.appendBtn.addEventListener("click", () => this.writeResult("append"));
    cancelBtn.addEventListener("click", () => this.close());

    this.setStreaming(true);
    // Seed history with a synthetic user turn so follow-up history is properly paired
    this.history.push({ role: "user", content: `[Analyzing note: ${this.sourceFile.basename}]` });
    this.streamTurn(this.req);
  }

  onClose(): void {
    this.abortController?.abort();
    this.contentEl.empty();
  }

  private scrollToBottom(): void {
    if (this.scrollPending) return;
    this.scrollPending = true;
    requestAnimationFrame(() => {
      this.outputEl.scrollTop = this.outputEl.scrollHeight;
      this.scrollPending = false;
    });
  }

  private setStreaming(active: boolean): void {
    if (!this.contentEl.isConnected) return;
    this.isStreaming = active;
    this.sendBtn.disabled = active;
    this.inputEl.disabled = active;
    this.createNoteBtn.disabled = active;
    this.appendBtn.disabled = active;
  }

  private async streamTurn(req: InvokeRequest): Promise<void> {
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const turnEl = this.outputEl.createEl("div", { cls: "memex-pai-turn assistant" });
    const textSpan = turnEl.createEl("span");
    const cursorEl = turnEl.createEl("span", { text: t("modalStreaming"), cls: "memex-pai-cursor" });
    let turnText = "";
    let gotDone = false;

    try {
      for await (const event of this.client.invoke(req, signal)) {
        if (signal.aborted) return;
        if (event.type === "chunk") {
          turnText += event.text;
          textSpan.textContent = turnText;
          this.scrollToBottom();
        }
        if (event.type === "done") {
          gotDone = true;
          cursorEl.remove();
          if (event.error) {
            turnEl.addClass("memex-pai-turn-error");
            new Notice(t("noticeError", { error: event.error }));
          } else {
            this.lastDoneEvent = event;
            this.history.push({ role: "assistant", content: turnText });
            this.fullDialogText += (this.fullDialogText ? "\n\n---\n\n" : "") + `**PAI:** ${turnText}`;
            textSpan.empty();
            await MarkdownRenderer.render(this.app, turnText, textSpan, this.sourceFile.path, this);
          }
        }
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") { this.setStreaming(false); return; }
      if (this.contentEl.isConnected) {
        turnEl.setText(t("noticeError", { error: (e as Error).message }));
      }
      turnEl.addClass("memex-pai-turn-error");
      gotDone = true;
    } finally {
      cursorEl.remove();
    }

    if (!gotDone) {
      this.outputEl.createEl("div", {
        text: t("modalErrorNoResponse"),
        cls: "memex-pai-turn-error",
      });
    }

    this.setStreaming(false);
  }

  private async sendFollowUp(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text || this.isStreaming) return;

    this.inputEl.value = "";
    this.history.push({ role: "user", content: text });

    const userEl = this.outputEl.createEl("div", { cls: "memex-pai-turn user" });
    userEl.setText(text);
    this.scrollToBottom();

    this.fullDialogText += `\n\n---\n\n**You:** ${text}`;

    this.setStreaming(true);
    await this.streamTurn({ ...this.req, history: [...this.history] });
  }

  private async copyDialog(): Promise<void> {
    if (!this.fullDialogText) return;
    try {
      await navigator.clipboard.writeText(this.fullDialogText);
      new Notice(t("noticeCopied"));
    } catch {
      new Notice(t("noticeCopyFailed"));
    }
  }

  private async writeResult(action: "new-note" | "append"): Promise<void> {
    if (this.isStreaming || !this.fullDialogText) return;
    try {
      if (action === "new-note") {
        const suggestedName = this.lastDoneEvent?.suggestedName
          ?? `${this.sourceFile.basename} - ${this.label}.md`;
        const newFile = await this.writer.createNote(suggestedName, this.fullDialogText, this.sourceFile);
        const leaf = this.app.workspace.getLeaf("tab");
        await leaf.openFile(newFile);
      } else {
        await this.writer.appendToNote(this.sourceFile, this.fullDialogText, this.label);
      }
      this.close();
    } catch (e) {
      new Notice(t("noticeError", { error: (e as Error).message }));
    }
  }
}
