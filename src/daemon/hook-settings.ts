// O `--settings` temporário de cada agente.
//
// Todos os hooks são do tipo `http`: o próprio Claude Code faz o POST pra
// `/hooks/<agentId>` no daemon, sem processo intermediário. O agente se
// identifica pela URL, que é por isso que cada sessão ganha o seu arquivo.
//
// O orçamento de cada hook é curto de propósito. O endpoint responde antes de
// processar, então o timeout só existe pro caso de o daemon estar fora do ar —
// e aí falhar rápido é melhor que segurar a sessão.
import fs from 'node:fs'
import path from 'node:path'
import { config, paths } from './config.js'

/**
 * Eventos sem matcher: valem pra sessão inteira.
 *
 * `SessionStart` fica de fora: medido, ele não é entregue por hook `http` —
 * só por `command`. Ver `writeForwarder` abaixo.
 */
const SESSION_EVENTS = ['UserPromptSubmit', 'Notification', 'Stop', 'SessionEnd'] as const

/** Eventos de ferramenta: levam matcher. */
const TOOL_EVENTS = ['PreToolUse', 'PostToolUse', 'PermissionRequest'] as const

export type SettingsOptions = {
  /** política de permissão do run type (unidade 5); sem ela, modo da conta */
  permissions?: Record<string, unknown>
}

/**
 * O encaminhador do SessionStart.
 *
 * De todos os eventos, SessionStart é o único que não chega por hook `http` —
 * medido duas vezes, com os dois tipos registrados lado a lado no mesmo
 * arquivo: só a versão `command` entregou. E vale insistir nele, porque é o
 * evento que traz `source` (startup/resume/clear) e `model`.
 *
 * Um hook `command` precisa de um programa. Em vez de depender do `curl` estar
 * instalado, usamos o Node que já está rodando o daemon, com a forma `args`
 * (sem shell, sem problema de aspas em caminho com espaço).
 */
function writeForwarder(): string {
  const file = path.join(paths.tmp(), 'forward-hook.mjs')
  const source = `// Gerado pelo worldbige. Lê o JSON do evento em stdin e repassa pro daemon.
let body = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => (body += c))
process.stdin.on('end', async () => {
  try {
    await fetch(process.argv[2], {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body || '{}',
    })
  } catch {
    // O daemon pode estar fora do ar; o hook não pode travar a sessão por isso.
  }
  // Saída neutra: nenhuma decisão, nenhum campo.
  process.exit(0)
})
`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, source, 'utf8')
  return file
}

/**
 * A statusLine de cada agente.
 *
 * O canvas mostra nome, status e modelo pedido no spawn; o que ele não tem como
 * saber é o modelo que a sessão de fato está usando, qual é o session id vivo e
 * quanto do contexto já foi gasto. Essas três coisas o próprio Claude Code
 * entrega de graça pra quem configurar uma statusLine, e elas aparecem dentro da
 * janela — no rodapé do terminal, onde o agente está sendo lido.
 *
 * O payload chega em stdin e traz `model.display_name`, `session_id` e
 * `context_window.used_percentage` (medido na 2.1.322). Campo que faltar some da
 * linha em vez de virar `undefined`.
 */
function writeStatusLine(): string {
  const file = path.join(paths.tmp(), 'statusline.mjs')
  const source = `// Gerado pelo worldbige. Lê o JSON da statusLine em stdin e imprime uma linha.
let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => (raw += c))
process.stdin.on('end', () => {
  let d = {}
  try {
    d = JSON.parse(raw || '{}')
  } catch {
    // Sem payload legível não há o que dizer: linha vazia é melhor que ruído.
  }
  const dim = (s) => '\\x1b[2m' + s + '\\x1b[0m'
  const parts = []
  const model = d.model?.display_name || d.model?.id
  if (model) parts.push(model)
  if (d.session_id) parts.push(dim(String(d.session_id).slice(0, 8)))
  const used = d.context_window?.used_percentage
  if (typeof used === 'number') parts.push(dim('ctx ' + Math.round(used) + '%'))
  process.stdout.write(parts.join(dim(' · ')))
})
`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, source, 'utf8')
  return file
}

export function writeAgentSettings(agentId: string, opts: SettingsOptions = {}): string {
  const url = `http://${config.host}:${config.port}/hooks/${agentId}`
  const entry = { type: 'http' as const, url, timeout: 3 }

  const hooks: Record<string, unknown[]> = {}
  for (const event of SESSION_EVENTS) hooks[event] = [{ hooks: [entry] }]
  for (const event of TOOL_EVENTS) hooks[event] = [{ matcher: '*', hooks: [entry] }]

  // SessionStart só chega por `command` — ver writeForwarder.
  hooks.SessionStart = [
    {
      hooks: [
        {
          type: 'command',
          command: process.execPath,
          args: [writeForwarder(), url],
          timeout: 5,
        },
      ],
    },
  ]

  const settings: Record<string, unknown> = { hooks }
  // A statusLine não aceita `args` como os hooks — é uma string de comando só,
  // então as aspas são obrigatórias: tanto o Node quanto o diretório de dados
  // podem estar num caminho com espaço.
  settings.statusLine = {
    type: 'command',
    command: `"${process.execPath}" "${writeStatusLine()}"`,
    padding: 0,
  }
  if (opts.permissions) settings.permissions = opts.permissions

  const dir = paths.tmp()
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `settings-${agentId}.json`)
  fs.writeFileSync(file, JSON.stringify(settings, null, 2), 'utf8')
  return file
}

export function removeAgentSettings(agentId: string): void {
  try {
    fs.rmSync(path.join(paths.tmp(), `settings-${agentId}.json`), { force: true })
  } catch {
    /* já sumiu */
  }
}
