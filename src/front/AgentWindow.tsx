// ============================================================
// O chrome de janela (arrastar, redimensionar, z-order) é derivado do ccanvas
// (https://github.com/DevoidSloth/ccanvas)
// Copyright 2026 DevoidSloth — Apache License 2.0
// ============================================================
//
// Uma janela de agente no canvas: cabeçalho, terminal, e um card quando
// recolhida.
//
// O detalhe que o zoom impõe: arrastar e redimensionar acontecem em pixels de
// tela, mas a janela vive em coordenadas de mundo. Todo delta é dividido pelo
// zoom antes de virar posição — sem isso, arrastar com o canvas afastado move a
// janela rápido demais e com ele perto, devagar demais.
import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { AgentTerminal } from './AgentTerminal'
import { statusLabel, statusTone, tintOf, toolLabel, waitsForYou } from './identity'
import { CARD_H, focusRect } from './canvas/geometry'
import type { Agent, AgentLayout } from './transport'

const MIN_W = 360
const MIN_H = 240

type Props = {
  agent: Agent
  /** o papel dele no run: `lead`, `helper · busca`… */
  role: string
  /** zoom corrente: converte pixel de tela em unidade de mundo */
  zoom: number
  focused: boolean
  /**
   * Quanto esta janela está ampliada por estar em foco.
   *
   * É escala de verdade — a janela fica maior e a fonte do terminal cresce
   * junto —, não `transform`. Como as duas crescem pelo mesmo fator, o número
   * de colunas e linhas não muda, e é isso que mantém a seleção do mouse
   * funcionando: o xterm mede o retângulo do elemento e divide pelo tamanho da
   * célula, e com `transform` só o primeiro escala.
   */
  scale: number
  /** leva a câmera até esta janela e entrega o teclado a ela */
  onFocus: () => void
  /** entrega só o teclado, sem mexer na câmera */
  onTouch: () => void
  /** duplo-clique no cabeçalho: reenquadra mesmo já estando em foco */
  onReframe: () => void
  onLayout: (patch: Partial<AgentLayout>, commit: boolean) => void
  onHelper: () => void
  onStop: () => void
  onResume: () => void
  onRemove: () => void
  /** devolve o id do agente já dimensionado — ver AgentTerminal */
  resolveAgent: (cols: number, rows: number) => Promise<string | null>
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

export function AgentWindow(props: Props) {
  const { agent, zoom, focused, scale } = props
  const { layout } = agent
  const tint = tintOf(agent.tint)
  const alarm = waitsForYou(agent.status)
  const dragging = useRef(false)
  const rect = layout
  // Um card recolhido não amplia: o que o foco aumenta é o texto do terminal,
  // e um card não tem terminal — cresceria a caixa em volta do mesmo resumo,
  // no mesmo corpo de letra.
  const magnify = layout.collapsed ? 1 : scale

  // Durante o gesto a posição só existe na tela: `commit: false` atualiza o que
  // se vê (inclusive as setas, que são desenhadas lá fora), e só o `pointerup`
  // manda pro daemon. Sem isso, arrastar gravaria em disco a cada frame.
  const gesture = (
    e: ReactPointerEvent<HTMLElement>,
    apply: (dx: number, dy: number) => Partial<AgentLayout>,
    /** o gesto acabou sem sair do lugar: foi um clique, não um arrasto */
    onTap?: () => void,
  ) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const startX = e.clientX
    const startY = e.clientY
    let moved = false
    dragging.current = true
    document.body.classList.add('dragging')

    const far = (ev: PointerEvent) => Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > 3

    const move = (ev: PointerEvent) => {
      if (far(ev)) moved = true
      props.onLayout(apply((ev.clientX - startX) / zoom, (ev.clientY - startY) / zoom), false)
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('dragging')
      dragging.current = false
      if (!moved && !far(ev)) {
        onTap?.()
        return
      }
      props.onLayout(apply((ev.clientX - startX) / zoom, (ev.clientY - startY) / zoom), true)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /**
   * O cabeçalho é a alça de arrastar — e também o alvo mais natural de um
   * clique. Os dois convivem pelo resultado do gesto: se o ponteiro não saiu do
   * lugar, foi um pedido de ir até esta janela; se saiu, foi um arrasto, e aí a
   * câmera fica onde está (ninguém quer a tela voando no meio de um arrasto).
   */
  const onHeaderDown = (e: ReactPointerEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest('button')) return
    const from = { x: layout.x, y: layout.y }
    gesture(
      e,
      (dx, dy) => ({ x: Math.round(from.x + dx), y: Math.round(from.y + dy) }),
      () => props.onFocus(),
    )
  }

  const onResizeDown = (e: ReactPointerEvent<HTMLElement>) => {
    const from = { w: layout.w, h: layout.h }
    // O delta chega em unidades de mundo (já dividido pelo zoom), mas numa
    // janela em foco o que se vê é `mundo * scale`: sem dividir de novo, a
    // borda fugiria do ponteiro 1,4 vez mais rápido que ele.
    gesture(e, (dx, dy) => ({
      w: Math.max(MIN_W, Math.round(from.w + dx / magnify)),
      h: Math.max(MIN_H, Math.round(from.h + dy / magnify)),
    }))
  }

  /** O zoom está na escala em que o terminal sabe converter pixel em coluna? */
  const atOne = Math.abs(zoom - 1) < 0.005

  // Clicar na janela, fora do terminal: entrega o teclado sem mexer na câmera.
  const onPointerDownWindow = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    if (!focused) props.onTouch()
  }

  /**
   * O primeiro clique dentro do terminal, quando o zoom não é 1, é um pedido de
   * chegar perto — não de selecionar.
   *
   * Em qualquer zoom diferente de 1 a seleção do xterm pega o texto errado: ele
   * mede o retângulo do elemento (que a transform escala) e divide pelo tamanho
   * da célula (que ela não escala). Em vez de deixar o arrasto selecionar outra
   * coisa, o clique vira o voo até a janela, que pousa em 1 — e aí o próximo
   * arrasto seleciona o que você vê.
   */
  const onTermPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (atOne) {
      // Zoom 1: o terminal é um terminal. Só o teclado muda de dono.
      if (!focused) props.onTouch()
      return
    }
    e.preventDefault()
    e.stopPropagation()
    props.onFocus()
  }

  const collapsed = rect.collapsed

  // O que vai pra tela. O layout de verdade (`rect`/`layout`) continua sendo o
  // que os gestos leem e o que o daemon guarda — focar não redimensiona nada.
  const painted = focusRect(
    { x: rect.x, y: rect.y, w: rect.w, h: collapsed ? CARD_H : rect.h },
    magnify,
  )

  return (
    <article
      className={`win${focused ? ' is-focused' : ''}${alarm ? ' is-alarm' : ''}${collapsed ? ' is-card' : ''}`}
      style={{
        left: painted.x,
        top: painted.y,
        width: painted.w,
        height: painted.h,
        zIndex: layout.z,
        ['--tint' as string]: tint,
      }}
      onPointerDown={onPointerDownWindow}
    >
      <header className="win-head" onPointerDown={onHeaderDown} onDoubleClick={props.onReframe}>
        <span className="win-mark" aria-hidden="true" />
        <h2 className="win-name">{agent.name}</h2>
        {/* O nome diz quem é; o selo diz o que ele é no run. Fica calado de
            propósito — o destaque da janela pertence a `precisa de você`. */}
        <span className="role">{props.role}</span>
        {/* O nome da ferramenta entra legível; o técnico fica no title, pra
            quem precisar escrever uma regra de permissão com ele. */}
        <span
          className={`pill tone-${statusTone(agent.status)}`}
          title={agent.waitingTool ?? undefined}
        >
          {statusLabel(agent.status)}
          {agent.waitingTool ? `: ${toolLabel(agent.waitingTool)}` : ''}
        </span>
        {/* O modelo vem com o motivo no title: um helper rodando em opus sem
            ninguém saber por quê é exatamente o que a tabela de roteamento
            existe pra evitar, e o motivo tem que estar onde o modelo está. */}
        <span className="win-meta" title={agent.modelReason ?? undefined}>
          {basename(agent.cwd)}
          {agent.role ? ` · ${agent.role}` : ''}
          {agent.model ? ` · ${agent.model}` : ''}
          {agent.modelReason ? ` (${agent.modelReason})` : ''}
          {agent.sessionId ? ` · ${agent.sessionId.slice(0, 8)}` : ''}
        </span>
        <nav className="win-acts">
          {/* Só aparece quando há o que desfazer: uma janela no arranjo não tem
              o que realinhar, e um botão morto no cabeçalho é ruído. */}
          {rect.pinned && (
            <button
              onClick={() => props.onLayout({ pinned: false }, true)}
              title="devolve esta janela à coluna de quem a abriu"
            >
              realinhar
            </button>
          )}
          <button onClick={props.onHelper} title="abre um agente que depende deste">
            helper
          </button>
          <button onClick={() => props.onLayout({ collapsed: !collapsed }, true)}>
            {collapsed ? 'abrir' : 'recolher'}
          </button>
          {agent.live ? (
            <button onClick={props.onStop}>parar</button>
          ) : agent.sessionId ? (
            <button onClick={props.onResume}>resumir</button>
          ) : null}
          <button onClick={props.onRemove}>fechar</button>
        </nav>
      </header>

      {collapsed ? (
        <div className="win-card">
          {/* Recolhida, a janela é o que o agente disse de si no último
              `report` — não o caminho dele, que já está no cabeçalho. Sem o
              report, o card cai no que sempre teve. */}
          {agent.note ? (
            <p className="win-note">
              <strong>{agent.note.status}</strong> {agent.note.summary}
            </p>
          ) : (
            <p>
              {agent.cwd}
              {agent.exitCode !== null ? ` · saiu com ${agent.exitCode}` : ''}
            </p>
          )}
        </div>
      ) : (
        <>
          {/* Capture nos dois: `pointerdown` cancelado já suprime o `mousedown`
              de compatibilidade na maioria dos navegadores, mas é do `mousedown`
              que o xterm inicia a seleção — barrar os dois é barato. */}
          <div
            className="win-term"
            onPointerDownCapture={onTermPointerDown}
            onMouseDownCapture={(e) => {
              if (!atOne) {
                e.preventDefault()
                e.stopPropagation()
              }
            }}
          >
            <AgentTerminal
              resolveAgent={props.resolveAgent}
              focused={focused}
              fontScale={magnify}
            />
          </div>
          <span className="win-grip" onPointerDown={onResizeDown} aria-hidden="true" />
        </>
      )}
    </article>
  )
}
