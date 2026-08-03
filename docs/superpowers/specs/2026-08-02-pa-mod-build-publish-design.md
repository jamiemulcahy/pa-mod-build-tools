# Design: `pa-mod-build publish`

Milestone 1 — [#2](https://github.com/jamiemulcahy/pa-mod-build-tools/issues/2). Agreed 2026-08-02.

This document records the decisions taken on top of #2, resolves that issue's open questions,
and is the reference the implementation plan is written against. Where it is silent, #2 stands.

## Resolved open questions

| Question | Decision |
|---|---|
| Package name | `pa-mod-build-tools`. Binary `pa-mod-build`. One name across repo, package and action. |
| `$schema` URL | Point at `main` now; repoint to `v1` as part of #5. The tool ignores the key, so an unpinned ref costs nothing but editor hints running ahead of the installed version. |
| Default target branch | `published-mod`. |
| Multiple mods per repo | **In scope.** `.modbuild` may describe more than one mod, and `target` moves into the config to make that possible. See below. |

## Multiple mods, and what it moves

A repo may ship a mod pack. One mod means one publish branch, so N mods mean N branches and a
single `--target` can no longer say where anything goes. `target` therefore becomes a property
of a mod, alongside `root` and `ignore`.

This moves the config split rather than breaking it. The rule is still that a key appears in
exactly one place, with no precedence to explain:

- **`.modbuild` describes the mods** — `root`, `ignore`, `target`.
- **The workflow describes the plumbing** — `source`, `config`, `dry-run`, `token`.

The internal model is a **list of mods from the first line of `config.js`**. The single-mod
config is normalised into a one-element list on load, so no module downstream of `config.js`
knows the single form exists. Building this in now is cheaper than retrofitting it: payload
resolution, publishing and reporting are each list-shaped or they are not.

## `.modbuild`

Plain JSON. Two accepted shapes.

```json
{
  "$schema": "https://raw.githubusercontent.com/jamiemulcahy/pa-mod-build-tools/main/schema/modbuild.schema.json",
  "root": "Mod",
  "ignore": [".jshintrc", "pachat.zip"],
  "target": "published-mod"
}
```

```json
{
  "$schema": "https://raw.githubusercontent.com/jamiemulcahy/pa-mod-build-tools/main/schema/modbuild.schema.json",
  "mods": [
    { "root": "mods/artillery", "target": "published-artillery" },
    { "root": "mods/economy", "target": "published-economy", "ignore": ["*.psd"] }
  ]
}
```

The multi form is an object wrapping a `mods` array rather than a bare top-level array, because
`$schema` cannot live in a JSON array. A bare array would drop editor autocompletion in exactly
the configs that most need it.

| Key | Where | Type | Default | Meaning |
|---|---|---|---|---|
| `$schema` | top level | string | — | Ignored by the tool. Editor support only. |
| `mods` | top level | object[] | — | Present for the multi-mod form. Mutually exclusive with `root`/`ignore`/`target`. |
| `root` | mod | string | `"."` | Directory whose **contents** become the publish branch root |
| `ignore` | mod | string[] | `[]` | `.gitignore` syntax, including negation, relative to `root` |
| `target` | mod | string | `"published-mod"` | Branch this mod publishes to |

### Validation rules

Every one of these fails the run. Typo protection matters more than brevity here — a silently
ignored key is the failure that burns a non-technical user.

- Top level must be a JSON object. An array or a scalar is an error naming the expected shape.
- Unknown keys are rejected at both levels. Allowed at top level: `$schema`, `mods`, `root`,
  `ignore`, `target`. Allowed in a `mods` entry: `root`, `ignore`, `target`.
- `mods` together with any of `root`/`ignore`/`target` is an error, not a merge.
- `mods` must be a non-empty array of objects.
- `target` defaults to `published-mod` **always**, and two mods may not share a target. A
  multi-mod config that omits `target` therefore fails with a message naming both mods. This is
  one uniqueness rule rather than a conditional-requiredness rule, which is easier to state and
  easier to read in an error.
- `root` must stay inside the repo — no absolute paths, no `..` escaping the root.
- `target` must be a valid branch name (`git check-ref-format --branch`).

`schema/modbuild.schema.json` expresses this as a `oneOf` over the two shapes. The schema is for
editors; `config.js` validates independently, because the tool cannot depend on the author's
editor having done so.

## Modules

```
package.json                # pa-mod-build-tools, bin: pa-mod-build
src/
  cli.js                    # argv + env parsing, subcommand dispatch, rendering, exit codes
  config.js                 # load, validate and normalise .modbuild -> Mod[]
  payload.js                # (fileList, mod) -> { included, excluded }   <- pure
  git.js                    # the only module under src/ that touches child_process
  publish.js                # orchestration + ref mechanics; returns a report, prints nothing
  summary.js                # report -> text                              <- pure
schema/modbuild.schema.json
test/
.github/workflows/ci.yml
```

Two boundaries are worth stating explicitly:

**`git.js` exists** because `publish.js` should read as branch logic, not `execFile` boilerplate.
Confining `child_process` to one module also means one place to get argument quoting, `-z`
parsing and error handling right, and one seam to substitute in unit tests.

**`publish.js` returns a report object and performs no output.** `cli.js` renders it through
`summary.js` and decides between `$GITHUB_STEP_SUMMARY` and stdout. The whole pipeline is
therefore callable from a test without spawning a process, and the action stays a thin adapter
because there is nothing for it to adapt to but the same function.

- Node 20+, ESM.
- One runtime dependency: [`ignore`](https://www.npmjs.com/package/ignore).
- No `simple-git`. `node:child_process.execFile`.
- `node:test` + `node:assert`. No test-framework dependency.

## Payload resolution

1. Resolve `--source` to a commit sha.
2. Enumerate the tree **once** for the whole run: `git ls-tree -r -z <sha>`, giving mode, blob
   sha and path for every tracked file.
3. Per mod, `payload.js` filters that list: restrict to `root`, apply `ignore` patterns matched
   against paths relative to `root`, and strip the `root` prefix —
   `Mod/ui/mods/pa-chat/chat.js` → `ui/mods/pa-chat/chat.js`.

### Why `ls-tree` and not `ls-files`

#2 specifies `git ls-files`. That reads the **index**, not a ref, so it ignores `--source`
entirely and resolves whatever happens to be staged in the checkout. `ls-tree <sha>` is what
"read the source branch" actually means. It keeps the git-tracked-only guarantee that makes a
stray `node_modules/` unable to leak into a published mod, strengthens it — uncommitted local
edits cannot leak either — and returns the blob shas that publishing needs anyway.

### Nothing is stripped by default

Unchanged from #2. There is no built-in denylist; a file ships unless `.modbuild` says
otherwise. Sensible defaults reach authors through the starter `.modbuild` in #4, where every
rule lives in a file the author owns and can edit or delete.

## Publishing

Per mod, and entirely ref-to-ref. Nothing is written to the working tree and no worktree is
created.

**Every mod is resolved and validated before any ref is written.** A config error, a missing
`root` or an empty payload on the second mod must not leave the first one published — a run
either publishes all of its mods or none of them.

```
included files (mode, blob sha, rewritten path)
  -> git update-index --index-info      (paths on stdin, temp GIT_INDEX_FILE)
  -> git write-tree                     -> new tree sha
  -> compare with target tip's tree sha -> equal? stop, no commit
  -> git commit-tree <tree> [-p <tip>]  -> commit sha
  -> git update-ref refs/heads/<target>
  -> git push origin <target>
```

### Why plumbing rather than a temporary worktree

#2's implementation note suggests a temp `git worktree`. Plumbing is the smaller thing, not the
cleverer one — this is a ref-to-ref operation, and a worktree materialises every file onto disk
only to have them read straight back into the object store.

- **"Skip when the tree is unchanged" becomes exact and cheap.** It is a sha comparison, correct
  by construction, rather than a diff that has to be trusted.
- **The caller's checkout is untouched more strongly than a worktree manages.** The only thing
  written outside the object store is a temp index file, addressed via `GIT_INDEX_FILE`.
- **Path rewriting is free.** Index entries are written with the `root` prefix already stripped.
- **`--index-info` takes its input on stdin**, so there is no command-line length ceiling — which
  is a real constraint on Windows for a large mod.
- **It likely removes `fetch-depth: 0`** from every mod author's workflow, which is #3's first
  open question. The operation needs the source commit and the target ref and nothing else, both
  available from a shallow fetch. To be confirmed during implementation, but plumbing is what
  makes it reachable.
- **Published blobs are byte-identical to source blobs.** Nothing passes through a working tree,
  so no `.gitattributes` eol conversion is applied. A worktree checkout would apply it, and this
  repo sets `text=auto eol=lf` — so the plumbing path removes a real risk of publishing files
  whose line endings differ from the source.

The chain was proven end to end against a clone of PaChat before this design was accepted: 39 of
147 tracked files published, `root` prefix stripped, orphan commit parentless, an unchanged
second run detected by tree-sha comparison, the caller's index and working tree untouched, and
the resulting ref pushed to a remote.

### Ref resolution

- **Source** — `--source`, defaulting to current `HEAD`. Committed work only.
- **Target** — prefer `origin/<target>` (fetched), fall back to a local branch of that name, and
  create an **orphan** if neither exists. Preferring the remote means a local run and an Actions
  run produce the same commit from the same input, which is the premise of shipping the CLI
  before the action. It also makes a stale local `published-mod` unable to cause a bad publish.
- The branch **accumulates history and is never force-pushed**. Anyone who has cloned it keeps
  working, and it reads as a record of releases. The tree is replaced wholesale each run, so
  merge conflicts are structurally impossible.
- **Refuse to run when a mod's target is the same branch as the source.**

### Commits

- Message references the source commit and the mod version: `Publish mod v1.6.6 from a1b2c3d`.
  Version is read from the payload's `modinfo.json` when present, and omitted when it is not.
- Committer identity is `github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>`
  when `GITHUB_ACTIONS` is set, via `GIT_AUTHOR_*`/`GIT_COMMITTER_*`; the local git identity
  otherwise.

### Pushing

Push is the default, local and CI alike — one code path, and `--dry-run` is the look-first mode.
`--no-push` commits locally without pushing. When no remote is configured, the run commits and
the report says plainly that nothing was pushed, rather than failing.

`--dry-run` creates no commit, moves no ref and pushes nothing. It does still *fetch* the target
branch and build the candidate tree, because a report that cannot see both cannot tell the author
whether their next real run would produce a commit. Building the tree writes unreferenced tree
objects, which are unreachable and collected by `git gc` — the repository's visible state is
unchanged, but "writes nothing at all" would be an overclaim.

## Reporting

Written to `$GITHUB_STEP_SUMMARY` when set, stdout otherwise. Same renderer, same content.

Per run: source ref and sha, config path, and whether this was a dry run.

Per mod: root, target branch, resulting commit sha or `no changes — nothing to publish`, payload
file count and total size, and every excluded path with the `.modbuild` rule that matched it.
File sizes come from `git cat-file --batch-check` over the blob shas, so nothing is read from
disk.

**Warning when `modinfo.json` is absent from the payload root.** This is not mod validation —
that is deliberately out of v1 — but its absence almost always means the wrong `root` was
resolved. When a `modinfo.json` exists deeper inside the payload, the warning names it, because
`found at ui/mods/x/modinfo.json` diagnoses the mistake in one line.

## Errors

All exit non-zero with a message naming the file and the fix.

| Condition | Notes |
|---|---|
| `.modbuild` missing | Point at the setup docs from #4 |
| Invalid JSON | Report line and column |
| Config is not an object | Name the expected shape |
| Unknown key, at either level | A silently ignored `roots` is exactly the failure that burns a non-technical user |
| `mods` alongside `root`/`ignore`/`target` | Ambiguous, so an error rather than a merge |
| `mods` empty or not an array of objects | |
| Duplicate `target` across mods | Name both mods and their shared target |
| `target` is not a valid branch name | |
| `root` escapes the repo | |
| `root` does not exist | Hint by listing directories that contain a `modinfo.json` |
| Payload empty | Almost always a wrong `root` or an over-broad ignore rule |
| Not a git repository, or `--source` does not resolve | |
| Target branch is the source branch | |

Exit codes: `0` on success, including a no-change run. `1` on any error.

## CLI surface

```
pa-mod-build publish [options]

  --config <path>    default: .modbuild        PAMB_CONFIG
  --source <ref>     default: current HEAD     PAMB_SOURCE
  --repo <path>      default: cwd              PAMB_REPO
  --dry-run          resolve and report, write and push nothing    PAMB_DRY_RUN
  --no-push          commit locally, do not push                   PAMB_PUSH=false
```

Precedence is the conventional one — flag, then environment variable, then default — and it
applies only to plumbing. Nothing in `.modbuild` is overridable from the command line, so the
"no precedence rules" property of the config split is preserved intact.

There is deliberately **no `--target`**: `target` lives in the config, and an override would
reintroduce exactly the precedence this design avoids. Publishing to a scratch branch locally is
covered by `--dry-run`.

`publish` is a subcommand from day one so `validate`, `pack` and friends can be added later
without a breaking change.

## Testing

**Unit.** `payload.js`, `config.js` and `summary.js` are pure.

- `payload.js` — root hoisting, negation patterns, directory patterns, anchored vs unanchored,
  paths outside root, empty results, and two mods filtered from one shared file list.
- `config.js` — both accepted shapes, defaulting, normalisation to a list, and every error in the
  table above.
- `summary.js` — rendered output for a single mod, several mods, a no-change run and a dry run.

**Integration.** Real temporary git repos built from a file map, mirroring the shapes in #2 —
mod at root, mod in a subdirectory, mod alongside an unrelated solution — plus a two-mod repo.
Run `publish`, assert the exact file list on each target branch.

**Regression.** A second run with no changes creates no commit. A run where only files *outside*
the payload changed creates no commit. A run after a payload change commits on top, with the
previous publish commit as its parent.

**Acceptance.** `--dry-run` against the local clones of `instant_sandbox`,
`com.pa.jamiemulcahy.anonywho` and `PaChat`. PaChat's payload must be produced by `"root": "Mod"`
alone, with no ignore rules for the C# solution.

## Also in this milestone

- `.github/workflows/ci.yml` running the test suite on PRs. Matrix: ubuntu-latest and
  windows-latest, Node 20 and 22. Windows is not optional — this shells out to `git`, path
  handling is the obvious place to get it wrong, and it is the development platform.
- Add CI as a required status check on the `main` ruleset once it exists.
- Retry CodeQL default setup, which 404s on an empty repo and should take once there is
  JavaScript to analyse.

## Consequences for later milestones

- **#3** — the `target` action input is removed; `PAMB_TARGET` does not exist. `PAMB_PUSH` is
  not exposed either, as CI always pushes. The `fetch-depth: 0` open question is expected to
  resolve to "not needed" and should be tested there.
- **#4** — the starter `.modbuild` gains `"target": "published-mod"`, and its `$schema` points at
  `main` until #5. The multi-mod form is worth a short mention but should not lead.
- **#5** — package name is settled as `pa-mod-build-tools`. Repointing `$schema` to `v1` becomes
  part of the release checklist.

## Out of scope

Mod validation, zip artefacts, `--target` overrides, and any built-in denylist. Each has a home
later or deliberately does not.
