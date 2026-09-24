import { test } from 'orbed'

export default [1280, 390].map(width => test(`notebook checkout at ${width}px`, {
  viewport: [width, 720], timeoutMs: 600_000,
}, async ({ portals, db }) => {
  const shop = portals.get('shop')
  const orders = db.get('orders')
  await shop.action('Place two distinct orders, one for two notebooks and another for three.')
  await shop.expect('Both confirmations match the advertised unit price, with no extra charges.')
  await shop.action('Reload the page.')
  await orders.expect('Both orders retain their original IDs, quantities and totals in their durable local records.')
  await shop.action('Cancel the two-notebook order, then reload again.')
  await shop.expect('Only the two-notebook order is cancelled; the three-notebook order remains confirmed in history.')
  await orders.expect('Only the two-notebook order is cancelled; the three-notebook order remains confirmed in the durable records.')
}))
