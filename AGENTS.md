# skillsx

Node CLI and library for registry-first skill management. Read docs/contract.md
before changing behavior. Keep the registry as the only persistent authority;
never introduce hidden local ownership state. Skill content is opaque: do not
rewrite or execute external payloads. Categories are optional and one level deep.
Use node:test with disposable directories and local Git fixtures. Never change
real agent installations in tests. Run npm run check and npm pack --dry-run.
Documentation, code and commit messages are English. Do not publish packages or
create remote repositories without explicit authorization. Preserve upstream
copyright notices when copying implementation code.
