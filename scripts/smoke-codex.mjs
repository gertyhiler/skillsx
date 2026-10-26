#!/usr/bin/env node
// Optional native discovery test. No inference turns, credentials or skill execution.
import * as fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillsManager } from '../src/index.mjs';

const source = resolve(process.argv[2] ?? process.cwd());
const temp = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'skillsx-codex-')));
async function discover(root) {
  const child = spawn('codex', ['app-server', '--listen', 'stdio://'], { cwd: root, stdio: ['pipe', 'pipe', 'ignore'] });
  const pending = new Map(); let sequence = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const message = JSON.parse(line), item = pending.get(message.id);
    if (!item) return;
    clearTimeout(item.timer); pending.delete(message.id);
    if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message.result);
  });
  const fail = error => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  child.on('error', fail); child.on('exit', () => fail(new Error('Codex app-server exited')));
  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 40000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }
  try {
    await request('initialize', { clientInfo: { name: 'skillsx-smoke', title: 'SkillsX discovery smoke', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    const result = await request('skills/list', { cwds: [root], forceReload: true });
    const manager = new SkillsManager(root), r = manager.read();
    const expected = new Set(Object.entries(r.skills).map(([id, s]) => join(manager.path(id, s), 'SKILL.md')));
    const row = result.data.find(row => row.cwd === root) ?? result.data[0];
    const actual = new Set(row.skills.filter(s => s.path.startsWith(join(root, '.agents/skills') + '/')).map(s => s.path));
    const missing = [...expected].filter(path => !actual.has(path));
    const errors = row.errors.filter(e => e.path.startsWith(root));
    if (missing.length || errors.length || actual.size !== expected.size) throw new Error(`Discovery mismatch: ${missing.length} missing, ${errors.length} parser errors, ${actual.size}/${expected.size} found`);
    return { expected: expected.size, discovered: actual.size, parserErrors: errors.length };
  } finally { lines.close(); child.kill(); }
}
try {
  fs.mkdirSync(join(temp, '.agents'));
  fs.copyFileSync(join(source, '.agents/skills.registry.json'), join(temp, '.agents/skills.registry.json'));
  fs.cpSync(join(source, '.agents/skills'), join(temp, '.agents/skills'), { recursive: true });
  const r = JSON.parse(fs.readFileSync(join(temp, '.agents/skills.registry.json'))); r.agents = {};
  fs.writeFileSync(join(temp, '.agents/skills.registry.json'), JSON.stringify(r));
  execFileSync('git', ['init', '--quiet', temp]);
  const categorized = await discover(temp);
  const manager = new SkillsManager(temp), entry = Object.entries(r.skills).find(([id, s]) => s.categoryId && !Object.hasOwn(r.categories, id));
  if (!entry) throw new Error('Need at least one categorized skill for movement smoke');
  manager.move(entry[0]);
  const flattened = await discover(temp);
  console.log(JSON.stringify({ categorized, flattened }, null, 2));
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
