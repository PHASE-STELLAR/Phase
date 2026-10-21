"use client"

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react"
import { cn } from "@/lib/utils"

const STROKE = "#00ff00"
const BG = "#000000"
/** Tamaño de celda radar + snap */
export const FORGE_GRID_PX = 16

export type PaintTool = "pencil" | "line" | "circle"

type Segment =
  | { kind: "path"; points: [number, number][] }
  | { kind: "line"; x0: number; y0: number; x1: number; y1: number }
  | { kind: "circle"; cx: number; cy: number; r: number }

export type ForgePaintCanvasHandle = {
  exportPngBlob: () => Promise<Blob | null>
  clear: () => void
}

export type ForgePaintCanvasToolRail = "internal" | "none"

type Props = {
  className?: string
  width?: number
  height?: number
  /** Panel de herramientas integrado o solo lienzo (modal aporta el rail). */
  toolRail?: ForgePaintCanvasToolRail
  /** Modo controlado: obligatorio si `toolRail="none"`. */
  tool?: PaintTool
  onToolChange?: (t: PaintTool) => void
}

function snapCoord(n: number, grid = FORGE_GRID_PX) {
  return Math.round(n / grid) * grid
}

function snapPt(p: [number, number], grid = FORGE_GRID_PX): [number, number] {
  return [snapCoord(p[0], grid), snapCoord(p[1], grid)]
}

function drawRadarGrid(ctx: CanvasRenderingContext2D, w: number, h: number, grid: number) {
  ctx.save()
  ctx.strokeStyle = "rgba(0, 255, 0, 0.14)"
  ctx.lineWidth = 1
  for (let x = 0; x <= w; x += grid) {
    ctx.beginPath()
    ctx.moveTo(x + 0.5, 0)
    ctx.lineTo(x + 0.5, h)
    ctx.stroke()
  }
  for (let y = 0; y <= h; y += grid) {
    ctx.beginPath()
    ctx.moveTo(0, y + 0.5)
    ctx.lineTo(w, y + 0.5)
    ctx.stroke()
  }
  ctx.strokeStyle = "rgba(0, 255, 0, 0.22)"
  for (let x = 0; x <= w; x += grid * 4) {
    ctx.beginPath()
    ctx.moveTo(x + 0.5, 0)
    ctx.lineTo(x + 0.5, h)
    ctx.stroke()
  }
  for (let y = 0; y <= h; y += grid * 4) {
    ctx.beginPath()
    ctx.moveTo(0, y + 0.5)
    ctx.lineTo(w, y + 0.5)
    ctx.stroke()
  }
  const cx = w / 2
  const cy = h / 2
  const maxR = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy))
  ctx.strokeStyle = "rgba(0, 255, 0, 0.08)"
  for (let r = grid * 2; r < maxR; r += grid * 3) {
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.restore()
}

function drawAll(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  segments: Segment[],
  preview: Segment | null,
  grid: number,
) {
  ctx.fillStyle = BG
  ctx.fillRect(0, 0, w, h)
  drawRadarGrid(ctx, w, h, grid)

  ctx.strokeStyle = STROKE
  ctx.lineWidth = 2
  ctx.lineCap = "round"
  ctx.lineJoin = "round"

  const drawSeg = (s: Segment) => {
    if (s.kind === "path") {
      if (s.points.length < 2) return
      ctx.beginPath()
      ctx.moveTo(s.points[0][0], s.points[0][1])
      for (let i = 1; i < s.points.length; i++) {
        ctx.lineTo(s.points[i][0], s.points[i][1])
      }
      ctx.stroke()
    } else if (s.kind === "line") {
      ctx.beginPath()
      ctx.moveTo(s.x0, s.y0)
      ctx.lineTo(s.x1, s.y1)
      ctx.stroke()
    } else {
      ctx.beginPath()
      ctx.arc(s.cx, s.cy, Math.max(1, s.r), 0, Math.PI * 2)
      ctx.stroke()
    }
  }

  for (const s of segments) drawSeg(s)
  if (preview) drawSeg(preview)
}

export const ForgePaintCanvas = forwardRef<ForgePaintCanvasHandle, Props>(function ForgePaintCanvas(
  { className, width = 400, height = 280, toolRail = "internal", tool: toolProp, onToolChange },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [internalTool, setInternalTool] = useState<PaintTool>("pencil")
  const tool = toolRail === "none" ? (toolProp ?? "pencil") : (toolProp ?? internalTool)
  const setTool = toolRail === "none" ? onToolChange ?? (() => {}) : onToolChange ?? setInternalTool

  const [segments, setSegments] = useState<Segment[]>([])
  const draftRef = useRef<{
    tool: PaintTool
    start: [number, number]
    current: [number, number]
    path: [number, number][]
  } | null>(null)
  const [, bump] = useState(0)

  const redraw = useCallback(() => {
    const c = canvasRef.current
    if (!c) return
    const ctx = c.getContext("2d")
    if (!ctx) return
    const preview = (() => {
      const d = draftRef.current
      if (!d) return null
      if (d.tool === "pencil" && d.path.length >= 2) return { kind: "path" as const, points: d.path }
      if (d.tool === "line")
        return { kind: "line" as const, x0: d.start[0], y0: d.start[1], x1: d.current[0], y1: d.current[1] }
      if (d.tool === "circle") {
        const dx = d.current[0] - d.start[0]
        const dy = d.current[1] - d.start[1]
        const r = Math.sqrt(dx * dx + dy * dy)
        return { kind: "circle" as const, cx: d.start[0], cy: d.start[1], r }
      }
      return null
    })()
    drawAll(ctx, width, height, segments, preview, FORGE_GRID_PX)
  }, [segments, width, height])

  useEffect(() => {
    redraw()
  }, [redraw])

  const clientToCanvas = (e: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const c = canvasRef.current
    if (!c) return [0, 0]
    const r = c.getBoundingClientRect()
    const sx = c.width / r.width
    const sy = c.height / r.height
    const raw: [number, number] = [(e.clientX - r.left) * sx, (e.clientY - r.top) * sy]
    return snapPt(raw)
  }

  const pushSnappedPathPoint = (path: [number, number][], p: [number, number]) => {
    const last = path[path.length - 1]
    if (!last || last[0] !== p[0] || last[1] !== p[1]) path.push(p)
  }

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!e.isPrimary || e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = clientToCanvas(e)
    if (tool === "pencil") {
      draftRef.current = { tool: "pencil", start: p, current: p, path: [p] }
    } else {
      draftRef.current = { tool, start: p, current: p, path: [] }
    }
    bump((n) => n + 1)
  }

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!draftRef.current) return
    const p = clientToCanvas(e)
    draftRef.current.current = p
    if (draftRef.current.tool === "pencil") {
      pushSnappedPathPoint(draftRef.current.path, p)
    }
    redraw()
  }

  const onUp = () => {
    const d = draftRef.current
    if (!d) return
    draftRef.current = null
    const s0 = snapPt(d.start)
    const s1 = snapPt(d.current)
    if (d.tool === "pencil") {
      if (d.path.length >= 2) setSegments((prev) => [...prev, { kind: "path", points: d.path }])
    } else if (d.tool === "line") {
      setSegments((prev) => [...prev, { kind: "line", x0: s0[0], y0: s0[1], x1: s1[0], y1: s1[1] }])
    } else {
      const dx = s1[0] - s0[0]
      const dy = s1[1] - s0[1]
      const r = Math.sqrt(dx * dx + dy * dy)
      if (r >= 1) setSegments((prev) => [...prev, { kind: "circle", cx: s0[0], cy: s0[1], r }])
    }
    bump((n) => n + 1)
  }

  const onLeave = () => {
    if (draftRef.current) onUp()
  }

  useImperativeHandle(ref, () => ({
    exportPngBlob: () =>
      new Promise((resolve) => {
        const c = canvasRef.current
        if (!c) {
          resolve(null)
          return
        }
        c.toBlob((b) => resolve(b), "image/png")
      }),
    clear: () => {
      setSegments([])
      draftRef.current = null
      bump((n) => n + 1)
    },
  }))

  return (
    <div className={cn("space-y-3", className)}>
      {toolRail === "internal" && (
        <div className="flex flex-wrap gap-2">
          {(
            [
              ["pencil", "Lápiz"],
              ["line", "Línea"],
              ["circle", "Círculo"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTool(id)}
              className={cn(
                "border-2 px-3 py-1.5 font-mono text-[9px] uppercase tracking-widest transition-colors",
                tool === id
                  ? "border-[#00ff00] bg-[#00ff00]/15 text-[#00ff00]"
                  : "border-[#00ff00]/35 text-[#00ff00]/60 hover:border-[#00ff00]/55",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        className="max-w-full cursor-crosshair touch-none bg-black"
        style={{ width: "100%", height: "auto", aspectRatio: `${width} / ${height}` }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onLeave}
        onLostPointerCapture={onLeave}
      />
      {toolRail === "internal" && (
        <p className="font-mono text-[8px] uppercase tracking-wider text-[#00ff00]/45">
          Trazo <span style={{ color: STROKE }}>#00ff00</span> · grid snap {FORGE_GRID_PX}px
        </p>
      )}
    </div>
  )
})
