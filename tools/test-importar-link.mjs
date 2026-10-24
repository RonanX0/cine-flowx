#!/usr/bin/env node
/**
 * Testes da importação por link (TikTok / Kwai).
 *
 *   node tools/test-importar-link.mjs
 *
 * Não vai à Internet: as páginas do TikTok/Kwai, o tikwm e os CDNs são simulados
 * com a estrutura que essas páginas usam (a do TikTok segue a do yt-dlp).
 *
 *   1. links aceites e domínios permitidos (segurança: nada de proxy aberto);
 *   2. TikTok: link curto, JSON da página, preferência por H.264, cookies;
 *   3. TikTok sem dados na página → plano B tikwm;
 *   4. Kwai: og:video, JSON com /, main_mv_urls;
 *   5. download: salta CDNs que falham ou devolvem HTML, limite de 300 MB;
 *   6. a função da Vercel: streaming, cabeçalhos, CORS, erros;
 *   7. o painel do upload em massa: colar links → vídeos na lista.
 */
import fs from "node:fs";
import path from "node:path";
import {
  abrirVideo, candidatosKwai, candidatosTikTok, ErroImportacao, hostDeVideoPermitido,
  nomeDoFicheiro, normalizarLink, plataformaDe, resolverVideo,
} from "../server/importar-video.mjs";
import handler from "../api/public/importar.js";

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
async function lanca(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

/* --------------------------------------------------------- simulador HTTP */

function resposta(status, corpo = "", cabecalhos = {}) {
  const h = new Headers();
  for (const [k, v] of Object.entries(cabecalhos)) {
    if (Array.isArray(v)) v.forEach((x) => h.append(k, x));
    else h.set(k, String(v));
  }
  return new Response(status >= 300 && status < 400 ? null : corpo, { status, headers: h });
}

/** fetch falso: `rotas` mapeia prefixos de URL para funções (url, opts) => Response. */
function simulador(rotas) {
  const pedidos = [];
  const fetchFn = async (url, opts = {}) => {
    pedidos.push({ url: String(url), opts });
    const chave = Object.keys(rotas).filter((k) => String(url).startsWith(k)).sort((a, b) => b.length - a.length)[0];
    if (!chave) return resposta(599, "sem rota: " + url);
    return rotas[chave](String(url), opts);
  };
  return { fetchFn, pedidos };
}

function paginaTikTok(item, statusCode = 0) {
  const dados = { __DEFAULT_SCOPE__: { "webapp.video-detail": { statusCode, itemInfo: item ? { itemStruct: item } : undefined } } };
  return `<!doctype html><html><head><title>TikTok</title></head><body>
<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(dados)}</script></body></html>`;
}

const ITEM = {
  id: "7400000000000000001",
  desc: "Cena incrível #filme",
  author: { uniqueId: "cortesdefilme", nickname: "Cortes" },
  video: {
    duration: 58,
    codecType: "h264",
    playAddr: "https://v16-webapp.tiktok.com/play/abc.mp4?x=1",
    downloadAddr: "https://v16-webapp.tiktok.com/download/abc_marca.mp4",
    bitrateInfo: [
      { CodecType: "bytevc1", PlayAddr: { UrlKey: "v12044_bytevc1_1080p_2000000", DataSize: 9000000, UrlList: ["https://v19.tiktokcdn-us.com/hevc1080.mp4"] } },
      { CodecType: "h264", PlayAddr: { UrlKey: "v12044_h264_540p_900000", DataSize: 5000000, UrlList: ["https://v16.tiktokcdn.com/h264_540.mp4"] } },
      { CodecType: "h264", PlayAddr: { UrlKey: "v12044_h264_720p_1500000", DataSize: 7000000, UrlList: ["https://v16.tiktokcdn.com/h264_720.mp4", "https://v19.tiktokcdn-us.com/h264_720b.mp4"] } },
      { CodecType: "bytevc2", PlayAddr: { UrlKey: "v12044_bytevc2_1080p_1000000", UrlList: ["https://v16.tiktokcdn.com/vvc.mp4"] } },
      { CodecType: "h264", PlayAddr: { UrlKey: "v12044_h264_360p_400000", UrlList: ["https://malicioso.example/x.mp4", "https://www.tiktok.com/aweme/v1/play/?id=1"] } },
    ],
  },
};

console.log("\n🔗 Importar por link — TikTok e Kwai\n");

/* ------------------------------------------------------------------ 1 */
console.log("1. Links aceites e domínios permitidos");
check("TikTok normal", plataformaDe("https://www.tiktok.com/@a/video/1") === "tiktok");
check("TikTok link curto (vm./vt.)", plataformaDe("https://vm.tiktok.com/ZMabc/") === "tiktok" && plataformaDe("https://vt.tiktok.com/x/") === "tiktok");
check("Kwai normal e curto", plataformaDe("https://www.kwai.com/@b/video/2") === "kwai" && plataformaDe("https://k.kwai.com/p/abc") === "kwai" && plataformaDe("https://kw.ai/p/x") === "kwai");
check("YouTube e outros são recusados", plataformaDe("https://youtube.com/watch?v=1") === null && plataformaDe("https://tiktok.com.malicioso.example/x") === null);
check("texto à volta do link é limpo", normalizarLink("vê isto: https://vm.tiktok.com/ZMabc/ 🔥") === "https://vm.tiktok.com/ZMabc/");
check("link sem https é completado", normalizarLink("www.tiktok.com/@a/video/1") === "https://www.tiktok.com/@a/video/1");
check("CDN do TikTok é permitido", hostDeVideoPermitido("https://v16.tiktokcdn.com/a.mp4"));
check("CDN do Kwai é permitido", hostDeVideoPermitido("https://aws.kwai-pro.com/a.mp4") && hostDeVideoPermitido("https://tx.kwaicdn.com/a.mp4"));
check("outros servidores não", !hostDeVideoPermitido("https://malicioso.example/a.mp4") && !hostDeVideoPermitido("http://v16.tiktokcdn.com/a.mp4") && !hostDeVideoPermitido("https://169.254.169.254/latest"));
check("nome do ficheiro seguro", nomeDoFicheiro({ plataforma: "tiktok", autor: "cortés/../x", id: "123" }) === "tiktok_cortes_x_123.mp4", nomeDoFicheiro({ plataforma: "tiktok", autor: "cortés/../x", id: "123" }));

/* ------------------------------------------------------------------ 2 */
console.log("\n2. TikTok: página do vídeo");
{
  const c = candidatosTikTok(ITEM).map((x) => x.url);
  check("H.264 primeiro, maior resolução primeiro", c[0] === "https://v16.tiktokcdn.com/h264_720.mp4" && c[1] === "https://v19.tiktokcdn-us.com/h264_720b.mp4" && c[2] === "https://v16.tiktokcdn.com/h264_540.mp4", c.join(" | "));
  check("depois o playAddr, depois H.265", c.indexOf("https://v16-webapp.tiktok.com/play/abc.mp4?x=1") > 2 && c.indexOf("https://v19.tiktokcdn-us.com/hevc1080.mp4") > c.indexOf("https://v16-webapp.tiktok.com/play/abc.mp4?x=1"));
  check("a versão com marca de água fica em último", c[c.length - 1] === "https://v16-webapp.tiktok.com/download/abc_marca.mp4");
  check("H.266 (bytevc2) é ignorado", !c.some((u) => u.includes("vvc")));
  check("servidores fora da lista e www.tiktok.com são ignorados", !c.some((u) => u.includes("malicioso") || u.startsWith("https://www.tiktok.com")));

  const sim = simulador({
    "https://vm.tiktok.com/ZMcurto": () => resposta(301, "", { location: "https://www.tiktok.com/@cortesdefilme/video/7400000000000000001?_r=1" }),
    "https://www.tiktok.com/@cortesdefilme/video/": () => resposta(200, paginaTikTok(ITEM), {
      "content-type": "text/html", "set-cookie": ["tt_chain_token=abc123; Path=/; Domain=.tiktok.com", "ttwid=zz; Path=/"],
    }),
  });
  const info = await resolverVideo("https://vm.tiktok.com/ZMcurto/", { fetchFn: sim.fetchFn });
  check("segue o link curto", sim.pedidos[1] && sim.pedidos[1].url.startsWith("https://www.tiktok.com/@cortesdefilme/video/"));
  check("lê autor, id, título e duração", info.autor === "cortesdefilme" && info.id === "7400000000000000001" && info.titulo === "Cena incrível #filme" && info.duracao === 58);
  check("guarda os cookies da página para o CDN", /tt_chain_token=abc123/.test(info.cabecalhos.Cookie) && /ttwid=zz/.test(info.cabecalhos.Cookie));
  check("guarda o Referer", info.cabecalhos.Referer.startsWith("https://www.tiktok.com/@cortesdefilme/video/"));

  const fora = simulador({ "https://vm.tiktok.com/x": () => resposta(302, "", { location: "https://malicioso.example/roubo" }) });
  const e = await lanca(() => resolverVideo("https://vm.tiktok.com/x", { fetchFn: fora.fetchFn }));
  check("link curto que leva para fora do TikTok é recusado", e && /fora do TikTok/.test(e.message) && !fora.pedidos.some((p) => p.url.includes("malicioso")), e && e.message);

  const apagado = simulador({ "https://www.tiktok.com/": () => resposta(404, "") });
  const e2 = await lanca(() => resolverVideo("https://www.tiktok.com/@a/video/1", { fetchFn: apagado.fetchFn }));
  check("vídeo apagado → mensagem clara", e2 && e2.estado === 404 && /não existe/.test(e2.message));

  const e3 = await lanca(() => resolverVideo("https://youtube.com/watch?v=1", { fetchFn: async () => resposta(200, "") }));
  check("link que não é do TikTok/Kwai → erro 400", e3 instanceof ErroImportacao && e3.estado === 400);
}

/* ------------------------------------------------------------------ 3 */
console.log("\n3. TikTok sem dados na página → tikwm");
{
  const sim = simulador({
    "https://www.tiktok.com/": () => resposta(200, "<html><body>Please wait...</body></html>", { "content-type": "text/html" }),
    "https://www.tikwm.com/api/": () => resposta(200, JSON.stringify({
      code: 0, msg: "success",
      data: { id: "7400000000000000002", title: "outro", duration: 40, play: "/video/media/play/7400000000000000002.mp4", hdplay: "https://v16.tiktokcdn.com/hd.mp4", wmplay: "/video/media/wmplay/7400000000000000002.mp4", author: { unique_id: "perfilx" } },
    }), { "content-type": "application/json" }),
  });
  const info = await resolverVideo("https://www.tiktok.com/@perfilx/video/7400000000000000002", { fetchFn: sim.fetchFn });
  check("usa o tikwm quando a página vem sem dados", info.via === "tikwm" && info.autor === "perfilx");
  check("HD primeiro, links relativos do tikwm completados", info.candidatos[0].url === "https://v16.tiktokcdn.com/hd.mp4" && info.candidatos[1].url === "https://www.tikwm.com/video/media/play/7400000000000000002.mp4");
  check("a versão com marca de água fica em último", info.candidatos[info.candidatos.length - 1].marcaDeAgua === true);
  check("o tikwm não recebe cookies", Object.keys(info.cabecalhos).length === 0);

  const nada = simulador({
    "https://www.tiktok.com/": () => resposta(200, "<html></html>"),
    "https://www.tikwm.com/api/": () => resposta(200, JSON.stringify({ code: -1, msg: "Url parsing is failed!" })),
  });
  const e = await lanca(() => resolverVideo("https://www.tiktok.com/@a/video/9", { fetchFn: nada.fetchFn }));
  check("se os dois falham, explica porquê", e && /desafio anti-robô/.test(e.message) && /Url parsing is failed/.test(e.message), e && e.message);
}

/* ------------------------------------------------------------------ 4 */
console.log("\n4. Kwai");
{
  const og = candidatosKwai('<meta property="og:video" content="https://aws.kwai-pro.com/upic/video.mp4?tag=1">');
  check("og:video", og[0] && og[0].url === "https://aws.kwai-pro.com/upic/video.mp4?tag=1");
  const og2 = candidatosKwai('<meta content="https://tx.kwaicdn.com/v.mp4" property="og:video:url">');
  check("og:video com os atributos trocados", og2[0] && og2[0].url === "https://tx.kwaicdn.com/v.mp4");
  const json = candidatosKwai('<script>window.__DATA__={"photo":{"main_mv_urls":[{"cdn":"x","url":"https:\\u002F\\u002Fbr.kwaicdn.com\\u002Fa\\u002Fmain.mp4"}],"cover":"https://br.kwaicdn.com/c.jpg"}}</script>');
  check("main_mv_urls com \\u002F", json[0] && json[0].url === "https://br.kwaicdn.com/a/main.mp4", JSON.stringify(json));
  const solto = candidatosKwai('<script>var v="https:\\/\\/v.kwai.net\\/x\\/clip.mp4?s=2"; var mau="https://malicioso.example/x.mp4";</script>');
  check(".mp4 solto num script (e ignora outros servidores)", solto.length === 1 && solto[0].url === "https://v.kwai.net/x/clip.mp4?s=2", JSON.stringify(solto));

  const sim = simulador({
    "https://k.kwai.com/p/": () => resposta(302, "", { location: "https://www.kwai.com/@autor.kwai/video/5200000000000000001?page_source=x" }),
    "https://www.kwai.com/@autor.kwai/video/": () => resposta(200, '<meta property="og:title" content="Corte do filme"><meta property="og:video" content="https://aws.kwai-pro.com/v.mp4">'),
  });
  const info = await resolverVideo("https://k.kwai.com/p/abcd", { fetchFn: sim.fetchFn });
  check("segue o link curto do Kwai e lê autor/id/título", info.plataforma === "kwai" && info.autor === "autor.kwai" && info.id === "5200000000000000001" && info.titulo === "Corte do filme");

  const vazio = simulador({ "https://www.kwai.com/": () => resposta(200, "<html>nada</html>") });
  const e = await lanca(() => resolverVideo("https://www.kwai.com/@x/video/1", { fetchFn: vazio.fetchFn }));
  check("página do Kwai sem vídeo → mensagem clara", e && /Não encontrei o vídeo na página do Kwai/.test(e.message));
}

/* ------------------------------------------------------------------ 5 */
console.log("\n5. Download do vídeo");
{
  const sim = simulador({
    "https://v16.tiktokcdn.com/falha.mp4": () => resposta(403, "proibido"),
    "https://v16.tiktokcdn.com/html.mp4": () => resposta(200, "<html>login</html>", { "content-type": "text/html" }),
    "https://v16.tiktokcdn.com/redir.mp4": () => resposta(302, "", { location: "https://v19.tiktokcdn-us.com/final.mp4" }),
    "https://v19.tiktokcdn-us.com/final.mp4": () => resposta(200, new Uint8Array([1, 2, 3, 4]), { "content-type": "video/mp4", "content-length": "4" }),
  });
  const info = {
    plataforma: "tiktok",
    candidatos: [{ url: "https://v16.tiktokcdn.com/falha.mp4" }, { url: "https://v16.tiktokcdn.com/html.mp4" }, { url: "https://v16.tiktokcdn.com/redir.mp4", codec: "h264" }],
    cabecalhos: { Referer: "https://www.tiktok.com/@a/video/1", Cookie: "tt_chain_token=abc" },
  };
  const r = await abrirVideo(info, { fetchFn: sim.fetchFn });
  check("salta o 403 e a página HTML, segue o redirecionamento", r.candidato.url === "https://v16.tiktokcdn.com/redir.mp4" && r.tamanho === 4);
  const bytes = new Uint8Array(await r.resposta.arrayBuffer());
  check("devolve os bytes do vídeo", bytes.length === 4 && bytes[3] === 4);
  check("envia Referer e cookies ao CDN do TikTok", sim.pedidos.every((p) => p.opts.headers.Referer && p.opts.headers.Cookie === "tt_chain_token=abc"));

  const tik = simulador({ "https://www.tikwm.com/v.mp4": () => resposta(200, new Uint8Array([9]), { "content-type": "video/mp4" }) });
  await abrirVideo({ plataforma: "tiktok", candidatos: [{ url: "https://www.tikwm.com/v.mp4" }], cabecalhos: { Cookie: "tt_chain_token=abc" } }, { fetchFn: tik.fetchFn });
  check("cookies do TikTok não vão para outros serviços (tikwm)", !tik.pedidos[0].opts.headers.Cookie);

  const grande = simulador({ "https://v16.tiktokcdn.com/": () => resposta(200, "x", { "content-type": "video/mp4", "content-length": String(400 * 1024 * 1024) }) });
  const e = await lanca(() => abrirVideo({ plataforma: "tiktok", candidatos: [{ url: "https://v16.tiktokcdn.com/g.mp4" }], cabecalhos: {} }, { fetchFn: grande.fetchFn }));
  check("vídeo acima de 300 MB → 413", e && e.estado === 413);

  const fuga = simulador({ "https://v16.tiktokcdn.com/": () => resposta(302, "", { location: "http://169.254.169.254/latest/meta-data" }) });
  const e2 = await lanca(() => abrirVideo({ plataforma: "tiktok", candidatos: [{ url: "https://v16.tiktokcdn.com/r.mp4" }], cabecalhos: {} }, { fetchFn: fuga.fetchFn }));
  check("CDN que redireciona para fora é recusado", e2 && !fuga.pedidos.some((p) => p.url.includes("169.254")), e2 && e2.message);
}

/* ------------------------------------------------------------------ 6 */
console.log("\n6. A função da Vercel (/api/public/importar)");
function respostaFalsa() {
  const cab = {};
  const partes = [];
  let terminou;
  const fim = new Promise((r) => (terminou = r));
  return {
    statusCode: 0,
    cab,
    partes,
    fim,
    setHeader(n, v) { cab[n.toLowerCase()] = v; },
    write(p) { partes.push(Buffer.from(p)); return true; },
    once() {},
    end(p) { if (p) partes.push(Buffer.from(p)); terminou(); },
    destroy() { terminou(); },
  };
}
{
  const sim = simulador({
    "https://www.tiktok.com/": () => resposta(200, paginaTikTok(ITEM), { "content-type": "text/html" }),
    "https://v16.tiktokcdn.com/h264_720.mp4": () => resposta(200, new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), { "content-type": "video/mp4", "content-length": "8" }),
  });
  const res = respostaFalsa();
  await handler({
    method: "GET",
    url: "/api/public/importar?url=" + encodeURIComponent("https://www.tiktok.com/@cortesdefilme/video/7400000000000000001"),
    headers: { host: "cine-flowx.vercel.app", origin: "https://cine-flowx.vercel.app" },
  }, res, { fetchFn: sim.fetchFn });
  await res.fim;
  const corpo = Buffer.concat(res.partes);
  check("responde 200 com o .mp4", res.statusCode === 200 && res.cab["content-type"] === "video/mp4" && corpo.length === 8);
  check("cabeçalhos com nome, autor e codec", decodeURIComponent(res.cab["x-cineclip-nome"]) === "tiktok_cortesdefilme_7400000000000000001.mp4" && res.cab["x-cineclip-codec"] === "h264" && res.cab["x-cineclip-plataforma"] === "tiktok");
  check("o navegador pode ler esses cabeçalhos (CORS)", /X-Cineclip-Nome/.test(res.cab["access-control-expose-headers"]) && res.cab["access-control-allow-origin"] === "https://cine-flowx.vercel.app");

  const proibido = respostaFalsa();
  let chamou = false;
  await handler({ method: "GET", url: "/api/public/importar?url=x", headers: { host: "cine-flowx.vercel.app", origin: "https://outro-site.example" } }, proibido, { fetchFn: async () => { chamou = true; } });
  check("outro site recebe 403 e nada é descarregado", proibido.statusCode === 403 && !chamou);

  const semUrl = respostaFalsa();
  await handler({ method: "GET", url: "/api/public/importar", headers: { host: "a.vercel.app" } }, semUrl, { fetchFn: async () => {} });
  check("sem ?url= → 400", semUrl.statusCode === 400);

  const mau = respostaFalsa();
  await handler({ method: "GET", url: "/api/public/importar?url=" + encodeURIComponent("https://youtube.com/watch?v=1"), headers: { host: "a.vercel.app" } }, mau, { fetchFn: async () => {} });
  check("link inválido → erro em JSON legível", mau.statusCode === 400 && /TikTok ou do Kwai/.test(JSON.parse(Buffer.concat(mau.partes).toString()).error));

  const vj = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8"));
  check("vercel.json dá tempo à função (maxDuration)", (vj.functions && vj.functions["api/public/importar.js"] && vj.functions["api/public/importar.js"].maxDuration) >= 60);

  // Modo Alta Qualidade (?hd=1): quando a página web limita a 540p, busca Full HD 1080p sem marca d'água no tikwm
  const itemSo540 = {
    id: "7400000000000000099",
    desc: "Filme narrado completo",
    author: { uniqueId: "narradorhd", nickname: "Narrador HD" },
    video: {
      duration: 120,
      codecType: "h264",
      bitrateInfo: [
        { CodecType: "h264", GearName: "normal_540_0", Bitrate: 700000, PlayAddr: { UrlKey: "v09044g40000_sem_altura", Width: 576, Height: 1024, DataSize: 4000000, UrlList: ["https://v16.tiktokcdn.com/web_540.mp4"] } },
      ],
    },
  };
  const simHd = simulador({
    "https://www.tiktok.com/": () => resposta(200, paginaTikTok(itemSo540), { "content-type": "text/html" }),
    "https://www.tikwm.com/api/": () => resposta(200, JSON.stringify({
      code: 0,
      data: {
        id: "7400000000000000099",
        title: "Filme narrado completo",
        duration: 120,
        hdplay: "https://v19.tiktokcdn-us.com/master_1080p.mp4",
        hd_size: 22000000,
        play: "https://v16.tiktokcdn.com/play_720p_h264.mp4",
        size: 11000000,
        wmplay: "https://v16.tiktokcdn.com/wm.mp4",
        author: { unique_id: "narradorhd" },
      },
    }), { "content-type": "application/json" }),
    "https://v19.tiktokcdn-us.com/master_1080p.mp4": () => resposta(200, new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 1, 2]), { "content-type": "video/mp4", "content-length": "10" }),
  });

  const infoHd = await resolverVideo("https://www.tiktok.com/@narradorhd/video/7400000000000000099", { fetchFn: simHd.fetchFn, altaQualidade: true });
  check("modo altaQualidade (?hd=1) promove Full HD 1080p acima do 540p da web", infoHd.candidatos[0].url === "https://v19.tiktokcdn-us.com/master_1080p.mp4" && infoHd.candidatos[0].qualidade === "1080p");

  const infoH264Hd = await resolverVideo("https://www.tiktok.com/@narradorhd/video/7400000000000000099", { fetchFn: simHd.fetchFn, altaQualidade: true, preferirCodec: "h264" });
  check("modo altaQualidade + codec=h264 prioriza H.264 720p sem marca d'água antes do master", infoH264Hd.candidatos[0].url === "https://v16.tiktokcdn.com/play_720p_h264.mp4" && infoH264Hd.candidatos[0].codec === "h264");

  const resHd = respostaFalsa();
  await handler({
    method: "GET",
    url: "/api/public/importar?url=" + encodeURIComponent("https://www.tiktok.com/@narradorhd/video/7400000000000000099") + "&hd=1&download=1",
    headers: { host: "cine-flowx.vercel.app", origin: "https://cine-flowx.vercel.app" },
  }, resHd, { fetchFn: simHd.fetchFn });
  await resHd.fim;
  check("endpoint ?hd=1&download=1 devolve X-Cineclip-Qualidade=1080p e Content-Disposition", resHd.statusCode === 200 && resHd.cab["x-cineclip-qualidade"] === "1080p" && /attachment/.test(resHd.cab["content-disposition"] || ""));
}

/* ------------------------------------------------------------------ 7 */
console.log("\n7. Painel do upload em massa");
let JSDOM = null;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {}
if (!JSDOM) {
  console.log("   ⚠️  jsdom não instalado — parte do painel saltada (npm install --no-save jsdom fake-indexeddb)");
} else {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  window.eval(fs.readFileSync(path.join(root, "lote-massa.js"), "utf8"));
  const lote = window.CineLote._interno;
  lote.ambiente.app = () => ({ settings: { groqKey: "k", tmdbKey: "t" }, account: { id: "acc", name: "@conta" } });
  lote.ambiente.core = () => ({});
  const pedidos = [];
  lote.ambiente.baixarLink = async (link, progresso) => {
    pedidos.push(link);
    progresso(50, 100);
    if (link.includes("falha")) throw new Error("Esse vídeo não existe ou foi apagado.");
    return new window.File([new Uint8Array(10)], "tiktok_autor_" + pedidos.length + ".mp4", { type: "video/mp4" });
  };

  const links = lote.extrairLinks("olha https://vm.tiktok.com/ZMa/\nhttps://www.kwai.com/@b/video/2\nhttps://vm.tiktok.com/ZMa/\nhttps://youtube.com/x\nhttps://www.tiktok.com/@c/video/falha");
  check("só aceita TikTok/Kwai e tira repetidos", links.length === 3 && !links.some((l) => l.includes("youtube")), JSON.stringify(links));

  window.CineLote.abrir();
  const area = window.document.querySelector(".cl-texto");
  check("o painel tem a caixa para colar links", !!area);
  area.value = "https://vm.tiktok.com/ZMa/\nhttps://www.kwai.com/@b/video/2\nhttps://www.tiktok.com/@c/video/falha";
  area.dispatchEvent(new window.Event("input"));
  const botao = [...window.document.querySelectorAll("button")].find((b) => b.textContent === "Importar links");
  check("tem o botão «Importar links»", !!botao);
  botao.click();
  const t0 = Date.now();
  while (lote.estado.links.aImportar || Date.now() - t0 < 20) await new Promise((r) => setTimeout(r, 10));
  const itens = lote.estado.itens;
  check("os vídeos importados entram na lista do lote", itens.filter((i) => i.estado === "pendente").length === 2 && itens[0].nome === "tiktok_autor_1.mp4");
  check("guarda de que link veio cada vídeo", itens[0].origem === "https://vm.tiktok.com/ZMa/");
  const erro = itens.find((i) => i.estado === "erro");
  check("o link que falhou aparece com o motivo", erro && /apagado/.test(erro.erro) && erro.nome.includes("falha"));
  const texto = window.document.querySelector(".cl-painel").textContent;
  check("mostra o resumo da importação", /2 de 3 vídeos importados/.test(texto), texto.slice(0, 200));
  check("«Começar» fica disponível com os 2 vídeos", [...window.document.querySelectorAll("button")].some((b) => /Começar \(2 vídeos\)/.test(b.textContent) && !b.disabled));
  dom.window.close();
}

console.log("\n─────────────────────────────────────────────");
if (fail) {
  console.log(`❌ ${pass} passaram, ${fail} falharam:`);
  for (const f of falhas) console.log(`   • ${f}`);
  process.exit(1);
}
console.log(`✅ ${pass} passaram, 0 falharam`);
