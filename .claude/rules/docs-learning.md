---
paths:
  - "docs/**"
---

# Learning docs: a deliverable on every ticket

The project exists so the user can learn (ADR-0007). A ticket isn't done until its learning material is written, so plan these deliverables and verify them like code.

## Every ticket updates `docs/study-guide.md`

- **A new or extended numbered section** for the concept, in the same shape as §7 (Kubernetes), §8 (CI/CD) and §9 (Observability):
  1. **The concept.** What it is and what problem it solves, in plain language first, then the vocabulary.
  2. **How we did it here.** The real files, linked as `path:line`.
  3. **Why this way.** The trade-off and the ADR it relates to, plus what was deliberately deferred.
  4. **What setting it up taught.** A problem → lesson table of real issues hit during the ticket (like §8.4). Fill it in during implementation; don't invent entries.
- **§0 roadmap status** and the goal list at the top (e.g. "stage 7 done").
- **The "Self-check" section**: add 4–8 questions, each pointing to its section (`(§9.3)`).
- **The "Where to go next" section**, plus the "known gaps" lists if the ticket closes or opens one.
- Refer to those two by name, not number: each new stage section shifts them down.
- If a new companion doc is added, list it in the "companion docs" list at the top.

## Runbooks (`docs/<topic>.md`)

When a ticket adds something to operate (install, deploy, debug), write or extend a runbook in the style of `k8s-local-dev.md`:

- Numbered steps, each with the exact command and its **expected output** shown as comments, so the reader can tell whether it worked.
- A "what this does" note after any non-obvious flag.
- A troubleshooting section for the failures actually hit.
- **Hands-on exercises** at the end, with the expected result for each, so the user can check themselves. Good exercises break something on purpose and watch the system react.

## Style

- Explain _why_ before _how_. Assume the reader is new to the concept, but not to programming.
- Use real names from this repo, not generic examples.
- Keep `status-dashboards.md` current when a ticket adds a UI or endpoint worth watching.
