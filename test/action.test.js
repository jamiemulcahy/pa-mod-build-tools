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
const publishStep = steps.find((step) => step.run?.includes('cli.js'))

// The variables the CLI *reads*, taken from the calls that read them rather than from anywhere
// the name merely appears. Scanning the file for /PAMB_[A-Z_]+/ looked equivalent and was not:
// cli.js names every one of them in its --help text, so the help text alone satisfied the
// check, and a CLI that had stopped reading PAMB_CONFIG altogether still passed.
// Matches fromEnv('…') and boolFromEnv('…') alike, hence the optional capital.
const READ_BY_CLI = new Set(
  [...cliSource.matchAll(/(?:[Ff]romEnv\('|process\.env\.)(PAMB_[A-Z_]+)/g)].map((match) => match[1])
)

// PAMB_REPO and PAMB_PUSH are not inputs — the action runs against the workspace, which is
// where actions/checkout puts the repository, and it always pushes, with dry-run as the way to
// ask it not to. They are still set, to the empty string, which the CLI reads as unset. Left
// unset entirely they would be inherited from whatever the caller's workflow happens to have in
// scope, which is a way to change what the action does that no input can express.
const NEUTRALISED = ['PAMB_REPO', 'PAMB_PUSH']

test('it is a composite action, so it runs its own checkout without a registry', () => {
  assert.equal(action.runs.using, 'composite')
})

test('it carries what a Marketplace listing requires', () => {
  assert.ok(action.name)
  assert.ok(action.description)
  assert.ok(action.branding?.icon)
  assert.ok(action.branding?.color)
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
    // notEqual rather than equal(…, false): omitting `required` is how GitHub's own examples
    // are written and means exactly this, so it must not fail with "should not be required".
    assert.notEqual(input.required, true, `${name} should not be required`)
    assert.ok(input.description?.trim(), `${name} has no description`)
    assert.ok(typeof input.default === 'string' && input.default !== '', `${name} has no default`)
  }
})

// The naming rule is the whole contract: an input is its option's environment variable with a
// prefix. Asserting the rule rather than a table means a new input cannot be wired up wrongly.
test('each input maps onto its PAMB_ variable, alongside the neutralised two', () => {
  const expected = Object.fromEntries(
    Object.keys(action.inputs).map((name) => [
      `PAMB_${name.toUpperCase().replaceAll('-', '_')}`,
      `\${{ inputs.${name} }}`
    ])
  )
  for (const name of NEUTRALISED) expected[name] = ''

  assert.deepEqual(publishStep.env, expected)
})

test('every variable the action sets is one the CLI reads', () => {
  for (const name of Object.keys(publishStep.env)) {
    assert.ok(READ_BY_CLI.has(name), `action.yml sets ${name}, which cli.js never reads`)
  }
})

// The other direction, and the one that matters most. Without it, adding an option to the CLI
// and forgetting the action goes unnoticed: the action keeps working, just without the new
// capability, which is exactly the kind of gap nobody reports. Every variable is now accounted
// for — mapped from an input or pinned empty — so there is no "documented omission" escape
// hatch for a new one to hide in.
test('every variable the CLI reads is set by the action', () => {
  assert.ok(READ_BY_CLI.size > 0, 'no PAMB_ variables were found being read in cli.js')
  for (const name of READ_BY_CLI) {
    assert.ok(name in publishStep.env, `cli.js reads ${name}, which action.yml never sets`)
  }
})

// Pinned to empty rather than left out, so a variable in scope in the caller's workflow cannot
// change where the action runs or whether it pushes.
test('the variables with no input are pinned empty rather than left unset', () => {
  for (const name of NEUTRALISED) {
    assert.equal(publishStep.env[name], '', `${name} must be set to the empty string`)
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
// Windows runner contains no spaces today, but that is not a promise anyone made. Both spellings
// are checked, and the reference has to sit inside a quoted span rather than merely follow a
// quote, so a half-quoted command cannot satisfy it.
test('the action path is quoted wherever it is interpolated into a shell command', () => {
  for (const step of steps.filter((step) => step.run !== undefined)) {
    for (const line of step.run.split('\n')) {
      if (!line.includes('GITHUB_ACTION_PATH')) continue
      assert.match(
        line, /"[^"]*\$\{?GITHUB_ACTION_PATH\}?[^"]*"/,
        `unquoted $GITHUB_ACTION_PATH in step "${step.name}": ${line.trim()}`
      )
    }
  }
})

// npm ci reads package-lock.json from the working directory, so the install step has to be
// pointed at the action's own checkout rather than at the mod repository it is publishing.
test('dependencies install from the action checkout, not the caller workspace', async () => {
  const install = steps.find((step) => step.run?.includes('npm ci'))
  assert.ok(install, 'no step installs dependencies')
  assert.equal(install['working-directory'], '${{ github.action_path }}')
  assert.match(install.run, /--omit=dev/)
  await access(new URL('../package-lock.json', import.meta.url))
})
