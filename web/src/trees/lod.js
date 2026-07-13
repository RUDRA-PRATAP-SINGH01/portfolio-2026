// A level gives way to the next between these multiples of its changeover distance.
export const LOD_BAND = [.9, 1.1]

// Smooth, complementary intervals for the three foliage representations: the share of the cards drawn as
// near leaves, mid sprays and far sprays at a distance (TreeSystem.js evaluates the same in the shader).
export function lodWeights(distance, near, far) {
  const fade = (edge) => {
    const t = Math.max(0, Math.min(1, (distance - edge * LOD_BAND[0]) / (edge * (LOD_BAND[1] - LOD_BAND[0]))))
    return t * t * (3 - 2 * t)
  }
  const n = fade(near), f = fade(far)
  return [1 - n, n * (1 - f), f]
}

export function halfFloat(bits) {
  const sign = bits & 0x8000 ? -1 : 1, exponent = (bits >> 10) & 31, mantissa = bits & 1023
  return exponent === 0 ? sign * 2 ** -14 * mantissa / 1024
    : exponent === 31 ? (mantissa ? NaN : sign * Infinity)
      : sign * 2 ** (exponent - 15) * (1 + mantissa / 1024)
}

// One 22-byte record per leaf or spray (blender/scripts/foliage_pack.py), stored as byte planes: the first
// byte of every record, then the second of every record, and so on. Decoded into one typed array per field:
//   position  x, y, z in metres, from 16-bit steps of a grid: origin + (n + 0.5) * step
//   turn      rotation quaternion, 16-bit signed normalised, as stored
//   scale, glow (0..1)                     variation, moon, sky  bytes, 255 = 1
//   species   0 or 1                       phase  0..127
// moon and sky: the share of moonlight and of sky reaching the leaf through the rest of the canopy.
// phase: where in a cross-fade band the card changes level. A mid spray and the near leaves it stands for
// share it (and lie in the same cell of manifest.cluster_cell metres), so they change at the same moment.
export const RECORD_BYTES = 22

// The cards grouped into cubic cells of `blocks` blocks of `size` metres a side, one cell per species (one draw
// each); plain data, so it also runs in a worker (nearLeaves.worker.js). For every cell: species, the number of its
// cards, where they start in `order` (record numbers, cell after cell), their largest scale (reach), the box
// around their positions [min x, y, z, max x, y, z] and the centres of the blocks they lie in (x, y, z, ...).
export function groupCells(records, size, blocks) {
  const { count, position, species, scale } = records, keys = new Float64Array(count), cells = new Map()
  for (let i = 0; i < count; i++) {
    const x = position[i * 3], y = position[i * 3 + 1], z = position[i * 3 + 2]
    const bx = Math.floor(x / size), by = Math.floor(y / size), bz = Math.floor(z / size)
    const key = keys[i] = ((Math.floor(bx / blocks) + 512) * 1024 + Math.floor(by / blocks) + 512) * 2048
      + (Math.floor(bz / blocks) + 512) * 2 + species[i]
    let cell = cells.get(key)
    if (!cell) cells.set(key, cell = { species: species[i], count: 0, start: 0, reach: 0, box: [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], blocks: new Map() })
    cell.count++; cell.reach = Math.max(cell.reach, scale[i])
    const box = cell.box
    box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.min(box[2], z)
    box[3] = Math.max(box[3], x); box[4] = Math.max(box[4], y); box[5] = Math.max(box[5], z)
    const id = ((bx + 512) * 1024 + by + 512) * 1024 + bz + 512
    if (!cell.blocks.has(id)) cell.blocks.set(id, [(bx + .5) * size, (by + .5) * size, (bz + .5) * size])
  }
  let start = 0
  for (const cell of cells.values()) { cell.start = start; start += cell.count; cell.count = 0; cell.blocks = Float32Array.from([...cell.blocks.values()].flat()) }
  const order = new Uint32Array(count)
  for (let i = 0; i < count; i++) { const cell = cells.get(keys[i]); order[cell.start + cell.count++] = i }
  return { cells: [...cells.values()], order }
}

// A cell's cards (order[start .. start + count)) put in place nearest `from` ([x, y, z]) first, ties in list order.
// Seen from around there a cell is then drawn roughly front to back, and leaf pixels behind other leaves fail the
// depth test instead of being shaded. (Sorted as plain numbers, distance above and place in the list below: much
// faster than with a function.) Plain data: the near leaves are sorted in their worker, off the main thread.
export function nearestFirst(order, start, count, position, from) {
  const members = order.slice(start, start + count), keys = new Float64Array(count)
  for (let k = 0; k < count; k++) {
    const i = members[k], x = position[i * 3] - from[0], y = position[i * 3 + 1] - from[1], z = position[i * 3 + 2] - from[2]
    keys[k] = Math.floor((x * x + y * y + z * z) * 1024) * 2097152 + k
  }
  keys.sort()
  for (let k = 0; k < count; k++) order[start + k] = members[keys[k] % 2097152]
}

export function decodeRecords(buffer, count, grid) {
  if (buffer.byteLength !== count * RECORD_BYTES) throw new Error('Foliage record length does not match its manifest')
  const bytes = new Uint8Array(buffer), plane = (k) => bytes.subarray(k * count, (k + 1) * count)
  const pair = (k) => { const low = plane(k), high = plane(k + 1); return (i) => low[i] | high[i] << 8 }
  const records = { count, position: new Float32Array(count * 3), turn: new Int16Array(count * 4), scale: new Float32Array(count),
    glow: new Float32Array(count), variation: plane(16).slice(), species: new Uint8Array(count), phase: new Uint8Array(count),
    moon: plane(20).slice(), sky: plane(21).slice() }
  for (let axis = 0; axis < 3; axis++) {
    const steps = pair(axis * 2), origin = grid.origin[axis] + grid.step / 2
    for (let i = 0; i < count; i++) records.position[i * 3 + axis] = origin + steps(i) * grid.step
  }
  for (let c = 0; c < 4; c++) { const part = pair(6 + c * 2); for (let i = 0; i < count; i++) records.turn[i * 4 + c] = part(i) }   // wraps to signed
  const scale = pair(14), glow = pair(18), kind = plane(17)
  for (let i = 0; i < count; i++) {
    const s = records.scale[i] = halfFloat(scale(i)), g = records.glow[i] = halfFloat(glow(i))
    if (!(s > 0 && s < Infinity && g >= 0 && g <= 1)) throw new Error('Invalid foliage record')
    records.species[i] = kind[i] & 1; records.phase[i] = kind[i] >> 1
  }
  return records
}
