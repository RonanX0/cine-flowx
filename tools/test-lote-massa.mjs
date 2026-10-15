#!/usr/bin/env node
/**
 * Testes do upload em massa (lote-massa.js).
 *
 *   node tools/test-lote-massa.mjs
 *
 * Parte A — a lógica do lote com a IA, o FFmpeg e a fila falsos: o que entra na
 *           fila do Agendador, o corte em 90 s, o gancho da IA, a confiança baixa,
 *           o vídeo H.265, as chaves em falta e o botão Parar.
 * Parte B — o bundle REAL num DOM (jsdom + IndexedDB falso): a ponte
 *           window.CineClipCore / window.__CineClipApp existe, o botão "Upload em
 *           massa" abre o painel, escolher vários ficheiros abre o lote, e um lote
 *           com a IA/FFmpeg falsos grava os Reels na fila verdadeira (IndexedDB) nos
 *           horários livres certos.
 * Parte C — o motor do lote: a IA do vídeo seguinte corre DURANTE o FFmpeg do atual
 *           (e em fila indiana com a opção desligada), tentativas automáticas para
 *           erros passageiros (e nenhuma para os definitivos), parar/continuar sem
 *           repetir a IA, o painel que não se redesenha a cada aviso do FFmpeg, a
 *           memória libertada depois de agendar e os botões de repetir/limpar.
 * Parte D — a fila guardada (IndexedDB): a página nova retoma o lote, o vídeo já
 *           preparado não volta a passar pela IA e o que foi agendado sai do guardado.
 *
 * Precisa de jsdom e fake-indexeddb (npm install --no-save jsdom fake-indexeddb);
 * sem eles, o teste é saltado.
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const LOTE = fs.readFileSync(path.join(root, "lote-massa.js"), "utf8");

let JSDOM, fakeIndexedDB, IDBKeyRange;
try {
  ({ JSDOM } = await import("jsdom"));
  ({ indexedDB: fakeIndexedDB, IDBKeyRange } = await import("fake-indexeddb"));
} catch {
  console.log("\n⚠️  jsdom/fake-indexeddb não estão instalados — teste do upload em massa saltado.\n" +
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

function novoDom() {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url: "http://localhost/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  dom.window.URL.createObjectURL = () => "blob:stub";
  dom.window.URL.revokeObjectURL = () => {};
  dom.window.eval(LOTE);
  return dom;
}

/** Ficheiro falso: o nome decide o comportamento dos falsos. */
function ficheiro(window, nome, bytes = 4096) {
  return new window.File([new Uint8Array(Math.min(bytes, 64))], nome, { type: "video/mp4" });
}

function cenario(window, opcoes = {}) {
  const fila = [];
  const chamadas = { processar: [], identificar: 0, gerarGancho: 0, sincronizar: 0, atualizarFila: 0, historico: 0, cancelar: 0 };
  const slots = ["12:00", "18:00"];
  let travarProcessamento = null;

  const duracoes = { "longo.mp4": 120, "curto.mp4": 40, "sem-gancho.mp4": 70, "duvida.mp4": 60, "parar.mp4": 50, "depois.mp4": 50, "hevc.mp4": 60 };

  const core = {
    lerMetadados: async (f) => ({ duration: duracoes[f.name] || 30, fields: [{ label: "Título", value: "meta-" + f.name }] }),
    detetarBarras: async () => ({ y: 100, h: 800, vh: 1080 }),
    quadros: async () => ["data:image/jpeg;base64,AAA"],
    audio: async () => null,
    identificar: async (chave, quadros, lang, info) => {
      chamadas.identificar++;
      const nome = info.fileName;
      if (nome === "duvida.mp4") return { titulo: "Talvez Este", confianca: 50, cena: "cena incerta", ganchos: ["Gancho incerto 🤔"] };
      if (nome === "sem-gancho.mp4") return { titulo: "Sem Gancho", confianca: 90, cena: "", ganchos: [] };
      return { titulo: "Filme " + nome, confianca: 92, cena: "cena de " + nome, ganchos: ["Gancho de " + nome + " 😳", "outro"] };
    },
    procurarTmdb: async (chave, ia) => ({ title: ia.titulo, original: ia.titulo + " (orig)", year: 2024, poster: "https://img/p.jpg", kind: "movie", genres: [], overview: "" }),
    gerarGancho: async () => {
      chamadas.gerarGancho++;
      return { cena: "cena gerada", ganchos: ["Gancho gerado 🔥"] };
    },
    processar: async (f, inicio, fim, resolucao, gancho, progresso, corte) => {
      chamadas.processar.push({ nome: f.name, inicio, fim, resolucao, gancho, corte });
      progresso(0.5);
      if (f.name === "parar.mp4") {
        await new Promise((resolve, reject) => {
          travarProcessamento = { resolve, reject };
        });
      }
      progresso(1);
      return new window.Blob([new Uint8Array(100)], { type: "video/mp4" });
    },
    cancelarProcessamento: () => {
      chamadas.cancelar++;
      if (travarProcessamento) travarProcessamento.reject(new Error("terminated"));
    },
    gerarLegenda: async (chave, filme, lang, extra) => `**${filme.title}** — ${extra.hookText}`,
    limparLegenda: (t) => t.replace(/\*\*(.+?)\*\*/g, "$1").trim(),
    proximoHorario: (filaAtual, horarios, conta) => {
      const n = filaAtual.filter((it) => it.accountId === conta).length;
      const dia = 14 + Math.floor(n / horarios.length);
      return `2026-10-${dia}T${horarios[n % horarios.length]}`;
    },
    guardarNaFila: async (reel) => { fila.push(reel); },
    lerFila: async () => fila.slice(),
    guardarHistorico: () => { chamadas.historico++; },
    ganchoPadrao: "Você precisa assistir esse filme 😳",
  };
  const app = {
    settings: Object.assign({ nvidiaKey: "nv-key", geminiKey: "", tmdbKey: "tmdb-key", lang: "pt-BR", resolution: "720", overlayText: "Texto padrão" }, opcoes.settings || {}),
    account: { id: "acc_cena", name: "@cena.oculta", dailySlots: slots },
    accounts: [],
    atualizarFila: () => { chamadas.atualizarFila++; },
    sincronizar: async () => { chamadas.sincronizar++; },
    abrirConfiguracoes: () => {},
    abrirAgendador: () => {},
    abrirNoEstudio: () => {},
  };
  const lote = window.CineLote._interno;
  lote.ambiente.core = () => core;
  lote.ambiente.app = () => app;
  lote.ambiente.lerVideo = async (f) => (f.name === "hevc.mp4"
    ? { largura: 0, altura: 0, duracao: 60 }
    : { largura: 1920, altura: 1080, duracao: duracoes[f.name] || 30 });
  return { fila, chamadas, core, app, lote, liberar: () => travarProcessamento && travarProcessamento.resolve() };
}

console.log("\n📦 Upload em massa — lote-massa.js\n");
console.log("A1. Um lote com vídeos bons, um H.265, um com pouca certeza e um inválido");
{
  const dom = novoDom();
  const { window } = dom;
  const c = cenario(window);
  window.CineLote.abrir();
  const entraram = c.lote.adicionarFicheiros([
    ficheiro(window, "longo.mp4"),
    ficheiro(window, "hevc.mp4"),
    ficheiro(window, "curto.mp4"),
    ficheiro(window, "duvida.mp4"),
    ficheiro(window, "notas.txt"),
  ]);
  check("4 ficheiros válidos entram na lista (o .txt fica com erro)", entraram === 4, `entraram=${entraram}`);
  const botaoComecar = [...window.document.querySelectorAll("button")].find((b) => /Começar \(4 vídeos\)/.test(b.textContent));
  check("o painel mostra «Começar (4 vídeos)»", !!botaoComecar);

  await c.lote.iniciar();
  const porNome = Object.fromEntries(c.lote.estado.itens.map((it) => [it.nome, it]));

  check("2 Reels entram na fila do Agendador", c.fila.length === 2, `fila=${c.fila.length}`);
  check("longo.mp4 é cortado em 90 s", c.chamadas.processar.find((p) => p.nome === "longo.mp4")?.fim === 90);
  check("curto.mp4 usa o vídeo todo (40 s)", c.chamadas.processar.find((p) => p.nome === "curto.mp4")?.fim === 40);
  check("o corte começa sempre no início (0 s)", c.chamadas.processar.every((p) => p.inicio === 0));
  check("as barras pretas detetadas vão para o FFmpeg", c.chamadas.processar[0]?.corte?.top === 100 && c.chamadas.processar[0]?.corte?.bottom === 180);
  check("o gancho de cada vídeo vem da IA", c.fila[0].hookText === "Gancho de longo.mp4 😳" && c.fila[1].hookText === "Gancho de curto.mp4 😳", c.fila.map((r) => r.hookText).join(" | "));
  check("o gancho vai para o vídeo (FFmpeg)", c.chamadas.processar[0].gancho === "Gancho de longo.mp4 😳");
  check("a legenda é da IA e sem **negrito**", c.fila[0].caption === "Filme longo.mp4 — Gancho de longo.mp4 😳", c.fila[0].caption);
  check("os Reels vão para a conta ativa", c.fila.every((r) => r.accountId === "acc_cena"));
  check("horários diferentes, nos horários livres da conta", c.fila[0].scheduledAt === "2026-10-14T12:00" && c.fila[1].scheduledAt === "2026-10-14T18:00", c.fila.map((r) => r.scheduledAt).join(", "));
  check("o Reel leva título, ano e pôster do TMDB", c.fila[0].title === "Filme longo.mp4" && c.fila[0].year === 2024 && c.fila[0].poster === "https://img/p.jpg");
  check("o Reel leva o vídeo processado e o nome _cineclip.mp4", c.fila[0].videoBlob && c.fila[0].videoBlob.size === 100 && c.fila[0].videoFileName === "longo_cineclip.mp4");
  check("o Reel fica «scheduled» para Instagram", c.fila.every((r) => r.status === "scheduled" && r.platforms[0] === "instagram"));
  check("H.265: erro claro sem gastar a IA", porNome["hevc.mp4"].estado === "erro" && /H\.265\/HEVC/.test(porNome["hevc.mp4"].erro), porNome["hevc.mp4"].erro);
  check("pouca certeza: fica para rever, não é agendado", porNome["duvida.mp4"].estado === "revisar" && /50%/.test(porNome["duvida.mp4"].erro), porNome["duvida.mp4"].erro);
  check("pouca certeza: não chega a processar o vídeo", !c.chamadas.processar.some((p) => p.nome === "duvida.mp4"));
  check("o .txt fica com erro de formato", porNome["notas.txt"].estado === "erro" && /Formato não suportado/.test(porNome["notas.txt"].erro));
  check("cada Reel agendado pede a sincronização (upload para a nuvem)", c.chamadas.sincronizar === 2 && c.chamadas.atualizarFila === 2);
  check("a legenda vai para o histórico de legendas", c.chamadas.historico === 2);

  const textoPainel = window.document.querySelector(".cl-painel").textContent;
  check("o painel mostra o resumo do lote", /2 agendados/.test(textoPainel) && /1 para rever/.test(textoPainel) && /2 com erro/.test(textoPainel), textoPainel.slice(-160));
  check("o painel mostra o horário legível", /14\/10 às 12:00/.test(textoPainel));
  check("«Abrir no Estúdio» aparece para o vídeo a rever", [...window.document.querySelectorAll(".cl-item[data-estado=revisar] button")].some((b) => b.textContent === "Abrir no Estúdio"));
  check("o .txt não tem «Tentar de novo»", ![...window.document.querySelectorAll(".cl-item")].find((li) => /notas\.txt/.test(li.textContent))?.textContent.includes("Tentar de novo"));
  dom.window.close();
}

console.log("\nA2. Sem gancho na identificação → pede um gancho à IA");
{
  const dom = novoDom();
  const c = cenario(dom.window);
  c.lote.adicionarFicheiros([ficheiro(dom.window, "sem-gancho.mp4")]);
  await c.lote.iniciar();
  check("chama a IA de ganchos", c.chamadas.gerarGancho === 1);
  check("usa o gancho gerado", c.fila[0]?.hookText === "Gancho gerado 🔥", c.fila[0]?.hookText);
  dom.window.close();
}

console.log("\nA3. Opção «Agendar mesmo com pouca certeza»");
{
  const dom = novoDom();
  const c = cenario(dom.window);
  c.lote.estado.opcoes.agendarComPoucaCerteza = true;
  c.lote.adicionarFicheiros([ficheiro(dom.window, "duvida.mp4")]);
  await c.lote.iniciar();
  check("agenda o vídeo com 50% de certeza", c.fila.length === 1 && c.fila[0].title === "Talvez Este");
  dom.window.close();
}

console.log("\nA3b. Vídeo H.265/MKV sem imagem no <video>, mas com dimensões no MediaInfo → processa até ao fim");
{
  const dom = novoDom();
  const c = cenario(dom.window);
  const origCore = c.lote.ambiente.core();
  c.lote.ambiente.core = () => Object.assign({}, origCore, {
    lerMetadados: async (f) => ({ duration: 60, width: 1080, height: 1920, fields: [] }),
  });
  c.lote.adicionarFicheiros([ficheiro(dom.window, "hevc.mp4")]);
  await c.lote.iniciar();
  check("recupera dimensões pelo MediaInfo e agenda o vídeo", c.fila.length === 1 && c.lote.estado.itens[0].estado === "agendado");
  dom.window.close();
}

console.log("\nA3c. Chaves no localStorage antes do estado React hidratar → não trava no arranque");
{
  const dom = novoDom();
  dom.window.localStorage.setItem("cineclip.settings", JSON.stringify({ nvidiaKey: "nvapi-ok", tmdbKey: "tmdb-ok" }));
  const c = cenario(dom.window, { settings: { nvidiaKey: "", geminiKey: "", tmdbKey: "" } });
  check("faltaConfigurar lê as chaves guardadas no localStorage", c.lote.faltaConfigurar() === null);
  c.lote.adicionarFicheiros([ficheiro(dom.window, "curto.mp4")]);
  await c.lote.iniciar();
  check("processa e agenda sem ficar preso", c.fila.length === 1 && c.lote.estado.itens[0].estado === "agendado");
  dom.window.close();
}

console.log("\nA3d. Anti-duplicação no lote e nos links");
{
  const dom = novoDom();
  const c = cenario(dom.window);
  const f = ficheiro(dom.window, "curto.mp4");
  const n = c.lote.adicionarFicheiros([f, f]);
  check("adicionar o mesmo File duas vezes só entra uma vez no lote", n === 1 && c.lote.estado.itens.length === 1, `n=${n}`);
  const links = c.lote.extrairLinks("https://vm.tiktok.com/ZMdup1/?_t=1\nhttps://vm.tiktok.com/ZMdup1/?_t=2");
  check("extrairLinks ignora o mesmo link com query params diferentes", links.length === 1, JSON.stringify(links));
  dom.window.close();
}

console.log("\nA4. Chaves em falta");
{
  const dom = novoDom();
  const c = cenario(dom.window, { settings: { nvidiaKey: "", geminiKey: "", tmdbKey: "" } });
  dom.window.CineLote.abrir();
  c.lote.adicionarFicheiros([ficheiro(dom.window, "longo.mp4")]);
  await c.lote.iniciar();
  check("não processa nada", c.chamadas.identificar === 0 && c.fila.length === 0);
  const texto = dom.window.document.querySelector(".cl-painel").textContent;
  check("explica que falta a chave da IA", /chave NVIDIA ou Google Gemini/.test(texto));
  check("oferece «Abrir configurações»", /Abrir configurações/.test(texto));
  const c2 = cenario(dom.window, { settings: { tmdbKey: "" } });
  check("explica que falta a chave TMDB", /chave TMDB/.test(c2.lote.faltaConfigurar() || ""));
  dom.window.close();
}

console.log("\nA5. Botão Parar a meio do FFmpeg");
{
  const dom = novoDom();
  const { window } = dom;
  const c = cenario(window);
  window.CineLote.abrir();
  c.lote.adicionarFicheiros([ficheiro(window, "parar.mp4"), ficheiro(window, "depois.mp4")]);
  const corrida = c.lote.iniciar();
  await waitFor("FFmpeg a correr", () => c.chamadas.processar.length === 1);
  const botaoParar = [...window.document.querySelectorAll("button")].find((b) => b.textContent === "Parar");
  check("aparece o botão Parar", !!botaoParar);
  botaoParar.click();
  await corrida;
  check("interrompe o FFmpeg", c.chamadas.cancelar === 1);
  check("nada é agendado", c.fila.length === 0);
  check("os dois vídeos voltam a ficar na fila do lote", c.lote.estado.itens.every((it) => it.estado === "pendente"), c.lote.estado.itens.map((it) => it.estado).join(","));
  check("o segundo vídeo não começou", c.chamadas.processar.length === 1);
  dom.window.close();
}

console.log("\nA6. Fechar o painel durante o lote");
{
  const dom = novoDom();
  const { window } = dom;
  const c = cenario(window);
  window.CineLote.abrir();
  c.lote.adicionarFicheiros([ficheiro(window, "parar.mp4"), ficheiro(window, "curto.mp4")]);
  const corrida = c.lote.iniciar();
  await waitFor("FFmpeg a correr", () => c.chamadas.processar.length === 1);
  window.CineLote.fechar();
  const pilula = window.document.querySelector(".cl-pilula");
  check("o lote continua e aparece o atalho no canto", !!pilula && /1\/2/.test(pilula.textContent), pilula && pilula.textContent);
  c.liberar();
  await corrida;
  check("o lote termina com o painel fechado", c.fila.length === 2);
  check("o atalho desaparece no fim", !window.document.querySelector(".cl-pilula"));
  dom.window.close();
}

/* ======================================================================
   Parte B — o bundle real
   ====================================================================== */

console.log("\nB. O app real (bundle) com o upload em massa");

const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
check("index.html carrega lote-massa.js", html.includes('<script src="lote-massa.js"></script>'));
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
window.eval(moduleSource);

const entrar = await waitFor("ecrã de login", () => [...window.document.querySelectorAll("button")].find((b) => /Entrar e Sincronizar Tudo/.test(b.textContent)));
const [u, p] = window.document.querySelectorAll("input");
for (const [input, valor] of [[u, "teste@cineclip"], [p, "senha-de-teste"]]) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, valor);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}
entrar.click();
const botaoLote = await waitFor("botão Upload em massa", () => [...window.document.querySelectorAll("button")].find((b) => /Upload em massa/.test(b.textContent)));
check("o Estúdio mostra o botão «📦 Upload em massa»", !!botaoLote);

const nomesCore = ["lerMetadados", "detetarBarras", "quadros", "audio", "identificar", "procurarTmdb", "gerarGancho", "processar", "cancelarProcessamento", "gerarLegenda", "limparLegenda", "proximoHorario", "guardarNaFila", "lerFila", "guardarHistorico"];
const coreReal = window.CineClipCore;
check("window.CineClipCore expõe as 15 funções do bundle", !!coreReal && nomesCore.every((n) => typeof coreReal[n] === "function"), coreReal ? nomesCore.filter((n) => typeof coreReal[n] !== "function").join(",") : "sem CineClipCore");
check("o gancho padrão vem das definições do app", coreReal && coreReal.ganchoPadrao === "Você precisa assistir esse filme 😳");
const appReal = window.__CineClipApp;
check("window.__CineClipApp tem a conta ativa", appReal && appReal.account && appReal.account.id === "acc_default", appReal && JSON.stringify(appReal.account && appReal.account.id));
check("window.__CineClipApp tem as definições e as ações", appReal && appReal.settings && typeof appReal.sincronizar === "function" && typeof appReal.abrirNoEstudio === "function");

const inputFicheiro = window.document.querySelector('input[type="file"]');
check("o seletor de ficheiros aceita vários", !!inputFicheiro && inputFicheiro.multiple === true);

botaoLote.click();
check("o botão abre o painel do upload em massa", !!window.document.querySelector(".cl-painel"));
check("o painel diz para que conta agenda", /@conta\.teste/.test(window.document.querySelector(".cl-painel").textContent));
window.CineLote.fechar();

const f1 = new window.File([new Uint8Array(32)], "a.mp4", { type: "video/mp4" });
const f2 = new window.File([new Uint8Array(32)], "b.mp4", { type: "video/mp4" });
Object.defineProperty(inputFicheiro, "files", { value: [f1, f2], configurable: true });
inputFicheiro.dispatchEvent(new window.Event("change", { bubbles: true }));
await waitFor("painel aberto pela escolha múltipla", () => window.document.querySelector(".cl-painel"));
check("escolher 2 vídeos no Estúdio abre o lote com os 2", window.CineLote._interno.estado.itens.length === 2);
check("…e não carrega nenhum no Estúdio", !/Trocar/.test(window.document.querySelector("main")?.textContent || ""));

/* Lote com a IA e o FFmpeg falsos, mas a fila, os horários e as definições reais */
const lote = window.CineLote._interno;
lote.ambiente.lerVideo = async () => ({ largura: 1920, altura: 1080, duracao: 100 });
lote.ambiente.core = () => Object.assign({}, coreReal, {
  lerMetadados: async () => ({ duration: 100, fields: [] }),
  detetarBarras: async () => null,
  quadros: async () => ["q"],
  audio: async () => null,
  identificar: async (k, q, l, info) => ({ titulo: "Filme " + info.fileName, confianca: 95, cena: "cena", ganchos: ["Gancho " + info.fileName] }),
  procurarTmdb: async (k, ia) => ({ title: ia.titulo, original: ia.titulo, year: 2020, poster: "", kind: "movie", genres: [], overview: "" }),
  processar: async (f, i, fim, res, g, prog) => { prog(1); return new window.Blob([new Uint8Array(50)], { type: "video/mp4" }); },
  gerarLegenda: async (k, filme) => `**${filme.title}** é incrível`,
});
lote.ambiente.app = () => Object.assign({}, window.__CineClipApp, {
  settings: Object.assign({}, window.__CineClipApp.settings, { nvidiaKey: "nv", tmdbKey: "tm" }),
});
await lote.iniciar();

const filaReal = await coreReal.lerFila();
const doLote = filaReal.filter((r) => /^Filme [ab]\.mp4$/.test(r.title));
check("os 2 Reels ficam na fila real (IndexedDB)", doLote.length === 2, `fila=${filaReal.length}`);
check("na conta ativa, com estado scheduled", doLote.every((r) => r.accountId === "acc_default" && r.status === "scheduled"));
check("em horários diferentes às 12:00 (o horário da conta)", doLote.length === 2 && doLote[0].scheduledAt !== doLote[1].scheduledAt && doLote.every((r) => r.scheduledAt.endsWith("T12:00")), doLote.map((r) => r.scheduledAt).join(", "));
check("a legenda é limpa pelo app (sem **)", doLote.every((r) => !r.caption.includes("**")), doLote.map((r) => r.caption).join(" | "));
check("o vídeo processado fica guardado com o Reel", doLote.every((r) => r.videoBlob && r.videoSize === 50));

dom.window.close();

/* ======================================================================
   Parte C — o motor do lote: pipeline, tentativas automáticas e retomada
   ====================================================================== */

console.log("\nC1. O lote adianta a IA do vídeo seguinte enquanto o FFmpeg processa o atual");
{
  const dom = novoDom();
  const { window } = dom;
  const ordem = [];
  const fila = [];
  let soltar = null;
  const core = {
    lerMetadados: async () => ({ duration: 60, fields: [] }),
    detetarBarras: async () => null,
    quadros: async () => ["q"],
    audio: async () => null,
    identificar: async (k, q, l, info) => {
      ordem.push("identificar:" + info.fileName);
      return { titulo: "Filme " + info.fileName, confianca: 95, cena: "c", ganchos: ["Gancho 😳"] };
    },
    procurarTmdb: async (k, ia) => ({ title: ia.titulo, year: 2024, poster: "", original: "", kind: "movie", genres: [], overview: "" }),
    gerarGancho: async () => ({ ganchos: ["x"] }),
    gerarLegenda: async () => "legenda",
    limparLegenda: (t) => t,
    proximoHorario: () => "2026-10-14T12:00",
    guardarNaFila: async (r) => { fila.push(r); },
    lerFila: async () => fila.slice(),
    guardarHistorico: () => {},
    ganchoPadrao: "padrão",
    cancelarProcessamento: () => {},
    processar: async (f, i, fim, res, g, prog) => {
      prog(0.3);
      ordem.push("processar:comeco:" + f.name);
      if (f.name === "um.mp4") await new Promise((r) => { soltar = r; });
      ordem.push("processar:fim:" + f.name);
      prog(1);
      return new window.Blob([new Uint8Array(10)], { type: "video/mp4" });
    },
  };
  const lote = window.CineLote._interno;
  lote.ambiente.core = () => core;
  lote.ambiente.app = () => ({ settings: { nvidiaKey: "k", tmdbKey: "t", lang: "pt-BR", resolution: "720" }, account: { id: "acc", name: "@c", dailySlots: ["12:00"] } });
  lote.ambiente.lerVideo = async () => ({ largura: 1920, altura: 1080, duracao: 60 });
  lote.adicionarFicheiros([ficheiro(window, "um.mp4"), ficheiro(window, "dois.mp4")]);
  const corrida = lote.iniciar();
  await waitFor("FFmpeg do primeiro vídeo", () => ordem.includes("processar:comeco:um.mp4"));
  check("o FFmpeg do 1.º vídeo começou", ordem.includes("processar:comeco:um.mp4"));
  await waitFor("IA do segundo durante o FFmpeg do primeiro", () => ordem.includes("identificar:dois.mp4"));
  check(
    "a IA do 2.º vídeo correu ANTES de o FFmpeg do 1.º acabar",
    ordem.indexOf("identificar:dois.mp4") >= 0 && ordem.indexOf("processar:fim:um.mp4") === -1,
    ordem.join(" → ")
  );
  if (soltar) soltar();
  await corrida;
  check("os 2 Reels ficam agendados", fila.length === 2 && lote.estado.itens.every((it) => it.estado === "agendado"));
  dom.window.close();
}

console.log("\nC2. Com «adiantar» desligado, o lote volta a ser em fila indiana");
{
  const dom = novoDom();
  const { window } = dom;
  const ordem = [];
  const fila = [];
  const core = {
    lerMetadados: async () => ({ duration: 60, fields: [] }),
    detetarBarras: async () => null,
    quadros: async () => ["q"],
    audio: async () => null,
    identificar: async (k, q, l, info) => {
      ordem.push("identificar:" + info.fileName);
      return { titulo: "F " + info.fileName, confianca: 95, cena: "c", ganchos: ["G"] };
    },
    procurarTmdb: async (k, ia) => ({ title: ia.titulo, year: 2024, poster: "", original: "", kind: "movie", genres: [], overview: "" }),
    gerarGancho: async () => ({ ganchos: ["x"] }),
    gerarLegenda: async () => "legenda",
    limparLegenda: (t) => t,
    proximoHorario: () => "2026-10-14T12:00",
    guardarNaFila: async (r) => { fila.push(r); },
    lerFila: async () => fila.slice(),
    guardarHistorico: () => {},
    ganchoPadrao: "p",
    cancelarProcessamento: () => {},
    processar: async (f) => {
      ordem.push("processar:" + f.name);
      return new window.Blob([new Uint8Array(10)], { type: "video/mp4" });
    },
  };
  const lote = window.CineLote._interno;
  lote.estado.opcoes.adiantar = false;
  lote.ambiente.core = () => core;
  lote.ambiente.app = () => ({ settings: { nvidiaKey: "k", tmdbKey: "t" }, account: { id: "acc", name: "@c", dailySlots: ["12:00"] } });
  lote.ambiente.lerVideo = async () => ({ largura: 1920, altura: 1080, duracao: 60 });
  lote.adicionarFicheiros([ficheiro(window, "um.mp4"), ficheiro(window, "dois.mp4")]);
  await lote.iniciar();
  check(
    "cada vídeo é identificado, processado e só depois se passa ao seguinte",
    ordem.join(" ") === "identificar:um.mp4 processar:um.mp4 identificar:dois.mp4 processar:dois.mp4",
    ordem.join(" → ")
  );
  dom.window.close();
}

/** Cenário mínimo com um core controlado pelo teste. */
function cenarioFino(window, hooks = {}) {
  const fila = [];
  const chamadas = { identificar: 0, processar: 0, legenda: 0, identificados: [], capas: 0 };
  const core = {
    lerMetadados: async () => ({ duration: 60, fields: [] }),
    detetarBarras: async () => null,
    quadros: async () => ["q"],
    audio: async () => null,
    identificar: async (k, q, l, info) => {
      chamadas.identificar++;
      chamadas.identificados.push(info.fileName);
      if (hooks.identificar) return hooks.identificar(chamadas.identificar, info);
      return { titulo: "Filme " + info.fileName, confianca: 95, cena: "c", ganchos: ["Gancho 😳"] };
    },
    procurarTmdb: async (k, ia) => {
      if (hooks.tmdb) return hooks.tmdb(ia);
      return { title: ia.titulo, year: 2024, poster: "", original: "", kind: "movie", genres: [], overview: "" };
    },
    gerarGancho: async () => ({ ganchos: ["x"] }),
    gerarLegenda: async () => {
      chamadas.legenda++;
      return "legenda";
    },
    limparLegenda: (t) => t,
    proximoHorario: () => "2026-10-14T12:00",
    guardarNaFila: async (r) => { fila.push(r); },
    lerFila: async () => fila.slice(),
    guardarHistorico: () => {},
    ganchoPadrao: "p",
    cancelarProcessamento: () => {},
    processar: async (f, i, fim, res, g, prog) => {
      chamadas.processar++;
      if (hooks.processar) return hooks.processar(chamadas.processar, f, prog);
      if (prog) prog(1);
      return new window.Blob([new Uint8Array(10)], { type: "video/mp4" });
    },
  };
  const lote = window.CineLote._interno;
  lote.ambiente.core = () => core;
  lote.ambiente.app = () => ({ settings: { nvidiaKey: "k", tmdbKey: "t", lang: "pt-BR", resolution: "720" }, account: { id: "acc", name: "@c", dailySlots: ["12:00"] } });
  lote.ambiente.lerVideo = async () => ({ largura: 1920, altura: 1080, duracao: 60 });
  return { lote, core, fila, chamadas };
}

console.log("\nC3. Erro passageiro (IA a 503) → repete sozinho e agenda");
{
  const dom = novoDom();
  const c = cenarioFino(dom.window, {
    identificar: (n, info) => {
      if (n === 1) throw new Error("A NVIDIA devolveu 503 (serviço indisponível).");
      return { titulo: "Filme " + info.fileName, confianca: 95, cena: "c", ganchos: ["Gancho 😳"] };
    },
  });
  c.lote.adicionarFicheiros([ficheiro(dom.window, "um.mp4")]);
  dom.window.CineLote.abrir();
  const corrida = c.lote.iniciar();
  await waitFor("a espera entre tentativas aparecer no painel", () => /nova tentativa em/.test(c.lote.estado.itens[0].passo || ""), 4000);
  check("o painel explica que vai repetir e quanto falta", /nova tentativa em \d+ s \(2 de 3\)/.test(c.lote.estado.itens[0].passo), c.lote.estado.itens[0].passo);
  check("não foi para erro", c.lote.estado.itens[0].estado === "a_processar");
  await corrida;
  check("tentou 2 vezes e agendou", c.chamadas.identificar === 2 && c.fila.length === 1 && c.lote.estado.itens[0].estado === "agendado", `identificar=${c.chamadas.identificar}`);
  check("o painel diz que foi à 2.ª tentativa", /à 2\.ª/.test(dom.window.document.querySelector(".cl-item").textContent), dom.window.document.querySelector(".cl-item").textContent);
  dom.window.close();
}

console.log("\nC4. Erro definitivo (não está no TMDB) → não gasta tentativas");
{
  const dom = novoDom();
  const c = cenarioFino(dom.window, { tmdb: () => null });
  c.lote.adicionarFicheiros([ficheiro(dom.window, "um.mp4")]);
  await c.lote.iniciar();
  check("só tentou uma vez", c.chamadas.identificar === 1 && c.chamadas.processar === 0);
  check("fica com erro e explica porquê", c.lote.estado.itens[0].estado === "erro" && /no TMDB/.test(c.lote.estado.itens[0].erro), c.lote.estado.itens[0].erro);
  dom.window.close();
}

console.log("\nC5. Parar a meio e voltar a começar não repete a IA nem o gancho");
{
  const dom = novoDom();
  const { window } = dom;
  const c = cenario(dom.window);
  c.lote.adicionarFicheiros([ficheiro(window, "parar.mp4")]);
  const primeira = c.lote.iniciar();
  await waitFor("FFmpeg a correr", () => c.chamadas.processar.length === 1);
  c.lote.parar();
  await primeira;
  const item = c.lote.estado.itens[0];
  check("o vídeo volta para a fila com erro limpo", item.estado === "pendente" && item.erro === "");
  check("o trabalho já feito ficou guardado (sem repetir a IA)", c.chamadas.identificar === 1 && !!item.feito && !!item.feito.ia && !!item.feito.legenda);

  const segunda = c.lote.iniciar();
  await waitFor("FFmpeg outra vez", () => c.chamadas.processar.length === 2);
  c.liberar();
  await segunda;
  check("a IA não voltou a ser chamada", c.chamadas.identificar === 1, `identificar=${c.chamadas.identificar}`);
  check("o FFmpeg correu outra vez só para o vídeo que faltava", c.chamadas.processar.length === 2);
  check("o Reel acabou agendado", c.fila.length === 1 && item.estado === "agendado");
  dom.window.close();
}

console.log("\nC6. O painel não é redesenhado a cada aviso do FFmpeg (mas a barra acompanha)");
{
  const dom = novoDom();
  const { window } = dom;
  const c = cenario(dom.window);
  window.CineLote.abrir();
  c.lote.adicionarFicheiros([ficheiro(window, "parar.mp4")]);
  const corrida = c.lote.iniciar();
  await waitFor("FFmpeg a correr", () => c.chamadas.processar.length === 1);
  const lista = window.document.querySelector(".cl-lista");
  const antesDesenhar = window.document.querySelectorAll(".cl-painel *").length;
  for (let i = 1; i <= 40; i++) c.lote.atualizarProgresso();
  await sleep(300);
  check("a lista do painel é a mesma (não foi reconstruída)", window.document.querySelector(".cl-lista") === lista);
  check("o painel não cresceu nem se repetiu", window.document.querySelectorAll(".cl-painel *").length === antesDesenhar);
  const barra = window.document.querySelector(".cl-item .cl-barra > div");
  check("a barra de progresso acompanha", !!barra && parseInt(barra.style.width, 10) >= 70, barra && barra.style.width);
  const lote = window.document.querySelector(".cl-lote");
  check("há um resumo do lote com a percentagem", !!lote && /Lote: \d+ de \d+/.test(lote.textContent) && /%/.test(lote.textContent), lote && lote.textContent);
  c.liberar();
  await corrida;
  check("no fim o resumo mostra o tempo que demorou", /demorou|agendado/.test(window.document.querySelector(".cl-lote").textContent), window.document.querySelector(".cl-lote").textContent);
  dom.window.close();
}

console.log("\nC7. Depois de agendado, o vídeo original sai da memória");
{
  const dom = novoDom();
  const c = cenarioFino(dom.window);
  c.lote.adicionarFicheiros([ficheiro(dom.window, "um.mp4")]);
  await c.lote.iniciar();
  const it = c.lote.estado.itens[0];
  check("o item agendado já não guarda o ficheiro nem os dados da IA", it.estado === "agendado" && !it.ficheiro && !it.feito);
  check("o Reel na fila continua com o vídeo processado", c.fila[0] && c.fila[0].videoBlob && c.fila[0].videoBlob.size === 10);
  dom.window.close();
}

console.log("\nC8. «Tentar de novo os que falharam» e «Limpar erros»");
{
  const dom = novoDom();
  const { window } = dom;
  const c = cenarioFino(dom.window, { tmdb: () => null });
  c.lote.adicionarFicheiros([ficheiro(window, "um.mp4"), ficheiro(window, "dois.mp4")]);
  dom.window.CineLote.abrir();
  await c.lote.iniciar();
  const antesErro = window.document.querySelectorAll(".cl-item[data-estado=erro]").length;
  check("os 2 ficam com erro", antesErro === 2, `${antesErro}`);
  const botao = [...window.document.querySelectorAll("button")].find((b) => /Tentar de novo os que falharam \(2\)/.test(b.textContent));
  check("aparece o botão para repetir todos", !!botao);
  const botoesLimpar = [...window.document.querySelectorAll("button")].find((b) => b.textContent === "Limpar erros");
  check("aparece o botão para limpar os erros", !!botoesLimpar);
  botoesLimpar.click();
  check("limpar erros esvazia a lista", c.lote.estado.itens.length === 0 && !window.document.querySelector(".cl-item"));
  dom.window.close();
}

console.log("\nC9. Escrever um link na caixa não perde o cursor quando o painel se redesenha");
{
  const dom = novoDom();
  const { window } = dom;
  const c = cenario(dom.window);
  window.CineLote.abrir();
  const area = window.document.querySelector("textarea.cl-texto");
  area.value = "https://vm.tiktok.com/ZMabc/";
  area.dispatchEvent(new window.Event("input"));
  area.focus();
  area.setSelectionRange(5, 5);
  c.lote.adicionarFicheiros([ficheiro(window, "longo.mp4")]); // redesenha o painel
  const nova = window.document.querySelector("textarea.cl-texto");
  check("a caixa dos links mantém o texto", nova.value === "https://vm.tiktok.com/ZMabc/", nova.value);
  check("e o cursor volta onde estava", window.document.activeElement === nova, window.document.activeElement && window.document.activeElement.tagName);
  dom.window.close();
}

/* ======================================================================
   Parte D — a fila guardada: o lote sobrevive a um recarregamento
   ====================================================================== */

function novoDomBanco() {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url: "http://localhost/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  dom.window.URL.createObjectURL = () => "blob:stub";
  dom.window.URL.revokeObjectURL = () => {};
  dom.window.indexedDB = fakeIndexedDB;
  dom.window.IDBKeyRange = IDBKeyRange;
  dom.window.eval(LOTE);
  return dom;
}

console.log("\nD1. Guardar a fila e retomá-la noutra página (sem repetir a IA)");
{
  const dom1 = novoDomBanco();
  const c1 = cenarioFino(dom1.window);
  await c1.lote.limparFilaGuardada();
  c1.lote.adicionarFicheiros([ficheiro(dom1.window, "um.mp4"), ficheiro(dom1.window, "dois.mp4")]);
  // Prepara (identifica, gancho, legenda) mas não agenda: é o que fica guardado.
  await c1.lote.prepararItem(c1.lote.estado.itens[0]);
  await c1.lote.guardarDadosDaFila();
  check("o vídeo já preparado fica guardado com o que estava feito", !!c1.lote.estado.itens[0].feito && !!c1.lote.estado.itens[0].feito.ia);
  dom1.window.close();

  const dom2 = novoDomBanco();
  const c2 = cenarioFino(dom2.window);
  dom2.window.CineLote.abrir();
  const voltaram = await c2.lote.restaurarFila();
  check("a página nova retoma os 2 vídeos", voltaram === 2, `voltaram=${voltaram}`);
  check("o filme identificado vem no lote", c2.lote.estado.itens[0].resultado && c2.lote.estado.itens[0].resultado.titulo === "Filme um.mp4");
  check("e o gancho também", c2.lote.estado.itens[0].feito && c2.lote.estado.itens[0].feito.gancho === "Gancho 😳");
  check("o painel avisa que retomou o lote", /Retomei 2 vídeos/.test(dom2.window.document.querySelector(".cl-aviso").textContent), dom2.window.document.querySelector(".cl-aviso").textContent);
  const temFicheiro = !!c2.lote.estado.itens[0].ficheiro;
  if (temFicheiro) {
    await c2.lote.iniciar();
    check(
      "continuar identificou só o vídeo que faltava (não repetiu a IA do que já estava preparado)",
      c2.chamadas.identificados.join(",") === "dois.mp4",
      c2.chamadas.identificados.join(",")
    );
    check("a legenda do primeiro também não foi pedida outra vez", c2.chamadas.legenda === 1, `legendas=${c2.chamadas.legenda}`);
    check("os 2 Reels ficam agendados", c2.fila.length === 2, `fila=${c2.fila.length}`);
  } else {
    check("sem o vídeo guardado, o item pede para escolher outra vez", c2.lote.estado.itens[0].semFicheiro === true);
    c2.lote.estado.itens[0].ficheiro = ficheiro(dom2.window, "um.mp4");
    c2.lote.estado.itens[0].semFicheiro = false;
    c2.lote.estado.itens[0].estado = "pendente";
    await c2.lote.iniciar();
    check("depois de escolher, processa sem repetir a IA", c2.chamadas.identificados.join(",") === "dois.mp4" && c2.fila.length === 2, c2.chamadas.identificados.join(","));
  }
  await c2.lote.guardarDadosDaFila();
  const restos = await c2.lote.restaurarFila();
  check("os vídeos agendados saem do guardado", restos === 0, `restos=${restos}`);
  await c2.lote.limparFilaGuardada();
  dom2.window.close();
}

console.log("\nD2. Desligar «guardar a fila» limpa o que estava guardado");
{
  const dom = novoDomBanco();
  const c = cenarioFino(dom.window);
  await c.lote.limparFilaGuardada();
  c.lote.adicionarFicheiros([ficheiro(dom.window, "um.mp4")]);
  await c.lote.guardarDadosDaFila();
  const antes = await c.lote.restaurarFila();
  check("com a fila em memória não restaura nada", antes === 0);
  await c.lote.limparFilaGuardada();
  const dom2 = novoDomBanco();
  const c2 = cenarioFino(dom2.window);
  const depois = await c2.lote.restaurarFila();
  check("depois de limpar, a página nova não tem nada para retomar", depois === 0);
  dom.window.close();
  dom2.window.close();
}

console.log("\n─────────────────────────────────────────────");
if (fail) {
  console.log(`❌ ${pass} passaram, ${fail} falharam:`);
  for (const f of failures) console.log(`   • ${f}`);
  process.exit(1);
}
console.log(`✅ ${pass} passaram, 0 falharam`);
