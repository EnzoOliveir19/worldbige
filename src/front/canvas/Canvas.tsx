// ============================================================
// O gesto de pan/zoom é derivado do ccanvas
// (https://github.com/DevoidSloth/ccanvas)
// Copyright 2026 DevoidSloth — Apache License 2.0
// ============================================================
//
// O campo pontilhado e a camada do mundo.
//
// Uma regra manda neste arquivo: nada de `will-change: transform` nem de filtro
// na camada do mundo. O zoom é `scale()`, e texto em DOM o navegador rasteriza
// DEPOIS da transform — por isso o terminal continua nítido em qualquer zoom.
// Promover a camada a textura (que é o que `will-change` faz) inverteria a
// ordem: rasteriza uma vez e escala o bitmap, e aí o terminal borra.
import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { zoomAt, type Camera } from './viewport'

/** Espaçamento dos pontos em coordenadas de mundo. */
const DOT_GAP = 28

type Props = {
  camera: Camera
  onCamera: (next: Camera) => void
  /** clicou no vazio: o canvas tira o foco de quem estava com ele */
  onBackground: () => void
  children: ReactNode
}

export function Canvas({ camera, onCamera, onBackground, children }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  // A câmera no ref, pra roda e arrasto lerem o valor corrente sem reassinar.
  const camRef = useRef(camera)
  camRef.current = camera
  const spaceDown = useRef(false)

  // `wheel` precisa ser passivo=false pra poder cancelar o scroll da página, e o
  // React registra passivo por padrão — daí o listener na mão.
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const factor = Math.exp(-e.deltaY * 0.0014)
      onCamera(zoomAt(camRef.current, e.clientX - r.left, e.clientY - r.top, factor))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onCamera])

  // Espaço arrasta o canvas — menos quando o teclado está dentro de um terminal,
  // onde espaço é espaço.
  useEffect(() => {
    const typing = () => {
      const el = document.activeElement
      return !!el && (el.closest('.xterm') !== null || el.tagName === 'INPUT')
    }
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !typing()) {
        spaceDown.current = true
        document.body.classList.add('panning')
      }
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceDown.current = false
        document.body.classList.remove('panning')
      }
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const onEmpty = e.target === e.currentTarget || (e.target as HTMLElement).dataset.field === 'yes'
    const wantsPan = e.button === 1 || spaceDown.current || (e.button === 0 && onEmpty)
    if (!wantsPan) return
    if (e.button === 0 && onEmpty) onBackground()

    e.currentTarget.setPointerCapture(e.pointerId)
    const startX = e.clientX
    const startY = e.clientY
    const from = camRef.current
    let moved = false

    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      if (!moved && Math.abs(dx) + Math.abs(dy) > 2) {
        moved = true
        document.body.classList.add('panning')
      }
      onCamera({ ...camRef.current, x: from.x + dx, y: from.y + dy })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (!spaceDown.current) document.body.classList.remove('panning')
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div className="canvas" ref={rootRef} onPointerDown={onPointerDown} data-field="yes">
      {/* O campo de pontos vive em coordenadas de tela, com o passo e a origem
          derivados da câmera: um elemento gigante dentro da transform custaria
          caro e não ficaria mais nítido. */}
      <div
        className="canvas-dots"
        data-field="yes"
        style={{
          backgroundSize: `${DOT_GAP * camera.z}px ${DOT_GAP * camera.z}px`,
          backgroundPosition: `${camera.x}px ${camera.y}px`,
          opacity: Math.min(1, Math.max(0.25, camera.z)),
        }}
      />
      <div
        className="canvas-world"
        style={{
          transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.z})`,
        }}
      >
        {children}
      </div>
    </div>
  )
}
