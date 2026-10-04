#!/usr/bin/env node
/**
 * Servidor de preview do CineClip + mock do Cloudflare Worker (R2).
 *
 *   node tools/dev-server.mjs            # http://0.0.0.0:4173
 *   PORT=8080 node tools/dev-server.mjs
 *   DIST=1 node tools/dev-server.mjs     # serve dist/ (o que vai mesmo para o ar)
 *
 *  - serve os ficheiros estáticos do repo (index.html, nuvem-duravel.js, …)
 *  - com DIST=1 serve o resultado de `npm run build`: é a única forma de ver localmente
 *    o carimbo `window.CINECLIP_BUILD` e o `nuvem-duravel.js?v=<hash>` do deploy real
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
import { createMockDrive } from "./mock-drive-backend.mjs";

const root = path.resolve(import.meta.dirname, "..");
/* Raiz dos estáticos: o repositório, ou dist/ com DIST=1 para conferir o deploy real. */
const estaticos = process.env.DIST === "1" ? path.join(root, "dist") : root;
if (process.env.DIST === "1" && !fs.existsSync(path.join(estaticos, "index.html"))) {
  console.error("❌ dist/index.html não existe. Corre primeiro: npm run build");
  process.exit(1);
}
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const CLOUD_PREFIX = "/cloud-api";
const DRIVE_PREFIX = "/drive-api";

const storeDir = path.join(root, ".mock-cloud");
const handleCloud = createMockCloud({ storeDir });
const handleDrive = createMockDrive({ storeDir });

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
  const url = new URL(req.url, "http://localhost");
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad Request: malformed URL encoding");
    return;
  }

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

  if (pathname === DRIVE_PREFIX || pathname.startsWith(DRIVE_PREFIX + "/")) {
    try {
      await handleDrive(req, res);
    } catch (err) {
      const status = err && err.status ? err.status : 500;
      res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: false, error: err && err.message ? err.message : "Erro interno" }));
    }
    console.log(`📁 ${req.method} ${pathname}${url.search} → ${res.statusCode}`);
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" }).end("Method Not Allowed");
    return;
  }

  const requestedPath = pathname === "/" ? "index.html" : pathname.startsWith("/") ? pathname.slice(1) : pathname;
  let filePath = path.resolve(estaticos, requestedPath);
  const relativePath = path.relative(estaticos, filePath);
  if (relativePath === ".." || relativePath.startsWith(".." + path.sep) || path.isAbsolute(relativePath)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  // O preview não deve servir dados locais, dependências ou o repositório Git.
  if (relativePath.split(path.sep).some((part) => part.startsWith(".") || part === "node_modules")) {
    res.writeHead(404).end("Not Found");
    return;
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, "index.html");
  }
  if (!fs.existsSync(filePath)) {
    // SPA fallback (mesmo comportamento do _redirects / vercel.json)
    filePath = path.join(estaticos, "index.html");
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
  console.log(`📄 ${req.method} ${pathname} → ${path.relative(estaticos, filePath)}`);
});

server.listen(PORT, HOST, () => {
  console.log(`\n🎬 CineClip preview  →  http://${HOST}:${PORT}`,
    `\n     A servir          : ${path.relative(root, estaticos) || "."}/ ${estaticos === root ? "(repositório)" : "(build de produção)"}`,
    `\n☁️  Mock R2           →  http://${HOST}:${PORT}${CLOUD_PREFIX}`,
    `\n     Worker URL no app : ${CLOUD_PREFIX}`,
    `\n     Token             : ${process.env.MOCK_CLOUD_TOKEN || "cc_r2_token_de_teste"}`,
    `\n📁 Mock Google Drive  →  http://${HOST}:${PORT}${DRIVE_PREFIX}?action=health`,
    `\n     URL no app        : ${DRIVE_PREFIX}`,
    `\n     Token             : ${process.env.MOCK_DRIVE_TOKEN || "cc_drive_token_de_teste"}`,
    `\n     Ficheiros em      : ${path.relative(root, storeDir)}/\n`);
});
