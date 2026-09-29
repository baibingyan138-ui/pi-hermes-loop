import fs from "node:fs";
import path from "node:path";
import { writeAtomic } from "./lock.ts";
import type { ReadMarks } from "./read-marks.ts";
import { scanContent } from "./security.ts";
import type { Origin, ToolOutcome } from "./types.ts";

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_SKILL_CHARS = 100_000;
const MAX_SUPPORT_BYTES = 1_048_576;
const ALLOWED_SUBDIRS = new Set(["references", "templates", "scripts", "assets"]);

const ARTIFACT_NAME =
  /^(?:fix|debug|audit|summarize|summary|investigate|today)-|-\d{3,}$|\d{4}-\d{2}-\d{2}/;

export interface SkillSummary {
  name: string;
  description: string;
  directory: string;
  managed: boolean;
  pinned: boolean;
  origin: Origin | "user";
}

export interface RegistryEntry {
  origin: Origin;
  pinned: boolean;
  createdAt: string;
}

export interface SkillRegistry {
  skills: Record<string, RegistryEntry>;
}

export interface SkillStoreOptions {
  skillsDir: string;
  registryPath: string;
  readMarks: ReadMarks;
}

export type SkillAction =
  | { action: "create"; name: string; content: string; category?: string }
  | { action: "edit"; name: string; content: string }
  | { action: "patch"; name: string; old_string: string; new_string: string; file_path?: string; replace_all?: boolean }
  | { action: "delete"; name: string }
  | { action: "write_file"; name: string; file_path: string; file_content: string }
  | { action: "remove_file"; name: string; file_path: string };

export class SkillStore {
  private readonly options: SkillStoreOptions;

  constructor(options: SkillStoreOptions) {
    this.options = options;
  }

  list(): SkillSummary[] {
    const registry = this.readRegistry();
    const found = new Map<string, { directory: string; description: string }>();
    if (fs.existsSync(this.options.skillsDir)) {
      for (const directory of skillDirectories(this.options.skillsDir)) {
        const skillFile = path.join(directory, "SKILL.md");
        const parsed = parseFrontmatter(fs.readFileSync(skillFile, "utf8"));
        if ("error" in parsed) continue;
        const name = parsed.name;
        if (!found.has(name)) {
          found.set(name, { directory, description: parsed.description });
        }
      }
    }
    return [...found.entries()]
      .map(([name, info]) => {
        const record = registry.skills[name];
        return {
          name,
          description: info.description,
          directory: info.directory,
          managed: record?.origin === "review" && !record.pinned,
          pinned: record?.pinned === true,
          origin: record?.origin ?? "user",
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  view(name: string, filePath?: string): ToolOutcome {
    const located = this.locate(name);
    if ("error" in located) return fail(located.error);
    const relative = filePath?.trim() || "SKILL.md";
    const resolved = resolveInside(located.directory, relative === "SKILL.md" ? "SKILL.md" : relative);
    if (isFailure(resolved)) return fail(resolved.error);
    if (!fs.existsSync(resolved)) return fail(`No such file in skill ${name}: ${relative}`);
    const text = fs.readFileSync(resolved, "utf8");
    if (relative === "SKILL.md") this.options.readMarks.markSkill(name);
    else this.options.readMarks.markFile(name, normalizeRelative(relative));
    return ok(`# ${name} (${relative})\n\n${text}`);
  }

  /**
   * Validate and apply a skill write.
   * `applying` skips read-before-write because the user already approved a staged mutation.
   */
  mutate(request: SkillAction, origin: Origin, applying = false, commit = true): ToolOutcome {
    const nameError = validateName(request.name);
    if (nameError) return fail(nameError);
    const located = request.action === "create" ? null : this.locate(request.name);
    if (located && "error" in located && request.action !== "create") return fail(located.error);

    if (request.action !== "create") {
      const protection = this.protectionError(request.name, origin);
      if (protection) return fail(protection);
    }

    try {
      switch (request.action) {
        case "create":
          return this.create(request, origin, commit);
        case "edit":
          return this.edit(request.name, request.content, located as Located, applying, commit);
        case "patch":
          return this.patch(request, located as Located, applying, commit);
        case "delete":
          return this.delete(request.name, located as Located, commit);
        case "write_file":
          return this.writeFile(request, located as Located, applying, commit);
        case "remove_file":
          return this.removeFile(request, located as Located, applying, commit);
      }
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }

  pin(name: string, pinned: boolean): ToolOutcome {
    const registry = this.readRegistry();
    const entry = registry.skills[name];
    if (!entry) return fail(`${name} is not in the hermes-loop registry. /hermes adopt it first.`);
    entry.pinned = pinned;
    this.writeRegistry(registry);
    return ok(pinned ? `Pinned ${name}. Background review will not edit it.` : `Unpinned ${name}.`, pinned ? `pinned ${name}` : `unpinned ${name}`);
  }

  adopt(name: string): ToolOutcome {
    const located = this.locate(name);
    if ("error" in located) return fail(located.error);
    const registry = this.readRegistry();
    const existing = registry.skills[name];
    registry.skills[name] = {
      origin: "review",
      pinned: existing?.pinned === true,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    this.writeRegistry(registry);
    return ok(`Adopted ${name}. Background review may now maintain it.`, `adopted ${name}`);
  }

  private create(request: Extract<SkillAction, { action: "create" }>, origin: Origin, commit: boolean): ToolOutcome {
    if (origin === "review") {
      const artifact = sessionArtifactReason(request.name);
      if (artifact) return fail(artifact);
    }
    const categoryError = request.category ? validateName(request.category) : null;
    if (categoryError) return fail(`Invalid category. ${categoryError}`);
    const front = validateSkillMarkdown(request.content, request.name);
    if (front) return fail(front);
    const scanned = scanContent(request.content);
    if (scanned) return fail(scanned);
    if (!("error" in this.locate(request.name))) {
      return fail(`Skill ${request.name} already exists. Patch it, or pick a class-level name that is not taken.`);
    }
    const directory = path.join(
      this.options.skillsDir,
      ...(request.category ? [request.category] : []),
      request.name,
    );
    if (commit) {
      fs.mkdirSync(directory, { recursive: true });
      writeAtomic(path.join(directory, "SKILL.md"), ensureTrailingNewline(request.content));
      const registry = this.readRegistry();
      registry.skills[request.name] = {
        origin,
        pinned: false,
        createdAt: new Date().toISOString(),
      };
      this.writeRegistry(registry);
    }
    const note =
      origin === "review"
        ? "Background review can keep patching this skill."
        : "This skill is user-owned. Background review will not edit it unless you run /hermes adopt.";
    return ok(
      `Created skill ${request.name} at ${directory}. Pi loads it on the next session; use skill_view to read it now. ${note}`,
      `created skill ${request.name}`,
    );
  }

  private edit(name: string, content: string, located: Located, applying: boolean, commit: boolean): ToolOutcome {
    if (!applying && !this.options.readMarks.hasSkill(name)) {
      return fail(readBeforeWrite(name));
    }
    const front = validateSkillMarkdown(content, name);
    if (front) return fail(front);
    const scanned = scanContent(content);
    if (scanned) return fail(scanned);
    if (commit) writeAtomic(path.join(located.directory, "SKILL.md"), ensureTrailingNewline(content));
    return ok(`Updated SKILL.md for ${name}.`, `edited skill ${name}`);
  }

  private patch(
    request: Extract<SkillAction, { action: "patch" }>,
    located: Located,
    applying: boolean,
    commit: boolean,
  ): ToolOutcome {
    const relative = request.file_path?.trim() || "SKILL.md";
    const isSkill = relative === "SKILL.md";
    if (!applying) {
      if (isSkill && !this.options.readMarks.hasSkill(request.name)) return fail(readBeforeWrite(request.name));
      if (!isSkill && !this.options.readMarks.hasFile(request.name, normalizeRelative(relative))) {
        return fail(
          `Read-before-write: call skill_view with name=${request.name} and file_path=${relative} during this review, then retry the patch once.`,
        );
      }
    }
    if (!request.old_string) return fail("old_string is required for patch.");
    if (request.new_string == null) return fail("new_string is required for patch. Use an empty string to delete the match.");
    const resolved = resolveInside(located.directory, isSkill ? "SKILL.md" : relative);
    if (isFailure(resolved)) return fail(resolved.error);
    if (!fs.existsSync(resolved)) return fail(`No such file in skill ${request.name}: ${relative}`);
    const current = fs.readFileSync(resolved, "utf8");
    const patched = applyPatch(current, request.old_string, request.new_string, request.replace_all === true);
    if ("error" in patched) return fail(patched.error);
    if (isSkill) {
      const front = validateSkillMarkdown(patched.text, request.name);
      if (front) return fail(front);
    }
    const scanned = scanContent(patched.text);
    if (scanned) return fail(scanned);
    if (Buffer.byteLength(patched.text) > (isSkill ? MAX_SKILL_CHARS : MAX_SUPPORT_BYTES)) {
      return fail("Patched file exceeds the size limit. Split detail into references/.");
    }
    if (commit) writeAtomic(resolved, patched.text);
    return ok(`Patched ${relative} in ${request.name} (${patched.count} replacement${patched.count === 1 ? "" : "s"}).`, `patched ${request.name}`);
  }

  private delete(name: string, located: Located, commit: boolean): ToolOutcome {
    if (commit) {
      fs.rmSync(located.directory, { recursive: true, force: true });
      const registry = this.readRegistry();
      delete registry.skills[name];
      this.writeRegistry(registry);
    }
    return ok(`Deleted skill ${name}.`, `deleted skill ${name}`);
  }

  private writeFile(
    request: Extract<SkillAction, { action: "write_file" }>,
    located: Located,
    applying: boolean,
    commit: boolean,
  ): ToolOutcome {
    const relative = normalizeRelative(request.file_path || "");
    if (relative === "SKILL.md") return fail("Use edit or patch to change SKILL.md.");
    const resolved = resolveInside(located.directory, relative);
    if (isFailure(resolved)) return fail(resolved.error);
    const exists = fs.existsSync(resolved);
    if (exists && !applying && !this.options.readMarks.hasFile(request.name, relative)) {
      return fail(
        `Read-before-write: call skill_view with name=${request.name} and file_path=${relative} before overwriting it.`,
      );
    }
    if (request.file_content == null) return fail("file_content is required for write_file.");
    if (Buffer.byteLength(request.file_content) > MAX_SUPPORT_BYTES) {
      return fail(`Supporting file exceeds ${MAX_SUPPORT_BYTES} bytes.`);
    }
    const scanned = scanContent(request.file_content);
    if (scanned) return fail(scanned);
    if (commit) {
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      writeAtomic(resolved, request.file_content);
    }
    return ok(
      `${exists ? "Updated" : "Added"} ${relative} in ${request.name}. Point to it from SKILL.md if it is new.`,
      `${exists ? "updated" : "added"} ${request.name}/${relative}`,
    );
  }

  private removeFile(
    request: Extract<SkillAction, { action: "remove_file" }>,
    located: Located,
    applying: boolean,
    commit: boolean,
  ): ToolOutcome {
    const relative = normalizeRelative(request.file_path || "");
    if (relative === "SKILL.md") return fail("Use delete to remove a skill, not remove_file on SKILL.md.");
    const resolved = resolveInside(located.directory, relative);
    if (isFailure(resolved)) return fail(resolved.error);
    if (!fs.existsSync(resolved)) return fail(`No such file in skill ${request.name}: ${relative}`);
    if (!applying && !this.options.readMarks.hasFile(request.name, relative)) {
      return fail(
        `Read-before-write: call skill_view with name=${request.name} and file_path=${relative} before removing it.`,
      );
    }
    if (commit) fs.unlinkSync(resolved);
    return ok(`Removed ${relative} from ${request.name}.`, `removed ${request.name}/${relative}`);
  }

  private protectionError(name: string, origin: Origin): string | null {
    if (origin === "foreground") return null;
    const record = this.readRegistry().skills[name];
    if (!record || record.origin !== "review") {
      return (
        `${name} is user-owned or outside the curator registry. Background review must not edit it. ` +
        `Say so in the reply and recommend '/hermes adopt ${name}' if the user should hand it over.`
      );
    }
    if (record.pinned) {
      return `${name} is pinned. Background review cannot change it. Only a foreground session can edit a pinned skill.`;
    }
    return null;
  }

  private locate(name: string): Located | { error: string } {
    if (!fs.existsSync(this.options.skillsDir)) return { error: `Skill ${name} was not found.` };
    const hits: string[] = [];
    for (const directory of skillDirectories(this.options.skillsDir)) {
      const skillFile = path.join(directory, "SKILL.md");
      const raw = fs.readFileSync(skillFile, "utf8");
      const parsed = parseFrontmatter(raw);
      const frontName = "error" in parsed ? undefined : parsed.name;
      if (path.basename(directory) === name || frontName === name) hits.push(directory);
    }
    if (hits.length === 0) return { error: `Skill ${name} was not found.` };
    if (hits.length > 1) return { error: `Multiple skill directories match ${name}: ${hits.join(", ")}` };
    return { directory: hits[0] };
  }

  private readRegistry(): SkillRegistry {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.options.registryPath, "utf8")) as SkillRegistry;
      if (!parsed || typeof parsed !== "object" || !parsed.skills) return { skills: {} };
      return parsed;
    } catch {
      return { skills: {} };
    }
  }

  private writeRegistry(registry: SkillRegistry): void {
    writeAtomic(this.options.registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  }
}

interface Located {
  directory: string;
}

export function validateName(name: string): string | null {
  if (!name || !NAME_RE.test(name) || name.length > MAX_NAME_LENGTH) {
    return `Invalid skill name '${name}'. Use lowercase letters, digits, and hyphens, starting and ending with a letter or digit, at most ${MAX_NAME_LENGTH} characters. Pi will not load anything else.`;
  }
  return null;
}

export function sessionArtifactReason(name: string): string | null {
  if (ARTIFACT_NAME.test(name)) {
    return (
      `Refusing to create '${name}': it names today's task, not a class of work. ` +
      "Patch an existing umbrella skill or add a file under references/, templates/, or scripts/."
    );
  }
  return null;
}

export function validateSkillMarkdown(content: string, expectedName: string): string | null {
  if (content.length > MAX_SKILL_CHARS) {
    return `SKILL.md is ${content.length} characters (limit ${MAX_SKILL_CHARS}). Move detail into references/.`;
  }
  const parsed = parseFrontmatter(content);
  if ("error" in parsed) return parsed.error;
  if (parsed.name !== expectedName) {
    return `Frontmatter name '${parsed.name}' must match the skill name '${expectedName}'.`;
  }
  if (!parsed.description.trim()) return "Frontmatter description cannot be empty.";
  if (parsed.description.length > MAX_DESCRIPTION_LENGTH) {
    return `Description exceeds ${MAX_DESCRIPTION_LENGTH} characters.`;
  }
  if (!parsed.body.trim()) return "SKILL.md must have instructions after the frontmatter.";
  return null;
}

export function parseFrontmatter(
  content: string,
): { name: string; description: string; body: string } | { error: string } {
  const trimmed = content.replace(/^\uFEFF/, "");
  if (!trimmed.startsWith("---")) {
    return { error: "SKILL.md must start with YAML frontmatter (---)." };
  }
  const end = trimmed.indexOf("\n---", 3);
  if (end === -1) return { error: "SKILL.md frontmatter is not closed with ---." };
  const yaml = trimmed.slice(3, end).replace(/^\n/, "");
  const body = trimmed.slice(end + 4).replace(/^\n/, "");
  const name = scalarField(yaml, "name");
  const description = scalarField(yaml, "description");
  if (!name) return { error: "Frontmatter must include a name field." };
  if (!description) return { error: "Frontmatter must include a description field." };
  return { name, description, body };
}

function scalarField(yaml: string, key: string): string | null {
  const match = yaml.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
  if (!match) return null;
  let value = match[1].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  if (value === "|" || value === ">") return null;
  return value;
}

function skillDirectories(root: string): string[] {
  const directories: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const first = path.join(root, entry.name);
    if (fs.existsSync(path.join(first, "SKILL.md"))) directories.push(first);
    for (const child of fs.readdirSync(first, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      const second = path.join(first, child.name);
      if (fs.existsSync(path.join(second, "SKILL.md"))) directories.push(second);
    }
  }
  return directories;
}

function isFailure(value: { error: string } | string): value is { error: string } {
  return typeof value !== "string";
}

function resolveInside(skillDir: string, relative: string): { error: string } | string {
  const normalized = normalizeRelative(relative);
  if (!normalized || normalized === "SKILL.md") {
    return normalized === "SKILL.md" ? path.join(skillDir, "SKILL.md") : { error: "file_path is required." };
  }
  if (normalized.includes("..") || path.isAbsolute(normalized)) {
    return { error: "file_path must stay inside the skill directory." };
  }
  const [subdir] = normalized.split("/");
  if (!ALLOWED_SUBDIRS.has(subdir)) {
    return { error: `Supporting files must live in ${[...ALLOWED_SUBDIRS].join(", ")}.` };
  }
  const resolved = path.resolve(skillDir, normalized);
  const root = path.resolve(skillDir) + path.sep;
  if (!resolved.startsWith(root)) return { error: "file_path must stay inside the skill directory." };
  return resolved;
}

function normalizeRelative(relative: string): string {
  return relative.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function applyPatch(
  current: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): { text: string; count: number } | { error: string } {
  const count = occurrences(current, oldString);
  if (count === 0) return { error: "old_string was not found in the file." };
  if (count > 1 && !replaceAll) {
    return { error: `old_string matched ${count} times. Pass replace_all or include more surrounding text.` };
  }
  const text = replaceAll ? current.split(oldString).join(newString) : current.replace(oldString, newString);
  return { text, count: replaceAll ? count : 1 };
}

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (from <= haystack.length) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) break;
    count += 1;
    from = index + needle.length;
  }
  return count;
}

function readBeforeWrite(name: string): string {
  return `Read-before-write: call skill_view with name=${name} during this review before patching or editing SKILL.md. Transcript quotes do not count. View it once and retry the write once.`;
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function ok(text: string, action?: string): ToolOutcome {
  return { text, isError: false, action };
}

function fail(text: string): ToolOutcome {
  return { text, isError: true };
}
