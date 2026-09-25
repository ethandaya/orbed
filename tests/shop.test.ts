import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

type Order = { id: string; totalCents: number; quantity: number; status: string }

test('shop calibration has independent correct and regressed runtime outcomes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orbed-shop-'))
  const server = spawn('node', [fileURLToPath(new URL('../examples/shop.mjs', import.meta.url))], {
    cwd: root, env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'],
  })
  try {
    const [ready] = await once(server.stdout, 'data')
    const url = `http://127.0.0.1:${JSON.parse(String(ready)).port as number}`
    for (const fault of ['none', 'stored-quantity', 'cancel-all']) {
      await writeFile(join(root, '.orbed/shop/fault'), fault)
      const headers = { 'Content-Type': 'application/json', 'x-customer': fault }
      const create = async (quantity: number): Promise<Order> => {
        const r = await fetch(url + '/orders', { method: 'POST', headers, body: JSON.stringify({ quantity }) })
        assert.equal(r.status, 200)
        return await r.json() as Order
      }
      const a = await create(2)
      const b = await create(3)
      assert.notEqual(a.id, b.id)
      assert.equal(a.totalCents, 2500)
      assert.equal(b.totalCents, 3750)
      const stored = JSON.parse(await readFile(join(root, '.orbed/shop/orders', b.id + '.json'), 'utf8')) as Order
      assert.equal(stored.quantity, fault === 'stored-quantity' ? 1 : 3)
      const cancel = await fetch(url + '/orders/' + a.id + '/cancel', { method: 'POST', headers })
      assert.equal(cancel.status, 200)
      const history = await (await fetch(url + '/orders', { headers })).json() as Order[]
      assert.equal(history.length, 2)
      assert.equal(history.find(order => order.id === a.id)?.status, 'cancelled')
      assert.equal(history.find(order => order.id === b.id)?.status, fault === 'cancel-all' ? 'cancelled' : 'confirmed')
      const other = await (await fetch(url + '/orders', { headers: { 'x-customer': 'unrelated' } })).json() as Order[]
      assert.deepEqual(other, [])
    }
  } finally {
    const exited = once(server, 'exit')
    server.kill()
    await exited
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)
