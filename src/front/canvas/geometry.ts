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
const GAP_X = 72
const GAP_Y = 120

export function rectOf(agent: Agent): Rect {
  const { x, y, w, h, collapsed } = agent.layout
  return { x, y, w, h: collapsed ? CARD_H : h }
}

/**
 * Onde uma janela nova entra: helper abaixo de quem o abriu, irmão à direita do
 * irmão anterior, raiz à direita da última raiz.
 *
 * A mesma regra vive no daemon, e a duplicação é deliberada. O daemon precisa
 * dela pros spawns que não têm navegador (o `spawn_helper` do MCP, na unidade
 * 4); o front precisa dela antes, porque a janela existe como fantasma enquanto
 * mede o terminal, e é essa medida que faz o agente nascer no tamanho certo.
 * Se o front não escolhesse o lugar, a janela nasceria num ponto e pularia pro
 * outro assim que o daemon respondesse.
 */
export function placeNew(agents: Agent[], parentId: string | null): { x: number; y: number } {
  const parent = parentId ? agents.find((a) => a.id === parentId) : undefined

  if (parent) {
    const pr = rectOf(parent)
    const siblings = agents.filter((a) => a.parentId === parent.id)
    const y = pr.y + pr.h + GAP_Y
    if (!siblings.length) return { x: pr.x, y }
    const rightmost = siblings.reduce((m, a) => Math.max(m, a.layout.x + a.layout.w), -Infinity)
    return { x: rightmost + GAP_X, y }
  }

  const roots = agents.filter((a) => !a.parentId)
  if (!roots.length) return { x: 0, y: 0 }
  const rightmost = roots.reduce((m, a) => Math.max(m, a.layout.x + a.layout.w), -Infinity)
  return { x: rightmost + GAP_X, y: roots[0]?.layout.y ?? 0 }
}
