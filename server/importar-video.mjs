/**
 * 🔗 IMPORTAR POR LINK — TikTok e Kwai
 * ---------------------------------------------------------------------------
 * Recebe o link de um vídeo do TikTok ou do Kwai e devolve o .mp4 ao navegador
 * (em streaming, para não esbarrar no limite de 4,5 MB de resposta da Vercel).
 *
 * TikTok:
 *   1. lê a página do vídeo e o JSON __UNIVERSAL_DATA_FOR_REHYDRATION__;
 *      escolhe primeiro as versões H.264 (o H.265 não abre em muitos PCs);
 *   2. se a página vier sem dados (o TikTok desafia servidores), usa o tikwm.com.
 * Kwai:
 *   procura o .mp4 na página (meta og:video, campos JSON conhecidos ou qualquer
 *   link .mp4 dos servidores do Kwai).
 *
 * Segurança: só aceita links do TikTok/Kwai e só descarrega de domínios conhecidos
 * dessas plataformas (sem isto a função seria um proxy aberto para qualquer site).
 * Os cookies que a página do TikTok devolve são reenviados só ao CDN do vídeo.
 */

export const LIMITE_BYTES = 300 * 1024 * 1024;
const TEMPO_PAGINA_MS = 20_000;
const TEMPO_VIDEO_MS = 120_000;
const MAX_REDIRECIONAMENTOS = 6;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

/** Páginas que o utilizador pode colar. */
const HOSTS_PAGINA = {
  tiktok: ["tiktok.com"],
  kwai: ["kwai.com", "kw.ai", "kwai.net", "kwai-pro.com"],
};

/** Servidores de onde o vídeo pode ser descarregado. */
const HOSTS_VIDEO = [
  "tiktok.com", "tiktokcdn.com", "tiktokcdn-us.com", "tiktokcdn-eu.com", "tiktokv.com", "tiktokv.us",
  "tiktokv.eu", "byteoversea.com", "ibytedtos.com", "ibyteimg.com", "muscdn.com", "tikwm.com",
  "kwai.com", "kwai.net", "kwai-pro.com", "kwaicdn.com", "kwimgs.com", "kwai.co", "kuaishou.com",
  "yximgs.com", "kwaiimg.com", "snackvideo.com",
];

/** A que servidores podem ir os cookies que a página da plataforma devolveu. */
const HOSTS_COOKIE = {
  tiktok: ["tiktok.com", "tiktokcdn.com", "tiktokcdn-us.com", "tiktokcdn-eu.com", "tiktokv.com", "tiktokv.us", "tiktokv.eu"],
  kwai: ["kwai.com", "kwai.net", "kwai-pro.com", "kwaicdn.com", "kwimgs.com", "kwai.co"],
};

export class ErroImportacao extends Error {
  constructor(mensagem, estado = 422) {
    super(mensagem);
    this.estado = estado;
  }
}

function hostDe(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function pertence(host, dominios) {
  return dominios.some((d) => host === d || host.endsWith("." + d));
}

/** "tiktok" | "kwai" | null */
export function plataformaDe(url) {
  const host = hostDe(url);
  if (!host) return null;
  if (pertence(host, HOSTS_PAGINA.tiktok)) return "tiktok";
  if (pertence(host, HOSTS_PAGINA.kwai)) return "kwai";
  return null;
}

export function hostDeVideoPermitido(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === "https:" && pertence(u.hostname.toLowerCase(), HOSTS_VIDEO);
}

/** Limpa o que o utilizador colou (texto à volta, espaços, http→https). */
export function normalizarLink(entrada) {
  const texto = String(entrada || "").trim();
  const m = /https?:\/\/[^\s"'<>]+/i.exec(texto);
  let url = m ? m[0] : texto;
  if (!/^https?:\/\//i.test(url) && /^(www\.|vm\.|vt\.|m\.)?(tiktok|kwai)/i.test(url)) url = "https://" + url;
  url = url.replace(/^http:\/\//i, "https://").replace(/[).,;]+$/, "");
  return url;
}

/* ------------------------------------------------------------ HTTP util */

function juntarCookies(atual, cabecalhos) {
  const lista = typeof cabecalhos.getSetCookie === "function"
    ? cabecalhos.getSetCookie()
    : (cabecalhos.get("set-cookie") || "").split(/,(?=\s*[A-Za-z0-9_\-]+=)/);
  const mapa = new Map(atual ? atual.split("; ").map((c) => [c.split("=")[0], c]) : []);
  for (const linha of lista) {
    const par = String(linha || "").split(";")[0].trim();
    if (par && par.includes("=")) mapa.set(par.split("=")[0], par);
  }
  return [...mapa.values()].join("; ");
}

/**
 * GET de uma página seguindo redirecionamentos à mão: cada salto tem de continuar
 * no TikTok/Kwai (um link curto não pode levar a função para outro site).
 */
async function lerPagina(fetchFn, url, plataforma) {
  let atual = url;
  let cookies = "";
  for (let i = 0; i <= MAX_REDIRECIONAMENTOS; i++) {
    if (plataformaDe(atual) !== plataforma) {
      throw new ErroImportacao("O link redirecionou para fora do " + nomePlataforma(plataforma) + ".");
    }
    let r;
    try {
      r = await fetchFn(atual, {
        redirect: "manual",
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
          ...(cookies ? { Cookie: cookies } : {}),
        },
        signal: AbortSignal.timeout(TEMPO_PAGINA_MS),
      });
    } catch (e) {
      throw new ErroImportacao("Não consegui abrir a página do " + nomePlataforma(plataforma) + ".", 502);
    }
    cookies = juntarCookies(cookies, r.headers);
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
      atual = new URL(r.headers.get("location"), atual).toString();
      continue;
    }
    if (r.status === 404 || r.status === 410) {
      throw new ErroImportacao("Esse vídeo não existe ou foi apagado.", 404);
    }
    if (!r.ok) {
      throw new ErroImportacao(`O ${nomePlataforma(plataforma)} recusou o pedido (HTTP ${r.status}).`, 502);
    }
    return { url: atual, html: await r.text(), cookies };
  }
  throw new ErroImportacao("O link redireciona demasiadas vezes.");
}

function nomePlataforma(p) {
  return p === "kwai" ? "Kwai" : "TikTok";
}

/** Texto de dentro de um <script id="..."> como JSON. */
function jsonDoScript(html, id) {
  const re = new RegExp(`<script[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)</script>`, "i");
  const m = re.exec(html);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function comoUrl(valor) {
  if (typeof valor !== "string" || !valor) return null;
  const v = valor.startsWith("//") ? "https:" + valor : valor;
  return /^https?:\/\//i.test(v) ? v.replace(/^http:\/\//i, "https://") : null;
}

/* ------------------------------------------------------------- TikTok */

/** Codec a partir do UrlKey (ex.: "v12044gd0000_h264_720p_1234567"). */
function codecDoUrlKey(urlKey) {
  const m = /v[^_]+_([^_]+)_(\d+)p_(\d+)/.exec(String(urlKey || ""));
  return m ? { codec: m[1], altura: Number(m[2]), bitrate: Number(m[3]) } : null;
}

/**
 * Candidatos de download de um itemStruct do TikTok, do melhor para o pior:
 * H.264 do bitrateInfo (maior resolução primeiro), playAddr, depois H.265, e por
 * fim downloadAddr (tem a marca de água do TikTok).
 */
export function candidatosTikTok(item) {
  const video = (item && item.video) || {};
  const h264 = [];
  const outros = [];
  for (const info of Array.isArray(video.bitrateInfo) ? video.bitrateInfo : []) {
    const play = info && info.PlayAddr;
    const urls = (play && Array.isArray(play.UrlList) ? play.UrlList : []).map(comoUrl).filter(Boolean);
    if (!urls.length) continue;
    const meta = codecDoUrlKey(play.UrlKey) || {};
    const codec = String(info.CodecType || meta.codec || "").toLowerCase();
    if (codec.includes("bytevc2")) continue; // H.266 da ByteDance: ninguém reproduz
    const alvo = codec.includes("h264") ? h264 : outros;
    alvo.push({ urls, codec: codec.includes("h264") ? "h264" : codec || "desconhecido", altura: meta.altura || 0, bitrate: meta.bitrate || 0, tamanho: Number(play.DataSize) || 0 });
  }
  const ordenar = (a, b) => b.altura - a.altura || b.bitrate - a.bitrate;
  h264.sort(ordenar);
  outros.sort(ordenar);
  const lista = [];
  for (const c of h264) for (const url of c.urls) lista.push({ url, codec: "h264", tamanho: c.tamanho });
  const play = Array.isArray(video.playAddr) ? video.playAddr.map((p) => p && p.src) : [video.playAddr];
  for (const p of play) {
    const url = comoUrl(p);
    if (url) lista.push({ url, codec: video.codecType || "?" });
  }
  for (const c of outros) for (const url of c.urls) lista.push({ url, codec: c.codec, tamanho: c.tamanho });
  const dl = comoUrl(video.downloadAddr);
  if (dl) lista.push({ url: dl, codec: "h264", marcaDeAgua: true });
  const vistos = new Set();
  return lista.filter((c) => {
    if (vistos.has(c.url) || !hostDeVideoPermitido(c.url) || hostDe(c.url) === "www.tiktok.com") return false;
    vistos.add(c.url);
    return true;
  });
}

function idTikTok(url) {
  const m = /\/(?:video|photo|v)\/(\d+)/.exec(url) || /[?&]item_id=(\d+)/.exec(url);
  return m ? m[1] : "";
}

async function resolverTikTok(fetchFn, link) {
  const problemas = [];
  let pagina = null;
  try {
    pagina = await lerPagina(fetchFn, link, "tiktok");
  } catch (e) {
    if (e instanceof ErroImportacao && e.estado === 404) throw e;
    problemas.push(e.message);
  }

  if (pagina) {
    if (/\/login(\?|$)/.test(new URL(pagina.url).pathname)) problemas.push("O TikTok pediu login para este vídeo.");
    const dados = jsonDoScript(pagina.html, "__UNIVERSAL_DATA_FOR_REHYDRATION__");
    const detalhe = dados && dados.__DEFAULT_SCOPE__ && dados.__DEFAULT_SCOPE__["webapp.video-detail"];
    const item = detalhe && detalhe.itemInfo && detalhe.itemInfo.itemStruct;
    if (detalhe && detalhe.statusCode && detalhe.statusCode !== 0 && !item) {
      problemas.push(`O TikTok devolveu o código ${detalhe.statusCode} (vídeo privado, apagado ou com restrição).`);
    }
    if (item && item.video) {
      const candidatos = candidatosTikTok(item);
      if (candidatos.length) {
        return {
          plataforma: "tiktok",
          id: String(item.id || idTikTok(pagina.url) || ""),
          autor: String((item.author && (item.author.uniqueId || item.author.nickname)) || ""),
          titulo: String(item.desc || ""),
          duracao: Number(item.video.duration) || 0,
          candidatos,
          cabecalhos: { Referer: pagina.url, ...(pagina.cookies ? { Cookie: pagina.cookies } : {}) },
        };
      }
      problemas.push("A página do TikTok não trazia o link do vídeo.");
    } else if (!problemas.length) {
      problemas.push("A página do TikTok veio sem os dados do vídeo (desafio anti-robô).");
    }
  }

  // Plano B: tikwm.com (serviço público que resolve links do TikTok).
  try {
    const alvo = pagina ? pagina.url : link;
    const r = await fetchFn("https://www.tikwm.com/api/?hd=1&url=" + encodeURIComponent(alvo), {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(TEMPO_PAGINA_MS),
    });
    const j = await r.json();
    const d = j && j.code === 0 && j.data;
    if (d) {
      const abs = (u) => (typeof u === "string" && u.startsWith("/") ? "https://www.tikwm.com" + u : comoUrl(u));
      const candidatos = [abs(d.hdplay), abs(d.play), abs(d.wmplay)]
        .filter(Boolean)
        .filter((u, i, a) => a.indexOf(u) === i && hostDeVideoPermitido(u))
        .map((url) => ({ url, codec: "?", marcaDeAgua: url === abs(d.wmplay) }));
      if (candidatos.length) {
        return {
          plataforma: "tiktok",
          id: String(d.id || idTikTok(alvo) || ""),
          autor: String((d.author && (d.author.unique_id || d.author.nickname)) || ""),
          titulo: String(d.title || ""),
          duracao: Number(d.duration) || 0,
          candidatos,
          cabecalhos: {},
          via: "tikwm",
        };
      }
    }
    problemas.push("tikwm: " + ((j && j.msg) || "sem vídeo na resposta"));
  } catch (e) {
    problemas.push("tikwm indisponível");
  }
  throw new ErroImportacao("Não consegui obter este vídeo do TikTok. " + problemas.join(" · "), 502);
}

/* --------------------------------------------------------------- Kwai */

function desescapar(s) {
  return String(s)
    .replace(/\\u002F/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/\\u0026/gi, "&")
    .replace(/&amp;/g, "&");
}

/** Links .mp4 candidatos numa página do Kwai, do mais provável para o menos. */
export function candidatosKwai(html) {
  const texto = desescapar(html);
  const lista = [];
  const meta = /<meta[^>]+(?:property|name)=["'](?:og:video(?::secure_url|:url)?|twitter:player:stream)["'][^>]*content=["']([^"']+)["']/gi;
  for (let m; (m = meta.exec(texto)); ) lista.push(m[1]);
  const metaInvertido = /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:video(?::secure_url|:url)?|twitter:player:stream)["']/gi;
  for (let m; (m = metaInvertido.exec(texto)); ) lista.push(m[1]);
  const campos = /"(?:srcNoMark|mainMvUrl|main_mv_url|playUrl|play_url|mp4Url|videoUrl|video_url|photoUrl|url)"\s*:\s*"(https?:\/\/[^"]+)"/gi;
  for (let m; (m = campos.exec(texto)); ) if (/\.mp4|\/mp4|video/i.test(m[1])) lista.push(m[1]);
  const mvUrls = /"main_mv_urls"\s*:\s*\[([\s\S]*?)\]/gi;
  for (let m; (m = mvUrls.exec(texto)); ) {
    for (let u, re = /"url"\s*:\s*"(https?:\/\/[^"]+)"/g; (u = re.exec(m[1])); ) lista.unshift(u[1]);
  }
  const soltos = /https?:\/\/[^"'\s<>()\\]+\.mp4(?:\?[^"'\s<>()\\]*)?/gi;
  for (let m; (m = soltos.exec(texto)); ) lista.push(m[0]);
  const vistos = new Set();
  return lista
    .map(comoUrl)
    .filter((u) => u && hostDeVideoPermitido(u) && !vistos.has(u) && vistos.add(u))
    .map((url) => ({ url, codec: "?" }));
}

async function resolverKwai(fetchFn, link) {
  const pagina = await lerPagina(fetchFn, link, "kwai");
  const candidatos = candidatosKwai(pagina.html);
  if (!candidatos.length) {
    throw new ErroImportacao("Não encontrei o vídeo na página do Kwai (o vídeo pode ser privado ou o Kwai mudou a página).", 502);
  }
  const autor = (/kwai\.com\/@([^/?#]+)/.exec(pagina.url) || [])[1] || "";
  const id = (/\/(?:video|photo)\/(\d+)/.exec(pagina.url) || [])[1] || "";
  const titulo = (/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']*)["']/i.exec(pagina.html) || [])[1] || "";
  return {
    plataforma: "kwai",
    id,
    autor: decodeURIComponent(autor),
    titulo,
    duracao: 0,
    candidatos,
    cabecalhos: { Referer: pagina.url, ...(pagina.cookies ? { Cookie: pagina.cookies } : {}) },
  };
}

/* ----------------------------------------------------------- público */

/** Descobre de onde descarregar o vídeo (sem descarregar ainda). */
export async function resolverVideo(entrada, { fetchFn = fetch } = {}) {
  const link = normalizarLink(entrada);
  const plataforma = plataformaDe(link);
  if (!plataforma) {
    throw new ErroImportacao("Cola um link do TikTok ou do Kwai (ex.: https://www.tiktok.com/@perfil/video/123…).", 400);
  }
  return plataforma === "tiktok" ? resolverTikTok(fetchFn, link) : resolverKwai(fetchFn, link);
}

/** Nome de ficheiro seguro: tiktok_perfil_123.mp4 */
export function nomeDoFicheiro(info) {
  const limpar = (s) => String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  return [info.plataforma, limpar(info.autor), limpar(info.id)].filter(Boolean).join("_") + ".mp4";
}

/**
 * Abre o primeiro candidato que responda com vídeo. Devolve a resposta (com o
 * corpo por ler) para ser enviada em streaming.
 */
export async function abrirVideo(info, { fetchFn = fetch } = {}) {
  const falhas = [];
  for (const c of info.candidatos) {
    let atual = c.url;
    let resposta = null;
    try {
      let r;
      for (let i = 0; i <= MAX_REDIRECIONAMENTOS; i++) {
        if (!hostDeVideoPermitido(atual)) throw new Error("redirecionou para fora do CDN");
        const mesmoSite = info.cabecalhos.Cookie && pertence(hostDe(atual), HOSTS_COOKIE[info.plataforma] || []);
        r = await fetchFn(atual, {
          redirect: "manual",
          headers: {
            "User-Agent": UA,
            Accept: "video/mp4,video/*;q=0.9,*/*;q=0.5",
            ...(info.cabecalhos.Referer ? { Referer: info.cabecalhos.Referer } : {}),
            ...(mesmoSite ? { Cookie: info.cabecalhos.Cookie } : {}),
          },
          signal: AbortSignal.timeout(TEMPO_VIDEO_MS),
        });
        if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
          atual = new URL(r.headers.get("location"), atual).toString();
          continue;
        }
        break;
      }
      resposta = r;
      if (!r.ok) throw new Error("HTTP " + r.status);
      const tipo = String(r.headers.get("content-type") || "");
      if (/text\/html|application\/json/i.test(tipo)) throw new Error("respondeu " + tipo.split(";")[0] + " em vez de vídeo");
      const tamanho = Number(r.headers.get("content-length")) || 0;
      if (tamanho > LIMITE_BYTES) throw new ErroImportacao("O vídeo tem mais de 300 MB.", 413);
      return { resposta: r, candidato: c, tamanho };
    } catch (e) {
      if (e instanceof ErroImportacao) throw e;
      falhas.push(e && e.message ? e.message : String(e));
      try {
        if (resposta && resposta.body) await resposta.body.cancel();
      } catch {}
    }
  }
  throw new ErroImportacao("Encontrei o vídeo mas o servidor dele recusou o download (" + falhas.slice(0, 3).join(" · ") + ").", 502);
}
