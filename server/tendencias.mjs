/**
 * Tendências e Achados de Filmes Narrados do TikTok para o painel «🔥 Tendências».
 *
 * O TikTok não tem API aberta de "em alta". Este módulo pede ao tikwm.com (o mesmo
 * serviço que o importar-video.mjs já usa como plano B) as buscas por hashtag, por
 * termos livres (ex.: "filme narrado", "resumo de filme") e os vídeos de perfis,
 * junta tudo, tira o que é velho/curto/pequeno, deteta sinais de narração (voz
 * original, marcadores de resumo/recap, duração de corte narrado) e ordena por «hype»:
 * visualizações POR HORA (com pouco peso para a idade) e engajamento.
 *
 * É um serviço não oficial: pode mudar ou limitar (1 pedido/segundo). Por isso cada
 * fonte devolve o seu próprio estado e o painel mostra o que falhou.
 */

const TIKWM = "https://www.tikwm.com";
const PAUSA_MS = 1150; // o tikwm grátis aceita ~1 pedido por segundo
const MAX_FONTES = 10;
const TIMEOUT_MS = 12_000;

export const TAGS_NARRADOS_PADRAO = [
  "filmesnarrados",
  "resumodefilmes",
  "filmenarrado",
  "cortesdefilmesnarrados",
  "explicandofilmes",
];

export const TERMOS_NARRADOS_PADRAO = [
  "filme narrado",
  "resumo de filme",
  "cortes de filmes narrados",
];

const GENERICAS = new Set(
  ("fyp foryou foryoupage parati paratii viral viralvideo trending trend tiktok tiktokbrasil brasil filme filmes movie movies " +
    "cena cenas cenadefilme cenasdefilme cinema serie series netflix hbo hbomax primevideo disney edit edits clip clips " +
    "movieclips filmeclips cortes corte shorts reels xyzbca capcut fy fypシ foryourpage explore momentos melhorescenas " +
    "melhorfilme filmesesries filmeseseries recomendacao indicacao dica dicadefilme filmesdeacao acao terror suspense comedia " +
    "drama romance ficcao fantasia animacao anime desenho hollywood " +
    "filmenarrado filmesnarrados resumodefilme resumodefilmes resumofilme resumofilmes resumodofilme recap recapfilme recapfilmes " +
    "recapdefilmes cortesnarrados cortenarrado cortesdefilmesnarrados cenasnarradas narrado narrados narrada narracao " +
    "narracaodefilmes explicandofilmes explicandofilme historiadefilmes historiadofilme finalexplicado " +
    "parte1 parte2 parte3 parte4 parte5 pt1 pt2 pt3").split(" ")
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
 * Frases livres de busca ("filme narrado, resumo de filme") mantendo espaços internos,
 * sem repetidos nem aspas soltas.
 */
export function termosDeBusca(valor, max = 5) {
  const bruto = Array.isArray(valor) ? valor.join(",") : String(valor || "");
  const vistos = new Set();
  const saida = [];
  bruto
    .split(/[,;\n]+/)
    .map((x) =>
      limpo(x)
        .replace(/^["'“”«»#@]+|["'“”«»]+$/g, "")
        .replace(/[^\p{L}\p{N}\s\-']/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
    )
    .forEach((x) => {
      const chave = norm(x);
      if (chave.length >= 3 && x.length <= 60 && !vistos.has(chave)) {
        vistos.add(chave);
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
    let v = limpo(t)
      .replace(/^["“”«»'`´\-–—:|•\p{Extended_Pictographic}\uFE0F\u200D]+|["“”«»'`´\-–—:|•.!?,;\p{Extended_Pictographic}\uFE0F\u200D]+$/gu, "")
      .trim();
    v = v.replace(/\s*(?:[\-–—:|•(\[]+\s*)?(?:parte|pt\.?|epis[oó]dio|ep\.?)\s*\d+[\)\]]?\s*$/i, "").trim();
    v = v.replace(/\s*\((?:19|20)\d{2}\)\s*$/, "").trim();
    v = v.replace(/\s*(?:[\-–—:|•(\[]+\s*)?(?:parte|pt\.?|epis[oó]dio|ep\.?)\s*\d+[\)\]]?\s*$/i, "").trim();
    v = v.replace(/^["“”«»'`´\-–—:|•\p{Extended_Pictographic}\uFE0F\u200D]+|["“”«»'`´\-–—:|•.!?,;\p{Extended_Pictographic}\uFE0F\u200D]+$/gu, "").trim();
    if (v.length < 2 || v.length > 60) return;
    if (v.split(" ").length > 8) return;
    if (GENERICAS.has(norm(v).replace(/ /g, ""))) return;
    if (!achados.some((a) => norm(a.titulo) === norm(v))) achados.push({ titulo: v, origem });
  };

  // 1. entre aspas
  for (const m of texto.matchAll(/["“«]([^"”»\n]{2,60})["”»]/g)) juntar(m[1], "aspas");
  // 2. depois de marcadores («Nome do filme: X», «Filme narrado: X», «Resumo de: X», «Filme: X», «🎬 X»)
  for (const m of texto.matchAll(/(?:nome\s+do\s+(?:fil+me|s[eé]rie)|fil+me\s+narrado|resumo\s+(?:do\s+fil+me|da\s+s[eé]rie|de)|fil+me|s[eé]rie|movie|series?|anime|novela)\s*[:\-–—]\s*([^\n#|•@(]{2,60})/gi)) {
    juntar(m[1], "marcador");
  }
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

const RE_NARRADO_LEGENDA =
  /\b(filmes?\s*narrados?|cortes?\s*(?:de\s*filmes?\s*)?narrados?|cenas?\s*narradas?|narrado|narrada|narrando|narracao|narra[çc][aã]o|filmenarrado|filmesnarrados|cortesdefilmesnarrados|cenasnarradas|narracaodefilmes)\b/i;
const RE_RESUMO_LEGENDA =
  /\b(resumo\s*(?:de|do|da|completo)?\s*(?:filme|s[eé]rie)?|resumindo|recap|explicando\s*(?:o\s*)?(?:filme|final)|final\s*explicado|hist[oó]ria\s*(?:do|completa\s*do)\s*filme|resumodefilmes?|resumodofilme|recapfilmes?|explicandofilmes?|historiadefilmes?)\b/i;
const RE_PARTE_LEGENDA = /\b(parte\s*\d+|pt\.?\s*\d+)\b/i;
const RE_CANAL_NARRADO = /(narrad|resumo|recap|explica|historiadefilme|filmenarrado)/i;

/**
 * Avalia sinais de que o vídeo é um corte de filme narrado / recap com locução
 * (e não apenas um edit curto com música comercial).
 */
export function analisarNarrado({ legenda = "", autor = "", nomeAutor = "", musicaTitulo = "", musicaOriginal = false, duracao = 0 } = {}) {
  const txt = String(legenda || "");
  const txtNorm = norm(txt);
  const canal = `${autor || ""} ${nomeAutor || ""}`;
  const somOriginal = Boolean(
    musicaOriginal || /som\s*original|original\s*sound|[aá]udio\s*original/i.test(String(musicaTitulo || ""))
  );

  let nota = 0;
  const sinais = [];

  const temNarrado = RE_NARRADO_LEGENDA.test(txt) || RE_NARRADO_LEGENDA.test(txtNorm);
  const temResumo = RE_RESUMO_LEGENDA.test(txt) || RE_RESUMO_LEGENDA.test(txtNorm);
  const temParte = RE_PARTE_LEGENDA.test(txt);
  const temCanal = RE_CANAL_NARRADO.test(canal) || RE_CANAL_NARRADO.test(norm(canal));

  if (temNarrado) {
    nota += 45;
    sinais.push("🎙️ Narrado");
  }
  if (temResumo) {
    nota += temNarrado ? 15 : 38;
    sinais.push("📖 Resumo");
  }
  if (temCanal) {
    nota += 22;
    if (!temNarrado) sinais.push("🎙️ Canal narrado");
  }
  if (somOriginal) {
    nota += 20;
    sinais.push("🔊 Voz original");
  }
  if (temParte) {
    nota += 10;
    sinais.push("📑 Parte");
  }
  if (duracao >= 60) {
    nota += 15;
    sinais.push("⏱️ 1min+");
  } else if (duracao >= 35) {
    nota += 8;
  }

  // Áudio original e duração também aparecem em cenas sem locução e vídeos comuns.
  // Só marcadores de narração/resumo ou um canal especializado habilitam o filtro.
  const narrado = Boolean(temNarrado || temResumo || temCanal);
  return {
    narrado,
    notaNarrado: Math.min(100, nota),
    sinaisNarrado: sinais,
    somOriginal,
  };
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
  const legenda = limpo(v.title || v.desc || "");
  const nomeAutor = limpo(autor.nickname || usuario);
  const duracao = Number(v.duration) || 0;
  const music = v.music_info || v.music || {};
  const infoNarrado = analisarNarrado({
    legenda,
    autor: usuario,
    nomeAutor,
    musicaTitulo: limpo(music.title || ""),
    musicaOriginal: Boolean(music.original),
    duracao,
  });
  const tamanhoHd = Number(v.hd_size) || 0;
  const tamanhoPadrao = Number(v.size) || 0;
  const temHd = Boolean(v.hdplay || tamanhoHd > 0 || v._temHd);

  const item = {
    id,
    url: `https://www.tiktok.com/@${usuario}/video/${id}`,
    autor: usuario,
    nomeAutor,
    legenda,
    capa: limpo(v.origin_cover || v.cover || ""),
    duracao,
    views: Number(v.play_count ?? v.playCount) || 0,
    curtidas: Number(v.digg_count ?? v.diggCount) || 0,
    comentarios: Number(v.comment_count ?? v.commentCount) || 0,
    compartilhamentos: Number(v.share_count ?? v.shareCount) || 0,
    criadoEm: Number(v.create_time ?? v.createTime) || 0,
    origem,
    temHd,
    tamanhoBytes: tamanhoHd || tamanhoPadrao || 0,
    narrado: infoNarrado.narrado,
    notaNarrado: infoNarrado.notaNarrado,
    sinaisNarrado: infoNarrado.sinaisNarrado,
    somOriginal: infoNarrado.somOriginal,
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
  const music = v.musicMeta || {};
  const criado = Number(v.createTime) || Math.floor(Date.parse(v.createTimeISO || "") / 1000) || 0;
  const maiorLado = Math.max(Number(video.height) || 0, Number(video.width) || 0);
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
    music_info: {
      title: music.musicName || "",
      author: music.musicAuthor || "",
      original: Boolean(music.musicOriginal),
    },
    _temHd: maiorLado >= 1080,
  };
}

async function buscarNoApify(token, tags, perfis, termos, fetchFn) {
  const url = `https://api.apify.com/v2/acts/${APIFY_ATOR}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
  const corpo = {
    hashtags: tags,
    profiles: perfis,
    ...(termos && termos.length ? { searchQueries: termos } : {}),
    resultsPerPage: 25,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
    shouldDownloadSubtitles: false,
    shouldDownloadSlideshowImages: false,
  };
  let r;
  try {
    r = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(corpo),
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
 * @param {{modo?:"cortes"|"narrados", tags?:string[]|string, termos?:string[]|string, perfis?:string[]|string, dias?:number, minViews?:number, minDuracao?:number, maxDuracao?:number, apenasNarrados?:boolean, max?:number, apifyToken?:string}} p
 * @param {{fetchFn?:Function, agora?:number, pausa?:number}} deps
 */
export async function buscarTendencias(p = {}, deps = {}) {
  const fetchFn = deps.fetchFn || fetch;
  const agora = deps.agora || Date.now();
  const pausa = deps.pausa ?? PAUSA_MS;
  const modo = p.modo === "narrados" ? "narrados" : "cortes";
  const tags = listaDe(p.tags, 5);
  const termos = termosDeBusca(p.termos, 4);
  const perfis = listaDe(p.perfis, 5);
  const diasPadrao = modo === "narrados" ? 14 : 7;
  const dias = Math.max(1, Math.min(90, Number(p.dias) || diasPadrao));
  const minViews = Math.max(0, p.minViews != null && p.minViews !== "" ? Number(p.minViews) : 20_000);
  const minDuracao = Math.max(5, Math.min(300, Number(p.minDuracao) || (modo === "narrados" ? 25 : 8)));
  const maxDuracao = Math.max(minDuracao, Math.min(900, Number(p.maxDuracao) || (modo === "narrados" ? 600 : 300)));
  const apenasNarrados =
    modo === "narrados"
      ? p.apenasNarrados !== false && String(p.apenasNarrados) !== "0" && String(p.apenasNarrados) !== "false"
      : Boolean(p.apenasNarrados && String(p.apenasNarrados) !== "0" && String(p.apenasNarrados) !== "false");
  const max = Math.max(5, Math.min(100, Number(p.max) || 40));

  const fontes = [
    ...tags.map((t) => ({
      tipo: "hashtag",
      rotulo: `#${t}`,
      url: `${TIKWM}/api/feed/search?keywords=${encodeURIComponent("#" + t)}&count=30&cursor=0&hd=1`,
    })),
    ...termos.map((q) => ({
      tipo: "termo",
      rotulo: `🔎 ${q}`,
      url: `${TIKWM}/api/feed/search?keywords=${encodeURIComponent(q)}&count=30&cursor=0&hd=1`,
    })),
    ...perfis.map((u) => ({
      tipo: "perfil",
      rotulo: `@${u}`,
      url: `${TIKWM}/api/user/posts?unique_id=${encodeURIComponent(u)}&count=30&cursor=0&hd=1`,
    })),
  ].slice(0, MAX_FONTES);

  const estados = [];
  const todos = new Map();
  const token = String(p.apifyToken || "").trim();
  if (token) {
    // Com token do Apify usa só ele (uma execução para todas as hashtags, termos e perfis): é a via estável.
    try {
      const lista = await buscarNoApify(token, tags, perfis, termos, fetchFn);
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
        const item = normalizar(v, f.rotulo, agora);
        if (!item) continue;
        if (!todos.has(item.id)) {
          todos.set(item.id, item);
          aceites++;
        } else {
          // Se o mesmo vídeo apareceu também numa busca narrada/perfil, preserva o melhor sinal de HD
          const anterior = todos.get(item.id);
          if (item.temHd && !anterior.temHd) anterior.temHd = true;
          if (item.tamanhoBytes > anterior.tamanhoBytes) anterior.tamanhoBytes = item.tamanhoBytes;
        }
      }
      estados.push({ fonte: f.rotulo, ok: true, videos: videos.length, novos: aceites });
    } catch (e) {
      estados.push({ fonte: f.rotulo, ok: false, erro: e.message });
    }
  }

  const limite = agora - dias * 86_400_000;
  const pontuacaoOrdenacao = (v) =>
    modo === "narrados" ? Math.round(v.hype * (1 + (v.notaNarrado || 0) / 100)) : v.hype;

  const itens = [...todos.values()]
    .filter((v) => {
      if (v.criadoEm * 1000 < limite) return false;
      if (v.views < minViews) return false;
      if (v.duracao < minDuracao || v.duracao > maxDuracao) return false;
      if (apenasNarrados && !v.narrado) return false;
      return true;
    })
    .sort((a, b) => pontuacaoOrdenacao(b) - pontuacaoOrdenacao(a) || b.hype - a.hype)
    .slice(0, max);

  return {
    geradoEm: agora,
    modo,
    filtros: { tags, termos, perfis, dias, minViews, minDuracao, maxDuracao, apenasNarrados },
    estados,
    total: todos.size,
    itens,
  };
}
