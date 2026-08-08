import test from 'node:test'
import assert from 'node:assert/strict'
import { NAME, nameGate } from './glassName.js'

const near = (a, b, label) => assert.ok(Math.abs(a - b) < 1e-12, `${label}: ${a} vs ${b}`)

test('the name belongs to the beginning: it fades out past half the path and back in before it, over 0.9 s', () => {
  assert.equal(NAME.gate.until, .5); assert.equal(NAME.gate.seconds, .9)
  near(nameGate(1, .6, .45), .5, 'half way out'); assert.equal(nameGate(1, .6, 1), 0, 'gone at the end and over the outro')
  near(nameGate(0, .1, .45), .5, 'half way back in'); assert.equal(nameGate(.5, 0, 5), 1, 'whole again at the start')
  assert.equal(nameGate(.3, .2, -1), .3, 'no step backwards in time')
})
