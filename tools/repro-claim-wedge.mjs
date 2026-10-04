#!/usr/bin/env node
/**
 * 🔎 DIAGNÓSTICO — cunha (wedge) da claim no Worker R2
 *
 * Corre o Worker REAL (`cloudflare/r2-worker.js`) contra um bucket R2 falso que
 * implementa a semântica verdadeira do R2 para escritas condicionais:
 *
 *   onlyIf: { etagDoesNotMatch: "*" }  → só grava se a chave estiver VAZIA
 *                                        (devolve null se já existir algo)
 *   onlyIf: { etagMatches: "<etag>" }  → só grava se o ETag for o esperado
 *
 * O Worker atual usa sempre `etagDoesNotMatch: "*"`. Consequência: assim que
 * existe um objeto na chave da claim (a claim que o próprio app acabou de
 * obter, ou uma claim expirada deixada por uma execução interrompida), a
 * renovação pelo MESMO dono e o takeover de uma claim MORTA falham sempre:
 * o Worker responde `acquired:false` sem dono, o app aborta com
 * "Outro aparelho ou o Robô 24h está a publicar este Reel agora" e aquele
 * Reel nunca mais é publicado — por nenhum aparelho nem pelo Robô 24h.
 *
 *   node tools/repro-claim-wedge.mjs
 *
 * Sai com código 1 enquanto o defeito existir (serve de teste de regressão
 * depois de corrigir o Worker).
 */
import worker from "../cloudflare/r2-worker.js";

/* ---------------------- bucket R2 falso (só o que o Worker usa) ---------------------- */
const objects = new Map(); // nome -> { body, etag }
let seq = 0;

const bucket = {
  async get(name) {
    const o = objects.get(name);
    if (!o) return null;
    return {
      etag: o.etag,
      size: o.body.length,
      body: o.body,
      httpMetadata: { contentType: "application/json" },
      text: async () => o.body,
    };
  },
  async put(name, body, opts = {}) {
    const existing = objects.get(name);
    const onlyIf = opts && opts.onlyIf;
    if (onlyIf) {
      if (onlyIf.etagDoesNotMatch === "*" && existing) return null; // chave ocupada
      if (onlyIf.etagMatches !== undefined && (!existing || existing.etag !== onlyIf.etagMatches)) return null;
      if (onlyIf.etagDoesNotMatch && onlyIf.etagDoesNotMatch !== "*" && existing && existing.etag === onlyIf.etagDoesNotMatch) return null;
    }
    const etag = `etag-${++seq}`;
    objects.set(name, { body: typeof body === "string" ? body : String(body), etag });
    return { etag };
  },
  async delete(name) { objects.delete(name); },
  async list({ prefix = "", cursor, limit = 1000 } = {}) {
    const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const slice = keys.slice(start, start + limit);
    const next = start + limit < keys.length ? String(start + limit) : undefined;
    return {
      objects: slice.map((key) => ({ key, etag: objects.get(key).etag })),
      truncated: !!next,
      cursor: next,
    };
  },
};

const env = { BUCKET: bucket, CINECLIP_TOKEN: "cc_token_de_teste" };
const post = (path, payload) =>
  worker
    .fetch(
      new Request("https://worker.example" + path, {
        method: "POST",
        headers: { Authorization: "Bearer cc_token_de_teste", "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
      env
    )
    .then(async (r) => ({ status: r.status, data: await r.json() }));

const claimName = (key) => `claims/${key}.json`;
const KEY = "cc_teste_reel_1";
const A = "app:aparelhoA";
const B = "app:aparelhoB";
let falhas = 0;
const ver = (titulo, esperado, obtido) => {
  const ok = obtido === esperado;
  if (!ok) falhas++;
  console.log(`${ok ? "✔" : "✘"} ${titulo}`);
  console.log(`    esperado: ${esperado} | obtido: ${obtido}`);
};

console.log("Cenário A — aparelho novo obtém a claim (chave vazia)");
const a1 = await post("/api/claims/acquire", { key: KEY, owner: A, ttlMs: 600000 });
ver("primeira aquisição", "acquired:true", `acquired:${a1.data.acquired}`);

console.log("\nCenário B — o MESMO aparelho repete a publicação e renova a claim");
console.log("   (é o que o app faz antes de cada uma das 3 tentativas; TTL 30 min)");
const a2 = await post("/api/claims/acquire", { key: KEY, owner: A, ttlMs: 600000 });
ver("renovação pelo mesmo dono", "acquired:true", `acquired:${a2.data.acquired}`);

console.log("\nCenário C — a claim expira (execução interrompida) e OUTRO aparelho tenta tomá-la");
const entry = objects.get(claimName(KEY));
objects.set(claimName(KEY), {
  ...entry,
  body: JSON.stringify({ key: KEY, owner: A, expiresAt: Date.now() - 60000, acquiredAt: Date.now() - 660000 }),
});
const c1 = await post("/api/claims/acquire", { key: KEY, owner: B, ttlMs: 600000 });
ver("takeover de claim expirada", "acquired:true", `acquired:${c1.data.acquired}`);

console.log("\nCenário D — a chave ficou com um objeto ilegível (JSON corrompido)");
objects.set(claimName("cc_ilegivel"), { body: "{lixo", etag: "etag-x" });
const d1 = await post("/api/claims/acquire", { key: "cc_ilegivel", owner: B, ttlMs: 600000 });
ver("takeover de objeto ilegível", "acquired:true", `acquired:${d1.data.acquired}`);

console.log("\nCenário E — diagnóstico: GET /api/claims limpa a claim morta?");
const MORTA = "cc_diag_morta";
objects.set(claimName(MORTA), { body: "{lixo", etag: "etag-morta" });
const lista = await worker
  .fetch(new Request("https://worker.example/api/claims", { headers: { Authorization: "Bearer cc_token_de_teste" } }), env)
  .then((r) => r.json());
ver("claim morta limpa pelo diagnóstico", true, Number(lista.cleaned) >= 1 && !objects.has(claimName(MORTA)));
console.log(`    (chaves ocupadas no bucket: ${[...objects.keys()].join(", ") || "—"})`);

console.log(`\n${falhas ? "❌" : "✅"} ${falhas} verificação(ões) falhada(s) de 5.`);
if (falhas) {
  console.log(
    "\nO Worker precisa de escrita condicional ao ETag: criar quando a chave está vazia\n" +
      "(etagDoesNotMatch:\"*\") e renovar/tomar quando já existe uma claim do mesmo dono\n" +
      "ou uma claim morta (etagMatches: <etag lido>); objetos ilegíveis devem ser substituídos\n" +
      "ou apagados, e GET /api/claims deve limpar as caducas."
  );
}
process.exit(falhas ? 1 : 0);
