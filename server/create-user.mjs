import { randomUUID } from 'node:crypto';
import { emitKeypressEvents } from 'node:readline';
import process from 'node:process';
import { hashPassword } from './auth.mjs';
import { openDb, closeDb } from './db.mjs';

// Only fixed, application-owned messages are safe to print; never echo input or driver errors.
class UserError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function validateAssignment(siteCode, role) {
  if ((siteCode !== undefined) !== (role !== undefined)) {
    throw new UserError('--site and --role must be supplied together.', 2);
  }
  if (siteCode !== undefined && (typeof siteCode !== 'string' || !siteCode.trim())) {
    throw new UserError('A non-empty site code is required.', 2);
  }
  if (role !== undefined && !['owner', 'editor', 'verifier', 'viewer'].includes(role)) {
    throw new UserError('Role must be owner, editor, verifier or viewer.', 2);
  }
}

export async function createUser(db, { email, name, password, siteCode, role }) {
  email = typeof email === 'string' ? email.trim().toLowerCase() : '';
  name = typeof name === 'string' ? name.trim() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new UserError('A valid email of at most 254 characters is required.', 2);
  }
  if (!name || name.length > 200) {
    throw new UserError('A non-empty name of at most 200 characters is required.', 2);
  }
  // Twelve characters provide a baseline against guessing while allowing passphrases.
  if (typeof password !== 'string' || [...password].length < 12) {
    throw new UserError('Password must contain at least 12 characters.', 2);
  }
  validateAssignment(siteCode, role);
  return await db.transaction(async tx => {
    if (await tx.get('SELECT id FROM users WHERE lower(email) = ?', email)) {
      throw new UserError('A user with this email already exists.');
    }
    const site = siteCode === undefined ? null : await tx.get('SELECT id, code FROM sites WHERE code = ?', siteCode);
    if (siteCode !== undefined && !site) throw new UserError('Site code does not exist.');
    const user = { id: randomUUID(), email, name };
    try {
      await tx.run(`INSERT INTO users (id, email, name, password_hash, password_algo, created_at)
        VALUES (?, ?, ?, ?, 'scrypt', ?)`, user.id, email, name, await hashPassword(password), new Date().toISOString());
    } catch (error) {
      // The unique index also protects concurrent creators after the initial lookup.
      if (tx.isUniqueViolation(error)) throw new UserError('A user with this email already exists.');
      throw new UserError('Unable to create user.');
    }
    if (site) {
      await tx.run(`INSERT INTO site_members (site_id, user_id, role) VALUES (?, ?, ?)
        ON CONFLICT (site_id, user_id) DO UPDATE SET role = excluded.role`, site.id, user.id, role);
    }
    return user;
  });
}

export function parseArgs(args) {
  const options = {};
  const names = new Map([['--email', 'email'], ['--name', 'name'], ['--site', 'siteCode'], ['--role', 'role']]);
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const key = flag === '--password-stdin' ? 'passwordStdin' : names.get(flag);
    if (!key || Object.hasOwn(options, key)) throw new UserError('Unknown or repeated argument. Passwords must never be passed in argv.', 2);
    if (key === 'passwordStdin') { options[key] = true; continue; }
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new UserError('An argument value is missing.', 2);
    options[key] = value;
  }
  if (!options.email || !options.name) throw new UserError('--email and --name are required.', 2);
  validateAssignment(options.siteCode, options.role);
  return options;
}

export async function readPassword({ passwordStdin }, { input = process.stdin, output = process.stderr, signals = process } = {}) {
  if (passwordStdin) {
    input.setEncoding('utf8');
    let password = '';
    for await (const chunk of input) password += chunk;
    // Remove only the line ending added by a pipe, preserving password whitespace.
    return password.replace(/\r?\n$/, '');
  }
  if (!input.isTTY) throw new UserError('--password-stdin is required when stdin is not a TTY.', 2);
  const wasRaw = input.isRaw === true;
  const wasFlowing = input.readableFlowing;
  let onKey, onInterrupt, onEnd, onError;
  try {
    input.setRawMode(true);
    emitKeypressEvents(input);
    const pending = new Promise((resolve, reject) => {
      let password = '';
      onInterrupt = () => reject(new UserError('Cancelled.', 130));
      onEnd = () => reject(new UserError('Password input ended before confirmation.', 2));
      onError = () => reject(new UserError('Unable to read password.'));
      onKey = (text, key = {}) => {
        if (key.ctrl && key.name === 'c') return onInterrupt();
        if (key.name === 'return' || key.name === 'enter') return resolve(password);
        if (key.name === 'backspace') { password = [...password].slice(0, -1).join(''); return; }
        if (key.ctrl && key.name === 'd') return onEnd();
        if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text)) password += text;
      };
      input.on('keypress', onKey);
      input.once('end', onEnd);
      input.once('error', onError);
      signals.once('SIGINT', onInterrupt);
    });
    output.write('Password: ');
    input.resume();
    return await pending;
  } finally {
    if (onKey) input.removeListener('keypress', onKey);
    if (onEnd) input.removeListener('end', onEnd);
    if (onError) input.removeListener('error', onError);
    if (onInterrupt) signals.removeListener('SIGINT', onInterrupt);
    input.setRawMode(wasRaw);
    if (wasFlowing !== true) input.pause();
    output.write('\n');
  }
}

if (import.meta.main) {
  let db;
  try {
    const options = parseArgs(process.argv.slice(2));
    const password = await readPassword(options);
    db = await openDb(undefined, { onMigrationsApplied: () => process.stderr.write('migrations applied\n') });
    const user = await createUser(db, { ...options, password });
    await closeDb(db);
    db = undefined;
    process.stdout.write(`Created user ${user.email} (${user.id})\n`);
    if (options.siteCode !== undefined) process.stdout.write(`Role ${options.role} on site ${options.siteCode}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof UserError ? error.message : 'Unable to create user.'}\n`);
    process.exitCode = error instanceof UserError ? error.exitCode : 1;
  } finally {
    if (db) {
      try { await closeDb(db); }
      catch { process.stderr.write('Unable to close database.\n'); process.exitCode = 1; }
    }
  }
}
