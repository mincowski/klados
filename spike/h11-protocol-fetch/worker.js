;(async () => {
  const t0 = performance.now()
  const res = await fetch('nodepad-spike://spike/fixture')
  const buf = await res.arrayBuffer()
  const t1 = performance.now()
  postMessage({ byteLength: buf.byteLength, ms: t1 - t0 })
})().catch((err) => {
  postMessage({ error: String(err) })
})
