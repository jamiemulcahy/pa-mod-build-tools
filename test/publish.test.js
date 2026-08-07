// Outside-in tests. Every one of these runs the real command against a real git repository
// with a real remote, and asserts on what actually lands on the published branch. Nothing is
// mocked, and nothing internal is imported — the command's contract is the whole surface.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../src/publish.js', import.meta.url))
const lines = (text) => text.split('\n').filter(Boolean)

// A throwaway mod repository, with a bare repo standing in for GitHub.
function fixture (files) {
  const dir = mkdtempSync(join(tmpdir(), 'pamb-test-'))
  const work = join(dir, 'work')
  const origin = join(dir, 'origin.git')

  // Whoever runs this has their own git config, and a suite about git's behaviour must not
  // inherit it: commit.gpgsign with no usable key fails every commit below, and
  // init.defaultBranch renames the branch the assertions are written against. Pointing at paths
  // that do not exist is how you get an empty config on every platform; /dev/null is not.
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(dir, 'no-global-config'),
    GIT_CONFIG_SYSTEM: join(dir, 'no-system-config')
  }
  const run = (args, cwd) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim()
  const git = (...args) => run(args, work)
  const inOrigin = (...args) => run(['-C', origin, ...args], dir)

  run(['init', '-q', '--bare', origin], dir)
  run(['init', '-q', '-b', 'main', work], dir)
  git('config', 'user.email', 'mod@author.test')
  git('config', 'user.name', 'Mod Author')
  git('remote', 'add', 'origin', origin)

  const self = {
    git,
    commit (files, message = 'change') {
      for (const [path, body] of Object.entries(files)) {
        mkdirSync(dirname(join(work, path)), { recursive: true })
        writeFileSync(join(work, path), body)
      }
      git('add', '-A')
      git('commit', '-qm', message)
      return self
    },
    // Runs the command exactly as a user would, and hands back what they would see.
    publish (...args) {
      const { status, stdout, stderr } = spawnSync(process.execPath, [CLI, 'publish', ...args], { cwd: work, env, encoding: 'utf8' })
      return { code: status, out: stdout.trim(), err: stderr.trim() }
    },
    // What a mod author would actually download from the published branch. Read with -z for the
    // same reason the command writes with it: without it git quotes any path that is not plain
    // ASCII, and the readback would disagree with a correctly published tree.
    published: (branch = 'published-mod') =>
      inOrigin('ls-tree', '-r', '-z', '--name-only', branch).split('\0').filter(Boolean),
    tip: (branch = 'published-mod') => inOrigin('rev-parse', branch),
    history: (branch = 'published-mod') => lines(inOrigin('log', '--format=%s', branch)),
    author: (branch = 'published-mod') => inOrigin('log', '-1', '--format=%an <%ae>', branch),
    branches: () => lines(inOrigin('branch', '--format=%(refname:short)'))
  }

  self.commit(files, 'initial')
  git('push', '-q', '-u', 'origin', 'main')
  test.after(() => rmSync(dir, { recursive: true, force: true }))
  return self
}

const MOD = {
  '.modbuild': '{ "root": "Mod", "ignore": ["pachat.zip", "*.psd"] }',
  'Mod/modinfo.json': '{"identifier":"com.example.mod"}',
  'Mod/pa/units/tank.json': 'tank',
  'Mod/pachat.zip': 'zip',
  'Mod/art/logo.psd': 'psd',
  'CLAUDE.md': 'notes',
  '.vscode/settings.json': 'settings'
}

test('publishes the mod root only, minus the ignored files', () => {
  const repo = fixture(MOD)
  assert.equal(repo.publish().code, 0)
  assert.deepEqual(repo.published(), ['modinfo.json', 'pa/units/tank.json'])
})

test('leaves the source branch exactly as it was', () => {
  const repo = fixture(MOD)
  const before = repo.git('rev-parse', 'main')
  repo.publish()
  assert.equal(repo.git('rev-parse', 'main'), before)
  assert.equal(repo.git('status', '--porcelain'), '')
})

test('a second run with no changes makes no commit', () => {
  const repo = fixture(MOD)
  repo.publish()
  const result = repo.publish()
  assert.match(result.out, /unchanged/)
  assert.equal(repo.history().length, 1)
})

test('a change to the mod adds a commit on top of the published branch', () => {
  const repo = fixture(MOD)
  repo.publish()
  repo.commit({ 'Mod/pa/units/bot.json': 'bot' })
  repo.publish()
  assert.deepEqual(repo.published(), ['modinfo.json', 'pa/units/bot.json', 'pa/units/tank.json'])
  assert.equal(repo.history().length, 2)
})

test('a change to an ignored file publishes nothing', () => {
  const repo = fixture(MOD)
  repo.publish()
  repo.commit({ 'Mod/pachat.zip': 'different zip' })
  assert.match(repo.publish().out, /unchanged/)
  assert.equal(repo.history().length, 1)
})

test('a dry run reports what would happen and writes nothing', () => {
  const repo = fixture(MOD)
  const result = repo.publish('--dry-run')
  assert.equal(result.code, 0)
  assert.match(result.out, /would publish 2 files/)
  assert.deepEqual(repo.branches(), ['main'])
})

test('refuses to publish onto the branch you are standing on', () => {
  const repo = fixture({ ...MOD, '.modbuild': '{ "root": "Mod", "target": "main" }' })
  const result = repo.publish()
  assert.equal(result.code, 1)
  assert.match(result.err, /checked out/)
  assert.deepEqual(repo.branches(), ['main'])
})

// The guard above only covers branches this worktree has checked out, which under a detached
// HEAD is none of them — and a detached HEAD is what actions/checkout leaves behind for
// pull_request events. What actually protects a branch is that this tool did not write it.
test('refuses a target branch it did not publish itself, even from a detached HEAD', () => {
  const repo = fixture({ ...MOD, '.modbuild': '{ "root": "Mod", "target": "release" }' })
  repo.git('checkout', '-q', '-b', 'release')
  repo.commit({ 'RELEASE_NOTES.md': 'notes' })
  repo.git('push', '-q', '-u', 'origin', 'release')
  repo.git('checkout', '-q', 'main')
  repo.git('checkout', '-q', '--detach')

  const result = repo.publish()
  assert.equal(result.code, 1)
  assert.match(result.err, /was not published by pa-mod-build/)
  assert.ok(repo.published('release').includes('RELEASE_NOTES.md'), 'the branch must be untouched')
})

test('refuses to build a mod out of a submodule, rather than publishing an empty directory', () => {
  const repo = fixture(MOD)
  repo.git('update-index', '--add', '--cacheinfo', `160000,${repo.git('rev-parse', 'HEAD')},Mod/shared`)
  repo.git('commit', '-qm', 'add a gitlink')
  const result = repo.publish()
  assert.equal(result.code, 1)
  assert.match(result.err, /submodule/)
})

test('publishes several mods to their own branches', () => {
  const repo = fixture({
    '.modbuild': '{ "mods": [{ "root": "ModA", "target": "mod-a" }, { "root": "ModB", "target": "mod-b" }] }',
    'ModA/modinfo.json': 'a',
    'ModB/modinfo.json': 'b'
  })
  assert.equal(repo.publish().code, 0)
  assert.deepEqual(repo.published('mod-a'), ['modinfo.json'])
  assert.deepEqual(repo.published('mod-b'), ['modinfo.json'])
})

test('a root of "." publishes the whole repository', () => {
  const repo = fixture({ '.modbuild': '{ "root": ".", "ignore": ["secret.txt"] }', 'modinfo.json': 'm', 'secret.txt': 's' })
  repo.publish()
  assert.deepEqual(repo.published(), ['.modbuild', 'modinfo.json'])
})

test('ignore rules follow gitignore semantics, negation included', () => {
  const repo = fixture({
    '.modbuild': '{ "root": ".", "ignore": ["*.log", "!keep.log", "build/"] }',
    'modinfo.json': 'm',
    'drop.log': 'x',
    'keep.log': 'x',
    'build/out.js': 'x'
  })
  repo.publish()
  assert.deepEqual(repo.published(), ['.modbuild', 'keep.log', 'modinfo.json'])
})

test('builds from another branch with --source', () => {
  const repo = fixture(MOD)
  repo.git('checkout', '-q', '-b', 'release')
  repo.commit({ 'Mod/pa/units/ship.json': 'ship' })
  repo.git('checkout', '-q', 'main')
  repo.publish('--source', 'release')
  assert.ok(repo.published().includes('pa/units/ship.json'))
})

// Published commits are generated output, and attributing them to the tool is also what lets a
// run work on a runner with no git identity configured.
test('attributes the published commit to the tool, not to whoever ran it', () => {
  const repo = fixture(MOD)
  repo.publish()
  assert.equal(repo.author(), 'pa-mod-build <pa-mod-build@users.noreply.github.com>')
})

test('reports a missing .modbuild rather than publishing something arbitrary', () => {
  const repo = fixture({ 'modinfo.json': 'm' })
  const result = repo.publish()
  assert.equal(result.code, 1)
  assert.match(result.err, /ENOENT|no such file/i)
})

// Config and argument handling must fail closed. Every case below is someone who believes they
// have excluded a file, or asked for no writes at all, and the old behaviour was to publish.
test('a mistyped config key stops the run instead of publishing what it should have excluded', () => {
  const repo = fixture({ ...MOD, '.modbuild': '{ "root": "Mod", "ignores": ["pachat.zip"] }' })
  const result = repo.publish()
  assert.equal(result.code, 1)
  assert.match(result.err, /unknown key "ignores"/)
  assert.deepEqual(repo.branches(), ['main'])
})

test('catches a mistyped key inside a mods entry too', () => {
  const repo = fixture({ '.modbuild': '{ "mods": [{ "root": "Mod", "ignores": ["x"] }] }', 'Mod/modinfo.json': 'm' })
  const result = repo.publish()
  assert.equal(result.code, 1)
  assert.match(result.err, /mods\[0\]: unknown key "ignores"/)
})

// Editors use $schema for completion, so rejecting it would punish the people most likely to
// get the rest of the file right.
test('accepts a $schema key alongside a single mod', () => {
  const repo = fixture({ '.modbuild': '{ "$schema": "https://example.com/s.json", "root": "Mod" }', 'Mod/modinfo.json': 'm' })
  assert.equal(repo.publish().code, 0)
  assert.deepEqual(repo.published(), ['modinfo.json'])
})

test('rejects an "ignore" that is not an array of strings', () => {
  for (const bad of ['null', '"pachat.zip"', '["ok", 42]']) {
    const repo = fixture({ ...MOD, '.modbuild': `{ "root": "Mod", "ignore": ${bad} }` })
    const result = repo.publish()
    assert.equal(result.code, 1, `expected ${bad} to be rejected`)
    assert.match(result.err, /"ignore" must be an array of strings/)
  }
})

test('rejects two mods that would publish to the same branch', () => {
  const repo = fixture({
    '.modbuild': '{ "mods": [{ "root": "ModA" }, { "root": "ModB" }] }',
    'ModA/modinfo.json': 'a',
    'ModB/modinfo.json': 'b'
  })
  const result = repo.publish()
  assert.equal(result.code, 1)
  assert.match(result.err, /more than one mod publishes to "published-mod"/)
})

test('an unrecognised option stops the run rather than quietly publishing for real', () => {
  for (const bad of ['--dry-run=true', '--dryrun', '--help', 'published-mod']) {
    const repo = fixture(MOD)
    const result = repo.publish(bad)
    assert.equal(result.code, 1, `expected ${bad} to be rejected`)
    assert.match(result.err, /unknown option/)
    assert.deepEqual(repo.branches(), ['main'], `${bad} must publish nothing`)
  }
})

test('an option missing its value stops the run rather than using the next flag as one', () => {
  const repo = fixture(MOD)
  const result = repo.publish('--source')
  assert.equal(result.code, 1)
  assert.match(result.err, /--source needs a value/)
})

test('ignore matching is case sensitive, as gitignore is', () => {
  const repo = fixture({ '.modbuild': '{ "root": ".", "ignore": ["ICON.PNG"] }', 'modinfo.json': 'm', 'icon.png': 'i' })
  repo.publish()
  assert.ok(repo.published().includes('icon.png'), 'a differently-cased pattern must not exclude it')
})

// Kills the mutation that drops -z from ls-tree: git quotes these paths without it.
test('publishes paths containing spaces and non-ASCII characters', () => {
  const repo = fixture({
    '.modbuild': '{ "root": "Mod" }',
    'Mod/modinfo.json': 'm',
    'Mod/with space.json': 's',
    'Mod/ünïcode/naïve.json': 'u'
  })
  repo.publish()
  assert.deepEqual(repo.published(), ['modinfo.json', 'with space.json', 'ünïcode/naïve.json'])
})

// Kills the mutation that matches on `root` rather than `root + "/"`.
test('a sibling directory sharing the root prefix is not swept in', () => {
  const repo = fixture({ '.modbuild': '{ "root": "Mod" }', 'Mod/modinfo.json': 'm', 'ModTools/build.js': 't' })
  repo.publish()
  assert.deepEqual(repo.published(), ['modinfo.json'])
})

// Kills the mutation that adds --force to the push. With the fetch broken the run cannot see
// the remote's history, so it builds an orphan commit — which must be refused, not forced.
test('a push that would discard published history is refused', () => {
  const repo = fixture(MOD)
  repo.publish()
  const beforeSha = repo.tip()

  repo.git('config', 'remote.origin.pushurl', repo.git('config', 'remote.origin.url'))
  repo.git('config', 'remote.origin.url', join(tmpdir(), 'pamb-does-not-exist.git'))
  // Both, so nothing local remembers the published history. A successful push updates the
  // remote-tracking ref too, so deleting only the local branch would leave a usable parent
  // and the push below would be an ordinary fast-forward rather than the case under test.
  repo.git('update-ref', '-d', 'refs/remotes/origin/published-mod')
  repo.git('update-ref', '-d', 'refs/heads/published-mod')
  repo.commit({ 'Mod/pa/units/bot.json': 'bot' })

  const result = repo.publish()
  assert.equal(result.code, 1)
  assert.match(result.err, /non-fast-forward|rejected|fetch first/i)
  assert.equal(repo.tip(), beforeSha, 'remote history must survive')
})

// Kills the mutation that moves the local ref before the push: a payload that never reached the
// remote must not make the next run report success.
test('a run after a failed push retries instead of reporting unchanged', () => {
  const repo = fixture(MOD)
  repo.git('config', 'remote.origin.pushurl', join(tmpdir(), 'pamb-does-not-exist.git'))

  assert.equal(repo.publish().code, 1)
  const second = repo.publish()
  assert.equal(second.code, 1, 'the second run must fail too, not report success')
  assert.doesNotMatch(second.out, /unchanged/)
  assert.deepEqual(repo.branches(), ['main'], 'nothing reached the remote')
})
