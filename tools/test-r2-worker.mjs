#!/usr/bin/env node
/**
 * Testes do Worker REAL (cloudflare/r2-worker.js) sem Cloudflare, sem internet e
 * sem `wrangler dev`: o handler `fetch` é chamado diretamente, com um bucket R2
 * falso que implementa a semântica das escritas condicionais (`onlyIf`).
 *
 * Porquê: os testes de nuvem usam tools/mock-r2-worker.mjs, que é atómico e por
 * isso perdoava o bug que aqui se apanha — o Worker real usava sempre
 * `onlyIf: { etagDoesNotMatch: "*" }`, portanto a RENOVAÇÃO da claim pelo mesmo
 * dono e o TAKEOVER de uma claim expirada falhavam para sempre. O app recebia
 * `acquired:false` e abortava a publicação com
 *
 *   "Erro em <conta>: Outro aparelho ou o Robô 24h está a publicar este Reel
 *    agora (proteção anti-duplicado). Tenta novamente dentro de alguns minutos."
 *
 * mesmo sendo o próprio aparelho o dono da claim (e o aviso "tenta novamente
 * dentro de alguns minutos" nunca se cumpria).
 *
 *   node tools/test-r2-worker.mjs
 */
import worker from "../cloudflare/r2-worker.js";

const TOKEN = "cc_token_de_teste";
let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`   ✔ ${name}`);
  } else {
    fail++;
    failures.push(name + (detail ? ` → ${detail}` : ""));
    console.log(`   ❌ ${name}${detail ? ` → ${detail}` : ""}`);
  }
}

/* ------------------------------------------------- bucket R2 falso ---- */

/**
 * Bucket em memória com a mesma semântica do R2:
 *   • `put` devolve `null` quando a pré-condição `onlyIf` falha;
 *   • `etagDoesNotMatch: "*"` → só grava se o objeto NÃO existir;
 *   • `etagMatches` → só grava se o objeto existir com aquele ETag.
 * `broken` permite simular runtimes antigos: "throws" (rejeita `onlyIf`) e
 * "ignores" (aceita tudo, como se não houvesse condições).
 */
function createBucket({ broken } = {}) {
  const store = new Map();
  let seq = 0;
  const objectOf = (name) => {
    const entry = store.get(name);
    if (!entry) return null;
    return {
      key: name,
      etag: entry.etag,
      size: entry.body.length,
      customMetadata: entry.customMetadata,
      httpMetadata: entry.httpMetadata,
      async text() { return entry.body; },
      async json() { return JSON.parse(entry.body); },
      async arrayBuffer() { return new TextEncoder().encode(entry.body).buffer; },
      body: entry.body,
    };
  };
  return {
    /** acesso direto para o teste semear/inspecionar objetos */
    store,
    async get(name) { return objectOf(name); },
    async head(name) { const o = objectOf(name); return o ? { key: name, etag: o.etag, size: o.size } : null; },
    async delete(name) { store.delete(name); },
    async put(name, body, opts = {}) {
      const text = typeof body === "string" ? body : String(body);
      const onlyIf = opts.onlyIf || null;
      if (onlyIf) {
        if (broken === "throws") throw new Error("onlyIf não suportado neste runtime (teste)");
        if (broken !== "ignores") {
          const current = store.get(name) || null;
          if (onlyIf.etagDoesNotMatch === "*" && current) return null;
          if (onlyIf.etagMatches !== undefined && (!current || current.etag !== onlyIf.etagMatches)) return null;
        }
      }
      const entry = {
        body: text,
        etag: "e" + (++seq).toString(16),
        uploaded: new Date(),
        httpMetadata: opts.httpMetadata,
        customMetadata: opts.customMetadata,
      };
      store.set(name, entry);
      return { key: name, etag: entry.etag, size: text.length };
    },
    async list({ prefix = "", cursor, limit = 1000 } = {}) {
      const names = [...store.keys()].filter((n) => n.startsWith(prefix)).sort();
      const start = cursor ? names.indexOf(cursor) + 1 : 0;
      const slice = names.slice(start, start + limit);
      const next = names[start + limit];
      return {
        objects: slice.map((n) => ({ key: n, etag: store.get(n).etag, size: store.get(n).body.length })),
        truncated: !!next,
        cursor: next || undefined,
      };
    },
  };
}

function createEnv(opts) {
  return { BUCKET: createBucket(opts), CINECLIP_TOKEN: TOKEN };
}

const req = (path, { method = "GET", body, token = TOKEN, headers = {} } = {}) => {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h["Content-Type"] = "application/json";
  return new Request("https://cloud.exemplo" + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
};

async function call(env, path, opts) {
  const res = await worker.fetch(req(path, opts), env);
  let data = null;
  const text = await res.text();
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

const claimKey = (id) => `cc_hash_teste_${id}`;
const acquire = (env, owner, key = claimKey("1"), ttlMs) =>
  call(env, "/api/claims/acquire", { method: "POST", body: { key, owner, ttlMs } });
const release = (env, owner, key = claimKey("1")) =>
  call(env, "/api/claims/release", { method: "POST", body: { key, owner } });
const seedClaim = (env, key, claim) =>
  env.BUCKET.store.set(`claims/${key}.json`, {
    body: typeof claim === "string" ? claim : JSON.stringify(claim),
    etag: "semeada",
    uploaded: new Date(),
  });

/* ------------------------------------------------ 1. rotas básicas ---- */

console.log("\n1. Rotas básicas");
{
  const env = createEnv();
  const health = await call(env, "/", { token: null });
  check("health check público responde sem token", health.status === 200 && health.data.ok === true, JSON.stringify(health.data));
  check("health check anuncia as claims", health.data.claims === true);

  const noToken = await call(env, "/api/claims", { token: null });
  check("rotas /api/* exigem token (401)", noToken.status === 401, JSON.stringify(noToken.data));

  const unknown = await call(env, "/api/nao-existe");
  check("rota desconhecida → 404", unknown.status === 404, JSON.stringify(unknown.data));

  const bad = await call(env, "/api/claims/acquire", { method: "POST", body: { key: claimKey("x") } });
  check("claim sem owner → 400", bad.status === 400, JSON.stringify(bad.data));
}

/* ------------------------------------------ 2. aquisição e renovação ---- */

console.log("\n2. Aquisição e RENOVAÇÃO da claim (regressão do erro anti-duplicado)");
{
  const env = createEnv();
  const first = await acquire(env, "app:aparelhoA", claimKey("1"), 30 * 60 * 1000);
  check("1.º pedido adquire a claim", first.status === 200 && first.data.acquired === true, JSON.stringify(first.data));
  check("a claim fica gravada no bucket", !!env.BUCKET.store.get(`claims/${claimKey("1")}.json`));

  const ttl1 = Number(first.data.claim.expiresAt) - Date.now();
  check("o TTL pedido (30 min) é respeitado", ttl1 > 25 * 60 * 1000 && ttl1 <= 60 * 60 * 1000, String(ttl1));

  // É isto que o app faz antes de cada tentativa de publicação (renovarClaim).
  const renew = await acquire(env, "app:aparelhoA", claimKey("1"), 30 * 60 * 1000);
  check(
    "o MESMO dono renova a claim (era aqui que rebentava o erro 'Outro aparelho ou o Robô 24h…')",
    renew.status === 200 && renew.data.acquired === true,
    JSON.stringify(renew.data)
  );
  check("a renovação é assinalada", renew.data.renewed === true, JSON.stringify(renew.data));
  check("a renovação conta as vezes", Number(renew.data.claim?.renewals) >= 2, JSON.stringify(renew.data));
  check("a renovação não muda o dono", renew.data.claim?.owner === "app:aparelhoA", JSON.stringify(renew.data));

  const chain = await Promise.all([
    acquire(env, "app:aparelhoA", claimKey("1")),
    acquire(env, "app:aparelhoA", claimKey("1")),
    acquire(env, "app:aparelhoA", claimKey("1")),
  ]);
  check("renovações em série do mesmo dono nunca são recusadas", chain.every((r) => r.data.acquired === true), JSON.stringify(chain.map((r) => r.data.acquired)));
}

/* --------------------------------------- 3. outro dono é recusado ---- */

console.log("\n3. Outro aparelho/Robô é recusado (a proteção continua a funcionar)");
{
  const env = createEnv();
  const a = await acquire(env, "app:aparelhoA", claimKey("2"));
  const b = await acquire(env, "robo:abc123", claimKey("2"));
  check("o segundo dono não adquire a claim", b.data.acquired === false, JSON.stringify(b.data));
  check("a recusa diz quem é o dono atual", b.data.holder?.owner === "app:aparelhoA", JSON.stringify(b.data.holder));
  check("a recusa diz quando expira", !!b.data.holder?.expiresAt && Number(b.data.holder.expiresAt) > Date.now(), JSON.stringify(b.data.holder));
  check("a recusa sugere quando tentar de novo", Number(b.data.retryAfterMs) > 0, String(b.data.retryAfterMs));
  check("o dono original mantém a claim", a.data.claim?.owner === "app:aparelhoA", JSON.stringify(a.data));

  const status = await call(env, `/api/claims/${claimKey("2")}`);
  check("GET /api/claims/:key mostra a claim ativa", status.data.active === true && status.data.claim?.owner === "app:aparelhoA", JSON.stringify(status.data));
}

/* --------------------------------------------------- 4. libertação ---- */

console.log("\n4. Libertação");
{
  const env = createEnv();
  const a = await acquire(env, "app:aparelhoA", claimKey("3"));
  const wrong = await release(env, "robo:abc123", claimKey("3"));
  check("ninguém liberta a claim de outro dono", wrong.data.released === false && wrong.data.holder?.owner === "app:aparelhoA", JSON.stringify(wrong.data));
  check("a claim do dono continua viva", (await acquire(env, "robo:abc123", claimKey("3"))).data.acquired === false);

  const ok = await release(env, "app:aparelhoA", claimKey("3"));
  check("o dono liberta a claim", ok.data.released === true, JSON.stringify(ok.data));
  check("o objeto desaparece do bucket", !env.BUCKET.store.has(`claims/${claimKey("3")}.json`));

  const b = await acquire(env, "robo:abc123", claimKey("3"));
  check("libertada a claim, o outro dono publica", b.data.acquired === true, JSON.stringify(b.data));
  check("a claim nova é do dono novo", b.data.claim?.owner === "robo:abc123", JSON.stringify(b.data));
  check("o release registou a renovação", a.data.acquired === true);
}

/* ------------------------------- 5. claims mortas nunca prendem a chave ---- */

console.log("\n5. Claim expirada / ilegível nunca prende a chave");
{
  const env = createEnv();
  seedClaim(env, claimKey("4"), {
    key: claimKey("4"), owner: "robo:interrompido", provider: "cloudflare-r2",
    acquiredAt: Date.now() - 20 * 60 * 1000, expiresAt: Date.now() - 10 * 60 * 1000,
  });
  const takeover = await acquire(env, "app:aparelhoA", claimKey("4"));
  check("claim expirada é tomada pelo aparelho", takeover.data.acquired === true, JSON.stringify(takeover.data));
  check("o dono novo fica gravado", takeover.data.claim?.owner === "app:aparelhoA", JSON.stringify(takeover.data));
  check("não é tratada como renovação", takeover.data.renewed === false, JSON.stringify(takeover.data));

  seedClaim(env, claimKey("5"), "{isto não é JSON válido");
  const corrupt = await acquire(env, "app:aparelhoA", claimKey("5"));
  check("objeto ilegível a ocupar a chave não bloqueia", corrupt.data.acquired === true, JSON.stringify(corrupt.data));

  seedClaim(env, claimKey("6"), { key: claimKey("6"), owner: "robo:x", expiresAt: Date.now() - 1000 });
  const again = await acquire(env, "robo:outro", claimKey("6"));
  check("takeover por outro dono também funciona", again.data.acquired === true, JSON.stringify(again.data));
}

/* --------------------------- 6. runtimes sem escritas condicionais ---- */

console.log("\n6. Runtimes sem suporte a `onlyIf` (ou que o ignoram)");
{
  const ancient = createEnv({ broken: "throws" });
  const a = await acquire(ancient, "app:aparelhoA", claimKey("7"));
  check("runtime antigo (só put simples): a 1.ª aquisição funciona", a.data.acquired === true, JSON.stringify(a.data));
  const renew = await acquire(ancient, "app:aparelhoA", claimKey("7"));
  check("runtime antigo: a renovação do mesmo dono funciona", renew.data.acquired === true, JSON.stringify(renew.data));
  const other = await acquire(ancient, "robo:abc", claimKey("7"));
  check("runtime antigo: outro dono continua recusado", other.data.acquired === false, JSON.stringify(other.data));

  const loose = createEnv({ broken: "ignores" });
  const l1 = await acquire(loose, "app:aparelhoA", claimKey("8"));
  const l2 = await acquire(loose, "app:aparelhoA", claimKey("8"));
  check("runtime que ignora condições: aquisição e renovação funcionam", l1.data.acquired === true && l2.data.acquired === true, JSON.stringify([l1.data.acquired, l2.data.acquired]));
}

/* ------------------------------------------- 7. corrida simultânea ---- */

console.log("\n7. Dois pedidos ao mesmo tempo");
{
  const env = createEnv();
  const [a, b] = await Promise.all([
    acquire(env, "app:aparelhoA", claimKey("9")),
    acquire(env, "robo:abc", claimKey("9")),
  ]);
  const winners = [a, b].filter((r) => r.data.acquired === true);
  check("exatamente um pedido ganha a claim", winners.length === 1, JSON.stringify([a.data, b.data]));
  const stored = JSON.parse(env.BUCKET.store.get(`claims/${claimKey("9")}.json`).body);
  check("o bucket ficou com o dono que ganhou", stored.owner === winners[0].data.claim?.owner, stored.owner);
}

/* ------------------------------------------------- 8. diagnóstico ---- */

console.log("\n8. Listagem de diagnóstico (GET /api/claims)");
{
  const env = createEnv();
  await acquire(env, "app:aparelhoA", claimKey("10"));
  seedClaim(env, claimKey("11"), { key: claimKey("11"), owner: "robo:morto", expiresAt: Date.now() - 5000 });

  const list = await call(env, "/api/claims");
  check("só lista as claims vivas", list.data.count === 1 && list.data.active?.[0]?.owner === "app:aparelhoA", JSON.stringify(list.data));
  check("limpa a claim expirada do bucket", !env.BUCKET.store.has(`claims/${claimKey("11")}.json`));

  const expired = await call(env, `/api/claims/${claimKey("11")}`);
  check("estado de uma claim inexistente → active:false", expired.data.active === false, JSON.stringify(expired.data));
}

/* ----------------------------------------------- 9. cofre (smoke) ---- */

console.log("\n9. Cofre (smoke do mesmo backend)");
{
  const env = createEnv();
  const cipher = JSON.stringify({ v: 1, segredo: "cifrado" });
  const put = await call(env, "/api/vault/cc_hash_teste", { method: "PUT", body: cipher });
  check("PUT /api/vault grava o cofre", put.data.ok === true, JSON.stringify(put.data));
  const got = await call(env, "/api/vault/cc_hash_teste");
  check("GET /api/vault devolve o cofre", got.status === 200 && got.data.segredo === "cifrado", JSON.stringify(got.data));
  const missing = await call(env, "/api/vault/cc_nao_existe");
  check("cofre inexistente → 404", missing.status === 404, JSON.stringify(missing.data));
}

/* ------------------------------------------------------------------ */

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passaram, ${fail} falharam`);
if (failures.length) {
  console.log("\nFalhas:");
  failures.forEach((f) => console.log("  - " + f));
}
process.exit(fail === 0 ? 0 : 1);
