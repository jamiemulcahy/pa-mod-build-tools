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
              `git ${args[0]} failed: ${(stderr || error.message).trim()}`,
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
      // --symbolic-full-name combined with --end-of-options makes git echo the flag itself
      // back as an extra leading output line instead of consuming it, so the real answer (if
      // any) is always the last non-empty line. Reading the last line makes this correct
      // whether or not that echo happens, which keeps --end-of-options here for consistency
      // with every other rev-parse call in this file instead of dropping it as a special case.
      const { code, stdout } = await run(
        ['rev-parse', '--symbolic-full-name', '--end-of-options', ref],
        { allowFailure: true }
      )
      if (code !== 0) return null
      const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean)
      const full = lines[lines.length - 1] ?? ''
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

    // Returns false only when the remote genuinely has no such branch (the first-publish
    // case). A real failure to reach the remote (network, auth, misconfigured URL) is left to
    // throw GitError like any other command, rather than being folded into "false" and
    // misread by the caller as "no branch yet, start an orphan".
    async fetchBranch (remote, branch) {
      const { stdout } = await run(['ls-remote', '--heads', remote, branch])
      if (stdout.trim() === '') return false

      // Keep the + refspec so a rewound remote branch still force-updates the local tracking ref.
      await run(['fetch', '--no-tags', '--quiet', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`])
      return true
    },

    async push (remote, sha, branch) {
      await run(['push', remote, `${sha}:refs/heads/${branch}`])
    }
  }
}
