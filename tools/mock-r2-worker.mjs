#!/usr/bin/env node
/**
 * Mock local do Cloudflare Worker (cloudflare/r2-worker.js).
 * Implementa exatamente o mesmo contrato de API, guardando os objetos em
 * .mock-cloud/ — serve para testar o fluxo completo no preview sem conta Cloudflare.
 *
 * Rotas (montadas em /cloud-api pelo tools/dev-server.mjs):
 *   GET    /                      health
 *   POST   /api/video             upload direto
 *   POST   /api/video/presign     URL "pré-assinada" (aqui: PUT /s3/:key sem token)
 *   PUT    /s3/:key               destino do presign
 *   GET    /v/:key                link público do vídeo (Range/206)
 *   PUT    /api/vault/:name       grava cofre
 *   GET    /api/vault/:name       lê cofre
 *   DELETE /api/vault/:name       apaga cofre
 *   GET    /api/stats             contagens
 *   POST   /api/claims/acquire    🔒 reclama um item (anti-publicação dupla)
 *   POST   /api/claims/release    liberta a reclamação
 *   GET    /api/claims            reclamações ativas
 *   GET    /api/claims/:key       estado de uma reclamação
 *
 * MOCK_NO_CLAIMS=1 faz o mock comportar-se como um Worker ANTIGO (sem rotas de
 * claims) — é assim que os testes verificam que o cliente não bloqueia
 * publicações quando o backend ainda não foi atualizado.
 */
import fs from "node:fs";
import path from "node:path";

const TOKEN = process.env.MOCK_CLOUD_TOKEN || "cc_r2_token_de_teste";
const MAX_DIRECT = Number(process.env.MOCK_MAX_DIRECT_MB || 100) * 1024 * 1024;
// (o "modo antigo" é por instância: createMockCloud({ noClaims: true }))
const CLAIM_TTL_DEFAULT_MS = 10 * 60 * 1000;
const CLAIM_TTL_MIN_MS = 60 * 1000;
const CLAIM_TTL_MAX_MS = 60 * 60 * 1000;

export function createMockCloud({ storeDir, noClaims }) {
  // `noClaims: true` (ou MOCK_NO_CLAIMS=1) faz este mock passar a comportar-se
  // como um Worker ANTIGO, sem as rotas de claims — é assim que os testes
  // verificam a degradação segura do cliente.
  const NO_CLAIMS = noClaims === undefined ? process.env.MOCK_NO_CLAIMS === "1" : !!noClaims;
  fs.mkdirSync(path.join(storeDir, "videos"), { recursive: true });
  fs.mkdirSync(path.join(storeDir, "vaults"), { recursive: true });
  fs.mkdirSync(path.join(storeDir, "claims"), { recursive: true });

  const json = (res, data, status = 200, extra = {}) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Authorization,Content-Type,X-File-Name,X-File-Size,X-Cineclip-Client",
      "Access-Control-Expose-Headers": "Content-Length,Content-Range,X-Cineclip-Key",
      ...extra,
    });
    res.end(JSON.stringify(data));
  };

  const safe = (s) => String(s || "").replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 140);
  const rid = (n = 12) => [...Array(n)].map(() => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("");

  const readBody = (req, limit = 2 * 1024 * 1024 * 1024) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > limit) {
          reject(Object.assign(new Error("too_large"), { status: 413 }));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });

  const authed = (req) => {
    const h = String(req.headers["authorization"] || "");
    const token = h.replace(/^Bearer\s+/i, "").trim();
    return token && token === TOKEN;
  };

  const originOf = (req) => {
    const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
    const host = String(req.headers["x-forwarded-host"] || req.headers["host"] || "localhost");
    return `${proto}://${host}`;
  };

  /* --- 🔒 claims: mesma semântica do Worker real (ver cloudflare/r2-worker.js) --- */

  const claimsDir = path.join(storeDir, "claims");
  const claimFile = (key) => path.join(claimsDir, `${safe(key)}.json`);
  const readClaim = (key) => {
    try {
      return JSON.parse(fs.readFileSync(claimFile(key), "utf8"));
    } catch {
      return null;
    }
  };
  const clampTtl = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return CLAIM_TTL_DEFAULT_MS;
    return Math.min(Math.max(Math.round(n), CLAIM_TTL_MIN_MS), CLAIM_TTL_MAX_MS);
  };
  const activeClaims = () => {
    const nowMs = Date.now();
    const out = [];
    for (const f of fs.readdirSync(claimsDir)) {
      if (!f.endsWith(".json")) continue;
      let claim = null;
      try {
        claim = JSON.parse(fs.readFileSync(path.join(claimsDir, f), "utf8"));
      } catch {
        continue;
      }
      if (claim && Number(claim.expiresAt || 0) > nowMs) out.push(claim);
      else fs.rmSync(path.join(claimsDir, f), { force: true });
    }
    return out;
  };
  const replyNoClaims = (res2) => json(res2, { ok: false, error: "Rota desconhecida (mock antigo, sem claims)." }, 404);

  return async function handle(req, res, subPath) {
    const url = new URL(req.url, "http://mock");
    const p = (subPath || url.pathname).replace(/\/+$/, "") || "/";

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Authorization,Content-Type,X-File-Name,X-File-Size,X-Cineclip-Client",
        "Access-Control-Max-Age": "86400",
      });
      return res.end();
    }

    if (p === "/" && req.method === "GET") {
      return json(res, {
        ok: true,
        service: "cineclip-cloud-mock",
        version: "1.1.0-mock",
        bucket: true,
        presign: true,
        claims: !NO_CLAIMS,
        maxDirectUploadBytes: MAX_DIRECT,
        token: TOKEN,
        time: new Date().toISOString(),
      });
    }

    if (p.startsWith("/v/")) {
      const key = decodeURIComponent(p.slice(3));
      const file = path.join(storeDir, "videos", safe(key.replace(/\//g, "__")));
      if (!fs.existsSync(file)) return json(res, { ok: false, error: "Vídeo não encontrado (404)." }, 404);
      const stat = fs.statSync(file);
      const meta = readMeta(file);
      const headers = {
        "Content-Type": meta.contentType || "video/mp4",
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=31536000, immutable",
        "Access-Control-Allow-Origin": "*",
        "X-Cineclip-Durable": "1",
      };
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        const start = m && m[1] ? parseInt(m[1], 10) : 0;
        const end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
        res.writeHead(206, {
          ...headers,
          "Content-Range": `bytes ${start}-${end}/${stat.size}`,
          "Content-Length": String(end - start + 1),
        });
        if (req.method === "HEAD") return res.end();
        return fs.createReadStream(file, { start, end }).pipe(res);
      }
      res.writeHead(200, { ...headers, "Content-Length": String(stat.size) });
      if (req.method === "HEAD") return res.end();
      return fs.createReadStream(file).pipe(res);
    }

    if (p.startsWith("/s3/")) {
      // destino da "URL pré-assinada" do mock (sem token, tal como no S3)
      if (req.method !== "PUT") return json(res, { ok: false, error: "Use PUT." }, 405);
      const key = decodeURIComponent(p.slice(4));
      const body = await readBody(req);
      const file = path.join(storeDir, "videos", safe(key.replace(/\//g, "__")));
      fs.writeFileSync(file, body);
      writeMeta(file, { contentType: req.headers["content-type"] || "video/mp4", presigned: true });
      return json(res, { ok: true, key, size: body.length });
    }

    if (!TOKEN || !authed(req)) return json(res, { ok: false, error: "Token inválido (Authorization: Bearer …)." }, 401);

    if (p === "/api/claims" && req.method === "GET") {
      if (NO_CLAIMS) return replyNoClaims(res);
      const active = activeClaims();
      return json(res, { ok: true, provider: "mock-r2", active, count: active.length });
    }

    if (p === "/api/claims/acquire" && req.method === "POST") {
      if (NO_CLAIMS) return replyNoClaims(res);
      let payload = {};
      try {
        payload = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      } catch {
        return json(res, { ok: false, error: "JSON inválido no pedido de claim." }, 400);
      }
      const key = safe(payload.key || "");
      const owner = String(payload.owner || "").trim().slice(0, 120);
      if (!key) return json(res, { ok: false, error: "Claim sem 'key' (identificador do item)." }, 400);
      if (!owner) return json(res, { ok: false, error: "Claim sem 'owner' (quem está a publicar)." }, 400);
      const nowMs = Date.now();
      const current = readClaim(key);
      if (current && Number(current.expiresAt || 0) > nowMs && current.owner !== owner) {
        return json(res, {
          ok: true,
          provider: "mock-r2",
          acquired: false,
          holder: { owner: current.owner, expiresAt: current.expiresAt },
          retryAfterMs: Number(current.expiresAt || 0) - nowMs,
        });
      }
      const claim = { key, owner, provider: "mock-r2", acquiredAt: nowMs, expiresAt: nowMs + clampTtl(payload.ttlMs) };
      // Escrita síncrona: em Node não há interleaving dentro deste bloco, por isso
      // o mock é atómico (o Worker real usa R2 + verificação read-after-write).
      fs.writeFileSync(claimFile(key), JSON.stringify(claim));
      return json(res, { ok: true, provider: "mock-r2", acquired: true, claim });
    }

    if (p === "/api/claims/release" && req.method === "POST") {
      if (NO_CLAIMS) return replyNoClaims(res);
      let payload = {};
      try {
        payload = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      } catch {
        return json(res, { ok: false, error: "JSON inválido no pedido de release." }, 400);
      }
      const key = safe(payload.key || "");
      const owner = String(payload.owner || "").trim().slice(0, 120);
      if (!key || !owner) return json(res, { ok: false, error: "Release precisa de 'key' e 'owner'." }, 400);
      const current = readClaim(key);
      if (!current) return json(res, { ok: true, provider: "mock-r2", released: false, note: "sem claim" });
      if (current.owner !== owner) {
        return json(res, {
          ok: true,
          provider: "mock-r2",
          released: false,
          holder: { owner: current.owner, expiresAt: current.expiresAt },
          note: "claim de outro dono",
        });
      }
      fs.rmSync(claimFile(key), { force: true });
      return json(res, { ok: true, provider: "mock-r2", released: true });
    }

    if (p.startsWith("/api/claims/") && req.method === "GET") {
      if (NO_CLAIMS) return replyNoClaims(res);
      const key = safe(decodeURIComponent(p.slice("/api/claims/".length)));
      if (key === "acquire" || key === "release") return replyNoClaims(res);
      const claim = readClaim(key);
      const active = !!(claim && Number(claim.expiresAt || 0) > Date.now());
      return json(res, {
        ok: true, provider: "mock-r2", key, active,
        claim: active ? claim : null,
        expired: !!(claim && !active),
      });
    }

    if (p === "/api/video" && (req.method === "POST" || req.method === "PUT")) {
      const declared = Number(req.headers["x-file-size"] || req.headers["content-length"] || 0);
      if (declared > MAX_DIRECT) {
        return json(
          res,
          {
            ok: false,
            code: "too_large",
            presign: true,
            error: `Vídeo com ${(declared / 1048576).toFixed(1)} MB excede o limite de corpo do Worker (100 MB). Usa /api/video/presign.`,
          },
          413
        );
      }
      const body = await readBody(req);
      const name = safe(req.headers["x-file-name"] || "reel.mp4");
      const key = `videos/${Date.now().toString(36)}_${rid()}_${name.endsWith(".mp4") ? name : name + ".mp4"}`;
      const file = path.join(storeDir, "videos", safe(key.replace(/\//g, "__")));
      fs.writeFileSync(file, body);
      writeMeta(file, { contentType: req.headers["content-type"] || "video/mp4", originalName: name });
      return json(res, {
        ok: true,
        provider: "mock-r2",
        url: `${originOf(req)}${url.pathname.replace(/\/api\/video$/, "")}/v/${encodeURIComponent(key)}`,
        key,
        size: body.length,
        durable: true,
      }, 200, { "X-Cineclip-Key": key });
    }

    if (p === "/api/video/presign" && req.method === "POST") {
      let payload = {};
      try {
        payload = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      } catch {}
      const name = safe(payload.fileName || "reel.mp4");
      const key = `videos/${Date.now().toString(36)}_${rid()}_${name.endsWith(".mp4") ? name : name + ".mp4"}`;
      const base = `${originOf(req)}${url.pathname.replace(/\/api\/video\/presign$/, "")}`;
      return json(res, {
        ok: true,
        provider: "mock-r2-presigned",
        uploadUrl: `${base}/s3/${encodeURIComponent(key)}`,
        url: `${base}/v/${encodeURIComponent(key)}`,
        key,
        expiresIn: 3600,
        durable: true,
      });
    }

    if (p.startsWith("/api/vault/")) {
      const name = safe(p.slice("/api/vault/".length)).replace(/\.json$/i, "");
      const file = path.join(storeDir, "vaults", `${name}.json`);
      if (req.method === "PUT" || req.method === "POST") {
        const body = await readBody(req, 8 * 1024 * 1024);
        if (!body.length) return json(res, { ok: false, error: "Cofre vazio." }, 400);
        fs.writeFileSync(file, body);
        fs.writeFileSync(file + ".meta.json", JSON.stringify({ savedAt: new Date().toISOString() }));
        return json(res, { ok: true, provider: "mock-r2", name, size: body.length });
      }
      if (req.method === "GET") {
        if (!fs.existsSync(file)) return json(res, { ok: false, error: "Cofre não encontrado.", code: "not_found" }, 404);
        const body = fs.readFileSync(file);
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
          "Content-Length": String(body.length),
        });
        return res.end(body);
      }
      if (req.method === "DELETE") {
        fs.rmSync(file, { force: true });
        fs.rmSync(file + ".meta.json", { force: true });
        return json(res, { ok: true, deleted: name });
      }
    }

    if (p === "/api/stats" && req.method === "GET") {
      const videos = fs.readdirSync(path.join(storeDir, "videos")).filter((f) => !f.endsWith(".meta.json"));
      const vaults = fs.readdirSync(path.join(storeDir, "vaults")).filter((f) => f.endsWith(".json") && !f.endsWith(".meta.json"));
      const bytes = videos.reduce((acc, f) => acc + fs.statSync(path.join(storeDir, "videos", f)).size, 0);
      return json(res, { ok: true, videos: videos.length, vaults: vaults.length, claims: activeClaims().length, bytes, version: "1.1.0-mock" });
    }

    return json(res, { ok: false, error: `Rota desconhecida: ${req.method} ${p}` }, 404);
  };
}

function metaPath(file) {
  return file + ".meta.json";
}
function readMeta(file) {
  try {
    return JSON.parse(fs.readFileSync(metaPath(file), "utf8"));
  } catch {
    return {};
  }
}
function writeMeta(file, meta) {
  try {
    fs.writeFileSync(metaPath(file), JSON.stringify({ ...meta, savedAt: new Date().toISOString() }));
  } catch {}
}
