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

  const options = {
    repoPath: parsed.values.repo ?? process.env.PAMB_REPO ?? process.cwd(),
    configPath: parsed.values.config ?? process.env.PAMB_CONFIG ?? '.modbuild',
    source: parsed.values.source ?? process.env.PAMB_SOURCE ?? 'HEAD',
    dryRun: parsed.values['dry-run'] ?? isTrue(process.env.PAMB_DRY_RUN),
    push: parsed.values['no-push'] ? false : !isFalse(process.env.PAMB_PUSH)
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
const REMOTE_COMMANDS = ['fetch', 'push', 'ls-remote']

function describeGitError (error) {
  // error.command is "git <subcommand> <args...>"; the remote is the first bare argument.
  const [, subcommand, ...args] = (error.command ?? '').split(' ')
  if (!REMOTE_COMMANDS.includes(subcommand)) return error.message

  const remote = args.find((argument) => !argument.startsWith('-'))
  const named = remote === undefined ? 'the remote' : `the remote "${remote}"`
  return `${error.message}\n\nThis step contacts ${named}. Check your network connection and ` +
    'that you still have access to that repository.'
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

// Function declarations, not `const` arrow functions: main() runs synchronously (it does not hit
// its first `await` until `publish(options)`) as a direct result of `main().catch(...)` below, so
// by the time it builds `options` these two must already be usable. `const` bindings stay in the
// temporal dead zone until their own declaration executes, which is after main() has already run
// — function declarations are hoisted in full, so they are callable from anywhere in the module.
function isTrue (value) { return value === 'true' || value === '1' }
function isFalse (value) { return value === 'false' || value === '0' }
