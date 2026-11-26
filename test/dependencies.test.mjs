import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { SkillsManager, hashes } from '../src/index.mjs';

const cli = fileURLToPath(new URL('../bin/skillsx.mjs', import.meta.url));
const manifestPath = 'agents/skillsx.json';

function write(path, contents) {
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, contents);
}

function packageAt(root, path, body = 'Fixture') {
  const directory = join(root, path);
  const name = path.split('/').at(-1);
  write(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Fixture\n---\n${body}\n`);
  return directory;
}

function requires(directory, ...dependencies) {
  write(join(directory, manifestPath), `${JSON.stringify({ version: 1, dependencies }, null, 2)}\n`);
}

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commit(root) {
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'Fixture snapshot');
  return git(root, 'rev-parse', 'HEAD');
}

function fixture(t) {
  const temp = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'skillsx-deps-')));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = join(temp, 'consumer');
  fs.mkdirSync(root);
  const manager = new SkillsManager(root);
  manager.init();
  function source(id) {
    const upstream = join(temp, id);
    fs.mkdirSync(upstream);
    git(upstream, 'init', '-qb', 'main');
    git(upstream, 'config', 'user.name', 'Fixture');
    git(upstream, 'config', 'user.email', 'fixture@example.invalid');
    git(upstream, 'config', 'commit.gpgsign', 'false');
    git(upstream, 'config', 'core.hooksPath', '/dev/null');
    manager.configure('sources', id, { type: 'git', url: upstream, ref: 'main' });
    return upstream;
  }
  return { root, manager, source };
}

function install(manager, id, sourceId = 'upstream', options = {}) {
  return manager.install(id, { sourceId, sourcePath: `skills/${id}`, ...options });
}

test('CLI install follows the pinned snapshot through a diamond and keeps a matching categorized dependency', t => {
  const { root, manager, source } = fixture(t);
  const upstream = source('upstream');
  manager.configure('categories', 'external', {});
  manager.agent('claude-code', {});
  manager.agent('junie', { transport: 'copy' });

  const review = packageAt(upstream, 'skills/review');
  requires(review, { path: 'skills/review-code' }, { path: 'skills/review-tests' });
  requires(packageAt(upstream, 'skills/review-code'), { path: 'skills/verify-changes' });
  requires(packageAt(upstream, 'skills/review-tests'), { path: 'skills/verify-changes' });
  packageAt(upstream, 'skills/verify-changes', 'Original dependency');
  const pin = commit(upstream);

  install(manager, 'verify-changes', 'upstream', { categoryId: 'external', revision: pin });
  const existing = manager.read().skills['verify-changes'];
  packageAt(upstream, 'skills/verify-changes', 'Later dependency');
  assert.notEqual(commit(upstream), pin);

  execFileSync(process.execPath, [cli, 'install', 'review', '--root', root, '--source', 'upstream', '--path', 'skills/review', '--category', 'external', '--revision', pin]);
  const registry = manager.read();
  assert.deepEqual(Object.keys(registry.skills).sort(), ['review', 'review-code', 'review-tests', 'verify-changes']);
  assert.deepEqual(registry.skills['verify-changes'], existing);
  assert.equal(registry.skills.review.categoryId, 'external');
  for (const id of ['review-code', 'review-tests']) {
    assert.equal(registry.skills[id].categoryId, undefined);
    assert.equal(fs.readlinkSync(join(root, '.claude/skills', id)), `../../.agents/skills/${id}`);
    assert.deepEqual(hashes(join(root, '.junie/skills', id)), registry.skills[id].hashes);
  }
  for (const entry of Object.values(registry.skills)) assert.equal(entry.source.revision, pin);
  assert.deepEqual(fs.readFileSync(join(root, '.agents/skills/external/review', manifestPath)), fs.readFileSync(join(review, manifestPath)));
  assert.equal(manager.verify().ok, true);
});

test('a registered external URL uses the explicit pin for its package and relative dependencies', t => {
  const { manager, source } = fixture(t);
  const upstream = source('upstream');
  const helpers = source('helpers');
  requires(packageAt(helpers, 'library/helper'), { path: 'library/common' });
  packageAt(helpers, 'library/common', 'First version');
  const pin = commit(helpers);
  packageAt(helpers, 'library/common', 'New version');
  const latest = commit(helpers);
  requires(packageAt(upstream, 'skills/review'), { url: helpers, path: 'library/helper', revision: pin });
  commit(upstream);

  install(manager, 'review');
  const { skills } = manager.read();
  assert.deepEqual(skills.helper.source, { id: 'helpers', path: 'library/helper', revision: pin });
  assert.deepEqual(skills.common.source, { id: 'helpers', path: 'library/common', revision: pin });
  assert.notEqual(skills.common.source.revision, latest);
  assert.match(fs.readFileSync(join(manager.path('common', skills.common), 'SKILL.md'), 'utf8'), /First version/);

  assert.deepEqual(manager.check('common'), [{ skill: 'common', status: 'pinned', revision: pin }]);
  manager.updateAll();
  assert.deepEqual(manager.read().skills, skills);
  fs.renameSync(helpers, `${helpers}-offline`);
  assert.equal(manager.verify().ok, true);

  skills.common.source.revision = latest;
  write(manager.registryPath, JSON.stringify({ ...manager.read(), skills }));
  assert.throws(() => manager.check('review'), /dependency-conflict/);
});

test('only the exact regular manifest file is interpreted', t => {
  const { manager, source } = fixture(t);
  const upstream = source('upstream');
  const first = packageAt(upstream, 'skills/first');
  const second = packageAt(upstream, 'skills/second');
  const third = packageAt(upstream, 'skills/third');
  write(join(first, 'agents'), 'Ordinary payload');
  write(join(second, 'agents/SkillsX.json'), 'Ordinary payload');
  write(join(third, 'agents/skillsx.json/README.md'), 'Ordinary payload');
  commit(upstream);

  for (const id of ['first', 'second', 'third']) install(manager, id);
  assert.equal(manager.verify().ok, true);
});

test('CLI escapes terminal controls from invalid manifest fields', t => {
  const { root, manager, source } = fixture(t);
  const upstream = source('upstream');
  const review = packageAt(upstream, 'skills/review');
  write(join(review, manifestPath), JSON.stringify({ version: 1, dependencies: [{ '\u001b[2J': true }] }));
  commit(upstream);

  const result = spawnSync(process.execPath, [cli, 'install', 'review', '--root', root, '--source', 'upstream', '--path', 'skills/review'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stderr.includes('\u001b'), false);
  assert.equal(result.stderr.includes('\\u001b[2J'), true);
  assert.deepEqual(manager.read().skills, {});
});

test('a second registered ID for a required URL is rejected and check detects an incompatible recorded pin', t => {
  const { manager, source } = fixture(t);
  const upstream = source('upstream');
  const helpers = source('helpers');
  packageAt(helpers, 'skills/helper', 'Required version');
  const pin = commit(helpers);
  packageAt(helpers, 'skills/helper', 'Unrelated version');
  const other = commit(helpers);
  requires(packageAt(upstream, 'skills/review'), { url: helpers, path: 'skills/helper', revision: pin });
  commit(upstream);
  install(manager, 'review');

  const baseline = fs.readFileSync(manager.registryPath);
  assert.throws(() => manager.configure('sources', 'alias', { type: 'git', url: helpers, ref: 'main' }), /ambiguous|helper/i);
  assert.deepEqual(fs.readFileSync(manager.registryPath), baseline);
  const registry = manager.read();
  assert.equal(Object.hasOwn(registry.sources, 'alias'), false);
  assert.deepEqual(manager.check('helper'), [{ skill: 'helper', status: 'pinned', revision: pin }]);
  assert.equal(manager.verify().ok, true);

  registry.skills.helper.source.revision = other;
  write(manager.registryPath, JSON.stringify(registry));
  assert.throws(() => manager.check('helper'), /conflict|revision|helper/i);
  assert.throws(() => manager.check('review'), /conflict|revision|helper/i);
});

test('failed graph resolution leaves old installations, agent projections and registry unchanged', async t => {
  const cases = [
    ['cycle', ({ review, helper }) => {
      requires(review, { path: 'skills/helper' });
      requires(helper, { path: 'skills/review' });
    }, /cycle|circular/i],
    ['missing path', ({ review }) => {
      requires(review, { path: 'skills/helper' }, { path: 'skills/missing' });
    }, /missing|not found|no such file/i],
    ['invalid path', ({ review }) => {
      requires(review, { path: '../helper' });
    }, /path|manifest/i],
    ['invalid manifest', ({ review }) => {
      write(join(review, manifestPath), '{');
    }, /manifest|json/i],
    ['unregistered URL', ({ root, review, pin }) => {
      requires(review, { url: join(root, 'unregistered-source'), path: 'skills/helper', revision: pin });
    }, /source|url/i],
    ['conflicting path with the same ID', ({ upstream, review }) => {
      packageAt(upstream, 'other/helper');
      requires(review, { path: 'skills/helper' }, { path: 'other/helper' });
    }, /helper|conflict/i],
    ['incompatible existing revision', ({ review, manager, pin }) => {
      install(manager, 'helper', 'upstream', { revision: pin });
      requires(review, { path: 'skills/helper' });
    }, /helper|revision/i],
    ['distinct existing source', ({ review, manager, source }) => {
      const other = source('other');
      packageAt(other, 'skills/helper');
      commit(other);
      install(manager, 'helper', 'other');
      requires(review, { path: 'skills/helper' });
    }, /helper|source/i]
  ];

  for (const [name, arrange, error] of cases) {
    await t.test(name, subtest => {
      const { root, manager, source } = fixture(subtest);
      const upstream = source('upstream');
      manager.agent('claude-code', {});
      packageAt(upstream, 'skills/installed');
      const helper = packageAt(upstream, 'skills/helper');
      const pin = commit(upstream);
      install(manager, 'installed');
      const review = packageAt(upstream, 'skills/review');
      arrange({ root, upstream, review, helper, pin, manager, source });
      commit(upstream);
      const registry = fs.readFileSync(manager.registryPath);
      const previousSkills = fs.readdirSync(join(root, '.agents/skills')).sort();
      const previousLinks = fs.readdirSync(join(root, '.claude/skills')).sort();

      assert.throws(() => install(manager, 'review'), error);
      assert.deepEqual(fs.readFileSync(manager.registryPath), registry);
      assert.deepEqual(fs.readdirSync(join(root, '.agents/skills')).sort(), previousSkills);
      assert.deepEqual(fs.readdirSync(join(root, '.claude/skills')).sort(), previousLinks);
      assert.equal(fs.existsSync(join(root, '.agents/.skillsx-transaction')), false);
      assert.equal(manager.verify().ok, true);
    });
  }
});

test('remove protects dependencies and verify reports a missing registered edge without rewriting state', t => {
  const { manager, source } = fixture(t);
  const upstream = source('upstream');
  packageAt(upstream, 'skills/helper');
  requires(packageAt(upstream, 'skills/review'), { path: 'skills/helper' });
  commit(upstream);
  install(manager, 'review');

  const before = fs.readFileSync(manager.registryPath);
  assert.throws(() => manager.remove('helper'), /review|depend/i);
  assert.deepEqual(fs.readFileSync(manager.registryPath), before);
  const registry = manager.read();
  fs.rmSync(manager.path('helper', registry.skills.helper), { recursive: true });
  delete registry.skills.helper;
  write(manager.registryPath, JSON.stringify(registry));
  const invalid = fs.readFileSync(manager.registryPath);
  const report = manager.verify();
  assert.equal(report.ok, false);
  assert.match(JSON.stringify(report.findings), /helper/);
  assert.deepEqual(fs.readFileSync(manager.registryPath), invalid);
});

test('update respects other installed pins, installs the new closure and retains unused packages', t => {
  const { root, manager, source } = fixture(t);
  const upstream = source('upstream');
  const helpers = source('helpers');
  packageAt(helpers, 'skills/helper', 'Old helper');
  const initialPin = commit(helpers);
  const review = packageAt(upstream, 'skills/review');
  packageAt(upstream, 'skills/orphan');
  requires(review, { url: helpers, path: 'skills/helper', revision: initialPin }, { path: 'skills/orphan' });
  const initialReview = commit(upstream);
  install(manager, 'review');
  requires(packageAt(root, '.agents/skills/peer'), { url: helpers, path: 'skills/helper', revision: initialPin });
  manager.register('peer');

  requires(packageAt(helpers, 'skills/helper', 'Updated helper'), { path: 'skills/new-leaf' });
  packageAt(helpers, 'skills/new-leaf');
  const updatedPin = commit(helpers);
  requires(review, { url: helpers, path: 'skills/helper', revision: updatedPin });
  const updatedReview = commit(upstream);

  const withPeer = fs.readFileSync(manager.registryPath);
  assert.throws(() => manager.update('review'), /peer|dependency|pin|conflict/i);
  assert.deepEqual(fs.readFileSync(manager.registryPath), withPeer);
  assert.equal(manager.verify().ok, true);
  manager.remove('peer');
  manager.update('review');

  const { skills } = manager.read();
  assert.equal(skills.review.source.revision, updatedReview);
  assert.equal(skills.helper.source.revision, updatedPin);
  assert.equal(skills['new-leaf'].source.revision, updatedPin);
  assert.equal(skills.orphan.source.revision, initialReview);
  assert.match(fs.readFileSync(join(manager.path('helper', skills.helper), 'SKILL.md'), 'utf8'), /Updated helper/);
  assert.equal(manager.verify().ok, true);

  const baseline = fs.readFileSync(manager.registryPath);
  requires(review, { url: helpers, path: 'skills/helper', revision: updatedPin }, { path: 'skills/missing' });
  commit(upstream);
  assert.throws(() => manager.update('review'), /missing|not found|no such file/i);
  assert.deepEqual(fs.readFileSync(manager.registryPath), baseline);
  assert.equal(manager.verify().ok, true);
});

test('batch update rejects incompatible selected revisions before a targeted parent update applies its new pin', t => {
  const { root, manager, source } = fixture(t);
  const upstream = source('upstream');
  const helpers = source('helpers');
  manager.agent('junie', { transport: 'copy' });
  packageAt(helpers, 'skills/helper', 'Previously installed');
  commit(helpers);
  const review = packageAt(upstream, 'skills/review');
  commit(upstream);
  install(manager, 'helper', 'helpers');
  install(manager, 'review');

  packageAt(helpers, 'skills/helper', 'New declared pin');
  const pin = commit(helpers);
  packageAt(helpers, 'skills/helper', 'Tracked head');
  commit(helpers);
  requires(review, { url: helpers, path: 'skills/helper', revision: pin });
  const parentRevision = commit(upstream);

  const previous = fs.readFileSync(manager.registryPath);
  const before = manager.read().skills.helper;
  const helper = manager.path('helper', before);
  const copy = join(root, '.junie/skills/helper');
  assert.throws(() => manager.updateAll(), /conflict|revision|helper/i);
  assert.deepEqual(fs.readFileSync(manager.registryPath), previous);
  assert.deepEqual(hashes(helper), before.hashes);
  assert.deepEqual(hashes(copy), before.hashes);
  assert.equal(manager.verify().ok, true);

  manager.update('review');
  const { skills } = manager.read();
  assert.equal(skills.review.source.revision, parentRevision);
  assert.deepEqual(skills.helper.source, { ...before.source, revision: pin });
  assert.match(fs.readFileSync(join(helper, 'SKILL.md'), 'utf8'), /New declared pin/);
  assert.deepEqual(hashes(copy), skills.helper.hashes);
  assert.equal(manager.verify().ok, true);
});

test('batch update advances newly unpinned dependencies including the transitive chain', t => {
  const { manager, source } = fixture(t);
  const upstream = source('upstream');
  const review = packageAt(upstream, 'skills/review');
  const helper = packageAt(upstream, 'skills/helper');
  requires(review, { path: 'skills/helper' });
  requires(helper, { path: 'skills/common' });
  packageAt(upstream, 'skills/common', 'Initially pinned');
  commit(upstream);
  install(manager, 'review');

  requires(review);
  requires(helper);
  packageAt(upstream, 'skills/common', 'Now eligible to track the source');
  const latest = commit(upstream);
  manager.updateAll();

  const { skills } = manager.read();
  for (const id of ['review', 'helper', 'common']) assert.equal(skills[id].source.revision, latest);
  assert.equal(manager.verify().ok, true);
});

test('restoring the recorded root repairs missing transitive packages without advancing their revisions', t => {
  const { manager, source } = fixture(t);
  const upstream = source('upstream');
  const review = packageAt(upstream, 'skills/review');
  requires(review, { path: 'skills/helper' });
  requires(packageAt(upstream, 'skills/helper'), { path: 'skills/common' });
  packageAt(upstream, 'skills/common', 'Recorded');
  commit(upstream);
  install(manager, 'review');
  const before = manager.read();
  const common = manager.path('common', before.skills.common);
  fs.rmSync(common, { recursive: true });
  packageAt(upstream, 'skills/common', 'Latest');
  commit(upstream);

  manager.restoreAll(['review']);
  assert.match(fs.readFileSync(join(common, 'SKILL.md'), 'utf8'), /Recorded/);
  assert.deepEqual(manager.read(), before);
  assert.equal(manager.verify().ok, true);

  for (const id of ['review', 'helper', 'common']) fs.rmSync(manager.path(id, before.skills[id]), { recursive: true });
  manager.restoreAll(['review']);
  assert.deepEqual(manager.read(), before);
  assert.equal(manager.verify().ok, true);
});

test('a legacy package with an invalid manifest can be updated or removed', t => {
  const { manager, source } = fixture(t);
  const upstream = source('upstream');
  const review = packageAt(upstream, 'skills/review');
  write(join(review, manifestPath), '{}');
  const revision = commit(upstream);
  const registry = manager.read();
  // Before dependency support, an arbitrary JSON file was opaque payload.
  const entry = { source: { id: 'upstream', path: 'skills/review', revision }, hashes: hashes(review) };
  const directory = manager.path('review', entry);
  const installLegacy = () => {
    fs.cpSync(review, directory, { recursive: true });
    write(manager.registryPath, JSON.stringify({ ...registry, skills: { review: entry } }));
  };
  installLegacy();
  assert.equal(manager.verify().findings[0].status, 'invalid-dependency-manifest');
  manager.remove('review');
  assert.equal(manager.verify().ok, true);

  installLegacy();
  requires(review);
  const fixed = commit(upstream);
  manager.update('review');
  assert.equal(manager.read().skills.review.source.revision, fixed);
  assert.equal(manager.verify().ok, true);
});

test('an older installation can register its missing Git source before installing the dependency', t => {
  const { manager, source } = fixture(t);
  const upstream = source('upstream');
  const helpers = source('helpers');
  packageAt(helpers, 'skills/helper');
  const pin = commit(helpers);
  const review = packageAt(upstream, 'skills/review');
  requires(review, { url: helpers, path: 'skills/helper', revision: pin });
  const revision = commit(upstream);

  const registry = manager.read();
  const helperSource = registry.sources.helpers;
  delete registry.sources.helpers;
  const entry = { source: { id: 'upstream', path: 'skills/review', revision }, hashes: hashes(review) };
  fs.cpSync(review, manager.path('review', entry), { recursive: true });
  write(manager.registryPath, JSON.stringify({ ...registry, skills: { review: entry } }));
  assert.equal(manager.verify().findings[0].status, 'invalid-dependency-manifest');

  manager.configure('sources', 'helpers', helperSource);
  assert.equal(manager.verify().findings[0].status, 'dependency-missing');
  install(manager, 'helper', 'helpers', { revision: pin });
  assert.equal(manager.verify().ok, true);
});

test('own package registration and recording validate existing pins offline without installing missing packages', t => {
  const { root, manager, source } = fixture(t);
  const upstream = source('upstream');
  packageAt(upstream, 'skills/helper');
  packageAt(upstream, 'skills/not-installed');
  const pin = commit(upstream);
  install(manager, 'helper');
  fs.renameSync(upstream, `${upstream}-offline`);

  const project = packageAt(root, '.agents/skills/project');
  const helper = { url: upstream, path: 'skills/helper', revision: pin };
  const missing = { url: upstream, path: 'skills/not-installed', revision: pin };
  const initial = fs.readFileSync(manager.registryPath);
  requires(project, missing);
  assert.throws(() => manager.register('project'), /not-installed|depend/i);
  assert.deepEqual(fs.readFileSync(manager.registryPath), initial);
  requires(project, helper);
  manager.register('project');
  assert.equal(manager.verify().ok, true);
  const baseline = fs.readFileSync(manager.registryPath);
  requires(project, helper, missing);
  assert.throws(() => manager.record('project'), /not-installed|depend/i);
  assert.deepEqual(fs.readFileSync(manager.registryPath), baseline);
  requires(project, helper);
  fs.appendFileSync(join(project, 'SKILL.md'), 'Project edit\n');
  manager.record('project');
  assert.equal(manager.verify().ok, true);
  assert.deepEqual(Object.keys(manager.read().skills).sort(), ['helper', 'project']);
});
