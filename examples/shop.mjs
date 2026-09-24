import { createServer } from 'node:http'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

const directory = '.orbed/shop/orders'
await mkdir(directory, { recursive: true })
const page = `<!doctype html>
<html lang="en">
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Notebook checkout</title>
<style>body{font:16px/1.5 system-ui;margin:24px}main{max-width:36rem}input,button{font:inherit;min-height:44px}input{width:5rem}output{overflow-wrap:anywhere}</style>
<main>
<h1>Notebook checkout</h1>
<p>Notebook — $12.50 each. No tax or shipping charges.</p>
<p>Disposable checkout fixture. No payments are taken.</p>
<form>
<label for="quantity">Quantity</label>
<input id="quantity" type="number" min="1" max="10" value="1" required>
<p>Total: <output id="total">$12.50</output></p>
<button>Place order</button>
</form>
<p role="status" id="receipt"></p>
<h2>Your orders</h2>
<button id="refresh" type="button">Refresh order history</button>
<div id="history">No orders yet.</div>
</main>
<script>
const customer = localStorage.customer || (localStorage.customer = crypto.randomUUID());
async function loadHistory() {
  const response = await fetch('/orders', {headers:{'x-customer':customer}});
  if (!response.ok) throw new Error('Order history could not be loaded.');
  const orders = await response.json();
  const container = document.querySelector('#history');
  container.replaceChildren();
  if (!orders.length) container.textContent = 'No orders yet.';
  for (const order of orders) {
    const row = document.createElement('p');
    row.textContent = 'Order ' + order.id + ': ' + order.quantity + ' notebooks, $' + (order.totalCents / 100).toFixed(2) + ', ' + order.status + '. ';
    if (order.status === 'confirmed') {
      const cancel = document.createElement('button');
      cancel.textContent = 'Cancel order ' + order.id;
      cancel.style.maxWidth = '100%';
      cancel.style.overflowWrap = 'anywhere';
      cancel.onclick = async () => {
        cancel.disabled = true;
        try {
          const response = await fetch('/orders/' + order.id + '/cancel', {method:'POST', headers:{'x-customer':customer}});
          if (!response.ok) throw new Error('Cancellation failed.');
          await loadHistory();
        } catch (error) { document.querySelector('#receipt').textContent = error.message; cancel.disabled = false; }
      };
      row.append(cancel);
    }
    container.append(row);
  }
}
function refresh() { loadHistory().catch(error => { document.querySelector('#receipt').textContent = error.message; }); }
document.querySelector('#refresh').onclick = refresh;
refresh();
const quantity = document.querySelector('#quantity');
quantity.addEventListener('input', () => {
  document.querySelector('#total').textContent = '$' + (Number(quantity.value) * 12.5).toFixed(2);
});
document.querySelector('form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = document.querySelector('form button');
  button.disabled = true;
  try {
    const response = await fetch('/orders', {method:'POST', headers:{'Content-Type':'application/json','x-customer':customer}, body:JSON.stringify({quantity:Number(quantity.value)})});
    if (!response.ok) throw new Error('Order could not be placed.');
    const order = await response.json();
    document.querySelector('#receipt').textContent = 'Order ' + order.id + ' confirmed: ' + order.quantity + ' notebooks, $' + (order.totalCents / 100).toFixed(2) + '.';
    await loadHistory();
  } catch (error) { document.querySelector('#receipt').textContent = error.message; }
  finally { button.disabled = false; }
});
</script></html>`

createServer(async (request, response) => {
  try {
    if (request.url === '/health') return response.end('ok')
    const customer = request.headers['x-customer']
    const fault = (await readFile('.orbed/shop/fault', 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error
      return 'none'
    })).trim()
    const orders = async () => (await Promise.all((await readdir(directory)).map(name => readFile(directory + '/' + name, 'utf8').then(JSON.parse)))).filter(order => order.customer === customer)
    if (request.method === 'GET' && request.url === '/orders') {
      response.setHeader('Content-Type', 'application/json')
      return response.end(JSON.stringify(await orders()))
    }
    const cancel = request.url.match(/^\/orders\/([a-f0-9-]{36})\/cancel$/)
    if (request.method === 'POST' && cancel) {
      const own = await orders()
      const selected = own.find(order => order.id === cancel[1])
      if (!selected) { response.writeHead(404); return response.end('Order not found') }
      for (const order of fault === 'cancel-all' ? own : [selected]) {
        order.status = 'cancelled'
        await writeFile(directory + '/' + order.id + '.json', JSON.stringify(order))
      }
      return response.end('cancelled')
    }
    if (request.method === 'POST' && request.url === '/orders') {
      let body = ''
      for await (const chunk of request) {
        body += chunk
        if (body.length > 1024) { response.writeHead(413); return response.end() }
      }
      const { quantity } = JSON.parse(body)
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
        response.writeHead(400); return response.end('Invalid quantity')
      }
      const order = { id: randomUUID(), customer, status: 'confirmed', quantity, totalCents: quantity * 1250 + (fault === 'total' ? 200 : 0) }
      if (fault !== 'persistence') await writeFile(directory + '/' + order.id + '.json', JSON.stringify({ ...order, quantity: fault === 'stored-quantity' ? 1 : quantity }))
      response.setHeader('Content-Type', 'application/json')
      return response.end(JSON.stringify(order))
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(page)
  } catch {
    response.writeHead(500); response.end('Order could not be placed.')
  }
}).listen(Number(process.env.PORT), '0.0.0.0', function () {
  console.log(JSON.stringify({ port: this.address().port }))
})
