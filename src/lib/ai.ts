/**
 * 🧠 Identificação do filme/série e geração de ganchos/legendas.
 *  - NVIDIA (via proxy /api/public/nvidia) com lista de modelos vision+text
 *  - Google Gemini (vídeo/áudio + Google Search) quando há chave
 *  - TMDB para títulos, sinopses, géneros e pôster oficial
 */
import { HttpError, fetchTimeout, normalizeText } from "./util";
import type { Ident, Settings } from "./types";

export const NVIDIA_MODELS = [
  "meta/llama-3.2-90b-vision-instruct",
  "meta/llama-3.2-11b-vision-instruct",
  "deepseek-ai/deepseek-v4.1-flash",
  "google/gemma-4-31b-it",
  "nvidia/nemotron-3.5-lightning-30b-a3b",
  "nvidia/nemotron-3-super-120b-a12b",
  "openai/gpt-oss-20b",
  "moonshotai/kimi-k2.6",
  "z-ai/glm-5.3-flash",
  "meta/llama-3.3-70b-instruct",
  "meta/llama-3.1-70b-instruct",
  "meta/llama-3.1-8b-instruct",
];

export const NVIDIA_VISION_MODELS = [
  "meta/llama-3.2-90b-vision-instruct",
  "google/gemma-4-31b-it",
  "meta/llama-3.2-11b-vision-instruct",
  "google/gemma-3-12b-it",
  "microsoft/phi-3-vision-128k-instruct",
  "nvidia/cosmos-reason2-8b",
];

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_FALLBACK_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-pro",
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
];

const TMDB_BASE = "https://api.themoviedb.org/3";
export const TMDB_IMG = "https://image.tmdb.org/t/p";

const brokenNvidiaModels = new Set<string>();

const cleanKey = (k: string) => (k || "").trim();

/* ------------------------------------------------------------------ NVIDIA */

async function nvidiaChat(
  key: string,
  content: string | { type: string; text?: string; image_url?: { url: string } }[],
  lowTemp: boolean,
  model: string,
  maxTokens = 1200
): Promise<string> {
  const k = cleanKey(key);
  const res = await fetchTimeout("NVIDIA", "/api/public/nvidia", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${k}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content }],
      temperature: lowTemp ? 0.15 : 0.65,
      max_tokens: maxTokens,
    }),
  }, 90000);
  const json: any = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new HttpError(json?.error || `NVIDIA HTTP ${res.status}`, res.status);
    throw err;
  }
  const text = json?.choices?.[0]?.message?.content ?? "";
  if (!String(text).trim()) throw new HttpError("A NVIDIA devolveu uma resposta vazia.");
  return text;
}

async function nvidiaText(key: string, prompt: string, lowTemp = false): Promise<string> {
  let last: unknown = null;
  const order = [...NVIDIA_MODELS.filter((m) => !brokenNvidiaModels.has(m)), ...NVIDIA_MODELS.filter((m) => brokenNvidiaModels.has(m))];
  for (const model of order) {
    try {
      return await nvidiaChat(key, prompt, lowTemp, model);
    } catch (e) {
      last = e;
      if (e instanceof HttpError && (e.status === 401 || e.status === 403)) throw e;
      if (e instanceof HttpError && e.status === 404) {
        brokenNvidiaModels.add(model);
        continue;
      }
    }
  }
  throw last instanceof Error ? last : new Error("Não foi possível obter resposta da NVIDIA.");
}

async function nvidiaVision(key: string, prompt: string, firstImage?: string, lowTemp = false): Promise<string> {
  let last: unknown = null;
  const order = [...NVIDIA_VISION_MODELS.filter((m) => !brokenNvidiaModels.has(m)), ...NVIDIA_VISION_MODELS.filter((m) => brokenNvidiaModels.has(m))];
  for (const model of order) {
    try {
      return await nvidiaChat(
        key,
        firstImage ? [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: firstImage } }] : prompt,
        lowTemp,
        model
      );
    } catch (e) {
      last = e;
      if (e instanceof HttpError && (e.status === 401 || e.status === 403)) throw e;
      if (e instanceof HttpError && e.status === 404) {
        brokenNvidiaModels.add(model);
        continue;
      }
    }
    if (firstImage) {
      try {
        return await nvidiaChat(key, `<img src="${firstImage}" />\n\n${prompt}`, lowTemp, model);
      } catch (e) {
        last = e;
        if (e instanceof HttpError && (e.status === 401 || e.status === 403)) throw e;
        if (e instanceof HttpError && e.status === 404) brokenNvidiaModels.add(model);
      }
    }
  }
  throw last instanceof Error ? last : new Error("Falha ao analisar as imagens na NVIDIA.");
}

export async function testNvidiaKey(key: string): Promise<void> {
  const k = cleanKey(key);
  if (!k.startsWith("nvapi-")) throw new HttpError('A chave NVIDIA começa por "nvapi-".');
  await fetchTimeout("NVIDIA", "/api/public/nvidia", { headers: { Authorization: `Bearer ${k}` } }, 30000);
}

/* ------------------------------------------------------------------ Gemini */

export async function listGeminiModels(key: string): Promise<string[]> {
  const k = cleanKey(key);
  try {
    const res = await fetch(`${GEMINI_BASE}/models?key=${encodeURIComponent(k)}`);
    if (res.ok) {
      const json: any = await res.json();
      const models: string[] = (Array.isArray(json?.models) ? json.models : [])
        .map((m: any) => String(m?.name || "").replace(/^models\//, ""))
        .filter((n: string) => /gemini/.test(n) && !/embed|image|tts|aqa/i.test(n));
      if (models.length) {
        const score = (p: string) =>
          p === "gemini-2.5-flash" ? 100 :
          /^gemini-3.*flash/.test(p) ? 95 :
          p === "gemini-2.5-flash-lite" ? 95 :
          /^gemini-2\.5-flash/.test(p) ? 90 :
          p === "gemini-2.5-pro" ? 85 :
          /^gemini-2\.5-pro/.test(p) ? 80 :
          p === "gemini-2.0-flash" ? 75 :
          /flash/.test(p) ? 70 :
          /pro/.test(p) ? 60 : 50;
        return models.sort((a, b) => score(b) - score(a)).slice(0, 6);
      }
    }
  } catch {
    /* fallback */
  }
  return GEMINI_FALLBACK_MODELS;
}

export async function testGeminiKey(key: string): Promise<void> {
  const k = cleanKey(key);
  if (!k) throw new HttpError("Insere a chave da API Google Gemini.");
  await fetchTimeout("Google Gemini", `${GEMINI_BASE}/models?key=${encodeURIComponent(k)}`, undefined, 25000);
}

export interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
}

/** generateContent com partes (texto/imagens/áudio) e Google Search opcional. */
export async function geminiGenerate(
  key: string,
  parts: GeminiPart[],
  useSearch = false,
  lowTemp = false
): Promise<string> {
  const k = cleanKey(key);
  const models = await listGeminiModels(k);
  let last: unknown = null;
  for (const model of models) {
    try {
      const res = await fetchTimeout(
        "Google Gemini",
        `${GEMINI_BASE}/models/${model}:generateContent?key=${encodeURIComponent(k)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts }],
            ...(useSearch ? { tools: [{ google_search: {} }] } : {}),
            generationConfig: { temperature: lowTemp ? 0.2 : 0.7 },
          }),
        },
        120000
      );
      const json: any = await res.json().catch(() => null);
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) throw new HttpError("Chave Gemini inválida (401/403).", res.status);
        if (res.status === 404 || res.status === 429) {
          last = new HttpError(`Gemini ${model} HTTP ${res.status}`, res.status);
          continue;
        }
        throw new HttpError(json?.error?.message || `Gemini HTTP ${res.status}`, res.status);
      }
      const text = json?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text || "").join("") || "";
      if (!text.trim()) throw new HttpError("O Gemini devolveu uma resposta vazia.");
      return text;
    } catch (e) {
      last = e;
      if (e instanceof HttpError && (e.status === 401 || e.status === 403)) throw e;
    }
  }
  throw last instanceof Error ? last : new Error("Não foi possível obter resposta do Gemini.");
}

/* -------------------------------------------------------------------- TMDB */

async function tmdbFetch(key: string, path: string, params: Record<string, string> = {}): Promise<any> {
  const url = new URL(TMDB_BASE + path);
  url.searchParams.set("api_key", cleanKey(key));
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetchTimeout("TMDB", url.toString(), undefined, 20000);
  const json: any = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401) throw new HttpError("Chave TMDB inválida (401).", 401);
    if (res.status === 404) throw new HttpError("Recurso não encontrado no TMDB (404).", 404);
    throw new HttpError(`TMDB HTTP ${res.status}: ${json?.status_message || ""}`, res.status);
  }
  return json;
}

export async function testTmdbKey(key: string): Promise<void> {
  await tmdbFetch(key, "/configuration");
}

interface TmdbCandidate {
  kind: "movie" | "tv";
  id: number;
  title: string;
  original: string;
  year: number | string;
  poster: string;
  overview: string;
  popularity: number;
}

function mapTmdb(r: any, kind: "movie" | "tv"): TmdbCandidate {
  const title = kind === "movie" ? r.title || r.original_title || "" : r.name || r.original_name || "";
  const original = kind === "movie" ? r.original_title || title : r.original_name || title;
  const date = kind === "movie" ? r.release_date : r.first_air_date;
  return {
    kind,
    id: r.id,
    title,
    original,
    year: date ? String(date).slice(0, 4) : "",
    poster: r.poster_path ? `${TMDB_IMG}/w300${r.poster_path}` : "",
    overview: r.overview || "",
    popularity: Number(r.popularity) || 0,
  };
}

export async function tmdbSearchMulti(key: string, query: string): Promise<TmdbCandidate[]> {
  if (!query.trim()) return [];
  const [movies, tv] = await Promise.all([
    tmdbFetch(key, "/search/movie", { query, language: "pt-BR" }).catch(() => ({ results: [] })),
    tmdbFetch(key, "/search/tv", { query, language: "pt-BR" }).catch(() => ({ results: [] })),
  ]);
  const all = [
    ...(movies.results ?? []).map((r: any) => mapTmdb(r, "movie")),
    ...(tv.results ?? []).map((r: any) => mapTmdb(r, "tv")),
  ];
  return all.sort((a, b) => b.popularity - a.popularity).slice(0, 10);
}

export async function tmdbDetails(key: string, kind: "movie" | "tv", id: number): Promise<TmdbCandidate & { genres: string[] }> {
  const json = await tmdbFetch(key, `/${kind}/${id}`, { language: "pt-BR" });
  const base = mapTmdb(json, kind);
  return { ...base, genres: (json.genres || []).map((g: any) => g.name) };
}

async function tmdbPersonSearch(key: string, names: string[]): Promise<string[]> {
  const clean = names
    .map((n) => n.replace(/\([^)]*\)/g, "").replace(/como\s+.*/i, "").trim())
    .filter((n) => n.length >= 3)
    .slice(0, 2);
  if (!clean.length) return [];
  try {
    const results = await Promise.all(
      clean.map((q) => tmdbFetch(key, "/search/person", { query: q, language: "pt-BR" }).catch(() => ({ results: [] })))
    );
    const known: string[] = [];
    for (const r of results) {
      const p = (r.results || [])[0];
      if (p?.name) known.push(p.name);
    }
    return known;
  } catch {
    return [];
  }
}

/** Pontua candidatos TMDB contra o que a IA viu (título/ano/atores). */
function scoreCandidate(c: TmdbCandidate, hint: { title?: string; year?: number; actors?: string[]; kind?: string }): number {
  let score = 0;
  const nt = normalizeText(hint.title || "");
  const nc = normalizeText(c.title);
  const no = normalizeText(c.original);
  if (nt && (nc.includes(nt) || nt.includes(nc) || no.includes(nt) || nt.includes(no))) score += 100;
  if (hint.actors?.length) score += 0; // atores confirmados via person search abaixo
  if (hint.kind && c.kind === hint.kind) score += 12;
  const year = Number(hint.year) || 0;
  if (year && c.year) {
    const d = Math.abs(year - Number(c.year));
    if (d === 0) score += 22;
    else if (d <= 2) score += 14;
  }
  score += Math.min(28, Math.log10(c.popularity + 1) * 14);
  return score;
}

/* ------------------------------------------------- ganchos + identificação */

export interface SceneAnalysis {
  cena: string;
  ganchos: string[];
}

function hintsFromFileName(fileName?: string): string {
  const parts: string[] = [];
  for (const raw of [fileName]) {
    if (!raw) continue;
    const c = raw
      .replace(/\.[^.]+$/, "")
      .replace(/_cineclip$/i, "")
      .replace(/[._-]+/g, " ")
      .trim();
    if (
      !/^(vid|video|clip|clipe|mov|mp4|whatsapp|instagram|tiktok|reels|shorts|download|captura|screen|recording|untitled|sem titulo|novo|final|copy|lv|in|out|test|teste|img|dsc|pxl)[\s\d_-]*$/i.test(c) &&
      !/^[\d\s_-]+$/.test(c) &&
      c.length >= 3
    )
      parts.push(c);
  }
  return [...new Set(parts)].join(" / ");
}

/** Analisa a cena (quadros + áudio) e devolve descrição + 3 ganchos virais. */
export async function analyzeScene(
  settings: Settings,
  frames: string[],
  audio: { mimeType: string; base64: string } | null,
  fileName?: string
): Promise<SceneAnalysis> {
  const hint = hintsFromFileName(fileName);
  const lang = settings.lang === "pt-PT" ? "Escreve em Português de Portugal." : "Escreva em Português do Brasil.";
  const prompt = `Analise as imagens (e o áudio, se fornecido) desta cena de filme/série${hint ? ` (pista do arquivo: "${hint}")` : ""}.\n${lang}\n1. Descreva em 1 ou 2 frases o que está acontecendo na cena (ação visual, fala/diálogo, emoção ou tensão) no campo "cena".\n2. Crie 3 opções de GANCHOS VIRAIS curtos (de 6 a 12 palavras cada, terminando com 1 emoji expressivo) para colocar como legenda no topo do vídeo 9:16 (estilo TikTok/Reels/Shorts). REGRAS OBRIGATÓRIAS PARA OS GANCHOS: - Cada gancho DEVE refletir diretamente o conteúdo e a situação real da cena (o que acontece ou o que é dito), gerando curiosidade imediata para assistir até o fim. - NUNCA use frases genéricas vazias como "Você precisa assistir esse filme". - Não cite nomes de atores. - Responda SOMENTE com JSON válido neste formato exato: {"cena": "resumo do que acontece na cena", "ganchos": ["Gancho 1 😳", "Gancho 2 🔥", "Gancho 3 😱"]}`;

  let raw = "";
  if (cleanKey(settings.geminiKey)) {
    try {
      const parts: GeminiPart[] = [{ text: prompt }];
      for (const f of frames.slice(1, 7)) {
        const m = f.match(/^data:([^;]+);base64,(.+)$/);
        if (m) parts.push({ inline_data: { mime_type: m[1], data: m[2] } });
      }
      if (audio) parts.push({ inline_data: { mime_type: audio.mimeType, data: audio.base64 } });
      raw = await geminiGenerate(settings.geminiKey, parts, false, false);
    } catch (e) {
      if (!cleanKey(settings.nvidiaKey)) throw e;
    }
  }
  if (!raw && cleanKey(settings.nvidiaKey)) {
    try {
      raw = await nvidiaVision(settings.nvidiaKey, prompt, frames[0], false);
    } catch (e) {
      if (e instanceof HttpError && (e.status === 401 || e.status === 403)) throw e;
      raw = await nvidiaText(
        settings.nvidiaKey,
        `${prompt} Crie 3 opções de GANCHOS VIRAIS curtos e impactantes (de 6 a 12 palavras cada, terminando com 1 emoji expressivo) para colocar no topo de um corte de cena tensa de filme/série${hint ? ` relacionado a "${hint}"` : ""}. Responda SOMENTE com JSON válido: {"cena": "Cena tensa e decisiva do clipe", "ganchos": ["Gancho 1 😳", "Gancho 2 🔥", "Gancho 3 😱"]}`,
        false
      );
    }
  }
  if (!raw) throw new HttpError("Adiciona a tua chave Google Gemini ou NVIDIA nas configurações para gerar o gancho pelo conteúdo do vídeo.");
  const m = raw.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(m ? m[0] : raw);
  const ganchos = Array.isArray(parsed.ganchos) ? parsed.ganchos.map((g: unknown) => String(g)).slice(0, 3) : [];
  return { cena: String(parsed.cena || ""), ganchos };
}

export interface IdentifyResult {
  media: Ident;
  raw: { atores?: string[]; fala_do_audio?: string; provedor: string };
}

/** Identifica o filme/série da cena e confirma no TMDB. */
export async function identifyFilm(
  settings: Settings,
  frames: string[],
  audio: { mimeType: string; base64: string } | null,
  scene: SceneAnalysis,
  userHint: string,
  fileName?: string
): Promise<IdentifyResult> {
  if (!cleanKey(settings.tmdbKey)) throw new HttpError("Para identificar o filme e gerar a legenda, adiciona as tuas chaves NVIDIA & TMDB.");
  const hint = hintsFromFileName(fileName);
  const prompt = `Com base ${scene.cena ? `na cena descrita ("${scene.cena}")` : "nas imagens"}${userHint ? ` e na dica do utilizador ("${userHint}")` : ""}${hint ? ` e no nome do arquivo ("${hint}")` : ""}, identifica o filme ou série.\nResponde SOMENTE com JSON válido: {"titulo": "título em pt", "titulo_original": "título original", "ano": 1999, "tipo": "filme" | "serie", "atores": ["nome do ator 1", "nome do ator 2"], "fala_do_audio": "frase ouvida no áudio, se houver"}`;

  let raw = "";
  let provedor = "nvidia";
  if (cleanKey(settings.geminiKey)) {
    try {
      const parts: GeminiPart[] = [{ text: prompt }];
      for (const f of frames.slice(0, 4)) {
        const m = f.match(/^data:([^;]+);base64,(.+)$/);
        if (m) parts.push({ inline_data: { mime_type: m[1], data: m[2] } });
      }
      if (audio) parts.push({ inline_data: { mime_type: audio.mimeType, data: audio.base64 } });
      raw = await geminiGenerate(settings.geminiKey, parts, true, true);
      provedor = "gemini";
    } catch (e) {
      if (!cleanKey(settings.nvidiaKey)) throw e;
    }
  }
  if (!raw && cleanKey(settings.nvidiaKey)) {
    raw = await nvidiaVision(settings.nvidiaKey, prompt, frames[0], true);
    provedor = "nvidia";
  }
  if (!raw) throw new HttpError("A IA não conseguiu identificar o clipe.");
  const m = raw.match(/\{[\s\S]*\}/);
  const guess = JSON.parse(m ? m[0] : raw);

  const wantedKind = guess.tipo === "serie" || guess.tipo === "série" ? "tv" : guess.kind === "tv" ? "tv" : "movie";
  const queries = [guess.titulo_original, guess.titulo, userHint, hint].filter(Boolean) as string[];
  let best: (TmdbCandidate & { genres: string[] }) | null = null;
  let alternatives: TmdbCandidate[] = [];
  for (const qy of queries) {
    const cands = await tmdbSearchMulti(settings.tmdbKey, qy);
    alternatives = cands;
    const scored = cands
      .map((c) => ({ c, s: scoreCandidate(c, { title: qy, year: Number(guess.ano) || 0, kind: wantedKind }) }))
      .sort((a, b) => b.s - a.s);
    if (scored[0] && scored[0].s >= 40) {
      best = await tmdbDetails(settings.tmdbKey, scored[0].c.kind, scored[0].c.id);
      break;
    }
  }
  if (!best) throw new HttpError("A IA não conseguiu identificar o clipe.");

  const atoresIa: string[] = Array.isArray(guess.atores) ? guess.atores.map(String) : [];
  const atores = await tmdbPersonSearch(settings.tmdbKey, atoresIa);

  return {
    media: {
      kind: best.kind,
      id: best.id,
      title: best.title,
      original: best.original,
      year: best.year,
      poster: best.poster.replace("/w300/", "/w300/"),
      overview: best.overview,
      genres: best.genres,
      popularity: best.popularity,
      alternativas: alternatives.slice(0, 6).map((c) => ({ ...c, genres: [], alternativas: [] })),
      via: provedor,
      cena: scene.cena,
      atores,
    },
    raw: { atores, fala_do_audio: guess.fala_do_audio ? String(guess.fala_do_audio) : undefined, provedor },
  };
}

/* ------------------------------------------------------------------ legenda */

/** Gera a legenda pronta a publicar (formato exato do CineClip). */
export async function buildCaption(
  settings: Settings,
  media: Ident,
  scene?: { cena?: string; hookText?: string }
): Promise<string> {
  const isTv = media.kind === "tv";
  const langInstr =
    settings.lang === "pt-PT"
      ? "Escreve em Português de Portugal (ortografia e vocabulário europeus: 'ecrã', 'tu', 'estás a sentir', 'transformou-se')."
      : "Escreva em Português do Brasil (ortografia e vocabulário brasileiros), mas mantendo a 2ª pessoa 'tu' com conjugação natural brasileira quando possível.";
  const firstLine = `QUER ASSISTIR A ${isTv ? "ESTA SÉRIE" : "ESTE FILME"}? LINK NA BIO! 🎬`;
  const sceneBlock =
    scene?.cena || scene?.hookText
      ? ` CONTEÚDO ESPECÍFICO DO VÍDEO/CENA ENVIADA: - O que acontece na cena do vídeo: ${scene.cena || "Cena tensa e decisiva do clipe"} - Gancho principal do vídeo: ${scene.hookText || ""} IMPORTANTE: O Parágrafo 1 DEVE começar com um GANCHO (hook) irresistível diretamente ligado ao que acontece nesta cena do vídeo, prendendo quem acabou de ver o clipe, e o Parágrafo 2 deve destacar em **negrito** exatamente o momento de tensão desta cena!`
      : "";
  const prompt = `${langInstr}  Gera uma legenda para redes sociais sobre ${isTv ? "a série" : "o filme"} "${media.title}" (título original: "${media.original}", ${media.year}). Géneros: ${media.genres.join(", ") || "desconhecido"}. Sinopse oficial (não reveles nada além disto): ${media.overview || "(sem sinopse)"}${sceneBlock}  FORMATO EXATO (texto puro, uma linha em branco entre blocos, sem títulos de secção):  ${firstLine}  🎬 ${media.title} (${media.original})  {Parágrafo 1}  {Parágrafo 2}  {Parágrafo 3}  #Hashtag1 #Hashtag2 #Hashtag3 #Hashtag4  REGRAS: - Primeira linha literalmente: "${firstLine}" - Linha do título exatamente: "🎬 ${media.title} (${media.original})" - Parágrafo 1 (80–110 palavras): começa com um GANCHO forte diretamente conectado ao conteúdo da cena do vídeo; tom de trailer épico; premissa, clima e conflitos emocionais SEM dar spoilers do final; NUNCA citar nomes de personagens nem de atores. - Parágrafo 2 (80–110 palavras): começa com frase de transição (ex.: "O grande trunfo da produção reside na forma magnética com que retrata..."), aponta o momento-chave da cena do vídeo em **negrito** dentro da frase com descrição intensa de tensão emocional, seguida de uma sequência de gerúndios entre travessões (ex.: "— sentindo o pânico da traição, o desespero perante a perda irreparável e a angústia sufocante de enfrentar o seu destino trágico —"). - Parágrafo 3 (40–60 palavras): fecho no estilo "É uma obra fascinante e indispensável para quem aprecia dramas profundos, histórias de superação e narrativas emocionantes que marcam para sempre." - Estilo: 2ª pessoa do singular ("tu"), adjetivação intensa e sensorial, vocabulário de drama psicológico (implacável, sufocante, devastador, visceral, cru, inquebrável, magnético), frases longas encadeadas, ZERO spoilers, ZERO diálogos citados, nenhum emoji além dos dois 🎬 já definidos. - Total: 200–280 palavras. - Hashtags: EXATAMENTE 4 no máximo, na última linha, separadas por espaço: 1 do título/franquia (sem espaços) + ${isTv ? "#Series" : "#Filme"} + 2 de género/tema. NUNCA mais de 4.`;

  let raw = "";
  if (cleanKey(settings.geminiKey)) {
    raw = await geminiGenerate(settings.geminiKey, [{ text: prompt }], false, false);
  } else if (cleanKey(settings.nvidiaKey)) {
    raw = await nvidiaText(settings.nvidiaKey, prompt, false);
  } else {
    throw new HttpError("Para identificar o filme e gerar a legenda, adiciona as tuas chaves NVIDIA & TMDB.");
  }
  return normalizeCaption(raw, media, firstLine);
}

/** Normaliza a resposta da IA ao formato exato (máx. 4 hashtags). */
export function normalizeCaption(raw: string, media: Ident, firstLine: string): string {
  const text = raw.replace(/\r/g, "").replace(/```[a-z]*\n?/g, "").trim();
  const blocks = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const paras = blocks.filter((p) => !/^QUER ASSISTIR/i.test(p) && !p.startsWith("🎬") && !/^#/.test(p));
  let tags = ((blocks.slice().reverse().find((p) => /^#/.test(p)) ?? "").match(/#[\p{L}\p{N}_]+/gu) ?? []).slice(0, 4);
  if (!tags.length)
    tags = ["#" + media.original.replace(/[^\p{L}\p{N}]/gu, ""), media.kind === "tv" ? "#Series" : "#Filme"];
  const clean = paras.map((p) => p.replace(/🎬/g, "").replace(/\n/g, " "));
  return [firstLine, `🎬 ${media.title} (${media.original})`, ...clean, tags.join(" ")].join(`\n\n`);
}
