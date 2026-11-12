// Configuração do daemon. Tudo tem default utilizável e override por ambiente —
// os números (buffer, limite de helpers, watchdog) são chutes deliberados do TDD,
// pra calibrar pelo uso.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
// dist/daemon/config.js → raiz do repo
export const repoRoot = path.resolve(here, '..', '..')

function int(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

const home = process.env.USERPROFILE || process.env.HOME || repoRoot

export const config = {
  /** Bind em loopback: sem multiusuário, sem acesso pela rede. */
  host: '127.0.0.1',
  port: int(process.env.WORLDBIGE_PORT, 4317),

  /** Override da detecção de `claude.cmd` / `claude.exe`. */
  claudeBin: process.env.CLAUDE_BIN?.trim() || null,

  /**
   * Onde moram os repositórios. É a raiz de todo agente: o lead abre aqui por
   * padrão e um helper abre num repo lá dentro. Agente nenhum abre na home —
   * uma sessão solta no perfil do usuário tem a árvore inteira ao alcance.
   */
  reposRoot: path.resolve(process.env.REPOS_ROOT?.trim() || path.join(home, 'Documents', 'GitHub')),

  /** Dados de runtime: estado, resultados de run, briefs gerados. Fora do git. */
  dataDir: process.env.WORLDBIGE_DATA?.trim() || path.join(repoRoot, 'data'),

  /** Material da Oncar (convenções, briefs reais). Fora do git. */
  privateDir: process.env.WORLDBIGE_PRIVATE?.trim() || path.join(repoRoot, 'private'),

  /**
   * Teto do scrollback por agente, em LINHAS — não em bytes. O scrollback vive
   * num xterm headless, que conta linhas; o teto de 2 MB do TDD era pro buffer
   * de bytes que não resistiu ao primeiro teste (replay cru duplicava a tela).
   */
  scrollbackLines: int(process.env.WORLDBIGE_SCROLLBACK_LINES, 2000),

  /** Helpers simultâneos por run; acima disso o spawn entra na fila. */
  maxHelpers: int(process.env.WORLDBIGE_MAX_HELPERS, 3),

  /** Silêncio além disso marca o agente como `stale`. */
  staleMs: int(process.env.WORLDBIGE_STALE_MS, 10 * 60 * 1000),

  /** Onde o front buildado vive. */
  frontDir: path.join(repoRoot, 'dist', 'front'),
} as const

export const paths = {
  state: () => path.join(config.dataDir, 'state.json'),
  runs: () => path.join(config.dataDir, 'runs'),
  briefs: () => path.join(config.dataDir, 'briefs'),
  tmp: () => path.join(config.dataDir, 'tmp'),
}
