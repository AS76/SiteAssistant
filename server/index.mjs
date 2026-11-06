import { openDb, closeDb } from './db.mjs';
import { createServer } from './http.mjs';

const rawPort = process.env.PORT ?? '8787';
if (!/^\d+$/.test(rawPort) || Number(rawPort) > 65535) {
  throw new Error('PORT must be an integer between 0 and 65535.');
}

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
server.listen(Number(rawPort), '127.0.0.1', () => {
  console.log(`SiteAssistant API listening at http://127.0.0.1:${server.address().port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close());
}
