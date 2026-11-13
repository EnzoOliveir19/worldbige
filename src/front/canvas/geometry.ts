// O retângulo que uma janela ocupa no mundo.
//
// Mora num arquivo só porque três lugares precisam concordar sobre ele: a
// janela que se desenha, as setas que a encontram, e a câmera que a enquadra.
// Se divergirem, a seta aponta pra um lugar onde a janela não está.
import type { Agent } from '../transport'
import type { Rect } from './viewport'

/**
 * Altura do card recolhido. A largura continua a da janela aberta.
 *
 * Tem folga pra duas ou três linhas: o card recolhido é onde o último `report`
 * do agente vai aparecer (unidade 4), e um card que muda de altura ao receber
 * um resumo faria o canvas inteiro se mexer sozinho.
 */
export const CARD_H = 108

/** Tamanho de uma janela nova. Igual ao do daemon, de propósito — ver `placeNew`. */
export const WIN_W = 840
export const WIN_H = 620
/** Entre uma coluna e a seguinte. É onde o tronco do colchete é desenhado. */
export const COL_GAP = 120
/** Entre dois irmãos empilhados. Fixo: a coluna tem que ler como uma lista. */
export const ROW_GAP = 48
/** Entre uma raiz e a raiz seguinte, com a subárvore inteira no meio. */
const RUN_GAP = 220

export function rectOf(agent: Agent): Rect {
  const { x, y, w, h, collapsed } = agent.layout
  return { x, y, w, h: collapsed ? CARD_H : h }
}

/**
 * Quanto a janela em foco cresce. Mexa aqui pra calibrar.
 *
 * 1.4 é o zoom do voo antigo, e é de propósito: a sensação é a mesma, o
 * mecanismo é que mudou.
 */
export const FOCUS_SCALE = 1.4

/**
 * O retângulo de uma janela em foco: o mesmo, maior, em volta do mesmo centro.
 *
 * Crescer em volta do centro é o que faz a janela inchar no lugar em vez de
 * escorregar pra baixo e pra direita — e, como o centro não se move, a câmera
 * que centraliza o retângulo normal já centraliza este aqui.
 *
 * Este tamanho é de TELA, e não existe no daemon: focar não é redimensionar.
 * Nenhum gesto de arrastar ou redimensionar lê daqui, e nada disto vai parar
 * num `PATCH /layout` — senão enquadrar uma janela gravaria o tamanho ampliado
 * como se você a tivesse esticado.
 */
export function focusRect(rect: Rect, scale: number): Rect {
  if (scale === 1) return rect
  const w = Math.round(rect.w * scale)
  const h = Math.round(rect.h * scale)
  return {
    x: Math.round(rect.x - (w - rect.w) / 2),
    y: Math.round(rect.y - (h - rect.h) / 2),
    w,
    h,
  }
}

/**
 * Onde uma janela nova entra: no fim da coluna de quem a abriu — os helpers de
 * um agente ficam numa coluna à direita dele, empilhados e alinhados pelo topo.
 * Uma raiz nova entra à direita de tudo que já existe, subárvores incluídas.
 *
 * A mesma regra vive no daemon, e a duplicação é deliberada. O daemon precisa
 * dela pros spawns que não têm navegador (o `spawn_helper` do MCP) e pra
 * refazer a pilha quando alguém entra ou sai; o front precisa dela antes,
 * porque a janela existe como fantasma enquanto mede o terminal, e é essa
 * medida que faz o agente nascer no tamanho certo. Se o front não escolhesse o
 * lugar, a janela nasceria num ponto e pularia pro outro assim que o daemon
 * respondesse.
 */
export function placeNew(agents: Agent[], parentId: string | null): { x: number; y: number } {
  const parent = parentId ? agents.find((a) => a.id === parentId) : undefined

  if (parent) {
    const x = Math.round(parent.layout.x + parent.layout.w + COL_GAP)
    // Quem foi arrastado pra fora da coluna não ocupa mais lugar nela.
    const siblings = agents.filter((a) => a.parentId === parent.id && !a.layout.pinned)
    const y = siblings.reduce((acc, a) => acc + rectOf(a).h + ROW_GAP, parent.layout.y)
    return { x, y: Math.round(y) }
  }

  if (!agents.length) return { x: 0, y: 0 }
  const right = agents.reduce((m, a) => Math.max(m, a.layout.x + a.layout.w), -Infinity)
  const top = agents.reduce((m, a) => Math.min(m, a.layout.y), Infinity)
  return { x: Math.round(right + RUN_GAP), y: Math.round(top) }
}
