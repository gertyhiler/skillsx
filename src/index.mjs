import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { exists, safePath, hashes, same, discover, transaction, json } from './storage.mjs';
export { hashes } from './storage.mjs';

export const adapters = Object.freeze({
  codex: { path: '.agents/skills', transport: 'direct' },
  'claude-code': { path: '.claude/skills', transport: 'symlink' },
  junie: { path: '.junie/skills', transport: 'symlink' }
});
const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const hashPattern = /^sha256:[a-f0-9]{64}$/;
const revisionPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.hasOwn(o, k);
function assert(value, message) { if (!value) throw new Error(message); }
function fields(value, allowed, label) {
  assert(object(value), `${label} must be an object`);
  for (const key of Object.keys(value)) assert(allowed.includes(key), `Unknown ${label} field: ${key}`);
}
function name(id) { assert(typeof id === 'string' && namePattern.test(id), `Invalid ID: ${id}`); }
function subpath(value) {
  assert(typeof value === 'string' && value.length && !value.includes('\\') && !value.includes('\0') && !value.includes(':') && value.split('/').every(p => p && p !== '.' && p !== '..'), `Invalid relative path: ${value}`);
}
function sourceCheck(source) {
  fields(source, ['type', 'url', 'ref', 'path'], 'source');
  assert(['git', 'copy'].includes(source.type), 'Source type must be git or copy');
  if (source.type === 'git') {
    assert(typeof source.url === 'string' && source.url.length > 0 && !source.url.startsWith('-') && !/[\r\n\0]/.test(source.url), 'Invalid Git source URL');
    assert(!source.url.includes('::'), 'Git remote helper syntax is unsupported');
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source.url)) {
      const url = new URL(source.url);
      assert(['https:', 'http:', 'ssh:', 'git:', 'file:'].includes(url.protocol), 'Unsupported Git transport');
      assert(!url.password && (!['https:', 'http:'].includes(url.protocol) || !url.username), 'Keep credentials out of registry URLs; use Git authentication');
    }
    assert(!own(source, 'path'), 'Git sources use url, not path');
    if (own(source, 'ref')) assert(typeof source.ref === 'string' && source.ref.length && !source.ref.startsWith('-') && !/[\r\n\0]/.test(source.ref), 'Invalid Git ref');
  } else {
    subpath(source.path);
    assert(!own(source, 'url') && !own(source, 'ref'), 'Copy sources use a relative path only');
  }
}
export function skillPath(id, skill) {
  return ['.agents', 'skills', ...(own(skill, 'categoryId') ? [skill.categoryId] : []), id].join('/');
}
export function agentConfig(id, config) {
  const preset = adapters[id];
  const path = config.path ?? preset?.path;
  const transport = config.transport ?? preset?.transport;
  assert(path && transport, `Custom agent ${id} requires path and transport`);
  subpath(path);
  assert(/^\.[a-z0-9-]+\/skills$/.test(path), `Agent path must be a relative .<agent>/skills directory: ${path}`);
  assert(['direct', 'copy', 'symlink'].includes(transport), `Invalid transport for ${id}`);
  assert((path === '.agents/skills') === (transport === 'direct'), 'Only canonical .agents/skills supports direct transport');
  return { path, transport };
}
export function validateRegistry(r) {
  fields(r, ['$schema', 'version', 'categories', 'sources', 'agents', 'skills'], 'registry');
  assert(r.version === 1, 'Unsupported registry version');
  if (own(r, '$schema')) assert(typeof r.$schema === 'string', '$schema must be a string');
  for (const key of ['categories', 'sources', 'agents', 'skills']) assert(object(r[key]), `Registry requires ${key}`);
  for (const [id, category] of Object.entries(r.categories)) {
    name(id); fields(category, ['description'], 'category');
    if (own(category, 'description')) assert(typeof category.description === 'string', 'Category description must be a string');
  }
  for (const [id, source] of Object.entries(r.sources)) { name(id); sourceCheck(source); }
  const targets = new Set();
  for (const [id, config] of Object.entries(r.agents)) {
    name(id); fields(config, ['path', 'transport'], 'agent');
    const { path } = agentConfig(id, config);
    assert(!targets.has(path), `Duplicate agent target: ${path}`); targets.add(path);
  }
  for (const [id, skill] of Object.entries(r.skills)) {
    name(id); fields(skill, ['categoryId', 'source', 'hashes', 'refines'], 'skill');
    if (own(skill, 'categoryId')) { name(skill.categoryId); assert(own(r.categories, skill.categoryId), `Unknown category: ${skill.categoryId}`); }
    else assert(!own(r.categories, id), `Uncategorized skill conflicts with category: ${id}`);
    fields(skill.hashes, ['payload', 'metadata'], 'hashes');
    assert(hashPattern.test(skill.hashes.payload), `Invalid payload hash: ${id}`);
    assert(skill.hashes.metadata === null || hashPattern.test(skill.hashes.metadata), `Invalid metadata hash: ${id}`);
    if (own(skill, 'source')) {
      fields(skill.source, ['id', 'path', 'revision'], 'skill source');
      assert(own(r.sources, skill.source.id), `Unknown source: ${skill.source.id}`);
      subpath(skill.source.path);
      assert(r.sources[skill.source.id].type === 'git' ? revisionPattern.test(skill.source.revision) : hashPattern.test(skill.source.revision), `Invalid resolved revision: ${id}`);
    }
    if (own(skill, 'refines')) {
      assert(object(skill.refines), 'refines must be an object');
      for (const [target, refinement] of Object.entries(skill.refines)) {
        assert(target !== id && own(r.skills, target), `Unknown or self refinement: ${target}`);
        fields(refinement, ['reviewedRevision'], 'refinement');
        assert(typeof refinement.reviewedRevision === 'string' && refinement.reviewedRevision.length > 0, 'Refinement requires reviewedRevision');
      }
    }
  }
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    assert(!visiting.has(id), `Refinement cycle: ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of Object.keys(r.skills[id].refines ?? {})) visit(next);
    visiting.delete(id); visited.add(id);
  }
  Object.keys(r.skills).forEach(visit);
  return r;
}
function git(args) {
  const operation = args.find(arg => ['init', 'fetch', 'checkout', 'rev-parse', 'ls-files', 'ls-remote', 'sparse-checkout'].includes(arg)) ?? 'operation';
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000,
    maxBuffer: 16 * 1024 * 1024, detached: process.platform !== 'win32'
  });
  if (result.error && result.pid && process.platform !== 'win32') {
    try { process.kill(-result.pid, 'SIGKILL'); } catch { /* Already exited. */ }
  }
  if (result.error?.code === 'ETIMEDOUT') throw new Error(`Git ${operation} timed out after 300 seconds; retry when the source is reachable.`);
  if (result.error || result.status !== 0) throw new Error(`Git ${operation} failed. Check source, ref, connectivity and Git authentication.`);
  return result.stdout.trim();
}

export class SkillsManager {
  constructor(root = process.cwd()) {
    this.root = fs.realpathSync(root);
    this.registryPath = safePath(this.root, '.agents/skills.registry.json');
  }
  path(id, skill) { return safePath(this.root, skillPath(id, skill)); }
  mutate(action) {
    return transaction(this.root, tx => {
      this.inTransaction = true;
      try { return action(tx); } finally { this.inTransaction = false; }
    });
  }
  read() {
    assert(this.inTransaction || !exists(safePath(this.root, '.agents/.skillsx-transaction')), 'Active or interrupted skillsx transaction; registry snapshot is unavailable');
    return validateRegistry(JSON.parse(fs.readFileSync(this.registryPath, 'utf8')));
  }
  write(tx, r) { validateRegistry(r); tx.replace(this.registryPath, json(r), 'file'); }
  init() {
    assert(!exists(this.registryPath), 'Registry already exists');
    return this.mutate(tx => {
      const r = { version: 1, categories: {}, sources: {}, agents: {}, skills: {} };
      this.write(tx, r); return r;
    });
  }
  configure(type, id, value) {
    assert(['categories', 'sources'].includes(type), 'Use agent() for agent configuration'); name(id);
    return this.mutate(tx => {
      const r = this.read(); r[type][id] = value; this.write(tx, r); return r;
    });
  }
  projections(r) {
    const result = [];
    for (const [agent, config] of Object.entries(r.agents)) {
      const { path, transport } = agentConfig(agent, config);
      if (transport === 'direct') continue;
      for (const [id, skill] of Object.entries(r.skills)) {
        const target = safePath(this.root, `${path}/${id}`, { leafLink: true });
        const canonical = this.path(id, skill);
        result.push({ agent, id, target, canonical, transport, link: relative(dirname(target), canonical).split(sep).join('/'), hashes: skill.hashes });
      }
    }
    return result;
  }
  projectionMatches(p) {
    if (!exists(p.target)) return false;
    if (p.transport === 'symlink') return fs.lstatSync(p.target).isSymbolicLink() && fs.readlinkSync(p.target) === p.link;
    return !fs.lstatSync(p.target).isSymbolicLink() && same(hashes(p.target), p.hashes);
  }
  verify(r = this.read()) {
    validateRegistry(r);
    const findings = [], warnings = [];
    const add = (status, id, path) => findings.push({ status, skill: id, path: relative(this.root, path).split(sep).join('/') });
    const paths = new Map();
    for (const [id, skill] of Object.entries(r.skills)) {
      const path = this.path(id, skill); paths.set(path, id);
      if (!exists(path)) { add('missing', id, path); continue; }
      try {
        const actual = hashes(path);
        if (actual.payload !== skill.hashes.payload) add('payload-modified', id, path);
        if (actual.metadata !== skill.hashes.metadata) add('metadata-modified', id, path);
      } catch { add('invalid-entry', id, path); }
      for (const [target, refinement] of Object.entries(skill.refines ?? {})) {
        const installed = r.skills[target].source?.revision ?? r.skills[target].hashes.payload;
        if (refinement.reviewedRevision !== installed) warnings.push({ status: 'refinement-review-needed', skill: id, target });
      }
    }
    for (const found of discover(safePath(this.root, '.agents/skills'))) if (!paths.has(found)) add('unregistered', null, found);
    const projections = this.projections(r);
    for (const p of projections) {
      if (!exists(p.target)) add('agent-missing', p.id, p.target);
      else { try { if (!this.projectionMatches(p)) add(p.transport === 'symlink' ? 'broken-link' : 'agent-copy-modified', p.id, p.target); }
        catch { add('agent-copy-modified', p.id, p.target); } }
    }
    for (const [id, config] of Object.entries(r.agents)) {
      const a = agentConfig(id, config);
      if (a.transport === 'direct') continue;
      const root = safePath(this.root, a.path);
      for (const found of discover(root)) {
        if (!projections.some(p => p.target === found || (found.startsWith(p.target + sep) && p.transport === 'copy'))) add('unregistered', null, found);
      }
    }
    return { ok: findings.length === 0, findings, warnings };
  }
  preflight(r, allow = () => false) {
    const failures = this.verify(r).findings.filter(f => f.status !== 'agent-missing' && !allow(f));
    assert(failures.length === 0, `Registry drift or conflict: ${JSON.stringify(failures)}`);
  }
  syncProjections(tx, before, after) {
    const previous = this.projections(before), next = this.projections(after);
    const destinations = new Set([...previous, ...next].map(p => p.target));
    // Check every destination before changing any of them.
    for (const target of destinations) {
      const old = previous.find(p => p.target === target), wanted = next.find(p => p.target === target);
      if (exists(target)) assert((old && this.projectionMatches(old)) || (wanted && this.projectionMatches(wanted)), `Agent destination conflict: ${target}`);
    }
    for (const target of destinations) {
      const wanted = next.find(p => p.target === target);
      if (!wanted) { if (exists(target)) tx.replace(target, null, 'remove'); }
      else if (!this.projectionMatches(wanted)) {
        if (wanted.transport === 'symlink') tx.replace(target, wanted.link, 'symlink');
        else tx.replace(target, wanted.canonical);
      }
    }
  }
  finish(tx, before, after) {
    validateRegistry(after); this.syncProjections(tx, before, after);
    this.write(tx, after);
    const result = this.verify(after);
    assert(result.ok, `Final verification failed: ${JSON.stringify(result.findings)}`);
    return result;
  }
  sync() { return this.mutate(tx => { const r = this.read(); this.preflight(r); return this.finish(tx, r, r); }); }
  agent(id, config = null) {
    name(id);
    return this.mutate(tx => {
      const before = this.read(); this.preflight(before);
      const after = structuredClone(before);
      if (config === null) { assert(own(after.agents, id), `Unknown agent: ${id}`); delete after.agents[id]; }
      else after.agents[id] = config;
      validateRegistry(after); return this.finish(tx, before, after);
    });
  }
  register(id, options = {}) { return this.registerMany({ [id]: options }); }
  registerMany(entries) {
    assert(object(entries) && Object.keys(entries).length > 0, 'Select at least one own skill to register');
    return this.mutate(tx => {
      const before = this.read(), after = structuredClone(before), selectedPaths = new Set();
      for (const [id, options] of Object.entries(entries)) {
        name(id); fields(options, ['categoryId', 'refines'], 'registration');
        assert(!own(before.skills, id), `Already registered: ${id}`);
        const skill = { ...options };
        const path = this.path(id, skill); selectedPaths.add(path);
        skill.hashes = hashes(path); after.skills[id] = skill;
      }
      validateRegistry(after);
      this.preflight(before, f => f.status === 'unregistered' && selectedPaths.has(resolve(this.root, f.path)));
      return this.finish(tx, before, after);
    });
  }
  record(id, options = {}) { return this.recordMany([id], options); }
  recordMany(ids, { metadata = false } = {}) {
    assert(Array.isArray(ids) && ids.length > 0 && new Set(ids).size === ids.length, 'Select unique skill IDs to record');
    return this.mutate(tx => {
      const before = this.read(), after = structuredClone(before);
      for (const id of ids) {
        assert(own(before.skills, id), `Unknown skill: ${id}`);
        const skill = before.skills[id];
        assert(!skill.source || metadata, 'External payloads cannot be recorded; use update or restore');
        const actual = hashes(this.path(id, skill));
        after.skills[id].hashes = metadata ? { ...skill.hashes, metadata: actual.metadata } : actual;
      }
      this.preflight(before, f => ids.includes(f.skill) && (f.status === 'metadata-modified' || (!metadata && f.status === 'payload-modified')));
      return this.finish(tx, before, after);
    });
  }
  fetch(tx, r, sourceId, sourcePath, revision) {
    assert(own(r.sources, sourceId), `Unknown source: ${sourceId}`); const source = r.sources[sourceId]; subpath(sourcePath);
    let checkout, resolvedRevision;
    if (source.type === 'git') {
      tx.sources ??= new Map();
      const key = `${sourceId}:${revision ?? source.ref ?? 'HEAD'}`;
      let cached = tx.sources.get(key);
      if (!cached) {
        checkout = fs.mkdtempSync(join(tx.workspace, 'checkout-'));
        git(['init', '--quiet', checkout]);
        git(['-C', checkout, 'sparse-checkout', 'init', '--cone']);
        git(['-C', checkout, 'sparse-checkout', 'set', '--', sourcePath]);
        const url = source.url.startsWith('.') ? resolve(this.root, source.url) : source.url;
        const resolved = this.resolveRef(source, revision);
        git(['-C', checkout, 'remote', 'add', 'origin', url]);
        git(['-C', checkout, 'config', 'remote.origin.promisor', 'true']);
        git(['-C', checkout, 'config', 'remote.origin.partialclonefilter', 'blob:none']);
        git(['-C', checkout, 'fetch', '--quiet', '--filter=blob:none', '--depth=1', 'origin', resolved]);
        git(['-C', checkout, 'checkout', '--quiet', '--detach', 'FETCH_HEAD']);
        resolvedRevision = git(['-C', checkout, 'rev-parse', 'HEAD']);
        assert(resolvedRevision === resolved, 'Fetched revision differs from resolved source revision');
        cached = { checkout, resolvedRevision, paths: new Set([sourcePath]) }; tx.sources.set(key, cached);
      }
      ({ checkout, resolvedRevision } = cached);
      if (!cached.paths.has(sourcePath)) {
        cached.paths.add(sourcePath);
        git(['-C', checkout, 'sparse-checkout', 'set', '--', ...cached.paths]);
      }
      const index = git(['-C', checkout, 'ls-files', '--stage', '--', sourcePath]);
      assert(!/^160000 /m.test(index), 'Git submodules inside skill packages are unsupported');
    } else checkout = safePath(this.root, source.path);
    const path = safePath(checkout, sourcePath);
    const digest = hashes(path);
    return { path, revision: resolvedRevision ?? digest.payload };
  }
  install(id, { sourceId, sourcePath, categoryId, revision } = {}) {
    name(id);
    return this.mutate(tx => {
      const before = this.read(); this.preflight(before);
      assert(!own(before.skills, id), `Already registered: ${id}`);
      if (revision !== undefined) assert(revisionPattern.test(revision), 'Explicit revision must be a full Git commit ID');
      const fetched = this.fetch(tx, before, sourceId, sourcePath, revision);
      const skill = { ...(categoryId === undefined ? {} : { categoryId }), source: { id: sourceId, path: sourcePath, revision: fetched.revision }, hashes: hashes(fetched.path) };
      // No renaming: the selected source directory determines the installed name.
      assert(sourcePath.split('/').at(-1) === id, 'Installed ID must match the source directory name');
      const after = structuredClone(before); after.skills[id] = skill; validateRegistry(after);
      const target = this.path(id, skill); assert(!exists(target), `Destination already exists: ${target}`);
      tx.replace(target, fetched.path); return this.finish(tx, before, after);
    });
  }
  update(id, { restore = false } = {}) { return this.reconcile([id], { restore }); }
  updateAll(ids) { return this.reconcile(ids); }
  restoreAll(ids) { return this.reconcile(ids, { restore: true }); }
  reconcile(ids, { restore = false } = {}) {
    return this.mutate(tx => {
      const before = this.read(), after = structuredClone(before);
      const selected = ids ?? Object.keys(before.skills).filter(id => before.skills[id].source);
      assert(Array.isArray(selected) && new Set(selected).size === selected.length, 'Select unique external skill IDs');
      for (const id of selected) assert(own(before.skills, id) && before.skills[id].source, `Not an external skill: ${id}`);
      this.preflight(before, f => restore && selected.includes(f.skill) && (
        ['payload-modified', 'missing'].includes(f.status) ||
        (f.status === 'invalid-entry' && !exists(join(this.path(f.skill, before.skills[f.skill]), 'SKILL.md')))
      ));
      const replacements = [];
      for (const id of selected) {
        const skill = before.skills[id];
        const fetched = this.fetch(tx, before, skill.source.id, skill.source.path, restore ? skill.source.revision : undefined);
        const staged = fs.mkdtempSync(join(tx.workspace, 'payload-')); fs.cpSync(fetched.path, staged, { recursive: true });
        const target = this.path(id, skill), metadata = safePath(this.root, join(target, 'agents/openai.yaml'));
        const nextMetadata = join(staged, 'agents/openai.yaml');
        if (exists(metadata)) { fs.mkdirSync(dirname(nextMetadata), { recursive: true }); fs.copyFileSync(metadata, nextMetadata); }
        else if (skill.hashes.metadata === null || !restore) fs.rmSync(nextMetadata, { force: true });
        after.skills[id].source.revision = fetched.revision; after.skills[id].hashes = hashes(staged);
        if (restore) {
          assert(after.skills[id].hashes.payload === skill.hashes.payload, 'Source no longer reproduces registered payload');
          assert(after.skills[id].hashes.metadata === skill.hashes.metadata, 'Missing or changed local metadata cannot be reconstructed from upstream; restore it from version control first');
        }
        replacements.push({ target, staged });
      }
      for (const { target, staged } of replacements) tx.replace(target, staged);
      return this.finish(tx, before, after);
    });
  }
  move(id, categoryId) {
    return this.mutate(tx => {
      const before = this.read(); this.preflight(before); assert(own(before.skills, id), `Unknown skill: ${id}`);
      const after = structuredClone(before);
      if (categoryId === undefined) delete after.skills[id].categoryId; else after.skills[id].categoryId = categoryId;
      validateRegistry(after);
      const old = this.path(id, before.skills[id]), target = this.path(id, after.skills[id]);
      if (old !== target) {
        assert(!exists(target), `Destination exists: ${target}`);
        tx.replace(target, old); tx.replace(old, null, 'remove');
      }
      return this.finish(tx, before, after);
    });
  }
  remove(id) {
    return this.mutate(tx => {
      const before = this.read(); this.preflight(before); assert(own(before.skills, id), `Unknown skill: ${id}`);
      const after = structuredClone(before); delete after.skills[id]; validateRegistry(after);
      const target = this.path(id, before.skills[id]); tx.replace(target, null, 'remove');
      return this.finish(tx, before, after);
    });
  }
  resolveRef(source, revision) {
    const ref = revision ?? source.ref ?? 'HEAD';
    if (revisionPattern.test(ref)) return ref;
    const patterns = ref === 'HEAD' || ref.startsWith('refs/') ? [ref, `${ref}^{}`] : [`refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`];
    const output = git(['ls-remote', '--', source.url.startsWith('.') ? resolve(this.root, source.url) : source.url, ...patterns]);
    const rows = output.split('\n').filter(Boolean).map(line => line.split(/\s+/));
    const named = rows.filter(([, name]) => !name.endsWith('^{}'));
    assert(named.length === 1, 'Missing or ambiguous remote ref; use a full ref');
    const peeled = rows.find(([, name]) => name === `${named[0][1]}^{}`);
    return peeled?.[0] ?? named[0][0];
  }
  check(id) {
    const r = this.read(), resolvedSources = new Map();
    if (id !== undefined) assert(own(r.skills, id), `Unknown skill: ${id}`);
    return Object.entries(r.skills).filter(([name, s]) => s.source && (id === undefined || name === id)).map(([name, s]) => {
      const source = r.sources[s.source.id];
      if (source.type === 'copy') {
        const actual = hashes(safePath(safePath(this.root, source.path), s.source.path));
        return { skill: name, status: actual.payload === s.source.revision ? 'current' : 'update-available' };
      }
      if (!resolvedSources.has(s.source.id)) resolvedSources.set(s.source.id, this.resolveRef(source));
      const revision = resolvedSources.get(s.source.id);
      return { skill: name, status: revision === s.source.revision ? (revisionPattern.test(source.ref ?? '') ? 'pinned' : 'current') : 'update-available', revision };
    });
  }
}
