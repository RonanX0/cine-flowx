#!/usr/bin/env node
/**
 * Testes do motor VidScio, da limpeza dos ganchos (bug do "Gancho 1: …"),
 * das fórmulas virais, do corte 9:16 e da identificação de filmes.
 *
 *   node tools/test-vidscio-identificacao.mjs
 *
 * Parte A — o ficheiro: os prompts já não usam o placeholder "Gancho 1 😳"
 *           (que a IA copiava para o texto), proíbem numerar e passam todos
 *           os ganchos pela limpeza (_gcLimpaLista).
 * Parte B — o bundle REAL num DOM (jsdom + IndexedDB falso):
 *           • window.CineClipCore.limparGancho limpa "Gancho 1: ele matou a
 *             mulher 😳" → "ele matou a mulher 😳" (e não estraga ganchos
 *             legítimos que começam por número);
 *           • gerarGancho com a IA falsa devolvendo ganchos sujos (JSON e
 *             texto solto) devolve só a frase pronta;
 *           • identificar (VidScio) também devolve ganchos limpos.
 *
 * Precisa de jsdom e fake-indexeddb (npm install --no-save jsdom fake-indexeddb);
 * sem eles, o teste é saltado.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");

let JSDOM, fakeIndexedDB, IDBKeyRange;
try {
  ({ JSDOM } = await import("jsdom"));
  ({ indexedDB: fakeIndexedDB, IDBKeyRange } = await import("fake-indexeddb"));
} catch {
  console.log("\n⚠️  jsdom/fake-indexeddb não estão instalados — teste VidScio/ganchos saltado.\n" +
    "   Corre: npm install --no-save jsdom fake-indexeddb\n");
  process.exit(0);
}

let pass = 0;
let fail = 0;
const failures = [];
function check(nome, ok, detalhe = "") {
  if (ok) {
    pass++;
    console.log(`   ✔ ${nome}`);
  } else {
    fail++;
    failures.push(nome);
    console.log(`   ❌ ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(desc, fn, timeout = 8000) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`Tempo esgotado à espera de: ${desc}`);
    await sleep(25);
  }
}

/* ======================================================================
   Parte A — o ficheiro (index.html / app-pronto.html / 404.html)
   ====================================================================== */

console.log("\nA. Prompts e limpeza no ficheiro");

const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const loteSrc = fs.readFileSync(path.join(root, "lote-massa.js"), "utf8");

check("o bloco ==CINECLIP-GANCHO-LIMPO== existe no bundle", html.includes("==CINECLIP-GANCHO-LIMPO=="));
check('o placeholder "Gancho 1 😳" desapareceu dos exemplos dos prompts', !html.includes('["Gancho 1 😳"'));
check('o placeholder "Gancho 1 sobre a cena" desapareceu do prompt VidScio', !html.includes("Gancho 1 sobre a cena"));
check("o prompt principal proíbe numerar/rótular (PROIBIDO numerar)", html.includes("PROIBIDO numerar ou rotular"));
check("o prompt NVIDIA proíbe rótulos no início do gancho", html.includes('SEM rótulos como "Gancho 1" ou "1." no início'));
check("o prompt VidScio tem a regra 7 dos ganchos", html.includes('7. GANCHOS ("ganchos")'));
check("os exemplos dos prompts são frases reais prontas a publicar", html.includes("Ele achou que estava no controle até isso acontecer 😳"));
check("Hm: ganchos do JSON passam por _gcLimpaLista", html.includes("k=_gcLimpaLista(Array.isArray(_.ganchos)?_.ganchos:[])"));
check("Hm: fallback de linhas passa por _gcLimpa", html.includes(".map(_=>_gcLimpa(_)).filter(_=>_.length>=8"));
check("_vsParseIA: ganchos do VidScio passam por _gcLimpaLista", html.includes("ganchos:Array.isArray(k.ganchos)?_gcLimpaLista(k.ganchos):void 0"));
check("CineClipCore exporta limparGancho/limparGanchos", html.includes("limparGancho:_gcLimpa,limparGanchos:_gcLimpaLista"));
check("lote-massa limpa o gancho da IA antes de gravar no Reel", loteSrc.includes("typeof core.limparGancho === \"function\"") && loteSrc.includes(".map(limparGancho)"));

const appPronto = fs.readFileSync(path.join(root, "app-pronto.html"), "utf8");
const fallback404 = fs.readFileSync(path.join(root, "404.html"), "utf8");
check("app-pronto.html e 404.html sincronizados com index.html", html === appPronto && html === fallback404);

/* ======================================================================
   Corte 9:16, estética, fórmulas virais e identificação (do main)
   ====================================================================== */

// -----------------------------------------------------------------------------
// 1. Corte de formato (Eh)
// -----------------------------------------------------------------------------
console.log("1. Corte de Formato 9:16 e Dimensões");
{
  const modulo = /<script type="module">([\s\S]*?)<\/script>/.exec(html)[1];
  // Chavetas equilibradas: o `Eh` ganhou um parâmetro de preset e a regex antiga
  // (que parava no primeiro `}}`) truncava a função.
  const extrairEh = (fonte) => extrairFuncao2(fonte, "function Eh(");
  function extrairFuncao2(fonte, inicio) {
    const a = fonte.indexOf("function Eh(");
    if (a < 0) return null;
    let i = fonte.indexOf("{", a);
    let nivel = 0;
    let aspas = null;
    for (; i < fonte.length; i++) {
      const ch = fonte[i];
      if (aspas) {
        if (ch === "\\") { i++; continue; }
        if (ch === aspas) aspas = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") { aspas = ch; continue; }
      if (ch === "{") nivel++;
      else if (ch === "}" && --nivel === 0) return fonte.slice(a, i + 1);
    }
    return null;
  }
  // O Eh usa a tabela de presets e dois helpers do bundle — vão todos para o vm.
  function extrairFuncao(fonte, inicio) {
    const a = fonte.indexOf(inicio);
    if (a < 0) return null;
    let i = fonte.indexOf("{", a);
    let nivel = 0;
    let aspas = null;
    for (; i < fonte.length; i++) {
      const ch = fonte[i];
      if (aspas) {
        if (ch === "\\") { i++; continue; }
        if (ch === aspas) aspas = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") { aspas = ch; continue; }
      if (ch === "{") nivel++;
      else if (ch === "}" && --nivel === 0) return fonte.slice(a, i + 1);
    }
    return null;
  }
  function extrairTabela(fonte) {
    const inicio = "const PRESETS_DO_REEL={";
    const a = fonte.indexOf(inicio);
    if (a < 0) return "";
    let i = fonte.indexOf("{", a + inicio.length - 1);
    let nivel = 0;
    let aspas = null;
    for (; i < fonte.length; i++) {
      const ch = fonte[i];
      if (aspas) {
        if (ch === "\\") { i++; continue; }
        if (ch === aspas) aspas = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") { aspas = ch; continue; }
      if (ch === "{") nivel++;
      else if (ch === "}" && --nivel === 0) return fonte.slice(a, i + 1) + ";";
    }
    return "";
  }
  const ehCodigo = extrairEh(modulo);
  if (!ehCodigo) throw new Error("Função Eh não encontrada no bundle.");
  const codigoVm = [
    extrairTabela(modulo),
    extrairFuncao(modulo, "function presetDoReel("),
    extrairFuncao(modulo, "function alvoDaCaixa("),
    ehCodigo,
  ].filter(Boolean).join("\n");

  const ctx = vm.createContext({ Math, Number });
  vm.runInContext(codigoVm, ctx);

  // Vídeo 16:9 (1920x1080) -> deve ser centralizado em 720x1280 com margem vertical equilibrada
  const r169 = ctx.Eh(1920, 1080, null, 720);
  check("16:9 largura total 720", r169.videoW === 720);
  check("16:9 altura proporcional ~406", r169.videoH >= 404 && r169.videoH <= 406);
  check("16:9 centralizado verticalmente (padY ~402)", r169.padY >= 390 && r169.padY <= 415, `padY=${r169.padY}`);
  check("16:9 sem deslocamento horizontal", r169.padX === 0);

  // Vídeo já vertical 9:16 (1080x1920) -> deve ocupar a tela toda sem encolher nem criar barras
  const r916 = ctx.Eh(1080, 1920, null, 720);
  check("9:16 ocupa 100% da largura (720)", r916.videoW === 720);
  check("9:16 ocupa 100% da altura (1280)", r916.videoH === 1280);
  check("9:16 sem bordas (padX=0, padY=0)", r916.padX === 0 && r916.padY === 0);

  // Vídeo ultra-widescreen 2.39:1 (1920x804)
  const r239 = ctx.Eh(1920, 804, null, 720);
  check("2.39:1 centralizado verticalmente", r239.padY > 430 && r239.padY < 460, `padY=${r239.padY}`);
}

// -----------------------------------------------------------------------------
// 2. Fundo preto cinematográfico no FFmpeg e Preview
// -----------------------------------------------------------------------------
console.log("\n2. Estética Cinematográfica (Fundo Preto)");
{
  // O fundo do pad passou a vir de uma variável: preto por omissão, branco só
  // quando a conta escolhe o fundo branco (preset "claro" ou opção "Branco").
  check("FFmpeg processa com fundo preto por omissão (pad=...:${__corFundo})", html.includes(",pad=${w.outWidth}:${w.outHeight}:${w.padX}:${w.padY}:${__corFundo},setsar=1") && html.includes('__corFundo=__fundoBranco?"white":"black"') && html.includes('__fundoBranco=__P.fundo==="branco"||bgMode==="branco"'));
  check("FFmpeg não usa mais fundo branco (:white)", !html.includes(":white,setsar=1"));
  check("Preview 9:16 usa container preto (bg-black)", html.includes('aspect-[9/16] w-full overflow-hidden rounded-xl border border-border bg-black'));
}

// -----------------------------------------------------------------------------
// 3. Renderização e Ganchos Virais
// -----------------------------------------------------------------------------
console.log("\n3. Ganchos Virais e Tipografia Moderna");
{
  check("Gancho padrão não é o clichê genérico", !html.includes('overlayText:"Você precisa assistir esse filme 😳"'));
  check("Renderizador _h usa tipografia em negrito 900", html.includes('900 ${g}px "Inter", "Montserrat"'));
  check("Renderizador _h usa badge de alto contraste com cantos arredondados", html.includes('rgba(10, 10, 14, 0.78)'));
  check("Renderizador _h usa texto branco puro com sombra (em fundo escuro)", html.includes('#FFFFFF') && html.includes('shadowColor=P.ganchoPill?"rgba(0, 0, 0, 0.9)":"rgba(0, 0, 0, 0.55)"') && html.includes('f.fillStyle=color||(P.ganchoPill?(ital?"rgba(255, 255, 255, 0.55)":"#FFFFFF"):P.ganchoCor)'));

  // Prompt do Hm deve conter fórmulas virais comprovadas
  check("Prompt do Hm ensina quebra de expectativa", html.includes("QUEBRA DE EXPECTATIVA"));
  check("Prompt do Hm ensina tensão extrema e dilema", html.includes("TENSÃO EXTREMA"));
  check("Prompt do Hm proíbe frases vazias genéricas", html.includes('NUNCA use frases vazias como "Você precisa assistir esse filme"'));
}

// -----------------------------------------------------------------------------
// 4. Identificação de Filmes (VidScio Engine e TMDB)
// -----------------------------------------------------------------------------
console.log("\n4. Motor de Identificação e TMDB");
{
  // _vsParseIA tolerante a markdown
  const parseMatch = html.match(/function _vsParseIA\(v,x\)\{[\s\S]*?return\{[\s\S]*?\}\;[\s\n]*\}/);
  check("Parser tolerante a JSON com blocos markdown", html.includes("```json"));
  check("Parser limpa vírgulas extras no JSON", html.includes('raw=raw.replace(/,\\s*([}\\]])/g,"$1")'));

  // Multi-frame Gemini
  check("Gemini recebe múltiplos frames nítidos em vez de cortar", html.includes("frames.length>=4?frames.slice(1):frames"));

  // Áudio até 120MB
  check("Limite de áudio aceita filmes de até 120MB", html.includes("r.size>120*1024*1024"));
  check("Timeout de áudio estendido para 12s", html.includes('setTimeout(()=>j(new Error("audio timeout")),12000)'));

  // Pontuação TMDB: título exato deve vencer ator coincidente
  check("Título exato original recebe pontuação dominante (+145)", html.includes("if(x&&(D===x||O===x))T+=145"));
  check("Título exato em português recebe pontuação dominante (+135)", html.includes("else if(h&&(O===h||D===h))T+=135"));
  check("Pontuação de ator calibrada para não sobrepor título (+45 max)", html.includes("T+=(ac.actorMatches||1)>=2?45:25"));

  // 🎬 Gemini "assiste" ao vídeo (File API) em vez de só ver frames
  check("bundle tem o upload do vídeo para a File API do Gemini", html.includes("_ccGeminiVideo") && html.includes("upload/v1beta/files"));
  check("a análise usa file_data + video_metadata (intervalo)", html.includes("file_data:{file_uri:uri,mime_type:tipo}") && html.includes("part.video_metadata=md"));
  check("hasMedia do generateContent conta também o vídeo (file_data)", html.includes("hasMedia=a.some(pt=>pt&&(pt.inline_data||pt.file_data))"));
  check("hasMedia do ju conta também o vídeo (file_data)", html.includes("hasMedia=o.some(pt=>pt&&(pt.inline_data||pt.file_data))"));
  check("com vídeo, o generateContent espera mais tempo (300 s)", html.includes("body:JSON.stringify(p)},hasMedia?3e5:9e4)"));
  check("CineClipCore exporta videoParaIA", html.includes("videoParaIA:_ccVideoParaIA"));
  check("o Estúdio passa o vídeo à identificação (Zb)", html.includes("audioClip:Pt,video:X?{data:X,"));
  check("o Estúdio passa o vídeo ao gancho (Hm)", html.includes('S.geminiKey,ue,{data:X,mimeType:(X&&X.type)||"video/mp4"'));
  check("lote-massa prepara o vídeo para a IA", loteSrc.includes("core.videoParaIA") && loteSrc.includes("video: videoIA"));
  check("lote-massa passa o vídeo ao gerarGancho (quando a identificação ainda não viu a cena)", loteSrc.includes("jaViuCena ? null : videoIA, contextoGancho)"));
  check("o servidor também prepara o vídeo para a IA", fs.readFileSync(path.join(root, "servidor", "video.mjs"), "utf8").includes("export async function videoParaIA"));
}


/* ======================================================================
   Parte B — o bundle real num DOM
   ====================================================================== */

console.log("\nB. O bundle real (jsdom): limpeza dos ganchos");

function resposta(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => headers[String(n).toLowerCase()] ?? null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body ?? {})),
    json: async () => (typeof body === "string" ? JSON.parse(body) : body ?? {}),
    body: { cancel: async () => {} },
  };
}

/** Resposta da IA (Gemini) — mutável para cada cenário. */
let respostaGemini = "";
/** Corpo do último generateContent + contagem de uploads (File API de vídeo). */
let corpoGenerate = null;
let uploads = 0;
const dom = new JSDOM(html, { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
const { window } = dom;
window.indexedDB = fakeIndexedDB;
window.IDBKeyRange = IDBKeyRange;
window.TextEncoder = globalThis.TextEncoder;
window.TextDecoder = globalThis.TextDecoder;
try { Object.defineProperty(window, "crypto", { value: globalThis.crypto, configurable: true }); } catch {}
window.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("upload/v1beta/files")) {
    uploads++;
    return resposta(200, {}, { "x-goog-upload-url": "https://upload.stub/finalize" });
  }
  if (u.includes("upload.stub/finalize")) {
    return resposta(200, { file: { name: "files/vid01", uri: "https://generativelanguage.googleapis.com/v1beta/files/vid01", state: "PROCESSING" } });
  }
  if (u.includes("/files/vid01")) {
    return resposta(200, { file: { state: "ACTIVE" } });
  }
  if (u.includes(":generateContent")) {
    corpoGenerate = opts && opts.body != null ? String(opts.body) : "";
    return resposta(200, { candidates: [{ content: { parts: [{ text: respostaGemini }] } }] });
  }
  if (u.includes("generativelanguage")) return resposta(200, { candidates: [{ content: { parts: [{ text: respostaGemini }] } }] });
  return resposta(200, { key: "stub", id: "stub" }, { "content-type": "application/json" });
};
window.matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false });
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.HTMLMediaElement.prototype.play = () => Promise.resolve();
window.HTMLMediaElement.prototype.pause = () => {};
window.HTMLMediaElement.prototype.load = () => {};
window.scrollTo = () => {};
window.confirm = () => true;
window.URL.createObjectURL = () => "blob:stub";
window.URL.revokeObjectURL = () => {};
const logs = [];
for (const n of ["log", "info", "debug", "warn"]) window.console[n] = (...a) => logs.push(a.map(String).join(" "));
const CONTA = { id: "acc_default", name: "@conta.teste", mode: "graph", igUserId: "1", fbPageId: "", metaAccessToken: "x", webhookUrl: "", dailySlots: ["12:00"], autoPilot: false, shareToFeed: true };
window.localStorage.setItem("cineclip.ig.accounts", JSON.stringify([CONTA]));
window.localStorage.setItem("cineclip.ig.active", CONTA.id);

const moduleSource = /<script type="module">([\s\S]*?)<\/script>/.exec(html)[1].replace(/import\.meta\.url/g, '"file:///index.html"');
const cineCloudSource = fs.readFileSync(path.join(root, "nuvem-duravel.js"), "utf8");
window.eval(cineCloudSource);
window.eval(moduleSource);

const core = await waitFor("window.CineClipCore", () => window.CineClipCore);
check("CineClipCore continua a expor as funções do bundle", ["identificar", "gerarGancho", "processar", "gerarLegenda"].every((n) => typeof core[n] === "function"));
check("o gancho padrão vem das definições do app", core.ganchoPadrao === "O que acontece nessa cena deixou todo mundo em choque 😳");

/* ---- B1. limparGancho: rótulos, numeração, aspas e lixo ---- */
const casos = [
  ["Gancho 1: ele matou a mulher 😳", "ele matou a mulher 😳"],
  ["gancho1 ele matou a mulher", "ele matou a mulher"],
  ["Gancho 2 - a reação dela é impagável 🔥", "a reação dela é impagável 🔥"],
  ["1. ele matou a mulher 😳", "ele matou a mulher 😳"],
  ["2) Ninguém viu isso chegar 😱", "Ninguém viu isso chegar 😱"],
  ["3 - Ninguém viu isso chegar 😱", "Ninguém viu isso chegar 😱"],
  ["Opção 3: o motivo da discussão 😱", "o motivo da discussão 😱"],
  ["Gancho: ele matou a mulher", "ele matou a mulher"],
  ['"ele matou a mulher 😳"', "ele matou a mulher 😳"],
  ["Gancho nº1 a cena que ninguém esquece 😳", "a cena que ninguém esquece 😳"],
];
for (const [suja, limpa] of casos) {
  check(`limparGancho(${JSON.stringify(suja)})`, core.limparGancho(suja) === limpa, `devolveu ${JSON.stringify(core.limparGancho(suja))}`);
}

/* ---- B2. limparGancho NÃO estraga ganchos legítimos ---- */
const legitimos = [
  "7 minutos de puro terror 😱",
  "3 segundos mudaram tudo 😳",
  "Gancho de longo.mp4 😳",
  "O momento exato em que tudo mudou nessa cena 😳",
];
for (const g of legitimos) {
  check(`limparGancho preserva ${JSON.stringify(g)}`, core.limparGancho(g) === g, `devolveu ${JSON.stringify(core.limparGancho(g))}`);
}

/* ---- B3. limparGancho descarta lixo ---- */
for (const lixo of ["Gancho", "1", "   ", "", "😳", "23"]) {
  check(`limparGancho(${JSON.stringify(lixo)}) devolve vazio`, core.limparGancho(lixo) === "");
}

/* ---- B4. limparGanchos deduplica e limita ---- */
const lista = core.limparGanchos(["Ele morre na cena final 😳", "ele morre na cena final 🔥", "Gancho 1: a reação dela é impagável 😱", "Gancho"]);
check("limparGanchos remove duplicados e lixo", lista.length === 2 && lista[0] === "Ele morre na cena final 😳" && lista[1] === "a reação dela é impagável 😱", JSON.stringify(lista));

/* ---- B5. gerarGancho: JSON sujo → ganchos limpos ---- */
const QUADRO = "data:image/jpeg;base64,QUJD";
respostaGemini = JSON.stringify({
  cena: "Ele confronta a mulher sobre a traição e a situação escapa ao controle",
  ganchos: ["Gancho 1: ele matou a mulher 😳", "gancho2 A reação dela é impagável 🔥", "3. Ninguém viu isso chegar 😱"],
});
let r1;
try {
  r1 = await core.gerarGancho("", [QUADRO], "pt-BR", "cena-suja.mp4", "chave-gemini-falsa", null);
  const ok = Array.isArray(r1.ganchos) && r1.ganchos.length === 3 &&
    r1.ganchos[0] === "ele matou a mulher 😳" &&
    r1.ganchos[1] === "A reação dela é impagável 🔥" &&
    r1.ganchos[2] === "Ninguém viu isso chegar 😱";
  check("gerarGancho devolve os ganchos limpos (JSON da IA sujo)", ok, JSON.stringify(r1.ganchos));
  check("gerarGancho devolve a cena identificada", r1.cena === "Ele confronta a mulher sobre a traição e a situação escapa ao controle");
} catch (e) {
  check("gerarGancho devolve os ganchos limpos (JSON da IA sujo)", false, e && e.message);
}

/* ---- B6. gerarGancho: resposta em texto solto (fallback) ---- */
respostaGemini = "Aqui estão os ganchos:\n1. Gancho 1: ele matou a mulher 😳\n2) A reação dela é impagável 🔥\n3 - Ninguém viu isso chegar 😱";
let r2;
try {
  r2 = await core.gerarGancho("", [QUADRO], "pt-BR", "cena-fallback.mp4", "chave-gemini-falsa", null);
  const ok = Array.isArray(r2.ganchos) && r2.ganchos.length === 3 &&
    r2.ganchos[0] === "ele matou a mulher 😳" &&
    r2.ganchos[1] === "A reação dela é impagável 🔥" &&
    r2.ganchos[2] === "Ninguém viu isso chegar 😱";
  check("gerarGancho limpa também o fallback de texto solto (sem linha de abertura)", ok, JSON.stringify(r2.ganchos));
} catch (e) {
  check("gerarGancho limpa também o fallback de texto solto (sem linha de abertura)", false, e && e.message);
}

/* ---- B7. identificar (VidScio): ganchos sujos → limpos ---- */
respostaGemini = JSON.stringify({
  fala_do_audio: "Você não devia ter feito isso com ela.",
  atores: ["Ator Fictício"],
  personagens: ["Personagem Fictícia"],
  texto_na_tela: "",
  ancoras_visuais: "cozinha à noite, tom dramático",
  cena: "Ele confronta a mulher sobre a traição na cozinha",
  tipo: "movie",
  temporada_episodio: "",
  titulo: "Filme Teste VidScio",
  titulo_original: "VidScio Test Movie",
  ano: 2024,
  confianca: 95,
  ganchos: ["Gancho 1: ele matou a mulher 😳", "gancho2 A reação dela é impagável 🔥", "3. Ninguém viu isso chegar 😱"],
  alternativas: [],
});
let id1;
try {
  id1 = await core.identificar("", [QUADRO], "pt-BR", { fileName: "vidscio-sujo.mp4", userHint: "cena de teste", geminiKey: "chave-gemini-falsa", audioClip: null });
  const ok = id1 && id1.titulo === "Filme Teste VidScio" &&
    Array.isArray(id1.ganchos) && id1.ganchos.length === 3 &&
    id1.ganchos[0] === "ele matou a mulher 😳" &&
    id1.ganchos[1] === "A reação dela é impagável 🔥" &&
    id1.ganchos[2] === "Ninguém viu isso chegar 😱";
  check("identificar (VidScio) devolve os ganchos limpos", ok, JSON.stringify(id1 && id1.ganchos));
  check("identificar (VidScio) mantém o título e a confiança", id1 && id1.titulo === "Filme Teste VidScio" && id1.confianca === 95);
} catch (e) {
  check("identificar (VidScio) devolve os ganchos limpos", false, e && e.message);
}

/* ---- B8. identificar e gerarGancho com o vídeo (Gemini File API) ---- */
respostaGemini = JSON.stringify({
  fala_do_audio: "Ele disse: não devias ter feito isso.",
  atores: ["Ator Vídeo"], personagens: ["Personagem Vídeo"], texto_na_tela: "",
  ancoras_visuais: "cozinha à noite, tom dramático", cena: "Ele confronta a mulher e a situação escala em movimento",
  tipo: "movie", temporada_episodio: "", titulo: "Filme Com Vídeo", titulo_original: "Video Movie",
  ano: 2025, confianca: 96, ganchos: ["A cena em movimento mudou tudo 😳"], alternativas: [],
});
const videoFake = { data: new Uint8Array([1, 2, 3, 4]), mimeType: "video/mp4", ini: 0, fim: 90 };
let idv = null;
try {
  idv = await core.identificar("", [QUADRO], "pt-BR", { fileName: "video-fake.mp4", userHint: "cena com vídeo", geminiKey: "chave-gemini-falsa", audioClip: null, video: videoFake });
  check("identificar com vídeo devolve o resultado", !!idv && idv.titulo === "Filme Com Vídeo" && idv.confianca === 96, JSON.stringify(idv && idv.titulo));
  check("o vídeo sobe uma vez para a File API do Gemini", uploads === 1, "uploads=" + uploads);
  check("a identificação usa file_data com o file_uri", !!corpoGenerate && corpoGenerate.includes('"file_data"') && corpoGenerate.includes("files/vid01"));
  check("a identificação marca o intervalo com video_metadata", !!corpoGenerate && corpoGenerate.includes('"end_offset":"90s"'));
  check("com vídeo, os frames não são enviados como inline_data", !!corpoGenerate && !corpoGenerate.includes("inline_data"));
} catch (e) {
  check("identificar com vídeo devolve o resultado", false, e && e.message);
}

let gv = null;
try {
  gv = await core.gerarGancho("", [QUADRO], "pt-BR", "Filme Com Vídeo", "chave-gemini-falsa", null, videoFake);
  check("gerarGancho com vídeo devolve a cena", !!gv && /movimento/.test(gv.cena || ""), JSON.stringify(gv && gv.cena));
  check("o mesmo vídeo reutiliza o upload (cache)", uploads === 1, "uploads=" + uploads);
  check("o gancho também usa file_data", !!corpoGenerate && corpoGenerate.includes('"file_data"') && corpoGenerate.includes("files/vid01"));
} catch (e) {
  check("gerarGancho com vídeo devolve a cena", false, e && e.message);
}

/* ---- B9. Modos de Gancho Viral e Modos de Identificação exportados ---- */
check("CineClipCore exporta os 7 modos de gancho viral", Array.isArray(core.modosGancho) && core.modosGancho.length === 7 && core.modosGancho.some((m) => m.id === "suspense") && core.modosGancho.some((m) => m.id === "sem_gancho"));
check("CineClipCore exporta os 4 modos de identificação", Array.isArray(core.modosIdentificacao) && core.modosIdentificacao.length === 4 && core.modosIdentificacao.some((m) => m.id === "dialogo") && core.modosIdentificacao.some((m) => m.id === "sem_id"));

/* ---- B10. gerarGancho: modo sem_gancho e filtro de clichês por modo ---- */
{
  const semG = await core.gerarGancho("", [QUADRO], "pt-BR", "qualquer.mp4", "", null, "sem_gancho");
  check("modo sem_gancho devolve lista vazia sem chamar IA", semG && semG.modo === "sem_gancho" && Array.isArray(semG.ganchos) && semG.ganchos.length === 0);

  respostaGemini = JSON.stringify({
    cena: "Interrogatório tenso na delegacia",
    ganchos: [
      "Você precisa assistir esse filme até o final 😱",
      "O que acontece nessa cena é inacreditável 😳",
      "Quem você salvaria se tivesse apenas 10 segundos? 🤔",
    ],
  });
  const rPerg = await core.gerarGancho("", [QUADRO], "pt-BR", { titulo: "Prisoners", ano: 2013 }, "chave-gemini-falsa", null, "pergunta");
  check("gerarGancho filtra clichês genéricos e preserva o gancho real do modo", rPerg && rPerg.modo === "pergunta" && rPerg.ganchos.length === 1 && rPerg.ganchos[0] === "Quem você salvaria se tivesse apenas 10 segundos? 🤔", JSON.stringify(rPerg && rPerg.ganchos));
}

/* ---- B11. identificar: modo sem_id e modo dica (rápido por nome) ---- */
{
  const idSem = await core.identificar("", [], "pt-BR", { fileName: "Interestelar_2014_corte_final.mp4", identMode: "sem_id" });
  check("identificar em modo sem_id limpa o nome do ficheiro e nunca trava", idSem && idSem.modo_identificacao === "sem_id" && idSem.titulo === "Interestelar" && idSem.confianca === 100, JSON.stringify(idSem));

  const idDica = await core.identificar("", [], "pt-BR", { fileName: "Breaking.Bad.S02E03.1080p.WEB-DL.mp4", identMode: "dica" });
  check("identificar em modo dica extrai título, série e episódio do nome sem precisar de IA", idDica && idDica.titulo === "Breaking Bad" && idDica.tipo === "tv" && idDica.temporada_episodio === "S02E03" && idDica.confianca >= 85, JSON.stringify(idDica));
}

/* ---- B12. identificar: modo dialogo + recuperação de JSON truncado + IMDb ID ---- */
{
  respostaGemini = '```json\n{"fala_do_audio":"Say my name","personagens":["Heisenberg"],"titulo":"Breaking Bad","titulo_original":"Breaking Bad","ano":2008,"tipo":"tv","imdb_id":"tt0903747","confianca":98,"ganchos":["Quando ele disse essas 3 palavras o império nasceu 💀"';
  const idDiag = await core.identificar("", [QUADRO], "pt-BR", { fileName: "corte.mp4", geminiKey: "chave-gemini-falsa", identMode: "dialogo", hookMode: "fala" });
  check("identificar recupera JSON truncado e preserva imdb_id e modo dialogo", idDiag && idDiag.titulo === "Breaking Bad" && idDiag.imdb_id === "tt0903747" && idDiag.modo_identificacao === "dialogo", JSON.stringify(idDiag));
}

/* ---- B13. Limpeza de nomes de ficheiro (SnapTik/CapCut/WhatsApp) + toggle useFileNameHint + anti-lag do gancho ---- */
{
  check("CineClipCore exporta limparNomeArquivo", typeof core.limparNomeArquivo === "function");
  const lixos = [
    "SnapTik_App_7382910384920192.mp4",
    "ssstik.io_1709382910392.mp4",
    "SaveInsta.App_3291029384920_1080p.mp4",
    "CapCut_20260415_182011.mp4",
    "WhatsApp Video 2026-04-12 at 19.22.10.mp4",
    "corte_1_final_1080p_dublado.mp4",
    "O_que_acontece_nessa_cena_deixou_todo_mundo_em_choque.mp4",
  ];
  check("limparNomeArquivo rejeita nomes de downloaders, editores e frases de gancho", lixos.every((n) => core.limparNomeArquivo(n) === ""), JSON.stringify(lixos.map((n) => [n, core.limparNomeArquivo(n)])));
  check("limparNomeArquivo extrai título real mesmo com prefixo SnapTik e sufixos 1080p/dublado", core.limparNomeArquivo("SnapTik_7382910_Peaky_Blinders_1080p_dublado_corte_2.mp4") === "Peaky Blinders", core.limparNomeArquivo("SnapTik_7382910_Peaky_Blinders_1080p_dublado_corte_2.mp4"));
  const idTesouro = await core.identificar("", [], "pt-BR", { fileName: "05_O_Tesouro_National_Treasure_2004.mp4", identMode: "dica" });
  check("identificar extrai ano 2004, remove prefixo 05_ e gera sub-pista National Treasure para 05_O_Tesouro_National_Treasure_2004.mp4", idTesouro && idTesouro.ano === 2004 && idTesouro.titulo === "O Tesouro National Treasure" && Array.isArray(idTesouro.alternativas) && idTesouro.alternativas.some((a) => a.titulo === "National Treasure"), JSON.stringify(idTesouro));

  const idSemDesligado = await core.identificar("", [], "pt-BR", { fileName: "Interestelar_2014.mp4", identMode: "sem_id", useFileNameHint: false });
  check("useFileNameHint=false ignora o nome do ficheiro quando o utilizador desativa o rastreio", idSemDesligado && idSemDesligado.titulo === "Cena de filme", JSON.stringify(idSemDesligado));

  check("Estúdio tem debounce de sincronização (_syncTm/_editTs) para digitar gancho sem delay", html.includes("_syncTm") && html.includes("_editTs") && html.includes("freshEdit"));
  check("Estúdio tem seletor rápido de preset sob o preview 9:16", html.includes("mudarPresetConta") && html.includes("Mudar preset visual desta conta em tempo real"));
  const ganchoCurto = core.limparGancho("⛳ O ex-jogador descobriu um prodígio do golfe num campo abandonado onde ninguém imaginava 😳");
  check("limparGancho limita o tamanho para caber em até 2 linhas e preserva o emoji", ganchoCurto.length <= 58 && ganchoCurto.endsWith("😳"), ganchoCurto);
}

/* ====================================================================== */

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} verificações passaram${fail ? `, ${fail} falharam` : ""}\n`);
if (fail) {
  console.log("Falhas:", failures.join(" · "), "\n");
  process.exit(1);
}
