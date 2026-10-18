import { iaCorsHeadersFor, iaForbiddenOrigin, proxyIaRequest } from "../../server/ia-proxy.mjs";

export async function handler(event) {
  const headers = event.headers || {};
  const cors = iaCorsHeadersFor(
    headers.origin || headers.Origin,
    headers.host || headers.Host || headers["x-forwarded-host"]
  );

  if (!cors) {
    return {
      statusCode: iaForbiddenOrigin.status,
      headers: iaForbiddenOrigin.headers,
      body: iaForbiddenOrigin.body,
    };
  }

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }

  let body = event.body || "";
  if (event.isBase64Encoded) body = Buffer.from(body, "base64");

  const result = await proxyIaRequest({ method: event.httpMethod, body });

  return {
    statusCode: result.status,
    headers: { ...cors, ...result.headers },
    body: result.body,
  };
}
