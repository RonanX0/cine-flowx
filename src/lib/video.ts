/**
 * 🎬 Pipeline de vídeo no navegador (FFmpeg.wasm):
 *  - limpeza de metadados + corte (máx. 2:30)
 *  - formatação 9:16 com remoção de barras pretas e texto de gancho no topo
 *  - captura de quadros nítidos + áudio para a IA identificar a cena
 */
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL, fetchFile } from "@ffmpeg/util";

const CORE_URL = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm";

let ff: FFmpeg | null = null;
let ffLoading: Promise<FFmpeg> | null = null;

export function getFFmpeg(): Promise<FFmpeg> {
  if (ff) return Promise.resolve(ff);
  if (ffLoading) return ffLoading;
  const p = (async () => {
    const inst = new FFmpeg();
    const coreURL = await toBlobURL(`${CORE_URL}/ffmpeg-core.js`, "text/javascript");
    const wasmURL = await toBlobURL(`${CORE_URL}/ffmpeg-core.wasm`, "application/wasm");
    await inst.load({ coreURL, wasmURL });
    ff = inst;
    return inst;
  })();
  ffLoading = p;
  p.finally(() => {
    ffLoading = null;
  });
  return p;
}

export function terminateFFmpeg() {
  ff?.terminate();
  ff = null;
}

function parseTime(logLine: string): number | null {
  const m = logLine.match(/time=(\d+):(\d+):(\d+\.?\d*)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

async function runFfmpeg(
  args: string[],
  inName: string,
  input: Blob,
  outName: string,
  durationSecs: number,
  onProgress?: (p: number) => void
): Promise<Blob> {
  const f = await getFFmpeg();
  await f.writeFile(inName, await fetchFile(input));
  const onLog = ({ message }: { message: string }) => {
    const t = parseTime(message);
    if (t != null && durationSecs > 0 && onProgress) onProgress(Math.min(0.99, t / durationSecs));
  };
  f.on("log", onLog);
  try {
    if ((await f.exec(args)) !== 0) throw new Error("O ffmpeg falhou ao processar o vídeo.");
    const data = await f.readFile(outName);
    onProgress && onProgress(1);
    const u8 = data instanceof Uint8Array ? data : new TextEncoder().encode(data as string);
    return new Blob([u8.slice().buffer], { type: "video/mp4" });
  } finally {
    f.off("log", onLog);
    try {
      await f.deleteFile(inName);
      await f.deleteFile(outName);
    } catch {
      /* ignore */
    }
  }
}

export const extOf = (name: string) => (name.split(".").pop() || "mp4").toLowerCase();

/** Dimensões reais do vídeo (lidas dos metadados do browser). */
export async function probeVideo(blob: Blob): Promise<{ vw: number; vh: number }> {
  const url = URL.createObjectURL(blob);
  const v = document.createElement("video");
  v.preload = "metadata";
  v.muted = true;
  v.src = url;
  try {
    await new Promise<void>((res, rej) => {
      v.onloadedmetadata = () => res();
      v.onerror = () => rej(new Error("metadata"));
    });
    return { vw: v.videoWidth || 1920, vh: v.videoHeight || 1080 };
  } catch {
    return { vw: 1920, vh: 1080 };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export interface Crop {
  top: number;
  bottom: number;
  vw: number;
  vh: number;
}

export interface Geometry {
  outWidth: number;
  outHeight: number;
  vw: number;
  vh: number;
  hasCrop: boolean;
  cropX: number;
  cropY: number;
  cropW: number;
  cropH: number;
  videoW: number;
  videoH: number;
  padX: number;
  padY: number;
}

/** Layout 9:16: corta as barras, escala e centra com fundo branco + espaço p/ gancho. */
export function computeGeometry(vw: number, vh: number, crop?: Crop | null, resolution: 720 | 1080 = 720): Geometry {
  const w = Math.max(2, vw - (vw % 2));
  const h = Math.max(2, vh - (vh % 2));
  const outHeight = Math.round((resolution * 16) / 9);
  const top = crop ? Math.max(0, crop.top) : 0;
  const bottom = crop ? Math.max(0, crop.bottom) : 0;
  const cropY = Math.min(h - 2, Math.max(0, Math.round(top / 2) * 2));
  const cropBottom = Math.max(0, Math.round(bottom / 2) * 2);
  const cropH = Math.max(2, Math.min(h - cropY, Math.floor((h - cropY - cropBottom) / 2) * 2));
  const cropW = w;
  const hasCrop = cropY > 0 || cropBottom > 0;
  const padY = Math.round((outHeight * 0.3) / 2) * 2; // 30% no topo p/ o gancho
  const maxVideoH = outHeight - padY;
  let videoW: number = resolution;
  let videoH: number = Math.max(2, Math.round(((resolution * cropH) / cropW / 2)) * 2);
  let padX = 0;
  if (videoH > maxVideoH) {
    videoH = Math.floor(maxVideoH / 2) * 2;
    videoW = Math.max(2, Math.floor(((videoH * cropW) / cropH / 2)) * 2);
    padX = Math.floor((resolution - videoW) / 4) * 2;
  }
  return { outWidth: resolution, outHeight, vw: w, vh: h, hasCrop, cropX: 0, cropY, cropW, cropH, videoW, videoH, padX, padY };
}

/** Desenha o texto de gancho (centrado, a preto, quebra por palavras). */
export function drawHook(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  topPad: number,
  text: string,
  placeholder = false
) {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);
  const value = text.trim() || (placeholder ? "Você precisa assistir esse filme 😳" : "");
  if (!value) return;
  const fontSize = Math.round(width * 0.062);
  ctx.font = `${placeholder ? "italic " : ""}800 ${fontSize}px "Inter", "Helvetica Neue", Arial, sans-serif`;
  ctx.fillStyle = placeholder ? "rgba(0, 0, 0, 0.35)" : "#000000";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const maxW = width * 0.84;
  const words = value.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    const attempt = cur ? `${cur} ${word}` : word;
    if (ctx.measureText(attempt).width > maxW && cur) {
      lines.push(cur);
      cur = word;
    } else cur = attempt;
  }
  if (cur) lines.push(cur);
  const lineH = fontSize * 1.25;
  const blockH = lines.length * lineH;
  const top = height * 0.06;
  const avail = Math.max(blockH, topPad - top);
  const startY = top + (avail - blockH) / 2 + lineH / 2;
  lines.forEach((line, i) => ctx.fillText(line, width / 2, startY + i * lineH));
}

/** PNG transparente com o gancho, para o filtro overlay do ffmpeg. */
export async function hookOverlayPng(width: number, height: number, topPad: number, text: string): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  drawHook(canvas, width, height, topPad, text, false);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
  return new Uint8Array(await (blob as Blob).arrayBuffer());
}

/** WAV silencioso (quando o vídeo não tem áudio, para o -shortest não zerar). */
export function silentWav(secs: number): Uint8Array {
  const samples = Math.max(22050, Math.min(3307500, Math.ceil(secs * 22050)));
  const buf = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 22050, true);
  view.setUint32(28, 22050 * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, samples * 2, true);
  return new Uint8Array(buf);
}

/** O ficheiro tem áudio descodificável? */
export async function hasAudio(blob: Blob): Promise<boolean> {
  if (blob.size > 80 * 1024 * 1024) return true;
  const Ctx = window.AudioContext || (window as any).webkitAudioContext;
  if (!Ctx) return true;
  const ctx = new Ctx();
  try {
    const buf = await blob.arrayBuffer();
    const audio = await ctx.decodeAudioData(buf);
    return audio.numberOfChannels > 0 && audio.duration > 0;
  } catch {
    return false;
  } finally {
    try {
      await ctx.close();
    } catch {
      /* ignore */
    }
  }
}

/** Deteção de barras pretas (letterbox) por luminância de linhas. */
export async function detectBlackBars(blob: Blob, manual?: Crop | null): Promise<Crop | null> {
  if (manual) return manual;
  const url = URL.createObjectURL(blob);
  const v = document.createElement("video");
  v.muted = true;
  v.src = url;
  v.preload = "auto";
  try {
    await new Promise<void>((res, rej) => {
      v.onloadeddata = () => res();
      v.onerror = () => rej(new Error("Não foi possível ler o vídeo."));
    });
    const vw = v.videoWidth || 1280;
    const vh = v.videoHeight || 720;
    // procura um frame com conteúdo (meio do vídeo)
    v.currentTime = Math.min(1.5, (v.duration || 2) / 2);
    await new Promise<void>((res) => {
      v.onseeked = () => res();
      setTimeout(res, 1500);
    });
    const W = 560;
    const H = Math.max(180, Math.min(360, Math.round((W * vh) / vw)));
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(v, 0, 0, W, H);
    const data = ctx.getImageData(0, 0, W, H).data;
    const rowLum = (y: number) => {
      let sum = 0;
      const step = 16;
      let n = 0;
      for (let x = 0; x < W; x += 4) {
        const i = (y * W + x) * 4;
        sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        n++;
      }
      return sum / Math.max(1, n);
    };
    const TH = 24;
    let top = 0;
    while (top < H * 0.4 && rowLum(top) < TH) top++;
    let bottom = 0;
    while (bottom < H * 0.4 && rowLum(H - 1 - bottom) < TH) bottom++;
    // converte para píxeis do vídeo original; ignora deteções insignificantes
    const scale = vh / H;
    const topPx = Math.round(top * scale);
    const bottomPx = Math.round(bottom * scale);
    if (topPx < Math.max(8, vh * 0.02) && bottomPx < Math.max(8, vh * 0.02)) return null;
    return { top: topPx, bottom: bottomPx, vw, vh };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export interface ProcessResult {
  blob: Blob;
  geometry: Geometry;
}

/**
 * Limpa metadados + corta [start,end] + formata 9:16 com gancho no topo.
 * Argumentos idênticos ao pipeline original (libx264 main@4.0 crf24 ultrafast,
 * aac 44.1k 128k, +faststart, bitexact, bsf filter_units remove SEI).
 */
export async function processVideo(
  file: Blob,
  fileName: string,
  start: number,
  end: number,
  hookText: string,
  crop: Crop | null,
  resolution: 720 | 1080,
  onProgress?: (p: number) => void
): Promise<ProcessResult> {
  const inName = `in.${extOf(fileName)}`;
  const dur = end - start;

  let geoCrop = crop;
  if (!geoCrop) {
    const detected = await detectBlackBars(file);
    if (detected) geoCrop = { top: detected.top, bottom: detected.bottom, vw: detected.vw, vh: detected.vh };
  }
  const dims = geoCrop ? { vw: geoCrop.vw, vh: geoCrop.vh } : await probeVideo(file);
  const geom = computeGeometry(dims.vw, dims.vh, geoCrop, resolution);

  const f = await getFFmpeg();
  const hasHook = !!hookText.trim();
  if (hasHook) await f.writeFile("ovl.png", await hookOverlayPng(geom.outWidth, geom.outHeight, geom.padY, hookText));
  const audio = await hasAudio(file);
  if (!audio) await f.writeFile("silent.wav", silentWav(dur));

  const chain = `[0:v]${geom.hasCrop ? `crop=${geom.cropW}:${geom.cropH}:${geom.cropX}:${geom.cropY},` : ""}scale=${geom.videoW}:${geom.videoH},pad=${geom.outWidth}:${geom.outHeight}:${geom.padX}:${geom.padY}:white,setsar=1`;
  const filter = hasHook ? `${chain}[b];[b][1:v]overlay=0:0[v]` : `${chain}[v]`;
  const audioInput = audio ? 0 : 2;

  const args = [
    "-ss", start.toFixed(2),
    "-t", dur.toFixed(2),
    "-i", inName,
    ...(hasHook ? ["-i", "ovl.png"] : []),
    ...(!audio ? ["-i", "silent.wav"] : []),
    "-filter_complex", filter,
    "-map", "[v]",
    "-map", audio ? "0:a:0?" : `${audioInput}:a:0`,
    "-map_metadata", "-1",
    "-map_chapters", "-1",
    "-metadata", "title=",
    "-metadata", "encoder=",
    "-metadata:s:v:0", "encoder= ",
    "-metadata:s:a:0", "encoder= ",
    "-fflags", "+bitexact",
    "-flags:v", "+bitexact",
    "-flags:a", "+bitexact",
    "-r", "30",
    "-c:v", "libx264",
    "-profile:v", "main",
    "-level:v", "4.0",
    "-crf", "24",
    "-preset", "ultrafast",
    "-tune", "fastdecode",
    "-pix_fmt", "yuv420p",
    "-bsf:v", "filter_units=remove_types=6",
    "-c:a", "aac",
    "-ar", "44100",
    "-ac", "2",
    "-b:a", "128k",
    "-shortest",
    "-movflags", "+faststart",
    "out.mp4",
  ];

  try {
    const blob = await runFfmpeg(args, inName, file, "out.mp4", dur, onProgress);
    return { blob, geometry: geom };
  } finally {
    if (hasHook)
      try {
        await f.deleteFile("ovl.png");
      } catch {
        /* ignore */
      }
    if (!audio)
      try {
        await f.deleteFile("silent.wav");
      } catch {
        /* ignore */
      }
  }
}

/** Captura 6 quadros nítidos (JPEG) + áudio (WAV base64) para a IA. */
export async function captureForAi(
  file: Blob,
  start: number,
  end: number
): Promise<{ frames: string[]; audio: { mimeType: string; base64: string } | null }> {
  const url = URL.createObjectURL(file);
  const v = document.createElement("video");
  v.muted = true;
  v.src = url;
  v.preload = "auto";
  await new Promise<void>((res, rej) => {
    v.onloadeddata = () => res();
    v.onerror = () => rej(new Error("Não foi possível ler o vídeo."));
  });
  const vw = v.videoWidth || 1280;
  const vh = v.videoHeight || 720;
  const W = 768;
  const H = Math.round((W * vh) / vw);
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;

  const frames: string[] = [];
  const span = Math.max(0.5, end - start);
  for (let i = 0; i < 6; i++) {
    const t = start + (span * (i + 0.5)) / 6;
    v.currentTime = Math.min(t, Math.max(0, (v.duration || end) - 0.1));
    await new Promise<void>((res) => {
      v.onseeked = () => res();
      setTimeout(res, 1200);
    });
    ctx.drawImage(v, 0, 0, W, H);
    frames.push(canvas.toDataURL("image/jpeg", 0.85));
  }

  let audio: { mimeType: string; base64: string } | null = null;
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    const actx = new Ctx();
    const decoded = await actx.decodeAudioData(await file.arrayBuffer());
    if (decoded.numberOfChannels > 0 && decoded.duration > 0) {
      const rate = 16000;
      const maxSecs = 60;
      const from = Math.max(0, start);
      const to = Math.min(decoded.duration, end || decoded.duration, from + maxSecs);
      const n = Math.max(0, Math.floor((to - from) * rate));
      if (n > rate) {
        const out = new Float32Array(n);
        const ch0 = decoded.getChannelData(0);
        const ch1 = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : null;
        const srcRate = decoded.sampleRate;
        const srcStart = Math.floor(from * srcRate);
        for (let i = 0; i < n; i++) {
          const si = srcStart + Math.floor((i / n) * (to - from) * srcRate);
          const a = ch0[si] || 0;
          const b = ch1 ? ch1[si] || 0 : a;
          out[i] = (a + b) / 2;
        }
        const buf = new ArrayBuffer(44 + n * 2);
        const dv = new DataView(buf);
        const wstr = (off: number, s: string) => {
          for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
        };
        wstr(0, "RIFF");
        dv.setUint32(4, 36 + n * 2, true);
        wstr(8, "WAVE");
        wstr(12, "fmt ");
        dv.setUint32(16, 16, true);
        dv.setUint16(20, 1, true);
        dv.setUint16(22, 1, true);
        dv.setUint32(24, rate, true);
        dv.setUint32(28, rate * 2, true);
        dv.setUint16(32, 2, true);
        dv.setUint16(34, 16, true);
        wstr(36, "data");
        dv.setUint32(40, n * 2, true);
        for (let i = 0; i < n; i++) {
          const s = Math.max(-1, Math.min(1, out[i]));
          dv.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        }
        const bytes = new Uint8Array(buf);
        let bin = "";
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)) as any);
        }
        audio = { mimeType: "audio/wav", base64: btoa(bin) };
      }
    }
    await actx.close();
  } catch {
    audio = null;
  } finally {
    URL.revokeObjectURL(url);
  }
  return { frames, audio };
}

/** Estimativa de tamanho/tempo de processamento. */
export function estimateOutput(geom: Geometry, secs: number): { size: number; secs: number } {
  const bitsPerPx = 0.12; // crf 24 ultrafast ≈
  const fps = 30;
  const bytes = ((geom.videoW * geom.videoH * fps * bitsPerPx) / 8) * secs + (128000 / 8) * secs;
  return { size: Math.round(bytes), secs: Math.round(secs * 0.6) };
}
