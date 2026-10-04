# CineClip 🎬

Aplicação web **100% no navegador** que limpa metadados de vídeos, corta até 2:30, formata em **9:16** com texto de *hook* no topo, identifica o filme/série via **NVIDIA Vision + TMDB** e gera uma legenda pronta para publicar.

## Estrutura do Projeto

- `index.html` — aplicação React já compilada (interface, processamento com FFmpeg e identificação do filme)
- `app-pronto.html` — cópia de distribuição do bundle principal
- `nuvem-duravel.js` — camada de armazenamento durável (`window.CineCloud`), carregada antes do app
- `apps-script/cineclip-cloud-drive.js` e `cloudflare/r2-worker.js` — backends do Google Drive e Cloudflare R2
- `tools/` — servidor de preview, mocks, testes e ferramentas para reaplicar os patches do bundle
- `vite.config.ts` — servidor de desenvolvimento e proxy local para NVIDIA
- `api/public/nvidia.js` e `netlify/functions/nvidia.mjs` — proxy NVIDIA para deploys Vercel e Netlify

## Como executar localmente

```bash
npm install
npm run dev
```

Para gerar o build de produção:

```bash
npm run build
npm run preview
```

> **Estado atual do repositório:** o código-fonte React (`src/`) não está versionado; a
> interface está guardada como bundle em `index.html`. O `npm run build` copia esse bundle,
> a camada de nuvem e o fallback 404 para `dist/` (sem tentar compilar o bundle de novo).
> Para testar o app com mocks locais da nuvem em `/drive-api` e `/cloud-api`, usa
> `npm run nuvem`; esse servidor não precisa de `npm install`. Vercel e Netlify têm proxy
> NVIDIA incluído. GitHub Pages serve apenas arquivos estáticos e não executa `/api/`; a
> identificação que depende da NVIDIA precisa de um backend em Vercel/Netlify (ou outro host).

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

Para o alterar, edita **só** `tools/agendador-ui/agendador.template.js` (código legível)
e `tools/agendador-ui/agendador.css`, e corre `npm run patch:agendador`.

## 🎬 Erro 2207077 no Instagram (`Media upload has failed`)

> `Erro em @conta: O Instagram recusou o processamento do vídeo: Error: Media upload has failed with error code 2207077`

Esse código não está na tabela pública da Meta: aparece quando os servidores dela **não
conseguem descarregar/processar o `.mp4`** a partir do `video_url` que o app lhe entrega.
Os gatilhos conhecidos são links de hosts **temporários** (`uguu.se` 3 h, `litterbox` 12 h,
`kappa.lol`) já expirados quando o horário agendado chegou, hosts que respondem `GET` mas
falham `HEAD` (ou bloqueiam o crawler da Meta), respostas em HTML (login/captcha) em vez dos
bytes do vídeo e falhas transitórias da própria Meta.

A partir do patch **`24-ig-2207077`** a publicação do Reel deixa de ter um único caminho:

1. **Envio direto** (`POST /media?upload_type=resumable` → `rupload.facebook.com`, com
   `offset`/`file_size` e progresso): o `.mp4` sai do browser direto para a Meta, **sem link
   público nenhum** — é a correção documentada para o 2207077, porque a Meta deixa de "ir
   buscar" o ficheiro. Se o navegador bloquear o pedido (rede/CORS), cai para o passo 2.
2. **`video_url` verificado**: antes de gastar a tentativa o link guardado é sondado
   (`HEAD` + `GET Range: bytes=0-1`); links de host temporário, links `404/410`, respostas em
   HTML ou hosts que só servem por `GET` são substituídos por um envio novo à nuvem durável.
3. **Repetição com container novo** (o container que falhou fica inutilizável), até 3
   tentativas, alternando as duas estratégias. Erros permanentes — formato (`2207026`),
   limite de 50/24 h (`2207042`), conta restringida (`2207050`/`2207051`), token — não são
   repetidos: a mensagem sai logo com a dica certa. Um `media_publish` sem resposta **não**
   é repetido automaticamente, para não duplicar o Reel.

O erro mostrado na interface passa a trazer o código e a dica (ex.: *"O Instagram recusou o
processamento do vídeo (código 2207077): … · Dica: … (após 3 tentativas)"*), e um Reel que
ficou em erro pode ser reenviado pelo **Publicar agora** do Agendador.

> **Regressão `hS is not defined`.** O `hS` — o helper que eleva a capa do Instagram
> (`/t/p/w300/` → `/t/p/w780/`) — vivia **dentro** do troço do bundle que o patch 24 substitui.
> Como o código novo continuava a chamá-lo, a publicação rebentava logo na primeira tentativa
> (`ReferenceError: hS is not defined`), apesar de `npm run ig:test` passar: o contexto `vm` do
> teste injetava um `hS` falso, escondendo exatamente o que falhava no browser. Agora o helper é
> declarado dentro do próprio bloco e o teste tem a secção **0. Autossuficiência do bloco**, que
> falha se uma chamada apontar para um helper que só exista no bundle que envolve o bloco.

Cada tentativa **renova a claim anti-duplicado** (TTL de 30 min) para o TTL de 10 min do
Worker/Apps Script não expirar a meio de um envio longo — e se a claim passar a ser de
outro aparelho/Robô, a publicação para em vez de arriscar um Reel repetido. A mensagem diz
**quem** tem a claim e **até quando**, para se saber quando voltar a tentar.

> 🔧 **Correção da renovação da claim (Worker R2).** O Worker usava sempre
> `onlyIf: { etagDoesNotMatch: "*" }` ao gravar a claim. Como o objeto já existia (a claim
> que o próprio app acabou de obter, ou uma claim expirada deixada por uma execução
> interrompida), a renovação e o takeover falhavam sempre: o app recebia `acquired:false`
> sem dono e abortava a publicação com *"Erro em …: Outro aparelho ou o Robô 24h está a
> publicar este Reel agora (proteção anti-duplicado)"* — mesmo sem ninguém a publicar, e o
> "tenta novamente dentro de alguns minutos" nunca se cumpria. Agora a renovação do mesmo
> dono usa escrita condicional ao `ETag` e as claims mortas (expiradas/ilegíveis) são
> substituídas ou apagadas. **Se já tens o Worker instalado, faz `npx wrangler deploy`
> outra vez.** Ver `npm run worker:test` (43 verificações do Worker real contra um bucket R2
> falso, incluindo renovação, takeover e corrida entre dois donos) e a secção 10 de
> [NUVEM-DURAVEL.md](NUVEM-DURAVEL.md).

Testar tudo isto sem conta Meta (Graph API, `rupload.facebook.com` e XHR simulados):

```bash
# 56 verificações: envio direto, fallback, retries, links, capa, claims, dicas```

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
npm run nuvem          # app + mocks em http://localhost:4173 (/drive-api e /cloud-api) — testar sem contas
npm run nuvem:test     # testes ponta-a-ponta da camada de nuvem (arranca os mocks sozinho)
npm run worker:test    # testes do Worker real (cloudflare/r2-worker.js) com um bucket R2 falso
npm test               # testes da nuvem + Worker + proxy NVIDIA + publicação no Instagram
npm run build          # gera dist/ para deploy estático
npm run patch:full     # reconstrói/verifica o bundle e reaplica os patches
npm run patch:agendador # regenera e aplica o layout do Agendador (tools/agendador-ui/)
```

- **[NUVEM-DURAVEL.md](NUVEM-DURAVEL.md)** — diagnóstico completo, setup do Drive e do R2,
  limites reais de cada um, recuperação dos Reels perdidos e tabela de diagnóstico.
- `apps-script/cineclip-cloud-drive.js` — backend Google Drive (Web App): upload em blocos,
  cofre encriptado, `videohead`, `health`, `stats` e o helper `setup()`.
- `cloudflare/r2-worker.js` + `cloudflare/wrangler.toml` — backend R2 (upload, link público
  com Range/206 para a Meta, cofre, presign SigV4, stats).
- `nuvem-duravel.js` — camada no browser (`window.CineCloud`), carregada antes do bundle.
- `tools/` — patch reproduzível do bundle, mocks locais, servidor de preview e testes.
