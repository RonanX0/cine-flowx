#!/usr/bin/env node
/**
 * Editor de horários do Agendador (aba "Conta e horários") — bundle REAL em jsdom.
 *
 *   • adicionar com os seletores de hora/minuto e com as sugestões;
 *   • remover (e não deixar ficar sem nenhum);
 *   • "Preencher automaticamente" (de X até Y, a cada N);
 *   • "Copiar estes horários para outras contas" — com updatedAt novo nas contas
 *     copiadas, senão a sincronização podia ficar com os horários antigos;
 *   • trocar de conta não muda o updatedAt (patch 32): uma cópia antiga num
 *     aparelho já não apaga os horários editados noutro.
 *
 *   node tools/test-horarios.mjs
 */
import fs from "node:fs";
import path from "node:path";

let JSDOM, fakeIndexedDB, IDBKeyRange;
try {
  ({ JSDOM } = await import("jsdom"));
  ({ indexedDB: fakeIndexedDB, IDBKeyRange } = await import("fake-indexeddb"));
} catch {
  console.log("\n⚠️  jsdom/fake-indexeddb não estão instalados — teste saltado.\n");
  process.exit(0);
}

const root = path.resolve(import.meta.dirname, "..");
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
async function esperar(desc, fn, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("tempo esgotado: " + desc);
    await sleep(40);
  }
}

const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const modulo = /<script type="module">([\s\S]*?)<\/script>/.exec(html)[1].replace(/import\.meta\.url/g, '"file:///index.html"');
const nuvem = fs.readFileSync(path.join(root, "nuvem-duravel.js"), "utf8");

const CONTAS = [
  { id: "acc_a", name: "@sombra.em.cena", mode: "meta_api", igUserId: "1", metaAccessToken: "x", fbPageId: "", webhookUrl: "", dailySlots: ["12:00", "18:00"], autoPilot: true, shareToFeed: true, updatedAt: 1000 },
  { id: "acc_b", name: "@cineteca", mode: "meta_api", igUserId: "2", metaAccessToken: "y", fbPageId: "", webhookUrl: "", dailySlots: ["10:00"], autoPilot: true, shareToFeed: true, updatedAt: 1000 },
  { id: "acc_c", name: "@cortes", mode: "meta_api", igUserId: "3", metaAccessToken: "z", fbPageId: "", webhookUrl: "", dailySlots: ["20:00"], autoPilot: true, shareToFeed: true, updatedAt: 1000 },
];

const resposta = (status, corpo) => ({
  ok: status < 300, status, headers: { get: () => null },
  text: async () => JSON.stringify(corpo), json: async () => corpo, body: { cancel: async () => {} },
});

const dom = new JSDOM(html, { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
const { window } = dom;
window.indexedDB = fakeIndexedDB;
window.IDBKeyRange = IDBKeyRange;
window.TextEncoder = globalThis.TextEncoder;
window.TextDecoder = globalThis.TextDecoder;
try { Object.defineProperty(window, "crypto", { value: globalThis.crypto, configurable: true }); } catch {}
window.fetch = async () => resposta(200, { key: "stub", id: "stub", link: "https://stub.local/v.mp4" });
window.matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false });
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.HTMLMediaElement.prototype.load = () => {};
window.scrollTo = () => {};
window.URL.createObjectURL = () => "blob:x";
window.URL.revokeObjectURL = () => {};
let confirmar = true;
window.confirm = () => confirmar;
for (const n of ["log", "info", "debug", "warn"]) window.console[n] = () => {};
window.localStorage.setItem("cineclip.ig.accounts", JSON.stringify(CONTAS));
window.localStorage.setItem("cineclip.ig.active", "acc_a");
window.eval(nuvem);
window.eval(modulo);

const contas = () => JSON.parse(window.localStorage.getItem("cineclip.ig.accounts"));
const conta = (id) => contas().find((a) => a.id === id);
const botao = (texto) => [...window.document.querySelectorAll("button")].find((b) => (b.textContent || "").trim().includes(texto));
function escolher(rotulo, valor) {
  const sel = window.document.querySelector(`select[aria-label="${rotulo}"]`);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
  setter.call(sel, valor);
  sel.dispatchEvent(new window.Event("change", { bubbles: true }));
}
function digitar(input, valor) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, valor);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}
const chips = () => [...window.document.querySelectorAll(".cc-slot")].map((e) => e.textContent.trim());

console.log("\n🕒 Horários do Agendador\n");
const entrar = await esperar("login", () => botao("Entrar e Sincronizar Tudo"));
const [u, p] = window.document.querySelectorAll("input");
digitar(u, "teste@cineclip");
digitar(p, "senha-de-teste");
entrar.click();
(await esperar("aba Agendador", () => botao("Agendador"))).click();
(await esperar("aba Conta", () => [...window.document.querySelectorAll("[role=tab], button")].find((b) => /^Conta/.test((b.textContent || "").trim())))).click();
await esperar("editor", () => window.document.querySelector(".cc-slots"));

console.log("1. Adicionar e remover");
check("mostra os horários da conta", chips().join(",") === "12:00,18:00", chips().join(","));
escolher("Hora", "15");
escolher("Minutos", "30");
check("o botão diz o que vai adicionar", !!botao("Adicionar 15:30"));
botao("Adicionar 15:30").click();
await esperar("15:30", () => conta("acc_a").dailySlots.includes("15:30"));
check("adiciona 15:30, por ordem", conta("acc_a").dailySlots.join(",") === "12:00,15:30,18:00", conta("acc_a").dailySlots.join(","));
botao("Adicionar 15:30").click();
await sleep(150);
check("não duplica um horário que já existe", conta("acc_a").dailySlots.filter((s) => s === "15:30").length === 1);
const sug = [...window.document.querySelectorAll(".cc-sug")];
check("sugere horários que ainda não estão na lista", sug.length > 0 && !sug.some((b) => /12:00|18:00|15:30/.test(b.textContent)), sug.map((b) => b.textContent).join(" "));
sug.find((b) => /08:00/.test(b.textContent)).click();
await esperar("08:00", () => conta("acc_a").dailySlots.includes("08:00"));
check("uma sugestão adiciona com um toque", conta("acc_a").dailySlots[0] === "08:00");
window.document.querySelector('[aria-label="Remover 08:00"]').click();
await esperar("sem 08:00", () => !conta("acc_a").dailySlots.includes("08:00"));
check("remove com o ×", conta("acc_a").dailySlots.join(",") === "12:00,15:30,18:00");
check("mostra quantas publicações por dia", /3 publicações por dia/.test(window.document.querySelector(".cc-slots").textContent));

console.log("\n2. Preencher automaticamente");
escolher("Começa às", "10");
escolher("Acaba às", "22");
escolher("Intervalo", "180");
await sleep(50);
check("mostra a prévia antes de trocar", /5 horário\(s\): 10:00 · 13:00 · 16:00 · 19:00 · 22:00/.test(window.document.querySelector(".cc-slots").textContent));
confirmar = false;
botao("Usar estes horários").click();
await sleep(100);
check("se cancelar a confirmação, não muda nada", conta("acc_a").dailySlots.join(",") === "12:00,15:30,18:00");
confirmar = true;
botao("Usar estes horários").click();
await esperar("gerados", () => conta("acc_a").dailySlots.length === 5);
check("troca pelos horários gerados", conta("acc_a").dailySlots.join(",") === "10:00,13:00,16:00,19:00,22:00", conta("acc_a").dailySlots.join(","));

console.log("\n3. Copiar para outras contas");
const caixa = (nome) => [...window.document.querySelectorAll(".cc-copia")].find((l) => l.textContent.includes(nome)).querySelector("input");
check("lista as outras contas com os horários atuais", /@cineteca/.test(window.document.querySelector(".cc-slots").textContent) && /agora: 10:00/.test(window.document.querySelector(".cc-slots").textContent));
caixa("@cineteca").click();
await esperar("marcada", () => caixa("@cineteca").checked);
const antes = Date.now();
botao("Copiar para 1 conta").click();
await esperar("copiado", () => conta("acc_b").dailySlots.length === 5);
check("copia os horários para a conta escolhida", conta("acc_b").dailySlots.join(",") === conta("acc_a").dailySlots.join(","));
check("a conta copiada ganha updatedAt novo (a sincronização fica com os novos)", conta("acc_b").updatedAt >= antes, String(conta("acc_b").updatedAt));
check("as contas não escolhidas ficam iguais", conta("acc_c").dailySlots.join(",") === "20:00" && conta("acc_c").updatedAt === 1000);
botao("Selecionar todas").click();
await esperar("todas", () => !!botao("Copiar para 2 contas"));
botao("Copiar para 2 contas").click();
await esperar("copiado 2", () => conta("acc_c").dailySlots.length === 5);
check("«Selecionar todas» copia para todas", conta("acc_c").dailySlots.join(",") === "10:00,13:00,16:00,19:00,22:00");

console.log("\n4. Trocar de conta não «rejuvenesce» a conta");
const b0 = conta("acc_b").updatedAt;
const c0 = conta("acc_c").updatedAt;
await sleep(20);
const seletor = [...window.document.querySelectorAll(".cc-acc")].find((e) => /@cortes/.test(e.textContent));
if (seletor) {
  seletor.click();
  await esperar("ativa", () => window.localStorage.getItem("cineclip.ig.active") === "acc_c");
  check("mudar para outra conta não muda o updatedAt dela", conta("acc_c").updatedAt === c0 && conta("acc_b").updatedAt === b0, `${conta("acc_c").updatedAt} vs ${c0}`);
} else {
  check("há o seletor de contas", false);
}

dom.window.close();
console.log("\n─────────────────────────────────────────────");
if (fail) {
  console.log(`❌ ${pass} passaram, ${fail} falharam:`);
  for (const f of falhas) console.log(`   • ${f}`);
  process.exit(1);
}
console.log(`✅ ${pass} passaram, 0 falharam`);
