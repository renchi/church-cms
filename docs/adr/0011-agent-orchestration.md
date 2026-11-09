# ADR-0011 — Agent orchestration: one orchestrator, read-only workers, measured before trusted

**Date:** November 2026
**Status:** Accepted
**Linear:** CMS-35 (CMS-36 and CMS-37 will add addenda)
**Context:** How the AI agents that build this repo are split up, what each may do, and how we know a change to them helps

---

## Context

Learning goal 5 (ADR-0007) is "using AI tools". CMS-34 started an agent-orchestration track:
long workflow steps run in the background, a status record (`scripts/agent-status.sh`) tracks
each stage, and `/status` answers "is it done?" while the chat stays free (study-guide §12.4).

One step was left as it was: **"review in the background" started a _fork_** of the working
session, which then ran the built-in `/code-review`. A fork inherits the whole conversation.
That has two costs:

1. **Bias.** The fork has read the author's reasoning for every line ("this can't be null
   because…"). A reviewer that already agrees with the author is a weaker check.
2. **Cost.** Every fork carries the full context window, however long the session has been.

Claude Code also offers **subagents defined in files** (`.claude/agents/<name>.md`): a fresh
context, its own prompt, a fixed list of tools and a pinned model. The questions are which
agents to define, what each may touch, and how to tell whether the switch actually helps.

The track has two more parts already ticketed: an orchestrator written in code with the Claude
Agent SDK (CMS-36), and an advisory review agent in CI (CMS-37). Their rules should be decided
once, here, rather than re-argued per ticket.

---

## Decision

### 1. The rules for the whole track

- **One orchestrator, one level of workers.** The working session (later, CMS-36's program)
  decides and edits. Workers do one bounded job and report back. Workers don't start workers:
  deeper trees are hard to debug and multiply cost.
- **One writer per working tree, many readers.** Only the orchestrator edits the ticket branch.
  Reviewers and auditors only read, so any number can run in parallel. An agent that must write
  something else gets **its own git worktree** (§3 below).
- **The tool list is the security boundary, not the prompt.** "Only use Bash for `git diff`" in
  a prompt is a request that a prompt injection in a reviewed file could override. Leaving Bash
  out of `tools:` is a rule the harness enforces. The same lesson as CMS-34's allow list: a
  wrapper inherits the permissions of whatever it wraps.
- **Human gates stay human.** Plan approval and the merge always wait for the user's explicit
  yes. No agent in this track gets a tool that merges.
- **Structured output.** Workers end with one JSON block in a fixed schema, so a script can
  read it (the eval below, later CMS-36's state machine and CMS-37's PR comments).
- **Measure an agent before trusting it.** A change to how review works is tested against bugs
  whose locations are known, not judged by how convincing the output reads.

### 2. CMS-35's agents

| Agent | Tools | Model | Job |
| --- | --- | --- | --- |
| [`reviewer`](../../.claude/agents/reviewer.md) | Read, Grep, Glob | opus | Reviews everything the branch changed since `main` against `.claude/rules/*`, CLAUDE.md, the ADRs and the ticket's acceptance criteria. Returns `{findings:[…]}` |
| [`docs-auditor`](../../.claude/agents/docs-auditor.md) | Read, Grep, Glob | sonnet | Checks the learning deliverables against `docs-learning.md` inside `/verify` step 5. Returns `{items:[…]}` |
| [`bug-planter`](../../.claude/agents/bug-planter.md) | + Edit, Write, Bash | sonnet | Eval only: writes a feature with planted bugs in a separate worktree, seals the key outside the repo |

- **The reviewer has its own prompt,** written for this repo, instead of wrapping the built-in
  `/code-review`. Repo knowledge (layering, the outbox, Helm env vars, the ticket's criteria) is
  what a project agent can add that a general recipe can't.
- **No Bash for readers.** They can't compute a diff, so the orchestrator writes one first
  ([`scripts/review-input.sh`](../../scripts/review-input.sh)) and passes the file paths.
- **The reviewer pins opus** because the fork it replaces always runs on the parent's model.
  Any other model would add a third difference to the eval. The auditor's checklist work runs
  on sonnet.
- **The docs-auditor runs inside `/verify`, with no stage of its own.** Its result goes in the
  `verify` note (`docs-audit 9/10`), so the status record's stage list doesn't change.
- **A new agent file isn't usable instantly.** The running session picks it up after a delay
  (minutes, in CMS-35), and a new session always has it. Don't build a step on an agent file
  created a moment earlier.

### 3. How the change is measured

[`scripts/eval-reviewer.sh`](../../scripts/eval-reviewer.sh) runs a planted-bug eval
(runbook: [`docs/agents.md`](../agents.md)):

- **Three arms, one change each:** (1) fork + `/code-review` (the old way), (2) fresh agent +
  `/code-review` (only the context changes), (3) the `reviewer` subagent (then the prompt and
  tool list change). Two arms would compare two changes at once and couldn't say which helped.
- **Blind planting.** The `bug-planter` works in a separate git worktree on a local branch that
  is never pushed. It writes the answer key outside the repo and reports only an author-style
  feature description. Re-planting bugs that were fixed earlier doesn't work: the study guide
  describes them, and every reviewer can read it.
- **Three runs per arm,** reported as mean and min–max. One run can't tell a difference from
  luck.
- **Unmatched findings are labelled by a person** (false alarm, real but not planted, nit). A
  script can't tell a false alarm from a real bug nobody planted.

Results: study-guide §12.5.

---

## Consequences

**Good**

- A review that can't change anything, whatever a reviewed file says.
- The reviewer checks this repo's rules and the ticket, which a general recipe doesn't know.
- Fresh-context reviewers cost the same however long the working session has run.
- The eval script and the planter can be re-used for every later change to an agent (a cheaper
  model, a new prompt, CMS-37's CI agent).

**Costs**

- One extra step before every review: write the diff and the ticket to files.
- Readers without Bash can't run a test to check a hunch. They report it as `low` instead.
- An eval costs about nine reviews of tokens, and labelling unmatched findings takes a person.
- Known limits of the eval: the fork arm knows an eval is running (that can only raise its
  score), arm 2 vs arm 3 differ in tools as well as prompt, and Read can open any absolute path,
  so the key is hidden only because no reviewer is told where it is.

## Evolution path

| Now | Trigger | Then |
| --- | --- | --- |
| The working session orchestrates; background tasks die with it | A ticket's pipeline must survive the session, or resume after a crash | An Agent SDK program runs verify → review → fix → PR as a state machine over the status record (CMS-36) |
| Review runs when the user asks for it | Every PR should get a review, including ones made outside this session | The `reviewer` runs in GitHub Actions and posts comments only, with a read-only token, never on fork PRs (CMS-37) |
| `reviewer` pinned to opus | The eval shows a cheaper model catches as much | Pin sonnet; re-run the eval as a fourth arm first (`docs/agents.md` exercise) |
| Readers have no Bash at all | A reviewer needs to run something (a test) to be useful | Bash plus a `PreToolUse` hook that allows only named commands, tested like the allow list |

## Decision log

| Decision | Rejected alternative | Why |
| --- | --- | --- |
| One orchestrator, one worker level | Agents that spawn agents | Hard to debug, cost multiplies, and nothing here needs it |
| Readers in parallel, one writer per tree | Several tickets in parallel, each with its own writer agent | One minikube (6 GB) and one Deploy runner: parallel tickets would queue on them anyway |
| Tool list as the boundary | Bash limited by the prompt or `settings.json` alone | A prompt is a request; a reviewed file could override it |
| Own reviewer prompt | Wrap `/code-review` in a subagent | Only the context would change; the repo-specific checks are the point |
| Own reviewer prompt only | Keep `/code-review` *and* add the reviewer | Two overlapping reviewers, and no rule for which one to trust |
| Claude Code subagents, later the Claude Agent SDK | CrewAI (or another multi-agent framework) | A second language (Python) and framework for concepts the existing tools already teach; a paragraph comparing them is enough |
