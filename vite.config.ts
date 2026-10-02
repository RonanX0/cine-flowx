import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import type { IncomingMessage, ServerResponse } from "http";

const tempVideos = new Map<
  string,
  { buffer: Buffer; fileName: string; createdAt: number }
>();

async function uploadBufferToDirectMp4Host(
  buffer: Buffer,
  fileName: string,
  reqHost?: string,
  reqProto?: string
): Promise<string> {
  const safeName = (fileName || "reel.mp4").replace(/[^a-zA-Z0-9._-]/g, "_");

  // Guarda também em memória no servidor local para servir com Range (HTTP 200/206 video/mp4)
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  tempVideos.set(id, { buffer, fileName: safeName, createdAt: Date.now() });
  // Limpa vídeos com mais de 2 horas
  for (const [k, v] of tempVideos.entries()) {
    if (Date.now() - v.createdAt > 2 * 3600 * 1000) tempVideos.delete(k);
  }

  // 1) Host Principal: uguu.se (CDN Nginx direto que retorna HTTP 200, Content-Type: video/mp4 e Accept-Ranges: bytes para o crawler da Meta/Instagram sem redirect HTML)
  try {
    const form = new FormData();
    form.append(
      "files[]",
      new Blob([buffer], { type: "video/mp4" }),
      safeName.endsWith(".mp4") ? safeName : `${safeName}.mp4`
    );
    const res = await fetch("https://uguu.se/upload", {
      method: "POST",
      body: form,
    });
    if (res.ok) {
      const json: any = await res.json();
      const directUrl: string = json?.files?.[0]?.url || "";
      if (directUrl && directUrl.startsWith("http")) {
        return directUrl;
      }
    }
  } catch {}

  // 2) Fallback: litterbox.catbox.moe (retorna link direto .mp4 em files.catbox.moe / litter.catbox.moe)
  try {
    const form2 = new FormData();
    form2.append("reqtype", "fileupload");
    form2.append("time", "12h");
    form2.append(
      "fileToUpload",
      new Blob([buffer], { type: "video/mp4" }),
      safeName.endsWith(".mp4") ? safeName : `${safeName}.mp4`
    );
    const res2 = await fetch(
      "https://litterbox.catbox.moe/resources/internals/api.php",
      {
        method: "POST",
        body: form2,
      }
    );
    if (res2.ok) {
      const directUrl2 = (await res2.text()).trim();
      if (directUrl2.startsWith("http")) {
        return directUrl2;
      }
    }
  } catch {}

  // 3) Se estiver rodando em domínio público (ex.: e2b.app, ngrok, VPS), usa o endpoint próprio /api/public/temp-video/:id.mp4
  if (reqHost && !/^(localhost|127\.0\.0\.1)/i.test(reqHost)) {
    const proto = reqProto || "https";
    return `${proto}://${reqHost}/api/public/temp-video/${id}.mp4`;
  }

  throw new Error(
    "Não foi possível gerar uma URL direta .mp4 para o Instagram."
  );
}

function apiProxyPlugin(): Plugin {
  const handleApiMiddleware = async (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void
  ) => {
    if (!req.url) return next();

    // Endpoint que serve o MP4 diretamente com suporte a HTTP Range (200 / 206 video/mp4) para o crawler da Meta
    if (req.url.startsWith("/api/public/temp-video/")) {
      const id = req.url
        .replace("/api/public/temp-video/", "")
        .replace(/\.mp4.*$/i, "");
      const entry = tempVideos.get(id);
      if (!entry) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      const total = entry.buffer.length;
      const range = req.headers.range;
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Accept-Ranges", "bytes");

      if (req.method === "HEAD") {
        res.statusCode = 200;
        res.setHeader("Content-Length", String(total));
        res.end();
        return;
      }

      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10) || 0;
        const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
        const chunkSize = end - start + 1;
        res.statusCode = 206;
        res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
        res.setHeader("Content-Length", String(chunkSize));
        res.end(entry.buffer.subarray(start, end + 1));
        return;
      }

      res.statusCode = 200;
      res.setHeader("Content-Length", String(total));
      res.end(entry.buffer);
      return;
    }

    // Endpoint de Upload Direto Binário para o servidor da Meta (rupload.facebook.com)
    if (req.url.startsWith("/api/public/ig-rupload") && req.method === "POST") {
      try {
        const containerId = String(req.headers["x-ig-container-id"] || "").trim();
        const accessToken = String(req.headers["x-ig-access-token"] || "").trim();
        if (!containerId || !accessToken) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "Missing containerId or accessToken" }));
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        }
        const bodyBuffer = Buffer.concat(chunks);

        const upstream = await fetch(
          `https://rupload.facebook.com/ig-api-upload/v21.0/${encodeURIComponent(
            containerId
          )}`,
          {
            method: "POST",
            headers: {
              Authorization: `OAuth ${accessToken}`,
              offset: "0",
              file_size: String(bodyBuffer.length),
              "Content-Type": "application/octet-stream",
              "Content-Length": String(bodyBuffer.length),
            },
            body: bodyBuffer,
          }
        );

        const text = await upstream.text();
        res.statusCode = upstream.status;
        res.setHeader("Content-Type", "application/json");
        res.end(text);
      } catch (err: any) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: err?.message || "rupload failed" }));
      }
      return;
    }

    // Endpoint de Upload Temporário (.mp4 direto sem HTML redirect)
    if (req.url.startsWith("/api/public/upload-temp") && req.method === "GET") {
      try {
        const urlObj = new URL(req.url, "http://localhost");
        const bin = urlObj.searchParams.get("bin") || "";
        const file = urlObj.searchParams.get("file") || "";
        if (!bin || !file) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "Missing bin or file" }));
          return;
        }
        const target = `https://filebin.net/${encodeURIComponent(
          bin
        )}/${encodeURIComponent(file)}`;
        const r = await fetch(target, {
          method: "GET",
          headers: {
            "User-Agent": "facebookexternalhit/1.1",
            Cookie: "verified=2024-05-24",
          },
          redirect: "manual",
        });
        const loc = r.headers.get("location");
        if (loc && loc.startsWith("http")) {
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ url: loc }));
          return;
        }
        throw new Error("Não foi possível obter a URL S3 direta.");
      } catch (err: any) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: err?.message || "Resolve failed" }));
      }
      return;
    }

    if (req.url.startsWith("/api/public/upload-temp") && req.method === "POST") {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        }
        const bodyBuffer = Buffer.concat(chunks);
        const fileName = String(
          req.headers["x-file-name"] || "reel_cineclip.mp4"
        ).replace(/[^a-zA-Z0-9._-]/g, "_");
        const reqHost = String(
          req.headers["x-forwarded-host"] || req.headers.host || ""
        );
        const reqProto = String(req.headers["x-forwarded-proto"] || "https");
        const url = await uploadBufferToDirectMp4Host(
          bodyBuffer,
          fileName,
          reqHost,
          reqProto
        );
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ url }));
      } catch (err: any) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            error: err?.message || "Falha ao gerar URL temporária do vídeo.",
          })
        );
      }
      return;
    }

    if (!req.url.startsWith("/api/public/nvidia")) {
      return next();
    }

    const auth = req.headers["authorization"];
    if (!auth) {
      res.statusCode = 401;
      res.end("Unauthorized");
      return;
    }

    try {
      const isPost = req.method === "POST";
      const targetUrl = isPost
        ? "https://integrate.api.nvidia.com/v1/chat/completions"
        : "https://integrate.api.nvidia.com/v1/models";

      let bodyBuffer: Buffer | undefined;
      if (isPost) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        }
        bodyBuffer = Buffer.concat(chunks);
      }

      const upstream = await fetch(targetUrl, {
        method: isPost ? "POST" : "GET",
        headers: {
          Authorization: String(auth),
          ...(isPost ? { "Content-Type": "application/json" } : {}),
        },
        body: isPost && bodyBuffer ? bodyBuffer : undefined,
      });

      res.statusCode = upstream.status;
      const contentType = upstream.headers.get("content-type");
      if (contentType) {
        res.setHeader("Content-Type", contentType);
      }
      const text = await upstream.text();
      res.end(text);
    } catch (err: any) {
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: err?.message || "Upstream error" }));
    }
  };

  return {
    name: "cineclip-api-proxy",
    configureServer(server) {
      server.middlewares.use(handleApiMiddleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handleApiMiddleware);
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), apiProxyPlugin()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  optimizeDeps: {
    exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"],
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    allowedHosts: true,
  },
  preview: {
    host: "0.0.0.0",
    port: 4173,
    allowedHosts: true,
  },
});
