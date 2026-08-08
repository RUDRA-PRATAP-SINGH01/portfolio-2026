import { lerp } from './timeline.js'

// alche.studio's mission-section timing (studied 2026-11-18, rebuilt, nothing copied), driven by the light screen's rise.

const clamp01 = x => Math.min(1, Math.max(0, x))
export const power3Out = x => 1 - (1 - x) ** 4                     // GSAP's names: power3.out is quartic
export const power2Out = x => 1 - (1 - x) ** 3                     // and power2.out cubic

export const lineAmount = (u, i, n) => power3Out(clamp01((u - i / n * .8) / .1))
export const markerAmount = (u, i, n) => power2Out(clamp01((u - i / n * .8 - .03) / .5))

// Gives the value it had (a frame behind, as alche's) and snaps on its target at 1e-4, so the loop can rest.
function follower(m) {
  let current = null
  return (target, seconds) => {
    if (current === null) current = target
    const shown = current
    current = lerp(current, target, seconds, m)
    if (Math.abs(target - current) < 1e-4) current = target
    return shown
  }
}

// u is pulled toward the nearer end, so the lines finish (or undo) by themselves once the screen is past half way.
export function createReveal() {
  const mask = follower(1), q = follower(.4), u = follower(.4)
  return (p, seconds) => {
    const shownMask = mask(p, seconds), shownQ = q(p, seconds), end = Math.round(shownQ)
    const target = end - (end - shownQ) * .7, shownU = u(target, seconds)
    return { mask: shownMask, u: shownU, still: shownMask === p && shownQ === p && shownU === target }
  }
}
