import * as THREE from 'three/webgpu'
import { useEffect, useMemo } from 'react'
import { cameraPosition, clamp, dot, exp, float, floor, fract, hash, length, max, mix, mod, mx_noise_float, normalize,
  positionLocal, positionWorld, pow, reflect, reflector, sin, smoothstep, texture, uniform, varying, vec2, vec3 } from 'three/tsl'
import { waveHeight, waveSlope, motionTime, reflectionPass } from './animation.js'
import { adaptive } from './AdaptiveQuality.jsx'
import { SLOW, drawing, resolution } from './resolution.js'
import { fieldLight } from './cinematic.js'
import { skyRadiance } from './sky.js'
import { steady } from './parallax.js'

const UP = vec3(0, 1, 0)

// Water surface slope (dh/dx, dh/dz) from five layers: the shared swell that also moves the floating plants
// (animation.js, unchanged), three drifting ripple maps at different scales and sparse expanding rings.
function surfaceSlope(world, p, distance) {
  const t = motionTime, maps = world.water
  // Calm, glassy patches beside ruffled ones, drifting slowly. The patches are metres wide, so the noise
  // is evaluated per vertex of the half-metre water grid rather than per pixel.
  const ruffle = smoothstep(.32, .74, varying(mx_noise_float(vec3(p.mul(.11), t.mul(.025)))).mul(.5).add(.5))
  const layer = (map, size, drift, speed) => texture(map, p.div(size).add(vec2(...drift).mul(t.mul(speed)))).xy.mul(2).sub(1)
  const fadeShort = smoothstep(26, 9, distance), fadeCapillary = smoothstep(11, 3.5, distance)   // no far sparkle
  let slope = waveSlope(p)
  if (maps) slope = slope
    .add(layer(maps.wind, 1.8, [.88, .47], .022).mul(ruffle.mul(.7).add(.3)).mul(.035))
    .add(layer(maps.fine, .62, [-.35, .94], .05).mul(ruffle).mul(.024).mul(fadeShort))
    .add(layer(maps.wind, .21, [.6, -.8], .09).mul(ruffle).mul(.014).mul(fadeCapillary))
  // Irregular rings (rain, insects): one candidate per 3 m cell, each with its own timing. The seed stays
  // positive across the whole terrain (hash() works on unsigned integers).
  const cell = floor(p.div(3)), local = fract(p.div(3)), seed = cell.x.mul(131).add(cell.y.mul(977)).add(1 << 20)
  const centre = vec2(hash(seed), hash(seed.add(1))).mul(.4).add(.3)
  const period = hash(seed.add(2)).mul(5).add(4), age = mod(t.add(hash(seed.add(3)).mul(period)), period)
  const offset = local.sub(centre).mul(3), d = length(offset), front = d.sub(age.mul(.24))
  const ring = sin(front.mul(42)).mul(exp(front.mul(front).mul(-60))).mul(exp(age.mul(-.9)))
    .mul(hash(seed.add(4)).lessThan(.5).select(1, 0)).mul(fadeShort)
  return { slope: slope.add(offset.div(d.max(.001)).mul(ring).mul(.03)), ruffle }
}

// The water surface: only those cells of the 128 x 128 lattice over the terrain that can show water (ground
// below the surface somewhere inside them, plus a rim). The lattice is the same as a full plane's, so the swell
// and the calm/ruffled mask are evaluated at the same vertices; the mesh is static and a fifth of the size.
function pondGeometry(world, segments = 128) {
  const { x0, x1, y0, y1 } = world.bounds, level = world.meta.water_level
  const plane = new THREE.PlaneGeometry(x1 - x0, y1 - y0, segments, segments)
  plane.rotateX(-Math.PI / 2); plane.translate((x0 + x1) / 2, level, -(y0 + y1) / 2)
  const position = plane.attributes.position, source = plane.index.array, wet = new Uint8Array(segments * segments)
  for (let cell = 0; cell < wet.length; cell++) {
    const a = source[cell * 6], c = source[cell * 6 + 4]                // opposite corners of the cell
    const ax = position.getX(a), az = position.getZ(a), cx = position.getX(c), cz = position.getZ(c)
    search: for (let j = 0; j <= 4; j++) for (let i = 0; i <= 4; i++)
      if (world.heightAt(ax + (cx - ax) * i / 4, az + (cz - az) * j / 4) < level + .03) { wet[cell] = 1; break search }
  }
  const remap = new Int32Array(position.count).fill(-1), points = [], indices = []
  for (let row = 0; row < segments; row++) for (let column = 0; column < segments; column++) {
    let keep = false
    for (let j = Math.max(0, row - 1); j <= Math.min(segments - 1, row + 1) && !keep; j++)
      for (let i = Math.max(0, column - 1); i <= Math.min(segments - 1, column + 1); i++) if (wet[j * segments + i]) { keep = true; break }
    if (!keep) continue
    for (let k = 0; k < 6; k++) {
      const vertex = source[(row * segments + column) * 6 + k]
      if (remap[vertex] < 0) { remap[vertex] = points.length / 3; points.push(position.getX(vertex), position.getY(vertex), position.getZ(vertex)) }
      indices.push(remap[vertex])
    }
  }
  plane.dispose()
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3)); geometry.setIndex(indices)
  return geometry
}

export function Water({world}) {
  const result=useMemo(()=>{
    const mirror=reflector({resolutionScale:adaptive.reflectionScale,bounces:false,samples:0,generateMipmaps:true})
    const base=mirror.reflector.updateBefore.bind(mirror.reflector)
    const last=new THREE.Vector3(Infinity,Infinity,Infinity),rotation=new THREE.Quaternion()
    let updated=-Infinity, frames=0, inReflection=false, diagnostic={}, allowed=-1
    mirror.reflector.updateBefore=frame=>{
      if(inReflection)return false
      // Every frame while the camera moves, so the mirror image never lags the view (30 Hz on slower
      // devices); while still, only drifting plants and flutter change, so it refreshes at reflectionHz.
      // "Moves" is judged on the camera's pose before its handheld drift (parallax.js steady): the drift alone is
      // slow enough for the resting rate (the mirror lags it by about half a pixel).
      // The sharpness test behind the loading screen times the moving case (resolution.js), and on every level
      // with the reflection in every frame: the frames that draw it are the slow ones, and those have to fit.
      const pose=steady.valid?steady:frame.camera
      const now=performance.now(), moved=resolution.measuring || last.distanceToSquared(pose.position)>1e-8 || rotation.angleTo(pose.quaternion)>1e-4
      const hz=adaptive.ready?adaptive.reflectionHz:15, gap=moved?(adaptive.level>=2&&!resolution.measuring?1000/30:0):1000/hz
      diagnostic={hasOutput:mirror.reflector.hasOutput,moved,elapsed:now-updated}
      // (?slow, development: a frame drawn several times draws its reflection each time.) 4 ms short of the gap: two
      // 60 Hz frames are 33.3 ms give or take the frame's own work, and a full gap would often wait for a third.
      if(mirror.reflector.hasOutput && now-updated<gap-4 && !(SLOW>1 && allowed===drawing.callback))return false
      allowed=drawing.callback
      mirror.reflector.resolutionScale=adaptive.reflectionScale
      const hidden=[], shown=[]
      frame.scene.traverse(o=>{
        if(o.visible && (o.name==='ProceduralGrass'||o.userData.noReflection)) {hidden.push(o);o.visible=false}
        else if(!o.visible && o.userData.reflectionLod) {shown.push(o);o.visible=true}   // far leaf cards for every tree
      })
      // NodeFrame is mutable: the nested render replaces frame.camera with
      // the reflected camera. Capture the main pose before entering it.
      last.copy(pose.position);rotation.copy(pose.quaternion)
      inReflection=true;reflectionPass.value=1
      try {const value=base(frame);updated=now;frames++;return value}
      finally {
        inReflection=false;reflectionPass.value=0
        hidden.forEach(o=>o.visible=true);shown.forEach(o=>o.visible=false)
      }
    }
    const p=positionWorld, toEye=cameraPosition.sub(p), distance=length(toEye), V=toEye.div(distance)
    const {slope,ruffle}=surfaceSlope(world,p.xz,distance)
    const N=normalize(vec3(slope.x.negate(),1,slope.y.negate()))
    // Roughness: calm vs ruffled water, broadened where ripples fall below a pixel.
    const roughness=mix(.035,.2,ruffle).add(smoothstep(6,40,distance).mul(.1))
    // Fresnel (Schlick, water F0 = 0.02) on a softened normal, so it varies with the waves without speckling.
    const facing=clamp(dot(normalize(mix(UP,N,.7)),V),0,1)
    const fresnel=float(.02).add(pow(float(1).sub(facing),5).mul(.98))
    // Planar reflection, displaced by the surface normal and blurred through its mipmaps by roughness.
    const mirrorUV=mirror.uvNode.add(vec2(N.x,N.z.negate()).mul(.32).div(distance.max(1)))
    // Calm water stays nearly mirror-sharp; blur grows with ruffle and distance (and hides texel steps).
    const lod=clamp(roughness.mul(7).add(.2),0,4)
    const planar=mirror.sample(mirrorUV).level(lod).rgb
    // Where the displaced lookup leaves the screen, the sky along the reflected ray takes over.
    const inside=smoothstep(0,.04,mirrorUV.x).mul(smoothstep(1,.96,mirrorUV.x)).mul(smoothstep(0,.04,mirrorUV.y)).mul(smoothstep(1,.96,mirrorUV.y))
    const R=reflect(V.negate(),N)
    const sky=world.sky?skyRadiance(world.sky,normalize(vec3(R.x,R.y.abs(),R.z)),3):vec3(.01,.04,.1)
    const reflected=mix(sky,planar,inside)
    // Water body seen when looking down: murky olive-teal over the shallows, blue-black where deep,
    // faintly lit by the baked pink/blue ambience. Never pure black.
    const uvS=uniform(world.uvScale), uvO=uniform(world.uvOffset)
    const depth=float(world.meta.water_level).sub(texture(world.heightTexture,p.xz.mul(uvS).add(uvO)).r).max(0)
    const P=world.palette.pond, lamps=world.palette.lamps
    const body=mix(vec3(...P.shallow),vec3(...P.deep),smoothstep(.02,.3,depth))
      .add(varying(fieldLight(world,p,UP,'lamps')).mul(lamps.pondBody))
    // Glints: the moon and the pond-side pink lights on the ripples (GGX), clamped below heavy bloom.
    const a2=roughness.mul(roughness).max(.0016)
    const ggx=L=>{ const H=normalize(L.add(V)), nh=clamp(dot(N,H),0,1), k=nh.mul(nh).mul(a2.sub(1)).add(1)
      return a2.div(k.mul(k).mul(Math.PI)).mul(clamp(dot(N,L),0,1)).mul(fresnel) }
    const moonDir=new THREE.Vector3(...world.meta.moon.direction_to_scene).normalize().negate()
    let glints=vec3(...world.meta.moon.color).mul(world.meta.moon.strength*world.palette.moon.pondGlint).mul(ggx(vec3(moonDir.x,moonDir.y,moonDir.z)))
    for(const name of ['L_Shore_Pink_C','L_Rock_Pink_BL','L_Rock_Pink_BR','L_Moai_Pink_Base_L']) {
      const light=world.meta.pink_lights.find(l=>l.name===name); if(!light)continue
      const toLight=vec3(...light.position).sub(p), d2=dot(toLight,toLight)
      glints=glints.add(vec3(...light.color).mul(ggx(normalize(toLight))).mul(float(light.watts*lamps.pondGlint).div(d2.add(.5))))
    }
    const material=new THREE.MeshBasicNodeMaterial({transparent:true})
    // Dark, slightly absorbing pond: the reflection is held a little below a clean mirror to keep the night mood.
    const shaded=mix(body,reflected.mul(P.mirror),fresnel).add(glints.min(vec3(lamps.glintCap)))
    if(import.meta.env.DEV) {
      // window.__waterDebug.value = 1 planar reflection, 2 on-screen mask, 3 Fresnel, 4 body (x20), 0 final.
      const debug=uniform(0); window.__waterDebug=debug
      material.colorNode=debug.equal(1).select(planar,debug.equal(2).select(vec3(inside),debug.equal(3).select(vec3(fresnel),
        debug.equal(4).select(body.mul(20),shaded))))
    } else material.colorNode=shaded
    // Soft shoreline where the water thins over the bank.
    // (The banks slope gently, so only the last few centimetres fade: a wider band shows the lit bed.)
    material.opacityNode=smoothstep(.002,.025,depth)
    // The surface is horizontal in object space; wave height uses the same world XZ as the floating plants.
    material.positionNode=positionLocal.add(vec3(0,waveHeight(positionLocal.xz),0))
    const geometry=pondGeometry(world)
    const mesh=new THREE.Mesh(geometry,material);mesh.name='ReflectivePond'
    mirror.target.rotation.x=-Math.PI/2;mirror.target.position.y=world.meta.water_level;mesh.add(mirror.target)
    mesh.userData.reflectionStats=()=>({frames,fallback:0,scale:mirror.reflector.resolutionScale,diagnostic})
    if(import.meta.env.DEV) mesh.userData.mirror=mirror.reflector
    return {mesh,material,mirror,geometry}
  },[world])
  useEffect(()=>()=>{result.geometry.dispose();result.material.dispose();result.mirror.dispose()},[result])
  return <primitive object={result.mesh}/>
}
