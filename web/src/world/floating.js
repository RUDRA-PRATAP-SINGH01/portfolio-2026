import * as THREE from 'three/webgpu'
import { Fn, attribute, positionLocal, normalLocal, vec3, float, sin, cos } from 'three/tsl'
import { motionTime, motionEnabled, safeDrift, waveHeight, waveSlope } from './animation.js'

export const FLOATING_DRIFT = { loose: .75, rooted: .38 }

export function floatingKind(world, source) {
  const tags = world.cinematic?.manifest.floating
  return tags?.loose.includes(source) ? 'loose' : tags?.rooted.includes(source) ? 'rooted' : null
}

const variation = (x,z) => {
  const value = Math.sin(x*12.9898+z*78.233)*43758.5453
  return value-Math.floor(value)
}

// Every physical plant gets one motion record. A flower's petals and stamens,
// and the pad underneath it, share a current instead of drifting apart.
export function prepareFloating(world, prototypes, root) {
  const byEntry = new Map(), records = [], pads = []
  const matrix = new THREE.Matrix4()
  for (const entry of prototypes) {
    const kind = floatingKind(world,entry.source)
    if (!kind) continue
    const prototype = root.getObjectByName(entry.name)
    if (!prototype) continue
    const localBox = new THREE.Box3().setFromObject(prototype)
    const placements = entry.instances.map((instance,index) => {
      matrix.fromArray(instance.matrix)
      const anchor = new THREE.Vector3().setFromMatrixPosition(matrix)
      const box = localBox.clone().applyMatrix4(matrix)
      const radius = Math.hypot(Math.max(Math.abs(box.min.x-anchor.x),Math.abs(box.max.x-anchor.x)),
        Math.max(Math.abs(box.min.z-anchor.z),Math.abs(box.max.z-anchor.z)))
      const record = { anchor:anchor.toArray(), radius, kind, source:entry.source, id:entry.name+':'+index }
      records.push(record)
      if (entry.source.startsWith('PROTO_LilyPad_')) pads.push(record)
      return record
    })
    byEntry.set(entry.name,placements)
  }
  for (const record of records) {
    let leader = record
    if (record.source.startsWith('PROTO_Nymphaea_')) {
      let closest = .22
      for (const pad of pads) {
        const distance = Math.hypot(record.anchor[0]-pad.anchor[0],record.anchor[2]-pad.anchor[2])
        if (distance < closest) { closest=distance; leader=pad }
      }
      if (leader !== record) leader.radius=Math.max(leader.radius,record.radius+closest)
    }
    record.leader=leader
  }
  for (const record of records) {
    const leader=record.leader
    if (!leader.motion) {
      const [x,,z]=leader.anchor, v=variation(x,z)
      leader.motion={
        drift:safeDrift(world,x,z,leader.radius,FLOATING_DRIFT[leader.kind]),
        phase:v*Math.PI*2,
        speed:(leader.kind==='loose'?.10:.12)*(.85+v*.3),
        turn:leader.kind==='loose'?.45:.12,
      }
    }
    record.motion=leader.motion
    record.group=leader.id
  }
  return byEntry
}

export function animateFloating(mesh, world, kind, placements) {
  const geometry=mesh.geometry.clone()
  mesh.geometry=geometry
  const packed=new Float32Array(mesh.count*7)
  let moving=0, maxDrift=0
  for (let i=0;i<mesh.count;i++) {
    const {anchor,motion}=placements[i]
    packed.set(anchor,i*7)
    packed.set([motion.drift,motion.phase,motion.speed,motion.turn],i*7+3)
    if (motion.drift>0) moving++
    maxDrift=Math.max(maxDrift,motion.drift)
  }
  // One instanced buffer, shared by both attributes, fits WebGPU's buffer limit.
  const buffer=new THREE.InstancedInterleavedBuffer(packed,7)
  geometry.setAttribute('floatAnchor',new THREE.InterleavedBufferAttribute(buffer,3,0))
  geometry.setAttribute('floatMotion',new THREE.InterleavedBufferAttribute(buffer,4,3))
  const anchor=attribute('floatAnchor','vec3'), info=attribute('floatMotion','vec4')
  const rotateY=(p,angle)=>vec3(p.x.mul(cos(angle)).add(p.z.mul(sin(angle))),p.y,
    p.z.mul(cos(angle)).sub(p.x.mul(sin(angle))))
  mesh.material.positionNode=Fn(()=>{
    // Three applies instanceMatrix BEFORE positionNode. positionLocal already
    // contains each scaled, rotated, placed plant; never apply/invert it again.
    const local=positionLocal.sub(anchor).toVar()
    const t=motionTime.mul(info.z).add(info.y)
    // Slow elliptical currents stay inside the checked circular clearance.
    const along=cos(t).mul(info.x), across=sin(t).mul(info.x).mul(.45)
    const offset=vec3(along.mul(.94).sub(across.mul(.341174)),0,
      along.mul(.341174).add(across.mul(.94))).mul(motionEnabled)
    const angle=sin(t.mul(.7)).mul(info.w).mul(motionEnabled)
    const turned=rotateY(local,angle).toVar()
    const center=anchor.add(offset).toVar(), slope=waveSlope(center.xz)
    const n=rotateY(normalLocal,angle).toVar()
    normalLocal.assign(vec3(n.x.sub(slope.x.mul(n.y)),n.y,n.z.sub(slope.y.mul(n.y))).normalize())
    // Keep authored millimetre clearance and flower height. Only the water's
    // actual shared wave sets elevation; instance scale cannot amplify bobbing.
    const water=float(world.meta.water_level)
    const contact=water.add(anchor.y.sub(water).clamp(.002,.014))
    const height=contact.add(turned.y).add(waveHeight(center.xz))
      .add(turned.x.mul(slope.x)).add(turned.z.mul(slope.y))
    return vec3(center.x.add(turned.x),height,center.z.add(turned.z))
  })()
  mesh.userData.floating={kind,instances:mesh.count,drifting:moving,maxDrift,
    paired:placements.filter(p=>p.group!==p.id).length}
  mesh.computeBoundingSphere()
  mesh.boundingSphere.radius+=maxDrift+.05
  return mesh
}
