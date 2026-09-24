import { orbed } from 'orbed/plugin'
import tests from '../../examples/shop.orbed.ts'
import portals from '../../tests/portals.orbed.ts'
import resources from '../../tests/resources.orbed.ts'

export const description = 'Run this project’s portal tests with Amp agents and browser-backed assertions.'
export default orbed([...tests, ...portals, ...resources], {
  allowShell: true,
  databases: { orders: { service: 'shop', instructions: 'This fixture uses a JSON document store in .orbed/shop/orders/<order-id>.json. Fields: id, customer, quantity, totalCents, status. Read only for expectations; change runtime records only when explicitly requested by an action.' } },
  services: { shop: { instructions: 'Disposable HTTP service on the local port supplied by Amp. GET /health returns ok. POST /orders accepts JSON {quantity} and x-customer header. GET /orders with that header returns the customer’s orders. No payments or external calls.' } },
  instructions: 'This is a disposable local checkout, with no payments or external services. Do not inspect implementation source or unrelated .orbed files; assess runtime behavior, not the fixture implementation.',
})
