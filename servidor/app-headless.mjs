/**
 * Arranca o CineClip (index.html + nuvem-duravel.js + lote-massa.js) num DOM
 * simulado (jsdom) para o servidor usar EXATAMENTE o mesmo código do site:
 *   • window.CineClipCore — identificar o filme, gancho, legenda, TMDB, horários;
 *   • window.CineLote._interno.processarItem — o fluxo do lote (90 s, regra de
 *     confiança, gancho de reserva, montagem do Reel).
 * As partes que precisam de <video>/<canvas>/WebAssembly são trocadas pelas do
 * FFmpeg nativo (servidor/video.mjs) quando o trabalhador processa um vídeo.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function arrancarApp({ site = "https://cine-flowx.vercel.app", raiz = RAIZ, fetchFn = fetch } = {}) {
  const { JSDOM } = await import("jsdom");
  const { indexedDB, IDBKeyRange } = await import("fake-indexeddb");
  const html = fs.readFileSync(path.join(raiz, "index.html"), "utf8");
  const m = /<script type="module">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error("index.html sem o bundle do app.");
  const modulo = m[1].replace(/import\.meta\.url/g, JSON.stringify(site + "/index.html"));

  const dom = new JSDOM(html, { url: site + "/", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  window.indexedDB = indexedDB;
  window.IDBKeyRange = IDBKeyRange;
  window.TextEncoder = globalThis.TextEncoder;
  window.TextDecoder = globalThis.TextDecoder;
  try {
    Object.defineProperty(window, "crypto", { value: globalThis.crypto, configurable: true });
  } catch {}
  // As chamadas do app (NVIDIA pelo proxy /api/public/nvidia, Gemini, TMDB) saem do
  // servidor; os endereços relativos resolvem-se contra o site publicado.
  window.fetch = (url, opts) => fetchFn(new URL(String(url), site + "/").toString(), opts);
  window.AbortSignal = globalThis.AbortSignal;
  window.AbortController = globalThis.AbortController;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.HTMLMediaElement.prototype.load = () => {};
  window.HTMLMediaElement.prototype.play = () => Promise.resolve();
  window.scrollTo = () => {};
  window.URL.createObjectURL = () => "blob:servidor";
  window.URL.revokeObjectURL = () => {};
  const registos = [];
  for (const n of ["log", "info", "debug", "warn", "error"]) window.console[n] = (...a) => registos.push(`${n}: ${a.map(String).join(" ")}`.slice(0, 500));
  // O botão flutuante e o aviso de link copiado não fazem sentido no servidor.
  window.localStorage.setItem("cineclip.lote.opcoes", JSON.stringify({ botaoColar: false, avisarLinkCopiado: false, processarLinksDoCelular: false }));

  window.eval(fs.readFileSync(path.join(raiz, "nuvem-duravel.js"), "utf8"));
  window.eval(fs.readFileSync(path.join(raiz, "lote-massa.js"), "utf8"));
  window.eval(modulo);

  const inicio = Date.now();
  while (!(window.CineClipCore && window.CineLote && window.CineLote._interno)) {
    if (Date.now() - inicio > 20000) throw new Error("O app não arrancou no servidor (sem CineClipCore). " + registos.slice(-3).join(" | "));
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    window,
    core: window.CineClipCore,
    lote: window.CineLote._interno,
    registos,
    fechar: () => window.close(),
  };
}
