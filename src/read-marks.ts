/** Tracks skill_view calls inside one foreground session or one background review. */
export class ReadMarks {
  private readonly skills = new Set<string>();
  private readonly files = new Set<string>();

  markSkill(name: string): void {
    this.skills.add(name);
  }

  markFile(name: string, filePath: string): void {
    this.files.add(`${name}\0${filePath}`);
  }

  hasSkill(name: string): boolean {
    return this.skills.has(name);
  }

  hasFile(name: string, filePath: string): boolean {
    return this.files.has(`${name}\0${filePath}`);
  }

  clear(): void {
    this.skills.clear();
    this.files.clear();
  }
}
