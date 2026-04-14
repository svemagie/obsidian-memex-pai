import { App, TFile, normalizePath } from "obsidian";

export class PAIResultWriter {
  constructor(private app: App) {}

  /** Creates a new note next to the source. Returns the created file. */
  async createNote(suggestedName: string, content: string, sourceFile: TFile): Promise<TFile> {
    const folder = sourceFile.parent?.path ?? "";
    let name = suggestedName.endsWith(".md") ? suggestedName : `${suggestedName}.md`;

    // Collision guard: append datestamp + counter if needed
    let path = normalizePath(`${folder}/${name}`);
    if (this.app.vault.getAbstractFileByPath(path)) {
      const date = new Date().toISOString().slice(0, 10);
      const baseName = name.replace(/\.md$/, "");
      name = `${baseName} ${date}.md`;
      path = normalizePath(`${folder}/${name}`);
      let counter = 2;
      while (this.app.vault.getAbstractFileByPath(path)) {
        name = `${baseName} ${date} ${counter}.md`;
        path = normalizePath(`${folder}/${name}`);
        counter++;
      }
    }

    return this.app.vault.create(path, content);
  }

  /** Appends PAI output under a section header in the source note. */
  async appendToNote(file: TFile, content: string, sectionLabel: string): Promise<void> {
    const existing = await this.app.vault.read(file);
    const appended = `${existing}\n\n---\n## PAI: ${sectionLabel}\n\n${content}`;
    await this.app.vault.modify(file, appended);
  }
}
