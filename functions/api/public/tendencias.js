import tendenciasHandler from "../../../api/public/tendencias.js";

// Cloudflare Pages Functions: mantém o mesmo endpoint da Vercel/Netlify/local.
export async function onRequest({ request }, deps = {}) {
  const headers = Object.fromEntries(request.headers);
  headers.host = new URL(request.url).host;
  const result = { status: 200, headers: {}, body: "" };
  const res = {
    get statusCode() { return result.status; },
    set statusCode(v) { result.status = v; },
    setHeader(k, v) { result.headers[k] = v; },
    end(body = "") { result.body = body; },
  };
  await tendenciasHandler({ method: request.method, url: request.url, headers }, res, deps);
  return new Response(result.status === 204 ? null : result.body, { status: result.status, headers: result.headers });
}
