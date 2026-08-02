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
