#!/usr/bin/env node
/**
 * Testes do botão flutuante "📋 Colar link" e do aviso de link copiado.
 *
 *   node tools/test-botao-colar.mjs
 *
 * A área de transferência e a permissão do Chrome são simuladas.
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const LOTE = fs.readFileSync(path.join(root, "lote-massa.js"), "utf8");

let JSDOM, ResourceLoader;
try {
  ({ JSDOM, ResourceLoader } = await import("jsdom"));
} catch {
  console.log("\n⚠️  jsdom não está instalado — teste do botão saltado.\n");
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
async function esperar(desc, fn, ms = 5000) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("tempo esgotado: " + desc);
    await sleep(20);
  }
}

/**
 * Celular simulado com área de transferência. `copiado` é o texto copiado;
 * `permissao` o estado de "clipboard-read"; `bloquear` faz readText falhar.
 */
function celular({ copiado = "", permissao = "prompt", bloquear = false, logado = true, opcoes = null } = {}) {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url: "https://cine-flowx.vercel.app/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    resources: new ResourceLoader({ userAgent: "Mozilla/5.0 (Linux; Android 12; SM-G970F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36" }),
  });
  const { window } = dom;
  const area = { texto: copiado, leituras: 0 };
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { readText: async () => { area.leituras++; if (bloquear) throw new Error("NotAllowedError"); return area.texto; } },
  });
  Object.defineProperty(window.navigator, "permissions", {
    configurable: true,
    value: { query: async () => ({ state: permissao }) },
  });
  if (opcoes) window.localStorage.setItem("cineclip.lote.opcoes", JSON.stringify(opcoes));
  window.URL.createObjectURL = () => "blob:x";
  window.URL.revokeObjectURL = () => {};
  window.eval(LOTE);
  const lote = window.CineLote._interno;
  const reg = { sincronizacoes: 0, baixados: [] };
  const fila = [];
  lote.ambiente.app = () => ({
    logado,
    settings: { nvidiaKey: "nv", tmdbKey: "tm" },
    account: { id: "acc", name: "@conta", dailySlots: ["12:00"] },
    atualizarFila() {},
    sincronizar: async () => { reg.sincronizacoes++; },
    abrirConfiguracoes() {}, abrirAgendador() {}, abrirNoEstudio() {},
  });
  lote.ambiente.core = () => ({
    lerMetadados: async () => ({ duration: 30, fields: [] }), detetarBarras: async () => null, quadros: async () => ["q"], audio: async () => null,
    identificar: async () => ({ titulo: "Filme", confianca: 90, ganchos: ["g"] }), procurarTmdb: async (k, ia) => ({ title: ia.titulo }),
    processar: async (f, i, fim, r, g, p) => { p(1); return new window.Blob([new Uint8Array(3)]); }, gerarLegenda: async () => "leg",
    limparLegenda: (s) => s, proximoHorario: () => "2026-10-14T12:00", guardarNaFila: async (r) => { fila.push(r); }, lerFila: async () => fila.slice(), guardarHistorico() {},
  });
  lote.ambiente.lerVideo = async () => ({ largura: 1080, altura: 1920, duracao: 30 });
  lote.ambiente.baixarLink = async (link) => { reg.baixados.push(link); return new window.File([new Uint8Array(4)], "v.mp4", { type: "video/mp4" }); };
  lote.atualizarBotaoColar();
  return { dom, window, lote, area, reg, fila };
}

const LINK = "https://vm.tiktok.com/ZMcopiado1/";

console.log("\n📋 Botão flutuante «Colar link»\n");

console.log("1. O botão aparece no sítio certo");
{
  const c = celular();
  const fab = c.window.document.querySelector(".cl-fab");
  check("aparece com sessão iniciada", !!fab && /Colar link/.test(fab.textContent));
  c.window.CineLote.abrir();
  check("esconde-se com o painel do lote aberto", !c.window.document.querySelector(".cl-fab"));
  c.window.CineLote.fechar();
  await esperar("volta", () => c.window.document.querySelector(".cl-fab"));
  check("volta quando o painel fecha", true);
  c.dom.window.close();

  const fora = celular({ logado: false });
  check("não aparece no ecrã de login", !fora.window.document.querySelector(".cl-fab"));
  fora.dom.window.close();

  const desligado = celular({ opcoes: { botaoColar: false } });
  check("pode ser escondido nas opções", !desligado.window.document.querySelector(".cl-fab"));
  desligado.dom.window.close();
}

console.log("\n2. Tocar no botão com um link copiado");
{
  const c = celular({ copiado: "Olha isto https://vm.tiktok.com/ZMcopiado1/ 😱" });
  c.window.document.querySelector(".cl-fab").click();
  const folha = await esperar("escolha", () => c.window.document.querySelector(".cl-folha"));
  check("lê o link copiado e pergunta aqui ou PC", /1 vídeo recebido/.test(folha.textContent) && folha.textContent.includes(LINK));
  [...folha.querySelectorAll("button")].find((b) => /Processar agora aqui/.test(b.textContent)).click();
  await esperar("agendado", () => c.fila.length === 1, 6000);
  check("«Processar agora aqui» importa e agenda", c.reg.baixados[0] === LINK && c.fila.length === 1);
  c.dom.window.close();
}
{
  const c = celular({ copiado: LINK, opcoes: { aoPartilhar: "pc" } });
  c.window.document.querySelector(".cl-fab").click();
  await esperar("enviado", () => /Enviado/.test(c.window.document.querySelector(".cl-folha")?.textContent || ""));
  check("com «Mandar para o PC» lembrado, vai direto sem perguntar", c.reg.sincronizacoes === 1 && c.lote.lerCaixa()[0].destino === "pc");
  c.dom.window.close();
}

console.log("\n3. Quando não dá para ler o link");
{
  const c = celular({ copiado: "texto qualquer sem link" });
  c.window.document.querySelector(".cl-fab").click();
  const folha = await esperar("colar à mão", () => c.window.document.querySelector(".cl-folha textarea") && c.window.document.querySelector(".cl-folha"));
  check("sem link copiado → explica e deixa colar à mão", /Copiar link/.test(folha.textContent));
  const area = folha.querySelector("textarea");
  area.value = "isto não é link";
  [...folha.querySelectorAll("button")].find((b) => b.textContent === "Continuar").click();
  check("recusa texto que não é link", /não parece um link/.test(folha.textContent));
  area.value = "https://www.kwai.com/@x/video/123";
  [...folha.querySelectorAll("button")].find((b) => b.textContent === "Continuar").click();
  await esperar("escolha", () => /1 vídeo recebido/.test(c.window.document.querySelector(".cl-folha")?.textContent || ""));
  check("o link colado à mão segue para a escolha", true);
  c.dom.window.close();
}
{
  const c = celular({ copiado: LINK, bloquear: true });
  c.window.document.querySelector(".cl-fab").click();
  const folha = await esperar("colar à mão", () => c.window.document.querySelector(".cl-folha textarea") && c.window.document.querySelector(".cl-folha"));
  check("Chrome sem permissão → caixa para colar à mão", /não deixou ler/.test(folha.textContent));
  c.dom.window.close();
}

console.log("\n4. Ao voltar ao app com um link copiado");
{
  const c = celular({ copiado: LINK, permissao: "granted" });
  await c.lote.verificarLinkCopiado();
  const aviso = c.window.document.querySelector(".cl-copiado");
  check("com permissão já dada, oferece processar", !!aviso && /Link copiado/.test(aviso.textContent) && /Processar/.test(aviso.textContent));
  [...aviso.querySelectorAll("button")].find((b) => b.textContent === "Ignorar").click();
  check("«Ignorar» fecha o aviso", !c.window.document.querySelector(".cl-copiado"));
  await c.lote.verificarLinkCopiado();
  check("o mesmo link não volta a ser oferecido", !c.window.document.querySelector(".cl-copiado"));
  c.area.texto = "https://vm.tiktok.com/ZMnovo2/";
  await c.lote.verificarLinkCopiado();
  const aviso2 = c.window.document.querySelector(".cl-copiado");
  check("um link novo é oferecido", !!aviso2);
  [...aviso2.querySelectorAll("button")].find((b) => b.textContent === "Processar").click();
  await esperar("escolha", () => c.window.document.querySelector(".cl-folha"));
  check("«Processar» abre a escolha aqui/PC", /Processar agora aqui/.test(c.window.document.querySelector(".cl-folha").textContent));
  c.dom.window.close();
}
{
  const c = celular({ copiado: LINK, permissao: "prompt" });
  await c.lote.verificarLinkCopiado();
  check("sem permissão, não lê nem pede nada sozinho", c.area.leituras === 0 && !c.window.document.querySelector(".cl-copiado"));
  c.dom.window.close();
}
{
  const c = celular({ copiado: LINK, permissao: "granted" });
  c.lote.adicionarACaixa([LINK], "pc");
  await c.lote.verificarLinkCopiado();
  check("link que já está na caixa não é oferecido outra vez", !c.window.document.querySelector(".cl-copiado"));
  c.dom.window.close();
}
{
  const c = celular({ copiado: LINK, permissao: "granted", opcoes: { avisarLinkCopiado: false } });
  await c.lote.verificarLinkCopiado();
  check("o aviso pode ser desligado nas opções", !c.window.document.querySelector(".cl-copiado") && c.area.leituras === 0);
  c.dom.window.close();
}

console.log("\n5. Ponte com o app");
{
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  check("o app diz ao lote se há sessão iniciada", html.includes("window.__CineClipApp={logado:!!r,settings:S,"));
}

console.log("\n─────────────────────────────────────────────");
if (fail) {
  console.log(`❌ ${pass} passaram, ${fail} falharam:`);
  for (const f of falhas) console.log(`   • ${f}`);
  process.exit(1);
}
console.log(`✅ ${pass} passaram, 0 falharam`);
process.exit(0);
