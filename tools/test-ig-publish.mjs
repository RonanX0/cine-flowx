#!/usr/bin/env node
/**
 * Testes da publicação de Reels do CineClip (bloco 24-ig-2207077 do bundle).
 *
 * O bundle não tem src/: o código publicado vive dentro de index.html. Este teste
 * extrai o bloco marcado entre `async function mS(r){` e `/* ==CINECLIP-IG-FIM== *​/`
 * e corre-o num contexto `vm` com a API do Instagram, o host rupload.facebook.com e
 * o XHR falsos. Assim dá para provar, sem internet e sem conta Meta, que:
 *
 *   • o envio direto (upload_type=resumable) publica sem precisar de link público;
 *   • quando o navegador bloqueia o envio direto, cai para o video_url;
 *   • um 2207077 no video_url é repetido com um container NOVO e outra estratégia;
 *   • links temporários/expirados são renovados antes de gastar a tentativa;
 *   • erros permanentes (2207042/2207026/2207050/2207051) não são repetidos;
 *   • o bloco é AUTOSSUFICIENTE: não chama nenhum helper que só exista no bundle que o
 *     envolve (regressão do `hS is not defined`, que bloqueava a publicação em produção).
 *
 *   node tools/test-ig-publish.mjs
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import {
  INICIO_BLOCO_IG,
  FIM_BLOCO_IG,
  analisarAutossuficiencia,
} from "./ig-block.mjs";

const root = path.resolve(import.meta.dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

const INICIO = INICIO_BLOCO_IG;
const FIM = FIM_BLOCO_IG;
const i0 = html.indexOf(INICIO);
const i1 = html.indexOf(FIM, i0);
if (i0 < 0 || i1 < 0) {
  console.error(
    "❌ Bloco de publicação IG não encontrado em index.html.\n" +
      "   Aplica primeiro: node tools/apply-cloud-patch.mjs --verify"
  );
  process.exit(1);
}
const FONTE = html.slice(i0, i1 + FIM.length);

/* ---------------------------------------------------------------- helpers */

let pass = 0;
let fail = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    pass++;
    console.log(`   ✔ ${name}`);
  } else {
    fail++;
    failures.push(name + (detail ? ` — ${detail}` : ""));
    console.log(`   ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const CONTA = {
  id: "acc_1",
  name: "@cena.oculta",
  mode: "graph",
  igUserId: "17841400000000000",
  metaAccessToken: "EAAG_token_de_teste",
  webhookUrl: "",
  shareToFeed: true,
};

function item(extra = {}) {
  return Object.assign(
    {
      id: "reel_1",
      accountId: "acc_1",
      title: "Cena oculta",
      caption: "Legenda com **negrito**",
      poster: "",
      platforms: ["instagram"],
      scheduledAt: "2026-10-04T12:00",
      videoBlob: new Blob([new Uint8Array(4096)], { type: "video/mp4" }),
      videoFileName: "cena-oculta.mp4",
      remoteVideoUrl: "",
    },
    extra
  );
}

/** Classificação de link parecida com a do nuvem-duravel.js. */
function classificar(url) {
  const u = String(url || "");
  if (/kappa\.lol|uguu\.se|litterbox|catbox/.test(u)) return "temp";
  if (/nuvem\.exemplo|workers\.dev|r2\.dev/.test(u)) return "r2";
  if (/drive\.google|script\.google/.test(u)) return "drive";
  if (/localhost|127\.0\.0\.1/.test(u)) return "local";
  return "unknown";
}

/**
 * Cria um mundo falso com a Graph API, o rupload e o XHR. Devolve o contexto `vm`
 * (onde `gS`/`pS`/`igProbeVideoUrl` ficam disponíveis) e o registo de chamadas.
 */
function criarAmbiente(opcoes = {}) {
  const o = Object.assign(
    {
      conta: CONTA,
      rede: null, // se definido, o fetch lança este erro
      containerResumable: (n) => ({
        status: 200,
        json: { id: `CONT_DIREto_${n}`, uri: `https://rupload.facebook.com/ig-api-upload/v21.0/CONT_DIRETO_${n}` },
      }),
      containerUrl: (n) => ({ status: 200, json: { id: `CONT_URL_${n}` } }),
      status: () => "FINISHED",
      publicar: () => ({ status: 200, json: { id: "MEDIA_PUBLICADA" } }),
      permalink: () => ({ status: 200, json: { permalink: "https://www.instagram.com/reel/abc123/" } }),
      xhr: () => ({ status: 200, text: '{"success":true}' }),
      bg: () => "https://nuvem.exemplo/reel.mp4",
      sonda: () => ({ status: 200, tipo: "video/mp4" }),
      claim: () => ({ ok: true, provider: "cloudflare-r2", key: "cc_hash_reel_1", owner: "app:1a2b" }),
      claimSkipMessage: null, // se definido, é exposto no mock de window.CineCloud
    },
    opcoes
  );

  const chamadas = [];
  const passos = [];
  let nContainers = 0;
  const polls = {};

  const resposta = (status, json, headers) => {
    const h = headers || {};
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k) => h[String(k).toLowerCase()] ?? null },
      json: async () => json,
      body: null,
    };
  };

  async function fetchFalso(url, opts = {}) {
    const metodo = String(opts.method || "GET").toUpperCase();
    const u = new URL(String(url));
    const corpo = opts.body ? String(opts.body) : "";
    chamadas.push({ tipo: "fetch", url: String(url), metodo, corpo, headers: opts.headers || {} });
    if (o.rede) throw new TypeError(o.rede);
    if (u.hostname === "graph.facebook.com") {
      const partes = u.pathname.split("/").filter(Boolean);
      const acao = partes[2];
      if (acao === "media") {
        nContainers++;
        const params = new URLSearchParams(corpo);
        const r = params.get("upload_type") === "resumable" ? o.containerResumable(nContainers, params) : o.containerUrl(nContainers, params);
        return resposta(r.status ?? 200, r.json);
      }
      if (acao === "media_publish") return resposta(o.publicar(nContainers).status ?? 200, o.publicar(nContainers).json);
      const id = partes[1];
      if (u.searchParams.get("fields") === "permalink") {
        const r = o.permalink(id);
        return resposta(r.status ?? 200, r.json);
      }
      polls[id] = (polls[id] || 0) + 1;
      const r = o.status(id, polls[id], nContainers);
      const st = typeof r === "string" ? { status_code: r, status: "" } : r;
      return resposta(200, st);
    }
    // Sonda do link de vídeo (HEAD / GET com Range)
    const r = o.sonda(metodo, String(url));
    if (r === null || r.falha) throw new TypeError("Failed to fetch");
    return resposta(r.status ?? 200, {}, { "content-type": r.tipo || "video/mp4", "accept-ranges": r.ranges ? "bytes" : "none" });
  }

  class XHRFalso {
    constructor() {
      this.upload = {};
      this.status = 0;
      this.responseText = "";
      this.headers = {};
    }
    open(metodo, url) {
      this.metodo = metodo;
      this.url = url;
    }
    setRequestHeader(k, v) {
      this.headers[k] = v;
    }
    send(blob) {
      chamadas.push({ tipo: "xhr", url: this.url, metodo: this.metodo, headers: this.headers, bytes: blob && blob.size });
      const r = o.xhr(this, blob) || {};
      setTimeout(() => {
        if (r.erro) {
          if (this.onerror) this.onerror();
          return;
        }
        this.status = r.status ?? 200;
        this.responseText = r.text || "";
        if (this.onload) this.onload();
      }, 0);
    }
  }

  const claims = [];
  const janela = {
    CineCloud: o.semCineCloud
      ? undefined
      : {
          classifyUrl: classificar,
          claimPublish: async (it, opts) => {
            claims.push({ id: it && it.id, ttlMs: opts && opts.ttlMs });
            return o.claim(it, opts);
          },
          ...(o.claimSkipMessage ? { claimSkipMessage: o.claimSkipMessage } : {}),
        },
  };

  const contexto = {
    console,
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout,
    Promise,
    Date,
    Math,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Error,
    TypeError,
    RegExp,
    URL,
    URLSearchParams,
    AbortController,
    Blob,
    Set,
    Map,
    encodeURIComponent,
    decodeURIComponent,
    parseInt,
    parseFloat,
    isNaN,
    fetch: fetchFalso,
    XMLHttpRequest: XHRFalso,
    window: janela,
    bg: async (blob, nome, onProgress) => {
      chamadas.push({ tipo: "bg", nome, bytes: blob && blob.size });
      if (onProgress) onProgress(42);
      const r = o.bg(blob);
      if (r && r.erro) throw new Error(r.erro);
      return r;
    },
    // NOTA: `hS` NÃO é injetado aqui de propósito. Ele era um helper do bundle base que
    // vivia dentro do troço substituído pelo patch 24; quando foi dado como falso global
    // neste contexto, o teste escondeu o erro que rebentava em produção ("hS is not
    // defined" ao publicar). O bloco tem de o declarar por si (ver secção 0).
    Yo: "https://graph.facebook.com/v21.0",
  };

  const sandbox = vm.createContext(contexto);
  vm.runInContext(FONTE, sandbox, { filename: "cineclip-ig-publish.js" });

  return {
    api: sandbox,
    chamadas,
    passos,
    claims,
    conta: o.conta,
    contar: (tipo) => chamadas.filter((c) => c.tipo === tipo).length,
  };
}

async function publicar(ambiente, it, conta) {
  const passos = [];
  try {
    const res = await ambiente.api.gS(it, conta || ambiente.conta, (p) => passos.push(String(p)));
    return { ok: true, res, passos };
  } catch (err) {
    return { ok: false, erro: err, passos };
  }
}

/* ----------------------------------------------------------------- testes */

console.log(`\n🎬 Publicação de Reels — bloco extraído do bundle (${FONTE.length} bytes)\n`);

/* 0 — o bloco tem de ser autossuficiente (regressão do "hS is not defined") */
console.log("0. Autossuficiência do bloco (regressão do `hS is not defined`)");
{
  const refsH = (FONTE.match(/\bhS\s*\(/g) || []).length;
  check(
    "o helper da capa (hS) está declarado dentro do bloco",
    refsH === 0 || /\bfunction\s+hS\s*\(/.test(FONTE),
    `${refsH} referência(s) a hS sem declaração no bloco — é o erro "hS is not defined" da publicação`
  );
  const suspeitos = analisarAutossuficiencia(FONTE);
  check(
    "o bloco não chama helpers que só existam no bundle",
    suspeitos.length === 0,
    suspeitos.length ? `sem declaração dentro do bloco: ${suspeitos.join(", ")}` : ""
  );
}

/* 1 — envio direto (resumable) sem link público nenhum */
console.log("1. Envio direto (upload_type=resumable)");
{
  const amb = criarAmbiente();
  const it = item();
  const out = await publicar(amb, it);
  check("publica com o container do envio direto", out.ok && out.res.publishedId === "MEDIA_PUBLICADA", out.erro && out.erro.message);
  const container = amb.chamadas.find((c) => c.tipo === "fetch" && c.corpo.includes("upload_type=resumable"));
  check("pede upload_type=resumable à Graph API", !!container, amb.chamadas.map((c) => c.tipo).join(","));
  check("inclui media_type=REELS e o caption", !!container && container.corpo.includes("media_type=REELS") && container.corpo.includes("Legenda"));
  const up = amb.chamadas.find((c) => c.tipo === "xhr");
  check("envia o binário para rupload.facebook.com", !!up && /^https:\/\/rupload\.facebook\.com\/ig-api-upload\//.test(up.url), up && up.url);
  check("manda os headers offset e file_size", !!up && up.headers.offset === "0" && String(up.headers.file_size) === "4096");
  check("usa Authorization: OAuth <token>", !!up && up.headers.Authorization === "OAuth EAAG_token_de_teste");
  check("não envia nada para hosts de terceiros (bg)", amb.contar("bg") === 0);
}

/* 2 — o navegador bloqueia o envio direto (CORS) → cai para video_url */
console.log("\n2. Envio direto bloqueado (CORS) → video_url");
{
  const amb = criarAmbiente({ xhr: () => ({ erro: true }) });
  const it = item();
  const out = await publicar(amb, it);
  check("publica pela estratégia do link", out.ok && out.res.publishedId === "MEDIA_PUBLICADA", out.erro && out.erro.message);
  const comLink = amb.chamadas.find((c) => c.tipo === "fetch" && c.corpo.includes("video_url="));
  check("cria container com video_url", !!comLink && comLink.corpo.includes(encodeURIComponent("https://nuvem.exemplo/reel.mp4")));
  check("enviou o ficheiro para a nuvem uma só vez", amb.contar("bg") === 1);
}

/* 3 — 2207077 na estratégia do link → repete com envio direto */
console.log("\n3. 2207077 no video_url → nova tentativa com envio direto");
{
  const amb = criarAmbiente({
    status: (id) =>
      id.startsWith("CONT_URL")
        ? { status_code: "ERROR", status: "Error: Media upload has failed with error code 2207077" }
        : "FINISHED",
  });
  const it = item({ remoteVideoUrl: "https://nuvem.exemplo/reel.mp4" });
  const out = await publicar(amb, it);
  check("publica na segunda tentativa", out.ok && out.res.publishedId === "MEDIA_PUBLICADA", out.erro && out.erro.message);
  check("criou os containers das duas estratégias", amb.contar("fetch") >= 3 && amb.contar("xhr") === 1, JSON.stringify(amb.chamadas.map((c) => c.tipo)));
  check("o passo avisa da repetição", out.passos.some((p) => /container novo \(2\/3\)/.test(p)), out.passos.join(" | "));
}

/* 4 — 2207077 em tudo → erro claro com dica e contagem de tentativas */
console.log("\n4. 2207077 em todas as tentativas → erro com dica");
{
  const amb = criarAmbiente({
    xhr: () => ({ erro: true }),
    status: () => ({ status_code: "ERROR", status: "Error: Media upload has failed with error code 2207077" }),
  });
  const it = item({ remoteVideoUrl: "https://nuvem.exemplo/reel.mp4" });
  const out = await publicar(amb, it);
  check("falha com erro e código 2207077", !out.ok && out.erro.igCode === "2207077", out.ok ? "publicou" : String(out.erro));
  const msg = out.ok ? "" : out.erro.message;
  check("mensagem explica o que aconteceu", /não conseguiu descarregar/.test(msg), msg);
  check("a dica aparece uma só vez", (msg.match(/Dica:/g) || []).length === 1, msg);
  check("mensagem diz quantas tentativas foram feitas", /após 3 tentativas/.test(msg), msg);
}

/* 5 — link de host temporário + ficheiro local → renova o link antes de tentar */
console.log("\n5. Link temporário (uguu/kappa) → renovado antes da tentativa");
{
  const amb = criarAmbiente({ bg: () => "https://nuvem.exemplo/novo.mp4" });
  const it = item({ remoteVideoUrl: "https://kappa.lol/abc123.mp4" });
  const out = await publicar(amb, it);
  check("publica", out.ok && out.res.publishedId === "MEDIA_PUBLICADA", out.erro && out.erro.message);
  const comLink = amb.chamadas.find((c) => c.tipo === "fetch" && c.corpo.includes("video_url="));
  check("usa o link novo na nuvem, não o temporário", !!comLink && comLink.corpo.includes(encodeURIComponent("https://nuvem.exemplo/novo.mp4")) && !comLink.corpo.includes("kappa.lol"));
  check("renovou o link uma única vez", amb.contar("bg") === 1);
  check("guardou o link novo no item", it.remoteVideoUrl === "https://nuvem.exemplo/novo.mp4", it.remoteVideoUrl);
}

/* 6 — link morto (404) e sem ficheiro local → erro explícito, sem criar containers */
console.log("\n6. Link morto (HTTP 404) sem ficheiro local");
{
  const amb = criarAmbiente({ sonda: () => ({ status: 404, tipo: "text/html" }) });
  const it = item({ videoBlob: undefined, remoteVideoUrl: "https://meusite.exemplo/velho.mp4" });
  const out = await publicar(amb, it);
  check("não publica", !out.ok);
  check("explica que o link já não existe", !out.ok && /já não existe/.test(out.erro.message), !out.ok ? out.erro.message : "");
  check("pede para reimportar o .mp4", !out.ok && /Reimporta o \.mp4/.test(out.erro.message));
  check("não chegou a criar container", !amb.chamadas.some((c) => c.tipo === "fetch" && c.corpo.includes("media_type=REELS")));
  check("a sonda usa HEAD antes do GET (como a Meta)", amb.chamadas.some((c) => c.metodo === "HEAD"));
}

/* 7 — só há link temporário e nenhum ficheiro local → avisa mas publica */
console.log("\n7. Só link temporário (sem ficheiro local)");
{
  const amb = criarAmbiente();
  const it = item({ videoBlob: undefined, remoteVideoUrl: "https://uguu.se/velho.mp4" });
  const out = await publicar(amb, it);
  check("publica com o link que existe", out.ok && out.res.publishedId === "MEDIA_PUBLICADA", out.erro && out.erro.message);
  check("avisa que o link é temporário", out.passos.some((p) => /host temporário/.test(p)), out.passos.join(" | "));
}

/* 8 — erro permanente (2207042, limite de 50/24 h) → uma só tentativa */
console.log("\n8. Erro permanente (2207042) não é repetido");
{
  const amb = criarAmbiente({
    status: () => ({ status_code: "ERROR", status: "Error: You reached maximum number of posts that is allowed with error code 2207042" }),
  });
  const it = item({ remoteVideoUrl: "https://nuvem.exemplo/reel.mp4" });
  const out = await publicar(amb, it);
  check("falha com o código 2207042", !out.ok && out.erro.igCode === "2207042", out.ok ? "publicou" : String(out.erro));
  check("não gastou tentativas novas", !/após 3 tentativas/.test(out.ok ? "" : out.erro.message));
  check("explica o limite de 24 h", !out.ok && /50 em 24 h/.test(out.erro.message), !out.ok ? out.erro.message : "");
}

/* 9 — publish devolve "media is not ready" (2207027) → repete e publica */
console.log("\n9. Publicação repetida quando o media ainda não está pronto");
{
  let n = 0;
  const amb = criarAmbiente({
    publicar: () => {
      n++;
      return n === 1
        ? { status: 400, json: { error: { message: "The media is not ready for publishing, please wait.", code: 9007 } } }
        : { status: 200, json: { id: "MEDIA_PUBLICADA" } };
    },
  });
  const it = item({ remoteVideoUrl: "https://nuvem.exemplo/reel.mp4" });
  const out = await publicar(amb, it);
  check("publica depois de repetir", out.ok && out.res.publishedId === "MEDIA_PUBLICADA", out.erro && out.erro.message);
  check("não criou um segundo container", amb.contar("xhr") === 0 && amb.chamadas.filter((c) => c.corpo.includes("upload_type=resumable")).length === 0);
}

/* 10 — webhook continua a funcionar (Make/n8n) */
console.log("\n10. Modo Webhook (Make/n8n)");
{
  const amb = criarAmbiente({ conta: Object.assign({}, CONTA, { mode: "webhook", webhookUrl: "https://hook.exemplo/reel" }) });
  const it = item();
  const out = await publicar(amb, it);
  check("aciona o webhook", out.ok && /^webhook_/.test(out.res.publishedId), out.erro && out.erro.message);
  const hook = amb.chamadas.find((c) => c.url === "https://hook.exemplo/reel");
  check("envia o videoUrl gerado na nuvem", !!hook && hook.corpo.includes("https://nuvem.exemplo/reel.mp4"));
  check("não cria containers no Instagram", !amb.chamadas.some((c) => c.tipo === "fetch" && c.url.includes("graph.facebook.com")));
}

/* 11 — configuração em falta */
console.log("\n11. Configuração em falta");
{
  const amb = criarAmbiente({ conta: Object.assign({}, CONTA, { metaAccessToken: "" }) });
  const out = await publicar(amb, item());
  check("erro de configuração claro", !out.ok && /Configura o ID da Conta Instagram/.test(out.erro.message), out.ok ? "publicou" : out.erro.message);
}

/* 12 — sonda "fraco" (GET serve, HEAD falha) → trata como suspeito e refaz o link */
console.log("\n12. Host que recusa HEAD (gatilho do 2207077)");
{
  const amb = criarAmbiente({
    sonda: (metodo) => (metodo === "HEAD" ? { status: 404, tipo: "text/plain" } : { status: 200, tipo: "video/mp4" }),
    bg: () => "https://nuvem.exemplo/refeito.mp4",
  });
  const it = item({ remoteVideoUrl: "https://meusite.exemplo/video.mp4" });
  const out = await publicar(amb, it);
  check("publica com o link refeito", out.ok && out.res.publishedId === "MEDIA_PUBLICADA", out.erro && out.erro.message);
  const comLink = amb.chamadas.find((c) => c.tipo === "fetch" && c.corpo.includes("video_url="));
  check("descartou o link que só serve por GET", !!comLink && comLink.corpo.includes(encodeURIComponent("https://nuvem.exemplo/refeito.mp4")));
}

/* 13 — renova a claim (TTL) antes de cada tentativa */
console.log("\n13. Claim renovada antes de cada tentativa (TTL longo)");
{
  const amb = criarAmbiente({
    status: (id) =>
      id.startsWith("CONT_URL")
        ? { status_code: "ERROR", status: "Error: Media upload has failed with error code 2207077" }
        : "FINISHED",
  });
  const it = item({ remoteVideoUrl: "https://nuvem.exemplo/reel.mp4" });
  const out = await publicar(amb, it);
  check("publica na segunda tentativa (envio direto)", out.ok && out.res.publishedId === "MEDIA_PUBLICADA", out.erro && out.erro.message);
  check("renovou a claim antes das duas tentativas", amb.claims.length === 2, JSON.stringify(amb.claims));
  check("pediu um TTL de 30 minutos", amb.claims.every((c) => c.ttlMs === 30 * 60 * 1000));
  check("renovou a claim do Reel certo", amb.claims.every((c) => c.id === "reel_1"));
}

/* 14 — outro aparelho/Robô tomou a claim → não publica (anti-duplicado) */
console.log("\n14. Claim tomada por outro aparelho → para antes de publicar");
{
  const amb = criarAmbiente({ claim: () => ({ ok: false, reason: "held" }) });
  const it = item();
  const out = await publicar(amb, it);
  check("não publica", !out.ok);
  check("explica que outro aparelho está a publicar", !out.ok && /Outro aparelho ou o Robô 24h/.test(out.erro.message), !out.ok ? out.erro.message : "");
  check("não chegou a criar containers", !amb.chamadas.some((c) => c.tipo === "fetch"));
}


/* 14b — a recusa explica quem tem a claim e até quando (mensagem do CineCloud) */
console.log("\n14b. Claim tomada: a mensagem final diz quem publica e até quando");
{
  const ate = new Date(Date.now() + 5 * 60 * 1000);
  const amb = criarAmbiente({
    claim: () => ({ ok: false, reason: "held", holder: { owner: "robo:9x8y", expiresAt: ate.getTime() } }),
    claimSkipMessage: (c, titulo) =>
      `⏳ "${titulo}" já está a ser publicado por ${c.holder.owner} — envio ignorado para não publicar duas vezes.`,
  });
  const it = item();
  const out = await publicar(amb, it);
  check("não publica", !out.ok);
  check(
    "a mensagem diz quem está a publicar",
    !out.ok && /robo:9x8y/.test(out.erro.message),
    !out.ok ? out.erro.message : ""
  );
  check(
    "a mensagem convida a tentar depois (sem prometer minutos mágicos)",
    !out.ok && /Tenta novamente depois dessa hora\./.test(out.erro.message),
    !out.ok ? out.erro.message : ""
  );
}

/* 15 — capa do Reel: hS eleva o pôster do CDN do Instagram para w780 */
console.log("\n15. Capa do Reel (hS eleva o pôster para w780)");
{
  const amb = criarAmbiente();
  const poster = "https://scontent.cdninstagram.com/v/t51.2885-15/t/p/w300/capa.jpg";
  const hSDoBloco = amb.api.hS;
  check("hS fica disponível dentro do bloco", typeof hSDoBloco === "function");
  check(
    "hS eleva w300 → w780",
    typeof hSDoBloco === "function" && hSDoBloco(poster) === poster.replace("/w300/", "/w780/"),
    typeof hSDoBloco === "function" ? hSDoBloco(poster) : "hS não definido"
  );
  check(
    "hS respeita pôsteres já maiores",
    typeof hSDoBloco === "function" && hSDoBloco("https://x/t/p/w1080/capa.jpg") === "https://x/t/p/w1080/capa.jpg"
  );
  const out = await publicar(amb, item({ poster }));
  check("publica com pôster oficial de capa", out.ok && out.res.publishedId === "MEDIA_PUBLICADA", out.erro && out.erro.message);
  const container = amb.chamadas.find((c) => c.tipo === "fetch" && c.corpo.includes("upload_type=resumable"));
  check(
    "o container leva o cover_url elevado a w780",
    !!container && container.corpo.includes(encodeURIComponent(poster.replace("/w300/", "/w780/"))),
    container ? container.corpo.slice(0, 200) : "sem container"

  );
}

/* ------------------------------------------------------------------ fim */

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passaram, ${fail} falharam`);
if (failures.length) {
  console.log("\nFalhas:");
  failures.forEach((f) => console.log("  - " + f));
}
process.exit(fail === 0 ? 0 : 1);
