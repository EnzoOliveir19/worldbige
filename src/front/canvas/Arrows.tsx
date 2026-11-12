// A ligação lead→helper: quem abriu quem.
//
// Não são setas soltas, é um colchete. Um agente que abriu três helpers tem UMA
// linha saindo dele, que desce pela coluna e ramifica numa horizontal por
// helper — a mesma forma de uma chave de chaveamento, e pelo mesmo motivo: ela
// diz "estes três vêm daqui" de uma vez, enquanto três curvas separadas dizem
// a mesma coisa três vezes e se cruzam no caminho. De longe, afastado, o run
// inteiro vira a sua própria forma: profundidade na horizontal, fan-out na
// vertical.
//
// A derivação é do `parentId` de cada agente, não desenhada à mão — por isso o
// colchete segue as janelas ao arrastar sem ninguém atualizar nada. A camada é
// SVG dentro do mundo, abaixo das janelas: uma linha nunca passa por cima de um
// terminal.
import type { Agent } from '../transport'
import { tintOf } from '../identity'
import { rectOf } from './geometry'
import { boundsOf, type Rect } from './viewport'

/** Raio do canto do colchete. */
const ELBOW = 18
/** Folga em volta do desenho, pra curva não ser cortada pela borda do SVG. */
const PAD = 64
/**
 * Onde a linha encosta na janela, medido do topo dela.
 *
 * Na altura do cabeçalho, e não no meio: o meio de uma janela aberta é terminal,
 * e uma linha que chega ali aponta pro texto da sessão em vez de apontar pra
 * janela. No cabeçalho ela chega onde está o nome.
 */
const ANCHOR_Y = 26

type Branch = { id: string; to: Rect; y: number; color: string }

/** Um colchete: o tronco de um pai e os ramos pros filhos que estão na coluna. */
type Bracket = {
  id: string
  stemX: number
  from: { x: number; y: number }
  branches: Branch[]
  color: string
}

/** Uma curva solta, pro filho que foi arrastado pra fora da coluna. */
type Loose = { id: string; from: Rect; to: Rect; color: string }

function anchorY(rect: Rect): number {
  // Num card recolhido, o cabeçalho é quase a altura toda: ancorar no meio dele
  // é mais honesto que insistir num offset pensado pra janela aberta.
  return rect.y + Math.min(ANCHOR_Y, rect.h / 2)
}

/** O caminho do tronco: sai do pai, dobra, desce até o último ramo. */
function stemPath(from: { x: number; y: number }, stemX: number, lastY: number): string {
  const drop = lastY - from.y
  if (Math.abs(drop) < 1) return `M ${from.x} ${from.y} H ${stemX}`
  const r = Math.min(ELBOW, Math.abs(stemX - from.x), Math.abs(drop) / 2)
  const dir = drop > 0 ? 1 : -1
  return [
    `M ${from.x} ${from.y}`,
    `H ${stemX - r}`,
    `Q ${stemX} ${from.y} ${stemX} ${from.y + r * dir}`,
    `V ${lastY}`,
  ].join(' ')
}

/**
 * O ramo do tronco até a janela do filho.
 *
 * Reto nas duas pontas do tronco — no topo ele é a continuação da horizontal
 * que vem do pai, embaixo é onde o tronco acaba. Só os do meio precisam da
 * curva que diz "o tronco continua abaixo de mim".
 */
function branchPath(stemX: number, y: number, to: Rect, straight: boolean): string {
  if (straight) return `M ${stemX} ${y} H ${to.x}`
  const r = Math.min(ELBOW, Math.abs(to.x - stemX) / 2)
  // Um ramo do meio sai do tronco por uma curva, senão o cruzamento vira um T
  // duro e a leitura de "o tronco continua" se perde.
  return `M ${stemX} ${y - r} Q ${stemX} ${y} ${stemX + r} ${y} H ${to.x}`
}

/** A curva de antes, pro filho que não está mais na coluna do pai. */
function loosePath(from: Rect, to: Rect): string {
  const px = from.x + from.w / 2
  const py = from.y + from.h
  const cx = to.x + to.w / 2
  const cy = to.y
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
  const brackets: Bracket[] = []
  const loose: Loose[] = []

  for (const parent of agents) {
    const children = agents
      .filter((a) => a.parentId === parent.id)
      .sort((a, b) => a.createdAt - b.createdAt)
    if (!children.length) continue

    const pr = rectOf(parent)
    // Quem foi arrastado pra fora da coluna ganha a curva solta: um ramo
    // horizontal até o outro lado do canvas cruzaria tudo no caminho.
    const inColumn = children.filter((c) => !c.layout.pinned && c.layout.x > pr.x + pr.w)
    for (const child of children) {
      if (inColumn.includes(child)) continue
      loose.push({
        id: `${parent.id}>${child.id}`,
        from: pr,
        to: rectOf(child),
        color: tintOf(child.tint),
      })
    }
    if (!inColumn.length) continue

    // O tronco fica no meio do vão entre as duas colunas — é o espaço que o
    // arranjo deixa livre justamente pra ele.
    const left = Math.min(...inColumn.map((c) => c.layout.x))
    const stemX = Math.round((pr.x + pr.w + left) / 2)
    brackets.push({
      id: parent.id,
      stemX,
      from: { x: pr.x + pr.w, y: anchorY(pr) },
      // A cor do tronco é a de quem abriu: o tronco é dele, os ramos são deles.
      color: tintOf(parent.tint),
      branches: inColumn.map((c) => {
        const to = rectOf(c)
        return { id: c.id, to, y: anchorY(to), color: tintOf(c.tint) }
      }),
    })
  }

  if (!brackets.length && !loose.length) return null
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
      {brackets.map((b) => {
        const from = { x: b.from.x - ox, y: b.from.y - oy }
        const stemX = b.stemX - ox
        const ys = b.branches.map((br) => br.y - oy)
        const lastY = Math.max(...ys, from.y)
        return (
          <g key={b.id}>
            <path
              d={stemPath(from, stemX, lastY)}
              stroke={b.color}
              fill="none"
              strokeWidth={2.5}
              strokeLinecap="round"
            />
            {b.branches.map((br) => {
              const y = br.y - oy
              const to = { ...br.to, x: br.to.x - ox }
              return (
                <g key={br.id} stroke={br.color} fill={br.color}>
                  <path
                    d={branchPath(stemX, y, to, Math.abs(y - lastY) < 1 || Math.abs(y - from.y) < 1)}
                    fill="none"
                    strokeWidth={2.5}
                    strokeLinecap="round"
                  />
                  {/* A ponta mora no filho: é onde a leitura termina. */}
                  <path
                    d={`M ${to.x - 10} ${y - 6} L ${to.x - 10} ${y + 6} L ${to.x} ${y} Z`}
                    stroke="none"
                  />
                </g>
              )
            })}
          </g>
        )
      })}

      {loose.map((e) => {
        const from = { ...e.from, x: e.from.x - ox, y: e.from.y - oy }
        const to = { ...e.to, x: e.to.x - ox, y: e.to.y - oy }
        const head = { x: to.x + to.w / 2, y: to.y }
        return (
          <g key={e.id} stroke={e.color} fill={e.color}>
            <path
              d={loosePath(from, to)}
              fill="none"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeDasharray="6 7"
            />
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
