import { test } from 'orbed'

for (const width of [1280, 390]) {
  test(`notebook checkout at ${width}px`, async ({ portals, db }) => {
    const shop = portals.get('shop')
    const orders = db.get('orders')
    await shop.action('Place two distinct orders, one for two notebooks and another for three.')
    await shop.expect('Both confirmations match the advertised unit price, with no extra charges.')
    await shop.action('Reload the page.')
    await orders.expect('Both orders retain their original IDs, quantities and totals in their durable local records.')
    await shop.action('Cancel the two-notebook order, then reload again.')
    await shop.expect('Only the two-notebook order is cancelled; the three-notebook order remains confirmed in history.')
    await orders.expect('Only the two-notebook order is cancelled; the three-notebook order remains confirmed in the durable records.')
  }, { viewport: [width, 720], timeout: 600_000 })
}
