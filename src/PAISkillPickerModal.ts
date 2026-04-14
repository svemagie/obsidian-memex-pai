import { SuggestModal, App } from "obsidian";
import { SkillEntry } from "./types";

export class PAISkillPickerModal extends SuggestModal<SkillEntry> {
  constructor(
    app: App,
    private skills: SkillEntry[],
    private onSelect: (skill: SkillEntry) => void,
  ) {
    super(app);
    this.setPlaceholder("Select a PAI skill…");
  }

  getSuggestions(query: string): SkillEntry[] {
    const q = query.toLowerCase();
    if (!q) return this.skills;
    return this.skills.filter(s =>
      s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
    );
  }

  renderSuggestion(skill: SkillEntry, el: HTMLElement): void {
    el.createEl("div", { text: skill.name, cls: "memex-pai-skill-name" });
    el.createEl("small", { text: skill.description, cls: "memex-pai-skill-desc" });
  }

  onChooseSuggestion(skill: SkillEntry): void {
    this.onSelect(skill);
  }
}
