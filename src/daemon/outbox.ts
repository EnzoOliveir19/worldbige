// A caixa de saída de cada agente: o que o worldbige tem a dizer pra uma
// sessão que está rodando num pty.
//
// Só existe um caminho pra falar com um agente já aberto, e é o teclado dele.
// Isso faz de toda mensagem um risco de atropelo: digitar durante um prompt de
// permissão responde o prompt, e digitar enquanto o Enzo escreve mistura texto
// com texto. Por isso a mensagem não é escrita quando nasce — ela entra numa
// fila, e a fila só anda quando a sessão está mesmo livre.
//
// Duas coisas usam este canal, e é de propósito que seja o mesmo mecanismo:
//   - o prompt inicial do helper ("leia seu brief em <caminho> e siga"), que
//     não pode ser digitado antes de a TUI subir;
//   - a notificação do lead quando um helper reporta ou conclui.
// Os dois têm o mesmo perigo e a mesma condição de segurança, então têm a mesma
// fila. Um helper aberto numa pasta não confiada guarda o brief na fila em vez
// de perdê-lo no vazio.
//
// Este módulo não conhece pty nenhum: ele guarda e decide, e quem escreve é o
// `agents.ts`, que é o dono dos ptys.

/** O que uma mensagem é, só pra leitura de log. */
export type OutgoingKind = 'brief' | 'notice'

export type Outgoing = {
  kind: OutgoingKind
  /** o texto digitado na sessão, sem o Enter */
  text: string
  at: number
  /**
   * Não entregar antes disto.
   *
   * O caso é o brief de um helper recém-aberto: ele fica pronto no mesmo
   * instante em que a sessão nasce, e a sessão anuncia SessionStart durante a
   * própria subida — antes de a TUI estar desenhada. O pty enfileira o que
   * chega cedo demais, mas uma folga de um segundo evita depender disso.
   */
  notBefore?: number
}

const queues = new Map<string, Outgoing[]>()
const lastTyped = new Map<string, number>()

/** Põe uma mensagem na fila do agente e devolve o tamanho dela. */
export function enqueue(
  agentId: string,
  kind: OutgoingKind,
  text: string,
  notBefore?: number,
): number {
  const queue = queues.get(agentId) ?? []
  queue.push({ kind, text, at: Date.now(), ...(notBefore ? { notBefore } : {}) })
  queues.set(agentId, queue)
  return queue.length
}

export function pending(agentId: string): number {
  return queues.get(agentId)?.length ?? 0
}

/** A próxima mensagem, sem tirá-la da fila. */
export function peek(agentId: string): Outgoing | null {
  return queues.get(agentId)?.[0] ?? null
}

/** Tira a próxima mensagem da fila. */
export function shift(agentId: string): Outgoing | null {
  const queue = queues.get(agentId)
  if (!queue?.length) return null
  const next = queue.shift() as Outgoing
  if (!queue.length) queues.delete(agentId)
  return next
}

/** Devolve uma mensagem ao começo da fila — a entrega não aconteceu. */
export function unshift(agentId: string, message: Outgoing): void {
  const queue = queues.get(agentId) ?? []
  queue.unshift(message)
  queues.set(agentId, queue)
}

export function clear(agentId: string): void {
  queues.delete(agentId)
  lastTyped.delete(agentId)
}

/**
 * O Enzo digitou neste agente agora.
 *
 * É o segundo caso de colisão do TDD, o que a fila sozinha não cobre: o lead
 * pode estar `idle` e ainda assim ter alguém escrevendo nele. O daemon vê todo
 * o teclado que passa pelo WebSocket, então ele sabe — e segurar a entrega por
 * alguns segundos é mais barato que uma mensagem no meio de uma frase.
 */
export function noteTyping(agentId: string): void {
  lastTyped.set(agentId, Date.now())
}

/** Teve digitação humana nos últimos `withinMs`? */
export function typingRecently(agentId: string, withinMs: number, now = Date.now()): boolean {
  const at = lastTyped.get(agentId)
  return at !== undefined && now - at < withinMs
}

/**
 * A frase que o lead recebe quando um helper conclui.
 *
 * A forma é fixa, e o prefixo `[worldbige]` é a parte que mais importa: se uma
 * entrega escapar da regra e cair fora de hora, ela tem que ser reconhecível no
 * scrollback como uma coisa que o daemon escreveu, não como uma coisa que o
 * Enzo escreveu ou que o modelo alucinou.
 */
export function doneNotice(helper: string, summary: string, file: string): string {
  return `[worldbige] helper "${helper}" concluiu: ${summary} Resultado em ${file}.`
}

/** A frase de progresso: mesmo prefixo, sem caminho de resultado. */
export function reportNotice(helper: string, status: string, summary: string): string {
  return `[worldbige] helper "${helper}" (${status}): ${summary}`
}
