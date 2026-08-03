#!/usr/bin/env node
// scripts/action-e2e.js
//
// Fixture setup and assertions for .github/workflows/action.yml, which is the only place this
// runs. The contract tests in test/action.test.js check what action.yml says; this checks what
// it does, by running it for real against repositories built here on the runner.
//
//   node scripts/action-e2e.js setup <scenario>
//   node scripts/action-e2e.js check <name> [argument]
//   node scripts/action-e2e.js advance
//
// It lives in scripts/ rather than test/ despite being test code, because `node --test` treats
// every file under a test directory as a test file and would run this one with no arguments on
// every `npm test`. Moving it back is a mistake someone will make once.
//
// The shape is dictated by one constraint: a composite action runs in the workspace and a
// `uses:` step cannot be pointed anywhere else, so the fixture repository has to *be* the
// workspace. The workflow checks this project out to _action and then builds a repository
// around it. `git init` in place, rather than a clone, is what allows the directory to already
// contain _action; the shallow fetch that follows makes it a genuinely shallow repository
// rather than an impression of one, which is the whole point of testing it.
//
// Written in Node rather than shell because it has to behave identically on a Windows runner,
// where `shell: bash` is git-bash and path handling is where this sort of thing quietly breaks.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const WORKSPACE = process.env.GITHUB_WORKSPACE ?? process.cwd()
const TEMP = process.env.RUNNER_TEMP ?? tmpdir()
const REMOTE = path.join(TEMP, 'pamb-remote.git')
const SEED = path.join(TEMP, 'pamb-seed')

// The action's own checkout. Kept when the workspace is reset between scenarios, because
// `uses: ./_action` needs it to still be there.
const KEEP = '_action'

const MODINFO = (name) => JSON.stringify({
  identifier: `com.example.${name}`,
  display_name: name,
  version: '1.0.0'
}, null, 2)

const SCENARIOS = {
  // One mod in a subdirectory, surrounded by the things PA should never have published: editor
  // settings, design sources, a README. Two ignore rules, one a glob and one a directory.
  single: [
    {
      '.modbuild': JSON.stringify({
        root: 'Mod',
        ignore: ['*.psd', 'notes/'],
        target: 'published-mod'
      }),
      'Mod/modinfo.json': MODINFO('example'),
      'Mod/ui/mods/example/main.js': 'console.log("mod")\n',
      'Mod/notes/todo.md': 'not for players\n',
      'Mod/art/logo.psd': 'binary-ish\n',
      'README.md': 'repository readme\n',
      '.vscode/settings.json': '{}\n'
    }
  ],

  // Two mods, two branches, one action step.
  multi: [
    {
      '.modbuild': JSON.stringify({
        mods: [
          { root: 'ModA', target: 'published-a' },
          { root: 'ModB', target: 'published-b', ignore: ['*.psd'] }
        ]
      }),
      'ModA/modinfo.json': MODINFO('a'),
      'ModA/a.js': 'a\n',
      'ModB/modinfo.json': MODINFO('b'),
      'ModB/b.js': 'b\n',
      'ModB/source.psd': 'binary-ish\n'
    }
  ],

  // For proving `config` and `source` in a single run. There is deliberately no .modbuild at
  // the default path, so a run that ignored `config` fails outright rather than passing by
  // accident, and the second commit adds a file that must NOT appear when building the first.
  inputs: [
    {
      'build/mod.json': JSON.stringify({ root: 'Mod', target: 'published-mod' }),
      'Mod/modinfo.json': MODINFO('example'),
      'Mod/old.js': 'old\n'
    },
    { 'Mod/new.js': 'new\n' }
  ]
}

const CHECKS = {
  'dry-run': (summaryFile) => {
    assert.equal(remoteBranches().includes('published-mod'), false,
      'a dry run created a branch on the remote')
    const summary = readSummary(summaryFile)
    assert.match(summary, /dry run/i)
    assert.match(summary, /Would create `published-mod`/)
    // The payload count is what makes the report worth reading before a first real run.
    assert.match(summary, /2 files/)
  },

  published: () => {
    assertTree('published-mod', ['modinfo.json', 'ui/mods/example/main.js'])
    assert.equal(commitCount('published-mod'), 1)
    // The prefix strip is the whole trick: PA needs modinfo.json at the branch root.
    assert.equal(remoteBranches().includes('published-a'), false)
  },

  unchanged: () => {
    assert.equal(commitCount('published-mod'), 1, 'an unchanged run made a second commit')
  },

  'second-publish': () => {
    assertTree('published-mod', ['modinfo.json', 'ui/mods/example/main.js', 'ui/mods/example/extra.js'])
    assert.equal(commitCount('published-mod'), 2)
    // History accumulated rather than being replaced. A force-push would leave one commit, and
    // anyone who had cloned the publish branch would have had it pulled out from under them.
    const [tip, parent] = log('published-mod')
    assert.notEqual(tip, parent)
    assert.match(tip, /^Publish mod v1\.0\.0 from [0-9a-f]{7,}$/)
  },

  multi: () => {
    assertTree('published-a', ['a.js', 'modinfo.json'])
    assertTree('published-b', ['b.js', 'modinfo.json'])
  },

  inputs: () => {
    // Built from `previous` using build/mod.json: the file added by the later commit is absent,
    // which no other combination of inputs produces.
    assertTree('published-mod', ['modinfo.json', 'old.js'])
  },

  summary: (summaryFile) => {
    const summary = readSummary(summaryFile)
    assert.match(summary, /## Mod publish/)
    assert.match(summary, /`Mod` → `published-mod`/)
    assert.match(summary, /Created `published-mod`/)
    assert.match(summary, /Excluded 2 files/)
    assert.match(summary, /`art\/logo\.psd`/)
    assert.match(summary, /`\*\.psd`/)
  }
}

function setup (scenario) {
  const commits = SCENARIOS[scenario]
  if (commits === undefined) fail(`Unknown scenario "${scenario}".`)

  resetWorkspace()
  rmSync(REMOTE, { recursive: true, force: true })
  rmSync(SEED, { recursive: true, force: true })

  git(['init', '-q', '--bare', '-b', 'main', REMOTE], TEMP)
  git(['init', '-q', '-b', 'main', SEED], TEMP)
  configure(SEED)
  git(['remote', 'add', 'origin', remoteUrl()], SEED)

  commits.forEach((files, index) => {
    write(SEED, files)
    git(['add', '-A'], SEED)
    git(['commit', '-q', '-m', `fixture ${index + 1}`], SEED)
    // The first commit doubles as the `previous` branch for the inputs scenario, so a run can
    // be asked to build a commit that is not the tip.
    if (index === 0) git(['branch', '-f', 'previous'], SEED)
  })
  git(['push', '-q', 'origin', 'main', 'previous'], SEED)

  git(['init', '-q', '-b', 'main', WORKSPACE], TEMP)
  configure(WORKSPACE)
  git(['remote', 'add', 'origin', remoteUrl()], WORKSPACE)
  fetchShallow()
  git(['checkout', '-q', '-B', 'main', 'origin/main'], WORKSPACE)

  // A local branch, because a bare `previous` resolves against refs/heads and refs/remotes/<name>
  // but never refs/remotes/origin/<name>. This is also what a real workflow has to arrange for
  // itself when it sets `source` to anything other than the default — see docs/specs/action.md.
  git(['branch', '-f', 'previous', 'origin/previous'], WORKSPACE)

  assert.equal(
    git(['rev-parse', '--is-shallow-repository'], WORKSPACE), 'true',
    'the fixture workspace is not shallow, so it proves nothing about a default checkout'
  )
  report(`${scenario}: workspace is a shallow checkout of ${commits.length} fixture commit(s)`)
}

// A later push to the source branch, as a second workflow run would see it: a new commit on the
// remote and a fresh shallow fetch, not a deepening of what is already here.
function advance () {
  write(SEED, { 'Mod/ui/mods/example/extra.js': 'console.log("extra")\n' })
  git(['add', '-A'], SEED)
  git(['commit', '-q', '-m', 'fixture: later change'], SEED)
  git(['push', '-q', 'origin', 'main'], SEED)

  fetchShallow()
  git(['checkout', '-q', '-B', 'main', 'origin/main'], WORKSPACE)
  report('source branch advanced by one commit')
}

function check (which, argument) {
  const assertion = CHECKS[which]
  if (assertion === undefined) fail(`Unknown check "${which ?? ''}".`)
  assertion(argument)
  report(`check passed: ${which}`)
}

// Everything except the action's own checkout, including the fixture's .git, so each scenario
// starts from nothing.
function resetWorkspace () {
  for (const entry of readdirSync(WORKSPACE)) {
    if (entry === KEEP) continue
    rmSync(path.join(WORKSPACE, entry), { recursive: true, force: true, maxRetries: 3 })
  }
}

function configure (repo) {
  git(['config', 'user.name', 'Fixture'], repo)
  git(['config', 'user.email', 'fixture@example.test'], repo)
  git(['config', 'commit.gpgsign', 'false'], repo)
  // Windows runners default core.autocrlf to true. Published bytes come from the object store
  // rather than the working tree either way, but a fixture that differs by platform is a
  // fixture that will one day fail on one of them for reasons unrelated to the tool.
  git(['config', 'core.autocrlf', 'false'], repo)
}

function fetchShallow () {
  git([
    'fetch', '--depth=1', '--no-tags', '-q', 'origin',
    '+refs/heads/main:refs/remotes/origin/main',
    '+refs/heads/previous:refs/remotes/origin/previous'
  ], WORKSPACE)
}

// file:// rather than a plain path: git ignores --depth for local-path clones and fetches, and
// silently gives a full repository instead. pathToFileURL keeps the Windows drive letter valid.
const remoteUrl = () => pathToFileURL(REMOTE).href

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const inRemote = (args) => git(['--git-dir', REMOTE, ...args], TEMP)

function remoteBranches () {
  const output = inRemote(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
  return output === '' ? [] : output.split('\n')
}

function assertTree (branch, expected) {
  assert.ok(remoteBranches().includes(branch), `${branch} was never pushed to the remote`)
  const actual = inRemote(['ls-tree', '-r', '--name-only', branch]).split('\n').filter(Boolean)
  assert.deepEqual(actual.sort(), [...expected].sort())
}

const commitCount = (branch) => Number(inRemote(['rev-list', '--count', branch]))
const log = (branch) => inRemote(['log', '--format=%s', branch]).split('\n')

function readSummary (file) {
  if (!file) fail('This check needs the path of the step summary file as its argument.')
  // Not merely a missing file: it means the runner did not pass GITHUB_STEP_SUMMARY through to
  // the composite action's steps, so the report went somewhere unasserted.
  assert.ok(existsSync(file), `no step summary was written to ${file}`)
  return readFileSync(file, 'utf8')
}

function write (repo, files) {
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(repo, relative)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, contents)
  }
}

const report = (message) => process.stdout.write(`${message}\n`)

function fail (message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

// Dispatch last, not at the top of the file where it reads better. Most of the helpers above
// are `const` arrow functions, and those stay in the temporal dead zone until their own
// declaration runs — calling setup() any earlier reaches them before they exist.
const [command, name, argument] = process.argv.slice(2)

try {
  if (command === 'setup') setup(name)
  else if (command === 'check') check(name, argument)
  else if (command === 'advance') advance()
  else fail(`Unknown command "${command ?? ''}". Expected setup, check or advance.`)
} catch (error) {
  fail(error.message)
}
