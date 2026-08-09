# Setting this up on your mod

This guide assumes nothing. You do not need to install anything, you do not need a terminal, and
every step happens on github.com. It takes about a minute.

## What this does, and what it does to your repository

Planetary Annihilation installs a mod from a zip file at a fixed web address. The easiest address
to give it is the one GitHub publishes for a branch — but that zip contains *everything* on the
branch, so players end up downloading your editor settings, your Photoshop files, and anything
else you happen to keep alongside the mod.

This tool fixes that by building a second branch that holds only the mod. Every time you push to
your repository, it rebuilds that branch and points it at a clean copy of your files. You give PA
the address of *that* branch instead. **It creates a new branch in your repository** — by default
one called `published-mod` — and adds a commit to it whenever your mod changes. It never touches
the branch you work on, and it never deletes anything.

Because it is an ordinary branch, you can open it on GitHub and see exactly what a player will
download.

## Step 1 — add the workflow

Go to your repository and click **Add file → Create new file**. Put this in the filename box:

```
.github/workflows/publish-mod.yml
```

and this in the editor:

```yaml
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

Click **Commit changes…**, then **Commit changes** again.

> If your repository's main branch is called something other than `main` — `master`, on older
> repositories — change `branches: [main]` to match, or nothing will ever run. The name is shown
> in the branch dropdown at the top left of your repository's file list.

## Step 2 — add `.modbuild`

**Add file → Create new file** again. Filename:

```
.modbuild
```

and this in the editor:

```json
{
  "root": ".",
  "target": "published-mod",
  "ignore": [
    ".modbuild",
    ".git*",
    ".vscode/",
    ".idea/",
    ".claude/",
    "CLAUDE.md",
    "AGENTS.md",
    "*.psd",
    "*.xcf"
  ]
}
```

This file describes your mod, and it is the only thing you will ever need to edit.

| Key | What it means |
|---|---|
| `root` | The folder your mod lives in. `.` means the whole repository — correct if `modinfo.json` sits at the top level. If your mod is in a folder called `Mod`, write `"Mod"`. |
| `target` | The branch to publish to. This is the branch you will point PA at. |
| `ignore` | Everything you do *not* want players to download. |

The `ignore` list above covers the usual suspects: this config file itself, everything git and
GitHub keep (`.git*` also covers `.github`, `.gitignore` and `.gitattributes`), the settings
folders that VS Code, the JetBrains editors and Claude Code create, notes files, and image
sources. Add anything else your repository holds that is not part of the mod, and delete any line
you do not need. **Nothing is left out unless you say so here** — there is no hidden list.

The patterns work exactly like a `.gitignore` file: `*.psd` matches by extension, a trailing
slash like `.vscode/` means a folder, and a leading `!` puts something back. Anything already
listed in your `.gitignore` is excluded for free, because only files committed to git are ever
considered.

Commit the file, and the first run starts by itself.

## Step 3 — check the first run

Open the **Actions** tab. There will be a run called *Publish mod*. Click it, click the
**publish** job, and open the **Publish mod** step. One line tells you what happened:

```
published-mod: published 42 files from .
```

Now open the branch dropdown at the top left of your repository's file list and switch to
`published-mod`. What you are looking at is exactly what a player will download. If something is
in there that should not be, add it to `ignore` and commit again.

**Want to look before it writes anything?** Add two lines to the last step of the workflow:

```yaml
      - uses: jamiemulcahy/pa-mod-build-tools@main
        with:
          dry-run: true
```

The run then reports what it *would* publish and creates no branch at all. Take the two lines
out again when you are happy with what it says. This is worth doing if you have changed `target`
to a branch that already exists — a mistyped branch name publishes over whatever is on it.

## Step 4 — point PA at the branch

Community Mods takes a direct link to a zip file. Yours is:

```
https://github.com/OWNER/REPO/archive/refs/heads/published-mod.zip
```

Replace `OWNER/REPO` with your own — it is the part of your repository's address after
`github.com/`. Open the link in a browser first to check that it downloads something sensible.

To get the mod listed, post that link in the `#mod-submissions` channel on the official
Planetary Annihilation Discord. This is a one-time thing. Afterwards, every push to your
repository rebuilds the publish branch, and that same link serves the new version — players get
the update with no resubmission and nothing further from you.

**If your mod is already listed, do not do this.** Read the next section instead.

## If your mod is already in Community Mods

The address you registered cannot be changed after submission. It names a branch — almost always
`main` — and that is the branch PA will keep fetching forever. Publishing to a new
`published-mod` branch would produce a clean payload that nobody ever downloads.

So the arrangement is inverted: your mod keeps being published to the branch PA already knows
about, and your working files move somewhere else.

1. Create a branch called `develop` from your current `main`. Under the branch dropdown, type
   `develop` and choose **Create branch: develop**.
2. Make it the default: **Settings → General**, then the switch icon beside the default branch,
   and pick `develop`.
3. In your workflow, change `branches: [main]` to `branches: [develop]`.
4. In `.modbuild`, change `"target": "published-mod"` to `"target": "main"`.

From then on you work on `develop`, and `main` holds the clean payload that PA downloads. The
registered address keeps working and no resubmission is needed.

Your existing `main` is adopted as it stands rather than replaced — the first run adds a commit
on top of it containing only the mod, and everything already in its history stays there.

## If your repository holds more than one mod

A repository shipping a client and a server half, or a mod pack, uses a `mods` array instead.
Each entry takes the same three keys and publishes to its own branch, so each half gets its own
address to hand to PA:

```json
{
  "mods": [
    { "root": "ModA", "target": "published-mod-a", "ignore": ["*.psd"] },
    { "root": "ModB", "target": "published-mod-b", "ignore": ["*.psd"] }
  ]
}
```

This is the rare case. If you have one mod, the file in step 2 is what you want.

## Troubleshooting

Everything below appears in the **Publish mod** step of the run, on the Actions tab.

| What you see | What it means |
|---|---|
| No run appears at all | The workflow's `branches:` does not match your default branch. See the note in step 1. |
| `no .modbuild in this directory` | The file is missing, or it is misnamed. It is `.modbuild` exactly — no `.json`, no `.txt`, and it belongs at the top level of the repository, not in a folder. |
| `.modbuild: Expected double-quoted property name in JSON at position 46 (line 4 column 1)` | The file is not valid JSON, and the line number tells you where. Nearly always a comma after the last item in a list, or a missing `"`. Nothing was published. |
| `nothing to publish from "."` | `root` names a folder that is not there, or your `ignore` list excludes everything. Check the spelling and the capitals — `Mod` and `mod` are different. |
| `remote: Permission to ... denied` or `403` | The workflow is missing `permissions: contents: write`. Compare it against step 1. |
| `! [rejected] ... (non-fast-forward)` or `failed to push` | The publish branch holds history this run cannot build on, usually because it was rewritten by hand. Nothing was published and the branch is untouched. Delete the publish branch on GitHub and push again to rebuild it from scratch. |
| `dry-run must be 'true' or 'false'` | The `dry-run` input in the workflow is set to something else — `yes` and `True` are not accepted, deliberately, so a typo cannot publish for real. |
| `usage: pa-mod-build publish [--dry-run]` | Only reachable if you are running the command yourself in a terminal. See the [README](../README.md). |

A run that finds nothing to change says `published-mod: unchanged` and stops there. That is not
an error — it means the mod is identical to what is already published.

## A shortcut for the two files above

GitHub's editor accepts a file's contents in the address bar, so both files can be created
prefilled:

```
https://github.com/OWNER/REPO/new/main?filename=.modbuild&value=PASTE_HERE
```

Substituting your own `OWNER/REPO`, and the file contents URL-encoded into `value`. This is
undocumented behaviour that GitHub may change without notice, which is why the guide above does
not rely on it. Copy and paste from the blocks in steps 1 and 2 is the supported route — hover
over a block and a copy button appears in its top right corner.

## What the tool guarantees

- Your working branch and your files are never modified.
- Only files committed to git are ever considered.
- A run that changes nothing makes no commit.
- The publish branch is never force-pushed. A run that would discard what is already published
  fails instead, and leaves the branch alone.
- Nothing is excluded unless `ignore` says so.

[docs/specs/publish.md](specs/publish.md) describes the command in full, including what it
deliberately does not do.
