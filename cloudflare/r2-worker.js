/**
 * ☁️ CINECLIP CLOUD — Cloudflare Worker + R2
 * ---------------------------------------------------------------------------
 * Backend durável para os vídeos agendados e para o "cofre" (fila/chaves/contas).
 *
 * Substitui os hosts temporários que faziam os vídeos desaparecer:
 *   - bytebin.lucko.me  (serviço anunciado como defunto, conteúdo expira)
 *   - kappa.lol         (100 MiB, "we may remove content at any time")
 *   - uguu.se           (apaga em 3 h)
 *   - litterbox         (máx. 72 h, o app usava 12 h)
 *
 * Rotas
 *   GET    /                     → health check público
 *   POST   /api/video            → guarda o .mp4 (streaming p/ R2) e devolve link público
 *   POST   /api/video/presign    → URL pré-assinada S3 (para vídeos > 100 MB)
 *   GET    /v/:key               → link PÚBLICO do vídeo (Range/206, sem token) — é este
 *                                  URL que o Instagram/Meta vai descarregar
 *   PUT    /api/vault/:name      → grava o cofre encriptado (JSON)
 *   GET    /api/vault/:name      → lê o cofre encriptado
 *   DELETE /api/vault/:name      → apaga o cofre
 *   GET    /api/stats            → quantos vídeos/cofres e bytes usados
 *
 *   POST   /api/claims/acquire   → 🔒 reclamar um item da fila antes de publicar
 *   POST   /api/claims/release   → libertar a reclamação depois de publicar
 *   GET    /api/claims           → reclamações ativas (diagnóstico)
 *   GET    /api/claims/:key      → estado da reclamação de um item
 *
 * As "claims" (reclamações) impedem que o mesmo Reel seja publicado duas vezes
 * quando o app e o Robô 24h correm ao mesmo tempo, ou quando há dois aparelhos
 * com a mesma fila. Têm TTL (10 min por omissão) e expiram sozinhas: uma claim
 * nunca bloqueia uma publicação para sempre — o mesmo dono renova-a e uma claim
 * caduca pode ser tomada por outro (coberto por `npm run worker:test`).
 *
 * Segredos / variáveis (wrangler):
 *   BUCKET              → binding R2 (obrigatório)
 *   CINECLIP_TOKEN      → secret: token Bearer exigido em /api/* (obrigatório)
 *   PUBLIC_BASE         → var opcional: domínio público dos vídeos
 *                         (default: a própria URL do Worker)
 *   R2_ACCOUNT_ID       → var opcional: só para /api/video/presign
 *   R2_ACCESS_KEY_ID    → secret opcional: só para /api/video/presign
 *   R2_SECRET_ACCESS_KEY→ secret opcional: só para /api/video/presign
 *   R2_BUCKET_NAME      → var opcional: só para /api/video/presign
 *
 * Deploy:
 *   npx wrangler deploy
 *   npx wrangler secret put CINECLIP_TOKEN
 */

const VERSION = "1.2.0";
const MAX_DIRECT_UPLOAD = 100 * 1024 * 1024; // limite de corpo do Worker (plano free)
const VAULT_PREFIX = "vaults/";
const VIDEO_PREFIX = "videos/";
const CLAIM_PREFIX = "claims/";
const CLAIM_TTL_DEFAULT_MS = 10 * 60 * 1000; // 10 min
const CLAIM_TTL_MIN_MS = 60 * 1000; // 1 min
const CLAIM_TTL_MAX_MS = 60 * 60 * 1000; // 1 h

/* ------------------------------------------------------------------ utils */

const corsHeaders = (extra = {}) => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization,Content-Type,X-File-Name,X-File-Size,X-Cineclip-Client",
  "Access-Control-Expose-Headers": "Content-Length,Content-Range,X-Cineclip-Key",
  "Access-Control-Max-Age": "86400",
  ...extra,
});

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders({ "Content-Type": "application/json; charset=utf-8", ...extra }),
  });

const fail = (message, status = 400, extra = {}) =>
  json({ ok: false, error: message, ...extra }, status);

function safeName(name) {
  return String(name || "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
}

function randomId(len = 20) {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/** Comparação de tokens sem timing attack. */
function tokenMatches(provided, expected) {
  if (!expected) return false;
  const a = new TextEncoder().encode(String(provided || ""));
  const b = new TextEncoder().encode(String(expected));
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function bearer(request) {
  const h = request.headers.get("authorization") || "";
  if (/^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, "").trim();
  return h.trim();
}

function publicBase(env, url) {
  const configured = String(env.PUBLIC_BASE || "").trim().replace(/\/+$/, "");
  return configured || `${url.protocol}//${url.hostname}`;
}

/* ------------------------------------------------- SigV4 (presigned URLs) */

async function hmac(key, data) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, data));
}

async function sha256Hex(data) {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const toHex = (bytes) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Gera uma URL pré-assinada (S3 SigV4, PUT) para o endpoint S3 do R2.
 * Permite enviar vídeos maiores que o limite de corpo do Worker,
 * sem expor credenciais ao navegador.
 */
async function presignPut({ accountId, accessKeyId, secretAccessKey, bucket, key, expires }) {
  const region = "auto";
  const service = "s3";
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const credential = `${accessKeyId}/${scope}`;
  const canonicalUri = `/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;

  const params = new URLSearchParams({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": credential,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expires),
    "X-Amz-SignedHeaders": "host",
  });
  // URLSearchParams já ordena? Não — ordenar manualmente (exigência da SigV4)
  const canonicalQuery = [...params.entries()]
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .sort()
    .join("&");

  const canonicalRequest = [
    "PUT",
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(new TextEncoder().encode(canonicalRequest)),
  ].join("\n");

  const enc = new TextEncoder();
  let signingKey = await hmac(enc.encode(`AWS4${secretAccessKey}`), enc.encode(dateStamp));
  signingKey = await hmac(signingKey, enc.encode(region));
  signingKey = await hmac(signingKey, enc.encode(service));
  signingKey = await hmac(signingKey, enc.encode("aws4_request"));
  const signature = toHex(await hmac(signingKey, enc.encode(stringToSign)));

  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/* ------------------------------------------------------------------ rotas */

async function handleVideoUpload(request, env, url) {
  if (!env.BUCKET) return fail("Worker sem binding R2 (BUCKET).", 500);
  const fileName = safeName(request.headers.get("x-file-name") || "reel.mp4");
  const name = fileName.toLowerCase().endsWith(".mp4") ? fileName : `${fileName}.mp4`;
  const sizeHeader = Number(request.headers.get("x-file-size") || 0);
  const contentType = request.headers.get("content-type") || "video/mp4";

  if (!request.body) return fail("Corpo vazio — o vídeo não chegou ao Worker.", 400);

  const key = `${VIDEO_PREFIX}${Date.now().toString(36)}_${randomId(12)}_${name}`;
  try {
    await env.BUCKET.put(key, request.body, {
      httpMetadata: { contentType },
      customMetadata: {
        originalName: name,
        uploadedAt: new Date().toISOString(),
        declaredSize: String(sizeHeader || ""),
        source: "cineclip-web",
      },
    });
  } catch (err) {
    return fail(`Falha ao gravar no R2: ${err && err.message ? err.message : err}`, 500);
  }

  const object = await env.BUCKET.head(key);
  const publicUrl = `${publicBase(env, url)}/v/${encodeURIComponent(key)}`;
  return json({
    ok: true,
    provider: "cloudflare-r2",
    url: publicUrl,
    key,
    size: object ? object.size : sizeHeader || 0,
    durable: true,
    version: VERSION,
  }, 200, { "X-Cineclip-Key": key });
}

async function handlePresign(request, env, url) {
  const missing = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"]
    .filter((k) => !env[k]);
  if (missing.length)
    return fail(
      `Presign não configurado. Falta: ${missing.join(", ")}. ` +
        `Defina-os como secrets/vars do Worker para enviar vídeos acima de 100 MB.`,
      501,
      { missing }
    );

  let payload = {};
  try {
    payload = await request.json();
  } catch {
    return fail("JSON inválido no pedido de presign.", 400);
  }
  const fileName = safeName(payload.fileName || "reel.mp4");
  const name = fileName.toLowerCase().endsWith(".mp4") ? fileName : `${fileName}.mp4`;
  const key = `${VIDEO_PREFIX}${Date.now().toString(36)}_${randomId(12)}_${name}`;
  const expires = Math.min(Math.max(Number(payload.expires || 3600), 300), 604800);

  let uploadUrl;
  try {
    uploadUrl = await presignPut({
      accountId: env.R2_ACCOUNT_ID,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      bucket: env.R2_BUCKET_NAME,
      key,
      expires,
    });
  } catch (err) {
    return fail(`Erro a assinar a URL: ${err && err.message ? err.message : err}`, 500);
  }

  return json({
    ok: true,
    provider: "cloudflare-r2-presigned",
    uploadUrl,
    url: `${publicBase(env, url)}/v/${encodeURIComponent(key)}`,
    key,
    expiresIn: expires,
    durable: true,
  });
}

async function handleServeVideo(request, env, key) {
  if (!env.BUCKET) return fail("Worker sem binding R2 (BUCKET).", 500);
  const decoded = decodeURIComponent(key);
  if (decoded.includes("..")) return fail("Chave inválida.", 400);

  const range = request.headers.get("range");
  let object;
  try {
    object = range
      ? await env.BUCKET.get(decoded, { range: parseRange(range) })
      : await env.BUCKET.get(decoded);
  } catch (err) {
    return fail(`Erro a ler do R2: ${err && err.message ? err.message : err}`, 500);
  }

  if (!object) return fail("Vídeo não encontrado (404).", 404);

  const headers = corsHeaders({
    "Content-Type": object.httpMetadata?.contentType || "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
    ETag: `"${object.etag || object.httpEtag?.replace(/"/g, "") || ""}"`,
    "X-Cineclip-Durable": "1",
  });

  if (object.range) {
    const start = object.range.offset ?? 0;
    const end = object.range.length ? start + object.range.length - 1 : object.size - 1;
    headers.set("Content-Range", `bytes ${start}-${end}/${object.size}`);
    headers.set("Content-Length", String(object.range.length || object.size));
    return new Response(object.body, { status: 206, headers });
  }

  headers.set("Content-Length", String(object.size));
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  return new Response(object.body, { status: 200, headers });
}

function parseRange(header) {
  const m = /bytes=(\d*)-(\d*)/.exec(String(header || ""));
  if (!m) return undefined;
  const start = m[1] ? parseInt(m[1], 10) : undefined;
  const end = m[2] ? parseInt(m[2], 10) : undefined;
  if (start === undefined && end === undefined) return undefined;
  if (start !== undefined && end !== undefined) return { offset: start, length: end - start + 1 };
  if (start !== undefined) return { offset: start };
  return { suffix: end };
}

async function handleVaultPut(request, env, name) {
  if (!env.BUCKET) return fail("Worker sem binding R2 (BUCKET).", 500);
  const clean = safeName(name).replace(/\.json$/i, "");
  if (!clean) return fail("Nome do cofre inválido.", 400);
  const body = await request.text();
  if (!body) return fail("Cofre vazio.", 400);
  if (body.length > 8 * 1024 * 1024) return fail("Cofre demasiado grande (> 8 MB).", 413);
  await env.BUCKET.put(`${VAULT_PREFIX}${clean}.json`, body, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { savedAt: new Date().toISOString() },
  });
  return json({ ok: true, provider: "cloudflare-r2", name: clean, size: body.length });
}

async function handleVaultGet(env, name) {
  if (!env.BUCKET) return fail("Worker sem binding R2 (BUCKET).", 500);
  const clean = safeName(name).replace(/\.json$/i, "");
  const object = await env.BUCKET.get(`${VAULT_PREFIX}${clean}.json`);
  if (!object) return fail("Cofre não encontrado.", 404, { code: "not_found" });
  const text = await object.text();
  return new Response(text, {
    status: 200,
    headers: corsHeaders({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Cineclip-Saved-At": object.customMetadata?.savedAt || "",
    }),
  });
}

async function handleStats(env) {
  if (!env.BUCKET) return fail("Worker sem binding R2 (BUCKET).", 500);
  let videos = 0;
  let vaults = 0;
  let claims = 0;
  let bytes = 0;
  let cursor;
  let guard = 0;
  do {
    const listed = await env.BUCKET.list({ cursor, limit: 1000 });
    for (const o of listed.objects) {
      bytes += o.size;
      if (o.key.startsWith(VIDEO_PREFIX)) videos++;
      else if (o.key.startsWith(VAULT_PREFIX)) vaults++;
      else if (o.key.startsWith(CLAIM_PREFIX)) claims++;
    }
    cursor = listed.cursor;
    guard++;
  } while (cursor && guard < 50);
  return json({ ok: true, videos, vaults, claims, bytes, version: VERSION });
}

/* ----------------------------------------- claims (anti-publicação dupla) */

/**
 * Uma "claim" é uma reclamação temporária sobre um item da fila: quem a tem é
 * quem pode publicar. Serve para o app (browser) e o Robô 24h (Apps Script) não
 * publicarem o mesmo Reel ao mesmo tempo — antes, ambos liam o cofre, ambos
 * viam `status: "scheduled"` e ambos publicavam.
 *
 * Semântica:
 *   • `owner` diferente e claim viva → recusado (`acquired: false` + `holder`);
 *   • mesmo `owner` → renova (o TTL é estendido), para os retries do mesmo
 *     aparelho não se auto-bloquearem;
 *   • claim expirada/ilegível → considerada morta e substituída (takeover);
 *   • a escrita é condicional ao ETag certo para cada caso + verificada por
 *     releitura, para dois pedidos simultâneos não ficarem ambos a pensar que
 *     ganharam.
 *
 * ⚠️ A pré-condição do `put` tem de acompanhar o caso: `etagDoesNotMatch: "*"`
 * só serve para CRIAR (chave vazia). Usá-la sempre — como acontecia antes —
 * fazia a renovação do próprio dono e o takeover de uma claim expirada falharem
 * para sempre: o Worker respondia `acquired:false` sem dono, o app e o Robô
 * abortavam com "Outro aparelho … está a publicar este Reel" e aquele Reel nunca
 * mais era publicado. É este o cenário que `tools/repro-claim-wedge.mjs`
 * reproduz e que `npm run worker:test` passa a cobrir.
 */

function clampClaimTtl(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return CLAIM_TTL_DEFAULT_MS;
  return Math.min(Math.max(Math.round(n), CLAIM_TTL_MIN_MS), CLAIM_TTL_MAX_MS);
}

const claimObjectName = (key) => `${CLAIM_PREFIX}${safeName(key)}.json`;

/**
 * Lê a claim e guarda o ETag: as escritas condicionais abaixo precisam dele para
 * detetar que outro dispositivo escreveu no meio.
 * @returns {Promise<{claim: object|null, etag: string|null, exists: boolean}>}
 */
async function readClaimEntry(env, key) {
  const object = await env.BUCKET.get(claimObjectName(key));
  if (!object) return { claim: null, etag: null, exists: false };
  const etag = object.etag ? String(object.etag) : null;
  try {
    const claim = JSON.parse(await object.text());
    if (!claim || typeof claim !== "object") return { claim: null, etag, exists: true };
    if (!claim.key) claim.key = key;
    return { claim, etag, exists: true };
  } catch {
    // Objeto ilegível a ocupar a chave: tratado como claim morta.
    return { claim: null, etag, exists: true };
  }
}

async function readClaim(env, key) {
  return (await readClaimEntry(env, key)).claim;
}

const claimIsLive = (claim, nowMs) => !!(claim && Number(claim.expiresAt || 0) > nowMs);

const holderOf = (claim) =>
  claim ? { owner: claim.owner, expiresAt: claim.expiresAt } : null;

async function handleClaimAcquire(request, env) {
  if (!env.BUCKET) return fail("Worker sem binding R2 (BUCKET).", 500);

  let payload = {};
  try {
    payload = await request.json();
  } catch {
    return fail("JSON inválido no pedido de claim.", 400);
  }

  const key = safeName(payload.key || "");
  const owner = String(payload.owner || "").trim().slice(0, 120);
  if (!key) return fail("Claim sem 'key' (identificador do item).", 400);
  if (!owner) return fail("Claim sem 'owner' (quem está a publicar).", 400);

  const ttlMs = clampClaimTtl(payload.ttlMs);
  const nowMs = Date.now();
  const objectName = claimObjectName(key);
  const meta = { httpMetadata: { contentType: "application/json; charset=utf-8" } };
  let lastHolder = null;

  for (let attempt = 1; attempt <= 4; attempt++) {
    const entry = await readClaimEntry(env, key);

    if (claimIsLive(entry.claim, nowMs) && entry.claim.owner !== owner) {
      return json({
        ok: true, provider: "cloudflare-r2", acquired: false,
        holder: holderOf(entry.claim),
        retryAfterMs: Math.max(0, Number(entry.claim.expiresAt || 0) - nowMs),
      });
    }

    const claim = {
      key, owner, provider: "cloudflare-r2",
      acquiredAt: nowMs, expiresAt: nowMs + ttlMs, renewals: attempt,
    };
    const body = JSON.stringify(claim);

    // Pré-condição certa para cada caso: CRIAR quando a chave está vazia
    // (`etagDoesNotMatch: "*"`), RENOVAR/TOMAR quando já existe uma claim do
    // mesmo dono ou uma claim morta (`etagMatches` do objeto lido). Sem o ETag
    // (runtime antigo), o put simples + releitura abaixo ainda confirma o dono.
    const onlyIf = !entry.exists
      ? { etagDoesNotMatch: "*" }
      : entry.etag
        ? { etagMatches: entry.etag }
        : null;

    try {
      const written = onlyIf
        ? await env.BUCKET.put(objectName, body, { ...meta, onlyIf })
        : await env.BUCKET.put(objectName, body, meta);
      if (written === null) {
        // Outro pedido escreveu no meio: relê e decide no próximo ciclo.
        continue;
      }
    } catch (err) {
      try {
        await env.BUCKET.put(objectName, body, meta);
      } catch (err2) {
        return fail(
          `Falha ao gravar a claim no R2: ${err2 && err2.message ? err2.message : err2}`,
          500
        );
      }
    }

    // Verificação read-after-write: quem ficou gravado é o dono da claim.
    const held = await readClaim(env, key);
    if (held && held.owner === owner) {
      return json({ ok: true, provider: "cloudflare-r2", acquired: true, claim: held });
    }
    lastHolder = held;
  }

  return json({
    ok: true, provider: "cloudflare-r2", acquired: false,
    holder: holderOf(lastHolder),
    note: "Não foi possível obter a claim (concorrência). Tenta de novo.",
  });
}

async function handleClaimRelease(request, env) {
  if (!env.BUCKET) return fail("Worker sem binding R2 (BUCKET).", 500);

  let payload = {};
  try {
    payload = await request.json();
  } catch {
    return fail("JSON inválido no pedido de release.", 400);
  }

  const key = safeName(payload.key || "");
  const owner = String(payload.owner || "").trim().slice(0, 120);
  if (!key) return fail("Release sem 'key'.", 400);
  if (!owner) return fail("Release sem 'owner'.", 400);

  const current = await readClaim(env, key);
  if (!current) {
    return json({ ok: true, provider: "cloudflare-r2", released: false, note: "sem claim" });
  }
  if (current.owner !== owner) {
    // Nunca apagar a claim de outro dispositivo: seria publicar duas vezes.
    return json({
      ok: true, provider: "cloudflare-r2", released: false,
      holder: holderOf(current), note: "claim de outro dono",
    });
  }

  await env.BUCKET.delete(claimObjectName(key));
  return json({ ok: true, provider: "cloudflare-r2", released: true });
}

async function handleClaimStatus(env, key) {
  if (!env.BUCKET) return fail("Worker sem binding R2 (BUCKET).", 500);
  const nowMs = Date.now();
  const claim = await readClaim(env, key);
  const active = !!(claim && Number(claim.expiresAt || 0) > nowMs);
  return json({
    ok: true, provider: "cloudflare-r2", key,
    active,
    claim: active ? claim : null,
    expired: !!(claim && !active),
  });
}

async function handleClaimsList(env) {
  if (!env.BUCKET) return fail("Worker sem binding R2 (BUCKET).", 500);
  const nowMs = Date.now();
  const active = [];
  let cleaned = 0;
  let cursor;
  let guard = 0;
  do {
    const listed = await env.BUCKET.list({ prefix: CLAIM_PREFIX, cursor, limit: 1000 });
    for (const o of listed.objects) {
      const object = await env.BUCKET.get(o.key);
      if (!object) continue;
      let claim = null;
      try {
        claim = JSON.parse(await object.text());
      } catch {
        claim = null;
      }
      if (claimIsLive(claim, nowMs)) {
        active.push(claim);
      } else {
        // Claim caduca/ilegível: sai da lista E da chave — se ficasse lá, o
        // diagnóstico mostrava "nenhuma claim" e a fila continuava presa.
        await env.BUCKET.delete(o.key);
        cleaned++;
      }
    }
    cursor = listed.cursor;
    guard++;
  } while (cursor && guard < 10);
  return json({ ok: true, provider: "cloudflare-r2", active, count: active.length, cleaned });
}

/* ------------------------------------------------------------------ main */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Health check público (sem token) — usado pelo botão "Testar nuvem R2"
    if (path === "/" && request.method === "GET") {
      return json({
        ok: true,
        service: "cineclip-cloud",
        version: VERSION,
        bucket: !!env.BUCKET,
        presign: !!(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY),
        claims: true,
        maxDirectUploadBytes: MAX_DIRECT_UPLOAD,
        time: new Date().toISOString(),
      });
    }

    // Link público dos vídeos — SEM autenticação (é o URL que a Meta descarrega).
    // A segurança vem da chave aleatória de 30+ caracteres.
    if (path.startsWith("/v/")) {
      return handleServeVideo(request, env, path.slice(3));
    }

    // Daqui para baixo: tudo exige o token Bearer
    if (!env.CINECLIP_TOKEN) {
      return fail(
        "Worker sem CINECLIP_TOKEN. Corre: npx wrangler secret put CINECLIP_TOKEN",
        500
      );
    }
    if (!tokenMatches(bearer(request), env.CINECLIP_TOKEN)) {
      return fail("Token inválido (Authorization: Bearer …).", 401);
    }

    if (path === "/api/video" && request.method === "POST") {
      const declared = Number(request.headers.get("x-file-size") || 0);
      const contentLength = Number(request.headers.get("content-length") || declared || 0);
      if (contentLength > MAX_DIRECT_UPLOAD) {
        return fail(
          `Vídeo com ${(contentLength / 1048576).toFixed(1)} MB excede o limite de corpo do Worker ` +
            `(100 MB). Usa /api/video/presign (configura R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY).`,
          413,
          { code: "too_large", presign: true }
        );
      }
      return handleVideoUpload(request, env, url);
    }

    if (path === "/api/video/presign" && request.method === "POST") {
      return handlePresign(request, env, url);
    }

    if (path.startsWith("/api/vault/")) {
      const name = path.slice("/api/vault/".length);
      if (request.method === "PUT" || request.method === "POST") return handleVaultPut(request, env, name);
      if (request.method === "GET") return handleVaultGet(env, name);
      if (request.method === "DELETE") {
        await env.BUCKET.delete(`${VAULT_PREFIX}${safeName(name).replace(/\.json$/i, "")}.json`);
        return json({ ok: true, deleted: name });
      }
    }

    if (path === "/api/stats" && request.method === "GET") return handleStats(env);

    // 🔒 Claims: quem reclama o item é quem pode publicá-lo.
    if (path === "/api/claims" && request.method === "GET") return handleClaimsList(env);
    if (path === "/api/claims/acquire" && request.method === "POST") {
      return handleClaimAcquire(request, env);
    }
    if (path === "/api/claims/release" && request.method === "POST") {
      return handleClaimRelease(request, env);
    }
    if (path.startsWith("/api/claims/") && request.method === "GET") {
      const key = path.slice("/api/claims/".length);
      if (key !== "acquire" && key !== "release") return handleClaimStatus(env, key);
    }

    return fail(`Rota desconhecida: ${request.method} ${path}`, 404);
  },
};
