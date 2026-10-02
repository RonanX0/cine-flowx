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
