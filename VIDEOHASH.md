# Videohash no CineClip — cache de identificação por hash perceptual

## O que é o `videohash`

[`videohash`](https://github.com/akamhy/videohash) é uma biblioteca Python de
**detecção de vídeos near-duplicate** (perceptual video hashing). Gera um hash de
64 bits a partir do conteúdo do vídeo; vídeos idênticos ou quase idênticos
(re-encode, resize, watermark, barras pretas adicionadas/removidas) dão o mesmo
hash ou um hash muito próximo.

> ⚠️ **O `videohash` NÃO identifica filmes.** Ele detecta duplicados. A
> identificação do filme continua a ser feita pela IA (NVIDIA Vision / Gemini) +
> TMDB. Usar o videohash como "identificador do filme" não funciona.

## Como foi aplicado neste projeto

O problema real era: o mesmo clipe (ou um near-duplicate) reaparecia no upload
em massa e a IA era chamada de novo, dando resultados inconsistentes e gastando
tempo/créditos. Agora o fluxo do upload em massa (`lote-massa.js`) calcula um
**hash perceptual** dos frames já extraídos pelo `core.quadros()` e usa-o como
chave de cache (localStorage, TTL 30 dias, máx. 200 entradas):

- Antes de chamar a IA, calcula `hashPerceptualVideo(quadros)`.
- Se o hash já está em cache, reutiliza o `{ia, filme}` anterior (sem chamar a
  IA nem o TMDB).
- Caso contrário, identifica normalmente e guarda o resultado em cache.

A implementação é inspirada no `videohash` (frames → grelha 8×8 → bits por
luminância), mas em JavaScript puro, sem dependências, para correr 100% no
navegador. Só cacheia quando há frames reais (≥ 2), para não colidir em testes
ou em placeholders.

### Funções adicionadas em `lote-massa.js`

- `hashPerceptualVideo(quadros)` → `string | null`
- `cacheIdentLer(hash)` / `cacheIdentGuardar(hash, valor)`

## Como aplicar noutras partes

### Estúdio (bundle `index.html`)

O Estúdio também chama `core.identificar`. Para aplicar o mesmo cache aí, seria
preciso injetar o mesmo código no bundle (via patch) ou portar para a versão
TypeScript/Vite do PR #19. A chave de cache é partilhada (`cineclip.ident.cache.v1`
no localStorage), por isso o cache preenchido no upload em massa já beneficia o
Estúdio se o mesmo código for adicionado.

### Versão TypeScript/Vite (PR #19, `src/`)

Portar `hashPerceptualVideo` para `src/lib/` (ex.: `src/lib/videohash.ts`) e
usá-lo em `src/lib/ai.ts` como chave de cache. É o local mais natural para a
implementação definitiva.

### Backend Python (opcional)

Se quiseres usar o `videohash` real (Python) para deduplicação pesada, instala
`pip install videohash` num serviço backend e expõe um endpoint que recebe o
vídeo e devolve o hash. O frontend pode então chamar esse endpoint em vez de
calcular o hash no browser. Requer FFmpeg no servidor.

## Limitações

- O hash perceptual é aproximado (8×8 por frame); não é o wavelet hash do
  `videohash` original. Vídeos muito diferentes podem colidir; vídeos com cenas
  totalmente distintas não.
- O cache é local ao browser (localStorage). Não é partilhado entre aparelhos.
- Não substitui a identificação por IA; apenas evita chamadas repetidas.

## Melhorias de identificação implementadas (além do cache)

No upload em massa (`lote-massa.js`), o identificador agora usa mais sinais:

1. **Metadados completos** — em vez de só o campo "Título", concatena todos os
   campos lidos (artista, comentário, descrição, etc.) e passa-os à IA.
2. **OCR dos frames** — tenta ler texto embutido nos frames (legendas hardcoded,
   nomes) via Tesseract.js (CDN), com timeout de 4 s e desativação em ambientes
   sem rede (testes). O texto extraído é incluído na dica.
3. **Nome do ficheiro** — incluído na dica (downloads do TikTok/Kwai às vezes
   trazem o título).
4. **Dica do utilizador** — mantida e enriquecida com os sinais acima.

Ainda por fazer (requer mudanças no motor de identificação, bundle/src):
- Transcrição de áudio local (Whisper) em vez de depender do Gemini.
- Matching no TMDB por âncoras (atores/objetos/locais) em vez de só pelo título.
- Consenso reforçado entre NVIDIA e Gemini.
- Threshold mais alto para "não sei" (pedir dica ao utilizador).
