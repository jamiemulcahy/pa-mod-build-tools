# pa-mod-build-tools

Build tools for [Planetary Annihilation](https://www.planetaryannihilation.com/) mod authors.

> **Status: early. Nothing here works yet.** The shape is agreed and broken down in
> [ROADMAP.md](ROADMAP.md); the work is tracked in
> [enhancement issues](https://github.com/jamiemulcahy/pa-mod-build-tools/issues).

## The problem

PA scans an approved mod's GitHub repo and publishes what it finds to the community mod
browser. It publishes *everything* it finds — so players downloading a mod routinely also
download `.vscode/`, `.idea/`, `CLAUDE.md`, Photoshop sources, test fixtures, and in at least
one real case an entire C# backend solution. Keeping that out means the author has to
maintain a separate clean branch by hand, which nobody does for long.

## The plan

One command, wrapped in one GitHub Action step.

You commit a `.modbuild` file describing which directory is your mod and which paths to leave
out. On every push to your default branch, the action rebuilds a clean copy of just your mod
and commits it to a dedicated publish branch — the branch you point PA at.

```jsonc
// .modbuild
{
  "root": "Mod",
  "ignore": [".jshintrc", "pachat.zip"]
}
```

```yaml
# .github/workflows/publish-mod.yml
- uses: jamiemulcahy/pa-mod-build-tools@v1
  with:
    target: published-mod
```

Nothing is excluded unless you say so. There are no hidden defaults — the starter `.modbuild`
ships with sensible rules already written into it, so every rule is visible in a file you own
and can edit or delete.

## Design decisions so far

| Decision | Choice |
|---|---|
| What gets stripped | Only what `.modbuild` lists. No built-in denylist. |
| Ignore syntax | `.gitignore` syntax, including negation, relative to `root` |
| Which files are considered | Git-tracked files only, so `.gitignore` is honoured for free |
| Output | A commit on a configurable publish branch. No release artifacts in v1. |
| Config split | Workflow YAML owns plumbing (source, target, token); `.modbuild` owns the payload (root, ignore) |
| Packaging | npm package, invoked by a composite action |

See [ROADMAP.md](ROADMAP.md) for how this gets built, and the individual issues for full
detail and open questions.

## Licence

[MIT](LICENSE)
