import test from 'node:test'
import assert from 'node:assert/strict'
import { parseConfig, ConfigError } from '../src/config.js'

const parse = (obj) => parseConfig(JSON.stringify(obj), '.modbuild')

function assertConfigError (fn, ...fragments) {
  // node:assert/strict's assert.throws() does not return the caught error (unlike some other
  // assertion libraries), so the error has to be captured manually to inspect its message.
  let error
  try {
    fn()
  } catch (err) {
    error = err
  }
  assert.ok(error instanceof ConfigError, `expected a ConfigError to be thrown, got: ${error}`)
  for (const fragment of fragments) {
    assert.ok(
      error.message.includes(fragment),
      `expected message to mention ${JSON.stringify(fragment)}, got: ${error.message}`
    )
  }
  return error
}

test('a single-mod config normalises to a one-element list', () => {
  assert.deepEqual(parse({ root: 'Mod', ignore: ['*.psd'], target: 'pub' }), [
    { root: 'Mod', ignore: ['*.psd'], target: 'pub' }
  ])
})

test('root, ignore and target all default', () => {
  assert.deepEqual(parse({}), [{ root: '.', ignore: [], target: 'published-mod' }])
})

test('$schema is accepted and discarded', () => {
  assert.deepEqual(parse({ $schema: 'https://example.test/s.json', root: 'Mod' }), [
    { root: 'Mod', ignore: [], target: 'published-mod' }
  ])
})

test('a mods array normalises to a list in order', () => {
  const mods = parse({
    mods: [
      { root: 'a', target: 'pub-a' },
      { root: 'b', target: 'pub-b', ignore: ['*.psd'] }
    ]
  })
  assert.deepEqual(mods, [
    { root: 'a', ignore: [], target: 'pub-a' },
    { root: 'b', ignore: ['*.psd'], target: 'pub-b' }
  ])
})

test('root is normalised', () => {
  assert.equal(parse({ root: './Mod/' })[0].root, 'Mod')
  assert.equal(parse({ root: 'Mod/sub' })[0].root, 'Mod/sub')
  assert.equal(parse({ root: './' })[0].root, '.')
  assert.equal(parse({ root: '' })[0].root, '.')
})

test('backslash separators in root are accepted and normalised', () => {
  assert.equal(parse({ root: 'Mod\\sub' })[0].root, 'Mod/sub')
})

test('invalid JSON reports line and column when the runtime gives a position', () => {
  const error = assertConfigError(
    () => parseConfig('{\n  "root": "Mod",\n}', '.modbuild'),
    '.modbuild',
    'line 3'
  )
  assert.ok(/column \d+/.test(error.message), `expected a column, got: ${error.message}`)
})

// Node 22 omits the character offset from some JSON error messages. Those still have to produce
// a usable error rather than an empty or mangled one.
test('invalid JSON without a position still reports the parser message', () => {
  const error = assertConfigError(() => parseConfig('{"root": }', '.modbuild'), '.modbuild')
  assert.ok(error.message.length > '.modbuild is not valid JSON: '.length, error.message)
  assert.equal(/line NaN|column NaN|undefined/.test(error.message), false, error.message)
})

test('a non-object config is rejected by name', () => {
  assertConfigError(() => parseConfig('[]', '.modbuild'), 'JSON object', 'mods')
  assertConfigError(() => parseConfig('"Mod"', '.modbuild'), 'JSON object')
  assertConfigError(() => parseConfig('null', '.modbuild'), 'JSON object')
})

test('an unknown top-level key is rejected and the likely fix named', () => {
  assertConfigError(() => parse({ roots: 'Mod' }), 'roots', 'root')
})

test('an unknown key inside a mods entry is rejected', () => {
  assertConfigError(() => parse({ mods: [{ rooot: 'Mod' }] }), 'rooot', 'mods[0]')
})

test('$schema inside a mods entry is rejected', () => {
  assertConfigError(() => parse({ mods: [{ $schema: 'x', root: 'a' }] }), '$schema', 'mods[0]')
})

test('mods alongside root is an error rather than a merge', () => {
  assertConfigError(() => parse({ root: 'Mod', mods: [{ root: 'a' }] }), 'mods', 'root')
})

test('mods must be a non-empty array of objects', () => {
  assertConfigError(() => parse({ mods: [] }), 'mods', 'empty')
  assertConfigError(() => parse({ mods: {} }), 'mods', 'array')
  assertConfigError(() => parse({ mods: ['Mod'] }), 'mods[0]', 'object')
})

test('duplicate targets are rejected, naming both mods and the target', () => {
  assertConfigError(
    () => parse({ mods: [{ root: 'a' }, { root: 'b' }] }),
    'published-mod',
    'a',
    'b'
  )
})

test('a target nested inside another target is rejected, naming both mods', () => {
  assertConfigError(
    () => parse({ mods: [{ root: 'a', target: 'mod' }, { root: 'b', target: 'mod/a' }] }),
    'mod/a',
    'a',
    'b',
    'branch'
  )
  // The order the two are declared in must not matter.
  assertConfigError(
    () => parse({ mods: [{ root: 'a', target: 'mod/a' }, { root: 'b', target: 'mod' }] }),
    'mod/a',
    'a',
    'b'
  )
})

test('targets that merely share a prefix without nesting are allowed', () => {
  const mods = parse({ mods: [{ root: 'a', target: 'mod' }, { root: 'b', target: 'modular' }] })
  assert.deepEqual(mods.map((mod) => mod.target), ['mod', 'modular'])
})

test('field types are checked', () => {
  assertConfigError(() => parse({ root: 42 }), 'root', 'string')
  assertConfigError(() => parse({ ignore: '*.psd' }), 'ignore', 'array')
  assertConfigError(() => parse({ ignore: [42] }), 'ignore[0]', 'string')
  assertConfigError(() => parse({ target: 42 }), 'target', 'string')
})

test('a root escaping the repository is rejected', () => {
  assertConfigError(() => parse({ root: '../evil' }), 'root', 'outside')
  assertConfigError(() => parse({ root: '/etc' }), 'root', 'outside')
  assertConfigError(() => parse({ root: 'C:/Windows' }), 'root', 'outside')
  assertConfigError(() => parse({ root: 'Mod/../..' }), 'root', 'outside')
})

test('a root that stays inside the repo after normalisation is allowed', () => {
  assert.equal(parse({ root: 'Mod/sub/..' })[0].root, 'Mod')
})

test('an invalid branch name is rejected', () => {
  for (const target of ['', 'has space', 'ends/', '/starts', 'a..b', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a.lock', 'a@{b', '.hidden', 'a//b']) {
    assertConfigError(() => parse({ target }), 'target', 'branch name')
  }
})

test('ordinary branch names are accepted', () => {
  for (const target of ['published-mod', 'main', 'feature/x', 'v1.2.3', 'a_b-c']) {
    assert.equal(parse({ target })[0].target, target)
  }
})
