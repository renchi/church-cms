---
paths:
  - "apps/web/**"
---

# Conventions for the web app (Next.js)

The web app is a client of the services. It shows their data and passes on their answers; the business rules live in the services' aggregates (`ddd.md`). Each rule below comes from a CMS-26 review finding (study-guide §5.4).

- **Send user input as typed.** Trimming, required fields, formats and "blank means none" belong to the aggregate, which every API client goes through. The form adds only HTML hints (`required`, `type="email"`).
- **Show users generic error text; log the details.** A visitor sees "Could not load members. Try again in a moment."; the status, the cause and any internal URL go to `console.error`, which ends up in `kubectl logs deploy/web-web`. Service messages meant for users (a domain `400`/`409` `{ error }`) are shown as-is.
- **Carry ids in URLs and look them up.** Text shown on a page comes from a service response, never straight from a query parameter, so a crafted link can't put words on the page. Treat a repeated parameter (an array) as absent.
- **A Server Action returns a result for every outcome.** Read response bodies with `.catch()`, check their shape, and return `{ error, values }` on failure. `redirect()` is the only throw, and it sits outside any try/catch.
- **Server-only config has no `NEXT_PUBLIC_` prefix**, and is set in `charts/web` as well as `docker-compose.yml` (`scripts/check-env.sh` enforces the chart side).
- **Every call to a service goes through `lib/membersApi.ts`** (or a sibling module per service), so status mapping lives in one place.
