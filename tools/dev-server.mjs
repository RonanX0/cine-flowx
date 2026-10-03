#!/usr/bin/env node
/**
 * Servidor de preview do CineClip + mock do Cloudflare Worker (R2).
 *
 *   node tools/dev-server.mjs            # http://0.0.0.0:4173
 *   PORT=8080 node tools/dev-server.mjs
 *
 *  - serve os ficheiros estáticos do repo (index.html, nuvem-duravel.js, …)
 *  - monta a API da nuvem em /cloud-api/*  (mock local do cloudflare/r2-worker.js)
 *
 * No preview, abre Configurações → Nuvem durável e usa:
 *      Worker URL : /cloud-api
 *      Token      : cc_r2_token_de_teste
 * Assim testas o fluxo real (upload do .mp4 → link durável → cofre) sem conta Cloudflare.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createMockCloud } from "./mock-r2-worker.mjs";

const root = path.resolve(import.meta.dirname, "..");
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const CLOUD_PREFIX = "/cloud-api";

const storeDir = path.join(root, ".mock-cloud");
const handleCloud = createMockCloud({ storeDir });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === CLOUD_PREFIX || pathname.startsWith(CLOUD_PREFIX + "/")) {
    const subPath = pathname.slice(CLOUD_PREFIX.length) || "/";
    try {
      await handleCloud(req, res, subPath);
    } catch (err) {
      const status = err && err.status ? err.status : 500;
      res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: false, error: err && err.message ? err.message : "Erro interno" }));
    }
    console.log(`☁️  ${req.method} ${pathname} → ${res.statusCode}`);
    return;
  }

  let filePath = path.join(root, pathname === "/" ? "index.html" : pathname);
  if (!filePath.startsWith(root)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, "index.html");
  }
  if (!fs.existsSync(filePath)) {
    // SPA fallback (mesmo comportamento do _redirects / vercel.json)
    filePath = path.join(root, "index.html");
  }

  const ext = path.extname(filePath).toLowerCase();
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Content-Length": String(stat.size),
    "Cache-Control": "no-cache",
    "Access-Control-Allow-Origin": "*",
  });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(filePath).pipe(res);
  console.log(`📄 ${req.method} ${pathname} → ${path.relative(root, filePath)}`);
});

server.listen(PORT, HOST, () => {
  console.log(`
🎬 CineClip preview  →  http://${HOST}:${PORT}
☁️  Mock da nuvem R2 →  http://${HOST}:${PORT}${CLOUD_PREFIX}
     Worker URL a usar no app : ${CLOUD_PREFIX}
     Token                    : ${process.env.MOCK_CLOUD_TOKEN || "cc_r2_token_de_teste"}
     Ficheiros guardados em   : ${path.relative(root, storeDir)}/
`);
});
