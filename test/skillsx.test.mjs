import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { SkillsManager, hashes, validateRegistry } from '../src/index.mjs';
import { transaction, exists } from '../src/storage.mjs';

const cli = resolve('bin/skillsx.mjs');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'skillsx-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = new SkillsManager(root); manager.init();
  return { root, manager };
}
function write(path, value) { fs.mkdirSync(dirname(path), { recursive: true }); fs.writeFileSync(path, value); }
function skill(path, body = 'Version one') {
  write(join(path, 'SKILL.md'), `---\nname: example\ndescription: Example\n---\n${body}\n`);
  write(join(path, 'references/details.md'), 'Reference bytes\n');
  write(join(path, 'scripts/helper.mjs'), 'throw new Error("Do not execute installed scripts");\n');
  write(join(path, 'assets/binary.bin'), Buffer.from([0, 1, 2, 255]));
  return path;
}
function ownSkill(root, manager, id = 'example', options = {}) {
  const path = skill(join(root, '.agents/skills', options.categoryId ?? '', id));
  manager.register(id, options); return path;
}
function git(root, ...args) { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function external(t) {
  const { root, manager } = fixture(t), upstream = join(root, 'upstream');
  const path = skill(join(upstream, 'skills/example'));
  write(join(path, 'agents/openai.yaml'), 'interface:\n  display_name: Original\n');
  git(upstream, 'init', '-b', 'main');
  git(upstream, 'config', 'user.name', 'Fixture'); git(upstream, 'config', 'user.email', 'fixture@example.invalid');
  git(upstream, 'add', '.'); git(upstream, 'commit', '-m', 'Initial fixture');
  manager.configure('sources', 'fixture', { type: 'git', url: upstream, ref: 'main' });
  manager.configure('categories', 'external', {});
  manager.install('example', { sourceId: 'fixture', sourcePath: 'skills/example', categoryId: 'external' });
  return { root, manager, upstream, path, installed: join(root, '.agents/skills/external/example') };
}
function updateUpstream(upstream, path) {
  write(join(path, 'references/details.md'), 'New upstream reference\n');
  write(join(path, 'agents/openai.yaml'), 'interface:\n  display_name: Changed upstream\n');
  git(upstream, 'add', '.'); git(upstream, 'commit', '-m', 'Update fixture');
}

test('mixed flat and category placement; all unregistered skills fail verify', t => {
  const { root, manager } = fixture(t);
  manager.configure('categories', 'project', {});
  ownSkill(root, manager, 'flat'); ownSkill(root, manager, 'grouped', { categoryId: 'project' });
  assert.equal(manager.verify().ok, true);
  skill(join(root, '.agents/skills/project/untracked'));
  assert.deepEqual(manager.verify().findings.map(f => f.status), ['unregistered']);
  assert.throws(() => manager.sync(), /unregistered/);
});

test('hashes include nested files, names, binary bytes and frontmatter; metadata is separate', t => {
  const { root } = fixture(t); const path = skill(join(root, 'example')), baseline = hashes(path);
  write(join(path, 'agents/openai.yaml'), 'interface: {}\n');
  assert.equal(hashes(path).payload, baseline.payload); assert.notEqual(hashes(path).metadata, baseline.metadata);
  for (const file of ['references/details.md', 'scripts/helper.mjs', 'assets/binary.bin', 'SKILL.md']) {
    const original = fs.readFileSync(join(path, file));
    fs.appendFileSync(join(path, file), 'edit'); assert.notEqual(hashes(path).payload, baseline.payload);
    fs.writeFileSync(join(path, file), original);
  }
  fs.renameSync(join(path, 'references/details.md'), join(path, 'references/renamed.md'));
  assert.notEqual(hashes(path).payload, baseline.payload);
});

test('own changes require record; verify never modifies the registry', t => {
  const { root, manager } = fixture(t); const path = ownSkill(root, manager);
  const before = fs.readFileSync(manager.registryPath, 'utf8');
  fs.appendFileSync(join(path, 'SKILL.md'), 'Changed\n');
  assert.equal(manager.verify().findings[0].status, 'payload-modified');
  assert.equal(fs.readFileSync(manager.registryPath, 'utf8'), before);
  manager.record('example'); assert.equal(manager.verify().ok, true);
});

test('source install preserves all payload bytes and local metadata across updates', t => {
  const { manager, upstream, path, installed } = external(t);
  assert.deepEqual(hashes(installed), hashes(path));
  write(join(installed, 'agents/openai.yaml'), 'interface:\n  display_name: Local\n');
  manager.record('example', { metadata: true });
  const before = fs.readFileSync(manager.registryPath, 'utf8');
  updateUpstream(upstream, path);
  assert.equal(manager.check()[0].status, 'update-available');
  assert.equal(fs.readFileSync(manager.registryPath, 'utf8'), before);
  manager.update('example');
  assert.equal(fs.readFileSync(join(installed, 'references/details.md'), 'utf8'), 'New upstream reference\n');
  assert.equal(fs.readFileSync(join(installed, 'agents/openai.yaml'), 'utf8'), 'interface:\n  display_name: Local\n');
  assert.equal(manager.verify().ok, true);
});

test('modified external payload cannot be recorded or overwritten; restore uses recorded revision', t => {
  const { manager, installed, upstream, path } = external(t);
  const baseline = hashes(installed);
  fs.appendFileSync(join(installed, 'references/details.md'), 'Local edit');
  assert.throws(() => manager.record('example'), /cannot be recorded/);
  assert.throws(() => manager.record('example', { metadata: true }), /payload-modified/);
  assert.throws(() => manager.update('example'), /payload-modified/);
  updateUpstream(upstream, path);
  manager.update('example', { restore: true });
  assert.deepEqual(hashes(installed), baseline);
});

test('relative links survive relocating a checkout without state', t => {
  const { root, manager } = fixture(t); manager.configure('categories', 'project', {});
  const path = ownSkill(root, manager, 'example', { categoryId: 'project' });
  manager.agent('claude-code', {});
  const target = join(root, '.claude/skills/example');
  assert.equal(fs.readlinkSync(target), '../../.agents/skills/project/example');
  const relocated = join(root, 'relocated'); fs.mkdirSync(relocated);
  for (const directory of ['.agents', '.claude']) fs.cpSync(join(root, directory), join(relocated, directory), { recursive: true, verbatimSymlinks: true });
  const other = new SkillsManager(relocated); assert.equal(other.verify().ok, true);
  assert.equal(exists(join(relocated, '.agents/.state')), false);
  assert.equal(exists(join(root, '.agents/.skillsx-transaction')), false);
  assert.equal(fs.readFileSync(join(target, 'SKILL.md'), 'utf8'), fs.readFileSync(join(path, 'SKILL.md'), 'utf8'));
});

test('copies are checked, missing projections are recreated, dirty copies are preserved', t => {
  const { root, manager } = fixture(t); ownSkill(root, manager);
  manager.agent('junie', { transport: 'copy' });
  const target = join(root, '.junie/skills/example');
  fs.rmSync(target, { recursive: true });
  assert.equal(manager.verify().findings[0].status, 'agent-missing'); manager.sync();
  fs.appendFileSync(join(target, 'SKILL.md'), 'Do not overwrite');
  assert.throws(() => manager.sync(), /agent-copy-modified/);
  assert.match(fs.readFileSync(join(target, 'SKILL.md'), 'utf8'), /Do not overwrite/);
});

test('record updates copies; category move updates relative links; removal cleans projections', t => {
  const { root, manager } = fixture(t); const path = ownSkill(root, manager);
  manager.agent('claude-code', {}); manager.agent('junie', { transport: 'copy' });
  fs.appendFileSync(join(path, 'SKILL.md'), 'New own content'); manager.record('example');
  assert.deepEqual(hashes(join(root, '.junie/skills/example')), hashes(path));
  manager.configure('categories', 'project', {}); manager.move('example', 'project');
  assert.equal(fs.readlinkSync(join(root, '.claude/skills/example')), '../../.agents/skills/project/example');
  assert.equal(exists(path), false); assert.equal(manager.verify().ok, true);
  manager.move('example'); assert.equal(exists(path), true);
  manager.remove('example');
  assert.equal(exists(path), false); assert.equal(exists(join(root, '.claude/skills/example')), false);
  assert.equal(exists(join(root, '.junie/skills/example')), false);
});

test('agent destination conflicts roll back configuration and leave files untouched', t => {
  const { root, manager } = fixture(t); ownSkill(root, manager);
  const foreign = skill(join(root, '.claude/skills/example'), 'Foreign installation');
  const before = fs.readFileSync(manager.registryPath, 'utf8');
  assert.throws(() => manager.agent('claude-code', {}), /conflict/);
  assert.equal(fs.readFileSync(manager.registryPath, 'utf8'), before);
  assert.match(fs.readFileSync(join(foreign, 'SKILL.md'), 'utf8'), /Foreign installation/);
});

test('registry rejects path escapes, category collisions, unknown fields and refinement cycles', t => {
  const { manager } = fixture(t); const r = manager.read();
  const h = { payload: `sha256:${'a'.repeat(64)}`, metadata: null };
  for (const invalid of [
    { ...r, mode: 'flat' },
    { ...r, categories: { '../external': {} } },
    { ...r, categories: { example: {} }, skills: { example: { hashes: h } } },
    { ...r, skills: { example: { categoryId: null, hashes: h } } },
    { ...r, agents: { other: { path: '../outside', transport: 'copy' } } },
    { ...r, skills: { a: { hashes: h, refines: { b: { reviewedRevision: 'x' } } }, b: { hashes: h, refines: { a: { reviewedRevision: 'x' } } } } }
  ]) assert.throws(() => validateRegistry(invalid));
});

test('payload links and symlinked destination parents are rejected', t => {
  const { root, manager } = fixture(t); const path = skill(join(root, '.agents/skills/example'));
  fs.symlinkSync(join(root, 'elsewhere'), join(path, 'link'));
  assert.throws(() => manager.register('example'), /symbolic|unregistered/);
  fs.unlinkSync(join(path, 'link')); manager.register('example');
  fs.mkdirSync(join(root, 'elsewhere')); fs.symlinkSync(join(root, 'elsewhere'), join(root, '.claude'));
  assert.throws(() => manager.agent('claude-code', {}), /symbolic link/);
  assert.equal(fs.readdirSync(join(root, 'elsewhere')).length, 0);
});

test('transaction failure restores files and registry; interrupted operation blocks writers', t => {
  const { root, manager } = fixture(t); ownSkill(root, manager);
  const before = fs.readFileSync(manager.registryPath);
  assert.throws(() => transaction(root, tx => {
    tx.replace(manager.registryPath, 'broken', 'file');
    tx.replace(join(root, '.agents/new-file'), 'partial', 'file');
    throw new Error('Injected failure');
  }), /Injected/);
  assert.deepEqual(fs.readFileSync(manager.registryPath), before);
  assert.equal(exists(join(root, '.agents/new-file')), false);
  fs.mkdirSync(join(root, '.agents/.skillsx-transaction'));
  assert.throws(() => manager.sync(), /interrupted/);
});

test('final verification failure rolls back canonical changes and projections', t => {
  const { root, manager } = fixture(t); const path = ownSkill(root, manager);
  manager.agent('junie', { transport: 'copy' }); manager.configure('categories', 'project', {});
  const before = fs.readFileSync(manager.registryPath), original = manager.verify.bind(manager);
  let calls = 0;
  manager.verify = (...args) => ++calls > 1 ? { ok: false, findings: [{ status: 'injected' }] } : original(...args);
  assert.throws(() => manager.move('example', 'project'), /Final verification/);
  assert.deepEqual(fs.readFileSync(manager.registryPath), before);
  assert.equal(exists(path), true); assert.equal(exists(join(root, '.agents/skills/project/example')), false);
  assert.equal(original().ok, true);
});

test('local copy source works without Git and external payload stays immutable', t => {
  const { root, manager } = fixture(t); const path = skill(join(root, 'vendor/skills/example'));
  manager.configure('sources', 'local', { type: 'copy', path: 'vendor' });
  manager.install('example', { sourceId: 'local', sourcePath: 'skills/example' });
  assert.equal(manager.verify().ok, true); assert.equal(manager.check()[0].status, 'current');
  fs.appendFileSync(join(path, 'SKILL.md'), 'New source');
  assert.equal(manager.check()[0].status, 'update-available'); manager.update('example');
  assert.equal(manager.verify().ok, true);
});

test('manual unregister leaves files detectable, never automatically deleted', t => {
  const { root, manager } = fixture(t); const path = ownSkill(root, manager);
  const r = manager.read(); delete r.skills.example; fs.writeFileSync(manager.registryPath, JSON.stringify(r));
  assert.equal(manager.verify().findings[0].status, 'unregistered');
  assert.throws(() => manager.sync(), /unregistered/); assert.equal(exists(path), true);
});

test('CLI validates arguments before mutation and selects explicit project/global roots', t => {
  const { root } = fixture(t), home = join(root, 'home'), project = join(root, 'project');
  fs.mkdirSync(home); fs.mkdirSync(project);
  const run = args => spawnSync(process.execPath, [cli, ...args], { cwd: project, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
  assert.notEqual(run(['init', '--category', 'external']).status, 0);
  assert.notEqual(run(['init', '--global', '--root', project]).status, 0);
  assert.equal(exists(join(project, '.agents')), false);
  assert.equal(run(['init', '--global']).status, 0);
  assert.equal(exists(join(home, '.agents/skills.registry.json')), true);
  assert.equal(exists(join(project, '.agents')), false);
  assert.equal(run(['init']).status, 0);
  const output = run(['verify', '--json']); assert.equal(output.status, 0); assert.equal(JSON.parse(output.stdout).ok, true);
});

test('refinement review warning follows upstream revision without rewriting own skill', t => {
  const { root, manager, upstream, path } = external(t);
  const revision = manager.read().skills.example.source.revision;
  const local = ownSkill(root, manager, 'project-example', { refines: { example: { reviewedRevision: revision } } });
  const before = hashes(local); updateUpstream(upstream, path); manager.update('example');
  assert.equal(manager.verify().warnings[0].status, 'refinement-review-needed');
  assert.deepEqual(hashes(local), before);
});

test('nested example SKILL.md is opaque payload, not a separate registration', t => {
  const { root, manager } = fixture(t); const path = skill(join(root, '.agents/skills/example'));
  write(join(path, 'references/template/SKILL.md'), 'A template, not an installed skill');
  manager.register('example'); assert.equal(manager.verify().ok, true);
});

test('missing custom metadata cannot be invented during restore', t => {
  const { manager, installed } = external(t);
  write(join(installed, 'agents/openai.yaml'), 'Local metadata not stored upstream');
  manager.record('example', { metadata: true });
  fs.rmSync(installed, { recursive: true });
  assert.throws(() => manager.update('example', { restore: true }), /cannot be reconstructed/);
  assert.equal(exists(installed), false);
});

test('full commit source pin installs reproducibly and refuses renamed source directories', t => {
  const { manager, upstream, path } = external(t);
  const original = manager.read().skills.example.source.revision;
  manager.configure('sources', 'fixture', { type: 'git', url: upstream, ref: original });
  updateUpstream(upstream, path);
  assert.equal(manager.check()[0].status, 'pinned');
  manager.update('example'); assert.equal(manager.read().skills.example.source.revision, original);
  assert.throws(() => manager.install('alias', { sourceId: 'fixture', sourcePath: 'skills/example' }), /must match/);
});

test('disabling agent removes only exact projections; no persistent state required', t => {
  const { root, manager } = fixture(t); ownSkill(root, manager);
  manager.agent('claude-code', {}); manager.agent('junie', { transport: 'copy' });
  manager.agent('claude-code');
  assert.equal(exists(join(root, '.claude/skills/example')), false);
  assert.equal(exists(join(root, '.junie/skills/example')), true);
  assert.equal(manager.verify().ok, true);
});

test('registry cannot authorize remote helpers or embed HTTP credentials', t => {
  const { manager } = fixture(t);
  for (const url of ['ext::sh -c echo', 'https://secret@example.invalid/repo.git', 'ssh://git:secret@example.invalid/repo.git', 'helper://example'])
    assert.throws(() => manager.configure('sources', 'unsafe', { type: 'git', url }));
});

test('readers refuse a registry while another process has an active transaction', t => {
  const { root, manager } = fixture(t);
  transaction(root, () => { assert.throws(() => manager.verify(), /transaction/); });
  assert.equal(manager.verify().ok, true);
});

test('registerMany and recordMany accept only explicitly selected own changes atomically', t => {
  const { root, manager } = fixture(t);
  const first = skill(join(root, '.agents/skills/prototype'));
  const second = skill(join(root, '.agents/skills/constructor'));
  manager.registerMany({ prototype: {}, constructor: {} });
  fs.appendFileSync(join(first, 'SKILL.md'), 'edit one');
  fs.appendFileSync(join(second, 'SKILL.md'), 'edit two');
  const registry = fs.readFileSync(manager.registryPath, 'utf8');
  assert.throws(() => manager.record('prototype'), /payload-modified/);
  assert.equal(fs.readFileSync(manager.registryPath, 'utf8'), registry);
  manager.recordMany(['prototype', 'constructor']); assert.equal(manager.verify().ok, true);
});

test('batch restore reconstructs multiple absent payloads, including deliberately absent metadata', t => {
  const { root, manager, upstream, path, installed } = external(t);
  const second = skill(join(upstream, 'skills/second'));
  git(upstream, 'add', '.'); git(upstream, 'commit', '-m', 'Second skill');
  manager.install('second', { sourceId: 'fixture', sourcePath: 'skills/second' });
  fs.unlinkSync(join(installed, 'agents/openai.yaml')); manager.record('example', { metadata: true });
  const expected = manager.read();
  fs.rmSync(installed, { recursive: true }); fs.rmSync(join(root, '.agents/skills/second'), { recursive: true });
  manager.restoreAll();
  assert.deepEqual(manager.read(), expected); assert.equal(manager.verify().ok, true);
  assert.equal(exists(join(installed, 'agents/openai.yaml')), false);
});

test('batch restoration supports saved metadata-only directories and refuses changing their bytes', t => {
  const { manager, installed } = external(t);
  write(join(installed, 'agents/openai.yaml'), 'Saved consumer metadata'); manager.record('example', { metadata: true });
  for (const entry of fs.readdirSync(installed)) if (entry !== 'agents') fs.rmSync(join(installed, entry), { recursive: true });
  manager.restoreAll(); assert.equal(manager.verify().ok, true);
  fs.unlinkSync(join(installed, 'SKILL.md')); write(join(installed, 'agents/openai.yaml'), 'Unrecorded edit');
  assert.throws(() => manager.restoreAll(), /cannot be reconstructed/);
  assert.equal(exists(join(installed, 'SKILL.md')), false);
});

test('ambiguous branch/tag refs are rejected for install and update; qualified annotated tags resolve commits', t => {
  const { manager, upstream, path } = external(t);
  git(upstream, 'tag', '-a', 'release', '-m', 'Annotated fixture');
  updateUpstream(upstream, path); git(upstream, 'branch', 'release');
  manager.configure('sources', 'fixture', { type: 'git', url: upstream, ref: 'release' });
  assert.throws(() => manager.update('example'), /ambiguous/);
  manager.remove('example');
  assert.throws(() => manager.install('example', { sourceId: 'fixture', sourcePath: 'skills/example' }), /ambiguous/);
  manager.configure('sources', 'fixture', { type: 'git', url: upstream, ref: 'refs/tags/release' });
  manager.install('example', { sourceId: 'fixture', sourcePath: 'skills/example' });
  assert.equal(manager.check()[0].status, 'current');
  assert.equal(manager.read().skills.example.source.revision, git(upstream, 'rev-parse', 'release^{commit}'));
});

test('batch update rolls back every selected skill if any source cannot be fetched', t => {
  const { root, manager, upstream, path, installed } = external(t);
  skill(join(upstream, 'skills/second')); git(upstream, 'add', '.'); git(upstream, 'commit', '-m', 'Second');
  manager.install('second', { sourceId: 'fixture', sourcePath: 'skills/second' });
  const r = manager.read();
  r.sources.broken = { type: 'git', url: join(root, 'does-not-exist') };
  r.skills.second.source.id = 'broken'; fs.writeFileSync(manager.registryPath, JSON.stringify(r));
  const before = hashes(installed); updateUpstream(upstream, path);
  assert.throws(() => manager.updateAll(), /Git/);
  assert.deepEqual(hashes(installed), before); assert.deepEqual(manager.read(), r);
});
