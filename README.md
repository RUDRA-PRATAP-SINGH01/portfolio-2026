# Portfolio 2026 — Moai Forest

A 3D portfolio by **Rudra Pratap Singh**: a stone Moai head on a small island in a dark forest lake, explored by a scroll-driven camera that circles the scene.

Built to run smoothly on everyday hardware (Intel integrated graphics and phones) without losing the look.

## What's inside

| Folder        | Contents |
|---------------|----------|
| `web/src/`    | The website — Vite + Three.js (WebGPU / TSL shaders), React Three Fiber |
| `web/public/` | 3D models, textures, sky and baked lighting |

## Features

- Low-poly scene with baked lighting and detailed textures
- Scroll-driven camera path around the island
- Cursor-reactive liquid and parallax effects
- Glass-style name title shader
- Adaptive resolution so weak GPUs hold a steady frame rate

## Run locally

Requires Node.js 26.

```bash
cd web
npm install
npm run dev      # development server
npm run build    # production build in web/dist
npm test         # unit tests
```
