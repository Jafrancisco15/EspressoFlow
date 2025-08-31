import React, { useEffect, useRef, useState } from 'react'

const waitForOpenCV = () =>
  new Promise(resolve => {
    const check = () => {
      if (window.cv && window.cv.Mat) resolve()
      else setTimeout(check, 100)
    }
    check()
  })

function App() {
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const chartRef = useRef(null)

  const [videoURL, setVideoURL] = useState(null)
  const [frameLoaded, setFrameLoaded] = useState(false)
  const [status, setStatus] = useState("Cargando OpenCV...")
  const [cvReady, setCvReady] = useState(false)

  const [roiA, setRoiA] = useState(null)
  const [roiB, setRoiB] = useState(null)
  const [activeRoi, setActiveRoi] = useState('A')

  const [ptsA, setPtsA] = useState([])
  const [ptsB, setPtsB] = useState([])

  const [scale, setScale] = useState(0.6)
  const [processing, setProcessing] = useState(false)
  const [metrics, setMetrics] = useState(null)

  const drawState = useRef({dragging:false,start:null})

  useEffect(() => {
    (async () => {
      await waitForOpenCV()
      setCvReady(true)
      setStatus("OpenCV listo. Sube tu video y toma un cuadro para configurar.")
    })()
  }, [])

  const onVideoFile = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const url = URL.createObjectURL(file)
    setVideoURL(url)
    setFrameLoaded(false)
    setRoiA(null); setRoiB(null)
    setPtsA([]); setPtsB([])
    setMetrics(null)
  }

  const grabFrame = async () => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return
    try { video.currentTime = Math.min(5, video.duration * 0.25) } catch(e) {}
    setTimeout(() => {
      const w = Math.min(960, video.videoWidth)
      const h = Math.round(video.videoHeight * (w / video.videoWidth))
      canvas.width = w; canvas.height = h
      const ctx = canvas.getContext('2d')
      ctx.drawImage(video, 0, 0, w, h)
      setFrameLoaded(true)
      setStatus("Elige dos regiones: Vista Directa (A) y Vista en Espejo (B). Añade puntos de calibración correspondientes.")
    }, 300)
  }

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
    if (roiA) drawRect(ctx, roiA, '#60a5fa')
    if (roiB) drawRect(ctx, roiB, '#34d399')
    const s = drawState.current.start
    const roi = normRect({x1:s.x,y1:s.y,x2:x,y2:y})
    drawRect(ctx, roi, activeRoi==='A' ? '#60a5fa' : '#34d399')
  }
  const onCanvasMouseUp = (e) => {
    if (!drawState.current.dragging) return
    drawState.current.dragging=false
    const rect = e.target.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const s = drawState.current.start
    const roi = normRect({x1:s.x,y1:s.y,x2:x,y2:y})
    if (activeRoi==='A') setRoiA(roi)
    else setRoiB(roi)
  }
  const onCanvasClick = (e) => {
    if (!frameLoaded || !(roiA && roiB)) return
    const rect = e.target.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    if (pointInRect(x,y,roiA)) {
      const p = {x: x - roiA.x, y: y - roiA.y}
      setPtsA(prev => [...prev, p])
    } else if (pointInRect(x,y,roiB)) {
      const p = {x: x - roiB.x, y: y - roiB.y}
      setPtsB(prev => [...prev, p])
    }
    drawOverlay()
  }

  useEffect(()=>{ if(frameLoaded) drawOverlay() }, [roiA, roiB, ptsA, ptsB, frameLoaded])

  const drawOverlay = () => {
    const canvas = canvasRef.current, video = videoRef.current
    if (!canvas || !video) return
    const ctx = canvas.getContext('2d')
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    if (roiA) drawRect(ctx, roiA, '#60a5fa')
    if (roiB) drawRect(ctx, roiB, '#34d399')
    if (roiA) {
      ctx.strokeStyle='#60a5fa'; ctx.fillStyle='#60a5fa'
      ptsA.forEach((p,i)=> drawPoint(ctx, p.x + roiA.x, p.y + roiA.y, i))
    }
    if (roiB) {
      ctx.strokeStyle='#34d399'; ctx.fillStyle='#34d399'
      ptsB.forEach((p,i)=> drawPoint(ctx, p.x + roiB.x, p.y + roiB.y, i))
    }
  }

  const runAnalysis = async () => {
    if (!cvReady) return
    if (!(roiA && roiB)) { setStatus("Selecciona las dos ROIs (A y B)."); return }
    if (ptsA.length < 6 || ptsB.length < 6 || ptsA.length!==ptsB.length) {
      setStatus("Agrega ≥6 puntos correspondientes y en el mismo orden en A y B."); return
    }
    setProcessing(true); setStatus("Rectificando vistas y analizando...")

    const cv = window.cv
    // Build point mats
    const matA = cv.matFromArray(ptsA.length, 1, cv.CV_32FC2, ptsA.flatMap(p=>[p.x,p.y]))
    const matB = cv.matFromArray(ptsB.length, 1, cv.CV_32FC2, ptsB.flatMap(p=>[p.x,p.y]))
    const F = new cv.Mat(), mask = new cv.Mat()
    cv.findFundamentalMat(matA, matB, F, cv.FM_RANSAC, 3.0, 0.99, mask)

    // Try stereoRectifyUncalibrated
    const imgSize = new cv.Size(Math.round(roiA.w*scale), Math.round(roiA.h*scale))
    const H1 = new cv.Mat(), H2 = new cv.Mat()
    try {
      const ok = cv.stereoRectifyUncalibrated(matA, matB, F, imgSize, H1, H2)
      if (!ok) { console.warn("Rectification failed; proceeding without it.") }
    } catch (e) {
      console.warn("stereoRectifyUncalibrated not available; proceeding without rectification.", e)
    }

    const video = videoRef.current
    const W = Math.round(video.videoWidth * scale)
    const H = Math.round(video.videoHeight * scale)
    const tmp = document.createElement('canvas'); tmp.width=W; tmp.height=H
    const ctx = tmp.getContext('2d')

    const perFrame = []
    let lastArea = null
    const duration = video.duration
    video.currentTime = 0.0
    const FPS = 10, dt = 1.0/FPS

    const loop = () => {
      if (video.currentTime >= duration) { finish(); return }
      ctx.drawImage(video, 0, 0, W, H)
      const frame = cv.imread(tmp)

      const rA = roiRectScaled(roiA, scale), rB = roiRectScaled(roiB, scale)
      let A = frame.roi(new cv.Rect(rA.x, rA.y, rA.w, rA.h))
      let B = frame.roi(new cv.Rect(rB.x, rB.y, rB.w, rB.h))

      // Rectify if possible (warpPerspective)
      if (H1.data && H2.data && H1.rows>0 && H2.rows>0) {
        let Arect = new cv.Mat(), Brect = new cv.Mat()
        cv.warpPerspective(A, Arect, H1, imgSize, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar())
        cv.warpPerspective(B, Brect, H2, imgSize, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar())
        A.delete(); B.delete(); A = Arect; B = Brect
      }

      // Grayscale + adaptive threshold
      let gA = new cv.Mat(); cv.cvtColor(A, gA, cv.COLOR_RGBA2GRAY)
      let gB = new cv.Mat(); cv.cvtColor(B, gB, cv.COLOR_RGBA2GRAY)
      cv.GaussianBlur(gA, gA, new cv.Size(3,3), 0)
      cv.GaussianBlur(gB, gB, new cv.Size(3,3), 0)
      let mA = new cv.Mat(), mB = new cv.Mat()
      cv.adaptiveThreshold(gA, mA, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 21, 5)
      cv.adaptiveThreshold(gB, mB, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 21, 5)
      let kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3,3))
      cv.morphologyEx(mA, mA, cv.MORPH_OPEN, kernel)
      cv.morphologyEx(mB, mB, cv.MORPH_OPEN, kernel)

      const jetsA = countBlobs(mA), jetsB = countBlobs(mB)
      const jets = Math.max(jetsA, jetsB)
      const areaA = sumArea(mA), areaB = sumArea(mB)
      const area = Math.max(areaA, areaB)

      // Spike detection for jets and area
      let areaJump = 0
      if (lastArea!==null && area>lastArea*1.35) areaJump = 1
      lastArea = area

      // Attempt disparity if StereoBM exists
      let disp = null
      try {
        let sbm = new cv.StereoBM()
        disp = new cv.Mat()
        // Ensure both are 8-bit 1-channel
        sbm.compute(mA, mB, disp)
      } catch(e) {
        // noop
      }

      perFrame.push({ t: video.currentTime, jetsA, jetsB, jets, area, areaJump })

      // Draw overlays
      const out = canvasRef.current
      out.width = W; out.height = H
      const octx = out.getContext('2d')
      octx.drawImage(tmp, 0, 0) // background
      drawRect(octx, rA, '#60a5fa'); drawRect(octx, rB, '#34d399')
      drawMaskContours(octx, mA, rA.x, rA.y, '#60a5fa')
      drawMaskContours(octx, mB, rB.x, rB.y, '#34d399')

      // cleanup
      frame.delete(); A.delete(); B.delete(); gA.delete(); gB.delete(); mA.delete(); mB.delete(); kernel.delete();
      if (disp && disp.delete) disp.delete()

      video.currentTime = Math.min(video.currentTime + dt, duration)
      setStatus(`Procesando… ${Math.round(100*video.currentTime/duration)}%`)
      setTimeout(loop, 0)
    }

    const finish = () => {
      setProcessing(false)
      const jetsSeries = perFrame.map(p=>p.jets)
      const areaSeries = perFrame.map(p=>p.area)
      const mean = meanArr(jetsSeries)
      const variance = varArr(jetsSeries, mean)
      const spikes = jetsSeries.filter((v,i,arr)=> i>0 && v>arr[i-1]+1).length
      const areaJumps = perFrame.reduce((acc,p)=>acc+p.areaJump,0)
      // Canalization score 0..100 (heuristic): weighted spikes + variance + area jumps
      let score = Math.min(100, Math.round( (spikes*10) + (variance*1.5) + (areaJumps*8) ))
      const m = { frames: perFrame.length, duration: videoRef.current.duration, jets_mean: mean, jets_var: variance, spikes, areaJumps, score, series: perFrame }
      setMetrics(m)
      setStatus("Listo ✅. Revisa indicadores y exporta CSV.")
      drawChart(chartRef.current, perFrame)
    }

    loop()
  }

  const exportCSV = () => {
    if (!metrics) return
    const header = "t_sec,jetsA,jetsB,jets,area,areaJump\n"
    const rows = metrics.series.map(p=>[p.t.toFixed(3),p.jetsA,p.jetsB,p.jets,p.area,p.areaJump].join(",")).join("\n")
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
        <h1>☕️ Espresso Flow Vision <span className="badge">Stereo (A + espejo)</span></h1>
        <div className="pill small">OpenCV.js (WASM) • Vite + React</div>
      </div>

      <div className="kpi" style={{margin:'12px 0 18px'}}>
        <div className="item"><div className="small muted">Estado</div><div>{status}</div></div>
        <div className="item"><div className="small muted">OpenCV</div><div>{cvReady ? '✅ listo' : '…'}</div></div>
        <div className="item"><div className="small muted">ROI A/B</div><div>{roiA&&roiB ? '✅' : '—'}</div></div>
        <div className="item"><div className="small muted">Puntos calib.</div><div>{ptsA.length}/{ptsB.length}</div></div>
      </div>

      <div className="card" style={{marginBottom:16}}>
        <h3>1) Sube video (smartphone + espejo)</h3>
        <input type="file" accept="video/*" onChange={onVideoFile}/>
        {videoURL && (
          <video
            ref={videoRef}
            src={videoURL}
            style={{maxWidth:'100%', display:'block', marginTop:8, borderRadius:12, border:'1px solid #232339'}}
            controls
            onLoadedMetadata={()=>setStatus("Video cargado. Presiona 'Tomar cuadro'.")}
          />
        )}
        <div style={{marginTop:8}}>
          <button className="btn" onClick={grabFrame} disabled={!videoURL}>Tomar cuadro</button>
        </div>
        <p className="muted small">Tip: usa portafiltro naked, ring light y fondo neutro. El espejo debe mostrar claramente la base del portafiltro.</p>
      </div>

      <div className="card" style={{marginBottom:16}}>
        <h3>2) Define ROIs y puntos de calibración</h3>
        <div className="row" style={{alignItems:'center'}}>
          <button className="btn secondary" onClick={()=>setActiveRoi('A')}>ROI A (Directa)</button>
          <button className="btn secondary" onClick={()=>setActiveRoi('B')}>ROI B (Espejo)</button>
          <span className="small muted">Dibuja rectángulos en el canvas. Luego haz clic dentro de cada ROI para añadir puntos; <b>agrega los mismos puntos</b> (en el mismo orden) en ambas vistas.</span>
        </div>
        <div style={{marginTop:8}}>
          <canvas
            ref={canvasRef}
            width={960}
            height={540}
            onMouseDown={onCanvasMouseDown}
            onMouseMove={onCanvasMouseMove}
            onMouseUp={onCanvasMouseUp}
            onClick={onCanvasClick}
          />
        </div>
        <div className="row">
          <label>Escala de procesamiento: 
            <input type="range" min="0.3" max="1.0" step="0.1" value={scale} onChange={e=>setScale(parseFloat(e.target.value))} />
            <span className="small muted" style={{marginLeft:8}}>{Math.round(scale*100)}%</span>
          </label>
          <button className="btn" onClick={()=>{setPtsA([]); setPtsB([])}}>Limpiar puntos</button>
          <button className="btn" onClick={()=>{setRoiA(null); setRoiB(null); setPtsA([]); setPtsB([])}}>Reset ROIs</button>
        </div>
      </div>

      <div className="card" style={{marginBottom:16}}>
        <h3>3) Analizar</h3>
        <div className="row">
          <button className="btn" disabled={processing} onClick={runAnalysis}>Iniciar análisis</button>
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
              <p className="small muted">Heurística: curvas suaves y decrecientes indican extracción uniforme; picos y alta varianza suelen implicar canalización o sprays.</p>
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
function pointInRect(x,y,r){ return x>=r.x && y>=r.y && x<=r.x+r.w && y<=r.y+r.h }
function drawRect(ctx,r,color='#60a5fa'){ ctx.save(); ctx.strokeStyle=color; ctx.lineWidth=2; ctx.strokeRect(r.x,r.y,r.w,r.h); ctx.restore() }
function drawPoint(ctx,x,y,i){ ctx.beginPath(); ctx.arc(x,y,4,0,Math.PI*2); ctx.fill(); ctx.font='11px ui-sans-serif'; ctx.fillText(String(i+1), x+6, y-6) }

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
  // Sum of white pixels (approx area of jets)
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
  // grid
  for (let i=0;i<6;i++){ const y = Math.round(i*H/6); ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke() }
  // data
  const xs = series.map(p=>p.t), ys = series.map(p=>p.jets)
  if (xs.length<2) return
  const x0 = xs[0], x1 = xs[xs.length-1]
  const yMax = Math.max(2, ...ys)
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
