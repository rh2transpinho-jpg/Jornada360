# Publicar o Jornada360

> **Esta é a Opção B: VPS própria, com custo mensal.** Para publicar de graça durante o programa
> piloto (Render + Turso, R$ 0/mês, sem cartão), ver [DEPLOY_GRATUITO.md](DEPLOY_GRATUITO.md). As
> duas rodam do mesmo código e a migração entre elas está documentada.

Do zero até uma URL que você entrega a um cliente. O caminho recomendado leva **cerca de 40 minutos**, sendo a maior parte espera de propagação de DNS.

---

## O que você precisa antes de começar

| Item | Para quê | Custo aproximado |
|---|---|---|
| **Um servidor Linux** (VPS) | Rodar a aplicação | R$ 25–60/mês |
| **Um domínio** | A URL que o cliente digita | R$ 40–70/ano |
| **Uma conta de envio de e-mail** | Recuperação de senha e convites | Grátis até ~3.000/mês |

Nenhum dos três pode ser criado por outra pessoa em seu nome — todos exigem cadastro e, no caso do servidor e do domínio, meio de pagamento.

**Especificação do servidor:** 1 vCPU e 1 GB de RAM atendem com folga. O Jornada360 é um processo Node com SQLite; não há banco separado consumindo memória. Provedores que funcionam bem: Hetzner (mais barato), DigitalOcean, Vultr, Linode, Contabo. No Brasil: Hostinger VPS, KingHost.

**Provedor de e-mail:** Resend e Brevo têm plano gratuito suficiente para este uso e configuração simples. Amazon SES é mais barato em volume alto e mais trabalhoso de liberar. **Gmail não serve** — os limites são baixos e o bloqueio é frequente.

---

## Passo 1 — Apontar o domínio

No painel de DNS do seu domínio, crie um registro:

```
Tipo: A
Nome: jornada360      (ou @ para usar o domínio raiz)
Valor: <IP do seu servidor>
TTL: 300
```

Confira antes de seguir — se o DNS não estiver no lugar, a emissão do certificado falha:

```bash
dig +short jornada360.suaempresa.com.br
```

A propagação costuma levar de 1 a 30 minutos.

---

## Passo 2 — Preparar o servidor

```bash
ssh root@<ip-do-servidor>
```

```bash
apt update && apt install -y docker.io docker-compose-plugin git
```

```bash
git clone <url-do-seu-repositorio> /opt/jornada360 && cd /opt/jornada360
```

---

## Passo 3 — Configurar

```bash
cp .env.producao.example .env && nano .env
```

Preencha **todos** os campos. Os que mais dão trabalho:

- `JORNADA_SMTP_URL` — vem do provedor de e-mail. Em geral: `smtp://usuario:chave@servidor:587`
- `JORNADA_EMAIL_REMETENTE` — precisa ser de um domínio **verificado no provedor**. Um remetente não verificado cai em spam ou é recusado.
- `JORNADA_DOMINIO` e `JORNADA_URL_PUBLICA` — o mesmo domínio do Passo 1.

> O servidor **recusa subir** se algo estiver inseguro, e diz exatamente o quê. Se acontecer, leia a lista e corrija — não é um obstáculo, é a verificação funcionando.

---

## Passo 4 — Subir

```bash
docker compose up -d --build
```

Isto sobe a aplicação e o Caddy. O Caddy pede o certificado ao Let's Encrypt sozinho — **HTTPS não tem passo manual e não tem validade para alguém esquecer.**

Acompanhe o primeiro minuto:

```bash
docker compose logs -f
```

Você deve ver `certificate obtained successfully` e `servidor no ar`.

---

## Passo 5 — Verificar

```bash
npm run smoke -- https://jornada360.suaempresa.com.br
```

São 31 verificações: HTTPS, redirecionamento de http, cabeçalhos, cookie com os atributos certos, criação de conta, persistência entre sessões, isolamento entre empresas, permissões, recuperação de senha e prontidão operacional.

**Só considere publicado quando isto passar inteiro.** Ele cria duas contas de teste (avisa quais no fim) — pode removê-las ou ignorá-las.

---

## Pronto

A URL é `https://jornada360.suaempresa.com.br`. O cliente abre, cria a conta dele e usa. Ele vê **apenas o Jornada360** — nada do ambiente de desenvolvimento.

---

# Operação

## Ver se está tudo bem

```bash
curl https://jornada360.suaempresa.com.br/api/prontidao
```

Responde `200` quando banco, e-mail e backup estão em ordem; `503` quando algum não está, dizendo qual. É o endereço para apontar um monitor externo (UptimeRobot, Better Stack, Healthchecks.io — todos com plano gratuito).

Há também `/api/saude`, que responde rápido e sem tocar o banco — é o que o Docker usa internamente.

## Logs

```bash
docker compose logs -f app
```

Em produção saem em JSON, uma linha por evento: nível, mensagem, rota, status e duração. Rotas com identificador são normalizadas (`/api/tenants/:id/setores`) para agrupar métricas sem espalhar id de cliente pelo log.

**Nunca entram no log:** senha, token de sessão, código de convite ou recuperação, corpo de requisição, ou a URL de SMTP (que contém a senha do provedor).

## Reiniciar

```bash
docker compose restart app
```

Reinício automático já está configurado (`restart: unless-stopped`): a aplicação volta sozinha se cair e depois de a máquina reiniciar. Só não volta se você tiver parado de propósito.

O encerramento é gracioso — o servidor para de aceitar conexões, termina o que estava fazendo e fecha o banco antes de sair.

## Backup

Automático a cada 6 horas, retenção de 14 dias. **Todo backup é verificado**: logo após gerar, o arquivo é aberto e consultado; se falhar, é descartado e a falha vai para o log. Backup que não foi lido é esperança, não backup.

```bash
docker compose exec app node scripts/backup.js
```

```bash
docker compose exec app node scripts/backup.js --listar
```

O `VACUUM INTO` do SQLite é usado em vez de copiar o arquivo — copiar um banco com o servidor rodando produz, na melhor das hipóteses, uma cópia desatualizada.

### Levar os backups para fora da máquina

O backup fica no mesmo servidor. **Se a máquina se perder, o backup se perde junto.** Para uma cópia externa, um cron na sua máquina ou em outro servidor:

```bash
rsync -az root@<ip>:/var/lib/docker/volumes/jornada360_jornada_backups/_data/ ~/backups-jornada360/
```

## Testar a restauração

A única pergunta que importa sobre um backup é **ele funciona?**

```bash
docker compose exec app node scripts/restaurar.js --testar
```

Restaura numa cópia isolada, confere que abre, mostra as contagens e descarta. **Não toca no banco em uso.** Rode uma vez por mês.

## Restaurar de verdade

```bash
docker compose stop app
docker compose run --rm app node scripts/restaurar.js
docker compose start app
```

Sem argumento, usa o backup mais recente; pode passar um caminho para voltar a um ponto anterior. Antes de sobrescrever, o script:

1. **verifica o backup** — restaurar um arquivo corrompido destruiria o banco bom para colocar um ruim no lugar;
2. **guarda o banco atual** com o sufixo `.pre-restauracao`;
3. **confere o banco restaurado** depois de gravar.

## Atualizar sem perder dados

```bash
cd /opt/jornada360
docker compose exec app node scripts/backup.js     # 1. backup antes
git pull                                            # 2. código novo
docker compose up -d --build                        # 3. reconstrói e sobe
npm run smoke -- https://jornada360.suaempresa.com.br   # 4. verifica
```

**Os dados não se perdem** porque o banco vive num volume Docker, fora da imagem. As migrations rodam sozinhas na subida e são idempotentes: aplicam só o que falta.

Se algo der errado, `git checkout <commit-anterior> && docker compose up -d --build` volta a versão. Se a migration nova alterou dados, restaure o backup do passo 1.

---

## Alternativa: sem Docker

`deploy/` traz as unidades systemd. O caminho é mais trabalhoso e **não inclui HTTPS** — você precisa configurar Caddy ou Nginx à parte.

```bash
sudo cp deploy/jornada360.service /etc/systemd/system/
sudo systemctl enable --now jornada360
sudo systemctl enable --now jornada360-backup.timer
sudo systemctl enable --now jornada360-verificar-backup.timer
```

O timer de verificação roda o ensaio de restauração toda semana — uma falha de backup aparece em dias, não em meses.

---

## Desenvolvimento × Produção

| | Desenvolvimento | Produção |
|---|---|---|
| Como sobe | `npm run dev:all` | `docker compose up -d` |
| Portas | 5173 (Vite) + 3333 (API) | 443, servindo tudo |
| Frontend | Vite, com recarga automática | Construído, servido pela API |
| HTTPS | não | sim, automático |
| Cookie | sem `Secure` | com `Secure` |
| Banco | `./data/` | volume persistente |
| Backup | desligado | a cada 6h, verificado |
| E-mail | `log` (console) | `smtp` (envia) |
| Validação de config | não exige nada | **recusa subir se inseguro** |

O ambiente de desenvolvimento **nunca** é o que o cliente vê. Ele acessa apenas a URL pública, que serve o frontend construído.

---

## Problemas comuns

**"O servidor NÃO subiu — configuração de produção inválida"**
A verificação funcionando. A lista diz exatamente o que corrigir no `.env`.

**Certificado não emitido**
O DNS não estava apontando quando o Caddy tentou. Confira com `dig` e reinicie: `docker compose restart proxy`.

**E-mail não chega**
`curl .../api/prontidao` mostra o estado do SMTP. As causas usuais: remetente não verificado no provedor, ou credencial errada. O log do servidor traz o erro do provedor.

**"Alguém alterou este registro enquanto você editava"**
Não é erro: duas pessoas editaram o mesmo registro e o sistema recusou sobrescrever em silêncio. Recarregar e refazer é o caminho.

---

## Custos

| Item | Mensal |
|---|---|
| VPS (1 vCPU, 1 GB) | R$ 25–60 |
| Domínio | ~R$ 5 (rateio anual) |
| Certificado HTTPS | R$ 0 (Let's Encrypt) |
| E-mail (até ~3.000/mês) | R$ 0 |
| **Total** | **R$ 30–65/mês** |

Sem custo por cliente: um servidor atende várias empresas — é o mesmo processo, com isolamento por `tenant_id`.

---

## Banco: quando trocar SQLite por Postgres

Não agora. SQLite atende com folga o volume de uma empresa e não exige serviço externo.

O sinal para migrar é **concorrência de escrita**, não volume de dados: o SQLite serializa escritas, então muitas pessoas gravando ao mesmo tempo é o limite prático. Com dezenas de usuários simultâneos por empresa, vale reavaliar.

O que já facilita a troca: SQL padrão, sem recurso exclusivo do SQLite, e todo acesso concentrado em `server/repositories/`. Ver [BACKEND.md](BACKEND.md).
