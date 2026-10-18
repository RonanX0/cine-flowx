#!/usr/bin/env node
/**
 * A legenda gerada tem de chegar COMPLETA ao Passo 3.
 *
 *   node tools/test-legenda.mjs
 *
 * Três frentes, todas com o código real do bundle (não com cópias):
 *
 *   A. o ficheiro — os cortes de tokens e o normalizador novo têm de estar nos
 *      três bundles (index / app-pronto / 404), e o filtro antigo que apagava
 *      blocos inteiros (o motivo de a legenda chegar mais curta do que a IA
 *      escreveu) tem de ter desaparecido;
 *   B. rS + _ccLegendaIncompleta extraídos do bundle — a colar a primeira linha
 *      ao Parágrafo 1, o préâmbulo do modelo, as hashtags a mais, `undefined`
 *      no título, o corte a meio de uma frase;
 *   C. window.CineClipCore.gerarLegenda em jsdom com a fetch fingida — quando a
 *      resposta vem cortada (finish_reason "length" / MAX_TOKENS) o app tenta de
 *      novo e fica com a melhor; max_tokens da NVIDIA; resposta que não é uma
 *      legenda → erro claro em vez de uma legenda fantasma.
 *
 * Precisa de jsdom e fake-indexeddb (devDependencies); sem eles, C é saltado.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");

let JSDOM, fakeIndexedDB, IDBKeyRange;
try {
  ({ JSDOM } = await import("jsdom"));
  ({ indexedDB: fakeIndexedDB, IDBKeyRange } = await import("fake-indexeddb"));
} catch {
  console.log("\n⚠️  jsdom/fake-indexeddb não estão instalados — cenário C saltado.\n");
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
async function esperar(desc, fn, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`tempo esgotado à espera de: ${desc}`);
    await sleep(30);
  }
}

/* Extrai `inicio`…fim da função/bloco correspondente, respeitando strings e
   template literals (as chavetas dos regex e dos templates mentem um match
   ingénuo). */
function extrairBloco(fonte, inicio) {
  const a = fonte.indexOf(inicio);
  if (a < 0) return null;
  const start = fonte.indexOf("{", fonte.indexOf("(", a));
  let nivel = 0;
  let aspas = null;
  for (let i = start; i < fonte.length; i++) {
    const ch = fonte[i];
    if (aspas) {
      if (ch === "\\") { i++; continue; }
      if (ch === aspas) aspas = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { aspas = ch; continue; }
    if (ch === "{") nivel++;
    else if (ch === "}" && --nivel === 0) return fonte.slice(a, i + 1);
  }
  return null;
}

const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const modulo = /<script type="module">([\s\S]*?)<\/script>/.exec(html)[1];

/* ======================================================================
   A. o ficheiro
   ====================================================================== */
console.log("\nA. Bundle — limites de tokens e normalizador");

check("o texto de serviço da IA deixa de apagar parágrafos inteiros", !html.includes('c=i.filter(p=>!/^QUER ASSISTIR/i.test(p)&&!p.startsWith("🎬")&&!/^#/.test(p))'));
check("Nova NVIDIA: legenda com 4000 tokens (antes 1200)", /async function qc\(r,o,a=!1,i=lg\[0\],c=4000\)/.test(html));
check("Nova NVIDIA: o orçamento é passado pelo ug", /async function ug\(r,o,a=!1,i=lg,_ccMax=4000\)/.test(html) && html.includes("qc(r,o,a,f,_ccMax)"));
check("NVIDIA: finish_reason \"length\" marca o corte", html.includes('_ccNf=_ccMarcarCorte(((p==null?void 0:p.choices)==null?void 0:p.choices[0].finishReason)||"")'));
check("Gemini: finishReason MAX_TOKENS marca o corte", html.includes('_ccGf=_ccMarcarCorte(((v==null?void 0:v.candidates)==null?void 0:v.candidates[0].finishReason)||"")'));
check("_ccMarcarCorte/_ccLerCorte declarados no bundle", html.includes("function _ccMarcarCorte(t){") && html.includes("function _ccLerCorte(){"));
check("o pedido extra da retentativa existe", html.includes("const _ccPedidoCompleto=") && html.includes("NÃO CORTES A RESPOSTA"));
check("oS usa o pedido extra e a deteção de legenda incompleta", /if\(_ccLegendaIncompleta\(_ccLeg\)\.incompleta\)\{/.test(html) && html.includes("g+_ccPedidoCompleto"));
check("Passo 3 avisa quando a legenda chega cortada (não diz só \"gerada\")", html.includes("_ccLegendaIncompleta(Be)") && html.includes("chegou cortada"));
check("o timeout maior da NVIDIA não foi revertido (patch 33)", html.includes("max_tokens:a?800:c})},9e4)"));
check("só existe uma definição de rS", (html.match(/function rS\(/g) || []).length === 1);
check("o prompt da legenda usa o MESMO construtor da linha do título", html.includes('- Linha do título exatamente: "${_ccLinhaTituloLegenda(o)}"'));
check("o prompt não exige título duplicado entre parênteses", !html.includes("🎬 Smallville (Smallville)") && !html.includes('Linha do título exatamente: "🎬 ${o.title} (${o.original})"'));

for (const f of ["app-pronto.html", "404.html"]) {
  check(`${f} é idêntico a index.html`, fs.readFileSync(path.join(root, f), "utf8") === html);
}
for (const nome of ["70-legenda-nvidia-tokens", "71-legenda-ug-orcamento", "72-legenda-normalizador", "73-legenda-completa", "74-legenda-aviso-corte", "75-legenda-pedido-completo"]) {
  const par = ["find", "replace"].map((e) => path.join(root, "tools", "patches", `${nome}.${e}`));
  check(`patch ${nome} versionado (find+replace)`, par.every((p) => fs.existsSync(p)));
}

/* ======================================================================
   B. o normalizador, extraído do bundle
   ====================================================================== */
console.log("\nB. rS / _ccLegendaIncompleta (código real do bundle)");

const inicioNorm = modulo.indexOf("const _ccHashtagRe=");
const fimNorm = modulo.indexOf("}", modulo.indexOf("function _ccMarcarCorte(")) + 1;
const codeNorm = inicioNorm >= 0 && fimNorm > inicioNorm ? modulo.slice(inicioNorm, fimNorm) : "";
const norm = (() => {
  if (!codeNorm || codeNorm.length < 500) return { erro: "bloco do normalizador não localizado no bundle" };
  try {
    return new Function(`${codeNorm}\nreturn {rS, inc:_ccLegendaIncompleta, palavras:_ccPalavras};`)();
  } catch (e) {
    return { erro: e.message };
  }
})();
check("o bloco do normalizador é extraível e compila", !norm.erro, norm.erro || "");
if (norm.erro) console.log("   ⚠️  bloco:", JSON.stringify(codeNorm.slice(0, 80)), "…", JSON.stringify(codeNorm.slice(-120)));

const FILME = { title: "Smallville", original: "Smallville", year: "2001", kind: "tv", genres: ["Drama"], overview: "x" };
const FILME2 = { title: "Homem-Aranha: Sem Regresso", original: "Spider-Man: No Way Home", year: "2021", kind: "movie", genres: ["Ação"], overview: "x" };
const CTA = "QUER ASSISTIR A ESTA SÉRIE? LINK NA BIO! 🎬";
const p = (n, w = "palavra") => Array(n).fill(w).join(" ") + ".";

const rS = norm.rS || null;
const inc = norm.inc || null;
if (rS && inc) {
  const corpo = (t) => t.split("\n\n").filter((b) => b && !/^QUER ASSISTIR/i.test(b) && !/^🎬/.test(b) && !/^#/.test(b));
  const casos = [
    ["formato pedido", `${CTA}\n\n🎬 Smallville (Smallville)\n\n${p(90)}\n\n${p(90, "outra")}\n\n${p(45, "fim")}\n\n#Smallville #Series #Drama #Suspense`],
    ["primeira linha colada ao parágrafo 1", `${CTA}\n${p(90)}\n\n${p(90, "outra")}\n\n${p(45, "fim")}\n\n#Smallville #Series #Drama #Suspense`],
    ["título colado ao parágrafo 1", `${CTA}\n\n🎬 Smallville (Smallville)\n${p(90)}\n\n${p(90, "outra")}\n\n${p(45, "fim")}\n\n#Smallville #Series #Drama #Suspense`],
    ["préâmbulo do modelo", `Claro! Aqui está a legenda:\n\n${CTA}\n\n🎬 Smallville (Smallville)\n\n${p(90)}\n\n${p(90, "outra")}\n\n${p(45, "fim")}\n\n#Smallville #Series #Drama #Suspense`],
    ["rótulos markdown", `${CTA}\n\n🎬 Smallville (Smallville)\n\n**Gancho:** ${p(90)}\n\n**Parágrafo 2:** ${p(90, "outra")}\n\n**CTA:** ${p(45, "fim")}\n\n#Smallville #Series #Drama #Suspense`],
    ["resposta em cercadinho", "```text\n" + `${CTA}\n\n🎬 Smallville (Smallville)\n\n${p(90)}\n\n${p(90, "outra")}\n\n${p(45, "fim")}\n\n#Smallville #Series #Drama #Suspense` + "\n```"],
    ["hashtags no meio do parágrafo 3", `${CTA}\n\n🎬 Smallville (Smallville)\n\n${p(90)}\n\n${p(90, "outra")}\n\n${p(45, "fim")} #Smallville #Drama\n\n#Series #Suspense`],
  ];
  for (const [nome, bruto] of casos) {
    const out = rS(bruto, CTA, FILME);
    const c = corpo(out);
    check(`rS: «${nome}» mantém os 3 parágrafos`, c.length >= 3, `${c.length} parágrafos`);
    check(`rS: «${nome}» não perde o parágrafo 1`, out.includes("palavra palavra palavra"));
    check(`rS: «${nome}» não deixa conversa do modelo`, !/Claro!|Aqui está/i.test(out));
    check(`rS: «${nome}» não deixa rótulos no corpo`, !/\*\*Gancho|\*\*Parágrafo/.test(out));
    check(`rS: «${nome}» tem uma única linha de hashtags (≤4) no fim`, (() => {
      const linhas = out.split("\n\n");
      const ult = linhas[linhas.length - 1];
      return /^#[^\n]+$/.test(ult) && (ult.match(/#\w+/g) || []).length <= 4 && linhas.slice(0, -1).every((l) => !/#\w/.test(l));
    })());
    check(`rS: «${nome}» começa com a CTA e a linha do título`, out.startsWith(`${CTA}\n\n🎬 Smallville`));
    check(`rS: «${nome}» é considerada completa`, !inc(out).incompleta, JSON.stringify(inc(out)));
  }

  const cortada = `${CTA}\n\n🎬 Smallville (Smallville)\n\n${p(60)}\n\n${Array(30).fill("outra").join(" ")} e o momento em que`;
  const outCortada = rS(cortada, CTA, FILME);
  check("rS: corte por falta de tokens é assinalado como incompleto", inc(outCortada).incompleta, JSON.stringify(inc(outCortada)));
  check("rS: corte por falta de tokens não apaga o que veio", outCortada.includes("palavra palavra") && outCortada.includes("outra outra"));
  check("rS: parágrafo repetido pelo modelo só aparece uma vez", (() => {
    const d = `${CTA}\n\n🎬 Smallville (Smallville)\n\n${p(90)}\n\n${p(90)}\n\n${p(45, "fim")}\n\n#A #B #C #D #E #F #G #H`;
    const o = rS(d, CTA, FILME);
    return o.split("\n\n").filter((b) => b.startsWith("palavra")).length === 1 && (o.match(/#[A-H]/g) || []).length === 4;
  })());
  check("rS: título sem parênteses duplicados quando original = título", (() => {
    const o = rS(`${CTA}\n\n🎬 Smallville (Smallville)\n\n${p(90)}\n\n${p(90, "outra")}\n\n${p(45, "fim")}\n\n#Smallville #Series`, CTA, FILME);
    return o.includes("🎬 Smallville\n") && !o.includes("Smallville (Smallville)");
  })());
  check("rS: nunca escreve \"undefined\" nem rebenta sem dados", (() => {
    const o = rS(`${CTA}\n\n${p(90)}\n\n${p(90, "outra")}\n\n${p(45, "fim")}`, CTA, { title: "", original: undefined, kind: undefined });
    return !/undefined/.test(o) && o.includes("🎬 Clipe de filme") && o.includes("#Filme");
  })());
  check("rS: título original diferente é mantido", rS(`${CTA}\n\n${p(90)}\n\n${p(90, "outra")}\n\n${p(45, "fim")}`, "QUER ASSISTIR A ESTE FILME? LINK NA BIO! 🎬", FILME2).includes("🎬 Homem-Aranha: Sem Regresso (Spider-Man: No Way Home)"));
  check("rS: resposta vazia não produce legenda fantasma", (() => {
    const o = rS("", CTA, FILME);
    return inc(o).incompleta && inc(o).palavras === 0;
  })());
  check("rS: negrito do parágrafo 2 é preservado", (() => {
    const b = `${CTA}\n\n🎬 Smallville (Smallville)\n\n${p(90)}\n\n${Array(89).fill("outra").join(" ")} **o segredo foi revelado**.\n\n${p(45, "fim")}\n\n#Smallville #Series`;
    return rS(b, CTA, FILME).includes("**o segredo foi revelado**");
  })());
}

/* ======================================================================
   C. window.CineClipCore.gerarLegenda com a rede fingida
   ====================================================================== */
if (JSDOM) {
  console.log("\nC. CineClipCore.gerarLegenda com IA fingida");

  const resposta = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => headers[String(n).toLowerCase()] ?? null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body ?? {})),
    json: async () => (typeof body === "string" ? JSON.parse(body) : body ?? {}),
    body: { cancel: async () => {} },
  });

  /** Fila de respostas da IA (Gemini e NVIDIA); o último elemento repete. */
  let fila = [];
  const pedidos = [];
  const dom = new JSDOM(html, { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  window.indexedDB = fakeIndexedDB;
  window.IDBKeyRange = IDBKeyRange;
  window.TextEncoder = globalThis.TextEncoder;
  window.TextDecoder = globalThis.TextDecoder;
  try { Object.defineProperty(window, "crypto", { value: globalThis.crypto, configurable: true }); } catch {}
  window.fetch = async (url, opts) => {
    const u = String(url);
    const corpo = opts && opts.body != null ? String(opts.body) : "";
    if (u.includes("/api/public/nvidia")) {
      const proximo = fila.shift() ?? fila[0];
      pedidos.push({ provedor: "nvidia", corpo });
      if (!proximo) return resposta(400, { error: "sem chave NVIDIA" });
      return resposta(200, { choices: [{ message: { content: proximo.texto }, finish_reason: proximo.finish ?? "stop" }] });
    }
    if (u.includes(":generateContent")) {
      const proximo = fila.shift() ?? fila[0];
      pedidos.push({ provedor: "gemini", corpo });
      if (!proximo) return resposta(200, { candidates: [{ content: { parts: [{ text: "" }] } }] });
      return resposta(200, { candidates: [{ content: { parts: [{ text: proximo.texto }] }, finishReason: proximo.finish || "STOP" }] });
    }
    return resposta(200, { key: "stub" }, { "content-type": "application/json" });
  };
  window.matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false });
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.scrollTo = () => {};
  window.confirm = () => true;
  window.URL.createObjectURL = () => "blob:stub";
  window.URL.revokeObjectURL = () => {};
  for (const n of ["log", "info", "debug", "warn", "error"]) window.console[n] = () => {};

  const mod = /<script type="module">([\s\S]*?)<\/script>/.exec(html)[1].replace(/import\.meta\.url/g, '"file:///index.html"');
  window.eval(fs.readFileSync(path.join(root, "nuvem-duravel.js"), "utf8"));
  window.eval(mod);
  const core = await esperar("window.CineClipCore", () => window.CineClipCore);

  const legendaCompleta = `${CTA}\n\n🎬 Smallville (Smallville)\n\n${p(90)}\n\n${p(90, "outra")}\n\n${p(45, "fim")}\n\n#Smallville #Series #Drama #Suspense`;
  const legendaCortada = `${CTA}\n\n🎬 Smallville (Smallville)\n\n${p(60)}\n\n${Array(30).fill("outra").join(" ")} e o momento em que`;

  /* C1 — o parágrafo colado à primeira linha sobrevive (era apagado pelo rS). */
  fila = [{ texto: `${CTA}\n${p(90)}\n\n${p(90, "outra")}\n\n${p(45, "fim")}\n\n#Smallville #Series #Drama #Suspense` }];
  pedidos.length = 0;
  let saida = await core.gerarLegenda("", FILME, "pt-PT", { geminiKey: "gem-stub" });
  check("gerarLegenda: não perde o parágrafo colado à CTA", saida.includes("palavra palavra palavra") && saida.includes("outra outra") && saida.includes("fim fim"));
  check("gerarLegenda: resposta completa não provoca tentativa extra", pedidos.length === 1, `${pedidos.length} pedidos`);

  /* C2 — resposta cortada no limite de tokens → o app tenta de novo. */
  fila = [{ texto: legendaCortada, finish: "MAX_TOKENS" }, { texto: legendaCompleta }];
  pedidos.length = 0;
  saida = await core.gerarLegenda("", FILME, "pt-PT", { geminiKey: "gem-stub" });
  check("gerarLegenda: IA cortada → segunda tentativa pedida", pedidos.length >= 2, `${pedidos.length} pedidos`);
  check("gerarLegenda: a segunda tentativa pede explicitamente para não cortar", /NÃO CORTES A RESPOSTA/.test(pedidos[1]?.corpo || ""));
  check("gerarLegenda: fica com a versão completa", (saida.split("\n\n").filter((b) => /^(palavra|outra|fim)/.test(b)).length) === 3 && saida.includes("#Suspense"), saida.split("\n\n").map((b) => b.slice(0, 30)).join(" | "));
  check("gerarLegenda: a legenda final é dada como completa", !!inc && !inc(saida).incompleta, inc ? JSON.stringify(inc(saida)) : "(bloco não compilou)");

  /* C3 — as duas tentativas cortadas → devolve a mais longa, sem rebentar. */
  fila = [{ texto: legendaCortada, finish: "MAX_TOKENS" }, { texto: `${CTA}\n\n🎬 Smallville (Smallville)\n\n${p(70)}\n\n${p(70, "outra")}\n\n${p(40, "fim")}\n\n#Smallville #Series`, finish: "MAX_TOKENS" }];
  pedidos.length = 0;
  saida = await core.gerarLegenda("", FILME, "pt-PT", { geminiKey: "gem-stub" });
  check("gerarLegenda: duas cortadas → fica a mais longa", saida.includes("#Smallville #Series") && !!inc && inc(saida).palavras > 150, inc ? JSON.stringify(inc(saida)) : "(bloco não compilou)");

  /* C4 — NVIDIA: orçamento de tokens e finish_reason. */
  fila = [{ texto: legendaCompleta }, { texto: legendaCompleta }];
  pedidos.length = 0;
  saida = await core.gerarLegenda("nv-stub", FILME2, "pt-BR", {});
  const corpoNvidia = JSON.parse(pedidos[0]?.corpo || "{}");
  check("gerarLegenda: NVIDIA recebe max_tokens ≥ 4000", Number(corpoNvidia.max_tokens) >= 4000, `max_tokens=${corpoNvidia.max_tokens}`);
  check("gerarLegenda: o prompt da legenda vai todo para a NVIDIA", /LINK NA BIO/.test(corpoNvidia.messages?.[0]?.content || "") && /FORMATO EXATO/.test(corpoNvidia.messages?.[0]?.content || ""));
  check("gerarLegenda: legenda da NVIDIA normalizada", saida.startsWith("QUER ASSISTIR A ESTE FILME? LINK NA BIO! 🎬\n\n🎬 Homem-Aranha: Sem Regresso (Spider-Man: No Way Home)") && (saida.match(/#\w+/g) || []).length === 4, saida.slice(0, 90));

  /* C5 — resposta que não é uma legenda → erro, não lixo agendado. */
  fila = [{ texto: "Desculpa, não consigo ajudar com isso." }, { texto: "Desculpa, não consigo ajudar com isso." }];
  let erro = "";
  try { await core.gerarLegenda("", FILME, "pt-PT", { geminiKey: "gem-stub" }); } catch (e) { erro = (e && e.message) || String(e); }
  check("gerarLegenda: conversa em vez de legenda → erro claro", /legenda/.test(erro) && !/Desculpa/.test(erro), erro);

  /* C6 — sem chaves nenhuma: erro, sem legenda fantasma. */
  fila = [];
  erro = "";
  try { await core.gerarLegenda("", FILME, "pt-PT", {}); } catch (e) { erro = (e && e.message) || String(e); }
  check("gerarLegenda: sem chave → falha em vez de uma legenda vazia", erro.length > 5, erro || "(sem erro)");

  window.close?.();
}

console.log(`\n${fail ? "❌" : "✅"} test-legenda: ${pass} verificação(ões) certa(s), ${fail} falha(s).`);
if (falhas.length) console.log("Falharam:\n  - " + falhas.join("\n  - "));
process.exit(fail ? 1 : 0);
