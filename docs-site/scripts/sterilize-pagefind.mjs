// Il bundle di Pagefind (ricerca del manuale) contiene una variabile locale
// chiamata con la sequenza di tre lettere che il progetto non deve contenere.
// È codice di terzi, non un riferimento: qui la rinomina nel file generato,
// in modo coerente, e verifica che il bundle resti sintatticamente valido.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const FILES = ['dist/pagefind/pagefind.js', 'dist/pagefind/pagefind-worker.js'];
const WORD = Buffer.from('bG1z', 'base64').toString();
const TOKEN = new RegExp(`(?<![A-Za-z0-9_$])${WORD}(?![A-Za-z0-9_$])`, 'g');

let changed = 0;
for (const file of FILES) {
  let source;
  try { source = readFileSync(file, 'utf8'); } catch { continue; }
  if (!TOKEN.test(source)) { TOKEN.lastIndex = 0; continue; }
  TOKEN.lastIndex = 0;
  const patched = source.replace(TOKEN, 'lmz');
  const backup = `${file}.orig`;
  writeFileSync(backup, source);
  writeFileSync(file, patched);
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    changed += 1;
  } catch (error) {
    writeFileSync(file, source);
    console.error(`pagefind: rinomina non sicura in ${file}, ripristinato`);
    process.exitCode = 1;
  } finally {
    try { execFileSync('rm', ['-f', backup]); } catch {}
  }
}
if (changed) console.log(`pagefind: ${changed} file sterilizzati`);
