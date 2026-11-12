// Onde está o `claude` — e como abri-lo num pty.
//
// No Windows a instalação deixa `claude.cmd` (npm) ou `claude.exe` (instalador
// nativo), e os dois exigem tratamento diferente no spawn: um .exe o ConPTY abre
// direto, um .cmd precisa do `cmd.exe /c` porque não é imagem executável.
// A detecção roda uma vez; `CLAUDE_BIN` pula tudo.
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'

export type ClaudeLaunch = {
  /** binário que o pty abre */
  file: string
  /** argumentos antes dos argumentos do próprio claude */
  prefix: string[]
  /** caminho resolvido do claude, pra log */
  resolved: string
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** Procura `name` no PATH, testando as extensões do Windows na ordem pedida. */
function searchPath(name: string, extensions: string[]): string | null {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, name + ext)
      if (isFile(candidate)) return candidate
    }
  }
  return null
}

function launchFor(resolved: string): ClaudeLaunch {
  const ext = path.extname(resolved).toLowerCase()
  if (ext === '.cmd' || ext === '.bat') {
    // CreateProcess não executa um .cmd; quem interpreta é o cmd.exe.
    return { file: process.env.COMSPEC || 'cmd.exe', prefix: ['/c', resolved], resolved }
  }
  return { file: resolved, prefix: [], resolved }
}

let cached: ClaudeLaunch | null = null

export function findClaude(): ClaudeLaunch {
  if (cached) return cached

  const override = config.claudeBin
  if (override) {
    // Um override com caminho é usado como está; um nome solto ainda procura o PATH.
    const resolved =
      override.includes(path.sep) || override.includes('/')
        ? path.resolve(override)
        : searchPath(override, process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''])
    if (!resolved || !isFile(resolved)) {
      throw new Error(
        `CLAUDE_BIN aponta pra "${override}", que não é um arquivo. Corrija ou remova a variável.`,
      )
    }
    cached = launchFor(resolved)
    return cached
  }

  // O .cmd vem primeiro: numa instalação npm é ele que existe; o instalador
  // nativo deixa o .exe. Quem tiver os dois roda o .cmd, que delega pro mesmo CLI.
  const resolved =
    process.platform === 'win32'
      ? searchPath('claude', ['.cmd', '.exe'])
      : searchPath('claude', [''])

  if (!resolved) {
    throw new Error(
      'Não achei o `claude` no PATH. Instale o Claude Code ou aponte CLAUDE_BIN pro binário.',
    )
  }
  cached = launchFor(resolved)
  return cached
}

/** Só pra teste/diagnóstico: esquece a detecção anterior. */
export function resetClaudeCache(): void {
  cached = null
}
