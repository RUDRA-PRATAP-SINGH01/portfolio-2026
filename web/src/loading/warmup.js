// True for the few frames drawn behind the loading screen once every asset is in (SceneReady.jsx).
// Systems that normally hide part of themselves (tree detail levels by distance) show all of it while this
// is set, so the renderer builds every shader and pipeline before the scene is revealed.
// done: the warm-up has finished (the sharpness test in AdaptiveQuality.jsx starts then).
// drawn: how many frames Post.jsx has drawn so far. Behind the loading screen it does not draw one in every frame
// callback (it waits for the graphics chip), so the warm-up counts its frames with this.
export const warmup = { active: false, done: false, drawn: 0 }
