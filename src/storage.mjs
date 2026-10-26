import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';

export const exists = p => { try { fs.lstatSync(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
export const json = value => `${JSON.stringify(value, null, 2)}\n`;
export function safePath(root, path, { leafLink = false } = {}) {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || target === root) throw new Error(`Path escapes storage: ${path}`);
  let current = root;
  const parts = rel.split(sep);
  parts.forEach((part, i) => {
    current = join(current, part);
    if (exists(current) && fs.lstatSync(current).isSymbolicLink() && !(leafLink && i === parts.length - 1))
      throw new Error(`Unexpected symbolic link: ${current}`);
  });
  return target;
}
export function files(directory) {
  const result = [];
  function walk(dir) {
    if (!fs.lstatSync(dir).isDirectory()) throw new Error(`Expected a real directory: ${dir}`);
    // UTF-8 byte order, independent of machine locale.
    for (const name of fs.readdirSync(dir).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const path = join(dir, name), stat = fs.lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Payload symbolic links are unsupported: ${path}`);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) result.push(path);
      else throw new Error(`Unsupported payload entry: ${path}`);
    }
  }
  walk(directory);
  return result;
}
export function hashes(directory) {
  const entries = files(directory);
  if (!entries.includes(join(directory, 'SKILL.md'))) throw new Error(`SKILL.md missing: ${directory}`);
  const hash = createHash('sha256');
  let metadata = null;
  for (const file of entries) {
    const path = relative(directory, file).split(sep).join('/');
    const bytes = fs.readFileSync(file);
    if (path === 'agents/openai.yaml') { metadata = `sha256:${createHash('sha256').update(bytes).digest('hex')}`; continue; }
    // Length-prefixed paths and bytes avoid delimiter ambiguity for arbitrary binary files.
    for (const part of [Buffer.from(path), bytes]) {
      const size = Buffer.alloc(8); size.writeBigUInt64BE(BigInt(part.length));
      hash.update(size).update(part);
    }
  }
  return { payload: `sha256:${hash.digest('hex')}`, metadata };
}
export function same(a, b) { return a.payload === b.payload && a.metadata === b.metadata; }
export function discover(root) {
  if (!exists(root)) return [];
  const result = [];
  function walk(path) {
    const stat = fs.lstatSync(path);
    if (stat.isSymbolicLink()) { result.push(path); return; }
    if (!stat.isDirectory()) return;
    if (exists(join(path, 'SKILL.md'))) { result.push(path); return; }
    for (const name of fs.readdirSync(path)) walk(join(path, name));
  }
  walk(root);
  return result;
}

// A short-lived operation lock and rollback workspace, never an ownership database.
// An interrupted process leaves this directory: refuse further writes until inspected.
export function transaction(root, action) {
  const agents = safePath(root, '.agents');
  fs.mkdirSync(agents, { recursive: true });
  const workspace = safePath(root, '.agents/.skillsx-transaction');
  try { fs.mkdirSync(workspace); } catch (e) {
    if (e.code === 'EEXIST') throw new Error('Active or interrupted skillsx transaction. Inspect .agents/.skillsx-transaction before retrying.');
    throw e;
  }
  const entries = [], made = new Set();
  function parents(path) {
    const missing = []; let dir = dirname(path);
    while (!exists(dir)) { missing.push(dir); dir = dirname(dir); }
    for (const item of missing.reverse()) { fs.mkdirSync(item); made.add(item); }
  }
  const tx = {
    workspace,
    replace(path, source, kind = 'directory') {
      safePath(root, path, { leafLink: true });
      if (entries.some(e => e.path === path)) throw new Error(`Duplicate transaction destination: ${path}`);
      const entry = { path, backup: join(workspace, `backup-${entries.length}`), existed: exists(path) };
      entries.push(entry);
      fs.writeFileSync(join(workspace, 'rollback.json'), json(entries));
      if (entry.existed) fs.renameSync(path, entry.backup);
      parents(path);
      if (kind === 'directory') fs.cpSync(source, path, { recursive: true, verbatimSymlinks: true });
      else if (kind === 'file') fs.writeFileSync(path, source);
      else if (kind === 'symlink') fs.symlinkSync(source, path, 'dir');
      else if (kind !== 'remove') throw new Error(`Unknown replacement: ${kind}`);
    }
  };
  let preserve = false;
  try { return action(tx); }
  catch (error) {
    try {
      for (const entry of entries.reverse()) {
        // If rename failed, the original is still at the destination.
        if (entry.existed && !exists(entry.backup)) continue;
        fs.rmSync(entry.path, { recursive: true, force: true });
        if (entry.existed) fs.renameSync(entry.backup, entry.path);
      }
      for (const dir of [...made].reverse()) if (exists(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch (rollbackError) {
      preserve = true;
      throw new AggregateError([error, rollbackError], `Rollback incomplete. Preserve ${workspace} for recovery.`);
    }
    throw error;
  } finally { if (!preserve) fs.rmSync(workspace, { recursive: true, force: true }); }
}
