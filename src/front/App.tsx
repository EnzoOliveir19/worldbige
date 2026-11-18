// O canvas: janelas de agente num campo infinito, ligadas por quem abriu quem,
// com a gaveta à esquerda contando o run.
//
// Três coisas moram aqui e em nenhum outro lugar: a câmera, quem está em foco,
// e a tradução entre o que o daemon sabe (a lista de agentes) e o que a tela
// mostra (painéis, inclusive os que ainda estão nascendo).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AgentWindow } from './AgentWindow'
import { Drawer } from './Drawer'
import { roleOf } from './identity'
import { Canvas } from './canvas/Canvas'
import { Arrows } from './canvas/Arrows'
import { FOCUS_SCALE, WIN_H, WIN_W, focusRect, placeNew, rectOf } from './canvas/geometry'
import {
  FOCUS_Z,
  IDENTITY,
  boundsOf,
  centerRect,
  fitRect,
  tweenCamera,
  type Camera,
} from './canvas/viewport'
import {
  createAgent,
  deleteAgent,
  fetchAgents,
  fetchHealth,
  patchLayout,
  resumeAgent,
  stopAgent,
  subscribeAgents,
  type Agent,
  type AgentLayout,
  type Health,
} from './transport'

/** Largura que a gaveta rouba do viewport ao enquadrar. */
const DRAWER_W = 268
const RAIL_W = 56

/**
 * Um painel é uma janela na tela.
 *
 * Uma janela que este navegador abriu nasce antes do agente: ela aparece como
 * fantasma, o terminal dentro dela mede a si mesmo, e só então o agente é criado
 * com essas dimensões. A chave do painel nunca muda, que é o que impede o React
 * de remontar o terminal quando o fantasma vira agente de verdade — e uma
 * remontagem criaria um segundo agente.
 *
 * A lista de painéis é DERIVADA, não guardada: fantasmas locais primeiro, e
 * depois os agentes que nenhum fantasma reivindicou. Guardá-la abria uma corrida
 * que dava pra ver — o daemon anuncia o agente novo pelo WebSocket antes de a
 * resposta do POST chegar aqui, e por um instante existiam duas janelas do mesmo
 * agente, uma por cima da outra.
 */
type Panel = { key: string; agentId: string | null; ghost: Agent }

/** Uma janela que este navegador abriu e que ainda está virando agente. */
type Ghost = { key: string; agentId: string | null; agent: Agent }

function ghostAgent(
  key: string,
  layout: AgentLayout,
  cwd: string,
  model: string,
  parentId: string | null,
): Agent {
  return {
    id: key,
    name: 'abrindo…',
    cwd: cwd || '…',
    status: 'starting',
    createdAt: Date.now(),
    lastSignalAt: Date.now(),
    exitCode: null,
    cols: 0,
    rows: 0,
    sessionId: null,
    live: false,
    model: (model || null) as Agent['model'],
    modelReason: null,
    // Um fantasma ainda não pertence a run nenhum: quem decide isso é o daemon,
    // no instante em que o agente nasce de verdade.
    runId: '',
    runType: '',
    role: null,
    note: null,
    waitingTool: null,
    layout,
    // O fantasma já sabe de quem é filho, e é o que faz o colchete aparecer no
    // instante do clique em vez de só quando o daemon responde.
    parentId,
    tint: 0,
  }
}

export function App() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [ghosts, setGhosts] = useState<Ghost[]>([])
  const [health, setHealth] = useState<Health | null>(null)
  const [camera, setCamera] = useState<Camera>(IDENTITY)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(true)
  const [searchTick, setSearchTick] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  /** posição durante um arrasto: ainda não foi pro daemon */
  const [overrides, setOverrides] = useState<Record<string, Partial<AgentLayout>>>({})

  const viewRef = useRef<HTMLDivElement | null>(null)
  const cancelTween = useRef<() => void>(() => undefined)
  // A câmera corrente num ref: o tween precisa do ponto de partida sem virar
  // dependência de todo callback que mexe nela.
  const camRef = useRef(camera)
  camRef.current = camera
  // O que estava escolhido no clique, lido quando o painel resolver.
  const pending = useRef<
    Map<
      string,
      {
        cwd: string
        model: string
        parentId: string | null
        runType?: string
        subject?: string
      }
    >
  >(new Map())

  // ---------- o que o daemon sabe ----------

  const sync = useCallback((list: Agent[]) => {
    setAgents(list)
    // Um fantasma que já virou agente e cujo agente sumiu (fechado, ou trocado
    // por outro no resume) cumpriu o seu papel: sai, e a janela que sobrar é a
    // do agente de verdade.
    setGhosts((prev) => {
      const ids = new Set(list.map((a) => a.id))
      const kept = prev.filter((g) => !g.agentId || ids.has(g.agentId))
      return kept.length === prev.length ? prev : kept
    })
  }, [])

  const panels = useMemo<Panel[]>(() => {
    const claimed = new Set(ghosts.map((g) => g.agentId).filter(Boolean))
    return [
      ...ghosts.map((g) => ({ key: g.key, agentId: g.agentId, ghost: g.agent })),
      ...agents.filter((a) => !claimed.has(a.id)).map((a) => ({ key: a.id, agentId: a.id, ghost: a })),
    ]
  }, [ghosts, agents])

  useEffect(() => {
    fetchAgents().then(sync).catch(() => undefined)
    fetchHealth().then(setHealth).catch(() => undefined)
    const off = subscribeAgents(sync)
    const tick = setInterval(() => setNow(Date.now()), 1000)
    const slow = setInterval(() => {
      fetchHealth().then(setHealth).catch(() => undefined)
    }, 10_000)
    return () => {
      off()
      clearInterval(tick)
      clearInterval(slow)
    }
  }, [sync])

  // A verdade na tela: o que o daemon disse, com o arrasto em curso por cima.
  const shown = useMemo(() => {
    const byId = new Map(agents.map((a) => [a.id, a]))
    return panels.map((p) => {
      const base = (p.agentId ? byId.get(p.agentId) : undefined) ?? p.ghost
      const over = overrides[base.id]
      return over ? { ...base, layout: { ...base.layout, ...over } } : base
    })
  }, [panels, agents, overrides])

  /**
   * Esta janela está ampliada por estar em foco?
   *
   * Um painel pode estar em foco pela chave (enquanto é fantasma) ou pelo id
   * do agente (depois que nasceu) — a mesma conta que decide `focused`.
   */
  const scaleOf = useCallback(
    (panel: Panel, agentId: string): number => {
      // Um fantasma — a janela que ainda está medindo o terminal pra fazer o
      // agente nascer — NUNCA amplia, mesmo nascendo em foco.
      //
      // É essa medida que define as colunas e linhas da sessão, e ela tem que
      // acontecer no tamanho real. Ampliado, o terminal mede 2 colunas a mais:
      // a janela cresce 1,4 mas o cromo (cabeçalho, margens, padding) não
      // cresce nada, então a área útil cresce 1,43 e sobra espaço pra mais
      // coluna. O agente nasceria com 101 colunas e o primeiro desfoque o
      // corrigiria pra 99 — um resize de verdade, logo um repaint da TUI,
      // exatamente o que esta mudança existe pra não ter.
      if (!panel.agentId) return 1
      return focusedId === agentId || focusedId === panel.key ? FOCUS_SCALE : 1
    },
    [focusedId],
  )

  /**
   * As setas enxergam a janela ampliada, não a de baixo.
   *
   * O colchete encosta na borda do que está desenhado; se ele usasse o
   * retângulo normal, a ponta da linha ficaria escondida atrás da janela em
   * foco, que é maior.
   */
  const linked = useMemo(
    () =>
      shown.map((a, i) => {
        const scale = scaleOf(panels[i] as Panel, a.id)
        // Card recolhido não amplia — a janela também não amplia, e as duas
        // contas têm que dar o mesmo, senão a linha erra a borda.
        if (scale === 1 || a.layout.collapsed) return a
        const r = focusRect(rectOf(a), scale)
        // `collapsed` mantém a altura do card; o retângulo já veio com ela.
        return { ...a, layout: { ...a.layout, x: r.x, y: r.y, w: r.w, h: r.h, collapsed: false } }
      }),
    [shown, panels, scaleOf],
  )

  // ---------- câmera ----------

  const viewport = () => {
    const el = viewRef.current
    return { w: el?.clientWidth ?? window.innerWidth, h: el?.clientHeight ?? window.innerHeight }
  }

  /**
   * Voa até a câmera que `make` calcular. A área livre exclui a gaveta: medir
   * pelo viewport inteiro esconderia metade da janela atrás dela.
   */
  const flyTo = useCallback(
    (make: (view: { w: number; h: number }) => Camera) => {
      const inset = drawerOpen ? DRAWER_W : RAIL_W
      const view = viewport()
      const to = make({ w: Math.max(240, view.w - inset), h: view.h })
      to.x += inset
      cancelTween.current()
      cancelTween.current = tweenCamera(camRef.current, to, setCamera)
    },
    [drawerOpen],
  )

  /**
   * O teclado passa a ser desta janela e ela vem pra frente — sem mexer na
   * câmera. É o que um clique dentro do terminal faz quando o zoom já está em 1:
   * ninguém quer a tela voando no meio de uma seleção de texto.
   */
  const touch = useCallback(
    (id: string) => {
      setFocusedId(id)
      // `z: -1` é "topo": quem sabe qual é o topo é o daemon, que vê todas elas.
      if (agents.some((a) => a.id === id)) void patchLayout(id, { z: -1 }).catch(() => undefined)
    },
    [agents],
  )

  /** Leva a câmera até a janela e entrega o teclado a ela. Pousa em zoom 1. */
  const goTo = useCallback(
    (id: string) => {
      const agent = shown.find((a) => a.id === id)
      if (!agent) return
      touch(id)
      flyTo((view) => centerRect(rectOf(agent), view, FOCUS_Z))
    },
    [shown, touch, flyTo],
  )

  const fitAll = useCallback(() => {
    const box = boundsOf(shown.map(rectOf))
    setFocusedId(null)
    // Sair do terminal é parte do gesto: `Ctrl+Shift+F` é "me tira daqui e me
    // mostra o run", e o teclado tem que sair junto.
    ;(document.activeElement as HTMLElement | null)?.blur()
    if (!box) {
      cancelTween.current()
      setCamera(IDENTITY)
      return
    }
    flyTo((view) => fitRect(box, view, 72, 1))
  }, [shown, flyTo])

  // Os atalhos são capturados antes do xterm: dentro de um terminal em foco,
  // qualquer tecla seria consumida pela sessão e o atalho nunca chegaria aqui.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey || e.altKey) return
      const key = e.key.toLowerCase()
      if (key === 'f') {
        e.preventDefault()
        e.stopPropagation()
        fitAll()
      } else if (key === 'b') {
        e.preventDefault()
        e.stopPropagation()
        setDrawerOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [fitAll])

  // ---------- abrir, mover, fechar ----------

  const openAgent = useCallback(
    (input: {
      cwd: string
      model: string
      parentId?: string | null
      runType?: string
      subject?: string
    }) => {
      setError(null)
      const key = crypto.randomUUID()
      const parentId = input.parentId ?? null
      const spot = placeNew(shown, parentId)
      const layout: AgentLayout = { ...spot, w: WIN_W, h: WIN_H, collapsed: false, z: 999 }
      pending.current.set(key, {
        cwd: input.cwd,
        model: input.model,
        parentId,
        // Só o agente raiz leva tipo e assunto: um helper herda o run inteiro
        // de quem o abriu, e mandá-los aqui seria o front opinando sobre uma
        // decisão que é do daemon.
        ...(parentId ? {} : { runType: input.runType, subject: input.subject }),
      })
      setGhosts((prev) => [
        ...prev,
        { key, agentId: null, agent: ghostAgent(key, layout, input.cwd, input.model, parentId) },
      ])
      setFocusedId(key)
      flyTo((view) => centerRect({ ...spot, w: WIN_W, h: WIN_H }, view, FOCUS_Z))
    },
    [shown, flyTo],
  )

  /**
   * Chamado pelo terminal DEPOIS de medir: é aqui que o agente nasce, já com as
   * dimensões certas — por isso o primeiro attach não precisa de resize, e sem
   * resize a TUI não repinta.
   */
  const resolveFor = useCallback(
    (panel: Panel) =>
      async (cols: number, rows: number): Promise<string | null> => {
        if (panel.agentId) return panel.agentId
        const want = pending.current.get(panel.key)
        if (!want) return null
        try {
          const agent = await createAgent({
            cols,
            rows,
            ...(want.cwd ? { cwd: want.cwd } : {}),
            // O modelo vai SEMPRE, inclusive vazio: `''` é "padrão da conta" e
            // ausente é "auto", e omitir o campo quando a escolha é vazia faria
            // as duas opções do dropdown darem no mesmo.
            model: want.model,
            ...(want.runType ? { runType: want.runType } : {}),
            ...(want.subject ? { subject: want.subject } : {}),
            ...(want.parentId ? { parentId: want.parentId } : {}),
            // Sem o `z`: o lugar na tela é do front, a ordem de empilhamento é
            // do daemon, que é quem vê todas as janelas.
            layout: {
              x: panel.ghost.layout.x,
              y: panel.ghost.layout.y,
              w: panel.ghost.layout.w,
              h: panel.ghost.layout.h,
            },
          })
          pending.current.delete(panel.key)
          setGhosts((prev) =>
            prev.map((g) => (g.key === panel.key ? { ...g, agentId: agent.id } : g)),
          )
          setFocusedId((id) => (id === panel.key ? agent.id : id))
          return agent.id
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e)
          setError(message)
          pending.current.delete(panel.key)
          setGhosts((prev) => prev.filter((g) => g.key !== panel.key))
          throw e
        }
      },
    [],
  )

  const onLayout = useCallback((id: string, patch: Partial<AgentLayout>, commit: boolean) => {
    setOverrides((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))
    if (!commit) return
    void patchLayout(id, patch)
      .catch(() => undefined)
      .finally(() => {
        // O daemon respondeu e já empurrou a lista nova: o local sai de cena.
        setOverrides((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
      })
  }, [])

  const onRemove = useCallback(async (panel: Panel) => {
    pending.current.delete(panel.key)
    setGhosts((prev) => prev.filter((g) => g.key !== panel.key))
    if (panel.agentId) await deleteAgent(panel.agentId)
  }, [])

  const onResume = useCallback(async (id: string) => {
    setError(null)
    try {
      await resumeAgent(id)
      const list = await fetchAgents()
      sync(list)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [sync])

  return (
    <div className={`app${drawerOpen ? ' drawer-open' : ''}`} ref={viewRef}>
      <Canvas camera={camera} onCamera={setCamera} onBackground={() => setFocusedId(null)}>
        <Arrows agents={linked} />
        {panels.map((panel, i) => {
          const agent = shown[i] as Agent
          return (
            <AgentWindow
              key={panel.key}
              agent={agent}
              role={roleOf(agent, shown)}
              zoom={camera.z}
              scale={scaleOf(panel, agent.id)}
              focused={focusedId === agent.id || focusedId === panel.key}
              onFocus={() => goTo(agent.id)}
              onTouch={() => touch(agent.id)}
              onReframe={() => goTo(agent.id)}
              onLayout={(patch, commit) =>
                panel.agentId ? onLayout(panel.agentId, patch, commit) : undefined
              }
              onHelper={() =>
                openAgent({
                  cwd: '',
                  // O helper herda o modelo de quem o abriu. Sem isso ele cairia
                  // no padrão da conta, e um lead em haiku abriria helpers em
                  // opus sem ninguém pedir. O roteamento por tabela, que é quem
                  // vai decidir isso de verdade, chega na unidade 4.
                  model: agent.model ?? '',
                  parentId: agent.id,
                })
              }
              onStop={() => void stopAgent(agent.id)}
              onResume={() => void onResume(agent.id)}
              onRemove={() => void onRemove(panel)}
              resolveAgent={resolveFor(panel)}
            />
          )
        })}
      </Canvas>

      <Drawer
        open={drawerOpen}
        onToggle={() => setDrawerOpen((v) => !v)}
        onOpenSearch={() => {
          setDrawerOpen(true)
          setSearchTick((n) => n + 1)
        }}
        searchTick={searchTick}
        agents={shown}
        health={health}
        focusedId={focusedId}
        onGoTo={goTo}
        onNew={(input) => openAgent(input)}
        now={now}
      />

      {error && (
        <p className="toast" role="alert" onClick={() => setError(null)}>
          {error}
        </p>
      )}

      {!panels.length && (
        <p className="blank">
          Nada aberto ainda. Abra um agente pela gaveta — ele vira uma janela aqui, e o botão
          <em> helper</em> no cabeçalho dela abre o próximo, ligado por uma seta.
        </p>
      )}
    </div>
  )
}
