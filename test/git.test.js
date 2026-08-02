import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { createGit, GitError } from '../src/git.js'
import { makeRepo, makeBareRemote } from './helpers/repo.js'

test('isRepo distinguishes a repository from a bare directory', async (t) => {
  const repo = await makeRepo({ 'a.txt': 'a' })
  const plain = await mkdtemp(path.join(tmpdir(), 'pamb-plain-'))
  t.after(async () => {
    await repo.cleanup()
    await rm(plain, { recursive: true, force: true })
  })

  assert.equal(await createGit(repo.dir).isRepo(), true)
  assert.equal(await createGit(plain).isRepo(), false)
})

test('revParse resolves a ref and reports an unknown one', async (t) => {
  const repo = await makeRepo({ 'a.txt': 'a' })
  t.after(() => repo.cleanup())
  const git = createGit(repo.dir)

  assert.match(await git.revParse('HEAD'), /^[0-9a-f]{40}$/)
  await assert.rejects(() => git.revParse('no-such-ref'), GitError)
})

test('currentBranch and refBranchName name branches', async (t) => {
  const repo = await makeRepo({ 'a.txt': 'a' })
  t.after(() => repo.cleanup())
  const git = createGit(repo.dir)

  assert.equal(await git.currentBranch(), 'main')
  assert.equal(await git.refBranchName('main'), 'main')
  assert.equal(await git.refBranchName('HEAD'), 'main')
  assert.equal(await git.refBranchName(await git.revParse('HEAD')), null)
})

test('lsTree returns mode, sha and posix paths for every tracked file', async (t) => {
  const repo = await makeRepo({
    'modinfo.json': '{}',
    'Mod/ui/mods/x/a.js': 'a',
    'name with spaces.txt': 'x'
  })
  t.after(() => repo.cleanup())

  const entries = await createGit(repo.dir).lsTree(repo.head)
  const paths = entries.map((entry) => entry.path).sort()
  assert.deepEqual(paths, ['Mod/ui/mods/x/a.js', 'modinfo.json', 'name with spaces.txt'])
  for (const entry of entries) {
    assert.match(entry.mode, /^\d{6}$/)
    assert.match(entry.sha, /^[0-9a-f]{40}$/)
    assert.equal(entry.path.includes('\\'), false)
  }
})

test('blobSizes reports byte sizes for many blobs in one call', async (t) => {
  const repo = await makeRepo({ 'a.txt': 'abc', 'b.txt': 'de' })
  t.after(() => repo.cleanup())
  const git = createGit(repo.dir)

  const entries = await git.lsTree(repo.head)
  const sizes = await git.blobSizes(entries.map((entry) => entry.sha))
  const byPath = new Map(entries.map((entry) => [entry.path, sizes.get(entry.sha)]))
  assert.equal(byPath.get('a.txt'), 3)
  assert.equal(byPath.get('b.txt'), 2)
})

test('blobSizes handles an empty list without invoking git', async (t) => {
  const repo = await makeRepo({ 'a.txt': 'a' })
  t.after(() => repo.cleanup())
  assert.equal((await createGit(repo.dir).blobSizes([])).size, 0)
})

test('catFile returns blob contents', async (t) => {
  const repo = await makeRepo({ 'a.txt': 'hello' })
  t.after(() => repo.cleanup())
  const git = createGit(repo.dir)
  const [entry] = await git.lsTree(repo.head)
  assert.equal(await git.catFile(entry.sha), 'hello')
})

test('buildTree writes a tree with rewritten paths and leaves the caller index alone', async (t) => {
  const repo = await makeRepo({ 'Mod/modinfo.json': '{}', 'Mod/ui/a.js': 'a', 'README.md': 'r' })
  t.after(() => repo.cleanup())
  const git = createGit(repo.dir)

  const entries = (await git.lsTree(repo.head))
    .filter((entry) => entry.path.startsWith('Mod/'))
    .map((entry) => ({ ...entry, path: entry.path.slice('Mod/'.length) }))

  const indexFile = path.join(repo.dir, '.git', 'pamb-index')
  const tree = await git.buildTree(entries, indexFile)
  assert.match(tree, /^[0-9a-f]{40}$/)

  const listed = await repo.git('ls-tree', '-r', '--name-only', tree)
  assert.deepEqual(listed.stdout.trim().split('\n').sort(), ['modinfo.json', 'ui/a.js'])

  const status = await repo.git('status', '--porcelain')
  assert.equal(status.stdout.trim(), '', 'the caller working tree and index must be untouched')
})

test('an identical entry list produces an identical tree sha', async (t) => {
  const repo = await makeRepo({ 'a.js': 'a' })
  t.after(() => repo.cleanup())
  const git = createGit(repo.dir)
  const entries = await git.lsTree(repo.head)

  const first = await git.buildTree(entries, path.join(repo.dir, '.git', 'i1'))
  const second = await git.buildTree(entries, path.join(repo.dir, '.git', 'i2'))
  assert.equal(first, second)
})

test('commitTree creates a parentless commit, then one on top', async (t) => {
  const repo = await makeRepo({ 'a.js': 'a' })
  t.after(() => repo.cleanup())
  const git = createGit(repo.dir)

  const entries = await git.lsTree(repo.head)
  const tree = await git.buildTree(entries, path.join(repo.dir, '.git', 'i'))
  const identity = { name: 'bot', email: 'bot@example.test' }

  const first = await git.commitTree(tree, { parent: null, message: 'first', identity })
  const parents = await repo.git('rev-list', '--parents', '-n', '1', first)
  assert.equal(parents.stdout.trim(), first, 'an orphan commit has no parents')

  const second = await git.commitTree(tree, { parent: first, message: 'second', identity })
  const secondParents = await repo.git('rev-list', '--parents', '-n', '1', second)
  assert.equal(secondParents.stdout.trim(), `${second} ${first}`)

  const author = await repo.git('log', '-1', '--format=%an <%ae>', second)
  assert.equal(author.stdout.trim(), 'bot <bot@example.test>')
})

test('updateRef, refExists and treeOf work together', async (t) => {
  const repo = await makeRepo({ 'a.js': 'a' })
  t.after(() => repo.cleanup())
  const git = createGit(repo.dir)

  assert.equal(await git.refExists('refs/heads/published-mod'), false)
  const tree = await git.buildTree(await git.lsTree(repo.head), path.join(repo.dir, '.git', 'i'))
  const commit = await git.commitTree(tree, { parent: null, message: 'p', identity: null })
  await git.updateRef('refs/heads/published-mod', commit)

  assert.equal(await git.refExists('refs/heads/published-mod'), true)
  assert.equal(await git.treeOf('refs/heads/published-mod'), tree)
})

test('hasRemote, fetchBranch and push move a ref to a remote', async (t) => {
  const repo = await makeRepo({ 'a.js': 'a' })
  const remote = await makeBareRemote()
  t.after(async () => {
    await repo.cleanup()
    await remote.cleanup()
  })
  const git = createGit(repo.dir)

  assert.equal(await git.hasRemote('origin'), false)
  await repo.git('remote', 'add', 'origin', remote.dir)
  assert.equal(await git.hasRemote('origin'), true)
  assert.equal(await git.fetchBranch('origin', 'published-mod'), false, 'absent branch fetches false')

  const tree = await git.buildTree(await git.lsTree(repo.head), path.join(repo.dir, '.git', 'i'))
  const commit = await git.commitTree(tree, { parent: null, message: 'p', identity: null })
  await git.push('origin', commit, 'published-mod')

  const listed = await remote.git('rev-parse', 'refs/heads/published-mod')
  assert.equal(listed.stdout.trim(), commit)
  assert.equal(await git.fetchBranch('origin', 'published-mod'), true)
})

test('GitError carries the command and stderr', async (t) => {
  const repo = await makeRepo({ 'a.js': 'a' })
  t.after(() => repo.cleanup())

  const error = await createGit(repo.dir).revParse('no-such-ref').then(
    () => null,
    (caught) => caught
  )
  assert.ok(error instanceof GitError)
  assert.ok(error.command.includes('rev-parse'))
  assert.equal(typeof error.stderr, 'string')
})
