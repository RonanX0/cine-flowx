import { waitUntil } from "@vercel/functions";
import ffmpegStatic from "ffmpeg-static";
import { estadoDaNuvem, trabalharNaVercel } from "../servidor/vercel.mjs";

/**
 * ☁️ /api/nuvem — processa na Vercel os links que o celular manda para a nuvem.
 *
 *   GET  → { configurado } — o app usa para mostrar «☁️ Processar na nuvem».
 *   POST → responde logo (202) e trata 1 link em segundo plano (até 5 min); se
 *          ficarem mais, chama-se outra vez.
 *
 * Configuração: variável CINECLIP_CHAVE_SERVIDOR na Vercel (ver servidor/README.md).
 */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method === "GET") return responder(res, 200, estadoDaNuvem());
  if (req.method !== "POST") return responder(res, 405, { ok: false, erro: "Usa GET ou POST." });

  const estado = estadoDaNuvem();
  if (!estado.configurado) return responder(res, 503, estado);

  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  const origem = host ? "https://" + host : "";
  waitUntil(
    trabalharNaVercel({ origem, ffmpeg: ffmpegStatic || "" })
      .then(async (r) => {
        console.log("[nuvem]", JSON.stringify(r));
        // Ainda há links? Novo pedido (com os seus próprios 5 minutos).
        if (r.restantes > 0 && origem) {
          await fetch(origem + "/api/nuvem", { method: "POST", signal: AbortSignal.timeout(8000) }).catch(() => {});
        }
      })
      .catch((e) => console.error("[nuvem] falhou:", (e && e.stack) || e))
  );
  return responder(res, 202, { ok: true, aceite: true });
}

function responder(res, status, corpo) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(corpo));
}
