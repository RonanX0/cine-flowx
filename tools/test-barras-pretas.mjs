#!/usr/bin/env node
/**
 * Deteção das faixas pretas (letterbox) — o código REAL do bundle (`_w` e `bi`).
 *
 *   node tools/test-barras-pretas.mjs
 *
 * O app recorta as faixas pretas antes de montar o 9:16. Antes do patch
 * 29-barras-cenas-escuras ele usava a MEDIANA de 8 quadros: numa cena em que o
 * topo da imagem é escuro (céu à noite, sombras) a maior parte dos quadros via
 * essa zona como "faixa preta" e o app cortava um bom pedaço do filme. Agora a
 * imagem vai do topo mais alto ao fundo mais baixo vistos em qualquer quadro.
 *
 * Os quadros são simulados (vídeo e canvas falsos); as funções vêm do index.html.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const modulo = /<script type="module">([\s\S]*?)<\/script>/.exec(html)[1];

let pass = 0;
let fail = 0;
function check(nome, ok, detalhe = "") {
  if (ok) {
    pass++;
    console.log(`   ✔ ${nome}`);
  } else {
    fail++;
    console.log(`   ❌ ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
  }
}

/** Extrai uma função do bundle pelo início da declaração (chavetas equilibradas). */
function extrair(inicio) {
  const a = modulo.indexOf(inicio);
  if (a < 0) throw new Error(`não encontrei ${inicio} no bundle`);
  let i = modulo.indexOf("{", a);
  let nivel = 0;
  let aspas = null;
  for (; i < modulo.length; i++) {
    const ch = modulo[i];
    if (aspas) {
      if (ch === "\\") { i++; continue; }
      if (ch === aspas) aspas = null;
      continue;
    }
    if (ch === "/" && modulo[i + 1] === "*") { i = modulo.indexOf("*/", i + 2) + 1; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { aspas = ch; continue; }
    if (ch === "{") nivel++;
    else if (ch === "}" && --nivel === 0) return modulo.slice(a, i + 1);
  }
  throw new Error(`chavetas desequilibradas em ${inicio}`);
}

const codigo = extrair("function _w(") + "\n" + extrair("async function bi(");

/**
 * Vídeo falso: `linhaClara(t, y)` diz se a linha y (na escala 640) do quadro no
 * instante t tem imagem (true) ou é escura (false).
 */
function ambiente({ largura, altura, duracao, linhaClara }) {
  let tempo = 0;
  const video = {
    muted: false, preload: "", crossOrigin: "",
    videoWidth: largura, videoHeight: altura, duration: duracao,
    onloadeddata: null, onerror: null, onseeked: null,
    set src(_) { setTimeout(() => this.onloadeddata && this.onloadeddata(), 0); },
    get currentTime() { return tempo; },
    set currentTime(t) { tempo = t; setTimeout(() => this.onseeked && this.onseeked(), 0); },
  };
  let quadro = 0;
  const contexto = {
    drawImage: (v) => { quadro = v.currentTime; },
    getImageData: (x, y, w, h) => {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let row = 0; row < h; row++) {
        const valor = linhaClara(quadro, row) ? 200 : 6;
        for (let col = 0; col < w; col++) {
          const k = (row * w + col) * 4;
          data[k] = data[k + 1] = data[k + 2] = valor;
          data[k + 3] = 255;
        }
      }
      return { data };
    },
  };
  const documento = {
    createElement: (tag) => (tag === "video" ? video : { width: 0, height: 0, getContext: () => contexto }),
  };
  const ctx = vm.createContext({
    document: documento,
    URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => {} },
    setTimeout, Promise, Math, Number, Array,
  });
  vm.runInContext(codigo, ctx);
  return ctx;
}

/* Vídeo 1080x1920 do TikTok: filme no meio (linhas 261–876 na escala 640×1138),
   faixas pretas em cima e em baixo. */
const LARGURA = 1080, ALTURA = 1920, TOPO = 261, FUNDO = 876;
const esperado = { y: 440, h: 1040, vh: 1920, vw: 1080 };

console.log("\n🎞️  Faixas pretas (código real do bundle)\n");

console.log("1. Cena escura no topo da imagem durante quase todo o vídeo");
{
  // Só os primeiros 10% do vídeo têm a imagem toda clara; depois, as 190 linhas
  // de cima do filme ficam escuras (céu à noite) — continua a ser filme.
  const ctx = ambiente({
    largura: LARGURA, altura: ALTURA, duracao: 60,
    linhaClara: (t, y) => y >= TOPO && y <= FUNDO && (t < 6 || y >= TOPO + 190),
  });
  const r = await ctx.bi("blob:x", 0, 60);
  check("mantém a imagem toda do filme (não corta o céu escuro)", JSON.stringify(r) === JSON.stringify(esperado), JSON.stringify(r));
}

console.log("\n2. Filme com faixas pretas e imagem sempre clara");
{
  const ctx = ambiente({ largura: LARGURA, altura: ALTURA, duracao: 60, linhaClara: (t, y) => y >= TOPO && y <= FUNDO });
  const r = await ctx.bi("blob:x", 0, 60);
  check("recorta exatamente as faixas pretas", JSON.stringify(r) === JSON.stringify(esperado), JSON.stringify(r));
}

console.log("\n3. Texto do autor dentro da faixa preta de cima");
{
  // Uma legenda branca fixa nas linhas 120–170 (dentro da faixa) não é filme.
  const ctx = ambiente({
    largura: LARGURA, altura: ALTURA, duracao: 60,
    linhaClara: (t, y) => (y >= TOPO && y <= FUNDO) || (y >= 120 && y <= 170),
  });
  const r = await ctx.bi("blob:x", 0, 60);
  check("o texto do autor fica de fora do recorte", JSON.stringify(r) === JSON.stringify(esperado), JSON.stringify(r));
}

console.log("\n4. Vídeo sem faixas pretas");
{
  const ctx = ambiente({ largura: 1920, altura: 1080, duracao: 30, linhaClara: () => true });
  const r = await ctx.bi("blob:x", 0, 30);
  check("não recorta nada", r === null, JSON.stringify(r));
}

console.log("\n5. Cena muito escura (quadros sem área clara suficiente)");
{
  // Metade dos quadros quase pretos (fade): são ignorados, os outros decidem.
  const ctx = ambiente({
    largura: LARGURA, altura: ALTURA, duracao: 60,
    linhaClara: (t, y) => y >= TOPO && y <= FUNDO && t < 30,
  });
  const r = await ctx.bi("blob:x", 0, 60);
  check("usa os quadros claros e mantém o filme todo", JSON.stringify(r) === JSON.stringify(esperado), JSON.stringify(r));
}

console.log("\n5b. Duração Infinity (WebM/MKV) não trava nem lança TypeError");
{
  const ctx = ambiente({
    largura: LARGURA, altura: ALTURA, duracao: Infinity,
    linhaClara: (t, y) => Number.isFinite(t) && y >= TOPO && y <= FUNDO,
  });
  const rSemFim = await ctx.bi("blob:x", 0);
  const rComFim = await ctx.bi("blob:x", 0, 60);
  check("com duration=Infinity e sem fim explícito, não falha e deteta as barras", JSON.stringify(rSemFim) === JSON.stringify(esperado), JSON.stringify(rSemFim));
  check("com duration=Infinity e fim=60, usa o fim finito", JSON.stringify(rComFim) === JSON.stringify(esperado), JSON.stringify(rComFim));
}

console.log("\n6. Os patches podem correr outra vez sem duplicar nada");
{
  const dir = path.join(root, "tools", "patches");
  const nomes = fs.readdirSync(dir).filter((f) => f.endsWith(".find")).map((f) => f.slice(0, -5)).sort();
  const ler = (n, ext) => {
    const t = fs.readFileSync(path.join(dir, `${n}.${ext}`), "utf8");
    return t.endsWith("\n") ? t.slice(0, -1) : t;
  };
  const presente = (n) => html.includes(ler(n, "replace"));
  const naoDetetados = nomes.filter((n) => !presente(n) && !nomes.some((m) => m > n && ler(m, "find").includes(ler(n, "replace")) && presente(m)));
  check("todos os patches são reconhecidos como aplicados", naoDetetados.length === 0, naoDetetados.join(", "));
  check("a camada de nuvem é carregada uma só vez", html.split('<script src="nuvem-duravel.js"></script>').length === 2);
  check("o upload em massa é carregado uma só vez", html.split('<script src="lote-massa.js"></script>').length === 2);
}

console.log("\n─────────────────────────────────────────────");
if (fail) {
  console.log(`❌ ${pass} passaram, ${fail} falharam`);
  process.exit(1);
}
console.log(`✅ ${pass} passaram, 0 falharam`);
