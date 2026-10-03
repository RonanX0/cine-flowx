import { nvidiaCorsHeaders, proxyNvidiaRequest } from "../../server/nvidia-proxy.mjs";

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: nvidiaCorsHeaders, body: "" };
  }

  let body = event.body || "";
  if (event.isBase64Encoded) body = Buffer.from(body, "base64");

  const result = await proxyNvidiaRequest({
    method: event.httpMethod,
    authorization: event.headers?.authorization || event.headers?.Authorization,
    body,
  });

  return {
    statusCode: result.status,
    headers: { ...nvidiaCorsHeaders, ...result.headers },
    body: result.body,
  };
}
