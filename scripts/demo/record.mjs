import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Record real CLI output in a disposable, offline fixture. Never execute a skill.
const repo = fileURLToPath(new URL('../../', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'skillsx-demo-'));
const events = [];
function run(args, expected = 0) {
  const result = spawnSync(process.execPath, [join(repo, 'bin/skillsx.mjs'), ...args], { cwd: root, encoding: 'utf8' });
  if (result.error || result.status !== expected) throw new Error(result.error?.message ?? result.stderr + result.stdout);
  events.push({ command: `skillsx ${args.join(' ')}`, output: (result.stdout + result.stderr).trim(), error: expected !== 0 });
}
try {
  mkdirSync(join(root, 'upstream/review'), { recursive: true });
  writeFileSync(join(root, 'upstream/review/SKILL.md'), '---\nname: review\ndescription: Review a change and report concrete findings.\n---\n\nRead the diff and report findings.\n');
  run(['init']);
  run(['category', 'external']);
  run(['source', 'demo', '--copy-path', 'upstream']);
  run(['install', 'review', '--source', 'demo', '--path', 'review', '--category', 'external']);
  run(['agent', 'claude-code', '--transport', 'symlink']);
  const target = readlinkSync(join(root, '.claude/skills/review'));
  events.push({ command: 'readlink .claude/skills/review', output: target });
  run(['move', 'review', '--uncategorized']);
  run(['verify']);
  appendFileSync(join(root, '.agents/skills/review/SKILL.md'), '\nUnexpected local edit.\n');
  events.push({ command: "printf '\\nUnexpected local edit.\\n' >> .agents/skills/review/SKILL.md", output: '' });
  run(['verify'], 1);
  const destination = resolve(process.argv[2] ?? join(repo, 'docs/assets/demo.json'));
  writeFileSync(destination, JSON.stringify({ title: 'SkillsX · one registry, every skill', events }, null, 2) + '\n');
  console.log(`Recorded ${events.length} real commands.`);
} finally { rmSync(root, { recursive: true, force: true }); }
