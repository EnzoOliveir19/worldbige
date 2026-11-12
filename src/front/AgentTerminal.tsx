// ============================================================
// A fiação do xterm é derivada do ccanvas
// (https://github.com/DevoidSloth/ccanvas)
// Copyright 2026 DevoidSloth — Apache License 2.0
// ============================================================
//
// Um xterm ligado ao pty de um agente.
//
// A ordem aqui é a correção do bug de scrollback duplicado. O `fit()` só vale
// depois que a fonte carregou e o layout assentou: medir antes devolve um
// tamanho provisório, e cada tamanho provisório vira um resize de verdade, que
// faz a TUI do Claude repintar e empilhar uma cópia do desenho. Então:
//
//   1. abre o xterm
//   2. espera `document.fonts.ready` e dois frames
//   3. mede
//   4. SÓ ENTÃO resolve o agente, já com essas dimensões
//   5. conecta com o mesmo tamanho
//   6. só depois disso começa a observar redimensionamento
//
// Resultado: abrir e reabrir a aba sem mexer na janela não gera resize nenhum,
// e portanto nenhum redesenho. Redimensionar a janela de propósito continua
// gerando um resize real — e aí a TUI repinta mesmo, como num terminal comum.
import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { connectAgent, type Transport } from './transport'

const RESIZE_DEBOUNCE_MS = 150

type Props = {
  /**
   * Devolve o id do agente já dimensionado. Chamado uma única vez, depois da
   * medição — é o que permite criar o agente no tamanho certo em vez de criar
   * num tamanho qualquer e corrigir com um resize logo em seguida.
   */
  resolveAgent: (cols: number, rows: number) => Promise<string | null>
}

/** Espera o layout assentar: dois frames depois das fontes. */
function layoutSettled(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

export function AgentTerminal({ resolveAgent }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  // O último tamanho que o daemon já conhece. Nunca remandamos o mesmo.
  const lastSent = useRef<{ cols: number; rows: number } | null>(null)
  // A prop muda de identidade a cada render do pai; guardada num ref, o efeito
  // abaixo roda uma vez só por montagem. Sem isso o terminal seria recriado a
  // cada render — e cada recriação é uma reconexão, que é o que queremos evitar.
  const resolveRef = useRef(resolveAgent)
  resolveRef.current = resolveAgent

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    let disposed = false
    let transport: Transport | null = null
    let debounce: number | undefined

    const term = new Terminal({
      fontFamily: 'Cascadia Mono, Consolas, Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.0,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10_000,
      theme: {
        background: '#12131a',
        foreground: '#d7dae3',
        cursor: '#e8795a',
        selectionBackground: '#2d3350',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)

    // Handle de inspeção: dá acesso ao buffer renderizado de fora da página,
    // que é a única forma de verificar o scrollback por automação. Sem isso o
    // teste só enxerga o que está no viewport, e duplicata em scrollback passa.
    const debug = (window as unknown as { __worldbige?: Record<string, unknown> }).__worldbige ?? {}
    debug.screenText = () => {
      const buf = term.buffer.active
      const lines: string[] = []
      for (let i = 0; i < buf.length; i++) {
        lines.push(buf.getLine(i)?.translateToString(true) ?? '')
      }
      return lines.join('\n')
    }
    debug.size = () => ({ cols: term.cols, rows: term.rows })
    ;(window as unknown as { __worldbige?: Record<string, unknown> }).__worldbige = debug

    const observer = new ResizeObserver(() => {
      if (disposed) return
      window.clearTimeout(debounce)
      debounce = window.setTimeout(() => {
        if (disposed || !transport) return
        try {
          fit.fit()
        } catch {
          return
        }
        const { cols, rows } = term
        const prev = lastSent.current
        // Só fala com o daemon se mudou de verdade.
        if (prev && prev.cols === cols && prev.rows === rows) return
        lastSent.current = { cols, rows }
        transport.resize(cols, rows)
      }, RESIZE_DEBOUNCE_MS)
    })

    void (async () => {
      // 1 + 2: fonte e layout. Sem isso a medição sai provisória.
      try {
        await document.fonts.ready
      } catch {
        /* navegador sem a API — segue */
      }
      if (disposed) return
      await layoutSettled()
      if (disposed) return

      // 3: medir
      try {
        fit.fit()
      } catch {
        /* host ainda sem layout */
      }
      const cols = term.cols
      const rows = term.rows
      lastSent.current = { cols, rows }

      // 4: o agente nasce já neste tamanho
      let id: string | null = null
      try {
        id = await resolveRef.current(cols, rows)
      } catch (err) {
        term.write(
          `\r\n\x1b[31m[worldbige] ${err instanceof Error ? err.message : String(err)}\x1b[0m\r\n`,
        )
        return
      }
      if (disposed || !id) return

      // 5: conectar no mesmo tamanho medido
      const t = await connectAgent(
        id,
        { cols, rows },
        {
          onData: (chunk) => term.write(chunk),
          onClose: () => {
            if (!disposed) {
              term.write(
                '\r\n\x1b[2m[worldbige] conexão encerrada — a sessão segue no daemon.\x1b[0m\r\n',
              )
            }
          },
        },
      )
      if (disposed) {
        t?.close()
        return
      }
      if (!t) {
        term.write('\r\n\x1b[31m[worldbige] não consegui ligar no agente.\x1b[0m\r\n')
        return
      }
      transport = t
      // O teclado só vai pro pty agora: com o transporte ligado, a resposta do
      // xterm à consulta de cursor do programa encontra o caminho de volta.
      term.onData((data) => t.send(data))
      term.focus()

      // 6: a partir daqui, redimensionar a janela é intenção do usuário
      observer.observe(host)
    })()

    return () => {
      disposed = true
      window.clearTimeout(debounce)
      observer.disconnect()
      // close() desassina; o pty é do daemon e continua trabalhando.
      transport?.close()
      term.dispose()
    }
    // monta uma vez: a prop vive no ref acima
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <div className="term-host" ref={hostRef} />
}
