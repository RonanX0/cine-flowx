import tendenciasHandler from "../../api/public/tendencias.js";

// Reutiliza o endpoint validado: mesmos filtros, cache e CORS da Vercel/local.
export async function handler(event, context, deps = {}) {
  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const query = new URLSearchParams(event.queryStringParameters || {});
  const req = { method: event.httpMethod, headers, url: "/api/public/tendencias?" + query };
  const result = { statusCode: 200, headers: {}, body: "" };
  const res = {
    get statusCode() { return result.statusCode; },
    set statusCode(v) { result.statusCode = v; },
    setHeader(k, v) { result.headers[k] = v; },
    end(body = "") { result.body = body; },
  };
  await tendenciasHandler(req, res, deps);
  return result;
}
