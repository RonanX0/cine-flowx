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

export const nvidiaCorsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization,Content-Type",
  "Access-Control-Max-Age": "86400",
};
