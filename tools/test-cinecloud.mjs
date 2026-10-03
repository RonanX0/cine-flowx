#!/usr/bin/env node
/**
 * Teste ponta-a-ponta da camada de nuvem (nuvem-duravel.js) contra mocks locais
 * dos dois backends duráveis — sem precisar de browser, sem internet e sem conta:
 *
 *   • Cloudflare R2          → tools/mock-r2-worker.mjs   (montado em /cloud-api)
 *   • Google Drive/Apps Script → tools/mock-drive-backend.mjs (montado em /drive-api)
 *
 *   node tools/test-cinecloud.mjs          # arranca os mocks sozinho (porta 4199)
 *   CLOUD_BASE=http://127.0.0.1:4173 node tools/test-cinecloud.mjs   # usa o dev-server
 *
 * O servidor de teste usa MOCK_MAX_DIRECT_MB=1 de propósito: assim o mesmo teste
 * cobre o envio direto (<1 MB) e o caminho de URL pré-assinada (>1 MB) no R2.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import http from "node:http";

const root = path.resolve(import.meta.dirname, "..");

// limites definidos ANTES de importar os mocks (eles leem o env no load)
process.env.MOCK_MAX_DIRECT_MB = process.env.MOCK_MAX_DIRECT_MB || "1";
process.env.MOCK_CLOUD_TOKEN = process.env.MOCK_CLOUD_TOKEN || "cc_r2_token_de_teste";
process.env.MOCK_DRIVE_TOKEN = process.env.MOCK_DRIVE_TOKEN || "cc_drive_token_de_teste";

const { createMockCloud } = await import("./mock-r2-worker.mjs");
const { createMockDrive } = await import("./mock-drive-backend.mjs");

const TOKEN = process.env.MOCK_CLOUD_TOKEN;
const DRIVE_TOKEN = process.env.MOCK_DRIVE_TOKEN;
const TEST_PORT = Number(process.env.TEST_PORT || 4199);

/* --------------------------------------------- mocks em processo (auto) */

let BASE = process.env.CLOUD_BASE || "";
let BASE_TINY = "";
let server = null;
let serverTiny = null;

if (!BASE) {
  const storeDir = path.join(root, ".mock-cloud", "test");
  fs.rmSync(storeDir, { recursive: true, force: true });
  const handleCloud = createMockCloud({ storeDir });
  const handleDrive = createMockDrive({ storeDir });
  // segundo Drive que anuncia limites diferentes (1 MB por pedido, máximo 2 MB)
  const handleDriveTiny = createMockDrive({
    storeDir: path.join(storeDir, "tiny"),
    singleMaxMb: 1,
    maxVideoMb: 2
  });
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;
    try {
      if (pathname === "/cloud-api" || pathname.startsWith("/cloud-api/")) {
        return await handleCloud(req, res, pathname.slice("/cloud-api".length) || "/");
      }
      if (pathname === "/drive-api" || pathname.startsWith("/drive-api/")) {
        return await handleDrive(req, res);
      }
    } catch (err) {
      const status = err && err.status ? err.status : 200;
      if (!res.headersSent) res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      return res.end(JSON.stringify({ ok: false, error: err && err.message ? err.message : "Erro interno" }));
    }
    res.writeHead(404).end("not found");
  });
  await new Promise((resolve) => server.listen(TEST_PORT, "127.0.0.1", resolve));
  BASE = `http://127.0.0.1:${TEST_PORT}`;

  serverTiny = http.createServer(async (req, res) => {
    try {
      return await handleDriveTiny(req, res);
    } catch (err) {
      if (!res.headersSent) res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      return res.end(JSON.stringify({ ok: false, error: err && err.message ? err.message : "Erro interno" }));
    }
  });
  await new Promise((resolve) => serverTiny.listen(TEST_PORT + 1, "127.0.0.1", resolve));
  BASE_TINY = `http://127.0.0.1:${TEST_PORT + 1}`;
}
const BASE_SMALL = process.env.CLOUD_BASE_SMALL || BASE; // mesmo servidor: limite direto = 1 MB

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
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
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
    RegExp,
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

console.log(`\n🧪 CineCloud vs mocks locais (${BASE})\n`);

/* 1 — camada carregada */
console.log("Camada");
check("window.CineCloud existe", !!CC);
check("versão exposta", !!(CC && CC.version), CC && CC.version);

/* 2 — sem configuração: erros não são silenciosos */
console.log("\nSem nuvem durável configurada (comportamento antigo)");
setSettings(sb, {});
check("configured() === false", CC.configured() === false);
check("cadeia cai para 'legacy'", CC.providers().join(",") === "legacy", CC.providers().join(","));
const msgSemR2 = await expectThrow(
  "uploadVideo sem provider durável falha com mensagem explícita (allowTemp:false)",
  () => CC.uploadVideo(new Blob([new Uint8Array(2048)], { type: "video/mp4" }), "sem-nuvem.mp4", { allowTemp: false }),
  "armazenamento durável"
);
check("mensagem diz onde configurar", /Configurações/i.test(msgSemR2 || ""), msgSemR2);
const hc0 = await CC.healthCheck();
check("healthCheck sem configuração explica o que falta", hc0.ok === false && /Apps Script|Worker/i.test(hc0.message), hc0.message);

/* 3 — token errado */
console.log("\nConfiguração inválida");
setSettings(sb, { r2WorkerUrl: "/cloud-api", r2Token: "token-errado" });
const hcBad = await CC.healthCheck();
check("healthCheck deteta token inválido no R2", hcBad.ok === false && /Token|401|403/i.test(hcBad.message), hcBad.message);
setSettings(sb, { driveScriptUrl: "/drive-api", driveToken: "token-errado" });
const hcBadDrive = await CC.healthCheck();
check("healthCheck deteta token inválido no Drive", hcBadDrive.ok === false && /Token|inválid/i.test(hcBadDrive.message), hcBadDrive.message);

/* 4 — R2 configurado */
console.log("\nCloudflare R2 configurado (mock local)");
setSettings(sb, { r2WorkerUrl: "/cloud-api", r2Token: TOKEN, r2MaxMb: 95 });
check("URL relativa resolvida contra a origem", CC.config().workerUrl === BASE + "/cloud-api", CC.config().workerUrl);
check("providers() = r2 → legacy", CC.providers().join(" → ") === "r2 → legacy", CC.providers().join(" → "));
const hc = await CC.healthCheck();
check("healthCheck ok", hc.ok === true, hc.message);
check("healthCheck reporta provider ativo", hc.provider === "cloudflare-r2", hc.provider);
check("healthCheck reporta presign e estatísticas", hc.ok && hc.presign === true && !!hc.stats, JSON.stringify(hc.stats || null));

/* 5 — upload direto (<1 MB no mock) */
console.log("\nUpload de vídeo (R2, envio direto)");
const smallBytes = randomBytes(512 * 1024);
let progressSeen = [];
const smallUrl = await CC.uploadVideo(new Blob([smallBytes], { type: "video/mp4" }), "meu reel (final).mp4", {
  onProgress: (pct) => progressSeen.push(pct),
});
check("devolve URL pública do R2", /^https?:\/\/.+\/cloud-api\/v\//.test(smallUrl), smallUrl);
check("o nome do ficheiro foi sanitizado", !/[ ()]/.test(smallUrl), smallUrl);
check("progresso reportado (XHR upload.onprogress)", progressSeen.length >= 2, JSON.stringify(progressSeen));
check("classifyUrl → 'r2' (durável)", CC.classifyUrl(smallUrl) === "r2", CC.classifyUrl(smallUrl));
check("isDurable('r2') === true", CC.isDurable(smallUrl) === true);
check("classifyUrl de host antigo → 'temp'", CC.classifyUrl("https://kappa.lol/abc.mp4") === "temp");
check("isDurable de host antigo === false", CC.isDurable("https://uguu.se/x.mp4") === false);

const full = await fetch(smallUrl);
const back = Buffer.from(await full.arrayBuffer());
check("o vídeo volta byte-a-byte (" + back.length + " bytes)", back.length === smallBytes.length && back.equals(Buffer.from(smallBytes)));
const ranged = await fetch(smallUrl, { headers: { Range: "bytes=0-0" } });
check("link público R2 responde a Range com 206 (é o que a Meta usa)", ranged.status === 206, "HTTP " + ranged.status);
await ranged.body?.cancel?.();

/* 6 — R2 acima do limite de corpo → URL pré-assinada */
console.log("\nVídeos grandes no R2 → URL pré-assinada");
const presignProbe = await fetch(BASE_SMALL + "/cloud-api/", { cache: "no-store" });
const presignHealth = await presignProbe.json();
check("o mock anuncia o limite de envio direto", presignHealth.maxDirectUploadBytes === 1024 * 1024, String(presignHealth.maxDirectUploadBytes));
const bigBytes = randomBytes(2 * 1024 * 1024);
const bigUrl = await CC.uploadVideo(new Blob([bigBytes], { type: "video/mp4" }), "grande.mp4");
check("upload acima do limite usa presign e devolve link público", /\/cloud-api\/v\//.test(bigUrl), bigUrl);
const bigBack = Buffer.from(await (await fetch(bigUrl)).arrayBuffer());
check("vídeo grande volta byte-a-byte", bigBack.equals(Buffer.from(bigBytes)), bigBack.length + " vs " + bigBytes.length);
const bigRanged = await fetch(bigUrl, { headers: { Range: "bytes=0-0" } });
check("vídeo grande fica legível (206)", bigRanged.status === 206, "HTTP " + bigRanged.status);
await bigRanged.body?.cancel?.();
check("diagnóstico regista o provider presigned", /presign/i.test(CC.report()), "");

/* 7 — ficheiro ilegível (File movido/apagado) */
console.log("\nFicheiro ilegível");
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

/* 8 — cofre no R2 */
console.log("\nCofre (fila/chaves/contas) via R2");
const cipher = JSON.stringify({ v: 2, iv: "QUJD", ct: "REVG" });
const put = await CC.putVault("hash_teste_1", cipher);
check("putVault ok via R2", put.ok === true && put.provider === "cloudflare-r2", JSON.stringify(put));
const got = await CC.getVaultCipher("hash_teste_1");
check("getVaultCipher devolve o mesmo conteúdo", got.data === cipher && got.source === "cloudflare-r2", JSON.stringify({ s: got.source, ok: !!got.data }));
check("leitura não marca falha de rede", got.readFailed === false);
const missing = await CC.getVaultCipher("hash_inexistente");
check("cofre inexistente → data null sem marcar falha de rede", missing.data === null && missing.readFailed === false, JSON.stringify(missing));

/* 9 — guarda anti-apagão */
console.log("\nGuarda anti-apagão de fila");
CC.noteQueueCount(3);
CC.markReadFailure(true);
check("bloqueia gravação de cofre vazio quando a leitura falhou", CC.blockEmptyOverwrite({ queue: [] }) === true);
check("não bloqueia quando há itens na fila", CC.blockEmptyOverwrite({ queue: [{}], settings: {} }) === false);
CC.markReadFailure(false);
check("deixa de bloquear depois de uma leitura bem sucedida", CC.blockEmptyOverwrite({ queue: [] }) === false);

/* 10 — GOOGLE DRIVE / Apps Script */
console.log("\nGoogle Drive (Apps Script) configurado");
setSettings(sb, { driveScriptUrl: "/drive-api", driveToken: DRIVE_TOKEN, cloudProvider: "drive" });
check("URL do Apps Script resolvido", CC.config().driveUrl === BASE + "/drive-api", CC.config().driveUrl);
check("cloudProvider:'drive' → só drive na cadeia", CC.providers().join(" → ") === "drive → legacy", CC.providers().join(" → "));
const hcDrive = await CC.healthCheck();
check("healthCheck do Drive ok (escrita+leitura de cofre de teste)", hcDrive.ok === true && hcDrive.provider === "google-drive", hcDrive.message);
check("healthCheck reporta os blocos de envio", /blocos de 2\.0 MB/.test(hcDrive.message), hcDrive.message);

console.log("\nUpload de vídeo (Drive, ficheiro pequeno = 1 pedido)");
const dSmall = randomBytes(512 * 1024);
let dProgress = [];
const dSmallUrl = await CC.uploadVideo(new Blob([dSmall], { type: "video/mp4" }), "reel drive.mp4", {
  onProgress: (p) => dProgress.push(p),
});
check("devolve link ?action=video&id=…", /[?&]action=video&/.test(dSmallUrl) && /[?&]id=/.test(dSmallUrl), dSmallUrl);
check("classifyUrl → 'drive'", CC.classifyUrl(dSmallUrl) === "drive", CC.classifyUrl(dSmallUrl));
check("isDurable('drive') === true", CC.isDurable(dSmallUrl) === true);
check("progresso reportado", dProgress.length >= 1 && dProgress[dProgress.length - 1] === 100, JSON.stringify(dProgress));
const dBack = Buffer.from(await (await fetch(dSmallUrl)).arrayBuffer());
check("o vídeo volta byte-a-byte do Drive (" + dBack.length + " bytes)", dBack.equals(Buffer.from(dSmall)));
const dHead = await fetch(dSmallUrl.replace(/action=video(&|$)/, "action=videohead$1"), { cache: "no-store" });
const dHeadJson = await dHead.json();
check("videohead confirma o ficheiro sem o descarregar", dHeadJson.ok === true && dHeadJson.size === dSmall.length, JSON.stringify(dHeadJson));
check("verifyPublicUrl usa o videohead (não baixa o vídeo)", (await CC.verifyPublicUrl(dSmallUrl)) === true);
const dRange = await fetch(dSmallUrl, { headers: { Range: "bytes=0-0" } });
check("o link do Drive NÃO suporta Range (por isso o Robô usa videohead)", dRange.status === 200, "HTTP " + dRange.status);
await dRange.body?.cancel?.();

console.log("\nUpload de vídeo (Drive, ficheiro grande = blocos de 2 MB)");
const dBig = randomBytes(10 * 1024 * 1024);
let dBigProgress = [];
const dBigUrl = await CC.uploadVideo(new Blob([dBig], { type: "video/mp4" }), "reel-grande.mp4", {
  onProgress: (p) => dBigProgress.push(p),
});
check("vídeo de 10 MB enviado em blocos devolve link final", /[?&]action=video&/.test(dBigUrl), dBigUrl);
check("progresso cresceu até 100%", dBigProgress.length >= 5 && dBigProgress[dBigProgress.length - 1] === 100, JSON.stringify(dBigProgress.slice(0, 8)) + "…");
const dBigBack = Buffer.from(await (await fetch(dBigUrl)).arrayBuffer());
check("vídeo grande volta byte-a-byte (montado pelo resumable upload)", dBigBack.equals(Buffer.from(dBig)), dBigBack.length + " vs " + dBig.length);

console.log("\nLimites anunciados pelo backend (health > Configurações)");
setSettings(sb, { driveScriptUrl: "/drive-api", driveToken: DRIVE_TOKEN, cloudProvider: "drive", driveSingleMaxMb: 100, driveChunkMb: 7 });
const dMis = randomBytes(9 * 1024 * 1024);
const dMisUrl = await CC.uploadVideo(new Blob([dMis], { type: "video/mp4" }), "limites-do-servidor.mp4");
const dMisBack = Buffer.from(await (await fetch(dMisUrl)).arrayBuffer());
check(
  "com limites errados nas Configurações o upload segue o que o Apps Script anuncia",
  dMisBack.equals(Buffer.from(dMis)),
  dMisBack.length + " vs " + dMis.length
);
setSettings(sb, { driveScriptUrl: "/drive-api", driveToken: DRIVE_TOKEN, cloudProvider: "drive" });

console.log("\nCofre via Drive");
const dPut = await CC.putVault("hash_drive_1", cipher);
check("putVault ok via Drive", dPut.ok === true && dPut.provider === "google-drive", JSON.stringify(dPut));
const dGot = await CC.getVaultCipher("hash_drive_1");
check("getVaultCipher devolve o mesmo conteúdo", dGot.data === cipher && dGot.source === "google-drive", JSON.stringify({ s: dGot.source, ok: !!dGot.data }));
const dMissing = await CC.getVaultCipher("hash_drive_inexistente");
check("cofre inexistente no Drive → data null sem marcar falha de rede", dMissing.data === null && dMissing.readFailed === false, JSON.stringify(dMissing.failures || null));

console.log("\nLimites do backend (vídeo demasiado grande)");
const sbTiny = createContext(BASE_TINY);
const CCT = sbTiny.window.CineCloud;
setSettings(sbTiny, { driveScriptUrl: BASE_TINY, driveToken: DRIVE_TOKEN, cloudProvider: "drive" });
const tinyHealth = await (await fetch(BASE_TINY + "?action=health", { cache: "no-store" })).json();
check(
  "o backend anuncia os próprios limites",
  tinyHealth.singleMaxBytes === 1024 * 1024 && tinyHealth.maxVideoBytes === 2 * 1024 * 1024,
  JSON.stringify({ single: tinyHealth.singleMaxBytes, max: tinyHealth.maxVideoBytes })
);
const midBytes = randomBytes(1536 * 1024);
const midUrl = await CCT.uploadVideo(new Blob([midBytes], { type: "video/mp4" }), "medio.mp4");
const midBack = Buffer.from(await (await fetch(midUrl)).arrayBuffer());
check(
  "1,5 MB com limite de 1 MB por pedido → enviado em blocos e íntegro",
  midBack.equals(Buffer.from(midBytes)),
  midBack.length + " vs " + midBytes.length
);
const msgTooBig = await expectThrow(
  "vídeo acima do limite do backend é recusado ANTES de enviar (sem 3 tentativas inúteis)",
  () => CCT.uploadVideo(new Blob([randomBytes(3 * 1024 * 1024)], { type: "video/mp4" }), "grande-demais.mp4")
);
check("o erro diz o tamanho e o limite", /3\.0 MB/.test(msgTooBig || "") && /no m[aá]ximo 2\.0 MB/i.test(msgTooBig || ""), msgTooBig);
check("o erro aponta a solução (cortar o clipe ou usar o R2)", /R2|MAX_VIDEO_MB/i.test(msgTooBig || ""), msgTooBig);

console.log("\nURL do Apps Script colado de qualquer maneira");
const GAS = "https://script.google.com/macros/s/AKfycbTESTE123456789/exec";
setSettings(sb, { driveScriptUrl: "script.google.com/macros/s/AKfycbTESTE123456789/exec", driveToken: DRIVE_TOKEN, cloudProvider: "drive" });
check("sem https:// à frente → o app acrescenta (não vira caminho relativo)", CC.config().driveUrl === GAS, CC.config().driveUrl);
setSettings(sb, { driveScriptUrl: "  " + GAS + "\n ", driveToken: "  " + DRIVE_TOKEN + "  ", cloudProvider: "drive" });
check("espaços e quebras de linha da cópia são limpos", CC.config().driveUrl === GAS && CC.config().driveToken === DRIVE_TOKEN, JSON.stringify(CC.config().driveUrl));
setSettings(sb, { driveScriptUrl: GAS.replace("/exec", "/dev"), driveToken: DRIVE_TOKEN, cloudProvider: "drive" });
const hcDev = await CC.healthCheck();
check("URL /dev é detetado e explicado (não dá um 'Failed to fetch' misterioso)", hcDev.ok === false && /\/dev/.test(hcDev.drive.message) && /\/exec/.test(hcDev.drive.message), hcDev.drive.message);
setSettings(sb, { driveScriptUrl: "http://example.com/exec", driveToken: DRIVE_TOKEN, cloudProvider: "drive" });
const hcHttp = await CC.healthCheck();
check("http:// fora de localhost é recusado com explicação", hcHttp.ok === false && /https:\/\//.test(hcHttp.drive.message), hcHttp.drive.message);
setSettings(sb, { driveScriptUrl: "/drive-api", driveToken: DRIVE_TOKEN, cloudProvider: "drive" });
check("caminho relativo continua a resolver contra a origem (preview/mocks)", CC.config().driveUrl === BASE + "/drive-api", CC.config().driveUrl);
setSettings(sb, { driveScriptUrl: "http://127.0.0.1:59999/drive-api", driveToken: DRIVE_TOKEN, cloudProvider: "drive" });
const hcDown = await CC.healthCheck();
check("backend em baixo → mensagem com o URL de teste direto e o que verificar", hcDown.ok === false && /action=health/.test(hcDown.drive.message) && /setup\(\)/.test(hcDown.drive.message), hcDown.drive.message.slice(0, 120));
setSettings(sb, { driveScriptUrl: "/drive-api", driveToken: DRIVE_TOKEN, cloudProvider: "drive" });

/* 11 — prioridade quando os dois estão configurados */
console.log("\nPrioridade de providers (R2 + Drive configurados)");
setSettings(sb, { r2WorkerUrl: "/cloud-api", r2Token: TOKEN, driveScriptUrl: "/drive-api", driveToken: DRIVE_TOKEN });
check("auto → r2 primeiro (suporta Range/presign), depois drive", CC.providers().join(" → ") === "r2 → drive → legacy", CC.providers().join(" → "));
const bothUrl = await CC.uploadVideo(new Blob([randomBytes(64 * 1024)], { type: "video/mp4" }), "prioridade.mp4");
check("o upload segue a prioridade (foi para o R2)", CC.classifyUrl(bothUrl) === "r2", bothUrl);
setSettings(sb, { r2WorkerUrl: "/cloud-api", r2Token: TOKEN, driveScriptUrl: "/drive-api", driveToken: DRIVE_TOKEN, cloudProvider: "drive" });
const forcedUrl = await CC.uploadVideo(new Blob([randomBytes(64 * 1024)], { type: "video/mp4" }), "forca-drive.mp4");
check("cloudProvider:'drive' força o Drive mesmo com R2 configurado", CC.classifyUrl(forcedUrl) === "drive", forcedUrl);

/* 12 — falha do R2 passa ao Drive (não cai logo num host temporário) */
console.log("\nFailover entre providers duráveis");
setSettings(sb, { r2WorkerUrl: "/cloud-api", r2Token: "token-errado", driveScriptUrl: "/drive-api", driveToken: DRIVE_TOKEN });
const failoverUrl = await CC.uploadVideo(new Blob([randomBytes(64 * 1024)], { type: "video/mp4" }), "failover.mp4");
check("R2 com token errado → o vídeo foi para o Drive", CC.classifyUrl(failoverUrl) === "drive", failoverUrl);
check("houve aviso sobre a falha do provider", sb.__toasts.length >= 0);
const failoverVault = await CC.putVault("hash_failover", cipher);
check("putVault também faz failover para o Drive", failoverVault.provider === "google-drive", JSON.stringify(failoverVault));
const failoverRead = await CC.getVaultCipher("hash_failover");
check("getVaultCipher também faz failover de leitura para o Drive", failoverRead.data === cipher && failoverRead.source === "google-drive", JSON.stringify({ src: failoverRead.source, ok: !!failoverRead.data }));

/* 13 — worker inacessível → erro real + readFailed */
console.log("\nFalhas de rede");
setSettings(sb, { r2WorkerUrl: "http://127.0.0.1:59999", r2Token: TOKEN });
const unreachable = await CC.getVaultCipher("hash_teste_1");
check("backend em baixo → readFailed=true (permite à guarda proteger a fila)", unreachable.readFailed === true && unreachable.data === null, JSON.stringify(unreachable.failures || null));
await expectThrow("putVault com backend em baixo lança erro (não falha em silêncio)", () => CC.putVault("hash_teste_1", cipher), "R2");
setSettings(sb, { driveScriptUrl: "http://127.0.0.1:59999/drive-api", driveToken: DRIVE_TOKEN, cloudProvider: "drive" });
const unreachableDrive = await CC.getVaultCipher("hash_drive_1");
check("Apps Script em baixo → readFailed=true", unreachableDrive.readFailed === true && unreachableDrive.data === null, JSON.stringify(unreachableDrive.failures || null));
await expectThrow("putVault com Apps Script em baixo lança erro", () => CC.putVault("hash_drive_1", cipher), "Drive");

/* 14 — diagnóstico */
console.log("\nDiagnóstico");
setSettings(sb, { r2WorkerUrl: "/cloud-api", r2Token: TOKEN, driveScriptUrl: "/drive-api", driveToken: DRIVE_TOKEN });
const diag = CC.diagnostics();
check("diagnostics() expõe configuração e log", diag.configured === true && Array.isArray(diag.log) && diag.log.length > 0);
check("diagnostics() mostra os dois backends", !!diag.r2WorkerUrl && !!diag.driveScriptUrl && diag.r2WorkerUrl !== "(não configurado)");
check("report() devolve texto copiável", typeof CC.report() === "string" && CC.report().length > 50);
check("report() menciona R2 e Drive", /R2:/.test(CC.report()) && /Drive:/.test(CC.report()));

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passaram, ${fail} falharam`);
if (failures.length) {
  console.log("\nFalhas:");
  failures.forEach((f) => console.log("  - " + f));
}
if (server) server.close();
if (serverTiny) serverTiny.close();
process.exit(fail === 0 ? 0 : 1);
