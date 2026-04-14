import { Notice, Plugin } from "obsidian";
import { PAIClient } from "./PAIClient";
import { PAIResultWriter } from "./PAIResultWriter";
import { PAISkillPickerModal } from "./PAISkillPickerModal";
import { MemexPAISettingsTab } from "./SettingsTab";
import { PluginSettings, DEFAULT_SETTINGS, SSEEvent } from "./types";
import { t } from "./i18n";

export default class MemexPAIPlugin extends Plugin {
  settings!: PluginSettings;
  client!: PAIClient;
  private ribbonEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    const data = (await this.loadData()) as { settings?: PluginSettings } | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(data?.settings ?? {}) };
    this.client = new PAIClient(this.settings.daemonUrl);

    this.addSettingTab(new MemexPAISettingsTab(this.app, this));

    this.ribbonEl = this.addRibbonIcon("brain", "Memex PAI", () => {
      this.invokeSkillCommand();
    });

    this.addCommand({
      id: "memex-pai-skill",
      name: t("cmdSkillOnNote"),
      callback: () => this.invokeSkillCommand(),
    });

    this.addCommand({
      id: "memex-pai-algorithm",
      name: t("cmdAlgorithmOnNote"),
      callback: () => this.invokeAlgorithmCommand(),
    });

    // Check daemon on load; retry once after 2s
    this.checkDaemonStatus().then(ok => {
      if (!ok) setTimeout(() => this.checkDaemonStatus().then(ok2 => {
        if (this.ribbonEl) {
          this.ribbonEl.title = ok2 ? "" : t("daemonTooltipUnreachable");
          this.ribbonEl.toggleClass("memex-pai-ribbon-error", !ok2);
        }
      }), 2000);
    });
  }

  async checkDaemonStatus(): Promise<boolean> {
    const status = await this.client.getStatus();
    return status !== null;
  }

  private async invokeSkillCommand(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) { new Notice(t("noticeNoFile")); return; }

    const content = await this.app.vault.read(file);
    if (!content.trim()) { new Notice(t("noticeEmptyNote")); return; }
    if (content.length > 100 * 1024) { new Notice(t("noticeContentTooLarge")); return; }

    const ok = await this.checkDaemonStatus();
    if (!ok) { new Notice(t("noticeNoDaemon")); return; }

    const skills = await this.client.getSkills();
    if (skills.length === 0) { new Notice(t("noticeNoDaemon")); return; }

    new PAISkillPickerModal(this.app, skills, async (skill) => {
      await this.runInvocation({
        action: "skill",
        skill: skill.name,
        content,
        notePath: file.path,
      }, skill.name, file);
    }).open();
  }

  private async invokeAlgorithmCommand(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) { new Notice(t("noticeNoFile")); return; }

    const content = await this.app.vault.read(file);
    if (!content.trim()) { new Notice(t("noticeEmptyNote")); return; }
    if (content.length > 100 * 1024) { new Notice(t("noticeContentTooLarge")); return; }

    const ok = await this.checkDaemonStatus();
    if (!ok) { new Notice(t("noticeNoDaemon")); return; }

    await this.runInvocation({
      action: "algorithm",
      content,
      notePath: file.path,
    }, t("cmdAlgorithmOnNote"), file);
  }

  private async runInvocation(
    req: Parameters<PAIClient["invoke"]>[0],
    label: string,
    sourceFile: import("obsidian").TFile,
  ): Promise<void> {
    const notice = new Notice(t("noticeRunning", { skill: label, elapsed: "0s" }), 0);
    const start = Date.now();
    const timer = setInterval(() => {
      const elapsed = `${Math.floor((Date.now() - start) / 1000)}s`;
      notice.setMessage(t("noticeRunning", { skill: label, elapsed }));
    }, 5000);

    let fullText = "";
    let doneEvent: SSEEvent | null = null;

    try {
      for await (const event of this.client.invoke(req)) {
        if (event.type === "chunk") fullText += event.text;
        if (event.type === "done") { doneEvent = event; break; }
      }
    } catch (e) {
      clearInterval(timer);
      notice.hide();
      new Notice(t("noticeError", { error: (e as Error).message }));
      return;
    }

    clearInterval(timer);
    notice.hide();

    if (!doneEvent || doneEvent.type !== "done") {
      new Notice(t("noticeError", { error: "No response from daemon." }));
      return;
    }
    if (doneEvent.error) {
      new Notice(t("noticeError", { error: doneEvent.error }));
      return;
    }

    const writer = new PAIResultWriter(this.app);

    if (doneEvent.resultAction === "new-note" && doneEvent.suggestedName) {
      const newFile = await writer.createNote(doneEvent.suggestedName, fullText, sourceFile);
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.openFile(newFile);
    } else if (doneEvent.resultAction === "append") {
      await writer.appendToNote(sourceFile, fullText, label);
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData({ settings: this.settings });
  }
}
