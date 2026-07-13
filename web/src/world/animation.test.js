import test from 'node:test'
import assert from 'node:assert/strict'
import { safeDrift } from './animation.js'
import * as THREE from 'three/webgpu'
import { prepareFloating } from './floating.js'

test('floating motion keeps full travel in open water',()=>{
  const world={meta:{water_level:0},heightAt:()=>-1}
  assert.equal(safeDrift(world,0,0,.1,.12),.12)
})

test('shore clearance reduces travel before an object can reach land',()=>{
  const world={meta:{water_level:0},heightAt:(x)=>x>=.17?.1:-1}
  const drift=safeDrift(world,0,0,.1,.12)
  assert.ok(drift>0 && drift<.12)
  for(let t=0;t<1000;t++) {
    const x=Math.sin(t*.18)*drift*Math.SQRT1_2
    const z=Math.sin(t*.18*.73+1.3)*drift*Math.SQRT1_2
    assert.ok(Math.hypot(x,z)<=drift)
    assert.ok(world.heightAt(x+.1,z)<world.meta.water_level-.025)
  }
})

test('a tight shoreline freezes drift while leaving shader bobbing available',()=>{
  const world={meta:{water_level:0},heightAt:(x)=>x>=.105?.1:-1}
  assert.equal(safeDrift(world,0,0,.1,.12),0)
})

test('a rock reduces the swept travel before the leaf can hit it',()=>{
  const world={meta:{water_level:0},heightAt:()=>-1,floatObstacles:[{x:.35,z:0,radius:.1}]}
  const drift=safeDrift(world,0,0,.1,.38)
  assert.ok(drift>0)
  assert.ok(drift+.1+.1<=.35)
})

test('flowers and pads share one motion even across separate prototype batches',()=>{
  const root=new THREE.Group(), materials=[], geometries=[]
  for(const [name,size] of [['pad',1],['flower',.08]]) {
    const geometry=new THREE.PlaneGeometry(size,size)
    geometry.rotateX(-Math.PI/2)
    const material=new THREE.MeshBasicMaterial(), mesh=new THREE.Mesh(geometry,material)
    mesh.name=name;root.add(mesh);materials.push(material);geometries.push(geometry)
  }
  root.updateMatrixWorld(true)
  const instance=(x,y,z,scale)=>({matrix:new THREE.Matrix4().compose(new THREE.Vector3(x,y,z),
    new THREE.Quaternion(),new THREE.Vector3(scale,scale,scale)).toArray()})
  const entries=[
    {name:'pad',source:'PROTO_LilyPad_0',instances:[instance(1,.006,-2,.3)]},
    {name:'flower',source:'PROTO_Nymphaea_Open',instances:[instance(1.05,.01,-2,1.2)]},
  ]
  const world={meta:{water_level:0},heightAt:()=>-1,cinematic:{manifest:{floating:{loose:[],rooted:entries.map(e=>e.source)}}}}
  const placements=prepareFloating(world,entries,root), pad=placements.get('pad')[0], flower=placements.get('flower')[0]
  assert.equal(flower.motion,pad.motion)
  assert.equal(flower.group,pad.id)
  assert.ok(pad.motion.drift>.1)
  materials.forEach(m=>m.dispose());geometries.forEach(g=>g.dispose())
})
