import { afterEach, test as check } from 'bun:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '../src/index.ts'
import { orbed, runSetupCommand } from '../src/plugin.ts'
import type { PluginAPI } from '@ampcode/plugin'
import type { Config, PortalTest } from '../src/index.ts'

type Context = { thread: { id: string } }
type ToolOutput = string | Array<{ type: string; text: string }>
type MockTool = { name: string; execute(input: Record<string, unknown>, context: Context): Promise<ToolOutput> }
type MockEvent = Context & { message?: string; status: string; tool?: string; toolUseID?: string }
type MockHook = (event: MockEvent) => void | Promise<void>
type Report = { error?: string; complete: boolean; passed: boolean; runID: string; reportPath: string; results: Array<{ status: string; reason: string; archived: boolean; evidence: string; setup?: { exitCode?: number } }> }
type Evidence = { steps: Array<{ target: { kind: string } }>; events: Array<{ action: string; url?: string }> }

const suite = (tests: PortalTest[], config: Config = {}) => async () => ({ tests, config })
const parse = <T>(value: string): T => JSON.parse(value) as T
const getTool = (tools: Map<string, MockTool>, name: string): MockTool => {
  const tool = tools.get(name)
  if (!tool) throw new Error(`Missing mock tool: ${name}`)
  return tool
}
const getHook = (hooks: Map<string, MockHook>, name: string): MockHook => {
  const hook = hooks.get(name)
  if (!hook) throw new Error(`Missing mock hook: ${name}`)
  return hook
}
const cleanupTasks: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanupTasks.length) await cleanupTasks.pop()!()
})

check('plugin executes live turns, attributes resources and cleans up only at test completion', async () => {
  const bin = await mkdtemp(join(tmpdir(), 'orbed-tools-'))
  const previousPath = process.env.PATH
  const archives = join(bin, 'archives')
  const setups = join(bin, 'setups')
  await writeFile(join(bin, 'amp'), `#!/bin/sh
if [ "$1" = orb ]; then
  printf '%s' '{"services":[{"name":"store","listening":true,"port":5432},{"name":"worker","listening":true,"port":8080}]}'
elif [ "$1" = threads ] && [ "$2" = archive ]; then
  echo "$3" >> '${archives}'
else exit 1; fi
`, { mode: 0o755 })
  process.env.PATH = `${bin}:${previousPath}`
  cleanupTasks.push(async () => { process.env.PATH = previousPath; await rm(bin, { recursive: true, force: true }) })
  const archiveCount = async () => (await readFile(archives, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).length
  let children = 0
  let turns = 0
  let cancelled = 0
  let resumed = false
  let lateTool: (() => Promise<ToolOutput>) | undefined
  let callbackReturned = false
  let unrelatedCancellationSent = false
  const tools = new Map<string, MockTool>()
  const hooks = new Map<string, MockHook>()
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
  orbed(suite(tests, {
    beforeEach: `echo setup >> '${setups}'`,
    databases: { orders: { service: 'store', instructions: 'Disposable test store' } },
  }))({
    system: { workspaceRoot: `file://${process.cwd()}` }, helpers: { filePathFromURI: () => process.cwd() },
    registerTool: (tool: unknown) => { const mock = tool as MockTool; tools.set(mock.name, mock) },
    on: (name: string, fn: unknown) => hooks.set(name, fn as MockHook),
    createAgent: () => ({ createThread: async () => {
      const id = `T-test-${++children}`
      return {
        id,
        cancel: async () => { cancelled++ },
        appendUserMessage: async ({ content }: { content: string }) => {
          turns++
          const match = content.match(/Current step: (.+)\. Execute ONLY/)
          if (!match) throw new Error('Missing current step')
          const current = parse<{ instruction: string; target: unknown }>(match[1])
          const ctx = { thread: { id } }
          const browser = (input: Record<string, unknown>) => getTool(tools, 'orbed_browser').execute(input, ctx)
          if (!unrelatedCancellationSent) {
            unrelatedCancellationSent = true
            await getHook(hooks, 'tool.result')({ thread: { id: 'T-parent' }, tool: 'other_orbed_run', status: 'cancelled' })
          }
          if (current.instruction === 'hang') { lateTool = () => browser({ action: 'finish' }); return }
          if (current.instruction === 'The order was consumed') {
            assert.equal(resumed, true)
            assert.equal(callbackReturned, false)
          }
          const record = parse<{ id: number; resource: unknown }>(String(await getTool(tools, 'orbed_command').execute({ command: 'printf "runtime observation"' }, ctx)))
          assert.deepEqual(record.resource, current.target)
          // Fabricated evidence is rejected; the agent must correct it in the same step.
          const rejected = parse<{ error?: string }>(String(await browser({ action: 'check', verdict: 'supported', reason: 'observed', evidence: [99999] })))
          assert.match(rejected.error ?? '', /Invalid evidence/)
          const accepted = parse<{ error?: string }>(String(await browser({ action: 'check', verdict: current.instruction === 'wrong' ? 'contradicted' : 'supported', reason: 'observed', evidence: [record.id] })))
          assert.equal(accepted.error, undefined)
          if (current.instruction !== 'missing finish') await browser({ action: 'finish' })
          await getHook(hooks, 'agent.end')({ thread: { id }, message: content, status: 'done' })
        },
      }
    } }),
  } as unknown as PluginAPI)
  assert.equal(hooks.has('tool.call'), false)
  const report = parse<Report>(String(await getTool(tools, 'orbed_run').execute({}, { thread: { id: 'T-parent' } })))
  assert.equal(report.error, undefined)
  assert.equal(report.complete, true)
  assert.deepEqual(report.results.map(r => r.status), ['passed', 'failed', 'incomplete', 'incomplete', 'incomplete'])
  assert.match(report.results[2].reason, /did not finish/)
  assert.match(report.results[3].reason, /timed out/)
  assert.match(report.results[4].reason, /not bound/)
  assert.equal(children, 4)
  assert.equal(turns, 5)
  assert.equal((await readFile(setups, 'utf8')).trim().split('\n').length, tests.length)
  assert.equal(await archiveCount(), 4)
  assert.equal(report.results.slice(0, 4).every(r => r.archived), true)
  assert.equal(callbackReturned, true)
  assert.ok(cancelled >= 1)
  assert.ok(lateTool)
  await assert.rejects(lateTool(), /No active step/)
  const evidence = parse<Evidence>(await readFile(report.results[0].evidence, 'utf8'))
  assert.deepEqual(evidence.steps.map(s => s.target.kind), ['db', 'service'])
  assert.equal(evidence.events.some(e => e.action === 'open'), false)
  assert.equal(report.results.every(result => result.setup?.exitCode === 0), true)
  const markdown = await readFile(report.reportPath, 'utf8')
  assert.match(markdown, /# orbed run: FAIL/)
  assert.match(markdown, /## PASS — live/)
  assert.match(markdown, /Verdict: \*\*supported\*\*/)
  const liveReport = markdown.match(/## PASS — live([\s\S]*?)---/)?.[1]
  assert.equal(liveReport?.match(/Verdict: \*\*supported\*\*/g)?.length, 2)
  assert.match(markdown, /Command event/)
  assert.deepEqual(parse<Report>(await readFile(join(process.cwd(), '.orbed', 'latest.json'), 'utf8')), report)
}, 10_000)

check('a failing beforeEach makes the test incomplete without starting an agent', async () => {
  const bin = await mkdtemp(join(tmpdir(), 'orbed-setup-'))
  const previousPath = process.env.PATH
  await writeFile(join(bin, 'amp'), `#!/bin/sh
if [ "$1" = orb ]; then printf '%s' '{"services":[]}'
else exit 1; fi
`, { mode: 0o755 })
  process.env.PATH = `${bin}:${previousPath}`
  cleanupTasks.push(async () => { process.env.PATH = previousPath; await rm(bin, { recursive: true, force: true }) })
  const tools = new Map<string, MockTool>()
  let children = 0
  orbed(suite([test('isolated', async ({ expect }) => { await expect('must not run') })], {
    beforeEach: 'printf setup-error >&2; exit 7',
  }))({
    system: { workspaceRoot: `file://${process.cwd()}` }, helpers: { filePathFromURI: () => process.cwd() },
    registerTool: (tool: unknown) => { const mock = tool as MockTool; tools.set(mock.name, mock) },
    on: () => {},
    createAgent: () => ({ createThread: async () => { children++; throw new Error('must not start') } }),
  } as unknown as PluginAPI)
  const report = parse<Report>(String(await getTool(tools, 'orbed_run').execute({}, { thread: { id: 'T-setup-parent' } })))
  assert.equal(report.complete, true)
  assert.equal(report.passed, false)
  assert.equal(report.results[0].status, 'incomplete')
  assert.match(report.results[0].reason, /beforeEach failed: exited with code 7/)
  assert.equal(report.results[0].setup?.exitCode, 7)
  assert.equal(children, 0)
  assert.match(await readFile(report.reportPath, 'utf8'), /setup-error/)
})

check('a setup timeout kills descendant reset processes before they can mutate state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orbed-setup-group-'))
  cleanupTasks.push(() => rm(root, { recursive: true, force: true }))
  const marker = join(root, 'late-mutation')
  const result = await runSetupCommand(`sh -c 'sleep 0.1; printf late > "$1"' sh '${marker}'`, root, new AbortController().signal, 20)
  assert.match(result.error ?? '', /timed out after 20ms/)
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(await access(marker).then(() => true, () => false), false)
})

check('commands are rejected on portal steps and allowed on resource and app-wide steps', async () => {
  const bin = await mkdtemp(join(tmpdir(), 'orbed-shell-'))
  const previousPath = process.env.PATH
  await writeFile(join(bin, 'amp'), `#!/bin/sh
if [ "$1" = orb ]; then printf '%s' '{"services":[{"name":"web","publicURL":"http://localhost:3000","listening":true,"port":3000},{"name":"worker","listening":true,"port":8080}]}'
elif [ "$1" = threads ] && [ "$2" = archive ]; then exit 0
else exit 1; fi
`, { mode: 0o755 })
  await writeFile(join(bin, 'agent-browser'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  process.env.PATH = `${bin}:${previousPath}`
  cleanupTasks.push(async () => { process.env.PATH = previousPath; await rm(bin, { recursive: true, force: true }) })
  const tools = new Map<string, MockTool>()
  const hooks = new Map<string, MockHook>()
  const outcomes = new Map<string, string>()
  let agentCalls = 0
  let children = 0
  orbed(suite([
    test('portal command', async ({ portals }) => { await portals.get('web').expect('portal claim') }),
    test('service command', async ({ services }) => { await services.get('worker').expect('service claim') }),
    test('app-wide command', async ({ expect }) => { await expect('app-wide claim') }),
  ]))({
    system: { workspaceRoot: `file://${process.cwd()}` }, helpers: { filePathFromURI: () => process.cwd() },
    registerTool: (tool: unknown) => { const mock = tool as MockTool; tools.set(mock.name, mock) },
    on: (name: string, fn: unknown) => hooks.set(name, fn as MockHook),
    createAgent: ({ tools: allowed }: { tools: string[] }) => {
      agentCalls++
      assert.deepEqual(allowed, ['orbed_browser', 'orbed_command'])
      return { createThread: async () => {
        const id = `T-shell-${++children}`
        return { id, cancel: async () => {}, appendUserMessage: async ({ content }: { content: string }) => {
          const instruction = parse<{ instruction: string }>(content.match(/Current step: (.+)\. Execute ONLY/)![1]).instruction
          try {
            outcomes.set(instruction, String(await getTool(tools, 'orbed_command').execute({ command: 'true' }, { thread: { id } })))
          } catch (error) { outcomes.set(instruction, (error as Error).message) }
          await getHook(hooks, 'agent.end')({ thread: { id }, message: content, status: 'done' })
        } }
      } }
    },
  } as unknown as PluginAPI)
  assert.ok(tools.has('orbed_command'))
  await getTool(tools, 'orbed_run').execute({}, { thread: { id: 'T-parent' } })
  assert.equal(agentCalls, 1)
  assert.match(outcomes.get('portal claim') ?? '', /Portal steps use the browser/)
  assert.doesNotThrow(() => parse<{ id: number }>(outcomes.get('service claim')!))
  assert.doesNotThrow(() => parse<{ id: number }>(outcomes.get('app-wide claim')!))
})

check('click navigation to a different port cannot reuse pre-action portal evidence', async () => {
  const bin = await mkdtemp(join(tmpdir(), 'orbed-browser-'))
  const previousPath = process.env.PATH
  const urlState = join(bin, 'url')
  await writeFile(join(bin, 'amp'), `#!/bin/sh
if [ "$1" = orb ]; then
  printf '%s' '{"services":[{"name":"web","publicURL":"http://localhost:3000","listening":true,"port":3000}]}'
elif [ "$1" = threads ] && [ "$2" = archive ]; then exit 0
else exit 1; fi
`, { mode: 0o755 })
  await writeFile(join(bin, 'agent-browser'), `#!/bin/sh
case "$5" in
  open) printf '%s' "$6" > '${urlState}' ;;
  get) cat '${urlState}' ;;
  snapshot) printf '%s' 'page snapshot' ;;
  screenshot) printf 'png' > "$6" ;;
  click) printf '%s' 'http://localhost:4000/escaped' > '${urlState}' ;;
  set|close|fill|press) ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 })
  process.env.PATH = `${bin}:${previousPath}`
  cleanupTasks.push(async () => { process.env.PATH = previousPath; await rm(bin, { recursive: true, force: true }) })

  const tools = new Map<string, MockTool>()
  const hooks = new Map<string, MockHook>()
  let rejected: { error?: string } | undefined
  orbed(suite([test('port escape', async ({ portal }) => { await portal.action('Click the link') })]))({
    system: { workspaceRoot: `file://${process.cwd()}` }, helpers: { filePathFromURI: () => process.cwd() },
    registerTool: (tool: unknown) => { const mock = tool as MockTool; tools.set(mock.name, mock) },
    on: (name: string, fn: unknown) => hooks.set(name, fn as MockHook),
    createAgent: () => ({ createThread: async () => ({
      id: 'T-port-child', cancel: async () => {},
      appendUserMessage: async ({ content }: { content: string }) => {
        const ctx = { thread: { id: 'T-port-child' } }
        const browser = (input: Record<string, unknown>) => getTool(tools, 'orbed_browser').execute(input, ctx)
        const opened = await browser({ action: 'open' })
        assert.ok(Array.isArray(opened))
        const openEvent = parse<{ id: number }>(opened[0].text)
        const clicked = parse<{ error?: string }>(String(await browser({ action: 'click', selector: '#leave' })))
        assert.match(clicked.error ?? '', /Browser left the declared portal/)
        rejected = parse<{ error?: string }>(String(await browser({ action: 'check', verdict: 'supported', reason: 'the old page showed it', evidence: [openEvent.id] })))
        assert.match(rejected.error ?? '', /fresh observation/)
        await browser({ action: 'finish' })
        await getHook(hooks, 'agent.end')({ ...ctx, message: content, status: 'done' })
      },
    }) }),
  } as unknown as PluginAPI)
  const report = parse<Report>(String(await getTool(tools, 'orbed_run').execute({}, { thread: { id: 'T-port-parent' } })))
  assert.equal(report.complete, true)
  assert.equal(report.results[0].status, 'incomplete')
  assert.match(report.results[0].reason, /operation failed without a successful retry/i)
  const evidence = parse<Evidence>(await readFile(report.results[0].evidence, 'utf8'))
  assert.equal(evidence.events[1].url, 'http://localhost:4000/escaped')
}, 10_000)

check.each([false, true])('cancellation cannot pass during cleanup or leave a late submitted turn running (late append: %s)', async delayedAppend => {
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
  cleanupTasks.push(async () => { process.env.PATH = previousPath; await rm(bin, { recursive: true, force: true }) })
  const waitFor = async (predicate: () => boolean | Promise<boolean>): Promise<void> => {
    const deadline = Date.now() + 2000
    while (!await predicate()) {
      assert.ok(Date.now() < deadline, 'condition did not settle')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }
    const tools = new Map<string, MockTool>()
    const hooks = new Map<string, MockHook>()
    let releaseAppend: () => void = () => {}
    const appendGate = new Promise<void>(resolve => { releaseAppend = resolve })
    let submitted = false
    let cancelled = 0
    const before = (await readFile(archives, 'utf8').catch(() => '')).split('\n').filter(Boolean).length
    if (!delayedAppend) await writeFile(hold, '')
    orbed(suite([test('cancel', async ({ services }) => {
      await services.get('worker').expect('ready')
    })]))({
      system: { workspaceRoot: `file://${process.cwd()}` }, helpers: { filePathFromURI: () => process.cwd() },
      registerTool: (tool: unknown) => { const mock = tool as MockTool; tools.set(mock.name, mock) },
      on: (name: string, fn: unknown) => hooks.set(name, fn as MockHook),
      createAgent: () => ({ createThread: async () => ({
        id: 'T-cancel-child',
        cancel: async () => { cancelled++ },
        appendUserMessage: async ({ content }: { content: string }) => {
          submitted = true
          if (delayedAppend) { await appendGate; return }
          const ctx = { thread: { id: 'T-cancel-child' } }
          const record = parse<{ id: number }>(String(await getTool(tools, 'orbed_command').execute({ command: 'printf ready' }, ctx)))
          await getTool(tools, 'orbed_browser').execute({ action: 'check', verdict: 'supported', reason: 'ready', evidence: [record.id] }, ctx)
          await getTool(tools, 'orbed_browser').execute({ action: 'finish' }, ctx)
          await getHook(hooks, 'agent.end')({ ...ctx, message: content, status: 'done' })
        },
      }) }),
    } as unknown as PluginAPI)
    const running = getTool(tools, 'orbed_run').execute({}, { thread: { id: 'T-cancel-parent' } })
    if (delayedAppend) await waitFor(() => submitted)
    else await waitFor(() => readFile(join(bin, 'archiving')).then(() => true, () => false))
    if (delayedAppend) {
      await getHook(hooks, 'agent.end')({ thread: { id: 'T-cancel-parent' }, message: 'cancelled', status: 'cancelled' })
    } else {
      await getHook(hooks, 'tool.result')({ thread: { id: 'T-cancel-parent' }, tool: 'orbed_run', toolUseID: 'cancel', status: 'cancelled' })
    }
    await rm(hold, { force: true })
    const report = parse<Report>(String(await running))
    assert.equal(report.passed, false)
    assert.equal(report.complete, false)
    assert.match(report.error ?? '', /cancelled/)
    const saved = parse<{ passed: boolean }>(await readFile(join(process.cwd(), '.orbed', report.runID, 'report.json'), 'utf8'))
    assert.equal(saved.passed, false)
    if (delayedAppend) {
      assert.equal(cancelled, 1)
      releaseAppend()
      await waitFor(async () => (await readFile(archives, 'utf8')).split('\n').filter(Boolean).length === before + 2)
      assert.equal(cancelled, 2)
      await assert.rejects(getTool(tools, 'orbed_command').execute({ command: 'printf late' }, { thread: { id: 'T-cancel-child' } }), /No idle active step/)
    }
}, 10_000)
