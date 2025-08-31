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

  // —— NUEVO: inputs PRE-ANÁLISIS para estimar flujo ——
  const [useFlowEst, setUseFlowEst] = useState(true)
  const [dose, setDose] = useState('')
  const [output, setOutput] = useState('')          // bebida final (g)
  const [tds, setTds] = useState('')
  const [balance, setBalance] = useState(5)         // 1..10
  const [notes, setNotes] = useState('')
  const [tStart, setTStart] = useState('')          // s (opcional)
  const [tEnd, setTEnd] = useState('')              // s (opcional)

  // Historial (localStorage)
  const [history, setHistory] = useState([])

  // Panel de inspección al hacer click en el gráfico
  const [inspect, setInspect] = useState(null) // {t, jets, flows[], gini, maxShare}

  const drawState = useRef({dragging:false,start:null})

  useEffect(() => {
    (async () => {
      await waitForOpenCV()
      setCvReady(true)
      setStatus("OpenCV listo. Sube tu video, define inputs (si deseas flujo) y analiza.")
    })().catch(err => setStatus("Error cargando OpenCV: " + err?.message))
  }, [])

  useEffect(() => {
    // cargar historial de localStorage
    try {
      const raw = localStorage.getItem('espressoHistory')
      if (raw) setHistory(JSON.parse(raw))
    } catch {}
  }, [])

  const onVideoFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const url = URL.createObjectURL(file)
    setVideoURL(url)
    setFrameLoaded(false)
    setRoi(null)
    setMetrics(null)
    setInspect(null)
    setRecs([])
    setStatus("Cargando video...")
    setTimeout(async ()=>{
      try {
        const v = videoRef.current
        if (!v) return
        await ensureReady(v)
        setStatus("Video listo. (Opcional) 'Tomar cuadro' para dibujar ROI, o 'Analizar'.")
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

  // ------- EY (para historial) -------
  const EY = computeEY(dose, output, tds) // en %, o null si incompleto

  // ------- Validación de inputs previos -------
  const flowInputsOK = () => {
    if (!useFlowEst) return true
    const out = parseFloat(output)
    if (!Number.isFinite(out) || out <= 0) return false
    // tStart/tEnd son opcionales; si ambos están, deben ser válidos
    const ts = parseFloat(tStart)
    const te = parseFloat(tEnd)
    if (Number.isFinite(ts) && Number.isFinite(te)) {
      if (te <= ts) return false
    }
    return true
  }

  const runAnalysis = async () => {
    if (!cvReady) return
    if (!flowInputsOK()) {
      setStatus("Completa los inputs: bebida final (>0 g) y/o revisa la ventana de tiempo.")
      return
    }
    const cv = window.cv
    const video = videoRef.current
    if (!video) { setStatus("Sube un video primero."); return }
    await ensureReady(video)

    setProcessing(true)
    setInspect(null)
    setStatus("Analizando video…")

    // Ventana de análisis
    let startSec = 0
    let endSec = video.duration
    const ts = parseFloat(tStart), te = parseFloat(tEnd)
    if (Number.isFinite(ts)) startSec = clamp(ts, 0, video.duration)
    if (Number.isFinite(te)) endSec = clamp(te, 0, video.duration)
    if (endSec <= startSec) { startSec = 0; endSec = video.duration } // fallback

    const extractionDuration = Math.max(0.1, endSec - startSec)
    const avgFlow_gps = (useFlowEst && parseFloat(output)>0)
      ? (parseFloat(output) / extractionDuration)
      : null

    const W = Math.round(video.videoWidth * scale)
    const H = Math.round(video.videoHeight * scale)
    const tmp = document.createElement('canvas'); tmp.width=W; tmp.height=H
    const ctx = tmp.getContext('2d')

    const r = roi ? roiRectScaled(roi, scale) : {x:0,y:0,w:W,h:H}
    const perFrame = []
    let lastArea = null

    const FPS = 10
    for (let t=startSec; t<=endSec; t+=1.0/FPS) {
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

      // Áreas por componente (chorro)
      const areas = componentAreasCC(m, 35) // píxeles
      const jets = areas.length
      const area = areas.reduce((a,b)=>a+b,0)

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

      // Estimación de flujo por chorro (g/s) proporcional al área
      let flowPerJet = null, gini = null, maxShare = null
      if (avgFlow_gps !== null && area > 0) {
        const shares = areas.map(a => a/area)
        flowPerJet = shares.map(s => s*avgFlow_gps)
        gini = giniCoefficient(flowPerJet)
        maxShare = Math.max(...shares)
      }

      perFrame.push({ t: t - startSec, jets, area, spike, areaJump, gini, maxShare })

      // Overlay preview (cada 3 frames)
      if ((perFrame.length % 3) === 0) {
        const out = canvasRef.current
        out.width = W; out.height = H
        const octx = out.getContext('2d')
        octx.drawImage(tmp, 0, 0)
        if (roi) drawRect(octx, r, '#60a5fa')
        drawMaskContours(octx, m, r.x, r.y, '#60a5fa')
        const pct = Math.round(100*((t-startSec)/(endSec-startSec)))
        setStatus(`Procesando… ${isFinite(pct)?pct:0}%`)
      }

      frame.delete(); A.delete(); g.delete(); m.delete(); kernel.delete()
    }

    // Métricas (suaves)
    const jetsSeries = perFrame.map(p=>p.jets)
    const areaSeries = perFrame.map(p=>p.area)
    const spikesIdx = perFrame.map((p,i)=> p.spike? i : -1).filter(i=>i>=0)
    const areaJumpIdx = perFrame.map((p,i)=> p.areaJump? i : -1).filter(i=>i>=0)

    const mean = meanArr(jetsSeries)
    const sd = stdArr(jetsSeries, mean)
    const cvJets = mean>0 ? sd/mean : 0 // coeficiente de variación
    const spikeRate = perFrame.length>0 ? (spikesIdx.length/perFrame.length) : 0
    const areaJumpRate = perFrame.length>0 ? (areaJumpIdx.length/perFrame.length) : 0

    // Gini y cuota máxima (medianas) si hubo estimación de flujo
    const giniMed = median(perFrame.map(p => p.gini).filter(x=>x!==null))
    const maxShareMed = median(perFrame.map(p => p.maxShare).filter(x=>x!==null))

    // Score 0..100 suave
    const sCV = clamp(mapRange(cvJets, 0, 1.0, 0, 50), 0, 50)
    const sSp = clamp(mapRange(spikeRate, 0, 0.30, 0, 35), 0, 35)
    const sAJ = clamp(mapRange(areaJumpRate, 0, 0.20, 0, 15), 0, 15)
    const score = Math.round(sCV + sSp + sAJ)

    const mtr = { 
      frames: perFrame.length, duration: (endSec - startSec),
      jets_mean: mean, jets_sd: sd, jets_cv: cvJets, 
      spikes: spikesIdx.length, areaJumps: areaJumpIdx.length, 
      spikeRate, areaJumpRate, score, 
      series: perFrame, spikesIdx, areaJumpIdx,
      avgFlow_gps: avgFlow_gps, giniMed: giniMed, maxShareMed: maxShareMed
    }
    setMetrics(mtr)
    setStatus("Listo ✅. Revisa indicadores, guarda y exporta.")
    drawChart(chartRef.current, perFrame, spikesIdx, areaSeries)
    setRecs(generateRecommendations(mtr))
    setProcessing(false)

    // click en chart → saltar y calcular detalle de flujos en ese frame
    attachChartClick(chartRef.current, perFrame, async (tRel)=>{
      const tAbs = startSec + tRel
      await seekTo(videoRef.current, tAbs)
      const detail = await computeFlowDetailAt(videoRef.current, roi, scale, avgFlow_gps)
      setInspect(detail) // {t, jets, flows[], gini, maxShare}
      // y pinto overlay de ese frame
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

  // ------- Guardar experimento (historial) -------
  const saveExperiment = () => {
    if (!metrics) return
    const exp = {
      id: Date.now(),
      timestamp: new Date().toISOString(),
      dose: parseFloatOrNull(dose),
      output: parseFloatOrNull(output),
      tds: parseFloatOrNull(tds),
      ey: EY !== null ? round2(EY) : null,
      balance: Number(balance) || null,
      notes: (notes || '').trim() || null,
      // resumen de métricas
      score: metrics.score,
      jets_mean: round2(metrics.jets_mean),
      jets_cv: round2(metrics.jets_cv),
      spikeRate: round2(metrics.spikeRate*100),    // %
      areaJumpRate: round2(metrics.areaJumpRate*100), // %
      duration: round2(metrics.duration),
      frames: metrics.frames,
      avgFlow_gps: metrics.avgFlow_gps !== null ? round3(metrics.avgFlow_gps) : null,
      giniMed: metrics.giniMed !== null ? round3(metrics.giniMed) : null,
      maxShareMed: metrics.maxShareMed !== null ? round3(metrics.maxShareMed) : null
    }
    const next = [exp, ...history]
    setHistory(next)
    try { localStorage.setItem('espressoHistory', JSON.stringify(next)) } catch {}
  }

  const deleteExperiment = (id) => {
    const next = history.filter(x => x.id !== id)
    setHistory(next)
    try { localStorage.setItem('espressoHistory', JSON.stringify(next)) } catch {}
  }
  const clearHistory = () => {
    setHistory([])
    try { localStorage.removeItem('espressoHistory') } catch {}
  }
  const exportHistoryCSV = () => {
    const header = "timestamp,dose_g,output_g,tds_pct,ey_pct,balance,notes,score,jets_mean,jets_cv,spike_rate_pct,area_jump_rate_pct,duration_s,frames,avg_flow_gps,gini_med,max_share_med\n"
    const rows = history.map(h => [
      h.timestamp, val(h.dose), val(h.output), val(h.tds), val(h.ey), val(h.balance), csvSafe(h.notes),
      h.score, h.jets_mean, h.jets_cv, h.spikeRate, h.areaJumpRate, h.duration, h.frames,
      val(h.avgFlow_gps), val(h.giniMed), val(h.maxShareMed)
    ].join(",")).join("\n")
    const blob = new Blob([header + rows], {type:'text/csv'})
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href=url; a.download='espresso_history.csv'; document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
  }

  // ------- CSV de métricas del tiro actual -------
  const exportShotCSV = () => {
    if (!metrics) return
    const header = "t_sec,jets,area,spike,areaJump,gini,maxShare\n"
    const rows = metrics.series.map(p=>[
      p.t.toFixed(3), p.jets, p.area, p.spike, p.areaJump,
      p.gini!=null? round3(p.gini):'', p.maxShare!=null? round3(p.maxShare):''
    ].join(",")).join("\n")
    const blob = new Blob([header+rows], {type:'text/csv'})
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href=url; a.download='espresso_flow_metrics.csv'
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
  }

  const canAnalyze = !!videoURL && (!useFlowEst || flowInputsOK())

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
            onLoadedMetadata={()=>setStatus("Video cargado. Define inputs debajo y/o 'Tomar cuadro' para dibujar ROI.")}
          />
        )}
      </div>

      {/* 2) Pre-análisis: inputs para estimar flujo */}
      <div className="card" style={{marginBottom:16}}>
        <h3>2) Pre-análisis (opcional): estimar flujo</h3>
        <label className="small" style={{display:'flex', alignItems:'center', gap:8}}>
          <input type="checkbox" checked={useFlowEst} onChange={e=>setUseFlowEst(e.target.checked)} />
          Usar estimación de flujo (g/s) a partir de bebida final y ventana de extracción
        </label>
        <div className="row" style={{gap:12, marginTop:8}}>
          <div>
            <label className="small muted">Bebida final (g) *</label>
            <input className="pill" style={{display:'block', padding:'8px'}} type="number" min="0" step="0.1" value={output} onChange={e=>setOutput(e.target.value)} disabled={!useFlowEst}/>
          </div>
          <div>
            <label className="small muted">Inicio extracción (s)</label>
            <input className="pill" style={{display:'block', padding:'8px'}} type="number" min="0" step="0.1" value={tStart} onChange={e=>setTStart(e.target.value)} disabled={!useFlowEst}/>
          </div>
          <div>
            <label className="small muted">Fin extracción (s)</label>
            <input className="pill" style={{display:'block', padding:'8px'}} type="number" min="0" step="0.1" value={tEnd} onChange={e=>setTEnd(e.target.value)} disabled={!useFlowEst}/>
          </div>
        </div>
        <p className="small muted" style={{marginTop:6}}>
          * Obligatorio si esta opción está activada. Si no defines inicio/fin, se usa toda la duración del video.
        </p>
      </div>

      {/* 3) ROI (opcional) */}
      <div className="card" style={{marginBottom:16}}>
        <h3>3) (Opcional) Define ROI y escala</h3>
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
          <button className="btn secondary" onClick={grabFrame} disabled={!videoURL}>Tomar cuadro</button>
        </div>
      </div>

      {/* 4) Analizar */}
      <div className="card" style={{marginBottom:16}}>
        <h3>4) Analizar</h3>
        <div className="row" style={{gap:8}}>
          <button className="btn" disabled={processing || !canAnalyze} onClick={runAnalysis}>Iniciar análisis</button>
          <button className="btn secondary" disabled={!metrics} onClick={exportShotCSV}>Exportar CSV (tiro)</button>
        </div>
        {!canAnalyze && <p className="small warn" style={{marginTop:6}}>Completa los inputs requeridos para la estimación de flujo.</p>}
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
              <div className="item"><div className="small muted">Flujo medio</div><div>{metrics.avgFlow_gps!=null? `${metrics.avgFlow_gps.toFixed(3)} g/s` : '—'}</div></div>
              <div className="item"><div className="small muted">Gini flujo (med)</div><div>{metrics.giniMed!=null? metrics.giniMed.toFixed(3) : '—'}</div></div>
              <div className="item"><div className="small muted">Máx cuota (med)</div><div>{metrics.maxShareMed!=null? (metrics.maxShareMed*100).toFixed(1)+'%' : '—'}</div></div>
            </div>
            <div style={{marginTop:12}}>
              <h4>Serie temporal: chorros (línea) + <span style={{color:'#f87171'}}>spikes</span> (marcas)</h4>
              <canvas ref={chartRef} width={900} height={200} style={{width:'100%', border:'1px solid #232339', borderRadius:'8px', cursor:'pointer'}} title="Haz clic para saltar a ese tiempo" />
              <p className="small muted">Clic en el gráfico para saltar al frame y ver detalle de flujos estimados.</p>
            </div>

            {/* Detalle del frame clicado */}
            {inspect && (
              <div className="card" style={{marginTop:12}}>
                <h4>Detalle en t = {inspect.t.toFixed(2)} s</h4>
                <p className="small muted">Chorros detectados: {inspect.jets}. Flujo total estimado: {metrics.avgFlow_gps!=null? `${metrics.avgFlow_gps.toFixed(3)} g/s`:'—'}</p>
                {inspect.flows ? (
                  <ol className="small">
                    {inspect.flows.slice(0,5).map((f,i)=>(
                      <li key={i}>Chorro #{i+1}: {f.toFixed(3)} g/s</li>
                    ))}
                  </ol>
                ) : <p className="small">No hay estimación de flujo (no activaste la opción o la bebida final = 0).</p>}
                <p className="small muted">Gini: {inspect.gini!=null? inspect.gini.toFixed(3):'—'} · Máx cuota: {inspect.maxShare!=null? (inspect.maxShare*100).toFixed(1)+'%':'—'}</p>
              </div>
            )}

            {/* 5) Datos opcionales + Guardar */}
            <div className="card" style={{marginTop:16}}>
              <h3>5) Datos opcionales y guardar experimento</h3>
              <div className="row" style={{gap:12}}>
                <div>
                  <label className="small muted">Dosis (g)</label>
                  <input className="pill" style={{display:'block', padding:'8px'}} type="number" min="0" step="0.1" value={dose} onChange={e=>setDose(e.target.value)} />
                </div>
                <div>
                  <label className="small muted">Salida (g/ml)</label>
                  <input className="pill" style={{display:'block', padding:'8px'}} type="number" min="0" step="0.1" value={output} onChange={e=>setOutput(e.target.value)} />
                </div>
                <div>
                  <label className="small muted">TDS (%)</label>
                  <input className="pill" style={{display:'block', padding:'8px'}} type="number" min="0" step="0.01" value={tds} onChange={e=>setTds(e.target.value)} />
                </div>
                <div>
                  <label className="small muted">EY (%)</label>
                  <div className="pill" style={{padding:'8px'}}>{EY!==null ? EY.toFixed(2) : '—'}</div>
                </div>
                <div>
                  <label className="small muted">Balance sensorial (1–10)</label>
                  <input className="pill" style={{display:'block', padding:'8px'}} type="range" min="1" max="10" value={balance} onChange={e=>setBalance(e.target.value)} />
                  <div className="small muted" style={{marginTop:4}}>Valor: {balance}</div>
                </div>
              </div>
              <div style={{marginTop:8}}>
                <label className="small muted">Notas</label>
                <textarea className="pill" style={{width:'100%', minHeight:70, padding:'8px'}} value={notes} onChange={e=>setNotes(e.target.value)} placeholder="Aroma, dulzor, acidez, textura, aftertaste, etc."/>
              </div>
              <div className="row" style={{marginTop:12, gap:8}}>
                <button className="btn" onClick={saveExperiment}>Guardar experimento</button>
                <button className="btn secondary" onClick={exportHistoryCSV} disabled={!history.length}>Exportar CSV (historial)</button>
              </div>
              {recs?.length>0 && (
                <div style={{marginTop:12}}>
                  <h4>Recomendaciones</h4>
                  <ul>
                    {recs.map((r,i)=>(<li key={i} className="small">{r}</li>))}
                  </ul>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Historial */}
      <div className="card" style={{marginBottom:16}}>
        <h3>Historial</h3>
        <div className="row" style={{gap:8, marginBottom:8}}>
          <button className="btn secondary" onClick={exportHistoryCSV} disabled={!history.length}>Exportar CSV (historial)</button>
          <button className="btn secondary" onClick={clearHistory} disabled={!history.length}>Borrar todo</button>
        </div>
        {!history.length ? (
          <p className="small muted">Aún no has guardado experimentos. Tras analizar, completa (opcional) los datos y pulsa “Guardar experimento”.</p>
        ) : (
          <div style={{overflowX:'auto'}}>
            <table style={{width:'100%', borderCollapse:'collapse'}}>
              <thead>
                <tr className="small">
                  <th style={th}>Fecha/Hora</th>
                  <th style={th}>Dosis (g)</th>
                  <th style={th}>Salida</th>
                  <th style={th}>TDS (%)</th>
                  <th style={th}>EY (%)</th>
                  <th style={th}>Score</th>
                  <th style={th}>Jets μ</th>
                  <th style={th}>Jets CV</th>
                  <th style={th}>Spike %</th>
                  <th style={th}>AreaJump %</th>
                  <th style={th}>Flujo (g/s)</th>
                  <th style={th}>Gini med</th>
                  <th style={th}>Max cuota med</th>
                  <th style={th}>Notas</th>
                  <th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {history.map(h=>(
                  <tr key={h.id} className="small" style={{borderTop:'1px solid #232339'}}>
                    <td style={td}>{fmtDate(h.timestamp)}</td>
                    <td style={td}>{val(h.dose)}</td>
                    <td style={td}>{val(h.output)}</td>
                    <td style={td}>{val(h.tds)}</td>
                    <td style={td}>{val(h.ey)}</td>
                    <td style={td}>{h.score}</td>
                    <td style={td}>{h.jets_mean}</td>
                    <td style={td}>{h.jets_cv}</td>
                    <td style={td}>{h.spikeRate}</td>
                    <td style={td}>{h.areaJumpRate}</td>
                    <td style={td}>{val(h.avgFlow_gps)}</td>
                    <td style={td}>{val(h.giniMed)}</td>
                    <td style={td}>{val(h.maxShareMed)}</td>
                    <td style={{...td, maxWidth:240, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}} title={h.notes||''}>{h.notes||'—'}</td>
                    <td style={td}><button className="btn secondary" onClick={()=>deleteExperiment(h.id)}>Borrar</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------- table cell styles ----------
const th = { textAlign:'left', padding:'8px 6px', borderBottom:'1px solid #232339', color:'#9aa0b3' }
const td = { padding:'8px 6px' }

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
function componentAreasCC(maskMat, minArea=35){
  const cv = window.cv
  let labels = new cv.Mat(), stats = new cv.Mat(), centroids = new cv.Mat()
  const n = cv.connectedComponentsWithStats(maskMat, labels, stats, centroids, 8, cv.CV_32S)
  const areas = []
  for(let i=1;i<n;i++){ // 0 es background
    const a = stats.intAt(i, cv.CC_STAT_AREA)
    if (a >= minArea) areas.push(a)
  }
  labels.delete(); stats.delete(); centroids.delete()
  return areas
}
function meanArr(a){ return a.length? a.reduce((x,y)=>x+y,0)/a.length : 0 }
function varArr(a,m){ return a.length? a.reduce((x,y)=>x+(y-m)*(y-m),0)/a.length : 0 }
function stdArr(a,m){ const v = varArr(a,m); return Math.sqrt(v) }
function median(arr){
  if (!arr || !arr.length) return null
  const a = [...arr].sort((x,y)=>x-y)
  const n = a.length
  return n%2? a[(n-1)/2] : (a[n/2-1]+a[n/2])/2
}
function clamp(x, lo, hi){ return Math.max(lo, Math.min(hi, x)) }
function mapRange(x, inMin, inMax, outMin, outMax){
  if (inMax===inMin) return outMin
  const t = (x-inMin)/(inMax-inMin)
  return outMin + clamp(t,0,1)*(outMax-outMin)
}
function parseFloatOrNull(v){ const n = parseFloat(v); return Number.isFinite(n) ? n : null }
function round2(x){ return Math.round((x + Number.EPSILON)*100)/100 }
function round3(x){ return Math.round((x + Number.EPSILON)*1000)/1000 }
function fmtDate(iso){ try{ return new Date(iso).toLocaleString() } catch{ return iso } }
function val(v){ return (v===null || v===undefined || v==='') ? '—' : v }
function csvSafe(s){ if (!s) return ''; const q = String(s).replace(/"/g,'""'); return `"${q}"` }
function computeEY(dose, output, tds){
  const d = parseFloat(dose), o = parseFloat(output), t = parseFloat(tds)
  if (!Number.isFinite(d) || d<=0 || !Number.isFinite(o) || o<0 || !Number.isFinite(t) || t<0) return null
  // EY% = (TDS% * beverage_mass) / dose
  return (t * o) / d
}
function giniCoefficient(values){
  if (!values || !values.length) return 0
  const x = values.slice().sort((a,b)=>a-b)
  const n = x.length
  const sum = x.reduce((a,b)=>a+b,0)
  if (sum === 0) return 0
  let cum = 0
  for (let i=0;i<n;i++){
    cum += (2*(i+1)-n-1) * x[i]
  }
  return cum / (n * sum)
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

// ---- Recompute flow detail at time t ----
async function computeFlowDetailAt(video, roi, scale, avgFlow_gps){
  const W = Math.round(video.videoWidth * scale)
  const H = Math.round(video.videoHeight * scale)
  const tmp = document.createElement('canvas'); tmp.width=W; tmp.height=H
  const ctx = tmp.getContext('2d')
  ctx.drawImage(video, 0, 0, W, H)
  const cv = window.cv
  const frame = cv.imread(tmp)
  const r = roi ? roiRectScaled(roi, scale) : {x:0,y:0,w:W,h:H}
  let A = frame.roi(new cv.Rect(r.x, r.y, r.w, r.h))
  let g = new cv.Mat(); cv.cvtColor(A, g, cv.COLOR_RGBA2GRAY)
  cv.GaussianBlur(g, g, new cv.Size(3,3), 0)
  let m = new cv.Mat()
  cv.adaptiveThreshold(g, m, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 21, 5)
  let kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3,3))
  cv.morphologyEx(m, m, cv.MORPH_OPEN, kernel)

  const areas = componentAreasCC(m, 35)
  const jets = areas.length
  let flows = null, gini = null, maxShare = null
  if (avgFlow_gps!=null && areas.length>0){
    const sumA = areas.reduce((a,b)=>a+b,0)
    const shares = areas.map(a=>a/sumA)
    flows = shares.map(s=>s*avgFlow_gps)
    gini = giniCoefficient(flows)
    maxShare = Math.max(...shares)
  }

  frame.delete(); A.delete(); g.delete(); m.delete(); kernel.delete()
  return { t: video.currentTime, jets, flows, gini, maxShare }
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
  if (m.avgFlow_gps!=null){
    if (m.giniMed!=null && m.giniMed>0.3) recs.push("Distribución de flujo desigual (Gini>0.3): revisa WDT y nivelado; considera preinfusión más larga.")
    if (m.maxShareMed!=null && m.maxShareMed>0.45) recs.push("Un chorro concentra gran parte del flujo: posible canal dominante; prueba reducir presión o flow-control al inicio.")
  }
  if (m.score >= 70) recs.push("Score elevado: prueba secuencia de control (WDT → PI suave → presión estable) y vuelve a medir.")

  if (recs.length===0) recs.push("Flujo estable: conserva receta y técnica; afina por sabor (temperatura/ratio) para mejorar dulzor y balance.")
  return recs
}

export default App
