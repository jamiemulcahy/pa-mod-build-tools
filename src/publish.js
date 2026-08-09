#!/usr/bin/env node
// Publishes a clean copy of a Planetary Annihilation mod to its own branch.
//
// Works entirely in git's object database — no working tree is touched, so this is safe to run
// over a repository you are in the middle of editing.
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ignore from 'ignore'

// Published commits are attributed to the tool rather than to whoever ran it, so a run needs no
// git identity configured — a CI runner has not got one.
const EMAIL = 'pa-mod-build@users.noreply.github.com'
const AUTHOR = {
  GIT_AUTHOR_NAME: 'pa-mod-build', GIT_AUTHOR_EMAIL: EMAIL, GIT_COMMITTER_NAME: 'pa-mod-build', GIT_COMMITTER_EMAIL: EMAIL
}

const git = (args, opts) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28, ...opts })
const line = (args, opts) => git(args, opts).trim()
// For commands whose failure is a legitimate answer: no such branch yet, or an unreachable remote.
const attempt = (args) => { try { return line(args, { stdio: 'pipe' }) } catch { return null } }

// Checked rather than ignored so that "--dry-run=true" cannot parse as no dry run and publish
// for real, which is the opposite of what whoever typed it asked for.
const argv = process.argv.slice(2)
const dryRun = argv[1] === '--dry-run'
if (argv[0] !== 'publish' || argv.length > (dryRun ? 2 : 1)) die('usage: pa-mod-build publish [--dry-run]')

// Hand-edited by people who have no terminal to read a stack trace in, so a missing file and a
// trailing comma both have to arrive as something the author can act on.
let raw
try {
  raw = JSON.parse(readFileSync('.modbuild', 'utf8'))
} catch (error) {
  die(error.code === 'ENOENT' ? 'no .modbuild in this directory' : `.modbuild: ${error.message}`)
}
const mods = (raw.mods ?? [raw]).map((mod) => ({ root: '.', ignore: [], target: 'published-mod', ...mod }))
const sha = line(['rev-parse', 'HEAD^{commit}'])
const remote = line(['remote']).split('\n').includes('origin') ? 'origin' : null

for (const { root, ignore: patterns, target } of mods) {
  // Dropped before the fetch so it cannot answer for one that failed: a branch deleted on the
  // remote would otherwise leave a stale ref that every later run compares equal to, reporting
  // "unchanged" for good while the remote has nothing on it.
  const tracking = `refs/remotes/${remote}/${target}`
  if (remote) { attempt(['update-ref', '-d', tracking]); attempt(['fetch', '--no-tags', '-q', remote, `+refs/heads/${target}:${tracking}`]) }
  const parent = attempt(['rev-parse', '--verify', '-q', remote ? tracking : `refs/heads/${target}`])

  const prefix = root === '.' ? '' : `${root}/`
  // The library matches case-insensitively by default where git does not.
  const ig = ignore({ ignorecase: false }).add(patterns)
  const files = git(['ls-tree', '-r', '-z', sha]).split('\0').filter(Boolean)
    .map((row) => [row.slice(0, row.indexOf('\t')).split(' '), row.slice(row.indexOf('\t') + 1)])
    .filter(([, path]) => path.startsWith(prefix))
    .map(([[mode, , blob], path]) => ({ mode, blob, path: path.slice(prefix.length) }))
    .filter(({ path }) => !ig.ignores(path))
  if (!files.length) die(`nothing to publish from "${root}"`)

  // A scratch index, so the caller's real one is never read or written.
  const dir = mkdtempSync(join(tmpdir(), 'pamb-'))
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') }
  git(['update-index', '-z', '--index-info'], { env, input: files.map((f) => `${f.mode} ${f.blob}\t${f.path}\0`).join('') })
  const tree = line(['write-tree'], { env })
  rmSync(dir, { recursive: true, force: true })

  if (parent && tree === line(['rev-parse', `${parent}^{tree}`])) { log(`${target}: unchanged`); continue }
  if (dryRun) { log(`${target}: would publish ${files.length} files from ${root}`); continue }

  const message = `Publish mod from ${sha.slice(0, 7)}`
  const commit = line(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message], { env: { ...process.env, ...AUTHOR } })
  // With a remote, no local branch is written at all: the push updates the tracking ref this run
  // reads, and moving refs/heads would rewrite a branch the author may have checked out.
  if (remote) git(['push', '-q', remote, `${commit}:refs/heads/${target}`])
  else git(['update-ref', `refs/heads/${target}`, commit])
  log(`${target}: published ${files.length} files from ${root} as ${commit.slice(0, 7)}${remote ? '' : ' (not pushed, no remote)'}`)
}

function log (message) { process.stdout.write(`${message}\n`) }
function die (message) { process.stderr.write(`pa-mod-build: ${message}\n`); process.exit(1) }
