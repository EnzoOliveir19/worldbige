// ============================================================
// A matemática de pan/zoom é derivada do ccanvas
// (https://github.com/DevoidSloth/ccanvas)
// Copyright 2026 DevoidSloth — Apache License 2.0
// ============================================================
//
// Uma câmera só, aplicada à camada do mundo como
// `translate(px, py) scale(z)`. Tudo o mais — janelas, setas — vive em
// coordenadas de mundo e nunca sabe que existe zoom.
//
// A convenção: tela = mundo * z + pan.

export type Camera = { x: number; y: number; z: number }

export type Rect = { x: number; y: number; w: number; h: number }

export const MIN_Z = 0.12
export const MAX_Z = 2.5

/**
 * O zoom em que a câmera pousa ao ir até uma janela: exatamente 1.
 *
 * Não é preferência estética, é a única escala em que o terminal é um terminal.
 * O xterm converte pixel em linha/coluna medindo o retângulo do elemento (que a
 * transform escala) e dividindo pelo tamanho da célula (que ela não escala):
 * em qualquer zoom diferente de 1 a conta dá errado e a seleção do mouse pega
 * outro pedaço de texto. Pousar em 1 é o que devolve a seleção.
 *
 * A ampliação do foco não sumiu por causa disso — ela mudou de mecanismo. Quem
 * cresce é a janela, junto com a fonte do terminal, pelo mesmo fator
 * (`FOCUS_SCALE`, em `geometry.ts`): o texto fica maior e nítido, as colunas e
 * linhas não mudam, e a conta do xterm continua certa porque o elemento e a
 * célula cresceram juntos. A câmera fica em 1 o tempo todo.
 */
export const FOCUS_Z = 1

export const IDENTITY: Camera = { x: 0, y: 0, z: 1 }

export function clampZ(z: number): number {
  return Math.min(MAX_Z, Math.max(MIN_Z, z))
}

export function screenToWorld(cam: Camera, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - cam.x) / cam.z, y: (sy - cam.y) / cam.z }
}

/**
 * Zoom ancorado num ponto da tela: o que está sob o cursor continua sob o
 * cursor. Sem a âncora, a roda do mouse puxa o conteúdo pra longe do ponteiro e
 * navegar vira perseguição.
 */
export function zoomAt(cam: Camera, sx: number, sy: number, factor: number): Camera {
  const z = clampZ(cam.z * factor)
  if (z === cam.z) return cam
  const w = screenToWorld(cam, sx, sy)
  return { z, x: sx - w.x * z, y: sy - w.y * z }
}

/** A câmera que põe `rect` dentro de `view`, com folga, centralizado. */
export function fitRect(rect: Rect, view: { w: number; h: number }, pad = 72, maxZ = MAX_Z): Camera {
  if (rect.w <= 0 || rect.h <= 0 || view.w <= 0 || view.h <= 0) return IDENTITY
  const z = Math.min(
    maxZ,
    clampZ(Math.min((view.w - pad * 2) / rect.w, (view.h - pad * 2) / rect.h)),
  )
  return {
    z,
    x: view.w / 2 - (rect.x + rect.w / 2) * z,
    y: view.h / 2 - (rect.y + rect.h / 2) * z,
  }
}

/**
 * A câmera que centraliza `rect` num zoom dado, sem tentar encaixá-lo.
 *
 * É o que o voo até uma janela usa: o zoom é fixo em 1 e a janela fica no meio.
 * Se ela for maior que a tela, sobra pra fora — e isso é melhor que diminuir o
 * zoom, porque abaixo de 1 a seleção do mouse quebra de novo.
 */
export function centerRect(rect: Rect, view: { w: number; h: number }, z: number): Camera {
  return {
    z,
    x: view.w / 2 - (rect.x + rect.w / 2) * z,
    y: view.h / 2 - (rect.y + rect.h / 2) * z,
  }
}

/** O retângulo que contém todos — a moldura do `Ctrl+Shift+F`. */
export function boundsOf(rects: Rect[]): Rect | null {
  if (!rects.length) return null
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const r of rects) {
    x0 = Math.min(x0, r.x)
    y0 = Math.min(y0, r.y)
    x1 = Math.max(x1, r.x + r.w)
    y1 = Math.max(y1, r.y + r.h)
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/** Desaceleração suave: rápido no começo, assentando no fim. */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

/**
 * Leva a câmera de um lugar ao outro.
 *
 * A animação existe por um motivo só: um corte seco entre dois enquadramentos
 * apaga a noção de onde a janela estava, que é justamente o que o canvas dá.
 * Quem pediu menos movimento no sistema recebe o corte seco.
 */
export function tweenCamera(
  from: Camera,
  to: Camera,
  onFrame: (cam: Camera) => void,
  ms = 420,
): () => void {
  if (prefersReducedMotion() || ms <= 0) {
    onFrame(to)
    return () => undefined
  }
  const start = performance.now()
  let raf = 0
  let done = false

  const step = (now: number) => {
    const t = Math.min(1, (now - start) / ms)
    const e = easeOutCubic(t)
    onFrame({
      x: from.x + (to.x - from.x) * e,
      y: from.y + (to.y - from.y) * e,
      // O zoom interpola em escala logarítmica: linear, a metade do caminho
      // entre 0,2 e 2 cairia em 1,1 e o movimento pareceria um tranco.
      z: from.z * Math.pow(to.z / from.z, e),
    })
    if (t < 1 && !done) raf = requestAnimationFrame(step)
  }
  raf = requestAnimationFrame(step)

  return () => {
    done = true
    cancelAnimationFrame(raf)
  }
}
