# Programa Piloto — operação comercial do Jornada360

**Classificação atual do produto: Jornada360 — MVP Comercial / Programa Piloto.**
Não é a versão definitiva. É a versão que já pode ser entregue a um cliente pagante, com escopo
deliberadamente contido: o que existe funciona e é confiável; o que não é essencial para colocar as
primeiras empresas usando ficou para depois, por decisão e não por falta de tempo.

Este documento é o manual de quem opera o piloto — não do cliente. O cliente usa o produto; você
usa isto.

---

## 1. O que o piloto assume

A cobrança é **manual** e acontece fora do sistema. Não existe assinatura, checkout, plano nem
fatura. O que o sistema precisa garantir é uma coisa só, e garante:

> controlar com segurança **quais empresas têm acesso** — liberar, suspender e devolver.

Tudo o mais em torno disso (CRM, central de tickets, painel comercial, múltiplos planos) é
combinado por fora, no contato direto com cada cliente. Com meia dúzia de empresas, isso é mais
barato e mais confiável do que software.

## 2. O que fecha a porta

Em produção o cadastro nasce **fechado** (`JORNADA_CADASTRO_ABERTO` não definido → `false` quando
`NODE_ENV=production`). Com ele fechado:

| Caminho | O que acontece |
|---|---|
| `POST /api/auth/registrar` (criar conta + empresa) | **403** `cadastro_fechado` |
| `POST /api/auth/tenants` (empresa nova, já logado) | **403** `cadastro_fechado` |
| `POST /api/auth/convites/aceitar` (conta a partir de convite) | **funciona** |
| `POST /api/auth/entrar` | **funciona** |
| Demonstração | **funciona**, sem conta e sem servidor |

A recusa acontece **no servidor**. Esconder o botão no portão seria sugestão — quem conhecesse a
rota criaria a conta assim mesmo. A interface consulta `GET /api/auth/modo` só para não oferecer um
caminho que vai ser negado depois de a pessoa preencher o formulário inteiro.

O gate no `POST /api/auth/tenants` é o que muita gente esquece: sem ele, fechar o registro não
fecharia nada — bastaria entrar por convite e abrir quantas empresas quisesse.

## 3. Liberar uma empresa

```bash
npm run piloto liberar cliente@empresa.com "Nome da Empresa Ltda"
```

Cria a conta do responsável, cria a empresa vazia, vincula como administrador e **mostra uma senha
inicial uma única vez**. Entregue essa senha ao cliente e peça que troque no primeiro acesso —
a recuperação de senha por e-mail funciona, então ninguém fica preso a ela.

A empresa nasce vazia: sem colaboradores, sem setores, sem registros, com as regras nos valores
padrão neutros. Nada da demonstração é copiado.

## 4. Configurar os usuários do cliente

O cliente convida a própria equipe pela tela de Configurações → Usuários. Se precisar fazer isso
por ele:

```bash
npm run piloto convidar <id-ou-nome-da-empresa> pessoa@empresa.com rh
```

Papéis: `administrador`, `rh`, `gestor`, `auditor`, `colaborador` (ver `SECURITY.md`).

A pessoa convidada abre `/convite`, cola o código e **cria a conta ali mesmo** — não precisa ter
conta antes, e o cadastro continua fechado para quem não foi convidado. O convite é nominal (vale
só para o e-mail que o recebeu), de uso único e expira em 7 dias. O e-mail da conta vem do convite,
não do que a pessoa digitar: é o que impede repassar um convite para outra pessoa.

Quem já tem conta usa o mesmo endereço, ou "Entrar em outra empresa".

## 5. Acompanhar a implantação

```bash
npm run piloto              # ou: npm run piloto panorama
```

Mostra, por empresa: status, usuários, colaboradores, dias processados, pendências (e quantas foram
tratadas), **última atividade** e feedback em aberto.

"Última atividade" é a coluna que importa numa venda piloto: ela separa o cliente que está
implantando do cliente que abandonou depois da primeira semana — e essa diferença precisa ser
percebida em dias, não no fim do trimestre.

Para anotar algo sobre o cliente (combinado comercial, contexto, próximo passo):

```bash
npm run piloto nota <id-ou-nome> "Reunião de acompanhamento marcada para 20/08"
```

## 6. Receber e tratar feedback

Dentro do produto, um botão **Relatar** fica sempre visível no canto inferior direito, em qualquer
tela. Ele não aparece na demonstração — lá não há empresa real de quem o relato partiria.

Cinco categorias, com a explicação junto de cada uma (sem isso, "Dificuldade de uso" e "Sugestão"
viram a mesma coisa na cabeça de quem relata):

| Categoria | Quando |
|---|---|
| **Erro** | Algo não funcionou como deveria |
| **Dificuldade de uso** | Funciona, mas foi difícil de encontrar ou entender |
| **Sugestão** | Uma ideia para melhorar algo que já existe |
| **Funcionalidade solicitada** | Algo que falta e faria diferença |
| **Dúvida** | Não entendi como algo funciona |

A tela em que a pessoa estava vai junto, automaticamente. Um relato sem contexto costuma custar uma
ida e volta inteira só para descobrir onde aconteceu.

Do lado do operador:

```bash
npm run piloto feedback                  # tudo
npm run piloto feedback aberto           # só o que ainda não foi tratado
npm run piloto feedback-marcar <id> lido "Respondido por telefone em 16/08"
```

Situações: `aberto` → `lido` → `resolvido`, ou `descartado`.

**Nem toda sugestão vira funcionalidade.** O texto que o cliente vê ao enviar diz isso na cara:
todas são lidas, e as decisões voltam para ele. Prometer implementar tudo é a forma mais rápida de
transformar um piloto num backlog impagável.

## 7. Suspender o acesso — e devolver

```bash
npm run piloto suspender <id-ou-nome> "Piloto encerrado - aguardando contrato"
npm run piloto reativar <id-ou-nome>
```

A suspensão pede confirmação digitada (`SUSPENDER`) e mostra antes o que será afetado.

**O que a suspensão faz:**

- marca a empresa como `suspensa`, com data e motivo;
- **encerra as sessões abertas** de todos os membros — sem isso, quem já estava dentro continuaria
  trabalhando até o token expirar, e a suspensão só valeria horas depois;
- passa a recusar **toda** leitura e escrita de dados daquela empresa com **403 `empresa_suspensa`**.

**O que a suspensão NÃO faz — e isto é a promessa central do piloto:**

- não apaga nada. Dias, pendências, auditoria, cadastro, feedback: tudo continua no banco;
- não remove a empresa da conta da pessoa. Ela continua aparecendo em `/api/auth/eu` marcada como
  suspensa, e no portão aparece marcada em laranja com "seus dados estão preservados";
- não impede o login. O problema é da empresa, não da conta;
- continua entrando nos backups normalmente.

O 403 é deliberado, e não 404: a pessoa tem vínculo legítimo com a empresa, e fazê-la sumir seria
lido como defeito ou como perda de dados. A tela explica que o acesso foi pausado pela equipe do
Jornada360, mostra o motivo quando há um, e diz com quem falar.

Reativar devolve o acesso imediatamente. Os usuários precisam entrar de novo, porque as sessões
foram encerradas na suspensão.

## 8. Por que uma CLI, e não um painel de administração

Um painel que "vê tudo de todos" precisaria de rotas HTTP que atravessam empresas. Essas rotas
ficariam expostas para sempre, e bastaria uma falha de autorização em uma delas para vazar dados
entre clientes — um risco permanente criado pela conveniência de uma fase que vai durar poucos
meses.

A CLI roda **no servidor**, com acesso direto ao banco, e não existe pela rede. Para meia dúzia de
empresas é suficiente. Quando forem muitas, um painel se justifica — e aí se constrói com o cuidado
que ele exige.

A única visão cruzada de feedback (`listarTodoFeedback`) existe apenas na CLI. Não há rota HTTP que
devolva feedback de várias empresas juntas, e o teste `piloto.test.js` fixa isso: uma empresa
pedindo o feedback de outra recebe **404**.

## 9. Suporte

Manual e direto: e-mail, telefone, mensagem. Não existe central de tickets, e não deve existir
agora — com poucos clientes, um canal humano responde mais rápido e ensina mais sobre o produto do
que qualquer fila.

O que o sistema oferece de apoio ao suporte:

- `npm run piloto panorama` — o que cada cliente já fez;
- `npm run piloto feedback` — o que cada cliente relatou, com a tela e a data;
- Auditoria dentro do produto — quem alterou o quê, quando e por quê;
- `docker compose logs` / `journalctl` — o que o servidor registrou (ver `OPERACAO.md`).

## 10. O que ficou de fora, de propósito

Nada disto é necessário para colocar os primeiros clientes usando, e portanto nada disto foi feito:

- cobrança automática, checkout, cobrança recorrente, múltiplos planos;
- Central 360, CRM, painel comercial de super administrador;
- aplicativo móvel nativo;
- infraestrutura para centenas de empresas simultâneas;
- central de tickets de suporte;
- funcionalidades novas de produto que não sejam essenciais.

Ver `ROADMAP.md` para o que entra depois da validação com os clientes piloto.

## 11. Checklist antes de entregar a primeira empresa

1. `npm run test:all` — 318 testes passando.
2. `npm run build` — sem erro.
3. Servidor em produção com `NODE_ENV=production` e as variáveis obrigatórias — em VPS
   (`DEPLOY.md`) ou na hospedagem gratuita (`DEPLOY_GRATUITO.md`).
   O servidor **se recusa a subir** com configuração insegura; isso é proposital.
4. `npm run smoke -- https://seu-dominio` — 31 verificações contra a URL pública.
5. `curl https://seu-dominio/api/auth/modo` → `{"cadastroAberto":false}`.
6. Cópia dos dados garantida: em VPS, `npm run backup` e `npm run testar-restauracao`; no banco
   remoto, `npm run exportar` (o backup por arquivo não existe lá, e o servidor recusa em vez de
   fingir que fez).
7. `npm run piloto liberar ...` — libere a empresa e guarde a senha inicial.
8. Entregue ao cliente: a URL, o e-mail, a senha inicial e o pedido para trocá-la no primeiro
   acesso.

## 12. Comandos, em uma tabela

| Comando | O que faz |
|---|---|
| `npm run piloto` | Panorama de todas as empresas do piloto |
| `npm run piloto liberar <email> "<empresa>"` | Cria conta + empresa e mostra a senha inicial |
| `npm run piloto convidar <empresa> <email> [papel]` | Gera convite para uma empresa existente |
| `npm run piloto suspender <empresa> [motivo]` | Bloqueia o acesso, **preserva os dados** |
| `npm run piloto reativar <empresa>` | Devolve o acesso |
| `npm run piloto nota <empresa> "<texto>"` | Anotação interna sobre o cliente |
| `npm run piloto feedback [situação]` | Feedback de todas as empresas |
| `npm run piloto feedback-marcar <id> <situação> [nota]` | Muda a situação de um feedback |

`<empresa>` aceita o identificador (`ten_...`) ou parte do nome.
