import { setConsoleFunction } from 'three/webgpu'

// three.js's own messages go to the console as three would print them, except one that is not ours: React Three
// Fiber 9.8 builds every canvas's frame clock with THREE.Clock (its store, in @react-three/fiber's
// events-*.esm.js), which three has called deprecated since r183, once per canvas (each visit, each change of quality).
// Nothing in this project uses Clock. Drop the line when R3F moves to THREE.Timer.
const NOT_OURS = ['THREE.Clock: This module has been deprecated']

setConsoleFunction((type, message, ...params) => {
  if (type === 'warn' && NOT_OURS.some(start => String(message).startsWith(start))) return
  const print = console[type] ?? console.log, trace = params[0]
  if (trace?.isStackTrace) print(trace.getError(message))          // (as three prints its node stack traces)
  else print(message, ...params)
})
