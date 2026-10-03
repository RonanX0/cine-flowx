import { nvidiaCorsHeaders, proxyNvidiaRequest } from "../../server/nvidia-proxy.mjs";

export default async function handler(req, res) {
  Object.entries(nvidiaCorsHeaders).forEach(([name, value]) => res.setHeader(name, value));

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  try {
    const result = await proxyNvidiaRequest({
      method: req.method,
      authorization: req.headers?.authorization,
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
