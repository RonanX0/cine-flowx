# CineClip 🎬

Aplicação web **100% no navegador** que limpa metadados de vídeos, corta até 2:30, formata em **9:16** com texto de *hook* no topo, identifica o filme/série via **Gemini (principal) ou NVIDIA Vision** + **TMDB** e gera uma legenda pronta para publicar.

## Estrutura do Projeto

- `src/App.tsx` — Fluxo principal em 3 etapas (Upload e limpeza → Identificação do filme → Legenda gerada)
- `src/lib/ffmpeg.ts` — Processamento de vídeo no navegador com `@ffmpeg/ffmpeg` (WebAssembly): corte de tempo, remoção de faixas pretas (`crop`), fundo vertical 9:16 branco, sobreposição do texto de *hook* e limpeza total de metadados/capítulos/unidades SEI
- `src/lib/crop.ts` — Deteção automática de faixas pretas horizontais (letterbox) por amostragem de 8 frames via Canvas
- `src/lib/meta.ts` — Leitura e auditoria de metadados (Antes / Depois) com `mediainfo.js`
- `src/lib/apis.ts` — Integração com **Google Gemini** (chamada directa ao `generativelanguage.googleapis.com`) e, em alternativa, **NVIDIA NIM** (`meta/llama-3.2-11b-vision-instruct` e `nvidia/llama-3.1-nemotron-70b-instruct`), mais a **TMDB API**
- `src/components/VerticalPreview.tsx` — Pré-visualização 9:16 em tempo real
- `src/components/SettingsDialog.tsx` — Modal de configuração e teste de chaves Gemini / NVIDIA / TMDB e texto do topo
- `src/components/MovieIdentification.tsx` — Cartão do filme identificado, grelha de alternativas e pesquisa manual no TMDB
- `netlify/functions/nvidia.mjs` — Proxy `/api/public/nvidia` para evitar CORS ao chamar a NVIDIA a partir do browser. **O destino é fixo** (não é uma open proxy) e a chave do utilizador nunca é logada. Deploy: `/api/public/nvidia` → `/.netlify/functions/nvidia` (ver `netlify.toml`)

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

> **Estado atual do repositório:** só o *build* está versionado (`index.html`, `404.html`) — a
> pasta `src/` **não** está no repo, por isso o bundle só pode ser alterado por *patch*
> (ver `tools/patches/`), nunca à mão. O proxy da NVIDIA vive em `netlify/functions/`. Para
> correr a aplicação como está, usa `npm run nuvem` (servidor estático + mocks da API de nuvem em
> `/drive-api` e `/cloud-api`), que não precisa de `npm install`.

## Qual-provider de IA usar

São **dois caminhos diferentes**, e não são equivalentes:

| | **Gemini** (recomendado) | **NVIDIA** |
|---|---|---|
| Chave | Google AI Studio (`AIza…`) | NVIDIA NIM (`nvapi-…`) |
| Chamada | directa do browser para `generativelanguage.googleapis.com` | passa por `netlify/functions/nvidia.mjs` (evita CORS) |
| Precisa de servidor? | **não** | **sim** — no Netlify/Vercel tem de existir a function |
| Funciona offline no build estático | sim | só se a function estiver implantada |

> ⚠️ **NVIDIA não funciona num deploy estático sem a function.** Sem ela, o catch-all
> `/* → /index.html` devolve HTML onde a app espera JSON e a identificação falha com um erro
> pouco claro. Em Netlify e Vercel a function já está no repo — noutros alojamentos, implanta-a
> tu. Se não quiseres depender disto, usa **Gemini**, que é o caminho principal e o que a tela de
> login anuncia.

### 📌 Por fazer: auto-hospedar o core do FFmpeg

O bundle carrega o FFmpeg (WASM) do `unpkg.com` — `https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm`
(há também uma referência a `0.12.9`). É o maior ponto único de falha da app: um CDN de
terceiros, sem SLA, para um ficheiro de dezenas de MB. Não foi auto-hospedado aqui porque os
ficheiros não puderam ser descarregados e verificados.

Para o fazer:

```bash
# 1. Descarregar para uma pasta que o Netlify publique
mkdir -p netlify/ffmpeg
curl -L -o netlify/ffmpeg/ffmpeg-core.js   https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.js
curl -L -o netlify/ffmpeg/ffmpeg-core.wasm https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.wasm

# 2. Servir a pasta (adicionar ao netlify.toml, ao lado dos redirects)
#    [[headers]] para /ffmpeg/*  →  Cache-Control: public, max-age=31536000, immutable
#    [[redirects]] de /ffmpeg/*  →  /.netlify/ffmpeg/:splat  200
```

Depois aponta o bundle para `/ffmpeg/` em vez do unpkg — **como patch**, nunca à mão:

```
tools/patches/19-ffmpeg-local.find      https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm
tools/patches/19-ffmpeg-local.replace  /ffmpeg
```

(Convém resolver primeiro a duplicação `0.12.10`/`0.12.9` — duas versões do core no mesmo bundle
é, por si só, um bug.)

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
npm run nuvem:test     # 92 testes ponta-a-ponta da camada de nuvem (arranca os mocks sozinho)
npm run patch:full     # repõe o bundle do HEAD e reaplica os 17 patches + verificação
npm run patch:extrair   # só quando o bundle ORIGINAL muda: regenera os alvos .find
```

- **[NUVEM-DURAVEL.md](NUVEM-DURAVEL.md)** — diagnóstico completo, setup do Drive e do R2,
  limites reais de cada um, recuperação dos Reels perdidos e tabela de diagnóstico.
- `apps-script/cineclip-cloud-drive.js` — backend Google Drive (Web App): upload em blocos,
  cofre encriptado, `videohead`, `health`, `stats` e o helper `setup()`.
- `cloudflare/r2-worker.js` + `cloudflare/wrangler.toml` — backend R2 (upload, link público
  com Range/206 para a Meta, cofre, presign SigV4, stats).
- `nuvem-duravel.js` — camada no browser (`window.CineCloud`), carregada antes do bundle.
- `netlify/functions/nvidia.mjs` — proxy da NVIDIA (CORS), implantado pelo Netlify automaticamente.
- `tools/` — patch reproduzível do bundle, mocks locais, servidor de preview e testes.

> **Ao mexer no bundle:** nunca edites o `index.html` à mão — o `npm run patch:full` repõe o
> ficheiro base e só reaplica o que está em `tools/patches/`. Uma alteração manual perde-se no
> próximo build. Para uma mudança nova, acrescenta `NN-nome.find` + `NN-nome.replace` e declara o
> alvo em `tools/extract-patch-targets.mjs`.
