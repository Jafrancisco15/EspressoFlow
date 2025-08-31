import React, { useEffect, useRef, useState } from 'react'

// ---- OpenCV runtime wait ----
const waitForOpenCV = () =>
  new Promise(resolve => {
    const ready = () => (window.cv && window.cv.Mat)
    const check = () => {
      if (ready()) return resolve()
      if (window.cv && typeof window.cv['onRuntimeInitialized'] === 'function') {
        const cb = window.cv['onRuntimeInitialized']
        window.cv['onRuntimeInitialized'] = () => { try{cb()}catch(e){} resolve() }
        return
      }
      setTimeout(check, 100)
    }
    check()
  })

// ---- video helpers ----
const waitEvent = (el, ev) => new Promise(res => {
  const h = () => { el.removeEventListener(ev, h); res() }
  el.addEventListener(ev, h, { once:true })
})
const ensureReady = async (video) => {
  if (Number.isNaN(video.duration) || !isFinite(video.duration) || video.duration === 0) {
    await waitEvent(video, 'loadedmetadata')
  }
  if (video.readyState < 2) { // HAVE_CURRENT_DATA
    await waitEvent(video, 'loadeddata')
  }
}
const seekTo = async (video, t) => {
  if (!isFinite(video.duration) || video.duration === 0) return
  if (t > video.duration) t = video.duration
  if (t < 0) t = 0
  video.currentTime = t
  try { await waitEvent(video, 'seeked') } catch(e){}
}

function App() {
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const chartRef = useRef(null)

  const [videoURL, setVideoURL] = useState(null)
  const [frameLoaded, setFrameLoaded] = useState(false)
  const [status, setStatus] = useState("Cargando OpenCV...")
  const [cvReady, setCvReady] = useState(false)

  // ---- Single ROI (optional). If not set, analyze full frame ----
  const [roi, setRoi] = useState(null)
  const [scale, setScale] = useState(0.6)

  const [processing, setProcessing] = useState(false)
  const [metrics, setMetrics] = useState(null)

  const drawState = useRef({dragging:false,start:null})

  useEffect(() => {
    (async () => {
      await waitForOpenCV()
      setCvReady(true)
      setStatus("OpenCV listo. Sube tu video y toma un cuadro para configurar (opcional ROI).")
    })().catch(err => setStatus("Error cargando OpenCV: " + err?.message))
  }, [])

  const onVideoFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const url = URL.createObjectURL(file)
    setVideoURL(url)
    setFrameLoaded(false)
    setRoi(null)
    setMetrics(null)
    setStatus("Cargando video...")
    setTimeout(async ()=>{
      try {
        const v = videoRef.current
        if (!v) return
        await ensureReady(v)
        setStatus("Video listo. (Opcional) Presiona 'Tomar cuadro' para dibujar ROI, o directamente 'Analizar' para analizar todo el frame.")
      } catch (err) {
        setStatus("No se pudo preparar el video: " + (err?.message||err))
      }
    }, 50)
  }

  const grabFrame = async () => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return
    try {
      await ensureReady(video)
      const targetT = Math.min(5, (isFinite(video.duration) ? video.duration * 0.25 : 5))
      await seekTo(video, targetT)
      const w = Math.min(960, video.videoWidth)
      const h = Math.round(video.videoHeight * (w / video.videoWidth))
      canvas.width = w; canvas.height = h
      const ctx = canvas.getContext('2d')
      ctx.drawImage(video, 0, 0, w, h)
      setFrameLoaded(true)
      setStatus("Dibuja un ROI (opcional). Si no dibujas, se analizará todo el frame.")
    } catch (e) {
      setStatus("Error al tomar cuadro: " + (e?.message||e))
    }
  }

  // ---- ROI drawing ----
  const onCanvasMouseDown = (e) => {
    if (!frameLoaded) return
    const rect = e.target.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    drawState.current = {dragging:true,start:{x,y}}
  }
  const onCanvasMouseMove = (e) => {
    if (!drawState.current.dragging) return
    const rect = e.target.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const ctx = canvasRef.current.getContext('2d')
    ctx.drawImage(videoRef.current, 0, 0, canvasRef.current.width, canvasRef.current.height)
    if (roi) drawRect(ctx, roi, '#60a5fa')
    const s = drawState.current.start
    const r = normRect({x1:s.x,y1:s.y,x2:x,y2:y})
    drawRect(ctx, r, '#60a5fa')
  }
  const onCanvasMouseUp = (e) => {
    if (!drawState.current.dragging) return
    drawState.current.dragging=false
    const rect = e.target.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const s = drawState.current.start
    const r = normRect({x1:s.x,y1:s.y,x2:x,y2:y})
    if (r.w >= 10 && r.h >= 10) setRoi(r)
  }

  useEffect(()=>{ if(frameLoaded) drawOverlay() }, [roi, frameLoaded])

  const drawOverlay = () => {
    const canvas = canvasRef.current, video = videoRef.current
    if (!canvas || !video) return
    const ctx = canvas.getContext('2d')
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    if (roi) drawRect(ctx, roi, '#60a5fa')
  }

  const runAnalysis = async () => {
    if (!cvReady) return
    const cv = window.cv
    const video = videoRef.current
    if (!video) { setStatus("Sube un video primero."); return }
    await ensureReady(video)

    setProcessing(true)
    setStatus("Analizando video…")

    const W = Math.round(video.videoWidth * scale)
    const H = Math.round(video.videoHeight * scale)
    const tmp = document.createElement('canvas'); tmp.width=W; tmp.height=H
    const ctx = tmp.getContext('2d')

    const r = roi ? roiRectScaled(roi, scale) : {x:0,y:0,w:W,h:H}
    const perFrame = []
    let lastArea = null

    // Recorrer el video a ~10 fps o la duración disponible
    const FPS = 10
    const totalT = isFinite(video.duration) ? video.duration : 30
    for (let t=0; t<=totalT; t+=1.0/FPS) {
      await seekTo(video, t)
      ctx.drawImage(video, 0, 0, W, H)
      const frame = cv.imread(tmp)

      // ROI
      let A = frame.roi(new cv.Rect(r.x, r.y, r.w, r.h))

      // Pre-proceso / segmentación
      let g = new cv.Mat(); cv.cvtColor(A, g, cv.COLOR_RGBA2GRAY)
      cv.GaussianBlur(g, g, new cv.Size(3,3), 0)
      let m = new cv.Mat()
      cv.adaptiveThreshold(g, m, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 21, 5)
      let kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3,3))
      cv.morphologyEx(m, m, cv.MORPH_OPEN, kernel)

      const jets = countBlobs(m)
      const area = sumArea(m)
      let areaJump = 0
      if (lastArea!==null && area>lastArea*1.35) areaJump = 1
      lastArea = area
      perFrame.push({ t, jets, area, areaJump })

      // Overlay para que el usuario vea progreso
      if ((perFrame.length % 3) === 0) {
        const out = canvasRef.current
        out.width = W; out.height = H
        const octx = out.getContext('2d')
        octx.drawImage(tmp, 0, 0)
        if (roi) drawRect(octx, r, '#60a5fa')
        drawMaskContours(octx, m, r.x, r.y, '#60a5fa')
        setStatus(`Procesando… ${Math.round(100*t/totalT)}%`)
      }

      // limpiar
      frame.delete(); A.delete(); g.delete(); m.delete(); kernel.delete()
    }

    // Métricas
    const jetsSeries = perFrame.map(p=>p.jets)
    const mean = meanArr(jetsSeries)
    const variance = varArr(jetsSeries, mean)
    const spikes = jetsSeries.filter((v,i,arr)=> i>0 && v>arr[i-1]+1).length
    const areaJumps = perFrame.reduce((acc,p)=>acc+p.areaJump,0)
    const score = Math.min(100, Math.round( (spikes*10) + (variance*1.5) + (areaJumps*8) ))

    const mtr = { frames: perFrame.length, duration: totalT, jets_mean: mean, jets_var: variance, spikes, areaJumps, score, series: perFrame }
    setMetrics(mtr)
    setStatus("Listo ✅. Revisa indicadores y exporta CSV.")
    drawChart(chartRef.current, perFrame)
    setProcessing(false)
  }

  const exportCSV = () => {
    if (!metrics) return
    const header = "t_sec,jets,area,areaJump\n"
    const rows = metrics.series.map(p=>[p.t.toFixed(3),p.jets,p.area,p.areaJump].join(",")).join("\n")
    const blob = new Blob([header+rows], {type:'text/csv'})
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href=url; a.download='espresso_flow_metrics.csv'
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="container">
      <div className="row" style={{alignItems:'center', justifyContent:'space-between'}}>
        <h1>☕️ Espresso Flow Vision <span className="badge">1 video</span></h1>
        <div className="pill small">OpenCV.js • Vite + React</div>
      </div>

      <div className="kpi" style={{margin:'12px 0 18px'}}>
        <div className="item"><div className="small muted">Estado</div><div>{status}</div></div>
        <div className="item"><div className="small muted">OpenCV</div><div>{cvReady ? '✅' : '…'}</div></div>
        <div className="item"><div className="small muted">ROI</div><div>{roi ? '✅' : '— (analiza todo el frame)'}</div></div>
      </div>

      <div className="card" style={{marginBottom:16}}>
        <h3>1) Sube video</h3>
        <input type="file" accept="video/*" onChange={onVideoFile}/>
        {videoURL && (
          <video
            ref={videoRef}
            src={videoURL}
            style={{maxWidth:'100%', display:'block', marginTop:8, borderRadius:12, border:'1px solid #232339'}}
            controls
            playsInline
            crossOrigin="anonymous"
            onLoadedMetadata={()=>setStatus("Video cargado. Puedes 'Tomar cuadro' y dibujar ROI, o directamente 'Analizar'.")}
          />
        )}
        <div style={{marginTop:8}}>
          <button className="btn" onClick={grabFrame} disabled={!videoURL}>Tomar cuadro</button>
        </div>
        <p className="muted small">Tip: portafiltro naked, ring light, fondo neutro. Si no dibujas ROI, se procesa todo el frame.</p>
      </div>

      <div className="card" style={{marginBottom:16}}>
        <h3>2) (Opcional) Define ROI</h3>
        <div style={{marginTop:8}}>
          <canvas
            ref={canvasRef}
            width={960}
            height={540}
            onMouseDown={onCanvasMouseDown}
            onMouseMove={onCanvasMouseMove}
            onMouseUp={onCanvasMouseUp}
          />
        </div>
        <div className="row">
          <label>Escala de procesamiento: 
            <input type="range" min="0.3" max="1.0" step="0.1" value={scale} onChange={e=>setScale(parseFloat(e.target.value))} />
            <span className="small muted" style={{marginLeft:8}}>{Math.round(scale*100)}%</span>
          </label>
          <button className="btn" onClick={()=>setRoi(null)}>Quitar ROI</button>
        </div>
      </div>

      <div className="card" style={{marginBottom:16}}>
        <h3>3) Analizar</h3>
        <div className="row">
          <button className="btn" disabled={processing || !videoURL} onClick={runAnalysis}>Iniciar análisis</button>
          <button className="btn secondary" disabled={!metrics} onClick={exportCSV}>Exportar CSV</button>
        </div>
        {processing && <p className="small warn">Procesando en tu navegador… Mantén esta pestaña activa.</p>}
        {metrics && (
          <>
            <div className="kpi" style={{marginTop:12}}>
              <div className="item"><div className="small muted">Frames</div><div>{metrics.frames}</div></div>
              <div className="item"><div className="small muted">Duración (s)</div><div>{metrics.duration.toFixed(2)}</div></div>
              <div className="item"><div className="small muted">Jets (prom)</div><div>{metrics.jets_mean.toFixed(2)}</div></div>
              <div className="item"><div className="small muted">Jets var</div><div>{metrics.jets_var.toFixed(2)}</div></div>
              <div className="item"><div className="small muted">Spikes jets</div><div>{metrics.spikes}</div></div>
              <div className="item"><div className="small muted">Saltos área</div><div>{metrics.areaJumps}</div></div>
              <div className="item"><div className="small muted">Score canalización</div><div>{metrics.score}/100</div></div>
            </div>
            <div style={{marginTop:12}}>
              <h4>Serie temporal: # chorros</h4>
              <canvas ref={chartRef} width={800} height={160} style={{width:'100%', border:'1px solid #232339', borderRadius:'8px'}} />
              <p className="small muted">Curvas suaves y decrecientes indican extracción uniforme; picos y alta varianza suelen implicar canalización.</p>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ---------- Utils ----------
function normRect({x1,y1,x2,y2}){ const x=Math.min(x1,x2), y=Math.min(y1,y2); return {x,y,w:Math.abs(x2-x1),h:Math.abs(y2-y1)} }
function roiRectScaled(roi,s){ return {x:Math.round(roi.x*s), y:Math.round(roi.y*s), w:Math.round(roi.w*s), h:Math.round(roi.h*s)} }
function drawRect(ctx,r,color='#60a5fa'){ ctx.save(); ctx.strokeStyle=color; ctx.lineWidth=2; ctx.strokeRect(r.x,r.y,r.w,r.h); ctx.restore() }

function drawMaskContours(ctx, maskMat, offsetX, offsetY, color='#60a5fa'){
  const cv = window.cv
  let contours = new cv.MatVector(), hierarchy = new cv.Mat()
  cv.findContours(maskMat, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)
  ctx.save(); ctx.strokeStyle=color; ctx.lineWidth=2
  for(let i=0;i<contours.size();i++){
    const rect = cv.boundingRect(contours.get(i))
    if (rect.width*rect.height < 40) continue
    ctx.strokeRect(rect.x + offsetX, rect.y + offsetY, rect.width, rect.height)
  }
  ctx.restore()
  contours.delete(); hierarchy.delete()
}
function countBlobs(maskMat){
  const cv = window.cv
  let labels = new cv.Mat(), stats = new cv.Mat(), centroids = new cv.Mat()
  const n = cv.connectedComponentsWithStats(maskMat, labels, stats, centroids, 8, cv.CV_32S)
  let count=0
  for(let i=1;i<n;i++){ if (stats.intAt(i, cv.CC_STAT_AREA) >= 35) count++ }
  labels.delete(); stats.delete(); centroids.delete()
  return count
}
function sumArea(maskMat){
  let count = 0
  const rows = maskMat.rows, cols = maskMat.cols
  for (let r=0;r<rows;r++){
    for (let c=0;c<cols;c++){
      if (maskMat.ucharPtr(r,c)[0]===255) count++
    }
  }
  return count
}
function meanArr(a){ return a.length? a.reduce((x,y)=>x+y,0)/a.length : 0 }
function varArr(a,m){ return a.length? a.reduce((x,y)=>x+(y-m)*(y-m),0)/a.length : 0 }

function drawChart(canvas, series){
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  const W = canvas.width, H = canvas.height
  ctx.clearRect(0,0,W,H)
  ctx.fillStyle = '#0b0b0f'; ctx.fillRect(0,0,W,H)
  ctx.strokeStyle = '#384152'; ctx.lineWidth=1
  for (let i=0;i<6;i++){ const y = Math.round(i*H/6); ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke() }
  const xs = series.map(p=>p.t), ys = series.map(p=>p.jets)
  if (xs.length<2) return
  const x0 = xs[0], x1 = xs[xs.length-1]; const yMax = Math.max(2, ...ys)
  ctx.strokeStyle = '#60a5fa'; ctx.lineWidth=2
  ctx.beginPath()
  for (let i=0;i<series.length;i++){
    const x = ((xs[i]-x0)/(x1-x0))*W
    const y = H - (ys[i]/yMax)*H
    if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y)
  }
  ctx.stroke()
}

export default App
