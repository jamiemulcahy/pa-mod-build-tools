# `publish`

## Intent

Planetary Annihilation publishes everything it finds in an approved mod repository. Players
downloading a mod therefore also receive editor settings, design sources, notes and build output —
whatever else happens to live alongside it. Keeping that out means maintaining a clean branch by
hand, which nobody sustains.

`publish` builds that branch instead. It reads a `.modbuild` file describing which directory is the
mod and which paths to leave out, and writes a clean copy to a dedicated branch — the branch PA is
pointed at.

Its guiding constraint is that **nothing is stripped unless `.modbuild` says so**. There is no
built-in denylist. Sensible defaults reach mod authors through the starter `.modbuild` they are
given, so every rule lives in a file the author owns and can read, edit or delete.

## `.modbuild`

Plain JSON at the repository root. Two accepted shapes.

A single mod:

```json
{
  "$schema": "https://raw.githubusercontent.com/jamiemulcahy/pa-mod-build-tools/main/schema/modbuild.schema.json",
  "root": "Mod",
  "ignore": [".jshintrc", "pachat.zip"],
  "target": "published-mod"
}
```

A repository shipping several mods. One mod means one publish branch, so each entry names its own:

```json
{
  "$schema": "https://raw.githubusercontent.com/jamiemulcahy/pa-mod-build-tools/main/schema/modbuild.schema.json",
  "mods": [
    { "root": "mods/artillery", "target": "published-artillery" },
    { "root": "mods/economy", "target": "published-economy", "ignore": ["*.psd"] }
  ]
}
```

| Key | Where | Type | Default | Meaning |
|---|---|---|---|---|
| `$schema` | top level | string | — | Ignored by the tool. Editor autocompletion only. |
| `mods` | top level | object[] | — | The several-mods form. Cannot be combined with `root`, `ignore` or `target`. |
| `root` | mod | string | `"."` | The directory whose **contents** become the root of the publish branch. The directory containing `modinfo.json`. |
| `ignore` | mod | string[] | `[]` | Paths to leave out, in `.gitignore` syntax including negation, relative to `root`. |
| `target` | mod | string | `"published-mod"` | The branch this mod publishes to. |

`.modbuild` describes **the mods**. Where the command runs from, which ref it builds, and what
credentials it uses are supplied by whoever invokes it. No key appears in both places, so there are
no precedence rules.

## What a run does

For each mod, in order:

1. Take every file tracked in the source commit that lives under `root`.
2. Remove those matching an `ignore` pattern.
3. Strip the `root` prefix, so `Mod/ui/mods/pa-chat/chat.js` becomes `ui/mods/pa-chat/chat.js`.
4. Commit the result to `target`.

The branch accumulates history and is never force-pushed. Anyone who has cloned it keeps working,
and it reads as a record of releases. The whole tree is replaced each run, so merge conflicts cannot
arise. The first run creates the branch with no history behind it; later runs commit on top.

The commit names the source commit and, where the payload has a readable `modinfo.json`, the mod
version — `Publish mod v1.6.6 from a1b2c3d`.

## Expectations

These hold for every run and are the things it is safe to rely on.

- **Only committed, tracked files are ever published.** Untracked and ignored files cannot leak in,
  and neither can uncommitted local edits. Published files are byte-for-byte identical to their
  source.
- **The caller's repository is left alone.** No file is written into the working tree, nothing is
  staged, and the checked-out branch is never moved.
- **A run that changes nothing produces no commit.** A push that touched only files outside the
  payload does not create an empty one. Pushing, though, is decided by what the remote actually
  holds rather than by whether a commit was made, so a branch that exists only locally is still
  sent the next time a run is able to push.
- **A run publishes all of its mods or none of them.** Everything is resolved and validated before
  anything is written. Where a later failure is unavoidable — a network drop mid-push — the report
  states exactly which mods reached the remote.
- **The same report is produced wherever it goes.** Written to a GitHub Actions job summary when one
  is available, and to standard output otherwise.
- **A local run and a CI run produce the same commit** from the same input.

## Command line

```
pa-mod-build publish [options]

  --config <path>    path to the .modbuild file      default: .modbuild
  --source <ref>     branch or commit to build from  default: current HEAD
  --repo <path>      repository to run against       default: current directory
  --dry-run          resolve and report, write and push nothing
  --no-push          commit locally without pushing
  --help
```

Every option is also readable from a `PAMB_`-prefixed environment variable. A flag beats the
variable, which beats the default.

`--config` is resolved relative to `--repo` and may point outside it. That is deliberate — a config
can be kept apart from the repository it describes, which is how the same mod can be built more than
one way — and it is the only path the command reads that the repository does not control.

There is deliberately **no `--target`**. The publish branch belongs to the mod, not to the
invocation, so it lives in `.modbuild` where an author can see it.

`--dry-run` exists because a command whose only mode pushes a branch is frightening to run for the
first time. It reports the payload that would be published and the exclusions that shaped it, and
changes nothing.

## The report

Per run: the source ref and commit, the config file used, and whether this was a dry run.

Per mod: its root and target branch; the resulting commit, or that there was nothing to publish; the
payload's file count and total size; every excluded path with the `.modbuild` rule that matched it;
and whether it was pushed.

Excluded paths are itemised while included files are only counted, because the question an author
needs answered before publishing is what they are about to lose, not a list of files they already
know about.

A run warns when the payload has no `modinfo.json` at its root, and names one found deeper if there
is one. This is not mod validation — that is a separate concern — but its absence almost always
means `root` is wrong, and that is worth saying loudly.

## Failure

Every one of these stops the run before anything is written, exits non-zero, and produces a message
naming both the problem and the fix:

- `.modbuild` is missing, is not valid JSON, or is not a JSON object.
- It contains an unknown key, at either level.
- It combines `mods` with `root`, `ignore` or `target`.
- Two mods publish to the same branch, or to branches git cannot hold at once, such as `mod` and
  `mod/a`.
- A `target` is not a valid branch name.
- A `root` points outside the repository, or contains no tracked files. The message lists the
  directories that do contain a `modinfo.json`.
- Every file under a `root` was removed by its `ignore` rules.
- A mod's `target` is the branch being built from, or the branch currently checked out. Publishing
  onto either would overwrite work.
- The command is not run against a git repository, or `--source` does not resolve.
- The remote cannot be reached and the run intended to push. When it did not intend to push, the run
  continues against local state and says so.

A run that publishes nothing because nothing changed is a success, not a failure.

## Out of scope

Mod validation, distributable archives, and any built-in list of files to strip. Each has a home
elsewhere or is deliberately absent.
