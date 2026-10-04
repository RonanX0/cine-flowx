import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { nvidiaCorsHeaders, proxyNvidiaRequest } from "./server/nvidia-proxy.mjs";
import { createMockCloud } from "./tools/mock-r2-worker.mjs";
import { createMockDrive } from "./tools/mock-drive-backend.mjs";
import path from "node:path";
import fs from "node:fs";

/**
 * Endpoints locais de desenvolvimento:
 *  - /api/public/nvidia          → proxy fixo para a API NVIDIA (a chave vai só para a NVIDIA)
 *  - /api/public/upload-temp     → host "temporário" local (estratégia legacy)
 *  - /api/public/temp-video/*.mp4→ serve o vídeo com Range (200/206) para o crawler da Meta
 *  - /cloud-api/*                → mock local do Worker R2 (testes sem conta Cloudflare)
 *  - /drive-api/*                → mock local do Apps Script Drive (testes sem conta Google)
 */
function apiPlugin(): Plugin {
  const tempVideos = new Map<string, { buffer: Buffer; fileName: string; createdAt: number }>();
  const storeDir = path.resolve(".mock-cloud");
  const handleCloud = createMockCloud({ storeDir, noClaims: false });
  const handleDrive = createMockDrive({ storeDir });

  const readBody = (req: IncomingMessage): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.from(c)));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });

  const sendJson = (res: ServerResponse, status: number, data: unknown) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end(JSON.stringify(data));
  };

  const handleApiMiddleware = async (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void
  ) => {
    const url = req.url || "";

    if (url.startsWith("/api/public/temp-video/")) {
      const id = url.replace("/api/public/temp-video/", "").replace(/\.mp4.*$/i, "");
      const entry = tempVideos.get(id);
      if (!entry) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      const total = entry.buffer.length;
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Accept-Ranges", "bytes");
      if (req.method === "HEAD") {
        res.statusCode = 200;
        res.setHeader("Content-Length", String(total));
        res.end();
        return;
      }
      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10) || 0;
        const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
        res.statusCode = 206;
        res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
        res.setHeader("Content-Length", String(end - start + 1));
        res.end(entry.buffer.subarray(start, end + 1));
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Length", String(total));
      res.end(entry.buffer);
      return;
    }

    if (url.startsWith("/api/public/upload-temp") && req.method === "POST") {
      const body = await readBody(req);
      const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const fileName = String(req.headers["x-file-name"] || "reel.mp4");
      tempVideos.set(id, { buffer: body, fileName, createdAt: Date.now() });
      for (const [k, v] of tempVideos.entries()) {
        if (Date.now() - v.createdAt > 2 * 3600 * 1000) tempVideos.delete(k);
      }
      const host = req.headers.host || "";
      const proto = (req.headers["x-forwarded-proto"] as string) || "http";
      const publicUrl = /^(localhost|127\.0\.0\.1)/i.test(host)
        ? ""
        : `${proto}://${host}/api/public/temp-video/${id}.mp4`;
      sendJson(res, 200, { ok: true, id, url: publicUrl || `/api/public/temp-video/${id}.mp4` });
      return;
    }

    if (url.startsWith("/api/public/nvidia")) {
      for (const [k, v] of Object.entries(nvidiaCorsHeaders)) res.setHeader(k, v);
      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
      }
      const body = req.method === "POST" ? await readBody(req) : undefined;
      const result = await proxyNvidiaRequest({
        method: req.method,
        authorization: req.headers.authorization,
        body,
      });
      for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
      res.statusCode = result.status;
      res.end(result.body);
      return;
    }

    if (url.startsWith("/cloud-api")) {
      const sub = url.slice("/cloud-api".length) || "/";
      try {
        await handleCloud(req, res, sub);
      } catch (err: any) {
        sendJson(res, err?.status || 500, { ok: false, error: err?.message || "Erro interno" });
      }
      return;
    }

    if (url.startsWith("/drive-api")) {
      try {
        await handleDrive(req, res);
      } catch (err: any) {
        sendJson(res, err?.status || 500, { ok: false, error: err?.message || "Erro interno" });
      }
      return;
    }

    next();
  };

  return {
    name: "cineclip-api",
    configureServer(server) {
      server.middlewares.use(handleApiMiddleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handleApiMiddleware);
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), apiPlugin()],
  server: { host: "0.0.0.0", allowedHosts: true },
  preview: { host: "0.0.0.0", allowedHosts: true },
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  optimizeDeps: { exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"] },
});
