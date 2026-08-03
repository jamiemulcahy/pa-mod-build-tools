import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import { parse } from 'yaml'

// These tests never run the action — the end-to-end workflow does that. What they catch is
// drift, which is the failure mode a thin adapter actually has: an environment variable renamed
// in cli.js while action.yml keeps setting the old one, silently ignoring an input for as long
// as it takes someone to notice their config path did nothing.
const actionUrl = new URL('../action.yml', import.meta.url)
const action = parse(await readFile(actionUrl, 'utf8'))
const cliSource = await readFile(new URL('../src/cli.js', import.meta.url), 'utf8')

const steps = action.runs.steps
const publishStep = steps.find((step) => step.env !== undefined)

// PAMB_REPO and PAMB_PUSH are omissions with reasons, not oversights. The action runs against
// the workspace, which is where actions/checkout puts the repository, and it always pushes —
// dry-run is how you ask it not to. Listing them here is what lets the test below insist that
// every *other* variable the CLI reads is wired up.
const DELIBERATELY_UNSET = ['PAMB_REPO', 'PAMB_PUSH']

test('it is a composite action, so it runs its own checkout without a registry', () => {
  assert.equal(action.runs.using, 'composite')
})

test('it carries what a Marketplace listing requires', () => {
  assert.ok(action.name)
  assert.ok(action.description)
  assert.ok(action.branding?.icon)
  assert.ok(action.branding?.color)
})

test('the file is at the repository root, where Marketplace requires it', async () => {
  await access(actionUrl)
})

// Composite run steps have no default shell, and forgetting it is the single most common way
// to get a composite action wrong. The failure is at run time, on someone else's repository.
test('every run step declares its shell', () => {
  const runSteps = steps.filter((step) => step.run !== undefined)
  assert.ok(runSteps.length > 0)
  for (const step of runSteps) {
    assert.equal(step.shell, 'bash', `step "${step.name}" has no shell`)
  }
})

test('every input is optional, described, and has a non-empty default', () => {
  for (const [name, input] of Object.entries(action.inputs)) {
    assert.equal(input.required, false, `${name} should not be required`)
    assert.ok(input.description?.trim(), `${name} has no description`)
    assert.ok(typeof input.default === 'string' && input.default !== '', `${name} has no default`)
  }
})

// The naming rule is the whole contract: an input is its option's environment variable with a
// prefix. Asserting the rule rather than a table means a new input cannot be wired up wrongly.
test('each input maps onto its PAMB_ variable and nothing else', () => {
  const expected = Object.fromEntries(
    Object.keys(action.inputs).map((name) => [
      `PAMB_${name.toUpperCase().replaceAll('-', '_')}`,
      `\${{ inputs.${name} }}`
    ])
  )
  assert.deepEqual(publishStep.env, expected)
})

test('every variable the action sets is one the CLI reads', () => {
  for (const name of Object.keys(publishStep.env)) {
    assert.ok(cliSource.includes(name), `action.yml sets ${name}, which cli.js never reads`)
  }
})

// The other direction. Without this, adding an option to the CLI and forgetting the action
// would go unnoticed — the action would keep working, just without the new capability, which is
// exactly the kind of gap nobody reports.
test('every variable the CLI reads is either set or a documented omission', () => {
  const read = new Set(cliSource.match(/PAMB_[A-Z_]+/g))
  assert.ok(read.size > 0)
  for (const name of read) {
    if (DELIBERATELY_UNSET.includes(name)) continue
    assert.ok(name in publishStep.env, `cli.js reads ${name}, which action.yml never sets`)
  }
})

test('the deliberate omissions are still omitted', () => {
  for (const name of DELIBERATELY_UNSET) {
    assert.equal(name in publishStep.env, false, `${name} was meant to stay unset`)
  }
})

// Asserting an absence is unusual, and it is here because these four decisions are load-bearing
// and each has an obvious-looking wrong answer. `target` belongs to the mod, not the workflow,
// because a repository shipping several mods publishes to several branches from one step.
// `token` cannot work — the push authenticates with the header actions/checkout leaves behind.
// `push` would duplicate `dry-run`. `repo` would contradict where actions/checkout puts things.
test('target, token, push and repo are not inputs', () => {
  for (const name of ['target', 'token', 'push', 'repo']) {
    assert.equal(name in action.inputs, false, `${name} should not be an input — see docs/specs/action.md`)
  }
})

test('the command it runs exists', async () => {
  assert.match(publishStep.run, /\$GITHUB_ACTION_PATH\/src\/cli\.js/)
  assert.match(publishStep.run, /publish/)
  await access(new URL('../src/cli.js', import.meta.url))
})

// $GITHUB_ACTION_PATH is a runner-chosen path. Quoting it is not fussiness: the default on a
// Windows runner contains no spaces today, but that is not a promise anyone made.
test('the action path is quoted wherever it is interpolated into a shell command', () => {
  for (const step of steps.filter((step) => step.run !== undefined)) {
    for (const match of step.run.matchAll(/(.?)\$GITHUB_ACTION_PATH/g)) {
      assert.equal(match[1], '"', `unquoted $GITHUB_ACTION_PATH in step "${step.name}"`)
    }
  }
})

// npm ci reads package-lock.json from the working directory, so the install step has to be
// pointed at the action's own checkout rather than at the mod repository it is publishing.
test('dependencies install from the action checkout, not the caller workspace', async () => {
  const install = steps.find((step) => step.run?.includes('npm ci'))
  assert.equal(install['working-directory'], '${{ github.action_path }}')
  assert.match(install.run, /--omit=dev/)
  await access(new URL('../package-lock.json', import.meta.url))
})
