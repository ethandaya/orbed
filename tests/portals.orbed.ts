import { test } from 'orbed'

export default [test('switching portals preserves the scenario', {
  viewport: [390, 720], timeoutMs: 600_000,
}, async ({ portals, db }) => {
  const counter = portals.get('portal-probe')
  const shop = portals.get('shop')
  await counter.action('Click Increment exactly three times.')
  await counter.expect('The count is three.')
  await shop.action('Place an order for two notebooks.')
  await shop.expect('The confirmation has quantity two and a total matching the advertised price.')
  await counter.action('Return to the counter without reloading it, then click Increment once.')
  await counter.expect('The count is now four, retaining the three increments from before visiting the shop.')
  await db.get('orders').expect('The order placed in the shop has a durable record with quantity two and the confirmed total.')
})]
