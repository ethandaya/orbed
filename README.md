# orbed

Ask an agent to test your app end to end and prove it works, then rerun that
check whenever you like. You write the steps as sentences. Amp agents carry them
out in an [orb](https://ampcode.com/docs/orbs), and a step passes only on proof
that orbed captured itself: screenshots, page snapshots, or command output.

Inspired by [Thorsten Ball](https://x.com/thorstenball/status/2102623376196194763):
“test this e2e & give me irrefutable proof it works.”

**Early alpha:** APIs will change, and runs consume Amp credits.

## Install

```sh
npm i -D orbed && mkdir -p .amp/plugins && echo "export { default } from 'orbed/plugin'" > .amp/plugins/orbed.ts
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

Then ask Amp: **“Run the Orbed suite using orbed_run.”**

Any `*.orbed.ts` file is picked up automatically. The `portal` shorthand works
when the orb has exactly one portal; use `portals.get(name)` otherwise.

## How it works

```text
orbed_run
  ├─ load orbed.config.ts and every *.orbed.ts (fresh each run)
  ├─ per test: private Amp agent thread + fresh browser session
  │    └─ per awaited step: one agent turn
  │         ├─ portal step  → browser: open, navigate, snapshot, click, fill, press
  │         ├─ db / service → shell commands against that resource
  │         └─ close step   → cite host-captured evidence, or it's incomplete
  └─ write .orbed/<run-id>/: report.json, evidence.json, screenshots
```

- **Evidence gate.** A step passes only when the agent cites fresh snapshots or
  command output that the host captured for that step's portal or resource.
- **Portal steps stay in the UI.** Commands are rejected on portal steps, so a
  UI action can't be faked through the API.
- **Three outcomes.** `passed` means every step was supported, and `failed` means an
  expectation was contradicted. `incomplete` covers uncertainty, missing
  evidence, timeouts, and errors. A suite passes only if every test passes.
- **No reloads.** Test and config edits apply on the next run. Run
  `plugins: reload` once if you added the plugin mid-session.

## Scenarios

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

### Two portals, two screen sizes

An admin cancels an order and the customer sees it, on mobile and desktop. Each
portal keeps its own browser session for the whole test.

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

- **Test options:** `test(name, callback, options?)`, where `options` is
  `{ viewport, timeout }` or a timeout in milliseconds.
  - Defaults are 120 seconds and 1280 × 720 at 2× scale.
  - Per step, use `await handle.expect('…', { timeoutMs: 30_000 })`.
  - Test and step limits max out at ten minutes.
- **Handles:** `portal`, `portals.get(name)`, `db.get(name)`, and
  `services.get(name)` all have `action()` and `expect()`. The context's
  top-level `expect(claim)` checks an app-wide outcome.
- **Config:** `orbed.config.ts` is optional.
  - `instructions` applies to every step.
  - `databases` and `services` tell the agent how to inspect each resource.
  - Tests run against the orb's existing Amp services and portals.

## Develop

Framework tests run the TypeScript source directly with Bun 1.3.10+ and don't run paid agents:

```sh
npm ci --ignore-scripts
bun run test
bun run typecheck
```

This repository's own suite covers [counter](examples/counter.orbed.ts), [checkout](examples/shop.orbed.ts),
[multiple portals](tests/portals.orbed.ts), and [service/database](tests/resources.orbed.ts)
scenarios. To also run [deliberate failures](tests/controls.orbed.ts), start Amp
with `ORBED_INCLUDE_NEGATIVE_CONTROLS=1 amp` and expect a non-passing suite.
To inject wrong checkout totals, write `total` to `.orbed/shop/fault`, then
restore `none`.

[MIT](LICENSE)
