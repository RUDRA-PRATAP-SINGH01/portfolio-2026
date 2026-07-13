import * as THREE from 'three/webgpu'
import { useEffect, useMemo, useRef } from 'react'
import { useThree, useFrame } from '@react-three/fiber'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { previewPose } from './previewPath.js'
import { active, createParallax } from './parallax.js'
import { scroll, setFlightPath } from './scroll.js'
import { OPENING } from './cameraPath.js'
import { holdProgress, outro, stepOutro, stepPage } from '../outro/timeline.js'

// Two ways to move. For visitors the camera rides the path animated in Blender (cameraPath.js), scrubbed by the
// page's own scroll through one ease (scroll.js; flight.js only for "Back to start"). With ?orbit, ?cam= or
// ?cinematicPreview (scripts depend on them): orbit/zoom anywhere, and "reference view" restores the Blender hero
// camera. Never under the ground.
// On top of either, the pointer swing (parallax.js): each frame the path, orbit (or preview) pose is restored,
// updated, kept as the base pose, and the swing (and on the path the handheld drift) is laid over it for this frame.
const query = new URLSearchParams(location.search)
export const ORBIT = ['orbit', 'cam', 'cinematicPreview'].some(flag => query.has(flag))

export function CameraRig({ world, resetSignal }) {
  const { camera, gl } = useThree()
  const controls = useRef()
  const previewTime=useRef(0)
  const params=new URLSearchParams(location.search)
  const preview=import.meta.env.DEV && params.has('cinematicPreview')
  const scrolling = !ORBIT && !!world.cameraPath
  const rig = useMemo(() => ({ parallax: createParallax(), position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), applied: false,
    posed: new THREE.Vector3(), posedTurn: new THREE.Quaternion(), settle: false, opening: null, flying: null, outro: '' }), [])
  const floor = () => Math.max(world.heightAt(camera.position.x, camera.position.z) + 0.15, world.meta.water_level + .12)
  // Back to the base pose (OrbitControls also updates from its own input handlers, between frames). If something
  // else has moved the camera since this rig posed it (a check script, the console), that pose is the new base.
  const unparallax = () => {
    if (!rig.applied) return
    if (camera.position.equals(rig.posed) && camera.quaternion.equals(rig.posedTurn)) { camera.position.copy(rig.position); camera.quaternion.copy(rig.quaternion) }
    rig.applied = false
  }
  const keepBase = () => { rig.position.copy(camera.position); rig.quaternion.copy(camera.quaternion) }
  useEffect(() => {
    // On the path a finger scrolls: every swipe starts with a pointerdown, and the view would lurch to it.
    const move = e => { if (!(scrolling && e.pointerType === 'touch')) rig.parallax.point(e.clientX, e.clientY, innerWidth, innerHeight) }
    const reduced = matchMedia('(prefers-reduced-motion: reduce)')
    const off = new URLSearchParams(location.search).get('parallax') === '0'      // ?parallax=0: comparisons
    const motion = () => { rig.strength = reduced.matches || off ? 0 : 1 }
    motion(); reduced.addEventListener('change', motion)
    active.sway = rig.parallax
    addEventListener('pointermove', move, { passive: true }); addEventListener('pointerdown', move, { passive: true })
    // Checks: the swing at once where it settles for pointer x, y (-1..1, y up), with a chosen roll (radians) and
    // drift ([pitch, yaw] radians; none by default), so a check's frames repeat.
    if (import.meta.env.DEV) window.__sway = {
      snap(x, y, roll = 0, drift = [0, 0]) { rig.parallax.pointer.set(x, y); rig.settle = true; rig.parallax.state.hold = { roll, drift } },
      free() { rig.parallax.state.hold = null },
    }
    return () => { removeEventListener('pointermove', move); removeEventListener('pointerdown', move); reduced.removeEventListener('change', motion) }
  }, [rig, scrolling])
  // Before anything reads the camera this frame (the pointer's ground point is found at priority -3).
  useFrame((_,dt)=>{
    unparallax()
    if (scrolling) setFlightPath(world.cameraPath)
    const place = scrolling ? stepPage(dt) : stepOutro(dt)      // (the camera and the outro as one page, timeline.js)
    // html[data-outro] for the page (outro.css): hold, wipe, covered; none before the outro (the edge of last frame)
    const state = outro.wipe >= .99 ? 'covered' : outro.wipe > 0 ? 'wipe' : outro.eased > 0 ? 'hold' : ''
    if (state !== rig.outro) { rig.outro = state; if (state) document.documentElement.dataset.outro = state; else delete document.documentElement.dataset.outro }
    const orbit = controls.current
    if (scrolling) {
      world.cameraPath.poseAt(place, camera.position, camera.quaternion)
      // main[data-opening] while the camera is on the opening (the name's place, loading.css);
      // main[data-flying] while it moves.
      const opening = scroll.eased <= OPENING, main = gl.domElement.closest('main')
      if (opening !== rig.opening) { rig.opening = opening; main?.toggleAttribute('data-opening', opening) }
      if (scroll.moving !== rig.flying) { rig.flying = scroll.moving; if (main) main.toggleAttribute('data-flying', scroll.moving) }
    } else if(preview && document.querySelector('.experience')?.dataset.phase==='ready'){
      if(orbit)orbit.enabled=false
      const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches
      if(!reduced)previewTime.current+=Math.min(dt,.05)
      const fixed=params.get('previewAt')
      const t=fixed!==null?Math.max(0,Math.min(1,Number(fixed)||0)):(previewTime.current%30)/30
      const pose=previewPose(t,world.meta.camera_reference)
      camera.position.fromArray(pose.position);camera.lookAt(...pose.target)
      if(orbit)orbit.target.fromArray(pose.target)
    } else orbit?.update()
    keepBase()
    // The swing turns round a point at a share of the distance to the view's subject: the orbit's target, or on the
    // path the statue (at most the reference view's 12 m, so far poses do not swing wider than the opening one).
    // The handheld drift only on the path (orbit and ?cam= captures must repeat).
    const distance = scrolling ? Math.min(12, camera.position.distanceTo(world.statue.centre)) : orbit ? camera.position.distanceTo(orbit.target) : 12
    // The swing fades out through the hold, so the head is still where its outline will stay (outro/wipe.js).
    rig.parallax.step(dt, distance, (rig.strength ?? 1) * (1 - holdProgress(outro.eased)), rig.settle, scrolling); rig.settle = false
    rig.parallax.apply(camera)
    camera.position.y = Math.max(camera.position.y, floor())
    camera.updateMatrixWorld()
    rig.posed.copy(camera.position); rig.posedTurn.copy(camera.quaternion)
    rig.applied = true
  }, -5)
  useEffect(() => {
    if (scrolling) return
    previewTime.current=0
    const c = new OrbitControls(camera, gl.domElement)
    c.enableDamping = true; c.dampingFactor = 0.08; c.maxDistance = 60; c.minDistance = 0.4
    c.addEventListener('change', () => { const g = floor(); if (camera.position.y < g) camera.position.y = g })
    const update = c.update.bind(c)
    c.update = (...args) => { unparallax(); const changed = update(...args); keepBase(); return changed }
    controls.current = c
    return () => { c.dispose(); controls.current = null }
  }, [camera, gl, world, scrolling])
  useEffect(() => {
    const orbit = controls.current
    previewTime.current=0
    unparallax()
    // Consume residual damping before placing the reference camera. Otherwise
    // the old drag continues moving the camera immediately after a reset.
    if (orbit) { orbit.enableDamping = false; orbit.update() }
    const ref = world.meta.camera_reference
    camera.position.set(...ref.position)
    camera.fov = ref.vertical_fov_deg; camera.near = 0.05; camera.far = 400; camera.updateProjectionMatrix()
    let target = new THREE.Vector3(...ref.position).add(new THREE.Vector3(...ref.forward).multiplyScalar(12))
    // ?cam=px,py,pz,tx,ty,tz (three.js coords) — used to compare identical viewpoints with Blender renders
    const cam = new URLSearchParams(location.search).get('cam')
    if (cam && resetSignal === 0) {
      const v = cam.split(',').map(Number)
      if (v.length === 6 && v.every(Number.isFinite)) { camera.position.set(v[0], v[1], v[2]); target = new THREE.Vector3(v[3], v[4], v[5]) }
    }
    camera.lookAt(target)
    if (orbit) { orbit.target.copy(target); orbit.update(); orbit.saveState(); orbit.enableDamping = true }
    rig.applied = false                    // this pose is the new base; the parallax goes on top next frame
  }, [camera, world, resetSignal, rig])
  return null
}
