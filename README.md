# orbed 0.0.1

Acceptance tests carried out by Amp agents in an orb. Describe an action, await
its completion, then check the running app through its portals, databases and
services. Orbed captures evidence and returns a test result.

**Local MVP, not published.** Remote CI is experimental; fresh-orb end-to-end
execution has not been verified.

## The core API

```ts
import { test } from 'orbed'

export default [
  test('checkout', async ({ portal, db, services }) => {
    const orders = db.get('orders')
    const mail = services.get('mail')

    await portal.action('Order two notebooks.')
    await portal.expect('The confirmation shows two notebooks at the advertised price.')
    await orders.expect('That order is saved with the same ID, quantity and total.')
    await mail.expect('One receipt for that order was accepted by the local mail service.', {
      timeoutMs: 30_000,
    })
  }),
]
```

This is executable authoring syntax, with illustrative application behavior.
Every handle exposes `action(instruction, options?)` and `expect(claim, options?)`,
both returning `Promise<void>`:

- `portal` / `portals.get(name)` selects an existing Amp portal.
- `db.get(name)` selects a database binding to an existing local resource.
- `services.get(name)` selects an existing Amp service, including non-browser services.
- The callback's `expect(claim)` checks an application-wide outcome.

You write outcomes, not selectors, SQL bindings or browser scripts. One Amp agent
retains context and IDs across the entire test.

## Await means execution, not declaration

`test(...)` registers a callback without running it. During a suite, Orbed invokes
that callback once. Each call sends **only its current step** to the agent and
waits for fresh evidence, a supported assessment and the end of the agent's turn.
Only then does JavaScript continue past `await`.

```ts
test('prepare and process an order', async ({ db, services, expect }) => {
  const orders = db.get('orders')
  const worker = services.get('worker')

  await orders.action('Insert one pending order for the disposable test customer; retain its ID.')
  await worker.action('Process that pending order using the existing local job endpoint.')
  await orders.expect('That order is marked processed.')
  await expect('The worker result and stored order agree on the order ID and total.')
})
```

Actions may change disposable runtime data as explicitly requested. Expectations
inspect it; they must not repair the app to make a claim pass. Actions also need
evidence of completion—starting a background job is not the same as finishing it.

Normal JavaScript awaits, loops and branches can run between calls. Handles
return no model-generated data; use IDs retained in the agent's context or values
your own callback obtains. Callback code runs in the plugin host; resolve file
paths relative to `import.meta.url` rather than assuming a repository working
directory. Instrumented agent commands do run from the repository root.
All Orbed operations must be awaited sequentially.
Overlapping calls (`Promise.all`), outstanding operations, and discarded operation
promises fail the test—even if a discarded operation already finished. Handles
return Promise-compatible thenables that track consumption through `await`, return,
or promise methods; this does not detect discarded chains after `.then()`/`.catch()`.
A failed action or expectation rejects, blocks later Orbed operations,
and remains a failure even if the callback catches its exception.

`timeoutMs` on a call bounds that step; the test's deadline bounds the entire
callback, including time spent outside Orbed calls. A timeout rejects the outstanding
Orbed await, stops new tool work and triggers cancellation/cleanup. Other JavaScript promises and already-running
commands cannot be forcibly undone: arbitrary callback code must be cooperative,
and a synchronous infinite loop can block the host. Do not use these deadlines as
a transaction rollback or a hard spend limit.

## Reuse Amp's setup

**Amp owns the environment; Orbed binds to it.** Keep dependency installation,
service startup, fixtures, disposable databases and test accounts in the existing
orb setup. Orbed uses Amp's service readiness output, not a second service manifest.

```ts
// .amp/plugins/orbed.ts
import { orbed } from 'orbed/plugin'
import tests from '../../tests/checkout.orbed.ts'

export default orbed(tests, {
  allowShell: true,
  databases: {
    orders: {
      service: 'postgres',
      instructions: 'Use the existing local test database via psql. Orders are in public.orders. Use the test connection already configured by orb setup; never print credentials.',
    },
  },
  services: {
    mail: {
      instructions: 'The existing local mail sink exposes its request journal at /requests. Match receipts by order ID.',
    },
    worker: {
      instructions: 'The local worker exposes POST /jobs to process an order ID and GET /jobs/:id for completion and result data.',
    },
  },
  instructions: 'Use only disposable local services and test accounts. Never access shared or production resources.',
})
```

These names, schema details and endpoints are examples; use the ones your project
already provides. Service handles resolve directly from Amp service names. Their
`services` entries add optional inspection guidance, not startup configuration.
Database bindings require an existing Amp `service` and `instructions`, because
Amp's service discovery does not identify database names or schemas. For SQLite
or a document store, bind to the owning app service and describe the local file
and available client. No connections or credentials are guessed.

`portal` shorthand requires exactly one configured portal. With several, select
`portals.get('shop')`. Only service-configured portals are discovered, not ad-hoc
portals. Every handle lookup checks its binding and service readiness; missing,
ambiguous or unavailable resources fail clearly and are never substituted.

**Dynamic callbacks cannot be preflighted as a whole without executing them.**
Lookups validate when JavaScript reaches them, including those in later branches.
Select known handles at the top of a callback to fail before any actions. The
test agent is created lazily for the first operation. Readiness is the snapshot
obtained at suite start; runtime failures still require fresh evidence.

Database and service operations require `allowShell: true`. The agent uses local
commands to inspect or operate the bound resource. Evidence records the host-owned
resource identity and step number. **Shell access is unrestricted, not an enforced
read-only sandbox.** Resource guidance and action/expectation rules are instructions,
not filesystem/network isolation. Attribution does not prove a command accessed
only that resource. Use trusted repositories and disposable orbs without production
credentials; avoid secrets in command output.

## Multiple portals and a database

```ts
test('an administrator can cancel an order', async ({ portals, db }) => {
  const shop = portals.get('shop')
  const admin = portals.get('admin')
  const orders = db.get('orders')

  await shop.action('Place an order for two notebooks.')
  await shop.expect('The order is confirmed.')
  await admin.action('Find that order and cancel it.')
  await admin.expect('That order is cancelled.')
  await shop.action('Reload the order history.')
  await shop.expect('That same order is cancelled.')
  await orders.expect('A fresh read shows that order cancelled, without changing other orders.')
})
```

Each portal retains its own browser session when switching away and back; cookies
are not shared. Each test gets fresh browser sessions, **not a fresh database or
application**. Fixture creation, isolation and data cleanup remain the project's
responsibility. A DB-only or service-only test does not need a portal or browser.

## Background jobs and service-call checks

```ts
test('an export produces a file and one notification', {
  timeoutMs: 240_000,
}, async ({ portals, db, services }) => {
  const dashboard = portals.get('dashboard')
  const orders = db.get('orders')
  const worker = services.get('worker')
  const mail = services.get('mail')

  await dashboard.action('Request an export of my current orders; retain the job ID.')
  await worker.expect('That job is completed and its export file exists.', { timeoutMs: 90_000 })
  await orders.expect('The exported order IDs match this account’s saved orders, with no other account’s orders included.')
  await mail.expect('Exactly one export-ready notification was recorded for that job, with no duplicate during the ten seconds following job completion.', {
    timeoutMs: 30_000,
  })
  await dashboard.action('Refresh the exports page.')
  await dashboard.expect('That export is available to download.')
})
```

For eventual outcomes, instruct the agent to observe until completion within the
step deadline. There is no automatic retry of an action or failed assessment.
The agent chooses polling commands; each command has a twenty-second limit.

Spy-like checks use real instrumentation such as a local request journal. The
app's setup must route external calls to a disposable sink and record correlation
IDs, payloads and timestamps. Orbed does not intercept requests or fabricate a
spy. “No duplicate” requires a bounded observation window and a complete journal;
an absent log line alone is not proof. No real mail or payments should be sent.

## Run with Amp

Use an Amp orb with Node 22+, Amp's plugin API and `agent-browser`/Chromium for
portal tests. Reload the plugin after changes, then ask Amp:

> Run the Orbed suite using orbed_run and show the recorded results.

The runner invokes callbacks, sends one step per agent turn, records results,
closes test browsers and archives each child thread once the test ends. It does
not archive between awaited calls. The interactive thread and app services remain
open. No human portal viewer or `agent: control` configuration is needed.

Test options: `test(name, { viewport: [390, 720], timeoutMs: 240_000 }, callback)`.
Defaults are 1280 × 720, 2× screenshots and a 120-second test deadline. Test and
step deadlines have a ten-minute maximum. Cleanup adds bounded time: cancellation
ten seconds, each browser-close/archive command twenty seconds. Service setup has
a ninety-second limit; child creation has a twenty-second limit. Process crashes
can still leave orphaned work; crash recovery is not implemented.

## Evidence and results

Each action or expectation receives `supported`, `contradicted` or
`insufficient-evidence`, with a reason and evidence IDs. Portal steps require
fresh screenshots/page snapshots from their portal; database and service steps
require fresh command observations attributed to their resource. Evidence from a
previous step or another resource alone cannot satisfy them. Application-wide
expectations can use browser or command evidence.

Only a complete, all-passed suite opens the gate. Contradiction fails the test;
uncertainty, missing evidence, timeout, callback errors and cleanup failures make
it incomplete. Both block the gate. A false claim stops the callback rather than
continuing to its later steps. Invalid citations can be corrected within the same
step; recovering a browser-target mistake requires retry and a fresh observation.

**Assessments remain model judgments, not deterministic proof.** Orbed validates
step boundaries and evidence references, not semantic correctness. Review the
captured observations and calibrate against known failures before relying on it.

Ignore `.orbed/` in Git. Each `.orbed/<run-id>/` contains a report and per-test
evidence with executed steps, resource attribution, thread IDs, screenshots,
commands, assessments and archival status. Callback functions are not serialized.
The report records Git HEAD and a source hash; source changes during the suite
invalidate it. Ignored builds/dependencies, environment and runtime data are not
covered. Reports are local evidence, not signed attestations.

```sh
orbed check .orbed/<run-id>/report.json
```

Exit codes: **0** passed, **1** failed/incomplete, **2** invalid input/transport.
`check` reads a saved report; it does not rerun tests or certify freshness. No Git
hook or push authorization is installed. Run a fresh suite before pushing.

## Remote CI remains experimental

```sh
# Supply AMP_API_KEY through the CI secret store.
orbed run --project team/app --revision "$GITHUB_SHA" --output orbed-report.json
```

The SDK creates an orb and prompts Amp to call `orbed_run`, consuming the correlated
tool result rather than assistant prose. The project must already contain this
library, plugin, tests and working setup at the requested clean commit.
`--revision` validates; it does not select a branch or upload local work.
Fresh-orb end-to-end execution is unverified; do not use it as a required release
gate yet. The remote wait defaults to fifteen minutes (`--timeout-ms`, maximum
one hour). Abort is not a verified server-side cancellation or spend cap.
Automatic artifact download and guaranteed remote-abort archival are not included.

## Develop and migrate

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
npm pack
# In another project:
npm install /path/to/orbed-0.0.1.tgz
```

Publication is disabled with `private: true`. This is a Vitest-like API, not a
Vitest plugin. There are no describe blocks, lifecycle hooks, watch mode, automatic
test discovery or automatic retries. Live agent runs consume Amp credits.

**Migration from the earlier 0.0.1 spike:** add `async` to test callbacks and
`await` to every action/expectation. Replace whole-app DB/service prose with named
handles when resource-specific command evidence is required. Add database bindings
and service guidance to the plugin, referring to existing orb setup. Callbacks now
run during execution, not import; they cannot be inspected as a static plan.

The included shop uses a JSON document store, not SQL. `tests/resources.orbed.ts`
exercises real service requests and database actions, with independent reads
inside the callback immediately after `await`. `tests/portals.orbed.ts` covers
multi-portal state. `examples/shop.orbed.ts` covers desktop/narrow checkout and
cancellation isolation. `tests/controls.orbed.ts` contains deliberately failing
claims and deadlines. SQL, worker and mail examples above require your own
application and setup; those integrations are not bundled fixtures.
