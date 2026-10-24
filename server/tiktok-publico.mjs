/** Lê somente JSON publicado nas páginas do TikTok, sem login nem execução de scripts. */
const BASE = "https://www.tiktok.com";
const IDS = new Set(["__FRONTITY_CONNECT_STATE__", "__UNIVERSAL_DATA_FOR_REHYDRATION__", "SIGI_STATE"]);

function dataDoId(id) {
  try {
    const segundos = Number(BigInt(id) >> 32n);
    return segundos >= 1_400_000_000 && segundos <= Date.now() / 1000 + 86400 ? segundos : 0;
  } catch { return 0; }
}

const texto = (s) => String(s || "").replace(/\\u0026/g, "&").replace(/\\n/g, "\n");

function adaptar(v, usuario = {}) {
  if (!v || v.privateItem || !/^\d{15,22}$/.test(String(v.id || ""))) return null;
  const author = v.author && typeof v.author === "object" ? v.author : usuario;
  const uniqueId = author.uniqueId || v.authorUniqueId || (typeof v.author === "string" ? v.author : "");
  if (!/^[\w.]{2,50}$/.test(uniqueId || "")) return null;
  const video = v.video || v;
  const stats = v.stats || v.statsV2 || v;
  if (stats.playCount == null) return null;
  const data = Number(v.createTime) || dataDoId(v.id);
  const largura = Number(video.width) || 0, altura = Number(video.height) || 0;
  return {
    video_id: String(v.id), title: texto(v.desc), author: { unique_id: uniqueId, nickname: texto(author.nickname || uniqueId), signature: texto(author.signature) },
    origin_cover: texto(video.originCover || video.originCoverUrl || video.cover || video.coverUrl),
    duration: video.duration == null ? null : Number(video.duration),
    play_count: stats.playCount, digg_count: stats.diggCount ?? null, comment_count: stats.commentCount ?? null, share_count: stats.shareCount ?? null,
    create_time: data, music_info: v.music || {},
    _publico: true, _dataEstimada: !v.createTime && !!data,
    _temHd: largura > 0 && altura > 0 && Math.min(largura, altura) >= 720,
  };
}

export function extrairVideosPublicos(html) {
  const videos = new Map();
  let total = 0;
  function visitar(v, usuario, profundidade = 0) {
    if (!v || typeof v !== "object" || profundidade > 30 || ++total > 30000) return;
    if (v.userInfo?.privateAccount) return;
    const autor = v.userInfo || usuario;
    const item = adaptar(v, autor);
    if (item) videos.set(item.video_id, item);
    for (const x of Object.values(v)) visitar(x, autor, profundidade + 1);
  }
  for (const m of String(html).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const id = /\bid\s*=\s*["']([^"']+)["']/i.exec(m[1])?.[1];
    if (!IDS.has(id)) continue;
    try { visitar(JSON.parse(m[2])); } catch {}
  }
  return [...videos.values()];
}

export async function buscarTikTokPublico(fonte, fetchFn = fetch, timeout = 8000) {
  const valor = encodeURIComponent(fonte.valor);
  // Perfis incorporados publicam uma seleção dos vídeos recentes. Busca e hashtag
  // só funcionam quando a própria página traz os itens no JSON público.
  const url = fonte.tipo === "perfil" ? `${BASE}/embed/@${valor}`
    : fonte.tipo === "hashtag" ? `${BASE}/tag/${valor}` : `${BASE}/search/video?q=${valor}`;
  const prazo = Date.now() + Math.max(1, timeout);
  let r;
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    r = await fetchFn(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" }, redirect: "error", signal: AbortSignal.timeout(Math.max(1, prazo - Date.now())) });
    // Uma falha transitória pode ser repetida; bloqueios e verificações de acesso não.
    if (r.status < 500 || tentativa || Date.now() + 300 >= prazo) break;
    await r.body?.cancel();
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  if (!r.ok) throw new Error(`TikTok público respondeu HTTP ${r.status}`);
  if (Number(r.headers.get("content-length")) > 5_000_000) throw new Error("Página pública excedeu o limite de tamanho");
  const leitor = r.body?.getReader();
  let html = "";
  if (leitor) {
    const decoder = new TextDecoder(); let bytes = 0;
    try {
      while (true) {
        const { done, value } = await leitor.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > 5_000_000) throw new Error("Página pública excedeu o limite de tamanho");
        html += decoder.decode(value, { stream: true });
      }
      html += decoder.decode();
    } finally { await leitor.cancel().catch(() => {}); }
  } else html = (await r.text()).slice(0, 5_000_000);
  const videos = extrairVideosPublicos(html);
  if (!videos.length) throw new Error(/SlardarWAF|captcha|challenge/i.test(html) ? "TikTok público pediu verificação de acesso" : "TikTok não publicou vídeos acessíveis nesta página (perfil privado, indisponível ou lista vazia)");
  return videos;
}
