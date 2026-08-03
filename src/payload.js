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
