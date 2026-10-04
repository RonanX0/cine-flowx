/** Utilidades pequenas partilhadas. */

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function fmtSize(bytes: number | null | undefined): string {
  if (bytes == null || Number.isNaN(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function fmtDuration(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

export function b64(bytes: Uint8Array | ArrayBuffer): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (let i = 0; i < u8.byteLength; i++) out += String.fromCharCode(u8[i]);
  return btoa(out);
}

export function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

export function hex(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(u8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Remove negrito markdown (**texto** → texto). */
export const stripMd = (s: string) => s.replace(/\*\*(.+?)\*\*/g, "$1").trim();

/** Normaliza texto para comparação (sem acentos/pontuação). */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const pad2 = (n: number) => String(n).padStart(2, "0");

/** YYYY-MM-DDTHH:MM local. */
export function localDateTime(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function dayLabel(key: string, long = false): string {
  const today = new Date();
  const t0 = localDayKey(today);
  const t1 = localDayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1));
  const tm = localDayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1));
  if (key === t0) return long ? "Hoje" : "Hoje";
  if (key === t1) return "Amanhã";
  if (key === tm) return "Ontem";
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1);
  return dt.toLocaleDateString("pt", long ? { weekday: "long", day: "2-digit", month: "long" } : { weekday: "short", day: "2-digit", month: "2-digit" });
}

export const uid = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

/** Eleva a capa do TMDB para w780 (o Instagram aceita melhor). */
export function boostPoster(poster?: string): string {
  if (!poster || !poster.trim()) return "";
  return poster.trim().replace(/\/t\/p\/w(92|154|185|300|342|500)\//, "/t/p/w780/");
}

export class HttpError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

/** fetch com timeout e mensagem de rede amigável. */
export async function fetchTimeout(
  label: string,
  url: string,
  init?: RequestInit,
  timeoutMs = 30000
): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } catch (e: any) {
    if (e?.name === "AbortError")
      throw new HttpError(`Tempo esgotado ao contactar o ${label}. Verifica a tua ligação.`, 0);
    throw new HttpError(`Falha de rede ao contactar o ${label}.`, 0);
  } finally {
    clearTimeout(t);
  }
}
