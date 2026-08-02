// test/payload.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolvePayload } from '../src/payload.js'

const entry = (path) => ({ mode: '100644', sha: 'a'.repeat(40), path })
const tree = (...paths) => paths.map(entry)
const mod = (overrides = {}) => ({ root: '.', ignore: [], target: 'published-mod', ...overrides })

const includedPaths = (payload) => payload.included.map((file) => file.path)
const excluded = (payload) => payload.excluded.map((file) => ({ path: file.path, rule: file.rule }))

test('with root "." every file is included, paths unchanged', () => {
  const payload = resolvePayload(tree('modinfo.json', 'ui/mods/x/a.js'), mod())
  assert.deepEqual(includedPaths(payload), ['modinfo.json', 'ui/mods/x/a.js'])
  assert.deepEqual(payload.excluded, [])
})

test('root hoisting strips the prefix and drops everything outside it', () => {
  const payload = resolvePayload(
    tree('Mod/modinfo.json', 'Mod/ui/mods/pa-chat/chat.js', 'Server/Program.cs', 'Logo.psd', 'Modest/x.js'),
    mod({ root: 'Mod' })
  )
  assert.deepEqual(includedPaths(payload), ['modinfo.json', 'ui/mods/pa-chat/chat.js'])
  assert.deepEqual(payload.excluded, [], 'files outside root are not "excluded", they are not this mod')
})

test('sourcePath keeps the original repo-relative path', () => {
  const payload = resolvePayload(tree('Mod/modinfo.json'), mod({ root: 'Mod' }))
  assert.equal(payload.included[0].path, 'modinfo.json')
  assert.equal(payload.included[0].sourcePath, 'Mod/modinfo.json')
})

test('mode and sha are carried through untouched', () => {
  const files = [{ mode: '100755', sha: 'b'.repeat(40), path: 'Mod/run.sh' }]
  const payload = resolvePayload(files, mod({ root: 'Mod' }))
  assert.equal(payload.included[0].mode, '100755')
  assert.equal(payload.included[0].sha, 'b'.repeat(40))
})

test('ignore patterns are matched relative to root', () => {
  const payload = resolvePayload(
    tree('Mod/modinfo.json', 'Mod/pachat.zip', 'Mod/.jshintrc'),
    mod({ root: 'Mod', ignore: ['pachat.zip', '.jshintrc'] })
  )
  assert.deepEqual(includedPaths(payload), ['modinfo.json'])
  assert.deepEqual(excluded(payload), [
    { path: 'pachat.zip', rule: 'pachat.zip' },
    { path: '.jshintrc', rule: '.jshintrc' }
  ])
})

test('directory patterns exclude everything beneath them', () => {
  const payload = resolvePayload(
    tree('modinfo.json', '.vscode/tasks.json', '.vscode/sync-mod.ps1'),
    mod({ ignore: ['.vscode/'] })
  )
  assert.deepEqual(includedPaths(payload), ['modinfo.json'])
  assert.deepEqual(excluded(payload), [
    { path: '.vscode/tasks.json', rule: '.vscode/' },
    { path: '.vscode/sync-mod.ps1', rule: '.vscode/' }
  ])
})

test('negation re-includes, and the negating rule is not reported as an exclusion', () => {
  const payload = resolvePayload(
    tree('a.psd', 'keep.psd', 'modinfo.json'),
    mod({ ignore: ['*.psd', '!keep.psd'] })
  )
  assert.deepEqual(includedPaths(payload).sort(), ['keep.psd', 'modinfo.json'])
  assert.deepEqual(excluded(payload), [{ path: 'a.psd', rule: '*.psd' }])
})

test('the reported rule is the last pattern that changed the decision', () => {
  const payload = resolvePayload(
    tree('keep.psd'),
    mod({ ignore: ['*.psd', '!keep.psd', 'keep.psd'] })
  )
  assert.deepEqual(excluded(payload), [{ path: 'keep.psd', rule: 'keep.psd' }])
})

// gitignore's rule, inherited deliberately: a negation cannot re-include a file whose parent
// directory is itself excluded. The rule reported must be the directory pattern that actually
// decided it, not the negation that looks like it should have won.
test('a negation cannot rescue a file under an excluded directory', () => {
  const payload = resolvePayload(
    tree('work/icon.xcf'),
    mod({ ignore: ['work/', '!work/icon.xcf'] })
  )
  assert.deepEqual(excluded(payload), [{ path: 'work/icon.xcf', rule: 'work/' }])
})

test('a negation does rescue when the parent directory is not itself excluded', () => {
  const payload = resolvePayload(
    tree('work/icon.xcf', 'work/other.xcf'),
    mod({ ignore: ['work/*.xcf', '!work/icon.xcf'] })
  )
  assert.deepEqual(includedPaths(payload), ['work/icon.xcf'])
  assert.deepEqual(excluded(payload), [{ path: 'work/other.xcf', rule: 'work/*.xcf' }])
})

test('anchored patterns only match at the root, unanchored match at any depth', () => {
  const anchored = resolvePayload(
    tree('build/out.js', 'ui/build/out.js'),
    mod({ ignore: ['/build/'] })
  )
  assert.deepEqual(includedPaths(anchored), ['ui/build/out.js'])

  const unanchored = resolvePayload(
    tree('build/out.js', 'ui/build/out.js'),
    mod({ ignore: ['build/'] })
  )
  assert.deepEqual(includedPaths(unanchored), [])
})

test('an empty payload is reported as empty rather than throwing', () => {
  const payload = resolvePayload(tree('Mod/a.js'), mod({ root: 'Mod', ignore: ['*'] }))
  assert.deepEqual(payload.included, [])
  assert.equal(payload.excluded.length, 1)
})

test('a root with no matching files yields nothing in either list', () => {
  const payload = resolvePayload(tree('a.js'), mod({ root: 'Missing' }))
  assert.deepEqual(payload.included, [])
  assert.deepEqual(payload.excluded, [])
})

test('one file list resolves independently for several mods', () => {
  const files = tree('a/modinfo.json', 'a/x.js', 'b/modinfo.json', 'b/y.psd')
  const first = resolvePayload(files, mod({ root: 'a' }))
  const second = resolvePayload(files, mod({ root: 'b', ignore: ['*.psd'] }))
  assert.deepEqual(includedPaths(first), ['modinfo.json', 'x.js'])
  assert.deepEqual(includedPaths(second), ['modinfo.json'])
  assert.deepEqual(excluded(second), [{ path: 'y.psd', rule: '*.psd' }])
})

test('input order is preserved in the output', () => {
  const payload = resolvePayload(tree('z.js', 'a.js', 'm.js'), mod())
  assert.deepEqual(includedPaths(payload), ['z.js', 'a.js', 'm.js'])
})
