import { test } from 'orbed'

// Deliberate failures; opt in with ORBED_INCLUDE_NEGATIVE_CONTROLS=1.
if (process.env.ORBED_INCLUDE_NEGATIVE_CONTROLS === '1') {
  test('wrong expectation fails', async ({ portals }) => {
    const counter = portals.get('portal-probe')
    await counter.action('Click Increment exactly once. Do not click again to satisfy an expectation.')
    await counter.expect('The displayed count is seven.')
    throw new Error('An incorrect expectation must not resolve')
  })
  test('missing evidence is incomplete', async ({ portals, expect }) => {
    await portals.get('portal-probe').action('Click Increment exactly once.')
    await expect('The latest backup in an external backup system completed successfully. That system is not connected to this orb and exposes no local evidence; do not access external systems or infer its state from this counter.')
  })
  test('timeout is incomplete', async ({ portals }) => {
    const counter = portals.get('portal-probe')
    await counter.action('Click Increment once.')
    await counter.expect('The displayed count is one.', { timeoutMs: 1 })
  })
}
