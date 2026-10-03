#!/usr/bin/env node
/**
 * Teste ponta-a-ponta da camada de nuvem (nuvem-duravel.js) contra o mock do
 * Worker R2 (tools/mock-r2-worker.mjs), sem precisar de browser.
 *
 *   node tools/dev-server.mjs &                      # porta 4173 (limite 100 MB)
 *   PORT=4174 MOCK_MAX_DIRECT_MB=1 node tools/dev-server.mjs &   # p/ testar o presign
 *   node tools/test-cinecloud.mjs
 *
 * Usa apenas APIs reais do ficheiro nuvem-duravel.js — o browser é emulado com
 * stubs mínimos (window, localStorage, XMLHttpRequest sobre fetch, Blob).
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const BASE = process.env.CLOUD_BASE || "http://127.0.0.1:4173";
const BASE_SMALL = process.env.CLOUD_BASE_SMALL || "http://127.0.0.1:4174";
const TOKEN = process.env.MOCK_CLOUD_TOKEN || "cc_r2_token_de_teste";

/* ------------------------------------------------- emulação do navegador */

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
}

class XMLHttpRequestStub {
  constructor() {
    this.upload = {};
    this.status = 0;
    this.responseText = "";
    this._headers = {};
  }
  open(method, url) {
    this._method = method;
    this._url = url;
    this._headers = {};
  }
  setRequestHeader(k, v) {
    this._headers[k] = v;
  }
  send(body) {
    const total = body ? body.byteLength || body.length || 0 : 0;
    (async () => {
      try {
        if (this.upload.onprogress) this.upload.onprogress({ lengthComputable: true, loaded: Math.floor(total / 2), total });
        const res = await fetch(this._url, { method: this._method, headers: this._headers, body });
        this.status = res.status;
        this.responseText = await res.text();
        if (this.upload.onprogress) this.upload.onprogress({ lengthComputable: true, loaded: total, total });
        if (this.onload) this.onload();
      } catch (err) {
        this._error = err;
        if (this.onerror) this.onerror(err);
      }
    })();
  }
  abort() {
    if (this.onabort) this.onabort();
  }
}

function createContext(origin) {
  const localStorage = makeStorage();
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Blob,
    File,
    FormData,
    fetch,
    crypto,
    Math,
    JSON,
    Date,
    Promise,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Error,
    Uint8Array,
    ArrayBuffer,
    localStorage,
    XMLHttpRequest: XMLHttpRequestStub,
    navigator: { clipboard: { writeText: async () => {} } },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.location = { origin, href: origin + "/", hostname: new URL(origin).hostname };
  sandbox.window.CineClipToast = function (msg) {
    sandbox.__toasts.push({ kind: "default", msg });
  };
  ["success", "error", "warning", "info", "loading", "message"].forEach((k) => {
    sandbox.window.CineClipToast[k] = function (msg) {
      sandbox.__toasts.push({ kind: k, msg });
    };
  });
  sandbox.window.CineClipToast.dismiss = function () {};
  sandbox.__toasts = [];

  const ctx = vm.createContext(sandbox);
  const code = fs.readFileSync(path.join(root, "nuvem-duravel.js"), "utf8");
  vm.runInContext(code, ctx, { filename: "nuvem-duravel.js" });
  return sandbox;
}

function setSettings(sandbox, settings) {
  sandbox.localStorage.setItem("cineclip.settings", JSON.stringify(settings));
}

/* ----------------------------------------------------------------- testes */

/** crypto.getRandomValues tem limite de 64 KB por chamada — preenche em blocos. */
function randomBytes(n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(i + 65536, n)));
  return out;
}

let pass = 0;
let fail = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    pass++;
    console.log(`   ✔ ${name}`);
  } else {
    fail++;
    failures.push(name + (detail ? ` — ${detail}` : ""));
    console.log(`   ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function expectThrow(name, fn, needle) {
  try {
    await fn();
    check(name, false, "esperava um erro lançado e não houve nenhum");
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    check(name, !needle || msg.includes(needle), msg);
    return msg;
  }
}

const sb = createContext(BASE);
const CC = sb.window.CineCloud;

console.log(`\n🧪 CineCloud vs mock R2 (${BASE})\n`);

/* 1 — camada carregada */
console.log("Camada");
check("window.CineCloud existe", !!CC);
check("versão exposta", !!(CC && CC.version), CC && CC.version);

/* 2 — sem configuração: erros não são silenciosos */
console.log("\nSem R2 configurado (comportamento antigo)");
setSettings(sb, {});
check("configured() === false", CC.configured() === false);
const msgSemR2 = await expectThrow(
  "uploadVideo sem R2 falha com mensagem explícita (não fica em silêncio)",
  () => CC.uploadVideo(new Blob([new Uint8Array(2048)], { type: "video/mp4" }), "sem-r2.mp4", { allowTemp: false }),
  ""
);
check("mensagem menciona os hosts", /kappa|upload-temp|armazenamento/i.test(msgSemR2 || ""), msgSemR2);
const hc0 = await CC.healthCheck();
check("healthCheck sem URL explica o que falta", hc0.ok === false && /Sem URL do Worker/.test(hc0.message), hc0.message);

/* 3 — token errado */
console.log("\nConfiguração inválida");
setSettings(sb, { r2WorkerUrl: "/cloud-api", r2Token: "token-errado" });
const hcBad = await CC.healthCheck();
check("healthCheck deteta token inválido", hcBad.ok === false && /Token|401|403/i.test(hcBad.message), hcBad.message);

/* 4 — tudo configurado */
console.log("\nR2 configurado (mock local)");
setSettings(sb, { r2WorkerUrl: "/cloud-api", r2Token: TOKEN, r2MaxMb: 95 });
check("URL relativa resolvida contra a origem", CC.config().workerUrl === BASE + "/cloud-api", CC.config().workerUrl);
const hc = await CC.healthCheck();
check("healthCheck ok", hc.ok === true, hc.message);
check("healthCheck reporta presign e estatísticas", hc.ok && hc.presign === true && !!hc.stats, JSON.stringify(hc.stats || null));

/* 5 — upload de vídeo */
console.log("\nUpload de vídeo");
const bytes = randomBytes(2 * 1024 * 1024);
let progressSeen = [];
const videoUrl = await CC.uploadVideo(new Blob([bytes], { type: "video/mp4" }), "meu reel (final).mp4", {
  onProgress: (pct) => progressSeen.push(pct),
});
check("devolve URL pública do R2", /^https?:\/\/.+\/cloud-api\/v\//.test(videoUrl), videoUrl);
check("o nome do ficheiro foi sanitizado", !/[ ()]/.test(videoUrl), videoUrl);
check("progresso reportado (XHR upload.onprogress)", progressSeen.length >= 2, JSON.stringify(progressSeen));
check("classifyUrl → 'r2' (durável)", CC.classifyUrl(videoUrl) === "r2", CC.classifyUrl(videoUrl));
check("classifyUrl de host antigo → 'temp'", CC.classifyUrl("https://kappa.lol/abc.mp4") === "temp");

const full = await fetch(videoUrl);
const back = Buffer.from(await full.arrayBuffer());
check("o vídeo volta byte-a-byte (" + back.length + " bytes)", back.length === bytes.length && back.equals(Buffer.from(bytes)));
const ranged = await fetch(videoUrl, { headers: { Range: "bytes=0-0" } });
check("link público responde a Range com 206 (é o que a Meta e o Robô usam)", ranged.status === 206, "HTTP " + ranged.status);
await ranged.body?.cancel?.();

/* 6 — ficheiro ilegível (File movido/apagado) */
const brokenBlob = new Blob([new Uint8Array(10)]);
brokenBlob.arrayBuffer = async () => {
  const e = new Error("The requested file could not be read");
  e.name = "NotReadableError";
  throw e;
};
const msgBroken = await expectThrow("blob ilegível gera erro claro (não é engolido)", () =>
  CC.uploadVideo(brokenBlob, "ilegivel.mp4")
);
check("erro explica o que fazer", /Reimporta/i.test(msgBroken || ""), msgBroken);

/* 7 — cofre */
console.log("\nCofre (fila/chaves/contas)");
const cipher = JSON.stringify({ v: 2, iv: "QUJD", ct: "REVG" });
const put = await CC.putVault("hash_teste_1", cipher);
check("putVault ok via R2", put.ok === true && put.provider === "cloudflare-r2", JSON.stringify(put));
const got = await CC.getVaultCipher("hash_teste_1");
check("getVaultCipher devolve o mesmo conteúdo", got.data === cipher && got.source === "cloudflare-r2", JSON.stringify({ s: got.source, ok: !!got.data }));
check("leitura não marca falha de rede", got.readFailed === false);
const missing = await CC.getVaultCipher("hash_inexistente");
check("cofre inexistente → data null sem marcar falha de rede", missing.data === null && missing.readFailed === false, JSON.stringify(missing));

/* 8 — guarda anti-apagão */
console.log("\nGuarda anti-apagão de fila");
CC.noteQueueCount(3);
CC.markReadFailure(true);
check("bloqueia gravação de cofre vazio quando a leitura falhou", CC.blockEmptyOverwrite({ queue: [] }) === true);
check("não bloqueia quando há itens na fila", CC.blockEmptyOverwrite({ queue: [{}], settings: {} }) === false);
CC.markReadFailure(false);
check("deixa de bloquear depois de uma leitura bem sucedida", CC.blockEmptyOverwrite({ queue: [] }) === false);

/* 9 — worker inacessível → erro real + readFailed */
console.log("\nFalhas de rede");
setSettings(sb, { r2WorkerUrl: "http://127.0.0.1:59999", r2Token: TOKEN });
const unreachable = await CC.getVaultCipher("hash_teste_1");
check("worker em baixo → readFailed=true (permite à guarda proteger a fila)", unreachable.readFailed === true && unreachable.data === null, JSON.stringify(unreachable.failures || null));
await expectThrow("putVault com worker em baixo lança erro (não falha em silêncio)", () => CC.putVault("hash_teste_1", cipher), "R2");

/* 10 — presign (vídeos acima do limite de corpo do Worker) */
console.log("\nVídeos grandes → URL pré-assinada");
let presignOk = false;
try {
  const probe = await fetch(BASE_SMALL + "/cloud-api/", { cache: "no-store" });
  presignOk = probe.ok && (await probe.json()).maxDirectUploadBytes < 2 * 1024 * 1024;
} catch {}
if (presignOk) {
  const sb2 = createContext(BASE_SMALL);
  const CC2 = sb2.window.CineCloud;
  setSettings(sb2, { r2WorkerUrl: "/cloud-api", r2Token: TOKEN, r2MaxMb: 500, r2Presign: true });
  const big = randomBytes(2 * 1024 * 1024);
  const bigUrl = await CC2.uploadVideo(new Blob([big], { type: "video/mp4" }), "grande.mp4");
  check("upload acima do limite usa presign e devolve link público", /\/cloud-api\/v\//.test(bigUrl), bigUrl);
  const r = await fetch(bigUrl, { headers: { Range: "bytes=0-0" } });
  check("vídeo grande fica legível (206)", r.status === 206, "HTTP " + r.status);
  await r.body?.cancel?.();
  check("diagnóstico regista o provider presigned", /presign/i.test(CC2.report()), "");
} else {
  console.log(`   ⏭  ignorado — arranca o mock pequeno: PORT=4174 MOCK_MAX_DIRECT_MB=1 node tools/dev-server.mjs`);
}

/* 11 — diagnóstico */
console.log("\nDiagnóstico");
setSettings(sb, { r2WorkerUrl: "/cloud-api", r2Token: TOKEN });
const diag = CC.diagnostics();
check("diagnostics() expõe configuração e log", diag.configured === true && Array.isArray(diag.log) && diag.log.length > 0);
check("report() devolve texto copiável", typeof CC.report() === "string" && CC.report().length > 50);

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passaram, ${fail} falharam`);
if (failures.length) {
  console.log("\nFalhas:");
  failures.forEach((f) => console.log("  - " + f));
}
process.exit(fail === 0 ? 0 : 1);
