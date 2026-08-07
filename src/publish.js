#!/usr/bin/env node
// Publishes a clean copy of a Planetary Annihilation mod to its own branch.
//
// Works entirely in git's object database — no working tree is touched, so this is safe to
// run over a repository you are in the middle of editing.
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ignore from 'ignore'

// Published commits are generated output, so they are attributed to the tool rather than to
// whoever happened to run it. This also means a run needs no git identity configured, which a
// CI runner generally has not got.
const IDENTITY = { NAME: 'pa-mod-build', EMAIL: 'pa-mod-build@users.noreply.github.com' }

const git = (args, opts) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28, ...opts })
const line = (args, opts) => git(args, opts).trim()
// For commands whose failure is a legitimate answer: no such branch yet, or a detached HEAD.
const attempt = (args, opts) => { try { return line(args, { stdio: 'pipe', ...opts }) } catch { return null } }

const argv = process.argv.slice(2)
const flag = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback)
if (argv[0] !== 'publish') die('usage: pa-mod-build publish [--source <ref>] [--config <path>] [--dry-run]')

const dryRun = argv.includes('--dry-run')
const config = JSON.parse(readFileSync(flag('--config', '.modbuild'), 'utf8'))
const sha = line(['rev-parse', `${flag('--source', 'HEAD')}^{commit}`])
const branch = attempt(['symbolic-ref', '--short', 'HEAD'])
const remote = line(['remote']).split('\n').includes('origin') ? 'origin' : null

for (const mod of config.mods ?? [config]) {
  const { root = '.', ignore: patterns = [], target = 'published-mod' } = mod
  // The one guard worth keeping: every other mistake here costs a bad branch, this one costs
  // the author's work.
  if (target === branch) die(`"${target}" is the branch you are on — publishing to it would overwrite your work`)

  const prefix = root === '.' ? '' : `${root}/`
  const ig = ignore().add(patterns)
  const files = git(['ls-tree', '-r', '-z', sha]).split('\0').filter(Boolean)
    .map((row) => [row.slice(0, row.indexOf('\t')).split(' '), row.slice(row.indexOf('\t') + 1)])
    .filter(([, path]) => path.startsWith(prefix))
    .map(([[mode, , blob], path]) => ({ mode, blob, path: path.slice(prefix.length) }))
    .filter(({ path }) => !ig.ignores(path))
  if (!files.length) die(`nothing to publish from "${root}"`)

  // Prefer what is actually on the remote, so a stale local branch cannot cause a bad publish.
  if (remote) attempt(['fetch', '--no-tags', '-q', remote, `+refs/heads/${target}:refs/remotes/${remote}/${target}`])
  const parent = attempt(['rev-parse', '--verify', '-q', `refs/remotes/${remote}/${target}`]) ??
    attempt(['rev-parse', '--verify', '-q', `refs/heads/${target}`])

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
      GIT_AUTHOR_NAME: IDENTITY.NAME,
      GIT_AUTHOR_EMAIL: IDENTITY.EMAIL,
      GIT_COMMITTER_NAME: IDENTITY.NAME,
      GIT_COMMITTER_EMAIL: IDENTITY.EMAIL
    }
  })
  git(['update-ref', `refs/heads/${target}`, commit])
  if (remote) git(['push', '-q', remote, `${commit}:refs/heads/${target}`])
  log(`${target}: published ${files.length} files from ${root} as ${commit.slice(0, 7)}${remote ? '' : ' (not pushed, no remote)'}`)
}

function log (message) { process.stdout.write(`${message}\n`) }
function die (message) { process.stderr.write(`pa-mod-build: ${message}\n`); process.exit(1) }
