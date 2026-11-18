# TDD — worldbige: orquestrador local de agentes Claude Code

## Contexto

Worldbige é um app local pra Windows que orquestra e acompanha sessões interativas do Claude Code: um processo Node em localhost, dono dos terminais dos agentes, e um front de canvas infinito onde cada agente é uma janela com terminal real, status e setas ligando quem abriu quem. É um projeto pessoal, de uma pessoa, com o repo público no meu GitHub como estudo, e dois objetivos: rodar vários agentes ao mesmo tempo com visibilidade de quem precisa de atenção, e aprender o encanamento do Claude Code — hooks, MCP, sessões, permissões — construindo em cima dele.

Hoje, rodar mais de um agente interativo é abrir uma janela de terminal por agente. Nenhuma janela diz se o agente está trabalhando, esperando uma permissão ou terminou; ou eu alterno entre elas o tempo todo, ou um agente fica parado num prompt sem eu perceber. Os subagentes nativos do Claude Code não resolvem isso: vivem dentro da sessão do pai, sem terminal visível, sem como intervir no meio da tarefa, e morrem quando o pai morre.

A referência mais próxima do que eu quero é o ccanvas, um canvas infinito open source onde as caixas são terminais e agentes Claude. Consideramos fork e descartamos, por duas razões. A arquitetura dele é invertida em relação à que este desenho precisa: o front é dono do estado do workspace e o backend é uma ponte de pty sem memória — no modo web, o único que roda sem o toolchain de Rust, o shell morre quando a conexão fecha, então um reload do navegador mata os agentes. E a maior parte do código dele são widgets fora do meu escopo: editor, VS Code embarcado, viewers de dados e vídeo. A decisão é repo novo, com o ccanvas servindo de pedreira: a matemática de pan/zoom, o chrome de janela arrastável/redimensionável e a fiação do xterm vêm de lá (licença Apache-2.0, com atribuição), junto com duas ideias — o indicador de "esperando você" acionado por sinal real, não por heurística de texto, e a lista de agentes com status ao lado do canvas.

O desenho que este documento registra: um processo Node só, servindo front buildado, API, WebSocket e um servidor MCP; cada agente é uma sessão `claude` num pty cujo scrollback vive no servidor; o status de cada agente vem dos hooks da própria sessão; e um lead orquestra helpers pelas ferramentas MCP.

## Escopo

Entra:

- o daemon: um processo Node em localhost servindo o front buildado, API HTTP, WebSocket e o servidor MCP, com estado persistido em arquivo;
- agentes como sessões interativas do `claude` em pty, scrollback em buffer circular no servidor, e resume de sessão depois de um reinício do daemon;
- status por hooks: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Notification, Stop e SessionEnd;
- o MCP de orquestração: `spawn_helper`, `list_helpers`, `close_helper`, `get_run`, `report` e `done`, com limite configurável de helpers em paralelo (default 3) e fila;
- notificação do lead por injeção no stdin do pty dele, com fila, entregue só quando ele está idle;
- política de permissão por tipo de run — allow/ask/deny por ferramenta, incluindo tools MCP;
- o canvas: pan/zoom, janela por agente (cabeçalho, terminal redimensionável, recolher pra card), setas lead→helper, gaveta com o run atual e a lista de runs, atalhos de enquadrar e fixar, destaque forte em "precisa de você";
- run types freeform e review de PRs, cada um com um brief de lead em markdown, e briefs de exemplo genéricos no repo público;
- o documento de convenções da arquitetura Oncar que os briefs referenciam, preenchido só com o que existir nos repos, fora do versionamento.

Fica fora:

- postar qualquer coisa no GitHub: reviews ficam locais;
- app desktop — o front roda no navegador, em localhost;
- autenticação no MCP além do header de identificação do agente;
- multiusuário e acesso pela rede: bind em 127.0.0.1.

Adiado:

- os run types de review de TDD/PRD, coding por ticket do Linear e triagem de suporte — quando entrarem, são briefs novos, sem código novo;
- as integrações que eles puxam (Linear, Slack, Drive).

## Desenho

O daemon é um processo Node só, escutando em `localhost:4317`. Ele serve quatro coisas na mesma porta: o front já buildado, uma API HTTP pro front, WebSocket pros terminais, e o servidor MCP em `/mcp`. O estado — runs, agentes, posições no canvas, ids de sessão — vive num arquivo JSON gravado a cada mudança. O scrollback de cada terminal não é um log de bytes, é uma tela: cada agente tem um xterm headless no daemon, alimentado pelo pty, e o que um cliente recebe ao conectar é o estado serializado dessa tela, com teto em linhas (default 2000, `WORLDBIGE_SCROLLBACK_LINES`). O front é descartável: fechar e reabrir o navegador reconecta aos mesmos ptys sem perder nada além do que o teto já descartou.

O desenho original era um buffer circular de bytes com teto de 2 MB, e ele não sobreviveu ao primeiro teste. Uma TUI redesenha a tela inteira o tempo todo, então repetir o histórico cru não reconstrói a tela: empilha uma cópia do desenho a cada reconexão. Guardar a tela renderizada, e não os bytes que a produziram, é o que torna o replay idempotente.

Cada agente é uma sessão interativa do `claude` num pty, aberto com `@lydell/node-pty`. Escolhemos esse fork em vez do `node-pty` original porque ele publica binários pré-compilados pra Windows; o original exige toolchain nativo de build, que é exatamente o tipo de dependência que este projeto quer evitar. No Windows o binário do Claude Code pode ser `claude.cmd` ou `claude.exe` dependendo da instalação: o daemon detecta na primeira execução, com override pela configuração `CLAUDE_BIN`.

O spawn limpa as variáveis `CLAUDE_CODE_*` do ambiente herdado. Se o worldbige for iniciado de dentro de uma sessão do Claude Code, o pty herdaria `CLAUDE_CODE_CHILD_SESSION`, o agente nasceria marcado como sessão filha, e o Claude Code desliga a persistência de transcript nesse caso — sem transcript não existe `--resume`, e o caminho de recuperação do daemon morreria em silêncio. `CLAUDE_CODE_MESSAGING_SOCKET` e `_TOKEN` são piores: dariam ao agente um canal de volta pra sessão que abriu o daemon. Cada agente é sessão de primeira classe, não filha de ninguém.

O agente também nasce já com as dimensões medidas pelo navegador. O front abre o xterm, espera a fonte carregar e o layout assentar, mede, e só então pede o agente — em vez de criar num tamanho qualquer e corrigir com um resize logo depois. A diferença importa porque todo resize real faz a TUI repintar: criar no tamanho errado custava um redesenho empilhado por agente aberto.

O brief de cada agente é um arquivo markdown escrito pelo daemon antes do spawn. O prompt inicial da sessão é uma linha — "leia seu brief em <caminho> e siga" — e não o brief inteiro, por duas razões: o brief fica editável até o momento do spawn, e o transcript da sessão começa limpo em vez de carregar um prompt de página inteira.

Cada sessão sobe com dois arquivos temporários gerados pelo daemon. Um `--mcp-config` aponta pro MCP do worldbige com o header `x-worldbige-agent: <id>` — é assim que o servidor sabe qual agente está chamando qual ferramenta. Essa flag adiciona o servidor aos que o usuário já tem configurados, não os substitui, então os agentes continuam com os conectores normais da conta. Um `--settings` carrega os hooks e, quando o tipo de run pede, a política de permissão.

### Status por hooks

Hooks são o mecanismo do Claude Code pra executar algo em pontos fixos da sessão, recebendo um JSON de contexto. Todos os hooks do worldbige são do tipo `http`: o próprio Claude Code faz o POST do evento pra `/hooks/<agentId>` no daemon, sem processo intermediário. O daemon responde de imediato e sem corpo de decisão, então nenhum hook atrasa nem interfere na sessão.

| Evento | O que o daemon faz |
|---|---|
| SessionStart | guarda o `session_id` (é o que permite `--resume`) e o `source` — `startup`, `resume`, `clear` |
| UserPromptSubmit | status → `running` |
| PreToolUse / PostToolUse | renova o timestamp de atividade — um comando longo continua `running` em vez de virar `stale` |
| PermissionRequest | status → `precisa de você`, com o nome do tool que espera aprovação; o daemon responde neutro, sem decisão, pro prompt seguir o fluxo normal |
| Notification `permission_prompt` | redundância do mesmo estado — idempotente, qualquer um dos dois acende o card |
| Notification `idle_prompt` | confirma `idle`; ponto de entrega da fila |
| Stop | status → `idle`; ponto de entrega da fila de mensagens |
| SessionEnd | `reason` decide: `clear`, `resume` e `prompt_input_exit` → `stopped`; `logout` e `other` → `failed` |

`done` não vem de hook nenhum: só do tool `done` do MCP. Uma sessão que encerra sem ter chamado `done` nunca fica `done` — vira `stopped` ou `failed` conforme a tabela. Todo status carrega o timestamp do último sinal e um watchdog marca `stale` quem está calado além do limite configurável; com Pre/PostToolUse renovando a cada tool call, `stale` passa a significar sinal perdido de verdade (daemon fora do ar durante o evento, sessão travada), não comando demorado. Se o daemon reinicia, os ptys morreram com ele: os agentes voltam `stopped`, e o resume abre um pty novo com `claude --resume <session_id>`.

### O MCP de orquestração

O lead orquestra pelos tools do servidor MCP; o daemon sabe quem chama pelo header e resolve o run a que o agente pertence.

- `spawn_helper({name, role, cwd?, brief, after?, model?, model_reason?})` — escreve o brief em arquivo, abre o helper no mesmo run e devolve o id. `after` nomeia o agente de que este depende e vira a seta no canvas. Um run tem um limite de helpers simultâneos (default 3, configurável); acima disso o spawn entra numa fila e o tool devolve "na fila" em vez de bloquear.
- `list_helpers()` / `close_helper(id)` / `get_run()` — leitura e encerramento.
- `report({status, summary})` — atualiza o card do agente no canvas; é o canal de progresso.
- `done({result, worktrees?})` — o daemon salva o `result` como markdown no diretório do run, marca o agente `done` e gera a notificação pro lead.

Quando `done` ou `report` gera uma mensagem pro lead, a entrega é por injeção no stdin do pty dele, na forma fixa `[worldbige] helper "<name>" concluiu: <summary>. Resultado em <caminho>.` seguida de Enter. A regra de entrega: se o lead já está `idle` no momento em que a mensagem chega, ela é digitada na hora, sem esperar Stop ou `idle_prompt`; senão entra na fila, e a fila é drenada no próximo Stop ou `idle_prompt` do lead. `permission_prompt` nunca entrega — nada é digitado por cima de um prompt de permissão aberto. O `idle_prompt` como ponto de entrega fecha o caso em que o lead ficou parado antes de a mensagem existir e nenhum Stop novo viria. Consideramos e descartamos polling de `get_run()` pelo lead (queima tokens num loop que dorme) e um tool MCP bloqueante de "espere um evento" (esbarra no timeout de tool do cliente).

### O modelo de cada agente

Cada agente roda num modelo escolhido no spawn e passado como `--model`, e o modelo em uso aparece no cabeçalho da janela junto com o motivo da escolha — um agente no modelo errado é invisível de outro jeito, e sem o motivo "por que esse helper está em opus" só se responde lendo transcript. A escolha é automática por padrão, numa ordem só, resolvida num ponto só (a criação do agente): a escolha explícita (o dropdown do "novo agente" ou o `model` do `spawn_helper`) → o default que o tipo de run fixa pro papel → a tabela de roteamento pelo papel → a linha `*` da tabela, que diz "na dúvida, sonnet".

A tabela mora em `config/model-routing.md`, um markdown editável relido por mtime: editar com o daemon no ar já vale pro próximo helper. É markdown e não JSON porque tem dois leitores — o daemon, que casa a primeira linha cuja palavra apareça no papel, e o lead, cujo brief manda lê-la antes de escolher — e a prosa em volta da tabela é metade do conteúdo. Como o casamento é por palavra contida e a ordem das linhas é a ordem da decisão, uma linha mais específica precisa vir antes da geral. "Auto" (ninguém escolheu) e "padrão da conta" (a escolha explícita de não passar `--model`) são valores distintos e não podem colapsar.

### Permissão por tipo de run

Cada tipo de run define uma política de permissão: três listas de regras — `allow`, `ask` e `deny` — que o daemon injeta no `--settings` temporário da sessão, por cima das configurações da conta. As listas se mesclam entre escopos e a avaliação é deny, depois ask, depois allow, com o primeiro match decidindo; um `ask` da política vence qualquer `allow` herdado das minhas configurações, o que é o que torna a política do run confiável mesmo com a conta liberal. A política também força `"defaultMode": "default"` no `--settings`, que tem precedência sobre as configurações da conta — sem isso, uma conta em `acceptEdits` ou bypass dissolveria a fronteira — e o daemon nunca passa `--permission-mode` nem `--dangerously-skip-permissions` pra um reviewer.

A política do reviewer de PR:

- Arquivos e edição: `Edit`, `Write` e `NotebookEdit` em deny. A saída do reviewer é `done({result})` — quem escreve o arquivo é o daemon.
- Bash: allowlist de leitura (`git log`, `git diff`, `gh pr view`, `gh pr diff` e afins) em allow; os prefixos que escrevem (`git push`, `git commit`, `gh pr comment`, `gh pr review`) em deny. A doc é explícita em que regra sobre texto de comando não é fronteira de segurança — `git -C . push` passa pelo deny — então essas duas listas são redução de superfície e de fricção, não a garantia.
- Conectores (Linear, Slack): mantidos — o reviewer precisa ler o ticket pra checar se o PR faz o que foi pedido. Tools de leitura (`mcp__claude_ai_Linear__get_*`, `list_*`, `search_*`) em allow; tools de escrita (`save_*`, `create_*`, `delete_*`, e os equivalentes do Slack) em ask.
- MCP do worldbige: no helper, só `report` e `done` em allow e `spawn_helper` em deny — helper não abre helper. O lead do mesmo run recebe os seis tools, porque sem `spawn_helper` ele não é lead; por isso a política é montada por agente, não só por run.
- Brief: `Read` do diretório do run em allow, pra que nenhum agente peça permissão pra ler o próprio brief, que mora fora do cwd. No Windows a regra precisa da forma absoluta do Claude Code — duas barras e caminho normalizado pra POSIX, `Read(//c/.../runs/<run>/**)`; com uma barra só ela ancora no diretório do arquivo de settings.
- Todo o resto cai no modo padrão, que pergunta no primeiro uso de cada tool.

A fronteira real é a última linha somada ao ask: o que escapar dos denies não executa sozinho — o prompt de permissão aparece na sessão, o hook PermissionRequest acende `precisa de você` no card com o nome do tool, e eu aprovo ou nego na hora. Consideramos e descartamos duas alternativas: `--strict-mcp-config`, que cortaria a escrita no Slack mas levaria junto a leitura do Linear que o review exige; e o modo plan, que mantém o agente propondo planos que ninguém vai aprovar. Um run freeform sobe sem política: conectores presentes, modo padrão da conta. A única regra que ele carrega é o allow do diretório do run, que não restringe nada.

O tipo de run fica gravado na ficha de cada agente, não só na do lead: depois de um reinício do daemon, um helper aberto num run retomado precisa subir com a mesma política, e o lead que o abriu pode nem estar vivo. O resume carrega o tipo adiante pelo mesmo motivo — um reviewer que voltasse freeform seria a fronteira se dissolvendo justamente no caminho de recuperação.

### O canvas

O front é Vite + React com `@xterm/xterm` nos terminais — as mesmas escolhas do ccanvas, e essa é a razão: o código de pan/zoom, o chrome de janela (arrastar, redimensionar, z-order) e a fiação do xterm vêm de lá por cópia, e portar pra outro framework jogaria fora o que a pedreira dá. Os arquivos copiados mantêm o cabeçalho de atribuição; a licença Apache-2.0 do ccanvas permite a cópia num repo público nessas condições.

Cada janela de agente tem cabeçalho (nome, status, session id, modelo em uso, recolher, fechar) e um terminal interativo ligado por WebSocket ao pty do daemon: ao conectar, o cliente recebe a tela serializada e depois o stream vivo; teclado vai pro pty; redimensionar a janela redimensiona o pty, mas só quando as dimensões mudam de verdade. Recolhida, a janela vira um card com o status e o último `summary` do `report`. As setas lead→helper são a camada SVG por cima do canvas, derivadas do `after` de cada spawn. A gaveta à esquerda lista o run atual (tempo, handoffs, agentes com status), o histórico de runs e o botão de novo run; `Ctrl+Shift+F` enquadra o run no viewport e `Ctrl+Shift+B` fixa a gaveta. `precisa de você` é o estado mais alto da hierarquia visual: o card pulsa e a gaveta conta quantos agentes esperam.

### O repo público e o material privado

O repo no GitHub carrega o daemon, o front e briefs de exemplo genéricos, sob licença Apache-2.0 — a mesma do código copiado, que já obriga a manter os avisos dela. O que não entra no versionamento: o diretório de dados em runtime (estado, resultados de run, briefs gerados — contêm conteúdo das sessões), e o material da Oncar — o documento de convenções da arquitetura e os briefs reais, que citam repos internos. Esses vivem num diretório ignorado pelo git que o daemon lê por configuração; o repo público funciona de ponta a ponta só com os exemplos.

## Riscos

O risco mais alto é a fidelidade do terminal no Windows. Uma sessão interativa do Claude Code é uma TUI cheia de redesenho, e o caminho ConPTY → node-pty → WebSocket → xterm tem fama de artefatos de resize e de renderização. A mitigação é dupla: é a mesma pilha do modo web do ccanvas, que funciona hoje com a TUI do Claude; e o resize é mantido em passo único — a janela redimensiona, o front recalcula colunas e linhas e o daemon aplica no pty e na tela do servidor na mesma chamada, nunca em dois momentos.

A execução confirmou o risco por um caminho que este documento não tinha previsto: o problema não foi a fidelidade do desenho, foi a contagem de desenhos. Todo resize real repinta a TUI, e um repaint a mais é uma cópia a mais na tela. Daí as três regras que o desenho hoje carrega — medir depois da fonte carregar, criar o agente já no tamanho medido, e ignorar resize cujas dimensões não mudaram. Com elas, reabrir a aba não gera resize nenhum e nada se repete; redimensionar a janela de propósito continua repintando, como repinta num terminal comum.

A injeção no stdin do lead pode colidir com o que está acontecendo no terminal dele. O caso coberto pelo desenho é o Claude ocupado (fila + entrega só em idle), mas há um segundo: eu mesmo digitando no terminal do lead no momento da entrega, com os caracteres se misturando ao meu texto. Mitigação: o daemon vê todo o teclado que passa pelo WebSocket e segura a entrega enquanto houver digitação minha nos últimos segundos; o prefixo fixo `[worldbige]` deixa qualquer entrega fora de hora reconhecível no scrollback.

O daemon é um processo só, e a morte dele leva todos os ptys juntos — no meio de um run, isso é todo agente trabalhando interrompido. A mitigação é o caminho de resume: o Claude Code persiste o transcript de cada sessão por conta própria, o daemon guarda o `session_id` de cada agente desde o SessionStart, e depois do reinício cada card volta `stopped` com o resume reabrindo a sessão onde parou. O que se perde é o scrollback do buffer (o transcript da sessão sobrevive) e o que estava na fila de notificação, que é regravada pelos `done` ainda não entregues no estado.

A política de permissão do reviewer não é fronteira de segurança no sentido forte, e o documento não finge que é. Regras sobre texto de comando são contornáveis por construção (`git -C . push` passa pelo deny de `git push`), e dois comportamentos que o desenho assumia tinham gap na doc — a resposta neutra do PermissionRequest tipo http preservando o fluxo, e globs parciais em `ask`. A fronteira real é o modo padrão forçado pela política somada ao humano no loop: o que não casa com `allow` pergunta, o prompt acende `precisa de você`, e nada executa sozinho. Os dois gaps foram verificados na task de permissões, antes de qualquer política ser escrita, e passaram (ver Em aberto).

Um caso que a execução encontrou: um `cd` pra fora do diretório de trabalho é tratado como leitura daquele caminho e pede aprovação, e num comando composto todo pedaço precisa estar liberado. Liberar `Bash(cd:*)` dissolveria a fronteira que o modo padrão segura; a resposta é abrir o reviewer no repo que ele vai revisar.

## Tasks e estimativa

Tamanhos relativos (P, M, G) em vez de dias: projeto pessoal, feito aos poucos, sem prazo — um número de dias aqui seria chute vestido de estimativa.

| # | Task | Repo | Tamanho |
|---|---|---|---|
| 1 | Esqueleto do daemon: um processo Node servindo o front estático, a API e o WebSocket na mesma porta, estado em arquivo JSON, configuração (porta, `CLAUDE_BIN`, diretório privado). Pronta quando sobe, responde a um health check e o estado sobrevive a um reinício | worldbige | M |
| 2 | Pty e terminal: spawn da sessão `claude` com `@lydell/node-pty` (detecção `.cmd`/`.exe`, ambiente limpo de `CLAUDE_CODE_*`), xterm headless por agente, attach por WebSocket com tela serializada + stream + teclado + resize, e uma página mínima com um xterm pra exercitar. Pronta quando dá pra abrir um agente, fechar o navegador, reabrir e o scrollback voltar igual, quantas vezes se reabra | worldbige | G |
| 3 | Hooks e status: geração do `--settings` temporário, o endpoint de hooks, a máquina de status completa (tabela do Desenho, watchdog, `stale`), captura do `session_id` e resume de agente `stopped`. Pronta quando o status transita conforme a tabela e matar o daemon + resumir funciona | worldbige | M |
| 4 | Canvas: cópia e poda do ccanvas — pan/zoom, chrome de janela, camada SVG das setas — mais janela de agente, recolher pra card, gaveta, atalhos de enquadrar e fixar, destaque de `precisa de você`. Pronta quando um run com três agentes é navegável e os arquivos copiados carregam a atribuição Apache-2.0 | worldbige | G |
| 5 | MCP de orquestração: o servidor em `/mcp`, identidade pelo header, `spawn_helper` com limite e fila, `report`, `done` salvando o resultado em markdown, `list_helpers`, `close_helper`, `get_run`, setas a partir do `after`. Pronta quando um lead abre um helper que reporta e conclui | worldbige | M |
| 6 | Notificação do lead: fila, entrega imediata quando já idle, drenagem em Stop e `idle_prompt`, supressão em `permission_prompt` e durante digitação minha. Pronta quando o `done` de um helper chega ao lead nos três cenários — idle, running e esperando permissão | worldbige | M |
| 7 | Políticas de permissão por tipo de run, incluindo o `defaultMode` forçado, e a verificação dos dois gaps de doc (PermissionRequest neutro via http; globs parciais em `ask`). Pronta quando um reviewer não consegue editar nem postar, e um tool em `ask` acende o card | worldbige | P |
| 8 | Run types: briefs de lead pra freeform e review de PRs, briefs de exemplo genéricos no repo público, documento de convenções Oncar no diretório privado preenchido só com o que existir nos repos. Pronta quando um review de PR roda de ponta a ponta | worldbige | M |

A ordem é 1 → 2 → 3, porque cada uma é o chão da seguinte; a partir daí 4 e 5 andam em paralelo (o canvas não depende do MCP); 6 e 7 dependem de 3 e 5; a 8 fecha, porque exercita tudo. Os testes de cada task são o critério de pronta dela — num projeto de uma pessoa, suíte separada seria cerimônia.

## Em aberto

Nada em aberto no v1. O único item que havia — os dois gaps de doc assumidos pelo desenho — foi fechado na task 7, num daemon isolado com `claude` de verdade, antes de qualquer política ser escrita:

1. **PermissionRequest `http` com resposta neutra preserva o fluxo** — o prompt aparece inteiro e funcional na TUI, e ainda cita a regra que o causou (`Permission rule mcp__claude_ai_Linear__save_* requires confirmation for this tool.`). De passagem: negar não dispara hook nenhum, então o card só sai de `precisa de você` porque o daemon vê a tecla passar pelo WebSocket.
2. **Glob parcial em `ask`** — `mcp__claude_ai_Linear__save_*` casa com `save_issue`. A fronteira, hoje na doc: `allow` aceita glob só depois de um `mcp__<servidor>__` literal, enquanto `deny` e `ask` aceitam glob na posição do nome inteiro.
3. **Regra de caminho no Windows** (não estava nomeado aqui, e era o risco do allow do diretório do run) — duas barras pra caminho absoluto, normalizado pra POSIX com drive minúsculo e sem os dois pontos.

De brinde, também medidos: o `defaultMode` forçado sobe a sessão em modo manual por cima de uma conta em auto mode, e `Edit`/`Write` em deny sem parênteses removem as ferramentas do contexto da sessão em vez de só negá-las no uso.
