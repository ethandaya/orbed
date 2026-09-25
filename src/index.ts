import type { Resources } from './portals.ts'
import { register } from './registry.ts'

export type StepOptions = { timeoutMs?: number }
export type Config = Resources & { instructions?: string }

/** Type-check orbed.config.ts. The plugin loads it fresh on every run. */
export function defineConfig(config: Config): Config {
  return config
}
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
export type TestOptions = { viewport?: readonly [number, number]; timeout?: number }
type Callback = PortalTest['run']

/** Register a test without executing it. The runner supplies live async handles. */
export function test(name: string, run: Callback, optionsOrTimeout: TestOptions | number = {}): PortalTest {
  if (!name.trim() || typeof run !== 'function') throw new Error('Test name and callback are required')
  const options = typeof optionsOrTimeout === 'number' ? { timeout: optionsOrTimeout } : optionsOrTimeout
  const viewport = options.viewport ?? [1280, 720]
  const timeoutMs = options.timeout ?? 120_000
  if (viewport.length !== 2 || viewport.some(n => !Number.isInteger(n) || n < 1 || n > 4096)) {
    throw new Error('Viewport dimensions must be integers from 1 to 4096')
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new Error('timeout must be 1–600000')
  const declaration = Object.freeze({ name, run, viewport: Object.freeze([...viewport]) as readonly [number, number], timeoutMs })
  register(declaration)
  return declaration
}
