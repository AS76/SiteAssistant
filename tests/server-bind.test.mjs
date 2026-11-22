import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const entryPoint = fileURLToPath(new URL('../server/index.mjs', import.meta.url));

for (const [configuredHost, expectedAddress] of [
  [undefined, '127.0.0.1'],
  ['0.0.0.0', '0.0.0.0'],
]) {
  test(`server binds to ${expectedAddress} with HOST ${configuredHost ?? 'unset'}`, { timeout: 10_000 }, async t => {
    const env = { ...process.env, PORT: '0', DB_DRIVER: 'sqlite', DATA_DIR: ':memory:' };
    delete env.HOST;
    if (configuredHost !== undefined) env.HOST = configuredHost;

    const child = spawn(process.execPath, [entryPoint], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    const closed = once(child, 'close');
    t.after(async () => {
      child.kill();
      await closed;
    });

    const stdout = createInterface({ input: child.stdout });
    const line = await Promise.race([
      once(stdout, 'line', { signal: t.signal }).then(([line]) => line),
      closed.then(([code]) => { throw new Error(`Server exited before listening (code ${code})`); }),
    ]);
    const address = new URL(line.replace(/^SiteAssistant API listening at /, ''));
    t.assert.equal(address.hostname, expectedAddress);
    t.assert.ok(Number(address.port) > 0);
  });
}
