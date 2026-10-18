import { Readable } from "node:stream";
import { iaCorsHeadersFor, iaForbiddenOrigin } from "../../server/ia-proxy.mjs";
import { abrirVideo, ErroImportacao, LIMITE_BYTES, nomeDoFicheiro, resolverVideo } from "../../server/importar-video.mjs";

/**
 * GET /api/public/importar?url=<link do TikTok ou do Kwai>
 * Responde com o .mp4 em streaming e os detalhes em cabeçalhos X-Cineclip-*.
 * O CORS segue a mesma regra do proxy da NVIDIA (o próprio site, localhost e
 * ALLOWED_ORIGINS).
 */
export default async function handler(req, res, deps = {}) {
  const fetchFn = deps.fetchFn || fetch;
  const headers = req.headers || {};
  const cors = iaCorsHeadersFor(headers.origin, headers.host || headers["x-forwarded-host"]);

  if (!cors) {
    Object.entries(iaForbiddenOrigin.headers).forEach(([n, v]) => res.setHeader(n, v));
    res.statusCode = iaForbiddenOrigin.status;
    return res.end(iaForbiddenOrigin.body);
  }
  Object.entries({
    ...cors,
    "Access-Control-Expose-Headers": "X-Cineclip-Nome, X-Cineclip-Plataforma, X-Cineclip-Autor, X-Cineclip-Titulo, X-Cineclip-Codec, X-Cineclip-Duracao, Content-Length",
  }).forEach(([n, v]) => res.setHeader(n, v));

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "GET") return erro(res, 405, "Usa GET com ?url=");

  let link = "";
  try {
    link = new URL(req.url || "", "http://local").searchParams.get("url") || "";
  } catch {}
  if (!link && req.query && typeof req.query.url === "string") link = req.query.url;
  if (!link) return erro(res, 400, "Falta o parâmetro url.");

  let aberto;
  let info;
  try {
    info = await resolverVideo(link, { fetchFn });
    aberto = await abrirVideo(info, { fetchFn });
  } catch (e) {
    const estado = e instanceof ErroImportacao ? e.estado : 500;
    return erro(res, estado, e instanceof ErroImportacao ? e.message : "Falha inesperada ao importar o vídeo.");
  }

  const { resposta, candidato, tamanho } = aberto;
  const cabecalho = (v) => encodeURIComponent(String(v || "").slice(0, 200));
  res.statusCode = 200;
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Cineclip-Nome", cabecalho(nomeDoFicheiro(info)));
  res.setHeader("X-Cineclip-Plataforma", info.plataforma);
  res.setHeader("X-Cineclip-Autor", cabecalho(info.autor));
  res.setHeader("X-Cineclip-Titulo", cabecalho(info.titulo));
  res.setHeader("X-Cineclip-Codec", cabecalho(candidato.codec));
  res.setHeader("X-Cineclip-Duracao", String(info.duracao || 0));
  if (tamanho) res.setHeader("Content-Length", String(tamanho));

  let enviados = 0;
  const corpo = Readable.fromWeb(resposta.body);
  await new Promise((resolve) => {
    corpo.on("data", (parte) => {
      enviados += parte.length;
      if (enviados > LIMITE_BYTES) {
        corpo.destroy();
        res.destroy();
        return resolve();
      }
      if (!res.write(parte)) {
        corpo.pause();
        res.once("drain", () => corpo.resume());
      }
    });
    corpo.on("end", () => {
      res.end();
      resolve();
    });
    corpo.on("error", () => {
      res.destroy();
      resolve();
    });
  });
}

function erro(res, estado, mensagem) {
  res.statusCode = estado;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ error: mensagem }));
}
