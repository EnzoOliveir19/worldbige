// A gaveta: o que está acontecendo, em texto, ao lado do canvas.
//
// Ela existe porque o canvas é bom pra onde e ruim pra quantos: olhando o
// campo você sabe quem está onde, mas não quantos agentes esperam você nem há
// quanto tempo o run corre. Recolhida, vira uma régua de pontos coloridos — a
// mesma informação, reduzida ao que cabe em 48 pixels: quem existe, de que cor,
// e quem está chamando.
import { useEffect, useRef, useState } from 'react'
import { elapsed, roleOf, statusLabel, statusTone, tintOf, waitsForYou } from './identity'
import { MODEL_OPTIONS, type Agent, type Health } from './transport'

type Props = {
  open: boolean
  onToggle: () => void
  /** o botão de busca da régua: abre a gaveta já com o cursor na busca */
  onOpenSearch: () => void
  /** muda quando alguém pede a busca; o input se foca */
  searchTick: number
  agents: Agent[]
  health: Health | null
  focusedId: string | null
  onGoTo: (id: string) => void
  onNew: (input: { cwd: string; model: string }) => void
  now: number
}

export function Drawer(props: Props) {
  const { agents, health, open } = props
  const [query, setQuery] = useState('')
  const [cwd, setCwd] = useState('')
  const [model, setModel] = useState('')
  const searchRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (open && props.searchTick > 0) searchRef.current?.focus()
  }, [open, props.searchTick])

  const live = agents.filter((a) => a.live).length
  const limit = health?.maxHelpers ?? 3
  const waiting = agents.filter((a) => waitsForYou(a.status)).length
  // Cada seta é um handoff: alguém abriu alguém.
  const handoffs = agents.filter((a) => a.parentId).length
  const since = agents.length ? Math.min(...agents.map((a) => a.createdAt)) : props.now
  const needle = query.trim().toLowerCase()
  const shown = needle
    ? agents.filter(
        (a) =>
          a.name.toLowerCase().includes(needle) ||
          a.cwd.toLowerCase().includes(needle) ||
          statusLabel(a.status).includes(needle),
      )
    : agents

  if (!open) {
    return (
      <aside className="rail" aria-label="agentes">
        <button className="round" onClick={props.onToggle} title="abrir a gaveta (ctrl+shift+b)">
          ›
        </button>
        <ol className="rail-dots">
          {agents.map((a) => (
            <li key={a.id}>
              <button
                className={`rail-dot tone-${statusTone(a.status)}${a.id === props.focusedId ? ' is-here' : ''}`}
                style={{ ['--tint' as string]: tintOf(a.tint) }}
                onClick={() => props.onGoTo(a.id)}
                title={`${a.name} — ${statusLabel(a.status)}`}
              >
                <span className="sr">{a.name}</span>
              </button>
            </li>
          ))}
        </ol>
        <p className={`rail-count${live > limit ? ' is-over' : ''}`}>
          <strong>{live}</strong>
          <span>/{limit}</span>
        </p>
        <button className="rail-find" onClick={props.onOpenSearch} title="buscar um agente">
          buscar
        </button>
      </aside>
    )
  }

  return (
    <aside className="drawer" aria-label="o run">
      <header className="drawer-head">
        <h1>worldbige</h1>
        <button className="round" onClick={props.onToggle} title="recolher a gaveta (ctrl+shift+b)">
          ‹
        </button>
      </header>

      <p className="drawer-sub">
        {agents.length
          ? `${agents.length} agente${agents.length > 1 ? 's' : ''} no canvas${waiting ? ` · ${waiting} esperando você` : ''}`
          : 'canvas vazio'}
      </p>

      <div className="stats">
        <div>
          <strong>{agents.length ? elapsed(since, props.now) : '—'}</strong>
          <span>tempo de run</span>
        </div>
        <div>
          <strong>{handoffs}</strong>
          <span>handoffs</span>
        </div>
      </div>

      <div className="power" title={`${live} agente(s) vivo(s), limite de ${limit} por run`}>
        <span className="power-dots">
          {Array.from({ length: Math.max(limit, live) }, (_, i) => (
            <i key={i} className={i < live ? 'on' : ''} />
          ))}
        </span>
        <span className="power-label">
          {live} de {limit} vivos
        </span>
      </div>

      <section className="list">
        <header>
          <h2>no canvas</h2>
          <span>{shown.length === agents.length ? `${agents.length}` : `${shown.length} de ${agents.length}`}</span>
        </header>
        <ol>
          {shown.map((a, i) => (
            <li key={a.id}>
              <button
                className={a.id === props.focusedId ? 'is-here' : ''}
                onClick={() => props.onGoTo(a.id)}
              >
                <span className="idx">{String(i + 1).padStart(2, '0')}</span>
                <span className="dot" style={{ ['--tint' as string]: tintOf(a.tint) }} />
                <span className="nm">{a.name}</span>
                {/* O mesmo selo da janela: quem coordena se lê na lista também,
                    sem precisar ir até o canvas conferir de quem sai a seta. */}
                <span className="role">{roleOf(a, agents)}</span>
                <span className={`pill tone-${statusTone(a.status)}`}>{statusLabel(a.status)}</span>
              </button>
            </li>
          ))}
        </ol>
        {!agents.length && <p className="empty">Abra um agente e ele aparece aqui.</p>}
        {agents.length > 0 && !shown.length && <p className="empty">Nada com “{query}”.</p>}
        {agents.length > 3 && (
          <input
            className="search"
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="buscar"
            spellCheck={false}
          />
        )}
      </section>

      <section className="runs">
        <header>
          <h2>runs</h2>
        </header>
        <p className="empty">
          Um run nasce de um lead que abre helpers. Por enquanto o canvas é a sessão.
        </p>
        <div className="new">
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="nome do repo ou caminho"
            title={
              health
                ? `o nome é procurado em: ${health.allowedRoots.join(', ')}`
                : 'nome do repo ou caminho completo'
            }
            spellCheck={false}
          />
          <select value={model} onChange={(e) => setModel(e.target.value)} title="modelo do agente">
            {MODEL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <button className="go" onClick={() => props.onNew({ cwd: cwd.trim(), model })}>
            novo agente
          </button>
        </div>
      </section>

      <footer className="keys">
        <p>
          <kbd>ctrl</kbd>
          <kbd>shift</kbd>
          <kbd>f</kbd> enquadrar tudo
        </p>
        <p>
          <kbd>ctrl</kbd>
          <kbd>shift</kbd>
          <kbd>b</kbd> recolher a gaveta
        </p>
        <p className="hint">
          clique numa janela pra digitar nela · arraste o fundo ou segure espaço pra andar · roda
          pra aproximar
        </p>
      </footer>
    </aside>
  )
}
