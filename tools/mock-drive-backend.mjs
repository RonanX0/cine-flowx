#!/usr/bin/env node
/**
 * Mock local do backend Google Drive (apps-script/cineclip-cloud-drive.js).
 * Replica o MESMO contrato — incluindo o detalhe importante de que o Apps Script
 * devolve sempre HTTP 200 e reporta os erros no corpo JSON ({ok:false,…}), e que
 * o link do vídeo NÃO suporta Range.
 *
 * Montado em /drive-api pelo tools/dev-server.mjs.
 */
import fs from "node:fs";
import path from "node:path";

const TOKEN = process.env.MOCK_DRIVE_TOKEN || "cc_drive_token_de_teste";

/**
 * @param {object} o
 * @param {string} o.storeDir      onde guardar os ficheiros (.mock-cloud/drive/…)
 * @param {number} [o.singleMaxMb] até aqui o vídeo vai num só pedido (default 8)
 * @param {number} [o.chunkBytes]  tamanho do bloco anunciado no health (default 2 MB)
 * @param {number} [o.maxVideoMb]  limite duro, como no Apps Script real (default 45)
 */
export function createMockDrive({ storeDir, singleMaxMb, chunkBytes, maxVideoMb }) {
  const SINGLE_MAX = Number(singleMaxMb || process.env.MOCK_DRIVE_SINGLE_MAX_MB || 8) * 1024 * 1024;
  const CHUNK = Number(chunkBytes || process.env.MOCK_DRIVE_CHUNK_BYTES || 2 * 1024 * 1024);
  const MAX_VIDEO = Number(maxVideoMb || process.env.MOCK_DRIVE_MAX_VIDEO_MB || 45) * 1024 * 1024;
  const videosDir = path.join(storeDir, "drive", "videos");
  const vaultsDir = path.join(storeDir, "drive", "vaults");
  fs.mkdirSync(videosDir, { recursive: true });
  fs.mkdirSync(vaultsDir, { recursive: true });
  const uploads = new Map();

  const send = (res, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  };

  const rid = (n = 16) => [...Array(n)].map(() => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_".charAt(Math.floor(Math.random() * 64))).join("");
  const safe = (s) => String(s || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });

  const originOf = (req) => {
    const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
    const host = String(req.headers["x-forwarded-host"] || req.headers["host"] || "localhost");
    return `${proto}://${host}`;
  };
  const baseOf = (req) => `${originOf(req)}${new URL(req.url, "http://x").pathname.replace(/\/$/, "")}`;
  const videoUrl = (req, id) => `${baseOf(req)}?action=video&id=${encodeURIComponent(id)}`;

  return async function handle(req, res) {
    const url = new URL(req.url, "http://mock");
    const p = url.searchParams;
    const action = p.get("action") || "health";
    const token = p.get("token") || "";
    const authed = token === TOKEN;

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      return res.end();
    }

    if (action === "health") {
      return send(res, {
        ok: true,
        service: "cineclip-cloud-drive-mock",
        version: "1.0.0-mock",
        bucket: true,
        provider: "google-drive",
        folder: "mock-folder",
        chunkBytes: CHUNK,
        singleMaxBytes: SINGLE_MAX,
        maxVideoBytes: MAX_VIDEO,
        durable: true,
        token: TOKEN,
        time: new Date().toISOString(),
      });
    }

    // link público do vídeo — sem suporte a Range, tal como o Apps Script real
    if (action === "video") {
      const id = p.get("id") || "";
      const file = path.join(videosDir, safe(id));
      if (!fs.existsSync(file)) return send(res, { ok: false, error: "Vídeo não encontrado." });
      const buf = fs.readFileSync(file);
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Access-Control-Allow-Origin": "*",
        "Content-Length": String(buf.length),
        "Content-Disposition": 'attachment; filename="' + (readSidecar(file).name || "reel.mp4") + '"',
      });
      if (req.method === "HEAD") return res.end();
      return res.end(buf);
    }

    if (action === "videohead") {
      const id = p.get("id") || "";
      const file = path.join(videosDir, safe(id));
      if (!fs.existsSync(file)) return send(res, { ok: false, error: "Vídeo não encontrado." });
      return send(res, {
        ok: true,
        provider: "google-drive",
        id,
        name: readSidecar(file).name || "reel.mp4",
        size: fs.statSync(file).size,
        contentType: "video/mp4",
        url: videoUrl(req, id),
      });
    }

    if (!authed) return send(res, { ok: false, error: "Token inválido." });

    if (action === "vault") {
      const hash = safe(p.get("hash") || "");
      const file = path.join(vaultsDir, `cc_${hash}.json`);
      if (req.method === "GET") {
        if (!fs.existsSync(file)) return send(res, { ok: false, error: "Cofre não encontrado.", code: "not_found" });
        return send(res, {
          ok: true,
          provider: "google-drive",
          cipher: fs.readFileSync(file, "utf8"),
          savedAt: new Date(fs.statSync(file).mtimeMs).toISOString(),
          size: fs.statSync(file).size,
        });
      }
      const body = (await readBody(req)).toString("utf8");
      if (!body.trim()) return send(res, { ok: false, error: "Cofre vazio." });
      fs.writeFileSync(file, body);
      return send(res, { ok: true, provider: "google-drive", name: `cc_${hash}.json`, size: body.length, savedAt: new Date().toISOString() });
    }

    if (action === "upload") {
      const uploadId = p.get("id") || "";
      const index = Number(p.get("index") || 0);
      const total = Number(p.get("total") || 0);
      const name = safe(p.get("name") || "reel.mp4");
      const declaredTotal = Number(p.get("total") || 0);
      if (declaredTotal > MAX_VIDEO) {
        return send(res, {
          ok: false,
          error: "Vídeo com " + Math.round(declaredTotal / 1048576) + " MB excede o limite de " + Math.round(MAX_VIDEO / 1048576) + " MB.",
          code: "too_large",
        });
      }
      const body = await readBody(req);
      let bytes;
      try {
        bytes = Buffer.from(body.toString("utf8").replace(/\s/g, ""), "base64");
      } catch {
        return send(res, { ok: false, error: "base64 inválido." });
      }
      if (!uploadId) return send(res, { ok: false, error: "Falta o id do upload." });

      // vídeo pequeno: um só pedido
      if (total <= SINGLE_MAX) {
        if (index !== 0) return send(res, { ok: false, error: "Vídeo pequeno deve ser enviado num só bloco." });
        const id = `1${rid(32)}`;
        fs.writeFileSync(path.join(videosDir, safe(id)), bytes);
        writeSidecar(path.join(videosDir, safe(id)), { name, size: bytes.length });
        const publicUrl = videoUrl(req, id);
        uploads.set(uploadId, { fileId: id, url: publicUrl, total: bytes.length, done: true });
        return send(res, { ok: true, done: true, provider: "google-drive", fileId: id, url: publicUrl, size: bytes.length, durable: true });
      }

      // vídeo grande: acumula os blocos (o mock faz o merge no fim)
      let st = uploads.get(uploadId);
      if (!st) {
        if (index !== 0) return send(res, { ok: false, error: "Upload não iniciado (esperava o bloco 0)." });
        st = { name, total, parts: [], sent: 0 };
        uploads.set(uploadId, st);
      }
      st.parts.push(bytes);
      st.sent += bytes.length;
      if (st.sent >= total) {
        const id = `1${rid(32)}`;
        const file = path.join(videosDir, safe(id));
        fs.writeFileSync(file, Buffer.concat(st.parts));
        writeSidecar(file, { name, size: st.sent });
        st.done = true;
        st.fileId = id;
        st.url = videoUrl(req, id);
        return send(res, { ok: true, done: true, provider: "google-drive", fileId: id, url: st.url, size: st.sent, durable: true });
      }
      return send(res, { ok: true, done: false, received: st.sent, total });
    }

    if (action === "complete") {
      const st = uploads.get(p.get("id") || "");
      if (!st) return send(res, { ok: false, error: "Upload desconhecido ou expirado." });
      if (!st.done) return send(res, { ok: false, error: "Upload incompleto.", received: st.sent });
      return send(res, { ok: true, done: true, provider: "google-drive", fileId: st.fileId, url: st.url, size: st.total, durable: true });
    }

    if (action === "abort") {
      uploads.delete(p.get("id") || "");
      return send(res, { ok: true, aborted: p.get("id") });
    }

    if (action === "stats") {
      const videos = fs.readdirSync(videosDir).filter((f) => !f.endsWith(".meta.json"));
      const vaults = fs.readdirSync(vaultsDir);
      const bytes = videos.reduce((a, f) => a + fs.statSync(path.join(videosDir, f)).size, 0);
      return send(res, { ok: true, provider: "google-drive", videos: videos.length, vaults: vaults.length, bytes, version: "1.0.0-mock" });
    }

    return send(res, { ok: false, error: "Ação desconhecida: " + action });
  };
}

function sidecarPath(file) {
  return file + ".meta.json";
}
function readSidecar(file) {
  try {
    return JSON.parse(fs.readFileSync(sidecarPath(file), "utf8"));
  } catch {
    return {};
  }
}
function writeSidecar(file, meta) {
  try {
    fs.writeFileSync(sidecarPath(file), JSON.stringify(meta));
  } catch {}
}
