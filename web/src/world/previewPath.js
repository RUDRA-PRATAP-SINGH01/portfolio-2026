// Developer-only lighting review path. Public orbit navigation remains unchanged.
export function previewPose(t, ref) {
  const p=ref.position, f=ref.forward
  const target=p.map((v,i)=>v+f[i]*12)
  const frames=[
    {p,t:target},
    {p:[p[0]-.25,p[1]+.45,p[2]-3.1],t:target},
    {p:[p[0]+2.2,p[1]+.65,p[2]-2.6],t:target},
    {p,t:target},
  ]
  const at=Math.max(0,Math.min(.999999,t))*3,i=Math.floor(at),v=at-i,u=v*v*(3-2*v)
  const mix=(a,b)=>a.map((n,j)=>n+(b[j]-n)*u)
  return {position:mix(frames[i].p,frames[i+1].p),target:mix(frames[i].t,frames[i+1].t)}
}
