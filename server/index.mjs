import { openDb, closeDb } from './db.mjs';
import { createServer } from './http.mjs';
import { assertAuthBypassAllowed } from './auth.mjs';

const rawPort = process.env.PORT ?? '8787';
if (!/^\d+$/.test(rawPort) || Number(rawPort) > 65535) {
  throw new Error('PORT must be an integer between 0 and 65535.');
}

assertAuthBypassAllowed();
const db = await openDb();
const server = createServer(db);
let closing;
const closeConnection = () => closing ??= (async () => {
  if (db.isOpen) await closeDb(db);
})().catch(error => {
  console.error('Could not close backend storage:', error.message);
  process.exitCode = 1;
});
server.once('close', () => { void closeConnection(); });
server.once('error', (error) => {
  console.error('Could not start backend:', error.message);
  void closeConnection();
  process.exitCode = 1;
});
server.listen(Number(rawPort), process.env.HOST || '127.0.0.1', () => {
  const { address, family, port } = server.address();
  const host = family === 'IPv6' ? `[${address}]` : address;
  console.log(`SiteAssistant API listening at http://${host}:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close());
}
