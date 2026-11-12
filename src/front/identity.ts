// A identidade visual de um agente e a tradução de status pra tela.
//
// Uma tinta por agente, usada em exatamente três lugares: o ponto na gaveta, a
// linha que liga o agente a quem o abriu, e o fio na borda de cima da janela.
// Nunca como preenchimento — o canvas é de papel, e um bloco de cor saturada
// roubaria o lugar do único destaque que importa, que é `precisa de você`.
import type { Agent, AgentStatus } from './transport'

/**
 * Seis tintas minerais, na mesma faixa de saturação pra nenhuma gritar mais que
 * as outras. A ordem é a de atribuição: o daemon dá a primeira livre.
 */
export const TINTS = [
  '#3f6fb0', // azul
  '#b03f55', // carmim
  '#6a4fb0', // violeta
  '#b08a3f', // ocre
  '#3f8f76', // verde
  '#a65a35', // ferrugem
] as const

export function tintOf(tint: number): string {
  return TINTS[((tint % TINTS.length) + TINTS.length) % TINTS.length] as string
}

/**
 * Como cada status se chama e quanto ele pesa na hierarquia visual.
 *
 * `alarm` é um só, de propósito: `precisa de você` é o estado que justifica o
 * produto, e dois destaques do mesmo peso seriam nenhum.
 */
export type StatusTone = 'alarm' | 'work' | 'rest' | 'end' | 'gone'

export const STATUS: Record<AgentStatus, { label: string; tone: StatusTone }> = {
  starting: { label: 'abrindo', tone: 'work' },
  awaiting_trust: { label: 'espera confiança', tone: 'alarm' },
  running: { label: 'trabalhando', tone: 'work' },
  idle: { label: 'livre', tone: 'rest' },
  needs_you: { label: 'precisa de você', tone: 'alarm' },
  stale: { label: 'calado', tone: 'gone' },
  done: { label: 'concluiu', tone: 'end' },
  stopped: { label: 'parado', tone: 'gone' },
  failed: { label: 'falhou', tone: 'gone' },
}

export function statusLabel(status: AgentStatus): string {
  return STATUS[status]?.label ?? status
}

export function statusTone(status: AgentStatus): StatusTone {
  return STATUS[status]?.tone ?? 'gone'
}

/** `precisa de você` e `espera confiança` são as duas formas de "parei por sua causa". */
export function waitsForYou(status: AgentStatus): boolean {
  return statusTone(status) === 'alarm'
}

/**
 * O papel do agente, pra aparecer como selo na janela, no card e na gaveta.
 *
 * O nome diz QUEM é; o selo diz O QUE ELE É no run. Sem ele, saber quem
 * coordena exige seguir as setas até achar quem não tem pai — e num canvas com
 * dois runs lado a lado isso é trabalho a cada olhada.
 *
 * Quando há mais de um lead na tela, o selo ganha o run: dois selos "lead"
 * iguais não dizem de qual run cada um é. A desambiguação é pelo run e não por
 * id de agente, porque o run é o que a pessoa está acompanhando.
 */
export function roleOf(agent: Agent, all: Agent[]): string {
  if (!agent.parentId) {
    const leads = all.filter((a) => !a.parentId)
    return leads.length > 1 ? `lead · ${shortRun(agent.runId)}` : 'lead'
  }
  return agent.role ? `helper · ${agent.role}` : 'helper'
}

/** `run-20261112-100353-4105` → `run 4105`. O sufixo é o que distingue. */
export function shortRun(runId: string): string {
  const tail = runId.split('-').pop()
  return tail ? `run ${tail}` : 'run'
}

/** mm:ss até uma hora, h:mm:ss depois dela. */
export function elapsed(since: number, now: number): string {
  const total = Math.max(0, Math.floor((now - since) / 1000))
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}
