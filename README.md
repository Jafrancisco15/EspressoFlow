# Espresso Flow Vision (OpenCV.js, Vite + React)

Analiza el flujo de espresso desde un **portafiltro naked visto con espejo** usando **un solo video**. 
El espejo te da una **segunda vista** en la misma toma para realizar un **análisis pseudo-estéreo** (calibración manual) y detectar **canalización** (picos de chorros, variabilidad).

## Demo local
```bash
npm install
npm run dev
```

## Deploy en Vercel
1) Sube este repo a GitHub.
2) Conecta el repo en vercel.com y usa framework "Vite".
3) `npm run build` será `vite build` (ya definido) y `dist/` se servirá automáticamente.

## Flujo de uso
1. **Sube el video** grabado con smartphone + espejo. Usa ring light y fondo blanco/negro. 
2. Presiona **Tomar cuadro** para congelar una imagen de referencia.
3. **Dibuja dos ROIs** (rectángulos): 
   - **A** = vista directa del chorro 
   - **B** = vista reflejada en el espejo.
4. **Añade puntos de calibración**: haz clic en puntos **correspondientes** visibles en A y B (mismo orden). Recomendado: 6–12 puntos en bordes rígidos del portafiltro, tornillos, etc.
5. **Inicia el análisis**: el sistema segmenta chorros y estima métricas por cuadro:
   - `jetsA`, `jetsB`, `jets` = # chorros (componentes conectados)
   - **spikes** y **varianza** de chorros → heurística de canalización.
6. **Exporta CSV** con los resultados por frame.

## Notas técnicas
- Todo corre **en el navegador** via **OpenCV.js (WASM)**.
- El módulo intenta usar `StereoBM` si está disponible para generar una **disparidad aproximada**, pero no todas las builds lo incluyen. 
- Rectificación estéreo aquí es **aproximada**; con tus puntos se calcula la **Fundamental F** (RANSAC). Para reconstrucción 3D métrica necesitarías una calibración intrínseca (focal) y conocer la geometría del espejo, o usar correspondencias en un patrón impreso.
- Aun sin 3D, la **curva de chorros vs tiempo** y los **spikes** son indicadores útiles de canalización.

## Consejos de captura
- Altura baja, portafiltro naked visible.
- Iluminación fija (ring), ISO bajo, enfoque manual si es posible.
- Evita vibraciones (tripié).
- El espejo debe ver claramente la base (elige ángulo que no deforme demasiado).

## Roadmap
- Mejor seguidor de movimiento (background subtraction + optical flow).
- Rectificación estéreo con `stereoRectifyUncalibrated`.
- Export de video con overlay (webm) y charts.
- Módulo opcional de curva TDS(t) con sensor Bluetooth.

© 2025

## Base conceptual (resumen)
Este prototipo se inspira en la literatura y práctica de diagnóstico con **portafiltro naked** y control de **canalización**: observación de sprays/chorros irregulares, cambios súbitos y “blonding”, más buenas prácticas de **preinfusión y rampas de presión** para mitigar canales. También retoma hallazgos sobre **WDT profundo** y efectos de **filtros de papel/puck screens** en la resistencia hidráulica y repetibilidad.
