import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { t } from "./i18n";
import type MemexPAIPlugin from "./main";
import { PAIClient } from "./PAIClient";

export class MemexPAISettingsTab extends PluginSettingTab {
  constructor(app: App, private plugin: MemexPAIPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: t("settingsTitle") });

    new Setting(containerEl)
      .setName(t("settingDaemonUrl"))
      .setDesc(t("settingDaemonUrlDesc"))
      .addText(text =>
        text
          .setPlaceholder("http://localhost:8765")
          .setValue(this.plugin.settings.daemonUrl)
          .onChange(async (value) => {
            this.plugin.settings.daemonUrl = value;
            await this.plugin.saveSettings();
            this.plugin.client = new PAIClient(value);
          })
      );

    // Status row
    const statusSetting = new Setting(containerEl)
      .setName(t("settingDaemonStatus"));

    const statusEl = statusSetting.settingEl.createEl("span", {
      text: "…",
      cls: "memex-pai-status",
    });

    this.plugin.checkDaemonStatus().then(ok => {
      statusEl.setText(ok ? "🟢" : "🔴");
      statusEl.title = ok ? "" : t("daemonTooltipUnreachable");
    });

    new Setting(containerEl)
      .addButton(btn =>
        btn
          .setButtonText(t("btnStartDaemon"))
          .onClick(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (window as any).require?.("child_process")
              ?.exec(
                "launchctl load ~/Library/LaunchAgents/eu.giersig.pai-obsidian-bridge.plist",
                (err: unknown) => {
                  if (err) new Notice(`PAI: Failed to start daemon: ${err}`);
                  else new Notice("PAI: Daemon start requested.");
                }
              );
          })
      );
  }
}
