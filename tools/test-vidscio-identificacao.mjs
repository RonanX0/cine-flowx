#!/usr/bin/env node
/**
 * Testes do motor VidScio e da limpeza dos ganchos (bug do "Gancho 1: …").
 *
 *   node tools/test-vidscio-identificacao.mjs
 *
 * Parte A — o ficheiro: os prompts já não usam o placeholder "Gancho 1 😳"
 *           (que a IA copiava para o texto), proíbem numerar e passam todos
 *           os ganchos pela limpeza (_gcLimpaLista).
 * Parte B — o bundle REAL num DOM (jsdom + IndexedDB falso):
 *           • window.CineClipCore.limparGancho limpa "Gancho 1: ele matou a
 *             mulher 😳" → "ele matou a mulher 😳" (e não estraga ganchos
 *             legítimos que começam por número);
 *           • gerarGancho com a IA falsa devolvendo ganchos sujos (JSON e
 *             texto solto) devolve só a frase pronta;
 *           • identificar (VidScio) também devolve ganchos limpos.
 *
 * Precisa de jsdom e fake-indexeddb (npm install --no-save jsdom fake-indexeddb);
 * sem eles, o teste é saltado.
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

let JSDOM, fakeIndexedDB, IDBKeyRange;
try {
  ({ JSDOM } = await import("jsdom"));
  ({ indexedDB: fakeIndexedDB, IDBKeyRange } = await import("fake-indexeddb"));
} catch {
  console.log("\n⚠️  jsdom/fake-indexeddb não estão instalados — teste VidScio/ganchos saltado.\n" +
    "   Corre: npm install --no-save jsdom fake-indexeddb\n");
  process.exit(0);
}

let pass = 0;
let fail = 0;
const failures = [];
function check(nome, ok, detalhe = "") {
  if (ok) {
    pass++;
    console.log(`   ✔ ${nome}`);
  } else {
    fail++;
    failures.push(nome);
    console.log(`   ❌ ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(desc, fn, timeout = 8000) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`Tempo esgotado à espera de: ${desc}`);
    await sleep(25);
  }
}

/* ======================================================================
   Parte A — o ficheiro (index.html / app-pronto.html / 404.html)
   ====================================================================== */

console.log("\nA. Prompts e limpeza no ficheiro");

const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const loteSrc = fs.readFileSync(path.join(root, "lote-massa.js"), "utf8");

check("o bloco ==CINECLIP-GANCHO-LIMPO== existe no bundle", html.includes("==CINECLIP-GANCHO-LIMPO=="));
check('o placeholder "Gancho 1 😳" desapareceu dos exemplos dos prompts', !html.includes('["Gancho 1 😳"'));
check('o placeholder "Gancho 1 sobre a cena" desapareceu do prompt VidScio', !html.includes("Gancho 1 sobre a cena"));
check("o prompt principal proíbe numerar/rótular (PROIBIDO numerar)", html.includes("PROIBIDO numerar ou rotular"));
check("o prompt NVIDIA proíbe rótulos no início do gancho", html.includes('SEM rótulos como "Gancho 1" ou "1." no início'));
check("o prompt VidScio tem a regra 7 dos ganchos", html.includes('7. GANCHOS ("ganchos")'));
check("os exemplos dos prompts são frases reais prontas a publicar", html.includes("Ele descobriu a verdade da pior maneira 😳"));
check("Hm: ganchos do JSON passam por _gcLimpaLista", html.includes("k=_gcLimpaLista(Array.isArray(_.ganchos)?_.ganchos:[])"));
check("Hm: fallback de linhas passa por _gcLimpa", html.includes(".map(_=>_gcLimpa(_)).filter(_=>_.length>=8"));
check("_vsParseIA: ganchos do VidScio passam por _gcLimpaLista", html.includes("ganchos:Array.isArray(k.ganchos)?_gcLimpaLista(k.ganchos):void 0"));
check("CineClipCore exporta limparGancho/limparGanchos", html.includes("limparGancho:_gcLimpa,limparGanchos:_gcLimpaLista"));
check("lote-massa limpa o gancho da IA antes de gravar no Reel", loteSrc.includes("typeof core.limparGancho === \"function\"") && loteSrc.includes(".map(limparGancho)"));

const appPronto = fs.readFileSync(path.join(root, "app-pronto.html"), "utf8");
const fallback404 = fs.readFileSync(path.join(root, "404.html"), "utf8");
check("app-pronto.html e 404.html sincronizados com index.html", html === appPronto && html === fallback404);

/* ======================================================================
   Parte B — o bundle real num DOM
   ====================================================================== */

console.log("\nB. O bundle real (jsdom): limpeza dos ganchos");

function resposta(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => headers[String(n).toLowerCase()] ?? null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body ?? {})),
    json: async () => (typeof body === "string" ? JSON.parse(body) : body ?? {}),
    body: { cancel: async () => {} },
  };
}

/** Resposta da IA (Gemini) — mutável para cada cenário. */
let respostaGemini = "";
const dom = new JSDOM(html, { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
const { window } = dom;
window.indexedDB = fakeIndexedDB;
window.IDBKeyRange = IDBKeyRange;
window.TextEncoder = globalThis.TextEncoder;
window.TextDecoder = globalThis.TextDecoder;
try { Object.defineProperty(window, "crypto", { value: globalThis.crypto, configurable: true }); } catch {}
window.fetch = async (url) => {
  if (String(url).includes("generativelanguage")) return resposta(200, { candidates: [{ content: { parts: [{ text: respostaGemini }] } }] });
  return resposta(200, { key: "stub", id: "stub" }, { "content-type": "application/json" });
};
window.matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false });
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.HTMLMediaElement.prototype.play = () => Promise.resolve();
window.HTMLMediaElement.prototype.pause = () => {};
window.HTMLMediaElement.prototype.load = () => {};
window.scrollTo = () => {};
window.confirm = () => true;
window.URL.createObjectURL = () => "blob:stub";
window.URL.revokeObjectURL = () => {};
const logs = [];
for (const n of ["log", "info", "debug", "warn"]) window.console[n] = (...a) => logs.push(a.map(String).join(" "));
const CONTA = { id: "acc_default", name: "@conta.teste", mode: "graph", igUserId: "1", fbPageId: "", metaAccessToken: "x", webhookUrl: "", dailySlots: ["12:00"], autoPilot: false, shareToFeed: true };
window.localStorage.setItem("cineclip.ig.accounts", JSON.stringify([CONTA]));
window.localStorage.setItem("cineclip.ig.active", CONTA.id);

const moduleSource = /<script type="module">([\s\S]*?)<\/script>/.exec(html)[1].replace(/import\.meta\.url/g, '"file:///index.html"');
const cineCloudSource = fs.readFileSync(path.join(root, "nuvem-duravel.js"), "utf8");
window.eval(cineCloudSource);
window.eval(moduleSource);

const core = await waitFor("window.CineClipCore", () => window.CineClipCore);
check("CineClipCore continua a expor as funções do bundle", ["identificar", "gerarGancho", "processar", "gerarLegenda"].every((n) => typeof core[n] === "function"));
check("o gancho padrão vem das definições do app", core.ganchoPadrao === "Você precisa assistir esse filme 😳");

/* ---- B1. limparGancho: rótulos, numeração, aspas e lixo ---- */
const casos = [
  ["Gancho 1: ele matou a mulher 😳", "ele matou a mulher 😳"],
  ["gancho1 ele matou a mulher", "ele matou a mulher"],
  ["Gancho 2 - a reação dela é impagável 🔥", "a reação dela é impagável 🔥"],
  ["1. ele matou a mulher 😳", "ele matou a mulher 😳"],
  ["2) Ninguém viu isso chegar 😱", "Ninguém viu isso chegar 😱"],
  ["3 - Ninguém viu isso chegar 😱", "Ninguém viu isso chegar 😱"],
  ["Opção 3: o motivo da discussão 😱", "o motivo da discussão 😱"],
  ["Gancho: ele matou a mulher", "ele matou a mulher"],
  ['"ele matou a mulher 😳"', "ele matou a mulher 😳"],
  ["Gancho nº1 a cena que ninguém esquece 😳", "a cena que ninguém esquece 😳"],
];
for (const [suja, limpa] of casos) {
  check(`limparGancho(${JSON.stringify(suja)})`, core.limparGancho(suja) === limpa, `devolveu ${JSON.stringify(core.limparGancho(suja))}`);
}

/* ---- B2. limparGancho NÃO estraga ganchos legítimos ---- */
const legitimos = [
  "7 minutos de puro terror 😱",
  "3 segundos mudaram tudo 😳",
  "Gancho de longo.mp4 😳",
  "O momento exato em que tudo mudou nessa cena 😳",
];
for (const g of legitimos) {
  check(`limparGancho preserva ${JSON.stringify(g)}`, core.limparGancho(g) === g, `devolveu ${JSON.stringify(core.limparGancho(g))}`);
}

/* ---- B3. limparGancho descarta lixo ---- */
for (const lixo of ["Gancho", "1", "   ", "", "😳", "23"]) {
  check(`limparGancho(${JSON.stringify(lixo)}) devolve vazio`, core.limparGancho(lixo) === "");
}

/* ---- B4. limparGanchos deduplica e limita ---- */
const lista = core.limparGanchos(["Ele morre na cena final 😳", "ele morre na cena final 🔥", "Gancho 1: a reação dela é impagável 😱", "Gancho"]);
check("limparGanchos remove duplicados e lixo", lista.length === 2 && lista[0] === "Ele morre na cena final 😳" && lista[1] === "a reação dela é impagável 😱", JSON.stringify(lista));

/* ---- B5. gerarGancho: JSON sujo → ganchos limpos ---- */
const QUADRO = "data:image/jpeg;base64,QUJD";
respostaGemini = JSON.stringify({
  cena: "Ele confronta a mulher sobre a traição e a situação escapa ao controle",
  ganchos: ["Gancho 1: ele matou a mulher 😳", "gancho2 A reação dela é impagável 🔥", "3. Ninguém viu isso chegar 😱"],
});
let r1;
try {
  r1 = await core.gerarGancho("", [QUADRO], "pt-BR", "cena-suja.mp4", "chave-gemini-falsa", null);
  const ok = Array.isArray(r1.ganchos) && r1.ganchos.length === 3 &&
    r1.ganchos[0] === "ele matou a mulher 😳" &&
    r1.ganchos[1] === "A reação dela é impagável 🔥" &&
    r1.ganchos[2] === "Ninguém viu isso chegar 😱";
  check("gerarGancho devolve os ganchos limpos (JSON da IA sujo)", ok, JSON.stringify(r1.ganchos));
  check("gerarGancho devolve a cena identificada", r1.cena === "Ele confronta a mulher sobre a traição e a situação escapa ao controle");
} catch (e) {
  check("gerarGancho devolve os ganchos limpos (JSON da IA sujo)", false, e && e.message);
}

/* ---- B6. gerarGancho: resposta em texto solto (fallback) ---- */
respostaGemini = "Aqui estão os ganchos:\n1. Gancho 1: ele matou a mulher 😳\n2) A reação dela é impagável 🔥\n3 - Ninguém viu isso chegar 😱";
let r2;
try {
  r2 = await core.gerarGancho("", [QUADRO], "pt-BR", "cena-fallback.mp4", "chave-gemini-falsa", null);
  const ok = Array.isArray(r2.ganchos) && r2.ganchos.length === 3 &&
    r2.ganchos[0] === "ele matou a mulher 😳" &&
    r2.ganchos[1] === "A reação dela é impagável 🔥" &&
    r2.ganchos[2] === "Ninguém viu isso chegar 😱";
  check("gerarGancho limpa também o fallback de texto solto (sem linha de abertura)", ok, JSON.stringify(r2.ganchos));
} catch (e) {
  check("gerarGancho limpa também o fallback de texto solto (sem linha de abertura)", false, e && e.message);
}

/* ---- B7. identificar (VidScio): ganchos sujos → limpos ---- */
respostaGemini = JSON.stringify({
  fala_do_audio: "Você não devia ter feito isso com ela.",
  atores: ["Ator Fictício"],
  personagens: ["Personagem Fictícia"],
  texto_na_tela: "",
  ancoras_visuais: "cozinha à noite, tom dramático",
  cena: "Ele confronta a mulher sobre a traição na cozinha",
  tipo: "movie",
  temporada_episodio: "",
  titulo: "Filme Teste VidScio",
  titulo_original: "VidScio Test Movie",
  ano: 2024,
  confianca: 95,
  ganchos: ["Gancho 1: ele matou a mulher 😳", "gancho2 A reação dela é impagável 🔥", "3. Ninguém viu isso chegar 😱"],
  alternativas: [],
});
let id1;
try {
  id1 = await core.identificar("", [QUADRO], "pt-BR", { fileName: "vidscio-sujo.mp4", userHint: "cena de teste", geminiKey: "chave-gemini-falsa", audioClip: null });
  const ok = id1 && id1.titulo === "Filme Teste VidScio" &&
    Array.isArray(id1.ganchos) && id1.ganchos.length === 3 &&
    id1.ganchos[0] === "ele matou a mulher 😳" &&
    id1.ganchos[1] === "A reação dela é impagável 🔥" &&
    id1.ganchos[2] === "Ninguém viu isso chegar 😱";
  check("identificar (VidScio) devolve os ganchos limpos", ok, JSON.stringify(id1 && id1.ganchos));
  check("identificar (VidScio) mantém o título e a confiança", id1 && id1.titulo === "Filme Teste VidScio" && id1.confianca === 95);
} catch (e) {
  check("identificar (VidScio) devolve os ganchos limpos", false, e && e.message);
}

/* ====================================================================== */

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} verificações passaram${fail ? `, ${fail} falharam` : ""}\n`);
if (fail) {
  console.log("Falhas:", failures.join(" · "), "\n");
  process.exit(1);
}
