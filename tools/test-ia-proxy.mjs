#!/usr/bin/env node
import assert from "node:assert/strict";
import vercelHandler from "../api/public/ia.js";
import { handler as netlifyHandler } from "../netlify/functions/ia.mjs";
import { iaOriginAllowed, proxyIaRequest } from "../server/ia-proxy.mjs";

const originalFetch = globalThis.fetch;
let calls = [];
const check = (name, fn) => fn().then(() => console.log(`✔ ${name}`));
const pedido = (o) => JSON.stringify(o);
const res = () => ({ headers: new Map(), setHeader(n, v) { this.headers.set(n.toLowerCase(), v); }, end(b) { this.body = b; } });

try {
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response('{"organic":[]}', { status: 200, headers: { "Content-Type": "application/json" } });
  };

  await check("Serper: encaminha só para google.serper.dev/search com a chave", async () => {
    const r = await proxyIaRequest({ method: "POST", body: pedido({ url: "https://google.serper.dev/search", headers: { "X-API-KEY": "k1", "Content-Type": "application/json", Authorization: "x" }, body: '{"q":"a"}' }) });
    assert.equal(r.status, 200);
    assert.equal(calls[0].url, "https://google.serper.dev/search");
    assert.equal(calls[0].options.headers["X-API-KEY"], "k1");
    assert.equal("Authorization" in calls[0].options.headers, false);
    assert.equal(calls[0].options.body, '{"q":"a"}');
  });

  await check("Serper sem chave → 401 sem chamar", async () => {
    calls = [];
    const r = await proxyIaRequest({ method: "POST", body: pedido({ url: "https://google.serper.dev/search", body: "{}" }) });
    assert.equal(r.status, 401);
    assert.equal(calls.length, 0);
  });

  await check("DuckDuckGo: permitido em /html/", async () => {
    calls = [];
    const r = await proxyIaRequest({ method: "POST", body: pedido({ url: "https://html.duckduckgo.com/html/", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "q=teste" }) });
    assert.equal(r.status, 200);
    assert.equal(calls[0].url, "https://html.duckduckgo.com/html/");
  });

  await check("não é proxy aberto: outros destinos/caminhos/protocolos → 403", async () => {
    calls = [];
    for (const url of ["https://api.groq.com/openai/v1/models", "https://google.serper.dev/outra", "http://google.serper.dev/search", "https://evil.example/search", "https://google.serper.dev:8443/search", "https://html.duckduckgo.com.evil.example/html/"]) {
      const r = await proxyIaRequest({ method: "POST", body: pedido({ url, headers: { "X-API-KEY": "k" }, body: "{}" }) });
      assert.equal(r.status, 403, url);
    }
    assert.equal(calls.length, 0);
  });

  await check("método ≠ POST → 405; JSON inválido → 400; url inválida → 400", async () => {
    assert.equal((await proxyIaRequest({ method: "GET" })).status, 405);
    assert.equal((await proxyIaRequest({ method: "POST", body: "{x" })).status, 400);
    assert.equal((await proxyIaRequest({ method: "POST", body: pedido({ url: "nao-e-url" }) })).status, 400);
  });

  await check("falha de rede → 502 sem expor a chave", async () => {
    globalThis.fetch = async () => { throw new Error("network error"); };
    const r = await proxyIaRequest({ method: "POST", body: pedido({ url: "https://google.serper.dev/search", headers: { "X-API-KEY": "chave-privada" }, body: "{}" }) });
    assert.equal(r.status, 502);
    assert.equal(r.body.includes("chave-privada"), false);
  });

  calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response('{"ok":true}', { status: 200, headers: { "Content-Type": "application/json" } });
  };

  await check("handler Vercel responde com CORS do próprio site", async () => {
    const response = res();
    await vercelHandler({ method: "POST", headers: { host: "cine-flowx.vercel.app", origin: "https://cine-flowx.vercel.app" }, body: pedido({ url: "https://google.serper.dev/search", headers: { "X-API-KEY": "k" }, body: "{}" }) }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, '{"ok":true}');
    assert.equal(response.headers.get("access-control-allow-origin"), "https://cine-flowx.vercel.app");
  });

  await check("handler Vercel responde OPTIONS sem chamar a API", async () => {
    calls = [];
    const response = res();
    await vercelHandler({ method: "OPTIONS", headers: {} }, response);
    assert.equal(response.statusCode, 204);
    assert.equal(calls.length, 0);
  });

  await check("handler Netlify encaminha POST", async () => {
    calls = [];
    const r = await netlifyHandler({ httpMethod: "POST", headers: { host: "cineclip.netlify.app", origin: "https://cineclip.netlify.app" }, body: pedido({ url: "https://html.duckduckgo.com/html/", body: "q=a" }) });
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers["Access-Control-Allow-Origin"], "https://cineclip.netlify.app");
    assert.equal(calls.length, 1);
  });

  await check("CORS: recusa outro site (Vercel e Netlify)", async () => {
    calls = [];
    const response = res();
    await vercelHandler({ method: "POST", headers: { host: "cine-flowx.vercel.app", origin: "https://site-alheio.example" }, body: "{}" }, response);
    assert.equal(response.statusCode, 403);
    assert.equal(response.headers.has("access-control-allow-origin"), false);
    const n = await netlifyHandler({ httpMethod: "OPTIONS", headers: { host: "cineclip.netlify.app", origin: "https://site-alheio.example" } });
    assert.equal(n.statusCode, 403);
    assert.equal(calls.length, 0);
  });

  await check("CORS: aceita localhost, ALLOWED_ORIGINS e pedidos sem Origin", async () => {
    assert.equal(iaOriginAllowed("http://localhost:5173", "cine-flowx.vercel.app", ""), true);
    assert.equal(iaOriginAllowed("https://meu-dominio.com", "cine-flowx.vercel.app", "https://meu-dominio.com/, https://x.app"), true);
    assert.equal(iaOriginAllowed("https://cine-flowx.vercel.app.evil.example", "cine-flowx.vercel.app", ""), false);
    assert.equal(iaOriginAllowed("null", "cine-flowx.vercel.app", ""), false);
    assert.equal(iaOriginAllowed("", "cine-flowx.vercel.app", ""), true);
  });

  console.log("\n✅ testes do proxy de busca passaram");
} finally {
  globalThis.fetch = originalFetch;
}
