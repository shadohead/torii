// Server-sent events hub. Zero work when nobody is connected.
const clients = new Set();

export function addClient(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':ok\n\n');
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

export function broadcast(type, data) {
  if (!clients.size) return;
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}

export const hasClients = () => clients.size > 0;

setInterval(() => { for (const res of clients) res.write(':hb\n\n'); }, 25000).unref();
