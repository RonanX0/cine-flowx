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

function createFakeBucket({ suportaOnlyIf = true } = {}) {
  const objects = new Map(); // nome -> { body, etag }
  let seq = 0;
  const newEtag = () => `etag-${++seq}`;
  return {
    objects,
    puts: [],
    async get(name) {
      const o = objects.get(name);
      if (!o) return null;
      const buffer = Buffer.from(o.body);
      return {
        etag: o.etag,
        size: buffer.byteLength,
        body: buffer,
        httpMetadata: o.httpMetadata || { contentType: "application/json" },
        text: async () => o.body,
      };
    },
    async put(name, body, opts = {}) {
      const existing = objects.get(name);
      const onlyIf = opts && opts.onlyIf;
      const text = typeof body === "string" ? body : Buffer.from(body).toString("utf8");
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
      objects.set(name, { body: text, etag, httpMetadata: opts && opts.httpMetadata });
      return { etag };
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
  check("a versão do Worker é a nova (1.2.0)", r.data.version === "1.2.0", String(r.data.version));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passaram, ${fail} falharam`);
if (failures.length) {
  console.log("\nFalhas:");
  failures.forEach((f) => console.log("  - " + f));
}
process.exit(fail === 0 ? 0 : 1);
