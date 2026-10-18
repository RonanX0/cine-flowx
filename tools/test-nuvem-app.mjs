#!/usr/bin/env node
/**
 * Testes do lado do app para o servidor na nuvem (lote-massa.js):
 * deteção do servidor, botão "☁️ Processar na nuvem", escolha lembrada, estado
 * dos links no painel e "Tentar de novo" / "Fazer aqui".
 *
 *   node tools/test-nuvem-app.mjs
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const LOTE = fs.readFileSync(path.join(root, "lote-massa.js"), "utf8");

let JSDOM, ResourceLoader;
try {
  ({ JSDOM, ResourceLoader } = await import("jsdom"));
} catch {
  console.log("\n⚠️  jsdom não está instalado — teste saltado.\n");
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

function celular({ url = "https://cine-flowx.vercel.app/", servidor = true, opcoes = null, caixa = null, vercel = false } = {}) {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url, runScripts: "outside-only", pretendToBeVisual: true,
    resources: new ResourceLoader({ userAgent: "Mozilla/5.0 (Linux; Android 12; SM-G970F) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36" }),
  });
  const { window } = dom;
  if (opcoes) window.localStorage.setItem("cineclip.lote.opcoes", JSON.stringify(opcoes));
  if (caixa) window.localStorage.setItem("cineclip.links.caixa", JSON.stringify(caixa));
  window.URL.createObjectURL = () => "blob:x";
  window.URL.revokeObjectURL = () => {};
  const reg = { sincronizacoes: 0, baixados: [], pedidosClaims: 0, acordados: 0, ordem: [] };
  window.CineCloud = {
    activeClaims: async () => {
      reg.pedidosClaims++;
      return servidor ? [{ provider: "r2", key: "cc_abc_servidor_nuvem", owner: "servidor:nuvem", expiresAt: Date.now() + 240000 }] : [];
    },
  };
  window.eval(LOTE);
  const lote = window.CineLote._interno;
  const fila = [];
  lote.ambiente.app = () => ({
    logado: true,
    settings: { groqKey: "nv", tmdbKey: "tm" },
    account: { id: "acc_cena", name: "@cena.oculta", dailySlots: ["12:00"] },
    atualizarFila() {},
    sincronizar: async () => { reg.sincronizacoes++; reg.ordem.push("sincronizar"); },
    abrirConfiguracoes() {}, abrirAgendador() {}, abrirNoEstudio() {},
  });
  lote.ambiente.core = () => ({
    lerMetadados: async () => ({ duration: 30, fields: [] }), detetarBarras: async () => null, quadros: async () => ["q"], audio: async () => null,
    identificar: async () => ({ titulo: "Filme", confianca: 90, ganchos: ["g"] }), procurarTmdb: async (k, ia) => ({ title: ia.titulo }),
    processar: async (f, i, fim, r, g, p) => { p(1); return new window.Blob([new Uint8Array(3)]); }, gerarLegenda: async () => "leg",
    limparLegenda: (s) => s, proximoHorario: () => "2026-10-14T12:00", guardarNaFila: async (r) => { fila.push(r); }, lerFila: async () => fila.slice(), guardarHistorico() {},
  });
  lote.ambiente.lerVideo = async () => ({ largura: 1080, altura: 1920, duracao: 30 });
  // Nuvem na Vercel (api/nuvem.js): GET diz se está configurada, POST acorda-a.
  lote.ambiente.consultarNuvem = async () => ({ ok: true, configurado: !!vercel, tipo: "vercel" });
  lote.ambiente.acordarNuvem = async () => { reg.acordados++; reg.ordem.push("acordar"); return { ok: true, status: 202 }; };
  lote.ambiente.baixarLink = async (link) => { reg.baixados.push(link); return new window.File([new Uint8Array(4)], "v.mp4", { type: "video/mp4" }); };
  return { dom, window, lote, reg, fila };
}

const LINK = "https://vm.tiktok.com/ZMnuvem1/";
const partilha = (l) => "https://cine-flowx.vercel.app/compartilhar?text=" + encodeURIComponent("vê isto " + l);
const botoesDaFolha = (w) => [...w.document.querySelectorAll(".cl-folha button")];

console.log("\n☁️  App ↔ servidor na nuvem\n");

console.log("1. Deteção do servidor e botão «Processar na nuvem»");
{
  const c = celular({ url: partilha(LINK), servidor: true });
  await esperar("botão nuvem", () => botoesDaFolha(c.window).find((b) => /Processar na nuvem/.test(b.textContent)));
  check("com o servidor ligado, a folha oferece «☁️ Processar na nuvem»", true);
  check("fica registado que o servidor foi visto", c.lote.servidorLigado() && Number(c.window.localStorage.getItem("cineclip.servidor.visto")) > 0);
  check("as outras opções continuam lá", botoesDaFolha(c.window).some((b) => /Processar agora aqui/.test(b.textContent)) && botoesDaFolha(c.window).some((b) => /Mandar para o PC/.test(b.textContent)));

  botoesDaFolha(c.window).find((b) => /Processar na nuvem/.test(b.textContent)).click();
  await esperar("enviado", () => /Enviado para a nuvem/.test(c.window.document.querySelector(".cl-folha")?.textContent || ""));
  const e = c.lote.lerCaixa()[0];
  check("o link vai para a caixa com destino nuvem", e && e.destino === "nuvem" && e.estado === "pendente" && e.url === LINK);
  check("leva a conta ativa (o servidor agenda nessa conta)", e && e.contaId === "acc_cena");
  check("sincroniza logo e diz que pode fechar", c.reg.sincronizacoes === 1 && /Já podes fechar/.test(c.window.document.querySelector(".cl-folha").textContent));
  await sleep(300);
  check("o celular não processa o que mandou para a nuvem", c.reg.baixados.length === 0 && c.fila.length === 0);
  c.dom.window.close();
}
{
  const c = celular({ url: partilha(LINK), servidor: false });
  await esperar("folha", () => botoesDaFolha(c.window).length);
  await sleep(150);
  check("sem servidor visto, a folha não mostra a opção da nuvem", !botoesDaFolha(c.window).some((b) => /Processar na nuvem/.test(b.textContent)));
  c.dom.window.close();
}

console.log("\n2. Escolha lembrada");
{
  const c = celular({ url: partilha(LINK), servidor: true });
  await esperar("botão nuvem", () => botoesDaFolha(c.window).find((b) => /Processar na nuvem/.test(b.textContent)));
  c.window.document.querySelector(".cl-folha input[type=checkbox]").click();
  botoesDaFolha(c.window).find((b) => /Processar na nuvem/.test(b.textContent)).click();
  await esperar("enviado", () => c.reg.sincronizacoes === 1);
  check("lembra «nuvem»", c.lote.estado.opcoes.aoPartilhar === "nuvem");
  c.lote.receberPartilha(partilha("https://vm.tiktok.com/ZMnuvem2/"));
  await esperar("segunda", () => c.reg.sincronizacoes === 2);
  check("a próxima partilha vai direto para a nuvem", c.lote.lerCaixa().filter((e) => e.destino === "nuvem").length === 2);
  c.dom.window.close();
}
{
  const c = celular({ servidor: false, opcoes: { aoPartilhar: "nuvem" } });
  c.window.localStorage.setItem("cineclip.servidor.visto", String(Date.now() - 3 * 3600 * 1000));
  c.lote.receberPartilha(partilha(LINK));
  await esperar("aviso", () => /Enviado para a nuvem/.test(c.window.document.querySelector(".cl-folha")?.textContent || ""));
  check("se o servidor está sem sinal, o envio avisa", /não deu sinal de vida/.test(c.window.document.querySelector(".cl-folha").textContent));
  c.dom.window.close();
}

console.log("\n3. Estado no painel e «Tentar de novo»");
{
  const agora = Date.now();
  const c = celular({ servidor: true, caixa: [
    { id: "lk_ok", url: "https://vm.tiktok.com/ok/", destino: "nuvem", estado: "feito", reelId: "r1", criadoEm: agora, atualizadoEm: agora },
    { id: "lk_rev", url: "https://vm.tiktok.com/rev/", destino: "nuvem", estado: "revisar", erro: "A IA acha que é \"X\", mas só com 40% de certeza.", criadoEm: agora, atualizadoEm: agora - 1000 },
  ] });
  c.window.CineLote.abrir();
  await esperar("estado ligado", () => /Servidor na nuvem: ligado/.test(c.window.document.querySelector(".cl-painel")?.textContent || ""));
  const texto = c.window.document.querySelector(".cl-painel").textContent;
  check("mostra «Servidor na nuvem: ligado»", true);
  check("lista os links da nuvem com o estado", /Agendado/.test(texto) && /Rever/.test(texto) && /40% de certeza/.test(texto));

  const tentar = [...c.window.document.querySelectorAll("button")].find((b) => b.textContent === "Agendar mesmo assim (nuvem)");
  check("vídeo «Rever» oferece «Agendar mesmo assim (nuvem)»", !!tentar);
  tentar.click();
  const e = c.lote.lerCaixa().find((x) => x.id === "lk_rev");
  check("volta a pôr o link na fila, como nova tentativa forçada", e.estado === "pendente" && e.destino === "nuvem" && e.tentativa === 1 && e.forcar === true);
  const junta = c.window.CineLote.mesclarLinks([{ id: "lk_rev", url: "https://vm.tiktok.com/rev/", destino: "nuvem", estado: "revisar", criadoEm: agora, atualizadoEm: agora + 5000 }]);
  check("a nova tentativa ganha ao estado antigo que vem da nuvem", junta.find((x) => x.id === "lk_rev").estado === "pendente");
  const doServidor = c.window.CineLote.mesclarLinks([{ ...e, estado: "feito", reelId: "r2", atualizadoEm: Date.now() + 10000 }]);
  check("…e o resultado do servidor nessa tentativa ganha ao pendente", doServidor.find((x) => x.id === "lk_rev").estado === "feito");
  c.dom.window.close();
}
{
  const agora = Date.now();
  const c = celular({ servidor: true, caixa: [
    { id: "lk_err", url: "https://vm.tiktok.com/err/", destino: "nuvem", estado: "erro", erro: "O TikTok bloqueou o servidor.", criadoEm: agora, atualizadoEm: agora },
  ] });
  c.window.CineLote.abrir();
  await esperar("botão", () => [...c.window.document.querySelectorAll("button")].find((b) => b.textContent === "Fazer aqui"));
  [...c.window.document.querySelectorAll("button")].find((b) => b.textContent === "Fazer aqui").click();
  await esperar("processado aqui", () => c.fila.length === 1, 6000);
  check("«Fazer aqui» processa o link no próprio aparelho", c.reg.baixados[0] === "https://vm.tiktok.com/err/");
  const e = c.lote.lerCaixa().find((x) => x.id === "lk_err");
  check("e o link passa a «aqui», feito", e.destino === "aqui" && e.estado === "feito" && e.tentativa === 1);
  c.dom.window.close();
}

console.log("\n3b. Nuvem na Vercel (sem servidor ligado)");
{
  const c = celular({ servidor: false, vercel: true });
  c.lote.receberPartilha(partilha(LINK));
  await esperar("botão nuvem", () => botoesDaFolha(c.window).find((b) => /Processar na nuvem/.test(b.textContent)));
  check("com a Vercel configurada, a folha oferece «☁️ Processar na nuvem»", true);
  botoesDaFolha(c.window).find((b) => /Processar na nuvem/.test(b.textContent)).click();
  await esperar("enviado", () => /Enviado para a nuvem/.test(c.window.document.querySelector(".cl-folha")?.textContent || ""));
  check("acorda a nuvem uma vez, depois de o link chegar ao cofre", c.reg.acordados === 1 && c.reg.ordem.indexOf("sincronizar") >= 0 && c.reg.ordem.indexOf("sincronizar") < c.reg.ordem.indexOf("acordar"), JSON.stringify(c.reg.ordem));
  check("o celular não processa nada", c.reg.baixados.length === 0 && c.fila.length === 0);
  c.dom.window.close();
}
{
  const c = celular({ servidor: false, vercel: false });
  c.lote.receberPartilha(partilha(LINK));
  await sleep(400);
  check("sem a Vercel configurada (nem servidor), não oferece a nuvem", !botoesDaFolha(c.window).some((b) => /Processar na nuvem/.test(b.textContent)) && c.reg.acordados === 0);
  c.dom.window.close();
}
{
  const agora = Date.now();
  const c = celular({ servidor: false, vercel: true, caixa: [
    { id: "lk_espera", url: "https://vm.tiktok.com/espera/", destino: "nuvem", estado: "pendente", criadoEm: agora, atualizadoEm: agora },
  ] });
  await esperar("acordada ao abrir", () => c.reg.acordados === 1, 4000).catch(() => {});
  check("ao abrir o app com links à espera da nuvem, acorda-a", c.reg.acordados === 1, String(c.reg.acordados));
  check("não acorda outra vez logo a seguir (no máximo 1x a cada 2 min)", c.lote.acordarNuvem(false) === false && c.reg.acordados === 1);
  c.window.CineLote.abrir();
  await esperar("estado", () => /Nuvem \(Vercel\): pronta/.test(c.window.document.querySelector(".cl-painel")?.textContent || ""));
  check("o painel mostra «☁️ Nuvem (Vercel): pronta»", true);
  c.dom.window.close();
}

console.log("\n4. Chave do servidor");
{
  const c = celular({ servidor: true });
  c.window.localStorage.setItem("cineclip.auth.session", JSON.stringify({ username: "ronan", vaultHash: "abc123", encryptionKeyB64: "S0VZ" }));
  let erro = null;
  try { c.lote.chaveDoServidor(); } catch (e) { erro = e; }
  check("sem R2 configurado, explica que o servidor precisa dele", erro && /Cloudflare R2/.test(erro.message));
  c.lote.ambiente.app = () => ({ logado: true, settings: { r2WorkerUrl: "https://cineclip-cloud.x.workers.dev/", r2Token: "tok" }, account: { id: "a" } });
  const chave = c.lote.chaveDoServidor();
  const cfg = JSON.parse(Buffer.from(chave.replace("CINECLIP1:", ""), "base64").toString("utf8"));
  check("a chave leva o cofre, a cifra e o R2 (e é curta)", chave.length < 600 && cfg.VAULT_HASH === "abc123" && cfg.ENCRYPTION_KEY_B64 === "S0VZ" && cfg.R2_WORKER_URL === "https://cineclip-cloud.x.workers.dev" && cfg.R2_TOKEN === "tok" && cfg.CONTA === "ronan");
  const { lerConfigDoRobo } = await import("../servidor/cofre.mjs");
  const doServidor = lerConfigDoRobo("  " + chave + "\n");
  check("o servidor aceita a chave tal como o app a gera", doServidor.VAULT_HASH === "abc123" && doServidor.R2_TOKEN === "tok");
  c.dom.window.close();
}

console.log("\n─────────────────────────────────────────────");
if (fail) {
  console.log(`❌ ${pass} passaram, ${fail} falharam:`);
  for (const f of falhas) console.log(`   • ${f}`);
  process.exit(1);
}
console.log(`✅ ${pass} passaram, 0 falharam`);
process.exit(0);
