// O canal de mudanças do estado dos agentes.
//
// Sem isto o front só descobre uma mudança no próximo poll, e o status fica
// com atraso de segundos — o que é fatal justamente pro estado que mais
// importa: `precisa de você` só serve se acender na hora.
//
// Um emissor mínimo, sem dependência de WebSocket, pra `agents.ts` poder
// avisar sem importar a camada de rede (e sem ciclo de import).

type Listener = () => void

const listeners = new Set<Listener>()

export function onAgentsChanged(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Alguma coisa mudou na lista de agentes. Chamado junto da persistência. */
export function emitAgentsChanged(): void {
  for (const fn of listeners) {
    try {
      fn()
    } catch (err) {
      console.error('ouvinte de eventos falhou:', err instanceof Error ? err.message : err)
    }
  }
}
