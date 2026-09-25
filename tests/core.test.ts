import { test as check } from 'bun:test'
import assert from 'node:assert/strict'
import { test } from '../dist/index.js'
import { executeTest } from '../dist/runtime.js'
import { orbed } from '../dist/plugin.js'
import { evaluate, evidenceError, persistTerminalReport } from '../dist/report.js'
import { portalPathURL, resolveResource } from '../dist/portals.js'
import type { PluginAPI, PluginToolDefinition } from '@ampcode/plugin'
import type { PortalTest, Resource, TestContext } from '../dist/index.js'
import type { Event, Report } from '../dist/report.js'
import type { Step } from '../dist/runtime.js'
import type { Resources, Service, Target } from '../dist/portals.js'

const portal: Target = { kind: 'portal', name: 'shop' }
const db: Target = { kind: 'db', name: 'orders' }
const service: Target = { kind: 'service', name: 'mail' }
const urls = { shop: 'https://shop.onamp.dev/', admin: 'https://admin.onamp.dev/' }
const step: Step = { kind: 'expect', instruction: 'Two items', target: portal }
const events = (): Event[] => [
  { action: 'open', at: '', portal: 'shop', url: urls.shop, snapshot: '0 items', screenshot: 'before.png' },
  { action: 'click', at: '', portal: 'shop', selector: '#increment' },
  { action: 'snapshot', at: '', portal: 'shop', url: urls.shop, snapshot: '2 items', screenshot: 'after.png' },
  { action: 'check', at: '', assessment: { claim: 'Two items', verdict: 'supported', reason: 'Count is 2', evidence: [2] } },
  { action: 'finish', at: '' },
]
const command = (resource: Target): Event => ({ action: 'command', at: '', resource, command: 'inspect', stdout: 'two', stderr: '', exitCode: 0 })
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}
const assessment = (event: Event) => {
  assert.ok(event.assessment)
  return event.assessment
}

check('test registration is lazy and options are immutable', () => {
  let calls = 0
  const declaration = test('lazy', async () => { calls++ })
  assert.equal(calls, 0)
  assert.equal(declaration.timeoutMs, 120_000)
  assert.deepEqual(declaration.viewport, [1280, 720])
  assert.throws(() => (declaration.viewport as [number, number])[0] = 1, TypeError)
  assert.throws(() => test('bad', () => {}, { viewport: [0, 720] }), /Viewport/)
  assert.throws(() => orbed([]), /nonempty/)
  assert.throws(() => orbed([declaration, declaration]), /unique/)
})

check('Bun-shaped declarations normalize numeric and object options without running callbacks', () => {
  const run = () => { throw new Error('Registration must not execute the callback') }
  const viewport: [number, number] = [390, 844]
  const declaration = test('mobile', run, { timeout: 180_000, viewport })
  viewport[0] = 1024
  assert.equal(declaration.run, run)
  assert.equal(declaration.timeoutMs, 180_000)
  assert.deepEqual(declaration.viewport, [390, 844])
  for (const timeout of [1, 600_000]) {
    assert.equal(test('numeric', run, timeout).timeoutMs, timeout)
    assert.equal(test('options', run, { timeout }).timeoutMs, timeout)
  }
  for (const timeout of [0, -1, 600_001, 1.5, NaN]) {
    assert.throws(() => test('numeric', run, timeout), /timeout/)
    assert.throws(() => test('options', run, { timeout }), /timeout/)
  }
  assert.throws(() => {
    // @ts-expect-error The unpublished options-first signature is no longer supported.
    test('old signature', { timeoutMs: 1000 }, run)
  }, /callback/)
})

check('await blocks JavaScript continuation and runs dynamic branches exactly once', async () => {
  const gate = deferred()
  const trace: string[] = []
  let calls = 0
  const definition = test('live', async ({ portals, db, services }) => {
    calls++
    const shop = portals.get('shop')
    await shop.action('Place order')
    trace.push('callback resumed')
    if (trace.includes('action completed')) await db.get('orders').expect('Saved')
    await services.get('mail').expect('Receipt delivered', { timeoutMs: 1000 })
  })
  const run = executeTest(definition, t => t, async s => {
    assert.ok(s.target)
    trace.push(`${s.target.kind}:${s.instruction}`)
    if (s.kind === 'action') { await gate.promise; trace.push('action completed') }
  })
  await new Promise(setImmediate)
  assert.deepEqual(trace, ['portal:Place order'])
  gate.resolve()
  await run
  assert.equal(calls, 1)
  assert.deepEqual(trace, ['portal:Place order', 'action completed', 'callback resumed', 'db:Saved', 'service:Receipt delivered'])
})

check('failure stays failed even if callback catches it; later steps do not run', async () => {
  const failure = new Error('Contradicted')
  let executed = 0
  await assert.rejects(executeTest(test('caught', async ({ portal }) => {
    try { await portal.expect('Wrong') } catch {}
    try { await portal.action('Do not execute') } catch {}
  }), t => t, async () => { executed++; throw failure }), e => e === failure)
  assert.equal(executed, 1)
})

check('missing awaits, concurrent steps and empty callbacks cannot pass', async () => {
  const callbacks: PortalTest['run'][] = [
    ({ portal }: TestContext) => { portal.expect('unawaited') },
    async ({ portal }: TestContext) => { await Promise.all([portal.action('one'), portal.expect('two')]) },
  ]
  for (const callback of callbacks) {
    const gate = deferred()
    await assert.rejects(executeTest(test('bad', callback), t => t, () => gate.promise), /unawaited|Await each/)
    gate.resolve()
  }
  await assert.rejects(executeTest(test('empty', async () => {}), t => t, async () => {}), /requires expectations/)
})

check('step and whole-test deadlines stop late continuations and captured handles', async () => {
  for (const options of [{ timeoutMs: 5 }, undefined]) {
    const gate = deferred()
    let handle!: Resource
    let operations = 0
    const definition = test('deadline', async ({ portal }) => {
      handle = portal
      await portal.action('slow', options)
      await portal.expect('Must not execute')
    }, { timeout: options ? 1000 : 5 })
    await assert.rejects(executeTest(definition, t => t, async () => { operations++; await gate.promise }), /timed out/)
    assert.throws(() => handle.expect('late'), /stopped/)
    gate.resolve()
    await new Promise(setImmediate)
    assert.equal(operations, 1)
  }
})

check('settled floating operations fail while returned promises remain valid', async () => {
  await assert.rejects(executeTest(test('floating', async ({ portal }) => {
    portal.expect('unawaited')
    await new Promise(setImmediate)
  }), t => t, async () => {}), /unawaited/)
  await executeTest(test('returned', ({ portal }) => portal.expect('returned')), t => t, async () => {})
})

check('test timeout and cancellation reject the callback step before late completion', async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController()
    const gate = deferred()
    let operation!: Promise<void>
    let continued = false
    const running = executeTest(test('terminal', async ({ portal }) => {
      operation = portal.expect('waiting', cancel ? { timeoutMs: 600_000 } : undefined)
      await operation
      continued = true
    }, cancel ? 1000 : 10), t => t, () => gate.promise, controller.signal)
    await new Promise(setImmediate)
    if (cancel) controller.abort(new Error('Parent cancelled'))
    await assert.rejects(running, /timed out|Parent cancelled/)
    // Race against an independent turn: this must reject without releasing the executor.
    let settled = 'pending'
    operation.then(() => { settled = 'resolved' }, () => { settled = 'rejected' })
    await new Promise(setImmediate)
    assert.equal(settled, 'rejected')
    gate.resolve()
    await new Promise(setImmediate)
    assert.equal(continued, false)
  }
})

check('abort and caught step timeouts release the runner even if callback keeps waiting', async () => {
  const controller = new AbortController()
  let handle!: Resource
  const running = executeTest(test('abort', async ({ portal }) => {
    handle = portal
    await portal.expect('waiting')
  }), t => t, () => new Promise(() => {}), controller.signal)
  await new Promise(setImmediate)
  controller.abort(new Error('Parent cancelled'))
  await assert.rejects(running, /Parent cancelled/)
  assert.throws(() => handle.action('late'), /stopped/)
  await assert.rejects(executeTest(test('caught timeout', async ({ portal }) => {
    try { await portal.expect('waiting', { timeoutMs: 5 }) } catch { await new Promise(() => {}) }
  }, { timeout: 1000 }), t => t, () => new Promise(() => {})), /Step timed out after 5ms/)
})

check('bindings use existing Amp services and fail on absent, ambiguous or unavailable resources', () => {
  const configured: Service[] = [
    { name: 'shop', publicURL: urls.shop, listening: true },
    { name: 'postgres', port: 5432, listening: true },
    { name: 'mail', port: 8025, listening: true },
  ]
  const resources: Resources = { databases: { orders: { service: 'postgres', instructions: 'Use the local orders database' } } }
  const resolve = (target: Target, services: Service[] = configured, allow = true) => resolveResource(target, services, resources, allow)
  assert.deepEqual(resolve({ kind: 'portal', name: '' }).target, portal)
  assert.match(resolve(db).instructions, /postgres.*5432.*local orders/)
  assert.deepEqual(resolve(service).target, service)
  assert.throws(() => resolve({ ...db, name: 'absent' }), /not bound/)
  assert.throws(() => resolve({ ...portal, name: 'absent' }), /not configured/)
  assert.throws(() => resolve(portal, [{ name: 'shop', listening: true }]), /not configured/)
  assert.throws(() => resolve(db, configured.map(s => ({ ...s, listening: false }))), /unavailable/)
  assert.throws(() => resolve(service, configured.map(s => ({ ...s, health: { ok: false } }))), /unavailable/)
  assert.throws(() => resolve(db, configured, false), /allowShell/)
  assert.throws(() => resolve({ kind: 'portal', name: '' }, [...configured, { name: 'admin', publicURL: urls.admin, listening: true }]), /ambiguous/)
})

check('portal paths resolve within their declared portal only', () => {
  assert.equal(portalPathURL(urls.shop, '/event/example?quantity=2'), 'https://shop.onamp.dev/event/example?quantity=2')
  assert.throws(() => portalPathURL(urls.shop, 'event/example'), /absolute application path/)
  assert.throws(() => portalPathURL(urls.shop, '//example.com/event/example'), /cannot leave/)
  assert.equal(evidenceError([0], [{ action: 'navigate', at: '', portal: 'shop', url: 'https://shop.onamp.dev/event/example',
    snapshot: 'Example event', screenshot: 'event.png' }], urls, portal), undefined)
})

check('missing resources fail at selection without starting an operation', async () => {
  let operations = 0
  await assert.rejects(executeTest(test('missing', async ({ db }) => {
    await db.get('absent').expect('ready')
  }), target => resolveResource(target, [], {}, true).target, async () => { operations++ }), /not bound/)
  assert.equal(operations, 0)
})

check('portal, database and service assessments require fresh evidence of their own resource', () => {
  const evidence = events().slice(0, 3)
  evidence.push(command(db), command(service))
  assert.equal(evidenceError([1, 2], evidence, urls, portal), undefined)
  assert.equal(evidenceError([3], evidence, urls, db), undefined)
  assert.equal(evidenceError([4], evidence, urls, service), undefined)
  const invalidCases: Array<[number[], Target, number]> = [
    [[1], portal, -1], [[2], db, -1], [[3], service, -1], [[4], db, -1],
    [[3], { ...db, name: 'another' }, -1], [[3, 4], db, 3], [[2, 99], portal, -1],
  ]
  for (const [ids, target, after] of invalidCases) assert.equal(typeof evidenceError(ids, evidence, urls, target, after), 'string')
  evidence[2].portal = 'admin'
  assert.match(evidenceError([2], evidence, urls, portal)!, /not captured/)
})

check('action completion and expectation gates reject missing, duplicate and fabricated assessments', () => {
  assert.equal(evaluate(step, events(), urls).status, 'passed')
  assert.equal(evaluate({ ...step, kind: 'action' }, events(), urls).status, 'passed')
  const invalidEvidence = [[], [99], [-1], [1], [3], ['2'] as unknown as number[]]
  const variants: Array<(events: Event[]) => unknown> = [e => e.pop(), e => e.splice(3, 1), e => e.splice(3, 0, structuredClone(e[3])),
    e => { delete e[2].screenshot }, e => { e[2].url = urls.admin },
    e => { e[1].error = 'timeout' }, e => { assessment(e[3]).claim = 'substituted' },
    e => { assessment(e[3]).reason = '' }, e => { assessment(e[3]).verdict = 'passed' as unknown as 'supported' },
    ...invalidEvidence.map(ids => (e: Event[]) => { assessment(e[3]).evidence = ids }),
  ]
  for (const change of variants) { const e = events(); change(e); assert.equal(evaluate(step, e, urls).status, 'incomplete') }
  const wrong = events()
  assessment(wrong[3]).verdict = 'contradicted'
  assert.equal(evaluate(step, wrong, urls).status, 'failed')
  assessment(wrong[3]).verdict = 'insufficient-evidence'
  assert.equal(evaluate(step, wrong, urls).status, 'incomplete')
})

check('portal evidence must follow the last interaction and assessment must be terminal', () => {
  for (const action of ['click', 'fill', 'press']) {
    const evidence = events()
    evidence[1].action = action
    assessment(evidence[3]).evidence = [0]
    assert.equal(evaluate({ ...step, kind: 'action' }, evidence, urls).status, 'incomplete')
    assessment(evidence[3]).evidence = [2]
    assert.equal(evaluate({ ...step, kind: 'action' }, evidence, urls).status, 'passed')
    evidence.splice(4, 0, { action, at: '', portal: 'shop' })
    assert.equal(evaluate(step, evidence, urls).status, 'incomplete')
  }
})

check('step boundaries prevent reuse of earlier evidence without a fresh observation', () => {
  const previous = events()
  const current = events()
  assessment(current[3]).evidence = [2]
  assert.equal(evaluate(step, [...previous, ...current], urls, 5).status, 'incomplete')
  assessment(current[3]).evidence = [7]
  assert.equal(evaluate(step, [...previous, ...current], urls, 5).status, 'passed')
})

check('command-only steps work without opening any browser; failed commands remain observations', () => {
  const evidence: Event[] = [command(db), { action: 'check', at: '', assessment: { claim: 'Two items', verdict: 'contradicted', reason: 'Missing', evidence: [0] } }, { action: 'finish', at: '' }]
  evidence[0].exitCode = 1
  assert.equal(evaluate({ ...step, target: db }, evidence, {}).status, 'failed')
  delete evidence[0].exitCode
  assert.equal(evaluate({ ...step, target: db }, evidence, {}).status, 'incomplete')
})

check('recoverable targets and rejected citations still require correction', () => {
  const e = events()
  e.splice(2, 0, { action: 'click', at: '', portal: 'shop', error: 'Element not found', recoverable: true }, { action: 'click', at: '', portal: 'shop' })
  assessment(e[5]).evidence = [4]
  assert.equal(evaluate(step, e, urls).status, 'passed')
  e[3].portal = 'admin'
  assert.equal(evaluate(step, e, urls).status, 'incomplete')
  const rejected = events()
  rejected.splice(3, 0, { action: 'check', at: '', recoverable: true, error: 'Invalid evidence' })
  assert.equal(evaluate(step, rejected, urls).status, 'passed')
  rejected.splice(4, 1)
  assert.equal(evaluate(step, rejected, urls).status, 'incomplete')
})

check('shell is opt-in and incomplete suites cannot pass', () => {
  for (const allowShell of [false, true]) {
    const tools: string[] = []
    let browserTool!: { inputSchema: { properties: { action: { enum: string[] }, path: { type: string } } } }
    const mock = {
      system: { workspaceRoot: 'file:///tmp/orbed' }, helpers: { filePathFromURI: () => '/tmp/orbed' },
      createAgent: () => ({}), on() {}, registerTool: (tool: PluginToolDefinition) => {
        tools.push(tool.name)
        if (tool.name === 'orbed_browser') browserTool = tool as unknown as typeof browserTool
      },
    } as unknown as PluginAPI
    orbed([test('example', async () => {})], { allowShell })(mock)
    assert.equal(tools.includes('orbed_command'), allowShell)
    assert.ok(browserTool.inputSchema.properties.action.enum.includes('navigate'))
    assert.equal(browserTool.inputSchema.properties.path.type, 'string')
  }
})

check('cancellation during terminal persistence cannot leave a passing report', async () => {
  const controller = new AbortController()
  const terminal: Report = { schemaVersion: 1, runID: 'test', complete: true, passed: true, results: [{ name: 'test', status: 'passed' }] }
  let writes = 0
  await persistTerminalReport(terminal, controller.signal, async () => {
    writes++
    if (writes === 1) controller.abort(new Error('cancelled during write'))
  })
  assert.equal(writes, 2)
  assert.equal(terminal.complete, false)
  assert.equal(terminal.passed, false)
  assert.match(terminal.error!, /cancelled during write/)
})
