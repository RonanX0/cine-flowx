/**
 * As partes do processamento que no navegador usam <video>, <canvas>, Web Audio
 * e o FFmpeg em WebAssembly — aqui com o FFmpeg nativo. Cada função devolve
 * exatamente o que a equivalente do app devolve, para o resto do fluxo (IA,
 * TMDB, lote) correr com o código do próprio app.
 *
 *   app (index.html)      servidor
 *   ───────────────────   ─────────────────────
 *   bi / _w  (barras)  →  detetarBarras
 *   Nc       (quadros) →  quadros
 *   Cc       (áudio)   →  audio
 *   Eh + _h + YS       →  processar
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { presetDoReel, alvoDaCaixa } from "./presets.mjs";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
// Lidos na hora (não no import): na Vercel o FFmpeg vem do pacote ffmpeg-static e o
// caminho só se conhece depois de carregar o módulo.
const ffmpeg = () => process.env.CINECLIP_FFMPEG || "ffmpeg";
const ffprobe = () => process.env.CINECLIP_FFPROBE || "ffprobe";

/** Corre um comando e devolve stdout (Buffer). `aoLog` recebe o stderr linha a linha. */
export function correr(cmd, args, { aoLog, entrada } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    const partes = [];
    let erro = "";
    p.stdout.on("data", (d) => partes.push(d));
    p.stderr.on("data", (d) => {
      const t = d.toString();
      erro = (erro + t).slice(-4000);
      if (aoLog) aoLog(t);
    });
    p.on("error", reject);
    p.on("close", (codigo) => {
      if (codigo === 0) resolve(Buffer.concat(partes));
      else reject(new Error(`${path.basename(cmd)} terminou com código ${codigo}: ${erro.split("\n").filter(Boolean).slice(-3).join(" | ")}`));
    });
    if (entrada) p.stdin.end(entrada);
    else p.stdin.end();
  });
}

export async function pastaTemporaria(prefixo = "cineclip-") {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), prefixo));
}

/* -------------------------------------------------------------- leitura */

/** Largura, altura (já com a rotação aplicada), duração e se há áudio. */
export async function sondar(caminho) {
  let saida;
  try {
    if (process.env.CINECLIP_FFPROBE === "nenhum") throw Object.assign(new Error("sem ffprobe"), { code: "ENOENT" });
    saida = await correr(ffprobe(), ["-v", "error", "-show_entries",
    "stream=codec_type,codec_name,width,height:stream_side_data=rotation:stream_tags=rotate:format=duration",
    "-of", "json", caminho]);
  } catch (e) {
    // Sem ffprobe (ex.: Vercel, só com o ffmpeg-static): lê o mesmo do "ffmpeg -i".
    if (e && e.code === "ENOENT") return sondarComFfmpeg(caminho);
    throw e;
  }
  const j = JSON.parse(saida.toString());
  const v = (j.streams || []).find((s) => s.codec_type === "video") || {};
  const a = (j.streams || []).find((s) => s.codec_type === "audio");
  let largura = Number(v.width) || 0;
  let altura = Number(v.height) || 0;
  const rot = Math.abs(Number((v.side_data_list || []).find((d) => d.rotation != null)?.rotation ?? v.tags?.rotate ?? 0)) % 180;
  if (rot === 90) [largura, altura] = [altura, largura];
  return { largura, altura, duracao: Number(j.format && j.format.duration) || 0, temAudio: !!a, codec: v.codec_name || "" };
}

/** O mesmo que `sondar`, a partir do relatório do "ffmpeg -i" (quando não há ffprobe). */
export function lerRelatorioFfmpeg(texto) {
  const t = String(texto || "");
  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(t);
  const linhaVideo = (t.split("\n").find((l) => /Stream #\S+.*: Video:/.test(l)) || "");
  const codec = (/: Video:\s*([\w-]+)/.exec(linhaVideo) || [])[1] || "";
  const dim = /,\s*(\d{2,5})x(\d{2,5})(?=[\s,\[]|$)/.exec(linhaVideo);
  let largura = dim ? Number(dim[1]) : 0;
  let altura = dim ? Number(dim[2]) : 0;
  const rot = /displaymatrix:\s*rotation of\s*(-?[\d.]+)\s*degrees/i.exec(t) || /\brotate\s*:\s*(-?\d+)/i.exec(t);
  if (rot && Math.abs(Math.round(Number(rot[1]))) % 180 === 90) [largura, altura] = [altura, largura];
  return {
    largura,
    altura,
    duracao: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0,
    temAudio: /Stream #\S+.*: Audio:/.test(t),
    codec,
  };
}

function sondarComFfmpeg(caminho) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg(), ["-hide_banner", "-i", caminho], { stdio: ["ignore", "ignore", "pipe"] });
    let texto = "";
    p.stderr.on("data", (d) => {
      texto += d.toString();
    });
    p.on("error", reject);
    p.on("close", () => {
      const info = lerRelatorioFfmpeg(texto);
      if (!info.largura || !info.altura) {
        reject(new Error("Não consegui ler o vídeo: " + texto.split("\n").filter(Boolean).slice(-2).join(" | ")));
      } else resolve(info);
    });
  });
}

/** Um quadro em RGB cru, à escala pedida. */
async function quadroRGB(caminho, t, largura, altura) {
  return correr(ffmpeg(), ["-v", "error", "-ss", t.toFixed(3), "-i", caminho, "-frames:v", "1",
    "-vf", `scale=${largura}:${altura}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
}

/* -------------------------------------------------------- faixas pretas */

/**
 * Maior faixa de imagem de um quadro — mesmo critério do `_w` do app.
 *
 * Conta como "faixa" (a tirar) tanto o letterbox preto como uma banda BRANCA
 * uniforme: muitos cortes vêm de reels já formatados, com uma área branca em
 * cima para o gancho, e sem isto essa área entrava na caixa e afastava o vídeo
 * do texto. O limiar do branco é propositadamente severo (97% das amostras
 * acima de 248) para não comer uma cena genuinamente clara.
 */
export function faixaClara(rgb, largura, altura) {
  const escura = [];
  for (let y = 0; y < altura; y++) {
    let n = 0;
    let brancas = 0;
    for (let x = 0; x < largura; x++) {
      const k = (y * largura + x) * 3;
      const L = 0.299 * rgb[k] + 0.587 * rgb[k + 1] + 0.114 * rgb[k + 2];
      if (L < 40) n++;
      if (L > 248) brancas++;
    }
    escura.push(n / largura >= 0.65 || brancas / largura >= 0.97);
  }
  let melhor = [0, -1];
  let ini = -1;
  for (let y = 0; y <= altura; y++) {
    if (y < altura && !escura[y]) {
      if (ini < 0) ini = y;
    } else if (ini >= 0) {
      const fim = y - 1;
      if (fim - ini > melhor[1] - melhor[0]) melhor = [ini, fim];
      ini = -1;
    }
  }
  return melhor[1] - melhor[0] < altura * 0.3 ? null : { t: melhor[0], b: melhor[1] };
}

/**
 * Faixas pretas (letterbox): igual ao `bi` do app com o patch 29 — 12 quadros,
 * a imagem vai do topo mais alto ao fundo mais baixo vistos em qualquer quadro.
 * Devolve {y, h, vh, vw} ou null (sem faixas).
 */
export async function detetarBarras(caminho, inicio = 0, fim) {
  const info = await sondar(caminho);
  const u = info.largura;
  const f = info.altura;
  if (!u || !f) return null;
  const p = Math.min(1, 640 / u);
  const g = Math.max(1, Math.round(u * p));
  const v = Math.max(1, Math.round(f * p));
  const w = Math.min(fim ?? info.duracao, info.duracao || 0) || 1;
  const topos = [];
  const fundos = [];
  for (const j of [0.06, 0.14, 0.22, 0.3, 0.38, 0.46, 0.54, 0.62, 0.7, 0.78, 0.86, 0.94]) {
    const t = Math.max(0, Math.min(inicio + (w - inicio) * j, Math.max(0, info.duracao - 0.05)));
    let rgb;
    try {
      rgb = await quadroRGB(caminho, t, g, v);
    } catch {
      continue;
    }
    if (rgb.length < g * v * 3) continue;
    const r = faixaClara(rgb, g, v);
    if (r) {
      topos.push(r.t);
      fundos.push(r.b);
    }
  }
  if (!topos.length) return null;
  const S = Math.min(...topos);
  const T = Math.max(...fundos);
  let D = Math.round(S / p / 2) * 2;
  let O = Math.round((T < v - 1 ? T + 1 : v) / p / 2) * 2;
  D = Math.max(0, D);
  O = Math.min(f - (f % 2), O);
  return O - D < f * 0.3 || (D < 4 && f - O < 4) ? null : { y: D, h: O - D, vh: f, vw: u };
}

/* ------------------------------------------------------------- quadros */

const dataUrl = (buf) => "data:image/jpeg;base64," + buf.toString("base64");

/**
 * Quadros para a IA — o mesmo formato do `Nc` do app: [mosaico 2×3, ...6 quadros].
 * `corte` = {top, bottom} em píxeis do vídeo original (as faixas pretas a tirar).
 */
export async function quadros(caminho, inicio, fim, corte) {
  const info = await sondar(caminho);
  const f = info.largura || 1280;
  const alturaTotal = info.altura || 720;
  const topo = corte ? Math.max(0, Math.round(corte.top || 0)) : 0;
  const baixo = corte ? Math.max(0, Math.round(corte.bottom || 0)) : 0;
  const x = Math.max(32, alturaTotal - topo - baixo);
  const ladoTile = 560;
  const k = Math.max(180, Math.min(360, Math.round((ladoTile * x) / f)));
  const T = Math.min(860, f);
  const D = Math.max(200, Math.round((T * x) / f));
  const V = info.duracao || fim || 1;
  const te = Math.min(V, fim || V);
  const se = Math.max(0.5, te - inicio);
  const pasta = await pastaTemporaria();
  try {
    const soltos = [];
    let i = 0;
    for (const pos of [0.08, 0.24, 0.41, 0.58, 0.75, 0.91]) {
      const t = Math.min(V - 0.05, Math.max(0, inicio + se * pos));
      const destino = path.join(pasta, `q${++i}.jpg`);
      await correr(ffmpeg(), ["-v", "error", "-y", "-ss", t.toFixed(3), "-i", caminho, "-frames:v", "1",
        "-vf", `crop=iw:${x}:0:${topo},scale=${T}:${D},setsar=1`, "-q:v", "3", destino]);
      soltos.push(destino);
    }
    const mosaico = path.join(pasta, "mosaico.jpg");
    await correr(ffmpeg(), ["-v", "error", "-y", "-framerate", "1", "-i", path.join(pasta, "q%d.jpg"),
      "-vf", `scale=${ladoTile}:${k},setsar=1,tile=2x3`, "-frames:v", "1", "-q:v", "3", mosaico]);
    const lista = [dataUrl(await fs.promises.readFile(mosaico))];
    for (const s of soltos) lista.push(dataUrl(await fs.promises.readFile(s)));
    return lista;
  } finally {
    fs.promises.rm(pasta, { recursive: true, force: true }).catch(() => {});
  }
}

/* --------------------------------------------------------------- áudio */

/**
 * Áudio para a IA (Gemini) — igual ao `Cc`: mono, 12 kHz, até 45 s, WAV em
 * base64; null se o vídeo for mudo ou o ficheiro tiver mais de 80 MB.
 */
export async function audio(caminho, inicio = 0, fim = 45) {
  const stat = await fs.promises.stat(caminho);
  if (stat.size > 80 * 1024 * 1024) return null;
  const info = await sondar(caminho);
  if (!info.temAudio) return null;
  const p = Math.max(0, Math.min(inicio, info.duracao - 0.5));
  const g = Math.max(1, Math.min(45, (fim || info.duracao) - p));
  let wav;
  try {
    wav = await correr(ffmpeg(), ["-v", "error", "-ss", p.toFixed(2), "-t", g.toFixed(2), "-i", caminho,
      "-vn", "-ac", "1", "-ar", "12000", "-c:a", "pcm_s16le", "-f", "wav", "-"]);
  } catch {
    return null;
  }
  let pico = 0;
  for (let i = 44; i + 1 < wav.length; i += 128) {
    const amostra = Math.abs(wav.readInt16LE(i)) / 32768;
    if (amostra > pico) pico = amostra;
  }
  return pico < 0.002 ? null : { mimeType: "audio/wav", base64: wav.toString("base64") };
}

/* ------------------------------------------------- vídeo para a IA */

/**
 * Vídeo para o Gemini "assistir" (File API) — recorta [inicio, fim] (ou os
 * primeiros 90 s) com stream copy (sem re-encode, com áudio) para o Gemini
 * analisar a cena em movimento em vez de frames soltos. Devolve
 * { data, mimeType, ini, fim } para `core.identificar`/`core.gerarGancho`
 * (o `video` do bundle faz o upload); null se não for possível.
 */
export async function videoParaIA(caminho, inicio = 0, fim = 0) {
  try {
    const info = await sondar(caminho);
    const ini = Math.max(0, Number(inicio) || 0);
    const pedida = Number(fim) > ini ? Number(fim) - ini : 0;
    const dur = pedida || Math.min(90, Math.max(1, info.duracao - ini));
    const pasta = await pastaTemporaria("cineclip-ia-");
    try {
      const destino = path.join(pasta, "cena.mp4");
      const args = ["-v", "error", "-y"];
      if (ini > 0) args.push("-ss", ini.toFixed(3));
      if (dur > 0) args.push("-t", dur.toFixed(3));
      args.push("-i", caminho, "-map", "0:v:0", "-map", "0:a?", "-c", "copy",
        "-movflags", "+faststart", "-f", "mp4", destino);
      await correr(ffmpeg(), args);
      const bytes = await fs.promises.readFile(destino);
      return bytes.length ? { data: bytes, mimeType: "video/mp4", ini: 0, fim: dur } : null;
    } finally {
      fs.promises.rm(pasta, { recursive: true, force: true }).catch(() => {});
    }
  } catch {
    return null;
  }
}

/* ------------------------------------------------- imagem do gancho */

/** Enquadramento 9:16 — cópia do `Eh` do app (inclui a caixa fixa dos presets). */
export function enquadramento(r, o, corte, i = 720, preset = "atual") {
  const c = Math.max(2, r - (r % 2));
  const u = Math.max(2, o - (o % 2));
  const f = Math.round((i * 16) / 9);
  const p = corte ? Math.max(0, corte.top) : 0;
  const g = corte ? Math.max(0, corte.bottom) : 0;
  const v = Math.min(u - 2, Math.max(0, Math.round(p / 2) * 2));
  const x = Math.max(0, Math.round(g / 2) * 2);
  const h = Math.max(2, Math.min(u - v, Math.floor((u - v - x) / 2) * 2));
  const w = c;
  const temCorte = v > 0 || x > 0;
  const P = presetDoReel(preset);
  const A = alvoDaCaixa(P);

  /* Caixa maleável ("livre"): em vez de uma proporção fixa, a caixa segue o
     aspeto do próprio vídeo e é encaixada na faixa que sobra entre o gancho
     (acima de `topo`) e o rodapé (abaixo de `caixaFim`). Não há recorte para
     a forçar a um formato — por isso um 16:9 fica largo e baixo, e um vertical
     ocupa a faixa toda em altura. */
  if (P.caixa === "livre") {
    const ty = Math.max(0, Math.round((f * P.topo) / 2) * 2);
    const fy = Math.min(f, Math.round((f * (P.caixaFim || 0.95)) / 2) * 2);
    const dh = Math.max(2, fy - ty);
    // A largura é sempre a largura toda do 9:16: o vídeo vai de ponta a ponta.
    const S = Math.max(2, Math.round((i * (1 - 2 * P.margem)) / 2) * 2);
    let T = Math.max(2, Math.round((S * h) / w / 2) * 2);
    let cy = v;
    let cw = w;
    let ch = h;
    // Alto de mais para o espaço entre o gancho e o rodapé: corta na vertical
    // (centrado) em vez de encolher a largura — a imagem nunca é esticada.
    if (T > dh) {
      T = Math.max(2, Math.round(dh / 2) * 2);
      const nh = Math.max(2, Math.min(ch, Math.round((cw * T) / S / 2) * 2));
      cy += Math.max(0, Math.round((ch - nh) / 2 / 2) * 2);
      ch = nh;
    }
    const D = Math.max(0, Math.round((i - S) / 2 / 2) * 2);
    const k = Math.max(0, Math.min(f - T, ty + Math.round((dh - T) / 2 / 2) * 2));
    return {
      outWidth: i, outHeight: f, vw: c, vh: u, hasCrop: cy > 0 || ch < u || cw < c,
      cropX: 0, cropY: cy, cropW: cw, cropH: ch,
      videoW: S, videoH: T, padX: D, padY: k,
      radius: Math.max(0, Math.round(S * P.raio)), bg: P.fundo, preset: P.id,
    };
  }

  if (A > 0) {
    // Caixa fixa do preset: 1:1 com margens laterais (escuro) ou faixa 4:3 de
    // ponta a ponta (claro). O recorte é centrado e tem o mesmo aspeto da caixa,
    // para o `scale` não esticar a imagem.
    let S = Math.max(2, Math.round((i * (1 - 2 * P.margem)) / 2) * 2);
    let T = Math.max(2, Math.round(S / A / 2) * 2);
    if (T > f - 2) {
      T = Math.max(2, Math.round((f - 2) / 2) * 2);
      S = Math.min(i, Math.max(2, Math.round((T * A) / 2) * 2));
    }
    const D = Math.max(0, Math.round((i - S) / 2 / 2) * 2);
    const k = Math.max(0, Math.min(f - T - 2, Math.round((f * P.topo) / 2) * 2));
    let cropW = w;
    let cropH = h;
    let cropX = 0;
    let cropY = v;
    const fa = cropW / cropH;
    if (fa > A) {
      const nw = Math.max(2, Math.min(cropW, Math.round((cropH * A) / 2) * 2));
      cropX += Math.max(0, Math.round((cropW - nw) / 2 / 2) * 2);
      cropW = nw;
    } else if (fa < A) {
      const nh = Math.max(2, Math.min(cropH, Math.round(cropW / A / 2) * 2));
      cropY += Math.max(0, Math.round((cropH - nh) / 2 / 2) * 2);
      cropH = nh;
    }
    return {
      outWidth: i, outHeight: f, vw: c, vh: u,
      hasCrop: cropX > 0 || cropY > 0 || cropW < c || cropH < u,
      cropX, cropY, cropW, cropH, videoW: S, videoH: T, padX: D, padY: k,
      radius: Math.max(0, Math.round(S * P.raio)), bg: P.fundo, preset: P.id,
    };
  }
  const k = Math.round((f * 0.3) / 2) * 2;
  const C = f - k;
  let S = i;
  let T = Math.max(2, Math.round((i * h) / w / 2) * 2);
  let D = 0;
  if (T > C) {
    T = Math.floor(C / 2) * 2;
    S = Math.max(2, Math.floor((T * w) / h / 2) * 2);
    D = Math.floor((i - S) / 4) * 2;
  }
  return { outWidth: i, outHeight: f, vw: c, vh: u, hasCrop: temCorte, cropX: 0, cropY: v, cropW: w, cropH: h, videoW: S, videoH: T, padX: D, padY: k, radius: 0, bg: P.fundo, preset: P.id };
}

let fontesProntas = null;

async function canvasComFontes() {
  const mod = await import("@napi-rs/canvas");
  if (!fontesProntas) {
    const candidatos = [
      process.env.CINECLIP_FONTE_INTER,
      "/usr/share/fonts/opentype/inter/Inter-ExtraBold.otf",
      "/usr/share/fonts/truetype/inter/Inter-ExtraBold.ttf",
      "/usr/share/fonts/opentype/inter/Inter-Bold.otf",
      path.join(AQUI, "fontes", "Inter-ExtraBold.ttf"), // as que vão no repositório (Vercel)
    ].filter(Boolean);
    const emoji = [
      process.env.CINECLIP_FONTE_EMOJI,
      "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",
      path.join(AQUI, "fontes", "NotoColorEmoji.ttf"),
    ].filter(Boolean);
    fontesProntas = { inter: false, emoji: false };
    for (const c of candidatos) {
      if (fs.existsSync(c) && mod.GlobalFonts.registerFromPath(c, "Inter")) {
        fontesProntas.inter = true;
        break;
      }
    }
    for (const c of emoji) {
      if (fs.existsSync(c) && mod.GlobalFonts.registerFromPath(c, "Noto Color Emoji")) {
        fontesProntas.emoji = true;
        break;
      }
    }
  }
  return mod;
}

export async function fontesDisponiveis() {
  await canvasComFontes();
  return { ...fontesProntas };
}

/**
 * PNG do gancho por cima do vídeo — cópia do `_h` do app.
 *
 * Sem preset (o padrão do servidor) mantém o aspeto de sempre: texto preto,
 * centrado na faixa de cima. Com um preset ("escuro"/"claro") usa a tipografia,
 * a cor e a geometria medidas das capturas: tapa os cantos da caixa do vídeo com
 * a cor do fundo (cantos arredondados) e desenha o rodapé.
 */
export async function imagemDoGancho(largura, altura, padY, texto, estilo = {}) {
  const canvasMod = await canvasComFontes();
  const { createCanvas, loadImage } = canvasMod;
  const canvas = createCanvas(largura, altura);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, largura, altura);
  const P = presetDoReel(estilo.preset);
  const comPreset = P.caixa !== "auto";
  const caixa = estilo.caixa || null;

  /* Cantos arredondados: o retângulo da caixa menos o retângulo arredondado,
     preenchido com a cor do fundo (o PNG vai por cima do vídeo no ffmpeg). */
  if (comPreset && caixa && caixa.radius > 0 && caixa.videoW > 0 && caixa.videoH > 0) {
    const R = Math.max(1, Math.min(caixa.radius, caixa.videoW / 2, caixa.videoH / 2));
    const X0 = Math.round(caixa.padX || 0);
    const Y0 = Math.round(caixa.padY || 0);
    const X1 = X0 + caixa.videoW;
    const Y1 = Y0 + caixa.videoH;
    ctx.save();
    ctx.fillStyle = caixa.fundo === "branco" ? "#FFFFFF" : "#000000";
    const arcos = [
      [X0, Y0, X0 + R, Y0 + R, -Math.PI / 2, Math.PI, true],
      [X1, Y0, X1 - R, Y0 + R, -Math.PI / 2, 0, false],
      [X0, Y1, X0 + R, Y1 - R, Math.PI, Math.PI / 2, true],
      [X1, Y1, X1 - R, Y1 - R, Math.PI / 2, 0, true],
    ];
    ctx.beginPath();
    for (const [px, py, ax, ay, inicio, fim, ccw] of arcos) {
      ctx.moveTo(px, py);
      ctx.arc(ax, ay, R, inicio, fim, ccw);
      ctx.closePath();
    }
    ctx.fill();
    ctx.restore();
  }

  /* Cabeçalho tipo post: foto redonda, nome, selo azul e @ da conta ativa.
     O conteúdo vem da conta e a geometria do preset; campo vazio não aparece.
     Aqui o avatar pode ser carregado com `await` — no app o desenho é síncrono
     e usa a imagem que o motor guardou em cache. */
  const perfil = (caixa && caixa.perfil) || estilo.perfil || null;
  if (comPreset && P.perfilCabecalho && perfil && (perfil.nome || perfil.avatar)) {
    const ar = Math.round(largura * P.perfilAvatarR);
    const ay = Math.round(altura * P.perfilY);
    const nf = Math.round(largura * P.perfilNomeTamanho);
    const af = Math.round(largura * P.perfilArrobaTamanho);
    const gp = Math.round(largura * (P.perfilEspaco || 0.028));
    const br = Math.round(nf * 0.36);
    const arroba = perfil.arroba ? String(perfil.arroba).replace(/^@?/, "@") : "";

    let img = null;
    if (perfil.avatar) {
      try { img = await loadImage(perfil.avatar); } catch (_) { img = null; }
    }
    const temFoto = !!img;

    /* Mede antes de desenhar: o bloco inteiro (foto + nome/@) vai centrado, e
       a largura dele depende do nome, do selo e do @. */
    ctx.save();
    ctx.font = `700 ${nf}px Inter, "Noto Color Emoji", "Helvetica Neue", Arial, sans-serif`;
    const wn = perfil.nome ? ctx.measureText(perfil.nome).width : 0;
    const wb = perfil.nome && perfil.verificado !== false ? Math.round(nf * 0.3) + br * 2 : 0;
    ctx.font = `500 ${af}px Inter, "Noto Color Emoji", "Helvetica Neue", Arial, sans-serif`;
    const wa = arroba ? ctx.measureText(arroba).width : 0;
    ctx.restore();

    const wt = Math.max(wn + wb, wa);
    const bloco = (temFoto ? ar * 2 + gp : 0) + wt;
    const x0 = Math.round((largura - bloco) / 2);
    const ax = x0 + ar;
    const tx = x0 + (temFoto ? ar * 2 + gp : 0);

    if (img) {
      const lado = Math.min(img.width, img.height) || 1;
      ctx.save();
      ctx.beginPath();
      ctx.arc(ax, ay, ar, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(img, (img.width - lado) / 2, (img.height - lado) / 2, lado, lado, ax - ar, ay - ar, ar * 2, ar * 2);
      ctx.restore();
    }

    if (perfil.nome) {
      const ny = Math.round(altura * P.perfilNomeY);
      ctx.save();
      ctx.font = `700 ${nf}px Inter, "Noto Color Emoji", "Helvetica Neue", Arial, sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = P.ganchoCor || "#000000";
      ctx.fillText(perfil.nome, tx, ny);
      if (perfil.verificado !== false) {
        const bx = tx + wn + Math.round(nf * 0.3) + br;
        ctx.beginPath();
        ctx.arc(bx, ny, br, 0, Math.PI * 2);
        ctx.fillStyle = "#1D9BF0";
        ctx.fill();
        ctx.strokeStyle = "#FFFFFF";
        ctx.lineWidth = Math.max(2, Math.round(br * 0.3));
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(bx - br * 0.45, ny + br * 0.02);
        ctx.lineTo(bx - br * 0.12, ny + br * 0.35);
        ctx.lineTo(bx + br * 0.48, ny - br * 0.38);
        ctx.stroke();
      }
      ctx.restore();
    }

    if (arroba) {
      ctx.save();
      ctx.font = `500 ${af}px Inter, "Noto Color Emoji", "Helvetica Neue", Arial, sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = P.perfilArrobaCor || "#8E8E93";
      ctx.fillText(arroba, tx, Math.round(altura * P.perfilArrobaY));
      ctx.restore();
    }
  }

  /* Rodapé do preset (texto da conta do Instagram, ou o do próprio preset).
     Com `rodapeFaixa` desenha uma faixa preenchida por trás, a abraçar o texto,
     e uma segunda linha por baixo — é o formato das capturas com o rodapé preto.
     Nesse caso a cor do texto vem do preset e não da conta: a cor por omissão da
     conta é verde, que sobre a faixa preta não é o que se quer. */
  /* O `rodapeFixo` do preset ganha ao texto da conta: nestes formatos o
     rodapé é informação do próprio formato, não um campo editável. */
  const rodape = P.rodapeFixo || String((caixa && caixa.rodape) || "").trim();
  if (comPreset && rodape && P.rodapeTamanho > 0) {
    const tamRodape = Math.round(largura * P.rodapeTamanho);
    const yRodape = Math.round(altura * (P.rodapeY || 0.9355));
    ctx.save();
    ctx.font = `700 ${tamRodape}px Inter, "Noto Color Emoji", "Helvetica Neue", Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (P.rodapeFaixa) {
      const padX = Math.round(tamRodape * 0.9);
      const padY = Math.round(tamRodape * 0.62);
      const faixaW = Math.min(largura * 0.96, ctx.measureText(rodape).width + padX * 2);
      const faixaH = tamRodape + padY * 2;
      ctx.fillStyle = P.rodapeFundo || "#000000";
      ctx.fillRect(Math.round((largura - faixaW) / 2), Math.round(yRodape - faixaH / 2), Math.round(faixaW), Math.round(faixaH));
    }
    ctx.fillStyle = P.rodapeFaixa ? (P.rodapeCor || "#FFFFFF") : ((caixa && caixa.rodapeCor) || P.rodapeCor);
    ctx.fillText(rodape, largura / 2, yRodape, largura * 0.94);
    if (P.rodapeNota && P.rodapeNotaTamanho > 0) {
      const tamNota = Math.round(largura * P.rodapeNotaTamanho);
      ctx.font = `700 ${tamNota}px Inter, "Noto Color Emoji", "Helvetica Neue", Arial, sans-serif`;
      ctx.fillStyle = P.rodapeNotaCor || P.ganchoCor || "#000000";
      ctx.fillText(P.rodapeNota, largura / 2, Math.round(altura * (P.rodapeNotaY || 0.938)), largura * 0.94);
    }
    ctx.restore();
  }

  const frase = String(texto || "").trim();
  if (frase) {
    const tam = Math.round(largura * (comPreset ? P.ganchoTamanho : 0.062));
    ctx.font = `${comPreset ? 900 : 800} ${tam}px Inter, "Noto Color Emoji", "Helvetica Neue", Arial, sans-serif`;
    ctx.fillStyle = comPreset ? (estilo.hookColor || P.ganchoCor) : "#000000";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const max = largura * 0.86;
    const palavras = frase.split(/\s+/);
    const linhas = [];
    let atual = "";
    for (const palavra of palavras) {
      const teste = atual ? `${atual} ${palavra}` : palavra;
      if (ctx.measureText(teste).width > max && atual) {
        linhas.push(atual);
        atual = palavra;
      } else atual = teste;
    }
    if (atual) linhas.push(atual);
    if (linhas.length > 2) {
      const wCap = palavras.length > 12 ? [...palavras.slice(0, 11), palavras[palavras.length - 1]] : palavras;
      const mid = Math.ceil(wCap.length / 2);
      linhas.length = 0;
      linhas.push(wCap.slice(0, mid).join(" "), wCap.slice(mid).join(" "));
    }
    const entre = tam * (comPreset ? P.ganchoEntrelinha : 1.25);
    const total = linhas.length * entre;
    const margem = altura * (comPreset ? (P.ganchoInicio || 0.065) : 0.06);
    const area = Math.max(total, padY - margem);
    const y0 = margem + (area - total) / 2 + entre / 2;
    const maxDrawW = Math.round(largura * 0.92);
    const usaBordaPreta = !/^#(?:000|000000)$/i.test(String(ctx.fillStyle || "").trim());
    if (usaBordaPreta && typeof ctx.strokeText === "function") {
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.miterLimit = 2;
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = Math.max(4, Math.round(tam * 0.16));
    }
    linhas.forEach((l, n) => {
      const ly = y0 + n * entre;
      if (usaBordaPreta && typeof ctx.strokeText === "function") ctx.strokeText(l, largura / 2, ly, maxDrawW);
      ctx.fillText(l, largura / 2, ly, maxDrawW);
    });
  }
  return canvas.toBuffer("image/png");
}

/* ---------------------------------------------------------- processar */

const tempoDoLog = (t) => {
  const m = /time=(\d+):(\d+):(\d+\.?\d*)/.exec(t);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
};

/**
 * Limpa os metadados, corta [inicio, fim] e monta o 9:16 com o gancho — os
 * mesmos filtros e opções do `YS` do app. Devolve {caminho, size, name}.
 *
 * `estilo` traz a formatação da conta do Instagram ({preset, bgMode, hookColor,
 * footerText, footerColor}) e chega aqui pelo lote em massa (lote-massa.js).
 * Sem preset, o servidor mantém o seu aspeto de sempre (fundo branco, gancho
 * preto); com "escuro"/"claro" usa a geometria e as cores medidas do formato.
 */
export async function processar(entrada, inicio, fim, resolucao, gancho, aoProgresso, corte, destino, estilo = {}) {
  const info = await sondar(entrada);
  const dur = Math.max(0.5, fim - inicio);
  const alvo = resolucao === "720" ? 720 : 1080;
  const vw = (corte && corte.vw) || info.largura || 1920;
  const vh = (corte && corte.vh) || info.altura || 1080;
  const P = presetDoReel(estilo.preset);
  const comPreset = P.caixa !== "auto";
  const e = enquadramento(vw, vh, corte, alvo, P.id);
  const pasta = await pastaTemporaria();
  try {
    const temGancho = !!String(gancho || "").trim();
    const rodape = comPreset ? String(estilo.footerText || "").trim() : "";
    // Os cantos arredondados e o rodapé também vivem no PNG do gancho: mesmo sem
    // texto é preciso sobrepor a imagem.
    const temOverlay = temGancho || (comPreset && (e.radius > 0 || !!rodape));
    const args = ["-v", "info", "-y", "-ss", inicio.toFixed(2), "-t", dur.toFixed(2), "-i", entrada];
    if (temOverlay) {
      const png = path.join(pasta, "gancho.png");
      await fs.promises.writeFile(png, await imagemDoGancho(e.outWidth, e.outHeight, e.padY, gancho, {
        preset: P.id,
        hookColor: estilo.hookColor,
        caixa: {
          padX: e.padX, padY: e.padY, videoW: e.videoW, videoH: e.videoH,
          radius: e.radius, fundo: P.fundo, rodape, rodapeCor: estilo.footerColor || P.rodapeCor,
        },
      }));
      args.push("-i", png);
    }
    const indiceSilencio = temOverlay ? 2 : 1;
    if (!info.temAudio) args.push("-f", "lavfi", "-t", dur.toFixed(2), "-i", "anullsrc=r=44100:cl=stereo");
    const corFundo = comPreset ? (P.fundo === "branco" ? "white" : "black") : "white";
    const base = `[0:v]${e.hasCrop ? `crop=${e.cropW}:${e.cropH}:${e.cropX}:${e.cropY},` : ""}scale=${e.videoW}:${e.videoH},pad=${e.outWidth}:${e.outHeight}:${e.padX}:${e.padY}:${corFundo},setsar=1`;
    const filtro = temOverlay ? `${base}[b];[b][1:v]overlay=0:0[v]` : `${base}[v]`;
    const saida = destino || path.join(pasta, "out.mp4");
    args.push(
      "-filter_complex", filtro, "-map", "[v]", "-map", info.temAudio ? "0:a:0?" : `${indiceSilencio}:a:0`,
      "-map_metadata", "-1", "-map_chapters", "-1", "-metadata", "title=", "-metadata", "encoder=",
      "-metadata:s:v:0", "encoder= ", "-metadata:s:a:0", "encoder= ",
      "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact",
      "-r", "30", "-c:v", "libx264", "-profile:v", "main", "-level:v", "4.0", "-crf", "23", "-preset", "veryfast",
      "-pix_fmt", "yuv420p", "-bsf:v", "filter_units=remove_types=6",
      "-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "128k", "-shortest", "-movflags", "+faststart", saida
    );
    await correr(ffmpeg(), args, {
      aoLog: (t) => {
        const s = tempoDoLog(t);
        if (s != null && aoProgresso) aoProgresso(Math.min(0.99, s / dur));
      },
    });
    if (aoProgresso) aoProgresso(1);
    const st = await fs.promises.stat(saida);
    return { caminho: saida, size: st.size, name: path.basename(saida), pasta: destino ? null : pasta };
  } catch (erro) {
    fs.promises.rm(pasta, { recursive: true, force: true }).catch(() => {});
    throw erro;
  }
}
