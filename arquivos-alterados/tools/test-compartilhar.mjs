#!/usr/bin/env node
/**
 * Testes do "Compartilhar do celular" (Android → CineClip).
 *
 *   node tools/test-compartilhar.mjs
 *
 * 1. O app é instalável: manifest com share_target, ícones, service worker, tags.
 * 2. A partilha chega (/compartilhar?text=…): lê os links e limpa o endereço.
 * 3. "Processar agora aqui": importa, processa e agenda sozinho; marca o link feito.
 * 4. "Mandar para o PC": guarda o link e sincroniza; o PC processa-o.
 * 5. A caixa de links junta-se com a da nuvem (feito ganha a pendente, limpa antigos).
 * 6. Quem processa o quê (celular vs PC, "aqui" de outro aparelho).
 * 7. O bundle real chama a caixa durante a sincronização (patch 31).
 *
 * Precisa de jsdom e fake-indexeddb (npm install --no-save jsdom fake-indexeddb).
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
// Carrega a dependência real da lista, tal como o HTML de produção.
const LOTE = fs.readFileSync(path.join(root, "motor-ia.js"), "utf8") + "\n" + fs.readFileSync(path.join(root, "lote-massa.js"), "utf8");

let JSDOM, ResourceLoader, fakeIndexedDB, IDBKeyRange;
try {
  ({ JSDOM, ResourceLoader } = await import("jsdom"));
  ({ indexedDB: fakeIndexedDB, IDBKeyRange } = await import("fake-indexeddb"));
} catch {
  console.log("\n⚠️  jsdom/fake-indexeddb não estão instalados — teste do compartilhar saltado.\n");
  process.exit(0);
}

let pass = 0;
let fail = 0;
const falhas = [];
function check(nome, ok, detalhe = "") {
  if (ok) {
    pass++;
    console.log(`   ✔ ${nome}`);
  } else {
    fail++;
    falhas.push(nome);
    console.log(`   ❌ ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function esperar(desc, fn, ms = 6000) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("tempo esgotado: " + desc);
    await sleep(20);
  }
}
function pngTamanho(ficheiro) {
  const b = fs.readFileSync(path.join(root, ficheiro));
  return b.toString("ascii", 1, 4) === "PNG" ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null;
}

console.log("\n📱 Compartilhar do celular\n");

/* ------------------------------------------------------------------ 1 */
console.log("1. O app é instalável no Android");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.webmanifest"), "utf8"));
check("manifest com nome, start_url e display standalone", manifest.name === "CineClip" && manifest.start_url && manifest.display === "standalone");
const icones = manifest.icons || [];
const tem = (tam, prop) => icones.some((i) => i.sizes === tam && (!prop || i.purpose === prop) && JSON.stringify(pngTamanho(i.src)) === JSON.stringify(tam.split("x").map(Number)));
check("ícones 192 e 512 existem e têm o tamanho certo", tem("192x192") && tem("512x512"));
check("ícone maskable para o Android", tem("512x512", "maskable"));
const st = manifest.share_target || {};
check("share_target: GET em ./compartilhar com text e url", st.method === "GET" && st.action === "./compartilhar" && st.params && st.params.text === "text" && st.params.url === "url" && st.params.title === "title");
check("abrir pela partilha reaproveita a janela aberta (launch_handler)", JSON.stringify(manifest.launch_handler || {}).includes("focus-existing"));
const sw = fs.readFileSync(path.join(root, "sw.js"), "utf8");
check("service worker existe e não guarda cache", /addEventListener\("fetch"/.test(sw) && !/caches\.open/.test(sw));
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
check("index.html liga o manifest e a cor do tema", html.includes('<link rel="manifest" href="manifest.webmanifest" />') && html.includes('name="theme-color"'));
const build = fs.readFileSync(path.join(root, "tools", "build-static.mjs"), "utf8");
check("o build publica manifest, sw.js e ícones", ["manifest.webmanifest", "sw.js", "icone-192.png", "icone-512.png", "icone-maskable-512.png"].every((f) => build.includes(`"${f}"`)));
const redirects = fs.readFileSync(path.join(root, "_redirects"), "utf8");
const vercel = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8"));
check("/compartilhar abre o app (Vercel e Netlify)", vercel.rewrites.some((r) => r.destination === "/index.html") && /\/\*\s+\/index\.html\s+200/.test(redirects));

/* ---------------------------------------------------------- ambiente A */

function novoDom({ url = "http://localhost/", celular = false, localStorage = {} } = {}) {
  const userAgent = celular
    ? "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36"
    : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url, runScripts: "outside-only", pretendToBeVisual: true, resources: new ResourceLoader({ userAgent }),
  });
  const { window } = dom;
  for (const [k, v] of Object.entries(localStorage)) window.localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v));
  window.URL.createObjectURL = () => "blob:x";
  window.URL.revokeObjectURL = () => {};
  return dom;
}

/** Liga o lote a um app/IA/FFmpeg falsos; devolve registos para as verificações. */
function ligar(window, { semApp = false } = {}) {
  const lote = window.CineLote._interno;
  const fila = [];
  const reg = { baixados: [], sincronizacoes: 0, processados: [] };
  const app = {
    settings: { groqKey: "nv", tmdbKey: "tm", lang: "pt-BR", resolution: "720" },
    account: { id: "acc", name: "@conta", dailySlots: ["12:00"] },
    atualizarFila() {},
    sincronizar: async () => { reg.sincronizacoes++; },
    abrirConfiguracoes() {}, abrirAgendador() {}, abrirNoEstudio() {},
  };
  const core = {
    lerMetadados: async () => ({ duration: 60, fields: [] }),
    detetarBarras: async () => null,
    quadros: async () => ["q"],
    audio: async () => null,
    identificar: async (k, q, l, info) => ({ titulo: "Filme " + info.fileName, confianca: 95, cena: "c", ganchos: ["Gancho"] }),
    procurarTmdb: async (k, ia) => ({ title: ia.titulo, original: ia.titulo, year: 2020 }),
    gerarGancho: async () => ({ ganchos: [] }),
    processar: async (f, i, fim, r, g, p) => { reg.processados.push(f.name); p(1); return new window.Blob([new Uint8Array(5)]); },
    gerarLegenda: async () => "legenda",
    limparLegenda: (s) => s,
    proximoHorario: () => "2026-10-14T12:00",
    guardarNaFila: async (r) => { fila.push(r); },
    lerFila: async () => fila.slice(),
    guardarHistorico() {},
  };
  lote.ambiente.app = () => (semApp ? null : app);
  lote.ambiente.core = () => (semApp ? null : core);
  lote.ambiente.lerVideo = async () => ({ largura: 1080, altura: 1920, duracao: 60 });
  lote.ambiente.baixarLink = async (link) => {
    reg.baixados.push(link);
    if (link.includes("apagado")) throw new Error("Esse vídeo não existe ou foi apagado.");
    return new window.File([new Uint8Array(8)], "tiktok_" + reg.baixados.length + ".mp4", { type: "video/mp4" });
  };
  return { lote, fila, reg, app };
}

const PARTILHA = "http://localhost/compartilhar?title=TikTok&text=" + encodeURIComponent("Olha este corte 🔥 https://vm.tiktok.com/ZMpartilha1/ #filme");

/* ------------------------------------------------------------------ 2 */
console.log("\n2. A partilha chega ao app");
{
  const dom = novoDom({ url: PARTILHA, celular: true });
  const { window } = dom;
  window.eval(LOTE);
  const { lote } = ligar(window);
  check("tira o link do texto partilhado pelo TikTok", JSON.stringify(lote.linksDaPartilha(PARTILHA)) === JSON.stringify(["https://vm.tiktok.com/ZMpartilha1/"]));
  check("Kwai no parâmetro url", JSON.stringify(lote.linksDaPartilha("http://localhost/compartilhar?url=" + encodeURIComponent("https://k.kwai.com/p/abc"))) === JSON.stringify(["https://k.kwai.com/p/abc"]));
  check("endereço normal não é partilha", lote.linksDaPartilha("http://localhost/") === null);
  const folha = await esperar("folha de escolha", () => window.document.querySelector(".cl-folha"));
  check("mostra a escolha ao receber", /1 vídeo recebido/.test(folha.textContent) && /Processar agora aqui/.test(folha.textContent) && /Mandar para o PC/.test(folha.textContent));
  check("mostra o link recebido", folha.textContent.includes("https://vm.tiktok.com/ZMpartilha1/"));
  check("limpa o endereço (recarregar não repete a partilha)", window.location.pathname === "/" && !window.location.search, window.location.href);
  dom.window.close();
}
{
  const dom = novoDom({ url: "http://localhost/compartilhar?text=" + encodeURIComponent("só texto sem link"), celular: true });
  dom.window.eval(LOTE);
  ligar(dom.window);
  const folha = await esperar("aviso", () => dom.window.document.querySelector(".cl-folha"));
  check("partilha sem link do TikTok/Kwai → aviso claro", /Não encontrei nenhum link/.test(folha.textContent));
  dom.window.close();
}

/* ------------------------------------------------------------------ 3 */
console.log("\n3. «Processar agora aqui»");
{
  const dom = novoDom({ url: PARTILHA, celular: true });
  const { window } = dom;
  window.eval(LOTE);
  const { lote, fila, reg } = ligar(window);
  const botao = await esperar("botão aqui", () => [...window.document.querySelectorAll(".cl-folha button")].find((b) => /Processar agora aqui/.test(b.textContent)));
  botao.click();
  await esperar("Reel agendado", () => fila.length === 1, 8000);
  check("importa o link partilhado", reg.baixados[0] === "https://vm.tiktok.com/ZMpartilha1/");
  check("processa e agenda sozinho", fila[0] && fila[0].title === "Filme tiktok_1.mp4");
  check("o painel do lote abre para acompanhar", !!window.document.querySelector(".cl-painel:not(.cl-corpo)") || !!window.document.querySelector(".cl-overlay:not(.cl-folha) .cl-painel"));
  await esperar("caixa feita", () => lote.lerCaixa()[0] && lote.lerCaixa()[0].estado === "feito");
  const e = lote.lerCaixa()[0];
  check("o link fica marcado como feito, com o Reel", e.estado === "feito" && e.destino === "aqui" && e.reelId === fila[0].id);
  check("pede a sincronização (o Reel vai para a nuvem)", reg.sincronizacoes >= 1);
  dom.window.close();
}

/* ------------------------------------------------------------------ 4 */
console.log("\n4. «Mandar para o PC» e «Lembrar a minha escolha»");
{
  const dom = novoDom({ url: PARTILHA, celular: true });
  const { window } = dom;
  window.eval(LOTE);
  const { lote, fila, reg } = ligar(window);
  await esperar("folha", () => window.document.querySelector(".cl-folha"));
  window.document.querySelector(".cl-folha input[type=checkbox]").click();
  [...window.document.querySelectorAll(".cl-folha button")].find((b) => /Mandar para o PC/.test(b.textContent)).click();
  await esperar("enviado", () => /Enviado/.test(window.document.querySelector(".cl-folha")?.textContent || ""));
  const e = lote.lerCaixa()[0];
  check("guarda o link para o PC", e && e.destino === "pc" && e.estado === "pendente");
  check("sincroniza logo (o link vai para a nuvem)", reg.sincronizacoes === 1);
  check("o celular não processa o que mandou para o PC", reg.baixados.length === 0 && fila.length === 0);
  check("diz que já pode fechar", /Já podes fechar/.test(window.document.querySelector(".cl-folha").textContent));
  check("lembra a escolha", lote.estado.opcoes.aoPartilhar === "pc" && JSON.parse(window.localStorage.getItem("cineclip.lote.opcoes")).aoPartilhar === "pc");

  lote.receberPartilha("http://localhost/compartilhar?text=" + encodeURIComponent("https://vm.tiktok.com/ZMsegundo/"));
  await esperar("segunda enviada", () => reg.sincronizacoes === 2);
  check("com a escolha lembrada, a próxima partilha vai direto sem perguntar", !window.document.querySelector(".cl-folha button.cl-prim") && lote.lerCaixa().length === 2);

  lote.receberPartilha("http://localhost/compartilhar?text=" + encodeURIComponent("de novo https://vm.tiktok.com/ZMsegundo/"));
  await sleep(50);
  check("o mesmo link partilhado outra vez não duplica", lote.lerCaixa().length === 2);
  dom.window.close();
}

/* ------------------------------------------------------------------ 5 */
console.log("\n5. A caixa junta-se com a da nuvem");
{
  const agora = Date.now();
  const dom = novoDom({ celular: true, localStorage: {
    "cineclip.links.caixa": [
      { id: "a", url: "https://vm.tiktok.com/a/", destino: "pc", aparelho: "ap_cel", estado: "pendente", criadoEm: agora - 1000, atualizadoEm: agora - 1000 },
      { id: "velho", url: "https://vm.tiktok.com/v/", destino: "pc", aparelho: "ap_cel", estado: "feito", criadoEm: agora - 30 * 86400000, atualizadoEm: agora - 30 * 86400000 },
    ],
  } });
  dom.window.eval(LOTE);
  const { lote } = ligar(dom.window, { semApp: true });
  const lista = window_mesclar(dom.window, [
    { id: "a", url: "https://vm.tiktok.com/a/", destino: "pc", aparelho: "ap_cel", estado: "feito", reelId: "reel_1", criadoEm: agora - 1000, atualizadoEm: agora - 5000 },
    { id: "b", url: "https://vm.tiktok.com/b/", destino: "pc", aparelho: "ap_outro", estado: "pendente", criadoEm: agora, atualizadoEm: agora },
  ]);
  const porId = Object.fromEntries(lista.map((e) => [e.id, e]));
  check("feito na nuvem ganha ao pendente local", porId.a && porId.a.estado === "feito" && porId.a.reelId === "reel_1");
  check("link novo da nuvem entra na caixa", porId.b && porId.b.estado === "pendente");
  check("feitos com mais de 14 dias saem", !porId.velho);
  check("a caixa local fica igual à que vai para a nuvem", JSON.stringify(lote.lerCaixa()) === JSON.stringify(lista));
  dom.window.close();
}
function window_mesclar(window, remotas) {
  return window.CineLote.mesclarLinks(remotas);
}

/* ------------------------------------------------------------------ 6 */
console.log("\n6. Quem processa o quê");
{
  const agora = Date.now();
  const caixa = [
    { id: "pc1", url: "https://vm.tiktok.com/pc1/", destino: "pc", aparelho: "ap_cel", estado: "pendente", criadoEm: agora, atualizadoEm: agora },
    { id: "aquiOutro", url: "https://vm.tiktok.com/outro/", destino: "aqui", aparelho: "ap_cel", estado: "pendente", criadoEm: agora, atualizadoEm: agora },
    { id: "pc2", url: "https://vm.tiktok.com/apagado/", destino: "pc", aparelho: "ap_cel", estado: "pendente", criadoEm: agora, atualizadoEm: agora },
  ];
  const pc = novoDom({ celular: false, localStorage: { "cineclip.links.caixa": caixa } });
  pc.window.eval(LOTE);
  const p = ligar(pc.window);
  check("no PC, processar os links do celular vem ligado", p.lote.estado.opcoes.processarLinksDoCelular === true);
  await esperar("PC processou", () => p.fila.length === 1, 8000);
  await esperar("caixa atualizada", () => p.lote.lerCaixa().find((e) => e.id === "pc1").estado === "feito" && p.lote.lerCaixa().find((e) => e.id === "pc2").estado === "erro");
  check("o PC processa sozinho os links mandados para ele", p.reg.baixados.includes("https://vm.tiktok.com/pc1/") && p.fila[0].accountId === "acc");
  check("não toca no «aqui» de outro aparelho", !p.reg.baixados.includes("https://vm.tiktok.com/outro/"));
  const erro = p.lote.lerCaixa().find((e) => e.id === "pc2");
  check("link que falha fica com erro (não repete para sempre)", erro.estado === "erro" && /apagado/.test(erro.erro));
  pc.window.close();

  const cel = novoDom({ celular: true, localStorage: { "cineclip.links.caixa": caixa } });
  cel.window.eval(LOTE);
  const c = ligar(cel.window);
  await sleep(400);
  check("no celular, os links para o PC não são processados", c.lote.estado.opcoes.processarLinksDoCelular === false && c.reg.baixados.length === 0);
  cel.window.close();

  // O celular recarregou a meio: o link "aqui" dele continua sozinho.
  const meu = novoDom({ celular: true, localStorage: { "cineclip.links.aparelho": "ap_eu", "cineclip.links.caixa": [
    { id: "meu", url: "https://vm.tiktok.com/meu/", destino: "aqui", aparelho: "ap_eu", estado: "pendente", criadoEm: agora, atualizadoEm: agora },
  ] } });
  meu.window.eval(LOTE);
  const m = ligar(meu.window);
  await esperar("retomou", () => m.fila.length === 1, 8000);
  check("depois de recarregar, o celular retoma o link que estava a fazer", m.reg.baixados[0] === "https://vm.tiktok.com/meu/");
  meu.window.close();
}

/* ------------------------------------------------------------------ 7 */
console.log("\n7. O app real guarda a caixa no cofre ao sincronizar");
{
  const moduleSource = /<script type="module">([\s\S]*?)<\/script>/.exec(html)[1].replace(/import\.meta\.url/g, '"file:///index.html"');
  const cineCloudSource = fs.readFileSync(path.join(root, "nuvem-duravel.js"), "utf8");
  const dom = new JSDOM(html, { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  window.indexedDB = fakeIndexedDB;
  window.IDBKeyRange = IDBKeyRange;
  window.TextEncoder = globalThis.TextEncoder;
  window.TextDecoder = globalThis.TextDecoder;
  try { Object.defineProperty(window, "crypto", { value: globalThis.crypto, configurable: true }); } catch {}
  window.fetch = async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => "{}", json: async () => ({}), body: { cancel: async () => {} } });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.HTMLMediaElement.prototype.load = () => {};
  window.scrollTo = () => {};
  window.URL.createObjectURL = () => "blob:x";
  window.URL.revokeObjectURL = () => {};
  for (const n of ["log", "info", "debug", "warn"]) window.console[n] = () => {};
  window.localStorage.setItem("cineclip.links.caixa", JSON.stringify([{ id: "x1", url: "https://vm.tiktok.com/x1/", destino: "pc", aparelho: "ap_cel", estado: "pendente", criadoEm: 1, atualizadoEm: 1 }]));
  window.eval(cineCloudSource);
  window.eval(LOTE);
  const chamadas = [];
  const original = window.CineLote.mesclarLinks;
  window.CineLote.mesclarLinks = (remotas) => {
    const r = original(remotas);
    chamadas.push(r);
    return r;
  };
  window.eval(moduleSource);
  const entrar = await esperar("login", () => [...window.document.querySelectorAll("button")].find((b) => /Entrar e Sincronizar Tudo/.test(b.textContent)), 8000);
  const [u, p] = window.document.querySelectorAll("input");
  for (const [input, valor] of [[u, "teste@cineclip"], [p, "senha-de-teste"]]) {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, valor);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  }
  entrar.click();
  await esperar("sincronização", () => chamadas.length > 0, 10000).catch(() => null);
  check("a sincronização do app chama a caixa de links", chamadas.length > 0);
  check("…e leva os links pendentes para o cofre", chamadas.length > 0 && chamadas[chamadas.length - 1].some((e) => e.id === "x1"));
  dom.window.close();
}

console.log("\n─────────────────────────────────────────────");
if (fail) {
  console.log(`❌ ${pass} passaram, ${fail} falharam:`);
  for (const f of falhas) console.log(`   • ${f}`);
  process.exit(1);
}
console.log(`✅ ${pass} passaram, 0 falharam`);
process.exit(0);
