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
import { pathToFileURL } from "node:url";
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

const codigo = [extrair("function _wNit("), extrair("function _wDesfoque("), extrair("function _w("), extrair("async function bi(")].join("\n");

/**
 * Vídeo falso: `linhaClara(t, y)` diz se a linha y (na escala 640) do quadro no
 * instante t tem imagem (true) ou é escura (false).
 */
function ambiente({ largura, altura, duracao, linhaClara, pixel }) {
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
        const valor = linhaClara ? (linhaClara(quadro, row) ? 200 : 6) : 0;
        for (let col = 0; col < w; col++) {
          const k = (row * w + col) * 4;
          data[k] = data[k + 1] = data[k + 2] = pixel ? pixel(quadro, row, col) : valor;
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

console.log("\n6. Os patches podem correr outra vez sem duplicar nada");
{
  const dir = path.join(root, "tools", "patches");
  const nomes = fs.readdirSync(dir).filter((f) => f.endsWith(".find")).map((f) => f.slice(0, -5)).sort();
  const norm = (s) => String(s || "").replace(/\r\n/g, "\n");
  const htmlNorm = norm(html);
  const ler = (n, ext) => norm(fs.readFileSync(path.join(dir, `${n}.${ext}`), "utf8")).replace(/\n$/, "");
  const presente = (n) => htmlNorm.includes(ler(n, "replace"));
  const naoDetetados = nomes.filter((n) => !presente(n) && !nomes.some((m) => m > n && ler(m, "find").includes(ler(n, "replace")) && presente(m)));
  check("todos os patches são reconhecidos como aplicados", naoDetetados.length === 0, naoDetetados.join(", "));
  check("a camada de nuvem é carregada uma só vez", html.split('<script src="nuvem-duravel.js"></script>').length === 2);
  check("o upload em massa é carregado uma só vez", html.split('<script src="lote-massa.js"></script>').length === 2);
}

console.log("\n7. Faixas BRANCAS uniformes também são cortadas");
{
  const { faixaClara } = await import(pathToFileURL(path.join(root, "servidor", "video.mjs")).href);
  const L = 200, A = 300;
  // 60 linhas de faixa em cima e em baixo; no meio, imagem cinzenta.
  const montar = (corFaixa) => {
    const rgb = new Uint8Array(L * A * 3);
    for (let y = 0; y < A; y++) {
      for (let x = 0; x < L; x++) {
        const k = (y * L + x) * 3;
        const v = (y < 60 || y >= A - 60) ? corFaixa : 128;
        rgb[k] = v; rgb[k + 1] = v; rgb[k + 2] = v;
      }
    }
    return rgb;
  };
  const preta = faixaClara(montar(0), L, A);
  check("faixa preta: a imagem vai de 60 a 239", !!preta && preta.t === 60 && preta.b === A - 61, JSON.stringify(preta));
  const branca = faixaClara(montar(255), L, A);
  check("faixa branca: a imagem vai de 60 a 239 (era o que faltava)", !!branca && branca.t === 60 && branca.b === A - 61, JSON.stringify(branca));
  // Uma cena genuinamente clara (mas não branco puro) não pode ser comida.
  const clara = faixaClara(montar(238), L, A);
  check("cinzento claro não conta como faixa", !clara || clara.t === 0, JSON.stringify(clara));
}

console.log("\n8. Fundo DESFOCADO (o vídeo ampliado e borrado por trás)");
{
  /* Como o corte do TikTok que o app cortava mal: desfoque em cima, faixa
     branca com o gancho, o filme, e desfoque laranja em baixo com um texto
     nítido («Não esqueça de seguir»). Na escala 640×1138: desfoque 0–230,
     branca 231–431, filme 432–906, desfoque 907–1137 com texto em 950–990. */
  const ruido = (t, y, x) => ((x * 7919 + y * 104729 + Math.floor(t) * 31337) % 97) * 1.6;
  const pixel = (t, y, x) => {
    if (y <= 230) return 150 + Math.round(40 * Math.sin(x / 200 + y / 300)); // desfoque liso
    if (y <= 431) return 250; // faixa branca do gancho
    if (y <= 906) return 60 + ruido(t, y, x); // filme (textura)
    if (y >= 950 && y <= 990) return (x % 12 < 6) ? 250 : 120; // texto nítido sobre o desfoque
    return 170 + Math.round(30 * Math.sin(x / 180)); // desfoque liso
  };
  const ctx = ambiente({ largura: LARGURA, altura: ALTURA, duracao: 60, pixel });
  const r = await ctx.bi("blob:x", 0, 60);
  const fimFilme = r && r.y + r.h;
  check("começa logo abaixo da faixa branca", !!r && Math.abs(r.y - (432 * 1920) / 1138) <= 4, JSON.stringify(r));
  check("acaba onde o filme acaba (sem o desfoque de baixo)", !!r && Math.abs(fimFilme - (907 * 1920) / 1138) <= 4, JSON.stringify(r));
  check("o texto nítido sobre o desfoque fica de fora", !!r && fimFilme < (950 * 1920) / 1138, JSON.stringify(r));
}
{
  // Céu claro e liso no topo do filme na maior parte dos quadros, com detalhe nos outros.
  const pixel = (t, y, x) => {
    if (y < TOPO || y > FUNDO) return 4;
    if (y < TOPO + 200 && t < 40) return 180;
    return 60 + ((x * 7919 + y * 104729 + Math.floor(t)) % 97) * 1.6;
  };
  const ctx = ambiente({ largura: LARGURA, altura: ALTURA, duracao: 60, pixel });
  const r = await ctx.bi("blob:x", 0, 60);
  check("céu liso só em parte dos quadros continua a ser filme", JSON.stringify(r) === JSON.stringify(esperado), JSON.stringify(r));
}
{
  // O servidor («Processar na nuvem») usa a mesma regra que o app.
  const { cortarDesfoque, nitidezLinhas } = await import(pathToFileURL(path.join(root, "servidor", "video.mjs")).href);
  const v = 1138;
  const nit = new Float32Array(v);
  const luz = new Float32Array(v).fill(150);
  for (let y = 432; y <= 906; y++) nit[y] = 6;
  for (let y = 950; y <= 990; y++) nit[y] = 20;
  const corte = JSON.stringify(cortarDesfoque(432, 1137, nit, luz, v));
  check("servidor: corta o mesmo trecho que o app", corte === "[432,906]", corte);
  check("servidor: linha lisa tem nitidez 0", nitidezLinhas(new Uint8Array(10 * 2 * 3).fill(100), 10, 2).n[0] === 0);
}

console.log("\n9. Reel abaixo de 100 MB (limite do Worker R2 grátis)");
{
  // Teto de bitrate pela duração: 1:40 a ~7 Mbps dá ~88 MB; clipes curtos têm folga.
  const { tetoKbps } = await import(pathToFileURL(path.join(root, "servidor", "video.mjs")).href);
  check("1:40 → teto de 6912 kbps (~88 MB com o áudio)", tetoKbps(100) === 6912, String(tetoKbps(100)));
  check("o tamanho máximo de 1:40 fica abaixo de 90 MB", (100 * (tetoKbps(100) + 128) * 1000) / 8 < 90e6);
  check("clipes curtos não descem da qualidade (teto de 12 Mbps)", tetoKbps(20) === 12000);
  check("clipes longuíssimos não ficam ilegíveis (mínimo 1,5 Mbps)", tetoKbps(1000) === 1500);
  const ys = modulo.slice(modulo.indexOf("async function YS("), modulo.indexOf("function XS("));
  const m = /"-maxrate",t\+"k","-bufsize",2\*t\+"k"\]\)\((Math\.max\(1500,Math\.min\(12e3,Math\.floor\(\(704e6\/Math\.max\(1,g\)-128e3\)\/1e3\)\)\))\)/.exec(ys);
  check("o app usa -maxrate pela duração no FFmpeg do navegador", !!m);
  const tetoApp = m && new Function("g", "return " + m[1]);
  check("o app e o servidor calculam o mesmo teto", !!tetoApp && [10, 45, 60, 100, 150].every((g) => tetoApp(g) === tetoKbps(g)));
  const vsrc = fs.readFileSync(path.join(root, "servidor", "video.mjs"), "utf8");
  check("o servidor passa o teto ao libx264", vsrc.includes('"-maxrate", `${tetoKbps(dur)}k`'));
}

console.log("\n─────────────────────────────────────────────");
if (fail) {
  console.log(`❌ ${pass} passaram, ${fail} falharam`);
  process.exit(1);
}
console.log(`✅ ${pass} passaram, 0 falharam`);
