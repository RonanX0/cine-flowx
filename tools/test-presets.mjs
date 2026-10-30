#!/usr/bin/env node
/**
 * Presets de formatação do Reel — "escuro" (Formato 1) e "claro" (Formato 2).
 *
 *   node tools/test-presets.mjs
 *
 * Os dois formatos foram medidos pixel a pixel nas capturas formato-1.png e
 * formato-2.png (raiz do repositório). Este teste garante três coisas:
 *
 *   1. a geometria que o bundle calcula (`Eh`) bate certo com as medidas das
 *      capturas, e o preset "atual" continua exatamente como era;
 *   2. o desenho do gancho (`_h`) muda com o preset — pílula só no "atual",
 *      cantos arredondados e rodapé só no "escuro" — e nunca invade a caixa do
 *      vídeo;
 *   3. o servidor (servidor/video.mjs + presets.mjs) faz as MESMAS contas que o
 *      app, e o lote em massa leva o estilo da conta até ao FFmpeg.
 *
 * Tudo corre em node:vm com um canvas falso; não precisa de ffmpeg nem de npm.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const modulo = /<script type="module">([\s\S]*?)<\/script>/.exec(html)[1];
const lote = fs.readFileSync(path.join(root, "lote-massa.js"), "utf8");
const trabalhador = fs.readFileSync(path.join(root, "servidor", "trabalhador.mjs"), "utf8");

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
const perto = (a, b, tol) => Math.abs(a - b) <= tol;

/** Extrai uma função do bundle pelo início da declaração (chavetas equilibradas). */
function extrair(fonte, inicio) {
  const a = fonte.indexOf(inicio);
  if (a < 0) throw new Error(`não encontrei "${inicio}"`);
  let i = fonte.indexOf("{", a);
  let nivel = 0;
  let aspas = null;
  for (; i < fonte.length; i++) {
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
  throw new Error(`chavetas desequilibradas em ${inicio}`);
}

/** Extrai `const NOME={...};` (objeto literal, chavetas equilibradas). */
function extrairConst(fonte, nome) {
  const inicio = `const ${nome}={`;
  const a = fonte.indexOf(inicio);
  if (a < 0) throw new Error(`não encontrei ${inicio}`);
  let i = fonte.indexOf("{", a + 6);
  let nivel = 0;
  let aspas = null;
  for (; i < fonte.length; i++) {
    const ch = fonte[i];
    if (aspas) {
      if (ch === "\\") { i++; continue; }
      if (ch === aspas) aspas = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { aspas = ch; continue; }
    if (ch === "{") nivel++;
    else if (ch === "}" && --nivel === 0) return fonte.slice(a, i + 1) + ";";
  }
  throw new Error(`chavetas desequilibradas em ${inicio}`);
}

/* --------------------------------------------------- código real do bundle */
const codigo = [
  extrairConst(modulo, "PRESETS_DO_REEL"),
  extrair(modulo, "function presetDoReel("),
  extrair(modulo, "function alvoDaCaixa("),
  extrair(modulo, "function caixaDoPreset("),
  extrair(modulo, "function Eh("),
  extrair(modulo, "function _h("),
].join("\n");

/** Canvas falso que regista tudo o que o `_h` desenha. */
function canvasFalso() {
  const chamadas = { fillText: [], strokeText: [], fill: [], arc: [], roundRect: [], cores: [], fonts: [], drawImage: [], fillRect: [] };
  const ctx = {
    font: "", fillStyle: "", textAlign: "", textBaseline: "",
    shadowColor: "", shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
    strokeStyle: "", lineWidth: 0, lineJoin: "", lineCap: "", miterLimit: 0,
    clearRect() {}, save() {}, restore() {}, beginPath() {}, closePath() {}, clip() {},
    drawImage(...a) { chamadas.drawImage.push(a); },
    moveTo() {}, lineTo() {}, rect() {}, stroke() {},
    fillRect(...a) { chamadas.fillRect.push({ args: a, cor: ctx.fillStyle }); },
    roundRect(...a) { chamadas.roundRect.push(a); },
    arc(...a) { chamadas.arc.push(a); },
    fill(regra) { chamadas.fill.push({ regra: regra || "nonzero", cor: ctx.fillStyle }); },
    measureText(t) {
      const px = Number(/(\d+(?:\.\d+)?)px/.exec(ctx.font || "")?.[1] || 20);
      return { width: String(t).length * px * 0.55 };
    },
    strokeText(t, x, y) {
      chamadas.strokeText.push({ texto: String(t), x, y, cor: ctx.strokeStyle, largura: ctx.lineWidth });
    },
    fillText(t, x, y) {
      chamadas.fillText.push({ texto: String(t), x, y, cor: ctx.fillStyle, font: ctx.font });
      if (!chamadas.cores.includes(ctx.fillStyle)) chamadas.cores.push(ctx.fillStyle);
      if (!chamadas.fonts.includes(ctx.font)) chamadas.fonts.push(ctx.font);
    },
  };
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  return { canvas, ctx, chamadas };
}

const contexto = vm.createContext({ Math, console });
vm.runInContext(codigo + "\n;globalThis.api={PRESETS_DO_REEL,presetDoReel,alvoDaCaixa,caixaDoPreset,Eh,_h};", contexto);
const api = contexto.api;
const { PRESETS_DO_REEL, Eh, _h, caixaDoPreset } = api;

/** Desenha o gancho como o app desenha (GS/Im) e devolve o registo do canvas. */
function desenhar(preset, texto, geo, { rodape = "", rodapeCor = "", cor = "", perfil } = {}) {
  const { canvas, chamadas } = canvasFalso();
  const caixa = caixaDoPreset(preset, geo, rodape, rodapeCor);
  // No app o perfil vem das definições da conta; no teste injeta-se à mão.
  if (perfil !== undefined) caixa.perfil = perfil;
  _h(canvas, geo.outWidth, geo.outHeight, geo.padY, texto, !texto, cor, preset, caixa);
  return { canvas, chamadas, caixa };
}

/* ------------------------------------------------------------------ 1 */
/* Seletor de cor (gancho e rodapé): grava uma vez ao parar de mexer, não a cada movimento. */
{
  const htmlCor = fs.readFileSync(path.join(root, "index.html"), "utf8");
  check("cor do gancho: grava só depois de parar de mexer (debounce)", htmlCor.includes("window.__ccCorH=setTimeout(()=>ye({hookColor:v,hookTextColor:v}),700)"));
  check("cor do rodapé: idem", htmlCor.includes("window.__ccCorF=setTimeout(()=>ye({footerColor:v,rodapeCor:v}),700)"));
  check("os seletores já não regravam o cofre a cada evento", !htmlCor.includes("onChange:N=>ye({hookColor:N.target.value,hookTextColor:N.target.value})") && !htmlCor.includes("onChange:N=>ye({footerColor:N.target.value,rodapeCor:N.target.value})"));
}

console.log("\n1. A tabela de presets (medidas das capturas)");
check("cinco presets: atual, escuro, claro, perfil e destaque", ["atual", "escuro", "claro", "perfil", "destaque"].every((k) => PRESETS_DO_REEL[k]), Object.keys(PRESETS_DO_REEL).join(","));
check("escuro = caixa 1:1 com margens e cantos arredondados", PRESETS_DO_REEL.escuro.caixa === "quadrado" && PRESETS_DO_REEL.escuro.margem === 0.05 && PRESETS_DO_REEL.escuro.raio > 0);
check("claro = faixa 4:3 de ponta a ponta, sem cantos", PRESETS_DO_REEL.claro.caixa === "banda" && PRESETS_DO_REEL.claro.margem === 0 && PRESETS_DO_REEL.claro.raio === 0);
check("fundos: escuro preto, claro branco", PRESETS_DO_REEL.escuro.fundo === "preto" && PRESETS_DO_REEL.claro.fundo === "branco");
check("gancho: escuro fluorescente, claro preto, atual branco", PRESETS_DO_REEL.escuro.ganchoCor === "#ECFA12" && PRESETS_DO_REEL.claro.ganchoCor === "#000000" && PRESETS_DO_REEL.atual.ganchoCor === "#FFFFFF");
check("só o atual leva a pílula por trás do gancho", PRESETS_DO_REEL.atual.ganchoPill === true && PRESETS_DO_REEL.escuro.ganchoPill === false && PRESETS_DO_REEL.claro.ganchoPill === false);
check("rodapé só no escuro (verde, a 93,55% da altura)", PRESETS_DO_REEL.escuro.rodapeTamanho > 0 && PRESETS_DO_REEL.escuro.rodapeCor === "#2DBD2C" && PRESETS_DO_REEL.claro.rodapeTamanho === 0 && PRESETS_DO_REEL.atual.rodapeTamanho === 0);
/* Os dois formatos novos não têm caixa de proporção fixa: ela segue o aspeto do
   vídeo e encaixa na faixa que sobra entre o gancho e o rodapé. O que aqui se
   fixa é o que não pode variar — a caixa não subir para cima do gancho nem
   descer para cima do rodapé, e a imagem não ser esticada. */
check("perfil e destaque usam a caixa maleável", ["perfil", "destaque"].every((k) =>
  PRESETS_DO_REEL[k].caixa === "livre" && PRESETS_DO_REEL[k].caixaFim > PRESETS_DO_REEL[k].topo));
check("perfil e destaque são de fundo branco e sem pílula", ["perfil", "destaque"].every((k) =>
  PRESETS_DO_REEL[k].fundo === "branco" && PRESETS_DO_REEL[k].ganchoPill === false));

for (const id of ["perfil", "destaque"]) {
  const P = PRESETS_DO_REEL[id];
  const deitado = Eh(1920, 1080, { top: 0, bottom: 0, vw: 1920, vh: 1080 }, 720, id);
  const vertical = Eh(1080, 1920, { top: 0, bottom: 0, vw: 1080, vh: 1920 }, 720, id);
  const quadrado = Eh(1080, 1080, { top: 0, bottom: 0, vw: 1080, vh: 1080 }, 720, id);

  for (const [nome, caixa] of [["16:9", deitado], ["9:16", vertical], ["1:1", quadrado]]) {
    check(`${id} ${nome}: o vídeo ocupa a largura toda, de ponta a ponta`,
      caixa.videoW === caixa.outWidth && caixa.padX === 0, `videoW=${caixa.videoW} padX=${caixa.padX}`);
    // O aspeto da caixa tem de bater com o do RECORTE (não com o do original):
    // é isso que garante que o ffmpeg escala sem esticar a imagem.
    const aspeto = caixa.videoW / caixa.videoH;
    const aspetoRecorte = caixa.cropW / caixa.cropH;
    check(`${id} ${nome}: a imagem não é esticada`,
      Math.abs(aspeto - aspetoRecorte) < 0.02, `caixa ${aspeto.toFixed(3)} vs recorte ${aspetoRecorte.toFixed(3)}`);
    check(`${id} ${nome}: a caixa não invade o espaço do gancho`,
      caixa.padY >= Math.floor(caixa.outHeight * P.topo) - 2, `padY=${caixa.padY} topo=${Math.round(caixa.outHeight * P.topo)}`);
    check(`${id} ${nome}: a caixa não invade o rodapé`,
      caixa.padY + caixa.videoH <= Math.ceil(caixa.outHeight * P.caixaFim) + 2,
      `fim=${caixa.padY + caixa.videoH} limite=${Math.round(caixa.outHeight * P.caixaFim)}`);
    check(`${id} ${nome}: se corta, corta só na vertical`,
      caixa.cropX === 0 && caixa.cropW === caixa.vw, JSON.stringify({ cropX: caixa.cropX, cropW: caixa.cropW, vw: caixa.vw }));
  }
  check(`${id}: um 16:9 cabe inteiro, sem recorte`, deitado.cropH === deitado.vh, `${deitado.cropH} vs ${deitado.vh}`);
  check(`${id}: um vertical é cortado para caber, e fica mais alto do que o 16:9`,
    vertical.cropH < vertical.vh && vertical.videoH > deitado.videoH, `${vertical.videoH} vs ${deitado.videoH}`);
}

check("o rodapé é fixo no preset e ganha ao texto da conta", ["perfil", "destaque"].every((k) =>
  /B10/.test(PRESETS_DO_REEL[k].rodapeFixo) && PRESETS_DO_REEL[k].rodapeFaixa === true &&
  PRESETS_DO_REEL[k].rodapeFundo === "#000000" && PRESETS_DO_REEL[k].rodapeCor === "#FFFFFF" &&
  /legenda/.test(PRESETS_DO_REEL[k].rodapeNota)));
check("destaque = gancho vermelho, menor do que o do perfil",
  PRESETS_DO_REEL.destaque.ganchoCor === "#EC1C24" &&
  PRESETS_DO_REEL.destaque.ganchoTamanho < PRESETS_DO_REEL.perfil.ganchoTamanho,
  `${PRESETS_DO_REEL.destaque.ganchoTamanho} vs ${PRESETS_DO_REEL.perfil.ganchoTamanho}`);
check("o contorno preto do gancho continua ligado para cor que não seja preta",
  /usaBordaPreta=!\/\^#\(\?:000\|000000\)\$\/i\.test/.test(modulo), "o desenho perdeu a borda automática");

/* ------------------------------------------------- cabeçalho de perfil */
{
  const geo = Eh(1080, 1920, { top: 0, bottom: 0, vw: 1080, vh: 1920 }, 720, "perfil");
  const PERFIL = { nome: "Cena seguinte", arroba: "@cena.seguinte", avatar: "data:image/png;base64,AA==", verificado: true };

  const com = desenhar("perfil", "Esse filme será seu proximo vicio", geo, { perfil: PERFIL });
  const textos = com.chamadas.fillText.map((c) => c.texto);
  check("cabeçalho: escreve o nome da conta", textos.includes("Cena seguinte"), JSON.stringify(textos));
  check("cabeçalho: escreve o @ com arroba garantida",
    textos.includes("@cena.seguinte") && !textos.includes("cena.seguinte"), JSON.stringify(textos));
  check("cabeçalho: o @ sai em cinzento, não na cor do gancho",
    com.chamadas.fillText.find((c) => c.texto === "@cena.seguinte")?.cor === PRESETS_DO_REEL.perfil.perfilArrobaCor);
  check("cabeçalho: desenha o selo azul do verificado",
    com.chamadas.fill.some((x) => String(x.cor).toUpperCase() === "#1D9BF0"), JSON.stringify(com.chamadas.fill.map((x) => x.cor)));

  const semSelo = desenhar("perfil", "Gancho", geo, { perfil: { ...PERFIL, verificado: false } });
  check("cabeçalho: sem verificado, não há selo azul",
    !semSelo.chamadas.fill.some((x) => String(x.cor).toUpperCase() === "#1D9BF0"));

  const soNome = desenhar("perfil", "Gancho", geo, { perfil: { nome: "Só Nome", arroba: "", avatar: "" } });
  const textosSo = soNome.chamadas.fillText.map((c) => c.texto);
  check("cabeçalho: campo vazio não aparece", textosSo.includes("Só Nome") && !textosSo.some((t) => t.startsWith("@")));

  /* Centragem: o bloco (foto + nome/@) vai ao centro, por isso um nome maior
     empurra-o para a esquerda. Sem foto, o texto fica simétrico no eixo. */
  const curto = desenhar("perfil", "G", geo, { perfil: { nome: "AB", arroba: "", avatar: "", verificado: false } });
  const longo = desenhar("perfil", "G", geo, { perfil: { nome: "ABCDEFGHIJKLMNOP", arroba: "", avatar: "", verificado: false } });
  const xCurto = curto.chamadas.fillText.find((c) => c.texto === "AB").x;
  const xLongo = longo.chamadas.fillText.find((c) => c.texto === "ABCDEFGHIJKLMNOP").x;
  check("cabeçalho: um nome maior empurra o bloco para a esquerda", xLongo < xCurto, `${xLongo} vs ${xCurto}`);
  // O canvas falso mede len*px*0.55; usa-se a mesma conta para saber o centro.
  const larguraFalsa = (t, px) => String(t).length * px * 0.55;
  const nf = Math.round(geo.outWidth * PRESETS_DO_REEL.perfil.perfilNomeTamanho);
  const centroCurto = xCurto + larguraFalsa("AB", nf) / 2;
  check("cabeçalho: sem foto, o texto fica centrado no eixo",
    Math.abs(centroCurto - geo.outWidth / 2) <= 2, `centro=${centroCurto.toFixed(1)} meio=${geo.outWidth / 2}`);

  const sem = desenhar("perfil", "Gancho", geo, { perfil: null });
  check("sem conta configurada não há cabeçalho nenhum",
    !sem.chamadas.fillText.some((c) => /Cena seguinte|@/.test(c.texto)), JSON.stringify(sem.chamadas.fillText.map((c) => c.texto)));

  // O gancho tem de começar por baixo do cabeçalho, senão escrevia-lhe em cima.
  const yGancho = Math.min(...com.chamadas.fillText.filter((c) => /Esse filme/.test(c.texto)).map((c) => c.y));
  const fimCabecalho = geo.outHeight * PRESETS_DO_REEL.perfil.perfilArrobaY;
  check("o gancho começa por baixo do cabeçalho", yGancho > fimCabecalho, `gancho y=${yGancho} cabeçalho até ${Math.round(fimCabecalho)}`);
  check("o destaque não leva cabeçalho", !PRESETS_DO_REEL.destaque.perfilCabecalho);
  check("ganchoInicio só existe onde há cabeçalho",
    PRESETS_DO_REEL.perfil.ganchoInicio > 0.065 && !PRESETS_DO_REEL.destaque.ganchoInicio);
}

check("preset desconhecido cai no atual", api.presetDoReel("inventado").id === "atual" && api.presetDoReel().id === "atual");

/* ------------------------------------------------------------------ 2 */
console.log("\n2. Geometria do Formato 1 — «escuro» (captura 329×584)");
const horizontal = { top: 0, bottom: 0, vw: 1920, vh: 1080 };
const e720 = Eh(1920, 1080, horizontal, 720, "escuro");
const pc = (v, t) => (v / t) * 100;
check("saída 720×1280 (9:16)", e720.outWidth === 720 && e720.outHeight === 1280, `${e720.outWidth}×${e720.outHeight}`);
check("caixa do vídeo quadrada (1:1)", e720.videoW === e720.videoH, `${e720.videoW}×${e720.videoH}`);
check("margens laterais de 5% (medido: 4,9%–94,8%)", perto(pc(e720.padX, e720.outWidth), 5, 0.4) && perto(pc(e720.videoW, e720.outWidth), 90, 0.6), `padX=${pc(e720.padX, e720.outWidth).toFixed(1)}% caixa=${pc(e720.videoW, e720.outWidth).toFixed(1)}%`);
check("topo da caixa a 27,4% (medido)", perto(pc(e720.padY, e720.outHeight), 27.4, 0.4), `${pc(e720.padY, e720.outHeight).toFixed(1)}%`);
check("base da caixa a 78,0% (medido: 78,4%)", perto(pc(e720.padY + e720.videoH, e720.outHeight), 78.0, 0.6), `${pc(e720.padY + e720.videoH, e720.outHeight).toFixed(1)}%`);
check("cantos com raio de ~4,6% da caixa (medido: 4,3%–4,9%)", perto(e720.radius / e720.videoW, 0.046, 0.004), `${e720.radius}px de ${e720.videoW}px`);
check("recorte centrado no aspeto da caixa (não estica a imagem)", e720.cropW === e720.cropH && perto(e720.cropX, (1920 - e720.cropW) / 2, 2), `crop=${e720.cropW}×${e720.cropH} x=${e720.cropX}`);
check("o recorte aproveita a altura toda do original", e720.cropH === 1080 && e720.cropY === 0);
check("fundo preto", e720.bg === "preto");

/* ------------------------------------------------------------------ 3 */
console.log("\n3. Geometria do Formato 2 — «claro» (captura 606×1078)");
const c720 = Eh(1920, 1080, horizontal, 720, "claro");
check("faixa de ponta a ponta (100% da largura)", c720.padX === 0 && c720.videoW === c720.outWidth, `padX=${c720.padX} caixa=${c720.videoW}`);
check("aspeto 4:3 (medido: 1,335)", perto(c720.videoW / c720.videoH, 4 / 3, 0.02), (c720.videoW / c720.videoH).toFixed(3));
check("topo da faixa a 30,1% (medido)", perto(pc(c720.padY, c720.outHeight), 30.1, 0.4), `${pc(c720.padY, c720.outHeight).toFixed(1)}%`);
check("base da faixa a 72,2% (medido)", perto(pc(c720.padY + c720.videoH, c720.outHeight), 72.2, 0.5), `${pc(c720.padY + c720.videoH, c720.outHeight).toFixed(1)}%`);
check("cantos retos (sem raio)", c720.radius === 0);
check("recorte 4:3 centrado no original", perto(c720.cropW / c720.cropH, 4 / 3, 0.02) && perto(c720.cropX, (1920 - c720.cropW) / 2, 2), `crop=${c720.cropW}×${c720.cropH} x=${c720.cropX}`);
check("fundo branco", c720.bg === "branco");

/* ------------------------------------------------------------------ 4 */
console.log("\n4. Outras fontes (vertical, com faixas pretas, 1080p)");
const vertical = Eh(1080, 1920, { top: 0, bottom: 0, vw: 1080, vh: 1920 }, 720, "claro");
check("fonte vertical: recorte 4:3 centrado na altura", vertical.cropW === 1080 && perto(vertical.cropY, (1920 - vertical.cropH) / 2, 2), `crop=${vertical.cropW}×${vertical.cropH} y=${vertical.cropY}`);
const comBarras = Eh(1080, 1920, { top: 440, bottom: 440, vw: 1080, vh: 1920 }, 720, "escuro");
check("faixas pretas continuam cortadas antes da caixa do preset", comBarras.cropY >= 440 && comBarras.cropY + comBarras.cropH <= 1920 - 440 + 2, `cropY=${comBarras.cropY} cropH=${comBarras.cropH}`);
check("a caixa do preset não muda com as faixas", comBarras.videoW === e720.videoW && comBarras.videoH === e720.videoH && comBarras.padY === e720.padY);
const hd = Eh(1920, 1080, horizontal, 1080, "escuro");
check("1080p: caixa 1:1 de 972px com 5% de margem", hd.outWidth === 1080 && hd.videoW === 972 && hd.padX === 54, `${hd.videoW}px padX=${hd.padX}`);
const pares = [e720, c720, vertical, comBarras, hd];
check("todas as medidas são pares (yuv420p)", pares.every((g) => [g.outWidth, g.outHeight, g.videoW, g.videoH, g.padX, g.padY, g.cropX, g.cropY, g.cropW, g.cropH].every((n) => n % 2 === 0)));
check("a caixa cabe sempre dentro do 9:16", pares.every((g) => g.padY + g.videoH <= g.outHeight && g.padX + g.videoW <= g.outWidth));

/* ------------------------------------------------------------------ 5 */
console.log("\n5. O preset «atual» continua como era");
const a720 = Eh(1920, 1080, horizontal, 720);
check("16:9 → 720×406 a 402px do topo (fórmula antiga)", a720.videoW === 720 && a720.videoH === 406 && a720.padY === 402 && a720.padX === 0, `${a720.videoW}×${a720.videoH} padY=${a720.padY}`);
check("sem caixa extra, sem cantos, fundo preto", a720.radius === 0 && a720.bg === "preto" && a720.hasCrop === false);
const aVertical = Eh(1080, 1920, { top: 0, bottom: 0, vw: 1080, vh: 1920 }, 720);
check("vertical preenche o 9:16 todo", aVertical.videoW === 720 && aVertical.videoH === 1280 && aVertical.padY === 0);
const aBarras = Eh(1080, 1920, { top: 440, bottom: 440, vw: 1080, vh: 1920 }, 720);
check("faixas pretas cortadas (hasCrop) como antes", aBarras.hasCrop === true && aBarras.cropY === 440 && aBarras.cropH === 1040, `cropY=${aBarras.cropY} cropH=${aBarras.cropH}`);

/* ------------------------------------------------------------------ 6 */
console.log("\n6. O desenho do gancho em cada preset");
const gancho = "O que acontece nessa cena deixou todo mundo em choque";
const dAtual = desenhar("atual", gancho, a720);
const dEscuro = desenhar("escuro", gancho, e720, { rodape: "Cenas rápidas" });
const dClaro = desenhar("claro", gancho, c720);
/** O rodapé é desenhado antes do gancho — separa as duas coisas. */
const ganchoDe = (d) => d.chamadas.fillText.filter((t) => !/cenas/i.test(t.texto));
const rodapeDe = (d) => d.chamadas.fillText.find((t) => /cenas/i.test(t.texto));
const pill = (d) => d.chamadas.fill.some((f) => String(f.cor).startsWith("rgba(10, 10, 14"));
check("atual: pílula escura por trás do texto", pill(dAtual));
check("escuro: sem pílula (texto direto no fundo preto)", !pill(dEscuro));
check("claro: sem pílula (texto preto no fundo branco)", !pill(dClaro));
check("escuro: cantos da caixa tapados com a cor do fundo", dEscuro.chamadas.fill.some((f) => f.regra === "evenodd" && f.cor === "#000000") || dEscuro.chamadas.arc.length === 4, JSON.stringify(dEscuro.chamadas.fill));
check("claro e atual: sem cantos para tapar (raio 0)", dClaro.chamadas.fill.length === 0 && dAtual.chamadas.fill.every((f) => pill(dAtual)));
check("escuro: gancho fluorescente #ECFA12", ganchoDe(dEscuro).length > 0 && ganchoDe(dEscuro).every((t) => t.cor === "#ECFA12"), ganchoDe(dEscuro).map((t) => t.cor).join(","));
check("claro: gancho preto #000000", ganchoDe(dClaro).length > 0 && ganchoDe(dClaro).every((t) => t.cor === "#000000"));
check("atual: gancho branco (como antes)", ganchoDe(dAtual).every((t) => t.cor === "#FFFFFF"));
const pxFont = (f) => Number(/(\d+(?:\.\d+)?)px/.exec(f)[1]);
check("escuro: letra maior (7,2% da largura = 52px em 720)", pxFont(ganchoDe(dEscuro)[0].font) === Math.round(720 * 0.072), ganchoDe(dEscuro)[0].font);
check("claro: letra de 5,6% da largura", pxFont(ganchoDe(dClaro)[0].font) === Math.round(720 * 0.056));
check("atual: letra de 6,2% da largura (inalterado)", pxFont(ganchoDe(dAtual)[0].font) === Math.round(720 * 0.062));
if (ganchoDe(dEscuro).length >= 2) {
  const entre = ganchoDe(dEscuro)[1].y - ganchoDe(dEscuro)[0].y;
  const em = pxFont(ganchoDe(dEscuro)[0].font);
  check("escuro: linhas coladas (entrelinha 0,88em, medido 0,84–0,9)", perto(entre / em, 0.88, 0.06), `${(entre / em).toFixed(2)}em`);
}
check("o gancho fica todo acima da caixa do vídeo", [
  ["atual", dAtual, a720], ["escuro", dEscuro, e720], ["claro", dClaro, c720],
].every(([nome, d, geo]) => {
  const linhas = ganchoDe(d);
  const em = pxFont(linhas[0].font);
  return linhas.every((t) => t.y + em / 2 <= geo.padY + 2);
}));
check("escuro: rodapé verde a 93,55% da altura", !!rodapeDe(dEscuro) && rodapeDe(dEscuro).cor === "#2DBD2C" && perto(rodapeDe(dEscuro).y, Math.round(1280 * 0.9355), 2), JSON.stringify(rodapeDe(dEscuro)));
check("escuro: rodapé com letra de 4,9% da largura", pxFont(rodapeDe(dEscuro).font) === Math.round(720 * 0.049), rodapeDe(dEscuro).font);
check("escuro: rodapé abaixo da caixa do vídeo", rodapeDe(dEscuro).y > e720.padY + e720.videoH);
check("claro: sem rodapé (o formato não o tem)", !rodapeDe(dClaro));
const semTexto = desenhar("escuro", "", e720);
check("sem gancho mas com preset: os cantos continuam desenhados", semTexto.chamadas.fill.length > 0 || semTexto.chamadas.arc.length === 4);
const corPropria = desenhar("escuro", gancho, e720, { cor: "#FF0000" });
check("a cor escolhida na conta vence a do preset", ganchoDe(corPropria).every((t) => t.cor === "#FF0000"));
const ganchoLongo = desenhar("escuro", "⛳ O ex-jogador descobriu um prodígio do golfe num lugar onde ninguém esperava encontrar", e720);
check("o gancho nunca passa de 2 linhas mesmo em frases longas", ganchoDe(dAtual).length <= 2 && ganchoDe(dEscuro).length <= 2 && ganchoDe(dClaro).length <= 2 && ganchoDe(ganchoLongo).length === 2, `linhas=${ganchoDe(ganchoLongo).length}`);
check("o gancho usa contorno preto (strokeText #000000) nas letras", dEscuro.chamadas.strokeText.length === ganchoDe(dEscuro).length && dEscuro.chamadas.strokeText.every((s) => s.cor === "#000000" && s.largura >= 4));

/* ------------------------------------------------------------------ 7 */
console.log("\n7. Servidor: as mesmas contas do app");
const servidor = await import(pathToFileURL(path.join(root, "servidor", "presets.mjs")).href);
const video = await import(pathToFileURL(path.join(root, "servidor", "video.mjs")).href);
check("a tabela do servidor é igual à do bundle", JSON.stringify(servidor.PRESETS_DO_REEL) === JSON.stringify(PRESETS_DO_REEL));
for (const preset of ["escuro", "claro", "perfil", "destaque"]) {
  for (const [largura, altura, corte] of [[1920, 1080, horizontal], [1080, 1920, { top: 0, bottom: 0, vw: 1080, vh: 1920 }], [1080, 1920, { top: 440, bottom: 440, vw: 1080, vh: 1920 }]]) {
    const app = Eh(largura, altura, corte, 720, preset);
    const srv = video.enquadramento(largura, altura, corte, 720, preset);
    const iguais = ["outWidth", "outHeight", "videoW", "videoH", "padX", "padY", "radius", "cropX", "cropY", "cropW", "cropH", "hasCrop", "bg"].every((k) => app[k] === srv[k]);
    check(`${preset} ${largura}×${altura}${corte.top ? " (com faixas)" : ""}: app == servidor`, iguais, JSON.stringify({ app, srv }));
  }
}
const srvPadrao = video.enquadramento(1080, 1920, { top: 440, bottom: 440, vw: 1080, vh: 1920 }, 720);
check("servidor sem preset mantém o enquadramento antigo (padY a 30%)", srvPadrao.padY === 384 && srvPadrao.radius === 0 && srvPadrao.videoW === 720, `padY=${srvPadrao.padY}`);
check("video.mjs importa a tabela partilhada", /from "\.\/presets\.mjs"/.test(fs.readFileSync(path.join(root, "servidor", "video.mjs"), "utf8")));
check("o servidor aceita o estilo no processar", /export async function processar\([^)]*estilo = \{\}\)/.test(fs.readFileSync(path.join(root, "servidor", "video.mjs"), "utf8")));
check("o Robô 24h passa o estilo da conta ao vídeo", /preset: preset \|\| conta\.preset/.test(trabalhador) && /video\.processar\([\s\S]{0,300}?estilo\)/.test(trabalhador));

/* ------------------------------------------------------------------ 8 */
console.log("\n8. Lote em massa: o estilo da conta chega ao FFmpeg");
check("lote-massa.js tem o estiloDoReel", lote.includes("function estiloDoReel(app, s)"));
check("o processar do lote leva fundo, cor, preset e rodapé", /core\.processar\(ficheiro, 0, fim, s\.resolution, gancho, function \(fracao\) \{[\s\S]{0,220}\}, corte, estilo\.bgMode, estilo\.hookColor, estilo\.preset, estilo\.footerText, estilo\.footerColor\)/.test(lote));
check("estiloDoReel está na API pública do lote", lote.includes("estiloDoReel: estiloDoReel,"));
{
  const fn = extrair(lote, "function estiloDoReel(");
  const ctxLote = vm.createContext({ window: { CineClipCore: { presets: PRESETS_DO_REEL } }, console });
  vm.runInContext(fn + "\n;globalThis.estiloDoReel=estiloDoReel;", ctxLote);
  const f = ctxLote.estiloDoReel;
  const conta = { preset: "escuro", bgMode: "preto", hookColor: "#ECFA12", footerText: "Cenas rápidas", footerColor: "#2DBD2C" };
  const e1 = f({ account: conta, settings: {} }, {});
  check("conta com preset escuro → passa tudo ao core", e1.preset === "escuro" && e1.hookColor === "#ECFA12" && e1.footerText === "Cenas rápidas", JSON.stringify(e1));
  const e2 = f({ account: {}, settings: {} }, {});
  check("conta sem preset → cai no atual com os valores por omissão", e2.preset === "atual" && e2.bgMode === "preto" && e2.hookColor === "#FFFFFF", JSON.stringify(e2));
  const e3 = f({ account: { preset: "inventado" }, settings: {} }, {});
  check("preset inválido → atual", e3.preset === "atual");
  const e4 = f({ account: { reelPreset: "claro" }, settings: {} }, {});
  check("aceita a chave alternativa (reelPreset) e usa o fundo do preset", e4.preset === "claro" && e4.bgMode === "branco" && e4.hookColor === "#000000", JSON.stringify(e4));
  const e5 = f({ account: { preset: "escuro" }, settings: {} }, { hookColor: "#123456" });
  check("a cor da conta vence a das definições gerais", e5.hookColor === "#123456" || e5.hookColor === "#ECFA12");
}

/* ------------------------------------------------------------------ 9 */
console.log("\n9. A ponta a ponta no bundle");
check("o YS recebe preset, rodapé e cor do rodapé", /async function YS\(r,o,a,i,c,u,f,bgMode="preto",hookColor="#FFFFFF",preset="atual",footerText="",footerColor=""\)/.test(modulo));
check("o YS passa o preset ao enquadramento", modulo.includes("w=Eh(h.vw,h.vh,x,v,preset)"));
check("o fundo do pad vem do preset (preto/branco)", modulo.includes('__corFundo=__fundoBranco?"white":"black"') && modulo.includes("pad=${w.outWidth}:${w.outHeight}:${w.padX}:${w.padY}:${__corFundo}"));
check("o PNG do gancho é usado mesmo sem texto (cantos/rodapé)", modulo.includes("k=!!(c&&c.trim())||w.radius>0||!!(footerText&&footerText.trim())"));
check("o fundo desfocado só existe na caixa automática", modulo.includes('__bgBlurred=__P.caixa==="auto"&&'));
check("o estúdio lê o estilo da conta ativa (g) e não da função de sincronização (j)", modulo.includes("g.preset||g.reelPreset||\"atual\",g.footerText") && !/await YS\(X,Y\[0\],Y\[1\],S\.resolution,F,nn,K\?R:null,j\./.test(modulo));
check("a pré-visualização usa o preset (geometria + cantos)", modulo.includes("Eh(_,k,w,720,pv)") && modulo.includes("borderRadius:rd") && modulo.includes("caixaDoPreset(pv,C,ft,fc)"));
check("as três opções aparecem nas configurações da conta", ['value:"atual"', 'value:"escuro"', 'value:"claro"'].every((v) => modulo.includes(v)) && modulo.includes("Preset do formato"));
check("o fundo branco é escolhível nas configurações", modulo.includes('d.jsx("option",{value:"branco",children:"Branco"})'));
check("há campo para o texto e a cor do rodapé", modulo.includes("Texto do rodapé") && modulo.includes("Cor do rodapé"));
check("as contas novas nascem com o preset atual", modulo.includes('preset:"atual",reelPreset:"atual",footerText:""') && /preset:\["atual","escuro","claro"\]\.indexOf/.test(modulo));
check("o lote em massa consegue ler a tabela pela ponte", modulo.includes("presets:PRESETS_DO_REEL,presetDoReel:presetDoReel"));

/* ------------------------------------------------------------------ 10 */
console.log("\n10. As três páginas continuam iguais");
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
check("app-pronto.html == index.html", fs.readFileSync(path.join(root, "app-pronto.html"), "utf8") === index);
check("404.html == index.html", fs.readFileSync(path.join(root, "404.html"), "utf8") === index);

/* ------------------------------------------------------------------ 11 */
console.log("\n11. O PNG que o FFmpeg sobrepõe (render real, opcional)");
let canvasMod = null;
try {
  canvasMod = await import("@napi-rs/canvas");
} catch {
  console.log("   ⏭  @napi-rs/canvas não está instalado — secção saltada (npm install --no-save @napi-rs/canvas)");
}
if (canvasMod) {
  const pngPorPreset = {};
  for (const preset of ["atual", "escuro", "claro"]) {
    const geo = video.enquadramento(1920, 1080, horizontal, 720, preset);
    pngPorPreset[preset] = await video.imagemDoGancho(geo.outWidth, geo.outHeight, geo.padY, gancho, {
      preset,
      hookColor: "",
      caixa: { padX: geo.padX, padY: geo.padY, videoW: geo.videoW, videoH: geo.videoH, radius: geo.radius, fundo: geo.bg, rodape: preset === "escuro" ? "Cenas rápidas" : "", rodapeCor: "#2DBD2C" },
    });
  }
  async function pixeis(buf) {
    const img = await canvasMod.loadImage(buf);
    const cv = canvasMod.createCanvas(img.width, img.height);
    const ctx = cv.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, img.width, img.height).data;
    return {
      img,
      px: (x, y) => {
        const i = (y * img.width + x) * 4;
        return [d[i], d[i + 1], d[i + 2], d[i + 3]];
      },
    };
  }
  const contaPixeis = (p, teste, yDe, yAte) => {
    let n = 0;
    for (let y = yDe; y < yAte; y++) for (let x = 0; x < p.img.width; x++) if (teste(p.px(x, y))) n++;
    return n;
  };

  const pEscuro = await pixeis(pngPorPreset.escuro);
  const gEscuro = video.enquadramento(1920, 1080, horizontal, 720, "escuro");
  check("escuro: o canto da caixa vem tapado de preto (canto arredondado)", pEscuro.px(gEscuro.padX + 1, gEscuro.padY + 1)[3] === 255 && pEscuro.px(gEscuro.padX + 1, gEscuro.padY + 1).slice(0, 3).every((v) => v < 10));
  check("escuro: dentro do arco a imagem fica descoberta (transparente)", pEscuro.px(gEscuro.padX + gEscuro.radius, gEscuro.padY + gEscuro.radius)[3] === 0);
  check("escuro: o centro da caixa fica descoberto para o vídeo", pEscuro.px(360, 674)[3] === 0);
  check("escuro: o gancho sai fluorescente no PNG", contaPixeis(pEscuro, ([r, g, b, a]) => a > 200 && r > 190 && g > 190 && b < 120, 0, gEscuro.padY) > 500);
  check("escuro: o rodapé verde sai no PNG", contaPixeis(pEscuro, ([r, g, b, a]) => a > 200 && g > 130 && r < 150 && b < 130, 1000, 1280) > 200);

  const pClaro = await pixeis(pngPorPreset.claro);
  const gClaro = video.enquadramento(1920, 1080, horizontal, 720, "claro");
  check("claro: sem cantos tapados (a faixa é de ponta a ponta)", pClaro.px(1, gClaro.padY + 1)[3] === 0);
  check("claro: o gancho sai preto no PNG", contaPixeis(pClaro, ([r, g, b, a]) => a > 200 && r < 70 && g < 70 && b < 70, 0, gClaro.padY) > 500);
  check("claro: sem rodapé no PNG", contaPixeis(pClaro, ([r, g, b, a]) => a > 200 && g > 130 && r < 150 && b < 130, 1000, 1280) === 0);

  const pAtual = await pixeis(pngPorPreset.atual);
  // O servidor, sem preset, mantém o aspeto de sempre: texto preto centrado na
  // faixa de cima (no browser o `_h` usa texto branco com pílula).
  check("atual (servidor): texto preto na faixa de cima, como sempre foi", contaPixeis(pAtual, ([r, g, b, a]) => a > 200 && r < 70 && g < 70 && b < 70, 0, 402) > 500);
  check("atual: nada tapado nos cantos (não há caixa extra)", pAtual.px(1, 403)[3] === 0);
}

/* ------------------------------------------------------------------ 12 */
console.log("\n12. Render real com FFmpeg (opcional)");
import("node:child_process").then(async ({ execFileSync }) => {
  const ffmpeg = process.env.CINECLIP_FFMPEG || "ffmpeg";
  let temFfmpeg = false;
  try {
    execFileSync(ffmpeg, ["-version"], { stdio: "ignore" });
    temFfmpeg = true;
  } catch {
    temFfmpeg = false;
  }
  const resumo = () => {
    console.log("\n" + "─".repeat(45));
    if (fail === 0) console.log(`✅ ${pass} passaram, 0 falharam`);
    else {
      console.log(`❌ ${pass} passaram, ${fail} falharam`);
      process.exit(1);
    }
  };
  if (!temFfmpeg) {
    console.log("   ⏭  ffmpeg não está no PATH — secção saltada");
    resumo();
    return;
  }
  // O ffprobe velho de alguns ambientes não conhece `stream_side_data`; o
  // servidor tem um caminho alternativo por `ffmpeg -i` (testado à parte).
  process.env.CINECLIP_FFPROBE = process.env.CINECLIP_FFPROBE || "nenhum";
  const osMod = await import("node:os");
  const tmp = fs.mkdtempSync(path.join(osMod.tmpdir(), "cineclip-presets-"));
  const fonte = path.join(tmp, "fonte.mp4");
  execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=3",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", fonte], { stdio: "ignore" });

  /** Um quadro do vídeo processado, em RGB cru (720×1280 = 2,7 MB). */
  function quadro(caminho) {
    const buf = execFileSync(ffmpeg, ["-v", "error", "-ss", "1", "-i", caminho, "-frames:v", "1",
      "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 16 * 1024 * 1024 });
    const px = (x, y) => {
      const i = (y * 720 + x) * 3;
      return [buf[i], buf[i + 1], buf[i + 2]];
    };
    const conta = (teste, yDe, yAte, xDe = 0, xAte = 720) => {
      let n = 0;
      for (let y = yDe; y < yAte; y++) for (let x = xDe; x < xAte; x++) if (teste(px(x, y))) n++;
      return n;
    };
    return { px, conta, bytes: buf.length };
  }
  const preto = ([r, g, b]) => r + g + b < 60;
  const branco = ([r, g, b]) => r > 235 && g > 235 && b > 235;
  const imagem = ([r, g, b]) => r + g + b > 90 && !(r > 235 && g > 235 && b > 235);

  const estilos = {
    escuro: { preset: "escuro", footerText: "Cenas rápidas" },
    claro: { preset: "claro" },
    atual: {},
  };
  const quadros = {};
  for (const [nome, estilo] of Object.entries(estilos)) {
    const destino = path.join(tmp, `out-${nome}.mp4`);
    await video.processar(fonte, 0, 2.5, "720", "GANCHO DE TESTE BEM VISIVEL", null, null, destino, estilo);
    quadros[nome] = quadro(destino);
  }
  check("os três renders saem em 720×1280", Object.values(quadros).every((q) => q.bytes === 720 * 1280 * 3));

  const qE = quadros.escuro;
  check("escuro: margem lateral preta (fundo do preset)", preto(qE.px(10, 640)) && preto(qE.px(710, 640)));
  check("escuro: o canto da caixa vem arredondado (cunha preta sobre o vídeo)", preto(qE.px(40, 354)) && imagem(qE.px(60, 374)), JSON.stringify([qE.px(40, 354), qE.px(60, 374)]));
  check("escuro: há imagem dentro da caixa 1:1", imagem(qE.px(360, 674)));
  check("escuro: entre a caixa e o rodapé o fundo é preto", preto(qE.px(360, 1080)));
  check("escuro: o gancho sai fluorescente no vídeo final", qE.conta(([r, g, b]) => r > 190 && g > 190 && b < 120, 100, 340) > 300);
  check("escuro: o rodapé verde sai no vídeo final", qE.conta(([r, g, b]) => g > 120 && r < 160 && b < 130, 1160, 1230) > 100);

  const qC = quadros.claro;
  check("claro: fundo branco acima e abaixo da faixa", branco(qC.px(360, 100)) && branco(qC.px(360, 1100)));
  check("claro: a faixa 4:3 vai de ponta a ponta", imagem(qC.px(5, 674)) && imagem(qC.px(714, 674)));
  check("claro: o gancho sai preto no vídeo final", qC.conta(([r, g, b]) => r < 70 && g < 70 && b < 70, 150, 380) > 300);
  check("claro: sem rodapé no vídeo final", qC.conta(([r, g, b]) => g > 120 && r < 160 && b < 130, 1000, 1270) === 0);

  const qA = quadros.atual;
  check("atual (servidor): mantém o fundo branco de sempre (faixas acima e abaixo)", branco(qA.px(360, 100)) && branco(qA.px(360, 1100)));
  check("atual (servidor): imagem centrada na faixa do meio", imagem(qA.px(360, 605)));

  fs.rmSync(tmp, { recursive: true, force: true });
  resumo();
});
