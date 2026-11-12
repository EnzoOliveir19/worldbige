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
  MODEL_OPTIONS,
  resumeAgent,
  subscribeAgents,
  stopAgent,
  type Agent,
  type Health,
} from './transport'

/** Um painel na tela. `agent` é null enquanto o terminal ainda está medindo. */
type Panel = { key: string; agent: Agent | null; cwd: string; model: string }

export function App() {
  const [panels, setPanels] = useState<Panel[]>([])
  const [health, setHealth] = useState<Health | null>(null)
  const [cwd, setCwd] = useState('')
  const [model, setModel] = useState('')
  const [error, setError] = useState<string | null>(null)
  // O que estava escolhido no momento do clique, lido quando o painel resolver.
  const pending = useRef<Map<string, { cwd: string; model: string }>>(new Map())

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
            .map((a) => ({ key: a.id, agent: a, cwd: a.cwd, model: a.model ?? '' }))
          const updated = prev.map((p) =>
            p.agent ? { ...p, agent: list.find((a) => a.id === p.agent?.id) ?? p.agent } : p,
          )
          return [...updated, ...added]
        })
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
    refreshHealth()
  }, [refreshHealth])

  // Casa a lista do daemon com os painéis na tela, preservando os que ainda
  // estão medindo (agent: null).
  const merge = useCallback((list: Agent[]) => {
    setPanels((prev) => {
      const known = new Set(prev.map((p) => p.agent?.id).filter(Boolean))
      const added = list
        .filter((a) => !known.has(a.id))
        .map((a) => ({ key: a.id, agent: a, cwd: a.cwd, model: a.model ?? '' }))
      const updated = prev.map((p) =>
        p.agent ? { ...p, agent: list.find((a) => a.id === p.agent?.id) ?? p.agent } : p,
      )
      return [...updated, ...added]
    })
  }, [])

  useEffect(() => {
    reload()
    // O estado chega empurrado pelo daemon: o status muda na hora, sem poll.
    const off = subscribeAgents(merge)
    // Poll lento só de rede de segurança, pro caso de o canal cair sem avisar.
    const t = setInterval(refreshHealth, 10000)
    return () => {
      off()
      clearInterval(t)
    }
  }, [reload, merge, refreshHealth])

  const onNew = () => {
    setError(null)
    const key = crypto.randomUUID()
    pending.current.set(key, { cwd: cwd.trim(), model })
    setPanels((prev) => [
      ...prev,
      { key, agent: null, cwd: cwd.trim() || '(raiz dos repos)', model },
    ])
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

        const want = pending.current.get(key) ?? { cwd: '', model: '' }
        try {
          const agent = await createAgent({
            cols,
            rows,
            ...(want.cwd ? { cwd: want.cwd } : {}),
            ...(want.model ? { model: want.model } : {}),
          })
          pending.current.delete(key)
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

  const onResume = async (id: string) => {
    setError(null)
    try {
      await resumeAgent(id)
      // A ficha velha é substituída por uma nova: recarrega e remonta o painel.
      setPanels((prev) => prev.filter((p) => p.agent?.id !== id))
      reload()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const onRemove = async (key: string, id?: string) => {
    if (id) await deleteAgent(id)
    pending.current.delete(key)
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
        <select
          className="model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          title="modelo do agente"
        >
          {MODEL_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
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
            {p.agent && (
              <span className={`status status-${p.agent.status}`}>
                {p.agent.status}
                {p.agent.waitingTool ? `: ${p.agent.waitingTool}` : ''}
              </span>
            )}
            <span className="meta">{p.cwd}</span>
            <span className="meta">{p.agent?.model || p.model || 'modelo da conta'}</span>
            {p.agent?.sessionId && (
              <span className="meta" title="session id — é o que o resume usa">
                {p.agent.sessionId.slice(0, 8)}
              </span>
            )}
            {p.agent && (
              <span className="meta">
                {p.agent.cols}×{p.agent.rows}
              </span>
            )}
            {p.agent?.live && <button onClick={() => void onStop(p.agent!.id)}>parar</button>}
            {p.agent && !p.agent.live && p.agent.sessionId && (
              <button onClick={() => void onResume(p.agent!.id)}>resumir</button>
            )}
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
