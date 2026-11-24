// Post-build link checker: fails the build if an internal link or asset is missing.
// Handles the Astro `base` prefix, directory indexes and hash-only links.
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const dist = resolve('dist');
const base = (process.env.DOCS_BASE || '/SiteAssistant').replace(/\/$/, '');
const problems = [];

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.name.endsWith('.html')) files.push(path);
  }
  return files;
}

async function exists(path) {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

async function targetFor(pathname) {
  let clean = pathname;
  if (base && (clean === base || clean.startsWith(`${base}/`))) clean = clean.slice(base.length) || '/';
  if (!clean.startsWith('/')) return null; // relative paths are resolved by the caller
  const disk = join(dist, clean);
  if (clean.endsWith('/')) return join(disk, 'index.html');
  if (await exists(disk)) return disk;
  if (await exists(join(disk, 'index.html'))) return join(disk, 'index.html');
  return disk;
}

const pages = await walk(dist);
const htmlByPath = new Map(await Promise.all(pages.map(async page => [page, await readFile(page, 'utf8')])));
const idsByPath = new Map([...htmlByPath].map(([page, html]) => [page,
  new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1])),
]));
let anchors = 0;
for (const [page, html] of htmlByPath) {
  const pageUrl = '/' + relative(dist, page).replaceAll('\\', '/').replace(/index\.html$/, '');
  for (const [, raw] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    if (!raw || raw.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
    const hashIndex = raw.indexOf('#');
    const pathname = (hashIndex === -1 ? raw : raw.slice(0, hashIndex)).split('?')[0];
    const anchor = hashIndex === -1 ? '' : raw.slice(hashIndex + 1);
    let target = page;
    if (pathname.startsWith('/')) {
      target = await targetFor(pathname);
      if (!target) { problems.push(`${pageUrl}: root-relative link without base prefix -> ${raw}`); continue; }
    } else if (pathname) {
      target = resolve(dist, `.${pageUrl}`, pathname);
      if (!(await exists(target))) target = join(target, 'index.html');
    }
    if (!(await exists(target))) { problems.push(`${pageUrl}: ${raw}`); continue; }
    if (anchor && idsByPath.has(target)) {
      anchors++;
      let id;
      try { id = decodeURIComponent(anchor); }
      catch { problems.push(`${pageUrl}: invalid anchor encoding in ${raw}`); continue; }
      if (!idsByPath.get(target).has(id)) problems.push(`${pageUrl}: missing anchor in ${raw}`);
    }
  }
}

if (problems.length) {
  console.error(`Broken internal links (${problems.length}):`);
  for (const problem of [...new Set(problems)]) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`Link check passed for ${pages.length} pages and ${anchors} internal anchors.`);
