# Registry v1

The only persistent authority is `<root>/.agents/skills.registry.json`. `root` is
the selected project directory or the user's home for explicit global operations.
There is no flat/nested mode, rename map or separate ownership state.

```json
{
  "version": 1,
  "categories": { "external": {}, "project": {} },
  "sources": {
    "personal": { "type": "git", "url": "https://github.com/example/skills.git", "ref": "main" }
  },
  "agents": { "claude-code": { "transport": "symlink" } },
  "skills": {
    "database": {
      "categoryId": "external",
      "source": {
        "id": "personal",
        "path": "skills/database",
        "revision": "0123456789abcdef0123456789abcdef01234567"
      },
      "hashes": {
        "payload": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "metadata": null
      }
    }
  }
}
```

The example's revision/hash are placeholders. Install/register computes real
values; manually inserting placeholder hashes does not authorize bootstrap.

## Identity and placement

Map keys are lowercase kebab-case identities. `skills.<name>` is unique across
categories. `categoryId` is optional, never null; it must reference `categories`.
Paths are derived, not independently configurable:

- no category: `.agents/skills/<name>`;
- category: `.agents/skills/<categoryId>/<name>`.

A flat skill cannot share a category ID. Categories have only an optional
`description`. Categories do not encode origin or permissions. No arbitrary
nested categories or skill renames are supported. Skill content, including its
frontmatter, is not rewritten or semantically validated. `SKILL.md` must exist;
its directory name determines identity. Nested SKILL.md example files are payload.

## Sources and ownership

A skill without `source` is project/user-authored. A skill with `source` is an
external immutable payload, regardless of its category.

Git sources have `type: git`, `url`, and optional `ref` (default remote HEAD).
Skill source records have `id`, a relative directory `path`, and a resolved full
Git commit `revision`. `check` and `update` use the configured ref unless a skill
dependency pins a revision. `restore` fetches the recorded revision.
Full commit refs remain pinned. Install, update and check share the same ref resolver;
annotated tags resolve to their peeled commit. A batch reuses one fetched snapshot
per source/ref. Dependency declarations can specify distinct exact commits.
Fetches request blob filtering and sparse checkout of selected directories. Git servers without
filter support may transfer the full snapshot. Each Git operation has a five-minute
timeout; failed operations do not accept a new registry baseline. Ambiguous remote branch/tag names are rejected;
use a full `refs/heads/...` or `refs/tags/...` reference.

Local sources have `type: copy` and a path relative to the selected root. Each
skill records the source payload hash as its revision. They have no historical
storage: restore succeeds only if the current source reproduces the recorded
payload. Root-directory skills (source path `.`), Git submodules, payload symlinks
and special files are not supported in v1. Git credentials belong in normal Git
credential/SSH configuration, never in registry URLs.

## Skill dependencies

A skill may declare its dependencies in `agents/skillsx.json`, a JSON object with
`version: 1` and a `dependencies` array. Each entry has one of these forms:

- `{ "path": "skills/report" }` uses the same Git source and resolved commit as
  the declaring skill. The declaring skill must come from Git.
- `{ "url": "https://github.com/example/skills.git", "path": "skills/report", "revision": "0123456789abcdef0123456789abcdef01234567" }`
  uses a full commit ID. The URL must match exactly one registered Git source.
  That source's configured ref has no effect on this pin.

Paths are relative to the source repository. The final directory name determines
the dependency ID. New dependencies are installed flat. A registered skill with
the same ID is reused when its Git source, path and revision match. A different
source, path or required revision for that ID is a conflict. Cycles are invalid.

The registry remains at version 1. Each installed dependency has an ordinary
registry entry with its resolved source, revision and hashes. The manifest itself
is a hashed payload file. `agents/openai.yaml` remains the optional consumer
interface file and retains its existing update rules.

- `install` resolves the full dependency graph and installs it atomically.
- `update` uses manifests from the selected packages' new revisions and applies
  their dependency changes in the same transaction. Pins from other installed
  dependents must still be satisfied. If a batch selects a previously independent
  package at its configured ref and another selected package introduces a
  different pin for it, the batch fails. Update the declaring package on its own
  to adopt the new pin. Packages that lose their last dependent stay installed
  until explicitly removed.
- `restore` restores the selected packages and their transitive dependencies
  from recorded revisions.
- `register` and `record` validate dependencies of own skills against compatible
  installed packages. These operations never fetch missing packages.
- `verify` reports absent or incompatible dependencies. `check` reports
  matching dependencies as pinned and rejects inconsistent declarations.
- `source` rejects configuration changes that break a previously valid installed
  dependency declaration.
- `remove` rejects removal of a package required by an installed skill.

## Hash contract

`hashes.payload` includes every regular file in the skill directory except the
exact path `agents/openai.yaml`. `hashes.metadata` is the SHA-256 of that file's
raw bytes, or null if absent. Adding or removing metadata changes its hash.

Payload hashing is deterministic: recursively traverse directory entries sorted
by UTF-8 byte order; normalize relative path separators to `/`. For each file,
feed an unsigned 64-bit big-endian byte length followed by UTF-8 path bytes, then
an unsigned 64-bit big-endian content length followed by content bytes into
SHA-256. Prefix the hex digest with `sha256:`. Do not normalize content or EOLs.
File permissions, timestamps and empty directories are not hashed. Configure Git
EOL handling consistently for managed files if using the same registry across OSes.

Hashes describe expected installed bytes; they do not authenticate an author,
validate scripts, or assess skill safety. Security auditing is outside this
contract. External payloads can change only through fetching their source.
`record --metadata` may accept a local interface-file change without accepting
payload drift. Updates preserve consumer metadata, including intentional absence.

## Lifecycle and verification

- `install`: fetch source, preserve its bytes, record source and hashes.
- `register`: register explicitly selected existing own directories at their derived paths.
- `record`: explicitly accept current bytes for the selected own skills. Never accepts external payload.
- `verify`: read-only comparison; never refreshes expected hashes.
- `check`: read-only source version lookup, no installation.
- `update`: fetch configured source revisions/refs atomically for the selected set, preserving consumer metadata.
- `restore`: restore selected recorded external payloads atomically (all if omitted); cannot recreate missing private metadata.
- `move`: change only category placement, updating agent projections.
- `sync`: reproduce missing agent links/copies from verified canonical files.
- `remove`: remove a registered unchanged skill and its projections together.

`verify` reports missing, modified, invalid and unregistered entries. The scan
stops at a skill directory; nested resources are part of its hash. No skill in
the canonical tree or configured agent directories is silently adopted. Manual
record deletion leaves an unregistered directory that blocks reconciliation.
Unknown ordinary files outside skill packages are not automatically deleted.

`refines` maps another registered skill name to `{ reviewedRevision }`. Compare
it to the external resolved revision or own payload hash. Mismatch is a warning,
not an automatic edit or quality judgement. Unknown references and cycles fail
registry validation. This metadata does not orchestrate agent execution.

## Agent projections

Each `agents.<id>` contains optional `path` and `transport`, resolved against the
built-in preset or required for a custom agent. Paths are `.name/skills` relative
to the selected root. Multiple agents cannot claim the same projection root.
Direct transport refers only to `.agents/skills`; it creates no extra files.
Other transports flatten categories into `<agent path>/<skill name>`.

Symlinks are relative and must point to the exact derived canonical directory.
Copies must match both expected hashes. Existing mismatches are conflicts.
Removing an adapter uses its previous registry entry to check and remove only
its exact projections. Manual configuration changes may leave old destinations
outside the newly declared management scope; prefer CLI transitions. Without
historical state, an undeclared old agent path cannot be inferred reliably.

Project and global stores are independent. Each command operates on one explicit
scope; agent-specific project/global precedence is not imposed by skillsx.

## Transactions

Writers create `.agents/.skillsx-transaction` exclusively. It temporarily holds
staged files, backups and rollback instructions, and disappears on success or
successful rollback. It is not a persistent authority and is never needed by a
fresh clone. Readers and other writers refuse an active/interrupted transaction.

Caught failures restore applied destinations and the registry. Abrupt process
termination/power loss may leave recovery files. Do not commit that directory or
simply delete backups: inspect rollback.json and restore from backups/version
control first. There is no automatic crash recovery in v1. External editors are
not locked by skillsx; avoid concurrent manual edits during mutations.
