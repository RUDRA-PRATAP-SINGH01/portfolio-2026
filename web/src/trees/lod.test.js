import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { lodWeights, decodeRecords, groupCells, RECORD_BYTES } from './lod.js'

test('LOD weights are bounded, complementary and continuous across both transitions', () => {
  let previous = lodWeights(0, 3, 18)
  for (let d = 0; d < 40; d += .01) {
    const w = lodWeights(d, 3, 18)
    assert.ok(w.every((v) => v >= 0 && v <= 1))
    assert.ok(Math.abs(w.reduce((a, b) => a + b) - 1) < 1e-10)
    assert.ok(w.every((v, i) => Math.abs(v - previous[i]) < .03))
    previous = w
  }
})

test('exported records have valid rotations, dimensions and matching level budgets', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../public/foliage/trees.json', import.meta.url)))
  const levels = []
  for (const level of manifest.levels) {
    const b = gunzipSync(readFileSync(new URL('../../public/' + level.file, import.meta.url)))
    const records = decodeRecords(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), level.count, manifest.grid)
    assert.equal(records.count, level.count)
    for (let i = 0; i < records.count; i++) {
      assert.ok(Math.abs(Math.hypot(...records.turn.subarray(i * 4, i * 4 + 4)) / 32767 - 1) < .001)
      assert.ok(records.scale[i] > 0 && records.scale[i] < 30)
      assert.ok(records.glow[i] >= 0 && records.glow[i] <= 1)
    }
    // Light reaching the leaves through the canopy: some stand in the open, most are shaded.
    const lit = records.moon.reduce((sum, v) => sum + v, 0) / 255 / records.count
    assert.ok(lit > .05 && lit < .6)
    levels.push(records)
  }
  // Near leaves change level together with a mid spray: same cell, species and phase.
  const cell = manifest.cluster_cell, key = (r, i) => [0, 1, 2].map((axis) => Math.floor(r.position[i * 3 + axis] / cell)).join(',') + ',' + r.species[i] + ',' + r.phase[i]
  const sprays = new Set(Array.from({ length: levels[1].count }, (_, i) => key(levels[1], i)))
  let alone = 0
  for (let i = 0; i < levels[0].count; i++) if (!sprays.has(key(levels[0], i))) alone++
  assert.equal(alone, 0)                              // the position grid keeps every card clear of the cell walls
  assert.ok(manifest.levels[2].count < manifest.levels[1].count)
  assert.ok(manifest.levels[1].count < manifest.levels[0].count)
})

test('cells hold every card exactly once, in boxes, reach and blocks that fit their cards', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../public/foliage/trees.json', import.meta.url))), level = manifest.levels[1]
  const b = gunzipSync(readFileSync(new URL('../../public/' + level.file, import.meta.url)))
  const records = decodeRecords(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), level.count, manifest.grid)
  for (const blocks of [1, 4, 8]) {
    const { cells, order } = groupCells(records, 3, blocks), seen = new Uint8Array(records.count)
    let next = 0
    for (const c of cells) {
      assert.equal(c.start, next); next += c.count
      for (let k = c.start; k < c.start + c.count; k++) {
        const i = order[k], [x, y, z] = records.position.subarray(i * 3, i * 3 + 3)
        seen[i]++
        assert.equal(records.species[i], c.species)
        assert.ok(x >= c.box[0] && y >= c.box[1] && z >= c.box[2] && x <= c.box[3] && y <= c.box[4] && z <= c.box[5])
        assert.ok(records.scale[i] <= c.reach)
        const centre = [x, y, z].map((v) => (Math.floor(v / 3) + .5) * 3)
        let found = false
        for (let at = 0; at < c.blocks.length && !found; at += 3) found = centre.every((v, axis) => Math.abs(c.blocks[at + axis] - v) < 1e-4)
        assert.ok(found)                                  // the shader measures each card to its block's centre
      }
    }
    assert.equal(next, records.count)
    assert.ok(seen.every((v) => v === 1))
  }
})

test('truncated or corrupt buffers fail before creating GPU resources', () => {
  const grid = { origin: [0, 0, 0], step: .001 }
  assert.throws(() => decodeRecords(new ArrayBuffer(RECORD_BYTES - 1), 1, grid), /length/)
  assert.throws(() => decodeRecords(new ArrayBuffer(RECORD_BYTES), 1, grid), /Invalid/)
  const bad = new DataView(new ArrayBuffer(RECORD_BYTES)); bad.setUint16(14, 0x3c00, true); bad.setUint16(18, 0x7c00, true)   // scale 1, glow infinite
  assert.throws(() => decodeRecords(bad.buffer, 1, grid), /Invalid/)
})
