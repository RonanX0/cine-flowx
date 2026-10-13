import { nvidiaCorsHeadersFor, nvidiaForbiddenOrigin, proxyNvidiaRequest } from "../../server/nvidia-proxy.mjs";

export default async function handler(req, res) {
  const headers = req.headers || {};
  const cors = nvidiaCorsHeadersFor(headers.origin, headers.host || headers["x-forwarded-host"]);

  if (!cors) {
    Object.entries(nvidiaForbiddenOrigin.headers).forEach(([name, value]) => res.setHeader(name, value));
    res.statusCode = nvidiaForbiddenOrigin.status;
    return res.end(nvidiaForbiddenOrigin.body);
  }
  Object.entries(cors).forEach(([name, value]) => res.setHeader(name, value));

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  try {
    const result = await proxyNvidiaRequest({
      method: req.method,
      authorization: headers.authorization,
      body: req.body,
    });
    Object.entries(result.headers).forEach(([name, value]) => res.setHeader(name, value));
    res.statusCode = result.status;
    res.end(result.body);
  } catch {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "NVIDIA proxy failed" }));
  }
}
