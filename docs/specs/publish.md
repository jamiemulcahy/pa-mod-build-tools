# publish

## Intent

PA scans an approved mod's GitHub repository and publishes everything it finds to the community
mod browser. Everything means everything — editor directories, Photoshop sources, test fixtures,
in at least one case an entire backend solution. The only way to control what players download is
to point PA at a branch holding just the mod, which authors maintain by hand until they stop.

`publish` rebuilds that branch from the source branch on demand, so it stays current without
anyone remembering to do it.

One constraint shapes the rest: an author must be able to read their `.modbuild` and know what
will ship. Every rule lives in a file they own, and nothing is withheld that they did not ask to
have withheld.

## Shape

```
pa-mod-build publish [--dry-run]
```

That is the whole command line. The mod is built from whatever is checked out, and its
configuration is read from `.modbuild` in the directory the command runs in.

| Option | Effect |
|---|---|
| `--dry-run` | Report what would be published. Nothing is written, committed or pushed. |

### `.modbuild`

A JSON object describing one mod:

| Key | Default | Meaning |
|---|---|---|
| `root` | `.` | The directory holding the mod. Its contents become the root of the publish branch. |
| `ignore` | nothing | Paths to leave out, in `.gitignore` syntax, relative to `root`. |
| `target` | `published-mod` | The branch to publish to — the branch PA is pointed at. |

A repository shipping more than one mod — a server and a client half, most often — uses `mods`
instead: an array of objects carrying those same three keys. Each entry publishes independently
to its own `target`.

There is deliberately no `--target` option. The publish branch belongs to the mod rather than to
the invocation, so it is set alongside the rest of the mod's description and every run of a given
repository behaves the same way.

### Output

One line per mod: what was published and where, or that nothing changed.

## Expectations

- Only files tracked by git are considered, so anything `.gitignore` already excludes never
  reaches the publish branch.
- The contents of `root` appear at the root of the publish branch. The prefix does not survive.
- Nothing is excluded unless `ignore` says so. There is no built-in denylist.
- `ignore` follows `.gitignore` semantics, negation included, and matches case sensitively.
- The working tree and the branch being built from are never modified. Where there is a remote to
  push to, no local branch is written either.
- A run whose payload matches what the publish branch already holds makes no commit.
- The publish branch accumulates history. It is never force-pushed: a push that would discard what
  is already published fails the run instead.
- An existing publish branch is adopted as it stands, so a branch that has been maintained by hand
  can be handed over without being recreated.
- `--dry-run` writes nothing, anywhere.

## Failure

| Situation | What the author gets |
|---|---|
| No `.modbuild` where the command runs | The run stops before anything is resolved. |
| `root` matches no tracked files | `nothing to publish from "<root>"`, and nothing is written. |
| An argument the command does not recognise | The usage line, and nothing is published. |
| The publish branch holds history this run cannot build on | The push is refused, the run fails, and the branch is left as it was. |
| The remote cannot be reached | The run fails at the point it needed the remote. |

A multi-mod run publishes one mod at a time, so a failure on the second leaves the first already
published. The run exits non-zero naming the mod that failed.

## Out of scope

None of these is an oversight. A reader who wants one of them should add it deliberately, not
file it as a defect.

- **`.modbuild` is not validated.** Keys it does not recognise are ignored, and values of the
  wrong type fail wherever they are first used. A mistyped `ignore` therefore publishes the files
  it was meant to withhold. `--dry-run` is how an author checks a config before trusting it.
- **Two mods may claim one `target`.** They overwrite each other, and both report success.
- **Any branch may be a `target`.** Nothing checks whether it holds work that came from
  somewhere else. Refusing branches this tool did not write would also refuse the
  hand-maintained branch an author most wants to hand over, which is the likeliest way in.
- **Submodules publish as recorded**, which leaves an empty directory where their contents
  should be.
- **There is no `--source`, `--config` or `--no-push`.** The mod is built from what is checked
  out, its configuration sits beside it, and a run that can push does.
- **Reporting is one line per mod.** No per-file account of which rule excluded what, and no
  rendered summary.
