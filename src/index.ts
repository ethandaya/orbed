export type Target = { kind: 'portal' | 'db' | 'service'; name: string }
export type Step = {
  kind: 'action' | 'expect'
  instruction: string
  target?: Target
  timeoutMs?: number
}
export type StepOptions = { timeoutMs?: number }
export type Resource = {
  action(instruction: string, options?: StepOptions): Promise<void>
  expect(claim: string, options?: StepOptions): Promise<void>
}
export type TestContext = {
  portal: Resource
  portals: { get(name: string): Resource }
  db: { get(name: string): Resource }
  services: { get(name: string): Resource }
  expect(claim: string, options?: StepOptions): Promise<void>
}
export type PortalTest = {
  name: string
  run(context: TestContext): void | Promise<void>
  viewport: readonly [number, number]
  timeoutMs: number
}
type Options = { viewport?: readonly [number, number]; timeoutMs?: number }
type Callback = PortalTest['run']

/** Register a callback without executing it. The runner supplies live async handles. */
export function test(name: string, run: Callback): PortalTest
export function test(name: string, options: Options, run: Callback): PortalTest
export function test(name: string, optionsOrRun: Options | Callback, callback?: Callback): PortalTest {
  const options = typeof optionsOrRun === 'function' ? {} : optionsOrRun
  const run = typeof optionsOrRun === 'function' ? optionsOrRun : callback
  const viewport = options.viewport ?? [1280, 720]
  const timeoutMs = options.timeoutMs ?? 120_000
  if (!name.trim() || typeof run !== 'function') throw new Error('Test name and callback are required')
  if (viewport.length !== 2 || viewport.some(n => !Number.isInteger(n) || n < 1 || n > 4096)) {
    throw new Error('Viewport dimensions must be integers from 1 to 4096')
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new Error('timeoutMs must be 1–600000')
  return Object.freeze({ name, run, viewport: Object.freeze([...viewport]) as readonly [number, number], timeoutMs })
}
