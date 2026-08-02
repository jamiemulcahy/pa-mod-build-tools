# `pa-mod-build publish` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `pa-mod-build publish` — a command that reads `.modbuild`, resolves one or more mod payloads from a git ref, commits each to its own publish branch, and reports what it did.

**Architecture:** Six small ESM modules with one responsibility each. `config.js`, `payload.js` and `summary.js` are pure and carry most of the test coverage. `git.js` is the only module that touches `child_process`. `publish.js` orchestrates and returns a report object without printing. `cli.js` owns argv, environment, output routing and exit codes. The publish itself is ref-to-ref git plumbing — `update-index` → `write-tree` → `commit-tree` → `update-ref` — so no worktree is created and the caller's checkout is never touched.

**Tech Stack:** Node 20+, ESM, `node:test` + `node:assert`, one runtime dependency ([`ignore`](https://www.npmjs.com/package/ignore)), `git` via `node:child_process.execFile`.

**Spec:** [`docs/superpowers/specs/2026-08-02-pa-mod-build-publish-design.md`](../specs/2026-08-02-pa-mod-build-publish-design.md). Where this plan and the spec disagree, the spec is wrong and should be corrected — but three deliberate deviations are recorded in "Deviations from the spec" at the end. Read that section before starting.

## Global Constraints

- **Node 20+, ESM.** `"type": "module"` in `package.json`, `import`/`export` everywhere, no `require`.
- **Exactly one runtime dependency: `ignore`.** No other `dependencies` entry may be added. No `simple-git`.
- **No test framework.** `node:test` and `node:assert/strict` only. Test-only helpers live in `test/helpers/`.
- **Package name `pa-mod-build-tools`, binary `pa-mod-build`.**
- **Default target branch is `published-mod`.** Default root is `"."`. Default config path is `.modbuild`.
- **All paths inside the tool are posix-style with `/` separators**, because that is what git emits and consumes on every platform. Only `cli.js` and test helpers touch `node:path` for real filesystem paths.
- **Temp directories in tests must use short paths** — `fs.mkdtemp(path.join(os.tmpdir(), 'pamb-'))`. A long base path makes `git clone` fail on Windows with "Filename too long".
- **CI runs ubuntu-latest and windows-latest, Node 20 and 22.** A task is not done until it passes on both platforms.
- **Every error the user can trigger names the file and the fix.** No bare `throw new Error('invalid')`.
- **Commit after every task**, using the repo's existing style: sentence-case imperative subject, wrapped body explaining why.

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json` | Package metadata, `bin`, `scripts.test`, the single dependency |
| `schema/modbuild.schema.json` | JSON Schema for `.modbuild`. Editor support only — never loaded by the tool |
| `src/config.js` | Read, validate and normalise `.modbuild` into `Mod[]`. Pure apart from one file read |
| `src/payload.js` | `(files, mod) -> {included, excluded}`. Pure. No fs, no git |
| `src/git.js` | Every `git` invocation. The only module importing `node:child_process` |
| `src/publish.js` | Orchestration and ref mechanics. Returns a report; prints nothing |
| `src/summary.js` | `report -> markdown string`. Pure |
| `src/cli.js` | argv + env parsing, dispatch, output routing, exit codes |
| `test/helpers/repo.js` | Builds real temporary git repos from a file map |
| `test/*.test.js` | One test file per module |
| `.github/workflows/ci.yml` | Test matrix on PRs |

---

## Task 1: Scaffolding and CI

**Files:**
- Create: `package.json`, `.github/workflows/ci.yml`, `test/smoke.test.js`
- Create (generated): `package-lock.json`

**Interfaces:**
- Consumes: nothing
- Produces: `npm test` runs `node --test test/`; the `ignore` package is installed and importable

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "pa-mod-build-tools",
  "version": "0.0.0",
  "description": "Build tools for Planetary Annihilation mod authors",
  "license": "MIT",
  "type": "module",
  "bin": {
    "pa-mod-build": "src/cli.js"
  },
  "engines": {
    "node": ">=20"
  },
  "files": [
    "src/",
    "schema/"
  ],
  "scripts": {
    "test": "node --test test/"
  },
  "dependencies": {
    "ignore": "^7.0.0"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/jamiemulcahy/pa-mod-build-tools.git"
  }
}
```

- [ ] **Step 2: Install the dependency**

Run: `npm install`
Expected: `package-lock.json` is created and `node_modules/ignore` exists. If npm resolves a major version other than 7, update the `dependencies` range in `package.json` to match what was installed and note it.

- [ ] **Step 3: Write the smoke test**

This exists so `npm test` and CI have something to run from the first commit. Delete it in Task 2 once real tests exist.

```js
// test/smoke.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import ignore from 'ignore'

test('the ignore dependency loads and applies a pattern', () => {
  assert.equal(ignore().add(['*.psd']).ignores('Logo.psd'), true)
  assert.equal(ignore().add(['*.psd']).ignores('Logo.jpg'), false)
})
```

- [ ] **Step 4: Run the test**

Run: `npm test`
Expected: PASS, 1 test.

- [ ] **Step 5: Write the CI workflow**

```yaml
# .github/workflows/ci.yml
name: CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest]
        node: ['20', '22']
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm test
```

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json test/smoke.test.js .github/workflows/ci.yml
git commit -m "Add package scaffolding and CI"
```

---

## Task 2: `config.js` — load, validate and normalise `.modbuild`

**Files:**
- Create: `src/config.js`, `test/config.test.js`
- Delete: `test/smoke.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `class ConfigError extends Error` — carries `.path` (the config file path) and is the only error type this module throws for user-facing problems
  - `parseConfig(text: string, filePath: string): Mod[]` — pure
  - `loadConfig(filePath: string): Promise<Mod[]>` — reads the file, then calls `parseConfig`
  - `const DEFAULT_TARGET = 'published-mod'`, `const DEFAULT_ROOT = '.'`
  - `Mod = { root: string, ignore: string[], target: string }` — `root` is normalised (no leading `./`, no trailing `/`, `'.'` for the repo root)

- [ ] **Step 1: Write the failing tests**

```js
// test/config.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseConfig, ConfigError } from '../src/config.js'

const parse = (obj) => parseConfig(JSON.stringify(obj), '.modbuild')

function assertConfigError (fn, ...fragments) {
  const error = assert.throws(fn, ConfigError)
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/config.js'`.

- [ ] **Step 3: Implement `src/config.js`**

```js
// src/config.js
import { readFile } from 'node:fs/promises'

export const DEFAULT_ROOT = '.'
export const DEFAULT_TARGET = 'published-mod'

const MOD_KEYS = ['root', 'ignore', 'target']
const TOP_LEVEL_KEYS = ['$schema', 'mods', ...MOD_KEYS]

export class ConfigError extends Error {
  constructor (message, filePath) {
    super(message)
    this.name = 'ConfigError'
    this.path = filePath
  }
}

export async function loadConfig (filePath) {
  let text
  try {
    text = await readFile(filePath, 'utf8')
  } catch (cause) {
    if (cause.code === 'ENOENT') {
      throw new ConfigError(
        `No ${filePath} found. Every repository needs one: it says which directory is your mod ` +
        'and which files to leave out. See docs/setup.md.',
        filePath
      )
    }
    throw new ConfigError(`Could not read ${filePath}: ${cause.message}`, filePath)
  }
  return parseConfig(text, filePath)
}

export function parseConfig (text, filePath) {
  const raw = parseJson(text, filePath)
  const entries = splitEntries(raw, filePath)
  // splitEntries has already proved that a defined "mods" is a non-empty array, so its mere
  // presence identifies the multi-mod form — which is what decides how errors are labelled.
  const isMulti = raw.mods !== undefined
  const mods = entries.map((entry, index) => normaliseMod(entry, isMulti ? index : null, filePath))
  assertUniqueTargets(mods, filePath)
  return mods
}

function parseJson (text, filePath) {
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new ConfigError(`${filePath} is not valid JSON: ${describeJsonError(cause, text)}`, filePath)
  }
}

// Node 20 always puts a character offset in its JSON error messages; Node 22 improved the
// wording and drops the offset for some errors. Where an offset exists, derive line and column
// ourselves so the message reads identically on both runtimes. Where it does not, Node 22's
// message already quotes the offending token and the surrounding text, so pass it through rather
// than hand-rolling a JSON scanner to recover a position.
function describeJsonError (cause, text) {
  const match = /position (\d+)/.exec(cause.message)
  if (!match) return cause.message
  const offset = Math.min(Number(match[1]), text.length)
  const before = text.slice(0, offset)
  const line = before.split('\n').length
  const column = offset - before.lastIndexOf('\n')
  const summary = cause.message.split(/ (?:in JSON )?at position/)[0]
  return `${summary} (line ${line}, column ${column})`
}

function splitEntries (raw, filePath) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(
      `${filePath} must contain a JSON object describing your mod — for example ` +
      '{"root": "Mod"} — or an object with a "mods" array for a repository that ships several.',
      filePath
    )
  }

  assertKnownKeys(raw, TOP_LEVEL_KEYS, 'top level', filePath)

  if (raw.mods === undefined) return [raw]

  const overlap = MOD_KEYS.filter((key) => raw[key] !== undefined)
  if (overlap.length > 0) {
    throw new ConfigError(
      `${filePath} sets both "mods" and ${quoteList(overlap)} at the top level. Use one or the ` +
      'other: "mods" for several mods, or root/ignore/target on their own for a single mod.',
      filePath
    )
  }
  if (!Array.isArray(raw.mods)) {
    throw new ConfigError(`${filePath}: "mods" must be an array of mod objects.`, filePath)
  }
  if (raw.mods.length === 0) {
    throw new ConfigError(
      `${filePath}: "mods" is empty, so there is nothing to publish. Add a mod object, or ` +
      'replace "mods" with root/ignore/target for a single mod.',
      filePath
    )
  }
  return raw.mods
}

function normaliseMod (entry, index, filePath) {
  const where = index === null ? '' : `mods[${index}]: `
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new ConfigError(`${filePath}: mods[${index}] must be an object, for example {"root": "Mod"}.`, filePath)
  }
  assertKnownKeys(entry, index === null ? TOP_LEVEL_KEYS : MOD_KEYS, index === null ? 'top level' : `mods[${index}]`, filePath)

  const root = normaliseRoot(requireString(entry.root, DEFAULT_ROOT, `${where}"root"`, filePath), where, filePath)
  const target = requireString(entry.target, DEFAULT_TARGET, `${where}"target"`, filePath)
  assertBranchName(target, where, filePath)

  let patterns = []
  if (entry.ignore !== undefined) {
    if (!Array.isArray(entry.ignore)) {
      throw new ConfigError(`${filePath}: ${where}"ignore" must be an array of patterns.`, filePath)
    }
    patterns = entry.ignore.map((pattern, i) => {
      if (typeof pattern !== 'string') {
        throw new ConfigError(`${filePath}: ${where}"ignore[${i}]" must be a string.`, filePath)
      }
      return pattern
    })
  }

  return { root, ignore: patterns, target }
}

function requireString (value, fallback, label, filePath) {
  if (value === undefined) return fallback
  if (typeof value !== 'string') {
    throw new ConfigError(`${filePath}: ${label} must be a string.`, filePath)
  }
  return value
}

function assertKnownKeys (object, allowed, where, filePath) {
  for (const key of Object.keys(object)) {
    if (allowed.includes(key)) continue
    const suggestion = closestKey(key, allowed)
    throw new ConfigError(
      `${filePath}: unknown key "${key}" at ${where}.` +
      (suggestion ? ` Did you mean "${suggestion}"?` : ` Allowed keys here are ${quoteList(allowed)}.`),
      filePath
    )
  }
}

// A silently ignored "roots" is the failure that burns a non-technical user, so unknown keys are
// fatal. Suggesting the nearest allowed key turns the error into an instruction.
function closestKey (key, allowed) {
  const lower = key.toLowerCase()
  let best = null
  let bestDistance = Infinity
  for (const candidate of allowed) {
    const distance = editDistance(lower, candidate.toLowerCase())
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return bestDistance <= 2 ? best : null
}

function editDistance (a, b) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 0; j <= b.length; j++) rows[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
    }
  }
  return rows[a.length][b.length]
}

function normaliseRoot (value, where, filePath) {
  const outside = () => new ConfigError(
    `${filePath}: ${where}"root" is ${JSON.stringify(value)}, which points outside the ` +
    'repository. It must be a directory inside it, such as "Mod" or "." for the repository root.',
    filePath
  )

  const raw = value.replace(/\\/g, '/')
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw outside()

  const parts = []
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (parts.length === 0) throw outside()
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  return parts.length === 0 ? DEFAULT_ROOT : parts.join('/')
}

// git check-ref-format's rules for a branch name, applied here rather than by shelling out, so
// config.js stays free of git and testable as a pure function.
function assertBranchName (name, where, filePath) {
  const invalid =
    name === '' ||
    name.startsWith('/') || name.endsWith('/') || name.includes('//') ||
    name.startsWith('.') || name.includes('/.') ||
    name.endsWith('.') ||
    name.endsWith('.lock') ||
    name.includes('..') ||
    name.includes('@{') ||
    name === '@' ||
    /[\s~^:?*[\\\x00-\x1f\x7f]/.test(name)

  if (invalid) {
    throw new ConfigError(
      `${filePath}: ${where}"target" is ${JSON.stringify(name)}, which is not a valid git branch ` +
      'name. Use letters, digits, dots, dashes, underscores and slashes, such as "published-mod".',
      filePath
    )
  }
}

function assertUniqueTargets (mods, filePath) {
  const seen = new Map()
  for (const mod of mods) {
    const previous = seen.get(mod.target)
    if (previous !== undefined) {
      throw new ConfigError(
        `${filePath}: the mods rooted at "${previous}" and "${mod.root}" both publish to ` +
        `"${mod.target}". Give each mod its own "target" branch.`,
        filePath
      )
    }
    seen.set(mod.target, mod.root)
  }
}

function quoteList (values) {
  return values.map((value) => `"${value}"`).join(', ')
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS. If the `mods[0]` label is missing from an error raised for a single-mod config, check the `index === null` branch in `parseConfig` — a single-mod config passes `null`, a `mods` array always passes its index.

- [ ] **Step 5: Delete the smoke test**

```bash
git rm test/smoke.test.js
```

Run: `npm test`
Expected: PASS, with only `config.test.js` running.

- [ ] **Step 6: Commit**

```bash
git add src/config.js test/config.test.js
git commit -m "Add .modbuild loading, validation and normalisation"
```

---

## Task 3: `schema/modbuild.schema.json`

**Files:**
- Create: `schema/modbuild.schema.json`, `test/schema.test.js`

**Interfaces:**
- Consumes: `MOD_KEYS`/`TOP_LEVEL_KEYS` behaviour from `src/config.js` (via its exported defaults and observable validation)
- Produces: nothing the tool imports. The schema is editor-facing only.

The schema exists for autocompletion in VS Code. The risk it carries is **drift**: a schema that permits a key `config.js` rejects, or vice versa, actively misleads the author. The test below pins the two together without adding a JSON Schema validator dependency.

- [ ] **Step 1: Write the failing test**

```js
// test/schema.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parseConfig, ConfigError, DEFAULT_ROOT, DEFAULT_TARGET } from '../src/config.js'

const schema = JSON.parse(await readFile(new URL('../schema/modbuild.schema.json', import.meta.url), 'utf8'))

const singleForm = schema.oneOf[0]
const multiForm = schema.oneOf[1]

test('the schema declares both accepted shapes', () => {
  assert.equal(schema.oneOf.length, 2)
  assert.equal(singleForm.properties.root.default, DEFAULT_ROOT)
  assert.equal(singleForm.properties.target.default, DEFAULT_TARGET)
  assert.equal(multiForm.required.includes('mods'), true)
  assert.equal(multiForm.properties.mods.minItems, 1)
})

test('both forms forbid unknown keys, matching config.js', () => {
  assert.equal(singleForm.additionalProperties, false)
  assert.equal(multiForm.additionalProperties, false)
  assert.equal(multiForm.properties.mods.items.additionalProperties, false)
})

test('the keys the schema allows are exactly the keys config.js accepts', () => {
  const accepts = (object) => {
    try {
      parseConfig(JSON.stringify(object), '.modbuild')
      return true
    } catch (error) {
      assert.ok(error instanceof ConfigError)
      return false
    }
  }

  for (const key of Object.keys(singleForm.properties)) {
    assert.equal(accepts({ [key]: sampleFor(key) }), true, `config.js rejects top-level "${key}"`)
  }
  for (const key of Object.keys(multiForm.properties.mods.items.properties)) {
    assert.equal(accepts({ mods: [{ [key]: sampleFor(key) }] }), true, `config.js rejects mods[].${key}`)
  }

  // And nothing beyond them. "$schema" is top level only.
  assert.equal(accepts({ nonsense: 1 }), false)
  assert.equal(accepts({ mods: [{ $schema: 'x' }] }), false)
  assert.deepEqual(Object.keys(multiForm.properties.mods.items.properties).sort(), ['ignore', 'root', 'target'])
  assert.deepEqual(Object.keys(singleForm.properties).sort(), ['$schema', 'ignore', 'root', 'target'])
})

function sampleFor (key) {
  if (key === 'ignore') return ['*.psd']
  return key === 'mods' ? [{ root: 'a' }] : 'a'
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `ENOENT` opening `schema/modbuild.schema.json`.

- [ ] **Step 3: Write the schema**

```json
{
  "$schema": "https://json-schema.org/draft-07/schema#",
  "$id": "https://raw.githubusercontent.com/jamiemulcahy/pa-mod-build-tools/main/schema/modbuild.schema.json",
  "title": ".modbuild",
  "description": "Describes which directory of this repository is your Planetary Annihilation mod, which files to leave out, and which branch to publish it to.",
  "oneOf": [
    {
      "title": "A single mod",
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "$schema": {
          "type": "string",
          "description": "Ignored by pa-mod-build. Present so your editor can offer autocompletion."
        },
        "root": {
          "type": "string",
          "default": ".",
          "description": "The directory whose contents become the root of the publish branch. Use \".\" when the mod is the whole repository, or a path such as \"Mod\" when it lives in a subdirectory. This is the directory containing modinfo.json."
        },
        "ignore": {
          "type": "array",
          "default": [],
          "description": "Paths to leave out of the published mod, in .gitignore syntax, relative to \"root\". Negation with ! is supported.",
          "items": { "type": "string" }
        },
        "target": {
          "type": "string",
          "default": "published-mod",
          "description": "The branch the cleaned mod is published to. This is the branch you point Planetary Annihilation at."
        }
      }
    },
    {
      "title": "Several mods in one repository",
      "type": "object",
      "additionalProperties": false,
      "required": ["mods"],
      "properties": {
        "$schema": {
          "type": "string",
          "description": "Ignored by pa-mod-build. Present so your editor can offer autocompletion."
        },
        "mods": {
          "type": "array",
          "minItems": 1,
          "description": "One entry per mod. Each publishes to its own branch, so every entry needs its own \"target\".",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "root": {
                "type": "string",
                "default": ".",
                "description": "The directory whose contents become the root of this mod's publish branch. This is the directory containing modinfo.json."
              },
              "ignore": {
                "type": "array",
                "default": [],
                "description": "Paths to leave out of this mod, in .gitignore syntax, relative to \"root\". Negation with ! is supported.",
                "items": { "type": "string" }
              },
              "target": {
                "type": "string",
                "default": "published-mod",
                "description": "The branch this mod is published to. Two mods may not share a branch."
              }
            }
          }
        }
      }
    }
  ]
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add schema/modbuild.schema.json test/schema.test.js
git commit -m "Add the .modbuild JSON schema"
```

---

## Task 4: `payload.js` — the pure filter

**Files:**
- Create: `src/payload.js`, `test/payload.test.js`

**Interfaces:**
- Consumes: `Mod` from `src/config.js` (shape only — no import needed)
- Produces:
  - `resolvePayload(files: TreeEntry[], mod: Mod): Payload`
  - `TreeEntry = { mode: string, sha: string, path: string }` — `path` is repo-relative, posix
  - `Payload = { included: IncludedFile[], excluded: ExcludedFile[] }`
  - `IncludedFile = { mode: string, sha: string, path: string, sourcePath: string }` — `path` has the `root` prefix stripped; `sourcePath` is the original repo-relative path
  - `ExcludedFile = { path: string, sourcePath: string, rule: string }` — `rule` is the `.modbuild` pattern that decided the exclusion

Files outside `root` appear in neither list: they are not part of this mod at all. `excluded` means "inside `root`, but an `ignore` rule matched" — that is what the report's "excluded paths, each with the rule that matched" describes.

- [ ] **Step 1: Write the failing tests**

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/payload.js'`.

- [ ] **Step 3: Implement `src/payload.js`**

```js
// src/payload.js
import ignore from 'ignore'

export function resolvePayload (files, mod) {
  const matchers = buildMatchers(mod.ignore)
  const included = []
  const excluded = []

  for (const file of files) {
    const path = stripRoot(file.path, mod.root)
    if (path === null) continue

    const rule = decidingRule(matchers, mod.ignore, path)
    if (rule === null) {
      included.push({ mode: file.mode, sha: file.sha, path, sourcePath: file.path })
    } else {
      excluded.push({ path, sourcePath: file.path, rule })
    }
  }

  return { included, excluded }
}

function stripRoot (filePath, root) {
  if (root === '.') return filePath
  const prefix = `${root}/`
  return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : null
}

// One matcher per prefix of the pattern list. Comparing consecutive matchers tells us which
// pattern actually decided a path's fate, including when a later negation overturns an earlier
// exclusion. Delegating each decision to `ignore` keeps .gitignore semantics exact rather than
// reimplementing anchoring, directory matching and negation by hand.
function buildMatchers (patterns) {
  return patterns.map((_, index) => ignore().add(patterns.slice(0, index + 1)))
}

function decidingRule (matchers, patterns, path) {
  let previous = false
  let rule = null
  for (let index = 0; index < matchers.length; index++) {
    const current = matchers[index].ignores(path)
    if (current !== previous) rule = patterns[index]
    previous = current
  }
  return previous ? rule : null
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS. If `ignore` throws on a path, check that nothing passes an absolute path or one starting `./` — `ignore` rejects both, and `stripRoot` should never produce them.

- [ ] **Step 5: Commit**

```bash
git add src/payload.js test/payload.test.js
git commit -m "Add pure payload resolution"
```

---

## Task 5: `git.js` and the temporary-repo test helper

**Files:**
- Create: `src/git.js`, `test/helpers/repo.js`, `test/git.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `class GitError extends Error` with `.command`, `.stderr`, `.code`
  - `createGit(repoPath: string): Git` — every method async
  - `Git` methods:
    - `isRepo(): Promise<boolean>`
    - `revParse(ref: string): Promise<string>` — 40-char sha; throws `GitError` if the ref is unknown
    - `currentBranch(): Promise<string|null>` — branch name, or `null` when detached
    - `refBranchName(ref: string): Promise<string|null>` — the branch `ref` names, or `null`
    - `lsTree(sha: string): Promise<TreeEntry[]>` — `{mode, sha, path}`, posix paths
    - `blobSizes(shas: string[]): Promise<Map<string, number>>`
    - `buildTree(entries: {mode, sha, path}[], indexFile: string): Promise<string>` — tree sha
    - `treeOf(commitish: string): Promise<string>` — the tree sha of a commit
    - `commitTree(treeSha, {parent, message, identity}): Promise<string>` — `identity` is `{name, email}` or `null`
    - `updateRef(ref: string, sha: string): Promise<void>`
    - `refExists(ref: string): Promise<boolean>`
    - `hasRemote(name: string): Promise<boolean>`
    - `fetchBranch(remote: string, branch: string): Promise<boolean>` — `false` when the remote has no such branch
    - `push(remote: string, sha: string, branch: string): Promise<void>`
  - Test helper `makeRepo(files: Record<string,string>, options?): Promise<Repo>` and `Repo.commit(files, message)`

- [ ] **Step 1: Write the test helper**

```js
// test/helpers/repo.js
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

// Short base path on purpose: a long one makes git fail on Windows with "Filename too long".
export async function makeRepo (files, { branch = 'main' } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'pamb-'))
  const git = (...args) => run('git', ['-C', dir, ...args], { encoding: 'utf8' })

  await git('init', '-q', '-b', branch)
  await git('config', 'user.name', 'Fixture')
  await git('config', 'user.email', 'fixture@example.test')
  await git('config', 'commit.gpgsign', 'false')
  await git('config', 'core.autocrlf', 'false')

  const repo = {
    dir,
    git,
    async commit (nextFiles, message = 'change') {
      await writeAll(dir, nextFiles)
      await git('add', '-A')
      await git('commit', '-q', '-m', message)
      const { stdout } = await git('rev-parse', 'HEAD')
      return stdout.trim()
    },
    async cleanup () {
      await rm(dir, { recursive: true, force: true, maxRetries: 3 })
    }
  }

  repo.head = await repo.commit(files, 'initial')
  return repo
}

export async function makeBareRemote () {
  const dir = await mkdtemp(path.join(tmpdir(), 'pamb-remote-'))
  await run('git', ['init', '-q', '--bare', dir])
  return {
    dir,
    git: (...args) => run('git', ['--git-dir', dir, ...args], { encoding: 'utf8' }),
    cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 3 })
  }
}

async function writeAll (dir, files) {
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(dir, relative)
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, contents)
  }
}
```

- [ ] **Step 2: Write the failing tests for `git.js`**

```js
// test/git.test.js
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/git.js'`.

- [ ] **Step 4: Implement `src/git.js`**

```js
// src/git.js
import { execFile } from 'node:child_process'

const MAX_BUFFER = 256 * 1024 * 1024

export class GitError extends Error {
  constructor (message, { command, stderr, code }) {
    super(message)
    this.name = 'GitError'
    this.command = command
    this.stderr = stderr
    this.code = code
  }
}

export function createGit (repoPath) {
  function run (args, { stdin = null, env = {}, allowFailure = false } = {}) {
    return new Promise((resolve, reject) => {
      const child = execFile(
        'git',
        ['-C', repoPath, ...args],
        { encoding: 'utf8', maxBuffer: MAX_BUFFER, env: { ...process.env, ...env } },
        (error, stdout, stderr) => {
          if (error && !allowFailure) {
            reject(new GitError(
              `git ${args[2] ?? args[0]} failed: ${(stderr || error.message).trim()}`,
              { command: `git ${args.join(' ')}`, stderr: stderr ?? '', code: error.code ?? 1 }
            ))
            return
          }
          resolve({ stdout, stderr, code: error ? (error.code ?? 1) : 0 })
        }
      )
      if (stdin !== null) child.stdin.end(stdin)
    })
  }

  const trimmed = async (args, options) => (await run(args, options)).stdout.trim()

  return {
    run,

    async isRepo () {
      const { code, stdout } = await run(['rev-parse', '--is-inside-work-tree'], { allowFailure: true })
      return code === 0 && stdout.trim() === 'true'
    },

    revParse (ref) {
      return trimmed(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])
    },

    async currentBranch () {
      const name = await trimmed(['rev-parse', '--abbrev-ref', 'HEAD'])
      return name === 'HEAD' ? null : name
    },

    async refBranchName (ref) {
      const { code, stdout } = await run(
        ['rev-parse', '--symbolic-full-name', '--end-of-options', ref],
        { allowFailure: true }
      )
      if (code !== 0) return null
      const full = stdout.trim()
      return full.startsWith('refs/heads/') ? full.slice('refs/heads/'.length) : null
    },

    async lsTree (sha) {
      const { stdout } = await run(['ls-tree', '-r', '-z', '--full-tree', sha])
      const entries = []
      for (const record of stdout.split('\0')) {
        if (record === '') continue
        // "<mode> SP <type> SP <sha> TAB <path>"
        const tab = record.indexOf('\t')
        const [mode, , sha1] = record.slice(0, tab).split(' ')
        entries.push({ mode, sha: sha1, path: record.slice(tab + 1) })
      }
      return entries
    },

    async blobSizes (shas) {
      const sizes = new Map()
      const unique = [...new Set(shas)]
      if (unique.length === 0) return sizes

      const { stdout } = await run(
        ['cat-file', '--batch-check=%(objectname) %(objectsize)'],
        { stdin: `${unique.join('\n')}\n` }
      )
      for (const line of stdout.split('\n')) {
        if (line === '') continue
        const [name, size] = line.split(' ')
        if (size !== undefined && size !== 'missing') sizes.set(name, Number(size))
      }
      return sizes
    },

    async catFile (sha) {
      const { stdout } = await run(['cat-file', 'blob', sha])
      return stdout
    },

    // Builds a tree from entries alone. GIT_INDEX_FILE points update-index at a scratch index, so
    // the caller's real index is never read or written.
    async buildTree (entries, indexFile) {
      const records = entries.map((entry) => `${entry.mode} ${entry.sha}\t${entry.path}\0`).join('')
      const env = { GIT_INDEX_FILE: indexFile }
      await run(['update-index', '-z', '--index-info'], { stdin: records, env })
      return trimmed(['write-tree'], { env })
    },

    treeOf (commitish) {
      return trimmed(['rev-parse', '--verify', '--end-of-options', `${commitish}^{tree}`])
    },

    commitTree (treeSha, { parent, message, identity }) {
      const args = ['commit-tree', treeSha]
      if (parent) args.push('-p', parent)
      args.push('-m', message)

      const env = identity
        ? {
            GIT_AUTHOR_NAME: identity.name,
            GIT_AUTHOR_EMAIL: identity.email,
            GIT_COMMITTER_NAME: identity.name,
            GIT_COMMITTER_EMAIL: identity.email
          }
        : {}
      return trimmed(args, { env })
    },

    async updateRef (ref, sha) {
      await run(['update-ref', ref, sha])
    },

    async refExists (ref) {
      const { code } = await run(
        ['rev-parse', '--verify', '--quiet', '--end-of-options', ref],
        { allowFailure: true }
      )
      return code === 0
    },

    async hasRemote (name) {
      const { stdout } = await run(['remote'])
      return stdout.split('\n').map((line) => line.trim()).includes(name)
    },

    // Fetches just this branch, shallow-friendly. Returns false when the remote has no such
    // branch, which is the first-publish case rather than an error.
    async fetchBranch (remote, branch) {
      const { code } = await run(
        ['fetch', '--no-tags', '--quiet', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`],
        { allowFailure: true }
      )
      return code === 0
    },

    async push (remote, sha, branch) {
      await run(['push', remote, `${sha}:refs/heads/${branch}`])
    }
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS. Two likely failures: if `git init -b` is unsupported the installed git is older than 2.28 and must be upgraded; if cleanup fails on Windows with `EBUSY`, confirm `rm` is called with `maxRetries`.

- [ ] **Step 6: Commit**

```bash
git add src/git.js test/helpers/repo.js test/git.test.js
git commit -m "Add the git wrapper and temporary-repo test helper"
```

---

## Task 6: `publish.js` — orchestration

**Files:**
- Create: `src/publish.js`, `test/publish.test.js`

**Interfaces:**
- Consumes: `loadConfig`, `ConfigError` from `src/config.js`; `resolvePayload` from `src/payload.js`; `createGit`, `GitError` from `src/git.js`
- Produces:
  - `class PublishError extends Error` — user-facing failures that are not `ConfigError`
  - `publish(options): Promise<Report>` where `options = { repoPath, configPath, source, dryRun, push, env }`
    - `repoPath` defaults to `process.cwd()`, `configPath` to `.modbuild`, `source` to `'HEAD'`, `dryRun` to `false`, `push` to `true`, `env` to `process.env`
  - `Report`:
    ```js
    {
      configPath: string,
      dryRun: boolean,
      source: { ref: string, sha: string, branch: string|null },
      remote: string|null,          // 'origin' when it exists, else null
      mods: [{
        root: string,
        target: string,
        included: [{ path: string, bytes: number }],
        excluded: [{ path: string, rule: string }],
        fileCount: number,
        totalBytes: number,
        warnings: string[],
        unchanged: boolean,         // resulting tree equals the target tip's tree
        created: boolean,           // the target branch did not exist before this run
        commit: string|null,        // null when unchanged or dryRun
        pushed: boolean
      }]
    }
    ```

Order of operations matters: **every mod is fully resolved and validated before any ref is written**, so a failure on the second mod cannot leave the first published.

- [ ] **Step 1: Write the failing tests**

```js
// test/publish.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/publish.js'`.

- [ ] **Step 3: Implement `src/publish.js`**

```js
// src/publish.js
import path from 'node:path'
import { tmpdir } from 'node:os'
import { rm } from 'node:fs/promises'
import { loadConfig } from './config.js'
import { resolvePayload } from './payload.js'
import { createGit } from './git.js'

const ACTIONS_IDENTITY = {
  name: 'github-actions[bot]',
  email: '41898282+github-actions[bot]@users.noreply.github.com'
}

export class PublishError extends Error {
  constructor (message) {
    super(message)
    this.name = 'PublishError'
  }
}

export async function publish ({
  repoPath = process.cwd(),
  configPath = '.modbuild',
  source = 'HEAD',
  dryRun = false,
  push = true,
  env = process.env
} = {}) {
  const git = createGit(repoPath)
  if (!(await git.isRepo())) {
    throw new PublishError(
      `${repoPath} is not a git repository. Run pa-mod-build from inside your mod's repository, ` +
      'or pass --repo with the path to it.'
    )
  }

  const mods = await loadConfig(path.resolve(repoPath, configPath))

  let sourceSha
  try {
    sourceSha = await git.revParse(source)
  } catch {
    throw new PublishError(
      `Could not resolve --source ${JSON.stringify(source)} to a commit. Check the branch or ` +
      'commit exists in this repository.'
    )
  }
  const sourceBranch = source === 'HEAD' ? await git.currentBranch() : await git.refBranchName(source)

  for (const mod of mods) {
    if (sourceBranch !== null && mod.target === sourceBranch) {
      throw new PublishError(
        `The mod rooted at "${mod.root}" publishes to "${mod.target}", which is the branch being ` +
        'built from. Publishing onto the source branch would overwrite your work. Change ' +
        `"target" in ${configPath}, or build from a different branch with --source.`
      )
    }
  }

  const files = await git.lsTree(sourceSha)

  // Resolve and validate every mod before writing anything, so a failure on the second mod
  // cannot leave the first published.
  const resolved = mods.map((mod) => {
    const payload = resolvePayload(files, mod)
    assertUsablePayload(payload, mod, files, configPath)
    return { mod, payload }
  })

  const sizes = await git.blobSizes(resolved.flatMap(({ payload }) => payload.included.map((file) => file.sha)))
  const remote = (await git.hasRemote('origin')) ? 'origin' : null
  const identity = env.GITHUB_ACTIONS ? ACTIONS_IDENTITY : null

  const report = {
    configPath,
    dryRun,
    source: { ref: source, sha: sourceSha, branch: sourceBranch },
    remote,
    mods: []
  }

  for (const { mod, payload } of resolved) {
    report.mods.push(await publishMod({
      git, mod, payload, sizes, sourceSha, remote, identity, dryRun, push, repoPath
    }))
  }

  return report
}

async function publishMod ({ git, mod, payload, sizes, sourceSha, remote, identity, dryRun, push, repoPath }) {
  const included = payload.included.map((file) => ({ path: file.path, bytes: sizes.get(file.sha) ?? 0 }))
  const result = {
    root: mod.root,
    target: mod.target,
    included,
    excluded: payload.excluded.map((file) => ({ path: file.path, rule: file.rule })),
    fileCount: included.length,
    totalBytes: included.reduce((total, file) => total + file.bytes, 0),
    warnings: warningsFor(payload),
    unchanged: false,
    created: false,
    commit: null,
    pushed: false
  }

  const tip = await resolveTarget(git, mod.target, remote)
  result.created = tip === null

  // Deliberately in the OS temp directory, not inside .git: in a git worktree ".git" is a file,
  // not a directory, and writing into it would fail.
  const indexFile = path.join(tmpdir(), `pamb-index-${process.pid}-${mod.target.replace(/[^\w.-]/g, '_')}`)
  let tree
  try {
    tree = await git.buildTree(payload.included, indexFile)
  } finally {
    await rm(indexFile, { force: true })
  }

  if (tip !== null && (await git.treeOf(tip)) === tree) {
    result.unchanged = true
    return result
  }

  if (dryRun) return result

  const commit = await git.commitTree(tree, {
    parent: tip,
    message: await commitMessage(git, payload, sourceSha),
    identity
  })
  await git.updateRef(`refs/heads/${mod.target}`, commit)
  result.commit = commit

  if (push && remote !== null) {
    await git.push(remote, commit, mod.target)
    result.pushed = true
  }
  return result
}

// origin is preferred so a local run and an Actions run commit on top of the same thing, and a
// stale local branch cannot cause a bad publish.
async function resolveTarget (git, target, remote) {
  if (remote !== null && (await git.fetchBranch(remote, target))) {
    return git.revParse(`refs/remotes/${remote}/${target}`)
  }
  if (await git.refExists(`refs/heads/${target}`)) {
    return git.revParse(`refs/heads/${target}`)
  }
  return null
}

function assertUsablePayload (payload, mod, files, configPath) {
  if (payload.included.length > 0) return

  if (payload.excluded.length === 0) {
    const candidates = modinfoDirectories(files)
    const hint = candidates.length > 0
      ? ` Directories in this repository that contain a modinfo.json: ${candidates.join(', ')}.`
      : ' No modinfo.json was found anywhere in this repository.'
    throw new PublishError(
      `"root" is ${JSON.stringify(mod.root)} in ${configPath}, but no tracked files live there.` + hint
    )
  }

  throw new PublishError(
    `The mod rooted at ${JSON.stringify(mod.root)} has no files left to publish — all ` +
    `${payload.excluded.length} of them were removed by "ignore" rules in ${configPath}. Check ` +
    'those rules are not broader than you intended.'
  )
}

function modinfoDirectories (files) {
  const directories = new Set()
  for (const file of files) {
    if (!file.path.endsWith('modinfo.json')) continue
    const slash = file.path.lastIndexOf('/')
    directories.add(slash === -1 ? '.' : file.path.slice(0, slash))
  }
  return [...directories].sort()
}

function warningsFor (payload) {
  if (payload.included.some((file) => file.path === 'modinfo.json')) return []

  const deeper = payload.included.find((file) => file.path.endsWith('/modinfo.json'))
  const base = 'The published files do not include a modinfo.json at their root, so Planetary ' +
    'Annihilation will not recognise this as a mod.'
  return [
    deeper
      ? `${base} There is one at ${deeper.path} — "root" is probably pointing one or more ` +
        'directories too high.'
      : `${base} Check that "root" points at the directory containing your modinfo.json.`
  ]
}

async function commitMessage (git, payload, sourceSha) {
  const version = await readVersion(git, payload)
  const shortSha = sourceSha.slice(0, 7)
  return version === null
    ? `Publish mod from ${shortSha}`
    : `Publish mod v${version} from ${shortSha}`
}

// The version is a nicety in the commit subject, never a correctness concern, so a malformed or
// absent modinfo.json simply drops it rather than failing the run. The blob is only read when a
// root modinfo.json exists, so a mod without a manifest costs no extra git call.
async function readVersion (git, payload) {
  const modinfo = payload.included.find((file) => file.path === 'modinfo.json')
  if (!modinfo) return null
  try {
    const parsed = JSON.parse(await git.catFile(modinfo.sha))
    return typeof parsed?.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS. Two likely failures worth knowing in advance:
- *"the actions identity" test fails with `Committer identity unknown`* — `commitTree` must pass `GIT_COMMITTER_*` as well as `GIT_AUTHOR_*`.
- *"origin is preferred over a stale local one" fails* — check `resolveTarget` fetches before reading `refs/remotes/...`, and that `fetchBranch` uses a `+` refspec so a rewound remote branch still updates.

- [ ] **Step 5: Commit**

```bash
git add src/publish.js test/publish.test.js
git commit -m "Add publish orchestration and ref mechanics"
```

---

## Task 7: `summary.js` — the report renderer

**Files:**
- Create: `src/summary.js`, `test/summary.test.js`

**Interfaces:**
- Consumes: the `Report` shape produced by `src/publish.js`
- Produces: `renderSummary(report: Report): string` — GitHub-flavoured markdown, readable as plain text in a terminal

- [ ] **Step 1: Write the failing tests**

```js
// test/summary.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderSummary } from '../src/summary.js'

const report = (overrides = {}) => ({
  configPath: '.modbuild',
  dryRun: false,
  source: { ref: 'HEAD', sha: 'a'.repeat(40), branch: 'main' },
  remote: 'origin',
  mods: [modReport()],
  ...overrides
})

const modReport = (overrides = {}) => ({
  root: 'Mod',
  target: 'published-mod',
  included: [{ path: 'modinfo.json', bytes: 120 }, { path: 'ui/a.js', bytes: 2048 }],
  excluded: [{ path: 'pachat.zip', rule: 'pachat.zip' }],
  fileCount: 2,
  totalBytes: 2168,
  warnings: [],
  unchanged: false,
  created: true,
  commit: 'b'.repeat(40),
  pushed: true,
  ...overrides
})

test('a successful publish names source, target and commit', () => {
  const output = renderSummary(report())
  assert.match(output, /main/)
  assert.match(output, /a{7}/)
  assert.match(output, /published-mod/)
  assert.match(output, /b{7}/)
})

test('the payload count and total size are reported in human units', () => {
  const output = renderSummary(report())
  assert.match(output, /2 files/)
  assert.match(output, /2\.2 kB/) // 120 + 2048 bytes, rounded to one decimal
})

test('excluded paths are listed with the rule that matched', () => {
  const output = renderSummary(report())
  assert.match(output, /pachat\.zip/)
  assert.match(output, /`pachat\.zip`/)
})

test('an unchanged mod says so and shows no commit', () => {
  const output = renderSummary(report({ mods: [modReport({ unchanged: true, commit: null, pushed: false })] }))
  assert.match(output, /no changes — nothing to publish/)
})

test('a dry run is labelled and states that nothing was written', () => {
  const output = renderSummary(report({ dryRun: true, mods: [modReport({ commit: null, pushed: false })] }))
  assert.match(output, /dry run/i)
  assert.match(output, /would/i)
})

test('warnings are rendered prominently', () => {
  const output = renderSummary(report({ mods: [modReport({ warnings: ['No modinfo.json at the payload root.'] })] }))
  assert.match(output, /No modinfo\.json at the payload root\./)
  assert.match(output, /⚠|Warning/)
})

test('several mods each get their own section', () => {
  const output = renderSummary(report({
    mods: [
      modReport({ root: 'mods/a', target: 'published-a' }),
      modReport({ root: 'mods/b', target: 'published-b' })
    ]
  }))
  assert.match(output, /published-a/)
  assert.match(output, /published-b/)
  assert.equal(output.match(/^### /gm).length, 2)
})

test('a run with no remote says nothing was pushed', () => {
  const output = renderSummary(report({ remote: null, mods: [modReport({ pushed: false })] }))
  assert.match(output, /not pushed|no remote/i)
})

test('a mod with no exclusions omits the exclusions section', () => {
  const output = renderSummary(report({ mods: [modReport({ excluded: [] })] }))
  assert.equal(/Excluded/.test(output), false)
})

test('rendering is deterministic', () => {
  assert.equal(renderSummary(report()), renderSummary(report()))
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/summary.js'`.

- [ ] **Step 3: Implement `src/summary.js`**

```js
// src/summary.js
export function renderSummary (report) {
  const lines = []
  const title = report.dryRun ? 'Mod publish (dry run)' : 'Mod publish'
  lines.push(`## ${title}`, '')

  const sourceLabel = report.source.branch ?? report.source.ref
  lines.push(`Built from **${sourceLabel}** at \`${short(report.source.sha)}\`, using \`${report.configPath}\`.`)
  if (report.dryRun) {
    lines.push('', 'Nothing was committed or pushed. This is what a real run would do.')
  }
  lines.push('')

  for (const mod of report.mods) {
    lines.push(...renderMod(mod, report))
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

function renderMod (mod, report) {
  const lines = [`### \`${mod.root}\` → \`${mod.target}\``, '']

  for (const warning of mod.warnings) {
    lines.push(`> ⚠ **Warning.** ${warning}`, '')
  }

  if (mod.unchanged) {
    lines.push('**no changes — nothing to publish.** The payload is identical to what is already on the branch.', '')
  } else if (report.dryRun) {
    lines.push(
      `Would ${mod.created ? 'create' : 'commit to'} \`${mod.target}\` with ` +
      `${count(mod.fileCount)} (${formatBytes(mod.totalBytes)}).`,
      ''
    )
  } else {
    const action = mod.created ? 'Created' : 'Committed to'
    const pushed = mod.pushed
      ? `pushed to \`${report.remote}\``
      : report.remote === null
        ? 'not pushed — no remote is configured'
        : 'not pushed'
    lines.push(
      `${action} \`${mod.target}\` as \`${short(mod.commit)}\`, ${pushed}. ` +
      `Payload: ${count(mod.fileCount)}, ${formatBytes(mod.totalBytes)}.`,
      ''
    )
  }

  if (mod.excluded.length > 0) {
    lines.push(`<details><summary>Excluded ${count(mod.excluded.length)}</summary>`, '')
    lines.push('| Path | Rule |', '| --- | --- |')
    for (const file of mod.excluded) {
      lines.push(`| \`${file.path}\` | \`${file.rule}\` |`)
    }
    lines.push('', '</details>', '')
  }

  return lines
}

const short = (sha) => (sha === null ? '' : sha.slice(0, 7))
const count = (n) => `${n} file${n === 1 ? '' : 's'}`

// Decimal units, matching how file sizes are quoted everywhere a mod author will see them.
function formatBytes (bytes) {
  if (bytes < 1000) return `${bytes} B`
  const units = ['kB', 'MB', 'GB']
  let value = bytes / 1000
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit++
  }
  return `${value.toFixed(1)} ${units[unit]}`
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS. If the "several mods" test fails on the `### ` count, check that `renderMod` emits exactly one `###` heading per mod and that no other line starts with `### `.

- [ ] **Step 5: Commit**

```bash
git add src/summary.js test/summary.test.js
git commit -m "Add report rendering"
```

---

## Task 8: `cli.js` — argv, environment and exit codes

**Files:**
- Create: `src/cli.js`, `test/cli.test.js`

**Interfaces:**
- Consumes: `publish`, `PublishError` from `src/publish.js`; `renderSummary` from `src/summary.js`; `ConfigError` from `src/config.js`
- Produces: the `pa-mod-build` executable. Exit `0` on success including a no-change run, `1` on any error.

Options resolve **flag → environment variable → default**, and only ever cover plumbing. There is deliberately no `--target`.

| Flag | Env | Default |
|---|---|---|
| `--config <path>` | `PAMB_CONFIG` | `.modbuild` |
| `--source <ref>` | `PAMB_SOURCE` | `HEAD` |
| `--repo <path>` | `PAMB_REPO` | cwd |
| `--dry-run` | `PAMB_DRY_RUN` | `false` |
| `--no-push` | `PAMB_PUSH=false` | push enabled |

- [ ] **Step 1: Write the failing tests**

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module` for `src/cli.js`.

- [ ] **Step 3: Implement `src/cli.js`**

```js
#!/usr/bin/env node
// src/cli.js
import { parseArgs } from 'node:util'
import { appendFile } from 'node:fs/promises'
import { publish, PublishError } from './publish.js'
import { renderSummary } from './summary.js'
import { ConfigError } from './config.js'

const USAGE = `pa-mod-build publish [options]

Publishes a clean copy of your Planetary Annihilation mod to its own branch,
as described by .modbuild.

  --config <path>    path to the .modbuild file      (default: .modbuild, env: PAMB_CONFIG)
  --source <ref>     branch or commit to build from  (default: HEAD, env: PAMB_SOURCE)
  --repo <path>      repository to run against       (default: current directory, env: PAMB_REPO)
  --dry-run          resolve and report, write and push nothing   (env: PAMB_DRY_RUN)
  --no-push          commit locally without pushing               (env: PAMB_PUSH=false)
  --help             show this message

The publish branch is set with "target" in .modbuild, not on the command line,
so everything about a mod lives in one file.
`

const OPTIONS = {
  config: { type: 'string' },
  source: { type: 'string' },
  repo: { type: 'string' },
  'dry-run': { type: 'boolean' },
  'no-push': { type: 'boolean' },
  help: { type: 'boolean' }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`)
  process.exitCode = 1
})

async function main () {
  let parsed
  try {
    parsed = parseArgs({ args: process.argv.slice(2), options: OPTIONS, allowPositionals: true, strict: true })
  } catch (error) {
    return fail(`${error.message}\n\n${USAGE}`)
  }

  if (parsed.values.help) {
    process.stdout.write(USAGE)
    return
  }

  const [command] = parsed.positionals
  if (command === undefined) return fail(USAGE)
  if (command !== 'publish') {
    return fail(`Unknown command "${command}". The available command is: publish.\n\n${USAGE}`)
  }

  const options = {
    repoPath: parsed.values.repo ?? process.env.PAMB_REPO ?? process.cwd(),
    configPath: parsed.values.config ?? process.env.PAMB_CONFIG ?? '.modbuild',
    source: parsed.values.source ?? process.env.PAMB_SOURCE ?? 'HEAD',
    dryRun: parsed.values['dry-run'] ?? isTrue(process.env.PAMB_DRY_RUN),
    push: parsed.values['no-push'] ? false : !isFalse(process.env.PAMB_PUSH)
  }

  let report
  try {
    report = await publish(options)
  } catch (error) {
    if (error instanceof ConfigError || error instanceof PublishError) return fail(error.message)
    throw error
  }

  await write(renderSummary(report))
}

async function write (text) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (summaryPath) {
    await appendFile(summaryPath, text, 'utf8')
    return
  }
  process.stdout.write(text)
}

function fail (message) {
  process.stderr.write(`${message.trimEnd()}\n`)
  process.exitCode = 1
}

const isTrue = (value) => value === 'true' || value === '1'
const isFalse = (value) => value === 'false' || value === '0'
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS. If the `--repo` test fails on Windows, check the `cli` path fix-up in the test — `URL.pathname` yields `/C:/...`, which `execFile` cannot run.

- [ ] **Step 5: Verify the binary runs as installed**

Run: `npm pack --dry-run`
Expected: the file list contains `src/` and `schema/` and nothing from `test/`.

- [ ] **Step 6: Commit**

```bash
git add src/cli.js test/cli.test.js
git commit -m "Add the command line entry point"
```

---

## Task 9: Acceptance against the real mods, and README

**Files:**
- Modify: `README.md`
- Create: `.modbuild` (this repository's own config is not needed — see step 4)

**Interfaces:**
- Consumes: the finished command
- Produces: evidence the acceptance criteria in #2 are met

The three reference clones are at:
- `C:\Users\jamie\Dev\jamiemulcahy\instant_sandbox` — mod at repo root, ships `work/icon.xcf`
- `C:\Users\jamie\Dev\PA\com.pa.jamiemulcahy.anonywho` — mod at repo root, ships `.vscode/`, `CLAUDE.md`, `PLAN.md`
- `C:\Users\jamie\Dev\jamiemulcahy\PaChat` — mod under `Mod/`, alongside a C# solution

**Do not modify the clones.** Write each `.modbuild` to a temporary copy, or pass `--config` pointing at a file outside the repo. Every command here uses `--dry-run`.

- [ ] **Step 1: Dry-run against PaChat, the case that motivates `root`**

```bash
node src/cli.js publish --repo "C:/Users/jamie/Dev/jamiemulcahy/PaChat" --config "/c/Users/jamie/AppData/Local/Temp/pachat.modbuild" --dry-run
```

First write that config:

```json
{ "root": "Mod", "ignore": [".jshintrc", "pachat.zip"] }
```

Expected: 37 files, no `Server/`, no `Logo.psd`, no `CLAUDE.md`, and no ignore rules needed for the C# solution — `"root": "Mod"` alone excludes it. Record the actual file count in the commit message. If `modinfo.json` is missing from the payload the warning must appear.

- [ ] **Step 2: Dry-run against instant_sandbox**

Config:

```json
{ "root": ".", "ignore": [".modbuild", ".gitignore", "work/", "*.xcf"] }
```

Expected: `work/icon.xcf` excluded with the rule that matched shown; `modinfo.json` present; no warning.

- [ ] **Step 3: Dry-run against com.pa.jamiemulcahy.anonywho**

Config:

```json
{ "root": ".", "ignore": [".modbuild", ".gitignore", ".vscode/", "CLAUDE.md", "PLAN.md"] }
```

Expected: `.vscode/sync-mod.ps1`, `.vscode/tasks.json`, `CLAUDE.md` and `PLAN.md` all excluded, each naming its rule.

- [ ] **Step 4: Confirm a wrong `root` produces the promised hint**

```bash
node src/cli.js publish --repo "C:/Users/jamie/Dev/jamiemulcahy/PaChat" --config <a config with "root": "Mods"> --dry-run
```

Expected: exit 1, message naming `Mods` and listing `Mod` as a directory containing a `modinfo.json`.

- [ ] **Step 5: Update the README**

Replace the "Status: early. Nothing here works yet." banner with an accurate statement that the command works and the action does not exist yet, and update the `.modbuild` example to include `target`. Add a short "Try it" section:

````markdown
## Try it

```bash
npx pa-mod-build-tools publish --dry-run
```

Nothing is written or pushed. The report shows exactly which files would be published
and which were left out, with the `.modbuild` rule that excluded each one.
````

Keep the existing "Design decisions so far" table, but change the config-split row to say that `.modbuild` owns `root`, `ignore` and `target` while the workflow owns source, config and token.

- [ ] **Step 6: Run the full suite one more time**

Run: `npm test`
Expected: PASS, all files.

- [ ] **Step 7: Commit**

```bash
git add README.md
git commit -m "Verify the command against the three reference mods and update the README"
```

---

## Task 10: Repository settings

These are GitHub settings, not code, and cannot be done from a branch. Do them after the pull request merges.

- [ ] **Step 1: Add CI as a required status check**

In the `main` ruleset, add the `test` job as a required status check. It has four matrix legs; require the check named `test` so all legs must pass.

- [ ] **Step 2: Retry CodeQL default setup**

It previously 404'd because the repository had no code to analyse. With JavaScript present it should now enable.

- [ ] **Step 3: Confirm on the next pull request**

Expected: CI runs on the PR, the merge button is blocked until it passes, and CodeQL reports.

---

## Deviations from the spec

Three, all deliberate. Each is a place where following the spec's letter would have made the code worse:

1. **Branch-name validation is a regex in `config.js`, not `git check-ref-format`.** The spec names the git command. Shelling out would drag git into an otherwise pure module and make its tests need a repository. The regex implements the same rules for branch names, and the user-visible outcome is identical.

2. **`git.js` gained `catFile`.** Not in the spec's module list, but reading the mod version for the commit subject needs blob contents, and `git.js` is where git calls belong.

3. **A dry run writes unreferenced tree objects.** `git write-tree` must run to answer "would this produce a commit?". The objects are unreachable and collected by `git gc`. The spec has been corrected to say so rather than claiming a dry run writes nothing.

4. **"Invalid JSON reports line and column" holds on Node 20, and on Node 22 only where the runtime supplies a character offset.** Node 22 improved `JSON.parse` messages and dropped the offset from some of them; those messages instead quote the offending token and its surrounding text, which is at least as useful. Recovering a position in every case would mean shipping a hand-rolled JSON scanner, which is not worth it for an error path. The spec's error table should be read with this qualification.

## Notes for whoever implements this

- **The plumbing chain is already proven.** It was run end to end against a PaChat clone before this plan was written: 39 of 147 files published, prefix stripped, orphan commit parentless, unchanged second run detected by tree-sha comparison, caller's index and working tree untouched, resulting ref pushed to a bare remote. If something does not work, suspect the code rather than the approach.
- **Blob identity is preserved** because nothing passes through a working tree, so no `.gitattributes` eol conversion is applied. Do not "fix" this by materialising files.
- **Long paths break git on Windows.** Test temp directories must come from `os.tmpdir()`, not a deep scratch path.
- **`ignore` rejects paths that are absolute or start with `./`.** `payload.js` must never hand it one.
- **The rule-attribution algorithm and the `ignore` semantics in Task 4 were verified against `ignore@7.0.6`** before this plan was written. Every expected value in those tests is a recorded output, not a guess — including the two parent-directory cases, which are the counter-intuitive ones.
