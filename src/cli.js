#!/usr/bin/env node
// src/cli.js
import { parseArgs } from 'node:util'
import { appendFile } from 'node:fs/promises'
import { publish, PublishError } from './publish.js'
import { renderSummary } from './summary.js'
import { ConfigError } from './config.js'
import { GitError } from './git.js'

const USAGE = `pa-mod-build publish [options]

Publishes a clean copy of your Planetary Annihilation mod to its own branch,
as described by .modbuild.

  --config <path>    path to the .modbuild file      (default: .modbuild, env: PAMB_CONFIG)
  --source <ref>     branch or commit to build from  (default: HEAD, env: PAMB_SOURCE)
  --repo <path>      repository to run against       (default: current directory, env: PAMB_REPO)
  --dry-run          resolve and report, write and push nothing   (env: PAMB_DRY_RUN)
  --no-push          commit locally without pushing               (env: PAMB_PUSH=false)
  --help             show this message

The publish branch is set with "target" in .modbuild, not on the command line,
so everything about a mod lives in one file.
`

const OPTIONS = {
  config: { type: 'string' },
  source: { type: 'string' },
  repo: { type: 'string' },
  'dry-run': { type: 'boolean' },
  'no-push': { type: 'boolean' },
  help: { type: 'boolean' }
}

// Only a genuinely unexpected exception reaches here — the three known error types are handled
// in main() and reported without a trace. Anything else is a bug in this tool rather than
// something the author did, and the stack is the useful part of the report.
main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`)
  process.exitCode = 1
})

async function main () {
  let parsed
  try {
    parsed = parseArgs({ args: process.argv.slice(2), options: OPTIONS, allowPositionals: true, strict: true })
  } catch (error) {
    return fail(`${error.message}\n\n${USAGE}`)
  }

  if (parsed.values.help) {
    process.stdout.write(USAGE)
    return
  }

  const [command] = parsed.positionals
  if (command === undefined) return fail(USAGE)
  if (command !== 'publish') {
    return fail(`Unknown command "${command}". The available command is: publish.\n\n${USAGE}`)
  }

  // Someone typing `publish published-mod`, expecting a branch argument, would otherwise get a
  // silent apparent success with the argument ignored.
  if (parsed.positionals.length > 1) {
    return fail(
      `Unexpected argument "${parsed.positionals[1]}". publish takes no arguments of its own — ` +
      'the branch each mod publishes to is set with "target" in .modbuild, not on the command ' +
      `line.\n\n${USAGE}`
    )
  }

  let options
  try {
    options = resolveOptions(parsed.values)
  } catch (error) {
    return fail(error.message)
  }

  let report
  try {
    report = await publish(options)
  } catch (error) {
    // publish() attaches a partial report to the error when a multi-mod run fails part way
    // through (e.g. the second mod's push fails after the first mod's commit already landed).
    // Render what did happen to the same destination as a normal report, so the user isn't left
    // wondering which mods, if any, went out — while the error itself still goes to stderr below.
    // A report with no mods in it says nothing (the run failed before the first one finished),
    // and printing a bare header above the error would only be noise.
    if (error?.report?.mods?.length > 0) await write(renderSummary(error.report))
    if (error instanceof ConfigError || error instanceof PublishError) return fail(error.message)
    if (error instanceof GitError) return fail(describeGitError(error))
    throw error
  }

  await write(renderSummary(report))
}

// A GitError is an ordinary thing to hit — an unreachable remote, a DNS failure, an auth
// rejection — and its message already carries git's own stderr, which is the explanation. A
// stack trace of this tool's internals would only bury it. The commands that talk to a remote
// get an extra line, because "could not resolve host" is not obviously about *this* remote to
// someone who did not know the tool contacts one at all.
function describeGitError (error) {
  if (error.remote == null) return error.message

  return `${error.message}\n\nThis step contacts the remote "${error.remote}". Check your network ` +
    'connection and that you still have access to that repository.'
}

async function write (text) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (summaryPath) {
    await appendFile(summaryPath, text, 'utf8')
    return
  }
  process.stdout.write(text)
}

function fail (message) {
  process.stderr.write(`${message.trimEnd()}\n`)
  process.exitCode = 1
}

// These three are function declarations, not `const` arrow functions, and that is load bearing.
// main() runs synchronously (it does not reach its first `await` until `publish(options)`) as a
// direct result of the `main().catch(...)` call above, so by the time it resolves its options
// they must already be usable. `const` bindings stay in the temporal dead zone until their own
// declaration executes, which is after main() has already run — function declarations are
// hoisted in full, so they are callable from anywhere in the module.
function resolveOptions (values) {
  return {
    repoPath: values.repo ?? fromEnv('PAMB_REPO') ?? process.cwd(),
    configPath: values.config ?? fromEnv('PAMB_CONFIG') ?? '.modbuild',
    source: values.source ?? fromEnv('PAMB_SOURCE') ?? 'HEAD',
    dryRun: values['dry-run'] ?? boolFromEnv('PAMB_DRY_RUN') ?? false,
    push: values['no-push'] ? false : (boolFromEnv('PAMB_PUSH') ?? true)
  }
}

// An empty variable counts as unset. GitHub Actions expressions collapse to an empty string
// rather than to nothing, so an input the caller never supplied still arrives here as
// PAMB_CONFIG="" — and reading that as a real value would send the tool looking for a config
// file at "". Whoever set an empty variable meant "I have nothing to say about this", wherever
// they set it from.
function fromEnv (name) {
  const value = process.env[name]
  return value === undefined || value === '' ? undefined : value
}

// Anything that is not recognisably true or false stops the run, rather than counting as false.
// PAMB_DRY_RUN is why: it is the variable someone reaches for when they are nervous about what
// this tool is about to do, and treating an unrecognised value as "no" would publish a branch
// they had just asked it not to touch. `dry-run: 'yes'` in a workflow is a plausible thing to
// write, and it must not quietly perform a real publish reported as a success.
function boolFromEnv (name) {
  const value = fromEnv(name)
  if (value === undefined) return undefined
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false

  throw new Error(
    `${name} is set to "${value}", which is neither true nor false. Use "true" or "false" ` +
    '("1" and "0" also work). Nothing was published: a value that cannot be read as "false" is ' +
    'not assumed to be one.'
  )
}
