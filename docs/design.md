# Design and implementation boundaries

skillsx extracts the registry-first approach used in a private project into an
independent Node CLI and importable library. No private registries, credentials,
company skill payloads or project policies are included.

- `src/index.mjs`: registry validation, lifecycle, sources and agent projections.
- `src/storage.mjs`: deterministic hashes, safe paths, discovery and rollback.
- `bin/skillsx.mjs`: argument validation, scope selection and output.
- `schema/skills.registry.schema.json`: portable registry document shape.
- `test/skillsx.test.mjs`: filesystem behavior and disposable Git fixtures.
- `scripts/smoke-codex.mjs`: optional native Codex discovery on a disposable copy.

The original principles are retained: opaque upstream payloads, separate local
interface metadata, mandatory registration and explicit acceptance of own edits.
The implementation is intentionally synchronous with no runtime npm dependencies.

Agent path presets were checked against the public vercel-labs/skills agent
configuration on 2026-10-26:
https://github.com/vercel-labs/skills/blob/main/src/agents.ts
Their direct/copy/symlink approach is also a useful interoperability reference:
https://github.com/vercel-labs/skills/blob/main/src/installer.ts
The optional scripts/smoke-codex.mjs test calls the installed Codex app-server
skills/list protocol without inference. Codex CLI0.163.0 discovered all61 skills
in an integration fixture before and after a category-to-flat move. Supporting a
path mapping does not establish discovery in every version of other agents.
Protocol reference: https://developers.openai.com/codex/app-server

No automatic importer of the legacy project registry is shipped yet. Its package
records and fixed groups need an explicit migration; do not replace existing
consumer registries with this format in place without migration review.

Possible future work, outside v1: separate external-skill security audit,
additional tested agent adapters, automated crash recovery, source-root skills,
and an explicit legacy registry importer. There is no Python implementation,
background service or hidden state database.
