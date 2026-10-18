import { iaCorsHeadersFor, iaForbiddenOrigin, proxyIaRequest } from "../../server/ia-proxy.mjs";

export default async function handler(req, res) {
  const headers = req.headers || {};
  const cors = iaCorsHeadersFor(headers.origin, headers.host || headers["x-forwarded-host"]);

  if (!cors) {
    Object.entries(iaForbiddenOrigin.headers).forEach(([name, value]) => res.setHeader(name, value));
    res.statusCode = iaForbiddenOrigin.status;
    return res.end(iaForbiddenOrigin.body);
  }
  Object.entries(cors).forEach(([name, value]) => res.setHeader(name, value));

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  try {
    const result = await proxyIaRequest({ method: req.method, body: req.body });
    Object.entries(result.headers).forEach(([name, value]) => res.setHeader(name, value));
    res.statusCode = result.status;
    res.end(result.body);
  } catch {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Search proxy failed" }));
  }
}
