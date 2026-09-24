import { createServer } from 'node:http'

const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Portal instrumentation probe</title>
<main>
  <h1>Portal instrumentation probe</h1>
  <p>This disposable page tests Amp agents interacting with a portal.</p>
  <button id="increment">Increment</button>
  <p role="status">Count: <output id="count">0</output></p>
</main>
<script>
  document.querySelector('#increment').addEventListener('click', () => {
    const count = document.querySelector('#count');
    count.value = String(Number(count.value) + 1);
    console.info('orbed-probe:increment', count.value);
  });
  console.info('orbed-probe:ready');
</script>
</html>`

createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8')
  response.end(request.url === '/health' ? 'ok' : html)
}).listen(Number(process.env.PORT), '0.0.0.0')
