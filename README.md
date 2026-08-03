# pa-mod-build-tools

Build tools for [Planetary Annihilation](https://www.planetaryannihilation.com/) mod authors.

> **Status: the `publish` command works and is tested**, but there is no way to run it yet
> without a terminal. The GitHub Action that would let a mod author use this from a
> `.modbuild` file and a workflow step is not built (milestone 2,
> [#3](https://github.com/jamiemulcahy/pa-mod-build-tools/issues/3)), and neither are the
> onboarding docs (milestone 3,
> [#4](https://github.com/jamiemulcahy/pa-mod-build-tools/issues/4)) or the npm package
> (milestone 4, [#5](https://github.com/jamiemulcahy/pa-mod-build-tools/issues/5)). See
> [ROADMAP.md](ROADMAP.md) for the full sequence and the
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

The GitHub Action is not built yet
([#3](https://github.com/jamiemulcahy/pa-mod-build-tools/issues/3)) — this is what the
workflow step is expected to look like once it exists, not something you can add today:

```yaml
# .github/workflows/publish-mod.yml — not built yet
- uses: jamiemulcahy/pa-mod-build-tools@v1
```

Nothing is excluded unless you say so. There are no hidden defaults — the starter `.modbuild`
ships with sensible rules already written into it, so every rule is visible in a file you own
and can edit or delete.

## Try it

The `publish` command itself works today, though it is not on npm yet, so you need a checkout
of this repository to run it. From inside a checkout, pointed at your mod's git repository
with `--repo` (or run from inside the mod's repository itself):

```bash
node src/cli.js publish --repo /path/to/your/mod --dry-run
```

Nothing is written or pushed. The report shows exactly which files would be published and
which were left out, with the `.modbuild` rule that excluded each one.

## Design decisions so far

| Decision | Choice |
|---|---|
| What gets stripped | Only what `.modbuild` lists. No built-in denylist. |
| Ignore syntax | `.gitignore` syntax, including negation, relative to `root` |
| Which files are considered | Git-tracked files only, so `.gitignore` is honoured for free |
| Output | A commit on a configurable publish branch. No release artifacts in v1. |
| Config split | `.modbuild` owns the payload (root, ignore, target); workflow YAML owns plumbing (source, config, token) |
| Packaging | npm package, invoked by a composite action |

See [ROADMAP.md](ROADMAP.md) for how this gets built, and the individual issues for full
detail and open questions.

## Licence

[MIT](LICENSE)
