import { iaCorsHeadersFor, iaForbiddenOrigin } from "../../server/ia-proxy.mjs";
import { buscarTendencias } from "../../server/tendencias.mjs";

/**
 * GET /api/public/tendencias?modo=narrados&tags=filmesnarrados&termos=filme%20narrado&perfis=conta1&dias=14&min=20000
 * Devolve os cortes mais «hypados» ou os «Achados de Filmes Narrados» do TikTok
 * (ver server/tendencias.mjs).
 * Com o cabeçalho X-Apify-Token usa o Apify (estável, pago por uso); sem ele, o tikwm.
 * CORS: o próprio site, localhost e ALLOWED_ORIGINS (como o proxy de busca).
 */
const cache = new Map(); // instâncias quentes da Vercel guardam o resultado 10 min
const VALIDADE_MS = 10 * 60 * 1000;

export default async function handler(req, res, deps = {}) {
  const headers = req.headers || {};
  const hostEfetivo = headers["x-forwarded-host"] || headers.host;
  const cors = iaCorsHeadersFor(headers.origin, hostEfetivo);
  if (!cors) {
    Object.entries(iaForbiddenOrigin.headers).forEach(([n, v]) => res.setHeader(n, v));
    res.statusCode = iaForbiddenOrigin.status;
    return res.end(iaForbiddenOrigin.body);
  }
  Object.entries(cors).forEach(([n, v]) => res.setHeader(n, v));
  const responder = (status, corpo) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(corpo));
  };
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "GET") return responder(405, { error: "Usa GET." });

  let q = {};
  try {
    q = Object.fromEntries(new URL(req.url || "", "http://local").searchParams);
  } catch {}
  if (req.query && typeof req.query === "object") q = { ...req.query, ...q };
  if (!q.tags && !q.perfis && !q.termos) {
    return responder(400, { error: "Indica pelo menos uma hashtag (tags), termo de busca (termos) ou perfil (perfis)." });
  }

  const apifyToken = String(headers["x-apify-token"] || "").trim();
  const chave = JSON.stringify([
    q.modo || "cortes",
    q.tags,
    q.termos,
    q.perfis,
    q.dias,
    q.min,
    q.minDur,
    q.maxDur,
    q.narrados,
    q.max,
    apifyToken ? "apify" : "tikwm",
  ]);
  const guardado = cache.get(chave);
  if (guardado && Date.now() - guardado.t < VALIDADE_MS && !q.fresco && !deps.semCache) {
    return responder(200, { ...guardado.dados, daCache: true });
  }

  try {
    const dados = await buscarTendencias(
      {
        modo: q.modo,
        tags: q.tags,
        termos: q.termos,
        perfis: q.perfis,
        dias: q.dias,
        minViews: q.min,
        minDuracao: q.minDur,
        maxDuracao: q.maxDur,
        apenasNarrados: q.narrados === undefined ? undefined : q.narrados !== "0" && q.narrados !== "false",
        max: q.max,
        apifyToken,
      },
      { fetchFn: deps.fetchFn, pausa: deps.pausa }
    );
    if (dados.itens.length) cache.set(chave, { t: Date.now(), dados });
    return responder(200, dados);
  } catch {
    return responder(500, { error: "Falha inesperada ao buscar as tendências." });
  }
}
