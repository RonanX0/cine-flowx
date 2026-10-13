#!/usr/bin/env node
import assert from "node:assert/strict";
import vercelHandler from "../api/public/nvidia.js";
import { handler as netlifyHandler } from "../netlify/functions/nvidia.mjs";
import { nvidiaOriginAllowed, proxyNvidiaRequest } from "../server/nvidia-proxy.mjs";

const originalFetch = globalThis.fetch;
let calls = [];
const check = (name, fn) => fn().then(() => console.log(`✔ ${name}`));

try {
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  await check("recusa pedido sem chave sem chamar NVIDIA", async () => {
    calls = [];
    const result = await proxyNvidiaRequest({ method: "GET" });
    assert.equal(result.status, 401);
    assert.equal(calls.length, 0);
  });

  await check("GET autenticado consulta apenas o endpoint de modelos", async () => {
    calls = [];
    const result = await proxyNvidiaRequest({ method: "GET", authorization: "Bearer nvapi-test" });
    assert.equal(result.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://integrate.api.nvidia.com/v1/models");
    assert.equal(calls[0].options.headers.Authorization, "Bearer nvapi-test");
    assert.equal(calls[0].options.body, undefined);
  });

  await check("POST encaminha JSON e mantém o destino fixo", async () => {
    calls = [];
    const payload = { model: "test-model", messages: [{ role: "user", content: "Olá" }] };
    await proxyNvidiaRequest({ method: "POST", authorization: "Bearer nvapi-test", body: payload });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://integrate.api.nvidia.com/v1/chat/completions");
    assert.equal(calls[0].options.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(calls[0].options.body), payload);
  });

  await check("encaminha status e corpo de erro do upstream", async () => {
    globalThis.fetch = async () => new Response('{"error":"rate limited"}', {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
    const result = await proxyNvidiaRequest({ method: "GET", authorization: "Bearer nvapi-test" });
    assert.equal(result.status, 429);
    assert.equal(result.body, '{"error":"rate limited"}');
  });

  await check("rejeita método inesperado e corpo vazio", async () => {
    const method = await proxyNvidiaRequest({ method: "DELETE", authorization: "Bearer nvapi-test" });
    const body = await proxyNvidiaRequest({ method: "POST", authorization: "Bearer nvapi-test" });
    assert.equal(method.status, 405);
    assert.equal(body.status, 400);
  });

  await check("converte falha de rede em 502 sem expor a chave", async () => {
    globalThis.fetch = async () => { throw new Error("network error"); };
    const result = await proxyNvidiaRequest({ method: "GET", authorization: "Bearer private-key" });
    assert.equal(result.status, 502);
    assert.equal(result.body.includes("private-key"), false);
  });

  calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response('{"ok":true}', {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  await check("handler Vercel devolve resposta com CORS e status corretos", async () => {
    const response = {
      headers: new Map(),
      setHeader(name, value) { this.headers.set(name.toLowerCase(), value); },
      end(body) { this.body = body; },
    };
    await vercelHandler({
      method: "GET",
      headers: { authorization: "Bearer nvapi-test", host: "cine-flowx.vercel.app", origin: "https://cine-flowx.vercel.app" },
    }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, '{"ok":true}');
    assert.equal(response.headers.get("access-control-allow-origin"), "https://cine-flowx.vercel.app");
    assert.equal(calls.length, 1);
  });

  await check("handler Vercel responde OPTIONS sem chamar NVIDIA", async () => {
    calls = [];
    const response = {
      headers: new Map(),
      setHeader(name, value) { this.headers.set(name.toLowerCase(), value); },
      end(body) { this.body = body; },
    };
    await vercelHandler({ method: "OPTIONS", headers: {} }, response);
    assert.equal(response.statusCode, 204);
    assert.equal(response.body, undefined);
    assert.equal(calls.length, 0);
  });

  await check("handler Netlify encaminha POST e devolve o JSON da API", async () => {
    calls = [];
    const response = await netlifyHandler({
      httpMethod: "POST",
      headers: { authorization: "Bearer nvapi-test", host: "cineclip.netlify.app", origin: "https://cineclip.netlify.app" },
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, '{"ok":true}');
    assert.equal(response.headers["Access-Control-Allow-Origin"], "https://cineclip.netlify.app");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://integrate.api.nvidia.com/v1/chat/completions");
  });

  await check("CORS: recusa outro site sem chamar a NVIDIA (Vercel)", async () => {
    calls = [];
    const response = {
      headers: new Map(),
      setHeader(name, value) { this.headers.set(name.toLowerCase(), value); },
      end(body) { this.body = body; },
    };
    await vercelHandler({
      method: "POST",
      headers: { authorization: "Bearer nvapi-test", host: "cine-flowx.vercel.app", origin: "https://site-alheio.example" },
      body: "{}",
    }, response);
    assert.equal(response.statusCode, 403);
    assert.equal(response.headers.has("access-control-allow-origin"), false);
    assert.equal(calls.length, 0);
  });

  await check("CORS: recusa outro site no preflight (Netlify)", async () => {
    calls = [];
    const response = await netlifyHandler({
      httpMethod: "OPTIONS",
      headers: { host: "cineclip.netlify.app", origin: "https://site-alheio.example" },
    });
    assert.equal(response.statusCode, 403);
    assert.equal("Access-Control-Allow-Origin" in response.headers, false);
    assert.equal(calls.length, 0);
  });

  await check("CORS: aceita localhost, ALLOWED_ORIGINS e pedidos sem Origin", async () => {
    assert.equal(nvidiaOriginAllowed("http://localhost:5173", "cine-flowx.vercel.app", ""), true);
    assert.equal(nvidiaOriginAllowed("http://127.0.0.1:4174", "cine-flowx.vercel.app", ""), true);
    assert.equal(nvidiaOriginAllowed("https://meu-dominio.com", "cine-flowx.vercel.app", "https://meu-dominio.com/, https://x.app"), true);
    assert.equal(nvidiaOriginAllowed("https://meu-dominio.com.evil.example", "cine-flowx.vercel.app", "https://meu-dominio.com"), false);
    assert.equal(nvidiaOriginAllowed("https://cine-flowx.vercel.app.evil.example", "cine-flowx.vercel.app", ""), false);
    assert.equal(nvidiaOriginAllowed("null", "cine-flowx.vercel.app", ""), false);
    assert.equal(nvidiaOriginAllowed("", "cine-flowx.vercel.app", ""), true);
  });

  console.log("\n✅ 12 testes do proxy NVIDIA passaram");
} finally {
  globalThis.fetch = originalFetch;
}
