import { test as check } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '../dist/index.js'
import { orbed } from '../dist/plugin.js'

check('plugin executes live turns, attributes resources and cleans up only at test completion', { timeout: 10_000 }, async t => {
  const bin = await mkdtemp(join(tmpdir(), 'orbed-tools-'))
  const previousPath = process.env.PATH
  const archives = join(bin, 'archives')
  await writeFile(join(bin, 'amp'), `#!/bin/sh
if [ "$1" = orb ]; then
  printf '%s' '{"services":[{"name":"store","listening":true,"port":5432},{"name":"worker","listening":true,"port":8080}]}'
elif [ "$1" = threads ] && [ "$2" = archive ]; then
  echo "$3" >> '${archives}'
else exit 1; fi
`, { mode: 0o755 })
  process.env.PATH = `${bin}:${previousPath}`
  t.after(async () => { process.env.PATH = previousPath; await rm(bin, { recursive: true, force: true }) })
  const archiveCount = async () => (await readFile(archives, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).length
  let children = 0
  let turns = 0
  let cancelled = 0
  let resumed = false
  let lateTool
  let callbackReturned = false
  const tools = new Map()
  const hooks = new Map()
  const tests = [
    test('live', async ({ db, services }) => {
      const orders = db.get('orders')
      await orders.action('Seed one order')
      assert.equal(turns, 1)
      assert.equal(await archiveCount(), 0)
      resumed = true
      await services.get('worker').expect('The order was consumed')
      callbackReturned = true
    }),
    test('contradiction', async ({ db }) => {
      try { await db.get('orders').expect('wrong') } catch {}
      try { await db.get('orders').action('must not execute') } catch {}
    }),
    test('no finish', async ({ services }) => { await services.get('worker').expect('missing finish') }),
    test('bounded step', async ({ services }) => {
      await services.get('worker').expect('hang', { timeoutMs: 30 })
      throw new Error('must not reach')
    }),
    test('missing binding', async ({ db }) => { await db.get('absent').expect('ready') }),
  ]
  orbed(tests, { allowShell: true, databases: { orders: { service: 'store', instructions: 'Disposable test store' } } })({
    system: { workspaceRoot: `file://${process.cwd()}` }, helpers: { filePathFromURI: () => process.cwd() },
    registerTool: tool => tools.set(tool.name, tool),
    on: (name, fn) => hooks.set(name, fn),
    createAgent: () => ({ createThread: async () => {
      const id = `T-test-${++children}`
      return {
        id,
        cancel: async () => { cancelled++ },
        appendUserMessage: async ({ content }) => {
          turns++
          const current = JSON.parse(content.match(/Current step: (.+)\. Execute ONLY/)[1])
          const ctx = { thread: { id } }
          const browser = input => tools.get('orbed_browser').execute(input, ctx)
          if (current.instruction === 'hang') { lateTool = () => browser({ action: 'finish' }); return }
          if (current.instruction === 'The order was consumed') {
            assert.equal(resumed, true)
            assert.equal(callbackReturned, false)
          }
          const record = JSON.parse(await tools.get('orbed_command').execute({ command: 'printf "runtime observation"' }, ctx))
          assert.deepEqual(record.resource, current.target)
          // Fabricated evidence is rejected; the agent must correct it in the same step.
          const rejected = JSON.parse(await browser({ action: 'check', verdict: 'supported', reason: 'observed', evidence: [99999] }))
          assert.match(rejected.error, /Invalid evidence/)
          const accepted = JSON.parse(await browser({ action: 'check', verdict: current.instruction === 'wrong' ? 'contradicted' : 'supported', reason: 'observed', evidence: [record.id] }))
          assert.equal(accepted.error, undefined)
          if (current.instruction !== 'missing finish') await browser({ action: 'finish' })
          await hooks.get('agent.end')({ thread: { id }, message: content, status: 'done' })
        },
      }
    } }),
  })
  const report = JSON.parse(await tools.get('orbed_run').execute({}, { thread: { id: 'T-parent' } }))
  assert.equal(report.error, undefined)
  assert.equal(report.complete, true)
  assert.deepEqual(report.results.map(r => r.status), ['passed', 'failed', 'incomplete', 'incomplete', 'incomplete'])
  assert.match(report.results[2].reason, /did not finish/)
  assert.match(report.results[3].reason, /timed out/)
  assert.match(report.results[4].reason, /not bound/)
  assert.equal(children, 4)
  assert.equal(turns, 5)
  assert.equal(await archiveCount(), 4)
  assert.equal(report.results.slice(0, 4).every(r => r.archived), true)
  assert.equal(callbackReturned, true)
  assert.ok(cancelled >= 1)
  await assert.rejects(lateTool(), /No active step/)
  const evidence = JSON.parse(await readFile(report.results[0].evidence, 'utf8'))
  assert.deepEqual(evidence.steps.map(s => s.target.kind), ['db', 'service'])
  assert.equal(evidence.events.some(e => e.action === 'open'), false)
})

check('cancellation cannot pass during cleanup or leave a late submitted turn running', { timeout: 10_000 }, async t => {
  const bin = await mkdtemp(join(tmpdir(), 'orbed-cancel-'))
  const previousPath = process.env.PATH
  const archives = join(bin, 'archives')
  const hold = join(bin, 'hold')
  await writeFile(join(bin, 'amp'), `#!/bin/sh
if [ "$1" = orb ]; then
  printf '%s' '{"services":[{"name":"worker","listening":true,"port":8080}]}'
elif [ "$1" = threads ] && [ "$2" = archive ]; then
  touch '${bin}/archiving'
  while [ -f '${hold}' ]; do sleep 0.01; done
  echo "$3" >> '${archives}'
else exit 1; fi
`, { mode: 0o755 })
  process.env.PATH = `${bin}:${previousPath}`
  t.after(async () => { process.env.PATH = previousPath; await rm(bin, { recursive: true, force: true }) })
  const waitFor = async predicate => {
    const deadline = Date.now() + 2000
    while (!await predicate()) {
      assert.ok(Date.now() < deadline, 'condition did not settle')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }
  for (const delayedAppend of [false, true]) await t.test(delayedAppend ? 'late append' : 'final archive', async () => {
    const tools = new Map()
    const hooks = new Map()
    let releaseAppend
    const appendGate = new Promise(resolve => { releaseAppend = resolve })
    let submitted = false
    let cancelled = 0
    const before = (await readFile(archives, 'utf8').catch(() => '')).split('\n').filter(Boolean).length
    if (!delayedAppend) await writeFile(hold, '')
    orbed([test('cancel', async ({ services }) => {
      await services.get('worker').expect('ready')
    })], { allowShell: true })({
      system: { workspaceRoot: `file://${process.cwd()}` }, helpers: { filePathFromURI: () => process.cwd() },
      registerTool: tool => tools.set(tool.name, tool),
      on: (name, fn) => hooks.set(name, fn),
      createAgent: () => ({ createThread: async () => ({
        id: 'T-cancel-child',
        cancel: async () => { cancelled++ },
        appendUserMessage: async ({ content }) => {
          submitted = true
          if (delayedAppend) { await appendGate; return }
          const ctx = { thread: { id: 'T-cancel-child' } }
          const record = JSON.parse(await tools.get('orbed_command').execute({ command: 'printf ready' }, ctx))
          await tools.get('orbed_browser').execute({ action: 'check', verdict: 'supported', reason: 'ready', evidence: [record.id] }, ctx)
          await tools.get('orbed_browser').execute({ action: 'finish' }, ctx)
          await hooks.get('agent.end')({ ...ctx, message: content, status: 'done' })
        },
      }) }),
    })
    const running = tools.get('orbed_run').execute({}, { thread: { id: 'T-cancel-parent' } })
    if (delayedAppend) await waitFor(() => submitted)
    else await waitFor(() => readFile(join(bin, 'archiving')).then(() => true, () => false))
    if (delayedAppend) {
      await hooks.get('agent.end')({ thread: { id: 'T-cancel-parent' }, message: 'cancelled', status: 'cancelled' })
    } else {
      await hooks.get('tool.result')({ thread: { id: 'T-cancel-parent' }, tool: 'orbed_run', toolUseID: 'cancel', status: 'cancelled' })
    }
    await rm(hold, { force: true })
    const report = JSON.parse(await running)
    assert.equal(report.passed, false)
    assert.equal(report.complete, false)
    assert.match(report.error, /cancelled/)
    const saved = JSON.parse(await readFile(join(process.cwd(), '.orbed', report.runID, 'report.json'), 'utf8'))
    assert.equal(saved.passed, false)
    if (delayedAppend) {
      assert.equal(cancelled, 1)
      releaseAppend()
      await waitFor(async () => (await readFile(archives, 'utf8')).split('\n').filter(Boolean).length === before + 2)
      assert.equal(cancelled, 2)
      await assert.rejects(tools.get('orbed_command').execute({ command: 'printf late' }, { thread: { id: 'T-cancel-child' } }), /No idle active step/)
    }
  })
})
