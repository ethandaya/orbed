import { test } from 'orbed'

export default [
  test('wrong expectation fails', async ({ portals }) => {
    const counter = portals.get('portal-probe')
    await counter.action('Click Increment exactly once. Do not click again to satisfy an expectation.')
    await counter.expect('The displayed count is seven.')
    throw new Error('An incorrect expectation must not resolve')
  }),
  test('missing evidence is incomplete', async ({ portals, expect }) => {
    await portals.get('portal-probe').action('Click Increment exactly once.')
    await expect('The server persisted the new count to its production database.')
  }),
  test('timeout is incomplete', async ({ portals }) => {
    const counter = portals.get('portal-probe')
    await counter.action('Click Increment once.')
    await counter.expect('The displayed count is one.', { timeoutMs: 1 })
  }),
]
