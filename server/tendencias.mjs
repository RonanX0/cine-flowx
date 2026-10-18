/**
 * Tendências do TikTok para o painel «🔥 Tendências».
 *
 * O TikTok não tem API aberta de "em alta". Este módulo pede ao tikwm.com (o mesmo
 * serviço que o importar-video.mjs já usa como plano B) as buscas por hashtag e os
 * vídeos de perfis, junta tudo, tira o que é velho/curto/pequeno e ordena por «hype»:
 * visualizações POR HORA (com pouco peso para a idade) e engajamento.
 *
 * É um serviço não oficial: pode mudar ou limitar (1 pedido/segundo). Por isso cada
 * fonte devolve o seu próprio estado e o painel mostra o que falhou.
 */

const TIKWM = "https://www.tikwm.com";
const PAUSA_MS = 1150; // o tikwm grátis aceita ~1 pedido por segundo
const MAX_FONTES = 8;
const TIMEOUT_MS = 12_000;

const GENERICAS = new Set(
  ("fyp foryou foryoupage parati paratii viral viralvideo trending trend tiktok tiktokbrasil brasil filme filmes movie movies " +
    "cena cenas cenadefilme cenasdefilme cinema serie series netflix hbo hbomax primevideo disney edit edits clip clips " +
    "movieclips filmeclips cortes corte shorts reels xyzbca capcut fy fypシ foryourpage explore momentos melhorescenas " +
    "melhorfilme filmesesries filmeseseries recomendacao indicacao dica dicadefilme filmesdeacao acao terror suspense comedia " +
    "drama romance ficcao fantasia animacao anime desenho hollywood").split(" ")
);

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const limpo = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
const norm = (s) =>
  String(s == null ? "" : s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** "#Cenas, filmes  @Perfil" → ["cenas","filmes"] (sem #, sem @, sem repetidos). */
export function listaDe(valor, max = 6) {
  const bruto = Array.isArray(valor) ? valor.join(",") : String(valor || "");
  const vistos = new Set();
  const saida = [];
  bruto
    .split(/[,;\s\n]+/)
    .map((x) => x.replace(/^[#@]+/, "").replace(/[^\p{L}\p{N}_.]/gu, "").toLowerCase())
    .forEach((x) => {
      if (x.length >= 2 && !vistos.has(x)) {
        vistos.add(x);
        saida.push(x);
      }
    });
  return saida.slice(0, max);
}

/**
 * Possíveis nomes do filme/série na legenda, do mais seguro para o menos seguro.
 * O painel confirma cada um no TMDB (o nome tem de bater por inteiro), por isso aqui
 * é melhor sugerir demais do que de menos.
 */
export function candidatosDeTitulo(legenda) {
  const texto = String(legenda || "");
  const achados = [];
  const juntar = (t, origem) => {
    let v = limpo(t).replace(/^["“”«»'`´\-–—:|•]+|["“”«»'`´\-–—:|•.!?,]+$/g, "").trim();
    v = v.replace(/\s*\((?:19|20)\d{2}\)\s*$/, "").trim();
    if (v.length < 2 || v.length > 60) return;
    if (v.split(" ").length > 8) return;
    if (GENERICAS.has(norm(v).replace(/ /g, ""))) return;
    if (!achados.some((a) => norm(a.titulo) === norm(v))) achados.push({ titulo: v, origem });
  };

  // 1. entre aspas
  for (const m of texto.matchAll(/["“«]([^"”»\n]{2,60})["”»]/g)) juntar(m[1], "aspas");
  // 2. depois de marcadores («Filme: X», «🎬 X», «Série - X»)
  for (const m of texto.matchAll(/(?:fil+me|s[eé]rie|movie|series?|anime|novela)\s*[:\-–—]\s*([^\n#|•@(]{2,60})/gi)) juntar(m[1], "marcador");
  for (const m of texto.matchAll(/[🎬🎞📽📺🍿🎥]️?\s*([^\n#|•@(🎬🎞📽📺🍿🎥]{2,60})/gu)) juntar(m[1], "emoji");
  // 3. «Título (2019)»
  for (const m of texto.matchAll(/([\p{L}0-9][\p{L}0-9 ':,&.\-]{1,55}?)\s*\(((?:19|20)\d{2})\)/gu)) juntar(m[1], "ano");
  // 4. hashtags que não são genéricas (o TMDB confirma com o nome colado)
  for (const m of texto.matchAll(/#([\p{L}\p{N}_]{4,40})/gu)) {
    const h = m[1];
    if (GENERICAS.has(h.toLowerCase())) continue;
    // separa CamelCase (#TheHangover → The Hangover); se vier tudo em minúsculas fica colado
    const partido = h.replace(/_/g, " ").replace(/([a-zà-ÿ0-9])([A-ZÀ-Ý])/g, "$1 $2");
    juntar(partido, "hashtag");
  }
  return achados.slice(0, 8);
}

/** Pontuação de «hype»: views por hora (idade amortecida) × engajamento. */
export function pontuar(v, agoraMs) {
  const horas = Math.max(1, (agoraMs - v.criadoEm * 1000) / 3_600_000);
  const porHora = v.views / Math.pow(horas, 0.75);
  const eng = v.views > 0 ? (v.curtidas + 3 * v.comentarios + 5 * v.compartilhamentos) / v.views : 0;
  return Math.round(porHora * (1 + Math.min(eng, 0.3) * 2));
}

function normalizar(v, origem, agoraMs) {
  const id = String(v.video_id || v.id || "");
  const autor = v.author || {};
  const usuario = limpo(autor.unique_id || autor.uniqueId || "");
  if (!id || !usuario) return null;
  const item = {
    id,
    url: `https://www.tiktok.com/@${usuario}/video/${id}`,
    autor: usuario,
    nomeAutor: limpo(autor.nickname || usuario),
    legenda: limpo(v.title || v.desc || ""),
    capa: limpo(v.origin_cover || v.cover || ""),
    duracao: Number(v.duration) || 0,
    views: Number(v.play_count ?? v.playCount) || 0,
    curtidas: Number(v.digg_count ?? v.diggCount) || 0,
    comentarios: Number(v.comment_count ?? v.commentCount) || 0,
    compartilhamentos: Number(v.share_count ?? v.shareCount) || 0,
    criadoEm: Number(v.create_time ?? v.createTime) || 0,
    origem,
  };
  item.hype = pontuar(item, agoraMs);
  item.candidatos = candidatosDeTitulo(item.legenda);
  return item;
}

const UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

/** Diz o motivo REAL da falha (rede, bloqueio, HTTP) em vez de um genérico «sem ligação». */
function motivoDaFalha(e) {
  if (e && (e.name === "TimeoutError" || e.name === "AbortError")) return "demorou demais";
  const causa = e && e.cause && (e.cause.code || e.cause.message);
  return "rede: " + String((causa || (e && e.message) || "falhou")).slice(0, 80);
}

async function pedirJson(url, fetchFn) {
  let ultimo = "sem resposta";
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    try {
      const r = await fetchFn(url, {
        headers: { "User-Agent": UA, Accept: "application/json, text/plain, */*", Referer: TIKWM + "/", "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const texto = await r.text();
      let j = null;
      try {
        j = JSON.parse(texto);
      } catch {}
      if (j && j.code === 0 && j.data) return j.data;
      if (j) ultimo = j.msg || `código ${j.code}`;
      else if (/cloudflare|just a moment|captcha|challenge/i.test(texto)) ultimo = `bloqueado pelo anti-robô (HTTP ${r.status})`;
      else ultimo = `resposta inesperada (HTTP ${r.status})`;
      if (!/limit|second|frequen/i.test(ultimo)) break;
    } catch (e) {
      ultimo = motivoDaFalha(e);
    }
    await esperar(PAUSA_MS + 400);
  }
  throw new Error(ultimo);
}


/* ------------------------------------------------------------------ Apify */

const APIFY_ATOR = "clockworks~tiktok-scraper";
const APIFY_TIMEOUT_MS = 110_000;

/** Um item do clockworks/tiktok-scraper → o mesmo formato do tikwm (para o resto não mudar). */
function deApify(v) {
  const meta = v.authorMeta || {};
  const video = v.videoMeta || {};
  const criado = Number(v.createTime) || Math.floor(Date.parse(v.createTimeISO || "") / 1000) || 0;
  return {
    video_id: v.id,
    title: v.text || "",
    origin_cover: video.coverUrl || video.originalCoverUrl || "",
    duration: Number(video.duration) || 0,
    play_count: v.playCount,
    digg_count: v.diggCount,
    comment_count: v.commentCount,
    share_count: v.shareCount,
    create_time: criado,
    author: { unique_id: meta.name || meta.uniqueId || "", nickname: meta.nickName || meta.name || "" },
  };
}

async function buscarNoApify(token, tags, perfis, fetchFn) {
  const url = `https://api.apify.com/v2/acts/${APIFY_ATOR}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
  let r;
  try {
    r = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        hashtags: tags,
        profiles: perfis,
        resultsPerPage: 25,
        shouldDownloadVideos: false,
        shouldDownloadCovers: false,
        shouldDownloadSubtitles: false,
        shouldDownloadSlideshowImages: false,
      }),
      signal: AbortSignal.timeout(APIFY_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(motivoDaFalha(e));
  }
  if (r.status === 401 || r.status === 403) throw new Error("token do Apify recusado — confere se colaste o token certo");
  if (r.status === 402) throw new Error("o Apify ficou sem crédito este mês");
  if (r.status === 404) throw new Error("o Apify não encontrou o robô do TikTok");
  const texto = await r.text();
  let lista = null;
  try {
    lista = JSON.parse(texto);
  } catch {}
  if (!r.ok || !Array.isArray(lista)) {
    let detalhe = "";
    try {
      detalhe = (JSON.parse(texto).error || {}).message || "";
    } catch {}
    throw new Error(`o Apify respondeu HTTP ${r.status}${detalhe ? ": " + String(detalhe).slice(0, 100) : ""}`);
  }
  return lista.filter((v) => v && v.id && !v.error);
}

/**
 * @param {{tags?:string[]|string, perfis?:string[]|string, dias?:number, minViews?:number, max?:number}} p
 * @param {{fetchFn?:Function, agora?:number, pausa?:number}} deps
 */
export async function buscarTendencias(p = {}, deps = {}) {
  const fetchFn = deps.fetchFn || fetch;
  const agora = deps.agora || Date.now();
  const pausa = deps.pausa ?? PAUSA_MS;
  const tags = listaDe(p.tags, 5);
  const perfis = listaDe(p.perfis, 5);
  const dias = Math.max(1, Math.min(60, Number(p.dias) || 7));
  const minViews = Math.max(0, Number(p.minViews) || 20_000);
  const max = Math.max(5, Math.min(100, Number(p.max) || 40));

  const fontes = [
    ...tags.map((t) => ({ tipo: "hashtag", nome: t, url: `${TIKWM}/api/feed/search?keywords=${encodeURIComponent("#" + t)}&count=30&cursor=0&hd=1` })),
    ...perfis.map((u) => ({ tipo: "perfil", nome: u, url: `${TIKWM}/api/user/posts?unique_id=${encodeURIComponent(u)}&count=30&cursor=0` })),
  ].slice(0, MAX_FONTES);

  const estados = [];
  const todos = new Map();
  const token = String(p.apifyToken || "").trim();
  if (token) {
    // Com token do Apify usa só ele (uma execução para todas as hashtags e perfis): é a via estável.
    try {
      const lista = await buscarNoApify(token, tags, perfis, fetchFn);
      let aceites = 0;
      for (const v of lista) {
        const item = normalizar(deApify(v), "apify", agora);
        if (item && !todos.has(item.id)) {
          todos.set(item.id, item);
          aceites++;
        }
      }
      estados.push({ fonte: "Apify", ok: true, videos: lista.length, novos: aceites });
    } catch (e) {
      estados.push({ fonte: "Apify", ok: false, erro: e.message });
    }
    fontes.length = 0;
  }
  for (let i = 0; i < fontes.length; i++) {
    const f = fontes[i];
    if (i > 0 && pausa) await esperar(pausa);
    try {
      const dados = await pedirJson(f.url, fetchFn);
      const videos = Array.isArray(dados.videos) ? dados.videos : [];
      let aceites = 0;
      for (const v of videos) {
        const item = normalizar(v, `${f.tipo === "hashtag" ? "#" : "@"}${f.nome}`, agora);
        if (!item) continue;
        if (!todos.has(item.id)) {
          todos.set(item.id, item);
          aceites++;
        }
      }
      estados.push({ fonte: `${f.tipo === "hashtag" ? "#" : "@"}${f.nome}`, ok: true, videos: videos.length, novos: aceites });
    } catch (e) {
      estados.push({ fonte: `${f.tipo === "hashtag" ? "#" : "@"}${f.nome}`, ok: false, erro: e.message });
    }
  }

  const limite = agora - dias * 86_400_000;
  const itens = [...todos.values()]
    .filter((v) => v.criadoEm * 1000 >= limite && v.views >= minViews && v.duracao >= 8 && v.duracao <= 300)
    .sort((a, b) => b.hype - a.hype)
    .slice(0, max);

  return { geradoEm: agora, filtros: { tags, perfis, dias, minViews }, estados, total: todos.size, itens };
}
