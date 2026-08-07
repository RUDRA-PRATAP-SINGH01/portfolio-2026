import * as THREE from 'three/webgpu'
import { useMemo, useEffect } from 'react'
import { useFrame } from '@react-three/fiber'
import { texture, uv, uniform, vec3, viewportDepthTexture, linearDepth, cameraFar, cameraNear } from 'three/tsl'

export function LightShafts({world}) {
  const result=useMemo(()=>{
    const group=new THREE.Group();group.name='CinematicLightShafts'
    const data=new Uint8Array(64*256)
    for(let y=0;y<256;y++) for(let x=0;x<64;x++) {
      const u=x/63,v=y/255
      const edge=Math.exp(-Math.pow((u-.5)*4,2))*Math.pow(Math.sin(Math.PI*v),.65)
      data[y*64+x]=Math.round(255*edge*(.82+.18*Math.sin(v*43+u*8)))
    }
    const map=new THREE.DataTexture(data,64,256,THREE.RedFormat);map.needsUpdate=true
    map.minFilter=map.magFilter=THREE.LinearFilter
    const strength=uniform(.22), meshes=[]
    // One depth read shared by every beam. Each viewportDepthTexture() node copies the depth buffer once per
    // render and splits the render pass to do so: a node per beam meant three copies of the same buffer.
    const sceneDepth=linearDepth(viewportDepthTexture())
    for(const beam of world.cinematic?.manifest.beams??[]) {
      const start=new THREE.Vector3(...beam.start),end=new THREE.Vector3(...beam.end),axis=end.clone().sub(start)
      const geo=new THREE.PlaneGeometry(1,1)
      const material=new THREE.MeshBasicNodeMaterial({transparent:true,depthWrite:false,side:THREE.DoubleSide,blending:THREE.AdditiveBlending})
      const intersection=sceneDepth.sub(linearDepth()).mul(cameraFar.sub(cameraNear)).div(.65).clamp()
      material.colorNode=vec3(...world.palette.shafts.colour);material.opacityNode=texture(map,uv()).r.mul(strength).mul(intersection)
      const mesh=new THREE.Mesh(geo,material);mesh.position.copy(start).add(end).multiplyScalar(.5)
      mesh.scale.set(beam.width,axis.length(),1);mesh.renderOrder=2
      mesh.userData.axis=axis.normalize();mesh.userData.noReflection=true
      group.add(mesh);meshes.push(mesh)
    }
    const reference=new THREE.Vector3(...world.meta.camera_reference.position), forward=new THREE.Vector3(...world.meta.camera_reference.forward)
    return {group,meshes,map,strength,reference,forward,peak:world.palette.shafts.strength,view:new THREE.Vector3(),x:new THREE.Vector3(),z:new THREE.Vector3(),basis:new THREE.Matrix4()}
  },[world])
  useFrame(({camera})=>{
    const {view,x,z,basis}=result
    const corridor=THREE.MathUtils.clamp(1-camera.position.distanceTo(result.reference)/18,0,1)
    const alignment=camera.getWorldDirection(view).dot(result.forward)
    result.strength.value=result.peak*corridor*THREE.MathUtils.smoothstep(alignment,.55,.9)
    // Away from the reference corridor the beams have no strength: skip them, and their depth copy, entirely.
    result.group.visible=result.strength.value>1e-4
    if(!result.group.visible)return
    result.meshes.forEach(mesh=>{
      const y=mesh.userData.axis
      view.copy(camera.position).sub(mesh.position).normalize()
      x.crossVectors(y,view).normalize();z.crossVectors(x,y).normalize()
      mesh.quaternion.setFromRotationMatrix(basis.makeBasis(x,y,z))
    })
  })
  useEffect(()=>()=>{result.map.dispose();result.meshes.forEach(m=>{m.geometry.dispose();m.material.dispose()})},[result])
  return <primitive object={result.group}/>
}
