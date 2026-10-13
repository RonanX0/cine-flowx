const NVIDIA_MODELS_URL = "https://integrate.api.nvidia.com/v1/models";
const NVIDIA_CHAT_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const UPSTREAM_TIMEOUT_MS = 85_000;

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

/**
 * Fixed-destination proxy for the browser's NVIDIA API calls. The caller's key
 * is forwarded only to NVIDIA; this function never stores or logs credentials.
 */
export async function proxyNvidiaRequest({ method, authorization, body }) {
  const verb = String(method || "GET").toUpperCase();
  if (verb !== "GET" && verb !== "POST") {
    return jsonResult(405, { error: "Method not allowed" });
  }
  if (!String(authorization || "").trim()) {
    return jsonResult(401, { error: "Missing NVIDIA Authorization header" });
  }

  const bodyText = verb === "POST" ? bodyToText(body) : "";
  if (verb === "POST" && !bodyText) {
    return jsonResult(400, { error: "Missing JSON request body" });
  }

  let upstream;
  try {
    upstream = await fetch(verb === "POST" ? NVIDIA_CHAT_URL : NVIDIA_MODELS_URL, {
      method: verb,
      headers: {
        Authorization: String(authorization),
        ...(verb === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      ...(verb === "POST" ? { body: bodyText } : {}),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    return jsonResult(502, {
      error: error?.name === "TimeoutError" || error?.name === "AbortError"
        ? "NVIDIA API request timed out"
        : "Could not reach the NVIDIA API",
    });
  }

  let responseBody;
  try {
    responseBody = await upstream.text();
  } catch {
    return jsonResult(502, { error: "Could not read the NVIDIA API response" });
  }

  return {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
    body: responseBody,
  };
}

/*
 * CORS restrito. Antes era `Access-Control-Allow-Origin: *`, o que deixava qualquer
 * outro site usar esta função (e a cota da Vercel/Netlify) como intermediário para a
 * NVIDIA. Agora só respondem com CORS:
 *   • o próprio site (o Origin tem o mesmo host do pedido);
 *   • localhost / 127.0.0.1 (desenvolvimento);
 *   • as origens listadas na variável de ambiente ALLOWED_ORIGINS
 *     (separadas por vírgula, ex.: "https://meu-dominio.com,https://outro.app").
 * Pedidos sem Origin (mesma origem em GET, curl, servidores) não são afetados pelo CORS.
 */
const CORS_BASE = {
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization,Content-Type",
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
export function nvidiaOriginAllowed(origin, host, allowedOrigins) {
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
export function nvidiaCorsHeadersFor(origin, host, allowedOrigins) {
  if (!nvidiaOriginAllowed(origin, host, allowedOrigins)) return null;
  const cleanOrigin = String(origin || "").trim();
  return cleanOrigin
    ? { ...CORS_BASE, "Access-Control-Allow-Origin": cleanOrigin }
    : { ...CORS_BASE };
}

export const nvidiaForbiddenOrigin = {
  status: 403,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", Vary: "Origin" },
  body: JSON.stringify({ error: "Origin not allowed. Add it to ALLOWED_ORIGINS on the server." }),
};
