#!/usr/bin/env node
// Publishes a clean copy of a Planetary Annihilation mod to its own branch.
//
// Works entirely in git's object database — no working tree is touched, so this is safe to
// run over a repository you are in the middle of editing.
//
// Everything unrecognised here is fatal rather than ignored. A tool whose whole job is keeping
// files off a public branch must never treat "I did not understand that" as "carry on".
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ignore from 'ignore'

const USAGE = 'usage: pa-mod-build publish [--source <ref>] [--config <path>] [--dry-run]'
// Published commits are generated output, so they are attributed to the tool rather than to
// whoever happened to run it. That also means a run needs no git identity configured, which a
// CI runner generally has not got, and it is how a later run tells a branch it wrote itself
// apart from one holding somebody's real work.
const IDENTITY = { name: 'pa-mod-build', email: 'pa-mod-build@users.noreply.github.com' }
const OPTIONS = { '--source': true, '--config': true, '--dry-run': false } // true = takes a value
const MOD_KEYS = ['root', 'ignore', 'target']

const git = (args, opts) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28, ...opts })
const line = (args, opts) => git(args, opts).trim()
// For commands whose failure is a legitimate answer: no such branch yet, or an unreachable remote.
const attempt = (args, opts) => { try { return line(args, { stdio: 'pipe', ...opts }) } catch { return null } }
const lines = (text) => text.split('\n').filter(Boolean)

// "--dry-run=true" and "--dryrun" would otherwise parse as no dry run at all and publish for
// real — the exact opposite of what whoever typed them asked for.
const argv = process.argv.slice(2)
if (argv[0] !== 'publish') die(USAGE)
for (let i = 1; i < argv.length; i++) {
  if (!(argv[i] in OPTIONS)) die(`unknown option ${JSON.stringify(argv[i])}\n${USAGE}`)
  if (!OPTIONS[argv[i]]) continue
  if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) die(`${argv[i]} needs a value\n${USAGE}`)
  i++
}
const flag = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback)
const dryRun = argv.includes('--dry-run')

const configPath = flag('--config', '.modbuild')
const mods = readConfig(configPath)
const sha = line(['rev-parse', `${flag('--source', 'HEAD')}^{commit}`])
const remote = line(['remote']).split('\n').includes('origin') ? 'origin' : null
// Every branch checked out anywhere in this repository, linked worktrees included. Asking git
// this rather than reading HEAD is what makes the guard below still work under a detached HEAD,
// which is what actions/checkout leaves behind for pull_request events and tag pushes.
const checkedOut = lines(line(['worktree', 'list', '--porcelain'])).filter((l) => l.startsWith('branch ')).map((l) => l.slice(7))

for (const { root, ignore: patterns, target } of mods) {
  if (checkedOut.includes(`refs/heads/${target}`)) {
    die(`"${target}" is checked out — publishing to it would replace the files under a working tree`)
  }

  if (remote) attempt(['fetch', '--no-tags', '-q', remote, `+refs/heads/${target}:refs/remotes/${remote}/${target}`])
  const parent = attempt(['rev-parse', '--verify', '-q', `refs/remotes/${remote}/${target}`]) ??
    attempt(['rev-parse', '--verify', '-q', `refs/heads/${target}`])

  // Refuse any branch this tool did not write. That is what stops a "target" naming the branch
  // being built from — or any other branch holding real work — from being replaced by a payload.
  if (parent && attempt(['log', '-1', '--format=%ae', parent]) !== IDENTITY.email) {
    die(`"${target}" was not published by pa-mod-build, so overwriting it would throw away whatever ` +
      `is on it. Set a different "target" in ${configPath}, or delete the branch if you really mean to.`)
  }

  const prefix = root === '.' ? '' : `${root}/`
  // The library defaults to case-insensitive matching; git does not, and over-matching here
  // would silently drop files the author meant to ship.
  const ig = ignore({ ignorecase: false }).add(patterns)
  const files = git(['ls-tree', '-r', '-z', sha]).split('\0').filter(Boolean)
    .map((row) => [row.slice(0, row.indexOf('\t')).split(' '), row.slice(row.indexOf('\t') + 1)])
    .filter(([, path]) => path.startsWith(prefix))
    .map(([[mode, , blob], path]) => ({ mode, blob, path: path.slice(prefix.length) }))
    .filter(({ path }) => !ig.ignores(path))
  if (!files.length) die(`nothing to publish from "${root}"`)

  // A gitlink records a commit this repository does not contain, so publishing one leaves an
  // empty directory where the submodule should be. Better to stop than to ship a mod with a hole.
  const gitlink = files.find(({ mode }) => mode === '160000')
  if (gitlink) {
    die(`"${gitlink.path}" is a submodule, whose contents cannot be published as files. Add it to ` +
      `"ignore" in ${configPath}, or vendor its files into the mod.`)
  }

  // A scratch index, so the caller's real one is never read or written.
  const dir = mkdtempSync(join(tmpdir(), 'pamb-'))
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') }
  git(['update-index', '-z', '--index-info'], { env, input: files.map((f) => `${f.mode} ${f.blob}\t${f.path}\0`).join('') })
  const tree = line(['write-tree'], { env })
  rmSync(dir, { recursive: true, force: true })

  if (parent && tree === line(['rev-parse', `${parent}^{tree}`])) { log(`${target}: unchanged`); continue }
  if (dryRun) { log(`${target}: would publish ${files.length} files from ${root}`); continue }

  const commit = line(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', `Publish mod from ${sha.slice(0, 7)}`], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: IDENTITY.name,
      GIT_AUTHOR_EMAIL: IDENTITY.email,
      GIT_COMMITTER_NAME: IDENTITY.name,
      GIT_COMMITTER_EMAIL: IDENTITY.email
    }
  })
  // Pushed before the local ref moves. A local branch left pointing at a payload that never
  // reached the remote would make the next run find a matching tree, report "unchanged" and
  // exit 0 while the remote still had nothing on it.
  if (remote) git(['push', '-q', remote, `${commit}:refs/heads/${target}`])
  git(['update-ref', `refs/heads/${target}`, commit])
  log(`${target}: published ${files.length} files from ${root} as ${commit.slice(0, 7)}${remote ? '' : ' (not pushed, no remote)'}`)
}

function readConfig (path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    die(`${path} must contain a JSON object, for example {"root": "Mod"}.`)
  }

  const multi = raw.mods !== undefined
  checkKeys(raw, multi ? ['$schema', 'mods'] : ['$schema', ...MOD_KEYS], path)
  if (multi && (!Array.isArray(raw.mods) || raw.mods.length === 0)) {
    die(`${path}: "mods" must be a non-empty array of mod objects.`)
  }

  const mods = (multi ? raw.mods : [raw]).map((entry, index) => {
    const where = multi ? `${path}: mods[${index}]` : path
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) die(`${where} must be an object.`)
    // Only in the multi form: in the single form this entry *is* the top-level object, whose
    // keys were checked above against a list that also permits "$schema".
    if (multi) checkKeys(entry, MOD_KEYS, where)

    const { root = '.', ignore: patterns = [], target = 'published-mod' } = entry
    if (typeof root !== 'string') die(`${where}: "root" must be a string.`)
    if (typeof target !== 'string') die(`${where}: "target" must be a string.`)
    if (!Array.isArray(patterns) || patterns.some((p) => typeof p !== 'string')) {
      die(`${where}: "ignore" must be an array of strings.`)
    }
    return { root, ignore: patterns, target }
  })

  const targets = mods.map((mod) => mod.target)
  const duplicate = targets.find((target, index) => targets.indexOf(target) !== index)
  if (duplicate !== undefined) {
    die(`${path}: more than one mod publishes to "${duplicate}", so they would overwrite each ` +
      'other. Give each mod its own "target".')
  }
  return mods
}

// An unknown key is fatal because the likeliest one to mistype is "ignore" — and a dropped
// "ignore" publishes every file it was meant to withhold, reporting success as it goes.
function checkKeys (object, allowed, where) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) die(`${where}: unknown key "${key}". Allowed here: ${allowed.join(', ')}.`)
  }
}

function log (message) { process.stdout.write(`${message}\n`) }
function die (message) { process.stderr.write(`pa-mod-build: ${message}\n`); process.exit(1) }
