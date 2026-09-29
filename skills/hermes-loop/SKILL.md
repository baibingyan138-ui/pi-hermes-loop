---
name: hermes-loop
description: Use when a correction, preference, or non-trivial workflow should outlive this Pi session. Saves curated memory and patches class-level skills through the Hermes-style learning loop.
---

# Hermes loop

This Pi package is the runtime learning loop. Memory is who the user is and what stays true. Skills are how to do a class of work. Do not wait for the background review when the lesson is already obvious.

## Save memory

Call `memory` when the user states a durable preference, corrects tone or workflow, or reveals a stable environment fact.

- `target=user` for the person: language, format, role, pet peeves.
- `target=memory` for the environment: conventions, tool quirks, paths that will still be true next week.
- Use `replace` when an entry already covers that fact. If the file is full, `remove` or shorten entries in the same `operations` batch, then add.
- Do not store secrets, one-off task notes, or transient failures such as a missing binary.

The block in the system prompt is a frozen snapshot from session start. Trust the tool result for the live text.

## Save a skill

Call `skill_manage` when a future session would otherwise repeat a multi-step procedure, a fix, or a correction about how a class of task should be done.

1. `skills_list` to see what already exists.
2. `skill_view` the skill you might change. This is mandatory before `patch` or `edit`.
3. Prefer `patch`. Put session-specific detail in `references/`, copyable starters in `templates/`, and re-runnable checks in `scripts/`.
4. Create a new skill only when no class-level skill fits. Name the class (`deploy-web`), not today's incident (`fix-504-today`).
5. Frontmatter `name` must match the skill name. Include `name` and `description`.

Background review will later maintain skills it created, and skills you mark with `/hermes adopt`. It will not edit skills you created in the foreground, pinned skills, or anything outside `~/.pi/agent/skills`.

Do not write an unresolved failure up as a recommended workflow. Do not record "tool X is broken".

## Recall

Call `session_search` before re-deriving a workflow this project has already done. `scope=project` is the default.

## Commands

`/hermes status` shows the loop. `/hermes pending` and `/hermes approve` are for the write-approval gate. `/hermes review` runs a review immediately.
