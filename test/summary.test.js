// test/summary.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderSummary } from '../src/summary.js'

const report = (overrides = {}) => ({
  configPath: '.modbuild',
  dryRun: false,
  source: { ref: 'HEAD', sha: 'a'.repeat(40), branch: 'main' },
  remote: 'origin',
  mods: [modReport()],
  ...overrides
})

const modReport = (overrides = {}) => ({
  root: 'Mod',
  target: 'published-mod',
  included: [{ path: 'modinfo.json', bytes: 120 }, { path: 'ui/a.js', bytes: 2048 }],
  excluded: [{ path: 'pachat.zip', rule: 'pachat.zip' }],
  fileCount: 2,
  totalBytes: 2168,
  warnings: [],
  unchanged: false,
  created: true,
  commit: 'b'.repeat(40),
  pushed: true,
  ...overrides
})

test('a successful publish names source, target and commit', () => {
  const output = renderSummary(report())
  assert.match(output, /main/)
  assert.match(output, /a{7}/)
  assert.match(output, /published-mod/)
  assert.match(output, /b{7}/)
})

test('the payload count and total size are reported in human units', () => {
  const output = renderSummary(report())
  assert.match(output, /2 files/)
  assert.match(output, /2\.2 kB/) // 120 + 2048 bytes, rounded to one decimal
})

test('excluded paths are listed with the rule that matched', () => {
  const output = renderSummary(report())
  assert.match(output, /pachat\.zip/)
  assert.match(output, /`pachat\.zip`/)
})

test('an unchanged mod says so and shows no commit', () => {
  const output = renderSummary(report({ mods: [modReport({ unchanged: true, commit: null, pushed: false })] }))
  assert.match(output, /no changes — nothing to publish/)
  assert.doesNotMatch(output, /b{7}/)
})

test('a dry run is labelled and states that nothing was written', () => {
  const output = renderSummary(report({ dryRun: true, mods: [modReport({ commit: null, pushed: false })] }))
  assert.match(output, /dry run/i)
  assert.match(output, /would/i)
})

test('warnings are rendered prominently', () => {
  const output = renderSummary(report({ mods: [modReport({ warnings: ['No modinfo.json at the payload root.'] })] }))
  assert.match(output, /No modinfo\.json at the payload root\./)
  assert.match(output, /⚠|Warning/)
})

test('several mods each get their own section', () => {
  const output = renderSummary(report({
    mods: [
      modReport({ root: 'mods/a', target: 'published-a' }),
      modReport({ root: 'mods/b', target: 'published-b' })
    ]
  }))
  assert.match(output, /published-a/)
  assert.match(output, /published-b/)
  assert.equal(output.match(/^### /gm).length, 2)
})

test('a run with no remote says nothing was pushed', () => {
  const output = renderSummary(report({ remote: null, mods: [modReport({ pushed: false })] }))
  assert.match(output, /not pushed|no remote/i)
})

test('an unreachable remote is called out at the top of the report', () => {
  const output = renderSummary(report({
    remoteUnreachable: true,
    mods: [modReport({ pushed: false })]
  }))
  assert.match(output, /could not be reached/i)
  assert.match(output, /origin/)
  assert.match(output, /local branches/i)
})

test('a report with a reachable remote says nothing about reachability', () => {
  assert.doesNotMatch(renderSummary(report()), /could not be reached/i)
})

test('a mod with no exclusions omits the exclusions section', () => {
  const output = renderSummary(report({ mods: [modReport({ excluded: [] })] }))
  assert.equal(/Excluded/.test(output), false)
})

test('rendering is deterministic', () => {
  assert.equal(renderSummary(report()), renderSummary(report()))
})

test('excluded files are explained with a framing sentence, not just a table', () => {
  const output = renderSummary(report())
  assert.match(output, /matched an ignore rule in `\.modbuild` and were not published/)
})

// The unit must escalate whenever the *displayed* (rounded) value would reach 1000, not just the
// raw value — toFixed(1) can round e.g. 999999 bytes up to "1000.0" without the unit escalating,
// which would print "1000.0 kB" instead of "1.0 MB". These pin the exact rendered string at and
// around that boundary, in each unit.
for (const [bytes, expected] of [
  [999, '999 B'],
  [1000, '1.0 kB'],
  [999949, '999.9 kB'],
  [999950, '1.0 MB'],
  [999999, '1.0 MB'],
  [1000000, '1.0 MB'],
  [2500000000, '2.5 GB']
]) {
  test(`formats ${bytes} bytes as ${expected}`, () => {
    const output = renderSummary(report({ mods: [modReport({ totalBytes: bytes })] }))
    assert.match(output, new RegExp(expected.replace('.', '\\.')))
  })
}
