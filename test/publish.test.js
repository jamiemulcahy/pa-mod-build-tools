// test/publish.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises'
import { publish, PublishError } from '../src/publish.js'
import { ConfigError } from '../src/config.js'
import { makeRepo, makeBareRemote } from './helpers/repo.js'

const modbuild = (config) => JSON.stringify(config)

async function listBranch (repo, branch) {
  const { stdout } = await repo.git('ls-tree', '-r', '--name-only', branch)
  return stdout.trim() === '' ? [] : stdout.trim().split('\n').sort()
}

test('a mod at the repository root publishes every tracked file but the config', async (t) => {
  const repo = await makeRepo({
    '.modbuild': modbuild({ root: '.', ignore: ['.modbuild', 'work/'] }),
    'modinfo.json': '{"version":"1.2.3"}',
    'icon.png': 'png',
    'ui/mods/instant_sandbox/start.js': 'js',
    'work/icon.xcf': 'xcf'
  })
  t.after(() => repo.cleanup())

  const report = await publish({ repoPath: repo.dir, push: false })

  assert.equal(report.mods.length, 1)
  assert.equal(report.mods[0].created, true)
  assert.equal(report.mods[0].unchanged, false)
  assert.deepEqual(await listBranch(repo, 'published-mod'), [
    'icon.png', 'modinfo.json', 'ui/mods/instant_sandbox/start.js'
  ])
  assert.deepEqual(
    report.mods[0].excluded.map((file) => file.path).sort(),
    ['.modbuild', 'work/icon.xcf']
  )
})

test('a mod in a subdirectory is hoisted to the branch root', async (t) => {
  const repo = await makeRepo({
    '.modbuild': modbuild({ root: 'Mod', ignore: ['pachat.zip', '.jshintrc'] }),
    'CLAUDE.md': 'x',
    'Logo.psd': 'psd',
    'Server/Program.cs': 'cs',
    'Mod/.jshintrc': '{}',
    'Mod/pachat.zip': 'zip',
    'Mod/modinfo.json': '{"version":"1.6.6"}',
    'Mod/ui/mods/pa-chat/chat.js': 'js'
  })
  t.after(() => repo.cleanup())

  await publish({ repoPath: repo.dir, push: false })

  assert.deepEqual(await listBranch(repo, 'published-mod'), ['modinfo.json', 'ui/mods/pa-chat/chat.js'])
})

test('the commit message names the version and the source commit', async (t) => {
  const repo = await makeRepo({
    '.modbuild': modbuild({ root: 'Mod' }),
    'Mod/modinfo.json': '{"version":"1.6.6"}'
  })
  t.after(() => repo.cleanup())

  const report = await publish({ repoPath: repo.dir, push: false })
  const { stdout } = await repo.git('log', '-1', '--format=%s', 'published-mod')
  assert.equal(stdout.trim(), `Publish mod v1.6.6 from ${report.source.sha.slice(0, 7)}`)
})

test('a payload without a readable version omits it from the message', async (t) => {
  const repo = await makeRepo({
    '.modbuild': modbuild({ root: 'Mod' }),
    'Mod/modinfo.json': 'not json'
  })
  t.after(() => repo.cleanup())

  const report = await publish({ repoPath: repo.dir, push: false })
  const { stdout } = await repo.git('log', '-1', '--format=%s', 'published-mod')
  assert.equal(stdout.trim(), `Publish mod from ${report.source.sha.slice(0, 7)}`)
})

test('a second run with no changes creates no commit', async (t) => {
  const repo = await makeRepo({
    '.modbuild': modbuild({ root: 'Mod' }),
    'Mod/modinfo.json': '{"version":"1"}'
  })
  t.after(() => repo.cleanup())

  const first = await publish({ repoPath: repo.dir, push: false })
  const before = (await repo.git('rev-parse', 'published-mod')).stdout.trim()

  const second = await publish({ repoPath: repo.dir, push: false })
  const after = (await repo.git('rev-parse', 'published-mod')).stdout.trim()

  assert.equal(first.mods[0].unchanged, false)
  assert.equal(second.mods[0].unchanged, true)
  assert.equal(second.mods[0].commit, null)
  assert.equal(before, after)
})

test('a change outside the payload creates no commit', async (t) => {
  const repo = await makeRepo({
    '.modbuild': modbuild({ root: 'Mod' }),
    'Mod/modinfo.json': '{"version":"1"}',
    'README.md': 'first'
  })
  t.after(() => repo.cleanup())

  await publish({ repoPath: repo.dir, push: false })
  const before = (await repo.git('rev-parse', 'published-mod')).stdout.trim()

  await repo.commit({ 'README.md': 'second' }, 'docs')
  const report = await publish({ repoPath: repo.dir, push: false })

  assert.equal(report.mods[0].unchanged, true)
  assert.equal((await repo.git('rev-parse', 'published-mod')).stdout.trim(), before)
})

test('a payload change commits on top of the previous publish', async (t) => {
  const repo = await makeRepo({
    '.modbuild': modbuild({ root: 'Mod' }),
    'Mod/modinfo.json': '{"version":"1"}'
  })
  t.after(() => repo.cleanup())

  await publish({ repoPath: repo.dir, push: false })
  const first = (await repo.git('rev-parse', 'published-mod')).stdout.trim()

  await repo.commit({ 'Mod/modinfo.json': '{"version":"2"}' }, 'bump')
  const report = await publish({ repoPath: repo.dir, push: false })

  assert.equal(report.mods[0].unchanged, false)
  assert.equal(report.mods[0].created, false)
  const parents = await repo.git('rev-list', '--parents', '-n', '1', 'published-mod')
  assert.equal(parents.stdout.trim().split(' ')[1], first)
})

test('two mods publish to two branches from one invocation', async (t) => {
  const repo = await makeRepo({
    '.modbuild': modbuild({
      mods: [
        { root: 'mods/a', target: 'published-a' },
        { root: 'mods/b', target: 'published-b', ignore: ['*.psd'] }
      ]
    }),
    'mods/a/modinfo.json': '{"version":"1"}',
    'mods/a/ui/a.js': 'a',
    'mods/b/modinfo.json': '{"version":"2"}',
    'mods/b/art.psd': 'psd'
  })
  t.after(() => repo.cleanup())

  const report = await publish({ repoPath: repo.dir, push: false })

  assert.equal(report.mods.length, 2)
  assert.deepEqual(await listBranch(repo, 'published-a'), ['modinfo.json', 'ui/a.js'])
  assert.deepEqual(await listBranch(repo, 'published-b'), ['modinfo.json'])
})

test('a failure on the second mod leaves the first unpublished', async (t) => {
  const repo = await makeRepo({
    '.modbuild': modbuild({
      mods: [
        { root: 'mods/a', target: 'published-a' },
        { root: 'mods/missing', target: 'published-b' }
      ]
    }),
    'mods/a/modinfo.json': '{"version":"1"}'
  })
  t.after(() => repo.cleanup())

  await assert.rejects(() => publish({ repoPath: repo.dir, push: false }), PublishError)

  const { code } = await createRefCheck(repo, 'published-a')
  assert.notEqual(code, 0, 'no branch may exist when any mod failed to resolve')
})

async function createRefCheck (repo, branch) {
  try {
    await repo.git('rev-parse', '--verify', `refs/heads/${branch}`)
    return { code: 0 }
  } catch {
    return { code: 1 }
  }
}

test('a missing root is reported with a hint naming directories holding a modinfo.json', async (t) => {
  const repo = await makeRepo({
    '.modbuild': modbuild({ root: 'Mods' }),
    'Mod/modinfo.json': '{}'
  })
  t.after(() => repo.cleanup())

  const error = await publish({ repoPath: repo.dir, push: false }).catch((caught) => caught)
  assert.ok(error instanceof PublishError)
  assert.ok(error.message.includes('Mods'), error.message)
  assert.ok(error.message.includes('Mod'), error.message)
})

test('the missing-root hint does not mistake a lookalike file for a manifest', async (t) => {
  const repo = await makeRepo({
    '.modbuild': modbuild({ root: 'Mods' }),
    'Mod/custom_modinfo.json': '{}'
  })
  t.after(() => repo.cleanup())

  const error = await publish({ repoPath: repo.dir, push: false }).catch((caught) => caught)
  assert.ok(error instanceof PublishError)
  assert.ok(!/directories.*contain a modinfo\.json/i.test(error.message), error.message)
  assert.ok(/no modinfo\.json was found/i.test(error.message), error.message)
})

test('an empty payload is distinguished from a missing root', async (t) => {
  const repo = await makeRepo({
    '.modbuild': modbuild({ root: 'Mod', ignore: ['*'] }),
    'Mod/modinfo.json': '{}'
  })
  t.after(() => repo.cleanup())

  const error = await publish({ repoPath: repo.dir, push: false }).catch((caught) => caught)
  assert.ok(error instanceof PublishError)
  assert.ok(/ignore/i.test(error.message), error.message)
})

test('publishing to the source branch is refused', async (t) => {
  const repo = await makeRepo({ '.modbuild': modbuild({ root: '.', target: 'main' }), 'modinfo.json': '{}' })
  t.after(() => repo.cleanup())

  const error = await publish({ repoPath: repo.dir, push: false }).catch((caught) => caught)
  assert.ok(error instanceof PublishError)
  assert.ok(error.message.includes('main'), error.message)
})

test('publishing to the branch that is checked out is refused', async (t) => {
  const repo = await makeRepo({
    '.modbuild': modbuild({ root: 'Mod', target: 'release' }),
    'Mod/modinfo.json': '{}',
    'NOTES.md': 'keep me'
  })
  t.after(() => repo.cleanup())

  // "release" exists and is checked out; the run builds from main, so the source-branch guard
  // does not fire and only the checked-out guard can catch this.
  await repo.git('branch', 'release', 'main')
  const before = (await repo.git('rev-parse', 'refs/heads/release')).stdout.trim()
  await repo.git('checkout', '-q', 'release')

  const error = await publish({ repoPath: repo.dir, source: 'main', push: false })
    .catch((caught) => caught)

  assert.ok(error instanceof PublishError, `expected PublishError, got ${error}`)
  assert.ok(error.message.includes('release'), error.message)
  assert.ok(/checked out/i.test(error.message), error.message)

  assert.equal((await repo.git('rev-parse', 'refs/heads/release')).stdout.trim(), before)
  assert.equal((await repo.git('status', '--porcelain')).stdout.trim(), '')
})

test('a missing modinfo.json warns, naming a deeper one when there is one', async (t) => {
  const repo = await makeRepo({
    '.modbuild': modbuild({ root: '.' }),
    'ui/mods/x/modinfo.json': '{}'
  })
  t.after(() => repo.cleanup())

  const report = await publish({ repoPath: repo.dir, push: false })
  const warning = report.mods[0].warnings.join('\n')
  assert.ok(warning.includes('modinfo.json'), warning)
  assert.ok(warning.includes('ui/mods/x/modinfo.json'), warning)
})

test('a payload with modinfo.json at its root warns about nothing', async (t) => {
  const repo = await makeRepo({ '.modbuild': modbuild({ root: '.' }), 'modinfo.json': '{}' })
  t.after(() => repo.cleanup())

  const report = await publish({ repoPath: repo.dir, push: false })
  assert.deepEqual(report.mods[0].warnings, [])
})

test('the report carries file count and total size', async (t) => {
  const repo = await makeRepo({
    '.modbuild': modbuild({ root: 'Mod' }),
    'Mod/modinfo.json': 'abc',
    'Mod/a.js': 'de'
  })
  t.after(() => repo.cleanup())

  const report = await publish({ repoPath: repo.dir, push: false })
  assert.equal(report.mods[0].fileCount, 2)
  assert.equal(report.mods[0].totalBytes, 5)
})

test('dry run reports what would happen and moves no ref', async (t) => {
  const repo = await makeRepo({ '.modbuild': modbuild({ root: 'Mod' }), 'Mod/modinfo.json': '{}' })
  t.after(() => repo.cleanup())

  const report = await publish({ repoPath: repo.dir, dryRun: true, push: false })

  assert.equal(report.dryRun, true)
  assert.equal(report.mods[0].fileCount, 1)
  assert.equal(report.mods[0].commit, null)
  assert.equal(report.mods[0].unchanged, false, 'a dry run still reports that a commit would happen')
  const { code } = await createRefCheck(repo, 'published-mod')
  assert.equal(code, 1, 'dry run must not create the branch')
})

test('the caller working tree and index are untouched by a real publish', async (t) => {
  const repo = await makeRepo({ '.modbuild': modbuild({ root: 'Mod' }), 'Mod/modinfo.json': '{}' })
  t.after(() => repo.cleanup())

  await publish({ repoPath: repo.dir, push: false })

  const status = await repo.git('status', '--porcelain')
  assert.equal(status.stdout.trim(), '')
  assert.equal((await repo.git('rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim(), 'main')
})

test('publishing pushes to origin and reports it', async (t) => {
  const repo = await makeRepo({ '.modbuild': modbuild({ root: 'Mod' }), 'Mod/modinfo.json': '{}' })
  const remote = await makeBareRemote()
  t.after(async () => {
    await repo.cleanup()
    await remote.cleanup()
  })
  await repo.git('remote', 'add', 'origin', remote.dir)

  const report = await publish({ repoPath: repo.dir })

  assert.equal(report.remote, 'origin')
  assert.equal(report.mods[0].pushed, true)
  const pushed = await remote.git('rev-parse', 'refs/heads/published-mod')
  assert.equal(pushed.stdout.trim(), report.mods[0].commit)
})

test('with no remote the run commits and reports that nothing was pushed', async (t) => {
  const repo = await makeRepo({ '.modbuild': modbuild({ root: 'Mod' }), 'Mod/modinfo.json': '{}' })
  t.after(() => repo.cleanup())

  const report = await publish({ repoPath: repo.dir })

  assert.equal(report.remote, null)
  assert.equal(report.mods[0].pushed, false)
  assert.notEqual(report.mods[0].commit, null)
})

test('an existing origin branch is preferred over a stale local one', async (t) => {
  const repo = await makeRepo({ '.modbuild': modbuild({ root: 'Mod' }), 'Mod/modinfo.json': '{"v":1}' })
  const remote = await makeBareRemote()
  t.after(async () => {
    await repo.cleanup()
    await remote.cleanup()
  })
  await repo.git('remote', 'add', 'origin', remote.dir)

  const first = await publish({ repoPath: repo.dir })

  // Rewind the local branch so it no longer matches what origin holds.
  await repo.git('update-ref', 'refs/heads/published-mod', repo.head)

  await repo.commit({ 'Mod/modinfo.json': '{"v":2}' }, 'bump')
  const second = await publish({ repoPath: repo.dir })

  const parents = await repo.git('rev-list', '--parents', '-n', '1', second.mods[0].commit)
  assert.equal(
    parents.stdout.trim().split(' ')[1],
    first.mods[0].commit,
    'the new commit must sit on top of what origin published, not the stale local ref'
  )
})

test('a push failure on the second mod leaves the first committed and reports what was pushed', async (t) => {
  const repo = await makeRepo({
    '.modbuild': modbuild({
      mods: [
        { root: 'mods/a', target: 'published-a' },
        { root: 'mods/b', target: 'published-b' }
      ]
    }),
    'mods/a/modinfo.json': '{"version":"1"}',
    'mods/b/modinfo.json': '{"version":"1"}'
  })
  const remote = await makeBareRemote()
  t.after(async () => {
    await repo.cleanup()
    await remote.cleanup()
  })
  await repo.git('remote', 'add', 'origin', remote.dir)

  // A pre-receive hook standing in for a flaky network or an auth failure that only shows up
  // partway through a multi-mod push: it accepts published-a but rejects published-b, so the
  // first mod's push succeeds and the second's fails deterministically.
  const hookPath = path.join(remote.dir, 'hooks', 'pre-receive')
  await writeFile(
    hookPath,
    '#!/bin/sh\nwhile read old new ref; do case "$ref" in *published-b*) exit 1;; esac; done\n'
  )
  await chmod(hookPath, 0o755)

  const error = await publish({ repoPath: repo.dir }).catch((caught) => caught)

  assert.ok(error, 'the push failure must reject the publish() call')
  assert.ok(error.report, 'the thrown error must carry the partial report')
  assert.equal(error.report.mods.length, 2)

  const [a, b] = error.report.mods
  assert.equal(a.target, 'published-a')
  assert.equal(a.pushed, true)
  assert.notEqual(a.commit, null)
  assert.equal(b.target, 'published-b')
  assert.equal(b.pushed, false)
  assert.notEqual(b.commit, null, 'the second mod must still be committed locally even though the push failed')

  assert.equal((await repo.git('rev-parse', 'published-a')).stdout.trim(), a.commit)
  assert.equal((await repo.git('rev-parse', 'published-b')).stdout.trim(), b.commit)
})

test('running outside a git repository fails with an actionable message', async (t) => {
  const plain = await mkdtemp(path.join(tmpdir(), 'pamb-plain-'))
  t.after(() => rm(plain, { recursive: true, force: true }))

  const error = await publish({ repoPath: plain }).catch((caught) => caught)
  assert.ok(error instanceof PublishError)
  assert.match(error.message, /not a git repository/)
  assert.match(error.message, /--repo/)
})

test('an unresolvable --source fails naming the ref', async (t) => {
  const repo = await makeRepo({ '.modbuild': modbuild({ root: 'Mod' }), 'Mod/modinfo.json': '{}' })
  t.after(() => repo.cleanup())

  const error = await publish({ repoPath: repo.dir, source: 'no-such-branch', push: false })
    .catch((caught) => caught)
  assert.ok(error instanceof PublishError)
  assert.match(error.message, /no-such-branch/)
})

test('a missing .modbuild raises ConfigError naming the file', async (t) => {
  const repo = await makeRepo({ 'modinfo.json': '{}' })
  t.after(() => repo.cleanup())

  const error = await publish({ repoPath: repo.dir, push: false }).catch((caught) => caught)
  assert.ok(error instanceof ConfigError)
  assert.ok(error.message.includes('.modbuild'), error.message)
})

test('the actions identity is used when GITHUB_ACTIONS is set', async (t) => {
  const repo = await makeRepo({ '.modbuild': modbuild({ root: 'Mod' }), 'Mod/modinfo.json': '{}' })
  t.after(() => repo.cleanup())

  await publish({ repoPath: repo.dir, push: false, env: { GITHUB_ACTIONS: 'true' } })

  const { stdout } = await repo.git('log', '-1', '--format=%an <%ae>', 'published-mod')
  assert.equal(
    stdout.trim(),
    'github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>'
  )
})
