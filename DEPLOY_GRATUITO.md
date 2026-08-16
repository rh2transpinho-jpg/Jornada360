# Publicação gratuita — Opção A (Render + Turso)

Como colocar o Jornada360 numa URL pública **sem contratar servidor**, para o programa piloto.

A Opção B (Docker + Caddy + SQLite em VPS) continua inteira e documentada em [DEPLOY.md](DEPLOY.md).
Nada dela foi apagado: as duas rodam do mesmo código, e a volta está descrita no fim deste arquivo.

---

## 1. Por que estes dois serviços

| Peça | Serviço | Por quê |
|---|---|---|
| Aplicação (frontend + API) | **Render**, plano gratuito | Roda Node de verdade — Express, sessão em cookie e **scrypt** continuam como estão. Sem cartão. |
| Banco de dados | **Turso** (libSQL), plano gratuito | Hospedagem gratuita não tem disco persistente. O Turso guarda o banco fora da máquina, e fala o **mesmo dialeto do SQLite** — as 84 consultas do projeto valem letra por letra. Sem cartão. |

### Por que não Cloudflare Workers + D1

Foi a primeira opção avaliada, e ela é gratuita e sem cartão. Duas coisas a derrubaram para este
produto:

1. **O teto de 10 ms de CPU por requisição no plano gratuito.** O hash de senha do Jornada360 é
   scrypt; o Workers não tem scrypt, e o PBKDF2 disponível lá é limitado a 100.000 iterações — que
   por si só já custa cerca de 100 ms. Publicar no plano gratuito exigiria **enfraquecer o hash de
   senha** para caber no orçamento de CPU. Trocar segurança de senha por conveniência de deploy é
   exatamente o que não se faz.
2. **Express não roda no Workers.** Seriam cerca de 4.000 linhas de backend reescritas — uma
   reconstrução, não uma adaptação.

Fica registrado como caminho possível **se um dia** o produto pagar o plano de US$ 5/mês do Workers
(que remove o teto de CPU). Não é o caminho de um piloto gratuito.

---

## 2. Limites do plano gratuito, com números

### Render (aplicação)

| Limite | Valor |
|---|---|
| Horas de execução | 750 h/mês (um serviço 24 h/dia usa ~720 h) |
| Memória | 512 MB |
| **Hibernação** | **após 15 min sem acesso** |
| **Tempo para acordar** | **~1 minuto na primeira visita** |
| Disco persistente | **não existe** no plano gratuito — daí o Turso |
| Cartão de crédito | não exigido |

### Turso (banco)

| Limite | Valor |
|---|---|
| Armazenamento | 5 GB no total |
| Linhas lidas | 500 milhões/mês |
| Linhas escritas | 10 milhões/mês |
| Bancos | 100 |
| Cartão de crédito | não exigido |

### Quantas empresas isso aguenta

O número honesto depende de uso, então aqui está a conta em vez do palpite.

O consumo dominante é **leitura**, por causa de uma decisão da Fase 4: ao abrir o sistema, o
frontend carrega a empresa inteira de uma vez (ver [FRONTEND_BACKEND.md](FRONTEND_BACKEND.md)).
Cada abertura lê aproximadamente todas as linhas daquela empresa.

Uma empresa piloto com 30 colaboradores e 3 meses de dias processados fica na ordem de **3.000 a
5.000 linhas**. Com 2 pessoas abrindo o sistema 10 vezes por dia útil:

```
5.000 linhas × 20 aberturas/dia × 22 dias = 2,2 milhões de leituras/mês por empresa
```

Contra o teto de 500 milhões, isso dá espaço para **algo em torno de 100 empresas desse porte** —
muito além do que um piloto precisa. O limite que aperta primeiro **não é o do banco**: é a
hibernação do Render e os 512 MB de memória.

**A leitura honesta:** para 3 a 10 empresas piloto, esta estrutura sobra. O número acima é uma
estimativa a partir do padrão de acesso descrito, não uma medição — meça com
`npm run piloto panorama` e o painel do Turso quando houver clientes reais.

### Custo

**R$ 0/mês** enquanto dentro desses limites. Nenhum dos dois serviços pede cartão para o plano
gratuito, então não existe cobrança acidental por ultrapassar: o serviço avisa e limita.

O que **custaria**, se um dia for necessário:

| Necessidade | Serviço | Preço | Alternativa gratuita |
|---|---|---|---|
| Acabar com a hibernação | Render Starter | ~US$ 7/mês | Oracle Cloud Always Free (VM permanente, exige cartão só para verificação) |
| Mais banco que 5 GB | Turso pago | a partir de ~US$ 5/mês | exportar e arquivar histórico antigo |
| E-mail de recuperação/convite | Resend, Brevo, etc. | camadas gratuitas existem (~100 e-mails/dia) | entregar o código do convite à mão |

---

## 3. Publicar, passo a passo

### 3.1. Criar o banco no Turso

1. Criar conta em turso.tech (sem cartão).
2. Criar um banco — anote a **URL** (`libsql://…`) e gere um **token de acesso**.

### 3.2. Levar os dados para lá

Se já existe um banco local com dados (o seu ambiente de desenvolvimento, ou uma instalação
Docker), a migração é explícita e conferida:

```bash
npm run exportar
```

Gera `backups/jornada360-export-<data>.sql` com as contagens no cabeçalho. Depois:

```bash
JORNADA_DB_URL=libsql://SEU-BANCO JORNADA_DB_TOKEN=SEU-TOKEN npm run importar -- backups/jornada360-export-<data>.sql
```

O importador:

- **recusa um destino que já tem empresas** (a menos que você passe `--forcar`);
- carrega **dentro de uma transação** — se qualquer linha falhar, nada é gravado;
- **confere as contagens** de cada tabela contra o que o dump declarou;
- **confere o isolamento**: nenhuma linha de negócio pode ficar sem empresa dona;
- lista as empresas migradas ao final.

Se a conferência reprovar, ele diz para não usar aquele banco. Uma migração que termina sem erro
mas perde linhas é o pior desfecho possível, porque parece sucesso.

### 3.3. Subir a aplicação no Render

1. Colocar o repositório no GitHub (privado serve).
2. No Render: **New → Web Service**, apontar para o repositório e a branch.
3. Build: `npm ci && npm run build` · Start: `npm start` · Health check: `/api/saude`.
4. Preencher as variáveis de ambiente (ver `render.yaml` — os valores marcados `sync: false` são
   os que você digita no painel, porque são segredos):

```
NODE_ENV=production
JORNADA_SERVIR_FRONTEND=1
JORNADA_DB_URL=libsql://SEU-BANCO
JORNADA_DB_TOKEN=SEU-TOKEN
JORNADA_URL_PUBLICA=https://jornada360.onrender.com
JORNADA_CORS_ORIGENS=https://jornada360.onrender.com
JORNADA_COOKIE_SEGURO=1
JORNADA_TRUST_PROXY=1
JORNADA_EMAIL_MODO=desativado
```

O endereço só é conhecido depois do primeiro deploy. Faça o deploy, copie a URL que o Render
atribuir, preencha `JORNADA_URL_PUBLICA` e `JORNADA_CORS_ORIGENS` com ela e faça o deploy de novo.

**O servidor se recusa a subir com configuração insegura** — CORS ausente, cookie sem `Secure`,
URL sem HTTPS, banco sem token. Isso é proposital: um aviso no log seria fácil demais de ignorar.
Se o deploy falhar, o log diz exatamente qual variável está errada.

### 3.4. Conferir

```bash
npm run smoke -- https://jornada360.onrender.com
```

São 31 verificações contra a URL real: HTTPS, atributos do cookie, persistência entre sessões,
isolamento entre empresas, permissões e prontidão.

### 3.5. Liberar a primeira empresa

O cadastro está fechado (é produção). A liberação é pela CLI, que precisa alcançar o mesmo banco:

```bash
JORNADA_DB_URL=libsql://SEU-BANCO JORNADA_DB_TOKEN=SEU-TOKEN npm run piloto liberar cliente@empresa.com "Empresa Ltda"
```

Ela devolve a senha inicial **uma única vez**. Entregue ao cliente com a URL. Ver [PILOTO.md](PILOTO.md).

---

## 4. E-mail

Com `JORNADA_EMAIL_MODO=desativado`, o sistema publica sem envio de e-mail. O que muda:

- **Recuperação de senha** não envia link. Quem esquecer a senha precisa falar com você — e você
  resolve com um convite novo ou trocando a senha pela CLI.
- **Convite** continua funcionando: o código aparece na tela de quem o gerou, e é entregue por
  WhatsApp, e-mail pessoal ou telefone.

O modo não finge que enviou. Nunca houve um modo silencioso, e não foi criado um agora.

Para ligar o envio de verdade, basta uma conta em qualquer provedor com camada gratuita
(Resend, Brevo, Mailtrap em produção…) e duas variáveis:

```
JORNADA_EMAIL_MODO=smtp
JORNADA_SMTP_URL=smtps://usuario:senha@smtp.provedor.com:465
JORNADA_EMAIL_REMETENTE=Jornada360 <nao-responda@seu-dominio>
```

---

## 5. Backup

O `VACUUM INTO` da Opção B copia um arquivo local. **No banco remoto não há arquivo para copiar** —
e o servidor recusa a operação em vez de fingir que fez backup.

O backup da Opção A tem duas camadas:

1. **Exportação sua**, quando você quiser (guarde fora da sua máquina):
   ```bash
   JORNADA_DB_URL=... JORNADA_DB_TOKEN=... npm run exportar
   ```
   Produz um arquivo SQL com todos os dados e as contagens no cabeçalho.
2. **Point-in-time restore do Turso**, que o plano gratuito inclui com janela de 1 dia.

**Restaurar** é importar o dump num banco novo e apontar a aplicação para ele:

```bash
JORNADA_DB_URL=libsql://BANCO-NOVO JORNADA_DB_TOKEN=... npm run importar -- backups/<dump>.sql
```

O importador confere contagens e isolamento antes de você trocar a variável no Render. Restaure
sempre num banco **novo**, nunca por cima do que está em uso: se o dump estiver errado, você ainda
tem o original.

Recomendação para o piloto: rodar `npm run exportar` uma vez por semana e guardar os arquivos.

---

## 6. Rotinas agendadas

O backup automático interno (`setInterval` no processo) **não vale a pena aqui**: o serviço
hiberna, então o cronômetro para junto. Deixe `JORNADA_BACKUP_INTERVALO_HORAS` sem definir e faça a
exportação manualmente, ou use um agendador gratuito externo (o próprio cron-job.org, ou GitHub
Actions com `schedule:`) chamando a exportação.

Se um dia houver rotina periódica de verdade, ela cabe num GitHub Actions agendado — sem VPS.

---

## 7. O que muda em relação à Opção B (Docker/VPS)

| | Opção A (Render + Turso) | Opção B (Docker + Caddy + VPS) |
|---|---|---|
| Custo | R$ 0 | ~R$ 30–65/mês |
| Domínio | subdomínio do Render | seu domínio |
| Hibernação | sim, após 15 min | não |
| Banco | Turso (remoto) | SQLite em volume |
| Backup | exportação + PITR do provedor | `VACUUM INTO` verificado a cada 6 h |
| HTTPS | do Render | Caddy + Let's Encrypt |
| Frontend e API | mesma origem | mesma origem |
| Autenticação, scrypt, cookie | **idênticos** | **idênticos** |
| Multiempresa, RBAC, isolamento | **idênticos** | **idênticos** |
| Motor de jornada e regras | **idênticos** | **idênticos** |

**O que NÃO muda é o que importa:** nenhuma regra de negócio, nenhuma tela, nenhum cálculo e
nenhuma garantia de segurança foi alterada para caber na hospedagem gratuita.

---

## 8. Voltar para Docker/VPS depois

O código é o mesmo; muda a configuração e o destino do banco.

1. Exportar o banco remoto: `JORNADA_DB_URL=… JORNADA_DB_TOKEN=… npm run exportar`
2. Subir a VPS conforme [DEPLOY.md](DEPLOY.md) (Docker + Caddy).
3. Importar no banco em arquivo, **sem** as variáveis do banco remoto:
   ```bash
   JORNADA_DB_PATH=/dados/jornada360.db npm run importar -- backups/<dump>.sql
   ```
4. Conferir contagens e isolamento (o importador faz, e reprova se algo não bater).
5. Apontar o DNS para a VPS e desligar o serviço do Render.

Nenhuma linha de código muda: `JORNADA_DB_URL` ausente já significa "banco em arquivo".

---

## 9. Como os dois caminhos são testados

O driver remoto não é exercitado só em produção — seria o pior lugar para descobrir uma diferença
de comportamento. A mesma suíte de backend roda nos dois:

```bash
npm run test:server                          # 143 testes no driver SQLite
JORNADA_DB_DRIVER=libsql npm run test:server # 135 testes no driver libSQL
```

Os 8 que não rodam no libSQL são os de backup e restauração **por arquivo**, que dependem de
`VACUUM INTO` e de um arquivo local. Não é lacuna: aquele caminho nunca prometeu isso, e o backup
dele é a exportação descrita na seção 5.
