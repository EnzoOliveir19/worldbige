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

/**
 * A paleta do terminal.
 *
 * O canvas é de papel claro e a janela é escura: o contraste é o desenho, não
 * um acidente — uma janela acesa num mundo apagado é o que faz os agentes
 * lerem como coisas vivas. Por isso a paleta é escura mas não preta, e os ANSI
 * são dessaturados o bastante pra conviver com o papel em volta.
 *
 * O cursor é âmbar, a mesma cor de `precisa de você`: âmbar nesta interface
 * quer dizer sempre a mesma coisa — é aqui que você entra.
 */
const TERM_THEME = {
  background: '#0e1210',
  foreground: '#ccd4cc',
  cursor: '#e07a1f',
  cursorAccent: '#0e1210',
  selectionBackground: 'rgba(224, 122, 31, 0.22)',
  black: '#1b211d',
  red: '#d4766c',
  green: '#8fbf87',
  yellow: '#d8b36a',
  blue: '#7fa8d8',
  magenta: '#b998d8',
  cyan: '#7fc3bd',
  white: '#c6cec6',
  brightBlack: '#5c665e',
  brightRed: '#e8908a',
  brightGreen: '#a8d6a0',
  brightYellow: '#e8c98a',
  brightBlue: '#9cc0e8',
  brightMagenta: '#cfb2e8',
  brightCyan: '#9adbd4',
  brightWhite: '#e4eae4',
} as const

/** Os terminais montados agora, pro handle de inspeção saber de quem falar. */
const openTerminals = new Set<Terminal>()

function activeTerminal(): Terminal | null {
  for (const t of openTerminals) {
    if (t.textarea && t.textarea === document.activeElement) return t
  }
  return openTerminals.values().next().value ?? null
}

type Props = {
  /**
   * Devolve o id do agente já dimensionado. Chamado uma única vez, depois da
   * medição — é o que permite criar o agente no tamanho certo em vez de criar
   * num tamanho qualquer e corrigir com um resize logo em seguida.
   */
  resolveAgent: (cols: number, rows: number) => Promise<string | null>
  /** a janela está em foco: o teclado tem que estar aqui dentro */
  focused?: boolean
}

/** Espera o layout assentar: dois frames depois das fontes. */
function layoutSettled(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

export function AgentTerminal({ resolveAgent, focused = false }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  // O terminal vivo, pra poder devolver o foco quando a câmera chega na janela.
  const termRef = useRef<Terminal | null>(null)
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

    // Sem renderer addon de propósito: o xterm 5 desenha em DOM por padrão, e
    // texto em DOM o navegador rasteriza depois da transform do canvas — é o
    // que mantém o terminal nítido em qualquer zoom. Um renderer de canvas
    // (ou WebGL) desenharia num bitmap, que o zoom borraria.
    const term = new Terminal({
      fontFamily: '"JetBrains Mono Variable", "JetBrains Mono", Consolas, monospace',
      fontSize: 13,
      // Mais ar entre as linhas que num terminal de sistema: a janela é pra ser
      // lida de longe, com o canvas afastado, não só de perto.
      lineHeight: 1.35,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
      scrollback: 10_000,
      theme: TERM_THEME,
    })
    termRef.current = term
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)

    // Handle de inspeção: dá acesso ao buffer renderizado de fora da página,
    // que é a única forma de verificar o scrollback por automação. Sem isso o
    // teste só enxerga o que está no viewport, e duplicata em scrollback passa.
    // Com várias janelas abertas, ele responde pela que está com o teclado.
    openTerminals.add(term)
    const debug = (window as unknown as { __worldbige?: Record<string, unknown> }).__worldbige ?? {}
    debug.screenText = () => {
      const t = activeTerminal()
      if (!t) return ''
      const buf = t.buffer.active
      const lines: string[] = []
      for (let i = 0; i < buf.length; i++) {
        lines.push(buf.getLine(i)?.translateToString(true) ?? '')
      }
      return lines.join('\n')
    }
    debug.size = () => {
      const t = activeTerminal()
      return t ? { cols: t.cols, rows: t.rows } : null
    }
    debug.selection = () => {
      for (const t of openTerminals) if (t.hasSelection()) return t.getSelection()
      return null
    }
    ;(window as unknown as { __worldbige?: Record<string, unknown> }).__worldbige = debug

    // ---------- copiar e colar ----------
    //
    // Colar texto NÃO passa pela API de área de transferência: o caminho é o
    // `paste` nativo do navegador, que dispara sozinho no textarea escondido do
    // xterm e não pede permissão nenhuma. O xterm já sabe tratá-lo, inclusive
    // embrulhando em bracketed paste — que é como o Claude Code reconhece um
    // texto colado em vez de digitado.
    //
    // A exceção é imagem. O Claude Code cola imagem lendo a área de
    // transferência DO SISTEMA, e no Windows a tecla dele pra isso é Alt+V, não
    // Ctrl+V — medido: com imagem no clipboard, Ctrl+V não anexa nada e Alt+V
    // vira `[Image #1]`. Então mandamos ESC+v (`\x1bv`), que é como o terminal
    // codifica Alt+V. Como o navegador e o daemon estão no mesmo micro, quem lê
    // o clipboard é ele.
    //
    // Ou seja: imagem na área de transferência → Ctrl+V vira Alt+V; qualquer
    // outra coisa → o xterm cola o texto. Alt+V digitado na mão segue igual,
    // porque não passa por aqui.
    const ALT_V = '\x1bv'

    const copy = (text: string) => {
      if (!text) return
      void navigator.clipboard?.writeText(text).catch(() => undefined)
    }

    const onPaste = (e: ClipboardEvent) => {
      const data = e.clipboardData
      if (!data) return
      const hasImage = [...data.items].some((i) => i.type.startsWith('image/'))
      if (!hasImage) return // texto: o xterm cuida
      e.preventDefault()
      e.stopPropagation()
      transport?.send(ALT_V)
    }
    term.textarea?.addEventListener('paste', onPaste, true)

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      if (!event.ctrlKey || event.altKey || event.metaKey) return true
      const key = event.key.toLowerCase()

      if (key === 'c') {
        // Com seleção, Ctrl+C copia; sem seleção é o ^C de sempre, que é como
        // se interrompe o que o agente está fazendo.
        if (term.hasSelection()) {
          copy(term.getSelection())
          // Limpa como o terminal do Windows faz. Além de dar o retorno visual
          // de que copiou, evita a surpresa seguinte: com a seleção de pé, o
          // botão direito copiaria de novo em vez de colar.
          term.clearSelection()
          event.preventDefault()
          return false
        }
        // Ctrl+Shift+C sem seleção não tem por que virar ^C.
        if (event.shiftKey) {
          event.preventDefault()
          return false
        }
        return true
      }

      if (key === 'v') {
        // Devolver `false` sem cancelar o evento é o ponto: o xterm não manda
        // \x16 e o navegador segue com a colagem nativa. Vale pro Ctrl+Shift+V
        // também, que o navegador trata como colar texto puro.
        return false
      }

      return true
    })

    // Botão direito, como no terminal do Windows: com seleção copia, sem
    // seleção cola. Aqui não existe evento nativo de colar pra aproveitar, então
    // é a API mesmo — e o navegador pode pedir permissão na primeira vez.
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      if (term.hasSelection()) {
        copy(term.getSelection())
        term.clearSelection()
        return
      }
      void navigator.clipboard
        ?.readText()
        .then((text) => {
          if (text) term.paste(text)
        })
        .catch(() => undefined)
    }
    host.addEventListener('contextmenu', onContextMenu)

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

      // 6: a partir daqui, redimensionar a janela é intenção do usuário
      observer.observe(host)
    })()

    return () => {
      disposed = true
      window.clearTimeout(debounce)
      observer.disconnect()
      // close() desassina; o pty é do daemon e continua trabalhando.
      transport?.close()
      term.textarea?.removeEventListener('paste', onPaste, true)
      host.removeEventListener('contextmenu', onContextMenu)
      openTerminals.delete(term)
      termRef.current = null
      term.dispose()
    }
    // monta uma vez: a prop vive no ref acima
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A câmera chegou nesta janela: o teclado vem junto. Sem isto, enquadrar uma
  // janela deixaria você olhando pra ela e digitando noutra.
  useEffect(() => {
    if (focused) termRef.current?.focus()
  }, [focused])

  return <div className="term-host" ref={hostRef} />
}
