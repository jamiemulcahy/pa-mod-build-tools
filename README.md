# pa-mod-build-tools

Build tools for [Planetary Annihilation](https://www.planetaryannihilation.com/) mod authors.

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

`root` defaults to `.`, `ignore` to nothing, and `target` to `published-mod`. Patterns use
`.gitignore` syntax, including negation, relative to `root`. A repository shipping more than
one mod uses a `mods` array instead, each entry carrying its own `root`, `ignore` and `target`:

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
`config` and `dry-run`.

Nothing is excluded unless you say so. There are no hidden defaults.

## Running it yourself

Not on npm yet, so this needs a checkout of this repository. From your mod's repository:

```bash
node /path/to/pa-mod-build-tools/src/publish.js publish --dry-run
```

A dry run writes and pushes nothing. Drop `--dry-run` to publish for real.

| Option | Default | |
|---|---|---|
| `--source <ref>` | `HEAD` | branch, tag or commit to build from |
| `--config <path>` | `.modbuild` | where the config lives |
| `--dry-run` | off | report only |

The publish branch is set in `.modbuild`, not on the command line, so everything about a mod
lives in one file.

## What a run guarantees

- Only git-tracked files are considered, so your `.gitignore` is honoured for free.
- Your working tree and source branch are never touched — the whole thing happens in git's
  object database.
- A run that changes nothing produces no commit.
- The publish branch accumulates history; it is never force-pushed over.
- It refuses to publish onto the branch you have checked out.

## Tests

```bash
npm test           # against your own git
npm run test:docker  # against a pinned git and Node, with no host config in scope
```

Every test drives the real command against a real repository with a bare repository standing
in for GitHub, and asserts on what lands on the published branch. Nothing is mocked.

## Licence

[MIT](LICENSE)
