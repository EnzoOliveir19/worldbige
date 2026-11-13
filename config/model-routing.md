# Tabela de roteamento de modelo

Qual modelo abrir pra qual papel. **Este arquivo é lido em tempo de execução** —
editar e salvar já vale pro próximo helper, sem recompilar nada e sem reiniciar o
daemon. É arquivo e não código de propósito: a calibragem de "que tipo de
trabalho merece que modelo" se aprende usando, e não se discute em PR.

Quem consulta isto são dois:

- **o lead**, antes de chamar `spawn_helper` — o brief dele manda ler esta
  tabela e escolher o `model` de cada helper por ela, escrevendo numa linha o
  motivo da escolha no `model_reason`;
- **o daemon**, quando o lead não escolhe nada: ele casa o papel do helper com a
  coluna `papel` abaixo e abre naquele modelo.

A escolha explícita do `spawn_helper` sempre vence a tabela. A tabela sempre
vence o "padrão da conta" — menos quando o tipo de run fixa um modelo de helper,
caso em que quem manda é o tipo de run (veja `src/daemon/run-types.ts`).

## A tabela

O casamento é por palavra: o papel que o lead escreveu é comparado com a coluna
`papel`, e vale a primeira linha cuja palavra apareça nele. `review de PR do
backend` casa com `review`; `busca nos quatro repos` casa com `busca`. A última
linha, `*`, é o que vale quando nenhuma casa.

**A ordem das linhas é a ordem da decisão.** Uma linha mais específica tem que
vir antes da mais geral, senão a geral a come: com `teste` acima, um papel
`teste-de-carga` casa com `teste` e nunca chega numa linha `teste-de-carga`
escrita depois.

| papel        | modelo | quando é esse papel                                               |
| ------------ | ------ | ----------------------------------------------------------------- |
| review       | opus   | review de PR, de diff, de branch — leitura crítica de código alheio |
| arquitetura  | opus   | decisão de desenho, TDD, consequência de longo prazo               |
| skeptic      | fable  | procurar o furo de um raciocínio que já parece pronto              |
| bug          | fable  | bug difícil, comportamento que ninguém explica, corrida            |
| debug        | fable  | o mesmo que bug                                                    |
| busca        | sonnet | achar onde está o código, varrer arquivo, listar ocorrência        |
| resumo       | sonnet | condensar o que já está escrito                                    |
| triagem      | sonnet | separar o que importa do que não importa, numa lista               |
| doc          | sonnet | escrever ou corrigir documentação                                  |
| teste        | sonnet | escrever teste pro que já existe                                   |
| \*           | sonnet | **na dúvida, sonnet** — é o default de quem não se encaixou acima  |

## Por que "na dúvida, sonnet"

Porque o erro de abrir sonnet pra um trabalho de opus aparece na hora (o
resultado vem raso e se reabre o helper), e o erro contrário não aparece nunca —
só na fatura. Um default caro é um default que ninguém revisa.
