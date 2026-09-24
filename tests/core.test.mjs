import { test as check } from 'node:test'
import assert from 'node:assert/strict'
import { test } from '../dist/index.js'
import { executeTest } from '../dist/runtime.js'
import { orbed } from '../dist/plugin.js'
import { evaluate, evidenceError, exitCode } from '../dist/report.js'
import { resolveResource } from '../dist/portals.js'

const portal = { kind: 'portal', name: 'shop' }
const db = { kind: 'db', name: 'orders' }
const service = { kind: 'service', name: 'mail' }
const urls = { shop: 'https://shop.onamp.dev/', admin: 'https://admin.onamp.dev/' }
const step = { kind: 'expect', instruction: 'Two items', target: portal }
const events = () => [
  { action: 'open', portal: 'shop', url: urls.shop, snapshot: '0 items', screenshot: 'before.png' },
  { action: 'click', portal: 'shop', selector: '#increment' },
  { action: 'snapshot', portal: 'shop', url: urls.shop, snapshot: '2 items', screenshot: 'after.png' },
  { action: 'check', assessment: { claim: 'Two items', verdict: 'supported', reason: 'Count is 2', evidence: [2] } },
  { action: 'finish' },
]
const command = resource => ({ action: 'command', resource, command: 'inspect', stdout: 'two', stderr: '', exitCode: 0 })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

check('test registration is lazy and options are immutable', () => {
  let calls = 0
  const declaration = test('lazy', async () => { calls++ })
  assert.equal(calls, 0)
  assert.throws(() => declaration.viewport[0] = 1, TypeError)
  assert.throws(() => test('bad', { viewport: [0, 720] }, () => {}), /Viewport/)
  assert.throws(() => test('bad', { timeoutMs: 0 }, () => {}), /timeoutMs/)
  assert.throws(() => orbed([]), /nonempty/)
  assert.throws(() => orbed([declaration, declaration]), /unique/)
})

check('await blocks JavaScript continuation and runs dynamic branches exactly once', async () => {
  const gate = deferred()
  const trace = []
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
  for (const callback of [
    ({ portal }) => { portal.expect('unawaited') },
    async ({ portal }) => { await Promise.all([portal.action('one'), portal.expect('two')]) },
  ]) {
    const gate = deferred()
    await assert.rejects(executeTest(test('bad', callback), t => t, () => gate.promise), /unawaited|Await each/)
    gate.resolve()
  }
  await assert.rejects(executeTest(test('empty', async () => {}), t => t, async () => {}), /requires expectations/)
})

check('step and whole-test deadlines stop late continuations and captured handles', async () => {
  for (const options of [{ timeoutMs: 5 }, undefined]) {
    const gate = deferred()
    let handle
    let operations = 0
    const definition = test('deadline', { timeoutMs: options ? 1000 : 5 }, async ({ portal }) => {
      handle = portal
      await portal.action('slow', options)
      await portal.expect('Must not execute')
    })
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
    let operation
    let continued = false
    const running = executeTest(test('terminal', { timeoutMs: cancel ? 1000 : 10 }, async ({ portal }) => {
      operation = portal.expect('waiting', cancel ? { timeoutMs: 600_000 } : undefined)
      await operation
      continued = true
    }), t => t, () => gate.promise, controller.signal)
    await new Promise(setImmediate)
    if (cancel) controller.abort(new Error('Parent cancelled'))
    await assert.rejects(running, /timed out|Parent cancelled/)
    // Race against an independent turn: this must reject without releasing the executor.
    assert.equal(await Promise.race([
      operation.then(() => 'resolved', () => 'rejected'),
      new Promise(resolve => setImmediate(() => resolve('pending'))),
    ]), 'rejected')
    gate.resolve()
    await new Promise(setImmediate)
    assert.equal(continued, false)
  }
})

check('abort and caught step timeouts release the runner even if callback keeps waiting', async () => {
  const controller = new AbortController()
  let handle
  const running = executeTest(test('abort', async ({ portal }) => {
    handle = portal
    await portal.expect('waiting')
  }), t => t, () => new Promise(() => {}), controller.signal)
  await new Promise(setImmediate)
  controller.abort(new Error('Parent cancelled'))
  await assert.rejects(running, /Parent cancelled/)
  assert.throws(() => handle.action('late'), /stopped/)
  await assert.rejects(executeTest(test('caught timeout', { timeoutMs: 1000 }, async ({ portal }) => {
    try { await portal.expect('waiting', { timeoutMs: 5 }) } catch { await new Promise(() => {}) }
  }), t => t, () => new Promise(() => {})), /Step timed out after 5ms/)
})

check('bindings use existing Amp services and fail on absent, ambiguous or unavailable resources', () => {
  const configured = [
    { name: 'shop', publicURL: urls.shop, listening: true },
    { name: 'postgres', port: 5432, listening: true },
    { name: 'mail', port: 8025, listening: true },
  ]
  const resources = { databases: { orders: { service: 'postgres', instructions: 'Use the local orders database' } } }
  const resolve = (target, services = configured, allow = true) => resolveResource(target, services, resources, allow)
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
  for (const [ids, target, after] of [
    [[1], portal, -1], [[2], db, -1], [[3], service, -1], [[4], db, -1],
    [[3], { ...db, name: 'another' }, -1], [[3, 4], db, 3], [[2, 99], portal, -1],
  ]) assert.equal(typeof evidenceError(ids, evidence, urls, target, after), 'string')
  evidence[2].portal = 'admin'
  assert.match(evidenceError([2], evidence, urls, portal), /not captured/)
})

check('action completion and expectation gates reject missing, duplicate and fabricated assessments', () => {
  assert.equal(evaluate(step, events(), urls).status, 'passed')
  assert.equal(evaluate({ ...step, kind: 'action' }, events(), urls).status, 'passed')
  const variants = [e => e.pop(), e => e.splice(3, 1), e => e.splice(3, 0, structuredClone(e[3])),
    e => { delete e[2].screenshot }, e => { e[2].url = urls.admin },
    e => { e[1].error = 'timeout' }, e => { e[3].assessment.claim = 'substituted' },
    e => { e[3].assessment.reason = '' }, e => { e[3].assessment.verdict = 'passed' },
    ...[[], [99], [-1], [1], [3], ['2']].map(ids => e => { e[3].assessment.evidence = ids }),
  ]
  for (const change of variants) { const e = events(); change(e); assert.equal(evaluate(step, e, urls).status, 'incomplete') }
  const wrong = events()
  wrong[3].assessment.verdict = 'contradicted'
  assert.equal(evaluate(step, wrong, urls).status, 'failed')
  wrong[3].assessment.verdict = 'insufficient-evidence'
  assert.equal(evaluate(step, wrong, urls).status, 'incomplete')
})

check('step boundaries prevent reuse of earlier evidence without a fresh observation', () => {
  const previous = events()
  const current = events()
  current[3].assessment.evidence = [2]
  assert.equal(evaluate(step, [...previous, ...current], urls, 5).status, 'incomplete')
  current[3].assessment.evidence = [7]
  assert.equal(evaluate(step, [...previous, ...current], urls, 5).status, 'passed')
})

check('command-only steps work without opening any browser; failed commands remain observations', () => {
  const evidence = [command(db), { action: 'check', assessment: { claim: 'Two items', verdict: 'contradicted', reason: 'Missing', evidence: [0] } }, { action: 'finish' }]
  evidence[0].exitCode = 1
  assert.equal(evaluate({ ...step, target: db }, evidence, {}).status, 'failed')
  delete evidence[0].exitCode
  assert.equal(evaluate({ ...step, target: db }, evidence, {}).status, 'incomplete')
})

check('recoverable targets and rejected citations still require correction', () => {
  const e = events()
  e.splice(2, 0, { action: 'click', portal: 'shop', error: 'Element not found', recoverable: true }, { action: 'click', portal: 'shop' })
  e[5].assessment.evidence = [4]
  assert.equal(evaluate(step, e, urls).status, 'passed')
  e[3].portal = 'admin'
  assert.equal(evaluate(step, e, urls).status, 'incomplete')
  const rejected = events()
  rejected.splice(3, 0, { action: 'check', recoverable: true, error: 'Invalid evidence' })
  assert.equal(evaluate(step, rejected, urls).status, 'passed')
  rejected.splice(4, 1)
  assert.equal(evaluate(step, rejected, urls).status, 'incomplete')
})

check('shell is opt-in and incomplete suites cannot pass', () => {
  for (const allowShell of [false, true]) {
    const tools = []
    orbed([test('example', async () => {})], { allowShell })({
      system: { workspaceRoot: 'file:///tmp/orbed' }, helpers: { filePathFromURI: () => '/tmp/orbed' },
      createAgent: () => ({}), on() {}, registerTool: tool => tools.push(tool.name),
    })
    assert.equal(tools.includes('orbed_command'), allowShell)
  }
  const report = { complete: true, passed: true, results: [{ status: 'passed' }] }
  assert.equal(exitCode(report), 0)
  for (const patch of [{ complete: false }, { passed: false }, { error: 'timeout' }, { results: [] }, { results: [{ status: 'failed' }] }]) {
    assert.equal(exitCode({ ...report, ...patch }), 1)
  }
})
