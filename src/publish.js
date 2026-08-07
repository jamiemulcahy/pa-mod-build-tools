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

// Published commits are attributed to the tool rather than to whoever ran it. A run then needs
// no git identity configured — a CI runner has not got one — and a later run can tell a branch
// it wrote itself from one holding somebody's real work.
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

const raw = JSON.parse(readFileSync('.modbuild', 'utf8'))
const mods = (raw.mods ?? [raw]).map((mod) => ({ root: '.', ignore: [], target: 'published-mod', ...mod }))
const sha = line(['rev-parse', 'HEAD^{commit}'])
const remote = line(['remote']).split('\n').includes('origin') ? 'origin' : null

for (const { root, ignore: patterns, target } of mods) {
  // Prefer what is actually on the remote, so a stale local branch cannot cause a bad publish.
  if (remote) attempt(['fetch', '--no-tags', '-q', remote, `+refs/heads/${target}:refs/remotes/${remote}/${target}`])
  const parent = attempt(['rev-parse', '--verify', '-q', `refs/remotes/${remote}/${target}`]) ??
    attempt(['rev-parse', '--verify', '-q', `refs/heads/${target}`])

  // Refuse any branch this tool did not write. A "target" naming a branch that holds real work
  // is the one mistake here that destroys something: the payload commits cleanly on top of it
  // and pushes as an ordinary fast-forward, so nothing else would stop it.
  if (parent && attempt(['log', '-1', '--format=%ae', parent]) !== EMAIL) {
    die(`"${target}" was not published by pa-mod-build — refusing to overwrite it`)
  }

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
  // Pushed before the local ref moves: a local branch left pointing at a payload that never
  // reached the remote would make the next run report "unchanged" and exit 0 with nothing there.
  if (remote) git(['push', '-q', remote, `${commit}:refs/heads/${target}`])
  git(['update-ref', `refs/heads/${target}`, commit])
  log(`${target}: published ${files.length} files from ${root} as ${commit.slice(0, 7)}${remote ? '' : ' (not pushed, no remote)'}`)
}

function log (message) { process.stdout.write(`${message}\n`) }
function die (message) { process.stderr.write(`pa-mod-build: ${message}\n`); process.exit(1) }
