// src/publish.js
import path from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
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
  // Both branches that must never be published onto, resolved before anything is written.
  // `git update-ref` moves a branch even when it is the one HEAD points at — unlike
  // `git branch -f`, it does not refuse — and the working tree is left holding the old branch's
  // files, so every source file shows up as added or renamed and `git reset --hard` would
  // delete the author's work.
  const checkedOutBranch = await git.currentBranch()
  const sourceBranch = source === 'HEAD' ? checkedOutBranch : await git.refBranchName(source)

  for (const mod of mods) {
    if (sourceBranch !== null && mod.target === sourceBranch) {
      throw new PublishError(
        `The mod rooted at "${mod.root}" publishes to "${mod.target}", which is the branch being ` +
        'built from. Publishing onto the source branch would overwrite your work. Change ' +
        `"target" in ${configPath}, or build from a different branch with --source.`
      )
    }
    if (checkedOutBranch !== null && mod.target === checkedOutBranch) {
      throw new PublishError(
        `The mod rooted at "${mod.root}" publishes to "${mod.target}", which is the branch you ` +
        'currently have checked out. Publishing onto it would replace the branch under your ' +
        'working tree and make every file in it look changed. Check out a different branch ' +
        `first, or change "target" in ${configPath}.`
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
  // Compared against the string rather than tested for truthiness: Actions sets this to "true",
  // and a literal "false" elsewhere must not select the bot identity.
  const identity = env.GITHUB_ACTIONS === 'true' ? ACTIONS_IDENTITY : null

  // Whether this run will actually push decides how a failed fetch is treated below.
  const willPush = push && remote !== null && !dryRun

  const report = {
    configPath,
    dryRun,
    source: { ref: source, sha: sourceSha, branch: sourceBranch },
    remote,
    remoteUnreachable: false,
    mods: []
  }

  // Phase 1 (local) and phase 2 (push) are kept separate, and both run inside this try so that
  // whatever has already landed in `report` is attached to any error that escapes either phase.
  // Phase 2 is what confines *push* failures: a failure pushing mod B would otherwise discard the
  // report and strand the caller with no way to know mod A already reached the remote. Phase 1
  // can still fail on its own — it fetches the target branch, and it moves local refs — and the
  // partial report is attached either way.
  try {
    for (const { mod, payload } of resolved) {
      const modReport = await commitMod({
        git, mod, payload, sizes, sourceSha, remote, identity, dryRun, willPush
      })
      if (modReport.remoteUnreachable) report.remoteUnreachable = true
      report.mods.push(modReport)
    }

    if (willPush) {
      for (const modReport of report.mods) {
        // Push when the remote does not already hold what the branch now points at. Keying this
        // off `commit` instead would strand a branch that exists only locally — created by an
        // earlier --no-push run, or by a run whose push failed — because every later run finds
        // the tree unchanged, makes no commit, and would skip it forever while the remote has
        // nothing. PA would then be pointed at a branch that does not exist.
        if (modReport.head === null || modReport.head === modReport.remoteTip) continue
        await git.push(remote, modReport.head, modReport.target)
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
async function commitMod ({ git, mod, payload, sizes, sourceSha, remote, identity, dryRun, willPush }) {
  // A payload entry with no blob size is a gitlink — a submodule, recorded as a commit sha this
  // repository does not contain. It carries no bytes of its own, so 0 is the honest figure rather
  // than a swallowed lookup failure.
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
    // Where the target branch ends up locally, and what the remote already holds. Pushing is
    // decided by comparing the two — never by whether this run happened to create a commit.
    head: null,
    remoteTip: null,
    pushed: false,
    remoteUnreachable: false
  }

  const { tip, remoteTip, remoteUnreachable } = await resolveTarget(git, mod.target, remote, !willPush)
  result.remoteUnreachable = remoteUnreachable
  result.remoteTip = remoteTip
  result.created = tip === null

  // Deliberately in the OS temp directory, not inside .git: in a git worktree ".git" is a file,
  // not a directory, and writing into it would fail.
  //
  // A fresh mkdtemp directory per call rather than a name derived from the pid and the target.
  // `git update-index --index-info` *adds to* whatever index it is given, so a leftover index
  // from a run that was killed before its cleanup ran would be silently unioned with this
  // payload — publishing files that were never meant to ship, which is the one failure this
  // tool exists to prevent. mkdtemp makes the collision impossible rather than merely unlikely,
  // and removes the predictable name in a shared directory along with it.
  const indexDir = await mkdtemp(path.join(tmpdir(), 'pamb-index-'))
  let tree
  try {
    tree = await git.buildTree(payload.included, path.join(indexDir, 'index'))
  } finally {
    await rm(indexDir, { recursive: true, force: true })
  }

  if (tip !== null && (await git.treeOf(tip)) === tree) {
    result.unchanged = true
    // No new commit is needed, but the branch may still be ahead of the remote — it exists only
    // locally, or an earlier run committed it and never got as far as pushing. Recording where it
    // points lets the push phase notice that and put it right.
    result.head = tip
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
  result.head = commit
  return result
}

// origin is preferred so a local run and an Actions run commit on top of the same thing, and a
// stale local branch cannot cause a bad publish.
//
// Whether an unreachable remote is fatal depends on what the run is going to do with the answer.
// A run that will push must not build on a stale base and then publish it, so the fetch failure
// stays fatal there. A run that will not push — --no-push or --dry-run, the modes someone reaches
// for on a train or behind a flaky VPN — falls back to the local branch and says so in the
// report, because failing outright would make the offline modes useless for the one thing they
// are for.
async function resolveTarget (git, target, remote, toleratesFetchFailure) {
  let remoteUnreachable = false
  let remoteTip = null

  if (remote !== null) {
    try {
      if (await git.fetchBranch(remote, target)) {
        remoteTip = await git.revParse(`refs/remotes/${remote}/${target}`)
      }
    } catch (cause) {
      if (!toleratesFetchFailure) throw cause
      remoteUnreachable = true
    }
  }

  if (remoteTip !== null) return { tip: remoteTip, remoteTip, remoteUnreachable }

  if (await git.refExists(`refs/heads/${target}`)) {
    return { tip: await git.revParse(`refs/heads/${target}`), remoteTip, remoteUnreachable }
  }
  return { tip: null, remoteTip, remoteUnreachable }
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
