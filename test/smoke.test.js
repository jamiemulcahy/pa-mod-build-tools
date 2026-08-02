import test from 'node:test'
import assert from 'node:assert/strict'
import ignore from 'ignore'

test('the ignore dependency loads and applies a pattern', () => {
  assert.equal(ignore().add(['*.psd']).ignores('Logo.psd'), true)
  assert.equal(ignore().add(['*.psd']).ignores('Logo.jpg'), false)
})
