# ☁️ Nuvem durável (Cloudflare R2) — porque os vídeos "não ficavam na nuvem" e o que mudou

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
 ┌───────────────────────┐                  ┌────────────────────────────┐
 │ app (browser)         │                  │ app (browser)              │
 │  └ IndexedDB (vídeo)  │                  │  └ IndexedDB (vídeo)       │
 │  └ cofre → bytebin ⚠  │                  │  └ nuvem-duravel.js        │
 │            kappa.lol ⚠│                  │       │                    │
 │  └ .mp4 → kappa.lol ⚠ │                  │       ▼                    │
 │            uguu.se ⚠  │                  │  Cloudflare Worker + R2    │
 │            litterbox ⚠│                  │   ├ videos/… (link público)│
 └───────────┬───────────┘                  │   └ vaults/cc_<hash>.json  │
             ▼                              └───────────┬────────────────┘
      expira em 3–72 h ✗                                ▼
                                              Robô 24h (Apps Script)
                                              lê o cofre no R2, valida o
                                              link e publica ✔
```

Correções aplicadas ao bundle (`index.html` / `app-pronto.html`) pela camada
`nuvem-duravel.js` + patch `tools/apply-cloud-patch.mjs`:

| # | Correção | Onde |
|---|---|---|
| 1 | Armazenamento durável: **Cloudflare R2** para o `.mp4` e para o cofre (bytebin/kappa passam a ser apenas leitura de migração) | `nuvem-duravel.js`, `cloudflare/r2-worker.js` |
| 2 | O upload é **aguardado antes** de gravar o cofre — o cofre já contém o link | `Pg()` (patch `07`) |
| 3 | Upload com **progresso**, **retry 3× com backoff**, timeout e **erros visíveis** (toast + `cloudError` no item) | `CineCloud.uploadVideo`, `Pg()` |
| 4 | `File` → memória antes do envio (evita `NotReadableError` silencioso quando o ficheiro local já não está acessível) | `readIntoMemory()` |
| 5 | Vídeos acima do limite de corpo do Worker (100 MB) usam **URL pré-assinada S3** | `/api/video/presign` |
| 6 | **Guarda anti-apagão**: leitura falhada + fila vazia ⇒ não sobrescreve o cofre | `blockEmptyOverwrite()` |
| 7 | Sync automático deixa de falhar em silêncio (toast limitado a 1×/5 min) | patch `08` |
| 8 | Selos honestos na fila: `☁️ R2 · PC + Celular`, `⚠️ link temporário`, `⚠️ só neste aparelho`, `sem vídeo` + botão **Reenviar p/ nuvem** | patches `09`, `10` |
| 9 | Migração automática do cofre antigo (bytebin/kappa → R2) | `getVaultCipher()` |
| 10 | Robô 24h lê/grava o cofre no R2, **valida se o link ainda responde** (Range GET) e marca `needsReupload` para o app reenviar | patch `15` |
| 11 | Painel de diagnóstico no app (**Copiar diagnóstico**) e no Apps Script (`testarLigacaoR2`, `estadoDaFila`) | patches `13`, `15` |

---

## 3. Setup do Cloudflare R2 (≈ 5 minutos, 0 €/mês no plano grátis)

Pré-requisitos: conta Cloudflare e Node 18+.

```bash
cd cloudflare
npx wrangler login                                   # abre o browser e autoriza
npx wrangler r2 bucket create cineclip-reels         # (ou cria no Dashboard → R2)
npx wrangler secret put CINECLIP_TOKEN               # ex.: cc_r2_<32 chars aleatórios>
npx wrangler deploy                                  # devolve a URL do Worker
```

A URL fica algo como `https://cineclip-cloud.<a-tua-subdomain>.workers.dev`.

> **Gera um token forte**, por exemplo:
> `node -e "console.log('cc_r2_'+require('crypto').randomBytes(24).toString('base64url'))"`

### Opcional

| Queres | Faz |
|---|---|
| Vídeos > 100 MB | Cria um **Token de API R2 (S3)** no Dashboard e define `R2_ACCOUNT_ID` e `R2_BUCKET_NAME` no `wrangler.toml`, mais `npx wrangler secret put R2_ACCESS_KEY_ID` e `… R2_SECRET_ACCESS_KEY`. O app passa a usar `/api/video/presign` automaticamente. |
| Domínio próprio nos links | Define `PUBLIC_BASE = "https://media.o-teu-dominio.com"` no `wrangler.toml` (e aponta o domínio para o Worker). |
| Ver o que está guardado | `curl -H "Authorization: Bearer $TOKEN" https://<worker>/api/stats` |

### Custos (plano grátis, à data de hoje)

- **R2**: 10 GB-mês de armazenamento, 1 M de operações de escrita, 10 M de leitura, **0 € de egress**.
  Um Reel de ~30 MB ⇒ ~330 vídeos nos 10 GB.
- **Workers**: 100 000 pedidos/dia. O Robô 24h gasta 288/dia; cada Reel gasta ~3 (upload + link + cofre).

---

## 4. Ligar o app ao R2

1. Abre o CineClip → **Configurações** → secção **☁️ Nuvem durável — Cloudflare R2**.
2. Cola a **URL do Worker** e o **Token** (`CINECLIP_TOKEN`) → **Guardar**.
3. Clica em **Testar ligação R2**: deve aparecer `R2 ligado ✔ (0 vídeo(s), 1 cofre(s)…)`.
4. Vai ao **Agendador de Reels** e, nos itens com `⚠️ só neste aparelho` ou
   `⚠️ link temporário`, clica em **Reenviar p/ nuvem** — o selo passa a `☁️ R2 · PC + Celular`.
5. Volta ao painel **Robô 24h (PC Desligado)** → **1. Copiar Código do Robô 24h** (agora sai
   com `R2_WORKER_URL`/`R2_TOKEN` preenchidos) → substitui o código antigo no
   [script.google.com](https://script.google.com) → 💾 → corre `ativarRobo24h` outra vez.

> Sem o R2 configurado o app continua a funcionar como antes (hosts temporários) — mas agora
> mostra `⚠️ link temporário` em vez de fingir que está na nuvem.

---

## 5. Testar sem conta Cloudflare (mock local)

```bash
npm run nuvem                 # http://localhost:4173  (app + API da nuvem em /cloud-api)
```

No app: **Configurações → Nuvem durável** → Worker URL `/cloud-api`, Token
`cc_r2_token_de_teste` → **Testar ligação R2**. Os ficheiros ficam em `.mock-cloud/` (ignorado
pelo git).

Testes automatizados da camada de nuvem (33 verificações: upload, Range/206, cofre,
presign, guarda anti-apagão, erros de rede):

```bash
npm run nuvem &                                     # porta 4173
npm run nuvem:presign &                             # porta 4174, limite de 1 MB
npm run nuvem:test
```

---

## 6. Recuperar os Reels que já "sumiram"

O link antigo morreu, mas o agendamento (legenda, horário, capa) continua na fila:

1. No Agendador, o item aparece com `⚠️ só neste aparelho` ou `sem vídeo`.
2. Se tiver `sem vídeo`, importa outra vez o `.mp4` (**Importar p/ <conta>**) para esse item.
3. Clica em **Reenviar p/ nuvem** → o selo passa a `☁️ R2 · PC + Celular`.
4. Confirma no Apps Script correndo `estadoDaFila` (lista cada Reel e o estado do link).

Itens que o Robô 24h apanhou com link morto ficam marcados com
`needsReupload` + `cloudError` — o app reenvia-os automaticamente na próxima sincronização.

---

## 7. Diagnóstico rápido

| Sintoma | Onde olhar |
|---|---|
| Selo `⚠️ só neste aparelho` | R2 não configurado, ou upload falhou — passa o rato por cima do selo para ver o `cloudError`; **Copiar diagnóstico** nas Configurações dá o log completo |
| `Testar ligação R2` falha com 401 | Token errado (`npx wrangler secret put CINECLIP_TOKEN`) |
| Falha com "não parece ser o CineClip Cloud" | URL errada ou Worker sem deploy |
| "sem binding R2 (BUCKET)" | `wrangler.toml` sem o `[[r2_buckets]]` ou bucket com outro nome |
| Meta rejeita o vídeo | O link tem de ser público e responder 200/206 com `Content-Type: video/mp4` — testa com `curl -I <link>` |
| Robô não publica nada | No Apps Script corre `testarLigacaoR2` e `estadoDaFila`; confirma que o código foi **recopiado** depois de configurares o R2 |

`window.CineCloud.report()` na consola do browser devolve o mesmo texto do botão
**Copiar diagnóstico**.

---

## 8. Estrutura dos ficheiros novos

```
nuvem-duravel.js            camada de nuvem no browser (window.CineCloud) — carregada antes do bundle
cloudflare/r2-worker.js     Worker: upload/leitura de vídeos + cofre, CORS, Range, presign SigV4
cloudflare/wrangler.toml    binding R2 + vars/secrets
tools/apply-cloud-patch.mjs aplica o patch ao bundle e valida sintaxe (idempotente)
tools/extract-patch-targets.mjs  regenera tools/patches/*.find a partir do bundle original
tools/patches/*.find|.replace    as 15 substituições, em texto simples e revisável
tools/dev-server.mjs        preview estático + mock da API da nuvem em /cloud-api
tools/mock-r2-worker.mjs    mock do Worker (mesmo contrato de API) para testes locais
tools/test-cinecloud.mjs    33 testes ponta-a-ponta da camada de nuvem
```

O repositório **não tem `src/`** (apenas o build), por isso o patch é aplicado sobre o
`index.html`/`app-pronto.html`. Se um dia recuperares as fontes, o sítio certo para estas
alterações é `src/lib/cloud.ts` (equivalente ao `nuvem-duravel.js`) e o fluxo de sync em
`src/App.tsx` — o `tools/patches/` documenta exatamente o que muda.

Reaplicar depois de um novo build:

```bash
npm run patch:extrair   # só se o bundle mudar de forma (regenera os alvos)
npm run patch:nuvem
```
