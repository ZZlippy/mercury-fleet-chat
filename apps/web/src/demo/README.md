# Demo mode (GitHub Pages build)

This folder makes it possible to publish a **UI-only, static** build of the
web app to GitHub Pages — a real backend (Fastify + PostgreSQL) can't run on
Pages, so this build replaces every network call with an in-memory
simulation backed by sample data captured from a real, working instance of
this app.

## How it works

- `fixtures.json` is captured by `scripts/build-demo-fixtures.ts`, which
  spins up the real API + a scratch PostgreSQL database, drives several
  order lifecycles through the actual business logic (RFQ → quote → booking
  → shipment milestones → document review → completion, plus an in-progress
  shipment, a pending quote decision, a draft order, and a pending fleet
  profile review), and dumps the resulting API responses to this file.
  Nothing in it is real client data — it's generated from the seeded demo
  accounts (`fleet1..fleet10` / `operator1..operator3`).
- `store.ts` clones those fixtures into an in-memory store once per page
  load.
- `api.ts` implements the same method signatures as the real `api` object in
  `../api.ts`. Reads return the captured fixture data; writes (creating an
  order, selecting a quote, sending a chat message, reviewing a profile,
  etc.) apply a simplified, best-effort update to that same in-memory store
  so the UI reacts — but nothing is persisted past a page reload, and
  nothing is sent anywhere.
- `../api.ts` picks `demoApi` instead of the real fetch-based implementation
  when built with `VITE_DEMO_MODE=true` (see the root `build:demo` script).

## Regenerating fixtures

If the app's data model or business flows change meaningfully, regenerate
the fixtures against a local Postgres:

```bash
DATABASE_URL=postgresql://mercury:mercury@localhost:5432/mercury \
  pnpm build:demo-fixtures
```

This truncates and reseeds that database — never point it at anything real.

## Building the demo bundle locally

```bash
DEMO_BASE_PATH=/mercury-fleet-chat/ pnpm build:demo
```

Output lands in `apps/web/dist`, including a `404.html` copy of `index.html`
(GitHub Pages' documented SPA-routing workaround, since Pages can't rewrite
unknown paths like `/operator` back to the app the way the real server does)
and a `.nojekyll` marker.

In CI, `.github/workflows/deploy-pages.yml` builds and publishes this
automatically on every push to `main`.
