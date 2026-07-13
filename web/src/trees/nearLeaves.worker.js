// The near leaves (level 0: 211,401 cards, 3.2 MB) are fetched and unpacked here, after the scene is showing
// (TreeSystem.loadNear), so neither the first view's download nor the main thread waits for them.
// Each cell's cards come sorted nearest the reference viewpoint first (lod.js nearestFirst), here and not in the frame
// that first builds the cell (up to 4 ms for the fullest).
// In:  { url, count, grid, size, blocks, from }   Out: { records, cells, order } (typed arrays transferred) or { error }
import { decodeRecords, groupCells, nearestFirst } from './lod.js'
import { download } from '../world/bytes.js'

self.onmessage = async ({ data: { url, count, grid, size, blocks, from } }) => {
  try {
    // (Some hosts send the gzip file with Content-Encoding, and fetch has then unpacked it; others as it is.)
    const records = decodeRecords(await download(url, { label: 'Tree asset' }), count, grid)
    const { cells, order } = groupCells(records, size, blocks)
    for (const cell of cells) nearestFirst(order, cell.start, cell.count, records.position, from)
    const transfer = [order.buffer, ...Object.values(records).filter((v) => ArrayBuffer.isView(v)).map((v) => v.buffer), ...cells.map((c) => c.blocks.buffer)]
    self.postMessage({ records, cells, order }, [...new Set(transfer)])
  } catch (error) { self.postMessage({ error: error.message }) }
}
