#!/usr/bin/env node
/**
 * Teste de ponta a ponta do servidor na nuvem (servidor/).
 *
 *   node tools/test-servidor.mjs
 *
 * Usa o código REAL: a cifra do cofre (comparada com a do app), o app CineClip
 * a correr no servidor (IA, TMDB, fluxo do lote) e o FFmpeg nativo sobre um
 * vídeo H.265 1080×1920 com faixas pretas gerado na hora. São simulados só os
 * serviços externos: Worker R2 (cofre, vídeos, claims), TikTok, NVIDIA e TMDB.
 *
 * Precisa de: ffmpeg/ffprobe com libx265, jsdom, fake-indexeddb, @napi-rs/canvas
 * (npm install --prefix servidor). Sem eles, salta.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
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

try {
  execFileSync("ffmpeg", ["-hide_banner", "-encoders"]).toString().includes("libx265") || (() => { throw 0; })();
  // As dependências do servidor vivem em servidor/node_modules (npm install --prefix servidor).
  const v = await import("../servidor/video.mjs");
  const f = await v.fontesDisponiveis();
  if (!f.inter) throw 0;
  await import("../servidor/app-headless.mjs").then((m) => m.arrancarApp).then((fn) => typeof fn === "function" || (() => { throw 0; })());
  await import(new URL("../servidor/node_modules/jsdom/lib/api.js", import.meta.url).href).catch(() => import("jsdom"));
} catch {
  console.log("\n⚠️  Falta ffmpeg (com libx265), jsdom, fake-indexeddb ou @napi-rs/canvas — teste do servidor saltado.\n");
  process.exit(0);
}

const { cifrar, decifrar, lerConfigDoRobo } = await import("../servidor/cofre.mjs");
const video = await import("../servidor/video.mjs");
const { arrancarApp } = await import("../servidor/app-headless.mjs");
const { criarTrabalhador } = await import("../servidor/trabalhador.mjs");

console.log("\n☁️  Servidor na nuvem\n");

/* ------------------------------------------------------------------ 1 */
console.log("1. O cofre é o mesmo do app");
{
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const mod = /<script type="module">([\s\S]*?)<\/script>/.exec(html)[1];
  const extrair = (ini) => {
    const a = mod.indexOf(ini);
    let i = mod.indexOf("{", a);
    let n = 0;
    for (; i < mod.length; i++) {
      if (mod[i] === "{") n++;
      else if (mod[i] === "}" && --n === 0) return mod.slice(a, i + 1);
    }
  };
  const ctx = vm.createContext({ btoa, atob, crypto: globalThis.crypto, TextEncoder, TextDecoder, JSON, Uint8Array, Uint32Array, Math, String, Array });
  vm.runInContext(["function Qc(", "function mo(", "function Rg(", "async function bS(", "async function Gm(", "async function wS("].map(extrair).join("\n"), ctx);
  const chave = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const obj = { version: 1, queue: [{ id: "r1", title: "Ação 🎬" }], linksCelular: [{ id: "x", estado: "pendente" }] };
  check("o servidor lê o cofre gravado pelo app", JSON.stringify(await decifrar(await ctx.bS(obj, chave), chave)) === JSON.stringify(obj));
  check("o app lê o cofre gravado pelo servidor", JSON.stringify(await ctx.Gm(cifrar(obj, chave), chave)) === JSON.stringify(obj));
}

/* ------------------------------------------------------------------ 2 */
console.log("\n2. Configuração a partir do código do Robô 24h");
const ROBO = `// Conta vinculada: ronan
const VAULT_HASH = "abc123cofre";
const ENCRYPTION_KEY_B64 = "${Buffer.alloc(32, 7).toString("base64")}";
const R2_WORKER_URL = "https://cineclip-cloud.teste.workers.dev";
const R2_TOKEN = "token-r2";
const DRIVE_SCRIPT_URL = "";
const DRIVE_TOKEN = "";`;
const cfg = { ...lerConfigDoRobo(ROBO), SITE: "https://cine-flowx.vercel.app", NOME_SERVIDOR: "teste" };
check("lê cofre, chave, R2 e conta", cfg.VAULT_HASH === "abc123cofre" && cfg.R2_TOKEN === "token-r2" && cfg.CONTA === "ronan");
let erroCfg = null;
try { lerConfigDoRobo("const VAULT_HASH = \"x\";"); } catch (e) { erroCfg = e; }
check("código incompleto → explica o que falta", erroCfg && /ENCRYPTION_KEY_B64/.test(erroCfg.message));

/* ------------------------------------------------------- vídeo de teste */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cineclip-servidor-teste-"));
const fonte = path.join(tmp, "tiktok_hevc.mp4");
execFileSync("ffmpeg", ["-v", "error", "-y",
  "-f", "lavfi", "-i", "testsrc2=size=1080x1040:rate=30:duration=8",
  "-f", "lavfi", "-i", "sine=frequency=440:duration=8",
  "-filter_complex", "[0:v]pad=1080:1920:0:440:black,format=yuv420p[v]",
  "-map", "[v]", "-map", "1:a", "-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error", "-tag:v", "hvc1",
  "-c:a", "aac", "-metadata", "title=VIDEO DO AUTOR", "-metadata", "comment=baixado do tiktok", fonte]);
const bytesFonte = fs.readFileSync(fonte);

/* -------------------------------------------- serviços simulados (HTTP) */
const R2 = cfg.R2_WORKER_URL;
const nuvem = { cofre: null, videos: {}, claims: {}, gravacoes: 0 };
const pedidosIA = [];

function json(status, corpo) {
  return new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });
}
function paginaTikTok(id, autor) {
  const item = {
    id, desc: "corte", author: { uniqueId: autor },
    video: { duration: 8, bitrateInfo: [{ CodecType: "h264", PlayAddr: { UrlKey: "v1_h264_1080p_900000", UrlList: [`https://v16.tiktokcdn.com/${id}.mp4`] } }] },
  };
  const dados = { __DEFAULT_SCOPE__: { "webapp.video-detail": { statusCode: 0, itemInfo: { itemStruct: item } } } };
  return `<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(dados)}</script></html>`;
}
const respostasIA = {
  normal: { titulo: "O Labirinto do Tempo", titulo_original: "Time Maze", ano: 2019, tipo: "movie", confianca: 92, atores: [], cena: "Ele percebe que a cerca não era para os animais", ganchos: ["Ele achou que a cerca era para os animais 😱"] },
  duvida: { titulo: "Talvez Este", titulo_original: "Maybe This", ano: 2010, tipo: "movie", confianca: 40, atores: [], cena: "cena", ganchos: ["gancho"] },
};

async function fetchFalso(url, opts = {}) {
  const u = new URL(String(url));
  const metodo = String(opts.method || "GET").toUpperCase();
  // Worker R2
  if (u.origin === R2) {
    if (u.pathname === `/api/vault/cc_${cfg.VAULT_HASH}`) {
      if (opts.headers?.Authorization !== "Bearer token-r2") return json(401, { error: "token" });
      if (metodo === "PUT") {
        nuvem.cofre = String(opts.body);
        nuvem.gravacoes++;
        return json(200, { ok: true });
      }
      return nuvem.cofre ? new Response(nuvem.cofre, { status: 200 }) : json(404, { error: "not_found" });
    }
    if (u.pathname === "/api/video" && metodo === "POST") {
      const nome = opts.headers["X-File-Name"];
      const key = "videos/" + Date.now() + "_" + nome;
      nuvem.videos[key] = Buffer.from(opts.body);
      return json(200, { ok: true, url: `${R2}/v/${encodeURIComponent(key)}`, key, size: nuvem.videos[key].length });
    }
    if (u.pathname === "/api/claims/acquire") {
      const b = JSON.parse(opts.body);
      nuvem.claims[b.key] = b;
      return json(200, { ok: true, acquired: true, claim: b });
    }
  }
  // TikTok
  if (u.hostname === "vm.tiktok.com") {
    const id = u.pathname.includes("duvida") ? "7400000000000000002" : u.pathname.includes("apagado") ? "apagado" : "7400000000000000001";
    return new Response(null, { status: 301, headers: { location: `https://www.tiktok.com/@autor/video/${id}` } });
  }
  if (u.hostname === "www.tiktok.com") {
    if (u.pathname.includes("apagado")) return new Response("", { status: 404 });
    const id = u.pathname.split("/").pop();
    return new Response(paginaTikTok(id, "autor"), { status: 200, headers: { "content-type": "text/html" } });
  }
  if (u.hostname === "v16.tiktokcdn.com") {
    return new Response(bytesFonte, { status: 200, headers: { "content-type": "video/mp4", "content-length": String(bytesFonte.length) } });
  }
  if (u.hostname === "www.tikwm.com") return json(200, { code: -1, msg: "não usado" });
  // NVIDIA (pelo proxy do site)
  if (u.origin === cfg.SITE && u.pathname === "/api/public/nvidia") {
    const corpo = JSON.parse(opts.body || "{}");
    const texto = JSON.stringify(corpo.messages);
    pedidosIA.push(texto.slice(0, 200));
    let conteudo;
    if (/especialista mundial em identificação/.test(texto)) {
      conteudo = JSON.stringify(/7400000000000000002/.test(texto) ? respostasIA.duvida : respostasIA.normal);
    } else if (/GANCHOS VIRAIS/.test(texto)) {
      conteudo = JSON.stringify({ cena: "cena", ganchos: ["Gancho reserva 🔥"] });
    } else {
      conteudo = "QUER ASSISTIR A ESTE FILME? LINK NA BIO! 🎬\n\nEle achou que estava seguro.\n\nA cena que **muda tudo**.\n\n#Filme #Suspense";
    }
    return json(200, { choices: [{ message: { content: conteudo } }] });
  }
  // TMDB
  if (u.hostname === "api.themoviedb.org") {
    if (u.pathname.startsWith("/3/search/movie")) {
      const q = u.searchParams.get("query") || "";
      return json(200, { results: [{ id: q.includes("Maybe") ? 22 : 11, title: q.includes("Maybe") ? "Talvez Este" : "O Labirinto do Tempo", original_title: q.includes("Maybe") ? "Maybe This" : "Time Maze", release_date: q.includes("Maybe") ? "2010-01-01" : "2019-05-01", overview: "Sinopse.", poster_path: "/p.jpg", popularity: 50 }] });
    }
    if (u.pathname.startsWith("/3/search/")) return json(200, { results: [] });
    if (/^\/3\/movie\/\d+$/.test(u.pathname)) {
      const id = Number(u.pathname.split("/").pop());
      return json(200, { id, title: id === 22 ? "Talvez Este" : "O Labirinto do Tempo", original_title: id === 22 ? "Maybe This" : "Time Maze", release_date: id === 22 ? "2010-01-01" : "2019-05-01", overview: "Sinopse oficial.", poster_path: "/p.jpg", genres: [{ name: "Suspense" }], popularity: 50 });
    }
  }
  return new Response("sem rota: " + url, { status: 599 });
}

/* -------------------------------------------------------- cofre inicial */
const agora = Date.now();
const CONTA = { id: "acc_cena", name: "@cena.oculta", dailySlots: ["12:00", "18:00"] };
const app = await arrancarApp({ site: cfg.SITE, fetchFn: fetchFalso });
const primeiroHorario = app.core.proximoHorario([], CONTA.dailySlots, CONTA.id);
nuvem.cofre = cifrar({
  version: 1,
  updatedAt: agora,
  settings: { nvidiaKey: "nv-teste", geminiKey: "", tmdbKey: "tmdb-teste", lang: "pt-BR", resolution: "720", overlayText: "Você precisa assistir esse filme 😳", bold: true },
  accounts: [{ id: "acc_outra", name: "@outra", dailySlots: ["09:00"] }, CONTA],
  activeAccountId: "acc_outra",
  queue: [{ id: "reel_existente", accountId: "acc_cena", status: "scheduled", scheduledAt: primeiroHorario, title: "Já agendado", createdAt: agora }],
  deletedReelIds: [],
  history: [],
  linksCelular: [
    { id: "lk_ok", url: "https://vm.tiktok.com/ZMok/", destino: "nuvem", contaId: "acc_cena", aparelho: "ap_cel", estado: "pendente", criadoEm: agora, atualizadoEm: agora },
    { id: "lk_pc", url: "https://vm.tiktok.com/ZMpc/", destino: "pc", aparelho: "ap_cel", estado: "pendente", criadoEm: agora, atualizadoEm: agora },
    { id: "lk_duvida", url: "https://vm.tiktok.com/duvida/", destino: "nuvem", contaId: "acc_cena", aparelho: "ap_cel", estado: "pendente", criadoEm: agora, atualizadoEm: agora },
    { id: "lk_apagado", url: "https://vm.tiktok.com/apagado/", destino: "nuvem", aparelho: "ap_cel", estado: "pendente", criadoEm: agora, atualizadoEm: agora },
  ],
}, cfg.ENCRYPTION_KEY_B64);

/* ------------------------------------------------------------------ 3 */
console.log("\n3. Um ciclo do servidor (vídeo H.265 real, código do app, FFmpeg nativo)");
const registos = [];
const pastaDados = path.join(tmp, "dados");
const trabalhador = criarTrabalhador({ cfg, app, pastaDados, fetchFn: fetchFalso, log: (...a) => registos.push(a.join(" ")) });
const t0 = Date.now();
const r1 = await trabalhador.ciclo();
const segundos = ((Date.now() - t0) / 1000).toFixed(1);
let cofre = await decifrar(nuvem.cofre, cfg.ENCRYPTION_KEY_B64);
const links = Object.fromEntries(cofre.linksCelular.map((e) => [e.id, e]));
const novo = cofre.queue.find((r) => r.id !== "reel_existente");
check(`trata os 3 links da nuvem (${segundos}s)`, r1.processados === 3, JSON.stringify(r1));
check("o Reel entra na fila do cofre", !!novo, registos.join(" | "));
if (novo) {
  check("na conta do link (não na conta ativa)", novo.accountId === "acc_cena");
  check("filme do TMDB", novo.title === "O Labirinto do Tempo" && String(novo.year) === "2019" && /p\.jpg/.test(novo.poster || ""));
  check("gancho da IA", novo.hookText === "Ele achou que a cerca era para os animais 😱");
  check("legenda da IA, limpa pelo app", /QUER ASSISTIR/.test(novo.caption) && !novo.caption.includes("**"));
  check("horário livre (não em cima do Reel já agendado)", novo.scheduledAt !== primeiroHorario && /T(12|18):00$/.test(novo.scheduledAt), novo.scheduledAt);
  check("estado scheduled, para o Robô 24h publicar", novo.status === "scheduled" && Array.isArray(novo.platforms));
  check("vídeo no R2 (link /v/…), sem blob no cofre", /\/v\//.test(novo.remoteVideoUrl) && !("videoBlob" in novo) && novo.cloudProvider === "r2");
  check("marca a origem", novo.origem === "nuvem" && novo.linkOrigem === "https://vm.tiktok.com/ZMok/");
}
check("link marcado como feito, com o Reel", links.lk_ok.estado === "feito" && novo && links.lk_ok.reelId === novo.id);
check("o link para o PC fica intacto", links.lk_pc.estado === "pendente");
check("pouca certeza → «revisar», sem Reel", links.lk_duvida.estado === "revisar" && /40%/.test(links.lk_duvida.erro || ""), links.lk_duvida.erro);
check("vídeo apagado → «erro» com o motivo", links.lk_apagado.estado === "erro" && /não existe/.test(links.lk_apagado.erro || ""), links.lk_apagado.erro);
check("o Reel existente continua lá", cofre.queue.some((r) => r.id === "reel_existente"));
check("sinal de vida para o app («☁️ Servidor ligado»)", !!nuvem.claims[`cc_${cfg.VAULT_HASH}_servidor_nuvem`] && nuvem.claims[`cc_${cfg.VAULT_HASH}_servidor_nuvem`].owner === "servidor:teste");
check("a IA foi chamada pelo proxy do site", pedidosIA.length >= 2);

/* ------------------------------------------------------------------ 4 */
console.log("\n4. O vídeo que vai para o Instagram");
const chaves = Object.keys(nuvem.videos);
check("um vídeo enviado (os links com erro não geram vídeo)", chaves.length === 1, String(chaves.length));
if (chaves.length) {
  const final = path.join(tmp, "final.mp4");
  fs.writeFileSync(final, nuvem.videos[chaves[0]]);
  const p = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height:format=duration:format_tags", "-of", "json", final]).toString());
  const v = p.streams.find((s) => s.codec_type === "video");
  check("H.264 720×1280 (9:16) a partir de um H.265", v.codec_name === "h264" && v.width === 720 && v.height === 1280);
  check("com áudio AAC", p.streams.some((s) => s.codec_type === "audio" && s.codec_name === "aac"));
  check("duração do original (8 s)", Math.abs(Number(p.format.duration) - 8) < 0.5, p.format.duration);
  const tags = JSON.stringify(p.format.tags || {});
  check("metadados do autor removidos", !/VIDEO DO AUTOR|baixado do tiktok/i.test(tags), tags);
  // As faixas pretas do original foram cortadas: no topo (abaixo do gancho) a imagem tem cor.
  const px = execFileSync("ffmpeg", ["-v", "error", "-ss", "2", "-i", final, "-frames:v", "1", "-vf", "crop=720:4:0:400,scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  check("as faixas pretas do original não aparecem no 9:16", px[0] + px[1] + px[2] > 60, [...px].join(","));
}

/* ------------------------------------------------------------------ 5 */
console.log("\n5. Sincronização do app a atropelar o servidor");
{
  const enviadosAntes = Object.keys(nuvem.videos).length;
  const r2 = await trabalhador.ciclo();
  check("sem links pendentes, o ciclo não faz nada", r2.processados === 0 && Object.keys(nuvem.videos).length === enviadosAntes);
  // Um celular gravou o cofre por cima: o Reel sumiu e o link voltou a pendente.
  const c = await decifrar(nuvem.cofre, cfg.ENCRYPTION_KEY_B64);
  c.queue = c.queue.filter((r) => r.id === "reel_existente");
  c.linksCelular.find((e) => e.id === "lk_ok").estado = "pendente";
  nuvem.cofre = cifrar(c, cfg.ENCRYPTION_KEY_B64);
  await trabalhador.ciclo();
  const depois = await decifrar(nuvem.cofre, cfg.ENCRYPTION_KEY_B64);
  check("repõe o Reel sem processar de novo", depois.queue.some((r) => novo && r.id === novo.id) && Object.keys(nuvem.videos).length === enviadosAntes);
  check("e volta a marcar o link como feito", depois.linksCelular.find((e) => e.id === "lk_ok").estado === "feito");
}

/* ------------------------------------------------------------------ 6 */
console.log("\n6. «Agendar mesmo assim» depois de rever");
{
  const c = await decifrar(nuvem.cofre, cfg.ENCRYPTION_KEY_B64);
  const e = c.linksCelular.find((x) => x.id === "lk_duvida");
  Object.assign(e, { estado: "pendente", tentativa: 1, forcar: true, erro: "" });
  nuvem.cofre = cifrar(c, cfg.ENCRYPTION_KEY_B64);
  await trabalhador.ciclo();
  const depois = await decifrar(nuvem.cofre, cfg.ENCRYPTION_KEY_B64);
  const ligado = depois.linksCelular.find((x) => x.id === "lk_duvida");
  check("o servidor agenda o vídeo de pouca certeza quando o utilizador manda", ligado.estado === "feito" && depois.queue.some((r) => r.id === ligado.reelId && r.title === "Talvez Este"), JSON.stringify(ligado));
}

app.fechar();
fs.rmSync(tmp, { recursive: true, force: true });

console.log("\n─────────────────────────────────────────────");
if (fail) {
  console.log(`❌ ${pass} passaram, ${fail} falharam:`);
  for (const f of falhas) console.log(`   • ${f}`);
  console.log("\nRegistos do servidor:\n  " + registos.join("\n  "));
  process.exit(1);
}
console.log(`✅ ${pass} passaram, 0 falharam`);
process.exit(0);
