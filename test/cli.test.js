// test/cli.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeRepo } from './helpers/repo.js'

const run = promisify(execFile)
// fileURLToPath, not URL.pathname: the latter yields "/C:/..." on Windows and percent-encodes
// spaces, neither of which execFile can run.
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url))

async function runCli (args, { cwd, env = {} } = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, PAMB_PUSH: 'false', ...env }
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
  assert.match(result.stderr, /docs\/setup\.md/)
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
  const { makeBareRemote } = await import('./helpers/repo.js')
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
