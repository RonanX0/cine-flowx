#!/usr/bin/env node
/**
 * Teste de ponta a ponta (jsdom) do botão "Publicar agora" do Agendador.
 *
 * O bundle não tem src/: a interface é um ficheiro compilado (index.html). Foi
 * exatamente por isso que a regressão do bloqueio de publicação passou: o patch
 * das claims (19/20) usava `oe.current` como cadeado de publicação, mas `oe` é o
 * ref do `<input type="file">` do botão "Importar" — esse ref está SEMPRE
 * preenchido depois do componente montar, logo o handler saía pelo
 * `if(oe.current) return` e o botão não fazia absolutamente nada (nem erro, nem
 * toast, nem pedido à Meta). Os testes existentes só cobriam `gS`/claims em
 * isolamento, nunca o clique.
 *
 * Este teste arranca o bundle REAL num DOM (jsdom + IndexedDB falso), ouve o
 * `fetch`, clica no botão e verifica que a publicação chega mesmo à Graph API.
 *
 *   node tools/test-agendador-publish.mjs
 *
 * Dependências (opcionais — sem elas o teste salta e explica):
 *   npm install --no-save jsdom fake-indexeddb
 */
import fs from "node:fs";
import path from "node:path";

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

const root = path.resolve(import.meta.dirname, "..");

const CONTA_TESTE = {
  id: "acc_default",
  name: "@conta.teste",
  mode: "graph",
  igUserId: "17841400000000000",
  fbPageId: "",
  metaAccessToken: "TOKEN-FALSO-DE-TESTE",
  webhookUrl: "",
  dailySlots: ["12:00"],
  autoPilot: false,
  shareToFeed: true,
};

/* ------------------------------------------------ dependências opcionais */
let JSDOM;
let fakeIndexedDB;
let IDBKeyRange;
try {
  ({ JSDOM } = await import("jsdom"));
  ({ indexedDB: fakeIndexedDB, IDBKeyRange } = await import("fake-indexeddb"));
} catch (e) {
  console.log(
    "\n⚠️  jsdom/fake-indexeddb não estão instalados — teste saltado.\n" +
      "   Corre: npm install --no-save jsdom fake-indexeddb\n"
  );
  process.exit(0);
}

const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const modMatch = /<script type="module">([\s\S]*?)<\/script>/.exec(html);
if (!modMatch) {
  console.error("❌ Não encontrei o <script type=\"module\"> do bundle em index.html.");
  process.exit(1);
}
/* `import.meta` não existe num script clássico/eval: troca-se por um URL fixo.
   Esses troços (ffmpeg/preload) só correm ao processar vídeo, não no arranque. */
const moduleSource = modMatch[1].replace(/import\.meta\.url/g, '"file:///index.html"');
/* A camada de nuvem é carregada como no index.html real: tem de estar presente para
   o caminho das claims (patch 19/20) ser exercido a sério. */
const cineCloudSource = fs.readFileSync(path.join(root, "nuvem-duravel.js"), "utf8");

/* ---------------------------------------------------------------- stubs */
const requests = [];
const appLogs = [];

function jsonResponse(status, body, headers) {
  const h = headers || {};
  const lower = {};
  for (const [k, v] of Object.entries(h)) lower[k.toLowerCase()] = String(v);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => lower[String(name).toLowerCase()] ?? null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body ?? {})),
    json: async () => (typeof body === "string" ? JSON.parse(body) : body ?? {}),
    body: { cancel: async () => {} },
  };
}

function handleFetch(url, opts) {
  const target = String(url);
  const method = String((opts && opts.method) || "GET").toUpperCase();
  requests.push({ url: target, method });

  if (/graph\.facebook\.com|rupload\.facebook\.com/.test(target)) {
    return jsonResponse(400, {
      error: { message: "stub: token falso recusado", code: 190, type: "OAuthException" },
    });
  }
  if (/keyvalue\.immanuel\.co|bytebin\.lucko\.me|kappa\.lol|uguu\.se|litterbox|0x0\.st/.test(target)) {
    return jsonResponse(200, { key: "stub", id: "stub", link: "https://stub.local/v.mp4" });
  }
  if (method === "HEAD" || method === "GET") {
    /* A sonda do link do vídeo tem de o ver como um .mp4 saudável. */
    return jsonResponse(200, "video", { "content-type": "video/mp4", "accept-ranges": "bytes" });
  }
  return jsonResponse(200, {});
}

function bootBundle() {
  const dom = new JSDOM(html, {
    url: "http://localhost/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;

  window.indexedDB = fakeIndexedDB;
  window.IDBKeyRange = IDBKeyRange;
  window.TextEncoder = globalThis.TextEncoder;
  window.TextDecoder = globalThis.TextDecoder;
  try {
    Object.defineProperty(window, "crypto", { value: globalThis.crypto, configurable: true });
  } catch {}
  window.fetch = (url, opts) => Promise.resolve(handleFetch(url, opts));
  window.matchMedia = () => ({
    matches: false, media: "", addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent: () => false,
  });
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.HTMLMediaElement.prototype.play = () => Promise.resolve();
  window.HTMLMediaElement.prototype.pause = () => {};
  window.HTMLMediaElement.prototype.load = () => {};
  window.confirm = () => true;
  window.alert = () => {};
  window.scrollTo = () => {};
  window.URL.createObjectURL = () => "blob:stub";
  window.URL.revokeObjectURL = () => {};
  if (!window.navigator.clipboard) {
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText: async () => {} }, configurable: true });
  }
  window.addEventListener("error", (ev) => {
    console.log(`   ⚠️  erro no DOM: ${ev.message || ev.error}`);
  });

  /* Os logs da app (ex.: [CineCloud]) ficam guardados: só aparecem se algo falhar. */
  for (const nivel of ["log", "info", "debug", "warn"]) {
    window.console[nivel] = (...args) => appLogs.push(`${nivel}: ${args.map(String).join(" ")}`);
  }

  /* A conta Meta tem de estar no localStorage ANTES do bundle arrancar: o app lê-a
     no primeiro render e guarda-a em estado React (escrever depois já não conta). */
  window.localStorage.setItem("cineclip.ig.accounts", JSON.stringify([CONTA_TESTE]));
  window.localStorage.setItem("cineclip.ig.active", CONTA_TESTE.id);

  window.eval(cineCloudSource);
  window.eval(moduleSource);
  return dom;
}

/* ------------------------------------------------------------- utilidades */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(desc, fn, timeout = 8000) {
  const t0 = Date.now();
  for (;;) {
    let value;
    try {
      value = await fn();
    } catch {
      value = null;
    }
    if (value) return value;
    if (Date.now() - t0 > timeout) throw new Error(`Tempo esgotado à espera de: ${desc}`);
    await sleep(50);
  }
}

function findByText(window, selector, text) {
  return [...window.document.querySelectorAll(selector)].find((el) =>
    (el.textContent || "").includes(text)
  );
}

function reactType(window, input, value) {
  const proto = window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function readQueueFromIndexedDB() {
  return new Promise((resolve) => {
    const req = fakeIndexedDB.open("cineclip_scheduler_db", 1);
    req.onerror = () => resolve([]);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("reels_queue")) return resolve([]);
      const all = db.transaction("reels_queue", "readonly").objectStore("reels_queue").getAll();
      all.onsuccess = () => resolve(all.result || []);
      all.onerror = () => resolve([]);
    };
  });
}

async function putQueueItem(item) {
  await new Promise((resolve, reject) => {
    const req = fakeIndexedDB.open("cineclip_scheduler_db", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("reels_queue")) {
        db.createObjectStore("reels_queue", { keyPath: "id" });
      }
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction("reels_queue", "readwrite");
      tx.objectStore("reels_queue").put(item);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
  });
}

/* ------------------------------------------------------------------ teste */
console.log("\n📲 Botão \"Publicar agora\" do Agendador — clique real (jsdom)\n");
console.log("1. O app arranca e faz login");

const dom = bootBundle();
const { window } = dom;

const loginButton = await waitFor("ecrã de login", () =>
  findByText(window, "button", "Entrar e Sincronizar Tudo")
);
check("ecrã de entrada renderizado", !!loginButton);

const [userInput, passInput] = window.document.querySelectorAll("input");
reactType(window, userInput, "teste@cineclip");
reactType(window, passInput, "senha-de-teste");
loginButton.click();

const agendadorTab = await waitFor("aba Agendador", () =>
  findByText(window, "button", "Agendador")
);
check("login concluído e app principal visível", !!agendadorTab);
check(
  "camada de nuvem carregada (caminho das claims ativo)",
  !!(window.CineCloud && window.CineCloud.claimPublish)
);

console.log("\n2. Prepara a conta Meta e um Reel na fila");

const reel = {
  id: "reel_teste_clique",
  accountId: "acc_default",
  createdAt: Date.now(),
  scheduledAt: "2026-10-04T12:00",
  scheduledTimestamp: Date.now(),
  status: "scheduled",
  title: "Filme de Teste",
  originalTitle: "Test Movie",
  year: 2026,
  hookText: "hook",
  caption: "legenda de teste",
  remoteVideoUrl: "https://exemplo.local/video.mp4",
  videoFileName: "video.mp4",
  videoSize: 1024,
  platforms: ["instagram"],
  updatedAt: Date.now(),
};
await putQueueItem(reel);

agendadorTab.click();

const publishButton = await waitFor("botão Publicar do item", () =>
  window.document.querySelector(".cc-pub")
);
check("item da fila aparece com o botão \"Publicar\"", !!publishButton);
check("botão \"Publicar\" está ativo (tem vídeo na nuvem)", !publishButton.disabled);

console.log("\n3. Clique no botão e observa o que o app faz");

requests.length = 0;
publishButton.click();
await sleep(2500);

const graphCalls = requests.filter((r) => /graph\.facebook\.com|rupload\.facebook\.com/.test(r.url));
const queue = await readQueueFromIndexedDB();
const atual = queue.find((it) => it.id === reel.id) || {};
const bodyText = window.document.body.textContent || "";

check(
  "o clique chega à API do Instagram (graph.facebook.com)",
  graphCalls.length > 0,
  graphCalls.length === 0
    ? "nenhum pedido à Meta — o handler saiu antes de publicar (regressão do ref `oe`)"
    : `${graphCalls.length} pedido(s)`
);
check(
  "o item sai de \"scheduled\" (ficou \"error\" por causa do token falso)",
  atual.status === "error" || atual.status === "publishing",
  `status=${atual.status}`
);
check(
  "o erro do Instagram chega ao utilizador (toast)",
  /Erro em|token falso recusado|Erro ao publicar/i.test(bodyText),
  bodyText.slice(0, 120)
);

dom.window.close();

console.log("\n─────────────────────────────────────────────");
if (fail) {
  console.log(`❌ ${pass} passaram, ${fail} falharam:`);
  for (const f of failures) console.log(`   • ${f}`);
  if (appLogs.length) {
    console.log("\n   Registos da app (últimas linhas):");
    for (const l of appLogs.slice(-15)) console.log(`   | ${l}`);
  }
  process.exit(1);
}
console.log(`✅ ${pass} passaram, 0 falharam`);
