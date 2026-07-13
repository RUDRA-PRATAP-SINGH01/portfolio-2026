import test from 'node:test'
import assert from 'node:assert/strict'
import { PBR_PARTS, legacyParts } from './pbrLegacy.js'

test('?pbrLegacy: bare means every part, a list only the parts named, absent none', () => {
  assert.deepEqual([...legacyParts('?fixedQuality&pbrLegacy')], PBR_PARTS)
  assert.deepEqual([...legacyParts('?pbrLegacy=')], PBR_PARTS)
  assert.deepEqual([...legacyParts('?pbrLegacy=relief,wet')], ['relief', 'wet'])
  assert.deepEqual([...legacyParts('?pbrLegacy=wet,nonsense')], ['wet'])
  assert.equal(legacyParts('?fixedQuality&cullLegacy').size, 0)
})
