import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { FOG, KEEP_OUT, fogVisible, keepOut } from './keepOut.js'

test('keep-out: everything beyond the terrain, and nothing inside it', () => {
  // three.js (x, z) = Blender (x, -y)
  assert.equal(keepOut(0, -12, 1), false)                  // the statue's island
  assert.equal(keepOut(0, 8, .3), false)                   // the south ridge, dressed for the orbit
  assert.equal(keepOut(20, -20, 3), false)                 // the right-bank hill
  assert.equal(keepOut(-20, -20, 1), false)                // the left slope
  assert.equal(keepOut(0, 23.6, 1), false)                 // the terrain's edges are still ground
  assert.equal(keepOut(0, 23.7, 1), true)                  // beyond the south edge: the void
  assert.equal(keepOut(0, 23.7, -1), true)                 // ... wet or not
  assert.equal(keepOut(0, -44.5, 1), true)                 // beyond the north edge
  assert.equal(keepOut(34.01, -20, 1), true)
})

test('the terrain box is the scene\'s', () => {
  const meta = JSON.parse(readFileSync(new URL('../../public/data/scene_meta.json', import.meta.url)))
  const { x0, x1, y0, y1 } = KEEP_OUT.terrain
  assert.deepEqual([x0, x1, y0, y1], meta.terrain.bounds_blender_xy)
})

test('the fog\'s visible share follows CinematicLights.jsx', () => {
  // The numbers here must still be the ones in the scene's fog.
  const source = readFileSync(new URL('./CinematicLights.jsx', import.meta.url), 'utf8').replace(/\s/g, '')
  assert.ok(source.includes(`distance=ray.length().sub(${FOG.clear}).max(0)`), 'clear distance')
  assert.ok(source.includes(`mix(${String(FOG.low).replace(/^0/, '')},${String(FOG.high).replace(/^0/, '')},smoothstep(0,${FOG.fade},positionWorld.y.add(cameraPosition.y).mul(.5)))`), 'density')
  assert.ok(source.includes(`distance.mul(${String(FOG.rate).replace(/^0/, '')}).pow(2).mul(density).negate().exp().oneMinus()`), 'rate')
  assert.equal(fogVisible(0), 1); assert.equal(fogVisible(10), 1)
  assert.ok(Math.abs(fogVisible(40) - Math.exp(-((30 * .028) ** 2) * .8)) < 1e-12)
  assert.ok(Math.abs(fogVisible(40, 12) - Math.exp(-((30 * .028) ** 2) * .25)) < 1e-12)
  assert.ok(fogVisible(60, 2) < fogVisible(30, 2) && fogVisible(30, 6) > fogVisible(30, 2))
})
