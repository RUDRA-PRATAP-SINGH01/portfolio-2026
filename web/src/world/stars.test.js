import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three/webgpu'
import { BANDS, decodeStars, drawPlan, groupStars, visibleRuns } from './stars.js'

// pack_sky.py's byte planes for stars given as { u, elevation (degrees), light, tint }.
function planes(stars) {
  const n = stars.length, bytes = new Uint8Array(n * 6)
  stars.forEach(({ u, elevation, light = 0, tint = 0 }, i) => {
    const U = Math.round(u * 65536) % 65536, E = Math.round(elevation / 90 * 65535)
    bytes[i] = U & 255; bytes[n + i] = U >> 8; bytes[2 * n + i] = E & 255; bytes[3 * n + i] = E >> 8; bytes[4 * n + i] = light; bytes[5 * n + i] = tint
  })
  return bytes
}

test('a star lands where three.js equirectUV reads its texel', () => {
  const { u, data } = decodeStars(planes([{ u: .25, elevation: 0 }, { u: .5, elevation: 30, light: 7, tint: 200 }, { u: .75, elevation: 60 }]), 3)
  const direction = i => new THREE.Vector3(data[i * 4], data[i * 4 + 1], data[i * 4 + 2])
  for (let i = 0; i < 3; i++) {
    const d = direction(i)
    assert.ok(Math.abs(d.length() - 1) < 1e-6)
    // equirectUV: u = atan2(z, x) / 2pi + .5, v = asin(y) / pi + .5
    assert.ok(Math.abs(Math.atan2(d.z, d.x) / (2 * Math.PI) + .5 - u[i]) < 1e-6, `u of star ${i}`)
  }
  assert.ok(direction(0).distanceTo(new THREE.Vector3(0, 0, -1)) < 1e-6)
  assert.ok(Math.abs(Math.asin(direction(1).y) * 180 / Math.PI - 30) < 1e-3)
  assert.equal(data[7], 7 * 256 + 200)
})

// Stars over the upper sky, sorted by azimuth as pack_sky.py stores them.
function sky(n = 20000, seed = 7) {
  let s = seed; const random = () => (s = (s * 16807) % 2147483647) / 2147483647
  const stars = Array.from({ length: n }, () => ({ u: random(), elevation: Math.asin(random()) * 180 / Math.PI }))
    .map(star => ({ ...star, u: Math.round(star.u * 65536) % 65536 / 65536 })).sort((a, b) => a.u - b.u)
  return decodeStars(planes(stars), n)
}

function camera(yawDeg, pitchDeg, aspect = 16 / 9, rollDeg = 0) {
  const c = new THREE.PerspectiveCamera(44.37, aspect, .05, 400)
  c.rotation.set(pitchDeg * Math.PI / 180, yawDeg * Math.PI / 180, rollDeg * Math.PI / 180, 'YXZ')
  c.updateMatrixWorld(); c.updateProjectionMatrix()
  return c
}

// The stars one draw shows (drawPlan), as indices into decodeStars' list.
function drawnStars(u, data, camera) {
  const { order, bands } = groupStars(u, data), { plan, drawn } = drawPlan(bands, visibleRuns(bands, camera)), shown = new Set()
  for (let copy = 0; copy < drawn; copy++) {
    const row = plan.findLast(r => r[0] <= copy)                       // as the vertex stage picks it
    shown.add(order[row[1] + (row[3] + copy - row[0]) % row[2]])
  }
  return { shown, drawn }
}

test('one draw holds every star in the frame, and not many more', () => {
  const { u, data } = sky(), n = u.length, p = new THREE.Vector3()
  for (const [yaw, pitch, aspect, roll] of [[0, 4, 16 / 9, 0], [37, 22, 16 / 9, 2], [-90, 10, 16 / 9, 0], [180, 15, 21 / 9, -3], [123, 30, .46, 0], [271, 45, 1, 0], [10, -12, 16 / 9, 0]]) {
    const c = camera(yaw, pitch, aspect, roll), { shown, drawn } = drawnStars(u, data, c)
    let seen = 0
    for (let i = 0; i < n; i++) {
      p.set(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]).transformDirection(c.matrixWorldInverse)
      if (p.z >= 0) continue
      p.applyMatrix4(c.projectionMatrix)
      if (Math.abs(p.x) > 1.02 || Math.abs(p.y) > 1.02) continue          // a star's square reaches 2% past the frame
      seen++
      assert.ok(shown.has(i), `star ${i} in the frame but not drawn (yaw ${yaw}, pitch ${pitch})`)
    }
    assert.ok(seen > 0)
    assert.ok(drawn === shown.size, 'no star drawn twice')
    assert.ok(drawn < seen * 2 + 200, `yaw ${yaw}, pitch ${pitch}: ${drawn} drawn for ${seen} in the frame`)
  }
})

test('runs wrap past the end of a band, and the zenith in the frame draws them all', () => {
  const { u, data } = sky(), { bands } = groupStars(u, data)
  const behind = visibleRuns(bands, camera(90, 5))                    // heading -x: u near 0 and 1
  assert.ok(behind.some((run, b) => run.count && run.start + run.count > bands[b].u.length))
  assert.deepEqual(visibleRuns(bands, camera(0, 80)), bands.map(band => ({ start: 0, count: band.u.length })))
})

test('stars are grouped by elevation band, each band by azimuth', () => {
  const { u, data } = sky(), { order, bands } = groupStars(u, data)
  assert.equal(new Set(order).size, u.length)
  bands.forEach((band, b) => {
    for (let k = 0; k < band.u.length; k++) {
      const i = order[band.first + k], elevation = Math.asin(data[i * 4 + 1]) * 180 / Math.PI
      assert.ok(elevation >= BANDS[b] - 1e-9 && elevation < BANDS[b + 1], `star ${i} in band ${b}`)
      if (k) assert.ok(band.u[k] >= band.u[k - 1])
    }
  })
})
