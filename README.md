# pa-mod-build-tools

Build tools for [Planetary Annihilation](https://www.planetaryannihilation.com/) mod authors.

> **Status: the `publish` command and the GitHub Action both work and are tested.** What is
> still missing is the onboarding that makes them adoptable without reading this file closely —
> a setup guide, a starter `.modbuild`, and click-through links for adding both (milestone 3,
> [#4](https://github.com/jamiemulcahy/pa-mod-build-tools/issues/4)) — and the npm package
> (milestone 4, [#5](https://github.com/jamiemulcahy/pa-mod-build-tools/issues/5)). Until this
> is released, use the action at `@main` rather than `@v1`. See [ROADMAP.md](ROADMAP.md) for
> the full sequence and the
> [enhancement issues](https://github.com/jamiemulcahy/pa-mod-build-tools/issues) for detail.

## The problem

PA scans an approved mod's GitHub repo and publishes what it finds to the community mod
browser. It publishes *everything* it finds — so players downloading a mod routinely also
download `.vscode/`, `.idea/`, `CLAUDE.md`, Photoshop sources, test fixtures, and in at least
one real case an entire C# backend solution. Keeping that out means the author has to
maintain a separate clean branch by hand, which nobody does for long.

## The plan

One command, wrapped in one GitHub Action step.

You commit a `.modbuild` file describing which directory is your mod, which paths to leave
out, and which branch to publish to. On every push to your default branch, the action
rebuilds a clean copy of just your mod and commits it to that branch — the branch you point
PA at.

```jsonc
// .modbuild
{
  "root": "Mod",
  "ignore": [".jshintrc", "pachat.zip"],
  "target": "published-mod"
}
```

A repository that ships more than one mod uses a `mods` array instead, with each entry
carrying its own `root`, `ignore` and `target`:

```jsonc
// .modbuild
{ "mods": [
  { "root": "ModA", "target": "published-mod-a" },
  { "root": "ModB", "target": "published-mod-b" }
] }
```

The workflow that runs it is the whole of this:

```yaml
# .github/workflows/publish-mod.yml
name: Publish mod

on:
  push:
    branches: [main]

permissions:
  contents: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: jamiemulcahy/pa-mod-build-tools@main
```

No fetch depth, no token, no Node setup. The action takes three optional inputs — `source`,
`config` and `dry-run` — and `dry-run: 'true'` is the safe way to see what a real run would
publish. [docs/specs/action.md](docs/specs/action.md) covers all of it, including why each of
those absent lines is absent.

Nothing is excluded unless you say so. There are no hidden defaults — the starter `.modbuild`
ships with sensible rules already written into it, so every rule is visible in a file you own
and can edit or delete.

## Try it

Add the workflow above to your mod's repository with `dry-run: 'true'` set on the action step,
push, and read the job summary. It reports what would be published and everything that would
be left out, and writes nothing.

To run the same thing from a terminal instead: the command is not on npm yet, so you need a
checkout of this repository. From that checkout, point it at your mod's git repository:

```bash
npm run publish-mod -- --repo /path/to/your/mod --dry-run
```

Nothing is written or pushed. The report gives a count and total size for what would be
published, and an itemised list of everything left out with the `.modbuild` rule that
excluded it.

The script is `publish-mod` rather than `publish` because npm reserves `publish` as a lifecycle
hook of `npm publish` — a script by that name would run every time this package was released.

[docs/specs/publish.md](docs/specs/publish.md) describes the whole command: the `.modbuild`
format, what a run guarantees, and every way it can fail.

## Design decisions so far

| Decision | Choice |
|---|---|
| What gets stripped | Only what `.modbuild` lists. No built-in denylist. |
| Ignore syntax | `.gitignore` syntax, including negation, relative to `root` |
| Which files are considered | Git-tracked files only, so `.gitignore` is honoured for free |
| Output | A commit on a configurable publish branch. No release artifacts in v1. |
| Config split | `.modbuild` owns the payload (root, ignore, target); workflow YAML owns plumbing (source, config, dry-run) |
| Credentials | Whatever `actions/checkout` persisted. The action has no token input of its own. |
| Packaging | npm package, invoked by a composite action |

See [ROADMAP.md](ROADMAP.md) for how this gets built, and the individual issues for full
detail and open questions.

## Licence

[MIT](LICENSE)
