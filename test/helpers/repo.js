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
