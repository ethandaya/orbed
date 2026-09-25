import { test } from 'orbed'

export default [
  test('increment updates the count', async ({ portals }) => {
    const counter = portals.get('portal-probe')
    await counter.action('Click Increment exactly once.')
    await counter.expect('The displayed count increased by one from its initial value.')
  }),
  test('increment works at narrow width', async ({ portals }) => {
    const counter = portals.get('portal-probe')
    await counter.action('Click Increment exactly twice.')
    await counter.expect('The displayed count increased by two from its initial value.')
  }, { viewport: [390, 720] }),
]
