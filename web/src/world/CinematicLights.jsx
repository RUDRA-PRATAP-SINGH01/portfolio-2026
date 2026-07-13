import * as THREE from 'three/webgpu'
import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import { cameraPosition, cameraProjectionMatrix, fog, mix, modelViewMatrix, normalize, positionLocal, positionWorld, smoothstep, varying, vec3, vec4 } from 'three/tsl'
import { skyRadiance } from './sky.js'
import { createStars } from './stars.js'

const skyColor = height => mix(vec3(.055,.27,.8),vec3(.003,.025,.095),smoothstep(0,.5,height))
// The scene has no live lights: every surface is lit from the bake (bakedMaterial.js) and the statue works its own
// lamps out (Moai.jsx). What is left here is the air: distance fog in the colour of the sky, and the sky itself.
export function Lights({ world }) {
  const {gl,scene}=useThree()
  useEffect(()=>{
    const ray=positionWorld.sub(cameraPosition), distance=ray.length().sub(10).max(0)
    const density=mix(.8,.25,smoothstep(0,12,positionWorld.y.add(cameraPosition.y).mul(.5)))
    // Fogged geometry takes the blurred colour of the sky directly behind it, so distant trees dissolve into it.
    // That colour is a ~11 degree blur, so it is sampled per vertex rather than in every (overdrawn) leaf pixel.
    const fogColor=world.sky?varying(skyRadiance(world.sky,normalize(ray),world.sky.fogLevel)):skyColor(normalize(ray).y)
    scene.fogNode=fog(fogColor,distance.mul(.028).pow(2).mul(density).negate().exp().oneMinus())
    // The sky is a dome at the far plane, drawn after everything opaque: it is shaded only where nothing covers
    // it. (scene.backgroundNode draws the same dome first, over the whole frame, in the main view and the reflection.)
    const sky=new THREE.MeshBasicNodeMaterial({side:THREE.BackSide,depthWrite:false,fog:false})
    sky.colorNode=world.sky?skyRadiance(world.sky,normalize(positionLocal)):skyColor(normalize(positionLocal).y)
    const clip=cameraProjectionMatrix.mul(vec4(modelViewMatrix.mul(vec4(positionLocal,0)).xyz,1))   // rotation only: centred on the eye
    sky.vertexNode=vec4(clip.xy,clip.w,clip.w)
    const dome=new THREE.Mesh(new THREE.IcosahedronGeometry(1,3),sky)
    dome.name='SkyDome';dome.frustumCulled=false;dome.renderOrder=1000;dome.matrixAutoUpdate=false
    scene.add(dome)
    // The point stars over it, a pixel or so wide at any resolution (stars.js).
    const stars=world.sky?.stars?createStars(world.sky,world.palette.stars):null
    if(stars)scene.add(stars)
    gl.shadowMap.enabled=false
    return ()=>{scene.fogNode=null;scene.remove(dome);dome.geometry.dispose();sky.dispose();if(stars){scene.remove(stars);stars.userData.dispose()}}
  },[scene,gl,world])
  return null
}
