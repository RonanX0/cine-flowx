#!/usr/bin/env node
/**
 * Gera um Reel de amostra (720×1280) para cada preset, usando o código REAL do
 * servidor (`enquadramento` + `imagemDoGancho`) e o vídeo das capturas
 * formato-1.png / formato-2.png — assim dá para comparar a amostra com o
 * original lado a lado e confirmar que a geometria é a mesma.
 *
 *   npm install --no-save @napi-rs/canvas
 *   node tools/gerar-amostra-presets.mjs
 *
 * Os PNGs gerados (tools/amostra-preset-*.png) são artefactos locais e estão no
 * .gitignore; o que interessa versionar são as contas (servidor/presets.mjs) e
 * as capturas que lhes deram origem.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let canvas;
try {
  canvas = await import("@napi-rs/canvas");
} catch {
  console.error("⚠️  Falta o @napi-rs/canvas — corre: npm install --no-save @napi-rs/canvas");
  process.exit(1);
}
const { enquadramento, imagemDoGancho } = await import(path.join(raiz, "servidor", "video.mjs"));

/** Recorte (x, y, largura, altura) da zona de vídeo dentro de cada captura original. */
const FONTES = {
  escuro: { foto: "formato-1.png", corte: [16, 160, 297, 298], gancho: "🔥 O QUE ACONTECE NESSA CENA DEIXOU TODO MUNDO EM CHOQUE", rodape: "Cenas rápidas" },
  claro: { foto: "formato-2.png", corte: [0, 325, 606, 452], gancho: "ELE QUEBROU A ÚNICA REGRA QUE NUNCA DEVERIA QUEBRAR", rodape: "" },
};

/** Caminho de recorte com cantos arredondados (o canvas não tem roundRect fiável). */
function caixaArredondada(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
  ctx.lineTo(x + w, y + h - r);
  ctx.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
  ctx.lineTo(x + r, y + h);
  ctx.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
  ctx.lineTo(x, y + r);
  ctx.arc(x + r, y + r, r, Math.PI, -Math.PI / 2);
  ctx.closePath();
}

async function gerar(preset) {
  const f = FONTES[preset];
  const geo = enquadramento(1920, 1080, { top: 0, bottom: 0, vw: 1920, vh: 1080 }, 720, preset);
  const tela = canvas.createCanvas(geo.outWidth, geo.outHeight);
  const ctx = tela.getContext("2d");
  ctx.fillStyle = geo.bg === "branco" ? "#FFFFFF" : "#000000";
  ctx.fillRect(0, 0, geo.outWidth, geo.outHeight);
  const foto = await canvas.loadImage(fs.readFileSync(path.join(raiz, f.foto)));
  ctx.save();
  if (geo.radius > 0) {
    caixaArredondada(ctx, geo.padX, geo.padY, geo.videoW, geo.videoH, geo.radius);
    ctx.clip();
  }
  ctx.drawImage(foto, f.corte[0], f.corte[1], f.corte[2], f.corte[3], geo.padX, geo.padY, geo.videoW, geo.videoH);
  ctx.restore();
  const png = await imagemDoGancho(geo.outWidth, geo.outHeight, geo.padY, f.gancho, {
    preset,
    hookColor: "",
    caixa: { padX: geo.padX, padY: geo.padY, videoW: geo.videoW, videoH: geo.videoH, radius: geo.radius, fundo: geo.bg, rodape: f.rodape, rodapeCor: "#2DBD2C" },
  });
  ctx.drawImage(await canvas.loadImage(png), 0, 0);
  const destino = path.join(raiz, "tools", `amostra-preset-${preset}.png`);
  fs.writeFileSync(destino, tela.toBuffer("image/png"));
  console.log(`✔ ${destino} (${geo.outWidth}×${geo.outHeight}, caixa ${geo.videoW}×${geo.videoH} em x=${geo.padX} y=${geo.padY}, raio ${geo.radius}px)`);
}

await gerar("escuro");
await gerar("claro");
console.log("\nCompara com formato-1.png e formato-2.png: a geometria é a mesma, medida pixel a pixel.");
