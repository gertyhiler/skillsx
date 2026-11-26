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
const dependencyManifestPath = 'agents/skillsx.json';

function readDependencies(registry, skill, directory) {
  // Use directory entries so discovery has identical casing rules on every FS.
  if (!fs.readdirSync(directory, { withFileTypes: true }).some(entry => entry.name === 'agents' && entry.isDirectory())) return [];
  const entries = fs.readdirSync(safePath(directory, 'agents'), { withFileTypes: true });
  if (!entries.some(entry => entry.name === 'skillsx.json' && entry.isFile())) return [];
  const file = safePath(directory, dependencyManifestPath);
  const contents = fs.readFileSync(file, 'utf8');
  let manifest;
  try { manifest = JSON.parse(contents); } catch { throw new Error('Dependency manifest must contain valid JSON'); }
  fields(manifest, ['version', 'dependencies'], 'dependency manifest');
  assert(manifest.version === 1 && Array.isArray(manifest.dependencies), 'Expected dependency manifest version 1 and a dependencies array');
  const ids = new Set();
  return manifest.dependencies.map(dependency => {
    fields(dependency, ['url', 'path', 'revision'], 'dependency');
    const { url, path, revision } = dependency;
    subpath(path);
    const id = path.split('/').at(-1);
    name(id);
    assert(!ids.has(id), `Duplicate dependency: ${id}`);
    ids.add(id);
    if (!own(dependency, 'url')) {
      const source = skill.source;
      assert(!own(dependency, 'revision') && source && registry.sources[source.id].type === 'git', `Dependency ${id} needs a Git URL and revision outside a Git package`);
      return { id, source: { id: source.id, path, revision: source.revision } };
    }
    assert(typeof url === 'string' && url && typeof revision === 'string' && revisionPattern.test(revision), `Dependency ${id} requires a Git URL and full commit ID`);
    const matches = Object.keys(registry.sources).filter(key => registry.sources[key].type === 'git' && registry.sources[key].url === url);
    assert(matches.length === 1, matches.length ? `Ambiguous registered Git source for dependency ${id}` : `No registered Git source for dependency ${id}`);
    return { id, source: { id: matches[0], path, revision } };
  });
}

function sameSource(left, right) {
  return left?.id === right.id && left.path === right.path;
}

function sameRevision(left, right) {
  return sameSource(left, right) && left.revision === right.revision;
}

function dependencyFindings(registry, graph) {
  const findings = [];
  const active = new Set(), visited = new Set();
  function visit(skill) {
    if (visited.has(skill)) return;
    active.add(skill);
    for (const { id: target, source } of graph.get(skill) ?? []) {
      if (!own(registry.skills, target)) findings.push({ status: 'dependency-missing', skill, target });
      else if (!sameRevision(registry.skills[target].source, source)) findings.push({ status: 'dependency-conflict', skill, target });
      else if (active.has(target)) findings.push({ status: 'dependency-cycle', skill, target });
      else visit(target);
    }
    active.delete(skill);
    visited.add(skill);
  }
  for (const skill of graph.keys()) visit(skill);
  return findings;
}

function isDependencyFinding(finding) {
  return finding.status === 'invalid-dependency-manifest' || finding.status.startsWith('dependency-');
}

function dependencyTargets(registry, graph) {
  const targets = new Set();
  for (const dependencies of graph.values()) {
    for (const { id, source } of dependencies) {
      if (own(registry.skills, id) && sameRevision(registry.skills[id].source, source)) targets.add(id);
    }
  }
  return targets;
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
      const before = this.read(), after = structuredClone(before);
      after[type][id] = value;
      if (type === 'sources') {
        const dependencyErrors = r => this.inspect(r).findings.filter(isDependencyFinding);
        const alreadyInvalid = new Set(dependencyErrors(before).map(finding => finding.skill));
        const introduced = dependencyErrors(after).filter(finding => !alreadyInvalid.has(finding.skill));
        assert(!introduced.length, `Source configuration conflicts with installed dependencies: ${JSON.stringify(introduced)}`);
      }
      this.write(tx, after); return after;
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
  inspect(r) {
    validateRegistry(r);
    const findings = [], warnings = [];
    const add = (status, id, path, detail) => findings.push({ status, skill: id, path: relative(this.root, path).split(sep).join('/'), ...detail });
    const graph = new Map();
    const paths = new Map();
    for (const [id, skill] of Object.entries(r.skills)) {
      const path = this.path(id, skill); paths.set(path, id);
      if (!exists(path)) { add('missing', id, path); continue; }
      let actual;
      try { actual = hashes(path); } catch { add('invalid-entry', id, path); }
      if (actual) {
        if (actual.payload !== skill.hashes.payload) add('payload-modified', id, path);
        else {
          try { graph.set(id, readDependencies(r, skill, path)); }
          catch (error) { add('invalid-dependency-manifest', id, join(path, dependencyManifestPath), { reason: error.message }); }
        }
        if (actual.metadata !== skill.hashes.metadata) add('metadata-modified', id, path);
      }
      for (const [target, refinement] of Object.entries(skill.refines ?? {})) {
        const installed = r.skills[target].source?.revision ?? r.skills[target].hashes.payload;
        if (refinement.reviewedRevision !== installed) warnings.push({ status: 'refinement-review-needed', skill: id, target });
      }
    }
    for (const { status, skill, target } of dependencyFindings(r, graph)) {
      add(status, skill, join(this.path(skill, r.skills[skill]), dependencyManifestPath), { target });
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
    return { graph, findings, warnings };
  }
  verify(r = this.read()) {
    const { findings, warnings } = this.inspect(r);
    return { ok: findings.length === 0, findings, warnings };
  }
  preflight(r, allow = () => false) {
    const { graph, findings } = this.inspect(r);
    const failures = findings.filter(f => f.status !== 'agent-missing' && !allow(f));
    assert(failures.length === 0, `Registry drift or conflict: ${JSON.stringify(failures)}`);
    return graph;
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
        const resolved = this.resolveRef(source, revision);
        const commitKey = `${sourceId}:${resolved}`;
        cached = tx.sources.get(commitKey);
        if (!cached) {
          checkout = fs.mkdtempSync(join(tx.workspace, 'checkout-'));
          git(['init', '--quiet', checkout]);
          git(['-C', checkout, 'sparse-checkout', 'init', '--cone']);
          git(['-C', checkout, 'sparse-checkout', 'set', '--', sourcePath]);
          const url = source.url.startsWith('.') ? resolve(this.root, source.url) : source.url;
          git(['-C', checkout, 'remote', 'add', 'origin', url]);
          git(['-C', checkout, 'config', 'remote.origin.promisor', 'true']);
          git(['-C', checkout, 'config', 'remote.origin.partialclonefilter', 'blob:none']);
          git(['-C', checkout, 'fetch', '--quiet', '--filter=blob:none', '--depth=1', 'origin', resolved]);
          git(['-C', checkout, 'checkout', '--quiet', '--detach', 'FETCH_HEAD']);
          resolvedRevision = git(['-C', checkout, 'rev-parse', 'HEAD']);
          assert(resolvedRevision === resolved, 'Fetched revision differs from resolved source revision');
          cached = { checkout, resolvedRevision, paths: new Set([sourcePath]) };
          tx.sources.set(commitKey, cached);
        }
        tx.sources.set(key, cached);
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
    return { path, revision: resolvedRevision ?? digest.payload, hashes: digest };
  }
  stageExternal(tx, after, graph, staged, id, source, { categoryId, restore } = {}) {
    const previous = own(after.skills, id) ? after.skills[id] : undefined;
    const fetched = this.fetch(tx, after, source.id, source.path, source.revision);
    const skill = {
      ...(previous ?? (categoryId === undefined ? {} : { categoryId })),
      source: { id: source.id, path: source.path, revision: fetched.revision },
      hashes: fetched.hashes
    };
    const target = this.path(id, skill);
    let directory = fetched.path;
    if (previous) {
      directory = fs.mkdtempSync(join(tx.workspace, 'payload-'));
      fs.cpSync(fetched.path, directory, { recursive: true });
      const metadata = safePath(this.root, join(target, 'agents/openai.yaml'));
      const nextMetadata = join(directory, 'agents/openai.yaml');
      if (exists(metadata)) {
        fs.mkdirSync(dirname(nextMetadata), { recursive: true });
        fs.copyFileSync(metadata, nextMetadata);
      } else if (previous.hashes.metadata === null || !restore) fs.rmSync(nextMetadata, { force: true });
      skill.hashes = hashes(directory);
      if (restore) {
        assert(skill.hashes.payload === previous.hashes.payload, 'Source no longer reproduces registered payload');
        assert(skill.hashes.metadata === previous.hashes.metadata, 'Missing or changed local metadata cannot be reconstructed from upstream; restore it from version control first');
      }
    } else assert(!exists(target), `Destination already exists: ${target}`);
    try { graph.set(id, readDependencies(after, skill, directory)); }
    catch (error) { throw new Error(`Invalid dependency manifest for ${id}: ${error.message}`); }
    after.skills[id] = skill;
    staged.set(id, { target, directory });
  }
  stageDependencies(tx, after, graph, staged, mode) {
    const active = new Set(), visited = new Set();
    const visit = parent => {
      if (visited.has(parent)) return;
      active.add(parent);
      for (const { id, source } of graph.get(parent) ?? []) {
        assert(!active.has(id), `Dependency cycle: ${[...active, id].join(' → ')}`);
        const previous = own(after.skills, id) ? after.skills[id] : undefined;
        const matches = previous && sameRevision(previous.source, source);
        const canUpdate = mode === 'update' && sameSource(previous?.source, source);
        const requestedRevision = previous?.source?.revision;
        assert(!previous || matches || (canUpdate && !staged.has(id) && !visited.has(id)),
          `Dependency conflict: ${parent} requires ${id} at ${source.revision} from its declared source and path; selected or installed revision: ${requestedRevision ?? 'project-owned'}`);
        if (mode === 'restore') assert(matches, `Cannot restore dependency ${id} required by ${parent} without its recorded source and revision`);
        if (!matches || (mode === 'restore' && !graph.has(id))) {
          try { this.stageExternal(tx, after, graph, staged, id, source, { restore: mode === 'restore' }); }
          catch (error) { throw new Error(`Cannot resolve dependency ${id} required by ${parent}: ${error.message}`); }
        }
        visit(id);
      }
      active.delete(parent);
      visited.add(parent);
    };
    for (const id of staged.keys()) visit(id);
  }
  applyStaged(tx, before, after, graph, staged) {
    validateRegistry(after);
    const findings = dependencyFindings(after, graph);
    assert(!findings.length, `Dependency graph conflict: ${JSON.stringify(findings)}`);
    for (const { target, directory } of staged.values()) tx.replace(target, directory);
    return this.finish(tx, before, after);
  }
  install(id, { sourceId, sourcePath, categoryId, revision } = {}) {
    name(id);
    subpath(sourcePath);
    assert(sourcePath.split('/').at(-1) === id, 'Installed ID must match the source directory name');
    if (revision !== undefined) assert(revisionPattern.test(revision), 'Explicit revision must be a full Git commit ID');
    return this.mutate(tx => {
      const before = this.read(), after = structuredClone(before), staged = new Map();
      const graph = this.preflight(before, finding => finding.status === 'dependency-missing');
      assert(!own(before.skills, id), `Already registered: ${id}`);
      if (categoryId !== undefined) { name(categoryId); assert(own(after.categories, categoryId), `Unknown category: ${categoryId}`); }
      this.stageExternal(tx, after, graph, staged, id, { id: sourceId, path: sourcePath, revision }, { categoryId });
      this.stageDependencies(tx, after, graph, staged, 'install');
      return this.applyStaged(tx, before, after, graph, staged);
    });
  }
  update(id, { restore = false } = {}) { return this.reconcile([id], { restore }); }
  updateAll(ids) { return this.reconcile(ids); }
  restoreAll(ids) { return this.reconcile(ids, { restore: true }); }
  reconcile(ids, { restore = false } = {}) {
    return this.mutate(tx => {
      const before = this.read(), after = structuredClone(before), staged = new Map();
      const selected = ids ?? Object.keys(before.skills).filter(id => before.skills[id].source);
      assert(Array.isArray(selected) && new Set(selected).size === selected.length, 'Select unique external skill IDs');
      for (const id of selected) assert(own(before.skills, id) && before.skills[id].source, `Not an external skill: ${id}`);
      const graph = restore
        ? this.inspect(before).graph
        : this.preflight(before, finding => finding.status === 'dependency-missing' ||
          (isDependencyFinding(finding) && selected.includes(finding.skill)));
      let pending = selected;
      while (pending.length) {
        const pinned = restore ? new Set() : dependencyTargets(after, graph);
        const eligible = pending.filter(id => !pinned.has(id));
        if (!eligible.length) break;
        for (const id of eligible) {
          const source = before.skills[id].source;
          this.stageExternal(tx, after, graph, staged, id, { ...source, revision: restore ? source.revision : undefined }, { restore });
        }
        this.stageDependencies(tx, after, graph, staged, restore ? 'restore' : 'update');
        // An updated owner can release a pin and expose another selected root.
        pending = pending.filter(id => !staged.has(id));
      }
      if (restore) {
        this.preflight(before, f => staged.has(f.skill) && (
          ['payload-modified', 'missing'].includes(f.status) ||
          (f.status === 'invalid-entry' && !exists(join(this.path(f.skill, before.skills[f.skill]), 'SKILL.md')))
        ));
      }
      return this.applyStaged(tx, before, after, graph, staged);
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
      const before = this.read();
      assert(own(before.skills, id), `Unknown skill: ${id}`);
      const graph = this.preflight(before, finding => finding.skill === id && isDependencyFinding(finding));
      const dependents = [...graph].filter(([, dependencies]) => dependencies.some(dependency => dependency.id === id)).map(([parent]) => parent);
      assert(!dependents.length, `Cannot remove ${id}: required by ${dependents.join(', ')}`);
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
    const { graph, findings } = this.inspect(r);
    const scope = new Set(id === undefined ? [] : [id]);
    for (const skill of scope) {
      for (const dependency of graph.get(skill) ?? []) scope.add(dependency.id);
    }
    const errors = findings.filter(finding => isDependencyFinding(finding) &&
      (id === undefined || scope.has(finding.skill) || scope.has(finding.target)));
    assert(!errors.length, `Dependency graph conflict: ${JSON.stringify(errors)}`);
    const pinned = dependencyTargets(r, graph);
    return Object.entries(r.skills).filter(([name, s]) => s.source && (id === undefined || name === id)).map(([name, s]) => {
      if (pinned.has(name)) return { skill: name, status: 'pinned', revision: s.source.revision };
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
