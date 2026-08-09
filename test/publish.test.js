// Outside-in tests. Every one of these runs the real command against a real git repository
// with a real remote, and asserts on what actually lands on the published branch. Nothing is
// mocked, and nothing internal is imported — the command's contract is the whole surface.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../src/publish.js', import.meta.url))
const lines = (text) => text.split('\n').filter(Boolean)

// The setup guide is where a mod author copies their first config and workflow from, so those
// blocks are treated as shipped artefacts and driven through the real command below. Both are the
// first fence of their language in the file: the starter config, then the multi-mod example; the
// workflow, then nothing else.
const doc = (name) => readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8')
function block (name, language) {
  const match = doc(name).match(new RegExp('```' + language + '\\n([\\s\\S]*?)```'))
  assert.ok(match, `${name} must contain a ${language} block`)
  return match[1]
}

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


// The local tracking ref outlives a branch deleted on the remote, and a fetch that fails cannot
// correct it — so a run that trusted it would compare equal and report "unchanged" for good.
test('recreates the publish branch after it is deleted on the remote', () => {
  const repo = fixture(MOD)
  repo.publish()
  const stale = repo.tip()
  repo.git('push', '-q', 'origin', '--delete', 'published-mod')
  // Deleting through this clone tidies its tracking ref up too. Put it back, so the run faces
  // what it would if someone had deleted the branch on GitHub instead.
  repo.git('update-ref', 'refs/remotes/origin/published-mod', stale)

  const result = repo.publish()
  assert.equal(result.code, 0)
  assert.doesNotMatch(result.out, /unchanged/)
  assert.deepEqual(repo.published(), ['modinfo.json', 'pa/units/tank.json'])
})

// Moving refs/heads/<target> would rewrite a branch the author has checked out, leaving every
// file in it looking changed. With a remote there is no reason to write a local branch at all.
test('writes no local branch when it has a remote to push to', () => {
  const repo = fixture({ ...MOD, '.modbuild': '{ "root": "Mod", "target": "main" }' })
  const before = repo.git('rev-parse', 'main')
  repo.publish()
  assert.equal(repo.git('rev-parse', 'main'), before)
  assert.equal(repo.git('status', '--porcelain'), '')
})

test('publishes to a local branch when no remote is configured', () => {
  const repo = fixture(MOD)
  repo.git('remote', 'remove', 'origin')
  const result = repo.publish()
  assert.equal(result.code, 0)
  assert.match(result.out, /not pushed, no remote/)
  assert.deepEqual(lines(repo.git('ls-tree', '-r', '--name-only', 'published-mod')), ['modinfo.json', 'pa/units/tank.json'])
})

// The way in for most authors: they already keep a clean branch by hand and want this to take
// it over. It has to build on what is there rather than refusing it or starting again.
test('adopts a publish branch that was maintained by hand', () => {
  const repo = fixture(MOD)
  repo.git('checkout', '-q', '--orphan', 'published-mod')
  repo.git('rm', '-rq', '--cached', '.')
  repo.commit({ 'modinfo.json': '{"identifier":"com.example.mod"}' }, 'hand-built payload')
  repo.git('push', '-q', '-u', 'origin', 'published-mod')
  repo.git('checkout', '-qf', 'main')

  assert.equal(repo.publish().code, 0)
  assert.deepEqual(repo.published(), ['modinfo.json', 'pa/units/tank.json'])
  assert.deepEqual(repo.history(), ['Publish mod from ' + repo.git('rev-parse', '--short=7', 'main'), 'hand-built payload'])
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
  assert.match(result.err, /no \.modbuild in this directory/)
  assert.doesNotMatch(result.err, /at \w+ \(node:/, 'a stack trace is not something a mod author can act on')
})

// The likeliest mistake of the lot: the file is edited by hand in the github.com editor, by
// someone who has never written JSON before.
test('reports a malformed .modbuild with the line the author has to fix', () => {
  const repo = fixture({ ...MOD, '.modbuild': '{\n  "root": "Mod",\n  "target": "published-mod",\n}\n' })
  const result = repo.publish()
  assert.equal(result.code, 1)
  assert.match(result.err, /\.modbuild:/)
  assert.match(result.err, /line 4/)
  assert.doesNotMatch(result.err, /at JSON\.parse/, 'a stack trace is not something a mod author can act on')
  assert.deepEqual(repo.branches(), ['main'], 'nothing must be published from a file that did not parse')
})

test('an unrecognised argument stops the run rather than quietly publishing for real', () => {
  for (const bad of ['--dry-run=true', '--dryrun', '--help', 'published-mod']) {
    const repo = fixture(MOD)
    const result = repo.publish(bad)
    assert.equal(result.code, 1, `expected ${bad} to be rejected`)
    assert.match(result.err, /usage: pa-mod-build/)
    assert.deepEqual(repo.branches(), ['main'], `${bad} must publish nothing`)
  }
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

// The starter config is the first thing a mod author commits, and they commit it by copying it
// out of the guide without being able to test it. Driving the guide's own text through the real
// command is what stops the two drifting — a prefilled config that does not parse, or that
// publishes the files it promises to withhold, is the worst thing this repository could ship.
test('the starter .modbuild in the setup guide publishes the mod and withholds everything else', () => {
  const starter = block('docs/setup.md', 'json')
  assert.doesNotThrow(() => JSON.parse(starter), 'the starter .modbuild must be valid JSON')

  const repo = fixture({
    '.modbuild': starter,
    'modinfo.json': '{"identifier":"com.example.mod"}',
    'pa/units/tank.json': 'tank',
    'ui/main/game.js': 'ui',
    // One file for every rule the starter carries, so a rule quietly dropped from the guide fails
    // here rather than in somebody's mod.
    '.gitattributes': '* text=auto',
    '.github/workflows/publish-mod.yml': 'name: Publish mod',
    '.vscode/settings.json': 'settings',
    '.idea/workspace.xml': 'workspace',
    '.claude/settings.json': 'settings',
    'CLAUDE.md': 'notes',
    'AGENTS.md': 'notes',
    'art/logo.psd': 'psd',
    'art/logo.xcf': 'xcf'
  })

  assert.equal(repo.publish().code, 0)
  assert.deepEqual(repo.published(), ['modinfo.json', 'pa/units/tank.json', 'ui/main/game.js'])
})

// Two copies of the workflow exist because the README is the shop window and the guide is the
// walkthrough, and both have to be right.
test('the workflow in the setup guide and the README are the same file', () => {
  assert.equal(block('docs/setup.md', 'yaml'), block('README.md', 'yaml'))
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
