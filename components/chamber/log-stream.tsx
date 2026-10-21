import type { RefObject } from "react"

export function ChamberLogStream({ lines, endRef }: { lines: { id: number; text: string }[]; endRef: RefObject<HTMLDivElement | null> }) {
  return <div role="log" aria-live="polite" aria-relevant="additions" className="min-w-0 space-y-2 break-words font-mono text-xs leading-relaxed">
    {lines.map(line => <p key={line.id}>{line.text}</p>)}<div ref={endRef} />
  </div>
}
