# CineClip 🎬

Aplicação web **100% no navegador** que limpa metadados de vídeos, corta até 2:30, formata em **9:16** com texto de *hook* no topo, identifica o filme/série via **NVIDIA Vision + TMDB** e gera uma legenda pronta para publicar.

## Estrutura do Projeto

- `src/` — código-fonte da aplicação (React 18 + TypeScript + Vite + Tailwind 4):
  - `src/lib/` — lógica pura, testável fora do browser: `video.ts` (pipeline FFmpeg 9:16 +
    gancho), `ai.ts` (NVIDIA Vision, Gemini, TMDB, legenda), `ig.ts` (publicação na Graph
    API), `cloud.ts` (camada de nuvem durável — antiga `nuvem-duravel.js`), `vault.ts`
    (cofre encriptado), `robo.ts` (gerador do Robô 24h), `queue.ts`, `sync.ts`, etc.
  - `src/components/` — interface: `Studio.tsx` (3 passos), `Agendador.tsx`, `Settings.tsx`,
    `Login.tsx`, `Preview916.tsx` e primitivas em `ui.tsx`
- `index.html` — entrada fina do Vite (sem bundle inline)
- `apps-script/cineclip-cloud-drive.js` e `cloudflare/r2-worker.js` — backends do Google
  Drive e do Cloudflare R2
- `server/nvidia-proxy.mjs` — proxy NVIDIA partilhado (dev via `vite.config.ts`);
  `api/public/nvidia.js` e `netlify/functions/nvidia.mjs` — o mesmo proxy para Vercel e Netlify
- `tools/` — mocks locais da nuvem (R2 + Drive) e testes que correm contra `src/` e os
  backends reais
- `_headers` (Netlify / Cloudflare Pages), `netlify.toml` e `vercel.json` — revalidação do HTML

## Como executar localmente

```bash
npm install
npm run dev
```

Para gerar o build de produção (assets com hash no nome — a cache do browser não volta a
prender deploys novos):

```bash
npm run build
npm run preview
```

> O dev do Vite já inclui, sem contas externas: proxy NVIDIA em `/api/public/nvidia`,
> mock do Worker R2 em `/cloud-api` e mock do Apps Script em `/drive-api` (usa
> `http://localhost:5173/cloud-api` / `/drive-api` em **Configurações → Nuvem durável**
> com os tokens `cc_r2_token_de_teste` / `cc_drive_token_de_teste`). Vercel e Netlify têm
> proxy NVIDIA incluído. GitHub Pages serve apenas arquivos estáticos e não executa
> `/api/`; a identificação que depende da NVIDIA precisa de um backend em Vercel/Netlify
> (ou outro host).

## 📅 Agendador (layout)

A aba **Agendador** tem um layout próprio: resumo (na fila / próximo post / publicados /
erros), abas **Fila · Conta e horários · Robô 24h**, cartão *Novo agendamento* com atalhos
para os próximos horários livres, fila agrupada por dia com filtros e detalhes expansíveis
(reagendar, mudar de conta, legenda, baixar, reenviar, remover com confirmação) e editor
de horários diários em chips.

**Ordenar a fila:** ordena por horário (mais cedo / mais tarde), título ou situação (erros
primeiro), com busca por título/legenda. Em *Horário (mais cedo)* podes **arrastar** os
Reels ou usar as setas ↑↓ — os horários ficam fixos e os Reels trocam de lugar.
**Reorganizar horários** redistribui os agendados pelos próximos horários livres
(corrige atrasados e fecha buracos), e itens atrasados/com erro têm o atalho
*Mover p/ próximo horário livre*.

O Agendador é código-fonte normal: `src/components/Agendador.tsx` (layout + lógica de UI)
e `src/lib/queue.ts` / `src/lib/sync.ts` (horários e sincronização).

## 🤖 Publicação automática (Robô 24h)

A publicação **não depende de o app estar aberto**: na aba **Agendador → Robô 24h** o
botão *1. Copiar Código do Robô 24h* gera o script (já com a chave do teu cofre) para
colares em <https://script.google.com> e correres `ativarRobo24h`. Fica um acionador de
**5 em 5 minutos** nos servidores do Google: o robô lê a fila na nuvem, publica pela
Graph API e marca o resultado — **com o PC e o telemóvel desligados**.

- **Anti-publicação duplicada:** o robô e o app *reclamam* o Reel (claim, TTL 10 min)
  antes de publicar e libertam-no no fim; se o backend ainda não tiver claims, publica-se
  na mesma (degradação segura). É por isso que **só um aparelho** deve publicar a mesma fila.
- **Se o Apps Script/dev backend foi reimplantado**, volta a correr `ativarRobo24h` (e
  cria *Nova versão* da implantação): o `/exec` muda a cada reimplantação.
- **Se usaste a versão só-manual** e sincronizaste a fila, os agendados ficaram gravados
  como `device_scheduled`: o app converte-os de volta a `scheduled` ao ler o cofre e o
  robô também os aceita — nenhum Reel fica preso por causa da mudança.
- **Regressão conhecida:** houve uma versão (PR #15, commit `5b07192`) em que o robô foi
  desligado e a publicação passou a ser só manual — o gerador foi trocado por um stub que
  apagava o acionador e a fila passou a sincronizar como `device_scheduled`. Está
  revertida: `src/lib/robo.ts` gera o robô completo e `tools/test-logic.mjs` falha se
  alguém o voltar a desligar (acionador de 5 min, Graph API, claims e ausência de
  vestígios do modo só-manual).

## 🎬 Erro 2207077 no Instagram (`Media upload has failed`)

> `Erro em @conta: O Instagram recusou o processamento do vídeo: Error: Media upload has failed with error code 2207077`

Esse código não está na tabela pública da Meta: aparece quando os servidores dela **não
conseguem descarregar/processar o `.mp4`** a partir do `video_url` que o app lhe entrega.
Os gatilhos conhecidos são links de hosts **temporários** (`uguu.se` 3 h, `litterbox` 12 h,
`kappa.lol`) já expirados quando o horário agendado chegou, hosts que respondem `GET` mas
falham `HEAD` (ou bloqueiam o crawler da Meta), respostas em HTML (login/captcha) em vez dos
bytes do vídeo e falhas transitórias da própria Meta.

Em `src/lib/ig.ts` a publicação do Reel não tem um único caminho:

1. **Envio direto** (`POST /media?upload_type=resumable` → `rupload.facebook.com`, com
   `offset`/`file_size` e progresso): o `.mp4` sai do browser direto para a Meta, **sem link
   público nenhum** — é a correção documentada para o 2207077, porque a Meta deixa de "ir
   buscar" o ficheiro. Se o navegador bloquear o pedido (rede/CORS), cai para o passo 2.
2. **`video_url` verificado**: antes de gastar a tentativa o link guardado é sondado
   (`HEAD` + `GET Range: bytes=0-1`); links de host temporário, links `404/410`, respostas em
   HTML ou hosts que só servem por `GET` são substituídos por um envio novo à nuvem durável.
   Os links de **nuvem durável** também são verificados: um link do Drive que aponte para uma
   **implantação antiga do Apps Script** (o `/exec` muda a cada reimplantação) é reconstruído
   contra o `/exec` configurado agora; o `?action=videohead` confirma que o ficheiro ainda
   existe e que cabe no limite de ~50 MB do `file.getBlob()` do Apps Script (acima disso a
   Meta receberia uma página de erro em vez do `.mp4` — 2207077 garantido, e o app explica
   logo em vez de tentar).
3. **Repetição com container novo** (o container que falhou fica inutilizável), até 3
   tentativas, alternando as duas estratégias. Erros permanentes — formato (`2207026`),
   limite de 50/24 h (`2207042`), conta restringida (`2207050`/`2207051`), token — não são
   repetidos: a mensagem sai logo com a dica certa. Um `media_publish` sem resposta **não**
   é repetido automaticamente, para não duplicar o Reel.

O erro mostrado na interface passa a trazer o código e a dica (ex.: *"O Instagram recusou o
processamento do vídeo (código 2207077): … · Dica: … (após 3 tentativas)"*), e um Reel que
ficou em erro pode ser reenviado pelo **Publicar agora** do Agendador.

> **E o `(após 2 tentativas)`?** Significa que o Reel **não tem o ficheiro `.mp4` neste
> aparelho** (só o link na nuvem): sem o ficheiro não há envio direto nem renovação do link,
> por isso o plano fica reduzido a duas tentativas por `video_url`. Nesse cenário o app agora
> (1) renova links do Drive de implantações antigas e recusa logo links que o Apps Script não
> consegue servir (ficheiro apagado ou >50 MB), (2) **não repete** com um link que a sonda
> prova estar morto após o primeiro 2207077, e (3) diz na mensagem final o que desbloqueia de
> verdade: **reimportar o `.mp4` neste aparelho** (Importar no Agendador), para a publicação
> passar a usar o envio direto, sem depender de link nenhum.

> **Histórico: `hS is not defined`.** Na era do bundle minificado, o helper que eleva a capa
> do Instagram (`/t/p/w300/` → `/t/p/w780/`) podia ficar fora do troço substituído por um
> patch e a publicação rebentava logo na primeira tentativa. Na reescrita o helper é a
> função `boostPoster` de `src/lib/ai.ts`, coberta por `tools/test-logic.mjs`.

Cada tentativa **renova a claim anti-duplicado** (TTL de 30 min) para o TTL de 10 min do
Worker/Apps Script não expirar a meio de um envio longo — e se a claim passar a ser de
outro aparelho/Robô, a publicação para em vez de arriscar um Reel repetido.

> **Regressão da claim no Worker R2 (`Outro aparelho ou o Robô 24h está a publicar este
> Reel` sem ninguém a publicar).** O Worker gravava a claim sempre com
> `onlyIf: { etagDoesNotMatch: "*" }` — a pré-condição de *criar*, que só funciona com a
> chave vazia. Depois da primeira aquisição a chave nunca mais estava vazia, por isso a
> **renovação do mesmo dono** (feita antes de cada tentativa) e o **takeover de uma claim
> expirada** falhavam sempre: o Worker respondia `acquired:false` sem dono, o app e o Robô
> abortavam com a mensagem acima e aquele Reel nunca mais era publicado. A escrita passou a
> usar a pré-condição certa para cada caso — criar com `etagDoesNotMatch:"*"`, renovar/tomar
> com `etagMatches` do objeto lido — e o diagnóstico (`GET /api/claims`) limpa as claims
> caducas em vez de as esconder. Como o Worker corre na Cloudflare, **é preciso
> `npx wrangler deploy` outra vez**; o site sozinho não atualiza o backend. Coberto por
> `npm run worker:test` (o Worker real contra um bucket R2 falso, incluindo renovação,
> takeover, corrida entre dois donos e runtimes sem escrita condicional).

> **Regressão do botão "Publicar agora" (o clique não fazia nada).** O patch das claims
> (19/20) passou a usar `oe.current` como cadeado de publicação — mas `oe` é o **ref do
> `<input type="file">`** do botão *Importar*, que é renderizado sempre que o Agendador
> está aberto. Como o React preenche esse ref logo na montagem, `oe.current` era sempre
> verdadeiro: o handler saía pelo `if(oe.current) return` e o clique não publicava, não
> mostrava erro e nem sequer tocava na API da Meta. O **Auto-Pilot** (o intervalo de 30 s
> chama o mesmo handler) também ficava mudo — parecia tudo normal, o Reel só nunca saía.
> Os testes existentes não apanhavam isto porque cobriam `gS`/claims em isolamento, nunca
> o clique. Agora o cadeado tem um ref **próprio** (`ccPubLock`, patch `25-publish-lock`),
> o `oe` volta a servir só o `<input type="file">`, e `tools/test-agendador-publish.mjs`
> arranca o bundle real em jsdom, faz login, clica no botão e exige um pedido a
> `graph.facebook.com` — sem isso, o teste falha.

### Ainda apanhas o 2207077? Confirma que estás na versão nova

A mensagem diz-te qual o código que está a correr, **sem abrires o bundle**:

| Mensagem que aparece | O que significa |
| --- | --- |
| `… do vídeo (código 2207077): … · Dica: … (após 3 tentativas)` | versão **nova** — as 3 tentativas correram e a Meta recusou mesmo |
| `… do vídeo: Error: Media upload has failed with error code 2207077` | versão **antiga** — sem `(código …)`, sem `· Dica:` e sem contagem: o browser está a servir o bundle pré-correção |

Na consola (F12), `document.querySelector("script[src*=assets]")?.src` mostra o bundle com
hash que o browser carregou — se o hash for igual ao do `dist/index.html` do deploy, estás
na versão nova. Em caso de dúvida, **recarregamento forçado** (`Ctrl+Shift+R` / `Cmd+Shift+R`).

> **Histórico: a correção que não chegava ao browser.** Na era do bundle, `index.html` e
> `nuvem-duravel.js` tinham nomes fixos, sem hash nem `Cache-Control`: a correção do
> 2207077 ficava no repositório e verde nos testes, mas o browser continuava a servir a
> cópia antiga. A reescrita em Vite resolve isto **estruturalmente**: cada build emite
> `assets/index-<hash>.js` / `assets/index-<hash>.css` e o `index.html` é revalidado
> (`_headers`, `netlify.toml`, `vercel.json`). `tools/test-build.mjs` falha se um build
> algum dia voltar a emitir nomes sem hash.

Testar tudo isto sem conta Meta:

```bash
npm test   # lógica + nuvem (mocks R2/Drive) + arranque da app + build + Worker R2 + proxy NVIDIA
```

## ☁️ Nuvem durável (Google Drive **ou** Cloudflare R2)

Os Reels agendados desapareciam da "nuvem" porque o `.mp4` era enviado para hosts gratuitos
**temporários** — `uguu.se` (3 h), `litterbox` (12 h no app, máx. 72 h), `kappa.lol`
(100 MiB, "may remove content at any time") e o cofre para o `bytebin.lucko.me` (serviço
anunciado como defunto) — enquanto o agendador marca publicações até **60 dias** à frente.
Somavam-se a isso uploads em background sem `await`, erros engolidos por `catch{}` e uma
sincronização que podia sobrescrever a fila com dados vazios.

Agora o armazenamento é **teu** e durável, com duas opções à escolha (o app usa a que estiver
configurada e, se tiveres as duas, faz failover automático R2 → Drive):

| | **Google Drive** (recomendado) | **Cloudflare R2** |
|---|---|---|
| Custo | **0 €**, sem cartão | 10 GB/mês grátis, mas o checkout pede cartão (e há relatos de exigir Workers Paid, 5 USD/mês) |
| Setup | colar `apps-script/cineclip-cloud-drive.js` num projeto Apps Script, correr `setup`, implantar como Web App | `npx wrangler deploy` em `cloudflare/` |
| Tamanho do vídeo | até **45 MB** (limite de Blob do Apps Script) | até **100 MB** direto, **5 GB** com URL pré-assinada |
| Envio | blocos de 2 MB (upload *resumable* do Drive) | direto, com progresso e presign |
| Link público | `?action=video&id=…` (sem `Range`) | `/v/<chave>` com `Range`/`206` |

Mais: upload **aguardado** antes de gravar o cofre, retry 3× com backoff, progresso, erros
visíveis (toast + `cloudError` no item), limites lidos do próprio backend, guarda
anti-apagão da fila, migração automática dos cofres antigos e selos honestos
(`☁️ Drive · PC + Celular` / `☁️ R2 · PC + Celular` / `⚠️ link temporário` /
`⚠️ só neste aparelho` / `sem vídeo`) com botão **Reenviar p/ nuvem**.

```bash
npm run dev       # app + mocks da nuvem em http://localhost:5173 (/drive-api e /cloud-api) — sem contas
npm test          # lógica + nuvem ponta-a-ponta (mocks) + arranque da app + build + Worker R2 + proxy NVIDIA
npm run worker:test  # o Worker real da Cloudflare contra um bucket R2 falso (claims/ETag)
npm run typecheck # tsc --noEmit
npm run build     # gera dist/ para deploy estático (assets com hash)
```

- **[NUVEM-DURAVEL.md](NUVEM-DURAVEL.md)** — diagnóstico completo, setup do Drive e do R2,
  limites reais de cada um, recuperação dos Reels perdidos e tabela de diagnóstico.
- `apps-script/cineclip-cloud-drive.js` — backend Google Drive (Web App): upload em blocos,
  cofre encriptado, `videohead`, `health`, `stats` e o helper `setup()`.
- `cloudflare/r2-worker.js` + `cloudflare/wrangler.toml` — backend R2 (upload, link público
  com Range/206 para a Meta, cofre, presign SigV4, stats).
- `src/lib/cloud.ts` — camada de nuvem no browser (antiga `nuvem-duravel.js`, portada 1:1).
- `tools/` — mocks locais (R2 + Drive) e testes que correm contra `src/` e os backends reais.
