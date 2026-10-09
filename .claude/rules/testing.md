---
paths:
  - "**/*.test.ts"
  - "**/vitest.config.*"
---

# Testing conventions

- Vitest. Unit tests sit next to the code they test (`Member.test.ts` next to `Member.ts`).
- **Integration tests are named `*.integration.test.ts`.** They use Testcontainers (a real Postgres), so they need Docker running. They always run, and they never skip silently.
- Every tested package defines `test:unit` (`vitest run --exclude '**/*.integration.test.ts'`). CI fails if it's missing.
- `pnpm --filter <pkg> test:unit` gives fast feedback. `pnpm --filter <pkg> test` runs both kinds.
- Use-case tests stub the repository interface with `vi.fn()` (see `makeRepo()` in `RegisterMemberUseCase.test.ts`). Only infrastructure and API integration tests hit a real DB.
- API tests drive `buildApp()` through `app.inject()` without binding a port.
- Write the test first when adding domain behaviour (roadmap stage 2: TDD).
