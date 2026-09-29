export const MEMORY_TOOL_DESCRIPTION = [
  "Bounded curated memory that persists across Pi sessions.",
  "target=memory (MEMORY.md, default 2200 chars): stable environment facts, project conventions, tool quirks.",
  "target=user (USER.md, default 1375 chars): who the user is and how they want you to work.",
  "Actions: add, replace, remove. replace and remove locate one entry with a unique old_text substring.",
  "Pass operations to add, replace, and remove in one atomic call when consolidating a full file.",
  "The system prompt shows a frozen snapshot from session start. This tool returns the live entries.",
  "Save a fact when the user states a durable preference or corrects you. Do not store secrets, one-off tasks, or transient failures such as command-not-found.",
].join(" ");

export const SKILL_VIEW_DESCRIPTION = [
  "Read a Pi skill's SKILL.md, or a supporting file when file_path is set.",
  "Required before skill_manage can patch or edit that skill, or overwrite an existing support file.",
  "A quote already in the transcript does not count; call this during the current turn or review.",
].join(" ");

export const SKILLS_LIST_DESCRIPTION =
  "List Pi skills with a one-line description and whether background review may maintain them (curator, pinned, or user).";

export const SKILL_MANAGE_DESCRIPTION = [
  "Create and maintain procedural skills in the Pi skills directory so later sessions load them on demand.",
  "Actions: create, edit, patch, delete, write_file, remove_file. Prefer patch over edit.",
  "Before patch or edit, call skill_view for that skill. Before overwriting or removing an existing support file, call skill_view with file_path.",
  "Support files must live under references/, templates/, scripts/, or assets/.",
  "Create class-level skills, not one skill per PR, error string, or date. Put session-specific detail in references/.",
  "Background review can only change curator-managed skills that are not pinned. User-owned skills stay untouched until the user runs /hermes adopt.",
  "Do not record unresolved failures as a recommended workflow, and do not store 'tool X is broken' as a durable rule.",
].join(" ");

export const SESSION_SEARCH_DESCRIPTION = [
  "Search past Pi session transcripts for how a similar task was solved.",
  "scope=project (default) limits results to the current working directory. scope=all searches every local session.",
  "Use this before re-deriving a workflow the user has already walked through.",
].join(" ");
