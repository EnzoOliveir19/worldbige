// Front mínimo das unidades 1 e 2: abrir um agente, usar a TUI do Claude num
// xterm e ver o scrollback voltar ao reabrir a aba. O canvas infinito, as
// janelas arrastáveis e a gaveta entram na unidade 3 — inclusive a alça de
// redimensionar, que lá passa a ser da janela inteira e não do terminal.
import { useCallback, useEffect, useRef, useState } from 'react'
import { AgentTerminal } from './AgentTerminal'
import {
  createAgent,
  deleteAgent,
  fetchAgents,
  fetchHealth,
  stopAgent,
  type Agent,
  type Health,
} from './transport'

/** Um painel na tela. `agent` é null enquanto o terminal ainda está medindo. */
type Panel = { key: string; agent: Agent | null; cwd: string }

export function App() {
  const [panels, setPanels] = useState<Panel[]>([])
  const [health, setHealth] = useState<Health | null>(null)
  const [cwd, setCwd] = useState('')
  const [error, setError] = useState<string | null>(null)
  // O cwd digitado no momento do clique, lido pelo painel quando ele resolver.
  const pendingCwd = useRef<Map<string, string>>(new Map())

  const refreshHealth = useCallback(() => {
    fetchHealth().then(setHealth).catch(() => undefined)
  }, [])

  // Quem sabe quem está vivo é o daemon. Agentes que ele conhece e a tela não
  // mostra entram como painéis já resolvidos.
  const reload = useCallback(() => {
    fetchAgents()
      .then((list) => {
        setPanels((prev) => {
          const known = new Set(prev.map((p) => p.agent?.id).filter(Boolean))
          const added = list
            .filter((a) => !known.has(a.id))
            .map((a) => ({ key: a.id, agent: a, cwd: a.cwd }))
          const updated = prev.map((p) =>
            p.agent ? { ...p, agent: list.find((a) => a.id === p.agent?.id) ?? p.agent } : p,
          )
          return [...updated, ...added]
        })
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
    refreshHealth()
  }, [refreshHealth])

  useEffect(() => {
    reload()
    const t = setInterval(reload, 4000)
    return () => clearInterval(t)
  }, [reload])

  const onNew = () => {
    setError(null)
    const key = crypto.randomUUID()
    pendingCwd.current.set(key, cwd.trim())
    setPanels((prev) => [...prev, { key, agent: null, cwd: cwd.trim() || '(raiz dos repos)' }])
  }

  /**
   * Chamado pelo terminal DEPOIS de medir. É aqui que o agente nasce, já com
   * as dimensões certas — por isso o primeiro attach não precisa de resize.
   */
  const resolveFor = useCallback(
    (key: string) =>
      async (cols: number, rows: number): Promise<string | null> => {
        const existing = panels.find((p) => p.key === key)?.agent
        if (existing) return existing.id

        const requested = pendingCwd.current.get(key) ?? ''
        try {
          const agent = await createAgent({
            cols,
            rows,
            ...(requested ? { cwd: requested } : {}),
          })
          pendingCwd.current.delete(key)
          setPanels((prev) => prev.map((p) => (p.key === key ? { ...p, agent, cwd: agent.cwd } : p)))
          return agent.id
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e)
          setError(message)
          setPanels((prev) => prev.filter((p) => p.key !== key))
          throw e
        }
      },
    [panels],
  )

  const onStop = async (id: string) => {
    await stopAgent(id)
    reload()
  }

  const onRemove = async (key: string, id?: string) => {
    if (id) await deleteAgent(id)
    pendingCwd.current.delete(key)
    setPanels((prev) => prev.filter((p) => p.key !== key))
  }

  return (
    <div className="app">
      <header className="bar">
        <strong>worldbige</strong>
        <input
          className="cwd"
          placeholder={health ? `repo em ${health.reposRoot} (vazio = a própria raiz)` : 'repo…'}
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          spellCheck={false}
        />
        <button onClick={onNew}>novo agente</button>
        <button onClick={reload}>recarregar</button>
      </header>

      {error && <p className="error">{error}</p>}

      {panels.length === 0 && (
        <p className="empty">
          Nenhum agente. Abra um — e, pro teste do scrollback, deixe o Claude responder algo, feche
          a aba, espere a resposta terminar sem ninguém olhando, e reabra. O conteúdo tem que voltar
          igual, sem repetir, quantas vezes você reabrir.
        </p>
      )}

      {panels.map((p) => (
        <section className="agent" key={p.key}>
          <div className="agent-head">
            <span className="name">{p.agent?.name ?? 'medindo…'}</span>
            {p.agent && <span className={`status status-${p.agent.status}`}>{p.agent.status}</span>}
            <span className="meta">{p.cwd}</span>
            {p.agent && (
              <span className="meta">
                {p.agent.cols}×{p.agent.rows}
              </span>
            )}
            {p.agent?.live && <button onClick={() => void onStop(p.agent!.id)}>parar</button>}
            <button onClick={() => void onRemove(p.key, p.agent?.id)}>remover</button>
          </div>
          <div className="agent-term">
            <AgentTerminal resolveAgent={resolveFor(p.key)} />
          </div>
        </section>
      ))}

      {health && (
        <footer className="foot">
          telas: {(health.buffer.bytes / 1024).toFixed(0)} KB em {health.buffer.agents} agente(s) ·
          raízes permitidas: {health.allowedRoots.join(' · ')}
        </footer>
      )}
    </div>
  )
}
