import test from 'node:test'
import assert from 'node:assert/strict'
import { lateMode } from './lateTextures.js'

test('?late: 0 loads the desktop files at once, hold keeps the twins, anything else upgrades after the reveal', () => {
  assert.equal(lateMode(''), 'on')
  assert.equal(lateMode('?fixedQuality'), 'on')
  assert.equal(lateMode('?late=0'), 'off')
  assert.equal(lateMode('?fixedQuality&late=hold'), 'hold')
  assert.equal(lateMode('?late=1'), 'on')
})
