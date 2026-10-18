const UPSTREAM_TIMEOUT_MS = 30_000;
const MAX_RESPOSTA = 2_000_000;

/*
 * Proxy de destino fixo para as buscas (Serper e DuckDuckGo): estes dois não aceitam
 * chamadas direto do browser (CORS), por isso o app pede ao servidor. Só estes endereços
 * são permitidos — a função não é um proxy aberto. A chave do Serper passa só para o
 * Serper e nunca é guardada nem registada. (Groq e OpenRouter aceitam CORS e são
 * chamados direto do browser.)
 */
const DESTINOS = {
  "google.serper.dev": { caminho: "/search", cabecalhos: ["x-api-key", "content-type"] },
  "html.duckduckgo.com": { caminho: "/html/", cabecalhos: ["content-type"] },
};

function jsonResult(status, data) {
  return {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    body: JSON.stringify(data),
  };
}

function bodyToText(body) {
  if (body == null) return "";
  if (typeof body === "string") return body;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(body)) return body.toString("utf8");
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return JSON.stringify(body);
}

/** Corpo esperado: { url, method:"POST", headers:{}, body:"texto" }. */
export async function proxyIaRequest({ method, body }) {
  if (String(method || "POST").toUpperCase() !== "POST") return jsonResult(405, { error: "Method not allowed" });
  let pedido;
  try {
    pedido = JSON.parse(bodyToText(body) || "{}");
  } catch {
    return jsonResult(400, { error: "Invalid JSON body" });
  }
  let alvo;
  try {
    alvo = new URL(String(pedido.url || ""));
  } catch {
    return jsonResult(400, { error: "Invalid url" });
  }
  const destino = DESTINOS[alvo.hostname];
  if (alvo.protocol !== "https:" || !destino || alvo.pathname !== destino.caminho || alvo.port) {
    return jsonResult(403, { error: "Destination not allowed" });
  }
  const cabecalhos = {};
  for (const [nome, valor] of Object.entries(pedido.headers || {})) {
    if (destino.cabecalhos.includes(String(nome).toLowerCase())) cabecalhos[nome] = String(valor);
  }
  if (alvo.hostname === "google.serper.dev" && !cabecalhos["X-API-KEY"] && !cabecalhos["x-api-key"]) {
    return jsonResult(401, { error: "Missing Serper key" });
  }
  if (alvo.hostname === "html.duckduckgo.com") {
    cabecalhos["User-Agent"] = "Mozilla/5.0 (compatible; CineClip/1.0)";
  }

  let upstream;
  try {
    upstream = await fetch(alvo.toString(), {
      method: "POST",
      headers: cabecalhos,
      body: typeof pedido.body === "string" ? pedido.body : JSON.stringify(pedido.body ?? {}),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    return jsonResult(502, {
      error: error?.name === "TimeoutError" || error?.name === "AbortError" ? "Search request timed out" : "Could not reach the search API",
    });
  }
  let texto;
  try {
    texto = (await upstream.text()).slice(0, MAX_RESPOSTA);
  } catch {
    return jsonResult(502, { error: "Could not read the search response" });
  }
  return {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("content-type") || "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
    body: texto,
  };
}

/*
 * CORS restrito. Antes era `Access-Control-Allow-Origin: *`, o que deixava qualquer
 * outro site usar esta função (e a cota da Vercel/Netlify) como intermediário para as
 * APIs de busca. Agora só respondem com CORS:
 *   • o próprio site (o Origin tem o mesmo host do pedido);
 *   • localhost / 127.0.0.1 (desenvolvimento);
 *   • as origens listadas na variável de ambiente ALLOWED_ORIGINS
 *     (separadas por vírgula, ex.: "https://meu-dominio.com,https://outro.app").
 * Pedidos sem Origin (mesma origem em GET, curl, servidores) não são afetados pelo CORS.
 */
const CORS_BASE = {
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
};

function hostOf(value) {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return "";
  }
}

function extraOrigins(env) {
  return String(env ?? (typeof process !== "undefined" ? process.env?.ALLOWED_ORIGINS : "") ?? "")
    .split(",")
    .map((item) => item.trim().replace(/\/+$/, "").toLowerCase())
    .filter(Boolean);
}

/** true quando o Origin pode usar o proxy a partir do browser. */
export function iaOriginAllowed(origin, host, allowedOrigins) {
  const cleanOrigin = String(origin || "").trim().replace(/\/+$/, "").toLowerCase();
  if (!cleanOrigin) return true;
  const originHost = hostOf(cleanOrigin);
  if (!originHost) return false;
  if (host && originHost === String(host).trim().toLowerCase()) return true;
  const hostname = originHost.replace(/:\d+$/, "");
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") return true;
  return extraOrigins(allowedOrigins).includes(cleanOrigin);
}

/** Cabeçalhos CORS para um pedido (`null` quando a origem não é permitida). */
export function iaCorsHeadersFor(origin, host, allowedOrigins) {
  if (!iaOriginAllowed(origin, host, allowedOrigins)) return null;
  const cleanOrigin = String(origin || "").trim();
  return cleanOrigin
    ? { ...CORS_BASE, "Access-Control-Allow-Origin": cleanOrigin }
    : { ...CORS_BASE };
}

export const iaForbiddenOrigin = {
  status: 403,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", Vary: "Origin" },
  body: JSON.stringify({ error: "Origin not allowed. Add it to ALLOWED_ORIGINS on the server." }),
};
