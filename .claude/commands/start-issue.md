---
description: Start a Linear issue — load it, branch, set In Progress, then implement
argument-hint: <issue-id, e.g. CMS-9>
---

Start work on Linear issue **$1**. Follow these steps in order:

1. Fetch the issue with the Linear MCP `get_issue` tool to load its full
   description and acceptance criteria (the list views truncate them).
2. Create and switch to a new git branch using the issue's `gitBranchName`
   field (e.g. `git switch -c <gitBranchName>`). Branch off `main`.
3. Move the issue to **In Progress** via Linear `save_issue`.
4. Turn the acceptance criteria into a `TodoWrite` checklist, then begin
   implementing — smallest coherent slice first.

Constraints:
- Honour the conventions in CLAUDE.md and the ADRs in `docs/adr/`.
- Do NOT scaffold deferred services (identity / finance / communications /
  groups) — they are blocked by ADR-0007.
- Verify the change actually runs before claiming it is done.

When the work is complete and verified, summarise what changed and ask before
opening a PR or moving the issue to Done.
