import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  parseConfig, ConfigError, DEFAULT_ROOT, DEFAULT_TARGET, TOP_LEVEL_KEYS, MOD_KEYS
} from '../src/config.js'

const schema = JSON.parse(await readFile(new URL('../schema/modbuild.schema.json', import.meta.url), 'utf8'))

const singleForm = schema.oneOf[0]
const multiForm = schema.oneOf[1]

test('the schema declares both accepted shapes', () => {
  assert.equal(schema.oneOf.length, 2)
  assert.equal(singleForm.properties.root.default, DEFAULT_ROOT)
  assert.equal(singleForm.properties.target.default, DEFAULT_TARGET)
  assert.equal(multiForm.required.includes('mods'), true)
  assert.equal(multiForm.properties.mods.minItems, 1)
})

test('both forms forbid unknown keys, matching config.js', () => {
  assert.equal(singleForm.additionalProperties, false)
  assert.equal(multiForm.additionalProperties, false)
  assert.equal(multiForm.properties.mods.items.additionalProperties, false)
})

test('the keys the schema allows are exactly the keys config.js accepts', () => {
  const accepts = (object) => {
    try {
      parseConfig(JSON.stringify(object), '.modbuild')
      return true
    } catch (error) {
      assert.ok(error instanceof ConfigError)
      return false
    }
  }

  for (const key of Object.keys(singleForm.properties)) {
    assert.equal(accepts({ [key]: sampleFor(key) }), true, `config.js rejects top-level "${key}"`)
  }
  for (const key of Object.keys(multiForm.properties.mods.items.properties)) {
    assert.equal(accepts({ mods: [{ [key]: sampleFor(key) }] }), true, `config.js rejects mods[].${key}`)
  }

  // And nothing beyond them. "$schema" is top level only.
  assert.equal(accepts({ nonsense: 1 }), false)
  assert.equal(accepts({ mods: [{ $schema: 'x' }] }), false)
})

// The behavioural test above only walks the schema's keys and checks config.js takes them, so it
// catches the schema permitting something config.js rejects. It is blind the other way round: a
// key added to config.js and forgotten in the schema accepts every config anyone writes and shows
// up only as a missing editor completion. Comparing the two declared key lists as sets closes
// that side, and reads as one statement — these are the same set of keys — rather than two.
test('the schema declares exactly the keys config.js declares, in both directions', () => {
  const schemaTopLevel = [
    ...new Set([...Object.keys(singleForm.properties), ...Object.keys(multiForm.properties)])
  ]
  assert.deepEqual(schemaTopLevel.sort(), [...TOP_LEVEL_KEYS].sort())
  assert.deepEqual(
    Object.keys(multiForm.properties.mods.items.properties).sort(),
    [...MOD_KEYS].sort()
  )
})

function sampleFor (key) {
  if (key === 'ignore') return ['*.psd']
  return key === 'mods' ? [{ root: 'a' }] : 'a'
}
