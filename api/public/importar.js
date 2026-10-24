import { Readable } from "node:stream";
import { iaCorsHeadersFor, iaForbiddenOrigin } from "../../server/ia-proxy.mjs";
import { abrirVideo, ErroImportacao, LIMITE_BYTES, nomeDoFicheiro, resolverVideo } from "../../server/importar-video.mjs";

/**
 * GET /api/public/importar?url=<link do TikTok ou do Kwai>[&hd=1][&codec=h264][&download=1]
 * Responde com o .mp4 em streaming e os detalhes em cabeçalhos X-Cineclip-*.
 * Com hd=1 prioriza o stream Full HD (1080p sem marca d'água).
 * O CORS segue a mesma regra do proxy da IA (o próprio site, localhost e ALLOWED_ORIGINS).
 */
export default async function handler(req, res, deps = {}) {
  const fetchFn = deps.fetchFn || fetch;
  const headers = req.headers || {};
  const hostEfetivo = headers["x-forwarded-host"] || headers.host;
  const cors = iaCorsHeadersFor(headers.origin, hostEfetivo);

  if (!cors) {
    Object.entries(iaForbiddenOrigin.headers).forEach(([n, v]) => res.setHeader(n, v));
    res.statusCode = iaForbiddenOrigin.status;
    return res.end(iaForbiddenOrigin.body);
  }
  Object.entries({
    ...cors,
    "Access-Control-Expose-Headers":
      "X-Cineclip-Nome, X-Cineclip-Plataforma, X-Cineclip-Autor, X-Cineclip-Titulo, X-Cineclip-Codec, X-Cineclip-Qualidade, X-Cineclip-Tamanho, X-Cineclip-Duracao, Content-Length, Content-Disposition",
  }).forEach(([n, v]) => res.setHeader(n, v));

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "GET") return erro(res, 405, "Usa GET com ?url=");

  let params = new URLSearchParams();
  try {
    params = new URL(req.url || "", "http://local").searchParams;
  } catch {}
  let link = params.get("url") || "";
  if (!link && req.query && typeof req.query.url === "string") link = req.query.url;
  if (!link) return erro(res, 400, "Falta o parâmetro url.");

  const hdParam = params.get("hd") || (req.query && req.query.hd) || "";
  const qualParam = params.get("qualidade") || (req.query && req.query.qualidade) || "";
  const codecParam = params.get("codec") || (req.query && req.query.codec) || "";
  const downloadParam = params.get("download") || (req.query && req.query.download) || "";

  const altaQualidade = hdParam === "1" || hdParam === "true" || qualParam === "alta" || qualParam === "hd";
  const preferirCodec = String(codecParam || "").toLowerCase();
  const comoAnexo = downloadParam === "1" || downloadParam === "true";

  let aberto;
  let info;
  try {
    info = await resolverVideo(link, { fetchFn, altaQualidade, preferirCodec });
    aberto = await abrirVideo(info, { fetchFn });
  } catch (e) {
    const estado = e instanceof ErroImportacao ? e.estado : 500;
    return erro(res, estado, e instanceof ErroImportacao ? e.message : "Falha inesperada ao importar o vídeo.");
  }

  const { resposta, candidato, tamanho } = aberto;
  const cabecalho = (v) => encodeURIComponent(String(v || "").slice(0, 200));
  const nome = nomeDoFicheiro(info);
  const qualidade = candidato.qualidade || (candidato.altura ? `${candidato.altura}p` : "sd");
  const tamanhoTotal = tamanho || Number(candidato.tamanho) || 0;

  res.statusCode = 200;
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Cineclip-Nome", cabecalho(nome));
  res.setHeader("X-Cineclip-Plataforma", info.plataforma);
  res.setHeader("X-Cineclip-Autor", cabecalho(info.autor));
  res.setHeader("X-Cineclip-Titulo", cabecalho(info.titulo));
  res.setHeader("X-Cineclip-Codec", cabecalho(candidato.codec));
  res.setHeader("X-Cineclip-Qualidade", cabecalho(qualidade));
  res.setHeader("X-Cineclip-Tamanho", String(tamanhoTotal));
  res.setHeader("X-Cineclip-Duracao", String(info.duracao || 0));
  if (comoAnexo) {
    res.setHeader("Content-Disposition", `attachment; filename="${nome.replace(/[^a-zA-Z0-9._-]/g, "_")}"`);
  }
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
