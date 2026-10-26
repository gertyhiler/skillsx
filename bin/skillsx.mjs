#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { SkillsManager, adapters } from '../src/index.mjs';

const help = `skillsx — registry-first skill management

  init
  category <id> [--description TEXT]
  source <id> --url URL [--ref REF]
  source <id> --copy-path PATH
  agent <id> [--transport direct|symlink|copy] [--agent-path PATH]
  agent-remove <id>
  install <name> --source ID --path PATH [--category ID] [--revision SHA]
  register <name...> [--category ID]
  record <name...> [--metadata]
  verify
  sync
  check [name]
  update [name]
  restore [name...]
  move <name> --category ID | --uncategorized
  remove <name>

Options: --root DIR (default cwd), --global (home), --json, --help, --version
No content rewriting, script execution, automatic adoption or hidden ownership state.
`;
const strings = ['root', 'description', 'url', 'ref', 'copy-path', 'transport', 'agent-path', 'source', 'path', 'category', 'revision'];
const booleans = ['global', 'json', 'help', 'version', 'metadata', 'uncategorized'];
try {
  const { values: v, positionals: p } = parseArgs({ options: Object.fromEntries([...strings.map(k => [k, { type: 'string' }]), ...booleans.map(k => [k, { type: 'boolean' }])]), allowPositionals: true, strict: true });
  if (v.help) { console.log(help); process.exit(0); }
  if (v.version) { console.log('0.1.0'); process.exit(0); }
  const [command, id] = p;
  if (!command) { console.log(help); process.exit(0); }
  const rules = {
    init: [0, []], category: [1, ['description']], source: [1, ['url', 'ref', 'copy-path']],
    agent: [1, ['transport', 'agent-path']], 'agent-remove': [1, []],
    install: [1, ['source', 'path', 'category', 'revision']], register: [-2, ['category']],
    record: [-2, ['metadata']], verify: [0, []], sync: [0, []], check: [-1, []], update: [-1, []],
    restore: [-3, []], move: [1, ['category', 'uncategorized']], remove: [1, []]
  };
  if (!Object.hasOwn(rules, command)) throw new Error(`Unknown command: ${command}`);
  const [count, flags] = rules[command];
  if ((count === -3 ? false : count === -2 ? p.length < 2 : count === -1 ? p.length > 2 : p.length !== count + 1)) throw new Error(`Invalid arguments for ${command}; see --help`);
  for (const key of Object.keys(v)) if (!['root', 'global', 'json'].includes(key) && !flags.includes(key)) throw new Error(`Unexpected --${key} for ${command}`);
  if (v.root && v.global) throw new Error('Choose --root or --global, not both');
  if (command === 'source' && (Boolean(v.url) === Boolean(v['copy-path']) || (v.ref && !v.url))) throw new Error('Use --url [--ref] or --copy-path');
  if (command === 'install' && (!v.source || !v.path)) throw new Error('install requires --source and --path');
  if (command === 'move' && (Boolean(v.category) === Boolean(v.uncategorized))) throw new Error('move requires --category or --uncategorized');
  const manager = new SkillsManager(v.global ? homedir() : v.root ?? process.cwd());
  let result;
  switch (command) {
    case 'init': result = manager.init(); break;
    case 'category': result = manager.configure('categories', id, v.description === undefined ? {} : { description: v.description }); break;
    case 'source': result = manager.configure('sources', id, v.url ? { type: 'git', url: v.url, ...(v.ref ? { ref: v.ref } : {}) } : { type: 'copy', path: v['copy-path'] }); break;
    case 'agent': result = manager.agent(id, { ...(v.transport ? { transport: v.transport } : {}), ...(v['agent-path'] ? { path: v['agent-path'] } : {}) }); break;
    case 'agent-remove': result = manager.agent(id); break;
    case 'install': result = manager.install(id, { sourceId: v.source, sourcePath: v.path, categoryId: v.category, revision: v.revision }); break;
    case 'register': result = manager.registerMany(Object.fromEntries(p.slice(1).map(name => [name, v.category === undefined ? {} : { categoryId: v.category }]))); break;
    case 'record': result = manager.recordMany(p.slice(1), { metadata: v.metadata }); break;
    case 'verify': result = manager.verify(); break;
    case 'sync': result = manager.sync(); break;
    case 'check': result = manager.check(id); break;
    case 'update': result = manager.updateAll(id ? [id] : undefined); break;
    case 'restore': result = manager.restoreAll(p.length > 1 ? p.slice(1) : undefined); break;
    case 'move': result = manager.move(id, v.category); break;
    case 'remove': result = manager.remove(id); break;
  }
  if (result?.ok === false) process.exitCode = 1;
  if (command === 'check' && result.some(r => r.status === 'update-available')) process.exitCode = 1;
  if (v.json) console.log(JSON.stringify(result, null, 2));
  else if (result?.ok !== undefined) {
    console.log(result.ok ? `${command}: OK` : `${command}: findings`);
    for (const finding of [...(result.findings ?? []), ...(result.warnings ?? [])]) console.log(`  ${finding.status}: ${finding.skill ?? finding.path}${finding.path && finding.skill ? ` (${finding.path})` : ''}`);
  } else console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`skillsx: ${error.message}`);
  process.exitCode = 1;
}
