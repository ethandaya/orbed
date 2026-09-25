import { afterEach, jest, test } from 'bun:test'
import assert from 'node:assert/strict'
import { withTimeout } from '../dist/timeout.js'

afterEach(() => {
  jest.useRealTimers()
})

test('a nonsettling SDK wait rejects at the host deadline', async () => {
  jest.useFakeTimers()
  let settled = false
  const wait = withTimeout(new Promise<never>(() => {}), 120_000, 'Agent response')
  const rejection = assert.rejects(wait, /Agent response timed out after 120000ms/)
  wait.catch(() => { settled = true })
  jest.advanceTimersByTime(119_999)
  await Promise.resolve()
  assert.equal(settled, false)
  jest.advanceTimersByTime(1)
  await rejection
  assert.equal(settled, true)
})

test('successful and rejected operations keep their original outcomes', async () => {
  assert.equal(await withTimeout(Promise.resolve('finished'), 1000, 'Response'), 'finished')
  const error = new Error('transport failed')
  await assert.rejects(withTimeout(Promise.reject(error), 1000, 'Response'), e => e === error)
})

test('a late SDK rejection after timeout is still handled', async () => {
  let reject!: (reason?: unknown) => void
  const operation = new Promise<never>((_, fail) => { reject = fail })
  await assert.rejects(withTimeout(operation, 5, 'Cancellation'), /Cancellation timed out/)
  reject(new Error('late transport failure'))
  await new Promise(resolve => setImmediate(resolve))
})

test('abort stops waiting for an underlying operation that does not settle', async () => {
  const controller = new AbortController()
  const wait = withTimeout(new Promise<never>(() => {}), 60_000, 'Upload', controller.signal)
  controller.abort(new Error('suite cancelled'))
  await assert.rejects(wait, /suite cancelled/)
})

test('a pre-aborted wait still observes a later operation rejection', async () => {
  const controller = new AbortController()
  controller.abort(new Error('already cancelled'))
  let reject!: (reason?: unknown) => void
  const operation = new Promise<never>((_, fail) => { reject = fail })
  await assert.rejects(withTimeout(operation, 60_000, 'Upload', controller.signal), /already cancelled/)
  reject(new Error('late upload failure'))
  await new Promise(resolve => setImmediate(resolve))
})
