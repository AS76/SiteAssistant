import { DEMO_SEED_MARKER } from '../../server/demo-seed-environment.mjs';

export function provisionDemoFixture(db) {
  return db.run('INSERT INTO demo_seed_environment (singleton, marker) VALUES (1, ?)', DEMO_SEED_MARKER);
}

export async function withDemoEnvironment(operation) {
  const previous = process.env.APP_ENV;
  process.env.APP_ENV = 'demo';
  try {
    return await operation();
  } finally {
    if (previous === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = previous;
  }
}
