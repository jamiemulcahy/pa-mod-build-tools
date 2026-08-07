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
  // inherit it — core.autocrlf alone would change what lands in a published tree. Pointing at
  // paths that do not exist is how you get an empty config on every platform; /dev/null is not.
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
    // What a mod author would actually download from the published branch.
    published: (branch = 'published-mod') => lines(inOrigin('ls-tree', '-r', '--name-only', branch)),
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
  assert.match(result.err, /would overwrite your work/)
  assert.deepEqual(repo.branches(), ['main'])
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
