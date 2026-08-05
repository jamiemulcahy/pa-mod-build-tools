# Roadmap

Milestones are sequential — each one is usable on its own, and each is tracked by an
enhancement issue carrying the full agreed detail and its open questions.

## 0. Groundwork ✅

Repository, branch ruleset, merge policy, security settings, roadmap, issues.

## 1. `pa-mod-build publish` — [#2](https://github.com/jamiemulcahy/pa-mod-build-tools/issues/2) ✅

The whole tool as a command. Reads `.modbuild`, resolves the payload, writes the publish
branch, reports what it did. Runs from a terminal against a real repo, with no GitHub Actions
involvement at all.

The command owns everything. Later milestones only change how it gets invoked and how it is
distributed — never what it does.

## 2. GitHub Action — [#3](https://github.com/jamiemulcahy/pa-mod-build-tools/issues/3) ✅

A composite `action.yml` that maps action inputs onto the command. Self-contained: it runs
its own repo's code, so it works before anything is published to a registry.

## 3. Onboarding — [#4](https://github.com/jamiemulcahy/pa-mod-build-tools/issues/4)

`docs/setup.md`, a starter `.modbuild`, and prefilled "new file" links that let a modder add
the workflow and config with a few clicks and no local tooling.

**This is the first point a non-technical mod author can adopt the tool.**

## 4. npm package and release automation — [#5](https://github.com/jamiemulcahy/pa-mod-build-tools/issues/5)

Publish to npm, switch the action to a pinned `npx` invocation, and automate releases —
version bump, tag, npm publish via OIDC, moving major tag.

## 5. Marketplace listing — [#6](https://github.com/jamiemulcahy/pa-mod-build-tools/issues/6)

List the action on the GitHub Marketplace for discoverability and a canonical page to point
mod authors at.

## …and more tools

The command is built around subcommands so this repo can grow. Candidates, none committed to:

- `validate` — check `modinfo.json` against what the payload actually contains: missing
  `scenes` targets, identifier/folder mismatches, malformed manifests
- `pack` — produce a distributable zip
- `bump` — version and date maintenance across `modinfo.json`
- whatever mod authors ask for once they are actually using this
