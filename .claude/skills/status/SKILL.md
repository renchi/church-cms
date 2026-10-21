---
name: status
description: Answer "where is the ticket?" — is verify/review/CI/merge/deploy done, what's running in the background, which agents are working. Use whenever the user asks about progress ("is the review done?", "is shipping done?", "is CI green?", "what's running?", "what agents are working?"), including mid-step while something runs in the background.
argument-hint: "[CMS-<n>]  (omit for the current branch's ticket, or the newest record on main)"
---

# Status

Answer from evidence, never from memory: a step is done only if the status record or a live check says so. The record is what was last written; a live check is what's true now. When they disagree, believe the live check, say so, and fix the record. Read-only otherwise: don't start, rerun or merge anything here.

## 1. The status record

```bash
scripts/agent-status.sh show            # or: --ticket CMS-<n> show
```

One row per stage that has started: `start plan implement verify review ci merge deploy done`, each `running`, `waiting`, `done`, `failed`, or **`stale`**. Stale means the record says running but the process that would update it is gone (the session that started it ended, or it was killed). Never report a stale stage as running or done: check it live (step 3).

## 2. What's working right now

- **Background tasks you started in this session** (a CI or Deploy watch, a `cluster-up.sh` build): you get a notification when each one finishes. If one hasn't notified yet, it's still running; say how long it's been.
- **Agents:** the ListAgents tool lists subagents you started (a background code review, for example), plus other Claude Code sessions on this machine and whether each is busy or idle.

## 3. Live checks (only for stages that are running or stale)

```bash
gh pr checks <pr>                                         # ci: the record's PR number
gh run list --workflow=Deploy --commit <merge-sha> -L 1   # deploy: the sha is in the stage's note
```

If a live check finishes what the record left open, update it, e.g. `scripts/agent-status.sh set ci done "all 3 checks pass (checked live)"`.

## 4. Answer

2–5 lines, the stage the user asked about first. For example:

```
CMS-34: review ✓ (3 findings fixed) · CI running, 2 of 3 checks green, integration-tests still going (started 4 min ago).
Merge: not yet — I'll ask when CI is green. Agents: none besides this session.
```

If something is `waiting`, end with what you need from the user (usually "merge PR #n?").
