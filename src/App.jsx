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

  // ROI opcional
  const [roi, setRoi] = useState(null)
  const [scale, setScale] = useState(0.6)

  const [processing, setProcessing] = useState(false)
  const [metrics, setMetrics] = useState(null)
  const [recs, setRecs] = useState([])

  const drawState = useRef({dragging:false,start:null})

  useEffect(() => {
    (async () => {
      await waitForOpenCV()
      setCvReady(true)
      setStatus("OpenCV listo. Sube tu video y toma un cuadro (opcional ROI), o analiza todo el frame.")
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
    setRecs([])
    setStatus("Cargando video...")
    setTimeout(async ()=>{
      try {
        const v = videoRef.current
        if (!v) return
        await ensureReady(v)
        setStatus("Video listo. (Opcional) 'Tomar cuadro' para dibujar ROI, o 'Analizar' para todo el frame.")
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

      // Spike: salto >=2 jets respecto al frame anterior y nivel mínimo >= 3
      let spike = 0
      if (perFrame.length>0) {
        const prev = perFrame[perFrame.length-1].jets
        if (jets >= 3 && (jets - prev) >= 2) spike = 1
      }

      // area jump relativo
      let areaJump = 0
      if (lastArea!==null && area>lastArea*1.35) areaJump = 1
      lastArea = area

      perFrame.push({ t, jets, area, spike, areaJump })

      // Overlay preview (cada 3 frames)
      if ((perFrame.length % 3) === 0) {
        const out = canvasRef.current
        out.width = W; out.height = H
        const octx = out.getContext('2d')
        octx.drawImage(tmp, 0, 0)
        if (roi) drawRect(octx, r, '#60a5fa')
        drawMaskContours(octx, m, r.x, r.y, '#60a5fa')
        setStatus(`Procesando… ${Math.round(100*t/totalT)}%`)
      }

      frame.delete(); A.delete(); g.delete(); m.delete(); kernel.delete()
    }

    // Métricas con severidad más suave
    const jetsSeries = perFrame.map(p=>p.jets)
    const areaSeries = perFrame.map(p=>p.area)
    const spikesIdx = perFrame.map((p,i)=> p.spike? i : -1).filter(i=>i>=0)
    const areaJumpIdx = perFrame.map((p,i)=> p.areaJump? i : -1).filter(i=>i>=0)

    const mean = meanArr(jetsSeries)
    const sd = stdArr(jetsSeries, mean)
    const cvJets = mean>0 ? sd/mean : 0 // coeficiente de variación
    const spikeRate = perFrame.length>0 ? (spikesIdx.length/perFrame.length) : 0
    const areaJumpRate = perFrame.length>0 ? (areaJumpIdx.length/perFrame.length) : 0

    // Score 0..100 suave: mapea CV 0..1 → 0..50; spikeRate 0..0.3 → 0..35; areaJumpRate 0..0.2 → 0..15
    const sCV = clamp(mapRange(cvJets, 0, 1.0, 0, 50), 0, 50)
    const sSp = clamp(mapRange(spikeRate, 0, 0.30, 0, 35), 0, 35)
    const sAJ = clamp(mapRange(areaJumpRate, 0, 0.20, 0, 15), 0, 15)
    const score = Math.round(sCV + sSp + sAJ)

    const mtr = { 
      frames: perFrame.length, duration: totalT, 
      jets_mean: mean, jets_sd: sd, jets_cv: cvJets, 
      spikes: spikesIdx.length, areaJumps: areaJumpIdx.length, 
      spikeRate, areaJumpRate, score, 
      series: perFrame, spikesIdx, areaJumpIdx
    }
    setMetrics(mtr)
    setStatus("Listo ✅. Revisa indicadores y exporta CSV.")
    drawChart(chartRef.current, perFrame, spikesIdx, areaSeries)
    setRecs(generateRecommendations(mtr))
    setProcessing(false)

    // Hacer clickable el chart para saltar en el video
    attachChartClick(chartRef.current, perFrame, async (t)=>{
      await seekTo(videoRef.current, t)
      // Render frame seleccionado con overlay
      const out = canvasRef.current
      const W2 = Math.round(videoRef.current.videoWidth * scale)
      const H2 = Math.round(videoRef.current.videoHeight * scale)
      const tmp2 = document.createElement('canvas'); tmp2.width=W2; tmp2.height=H2
      const ctx2 = tmp2.getContext('2d')
      ctx2.drawImage(videoRef.current, 0, 0, W2, H2)
      const cv = window.cv
      const frame = cv.imread(tmp2)
      const r2 = roi ? roiRectScaled(roi, scale) : {x:0,y:0,w:W2,h:H2}
      let A2 = frame.roi(new cv.Rect(r2.x, r2.y, r2.w, r2.h))
      let g2 = new cv.Mat(); cv.cvtColor(A2, g2, cv.COLOR_RGBA2GRAY)
      cv.GaussianBlur(g2, g2, new cv.Size(3,3), 0)
      let m2 = new cv.Mat()
      cv.adaptiveThreshold(g2, m2, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 21, 5)
      let kernel2 = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3,3))
      cv.morphologyEx(m2, m2, cv.MORPH_OPEN, kernel2)

      out.width = W2; out.height = H2
      const octx = out.getContext('2d')
      octx.drawImage(tmp2, 0, 0)
      if (roi) drawRect(octx, r2, '#60a5fa')
      drawMaskContours(octx, m2, r2.x, r2.y, '#60a5fa')

      frame.delete(); A2.delete(); g2.delete(); m2.delete(); kernel2.delete()
    })
  }

  const exportCSV = () => {
    if (!metrics) return
    const header = "t_sec,jets,area,spike,areaJump\n"
    const rows = metrics.series.map(p=>[p.t.toFixed(3),p.jets,p.area,p.spike,p.areaJump].join(",")).join("\n")
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
        <div className="item"><div className="small muted">ROI</div><div>{roi ? '✅' : '— (full frame)'}</div></div>
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
              <div className="item"><div className="small muted">Jets CV</div><div>{metrics.jets_cv.toFixed(2)}</div></div>
              <div className="item"><div className="small muted">Spike rate</div><div>{(metrics.spikeRate*100).toFixed(1)}%</div></div>
              <div className="item"><div className="small muted">Area jump rate</div><div>{(metrics.areaJumpRate*100).toFixed(1)}%</div></div>
              <div className="item"><div className="small muted">Score canalización</div><div>{metrics.score}/100</div></div>
            </div>
            <div style={{marginTop:12}}>
              <h4>Serie temporal: chorros (línea) + <span style={{color:'#f87171'}}>spikes</span> (marcas)</h4>
              <canvas ref={chartRef} width={900} height={200} style={{width:'100%', border:'1px solid #232339', borderRadius:'8px', cursor:'pointer'}} title="Haz clic para saltar a ese tiempo" />
              <p className="small muted">Clic en el gráfico para saltar al frame correspondiente y ver el overlay en el canvas superior.</p>
            </div>
            {recs?.length>0 && (
              <div style={{marginTop:12}}>
                <h4>Recomendaciones</h4>
                <ul>
                  {recs.map((r,i)=>(<li key={i} className="small">{r}</li>))}
                </ul>
              </div>
            )}
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
function stdArr(a,m){ const v = varArr(a,m); return Math.sqrt(v) }

function clamp(x, lo, hi){ return Math.max(lo, Math.min(hi, x)) }
function mapRange(x, inMin, inMax, outMin, outMax){
  if (inMax===inMin) return outMin
  const t = (x-inMin)/(inMax-inMin)
  return outMin + clamp(t,0,1)*(outMax-outMin)
}

// ---- Chart drawing & interaction ----
function drawChart(canvas, series, spikesIdx, areaSeries){
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  const W = canvas.width, H = canvas.height
  ctx.clearRect(0,0,W,H)
  ctx.fillStyle = '#0b0b0f'; ctx.fillRect(0,0,W,H)

  // grid
  ctx.strokeStyle = '#384152'; ctx.lineWidth = 1
  for (let i=0;i<=4;i++){ const y = Math.round(i*H/4); ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke() }

  // extract series
  const xs = series.map(p=>p.t), ys = series.map(p=>p.jets)
  if (xs.length<2) return
  const x0 = xs[0], x1 = xs[xs.length-1]
  const yMax = Math.max(2, ...ys)

  // area overlay (normalized)
  const aMax = Math.max(1, ...areaSeries)
  ctx.strokeStyle = '#6b7280'; ctx.lineWidth = 1.5; ctx.setLineDash([4,4])
  ctx.beginPath()
  for (let i=0;i<series.length;i++){
    const x = ((xs[i]-x0)/(x1-x0))*W
    const y = H - ((areaSeries[i]/aMax)*H)
    if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y)
  }
  ctx.stroke()
  ctx.setLineDash([])

  // jets line
  ctx.strokeStyle = '#60a5fa'; ctx.lineWidth = 2
  ctx.beginPath()
  for (let i=0;i<series.length;i++){
    const x = ((xs[i]-x0)/(x1-x0))*W
    const y = H - (ys[i]/yMax)*H
    if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y)
  }
  ctx.stroke()

  // spikes markers
  ctx.fillStyle = '#f87171'
  for (const i of spikesIdx){
    const x = ((xs[i]-x0)/(x1-x0))*W
    const y = H - (ys[i]/yMax)*H
    drawMarker(ctx, x, y)
  }

  // axes labels (minimal)
  ctx.fillStyle = '#a1a1aa'
  ctx.font = '12px ui-sans-serif'
  ctx.fillText('0s', 2, H-4)
  ctx.fillText((x1-x0).toFixed(1)+'s', W-40, H-4)
}
function drawMarker(ctx, x, y){
  const r = 4
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI*2)
  ctx.fill()
}
function attachChartClick(canvas, series, onJump){
  if (!canvas || !series?.length) return
  const xs = series.map(p=>p.t)
  const x0 = xs[0], x1 = xs[xs.length-1]
  const handler = (e)=>{
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const t = x / rect.width * (x1-x0) + x0
    onJump && onJump(t)
  }
  canvas.onclick = handler
}

// ---- Recommendations based on metrics ----
function generateRecommendations(m){
  const recs = []
  const dur = m.duration || 30
  const thirds = dur/3
  // Early, mid, late spikes
  const earlySpikes = m.series.filter(p=>p.spike && p.t<thirds).length
  const midSpikes = m.series.filter(p=>p.spike && p.t>=thirds && p.t<2*thirds).length
  const lateSpikes = m.series.filter(p=>p.spike && p.t>=2*thirds).length

  if (earlySpikes>0) recs.push("Picos tempranos: mejora distribución (WDT profundo), nivela y prueba preinfusión más suave/larga.")
  if (midSpikes>0) recs.push("Picos a mitad del tiro: revisa consistencia del flujo/presión; considera reducir caudal o suavizar la rampa.")
  if (lateSpikes>0) recs.push("Picos al final: probablemente rendimientos decrecientes; evalúa cortar antes o bajar ratio.")

  if (m.jets_cv > 0.5 && m.spikeRate < 0.05) recs.push("Alta variabilidad sin muchos picos: añade puck screen o filtro de papel para estabilizar el frente de extracción.")
  if (m.areaJumpRate > 0.10) recs.push("Saltos grandes de área: sprays/fines → afina molienda un poco o mejora WDT para reducir conglomerados.")
  if (m.score >= 70) recs.push("Score elevado: prueba secuencia de control (WDT → PI suave → presión estable) y vuelve a medir.")

  if (recs.length===0) recs.push("Flujo estable: conserva receta y técnica; puedes buscar mejoras finas en dulzor ajustando temperatura o ratio.")
  return recs
}

export default App
