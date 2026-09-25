# orbed

Write acceptance tests in plain language. Amp agents execute each awaited step
and return results backed by screenshots, page snapshots, and command output.

**Unpublished 0.0.1 · [MIT](LICENSE).** Bun-like authoring, Amp-owned execution:
Orbed suites run through `orbed_run`, not `bun test`. No extra test registry,
discovery system, hooks, or matcher library.

Requires an [Amp orb](https://ampcode.com/docs/orbs), Node 22+, configured Amp
services, and `agent-browser`/Chromium for browser tests. Use disposable data
without production credentials. Agent runs consume Amp credits.

## Start with one portal

Until publication, build this checkout with `npm ci --ignore-scripts && npm run build`,
then install it in your app with `npm install --save-dev /path/to/orbed`.

```ts
// tests/counter.orbed.ts
import { test } from 'orbed'

export default [test('increment', async ({ portal }) => {
  await portal.action('Click Increment once.')
  await portal.expect('The count increased by one.')
})]
```

Register your tests in the app's plugin:

```ts
// .amp/plugins/orbed.ts
import { orbed } from 'orbed/plugin'
import tests from '../../tests/counter.orbed.ts'

export default orbed(tests)
```

Configure the app's portal through Amp's normal service setup, ask Amp to reload
the plugin, then ask: **“Run the Orbed suite using orbed_run.”**
The `portal` shorthand requires exactly one configured portal.

## Add viewports and deadlines

The callback comes second; options or a timeout in milliseconds come third.
Use ordinary JavaScript to generate cases:

```ts
import { test } from 'orbed'

export default [390, 1280].map(width => test(`checkout at ${width}px`, async ({ portal }) => {
  await portal.action('Order two notebooks.')
  await portal.expect('The confirmation matches the advertised price.')
}, { viewport: [width, 720], timeout: 180_000 }))
```

`test(name, callback, 180_000)` sets only the timeout. Defaults: 120 seconds,
1280 × 720, 2× screenshots. Per-step limits use
`await portal.expect('The export is ready.', { timeoutMs: 30_000 })`.
Test and step limits have a ten-minute maximum.

## Check the UI, storage, and service together

Named handles select existing Amp resources. This example uses the repository's
disposable `shop` service and JSON order store; adapt bindings to your app.

```ts
// tests/checkout.orbed.ts
import { test } from 'orbed'

export default [test('checkout persists', async ({ portals, db, services }) => {
  const shop = portals.get('shop')
  const orders = db.get('orders')
  const api = services.get('shop')

  await shop.action('Order three notebooks; retain the order and customer IDs.')
  await shop.expect('The confirmation shows three notebooks for $37.50.')
  await orders.expect('That order is stored with quantity three and total 3750 cents.')
  await api.expect('GET /orders with that customer’s x-customer header returns that order.')
}, 180_000)]
```

Enable command access and describe the existing resources:

```ts
// .amp/plugins/orbed.ts
import { orbed } from 'orbed/plugin'
import tests from '../../tests/checkout.orbed.ts'

export default orbed(tests, {
  allowShell: true,
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

All handles support `action()` and `expect()`. Database/service-only tests need
no browser. Select multiple portals with `portals.get(name)`; each preserves its
own session. The callback's `expect(claim)` checks an application-wide outcome.
Combine test files by importing their arrays and passing `[...checkout, ...other]`.

## Execution and evidence

- Await operations sequentially. Each await waits for execution and fresh evidence;
  a failed step stops later operations even if caught. Discarded `.then()` chains
  cannot be detected—await calls directly.
- Each test gets one agent and fresh browser sessions, **not fresh application or
  database state**. Your setup owns fixtures and cleanup. Expectations must not
  repair failures. IDs stay in agent context; operations return `Promise<void>`.
- Reports and evidence live in `.orbed/<run-id>/`; Git-ignore `.orbed/`.
  Contradictions are `failed`; uncertainty, timeout, callback, or cleanup errors
  are `incomplete`. Only a completed all-passed suite passes.
- Assessments are model judgments, not deterministic proof. Shell access is
  unrestricted; resource guidance and browser-origin checks are not OS isolation.
  Deadlines cannot undo side effects or guarantee termination of commands and
  descendants. Crashes can leave orphaned work.

## Develop and calibrate

Framework tests use Bun 1.3.10+ against compiled `dist`; typechecking also covers
acceptance tests and the plugin. These checks do not run paid agents:

```sh
npm ci --ignore-scripts
bun run test
bun run typecheck
```

The repository plugin runs [checkout](examples/shop.orbed.ts),
[multiple portals](tests/portals.orbed.ts), and [service/database](tests/resources.orbed.ts)
scenarios. Start Amp with `ORBED_INCLUDE_NEGATIVE_CONTROLS=1 amp` to also run
[deliberate failures](tests/controls.orbed.ts); expect a non-passing suite.
To inject incorrect checkout totals, write `total` to `.orbed/shop/fault`; restore
`none` afterward. No service restart is needed.
