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

Para o alterar, edita **só** `tools/agendador-ui/agendador.template.js` (código legível)
e `tools/agendador-ui/agendador.css`, e corre `npm run patch:agendador`.

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
npm test               # testes da nuvem + proxy NVIDIA
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
