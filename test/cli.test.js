// test/cli.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeRepo, makeBareRemote } from './helpers/repo.js'

const run = promisify(execFile)
// fileURLToPath, not URL.pathname: the latter yields "/C:/..." on Windows and percent-encodes
// spaces, neither of which execFile can run.
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url))

// The suite itself runs in GitHub Actions, where GITHUB_STEP_SUMMARY and GITHUB_ACTIONS are
// already set. Inheriting them would send every report to the job summary file instead of
// stdout — and silently make the committer-identity test pass for the wrong reason — so they are
// stripped here and each test opts in explicitly through `env`, which is applied last.
function ambientEnv () {
  const { GITHUB_STEP_SUMMARY, GITHUB_ACTIONS, ...rest } = process.env
  return rest
}

async function runCli (args, { cwd, env = {} } = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...ambientEnv(), PAMB_PUSH: 'false', ...env }
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

test('publish reports to stdout and exits 0', async (t) => {
  const repo = await makeRepo({
    '.modbuild': JSON.stringify({ root: 'Mod' }),
    'Mod/modinfo.json': '{"version":"1.0.0"}'
  })
  t.after(() => repo.cleanup())

  const result = await runCli(['publish'], { cwd: repo.dir })

  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /published-mod/)
  assert.match(result.stdout, /Mod/)
})

test('a no-change second run still exits 0', async (t) => {
  const repo = await makeRepo({ '.modbuild': JSON.stringify({ root: 'Mod' }), 'Mod/modinfo.json': '{}' })
  t.after(() => repo.cleanup())

  await runCli(['publish'], { cwd: repo.dir })
  const second = await runCli(['publish'], { cwd: repo.dir })

  assert.equal(second.code, 0)
  assert.match(second.stdout, /no changes/)
})

test('the report goes to GITHUB_STEP_SUMMARY when set, not stdout', async (t) => {
  const repo = await makeRepo({ '.modbuild': JSON.stringify({ root: 'Mod' }), 'Mod/modinfo.json': '{}' })
  t.after(() => repo.cleanup())
  const summaryFile = path.join(repo.dir, 'step-summary.md')

  const result = await runCli(['publish'], { cwd: repo.dir, env: { GITHUB_STEP_SUMMARY: summaryFile } })

  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout.includes('published-mod'), false)
  assert.match(await readFile(summaryFile, 'utf8'), /published-mod/)
})

test('--dry-run writes nothing', async (t) => {
  const repo = await makeRepo({ '.modbuild': JSON.stringify({ root: 'Mod' }), 'Mod/modinfo.json': '{}' })
  t.after(() => repo.cleanup())

  const result = await runCli(['publish', '--dry-run'], { cwd: repo.dir })

  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /dry run/i)
  await assert.rejects(() => repo.git('rev-parse', '--verify', 'refs/heads/published-mod'))
})

test('PAMB_DRY_RUN has the same effect as the flag', async (t) => {
  const repo = await makeRepo({ '.modbuild': JSON.stringify({ root: 'Mod' }), 'Mod/modinfo.json': '{}' })
  t.after(() => repo.cleanup())

  const result = await runCli(['publish'], { cwd: repo.dir, env: { PAMB_DRY_RUN: 'true' } })

  assert.match(result.stdout, /dry run/i)
  await assert.rejects(() => repo.git('rev-parse', '--verify', 'refs/heads/published-mod'))
})

// GitHub Actions expressions collapse to an empty string rather than to nothing, so an input
// nobody supplied still arrives as PAMB_CONFIG="". Reading that as a real value would send the
// tool looking for a config file at "" and fail a run that should have used its default.
test('an empty environment variable counts as unset', async (t) => {
  const repo = await makeRepo({ '.modbuild': JSON.stringify({ root: 'Mod' }), 'Mod/modinfo.json': '{}' })
  t.after(() => repo.cleanup())

  const result = await runCli(['publish'], {
    cwd: repo.dir,
    env: { PAMB_CONFIG: '', PAMB_SOURCE: '', PAMB_REPO: '', PAMB_DRY_RUN: '' }
  })

  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /published-mod/)
  assert.doesNotMatch(result.stdout, /dry run/i)
})

// The one that would hurt: someone nervous enough about this tool to reach for a dry run,
// whose spelling of "yes" is not one of the four accepted words, must not get a real publish
// reported back to them as a success.
test('a PAMB_DRY_RUN that is neither true nor false stops the run', async (t) => {
  const repo = await makeRepo({ '.modbuild': JSON.stringify({ root: 'Mod' }), 'Mod/modinfo.json': '{}' })
  t.after(() => repo.cleanup())

  const result = await runCli(['publish'], { cwd: repo.dir, env: { PAMB_DRY_RUN: 'yes' } })

  assert.equal(result.code, 1)
  assert.match(result.stderr, /PAMB_DRY_RUN/)
  assert.match(result.stderr, /"yes"/)
  assert.match(result.stderr, /true|false/)
  await assert.rejects(() => repo.git('rev-parse', '--verify', 'refs/heads/published-mod'))
})

test('PAMB_PUSH is held to the same standard', async (t) => {
  const repo = await makeRepo({ '.modbuild': JSON.stringify({ root: 'Mod' }), 'Mod/modinfo.json': '{}' })
  t.after(() => repo.cleanup())

  const result = await runCli(['publish'], { cwd: repo.dir, env: { PAMB_PUSH: 'nope' } })

  assert.equal(result.code, 1)
  assert.match(result.stderr, /PAMB_PUSH/)
  await assert.rejects(() => repo.git('rev-parse', '--verify', 'refs/heads/published-mod'))
})

test('the four accepted spellings still work', async (t) => {
  const repo = await makeRepo({ '.modbuild': JSON.stringify({ root: 'Mod' }), 'Mod/modinfo.json': '{}' })
  t.after(() => repo.cleanup())

  for (const value of ['true', '1']) {
    const result = await runCli(['publish'], { cwd: repo.dir, env: { PAMB_DRY_RUN: value } })
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /dry run/i)
  }
  for (const value of ['false', '0']) {
    const result = await runCli(['publish'], { cwd: repo.dir, env: { PAMB_DRY_RUN: value } })
    assert.equal(result.code, 0, result.stderr)
    assert.doesNotMatch(result.stdout, /dry run/i)
  }
})

test('a flag beats the environment variable', async (t) => {
  const repo = await makeRepo({
    '.modbuild': JSON.stringify({ root: 'Mod' }),
    'custom.json': JSON.stringify({ root: 'Mod', target: 'from-flag' }),
    'Mod/modinfo.json': '{}'
  })
  t.after(() => repo.cleanup())

  const result = await runCli(['publish', '--config', 'custom.json'], {
    cwd: repo.dir,
    env: { PAMB_CONFIG: '.modbuild' }
  })

  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /from-flag/)
})

test('--repo runs against another directory', async (t) => {
  const repo = await makeRepo({ '.modbuild': JSON.stringify({ root: 'Mod' }), 'Mod/modinfo.json': '{}' })
  t.after(() => repo.cleanup())

  const result = await runCli(['publish', '--repo', repo.dir], { cwd: process.cwd() })

  assert.equal(result.code, 0, result.stderr)
})

test('a missing .modbuild exits 1 with an actionable message on stderr', async (t) => {
  const repo = await makeRepo({ 'modinfo.json': '{}' })
  t.after(() => repo.cleanup())

  const result = await runCli(['publish'], { cwd: repo.dir })

  assert.equal(result.code, 1)
  assert.match(result.stderr, /\.modbuild/)
  assert.match(result.stderr, /README/)
})

test('an extra argument after publish exits 1 rather than being ignored', async (t) => {
  const repo = await makeRepo({ '.modbuild': JSON.stringify({ root: 'Mod' }), 'Mod/modinfo.json': '{}' })
  t.after(() => repo.cleanup())

  const result = await runCli(['publish', 'published-mod'], { cwd: repo.dir })

  assert.equal(result.code, 1)
  assert.match(result.stderr, /published-mod/)
  assert.match(result.stderr, /\.modbuild/)
  await assert.rejects(() => repo.git('rev-parse', '--verify', 'refs/heads/published-mod'))
})

test('an unknown subcommand exits 1 and lists what is available', async () => {
  const result = await runCli(['frobnicate'])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /publish/)
})

test('no subcommand prints usage and exits 1', async () => {
  const result = await runCli([])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /pa-mod-build publish/)
})

test('an unknown flag exits 1 naming the flag', async (t) => {
  const repo = await makeRepo({ '.modbuild': JSON.stringify({ root: 'Mod' }), 'Mod/modinfo.json': '{}' })
  t.after(() => repo.cleanup())

  const result = await runCli(['publish', '--target', 'x'], { cwd: repo.dir })

  assert.equal(result.code, 1)
  assert.match(result.stderr, /--target/)
})

test('--help exits 0 and documents every option', async () => {
  const result = await runCli(['--help'])
  assert.equal(result.code, 0)
  for (const flag of ['--config', '--source', '--repo', '--dry-run', '--no-push']) {
    assert.ok(result.stdout.includes(flag), `help omits ${flag}`)
  }
})

// Every other test here sets PAMB_PUSH=false in the environment, so the flag itself is otherwise
// never exercised — and parseArgs treats a "--no-" prefix specially on newer Node, which could
// quietly change what this flag means.
test('--no-push as a flag commits locally and pushes nothing', async (t) => {
  const repo = await makeRepo({ '.modbuild': JSON.stringify({ root: 'Mod' }), 'Mod/modinfo.json': '{}' })
  const remote = await makeBareRemote()
  t.after(async () => {
    await repo.cleanup()
    await remote.cleanup()
  })
  await repo.git('remote', 'add', 'origin', remote.dir)

  // PAMB_PUSH=true, so only the flag can stop the push.
  const result = await runCli(['publish', '--no-push'], { cwd: repo.dir, env: { PAMB_PUSH: 'true' } })

  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /not pushed/)
  await repo.git('rev-parse', '--verify', 'refs/heads/published-mod')
  await assert.rejects(
    () => remote.git('rev-parse', '--verify', 'refs/heads/published-mod'),
    'nothing may reach the remote'
  )
})

test('a git failure is reported as a message, never as a stack trace', async (t) => {
  const repo = await makeRepo({ '.modbuild': JSON.stringify({ root: 'Mod' }), 'Mod/modinfo.json': '{}' })
  t.after(() => repo.cleanup())

  // An origin that cannot be reached. Because this run pushes, the fetch failure is fatal, so a
  // GitError reaches the CLI's top level — the common case for a mod author with no network.
  await repo.git('remote', 'add', 'origin', path.join(repo.dir, 'no-such-remote'))

  const result = await runCli(['publish'], { cwd: repo.dir, env: { PAMB_PUSH: 'true' } })

  assert.equal(result.code, 1)
  assert.match(result.stderr, /ls-remote|does not appear to be a git repository/i)
  assert.equal(/^ {4}at /m.test(result.stderr), false, `stack frames leaked:\n${result.stderr}`)
  assert.match(result.stderr, /origin/)
  assert.match(result.stderr, /network connection/i)
  // Nothing had been published when it failed, so there is no partial report worth printing.
  assert.equal(result.stdout.trim(), '')
})

test('a partial multi-mod failure renders the partial report and keeps the error on stderr', async (t) => {
  const remote = await makeBareRemote()
  t.after(() => remote.cleanup())

  // Two mods, published in this order. An unrelated branch "published-mod-b/old" already exists
  // in the repository, and git's ref store cannot represent that alongside a branch literally
  // named "published-mod-b" — a ref cannot be both a leaf and a directory. Mod A's ref is
  // created first (phase 1 processes mods in order), so mod B's ref update then fails
  // deterministically with a ref-lock conflict, part way through a multi-mod run and before any
  // push is attempted — a genuine partial failure with no reliance on timing or environment
  // tricks. The conflict comes from a pre-existing branch rather than from the two targets
  // themselves because config.js now rejects targets that nest inside one another up front.
  const repo = await makeRepo({
    '.modbuild': JSON.stringify({
      mods: [
        { root: 'ModA', target: 'published-mod-a' },
        { root: 'ModB', target: 'published-mod-b' }
      ]
    }),
    'ModA/modinfo.json': '{"version":"1.0.0"}',
    'ModB/modinfo.json': '{"version":"1.0.0"}'
  })
  t.after(() => repo.cleanup())

  await repo.git('branch', 'published-mod-b/old', 'main')
  await repo.git('remote', 'add', 'origin', remote.dir)

  const result = await runCli(['publish'], { cwd: repo.dir, env: { PAMB_PUSH: 'true' } })

  assert.equal(result.code, 1)
  assert.match(result.stderr, /cannot lock ref|update-ref/i)
  assert.match(result.stdout, /published-mod-a/)
  assert.match(result.stdout, /Created|Committed/)
})
