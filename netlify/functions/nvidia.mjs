/**
 * Proxy NVIDIA NIM — serverless function (Netlify Functions).
 * ------------------------------------------------------------------
 * Porque é que isto existe:
 *   O bundle chama `POST /api/public/nvidia` para não apanhar CORS a falar
 *   directamente com a NVIDIA a partir do browser. Como a pasta `api/` não
 *   está no repo, esse endpoint não existia em produção — e o catch-all
 *   `/* -> /index.html` (status 200) devolveva HTML onde a app esperava JSON,
 *   pelo que a identificação de filmes via NVIDIA falhava com um erro obscuro.
 *
 * Rotas:
 *   POST /api/public/nvidia  → encaminha para chat/completions (com a chave que
 *                              o browser envia no cabeçalho Authorization)
 *   GET  /api/public/nvidia  → só valida a chave (usado por "Testar ligação")
 *
 * Segurança:
 *   - O destino é FIXO (nunca vem do cliente) — não é uma open proxy.
 *   - A chave do utilizador vai no cabeçalho Authorization e nunca é logada.
 *   - Só são encaminhados o corpo e os cabeçalhos necessários.
 */

const UPSTREAM = "https://integrate.api.nvidia.com/v1/chat/completions";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });

export default async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const auth = request.headers.get("authorization") || "";
  if (!/^Bearer\s+nvapi-/i.test(auth.trim())) {
    return json(
      {
        error:
          "Cabeçalho Authorization ausente ou mal formado. A chave NVIDIA começa por 'nvapi-'.",
      },
      401
    );
  }

  // Só valida a chave (GET) — a app usa isto no botão "Testar ligação".
  if (request.method === "GET") {
    const probe = await fetch(UPSTREAM, {
      method: "POST",
      headers: {
        Authorization: auth.trim(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "meta/llama-3.2-11b-vision-instruct",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
    });
    if (probe.status === 401 || probe.status === 403) {
      return json({ error: "Chave NVIDIA inválida ou expirada." }, 401);
    }
    return json({ ok: true, provider: "nvidia", reachable: true });
  }

  if (request.method !== "POST") {
    return json({ error: `Método não suportado: ${request.method}` }, 405);
  }

  let payload;
  try {
    const raw = await request.text();
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    return json({ error: "JSON inválido no pedido." }, 400);
  }

  // O destino é FIXO, portanto o `model` nunca influencia o URL — só entra no
  // corpo JSON. Validamo-lo na mesma para não enviar lixo à NVIDIA.
  const modelOk =
    typeof payload.model === "string" &&
    /^[A-Za-z0-9][\w.-]{0,59}$|^[A-Za-z0-9][\w.-]{0,40}\/[\w.-]{1,40}$/.test(payload.model) &&
    !payload.model.includes("..");
  if (!modelOk) {
    return json({ error: "Campo 'model' ausente ou inválido." }, 400);
  }

  const body = {
    model: payload.model,
    messages: Array.isArray(payload.messages) ? payload.messages : [],
    temperature: typeof payload.temperature === "number" ? payload.temperature : 0.65,
    max_tokens: Number(payload.max_tokens) || 1200,
  };

  try {
    const upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: {
        Authorization: auth.trim(),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        ...CORS,
        "Content-Type": upstream.headers.get("content-type") || "application/json",
      },
    });
  } catch (err) {
    return json(
      { error: `Falha ao contactar a NVIDIA: ${err?.message || err}` },
      502
    );
  }
};
