# The GitHub Action

## Intent

`publish` is a terminal command, and a mod author who is comfortable running one is not the
person this project exists for. The action is how the command reaches everyone else: a step
they paste into a workflow file once and never think about again.

It is an adapter and nothing else. Every input maps onto an option the command already has,
and the action decides nothing on its own. If a run does something surprising, the
explanation is in [`publish.md`](publish.md) — never here.

## What a mod author writes

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
      - uses: jamiemulcahy/pa-mod-build-tools@v1
```

That is the whole thing, and its shortness is a feature rather than a simplification for the
sake of the example. Three lines that a reasonable person would expect to need are absent:

- **No `fetch-depth: 0`.** `publish` builds the payload from the source commit's tree and the
  target branch's tip, and fetches the latter itself. A default shallow checkout holds
  everything it needs. Verified against a real `--depth=1` clone, first publish and
  subsequent ones alike.
- **No `token`.** The action pushes with whatever credentials `actions/checkout` persisted,
  which by default are `GITHUB_TOKEN`. See [Credentials](#credentials).
- **No `actions/setup-node`.** See [Runtime](#runtime).

`permissions: contents: write` does have to be written out, because the default for a workflow
is read-only and pushing a branch is the entire point.

## Inputs

| Input | Environment variable | Default | Meaning |
|---|---|---|---|
| `source` | `PAMB_SOURCE` | `HEAD` | Branch, tag or commit to build the mod from. |
| `config` | `PAMB_CONFIG` | `.modbuild` | Path to the `.modbuild` file. |
| `dry-run` | `PAMB_DRY_RUN` | `false` | Resolve and report; write and push nothing. |

Three inputs, each one an existing command-line option under a different name. The action
sets these three variables and no others.

Actions expressions collapse to an empty string rather than to nothing, so an input left
unset by a `with:` block whose value came from an expression arrives as `PAMB_CONFIG=""`
rather than as an absent variable. `publish` therefore treats an empty `PAMB_` variable as
unset and falls back to its default, which is what someone who wrote that workflow meant.
This is a small change to the command rather than something the action works around, because
an empty environment variable means the same thing whoever set it.

`source` defaults to `HEAD` — the commit `actions/checkout` checked out — rather than to a
named branch. A named default has to be right for every trigger, and none is:
`github.ref_name` is the triggering branch, which is correct for `push` and wrong for a
`workflow_dispatch` fired from somewhere else; the repository's default branch is correct for
that case and may not even exist locally in a shallow checkout of another branch. `HEAD` is
whatever the author asked `actions/checkout` for, which is right by construction for every
trigger there is. An author who wants something else names it, and then it is their explicit
choice rather than a default quietly disagreeing with them.

### What is deliberately not an input

Each of these was considered and rejected. They are listed because the reason matters more
than the omission, and because an absent input is the kind of thing that grows back.

- **`target`.** The publish branch belongs to the mod, not to the workflow. A repository
  shipping several mods publishes to several branches from one step, and no workflow-level
  value can say where any of them go. It lives in `.modbuild` beside `root` and `ignore`.
- **`token`.** Pushing already works, because `actions/checkout` writes an authenticated
  header into the repository's git config and leaves it there. A `token` input would have to
  either duplicate that mechanism or quietly do nothing.
- **`push`.** The action always pushes. `dry-run` is how you ask it not to, and two ways to
  say almost the same thing would only invite questions about how they interact.
- **`repo`.** The action runs against the workspace, which is where `actions/checkout` puts
  the repository.

The result is that `.modbuild` describes **the mods** and the workflow describes **the
plumbing**, with no key appearing in both. There are no precedence rules to learn because
there is nothing to resolve.

## Credentials

`actions/checkout` persists credentials by default: it configures an `http.extraheader` on the
repository carrying the token it was given. `publish` pushes to `origin` and that header
authenticates it. The action needs no token of its own, and never handles one.

The consequences follow from that single fact:

- The default token is `GITHUB_TOKEN`, so `permissions: contents: write` is what grants the
  push.
- Pushes made with `GITHUB_TOKEN` do not trigger further workflow runs. A publish cannot set
  off another publish, whatever the publish branch's own triggers say.
- An author who wants the publish branch to trigger workflows — or who is pushing to a
  different repository — passes a PAT to `actions/checkout` as its `token`, and the action
  inherits it with no change to the step.
- An author who sets `persist-credentials: false` has removed the credentials the push needs,
  and the run fails at the push with git's own message.

## Runtime

`runs: using: composite`, so the action executes its own checkout's code via
`$GITHUB_ACTION_PATH`. Nothing needs to be published to a registry for the action to work,
which is why this milestone comes before packaging. Switching to a pinned `npx` invocation
later is an internal change no consumer sees.

`action.yml` sits at the repository root. That is a GitHub requirement for a Marketplace
listing, not a preference.

Three steps, each with an explicit `shell: bash` — composite `run` steps have no default
shell, and omitting it is the single most common way to get a composite action wrong.

1. **Check Node.** Fail with a message naming the found version and the required one if Node
   is missing or older than 20. GitHub-hosted runners ship Node 20 or newer, so this step
   passes silently there and exists for self-hosted runners, where the alternative is a
   syntax error from deep inside the tool.
2. **Install.** `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`, with
   `working-directory: ${{ github.action_path }}`. `publish` has one runtime dependency,
   `ignore`. This requires `package-lock.json` to stay committed.
3. **Run.** `node "$GITHUB_ACTION_PATH/src/cli.js" publish`, with the three environment
   variables set.

`actions/setup-node` is deliberately absent. It is not merely a couple of seconds of runtime:
a composite action that runs it changes the Node version for **every later step in the
caller's job**, which is not a thing a mod-publishing step should be able to do to a workflow
it knows nothing about. The version check gives the determinism that mattered, and takes
nothing from the caller.

The report reaches the run page without the action doing anything: `publish` writes to
`$GITHUB_STEP_SUMMARY` when the runner sets it, and to standard output otherwise.

## Expectations

- **Nothing the action does is unreachable from the command line.** Every input is an
  existing option. Someone debugging a failed run can reproduce it locally, exactly, and the
  contract test asserts the mapping rather than trusting it.
- **A default `actions/checkout` is sufficient.** No fetch depth, no token, no toolchain
  setup, no `with:` block at all.
- **The action leaves the caller's job as it found it.** No global tool versions changed, no
  files written outside the workspace and `$GITHUB_ACTION_PATH`.
- **A publish cannot trigger a publish**, because the push carries `GITHUB_TOKEN`.
- **A dry run pushes nothing and creates nothing**, and says what a real run would have done.

## Failure

The step fails, non-zero, with a message naming the problem:

- Node is missing or older than 20.
- `npm ci` fails — most likely `package-lock.json` is out of step with `package.json`.
- Anything `publish` itself rejects, reported exactly as it is from a terminal. Those cases
  and their messages belong to [`publish.md`](publish.md) and are not restated here.

The most likely first-run failure is a missing `permissions: contents: write`, which surfaces
as git rejecting the push. That is a documentation problem, addressed by the onboarding
milestone rather than by code here.

## Testing

Two layers, because they catch different mistakes and neither substitutes for the other.

### Contract tests — `test/action.test.js`

Ordinary `node --test` cases that parse `action.yml` and assert its shape. They run locally
and on every existing CI matrix cell, in under a second, with no runner involved. They catch
drift, which is the failure mode a thin adapter actually has: someone renames an environment
variable in `cli.js` and the action keeps setting the old one, silently ignoring an input.

They assert:

- Every environment variable the action sets is one `cli.js` reads, **and** every `PAMB_`
  variable `cli.js` reads is either set by the action or listed as a deliberate omission.
  Both directions, so drift cannot hide on either side.
- Every `run` step declares `shell: bash`.
- Every input has a description and a non-empty default; the action requires nothing.
- `target`, `token`, `push` and `repo` are not inputs. A test that asserts an absence is
  unusual, and it is here because the decisions above are load-bearing and the natural
  instinct when someone asks for a `target` input is to add one.
- The referenced `src/cli.js` exists, `runs.using` is `composite`, and `name`, `description`
  and `branding` are present, since the Marketplace listing needs them.

This needs a YAML parser. `yaml` as a dev dependency, which the action's `--omit=dev` install
never sees.

### End-to-end workflow — `.github/workflows/action.yml`

The contract tests never run the action. This does, on `ubuntu-latest` and `windows-latest`,
against fixture repositories built on the runner.

The shape is unusual for a reason worth stating. A composite action runs in the workspace,
and a `uses:` step cannot be pointed somewhere else, so the fixture repository has to *be*
the workspace. The job therefore checks this repository out to a subdirectory, `_action`, and
then builds a fixture repository around it:

1. A bare repository in `$RUNNER_TEMP` acts as `origin`. No network, no credentials, no
   permissions, and no branches pushed to this project's own repository.
2. `git init` in the workspace, then `git fetch --depth=1`, then checkout. Initialising in
   place rather than cloning is what allows the workspace to already contain `_action`, and
   the shallow fetch makes it a genuinely shallow repository rather than an imitation of one.
   `_action` stays untracked, which is invisible to `publish` — it only ever reads tracked
   files from the source commit.

Fixture setup and assertions live in a Node script, `test/action/e2e.js`, invoked with a
scenario or check name. Written in Node rather than shell because it has to run identically on
both runners, and because a wrong assertion that silently passes is worse than no assertion.

Covered:

- Single mod: creates the branch, correct stripped tree, ignored paths absent.
- A second run onto the existing remote branch: history accumulates, no force-push.
- An unchanged run: no new commit.
- Multi-mod `.modbuild`: every branch published from one step.
- `dry-run: true`: no branch created, no commit, and the report still describes the payload.
- `config` and `source` each demonstrably taking effect — a config outside the default path,
  and a build from an older commit producing that commit's payload.
- The job summary: one step overrides `GITHUB_STEP_SUMMARY` to a known path and asserts the
  rendered report; another leaves it alone so the real summary appears on the run page.

Windows is in the matrix because `shell: bash` on a Windows runner is git-bash rather than a
POSIX shell, and path handling is where a composite action quietly breaks.

## Out of scope

Outputs for downstream steps — a published SHA or file count — are not exposed. Nobody has
asked, and an output is easier to add than to withdraw.

The workflow file a mod author copies, the starter `.modbuild`, and the click-through links
that let them add both without cloning anything belong to the onboarding milestone. This one
ends when the action works and is proven to.
