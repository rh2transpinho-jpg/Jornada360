# Jornada360

**Central Inteligente de Gestão e Auditoria de Jornada**

> **Jornada360 — MVP Comercial / Programa Piloto.** Esta é a versão que já pode ser entregue a
> um cliente pagante, com escopo deliberadamente contido — não a versão definitiva. O que existe
> funciona e é confiável; o que não é essencial para colocar as primeiras empresas usando ficou
> para depois. Operação do piloto em [PILOTO.md](PILOTO.md).

Plataforma para centralizar, automatizar e auditar o controle de jornada de equipes operacionais: cruza ponto, escala, horas extras e rastreamento automaticamente, classifica divergências por severidade e entrega só o que exige decisão humana — em vez de planilhas soltas que alguém precisa comparar linha por linha.

## O problema, a solução, o resultado

**Problema** — dados de ponto, escala e rastreio vivem em sistemas separados. Conferir divergências manualmente consome a maior parte do tempo do analista em tarefas repetitivas de triagem.

**Solução** — o Jornada360 cruza automaticamente ponto × escala × rastreio × horário padrão, calcula jornada e horas extras, classifica cada divergência por severidade e gera uma fila priorizada só com o que precisa de decisão humana.

**Resultado** — identificação rápida de pendências reais, redução do trabalho manual de triagem, e uma trilha de auditoria de tudo o que foi alterado, por quem e por quê.

## O ciclo completo

O sistema cobre a jornada operacional inteira, de ponta a ponta:

```
DADOS → ANÁLISE → PENDÊNCIA → PRIORIZAÇÃO → EXPLICAÇÃO
      → RESPONSÁVEL → PRAZO → SLA → RESOLUÇÃO
      → APROVAÇÃO/REPROVAÇÃO → AUDITORIA → INDICADORES → RELATÓRIO
```

1. **Importar** o espelho de ponto, a escala, o rastreio e o horário padrão do dia.
2. **Processar** — o motor cruza as quatro fontes e classifica cada jornada.
3. **Pendências** — o que ficou fora do padrão vira uma unidade de trabalho rastreável.
4. **Priorizar** — o sistema *sugere* prioridade (com o motivo escrito); quem decide é você.
5. **Entender** — "Por que isso apareceu?" mostra motivo, regra aplicada, dados considerados e evidências.
6. **Atribuir** responsável e prazo; acompanhar o SLA (dentro / próximo / vencido).
7. **Resolver** registrando setor, causa e justificativa.
8. **Revisar** — aprovar ou reprovar a resolução; reprovada pode ser reaberta.
9. **Auditar** — cada decisão fica registrada com quem, quando, valor anterior/novo e motivo.
10. **Analisar** — Dashboard Executivo com indicadores por empresa, unidade, setor e colaborador.
11. **Exportar** — 7 relatórios em CSV, respeitando a empresa ativa e o período selecionado.

## Primeiro acesso

Quem abre o Jornada360 encontra três caminhos explícitos — **nunca é colocado dentro de uma empresa sem escolher**:

| Opção | O que acontece |
|---|---|
| **Criar minha empresa** | Cria a conta e a empresa numa operação só. Ambiente vazio, regras padrão, nada herdado |
| **Ver demonstração** | Ambiente fictício, marcado em roxo. Funciona sem conta e sem servidor |
| **Já tenho acesso** | Login de verdade: e-mail e senha, sessão no servidor |

Detalhes em [ONBOARDING.md](ONBOARDING.md).

## Portátil por design

O sistema não é preso a uma empresa, a nomes de funcionários ou a regras fixas. Tudo é **configuração por empresa** — inclusive criar uma empresa nova, pela própria interface, sem tocar em código.

Cada empresa tem cadastro, regras, dados de ponto, pendências e auditoria **completamente separados** — no banco, por `tenant_id`, com o servidor validando o acesso em cada requisição. Uma empresa nova nasce vazia e nunca herda nada de outra. Veja [CONFIGURATION.md](CONFIGURATION.md) para o passo a passo.

Os dados de uma empresa real ficam **no servidor**: você entra de outra máquina e encontra tudo onde deixou, e a equipe trabalha sobre a mesma fila.

O **ambiente de demonstração** (dados 100% fictícios, 5 colaboradores inventados) permite apresentar o produto sem expor nenhum dado real. Veja [DEMO.md](DEMO.md).

## Portfólio

Há uma área de vitrine profissional em `/portfolio`, separada do sistema operacional, com os projetos desenvolvidos, sua arquitetura e as decisões de engenharia por trás. Ela não acessa nenhum dado de empresa. Veja [PORTFOLIO.md](PORTFOLIO.md).

## Princípio: nunca inventar número

Todo indicador do Jornada360 vem de dado que existe de verdade. Quando algo não pode ser calculado — falta cadastro, falta um limiar que a empresa ainda não definiu, falta o dado na origem — o sistema mostra **"—" e explica o que falta**, em vez de exibir um número estimado.

Cada indicador relevante tem um botão **"?"** que abre a explicação de como aquele número foi calculado e por que ele aparece ali. As limitações conhecidas estão documentadas em [BUSINESS_RULES.md](BUSINESS_RULES.md), não escondidas.

## Rodando localmente

```bash
cd jornada360
npm install
```

```bash
npm run dev:all
```

Sobe a API e o frontend juntos. Abra `http://localhost:5173` — o Vite faz proxy de `/api`, e é isso que torna o cookie de sessão first-party. Ver [DEPLOY.md](DEPLOY.md).

```bash
npm run build
```

```bash
npx tsc -b
```

```bash
npm test
```

```bash
npm run test:all
```

O **ambiente de demonstração** funciona sem servidor. Uma **empresa real** exige a API no ar — é lá que os dados dela ficam.

## Publicar

Dois caminhos, do mesmo código. A escolha é de custo e de conforto, não de arquitetura.

**Opção A — gratuita (Render + Turso).** Uma URL pública sem contratar servidor, para o programa
piloto. R$ 0/mês, sem cartão. Preço: o serviço hiberna após 15 min sem acesso e leva ~1 min para
acordar. Passo a passo, limites e números em [DEPLOY_GRATUITO.md](DEPLOY_GRATUITO.md).

**Opção B — VPS própria (Docker + Caddy + SQLite).** Sem hibernação, com domínio próprio, ~R$ 30–65/mês:

```bash
docker compose up -d --build
```

Sobe a aplicação e um proxy que obtém e renova o certificado HTTPS sozinho. Depois, verifique o deploy:

```bash
npm run smoke -- https://seu-dominio.com.br
```

São 31 verificações contra a URL publicada: HTTPS, cookie, persistência, isolamento entre empresas, permissões e prontidão. Passo a passo completo em [DEPLOY.md](DEPLOY.md); plantão em [OPERACAO.md](OPERACAO.md).

## Documentação

| Arquivo | Conteúdo |
|---|---|
| [JORNADA360_HANDOFF.md](JORNADA360_HANDOFF.md) | **Comece por aqui** se você é um dev novo no projeto: visão completa em um arquivo |
| [PILOTO.md](PILOTO.md) | **Operar o programa piloto**: liberar, convidar, acompanhar, suspender, reativar, feedback |
| [PRODUCT.md](PRODUCT.md) | Visão de produto: para quem serve, o que entrega, o que ainda não é, conceito de planos |
| [SAAS_ARCHITECTURE.md](SAAS_ARCHITECTURE.md) | O que já está pronto para multi-tenant e o que depende de backend, autenticação e banco |
| [ONBOARDING.md](ONBOARDING.md) | Primeiro acesso, criação de empresa, roteiro de configuração, estados vazios |
| [PORTFOLIO.md](PORTFOLIO.md) | Área de portfólio e como adicionar projetos novos |
| [AUTH.md](AUTH.md) | Login, sessão em cookie, papéis, convites — e o que ainda não existe |
| [FRONTEND_BACKEND.md](FRONTEND_BACKEND.md) | Como a interface conversa com o servidor, e o que a decisão custou |
| [BACKEND.md](BACKEND.md) | API, banco, RBAC, modelo de dados |
| [SECURITY.md](SECURITY.md) | O que está protegido, como, e o que ainda não está |
| [DEPLOY_GRATUITO.md](DEPLOY_GRATUITO.md) | **Publicar sem pagar servidor** (Render + Turso): limites, custos, migração e volta |
| [DEPLOY.md](DEPLOY.md) | Publicar em VPS própria: do servidor vazio à URL do cliente |
| [OPERACAO.md](OPERACAO.md) | Plantão: backup, restauração, atualização, o que fazer quando algo quebra |
| [MIGRACAO_LOCALSTORAGE.md](MIGRACAO_LOCALSTORAGE.md) | Levar ao servidor os dados que ficaram no navegador |
| [MIGRACAO.md](MIGRACAO.md) | Estado de cada repositório: local, remoto ou preparação |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Camadas (interface → serviços → repositórios → storage), estrutura de pastas, caminho para um backend real |
| [BUSINESS_RULES.md](BUSINESS_RULES.md) | Todas as regras: tolerância, HE, jornada, reincidência, status, prioridade, SLA, revisão, score, indicadores — e as limitações de cada uma |
| [CONFIGURATION.md](CONFIGURATION.md) | Como configurar uma empresa nova, passo a passo, e o dia a dia da operação |
| [DEMO.md](DEMO.md) | Como funciona o ambiente de demonstração e como resetá-lo |
| [INTEGRATIONS.md](INTEGRATIONS.md) | Camada de integrações (Cobli, sistema de ponto, importação de arquivo, API) |
| [ROADMAP.md](ROADMAP.md) | O que já existe, o que é preparação, e as próximas fases |
| [CURRENT_STATE.md](CURRENT_STATE.md) | Snapshot do que está implementado agora, item por item |
| [CHANGELOG.md](CHANGELOG.md) | Histórico de como se chegou até aqui |

## Stack

**Frontend:** React 19 + TypeScript + Vite. Gráficos com Recharts, ícones com Lucide.

**Backend:** Node + Express. Banco com dois drivers e um contrato único: SQLite local (`node:sqlite`, embutido) ou libSQL/Turso remoto, escolhidos por variável de ambiente — o mesmo SQL nos dois. Sessão em cookie `HttpOnly`, senha com scrypt. Duas dependências de runtime no servidor.

**Testes:** Vitest — **318 no total**: 175 de regra de negócio e interface, 143 de backend (isolamento entre empresas, RBAC, segurança, produção, programa piloto e fluxo completo ponta a ponta).

**Honestidade sobre o estágio:** o produto está classificado como **MVP Comercial / Programa Piloto** — pronto para as primeiras vendas, com cobrança e suporte manuais e acesso liberado empresa por empresa. Não é um SaaS de autoatendimento, e não se apresenta como um.

**Infraestrutura:** o sistema está pronto para ser publicado — HTTPS automático, banco persistente, backup verificado a cada 6 horas, restauração testada, recuperação de senha por e-mail, monitoramento e reinício automático. O que falta é o que só você pode fazer: contratar um servidor, registrar um domínio e criar a conta de envio de e-mail. Ver [DEPLOY.md](DEPLOY.md).
