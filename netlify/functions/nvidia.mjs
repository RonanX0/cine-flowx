import { nvidiaCorsHeadersFor, nvidiaForbiddenOrigin, proxyNvidiaRequest } from "../../server/nvidia-proxy.mjs";

export async function handler(event) {
  const headers = event.headers || {};
  const cors = nvidiaCorsHeadersFor(
    headers.origin || headers.Origin,
    headers.host || headers.Host || headers["x-forwarded-host"]
  );

  if (!cors) {
    return {
      statusCode: nvidiaForbiddenOrigin.status,
      headers: nvidiaForbiddenOrigin.headers,
      body: nvidiaForbiddenOrigin.body,
    };
  }

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }

  let body = event.body || "";
  if (event.isBase64Encoded) body = Buffer.from(body, "base64");

  const result = await proxyNvidiaRequest({
    method: event.httpMethod,
    authorization: headers.authorization || headers.Authorization,
    body,
  });

  return {
    statusCode: result.status,
    headers: { ...cors, ...result.headers },
    body: result.body,
  };
}
