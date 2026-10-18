#!/usr/bin/env node
/**
 * Testes do «⚡ Agendamento rápido» (agendamento-rapido.js).
 *
 *   node tools/test-agendamento-rapido.mjs
 *
 * Parte A — a lógica com a IA, o TMDB e a fila falsos: entra na fila sem passar
 *           pelo FFmpeg, a legenda e a capa (pôster do TMDB), o modo sem IA, a
 *           pouca certeza, o vídeo fora de 9:16, o vídeo curto, o ficheiro
 *           original guardado tal e qual e a edição da legenda depois de agendado.
 * Parte B — o bundle REAL num DOM (jsdom + IndexedDB falso): a aba «⚡ Rápido»
 *           existe, esconde o Estúdio e mostra o painel; um lote com a IA falsa
 *           grava os Reels na fila verdadeira (IndexedDB) nos horários livres.
 *
 * Precisa de jsdom e fake-indexeddb (npm install --no-save jsdom fake-indexeddb);
 * sem eles, o teste é saltado.
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const RAPIDO = fs.readFileSync(path.join(root, "agendamento-rapido.js"), "utf8");
const LOTE = fs.readFileSync(path.join(root, "lote-massa.js"), "utf8");

let JSDOM, fakeIndexedDB, IDBKeyRange;
try {
  ({ JSDOM } = await import("jsdom"));
  ({ indexedDB: fakeIndexedDB, IDBKeyRange } = await import("fake-indexeddb"));
} catch {
  console.log("\n⚠️  jsdom/fake-indexeddb não estão instalados — teste do agendamento rápido saltado.\n" +
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
   Parte A — lógica com dependências falsas
   ====================================================================== */

/**
 * O painel monta-se sozinho assim que o <div> da aba aparece (MutationObserver).
 * Nos cenários o div já existe, por isso basta esperar pela montagem — na parte
 * B é o bundle quem cria o div e o observador é posto à prova a sério.
 */
async function novoDom() {
  const dom = new JSDOM(
    "<!doctype html><html><head></head><body><div id=\"cc-rapido-monte\"></div></body></html>",
    { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true }
  );
  dom.window.URL.createObjectURL = () => "blob:stub";
  dom.window.URL.revokeObjectURL = () => {};
  dom.window.eval(LOTE);
  dom.window.eval(RAPIDO);
  await waitFor("painel montado", () => dom.window.CineRapido._interno.estado.montado, 4000);
  return dom;
}

/** Ficheiro falso: o nome decide o comportamento dos falsos. */
function ficheiro(window, nome, bytes = 4096) {
  const f = new window.File([new Uint8Array(Math.min(bytes, 64))], nome, { type: "video/mp4", lastModified: 1700000000000 });
  return f;
}

function cenario(window, opcoes = {}) {
  const fila = [];
  const chamadas = {
    identificar: 0, gerarLegenda: 0, historico: 0, quadros: 0,
    processar: 0, detetarBarras: 0, sincronizar: 0, atualizarFila: 0,
  };
  const duracoes = { "bom.mp4": 45, "segundo.mp4": 40, "curto.mp4": 2, "duvida.mp4": 60, "largo.mp4": 30, "cena-epica.mp4": 50 };
  const dimensoes = { "largo.mp4": { largura: 1920, altura: 1080, duracao: 30 } };

  const core = {
    lerMetadados: async (f) => ({ duration: duracoes[f.name] || 30, width: 1080, height: 1920, fields: [] }),
    /* Armadilhas: o modo rápido NÃO edita, por isso o FFmpeg nunca pode ser chamado. */
    detetarBarras: async () => { chamadas.detetarBarras++; return null; },
    processar: async () => { chamadas.processar++; throw new Error("o modo rápido não pode chamar o FFmpeg"); },
    quadros: async () => { chamadas.quadros++; return ["data:image/jpeg;base64,AAA"]; },
    audio: async () => null,
    identificar: async (chave, quadros, lang, info) => {
      chamadas.identificar++;
      if (info.fileName === "duvida.mp4") return { titulo: "Talvez Este", confianca: 50, cena: "cena incerta", ganchos: [] };
      return { titulo: "Filme " + info.fileName, confianca: 90, cena: "cena de " + info.fileName, ganchos: [] };
    },
    procurarTmdb: async (chave, ia) => ({
      title: ia.titulo, original: ia.titulo + " (orig)", year: 2024,
      poster: "https://img/p.jpg", kind: "movie", genres: [], overview: "",
    }),
    gerarLegenda: async (chave, filme) => { chamadas.gerarLegenda++; return `**${filme.title}** — imperdível`; },
    limparLegenda: (t) => String(t).replace(/\*\*(.+?)\*\*/g, "$1").trim(),
    proximoHorario: (filaAtual, horarios, conta) => {
      const n = filaAtual.filter((it) => it.accountId === conta).length;
      const dia = 14 + Math.floor(n / horarios.length);
      return `2026-10-${dia}T${horarios[n % horarios.length]}`;
    },
    guardarNaFila: async (reel) => { fila.push(reel); },
    lerFila: async () => fila.slice(),
    guardarHistorico: () => { chamadas.historico++; },
  };
  const app = {
    settings: Object.assign({ groqKey: "nv-key", geminiKey: "", tmdbKey: "tmdb-key", lang: "pt-BR" }, opcoes.settings || {}),
    account: { id: "acc_cena", name: "@cena.rapida", dailySlots: ["12:00", "18:00"] },
    accounts: [],
    atualizarFila: () => { chamadas.atualizarFila++; },
    sincronizar: async () => { chamadas.sincronizar++; },
    abrirConfiguracoes: () => {},
    abrirAgendador: () => {},
  };
  const rapido = window.CineRapido._interno;
  rapido.ambiente.core = () => core;
  rapido.ambiente.app = () => app;
  rapido.ambiente.lerVideo = async (f) =>
    dimensoes[f.name] || { largura: 1080, altura: 1920, duracao: duracoes[f.name] || 30 };
  return { fila, chamadas, core, app, rapido };
}

console.log("\n⚡ Agendamento rápido — agendamento-rapido.js\n");
console.log("A1. Dois vídeos já editados: legenda + capa, sem edição");
{
  const dom = await novoDom();
  const { window } = dom;
  const c = cenario(window);
  const f1 = ficheiro(window, "bom.mp4");
  const f2 = ficheiro(window, "segundo.mp4");
  const entraram = c.rapido.adicionarFicheiros([f1, f2, ficheiro(window, "notas.txt")]);
  check("só os vídeos contam para o lote (o .txt fica com erro)", entraram === 2, `entraram=${entraram}`);
  check("o .txt fica na lista a explicar o erro", c.rapido.estado.itens.length === 3 && /Formato não suportado/.test(c.rapido.estado.itens[2].erro), c.rapido.estado.itens[2] && c.rapido.estado.itens[2].erro);
  check("o .txt não tem legenda para editar", !/Legenda deste Reel/.test(window.document.querySelector(".cr-painel").textContent) || c.rapido.estado.itens[2].invalido === true);
  check("o painel está montado no div da aba", !!window.document.querySelector("#cc-rapido-monte .cr-painel"));

  await c.rapido.iniciar();

  check("2 Reels entram na fila do Agendador", c.fila.length === 2, `fila=${c.fila.length}`);
  check("o FFmpeg NUNCA é chamado (não há edição)", c.chamadas.processar === 0 && c.chamadas.detetarBarras === 0);
  check("o vídeo guardado é o ficheiro original, sem reconversão", c.fila[0].videoBlob === f1 && c.fila[1].videoBlob === f2);
  check("o nome do ficheiro original é mantido (sem _cineclip)", c.fila[0].videoFileName === "bom.mp4" && c.fila[1].videoFileName === "segundo.mp4");
  check("o Reel fica marcado como «sem edição»", c.fila.every((r) => r.semEdicao === true));
  check("a legenda vem da IA e sem **negrito**", c.fila[0].caption === "Filme bom.mp4 — imperdível", c.fila[0].caption);
  check("a capa é o pôster do TMDB", c.fila.every((r) => r.poster === "https://img/p.jpg"));
  check("o Reel leva título e ano do TMDB", c.fila[0].title === "Filme bom.mp4" && c.fila[0].year === 2024);
  check("vai para a conta ativa, «scheduled», para o Instagram", c.fila.every((r) => r.accountId === "acc_cena" && r.status === "scheduled" && r.platforms[0] === "instagram"));
  check("horários diferentes, nos horários livres da conta", c.fila[0].scheduledAt === "2026-10-14T12:00" && c.fila[1].scheduledAt === "2026-10-14T18:00", c.fila.map((r) => r.scheduledAt).join(", "));
  check("a legenda vai para o histórico", c.chamadas.historico === 2);
  check("o lote pede a sincronização no fim", c.chamadas.sincronizar === 1 && c.chamadas.atualizarFila === 1);

  const texto = window.document.querySelector(".cr-painel").textContent;
  check("o painel mostra o horário de cada Reel", /📅 .*12:00/.test(texto), texto.slice(-300));
  check("o painel diz que a capa é o pôster do TMDB", /Capa: pôster do TMDB/.test(texto));
  check("o painel avisa que este modo não edita", /não há corte, nem reconversão/.test(texto));
  dom.window.close();
}

console.log("\nA2. Com a IA desligada: só legenda, sem capa");
{
  const dom = await novoDom();
  const { window } = dom;
  const c = cenario(window, { settings: { groqKey: "", tmdbKey: "" } });
  c.rapido.estado.opcoes.identificar = false;
  c.rapido.adicionarFicheiros([ficheiro(window, "cena-epica.mp4")]);
  await c.rapido.iniciar();
  check("não chama a IA nem o TMDB", c.chamadas.identificar === 0 && c.chamadas.quadros === 0);
  check("agenda na mesma (sem chaves de IA)", c.fila.length === 1, `fila=${c.fila.length}`);
  check("o título sai do nome do ficheiro", c.fila[0].title === "cena epica", c.fila[0].title);
  check("a legenda sai do modelo do painel", c.fila[0].caption === "🎬 cena epica\n\n#Reels #Cinema", JSON.stringify(c.fila[0].caption));
  check("sem filme identificado, não há capa", !c.fila[0].poster);
  dom.window.close();
}

console.log("\nA3. Pouca certeza da IA");
{
  const dom = await novoDom();
  const { window } = dom;
  const c = cenario(window);
  c.rapido.adicionarFicheiros([ficheiro(window, "duvida.mp4")]);
  await c.rapido.iniciar();
  const item = c.rapido.estado.itens[0];
  check("fica para rever, não é agendado", item.estado === "revisar" && c.fila.length === 0, `${item.estado} fila=${c.fila.length}`);
  check("explica a certeza e a solução", /50% de certeza/.test(item.erro) && /pouca certeza/.test(item.erro), item.erro);
  check("o painel oferece «Agendar mesmo assim»", [...window.document.querySelectorAll("button")].some((b) => /Agendar mesmo assim/.test(b.textContent)));

  c.rapido.estado.opcoes.agendarComPoucaCerteza = true;
  c.rapido.estado.itens[0].estado = "pendente";
  await c.rapido.iniciar();
  check("com a opção ligada, agenda o vídeo duvidoso", c.fila.length === 1 && c.fila[0].title === "Talvez Este", `fila=${c.fila.length}`);
  dom.window.close();
}

console.log("\nA4. Vídeo fora de 9:16: avisa mas agenda");
{
  const dom = await novoDom();
  const { window } = dom;
  const c = cenario(window);
  c.rapido.adicionarFicheiros([ficheiro(window, "largo.mp4")]);
  await c.rapido.iniciar();
  const item = c.rapido.estado.itens[0];
  check("agenda na mesma", item.estado === "agendado" && c.fila.length === 1);
  check("avisa que o vídeo não está em 9:16", /não está em 9:16/.test(item.aviso) && /1920×1080/.test(item.aviso), item.aviso);
  check("o aviso aparece no painel", /não está em 9:16/.test(window.document.querySelector(".cr-painel").textContent));
  dom.window.close();
}

console.log("\nA5. Vídeo demasiado curto");
{
  const dom = await novoDom();
  const { window } = dom;
  const c = cenario(window);
  c.rapido.adicionarFicheiros([ficheiro(window, "curto.mp4")]);
  await c.rapido.iniciar();
  const item = c.rapido.estado.itens[0];
  check("não agenda e explica porquê", item.estado === "erro" && /menos de 3 segundos/.test(item.erro), item.erro);
  check("oferece «Tentar de novo»", [...window.document.querySelectorAll("button")].some((b) => /Tentar de novo/.test(b.textContent)));
  dom.window.close();
}

console.log("\nA6. Editar a legenda já depois de agendado");
{
  const dom = await novoDom();
  const { window } = dom;
  const c = cenario(window);
  c.rapido.adicionarFicheiros([ficheiro(window, "bom.mp4")]);
  await c.rapido.iniciar();
  check("agendado com a legenda da IA", c.fila[0].caption === "Filme bom.mp4 — imperdível");
  const item = c.rapido.estado.itens[0];
  c.rapido.guardarLegenda(item, "Legenda À MÃO **com negrito**");
  await waitFor("a legenda nova chega à fila", () => c.fila[0] && /À MÃO/.test(c.fila[0].caption));
  check("a legenda nova é gravada na fila e limpa", c.fila[0].caption === "Legenda À MÃO com negrito", c.fila[0].caption);
  check("a edição fica marcada (a IA não a volta a substituir)", item.legendaManual === true);
  dom.window.close();
}

console.log("\nA7. O painel recusa ficheiros repetidos e limpa a lista");
{
  const dom = await novoDom();
  const { window } = dom;
  const c = cenario(window);
  c.rapido.adicionarFicheiros([ficheiro(window, "bom.mp4"), ficheiro(window, "bom.mp4")]);
  check("o mesmo ficheiro duas vezes só entra uma", c.rapido.estado.itens.length === 1);
  await c.rapido.iniciar();
  check("agendado", c.fila.length === 1);
  const limpar = [...window.document.querySelectorAll("button")].find((b) => /Limpar concluídos/.test(b.textContent));
  limpar.click();
  check("«Limpar concluídos» esvazia a lista", c.rapido.estado.itens.length === 0);
  dom.window.close();
}

console.log("\nA8. O que falta configurar");
{
  const dom = await novoDom();
  const { window } = dom;
  const c = cenario(window, { settings: { groqKey: "", tmdbKey: "" } });
  check("sem chaves e com a IA ligada, diz o que falta", /chave Gemini\/Groq\/OpenRouter/.test(c.rapido.faltaConfigurar() || ""), c.rapido.faltaConfigurar());
  c.rapido.estado.opcoes.identificar = false;
  check("com a IA desligada, não falta nada", c.rapido.faltaConfigurar() === null, String(c.rapido.faltaConfigurar()));
  dom.window.close();
}

/* ======================================================================
   Parte B — o bundle real
   ====================================================================== */

console.log("\nB. O app real (bundle) com a aba «⚡ Rápido»");

const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
check("index.html carrega agendamento-rapido.js", html.includes('<script src="agendamento-rapido.js"></script>'));
check("…depois do lote-massa.js e antes da nuvem", /lote-massa\.js"><\/script>\s*<script src="agendamento-rapido\.js"><\/script>\s*<script src="nuvem-duravel\.js">/.test(html));
const moduleSource = /<script type="module">([\s\S]*?)<\/script>/.exec(html)[1].replace(/import\.meta\.url/g, '"file:///index.html"');
const cineCloudSource = fs.readFileSync(path.join(root, "nuvem-duravel.js"), "utf8");
const CONTA = { id: "acc_default", name: "@conta.teste", mode: "graph", igUserId: "1", fbPageId: "", metaAccessToken: "x", webhookUrl: "", dailySlots: ["12:00"], autoPilot: false, shareToFeed: true };

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

const dom = new JSDOM(html, { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
const { window } = dom;
window.indexedDB = fakeIndexedDB;
window.IDBKeyRange = IDBKeyRange;
window.TextEncoder = globalThis.TextEncoder;
window.TextDecoder = globalThis.TextDecoder;
try { Object.defineProperty(window, "crypto", { value: globalThis.crypto, configurable: true }); } catch {}
window.fetch = async () => resposta(200, { key: "stub", id: "stub" }, { "content-type": "application/json" });
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
window.localStorage.setItem("cineclip.ig.accounts", JSON.stringify([CONTA]));
window.localStorage.setItem("cineclip.ig.active", CONTA.id);

window.eval(cineCloudSource);
window.eval(LOTE);
window.eval(RAPIDO);
window.eval(moduleSource);

const entrar = await waitFor("ecrã de login", () => [...window.document.querySelectorAll("button")].find((b) => /Entrar e Sincronizar Tudo/.test(b.textContent)));
const [u, p] = window.document.querySelectorAll("input");
for (const [input, valor] of [[u, "teste@cineclip"], [p, "senha-de-teste"]]) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, valor);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}
entrar.click();
await waitFor("app com sessão iniciada", () => window.__CineClipApp && window.__CineClipApp.logado);

const abaRapido = await waitFor("aba «⚡ Rápido»", () => [...window.document.querySelectorAll("button")].find((b) => /Rápido/.test(b.textContent || "")));
check("a barra tem a aba «⚡ Rápido»", !!abaRapido, abaRapido && abaRapido.textContent);
check("a aba fica entre o Estúdio e o seletor de contas", !!abaRapido && /Agendador/.test(abaRapido.previousElementSibling?.textContent || ""));

abaRapido.click();
const monte = await waitFor("ponto de montagem visível", () => {
  const m = window.document.getElementById("cc-rapido-monte");
  return m && !/hidden/.test(m.className) ? m : null;
});
check("clicar na aba mostra o painel do agendamento rápido", !!monte.querySelector(".cr-painel"));
check("o Estúdio fica escondido", /hidden/.test(window.document.querySelector("main").children[0].className));
check("o Agendador também fica escondido", /hidden/.test(window.document.querySelector("main").children[1].className));
check("a aba fica marcada como ativa", /bg-primary/.test(abaRapido.className), abaRapido.className);
check("o painel diz para que conta agenda", /@conta\.teste/.test(monte.textContent));

/* Lote com a IA falsa, mas a fila, os horários e as definições reais */
const rapido = window.CineRapido._interno;
const coreReal = window.CineClipCore;
check("os presets Escuro e Claro continuam disponíveis com a aba Rápido", !!coreReal.presets?.escuro && !!coreReal.presets?.claro);
check("a ponte mantém a geometria e o estilo dos presets", typeof coreReal.enquadramento === "function" && typeof coreReal.presetDoReel === "function");
check("a ponte mantém as melhorias de identificação e gancho", typeof coreReal.videoParaIA === "function" && typeof coreReal.ganchoGenerico === "function");
let ffmpegChamado = 0;
const f1 = new window.File([new Uint8Array(32)], "r1.mp4", { type: "video/mp4" });
const f2 = new window.File([new Uint8Array(32)], "r2.mp4", { type: "video/mp4" });
rapido.adicionarFicheiros([f1, f2]);
rapido.ambiente.lerVideo = async () => ({ largura: 1080, altura: 1920, duracao: 42 });
rapido.ambiente.core = () => Object.assign({}, coreReal, {
  quadros: async () => ["q"],
  audio: async () => null,
  identificar: async (k, q, l, info) => ({ titulo: "Filme " + info.fileName, confianca: 95, cena: "cena", ganchos: [] }),
  procurarTmdb: async (k, ia) => ({ title: ia.titulo, original: ia.titulo, year: 2020, poster: "https://img/p.jpg", kind: "movie", genres: [], overview: "" }),
  processar: async () => { ffmpegChamado++; throw new Error("o modo rápido não pode chamar o FFmpeg"); },
  gerarLegenda: async (k, filme) => `**${filme.title}** é incrível`,
});
rapido.ambiente.app = () => Object.assign({}, window.__CineClipApp, {
  settings: Object.assign({}, window.__CineClipApp.settings, { groqKey: "nv", tmdbKey: "tm" }),
});
await rapido.iniciar();

const filaReal = await coreReal.lerFila();
const doRapido = filaReal.filter((r) => /^Filme r[12]\.mp4$/.test(r.title));
check("os 2 Reels ficam na fila real (IndexedDB)", doRapido.length === 2, `fila=${filaReal.length}`);
check("na conta ativa, com estado scheduled", doRapido.every((r) => r.accountId === "acc_default" && r.status === "scheduled"));
check("em horários diferentes às 12:00 (o horário da conta)", doRapido.length === 2 && doRapido[0].scheduledAt !== doRapido[1].scheduledAt && doRapido.every((r) => String(r.scheduledAt).endsWith("T12:00")), doRapido.map((r) => r.scheduledAt).join(", "));
check("a legenda é limpa pelo app (sem **)", doRapido.every((r) => !r.caption.includes("**")), doRapido.map((r) => r.caption).join(" | "));
check("a capa vem do TMDB", doRapido.every((r) => r.poster === "https://img/p.jpg"));
check("o FFmpeg nunca é chamado no app real", ffmpegChamado === 0);
/* O IndexedDB falso não preserva o conteúdo do Blob, mas o tamanho e a marca
   «sem edição» mostram que foi o ficheiro original a entrar na fila. */
check("o ficheiro original entra na fila sem reconversão", doRapido.every((r) => r.videoBlob && r.videoSize === 32 && r.semEdicao === true), doRapido.map((r) => `${r.videoSize}/${r.semEdicao}`).join(", "));
check("o nome do ficheiro original é mantido", doRapido.every((r) => /^r[12]\.mp4$/.test(r.videoFileName)), doRapido.map((r) => r.videoFileName).join(", "));

dom.window.close();

console.log("\n─────────────────────────────────────────────");
if (fail) {
  console.log(`❌ ${pass} passaram, ${fail} falharam:`);
  for (const f of failures) console.log(`   • ${f}`);
  process.exit(1);
}
console.log(`✅ ${pass} passaram, 0 falharam`);
