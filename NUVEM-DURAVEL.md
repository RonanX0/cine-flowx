# ☁️ Nuvem durável (Google Drive **ou** Cloudflare R2) — porque os vídeos "não ficavam na nuvem" e o que mudou

## 1. O diagnóstico (resposta curta)

O CineClip nunca guardou o vídeo na nuvem. Guardava **metadados** num cofre encriptado e,
quando conseguia, um **link temporário** para o `.mp4`. Um Reel só "fica na nuvem" (selo
`☁️`) se esse link existir — e ele era gerado por hosts gratuitos que **apagam os ficheiros**:

| O que o app usava | Retenção real | Consequência |
|---|---|---|
| `bytebin.lucko.me` (cofre) | serviço anunciado como **defunto**, "will be permanently shut down soon"; tempo de vida padrão do conteúdo 1440 min | cofre desaparece |
| `kappa.lol` (vídeo e cofre) | máx. **100 MiB**, "we may remove or modify Content at any time" | vídeo some sem aviso |
| `uguu.se` (fallback do `vite.config.ts`) | **apaga em 3 h** | vídeo morre no mesmo dia |
| `litterbox.catbox.moe` (fallback) | o app pedia `time: "12h"` (máximo do serviço: 72 h) | vídeo morre antes do horário |
| memória do dev server (`tempVideos`) | **2 h** e perde-se ao reiniciar | vídeo morre em 2 h |

Como o agendador distribui os Reels até **60 dias** à frente, qualquer vídeo agendado para
amanhã já tinha o link morto quando o Robô 24h (Apps Script) ia publicar.

### As 5 falhas de código que tornavam isto invisível

1. **O cofre nunca contém o vídeo** — `Km()` removia o blob antes de enviar:
   `queue: (o.queue||[]).map(p => { const {videoBlob, ...v} = p; … })`.
2. **Ordem invertida + sem `await`** — o cofre era gravado *antes* do upload, e o upload
   corria num bloco `async` solto (`return O.length>0 && (async()=>{…})()`). Fechar a aba,
   trocar de app ou o celular suspender o browser cancelava o envio: o link ficava só no
   IndexedDB local e nunca chegava ao cofre na nuvem.
3. **Erros engolidos** — `catch{}` vazio em `bg()` (upload) e no loop de envio; e o sync
   automático (`j(…, false)`) só mostrava toast quando era manual. Falhar 20 s após 20 s
   era silencioso.
4. **Corrida entre sincronizações** — o sync a cada 20 s regrava o cofre inteiro
   (last-write-wins) e troca o ponteiro no `keyvalue.immanuel.co`: um sync podia
   sobrescrever o cofre que já tinha os links.
5. **Leitura falhada = fila apagada** — `SS()` devolvia `null` tanto para "cofre não
   existe" como para "rede falhou". Um aparelho com fila vazia (ex.: celular recém-aberto,
   sem conseguir ler a nuvem) regravava um **cofre vazio** e apagava os Reels dos outros.

> Bónus: `deletedReelIds` é sincronizado — apagar um Reel num aparelho remove-o em todos.

---

## 2. O que mudou

```
        ANTES                                          DEPOIS
 ┌───────────────────────┐                  ┌──────────────────────────────────┐
 │ app (browser)         │                  │ app (browser)                    │
 │  └ IndexedDB (vídeo)  │                  │  └ IndexedDB (vídeo)             │
 │  └ cofre → bytebin ⚠  │                  │  └ nuvem-duravel.js (CineCloud)  │
 │            kappa.lol ⚠│                  │       │  aguarda o upload ✔      │
 │  └ .mp4 → kappa.lol ⚠ │                  │       ▼                          │
 │            uguu.se ⚠  │                  │  OPÇÃO A · Google Drive          │
 │            litterbox ⚠│                  │   Apps Script Web App            │
 └───────────┬───────────┘                  │   └ Drive/CineClip Cloud/        │
             ▼                              │      ├ videos/<fileId>.mp4       │
      expira em 3–72 h ✗                    │      └ vaults/cc_<hash>.json     │
                                            │  OPÇÃO B · Cloudflare R2         │
                                            │   └ videos/… + vaults/… (S3)     │
                                            └───────────┬──────────────────────┘
                                                        ▼
                                              Robô 24h (Apps Script, 5/5 min)
                                              lê o cofre (R2 → Drive → antigo),
                                              valida o link e publica ✔
```

Correções aplicadas ao bundle (`index.html` / `app-pronto.html`) pela camada
`nuvem-duravel.js` + patch `tools/apply-cloud-patch.mjs` (18 substituições por ficheiro):

| # | Correção | Onde |
|---|---|---|
| 1 | **Dois backends duráveis** à escolha: Google Drive (grátis, sem cartão) e Cloudflare R2. bytebin/kappa passam a ser só leitura de migração | `nuvem-duravel.js`, `apps-script/cineclip-cloud-drive.js`, `cloudflare/r2-worker.js` |
| 2 | **Cadeia com failover**: se o provider principal falha, tenta o seguinte (R2 → Drive → antigo) em vez de desistir | `chain()`, `uploadVideo()`, `putVault()`, `getVaultCipher()` |
| 3 | O upload é **aguardado antes** de gravar o cofre — o cofre já contém o link | `Pg()` (patch `07`) |
| 4 | Upload com **progresso**, **retry 3× com backoff**, timeout e **erros visíveis** (toast + `cloudError` no item) | `CineCloud.uploadVideo`, `Pg()` |
| 5 | `File` → memória antes do envio (evita `NotReadableError` silencioso quando o ficheiro local já não está acessível) | `readIntoMemory()` |
| 6 | **Drive**: vídeos > 8 MB são enviados em **blocos de 2 MB** (upload *resumable* do Drive) — o Apps Script nunca guarda o vídeo inteiro em memória; limites lidos do próprio backend (`?action=health`) | `uploadToDrive()`, `driveInfo()` |
| 7 | **R2**: vídeos acima do limite de corpo do Worker (100 MB) usam **URL pré-assinada S3** | `/api/video/presign` |
| 8 | **Guarda anti-apagão**: leitura falhada + fila vazia ⇒ não sobrescreve o cofre | `blockEmptyOverwrite()` |
| 9 | Sync automático deixa de falhar em silêncio (toast limitado a 1×/5 min) | patch `08` |
| 10 | Selos honestos na fila: `☁️ Drive · PC + Celular`, `☁️ R2 · PC + Celular`, `⚠️ link temporário`, `⚠️ só neste aparelho`, `sem vídeo` + botão **Reenviar p/ nuvem** | patches `09`, `10` |
| 11 | Migração automática do cofre antigo (bytebin/kappa → Drive/R2) | `getVaultCipher()` |
| 12 | Robô 24h lê/grava o cofre no R2 **e** no Drive, **valida se o link ainda responde** e marca `needsReupload` para o app reenviar | patch `15` |
| 13 | Validação de links do Drive por `?action=videohead` (o Apps Script não suporta `Range`; um GET normal descarregava o vídeo inteiro e gastava quota) | `verifyPublicUrl()`, `verificarLink()` |
| 14 | Painel de diagnóstico no app (**Testar ligação Drive/R2**, **Copiar diagnóstico**) e no Apps Script (`testarLigacaoDrive`, `testarLigacaoR2`, `estadoDaFila`) | patches `13`, `15` |
| 15 | 🔒 **Claims (anti-publicação duplicada)**: antes de publicar, o app/Robô reclama o item no backend e liberta-o no fim. Se o app e o Robô 24h acordarem ao mesmo tempo (ou houver 2 aparelhos com a mesma fila), só um publica. Se o backend ainda for antigo, publica-se na mesma (degradação segura) | patches `19`, `20`, `15` (Robô), `nuvem-duravel.js`, `cloudflare/r2-worker.js`, `apps-script/cineclip-cloud-drive.js` |

---

## 3. Opção A — Google Drive (grátis, sem cartão) ← recomendado

Os vídeos ficam numa pasta **`CineClip Cloud`** do teu próprio Drive. Um *Web App* do
Apps Script faz de servidor: recebe os uploads, guarda o cofre encriptado e serve o `.mp4`
à Meta quando o Robô publica.

### 3.1 Criar o backend (≈ 5 minutos)

1. Abre <https://script.google.com> → **Novo projeto**.
2. Apaga o código de exemplo e cola **todo** o conteúdo de
   [`apps-script/cineclip-cloud-drive.js`](apps-script/cineclip-cloud-drive.js) → 💾 Guardar.
3. No selector de funções (barra superior) escolhe **`setup`** → ▶ **Executar** → autoriza a
   tua conta Google. O registo (Ver → Registos ou `Ctrl+Enter`) mostra:

   ```
   ✅ CineClip Cloud pronto.
      Pasta : CineClip Cloud  (id: 1AbC…)
      TOKEN : cc_drive_XXXXXXXXXXXXXXXXXXXXXXXX
   ```

4. **Implantar → Nova implantação → App da Web** e preenche:
   - *Descrição*: `cineclip-cloud`
   - *Executar como*: **Eu**
   - *Quem pode aceder*: **Qualquer pessoa** ← sem isto a Meta não consegue ler o vídeo
5. Clica em **Implantar** e copia o **URL da app da Web** (termina em `/exec`).
6. Testa no browser: `URL/exec?action=health` deve devolver
   `{"ok":true,"service":"cineclip-cloud-drive",…}`.

> ⚠️ **Sempre que alterares o código do Apps Script** é preciso criar uma **nova versão**
> (Implantar → Gerir implantações → ✏️ → Versão: *Nova versão*), senão o URL continua a
> servir a versão antiga.

### 3.2 Ligar o app

1. CineClip → **Configurações** (ícone ⚙ no topo) → cartão
   **☁️ Nuvem durável — Google Drive (grátis, sem cartão)**.
2. Cola o **URL do Apps Script** (`…/exec`) e o **Token** (`cc_drive_…`) → **Guardar**.
3. **Testar ligação Drive** → deve aparecer
   `Google Drive (Apps Script) ligado ✔ (0 vídeo(s), 1 cofre(s) … · blocos de 2.0 MB)`.
4. No **Agendador de Reels**, os itens com `⚠️ só neste aparelho` ou `⚠️ link temporário`
   ganham o botão **Reenviar p/ nuvem** → o selo passa a `☁️ Drive · PC + Celular`.
5. Por fim, **copia outra vez o código do Robô 24h** (painel *Robô 24h (PC Desligado)* →
   *1. Copiar Código do Robô 24h*): ele já sai com `DRIVE_SCRIPT_URL` e `DRIVE_TOKEN`
   preenchidos. Substitui o código antigo no Apps Script e corre `ativarRobo24h`.

### 3.3 Limites reais do Drive/Apps Script (lê antes de agendar 60 dias)

| Limitação | Valor | Como o CineClip lida com isso |
|---|---|---|
| Espaço no Drive | **15 GB** grátis (partilhado com Gmail/Fotos) | ~300–500 Reels de 30 MB; apaga os ficheiros antigos da pasta `CineClip Cloud/videos` |
| Tamanho de um **Blob** no Apps Script | **50 MB** (52 428 800 bytes) | `MAX_VIDEO_MB = 45` no backend; o app recusa antes de enviar e diz para cortar o clipe ou usar o R2 |
| Tempo máximo por execução | **6 min** (contas gratuitas) | uploads em blocos de 2 MB: cada pedido dura segundos |
| Corpo de um `POST` | ~50 MB | idem (blocos de 2 MB ≈ 2,7 MB em base64) |
| `Range`/`206` no `ContentService` | **não suportado** | a Meta lê o ficheiro completo (funciona); o Robô valida com `?action=videohead` |
| Quotas `UrlFetchApp` | 20 000 chamadas/dia | o Robô gasta ~3 por execução (288/dia) e **nunca** descarrega vídeos |
| Privacidade dos ficheiros | ficam **privados** no teu Drive | só o Web App os serve; o `fileId` (25–44 caracteres) é o segredo do link |

Um Reel de 60 s a 720p/1080p tem normalmente **5–30 MB** → dentro do limite.
Se trabalhas com clipes maiores, usa a Opção B.

### 3.4 "Failed to fetch" / o browser bloqueia a leitura → modo compatível (JSONP)

O Google **não deixa** um Web App do Apps Script definir cabeçalhos CORS. Consequência: um
site noutro domínio (Netlify, Vercel, localhost, ou o app dentro de um iframe) faz o pedido,
o Apps Script **responde**, mas o browser **não deixa o app ler a resposta** — e o JavaScript
só vê um `Failed to fetch` genérico. Não é um erro teu nem da configuração.

O CineClip resolve isto sozinho, com um **modo compatível**:

| | Modo direto (CORS) | Modo compatível (JSONP) |
|---|---|---|
| Como lê | `fetch()` normal | etiqueta `<script src=…&callback=…>` — **não está sujeita a CORS** |
| Como escreve | `POST` e lê a resposta | `POST` "às cegas" (`no-cors`) + confirma o resultado com uma leitura |
| Quando é usado | sempre que o browser deixa | automaticamente, assim que uma leitura é bloqueada |

- O backend devolve `text/javascript` com `minhaCallback({…});` — tem de ser este MIME,
  porque com `application/json` o browser bloqueia a resposta por CORB/ORB.
- O nome da callback só aceita `[A-Za-z0-9_$.]` (nada de código injetado pelo URL).
- O botão **Testar ligação Drive** diz em que modo ficou:
  `… · modo direto (CORS)` ou `… · modo compatível (JSONP)`.
- As escritas "às cegas" são sempre **confirmadas**: o cofre é lido de volta e comparado
  byte a byte; o vídeo confirma-se com `?action=complete`, que devolve o link final. Se a
  confirmação falhar, o app repete o envio (3 tentativas) — nunca fica um ficheiro a meio
  sem aviso.

> ⚠️ O modo compatível precisa do `apps-script/cineclip-cloud-drive.js` **atualizado** no
> teu projeto e de uma **nova versão** da implantação (Implantar → Gerir implantações →
> ✏️ → Versão: *Nova versão*). Sem isso o backend não reconhece o parâmetro `callback` e o
> app avisa: *"respondeu mas não devolveu dados (modo compatível)"*.

---

## 4. Opção B — Cloudflare R2 (mais rápido, sem limite de 45 MB, **precisa de cartão**)

Pré-requisitos: conta Cloudflare e Node 18+.

```bash
cd cloudflare
npx wrangler login                                   # abre o browser e autoriza
npx wrangler r2 bucket create cineclip-reels         # (ou cria no Dashboard → R2)
npx wrangler secret put CINECLIP_TOKEN               # ex.: cc_r2_<32 chars aleatórios>
npx wrangler deploy                                  # devolve a URL do Worker
```

A URL fica algo como `https://cineclip-cloud.<a-tua-subdomain>.workers.dev`.
Testa: `curl https://<worker>/` → `{"ok":true,"service":"cineclip-cloud","bucket":true}`.

> **Gera um token forte**:
> `node -e "console.log('cc_r2_'+require('crypto').randomBytes(24).toString('base64url'))"`

### 💳 Custos — lê isto antes

- **R2**: 10 GB-mês de armazenamento, 1 M de escritas, 10 M de leituras e **0 € de egress**
  (um Reel de ~30 MB ⇒ ~330 vídeos nos 10 GB grátis).
- **Mas** ativar o R2 obriga a **completar um checkout** na Cloudflare (pede cartão na
  maioria dos casos) e há relatos de que ligar um bucket a um Worker exige o plano
  **Workers Paid (5 USD/mês)**. Confirma no checkout antes de te comprometeres.
- Plano Cloudflare Free: corpo de pedido até **100 MB** — acima disso o app usa
  automaticamente `/api/video/presign` (URL pré-assinada S3, até 5 GB).

### Opcional

| Queres | Faz |
|---|---|
| Presign (vídeos > 100 MB) | Cria um **Token de API R2 (S3)** no Dashboard, define `R2_ACCOUNT_ID` e `R2_BUCKET_NAME` no `wrangler.toml` e `npx wrangler secret put R2_ACCESS_KEY_ID` / `… R2_SECRET_ACCESS_KEY` |
| Domínio próprio nos links | `PUBLIC_BASE = "https://media.o-teu-dominio.com"` no `wrangler.toml` |
| Ver o que está guardado | `curl -H "Authorization: Bearer $TOKEN" https://<worker>/api/stats` |

Cola a **URL do Worker** e o **Token** no cartão *⚡ Alternativa — Cloudflare R2* das
Configurações e clica em **Testar ligação R2**.

---

## 5. Como o app escolhe o backend

`cloudProvider` (Configurações, default `auto`):

| Valor | Ordem usada |
|---|---|
| `auto` | **R2** (se configurado) → **Drive** (se configurado) → hosts antigos |
| `drive` | só Google Drive |
| `r2` | só Cloudflare R2 |
| `legacy` | comportamento antigo (hosts temporários) |

- Se configurares os dois, o R2 vai primeiro (serve com `Range`/206 e não tem o limite de
  45 MB) e o **Drive funciona como rede de segurança**: se o R2 falhar (token errado,
  Worker em baixo, 5xx), o vídeo vai para o Drive em vez de ir para um host temporário.
- Cada tentativa tem **retry 3× com backoff**; só erros definitivos (ficheiro ilegível,
  vídeo acima do limite) falham de imediato.
- O cofre é gravado em **todos** os providers configurados (mais o espelho antigo, para o
  Robô de versões anteriores continuar a funcionar).

---

## 6. Testar sem nenhuma conta (mocks locais)

```bash
npm run nuvem        # http://localhost:4173 — app + /cloud-api (R2) + /drive-api (Drive)
```

No app, **Configurações → Nuvem durável**:

| Campo | Valor de teste |
|---|---|
| URL do Apps Script | `/drive-api` |
| Token do Drive | `cc_drive_token_de_teste` |
| Worker URL (R2) | `/cloud-api` |
| Token do R2 | `cc_r2_token_de_teste` |

Os ficheiros ficam em `.mock-cloud/` (ignorado pelo git). É o **mesmo contrato de API** dos
backends reais — incluindo os detalhes do Apps Script: respostas sempre `HTTP 200` com
`{ok:false,…}` em caso de erro e **sem suporte a `Range`**.

Testes automatizados da camada de nuvem — **92 verificações**, sem internet e sem contas
(arranca os próprios mocks na porta 4199):

```bash
npm run nuvem:test
```

Cobrem: upload direto e em blocos (512 KB, 1,5 MB, 2 MB, 9 MB, 10 MB) com integridade
byte-a-byte, presign do R2, `videohead`, cofre put/get/não-existente, limites anunciados
pelo backend, recusa de vídeo acima do limite, prioridade e **failover R2 → Drive**, tokens
inválidos, backends inacessíveis (`readFailed`), guarda anti-apagão,
`diagnostics()`/`report()`, URLs colados de qualquer maneira (sem `https://`, com espaços,
com `?action=health` a mais, `/dev`) e o **modo compatível (JSONP)** com o CORS bloqueado de
propósito — escrita "às cegas" + confirmação pela leitura.

---

## 7. Recuperar os Reels que já "sumiram"

O link antigo morreu, mas o agendamento (legenda, horário, capa) continua na fila:

1. No Agendador, o item aparece com `⚠️ só neste aparelho`, `⚠️ link temporário` ou `sem vídeo`.
2. Se tiver `sem vídeo`, importa outra vez o `.mp4` (**Importar p/ <conta>**) para esse item.
3. Clica em **Reenviar p/ nuvem** → o selo passa a `☁️ Drive · PC + Celular` (ou `☁️ R2 · …`).
4. Confirma no Apps Script correndo `estadoDaFila` (lista cada Reel) e `testarLigacaoDrive`
   (verifica **cada link de vídeo** um a um).

Itens que o Robô 24h apanhou com link morto ficam marcados com `needsReupload` + `cloudError`
— o app reenvia-os automaticamente na próxima sincronização.

> Os teus agendamentos **não se perdem** com estas alterações: IndexedDB
> (`cineclip_scheduler_db`/`reels_queue`), `localStorage`, a encriptação do cofre
> (PBKDF2-SHA256 60 000 iterações + XOR stream `v:2`) e os tombstones mantêm-se iguais.
> Na dúvida, faz **Exportar Fila** (.json) antes de atualizar.

---

## 8. Diagnóstico rápido

| Sintoma | Onde olhar |
|---|---|
| Selo `⚠️ só neste aparelho` | nenhuma nuvem configurada ou upload falhou — passa o rato por cima do selo para ver o `cloudError`; **Copiar diagnóstico** dá o log completo |
| `Testar ligação Drive` → "inacessível" | URL errado (usa o `/exec`, não o `/dev`) ou deployment não é *App da Web* |
| Devolve HTML em vez de JSON | *Quem pode aceder* não é **Qualquer pessoa**, ou faltou criar **Nova versão** após editar o código |
| "o Apps Script RESPONDEU mas o browser bloqueou a leitura" | É o CORS do Google (não é defeito teu). O app muda sozinho para o **modo compatível (JSONP)** — precisa do ficheiro atualizado no Apps Script + **Nova versão** da implantação (secção 3.4) |
| "respondeu mas não devolveu dados (modo compatível)" | O código no Apps Script é anterior ao JSONP: volta a colar o `cineclip-cloud-drive.js` e cria uma **Nova versão** da implantação |
| "Token inválido" no Drive | corre `setup()` outra vez e copia o `CINECLIP_TOKEN` novo para as Configurações **e** para o Robô |
| "excede o limite de 45 MB" | corta o clipe, baixa o bitrate, ou usa o R2 |
| `Testar ligação R2` falha com 401 | token errado (`npx wrangler secret put CINECLIP_TOKEN`) |
| "sem binding R2 (BUCKET)" | `wrangler.toml` sem `[[r2_buckets]]` ou bucket com outro nome |
| Meta rejeita o vídeo | o link tem de ser público e devolver `video/mp4` — Drive: `?action=video&id=…`; R2: `curl -I <link>` deve dar 200/206 |
| Robô não publica nada | no Apps Script corre `testarLigacaoDrive` (ou `testarLigacaoR2`) e `estadoDaFila`; confirma que o código foi **recopiado** depois de configurares a nuvem |
| 🔒 "já está a ser publicado por … — envio ignorado" | É a proteção anti-duplicado a funcionar: outro aparelho (ou o Robô 24h) tem a claim do item. Se ficar preso, vê as claims ativas com `?action=claims` (Drive) ou `GET /api/claims` (Worker) — as claims expiram sozinhas em 10 min |
| 🔒 Aviso "Claims indisponíveis …" | O Worker/Apps Script configurado ainda não tem as rotas de claims (versão antiga). As publicações continuam a funcionar — atualiza o backend (secção 10) para ganhares a proteção |

`window.CineCloud.report()` na consola do browser devolve o mesmo texto do botão
**Copiar diagnóstico** (ordem dos providers, configuração, último erro e log).

---

## 9. Estrutura dos ficheiros

```
nuvem-duravel.js                  camada de nuvem no browser (window.CineCloud) — carregada antes do bundle
apps-script/cineclip-cloud-drive.js  backend Google Drive: Web App (upload em blocos, cofre, videohead, health)
cloudflare/r2-worker.js           Worker R2: upload/leitura de vídeos + cofre, CORS, Range/206, presign SigV4
cloudflare/wrangler.toml          binding R2 + vars/secrets
tools/apply-cloud-patch.mjs       aplica os 18 patches ao bundle e valida sintaxe (idempotente)
tools/extract-patch-targets.mjs   regenera tools/patches/*.find a partir do bundle original
tools/restore-base.mjs            repõe index.html/app-pronto.html no commit base (antes do patch)
tools/patches/*.find|.replace     as 18 substituições, em texto simples e revisável
tools/dev-server.mjs              preview estático + mocks em /cloud-api e /drive-api
tools/mock-r2-worker.mjs          mock do Worker R2 (mesmo contrato) para testes locais
tools/mock-drive-backend.mjs      mock do Apps Script/Drive (mesmo contrato, HTTP 200 + {ok:false})
tools/test-cinecloud.mjs          testes ponta-a-ponta da camada de nuvem
```

O repositório **não tem `src/`** (apenas o build), por isso o patch é aplicado sobre o
`index.html`/`app-pronto.html`. Se um dia recuperares as fontes, o sítio certo para estas
alterações é `src/lib/cloud.ts` (equivalente ao `nuvem-duravel.js`) e o fluxo de sync em
`src/App.tsx` — o `tools/patches/` documenta exatamente o que muda.

### Regenerar o patch do zero (determinístico)

```bash
npm run patch:full    # = patch:base (repor o bundle original)
                      # + patch:extrair (regenerar os .find)
                      # + patch:nuvem (aplicar os 18 patches e verificar sintaxe)
```

Os dois bundles ficam **byte-idênticos** entre execuções (md5 estável) e o código do
Robô 24h gerado é validado com `node --check` antes de gravar.

---

## 10. 🔒 Claims — anti-publicação duplicada

### O problema

O app (no browser) e o Robô 24h (Apps Script) partilham a mesma fila no cofre. Sem uma
trava, a sequência que acontece é esta:

1. o Robô lê o cofre e vê o Reel das 21:00 com `status: "scheduled"`;
2. ao mesmo tempo, o auto-piloto do app lê o cofre e vê **o mesmo item**;
3. os dois publicam — e o Reel aparece **duas vezes** no Instagram.

O mesmo acontece com dois aparelhos abertos com a mesma conta (PC + celular).

### Como funciona

Antes de publicar, cada lado **reclama** o item (uma *claim*, com validade/TTL de 10 min):

* quem consegue a claim é quem publica;
* quem não consegue **não publica** e deixa o item como está (volta a tentar mais tarde,
  ou vê que o outro lado já o marcou como `published`);
* a claim é **libertada** no fim (sucesso ou erro) e **expira sozinha** — uma execução
  interrompida nunca bloqueia a fila para sempre;
* o mesmo dono pode renovar a claim (um retry não se auto-bloqueia);
* claims expiradas podem ser tomadas por outro dispositivo.

### Contrato da API

| Backend | Adquirir | Libertar | Listar (diagnóstico) |
|---|---|---|---|
| Cloudflare Worker (R2) | `POST /api/claims/acquire` | `POST /api/claims/release` | `GET /api/claims` · `GET /api/claims/:key` |
| Google Drive (Apps Script) | `POST ?action=claim` | `POST ?action=release` | `GET ?action=claims` |

Corpo de `acquire`/`claim` (JSON): `{"key":"cc_<cofre>_<id do Reel>","owner":"app:…|robo:…","ttlMs":600000}`

Respostas:

```json
{ "ok": true, "acquired": true,  "claim": { "key": "…", "owner": "app:1a2b", "expiresAt": 1791068055790 } }
{ "ok": true, "acquired": false, "holder": { "owner": "robo:9x8y", "expiresAt": 1791068055790 } }   ← não publicar
```

* `key` = `cc_<vaultHash>_<id do Reel>` (o mesmo formato no app e no Robô, por isso
  bloqueiam-se mutuamente).
* `POST` no Apps Script vai com `Content-Type: text/plain` (evita o preflight CORS que o
  Google não responde); em **modo compatível** o resultado é confirmado com
  `GET ?action=claims` por JSONP.
* No Worker a escrita é condicional (`onlyIf`) e confirmada por releitura; no Apps Script
  a exclusão mútua é feita com `LockService`.

### Degradação segura (importante)

Se o backend **ainda não tiver** as rotas/ações de claims (Worker/Apps Script antigos), o
app e o Robô **publicam na mesma** — só aparece um aviso no log/toast:

> ⚠️ Claims indisponíveis … — a publicar sem proteção anti-duplicado.

Ou seja: **publicar só o front-end não parte as publicações**. O que se perde, até
atualizares o backend, é apenas a proteção contra Reels repetidos.

### Passos manuais para ativar a proteção

1. **Worker (R2)** — `npx wrangler deploy` (as rotas novas entram no mesmo deployment).
2. **Apps Script (Drive)** — cola outra vez o `apps-script/cineclip-cloud-drive.js` e cria
   **Implantar → Gerir implantações → ✏️ → Nova versão**.
3. **Robô 24h** — no CineClip, gera e **cola o código outra vez** no Apps Script (o Robô que
   já está a correr é código antigo e não conhece as claims).
4. Nada disto é obrigatório para o site continuar a publicar: sem os passos acima a
   proteção fica apenas inativa.

### Testar

```bash
npm test          # inclui os testes das claims: R2, Drive, modo compatível,
                  # expiração/takeover, dono errado a tentar libertar, backend antigo
```

---

## 11. 🎬 "Media upload has failed with error code 2207077" na publicação

Este erro não vem do armazenamento: vem do **Instagram** e significa que os servidores da
Meta não conseguiram descarregar/processar o `.mp4` a partir do `video_url` que o app lhes
deu. É a mesma família de problema que este documento descreve para a nuvem — ficheiros em
hosts temporários (3–72 h) que já expiraram quando o horário agendado chegou, hosts que
respondem `GET` mas falham `HEAD` e respostas em HTML em vez dos bytes do vídeo.

O patch `24-ig-2207077` ataca as duas pontas:

* **Envio direto** (`upload_type=resumable` → `rupload.facebook.com`): o `.mp4` sai do
  browser direto para a Meta e **não precisa de link público nenhum** (por isso a Meta deixa
  de "ir buscar" o ficheiro). Se a rede/CORS do navegador bloquear, o app volta sozinho ao
  caminho do `video_url`.
* **`video_url` verificado e renovado**: o link guardado é sondado antes de gastar a
  tentativa (`HEAD` primeiro, `GET Range: bytes=0-1` a seguir). Links expirados, em HTML ou
  de host que só aceita `GET` são substituídos por um envio novo à nuvem durável — ou seja,
  a nuvem durável deixa de ser só "para não perder o vídeo" e passa a ser também o que
  garante que o **Instagram consegue mesmo buscar** o ficheiro.
* Em erro de processamento, a publicação repete com **container novo** (o que falhou fica
  inutilizável) até 3 tentativas, alternando as estratégias; os erros permanentes
  (`2207026`, `2207042`, `2207050`, `2207051`, token) terminam logo com a dica certa.

> **Cuidado com helpers do bundle base.** O bloco do patch substitui um troço onde vivia o
> `hS` (eleva a capa de `/t/p/w300/` para `/t/p/w780/`). Chamar nomes que ficaram para trás no
> troço substituído dá `ReferenceError` só no browser — a publicação falhava com
> `hS is not defined` apesar de os testes passarem, porque o contexto `vm` do teste injetava
> um `hS` falso. O `hS` voltou a ser declarado dentro do bloco e a secção **0** do
> `tools/test-ig-publish.mjs` falha se uma chamada apontar para um helper que já não exista
> dentro do bloco (nem seja um dos dois do bundle que ele pode usar: `bg` e `Yo`).

Testar sem conta Meta:

```bash
npm run ig:test   # 53 verificações com a Graph API e o rupload simulados
```

Como agora se podem fazer até 3 tentativas (envio + processamento), o app **renova a claim
antes de cada tentativa** (`ttlMs` de 30 min) — o TTL de 10 min do Worker/Apps Script nunca
expira a meio e, se a claim passar a ser de outro aparelho/Robô, a publicação para em vez de
duplicar o Reel.
