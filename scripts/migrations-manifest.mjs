import { writeFile } from 'node:fs/promises';
import { buildManifest, fixtureRoot, json } from '../tests/helpers/migration-manifest.mjs';

await writeFile(new URL('manifest.json', fixtureRoot), json(await buildManifest()));
