# CineClip 🎬

Aplicação web **100% no navegador** que limpa metadados de vídeos, corta até 2:30, formata em **9:16** com texto de *hook* no topo, identifica o filme/série via **NVIDIA Vision + TMDB** e gera uma legenda pronta para publicar.

## Estrutura do Projeto

- `src/App.tsx` — Fluxo principal em 3 etapas (Upload e limpeza → Identificação do filme → Legenda gerada)
- `src/lib/ffmpeg.ts` — Processamento de vídeo no navegador com `@ffmpeg/ffmpeg` (WebAssembly): corte de tempo, remoção de faixas pretas (`crop`), fundo vertical 9:16 branco, sobreposição do texto de *hook* e limpeza total de metadados/capítulos/unidades SEI
- `src/lib/crop.ts` — Deteção automática de faixas pretas horizontais (letterbox) por amostragem de 8 frames via Canvas
- `src/lib/meta.ts` — Leitura e auditoria de metadados (Antes / Depois) com `mediainfo.js`
- `src/lib/apis.ts` — Integração com **NVIDIA NIM** (`meta/llama-3.2-11b-vision-instruct` e `nvidia/llama-3.1-nemotron-70b-instruct`) e **TMDB API**
- `src/components/VerticalPreview.tsx` — Pré-visualização 9:16 em tempo real
- `src/components/SettingsDialog.tsx` — Modal de configuração e teste de chaves NVIDIA / TMDB e texto do topo
- `src/components/MovieIdentification.tsx` — Cartão do filme identificado, grelha de alternativas e pesquisa manual no TMDB
- `vite.config.ts` & `api/public/nvidia.ts` — Proxy `/api/public/nvidia` para evitar bloqueios de CORS ao chamar a API da NVIDIA no navegador (funciona em `npm run dev`, `npm run preview` e deploy na Vercel)

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

> **Estado atual do repositório:** só o *build* está versionado (`index.html`,
> `app-pronto.html`, `404.html`) — a pasta `src/` e `api/` descritas acima **não** estão no
> repo. Para correr a aplicação como está, usa `npm run nuvem` (servidor estático + mock da
> API de nuvem em `/cloud-api`), que não precisa de `npm install`.

## ☁️ Nuvem durável (Cloudflare R2)

Os Reels agendados desapareciam da "nuvem" porque o `.mp4` era enviado para hosts gratuitos
**temporários** — `uguu.se` (3 h), `litterbox` (12 h no app, máx. 72 h), `kappa.lol`
(100 MiB, "may remove content at any time") e o cofre para o `bytebin.lucko.me` (serviço
anunciado como defunto) — enquanto o agendador marca publicações até **60 dias** à frente.
Somavam-se a isso uploads em background sem `await`, erros engolidos por `catch{}` e uma
sincronização que podia sobrescrever a fila com dados vazios.

Agora o armazenamento é o **teu bucket Cloudflare R2** (vídeos + cofre), com upload aguardado
antes de gravar o cofre, retry com backoff, progresso, erros visíveis, URL pré-assinada para
vídeos > 100 MB, migração automática dos cofres antigos e selos honestos na fila
(`☁️ R2 · PC + Celular` / `⚠️ link temporário` / `⚠️ só neste aparelho`).

```bash
npm run nuvem          # app + mock da nuvem em http://localhost:4173 (testar sem Cloudflare)
npm run nuvem:test     # 33 testes ponta-a-ponta da camada de nuvem
npm run patch:nuvem    # reaplica o patch ao bundle e valida a sintaxe
```

- **[NUVEM-DURAVEL.md](NUVEM-DURAVEL.md)** — diagnóstico completo, setup do R2 em 5 minutos,
  recuperação dos Reels perdidos e tabela de diagnóstico.
- `cloudflare/r2-worker.js` + `cloudflare/wrangler.toml` — o backend (upload, link público
  com Range/206 para a Meta, cofre, presign SigV4, stats).
- `nuvem-duravel.js` — camada no browser (`window.CineCloud`), carregada antes do bundle.
- `tools/` — patch reproduzível do bundle, mock local, servidor de preview e testes.
