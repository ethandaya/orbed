import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { test } from 'orbed'

export default [test('await service and database actions against real runtime state', { timeoutMs: 360_000 }, async ({ db, services }) => {
  const shop = services.get('shop')
  const orders = db.get('orders')
  const customer = randomUUID()
  await shop.action(`Create exactly one order for three notebooks through POST /orders with x-customer header ${customer}.`)

  // An independent read in the callback proves await did not just enqueue a plan.
  const directory = new URL('../.orbed/shop/orders/', import.meta.url)
  const records = await Promise.all((await readdir(directory)).map(async file =>
    JSON.parse(await readFile(new URL(file, directory), 'utf8'))))
  const own = records.filter(order => order.customer === customer)
  if (own.length !== 1 || own[0].quantity !== 3 || own[0].totalCents !== 3750) {
    throw new Error('Service action resolved before the correct order was persisted')
  }
  const id = own[0].id
  await orders.expect(`Order ${id} has quantity three, total 3750 cents and confirmed status.`)
  await orders.action(`Set only the disposable order ${id} to cancelled in its durable record, retaining all other fields and records.`)
  const cancelled = JSON.parse(await readFile(new URL(`${id}.json`, directory), 'utf8'))
  if (cancelled.status !== 'cancelled' || cancelled.quantity !== 3) throw new Error('Database action resolved before its write completed')
  await shop.expect(`GET /orders with x-customer header ${customer} returns exactly that order ${id}, now cancelled, with quantity three and total 3750 cents.`)
})]
