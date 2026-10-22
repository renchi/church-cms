---
name: start-ticket
description: Start work on a Linear ticket — sync main, read the ticket and its ADRs, create the cms-{n}/{slug} branch, move the ticket to In Progress, and surface reminders. Use at the start of every ticket session.
argument-hint: "[CMS-<n>]  (omit to take the top of the Todo queue)"
disable-model-invocation: true
---

# Start a ticket

Runs the "Start" row of the CLAUDE.md Workflow table. Stop and tell the user if any step fails. Don't push through a dirty tree or a failed pull.

## 1. Sync

```bash
git status --short           # must be clean; if not, ask the user what to do with the changes
git checkout main && git pull
```

## 2. Pick and read the ticket

- **Argument given** (e.g. `CMS-24`): use that ticket.
- **No argument:** take the **top of the `Todo` column**, i.e. the lowest `sortOrder`. `Todo` is the committed queue, and the user orders it on the Linear board. Never pick a ticket labelled `deferred`. If `Todo` is empty, list the non-deferred `Backlog` tickets and ask the user which one to take.

How to reach Linear, in this order:

1. The claude.ai Linear connector tools (`mcp__claude_ai_Linear__*`): `list_issues` (team CMS, state Todo), `get_issue`, `save_issue`. This is the normal path.
2. Only if the connector is unavailable, the GraphQL API with `$LINEAR_API_KEY`:
   ```bash
   curl -s https://api.linear.app/graphql -H "Authorization: $LINEAR_API_KEY" -H 'Content-Type: application/json' \
     -d '{"query":"{ issues(filter:{state:{name:{eq:\"Todo\"}}, labels:{every:{name:{neq:\"deferred\"}}}}){ nodes{ identifier title sortOrder } } }"}'
   ```
   Get the full ticket with `{ issue(id:"CMS-<n>"){ title description state{name} labels{nodes{name}} } }`.

Summarise the ticket for the user in a few lines: goal, tasks, and acceptance criteria.

## 3. Read the relevant ADRs and docs

Use the ADR index in CLAUDE.md to find the ADR(s) the ticket touches, and always read ADR-0007 (scope). Read `docs/study-guide.md` §0 to see where the ticket sits on the roadmap. Point out any conflict between the ticket and the ADRs or the "Active vs deferred services" table. For example, a ticket asking for work on a service that doesn't exist yet.

## 4. Branch and claim

```bash
git checkout -b cms-<n>/<two-to-four-word-slug>
```

Move the ticket to **In Progress** (connector `save_issue`, or the GraphQL `issueUpdate` mutation with the In Progress `stateId`).

Start the ticket's status record, which `/status` and the status line read (study-guide §12.4):

```bash
scripts/agent-status.sh set start done "branch cms-<n>/<slug>"
```

Record later stages as they happen: `set plan done` when the plan is approved, `set implement running`, then `set implement done` before `/verify`.

## 5. Surface reminders

Check the memory index for open reminders, such as repo visibility or pending follow-ups, and state them. Then check that the cluster is up if the ticket touches K8s: `minikube status`.

## 6. Next step

If the ticket touches more than two files or involves an architectural decision, enter plan mode. The plan **must include the learning deliverables** from `.claude/rules/docs-learning.md`.

**Suggest the skills that fit this ticket**: only the rows that match it, one line each with the reason, *before* plan mode. Never run them yourself: a grilling session takes the user's time, and whether a ticket deserves one is their call. If no row matches, say nothing. Use the full plugin names: other skills share some of these names.

| If the ticket… | Suggest | When |
| --- | --- | --- |
| adds a bounded context or aggregate, or changes what an ADR decided | `/mattpocock-skills:grill-with-docs` (stress-tests the design and updates ADRs as it goes) or `/mattpocock-skills:domain-modeling` | before plan mode |
| adds or changes domain behaviour (aggregates, invariants, use cases) | `/mattpocock-skills:tdd` (roadmap stage 2: tests first) | during implementation |
| uses a concept the study guide doesn't cover yet (check its sections) | `/mattpocock-skills:teach` | before or during planning |

Example: "CMS-20 adds the Communications context (ADR-0005). Consider `/mattpocock-skills:grill-with-docs` before plan mode."

If something breaks in a way that isn't obvious during the ticket, suggest `/mattpocock-skills:diagnosing-bugs` at that point.
