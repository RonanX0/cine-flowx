/**
 * ☁️ CINECLIP · NUVEM DURÁVEL (CineCloud)
 * ---------------------------------------------------------------------------
 * Camada de armazenamento durável: Google Drive (Apps Script) e/ou Cloudflare
 * R2, com fallback legado a hosts temporários. Port TypeScript do antigo
 * `nuvem-duravel.js` (mesmos comportamentos, mesmas mensagens).
 *
 * Regras que resolvem o "alguns vídeos não ficam na nuvem":
 *   1. O upload do .mp4 é AGUARDADO antes de gravar o cofre.
 *   2. Erros deixam de ser engolidos por catch{} — viram toast + diagnóstico.
 *   3. Retry com backoff (3 tentativas) por provider, e passagem ao seguinte.
 *   4. O File do <input> é copiado para memória antes do upload.
 *   5. R2: vídeos acima do limite usam URL pré-assinada S3; Drive: blocos de
 *      2 MB (upload resumable do Apps Script).
 *   6. Guarda anti-apagão: leitura falhou por rede → não sobrescreve o cofre.
 *   7. Migração automática de cofres antigos (bytebin/kappa).
 *   8. Claims anti-publicação duplicada com degradação segura.
 */
import { toastOnce } from "./toast";

export const VERSION = "2.0.0";
const SETTINGS_KEY = "cineclip.settings";
const STATE_KEY = "cineclip.cloud.state";
const MAX_LOG = 80;

const KV_BASE = "https://keyvalue.immanuel.co/api/KeyVal";
const KV_APP = "1729nxi0";
const TEMP_VIDEO_HOSTS = [
  "kappa.lol",
  "segs.lol",
  "uguu.se",
  "litter.catbox.moe",
  "litterbox.catbox.moe",
  "filebin.net",
  "catbox.moe",
  "bytebin.lucko.me",
];
const DRIVE_HOSTS = ["script.google.com", "googleusercontent.com"];

export const CLAIM_TTL_MS = 10 * 60 * 1000;

export interface CloudConfig {
  workerUrl: string;
  token: string;
  driveUrl: string;
  driveToken: string;
  driveChunkBytes: number;
  driveSingleMaxBytes: number;
  maxMb: number;
  presign: boolean;
  mirrorLegacy: boolean;
  provider: string;
  timeoutMs: number;
}

export interface ClaimResult {
  ok: boolean;
  degraded?: boolean;
  reason?: string;
  provider?: string;
  key?: string;
  owner?: string;
  expiresAt?: number;
  claim?: any;
  ownerLabel?: string;
  recovered?: boolean;
  holder?: { owner: string; expiresAt?: number } | null;
  problems?: string[];
}

interface LogEntry {
  t: string;
  level: string;
  message: string;
  extra?: unknown;
}

const memoryLog: LogEntry[] = [];
let lastError = "";

/* ------------------------------------------------------------------ utils */

const now = () => Date.now();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function log(level: string, message: string, extra?: unknown) {
  const entry: LogEntry = { t: new Date().toISOString(), level, message: String(message || "") };
  if (extra !== undefined) entry.extra = extra;
  memoryLog.push(entry);
  if (memoryLog.length > MAX_LOG) memoryLog.shift();
  try {
    const method = level === "error" ? "error" : level === "warn" ? "warn" : "debug";
    // eslint-disable-next-line no-console
    (console as any)[method]("[CineCloud] " + entry.message, extra || "");
  } catch {
    /* ignore */
  }
}

function readSettings(): Record<string, any> {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function loadState(): Record<string, any> {
  try {
    return JSON.parse(localStorage.getItem(STATE_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function saveState(patch: Record<string, any>) {
  try {
    const st = loadState();
    Object.assign(st, patch || {});
    localStorage.setItem(STATE_KEY, JSON.stringify(st));
  } catch (e: any) {
    log("warn", "Não foi possível gravar o estado local da nuvem: " + e.message);
  }
}

function absolute(base: string): string {
  try {
    return new URL(base, window.location.origin).toString().replace(/\/+$/, "");
  } catch {
    return String(base || "").replace(/\/+$/, "");
  }
}

/** Limpa o URL do Apps Script (espaços, zero-width, "https://" esquecido, query colado). */
export function normalizeScriptUrl(raw: string): string {
  let u = String(raw || "").trim().replace(/[\u200b-\u200f\ufeff]/g, "");
  if (!u) return "";
  u = u.replace(/\s+/g, "");
  u = u.split("?")[0].split("#")[0];
  if (/^\/[^/]/.test(u)) return u;
  if (/^\/\//.test(u)) u = "https:" + u;
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = "https://" + u;
  return u;
}

export function config(): CloudConfig {
  const s = readSettings();
  const r2Url = normalizeScriptUrl(s.r2WorkerUrl);
  const driveUrl = normalizeScriptUrl(s.driveScriptUrl);
  return {
    workerUrl: r2Url ? absolute(r2Url) : "",
    token: String(s.r2Token || "").trim(),
    driveUrl: driveUrl ? absolute(driveUrl) : "",
    driveToken: String(s.driveToken || "").trim(),
    driveChunkBytes: Number(s.driveChunkMb || 2) * 1024 * 1024,
    driveSingleMaxBytes: Number(s.driveSingleMaxMb || 8) * 1024 * 1024,
    maxMb: Number(s.r2MaxMb || 0) || 95,
    presign: s.r2Presign !== false,
    mirrorLegacy: s.cloudMirrorLegacy !== false,
    provider: String(s.cloudProvider || "auto").trim().toLowerCase(),
    timeoutMs: Number(s.cloudTimeoutMs || 0) || 300000,
  };
}

/** Providers configurados, por ordem de prioridade. */
function chain(cfg?: CloudConfig): string[] {
  cfg = cfg || config();
  const hasR2 = !!(cfg.workerUrl && cfg.token);
  const hasDrive = !!(cfg.driveUrl && cfg.driveToken);
  const order: string[] = [];
  if (cfg.provider === "r2") {
    if (hasR2) order.push("r2");
  } else if (cfg.provider === "drive") {
    if (hasDrive) order.push("drive");
  } else if (cfg.provider === "legacy") {
    // só hosts antigos
  } else {
    if (hasR2) order.push("r2");
    if (hasDrive) order.push("drive");
  }
  order.push("legacy");
  return order;
}

export const configured = () => chain().some((p) => p !== "legacy");
export const activeProviders = () => chain();

export function fmtSize(bytes: number | null | undefined): string {
  if (bytes == null || Number.isNaN(bytes)) return "—";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1048576).toFixed(1) + " MB";
}

function sameTarget(url: string, base: string): boolean {
  if (!base) return false;
  try {
    const u = new URL(url);
    const b = new URL(base);
    if (u.hostname !== b.hostname) return false;
    const bp = String(b.pathname || "/").replace(/\/+$/, "");
    if (bp && bp !== "/" && String(u.pathname || "/").indexOf(bp) !== 0) return false;
    return true;
  } catch {
    return false;
  }
}

/** Classifica um URL de vídeo: r2 | drive | temp | local | unknown | none. */
export function classifyUrl(url: string): string {
  if (!url || !/^https?:/i.test(url)) return "none";
  const cfg = config();
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return "unknown";
  }
  if (sameTarget(url, cfg.driveUrl)) return "drive";
  if (sameTarget(url, cfg.workerUrl)) return "r2";
  if (/workers\.dev$/i.test(host) || /r2\.cloudflarestorage\.com$/i.test(host) || /r2\.dev$/i.test(host))
    return "r2";
  for (const d of DRIVE_HOSTS) {
    if (host === d || host.slice(-d.length - 1) === "." + d) return "drive";
  }
  for (const t of TEMP_VIDEO_HOSTS) {
    if (host === t || host.slice(-t.length - 1) === "." + t) return "temp";
  }
  if (host === window.location.hostname) return "local";
  return "unknown";
}

export const isDurable = (url: string) => {
  const k = classifyUrl(url);
  return k === "r2" || k === "drive";
};

/* ------------------------------------------------------------------ HTTP */

function authHeaders(cfg: CloudConfig, extra?: Record<string, string>) {
  return { Authorization: "Bearer " + cfg.token, ...(extra || {}) };
}

function describeFailure(status: number, data: any): string {
  const msg = (data && (data.error || data.message)) || "";
  if (status === 401 || status === 403)
    return msg || "Token inválido ou em falta (401/403). Verifica em Configurações → Nuvem durável.";
  if (status === 404) return msg || "Recurso não encontrado (404). Confirma o URL.";
  if (status === 413) return msg || "Ficheiro demasiado grande para um só pedido (413).";
  if (status === 501) return msg || "Funcionalidade não configurada no backend (501).";
  if (status >= 500) return msg || "Erro no backend (HTTP " + status + ").";
  return msg || "HTTP " + status;
}

/** Apps Script devolve sempre HTTP 200 e reporta erros no corpo → validar o `ok`. */
function driveFailure(data: any): string | null {
  if (data && data.ok === false) return data.error || "Erro devolvido pelo Apps Script.";
  return null;
}

function driveFetchOpts(options?: RequestInit): RequestInit {
  const o: RequestInit = { ...(options || {}) };
  o.redirect = "follow";
  o.cache = o.cache || "no-store";
  o.credentials = "omit";
  return o;
}

function inIframe(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

async function probeBlocked(url: string): Promise<string> {
  try {
    const r = await fetch(url, driveFetchOpts({ mode: "no-cors" }));
    if (r && (r.type === "opaque" || r.status === 0)) return "blocked";
    return "reachable";
  } catch {
    return "unreachable";
  }
}

function canJsonp(): boolean {
  try {
    return (
      typeof document !== "undefined" &&
      !!document &&
      !!document.createElement &&
      !!(document.head || document.documentElement)
    );
  } catch {
    return false;
  }
}

let jsonpSeq = 0;

/** MODO COMPATÍVEL (JSONP) — o Apps Script não pode definir CORS. */
function driveJsonp(cfg: CloudConfig, params: Record<string, any>, timeoutMs?: number): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!canJsonp()) {
      reject(new Error("Este ambiente não tem DOM — o modo compatível (JSONP) não está disponível."));
      return;
    }
    jsonpSeq++;
    const name = "__cineCloudCb" + jsonpSeq + "_" + Math.random().toString(36).slice(2, 8);
    const all: Record<string, any> = { ...params, callback: "window." + name };
    const script = document.createElement("script");
    let finished = false;
    const timer = setTimeout(() => {
      finish(new Error(`O Apps Script não respondeu a tempo (${Math.round((timeoutMs || 45000) / 1000)} s, modo compatível).`));
    }, timeoutMs || 45000);

    function cleanup() {
      clearTimeout(timer);
      try {
        delete (window as any)[name];
      } catch {
        (window as any)[name] = undefined;
      }
      try {
        if (script && script.parentNode) script.parentNode.removeChild(script);
      } catch {
        /* ignore */
      }
    }
    function finish(err: Error | null, data?: any) {
      if (finished) return;
      finished = true;
      cleanup();
      if (err) reject(err);
      else resolve(data);
    }

    (window as any)[name] = (data: any) => finish(null, data);
    script.src = q(cfg.driveUrl, all);
    script.async = true;
    script.onerror = () =>
      finish(new Error("Não consegui carregar a resposta do Apps Script (modo compatível). Confirma o URL e que a implantação é 'Qualquer pessoa'."));
    script.onload = () => {
      setTimeout(() => {
        finish(new Error("O Apps Script respondeu mas não devolveu dados (modo compatível) — confirma que colaste o ficheiro apps-script/cineclip-cloud-drive.js atualizado e criaste uma NOVA VERSÃO da implantação."));
      }, 0);
    };
    (document.head || document.documentElement).appendChild(script);
  });
}

/** POST no-cors: o pedido chega, a resposta é opaca; confirma-se por JSONP. */
async function postOpaque(url: string, bodyText: string): Promise<boolean> {
  await fetch(
    url,
    driveFetchOpts({
      mode: "no-cors",
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: bodyText,
    })
  );
  return true;
}

async function driveReadJson(cfg: CloudConfig, params: Record<string, any>, forceJsonp?: boolean) {
  if (!forceJsonp) {
    try {
      return await fetchJson(q(cfg.driveUrl, params), driveFetchOpts());
    } catch (e) {
      if (!canJsonp()) throw e;
      log("warn", "Leitura bloqueada pelo browser (CORS) — a usar o modo compatível (JSONP).");
    }
  } else if (!canJsonp()) {
    return await fetchJson(q(cfg.driveUrl, params), driveFetchOpts());
  }
  const data = await driveJsonp(cfg, params);
  return { status: 200, ok: true, data, text: JSON.stringify(data), jsonp: true };
}

export function q(base: string, params: Record<string, any>): string {
  const clean = String(base || "");
  let existing = clean.indexOf("?") >= 0 ? clean.slice(clean.indexOf("?") + 1).split("&") : [];
  const keep = clean.split("?")[0];
  const parts: string[] = [];
  Object.keys(params || {}).forEach((k) => {
    const v = params[k];
    if (v === undefined || v === null || v === "") return;
    existing = existing.filter((kv) => kv.split("=")[0] !== k);
    parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(v));
  });
  const all = existing.concat(parts).filter((kv) => kv !== "");
  return keep + (all.length ? "?" + all.join("&") : "");
}

async function fetchJson(url: string, options?: RequestInit) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { ok: false, error: "Resposta não-JSON do backend: " + text.slice(0, 160) };
  }
  return { status: res.status, ok: res.ok, data, text };
}

interface XhrOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit;
  timeoutMs?: number;
  onProgress?: (pct: number, loaded?: number, total?: number) => void;
}

/** XHR para ter progresso de upload real (fetch não expõe upload progress). */
function xhrUpload(url: string, opts: XhrOpts): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(opts.method || "POST", url, true);
    xhr.timeout = opts.timeoutMs || 300000;
    Object.keys(opts.headers || {}).forEach((k) => xhr.setRequestHeader(k, opts.headers![k]));
    xhr.upload.onprogress = (ev) => {
      if (opts.onProgress && ev.lengthComputable)
        opts.onProgress(Math.round((ev.loaded / ev.total) * 100), ev.loaded, ev.total);
    };
    xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText || "" });
    xhr.onerror = () => reject(new Error("Falha de rede ao enviar para " + url + " (sem resposta do servidor)."));
    xhr.ontimeout = () =>
      reject(new Error(`Tempo esgotado ao enviar (${Math.round((opts.timeoutMs || 0) / 1000)} s). Verifica a ligação ou reduz o tamanho do clipe.`));
    xhr.onabort = () => reject(new Error("Envio cancelado."));
    xhr.send(opts.body as XMLHttpRequestBodyInit | null);
  });
}

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let out = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)) as any);
  }
  return btoa(out);
}

/* ---------------------------------------------------------- upload vídeo */

async function readIntoMemory(blobOrFile: Blob, fileName: string): Promise<{ buffer: ArrayBuffer; size: number }> {
  try {
    const buf = await blobOrFile.arrayBuffer();
    return { buffer: buf, size: buf.byteLength };
  } catch (e: any) {
    const err: any = new Error(
      `Não consegui ler o ficheiro "${fileName || "vídeo"}" neste aparelho (${e?.name || "erro"}). ` +
        "O ficheiro original foi movido/apagado ou o navegador limpou os dados do site. " +
        "Reimporta o .mp4 neste agendamento para o voltares a ter na nuvem."
    );
    err.code = "unreadable_source";
    throw err;
  }
}

async function uploadToWorker(cfg: CloudConfig, buffer: ArrayBuffer, fileName: string, onProgress?: XhrOpts["onProgress"]) {
  const url = cfg.workerUrl + "/api/video";
  const res = await xhrUpload(url, {
    method: "POST",
    headers: authHeaders(cfg, {
      "Content-Type": "video/mp4",
      "X-File-Name": fileName,
      "X-File-Size": String(buffer.byteLength),
      "X-Cineclip-Client": "web/" + VERSION,
    }),
    body: buffer,
    timeoutMs: cfg.timeoutMs,
    onProgress,
  });
  let data: any = null;
  try {
    data = JSON.parse(res.text || "null");
  } catch {
    /* ignore */
  }
  if (res.status === 413 && cfg.presign) {
    log("warn", "Vídeo acima do limite do Worker — a tentar URL pré-assinada S3.");
    return uploadPresigned(cfg, buffer, fileName, onProgress);
  }
  if (res.status < 200 || res.status >= 300) {
    const err: any = new Error(describeFailure(res.status, data));
    err.status = res.status;
    err.retryable = res.status === 429 || res.status >= 500 || res.status === 408;
    throw err;
  }
  if (!data || !data.ok || !data.url) throw new Error("O Worker respondeu sem um link público para o vídeo.");
  return { url: data.url, key: data.key, provider: data.provider || "cloudflare-r2", size: data.size || buffer.byteLength };
}

async function uploadPresigned(cfg: CloudConfig, buffer: ArrayBuffer, fileName: string, onProgress?: XhrOpts["onProgress"]) {
  const sign = await fetchJson(cfg.workerUrl + "/api/video/presign", {
    method: "POST",
    headers: authHeaders(cfg, { "Content-Type": "application/json" }),
    body: JSON.stringify({ fileName, size: buffer.byteLength, expires: 3600 }),
  });
  if (!sign.ok || !sign.data || !sign.data.ok || !sign.data.uploadUrl) {
    const err: any = new Error(
      "Vídeo demasiado grande para envio direto e o presign não está disponível no Worker: " +
        describeFailure(sign.status, sign.data)
    );
    err.code = "presign_unavailable";
    throw err;
  }
  const put = await xhrUpload(sign.data.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "video/mp4" },
    body: buffer,
    timeoutMs: cfg.timeoutMs,
    onProgress,
  });
  if (put.status < 200 || put.status >= 300) {
    const e2: any = new Error("O R2 recusou o envio pré-assinado (HTTP " + put.status + ").");
    e2.retryable = put.status >= 500;
    throw e2;
  }
  return { url: sign.data.url, key: sign.data.key, provider: "cloudflare-r2-presigned", size: buffer.byteLength };
}

/* --- Google Drive (Apps Script) --- */

let driveInfoCache: any = { url: "", at: 0, chunkBytes: 0, singleMaxBytes: 0, maxVideoBytes: 0, readable: true };

async function driveInfo(cfg: CloudConfig) {
  if (driveInfoCache.url === cfg.driveUrl && now() - driveInfoCache.at < 10 * 60 * 1000) return driveInfoCache;
  const fallback = {
    url: cfg.driveUrl,
    at: now() - 9 * 60 * 1000,
    chunkBytes: cfg.driveChunkBytes > 0 ? cfg.driveChunkBytes : 2 * 1024 * 1024,
    singleMaxBytes: cfg.driveSingleMaxBytes > 0 ? cfg.driveSingleMaxBytes : 8 * 1024 * 1024,
    maxVideoBytes: 0,
    readable: true as boolean,
  };
  let d: any = null;
  let readable = false;
  try {
    const res = await fetchJson(q(cfg.driveUrl, { action: "health" }), driveFetchOpts());
    d = res.data || null;
    readable = true;
  } catch (e: any) {
    if (canJsonp()) {
      try {
        d = await driveJsonp(cfg, { action: "health" });
        log("warn", "O browser bloqueia a leitura direta do Apps Script (CORS) — a usar o modo compatível (JSONP).");
      } catch (e2: any) {
        log("warn", `Não consegui ler o Apps Script (${e.message} · JSONP: ${e2.message}).`);
      }
    } else {
      log("warn", `Não consegui ler as capacidades do Apps Script (${e.message}) — a usar os valores das Configurações.`);
    }
  }
  if (!d || d.ok !== true) {
    fallback.readable = readable;
    return fallback;
  }
  driveInfoCache = {
    url: cfg.driveUrl,
    at: now(),
    chunkBytes: Number(d.chunkBytes) || fallback.chunkBytes,
    singleMaxBytes: Number(d.singleMaxBytes) || fallback.singleMaxBytes,
    maxVideoBytes: Number(d.maxVideoBytes) || 0,
    readable,
  };
  return driveInfoCache;
}

async function confirmUpload(cfg: CloudConfig, uploadId: string, total: number) {
  const res = await driveReadJson(cfg, { action: "complete", token: cfg.driveToken, id: uploadId }, true);
  const d = res.data;
  const f = driveFailure(d);
  if (f || !d || !d.url) {
    const err: any = new Error(`Drive (modo compatível): o envio terminou mas o ficheiro não ficou completo (${f || "sem url"}).`);
    err.retryable = true;
    throw err;
  }
  saveState({ driveMode: "compatível (JSONP)" });
  return { url: d.url, key: d.fileId, provider: "google-drive", size: d.size || total, mode: "jsonp" };
}

async function uploadToDrive(cfg: CloudConfig, buffer: ArrayBuffer, fileName: string, onProgress?: XhrOpts["onProgress"]) {
  const total = buffer.byteLength;
  const uploadId = "up_" + now().toString(36) + "_" + Math.random().toString(36).slice(2, 9);
  const info = await driveInfo(cfg);
  const chunkSize = Math.max(262144, Math.floor((info.chunkBytes || 2 * 1024 * 1024) / 262144) * 262144);
  const singleMax = info.singleMaxBytes > 0 ? info.singleMaxBytes : 8 * 1024 * 1024;
  const base = cfg.driveUrl;

  if (info.maxVideoBytes && total > info.maxVideoBytes) {
    const errBig: any = new Error(
      `O vídeo tem ${fmtSize(total)} e o backend do Drive aceita no máximo ${fmtSize(info.maxVideoBytes)}. ` +
        "Corta o clipe ou aumenta MAX_VIDEO_MB no Apps Script (o Drive guarda até 15 GB na conta grátis)."
    );
    errBig.code = "too_large";
    throw errBig;
  }

  const chunkUrl = (index: number) =>
    q(base, { action: "upload", token: cfg.driveToken, id: uploadId, index, total, name: fileName });

  const opaque = info.readable === false && canJsonp();

  async function sendChunk(index: number, slice: ArrayBuffer): Promise<any> {
    const b64 = bufferToBase64(slice);
    if (opaque) {
      await postOpaque(chunkUrl(index), b64);
      return {};
    }
    const res = await fetch(
      chunkUrl(index),
      driveFetchOpts({ method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: b64 })
    );
    let data: any = null;
    try {
      data = await res.json();
    } catch {
      throw new Error(`O Apps Script devolveu uma resposta inválida (HTTP ${res.status}). Confirma que o deploy é 'App da Web' com acesso 'Qualquer pessoa'.`);
    }
    const f = driveFailure(data);
    if (f) {
      const err: any = new Error("Drive: " + f);
      err.retryable = !/token|inválid|invalid|limite|excede/i.test(f);
      throw err;
    }
    return data || {};
  }

  if (total <= singleMax) {
    const one = await sendChunk(0, buffer);
    if (onProgress) onProgress(100, total, total);
    if (opaque) return await confirmUpload(cfg, uploadId, total);
    if (!one.url) throw new Error("Drive: o Apps Script não devolveu o link do vídeo.");
    return { url: one.url, key: one.fileId, provider: "google-drive", size: one.size || total };
  }

  let sent = 0;
  let index = 0;
  for (let offset = 0; offset < total; offset += chunkSize, index++) {
    const slice = buffer.slice(offset, Math.min(offset + chunkSize, total));
    const out = await sendChunk(index, slice);
    sent += slice.byteLength;
    if (onProgress) onProgress(Math.round((sent / total) * 100), sent, total);
    if (out.done && out.url) return { url: out.url, key: out.fileId, provider: "google-drive", size: out.size || total };
  }

  if (opaque) return await confirmUpload(cfg, uploadId, total);

  const done = await fetchJson(q(base, { action: "complete", token: cfg.driveToken, id: uploadId }), driveFetchOpts());
  const dd = driveFailure(done.data);
  if (dd || !done.data || !done.data.url) {
    throw new Error(`Drive: o upload terminou mas o ficheiro não ficou completo (${dd || "sem url"}).`);
  }
  return { url: done.data.url, key: done.data.fileId, provider: "google-drive", size: total };
}

/* ------------------------------------------------- upload legado (hosts temporários) */

export async function legacyUploadVideo(blobOrFile: Blob, fileName: string): Promise<string> {
  let name = String(fileName || "reel_cineclip.mp4").replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!/\.mp4$/i.test(name)) name += ".mp4";
  const errors: string[] = [];

  try {
    const form = new FormData();
    form.append("file", new Blob([blobOrFile], { type: "video/mp4" }), name);
    const res = await fetch("https://kappa.lol/api/upload", { method: "POST", body: form });
    if (res.ok) {
      const j = await res.json();
      if (j && j.link) {
        const ext = j.ext || ".mp4";
        const link = String(j.link).endsWith(ext) ? String(j.link) : String(j.link) + ext;
        log("warn", "Vídeo enviado para host TEMPORÁRIO (kappa.lol) — pode ser apagado em horas/dias.");
        return link;
      }
    }
    errors.push("kappa.lol HTTP " + res.status);
  } catch (e: any) {
    errors.push("kappa.lol: " + e.message);
  }

  try {
    const res2 = await fetch("/api/public/upload-temp", {
      method: "POST",
      headers: { "Content-Type": "video/mp4", "X-File-Name": name },
      body: blobOrFile,
    });
    if (res2.ok) {
      const j2 = await res2.json();
      if (j2 && j2.url && /^http/i.test(String(j2.url))) {
        log("warn", "Vídeo enviado para host TEMPORÁRIO (/api/public/upload-temp).");
        return String(j2.url);
      }
    }
    errors.push("/api/public/upload-temp HTTP " + res2.status);
  } catch (e: any) {
    errors.push("/api/public/upload-temp: " + e.message);
  }

  const err: any = new Error(`Nenhum armazenamento aceitou o vídeo (${fmtSize(blobOrFile?.size)}). ${errors.join(" | ")}`);
  err.code = "no_provider";
  throw err;
}

/* ---------------------------------------------------------- API de upload */

export interface UploadOpts {
  onProgress?: (pct: number | string) => void;
  allowTemp?: boolean;
}

/** Envia o vídeo para armazenamento durável e devolve o link público. */
export async function uploadVideo(blobOrFile: Blob | null | undefined, fileName: string, opts: UploadOpts = {}): Promise<string> {
  const cfg = config();
  let name = String(fileName || "reel_cineclip.mp4").replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!/\.mp4$/i.test(name)) name += ".mp4";

  if (!blobOrFile) {
    const err0: any = new Error("Este agendamento não tem vídeo associado neste aparelho.");
    err0.code = "no_blob";
    throw err0;
  }

  const providers = chain(cfg);
  const durable = providers.filter((p) => p !== "legacy");

  if (!durable.length) {
    if (opts.allowTemp === false) {
      const errNoProv: any = new Error(
        "Nenhum armazenamento durável configurado (Google Drive ou Cloudflare R2). Abre Configurações → Nuvem durável e cola o URL + token."
      );
      errNoProv.code = "no_durable_provider";
      throw errNoProv;
    }
    log("warn", "Nenhum armazenamento durável configurado — a usar hosts temporários.");
    toastOnce(
      "no-provider",
      "⚠️ Nuvem durável não configurada: os vídeos vão para hosts temporários que apagam os ficheiros em 3–72 h. Configura o Google Drive (grátis) ou o Cloudflare R2 em Configurações → Nuvem durável.",
      "warning",
      10 * 60 * 1000
    );
    return await legacyUploadVideo(blobOrFile, name);
  }

  const mem = await readIntoMemory(blobOrFile, name);
  const size = mem.size;
  const failures: string[] = [];

  for (const provider of providers) {
    if (provider === "legacy") continue;
    if (provider === "r2" && size > cfg.maxMb * 1024 * 1024 && !cfg.presign) {
      failures.push(`R2: vídeo com ${fmtSize(size)} excede ${cfg.maxMb} MB sem presign`);
      continue;
    }
    log("info", `A enviar ${name} (${fmtSize(size)}) para ${provider === "r2" ? "Cloudflare R2" : "Google Drive"}…`);
    let attempt = 0;
    let lastErr: any = null;
    while (attempt < 3) {
      attempt++;
      try {
        const out =
          provider === "r2"
            ? await uploadToWorker(cfg, mem.buffer, name, (p) => opts.onProgress && opts.onProgress(p))
            : await uploadToDrive(cfg, mem.buffer, name, (p) => opts.onProgress && opts.onProgress(p));
        await verifyPublicUrl(out.url);
        log("info", `Vídeo na nuvem durável: ${out.url} (${out.provider})`);
        saveState({ lastProvider: provider });
        return out.url;
      } catch (e: any) {
        lastErr = e;
        lastError = e?.message || String(e);
        if (e && (e.code === "unreadable_source" || e.code === "presign_unavailable" || e.code === "too_large")) throw e;
        const retryable = !e.status || e.retryable || e.status === 429 || e.status >= 500;
        log("warn", `${provider} tentativa ${attempt}/3 falhou: ${lastError}`);
        if (!retryable || attempt === 3) break;
        await sleep(800 * Math.pow(3, attempt - 1));
      }
    }
    failures.push(`${provider === "r2" ? "R2" : "Drive"}: ${lastErr?.message || lastErr}`);
  }

  if (opts.allowTemp === false) {
    const errAll: any = new Error("Não foi possível colocar o vídeo na nuvem durável. " + failures.join(" | "));
    errAll.code = "durable_providers_failed";
    throw errAll;
  }

  try {
    log("warn", `Providers duráveis falharam (${failures.join(" | ")}) — a tentar host temporário.`);
    const temp = await legacyUploadVideo(blobOrFile, name);
    toastOnce(
      "durable-fallback",
      `⚠️ O armazenamento durável falhou (${failures[0]}). O vídeo foi para um host TEMPORÁRIO e pode expirar antes do horário agendado.`,
      "warning",
      10 * 60 * 1000
    );
    return temp;
  } catch (e2: any) {
    const finalErr: any = new Error(
      `Não foi possível colocar o vídeo na nuvem. ${failures.join(" | ")} · Temporário: ${e2?.message || e2}`
    );
    finalErr.code = "all_providers_failed";
    throw finalErr;
  }
}

/** Confirma que o link público responde (Drive usa o endpoint leve `videohead`). */
export async function verifyPublicUrl(url: string): Promise<boolean> {
  const cfg = config();
  try {
    if (classifyUrl(url) === "drive") {
      const idMatch = /[?&]id=([^&]+)/.exec(String(url));
      const videoId = idMatch ? decodeURIComponent(idMatch[1]) : "";
      const info = await driveInfo(cfg);
      const hres = videoId
        ? await driveReadJson(cfg, { action: "videohead", id: videoId, token: cfg.driveToken }, info.readable === false)
        : await fetchJson(String(url).replace(/action=video(&|$)/, "action=videohead$1"), driveFetchOpts());
      const hf = driveFailure(hres.data);
      if (hf) {
        log("warn", "Link do Drive não confirmado: " + hf);
        toastOnce("drive-verify", "⚠️ O vídeo foi para o Drive mas não consegui confirmar o link: " + hf, "warning");
        return false;
      }
      return true;
    }
    const res = await fetch(url, { method: "GET", headers: { Range: "bytes=0-0" }, cache: "no-store" });
    if (res.status >= 400) {
      log("warn", "Link público respondeu HTTP " + res.status + ": " + url);
      toastOnce("public-" + res.status, `⚠️ O vídeo foi guardado mas o link público respondeu HTTP ${res.status}.`, "warning");
      return false;
    }
    try {
      res.body && (res.body as any).cancel && (res.body as any).cancel();
    } catch {
      /* ignore */
    }
    return true;
  } catch (e: any) {
    log("warn", `Não consegui validar o link público (${e.message}).`);
    return false;
  }
}

/* ------------------------------------------------------------------ cofre */

async function legacyReadVaultCipher(vaultHash: string) {
  const res = await fetch(`${KV_BASE}/GetValue/${KV_APP}/cc_${vaultHash}?t=${now()}`, { cache: "no-store" });
  if (!res.ok) {
    const err: any = new Error("Índice de sincronização respondeu HTTP " + res.status);
    err.status = res.status;
    err.retryable = res.status >= 500;
    throw err;
  }
  const pointer = (await res.text()).replace(/^"|"$/g, "").trim();
  if (!pointer) return { data: null, source: null, missing: true };
  const parts = pointer.split("__");
  const errors: string[] = [];
  for (const p of parts) {
    let url = "";
    if (p.indexOf("b_") === 0) url = `https://bytebin.lucko.me/${p.slice(2)}?t=${now()}`;
    else if (p.indexOf("k_") === 0) url = `https://kappa.lol/${p.slice(2)}.json?t=${now()}`;
    if (!url) continue;
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (r.ok) {
        const text = await r.text();
        if (text && text.length > 2)
          return { data: text, source: p.indexOf("b_") === 0 ? "legacy-bytebin" : "legacy-kappa", pointer };
      } else errors.push(`${url} → HTTP ${r.status}`);
    } catch (e: any) {
      errors.push(`${url} → ${e.message}`);
    }
  }
  const errAll: any = new Error("O cofre antigo não pôde ser lido: " + (errors.join(" | ") || "apontador vazio"));
  errAll.expired = true;
  throw errAll;
}

async function legacyWriteVaultMirror(vaultHash: string, cipher: string): Promise<boolean> {
  const ids: string[] = [];
  try {
    const res = await fetch("https://bytebin.lucko.me/post", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: cipher,
      cache: "no-store",
    });
    if (res.ok) {
      const j = await res.json();
      if (j && j.key) ids.push("b_" + j.key);
    }
  } catch {
    /* ignore */
  }
  try {
    const form = new FormData();
    form.append("file", new Blob([cipher], { type: "application/json" }), "vault.json");
    const res2 = await fetch("https://kappa.lol/api/upload", { method: "POST", body: form, cache: "no-store" });
    if (res2.ok) {
      const j2 = await res2.json();
      if (j2 && j2.id) ids.push("k_" + j2.id);
    }
  } catch {
    /* ignore */
  }
  if (!ids.length) return false;
  const pointer = ids.join("__");
  const res3 = await fetch(`${KV_BASE}/UpdateValue/${KV_APP}/cc_${vaultHash}/${encodeURIComponent(pointer)}?t=${now()}`, {
    method: "POST",
    cache: "no-store",
  });
  return res3.ok;
}

async function r2PutVault(cfg: CloudConfig, vaultHash: string, cipher: string) {
  const res = await fetch(cfg.workerUrl + "/api/vault/cc_" + encodeURIComponent(vaultHash), {
    method: "PUT",
    headers: authHeaders(cfg, { "Content-Type": "application/json" }),
    body: cipher,
    cache: "no-store",
  });
  if (!res.ok) {
    const err: any = new Error(describeFailure(res.status, null));
    err.status = res.status;
    err.retryable = res.status === 429 || res.status >= 500;
    throw err;
  }
  return { ok: true, provider: "cloudflare-r2" };
}

async function r2GetVaultCipher(cfg: CloudConfig, vaultHash: string) {
  const res = await fetch(cfg.workerUrl + "/api/vault/cc_" + encodeURIComponent(vaultHash), {
    headers: authHeaders(cfg, { "X-Cineclip-Client": "web/" + VERSION }),
    cache: "no-store",
  });
  if (res.status === 404) return { answered: true, data: null };
  if (!res.ok) {
    const err: any = new Error(describeFailure(res.status, null));
    err.status = res.status;
    throw err;
  }
  const text = await res.text();
  return { answered: true, data: text && text.length > 2 ? text : null, source: "cloudflare-r2" };
}

async function drivePutVault(cfg: CloudConfig, vaultHash: string, cipher: string) {
  const params = { action: "vault", hash: vaultHash, token: cfg.driveToken };
  const info = await driveInfo(cfg);

  if (info.readable !== false) {
    try {
      const res = await fetch(
        q(cfg.driveUrl, params),
        driveFetchOpts({ method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: cipher })
      );
      let data: any = null;
      try {
        data = await res.json();
      } catch {
        throw new Error(`Apps Script devolveu resposta inválida ao gravar o cofre (HTTP ${res.status}).`);
      }
      const f = driveFailure(data);
      if (f) {
        const err: any = new Error("Drive: " + f);
        err.retryable = !/token|inválid|invalid|vazio/i.test(f);
        throw err;
      }
      return { ok: true, provider: "google-drive", mode: "cors" };
    } catch (e: any) {
      if (!canJsonp() || /^Drive:/.test(e.message)) throw e;
      log("warn", "Gravação do cofre bloqueada pelo browser (CORS) — a enviar às cegas e a confirmar pela leitura.");
    }
  }

  await postOpaque(q(cfg.driveUrl, params), cipher);
  const back = await driveReadJson(cfg, { action: "vault", hash: vaultHash, token: cfg.driveToken }, true);
  const d2 = back.data;
  if (d2 && d2.ok === true && d2.cipher === cipher) {
    saveState({ driveMode: "compatível (JSONP)" });
    return { ok: true, provider: "google-drive", mode: "jsonp" };
  }
  if (d2 && d2.ok === false) {
    const e2: any = new Error("Drive: " + (d2.error || "falha a gravar o cofre"));
    e2.retryable = !/token|inválid|invalid|vazio/i.test(String(d2.error || ""));
    throw e2;
  }
  throw new Error("Drive: enviei o cofre mas não consegui confirmá-lo (modo compatível).");
}

async function driveGetVaultCipher(cfg: CloudConfig, vaultHash: string) {
  const res = await driveReadJson(cfg, { action: "vault", hash: vaultHash, token: cfg.driveToken });
  const data = res.data;
  if (data && data.ok === false) {
    if (data.code === "not_found" || /não encontrado|not found/i.test(String(data.error || ""))) {
      return { answered: true, data: null };
    }
    const err: any = new Error("Drive: " + (data.error || "falha a ler o cofre"));
    err.retryable = !/token|inválid/i.test(String(data.error || ""));
    throw err;
  }
  if (!data || !data.cipher) throw new Error("Drive: resposta sem o cofre.");
  return { answered: true, data: data.cipher, source: "google-drive" };
}

/** Lê o cofre (JSON encriptado) da melhor fonte disponível. */
export async function getVaultCipher(
  vaultHash: string
): Promise<{ data: string | null; source: string | null; readFailed: boolean; migrated?: boolean; failures?: string[] }> {
  const cfg = config();
  const providers = chain(cfg);
  const failures: string[] = [];
  let answered = false;
  if (vaultHash) saveState({ vaultHash: String(vaultHash).slice(0, 64) });

  for (const provider of providers) {
    if (provider === "legacy") {
      try {
        const legacy = await legacyReadVaultCipher(vaultHash);
        if (legacy && legacy.data) {
          log("info", `Cofre antigo encontrado (${legacy.source}).`);
          await migrateToDurable_(cfg, providers, vaultHash, legacy.data);
          saveState({ readFailedAt: 0 });
          return { data: legacy.data, source: legacy.source, readFailed: false, migrated: true };
        }
      } catch (e: any) {
        if (e && e.expired) log("warn", "Cofre antigo expirou ou está inacessível: " + e.message);
        else failures.push("legado " + e.message);
      }
      continue;
    }
    try {
      const out = provider === "r2" ? await r2GetVaultCipher(cfg, vaultHash) : await driveGetVaultCipher(cfg, vaultHash);
      if (out.answered) answered = true;
      if (out.data) {
        saveState({ readFailedAt: 0, lastProvider: provider });
        return { data: out.data, source: (out as any).source, readFailed: false };
      }
    } catch (e: any) {
      failures.push(`${provider === "r2" ? "R2" : "Drive"} ${e.message}`);
    }
  }

  const readFailed = !answered && failures.length > 0;
  if (readFailed) {
    lastError = failures.join(" | ");
    log("error", "Leitura da nuvem falhou: " + lastError);
    saveState({ readFailedAt: now() });
  } else if (failures.length) {
    log("warn", "Leitura concluída com avisos: " + failures.join(" | "));
  }
  return { data: null, source: null, readFailed, failures };
}

async function migrateToDurable_(cfg: CloudConfig, providers: string[], vaultHash: string, cipher: string) {
  const target = providers.filter((p) => p !== "legacy")[0];
  if (!target || !cfg.mirrorLegacy) return false;
  try {
    if (target === "r2") await r2PutVault(cfg, vaultHash, cipher);
    else await drivePutVault(cfg, vaultHash, cipher);
    log("info", `✅ Cofre antigo migrado para ${target === "r2" ? "o Cloudflare R2" : "o Google Drive"}.`);
    toastOnce("migrated", "✅ O teu cofre antigo (bytebin/kappa) foi migrado para a nuvem durável.", "success");
    return true;
  } catch (e: any) {
    log("warn", "Falha a migrar o cofre: " + e.message);
    return false;
  }
}

/** Grava o cofre encriptado. Devolve {ok, provider}. Lança erro real (sem catch{} vazio). */
export async function putVault(vaultHash: string, cipher: string): Promise<{ ok: boolean; provider: string }> {
  const cfg = config();
  if (vaultHash) saveState({ vaultHash: String(vaultHash).slice(0, 64) });
  const providers = chain(cfg).filter((p) => p !== "legacy");

  if (!providers.length) {
    log("warn", "Sem armazenamento durável — a gravar o cofre apenas nos hosts antigos.");
    const okLegacy = await legacyWriteVaultMirror(vaultHash, cipher).catch((e) => {
      lastError = e.message;
      return false;
    });
    if (!okLegacy)
      throw new Error("Falha ao salvar o cofre na nuvem (hosts antigos indisponíveis e nenhuma nuvem durável configurada).");
    return { ok: true, provider: "legacy" };
  }

  const failures: string[] = [];
  for (const provider of providers) {
    let attempt = 0;
    let lastErr: any = null;
    while (attempt < 3) {
      attempt++;
      try {
        const out = provider === "r2" ? await r2PutVault(cfg, vaultHash, cipher) : await drivePutVault(cfg, vaultHash, cipher);
        saveState({ readFailedAt: 0, lastProvider: provider });
        log("info", `Cofre gravado em ${provider === "r2" ? "R2" : "Drive"} (${fmtSize(cipher.length)}).`);
        if (cfg.mirrorLegacy) legacyWriteVaultMirror(vaultHash, cipher).catch(() => {});
        return out;
      } catch (e: any) {
        lastErr = e;
        lastError = e.message;
        log("warn", `putVault ${provider} tentativa ${attempt}/3 falhou: ${e.message}`);
        if (!e.retryable || attempt === 3) break;
        await sleep(600 * Math.pow(3, attempt - 1));
      }
    }
    failures.push(`${provider === "r2" ? "R2" : "Drive"}: ${lastErr?.message || lastErr}`);
  }
  throw new Error("Falha ao salvar o cofre na nuvem durável: " + failures.join(" | "));
}

/* -------------------------------------------- guarda anti-apagão de fila */

export function markReadFailure(readFailed: boolean) {
  saveState({ readFailedAt: readFailed ? now() : 0 });
}

export function noteQueueCount(n: number) {
  const count = Number(n) || 0;
  if (count > 0) saveState({ lastCloudQueueCount: count });
}

/** Impede sobrescrever o cofre com fila vazia quando a leitura da nuvem falhou. */
export function blockEmptyOverwrite(vault: any): boolean {
  const st = loadState();
  const queue = (vault && vault.queue) || [];
  if (queue.length > 0) return false;
  if (!st.readFailedAt || now() - st.readFailedAt > 10 * 60 * 1000) return false;
  if (!(st.lastCloudQueueCount > 0)) return false;
  log(
    "warn",
    `Bloqueada gravação de cofre vazio: a última leitura da nuvem falhou e existiam ${st.lastCloudQueueCount} Reels. Nada foi sobrescrito.`
  );
  toastOnce(
    "empty-overwrite",
    `🛡️ Sincronização protegida: não consegui ler a nuvem e não vou sobrescrever os ${st.lastCloudQueueCount} Reels que lá estão. Verifica a ligação e o URL/token nas Configurações.`,
    "warning",
    5 * 60 * 1000
  );
  return true;
}

/* --------------------- 🔒 claims (anti-publicação duplicada) */

/** Identificador estável deste aparelho — diz quem tem a claim. */
export function claimOwner(scope?: string): string {
  const st = loadState();
  let id = String(st.claimOwnerId || "");
  if (!id) {
    id = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
    saveState({ claimOwnerId: id });
  }
  return (scope ? scope + ":" : "") + id;
}

/** Chave da claim: por Reel e, quando conhecido, por cofre (multi-conta). */
export function claimKeyFor(item: string | { id?: string; vaultHash?: string }): string {
  const id = typeof item === "string" ? item : item && item.id;
  if (!id) return "";
  const st = loadState();
  const hash = String(((typeof item !== "string" && item && item.vaultHash) || st.vaultHash || "") as string).slice(0, 64);
  return "cc_" + (hash ? hash + "_" : "") + String(id).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}

function claimUnsupported(status: number, data: any): boolean {
  if (status === 404 || status === 405 || status === 501) return true;
  const err = String((data && data.error) || "");
  return /rota desconhecida|a[çc][ãa]o desconhecida|unknown (route|action)|n[ãa]o suportad/i.test(err);
}

async function r2Claim(cfg: CloudConfig, action: string, payload: any) {
  const res = await fetchJson(cfg.workerUrl + "/api/claims/" + action, {
    method: "POST",
    headers: authHeaders(cfg, { "Content-Type": "application/json", "X-Cineclip-Client": "web/" + VERSION }),
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  return { status: res.status, ok: res.ok, data: res.data };
}

async function driveClaimsLookup(cfg: CloudConfig, key: string, forceJsonp?: boolean) {
  const res = await driveReadJson(cfg, { action: "claims", token: cfg.driveToken }, forceJsonp);
  const data = res.data;
  if (!data || data.ok !== true || !Array.isArray(data.active)) return null;
  for (const c of data.active) {
    if (c && c.key === key) return c;
  }
  return null;
}

async function driveClaimPost(cfg: CloudConfig, action: string, payload: any, key: string, owner: string) {
  const body = JSON.stringify(payload);
  const params = { action, token: cfg.driveToken };
  const info = await driveInfo(cfg);

  if (info.readable !== false) {
    try {
      const res = await fetch(
        q(cfg.driveUrl, params),
        driveFetchOpts({ method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body })
      );
      let data: any = null;
      try {
        data = await res.json();
      } catch {
        throw new Error(`Apps Script devolveu resposta inválida em '${action}' (HTTP ${res.status}).`);
      }
      return { status: res.status, data };
    } catch (e) {
      if (!canJsonp()) throw e;
      log("warn", "Claim bloqueado pelo browser (CORS) — a enviar às cegas e a confirmar pela leitura.");
    }
  }

  await postOpaque(q(cfg.driveUrl, params), body);
  const holder = await driveClaimsLookup(cfg, key, true);

  if (action === "claim") {
    if (holder && holder.owner === owner) {
      return { status: 200, data: { ok: true, provider: "google-drive", acquired: true, claim: holder } };
    }
    if (holder) {
      return {
        status: 200,
        data: { ok: true, provider: "google-drive", acquired: false, holder: { owner: holder.owner, expiresAt: holder.expiresAt } },
      };
    }
    throw new Error("Drive: enviei a claim mas não consegui confirmá-la (modo compatível).");
  }

  if (holder && holder.owner !== owner) {
    return {
      status: 200,
      data: { ok: true, provider: "google-drive", released: false, holder: { owner: holder.owner, expiresAt: holder.expiresAt } },
    };
  }
  return { status: 200, data: { ok: true, provider: "google-drive", released: !holder } };
}

/**
 * Reclama um item antes de publicar.
 * ok:true → pode publicar (tenho a claim, ou o backend não suporta claims)
 * ok:false → NÃO publicar (reason:"held": outro dispositivo/Robô está a publicar)
 */
export async function claimPublish(item: any, opts: { owner?: string; ttlMs?: number; ownerLabel?: string } = {}): Promise<ClaimResult> {
  const key = claimKeyFor(item);
  if (!key) return { ok: true, degraded: true, reason: "sem_id" };

  const cfg = config();
  const owner = String(opts.owner || claimOwner("app")).slice(0, 120);
  const ttlMs = Number(opts.ttlMs || CLAIM_TTL_MS);
  const providers = chain(cfg).filter((p) => p !== "legacy");
  if (!providers.length) return { ok: true, degraded: true, reason: "sem_nuvem" };

  const problems: string[] = [];
  for (const provider of providers) {
    try {
      const out =
        provider === "r2"
          ? await r2Claim(cfg, "acquire", { key, owner, ttlMs })
          : await driveClaimPost(cfg, "claim", { key, owner, ttlMs }, key, owner);
      const data = (out && out.data) || {};
      if (claimUnsupported(out && out.status, data)) {
        problems.push(provider + ": claims não suportadas neste backend");
        continue;
      }
      if (data.ok === false) {
        problems.push(provider + ": " + (data.error || "erro devolvido pelo backend"));
        continue;
      }
      if (data.acquired === true) {
        saveState({ lastClaimAt: now(), lastClaimProvider: provider });
        log("info", `Claim obtida (${provider}) para ${key}.`);
        return {
          ok: true,
          provider,
          key,
          owner,
          expiresAt: (data.claim && data.claim.expiresAt) || now() + ttlMs,
          claim: data.claim || null,
          ownerLabel: opts.ownerLabel || owner,
        };
      }
      if (data.acquired === false) {
        if (data.holder && data.holder.owner === owner) {
          saveState({ lastClaimAt: now(), lastClaimProvider: provider });
          return {
            ok: true,
            provider,
            key,
            owner,
            expiresAt: data.holder.expiresAt || now() + ttlMs,
            claim: data.claim || null,
            ownerLabel: opts.ownerLabel || owner,
            recovered: true,
          };
        }
        return { ok: false, reason: "held", provider, key, owner, holder: data.holder || null };
      }
      problems.push(provider + ": resposta inesperada (" + JSON.stringify(data).slice(0, 120) + ")");
    } catch (e: any) {
      problems.push(provider + ": " + (e?.message || e));
    }
  }

  log("warn", `Claims indisponíveis (${problems.join(" | ")}) — a publicar sem proteção anti-duplicado.`);
  toastOnce(
    "claims-off",
    "⚠️ Proteção anti-publicação duplicada indisponível: o Worker/Apps Script configurado ainda não tem as rotas de claims. Publicação segue normalmente — atualiza o backend para evitar Reels repetidos.",
    "warning",
    10 * 60 * 1000
  );
  return { ok: true, degraded: true, key, owner, problems };
}

/** Liberta a claim (best-effort: se falhar, o TTL trata do assunto). */
export async function releaseClaim(claim: ClaimResult): Promise<{ ok: boolean; released?: boolean; skipped?: boolean; error?: string }> {
  if (!claim || !claim.ok || claim.degraded || !claim.key || !claim.owner) return { ok: true, skipped: true };
  try {
    const cfg = config();
    const out =
      claim.provider === "r2"
        ? await r2Claim(cfg, "release", { key: claim.key, owner: claim.owner })
        : await driveClaimPost(cfg, "release", { key: claim.key, owner: claim.owner }, claim.key, claim.owner);
    const data = (out && out.data) || {};
    if (data.released === true) {
      log("info", `Claim libertada (${claim.provider}) para ${claim.key}.`);
      return { ok: true, released: true };
    }
    return { ok: true, released: false };
  } catch (e: any) {
    log("warn", `Não consegui libertar a claim ${claim.key}: ${e?.message || e}`);
    return { ok: false, error: String(e?.message || e) };
  }
}

/** Texto para o utilizador quando o item está a ser publicado noutro lado. */
export function claimSkipMessage(claim: ClaimResult, title?: string): string {
  const holder = (claim && claim.holder && claim.holder.owner) || "outro dispositivo";
  const until = claim?.holder?.expiresAt ? new Date(claim.holder.expiresAt) : null;
  let hhmm = "";
  try {
    hhmm =
      until && !isNaN(until.getTime())
        ? until.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : "";
  } catch {
    /* ignore */
  }
  return (
    `⏳ ${title ? `"${title}" ` : "Este Reel "}já está a ser publicado por ${holder}` +
    (hhmm ? ` (claim válida até ${hhmm})` : "") +
    " — envio ignorado para não publicar duas vezes."
  );
}

/** Claims ativas em todos os backends (diagnóstico). */
export async function activeClaims(): Promise<{ provider: string; key: string; owner: string; expiresAt?: number }[]> {
  const cfg = config();
  const providers = chain(cfg).filter((p) => p !== "legacy");
  const out: any[] = [];
  for (const provider of providers) {
    try {
      let data: any = null;
      if (provider === "r2") {
        const res = await fetchJson(cfg.workerUrl + "/api/claims", {
          headers: authHeaders(cfg, { "X-Cineclip-Client": "web/" + VERSION }),
          cache: "no-store",
        });
        data = res.data;
      } else {
        data = (await driveReadJson(cfg, { action: "claims", token: cfg.driveToken })).data;
      }
      if (data && data.ok === true && Array.isArray(data.active)) {
        data.active.forEach((c: any) => {
          if (!c) return;
          out.push({ provider, key: c.key, owner: c.owner, expiresAt: c.expiresAt });
        });
      }
    } catch (e: any) {
      log("warn", `Não consegui listar as claims em ${provider}: ${e?.message || e}`);
    }
  }
  return out;
}

/* ------------------------------------------------------------ diagnóstico */

export async function checkR2(cfg: CloudConfig) {
  const out: any = { name: "Cloudflare R2", ok: false, message: "" };
  if (!cfg.workerUrl) {
    out.message = "não configurado";
    return out;
  }
  try {
    const health = await fetchJson(cfg.workerUrl + "/", { method: "GET", cache: "no-store" });
    if (!health.ok || !health.data || health.data.ok !== true) {
      out.message = "respondeu mas não parece ser o CineClip Cloud (HTTP " + health.status + ")";
      return out;
    }
    if (!health.data.bucket) {
      out.message = "no ar, mas sem o binding R2 (BUCKET)";
      return out;
    }
    out.presign = !!health.data.presign;
  } catch (e: any) {
    out.message = "inacessível: " + e.message;
    return out;
  }
  if (!cfg.token) {
    out.message = "no ar, mas falta o Token";
    return out;
  }
  try {
    const probe = "__healthcheck__";
    const put = await fetchJson(cfg.workerUrl + "/api/vault/" + probe, {
      method: "PUT",
      headers: authHeaders(cfg, { "Content-Type": "application/json" }),
      body: JSON.stringify({ probe: now() }),
    });
    if (!put.ok) {
      out.message = describeFailure(put.status, put.data);
      return out;
    }
    const get = await fetchJson(cfg.workerUrl + "/api/vault/" + probe, { headers: authHeaders(cfg), cache: "no-store" });
    await fetch(cfg.workerUrl + "/api/vault/" + probe, { method: "DELETE", headers: authHeaders(cfg) }).catch(() => {});
    if (!get.ok) {
      out.message = describeFailure(get.status, get.data);
      return out;
    }
    const stats = await fetchJson(cfg.workerUrl + "/api/stats", { headers: authHeaders(cfg), cache: "no-store" });
    if (stats.ok && stats.data) out.stats = stats.data;
  } catch (e: any) {
    out.message = "erro no teste de escrita/leitura: " + e.message;
    return out;
  }
  out.ok = true;
  out.message =
    "ligado ✔ (" +
    (out.stats ? `${out.stats.videos} vídeo(s), ${out.stats.vaults} cofre(s), ${fmtSize(out.stats.bytes)}` : "escrita e leitura OK") +
    (out.presign ? " · presign ativo (>100 MB)" : " · presign desativado (limite 100 MB)") +
    ")";
  return out;
}

export async function checkDrive(cfg: CloudConfig) {
  const out: any = { name: "Google Drive (Apps Script)", ok: false, message: "" };
  if (!cfg.driveUrl) {
    out.message = "não configurado";
    return out;
  }
  const healthUrl = q(cfg.driveUrl, { action: "health" });
  const urlLocal =
    /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(cfg.driveUrl) || sameTarget(cfg.driveUrl, window.location.origin);
  if (!/^https:\/\//i.test(cfg.driveUrl) && !urlLocal) {
    out.message = `o URL tem de começar por https:// (recebi: ${cfg.driveUrl.slice(0, 60)}). Copia o URL da implantação em Implantar → Gerir implantações.`;
    return out;
  }
  if (/\/dev(\?|$)/.test(cfg.driveUrl)) {
    out.message = "esse é o URL de desenvolvimento (/dev), que só funciona para ti com sessão iniciada. Usa o URL da implantação (/exec): Implantar → Gerir implantações → URL da app da Web.";
    return out;
  }
  if (cfg.driveUrl.indexOf("script.google.com/macros/s/") < 0 && cfg.driveUrl.indexOf(window.location.hostname) < 0) {
    log("warn", "URL do Apps Script invulgar (esperava script.google.com/macros/s/…): " + cfg.driveUrl);
  }

  try {
    const health = await driveReadJson(cfg, { action: "health" });
    const f = driveFailure(health.data);
    if (f || !health.data || health.data.ok !== true) {
      out.message = f || "respondeu mas não parece ser o backend CineClip (HTTP " + health.status + ")";
      return out;
    }
    out.service = health.data.service;
  } catch (e: any) {
    const why = await probeBlocked(healthUrl);
    out.hint = why;
    if (why === "blocked") {
      out.message =
        "o Apps Script RESPONDEU mas o browser bloqueou a leitura (CORS/cookies de terceiros). " +
        (inIframe()
          ? "Estás com o app dentro de um iframe (pré-visualização): abre-o num separador normal do browser e volta a testar."
          : "Desativa extensões/bloqueadores para script.google.com, ou sai da navegação anónima, e volta a testar. Teste direto: " + healthUrl);
    } else if (why === "unreachable") {
      out.message =
        `não consegui chegar ao URL (${e.message}). Faz este teste num separador: ${healthUrl}` +
        " · se devolver JSON, o problema é só deste lado (browser/extensão); " +
        "se pedir para iniciar sessão ou autorizar, corre a função setup() no editor do Apps Script, autoriza e cria uma NOVA VERSÃO da implantação; " +
        "se der erro/404, confirma 'Quem pode aceder: Qualquer pessoa'.";
    } else {
      out.message = `inacessível: ${e.message} (confirma que o deploy é 'App da Web' com acesso 'Qualquer pessoa')`;
    }
    return out;
  }
  if (!cfg.driveToken) {
    out.message = "no ar, mas falta o Token (corre a função setup() no Apps Script)";
    return out;
  }
  const probeCipher = JSON.stringify({ probe: now() });
  const info2 = await driveInfo(cfg);
  const forceJsonp = info2.readable === false;
  out.mode = forceJsonp ? "compatível (JSONP)" : "direto (CORS)";
  try {
    const probeHash = "healthcheck";
    const putRes = await drivePutVault(cfg, probeHash, probeCipher);
    out.mode = (putRes as any).mode === "jsonp" ? "compatível (JSONP)" : "direto (CORS)";
    const get = await driveReadJson(cfg, { action: "vault", hash: probeHash, token: cfg.driveToken }, forceJsonp);
    const gf = driveFailure(get.data);
    if (gf || !get.data || !get.data.cipher) {
      out.message = gf || "gravei o cofre de teste mas não o consegui ler de volta";
      return out;
    }
    if (get.data.cipher !== probeCipher) {
      out.message = "gravei o cofre de teste mas o que li de volta é diferente";
      return out;
    }
    const stats = await driveReadJson(cfg, { action: "stats", token: cfg.driveToken }, forceJsonp);
    if (!driveFailure(stats.data) && stats.data) out.stats = stats.data;
  } catch (e: any) {
    out.message = "erro no teste de escrita/leitura: " + e.message;
    return out;
  }
  out.ok = true;
  out.message =
    "ligado ✔ (" +
    (out.stats ? `${out.stats.videos} vídeo(s), ${out.stats.vaults} cofre(s), ${fmtSize(out.stats.bytes)}` : "escrita e leitura OK") +
    ` · blocos de ${fmtSize(info2.chunkBytes || cfg.driveChunkBytes)} · modo ${out.mode})`;
  return out;
}

export async function healthCheck() {
  const cfg = config();
  const report: any = { ok: false, provider: "none", order: chain(cfg), steps: [], config: {
    r2WorkerUrl: cfg.workerUrl,
    r2TokenSet: !!cfg.token,
    driveScriptUrl: cfg.driveUrl,
    driveTokenSet: !!cfg.driveToken,
    maxMb: cfg.maxMb,
  } };
  const r2 = await checkR2(cfg);
  const drive = await checkDrive(cfg);
  report.r2 = r2;
  report.drive = drive;
  report.steps.push("R2: " + r2.message);
  report.steps.push("Drive: " + drive.message);

  let winner: any = null;
  if (cfg.provider === "r2") winner = r2.ok ? r2 : null;
  else if (cfg.provider === "drive") winner = drive.ok ? drive : null;
  else winner = r2.ok ? r2 : drive.ok ? drive : null;

  if (winner) {
    report.ok = true;
    report.provider = winner === r2 ? "cloudflare-r2" : "google-drive";
    report.stats = winner.stats;
    report.presign = winner.presign === true;
    report.message = winner.name + " " + winner.message;
    log("info", "Health check OK: " + report.message);
    return report;
  }
  if (!cfg.workerUrl && !cfg.driveUrl) {
    report.message = "Nenhuma nuvem durável configurada. Cola o URL do Google Apps Script (grátis, sem cartão) ou do Cloudflare Worker em Configurações → Nuvem durável.";
  } else {
    report.message = `Nenhum backend passou no teste. R2: ${r2.message} · Drive: ${drive.message}`;
  }
  return report;
}

export function diagnostics() {
  const cfg = config();
  return {
    version: VERSION,
    configured: configured(),
    order: chain(cfg),
    provider: configured() ? chain(cfg)[0] : "legacy-temporario",
    r2WorkerUrl: cfg.workerUrl || "(não configurado)",
    driveScriptUrl: cfg.driveUrl || "(não configurado)",
    maxMb: cfg.maxMb,
    driveChunkMb: Math.round(cfg.driveChunkBytes / 1048576),
    presign: cfg.presign,
    mirrorLegacy: cfg.mirrorLegacy,
    lastProvider: loadState().lastProvider || null,
    lastError: lastError || null,
    state: loadState(),
    log: memoryLog.slice(-40),
  };
}

export function report(): string {
  const d = diagnostics();
  const lines = [
    "CineCloud " + d.version,
    "ordem: " + d.order.join(" → "),
    "provider ativo: " + d.provider,
    "R2: " + d.r2WorkerUrl,
    "Drive: " + d.driveScriptUrl,
    `maxMb: ${d.maxMb} · driveChunkMb: ${d.driveChunkMb}`,
    "último provider usado: " + d.lastProvider,
    "lastError: " + d.lastError,
    "--- log ---",
  ];
  (d.log as LogEntry[]).forEach((e) => lines.push(`${e.t} [${e.level}] ${e.message}`));
  return lines.join("\n");
}

export const getLastError = () => lastError;

log("info", `CineCloud ${VERSION} carregado (${configured() ? "providers: " + chain().join(" → ") : "SEM nuvem durável — a usar hosts temporários"})`);
