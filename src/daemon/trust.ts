// A pasta já é confiada pelo Claude Code?
//
// A tela de "trust this folder" aparece antes de qualquer hook. Um agente
// aberto numa pasta nunca confiada trava nela: não manda UserPromptSubmit, não
// manda nada, e o card ficaria `starting` para sempre sem dizer por quê.
//
// O Claude Code registra a resposta em ~/.claude.json, por projeto. Ler isso
// antes do spawn é melhor que esperar um timeout: o card já nasce dizendo que
// espera confiança, e o Enzo responde a tela no próprio terminal.
import fs from 'node:fs'
import path from 'node:path'

type ClaudeConfig = {
  projects?: Record<string, { hasTrustDialogAccepted?: boolean } | undefined>
}

function configPath(): string {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  return path.join(home, '.claude.json')
}

/**
 * A chave de comparação de um caminho JÁ ABSOLUTO. Windows mistura `/` e `\` e
 * ignora maiúsculas, então as duas coisas são normalizadas.
 *
 * Não chama `path.resolve`: resolver aqui dentro foi um bug real. A subida pelos
 * ancestrais chega em `C:\`, cujo `path.dirname` devolve `.` depois de a barra
 * final cair — e `path.resolve('.')` é o diretório de trabalho do daemon, que
 * por acaso é confiado. A busca escapava da raiz do volume e dizia "confiado"
 * pra qualquer pasta do sistema.
 */
function key(absolute: string): string {
  const s = absolute.replace(/[\\/]+$/, '').replace(/\\/g, '/')
  return process.platform === 'win32' ? s.toLowerCase() : s
}

/**
 * `true` se a pasta já foi confiada, `false` se não, `null` se não deu pra
 * saber (arquivo ausente ou ilegível). Null não é "não confiada": é ignorância,
 * e nesse caso o spawn segue em frente em vez de bloquear por suposição.
 */
export function isTrusted(cwd: string): boolean | null {
  let config: ClaudeConfig
  try {
    config = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as ClaudeConfig
  } catch {
    return null
  }
  const projects = config.projects
  if (!projects || typeof projects !== 'object') return null

  // A confiança é herdada: aceitar uma pasta cobre tudo que está abaixo dela.
  // Uma subpasta nova de um repo já confiado abre direto, sem tela nenhuma —
  // por isso a busca sobe pelos ancestrais em vez de exigir entrada exata.
  const accepted = new Set<string>()
  for (const [entry, value] of Object.entries(projects)) {
    // Basta uma grafia aceita: o mesmo caminho aparece como `c:/x` e `C:/x`,
    // e uma entrada negativa noutra grafia não desfaz a aceitação.
    if (value?.hasTrustDialogAccepted) accepted.add(key(path.resolve(entry)))
  }
  if (!accepted.size) return false

  // A subida é feita sobre o caminho absoluto, sem re-resolver nada: é
  // `path.dirname` de um absoluto que para sozinho na raiz do volume
  // (`dirname('C:\\') === 'C:\\'`).
  let current = path.resolve(cwd)
  for (;;) {
    if (accepted.has(key(current))) return true
    const parent = path.dirname(current)
    if (parent === current) break // raiz do volume
    current = parent
  }
  return false
}
