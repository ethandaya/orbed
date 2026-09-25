# orbed

orbed turns plain-English end-to-end checks into tests you can rerun in [Amp orbs](https://ampcode.com/docs/orbs). Agents exercise the UI, services, and data, and every passing step must cite fresh evidence captured by orbed.

It replaces one-off “test this in the orb” prompts and can take over some expensive E2E tests. It is not a drop-in replacement for every Playwright or Cypress test: a pass means the agent found evidence for the behavior in that run. Inspired by [Thorsten Ball](https://x.com/thorstenball/status/2102623376196194763): “test this e2e & give me irrefutable proof it works.” **Early alpha:** APIs will change, and runs use Amp credits.

## Install

Give Amp this prompt from your project:

```text
Set up orbed in this project. Run `npm install -D orbed`, create `.amp/plugins/orbed.ts` containing `export { default } from 'orbed/plugin'`, and add a minimal `*.orbed.ts` test for this app's primary flow. Configure any needed Amp portal and disposable test-state reset.
```

## Write a test

```ts
// tests/counter.orbed.ts
import { test } from 'orbed'

test('increment', async ({ portal }) => {
  await portal.action('Click Increment once.')
  await portal.expect('The count increased by one.')
})
```

Then ask Amp: **“Run the orbed suite.”**

Any `*.orbed.ts` file is picked up automatically. The `portal` shorthand works when the orb has exactly one portal; use `portals.get(name)` otherwise.

## How it works

```text
orbed_run
  ├─ load orbed.config.ts and every *.orbed.ts (fresh each run)
  ├─ per test: beforeEach, private agent, fresh browsers
  │    └─ per awaited step: one agent turn
  │         ├─ portal step  → browser: open, navigate, snapshot, click, fill, press
  │         ├─ db / service → shell commands against that resource
  │         └─ close step   → cite host-captured evidence, or it's incomplete
  └─ write reports and per-test evidence under .orbed/<run-id>/
```

- **Evidence gate.** A step passes only when the agent cites fresh snapshots or command output that the host captured for that step's portal or resource.
- **Portal steps stay in the browser.** The host rejects shell commands on portal steps.
- **No reloads.** Test and config edits apply on the next run. Run `plugins: reload` once if you added the plugin mid-session.

## Run result

`orbed_run` returns JSON with `runID`, `complete`, `passed`, `reportPath`, and the recorded test and step results. Amp summarizes the outcome and links to `reportPath`, the human-readable report.

Each run writes:

- `.orbed/<run-id>/report.md`: test and step statuses, setup output, action and expectation verdicts, reasons, screenshot links, and cited command output.
- `.orbed/<run-id>/report.json`: the machine-readable report for that run.
- `.orbed/<run-id>/<test-number>/evidence.json` and screenshots: raw captured evidence, including page snapshots.
- `.orbed/latest.json`: a copy of the latest run's JSON report, initialized with `complete: false` and `passed: false` and updated as the run progresses.

Tests are `passed`, `failed` when captured evidence contradicts a step, or `incomplete` when orbed cannot establish an outcome. `complete: true` means the suite finished; `passed: true` requires every test to pass.

### CI and pre-push

A completed tool call does not mean the suite passed. Gate the saved report:

```sh
rm -f .orbed/latest.json &&
  amp -x "Run the orbed suite. Do not modify source." --plugin-ready-timeout &&
  jq -e '.complete and .passed' .orbed/latest.json >/dev/null
```

Removing `latest.json` prevents a stale pass. Use separate workspaces for concurrent runs. Prefer pre-push or CI over pre-commit because runs take time and consume Amp credits.

## Examples

### UI, database, and API in one test

```ts
// tests/checkout.orbed.ts
import { test } from 'orbed'

test('checkout persists', async ({ portals, db, services }) => {
  const shop = portals.get('shop')
  const orders = db.get('orders')
  const api = services.get('shop')

  await shop.action('Order three notebooks; retain the order and customer IDs.')
  await shop.expect('The confirmation shows three notebooks for $37.50.')
  await orders.expect('That order is stored with quantity three and total 3750 cents.')
  await api.expect('GET /orders with that customer’s x-customer header returns that order.')
}, 180_000)
```

Tell the agent how to inspect each resource in `orbed.config.ts` at the repository root:

```ts
// orbed.config.ts
import { defineConfig } from 'orbed'

export default defineConfig({
  instructions: 'Disposable local checkout. No payments or external services.',
  beforeEach: 'bun run test:reset',
  databases: {
    orders: {
      service: 'shop',
      instructions: 'Read .orbed/shop/orders/<order-id>.json. Fields: id, customer, quantity, totalCents, status.',
    },
  },
  services: {
    shop: { instructions: 'GET /orders accepts an x-customer header and returns that customer’s orders.' },
  },
})
```

`beforeEach` runs a host-side Bash command from the workspace root before each test. Use it to reset disposable server and database state; fresh browser sessions do not. A failure or 20-second timeout marks the test `incomplete` and skips its callback and agent.

### Two portals, two screen sizes

An admin cancels an order and the customer sees it, on mobile and desktop. Each portal keeps its own browser session for the whole test.

```ts
// tests/cancellation.orbed.ts
import { test } from 'orbed'

for (const width of [390, 1280]) {
  test(`cancellation reaches the customer at ${width}px`, async ({ portals, expect }) => {
    const shop = portals.get('shop')
    const admin = portals.get('admin')

    await shop.action('Order two notebooks; retain the order ID.')
    await admin.action('Find that order and cancel it.')
    await shop.action('Open order history without signing out.')
    await shop.expect('That order is shown as cancelled and no longer counts toward the total spent.')
    await expect('The cancellation is visible to both the admin and the customer.')
  }, { viewport: [width, 720], timeout: 300_000 })
}
```

## Reference

- **Test options:** `test(name, callback, options?)`, where `options` is `{ viewport, timeout }` or a timeout in milliseconds.
  - Defaults are 120 seconds and 1280 × 720 at 2× scale.
  - Per step, use `await handle.expect('…', { timeoutMs: 30_000 })`.
  - Test and step limits max out at ten minutes.
- **Handles:** `portal`, `portals.get(name)`, `db.get(name)`, and `services.get(name)` all have `action()` and `expect()`. The context's top-level `expect(claim)` checks an app-wide outcome.
- **Config:** `orbed.config.ts` is optional.
  - `instructions` applies to every step.
  - `beforeEach` runs your disposable-state reset command before each test.
  - `databases` and `services` tell the agent how to inspect each resource.
  - Tests run against the orb's existing Amp services and portals.

## Develop

```sh
bun run test
bun run typecheck
```

Run `npm run changeset` for user-facing changes. Merges to `main` update the release PR; merging that PR publishes to npm.

[MIT](LICENSE)
