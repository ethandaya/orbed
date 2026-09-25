import type { PortalTest, Resource, StepOptions, TestContext } from './index.ts'
import type { Target } from './portals.ts'
import { withTimeout } from './timeout.ts'

export type Step = {
  kind: 'action' | 'expect'
  instruction: string
  target?: Target
  timeoutMs?: number
}

/** Own callback lifetime, sequential operations and a sticky failure gate. */
export async function executeTest(
  test: PortalTest,
  resolve: (target: Target) => Target,
  execute: (step: Step) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let closed = false
  let pending: Promise<void> | undefined
  let failure: unknown
  let expectations = 0
  const unconsumed = new Set<Promise<void>>()
  let rejectFailure: (error: unknown) => void
  const failed = new Promise<never>((_, reject) => { rejectFailure = reject })
  const stop = (error: unknown): never => { failure ??= error; rejectFailure(failure); throw failure }
  const abort = () => {
    failure ??= signal!.reason ?? new Error('Test cancelled')
    rejectFailure(failure)
  }
  const step = (kind: Step['kind'], instruction: string, target?: Target, options: StepOptions = {}): Promise<void> => {
    if (closed) throw new Error('Test has stopped')
    if (failure) throw failure
    if (pending) return stop(new Error('Await each Orbed action or expectation before starting another'))
    if (typeof instruction !== 'string' || !instruction.trim()) return stop(new Error('An action or expectation is required'))
    if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 600_000)) {
      return stop(new Error('Step timeoutMs must be 1–600000'))
    }
    if (kind === 'expect') expectations++
    const operation = Promise.resolve().then(() => {
      if (closed || failure) throw failure ?? new Error('Test has stopped')
      return execute({ kind, instruction, target, timeoutMs: options.timeoutMs })
    })
    const interruptible = Promise.race([failed, operation])
    const completion = (options.timeoutMs === undefined ? interruptible : withTimeout(interruptible, options.timeoutMs, 'Step'))
      .catch(stop).finally(() => { pending = undefined })
    pending = completion
    // A bare discarded call stays in this set. `await` and `return` remove it. `.then()` adopts
    // the promise, so a discarded chain cannot be distinguished from an awaited one.
    completion.catch(() => {})
    unconsumed.add(completion)
    return {
      then(onfulfilled, onrejected) {
        unconsumed.delete(completion)
        return completion.then(onfulfilled, onrejected)
      },
      catch(onrejected: (reason: unknown) => unknown) {
        unconsumed.delete(completion)
        return completion.catch(onrejected)
      },
      finally(onfinally: () => void) {
        unconsumed.delete(completion)
        return completion.finally(onfinally)
      },
    } as Promise<void>
  }
  const resource = (kind: Target['kind'], name: string): Resource => {
    if (closed) throw new Error('Test has stopped')
    if (failure) throw failure
    if (typeof name !== 'string' || (kind !== 'portal' && !name.trim())) return stop(new Error('Resource name is required'))
    let target: Target
    try { target = resolve({ kind, name }) } catch (error) { return stop(error) }
    return Object.freeze({
      action: (instruction: string, options?: StepOptions) => step('action', instruction, target, options),
      expect: (claim: string, options?: StepOptions) => step('expect', claim, target, options),
    })
  }
  const named = (kind: Target['kind']) => ({ get(name: string) {
    if (typeof name !== 'string' || !name.trim()) return stop(new Error('Resource name is required'))
    return resource(kind, name)
  } })
  const context: TestContext = {
    get portal() { return resource('portal', '') },
    portals: named('portal'), db: named('db'), services: named('service'),
    expect: (claim, options) => step('expect', claim, undefined, options),
  }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    if (signal?.aborted) abort()
    await withTimeout(Promise.race([failed, Promise.resolve().then(async () => {
      signal?.throwIfAborted()
      await test.run(context)
      if (pending || unconsumed.size) return stop(new Error('Test callback returned with an unawaited Orbed operation'))
      if (failure) throw failure
      if (!expectations) throw new Error('A test requires expectations')
    })]), test.timeoutMs, `Test ${test.name}`)
  } catch (error) {
    stop(error)
  } finally {
    closed = true
    signal?.removeEventListener('abort', abort)
  }
}
