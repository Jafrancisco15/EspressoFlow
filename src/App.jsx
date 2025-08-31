import React, { useEffect, useRef, useState } from 'react'

// ---- OpenCV runtime wait ---- const waitForOpenCV = () => new Promise(resolve => { const ready = () => (window.cv && window.cv.Mat) const check = () => { if (ready()) return resolve() if (window.cv && typeof window.cv['onRuntimeInitialized'] === 'function') { const cb = window.cv['onRuntimeInitialized'] window.cv['onRuntimeInitialized'] = () => { try{cb()}catch(e){} resolve() } return } setTimeout(check, 100) } check() })

// ---- video helpers ---- const waitEvent = (el, ev) => new Promise(res => { const h = () => { el.removeEventListener(ev, h); res() } el.addEventListener(ev, h, { once:true }) });

const ensureReady = async (video) => { if (Number.isNaN(video.duration) || !isFinite(video.duration) || video.duration === 0) { await waitEvent(video, 'loadedmetadata'); } if (video.readyState < 2) { // HAVE_CURRENT_DATA await waitEvent(video, 'loadeddata'); } };

const seekTo = async (video, t) => { if (!isFinite(video.duration) || video.duration === 0) { return; } if (t > video.duration) t = video.duration; if (t < 0) t = 0; video.currentTime = t; try { await waitEvent(video, 'seeked'); } catch(e){} };

function App() { const videoRef = useRef(null) const canvasRef = useRef(null) const chartRef = useRef(null)

const [videoURL, setVideoURL] = useState(null) const [frameLoaded, setFrameLoaded] = useState(false) const [status, setStatus] = useState('Cargando OpenCV...') const [cvReady, setCvReady] = useState(false)

// ROI opcional const [roi, setRoi] = useState(null) const [scale, setScale] = useState(0.6)

// Procesamiento / resultados const [processing, setProcessing] = useState(false) const [metrics, setMetrics] = useState(null) const [recs, setRecs] = useState([])

// —— Inputs PRE-ANÁLISIS const [useFlowEst, setUseFlowEst] = useState(true) const [dose, setDose] = useState('') const [output, setOutput] = useState('')          // bebida final (g) const [tds, setTds] = useState('') const [balance, setBalance] = useState(5)         // 1..10 const [notes, setNotes] = useState('')

// —— Sliders de calibración const [spikeDelta, setSpikeDelta] = useState(2) const [spikeMinJets, setSpikeMinJets] = useState(3) const [minBlobArea, setMinBlobArea] = useState(35) const [areaJumpFactor, setAreaJumpFactor] = useState(1.35)

// Historial (localStorage) const [history, setHistory] = useState([])

// Panel de inspección al hacer click en el gráfico const [inspect, setInspect] = useState(null) // {tAbs, tRel, jets, flows[], gini, maxShare}

const drawState = useRef({dragging:false,start:null})

useEffect(() => { (async () => { await waitForOpenCV() setCvReady(true) setStatus('OpenCV listo. Sube tu video, calibra si quieres y analiza.') })().catch(err => setStatus('Error cargando OpenCV: ' + (err?.message||err))) }, [])

useEffect(() => { // cargar historial try { const raw = localStorage.getItem('espressoHistory') if (raw) setHistory(JSON.parse(raw)) } catch {} }, [])

const onVideoFile = async (e) => { const file = e.target.files?.[0] if (!file) return const url = URL.createObjectURL(file) setVideoURL(url) setFrameLoaded(false) setRoi(null) setMetrics(null) setInspect(null) setRecs([]) setStatus('Cargando video...') setTimeout(async ()=>{ try { const v = videoRef.current if (!v) return await ensureReady(v) setStatus("Video listo. (Opcional) 'Tomar cuadro' para dibujar ROI, o 'Analizar'.") } catch (err) { setStatus('No se pudo preparar el video: ' + (err?.message||err)) } }, 50) }

const grabFrame = async () => { const video = videoRef.current const canvas = canvasRef.current if (!video || !canvas) return try { await ensureReady(video) const targetT = Math.min(5, (isFinite(video.duration) ? video.duration * 0.25 : 5)) await seekTo(video, targetT) const w = Math.min(960, video.videoWidth) const h = Math.round(video.videoHeight * (w / video.videoWidth)) canvas.width = w; canvas.height = h const ctx = canvas.getContext('2d') ctx.drawImage(video, 0, 0, w, h) setFrameLoaded(true) setStatus('Dibuja un ROI (opcional). Si no dibujas, se analizará todo el frame.') } catch (e) { setStatus('Error al tomar cuadro: ' + (e?.message||e)) } }

// ---- ROI drawing ---- const onCanvasMouseDown = (e) => { if (!frameLoaded) return const rect = e.target.getBoundingClientRect() const x = e.clientX - rect.left const y = e.clientY - rect.top drawState.current = {dragging:true,start:{x,y}} } const onCanvasMouseMove = (e) => { if (!drawState.current.dragging) return const rect = e.target.getBoundingClientRect() const x = e.clientX - rect.left const y = e.clientY - rect.top const ctx = canvasRef.current.getContext('2d') ctx.drawImage(videoRef.current, 0, 0, canvasRef.current.width, canvasRef.current.height) if (roi) drawRect(ctx, roi, '#60a5fa') const s = drawState.current.start const r = normRect({x1:s.x,y1:s.y,x2:x,y2:y}) drawRect(ctx, r, '#60a5fa') } const onCanvasMouseUp = (e) => { if (!drawState.current.dragging) return drawState.current.dragging=false const rect = e.target.getBoundingClientRect() const x = e.clientX - rect.left const y = e.clientY - rect.top const s = drawState.current.start const r = normRect({x1:s.x,y1:s.y,x2:x,y2:y}) if (r.w >= 10 && r.h >= 10) setRoi(r) }

useEffect(()=>{ if(frameLoaded) drawOverlay() }, [roi, frameLoaded])

const drawOverlay = () => { const canvas = canvasRef.current, video = videoRef.current if (!canvas || !video) return const ctx = canvas.getContext('2d') ctx.drawImage(video, 0, 0, canvas.width, canvas.height) if (roi) drawRect(ctx, roi, '#60a5fa') }

// ------- EY (para historial) ------- const EY = computeEY(dose, output, tds) // en %, o null si incompleto

const runAnalysis = async () => { if (!cvReady) return const cv = window.cv const video = videoRef.current if (!video) { setStatus('Sube un video primero.'); return } await ensureReady(video)

setProcessing(true)
setInspect(null)
setStatus('Analizando video…')

const W = Math.round(video.videoWidth * scale)
const H = Math.round(video.videoHeight * scale)
const tmp = document.createElement('canvas'); tmp.width=W; tmp.height=H
const ctx = tmp.getContext('2d')

const r = roi ? roiRectScaled(roi, scale) : {x:0,y:0,w:W,h:H}
const perFrameFull = [] // serie completa en todo el video (t abs)
let lastArea = null

const FPS = 10
const totalDur = isFinite(video.duration) ? video.duration : 30
for (let t=0; t<=totalDur; t+=1.0/FPS) {
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
  const areas = componentAreasCC(m, minBlobArea)
  const jets = areas.length
  const area = areas.reduce((a,b)=>a+b,0)

  // area jump relativo preliminar (para overlay/progreso)
  let areaJumpFlag = 0
  if (lastArea!==null && area>lastArea*areaJumpFactor) areaJumpFlag = 1
  lastArea = area

  perFrameFull.push({ t, jets, area, areas, areaJumpFlag })

  // Overlay preview (cada 3 frames)
  if ((perFrameFull.length % 3) === 0) {
    const out = canvasRef.current
    out.width = W; out.height = H
    const octx = out.getContext('2d')
    octx.drawImage(tmp, 0, 0)
    if (roi) drawRect(octx, r, '#60a5fa')
    drawMaskContours(octx, m, r.x, r.y, '#60a5fa', minBlobArea)
    const pct = Math.round(100 * (t/Math.max(0.01,totalDur)))
    setStatus(`Procesando… ${pct}%`)
  }

  frame.delete(); A.delete(); g.delete(); m.delete(); kernel.delete()
}

// --- Detectar ventana de flujo automático por umbral relativo de área
const areasAll = perFrameFull.map(p=>p.area)
const maxA = Math.max(1, ...areasAll)
const thr = 0.12 * maxA // 12% del máximo
const K = 3 // frames consecutivos
let startIdx = 0, endIdx = perFrameFull.length - 1
for (let i=0; i<perFrameFull.length-K; i++){
  let ok = true
  for (let k=0;k<K;k++){ if (perFrameFull[i+k].area < thr) { ok=false; break } }
  if (ok){ startIdx = i; break }
}
for (let i=perFrameFull.length-1; i>=K; i--){
  let ok = true
  for (let k=0;k<K;k++){ if (perFrameFull[i-k].area < thr) { ok=false; break } }
  if (ok){ endIdx = i; break }
}
if (endIdx < startIdx) { startIdx = 0; endIdx = perFrameFull.length - 1 }

const startSec = perFrameFull[startIdx]?.t ?? 0
const endSec = perFrameFull[endIdx]?.t ?? totalDur
const extractionDuration = Math.max(0.1, endSec - startSec)

// --- Estimar flujo medio si el usuario dio peso (g)
const avgFlow_gps = (useFlowEst && parseFloat(output)>0)
  ? (parseFloat(output) / extractionDuration)
  : null

// --- Construir serie "activa" (t relativo desde inicio de flujo)
const series = perFrameFull.slice(startIdx, endIdx+1).map((p) => ({
  t: p.t - startSec,
  jets: p.jets,
  area: p.area,
  areas: p.areas // para inspección y gini
}))

// --- Spikes y areaJumps con sliders
const spikesIdx = []
const areaJumpIdx = []
for (let i=0;i<series.length;i++){
  if (i>0){
    if (series[i].jets >= spikeMinJets && (series[i].jets - series[i-1].jets) >= spikeDelta){
      spikesIdx.push(i)
    }
    if (series[i-1].area>0 && series[i].area > series[i-1].area * areaJumpFactor){
      areaJumpIdx.push(i)
    }
  }
}

// Métricas (suaves)
const jetsSeries = series.map(p=>p.jets)
const areaSeries = series.map(p=>p.area)
const mean = meanArr(jetsSeries)
const sd = stdArr(jetsSeries, mean)
const cvJets = mean>0 ? sd/mean : 0
const spikeRate = series.length>0 ? (spikesIdx.length/series.length) : 0
const areaJumpRate = series.length>0 ? (areaJumpIdx.length/series.length) : 0

// Gini y cuota máxima (medianas) si hubo estimación de flujo
let giniMed = null, maxShareMed = null
if (avgFlow_gps!=null){
  const ginis = [], sharesMax = []
  for (const fr of series){
    const A = fr.areas.reduce((a,b)=>a+b,0)
    if (A>0){
      const shares = fr.areas.map(a => a/A)
      const flows = shares.map(s => s*avgFlow_gps)
      ginis.push(giniCoefficient(flows))
      sharesMax.push(Math.max(...shares))
    }
  }
  giniMed = median(ginis)
  maxShareMed = median(sharesMax)
}

// Score 0..100 suave
const sCV = clamp(mapRange(cvJets, 0, 1.0, 0, 50), 0, 50)
const sSp = clamp(mapRange(spikeRate, 0, 0.30, 0, 35), 0, 35)
const sAJ = clamp(mapRange(areaJumpRate, 0, 0.20, 0, 15), 0, 15)
const score = Math.round(sCV + sSp + sAJ)

const mtr = { 
  frames: series.length, duration: extractionDuration,
  jets_mean: mean, jets_sd: sd, jets_cv: cvJets, 
  spikes: spikesIdx.length, areaJumps: areaJumpIdx.length, 
  spikeRate, areaJumpRate, score, 
  series, spikesIdx, areaJumpIdx,
  avgFlow_gps, giniMed, maxShareMed,
  startSec, endSec
}
setMetrics(mtr)
setStatus('Listo ✅. Revisa indicadores, guarda y exporta.')
setRecs(generateRecommendations(mtr))
setProcessing(false)

}

// ---- DIBUJO DEL GRÁFICO (fix: ahora en effect para el primer análisis) useEffect(()=>{ if (!metrics) return const areaSeries = metrics.series.map(p=>p.area) drawChart(chartRef.current, metrics.series, metrics.spikesIdx, areaSeries) // click handler para saltar y mostrar detalle attachChartClick(chartRef.current, metrics.series, async (tRel)=>{ const tAbs = metrics.startSec + tRel await seekTo(videoRef.current, tAbs) const detail = await computeFlowDetailAt(videoRef.current, roi, scale, metrics.avgFlow_gps, minBlobArea) // Reutiliza áreas si existen const idx = findNearestIndex(metrics.series, tRel) if (idx>=0){ const fr = metrics.series[idx] if (metrics.avgFlow_gps!=null && fr.areas?.length){ const sumA = fr.areas.reduce((a,b)=>a+b,0) const flows = sumA>0 ? fr.areas.map(a=>a/sumA*metrics.avgFlow_gps) : null const gini = flows? giniCoefficient(flows): null const maxShare = sumA>0 ? Math.max(...fr.areas.map(a=>a/sumA)) : null setInspect({ tAbs, tRel, jets: fr.jets, flows, gini, maxShare }) } else { setInspect({ tAbs, tRel, jets: detail.jets, flows: detail.flows, gini: detail.gini, maxShare: detail.maxShare }) } } else { setInspect(detail) } // Overlay del frame seleccionado renderOverlayAtCurrent(videoRef.current, roi, scale, minBlobArea) }) }, [metrics])

// ------- Guardar experimento (historial) ------- const saveExperiment = () => { if (!metrics) return const exp = { id: Date.now(), timestamp: new Date().toISOString(), dose: parseFloatOrNull(dose), output: parseFloatOrNull(output), tds: parseFloatOrNull(tds), ey: EY !== null ? round2(EY) : null, balance: Number(balance) || null, notes: (notes || '').trim() || null, // resumen de métricas score: metrics.score, jets_mean: round2(metrics.jets_mean), jets_cv: round2(metrics.jets_cv), spikeRate: round2(metrics.spikeRate100),    // % areaJumpRate: round2(metrics.areaJumpRate100), // % duration: round2(metrics.duration), frames: metrics.frames, avgFlow_gps: metrics.avgFlow_gps !== null ? round3(metrics.avgFlow_gps) : null, giniMed: metrics.giniMed !== null ? round3(metrics.giniMed) : null, maxShareMed: metrics.maxShareMed !== null ? round3(metrics.maxShareMed) : null } const next = [exp, ...history] setHistory(next) try { localStorage.setItem('espressoHistory', JSON.stringify(next)) } catch {} }

const deleteExperiment = (id) => { const next = history.filter(x => x.id !== id) setHistory(next) try { localStorage.setItem('espressoHistory', JSON.stringify(next)) } catch {} } const clearHistory = () => { setHistory([]) try { localStorage.removeItem('espressoHistory') } catch {} } const exportHistoryCSV = () => { const header = 'timestamp,dose_g,output_g,tds_pct,ey_pct,balance,notes,score,jets_mean,jets_cv,spike_rate_pct,area_jump_rate_pct,duration_s,frames,avg_flow_gps,gini_med,max_share_med\n' const rows = history.map(h => [ h.timestamp, val(h.dose), val(h.output), val(h.tds), val(h.ey), val(h.balance), csvSafe(h.notes), h.score, h.jets_mean, h.jets_cv, h.spikeRate, h.areaJumpRate, h.duration, h.frames, val(h.avgFlow_gps), val(h.giniMed), val(h.maxShareMed) ].join(',')).join('\n') const blob = new Blob([header + rows], {type:'text/csv'}) const url = URL.createObjectURL(blob) const a = document.createElement('a'); a.href=url; a.download='espresso_history.csv'; document.body.appendChild(a); a.click(); a.remove() URL.revokeObjectURL(url) }

// ------- CSV de métricas del tiro actual ------- const exportShotCSV = () => { if (!metrics) return const header = 't_sec,jets,area,spike,areaJump\n' const rows = metrics.series.map((p,i)=>[ p.t.toFixed(3), p.jets, p.area, metrics.spikesIdx.includes(i)?1:0, metrics.areaJumpIdx.includes(i)?1:0 ].join(',')).join('\n') const blob = new Blob([header+rows], {type:'text/csv'}) const url = URL.createObjectURL(blob) const a = document.createElement('a') a.href=url; a.download='espresso_flow_metrics.csv' document.body.appendChild(a); a.click(); a.remove() URL.revokeObjectURL(url) }

// No bloqueamos análisis si falta el peso; simplemente no habrá métricas de flujo const canAnalyze = !!videoURL

return ( <div className="container"> <div className="row" style={{alignItems:'center', justifyContent:'space-between'}}> <h1>☕️ Espresso Flow Vision <span className="badge">1 video</span></h1> <div className="pill small">OpenCV.js • Vite + React</div> </div>

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
        onLoadedMetadata={()=>setStatus("Video cargado. Puedes definir ROI, calibrar y analizar.")}
      />
    )}
  </div>

  {/* 2) Pre-análisis: estimación de flujo y calibración */}
  <div className="card" style={{marginBottom:16}}>
    <h3>2) Pre-análisis (opcional)</h3>
    <label className="small" style={{display:'flex', alignItems:'center', gap:8}}>
      <input type="checkbox" checked={useFlowEst} onChange={e=>setUseFlowEst(e.target.checked)} />
      Estimar flujo (g/s) a partir de bebida final (el tiempo lo detecta el video automáticamente)
    </label>
    <div className="row" style={{gap:12, marginTop:8}}>
      <div>
        <label className="small muted">Bebida final (g)</label>
        <input className="pill" style={{display:'block', padding:'8px'}} type="number" min="0" step="0.1" value={output} onChange={e=>setOutput(e.target.value)} disabled={!useFlowEst}/>
      </div>
      <div>
        <label className="small muted">Dosis (g)</label>
        <input className="pill" style={{display:'block', padding:'8px'}} type="number" min="0" step="0.1" value={dose} onChange={e=>setDose(e.target.value)} />
      </div>
      <div>
        <label className="small muted">TDS (%)</label>
        <input className="pill" style={{display:'block', padding:'8px'}} type="number" min="0" step="0.01" value={tds} onChange={e=>setTds(e.target.value)} />
      </div>
      <div>
        <label className="small muted">EY (%)</label>
        <div className="pill" style={{padding:'8px'}}>{EY!==null ? EY.toFixed(2) : '—'}</div>
      </div>
    </div>

    <h4 style={{marginTop:12}}>Calibración (detección)</h4>
    <div className="row" style={{gap:16, flexWrap:'wrap'}}>
      <div>
        <label className="small muted">Δ Spikes (jets)</label>
        <input type="range" min="1" max="5" step="1" value={spikeDelta} onChange={e=>setSpikeDelta(parseInt(e.target.value))}/>
        <div className="small muted">Valor: {spikeDelta}</div>
      </div>
      <div>
        <label className="small muted">Mín. jets para spike</label>
        <input type="range" min="1" max="8" step="1" value={spikeMinJets} onChange={e=>setSpikeMinJets(parseInt(e.target.value))}/>
        <div className="small muted">Valor: {spikeMinJets}</div>
      </div>
      <div>
        <label className="small muted">Área mínima blob (px)</label>
        <input type="range" min="10" max="200" step="5" value={minBlobArea} onChange={e=>setMinBlobArea(parseInt(e.target.value))}/>
        <div className="small muted">Valor: {minBlobArea}</div>
      </div>
      <div>
        <label className="small muted">Factor salto de área</label>
        <input type="range" min="1.1" max="2.0" step="0.05" value={areaJumpFactor} onChange={e=>setAreaJumpFactor(parseFloat(e.target.value))}/>
        <div className="small muted">Valor: {areaJumpFactor.toFixed(2)}×</div>
      </div>
    </div>
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
          <canvas ref={chartRef} width={900} height={200} style={{width:'100%', border:'1px solid #232339', borderRadius:'8px', cursor:'pointer'}} title="Haz clic para saltar al frame" />
          <p className="small muted">Clic en el gráfico para saltar al frame y ver detalle de flujos estimados.</p>
        </div>

        {/* Detalle del frame clicado */}
        {inspect && (
          <div className="card" style={{marginTop:12}}>
            <h4>Detalle en t = {inspect.tRel.toFixed(2)} s</h4>
            <p className="small muted">Chorros detectados: {inspect.jets??(inspect.flows?inspect.flows.length:'—')} · Flujo total estimado: {metrics.avgFlow_gps!=null? `${metrics.avgFlow_gps.toFixed(3)} g/s`:'—'}</p>
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

) }

// ---------- table cell styles ---------- const th = { textAlign:'left', padding:'8px 6px', borderBottom:'1px solid #232339', color:'#9aa0b3' } const td = { padding:'8px 6px' }

// ---------- Utils (declarados UNA sola vez) ---------- function normRect({x1,y1,x2,y2}){ const x=Math.min(x1,x2), y=Math.min(y1,y2); return {x,y,w:Math.abs(x2-x1),h:Math.abs(y2-y1)} } function roiRectScaled(roi,s){ return {x:Math.round(roi.xs), y:Math.round(roi.ys), w:Math.round(roi.ws), h:Math.round(roi.hs)} } function drawRect(ctx,r,color='#60a5fa'){ ctx.save(); ctx.strokeStyle=color; ctx.lineWidth=2; ctx.strokeRect(r.x,r.y,r.w,r.h); ctx.restore() }

function drawMaskContours(ctx, maskMat, offsetX, offsetY, color='#60a5fa', minArea=40){ const cv = window.cv let contours = new cv.MatVector(), hierarchy = new cv.Mat() cv.findContours(maskMat, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE) ctx.save(); ctx.strokeStyle=color; ctx.lineWidth=2 for(let i=0;i<contours.size();i++){ const rect = cv.boundingRect(contours.get(i)) if (rect.widthrect.height < minArea) continue ctx.strokeRect(rect.x + offsetX, rect.y + offsetY, rect.width, rect.height) } ctx.restore() contours.delete(); hierarchy.delete() } function componentAreasCC(maskMat, minArea=35){ const cv = window.cv let labels = new cv.Mat(), stats = new cv.Mat(), centroids = new cv.Mat() const n = cv.connectedComponentsWithStats(maskMat, labels, stats, centroids, 8, cv.CV_32S) const areas = [] for(let i=1;i<n;i++){ // 0 es background const a = stats.intAt(i, cv.CC_STAT_AREA) if (a >= minArea) areas.push(a) } labels.delete(); stats.delete(); centroids.delete() return areas } function meanArr(a){ return a.length? a.reduce((x,y)=>x+y,0)/a.length : 0 } function varArr(a,m){ return a.length? a.reduce((x,y)=>x+(y-m)(y-m),0)/a.length : 0 } function stdArr(a,m){ const v = varArr(a,m); return Math.sqrt(v) } function median(arr){ if (!arr || !arr.length) return null; const a=[...arr].sort((x,y)=>x-y); const n=a.length; return n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2 } function clamp(x, lo, hi){ return Math.max(lo, Math.min(hi, x)) } function mapRange(x, inMin, inMax, outMin, outMax){ if (inMax===inMin) return outMin; const t=(x-inMin)/(inMax-inMin); return outMin + clamp(t,0,1)*(outMax-outMin) } function parseFloatOrNull(v){ const n = parseFloat(v); return Number.isFinite(n) ? n : null } function round2(x){ return Math.round((x + Number.EPSILON)*100)/100 } function round3(x){ return Math.round((x + Number.EPSILON)1000)/1000 } function fmtDate(iso){ try{ return new Date(iso).toLocaleString() } catch{ return iso } } function val(v){ return (v===null || v===undefined || v==='') ? '—' : v } function csvSafe(s){ if (!s) return ''; const q = String(s).replace(/"/g,'""'); return "${q}" } function computeEY(dose, output, tds){ const d = parseFloat(dose), o = parseFloat(output), t = parseFloat(tds) if (!Number.isFinite(d) || d<=0 || !Number.isFinite(o) || o<0 || !Number.isFinite(t) || t<0) return null // EY% = (TDS% * beverage_mass) / dose return (t * o) / d } function giniCoefficient(values){ if (!values || !values.length) return 0 const x = values.slice().sort((a,b)=>a-b) const n = x.length const sum = x.reduce((a,b)=>a+b,0) if (sum === 0) return 0 let cum = 0 for (let i=0;i<n;i++){ cum += (2(i+1)-n-1) * x[i] } return cum / (n * sum) } function findNearestIndex(series, tRel){ if (!series?.length) return -1 let best = 0, bestD = Infinity for (let i=0;i<series.length;i++){ const d = Math.abs(series[i].t - tRel) if (d < bestD){ bestD = d; best = i } } return best } async function computeFlowDetailAt(video, roi, scale, avgFlow_gps, minArea=35){ const W = Math.round(video.videoWidth * scale) const H = Math.round(video.videoHeight * scale) const tmp = document.createElement('canvas'); tmp.width=W; tmp.height=H const ctx = tmp.getContext('2d') ctx.drawImage(video, 0, 0, W, H) const cv = window.cv const frame = cv.imread(tmp) const r = roi ? roiRectScaled(roi, scale) : {x:0,y:0,w:W,h:H} let A = frame.roi(new cv.Rect(r.x, r.y, r.w, r.h)) let g = new cv.Mat(); cv.cvtColor(A, g, cv.COLOR_RGBA2GRAY) cv.GaussianBlur(g, g, new cv.Size(3,3), 0) let m = new cv.Mat() cv.adaptiveThreshold(g, m, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 21, 5) let kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3,3)) cv.morphologyEx(m, m, cv.MORPH_OPEN, kernel)

const areas = componentAreasCC(m, minArea) const jets = areas.length let flows = null, gini = null, maxShare = null if (avgFlow_gps!=null && areas.length>0){ const sumA = areas.reduce((a,b)=>a+b,0) const shares = areas.map(a=>a/sumA) flows = shares.map(s=>s*avgFlow_gps) gini = giniCoefficient(flows) maxShare = Math.max(...shares) }

frame.delete(); A.delete(); g.delete(); m.delete(); kernel.delete() return { t: video.currentTime, jets, flows, gini, maxShare } } async function renderOverlayAtCurrent(video, roi, scale, minArea=40){ const W = Math.round(video.videoWidth * scale) const H = Math.round(video.videoHeight * scale) const tmp = document.createElement('canvas'); tmp.width=W; tmp.height=H const ctx = tmp.getContext('2d') ctx.drawImage(video, 0, 0, W, H) const cv = window.cv const frame = cv.imread(tmp) const r = roi ? roiRectScaled(roi, scale) : {x:0,y:0,w:W,h:H} let A = frame.roi(new cv.Rect(r.x, r.y, r.w, r.h)) let g = new cv.Mat(); cv.cvtColor(A, g, cv.COLOR_RGBA2GRAY) cv.GaussianBlur(g, g, new cv.Size(3,3), 0) let m = new cv.Mat() cv.adaptiveThreshold(g, m, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 21, 5) let kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3,3)) cv.morphologyEx(m, m, cv.MORPH_OPEN, kernel)

const out = canvasRef.current out.width = W; out.height = H const octx = out.getContext('2d') octx.drawImage(tmp, 0, 0) if (roi) drawRect(octx, r, '#60a5fa') drawMaskContours(octx, m, r.x, r.y, '#60a5fa', minArea)

frame.delete(); A.delete(); g.delete(); m.delete(); kernel.delete() }

// ---- Chart drawing & interaction ---- function drawChart(canvas, series, spikesIdx, areaSeries){ if (!canvas) return const ctx = canvas.getContext('2d') const W = canvas.width, H = canvas.height ctx.clearRect(0,0,W,H) ctx.fillStyle = '#0b0b0f'; ctx.fillRect(0,0,W,H)

// grid ctx.strokeStyle = '#384152'; ctx.lineWidth = 1 for (let i=0;i<=4;i++){ const y = Math.round(i*H/4); ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke() }

// extract series const xs = series.map(p=>p.t), ys = series.map(p=>p.jets) if (xs.length<2) return const x0 = xs[0], x1 = xs[xs.length-1] const yMax = Math.max(2, ...ys)

// area overlay (normalized) const aMax = Math.max(1, ...areaSeries) ctx.strokeStyle = '#6b7280'; ctx.lineWidth = 1.5; ctx.setLineDash([4,4]) ctx.beginPath() for (let i=0;i<series.length;i++){ const x = ((xs[i]-x0)/(x1-x0))*W const y = H - ((areaSeries[i]/aMax)*H) if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y) } ctx.stroke() ctx.setLineDash([])

// jets line ctx.strokeStyle = '#60a5fa'; ctx.lineWidth = 2 ctx.beginPath() for (let i=0;i<series.length;i++){ const x = ((xs[i]-x0)/(x1-x0))*W const y = H - (ys[i]/yMax)*H if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y) } ctx.stroke()

// spikes markers ctx.fillStyle = '#f87171' for (const i of spikesIdx){ const x = ((xs[i]-x0)/(x1-x0))*W const y = H - (ys[i]/yMax)*H drawMarker(ctx, x, y) }

// axes labels (minimal) ctx.fillStyle = '#a1a1aa' ctx.font = '12px ui-sans-serif' ctx.fillText('0s', 2, H-4) ctx.fillText((x1-x0).toFixed(1)+'s', W-40, H-4) } function drawMarker(ctx, x, y){ const r = 4 ctx.beginPath() ctx.arc(x, y, r, 0, Math.PI*2) ctx.fill() } function attachChartClick(canvas, series, onJump){ if (!canvas || !series?.length) return const xs = series.map(p=>p.t) const x0 = xs[0], x1 = xs[xs.length-1] const handler = (e)=>{ const rect = canvas.getBoundingClientRect() const x = e.clientX - rect.left const t = x / rect.width * (x1-x0) + x0 onJump && onJump(t) } canvas.onclick = handler }

export default App

