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

  // Phase 1 (local) and phase 2 (push) are kept separate, and both run inside this try so that
  // whatever has already landed in `report` is attached to any error that escapes either phase.
  // Local ref writes are effectively incapable of failing once validation has passed above, so in
  // practice this confines the realistic failure surface — a flaky network, an auth failure, a
  // remote that disappears mid-run — to the push phase. Without this, a failure pushing mod B
  // would discard the report and silently strand the caller with no way to know mod A already
  // reached the remote.
  try {
    for (const { mod, payload } of resolved) {
      report.mods.push(await commitMod({ git, mod, payload, sizes, sourceSha, remote, identity, dryRun }))
    }

    if (push && remote !== null && !dryRun) {
      for (const modReport of report.mods) {
        if (modReport.commit === null) continue
        await git.push(remote, modReport.commit, modReport.target)
        modReport.pushed = true
      }
    }
  } catch (cause) {
    cause.report = report
    throw cause
  }

  return report
}

// Builds the tree and, when there is a change, creates the commit and moves the local branch ref.
// Pushing is deliberately not this function's job — see the comment in publish() above.
async function commitMod ({ git, mod, payload, sizes, sourceSha, remote, identity, dryRun }) {
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

// Anchored the same way warningsFor() anchors its "deeper" check below: a file merely ending in
// "modinfo.json" (e.g. "custom_modinfo.json") is not a manifest and must not be suggested as one.
function modinfoDirectories (files) {
  const directories = new Set()
  for (const file of files) {
    if (file.path !== 'modinfo.json' && !file.path.endsWith('/modinfo.json')) continue
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
