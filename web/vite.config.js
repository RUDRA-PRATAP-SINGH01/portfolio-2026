import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Static hosts compress text on the fly but send models and raw data as they are stored. The build stores those
// gzipped, under their own names, wherever that saves at least 3%; the page unpacks them (src/world/bytes.js).
// Measured 2026-11-13: 3.6 MB of models and 3.1 MB of terrain, colour and light data become about 4.1 MB.
const GZIP = /\.(glb|rgba8|rgba16f|u16|f32|bin)$/
function gzipData() {
  let outDir
  const files = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)])
  return {
    name: 'gzip-data', apply: 'build',
    configResolved(config) { outDir = resolve(config.root, config.build.outDir) },
    closeBundle() {
      for (const file of files(outDir).filter(f => GZIP.test(f))) {
        const raw = readFileSync(file), packed = gzipSync(raw, { level: 9 })
        if (packed.length < raw.length * .97) writeFileSync(file, packed)
      }
    },
  }
}

// Every package (R3F, three addons) must share ONE three.js build: the WebGPU one (src/three.js).
export default defineConfig({
  plugins: [react(), gzipData()],
  resolve: { alias: [{ find: /^three$/, replacement: resolve(import.meta.dirname, 'src/three.js') }] },
  server: { port: 5199, strictPort: true },   // 5173 is used by another local project
  build: { target: 'es2022', chunkSizeWarningLimit: 2500 },
})
