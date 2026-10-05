#!/usr/bin/env node
/**
 * Testes do Worker REAL (cloudflare/r2-worker.js) contra um bucket R2 falso.
 *
 * Porque é que isto existe: o mock `tools/mock-r2-worker.mjs` guarda as claims
 * com um `writeFileSync` simples e NÃO tem a escrita condicional do R2
 * (`onlyIf`/ETag). Durante meses os testes correram só contra o mock e ficaram
 * verdes enquanto o Worker em produção respondia `acquired:false` a renovações
 * do próprio dono e a takeovers de claims expiradas — a claim ficava presa e o
 * Reel nunca mais era publicado ("Outro aparelho ou o Robô 24h está a publicar
 * este Reel"). Este ficheiro fecha essa porta: importa o Worker que vai para a
 * Cloudflare e corre-o contra um bucket falso que implementa a semântica
 * verdadeira do R2.
 *
 *   node tools/test-r2-worker.mjs      (ou: npm run worker:test)
 */
import worker from "../cloudflare/r2-worker.js";

const TOKEN = "cc_token_de_teste";

/* --------------------- bucket R2 falso (semântica verdadeira) --------------------- */

/**
 * O Worker grava o .mp4 com `put(key, request.body)` — um ReadableStream, não uma
 * string. Um bucket falso que só sabe ler strings faria o upload rebentar antes de
 * o teste chegar ao /v/:key, por isso o corpo é lido como no R2 real.
 */
async function readBucketBody(body) {
  if (body == null) return Buffer.alloc(0);
  if (typeof body === "string") return body;
  if (typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  return Buffer.from(body);
}

function createFakeBucket({ suportaOnlyIf = true, rangeSempre = false } = {}) {
  const objects = new Map(); // nome -> { body, etag }
  let seq = 0;
  const newEtag = () => `etag-${++seq}`;
  return {
    objects,
    puts: [],
    async get(name, opts = {}) {
      const o = objects.get(name);
      if (!o) return null;
      const buffer = Buffer.from(o.body);
      const size = buffer.byteLength;
      // O R2 real aceita `range: {offset, length}` e `{suffix}` e devolve só esse
      // bocado + um `range` a dizer o que foi entregue. O `get` do /v/:key depende
      // disso para responder 206 com Content-Range — sem isto o teste não vê nada.
      const r = opts && opts.range;
      if (r && (Number.isFinite(r.offset) || Number.isFinite(r.suffix))) {
        let start = 0;
        let len = size;
        if (Number.isFinite(r.suffix)) {
          len = Math.min(size, r.suffix);
          start = size - len;
        } else {
          start = Math.min(size, Math.max(0, r.offset));
          len = Number.isFinite(r.length) ? Math.min(r.length, size - start) : size - start;
        }
        return {
          etag: o.etag,
          size,
          range: { offset: start, length: len },
          body: buffer.subarray(start, start + len),
          httpMetadata: o.httpMetadata || { contentType: "application/json" },
          text: async () => buffer.subarray(start, start + len).toString("utf8"),
        };
      }
      return {
        etag: o.etag,
        size,
        // `rangeSempre`: alguns runtime (o Miniflare do `wrangler dev`, por
        // exemplo) devolvem um `range` mesmo num GET que não pediu Range. Um
        // handler que decida 200/206 por `object.range` em vez de por o pedido
        // responderia 206 a tudo — foi isso que o smoke de 2026-10 apanhou.
        range: rangeSempre ? { offset: 0 } : undefined,
        body: buffer,
        httpMetadata: o.httpMetadata || { contentType: "application/json" },
        text: async () => o.body,
      };
    },
    async put(name, body, opts = {}) {
      const existing = objects.get(name);
      const onlyIf = opts && opts.onlyIf;
      const raw = await readBucketBody(body);
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      this.puts.push({ name, text, onlyIf: onlyIf ? { ...onlyIf } : null });
      if (onlyIf && suportaOnlyIf) {
        // R2: `etagDoesNotMatch:"*"` = só grava se a chave estiver vazia.
        if (onlyIf.etagDoesNotMatch === "*" && existing) return null;
        // R2: `etagMatches` = só grava se o ETag do objeto for este.
        if (onlyIf.etagMatches !== undefined && (!existing || String(existing.etag) !== String(onlyIf.etagMatches))) return null;
        if (
          onlyIf.etagDoesNotMatch &&
          onlyIf.etagDoesNotMatch !== "*" &&
          existing &&
          String(existing.etag) === String(onlyIf.etagDoesNotMatch)
        ) {
          return null;
        }
      }
      const etag = newEtag();
      objects.set(name, { body: raw, etag, httpMetadata: opts && opts.httpMetadata });
      return { etag };
    },
    // O Worker usa head() para confirmar o tamanho gravado antes de devolver a URL.
    async head(name) {
      const o = objects.get(name);
      if (!o) return null;
      const buffer = Buffer.from(o.body);
      return { etag: o.etag, size: buffer.byteLength, httpMetadata: o.httpMetadata || {} };
    },
    async delete(name) { objects.delete(name); },
    async list({ prefix = "", cursor, limit = 1000 } = {}) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const slice = keys.slice(start, start + limit);
      const next = start + limit < keys.length ? String(start + limit) : undefined;
      return { objects: slice.map((key) => ({ key, etag: objects.get(key).etag })), truncated: !!next, cursor: next };
    },
  };
}

const call = (bucket, path, { method = "GET", body, token = TOKEN } = {}) =>
  worker
    .fetch(
      new Request("https://worker.example" + path, {
        method,
        headers: token
          ? { Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) }
          : body
            ? { "Content-Type": "application/json" }
            : {},
        body: body ? JSON.stringify(body) : undefined,
      }),
      { BUCKET: bucket, CINECLIP_TOKEN: TOKEN }
    )
    .then(async (r) => ({ status: r.status, data: await r.json() }));

/**
 * Pedido "cru": permite corpo binário e cabeçalhos arbitrários (Range, If-None-Match,
 * HEAD) ao Worker real. O `call` acima só sabe mandar JSON.
 */
const callRaw = (bucket, path, { method = "GET", body, headers = {}, token = null } = {}) =>
  worker.fetch(
    new Request("https://worker.example" + path, {
      method,
      headers: token ? { Authorization: "Bearer " + token, ...headers } : { ...headers },
      body: method === "GET" || method === "HEAD" ? undefined : body,
    }),
    { BUCKET: bucket, CINECLIP_TOKEN: TOKEN }
  );

/* ------------------------------------ runner ------------------------------------ */

let pass = 0;
let fail = 0;
const failures = [];
function check(name, condition, detalhe = "") {
  if (condition) {
    pass++;
    console.log(`✔ ${name}`);
  } else {
    fail++;
    failures.push(name + (detalhe ? " — " + detalhe : ""));
    console.log(`✘ ${name}${detalhe ? "  (" + detalhe + ")" : ""}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const claimOf = (bucket, key) => bucket.objects.get(`claims/${key}.json`);

const KEY = "cc_teste_reel";
const A = "app:aparelhoA";
const B = "app:aparelhoB";
const TTL = 10 * 60 * 1000;

console.log("1. Aquisição básica");
{
  const bucket = createFakeBucket();
  const r = await call(bucket, "/api/claims/acquire", { method: "POST", body: { key: KEY, owner: A, ttlMs: TTL } });
  check("chave vazia → acquired:true", r.data.ok === true && r.data.acquired === true, JSON.stringify(r.data));
  check("a claim fica gravada com o dono e o TTL", claimOf(bucket, KEY)?.body.includes(A) === true && Number(JSON.parse(claimOf(bucket, KEY).body).expiresAt) > Date.now());
  check("a 1ª escrita usa a pré-condição de CRIAR (etagDoesNotMatch:'*')", bucket.puts[0]?.onlyIf?.etagDoesNotMatch === "*");

  const r2 = await call(bucket, "/api/claims/acquire", { method: "POST", body: { key: KEY, owner: B, ttlMs: TTL } });
  check("outro dono com claim viva → acquired:false + holder", r2.data.acquired === false && r2.data.holder?.owner === A, JSON.stringify(r2.data));
  check("o outro dono recebe retryAfterMs", Number(r2.data.retryAfterMs) > 0);
}

console.log("\n2. Renovação pelo mesmo dono (o retry do app não se auto-bloqueia)");
{
  const bucket = createFakeBucket();
  await call(bucket, "/api/claims/acquire", { method: "POST", body: { key: KEY, owner: A, ttlMs: TTL } });
  const antes = JSON.parse(claimOf(bucket, KEY).body);
  await sleep(5);
  const r = await call(bucket, "/api/claims/acquire", { method: "POST", body: { key: KEY, owner: A, ttlMs: TTL } });
  const depois = JSON.parse(claimOf(bucket, KEY).body);
  check("mesmo dono renova → acquired:true", r.data.ok === true && r.data.acquired === true, JSON.stringify(r.data));
  check("o TTL é estendido (expiresAt maior)", Number(depois.expiresAt) > Number(antes.expiresAt));
  check("a renovação usa a pré-condição de renovar (etagMatches)", bucket.puts.at(-1)?.onlyIf?.etagMatches === antes.__etag || bucket.puts.at(-1)?.onlyIf?.etagMatches !== undefined);
  check("continua a haver uma só claim para a chave", [...bucket.objects.keys()].filter((k) => k.includes(KEY)).length === 1);
}

console.log("\n3. Takeover de claim morta");
{
  const bucket = createFakeBucket();
  await call(bucket, "/api/claims/acquire", { method: "POST", body: { key: KEY, owner: A, ttlMs: TTL } });
  const obj = bucket.objects.get(`claims/${KEY}.json`);
  bucket.objects.set(`claims/${KEY}.json`, {
    ...obj,
    body: JSON.stringify({ key: KEY, owner: A, expiresAt: Date.now() - 60000, acquiredAt: Date.now() - 660000 }),
  });
  const r = await call(bucket, "/api/claims/acquire", { method: "POST", body: { key: KEY, owner: B, ttlMs: TTL } });
  check("claim expirada é tomada por outro aparelho", r.data.ok === true && r.data.acquired === true, JSON.stringify(r.data));
  check("a chave passa a ter o novo dono", JSON.parse(claimOf(bucket, KEY).body).owner === B);
}
{
  const bucket = createFakeBucket();
  bucket.objects.set(`claims/${KEY}.json`, { body: "{isto não é json", etag: "etag-partido" });
  const r = await call(bucket, "/api/claims/acquire", { method: "POST", body: { key: KEY, owner: B, ttlMs: TTL } });
  check("objeto ilegível a ocupar a chave é substituído", r.data.ok === true && r.data.acquired === true, JSON.stringify(r.data));
  check("o objeto ilegível deu lugar a uma claim válida", JSON.parse(claimOf(bucket, KEY).body).owner === B);
}

console.log("\n4. Corrida entre dois donos (escrita condicional)");
{
  const bucket = createFakeBucket();
  // Duas aquisições no mesmo instante: só uma pode ficar com a claim.
  const [x, y] = await Promise.all([
    call(bucket, "/api/claims/acquire", { method: "POST", body: { key: KEY, owner: A, ttlMs: TTL } }),
    call(bucket, "/api/claims/acquire", { method: "POST", body: { key: KEY, owner: B, ttlMs: TTL } }),
  ]);
  const ganhou = [x, y].filter((r) => r.data.acquired === true);
  const perdeu = [x, y].filter((r) => r.data.acquired === false);
  check("exatamente um pedido fica com a claim", ganhou.length === 1, `ganharam ${ganhou.length}`);
  check("o que perdeu recebe o dono da claim", perdeu.length === 1 && perdeu[0].data.holder?.owner === (ganhou[0] === x ? A : B), JSON.stringify(perdeu.map((r) => r.data)));
  check("a claim gravada é a do vencedor", JSON.parse(claimOf(bucket, KEY).body).owner === (ganhou[0] === x ? A : B));
}
{
  // Writer concorrente: outro dono escreve na chave no meio da RENOVAÇÃO do A.
  // A escrita condicional do Worker (etagMatches do ETag lido) tem de falhar e,
  // na releitura seguinte, o A vê a claim viva do intruso e não publica.
  const bucket = createFakeBucket();
  await call(bucket, "/api/claims/acquire", { method: "POST", body: { key: KEY, owner: A, ttlMs: TTL } });
  const putOriginal = bucket.put.bind(bucket);
  let sabotou = false;
  bucket.put = async (name, body, opts) => {
    if (!sabotou && opts?.onlyIf?.etagMatches !== undefined) {
      sabotou = true;
      await putOriginal(name, JSON.stringify({ key: KEY, owner: "app:intruso", expiresAt: Date.now() + TTL }), {});
    }
    return putOriginal(name, body, opts);
  };
  const r = await call(bucket, "/api/claims/acquire", { method: "POST", body: { key: KEY, owner: A, ttlMs: TTL } });
  check("renovação atropelada por outro dono → acquired:false com o holder certo", r.data.ok === true && r.data.acquired === false && r.data.holder?.owner === "app:intruso", JSON.stringify(r.data));
  check("a claim gravada é a do intruso (a renovação não a atropelou)", JSON.parse(claimOf(bucket, KEY).body).owner === "app:intruso");
}

console.log("\n5. Release");
{
  const bucket = createFakeBucket();
  await call(bucket, "/api/claims/acquire", { method: "POST", body: { key: KEY, owner: A, ttlMs: TTL } });
  const errado = await call(bucket, "/api/claims/release", { method: "POST", body: { key: KEY, owner: B } });
  check("ninguém liberta a claim de outro dono", errado.data.released === false && errado.data.holder?.owner === A, JSON.stringify(errado.data));
  check("a claim continua na chave", claimOf(bucket, KEY) !== undefined);
  const certo = await call(bucket, "/api/claims/release", { method: "POST", body: { key: KEY, owner: A } });
  check("o dono liberta a claim", certo.data.released === true);
  check("a chave fica livre", claimOf(bucket, KEY) === undefined);
  const sem = await call(bucket, "/api/claims/release", { method: "POST", body: { key: KEY, owner: A } });
  check("libertar uma claim inexistente é inofensivo", sem.data.ok === true && sem.data.released === false);
}

console.log("\n6. Estado e diagnóstico");
{
  const bucket = createFakeBucket();
  await call(bucket, "/api/claims/acquire", { method: "POST", body: { key: KEY, owner: A, ttlMs: TTL } });
  const st = await call(bucket, `/api/claims/${KEY}`);
  check("GET /api/claims/<key> mostra a claim ativa", st.data.active === true || st.data.claim !== null, JSON.stringify(st.data));
  const lista = await call(bucket, "/api/claims");
  check("GET /api/claims lista a claim ativa", lista.data.active?.some((c) => c.owner === A) === true, JSON.stringify(lista.data));
  check("uma claim viva não é limpa", !lista.data.cleaned);

  // claim caduca + objeto ilegível: o diagnóstico tem de os limpar, senão a
  // chave fica presa e a lista diz que não há nada (era o 2º sintoma do bug).
  bucket.objects.set("claims/cc_morta.json", { body: JSON.stringify({ key: "cc_morta", owner: A, expiresAt: Date.now() - 1000 }), etag: "e1" });
  bucket.objects.set("claims/cc_lixo.json", { body: "{{{", etag: "e2" });
  const lista2 = await call(bucket, "/api/claims");
  check("o diagnóstico limpa as claims caducas/ilegíveis", Number(lista2.data.cleaned) >= 2, JSON.stringify(lista2.data));
  check("as chaves presas ficam livres", !bucket.objects.has("claims/cc_morta.json") && !bucket.objects.has("claims/cc_lixo.json"));
  check("o diagnóstico continua a mostrar a claim viva", lista2.data.active?.some((c) => c.owner === A) === true);
}

console.log("\n7. TTL e validações");
{
  const bucket = createFakeBucket();
  const curto = await call(bucket, "/api/claims/acquire", { method: "POST", body: { key: "cc_ttl_min", owner: A, ttlMs: 1 } });
  const ttlMin = JSON.parse(claimOf(bucket, "cc_ttl_min").body).expiresAt - Number(curto.data.claim.acquiredAt);
  check("TTL mínimo de 1 min é aplicado", ttlMin >= 60000 - 50 && ttlMin <= 60000 + 2000, String(ttlMin));

  const longo = await call(bucket, "/api/claims/acquire", { method: "POST", body: { key: "cc_ttl_max", owner: A, ttlMs: 48 * 3600 * 1000 } });
  const ttlMax = JSON.parse(claimOf(bucket, "cc_ttl_max").body).expiresAt - Number(longo.data.claim.acquiredAt);
  check("TTL máximo de 1 h é aplicado", ttlMax >= 3600000 - 50 && ttlMax <= 3600000 + 2000, String(ttlMax));
}
{
  const bucket = createFakeBucket();
  const semKey = await call(bucket, "/api/claims/acquire", { method: "POST", body: { owner: A } });
  check("claim sem 'key' → 400", semKey.status === 400 && /key/i.test(semKey.data.error || ""), JSON.stringify(semKey.data));
  const semOwner = await call(bucket, "/api/claims/acquire", { method: "POST", body: { key: KEY } });
  check("claim sem 'owner' → 400", semOwner.status === 400 && /owner/i.test(semOwner.data.error || ""), JSON.stringify(semOwner.data));
  const lixo = await worker
    .fetch(new Request("https://worker.example/api/claims/acquire", { method: "POST", headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" }, body: "{não é json" }), { BUCKET: bucket, CINECLIP_TOKEN: TOKEN })
    .then(async (r) => ({ status: r.status, data: await r.json() }));
  check("JSON inválido → 400", lixo.status === 400);
  const semToken = await call(bucket, "/api/claims", { token: "" });
  check("sem token → 401 (as claims exigem autenticação)", semToken.status === 401, String(semToken.status));
}

console.log("\n8. Runtimes sem escrita condicional (fallback honesto)");
{
  const bucket = createFakeBucket({ suportaOnlyIf: false });
  const r = await call(bucket, "/api/claims/acquire", { method: "POST", body: { key: KEY, owner: A, ttlMs: TTL } });
  check("cria a claim na mesma (put simples + releitura)", r.data.ok === true && r.data.acquired === true, JSON.stringify(r.data));

  // Com outro dono vivo, o fallback NÃO pode roubar a claim: a leitura antes do
  // put deteta a claim viva e responde acquired:false.
  const r2 = await call(bucket, "/api/claims/acquire", { method: "POST", body: { key: KEY, owner: B, ttlMs: TTL } });
  check("não rouba uma claim viva de outro dono", r2.data.acquired === false && r2.data.holder?.owner === A, JSON.stringify(r2.data));
  check("a claim gravada continua a ser a do dono A", JSON.parse(claimOf(bucket, KEY).body).owner === A);
}

console.log("\n9. Health check anuncia as claims");
{
  const bucket = createFakeBucket();
  const r = await call(bucket, "/", { token: "" });
  check("GET / é público e diz claims:true", r.status === 200 && r.data.claims === true, JSON.stringify(r.data));
  check("a versão do Worker é a nova (1.3.0)", r.data.version === "1.3.0", String(r.data.version));
}

console.log("\n10. O link público /v/:key devolve bytes (a regressão do 500)");
{
  // Porque é que esta secção existe: `corsHeaders()` devolve um objeto simples e o
  // handler do vídeo chamava `headers.set(...)` em cima dele. Resultado: TODO
  // `GET /v/:key` rebentava com 500 + HTML — exatamente o que o crawler da Meta
  // apanhava no lugar do .mp4 (o sabor do "Media upload has failed / 2207077"), e o
  // `HEAD`/`Range` de verificação do app também. Os 40 testes antigos nunca pediram
  // um vídeo, por isso nunca viram isto.
  const bucket = createFakeBucket();
  // bytes todos < 0x80, para sobreviver à volta em string que o cofre usa
  const MP4 = Buffer.concat([Buffer.from("000000206674797069736f6d", "hex"), Buffer.alloc(2040, 0x41)]);
  const SIZE = MP4.byteLength;

  const up = await callRaw(bucket, "/api/video", {
    method: "POST",
    token: TOKEN,
    headers: { "Content-Type": "video/mp4", "X-File-Name": "meu reel.mp4", "X-File-Size": String(SIZE) },
    body: MP4,
  });
  const upJson = await up.json();
  const keyPath = String(upJson.url || "").replace(/^https?:\/\/worker\.example/, "");
  check("upload direto → 200 com key e URL pública do Worker", up.status === 200 && /^\/v\//.test(keyPath), keyPath);

  const full = await callRaw(bucket, keyPath);
  const fullBuf = Buffer.from(await full.arrayBuffer());
  check("GET /v/:key → 200 (não 500, não 206)", full.status === 200, String(full.status));
  check("os bytes do vídeo chegam intactos", fullBuf.length === SIZE && fullBuf.equals(MP4), `${fullBuf.length}/${SIZE}`);
  check("Content-Type é o do vídeo", full.headers.get("content-type") === "video/mp4", String(full.headers.get("content-type")));
  check("Content-Length bate certo com o tamanho", full.headers.get("content-length") === String(SIZE), String(full.headers.get("content-length")));
  check("Accept-Ranges: bytes (a Meta pede Range)", full.headers.get("accept-ranges") === "bytes");
  check("CORS * no link público (o browser tem de o poder ler)", full.headers.get("access-control-allow-origin") === "*");
  check("o link público não pede token", full.headers.get("x-cineclip-durable") === "1");

  const firstBytes = await callRaw(bucket, keyPath, { headers: { Range: "bytes=0-1" } });
  const firstBuf = Buffer.from(await firstBytes.arrayBuffer());
  check("GET com Range → 206 Partial Content", firstBytes.status === 206, String(firstBytes.status));
  check("Content-Range a dizer o pedaço certo", firstBytes.headers.get("content-range") === `bytes 0-1/${SIZE}`, String(firstBytes.headers.get("content-range")));
  check("o app lê mesmo 2 bytes (a sonda antes de publicar)", firstBuf.length === 2 && firstBuf.equals(MP4.subarray(0, 2)), String(firstBuf.length));

  const mid = await callRaw(bucket, keyPath, { headers: { Range: `bytes=1000-1999` } });
  const midBuf = Buffer.from(await mid.arrayBuffer());
  check("Range no meio do ficheiro → 1000 bytes do sítio certo", mid.status === 206 && midBuf.length === 1000 && midBuf.equals(MP4.subarray(1000, 2000)), `${midBuf.length}`);

  const tail = await callRaw(bucket, keyPath, { headers: { Range: "bytes=-512" } });
  const tailBuf = Buffer.from(await tail.arrayBuffer());
  check("Range de sufixo (bytes=-512) devolve o fim do vídeo", tail.status === 206 && tailBuf.length === 512 && tailBuf.equals(MP4.subarray(SIZE - 512)), `${tailBuf.length}`);

  const head = await callRaw(bucket, keyPath, { method: "HEAD" });
  const headBuf = await head.arrayBuffer();
  check("HEAD → 200 com Content-Length e corpo vazio", head.status === 200 && head.headers.get("content-length") === String(SIZE) && headBuf.byteLength === 0, `${head.status}/${head.headers.get("content-length")}`);

  const headRange = await callRaw(bucket, keyPath, { method: "HEAD", headers: { Range: "bytes=0-1" } });
  check("HEAD com Range → 206 + Content-Range, sem corpo", headRange.status === 206 && headRange.headers.get("content-range") === `bytes 0-1/${SIZE}` && (await headRange.arrayBuffer()).byteLength === 0, String(headRange.status));

  const inm = await callRaw(bucket, keyPath, { headers: { "If-None-Match": String(full.headers.get("etag")) } });
  check("If-None-Match com o ETag → 304 sem corpo (o .mp4 é imutável)", inm.status === 304 && (await inm.arrayBuffer()).byteLength === 0, String(inm.status));
  const inmOutdated = await callRaw(bucket, keyPath, { headers: { "If-None-Match": '"outro-etag"' } });
  check("If-None-Match com ETag velho → 200 com o vídeo", inmOutdated.status === 200 && (await inmOutdated.arrayBuffer()).byteLength === SIZE, String(inmOutdated.status));

  const rangeMalformed = await callRaw(bucket, keyPath, { headers: { Range: "bytes=" } });
  check("Range destralhado → serve o vídeo todo (200), não rebenta", rangeMalformed.status === 200 && (await rangeMalformed.arrayBuffer()).byteLength === SIZE, String(rangeMalformed.status));

  // Runtime que mente com um `range` vazio: o 200/206 tem de se decidir pelo
  // PEDIDO, nunca pelo que o backend devolve.
  {
    const bucketMentiroso = createFakeBucket({ rangeSempre: true });
    const upM = await callRaw(bucketMentiroso, "/api/video", {
      method: "POST", token: TOKEN,
      headers: { "Content-Type": "video/mp4", "X-File-Size": String(SIZE) },
      body: MP4,
    });
    const pathM = String((await upM.json()).url || "").replace(/^https?:\/\/worker\.example/, "");
    const fullM = await callRaw(bucketMentiroso, pathM);
    const bufM = Buffer.from(await fullM.arrayBuffer());
    check("GET sem Range continua 200 mesmo se o backend vier com `range`", fullM.status === 200 && bufM.length === SIZE, `${fullM.status}/${bufM.length}`);
    const rangeM = await callRaw(bucketMentiroso, pathM, { headers: { Range: "bytes=0-1" } });
    check("e com Range vem 206 com Content-Range", rangeM.status === 206 && /^bytes 0-1\//.test(String(rangeM.headers.get("content-range"))), String(rangeM.status));
  }

  const semObjecto = await callRaw(bucket, "/v/videos/nao-existe.mp4");
  check("chave inexistente → 404 honesto", semObjecto.status === 404, String(semObjecto.status));
  const travessia = await callRaw(bucket, "/v/..%2F..%2Fetc%2Fpasswd");
  check("chave com ../ → 400 (não lê fora do prefixo)", travessia.status === 400, String(travessia.status));

  const contentType = await callRaw(bucket, keyPath);
  check("a cache é longa e imutável (o link não muda)", /max-age=31536000, immutable/.test(String(contentType.headers.get("cache-control"))), String(contentType.headers.get("cache-control")));
}

console.log("\n11. cloudflare/wrangler.toml compatível com o runtime de 2026");
{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const url = await import("node:url");
  const tomlPath = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..", "cloudflare", "wrangler.toml");
  const toml = fs.readFileSync(tomlPath, "utf8");
  // comentários fora; cada linha guarda o índice original para saber onde começam as tabelas
  const code = toml.split("\n").map((l) => (/^\s*#/.test(l) ? "" : l));
  const body = code.join("\n");
  const val = (key) => {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, "m").exec(body);
    return m ? m[1].replace(/^"|"$/g, "") : undefined;
  };
  const compatDate = val("compatibility_date");
  const flagsMatch = /compatibility_flags\s*=\s*\[([^\]]*)\]/.exec(body);
  const flags = flagsMatch ? flagsMatch[1].split(",").map((f) => f.trim().replace(/^"|"$/g, "")).filter(Boolean) : [];
  const NODEJS_COMPAT_DEFAULT_SINCE = "2026-08-04";

  check("compatibility_date definida (AAAAMM-DD)", /^\d{4}-\d{2}-\d{2}$/.test(String(compatDate)), String(compatDate));
  check("compatibility_date renovada (≥ " + NODEJS_COMPAT_DEFAULT_SINCE + ")", String(compatDate) >= NODEJS_COMPAT_DEFAULT_SINCE, String(compatDate));
  // nodejs_compat passou a ser o default em 2026-08-04 e o workerd dessa versão
  // chumbava o arranque quando a flag era dita à mão → `wrangler deploy`/`dev`
  // a falhar. Com data nova a flag tem de FÔRA da config; com data velha tem de lá estar.
  check(
    String(compatDate) >= NODEJS_COMPAT_DEFAULT_SINCE
      ? "sem nodejs_compat redundante (é o default desde " + NODEJS_COMPAT_DEFAULT_SINCE + ")"
      : "com nodejs_compat (necessária antes de " + NODEJS_COMPAT_DEFAULT_SINCE + ")",
    String(compatDate) >= NODEJS_COMPAT_DEFAULT_SINCE ? !flags.includes("nodejs_compat") : flags.includes("nodejs_compat"),
    flags.join(",") || "(sem flags)"
  );
  // O TOML lê `chave = valor` como parte da tabela onde cai: com workers_dev
  // depois de [[r2_buckets]] o wrangler avisava "Unexpected fields found in
  // r2_buckets[0]: workers_dev" e a chave era ignorada. As chaves do Worker têm
  // de estar antes da primeira tabela ([vars]/[[r2_buckets]]/[observability]).
  const idxWorkersDev = code.findIndex((l) => /^\s*workers_dev\s*=/.test(l));
  const idxFirstTable = code.findIndex((l) => /^\s*\[/.test(l));
  check("workers_dev antes da primeira tabela (senão o TOML engole-o)", idxWorkersDev !== -1 && idxFirstTable !== -1 && idxWorkersDev < idxFirstTable, `workers_dev@${idxWorkersDev} tabela@${idxFirstTable}`);
  check("workers_dev ligado (o link /v/:key tem de ser público)", /^\s*workers_dev\s*=\s*true\s*$/m.test(body));
  check("main aponta para o Worker que testamos aqui", val("main") === "r2-worker.js", String(val("main")));
  check("nome do Worker é cineclip-cloud", val("name") === "cineclip-cloud", String(val("name")));
  check("binding BUCKET → bucket R2 declarado", /\[\[r2_buckets\]\][\s\S]*?binding\s*=\s*"BUCKET"/.test(body));
  // segredos nunca no repositório: nem o token, nem as chaves S3 do presign
  check("segredos fora do wrangler.toml", !/^\s*(CINECLIP_TOKEN|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY)\s*=/m.test(body));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passaram, ${fail} falharam`);
if (failures.length) {
  console.log("\nFalhas:");
  failures.forEach((f) => console.log("  - " + f));
}
process.exit(fail === 0 ? 0 : 1);
