# PA Mod Publish (action)

## Intent

A publish branch is only worth pointing PA at if it stays current, and it only stays current if
rebuilding it happens without anyone deciding to. This action is the step that does that on every
push.

Its job is to be the shortest thing a mod author can paste into a workflow and then forget. A mod
author is not a CI engineer, so anything the step can work out for itself, it works out for
itself — and every input it does not have is one fewer thing to get wrong.

## Shape

```yaml
# .github/workflows/publish-mod.yml
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

| Input | Default | Effect |
|---|---|---|
| `dry-run` | `false` | `true` reports what would be published and writes nothing. Any other value fails the run. |

What the mod publishes, and where, is read from `.modbuild` in the repository being built. See
[publish.md](publish.md).

The job needs `contents: write`, because the run pushes a branch. The runner needs Node 20 or
newer, which GitHub-hosted runners already have.

## Expectations

- The mod is built from whatever `actions/checkout` left behind, including a shallow checkout and
  one with no branch checked out at all.
- The push uses the credentials `actions/checkout` persisted.
- The step changes nothing else about the job. It installs what it needs for its own use and does
  not alter the Node version the rest of the workflow sees.
- Everything `publish` guarantees holds unchanged. This action decides nothing of its own.

## Failure

| Situation | What the author gets |
|---|---|
| `dry-run` is neither `true` nor `false` | An error annotation naming the value, and nothing is published. |
| Node is absent or too old | The step fails with whatever the runner reports, which may not name Node as the cause. |
| Anything `publish` treats as a failure | The step fails and the job log carries the reason. |

## Out of scope

Each absence is deliberate.

- **No `token` input.** Whatever `actions/checkout` persisted is what pushes, so there is no
  second place for credentials to be configured or leaked.
- **No `target` input.** The publish branch belongs to the mod, so it is set in `.modbuild`.
- **No `source` or `config` input.** The mod is built from what is checked out, and `.modbuild`
  sits beside it.
- **No Node setup.** Installing a Node version would change it for every later step in a workflow
  this action knows nothing about.
- **No fetch-depth requirement.** A default checkout is enough.
