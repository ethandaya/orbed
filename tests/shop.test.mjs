import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test('shop calibration has independent correct and regressed runtime outcomes', { timeout: 20_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'orbed-shop-'))
  const server = spawn(process.execPath, [fileURLToPath(new URL('../examples/shop.mjs', import.meta.url))], {
    cwd: root, env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'],
  })
  t.after(async () => {
    const exited = once(server, 'exit')
    server.kill()
    await exited
    await rm(root, { recursive: true, force: true })
  })
  const [ready] = await once(server.stdout, 'data')
  const url = `http://127.0.0.1:${JSON.parse(ready).port}`
  for (const fault of ['none', 'stored-quantity', 'cancel-all']) {
    await writeFile(join(root, '.orbed/shop/fault'), fault)
    const headers = { 'Content-Type': 'application/json', 'x-customer': fault }
    const create = async quantity => {
      const r = await fetch(url + '/orders', { method: 'POST', headers, body: JSON.stringify({ quantity }) })
      assert.equal(r.status, 200)
      return r.json()
    }
    const a = await create(2)
    const b = await create(3)
    assert.notEqual(a.id, b.id)
    assert.equal(a.totalCents, 2500)
    assert.equal(b.totalCents, 3750)
    const stored = JSON.parse(await readFile(join(root, '.orbed/shop/orders', b.id + '.json')))
    assert.equal(stored.quantity, fault === 'stored-quantity' ? 1 : 3)
    const cancel = await fetch(url + '/orders/' + a.id + '/cancel', { method: 'POST', headers })
    assert.equal(cancel.status, 200)
    const history = await (await fetch(url + '/orders', { headers })).json()
    assert.equal(history.length, 2)
    assert.equal(history.find(order => order.id === a.id).status, 'cancelled')
    assert.equal(history.find(order => order.id === b.id).status, fault === 'cancel-all' ? 'cancelled' : 'confirmed')
    const other = await (await fetch(url + '/orders', { headers: { 'x-customer': 'unrelated' } })).json()
    assert.deepEqual(other, [])
  }
})
