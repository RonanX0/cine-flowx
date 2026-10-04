# 🔍 Relatório de erros — CineClip (branch `arena/01a107f3-cine-flowx`, base `main` @ `c7ecc00`)

**Data:** 2026-10-04 · **Erros 1 a 4 corrigidos nesta branch** (o erro 5 ficou como estava: não foi pedido).

| # | Gravidade | Erro | Onde | Estado |
|---|-----------|------|------|--------|
| 1 | 🔴 **Crítico** | A claim anti-duplicado do Worker R2 **ficava presa para sempre**: renovação do mesmo dono e takeover de claims expiradas falhavam sempre → o Reel nunca era publicado e aparecia a mensagem falsa *"Outro aparelho ou o Robô 24h está a publicar este Reel"* | `cloudflare/r2-worker.js:468` | ✅ **Corrigido** |
| 2 | 🟠 Alto (consequência do n.º 1) | Os testes **não apanhavam** o erro 1: o mock dizia ter "a mesma semântica do Worker real", mas não implementa a escrita condicional do R2. `npm test` dava 239 verdes com o Worker avariado | `tools/mock-r2-worker.mjs:89`, `tools/test-cinecloud.mjs:638` | ✅ **Corrigido** (testa o Worker real; `npm run worker:test`) |
| 3 | 🟡 Médio-baixo | `recriar-botao-migrar.sh` falhava a meio e **deixava o repositório com alterações parciais** (escrevia os patches 17/18 e as entradas do extractor antes de rebentar). Pior: as âncoras do payload já **não existem** no bundle atual (o layout novo do Agendador, patch 22, mudou o botão "Robô 24h") — o script é obsoleto. O PR #2 tem o mesmo problema | `recriar-botao-migrar.sh` | ✅ **Corrigido** (pré-voo + idempotente) |
| 4 | 🟢 Baixo | `tsconfig.json` apontava para `src/`, que não existe → `tsc` falhava com `TS18003`; sem script de type-check; 3 erros de tipos reais no `vite.config.ts` | `tsconfig.json:22`, `vite.config.ts` | ✅ **Corrigido** (`npm run typecheck` passa) |
| 5 | ⚪ Higiene | `.sudo_as_admin_successful` versionado; dependências que o build não usa | `.gitignore`, `package.json` | ⏸️ Não alterado (não pedido) |

---

## ✅ Correções aplicadas nesta branch

### 1. Worker R2 — escrita condicional certa para cada caso

`cloudflare/r2-worker.js` (versão **1.1.0 → 1.2.0**):

* `readClaimEntry()` passa a devolver também o **ETag** do objeto;
* a aquisição escolhe a pré-condição pelo estado da chave:
  * chave vazia → `onlyIf: { etagDoesNotMatch: "*" }` (**criar**);
  * chave com claim do mesmo dono ou claim morta → `onlyIf: { etagMatches: <etag lido> }` (**renovar/tomar**);
  * sem ETag (runtime antigo) → `put` simples + releitura (comportamento anterior, honesto);
* um objeto ilegível a ocupar a chave deixa de a prender (é substituído);
* `GET /api/claims` **limpa** as claims caducas/ilegíveis (`cleaned`) em vez de as esconder — era o segundo sintoma: a fila presa e o diagnóstico a dizer que não havia nada;
* comentários do ficheiro corrigidos (prometiam renovação/takeover que o código não fazia).

Depois de aplicar no teu lado: **`npx wrangler deploy`** e confirmar
`curl -s <worker-url> | grep claims` → `"claims": true` e `"version": "1.2.0"`.
O site sozinho não atualiza o Worker.

### 2. Testes do Worker real

* **`tools/test-r2-worker.mjs`** (novo, **40 verificações**): corre `cloudflare/r2-worker.js` — o ficheiro que vai para a Cloudflare — contra um bucket R2 falso que implementa a semântica verdadeira do `onlyIf`/ETag. Cobre criação, renovação do mesmo dono, recusa de outro dono, takeover de claim expirada e de objeto ilegível, corrida entre dois donos, escrita concorrente a atropelar a renovação, release (incluindo dono errado), TTL mínimo/máximo, validações 400/401, limpeza no diagnóstico e runtimes sem escrita condicional.
* **`package.json`**: novo script `worker:test`, incluído no `npm test`.
* **`tools/mock-r2-worker.mjs`**: o comentário "mesma semântica do Worker real" passou a explicar que é uma **aproximação** e que renovação/takeover/corridas são testados no Worker real.

### 3. `recriar-botao-migrar.sh` seguro e idempotente

* **Pré-voo (passo 0)**: os payloads vão para uma pasta temporária e um pré-voo confirma **todas** as âncoras antes de escrever seja o que for. Clone fora do estado esperado → aborta com a lista do que falta e **sem tocar no repositório**.
* **Idempotente**: cada passo salta o que já está aplicado; correr duas vezes não muda nada (pasta temporária + `trap` de limpeza; comparação de conteúdo dos patches em vez de sobrepor).
* O pré-voo detetou (e documenta no cabeçalho) que este script é **obsoleto em `main`**: a âncora do patch 18 desapareceu com o layout novo do Agendador. Se quiseres o botão "Enviar todos p/ nuvem" de volta, é preciso refazer as âncoras contra o bundle atual — o PR #2 **também não se aplica** (a âncora do `18-migrar-button.find` dele tem **0 ocorrências** no `index.html` atual). Se preferires, apago o ficheiro.

### 4. Type-check a funcionar

* `tsconfig.json`: `include: ["vite.config.ts"]` (não há `src/`), `esModuleInterop: true`.
* `vite.config.ts`: `Buffer` → `new Uint8Array(...)` nos 3 pontos (2× `Blob`, 1× corpo do `fetch`).
* `package.json`: novo script `typecheck` → `npx tsc --noEmit` passa com **0 erros**.

---

## 🔎 Diagnóstico detalhado (como os erros 1 e 2 se manifestavam)

### O defeito no Worker

```js
// cloudflare/r2-worker.js:465-470 (antes da correção)
const written = await env.BUCKET.put(objectName, body, {
  ...meta,
  onlyIf: { etagDoesNotMatch: "*" },   // ← só grava se a chave estiver VAZIA
});
```

`etagDoesNotMatch: "*"` é a pré-condição de **criar**. Depois da primeira aquisição a
chave da claim passa a existir, por isso:

* a **renovação** (feita pelo app antes de cada tentativa de publicação) falhava sempre →
  `{ok:true, acquired:false, holder:null}` → o app abortava com
  *"Outro aparelho ou o Robô 24h está a publicar este Reel agora (proteção anti-duplicado)"*
  (a apontar para um culpado inexistente);
* um **takeover** de claim expirada nunca acontecia → o Reel ficava preso para sempre,
  em qualquer aparelho e no Robô 24h (que faz `if (claim && claim.ocupado) continue`);
* `GET /api/claims` mostrava `active: []` (a claim morta não era listada nem limpa), por
  isso o diagnóstico dizia que estava tudo bem enquanto a fila estava bloqueada.

A documentação prometia o contrário: `NUVEM-DURAVEL.md:379-380` — *"o mesmo dono pode
renovar a claim (um retry não se auto-bloqueia); claims expiradas podem ser tomadas por
outro dispositivo."*

**Reprodução** (contra o Worker real, sem dependências nem contas):

```bash
node tools/repro-claim-wedge.mjs     # antes: 4/5 cenários falhados, exit 1 · depois: ✅ 5/5
```

### Porque é que 239 testes estavam verdes

`tools/mock-r2-worker.mjs` fazia `readClaim` + `writeFileSync` (um `upsert` simples, atómico
em Node), sem `onlyIf`/ETag. Os testes que deviam apanhar isto corriam **contra o mock**:
`tools/test-cinecloud.mjs:638` ("o mesmo dono renova a claim") e o de takeover de claim
expirada. É a mesma classe de falha já documentada no README para o `hS is not defined`
(o teste injetava um helper falso e escondia o erro do browser). Agora o `npm test` inclui
os 40 testes do Worker real.

---

## 🧪 Validação depois das correções

| Verificação | Resultado |
|---|---|
| `npm test` (nuvem 111 + **worker 40** + NVIDIA 9 + IG 53 + build 66) | ✅ **279/279** |
| `npm run worker:test` (Worker real contra bucket R2 falso) | ✅ 40/40 |
| `node tools/repro-claim-wedge.mjs` (os 5 cenários do defeito) | ✅ 5/5, exit 0 |
| `npm run patch:nuvem` (sintaxe do bundle, patch 24, Robô 24h) | ✅ tudo verificado |
| `npm run build` (dist/, carimbo `CINECLIP_BUILD`, cache-busting) | ✅ 6 ficheiros, `ig2207077: true` |
| `npm run typecheck` (`tsc --noEmit`) | ✅ 0 erros |
| `bash recriar-botao-migrar.sh` numa cópia “já feita” | ✅ "nada a fazer", exit 0, sem alterações |
| `bash recriar-botao-migrar.sh` com âncora partida | ✅ aborta, exit 1, **sem escrever nada** (verificado com `git status`) |
| Arranque do bundle num DOM real (jsdom) | ✅ sem erros de runtime |
| Sintaxe de todos os ficheiros versionados | ✅ (exceto `tools/agendador-ui/agendador.template.js`, que é um excerto por desenho) |

Limitações: o smoke test cobre o boot e o ecrã de entrada; os fluxos com rede (login na
nuvem, upload, publicação) não foram exercidos num browser real, e o ambiente não tem
Internet para validar os CDNs externos (`unpkg`, NVIDIA, Meta).

---

## Próximos passos

1. **Worker**: `npx wrangler deploy` (obrigatório — sem isto o backend continua com a cunha).
2. **PR #10** (`🔒 Claims do R2...`) fica sobreposto: o essencial dele está agora nesta
   branch (Worker + testes do Worker real). O merge há de dar conflito em
   `cloudflare/r2-worker.js`/`nuvem-duravel.js` — decide qual fica (sugestão: esta, e fechar
   o #10). Se quiseres também a mensagem com *quem* tem a claim e *até quando*, isso vem
   do lado do cliente (bundle) e posso trazer do #10.
3. **PR #2** (`Recria botão de migração`) e o `recriar-botao-migrar.sh`: ambos apontam para
   um bundle que já não existe (o layout novo do Agendador mudou o troço do botão). O
   pré-voo agora diz isso em vez de rebentar a meio. Decidir: refazer as âncoras ou apagar
   o script.
4. **Erro 5** (higiene) ficou como estava — diz se queres que trate.
