// As setas lead→helper: quem abriu quem.
//
// São derivadas do `parentId` de cada agente, não desenhadas à mão — por isso
// seguem a janela ao arrastar sem ninguém atualizar nada. A camada é SVG dentro
// do mundo, abaixo das janelas: uma linha nunca passa por cima de um terminal.
import type { Agent } from '../transport'
import { tintOf } from '../identity'
import { rectOf } from './geometry'
import { boundsOf, type Rect } from './viewport'

/** Raio do canto do cotovelo. */
const ELBOW = 20
/** Folga em volta do desenho, pra curva não ser cortada pela borda do SVG. */
const PAD = 64

type Edge = { id: string; from: Rect; to: Rect; color: string }

function elbowPath(from: Rect, to: Rect): string {
  const px = from.x + from.w / 2
  const py = from.y + from.h
  const cx = to.x + to.w / 2
  const cy = to.y

  // Filho acima ou encavalado no pai: o cotovelo ortogonal daria um nó. Uma
  // curva simples diz a mesma coisa sem fingir ordem que não existe.
  if (cy - py < ELBOW * 2) {
    const mid = (py + cy) / 2
    return `M ${px} ${py} C ${px} ${mid + 80}, ${cx} ${mid - 80}, ${cx} ${cy}`
  }

  if (Math.abs(cx - px) < 1) return `M ${px} ${py} L ${cx} ${cy}`

  const midY = (py + cy) / 2
  const dir = cx > px ? 1 : -1
  const r = Math.min(ELBOW, Math.abs(cx - px) / 2, (cy - py) / 2)
  return [
    `M ${px} ${py}`,
    `V ${midY - r}`,
    `Q ${px} ${midY} ${px + r * dir} ${midY}`,
    `H ${cx - r * dir}`,
    `Q ${cx} ${midY} ${cx} ${midY + r}`,
    `V ${cy}`,
  ].join(' ')
}

export function Arrows({ agents }: { agents: Agent[] }) {
  const byId = new Map(agents.map((a) => [a.id, a]))
  const edges: Edge[] = []
  for (const agent of agents) {
    const parent = agent.parentId ? byId.get(agent.parentId) : undefined
    if (!parent) continue
    edges.push({
      id: `${parent.id}>${agent.id}`,
      from: rectOf(parent),
      to: rectOf(agent),
      // A cor é a do filho: a linha conta de quem ela é a chegada.
      color: tintOf(agent.tint),
    })
  }
  if (!edges.length) return null

  const box = boundsOf(agents.map(rectOf))
  if (!box) return null
  const ox = box.x - PAD
  const oy = box.y - PAD

  return (
    <svg
      className="arrows"
      style={{ left: ox, top: oy, width: box.w + PAD * 2, height: box.h + PAD * 2 }}
      width={box.w + PAD * 2}
      height={box.h + PAD * 2}
      aria-hidden="true"
    >
      {edges.map((e) => {
        const from = { ...e.from, x: e.from.x - ox, y: e.from.y - oy }
        const to = { ...e.to, x: e.to.x - ox, y: e.to.y - oy }
        const head = { x: to.x + to.w / 2, y: to.y }
        return (
          <g key={e.id} stroke={e.color} fill={e.color}>
            <path d={elbowPath(from, to)} fill="none" strokeWidth={2.5} strokeLinecap="round" />
            {/* A ponta mora no filho: é onde a leitura termina. */}
            <path
              d={`M ${head.x - 6} ${head.y - 10} L ${head.x + 6} ${head.y - 10} L ${head.x} ${head.y} Z`}
              stroke="none"
            />
          </g>
        )
      })}
    </svg>
  )
}
