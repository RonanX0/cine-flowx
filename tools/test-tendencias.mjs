#!/usr/bin/env node
/**
 * «🔥 Tendências»: busca no tikwm (simulado), pontuação de hype, filtros, nomes
 * prováveis do filme na legenda e o endpoint /api/public/tendencias.
 *
 *   node tools/test-tendencias.mjs
 */
import { analisarNarrado, buscarTendencias, candidatosDeTitulo, listaDe, pontuar, termosDeBusca } from "../server/tendencias.mjs";
import handler from "../api/public/tendencias.js";

let pass = 0, fail = 0;
const falhas = [];
const check = (n, ok, d = "") => { if (ok) { pass++; console.log(`   ✔ ${n}`); } else { fail++; falhas.push(n); console.log(`   ❌ ${n}${d ? " — " + d : ""}`); } };

const AGORA = Date.UTC(2026, 9, 18, 12, 0, 0);
const h = (horas) => Math.floor((AGORA - horas * 3_600_000) / 1000);
const video = (id, o = {}) => ({ video_id: id, title: "legenda " + id, cover: `https://x/${id}.jpg`, duration: 40, play_count: 100_000, digg_count: 10_000, comment_count: 100, share_count: 500, create_time: h(10), author: { unique_id: "cortes" + id, nickname: "Cortes " + id }, ...o });

console.log("\n🏷️ Listas de hashtags/perfis");
check("limpa #, @, espaços e repetidos", JSON.stringify(listaDe("#CenasDeFilme, @cortes  filmes #filmes")) === JSON.stringify(["cenasdefilme", "cortes", "filmes"]));
check("respeita o máximo", listaDe("a1,b2,c3,d4,e5,f6,g7", 3).length === 3);

console.log("\n🎬 Nome provável do filme na legenda");
{
  const c = (s) => candidatosDeTitulo(s).map((x) => x.titulo);
  check("entre aspas", c('Essa cena de "Onze Homens e Um Segredo" é perfeita #filmes').includes("Onze Homens e Um Segredo"));
  check("depois de «Filme:»", c("Filme: Se Beber, Não Case | melhor cena #viral").some((t) => /Se Beber, Não Case/.test(t)));
  check("com emoji 🎬", c("🎬 Gladiador (2000) cena final #cinema").includes("Gladiador"));
  check("título com ano", c("Interestelar (2014) - a despedida").includes("Interestelar"));
  check("hashtag em CamelCase vira título", c("que cena 😱 #TheHangover #fyp #filmes").includes("The Hangover"));
  check("hashtags genéricas não viram título", c("#fyp #viral #filmes #cenasdefilme #netflix").length === 0, JSON.stringify(c("#fyp #viral #filmes #cenasdefilme #netflix")));
  check("legenda sem nome → nada", c("olha isso 😳😳").length === 0);
}

console.log("\n🔥 Pontuação de hype");
{
  const base = { views: 100_000, curtidas: 10_000, comentarios: 100, compartilhamentos: 500 };
  const novo = pontuar({ ...base, criadoEm: h(5) }, AGORA);
  const velho = pontuar({ ...base, criadoEm: h(120) }, AGORA);
  check("o mesmo número de views vale mais num vídeo recente", novo > velho * 2, `${novo} vs ${velho}`);
  const frio = pontuar({ views: 100_000, curtidas: 100, comentarios: 0, compartilhamentos: 0, criadoEm: h(5) }, AGORA);
  check("engajamento sobe a nota", novo > frio, `${novo} vs ${frio}`);
}

console.log("\n🔎 Busca, junção e filtros");
{
  const chamadas = [];
  const fetchFalso = async (url) => {
    chamadas.push(url);
    const u = new URL(url);
    const j = (data) => new Response(JSON.stringify({ code: 0, msg: "success", data }));
    if (u.pathname === "/api/feed/search") {
      const k = u.searchParams.get("keywords");
      if (k === "#quebrada") return new Response(JSON.stringify({ code: -1, msg: "erro interno" }));
      return j({ videos: [
        video("1", { play_count: 2_000_000, create_time: h(6) }),
        video("2", { play_count: 500_000, create_time: h(48) }),
        video("3", { play_count: 900, create_time: h(3) }),                       // poucas views
        video("4", { play_count: 3_000_000, create_time: h(24 * 30) }),            // velho demais
        video("5", { play_count: 800_000, create_time: h(5), duration: 2 }),       // curto demais
        video("6", { play_count: 800_000, create_time: h(5), duration: 900 }),     // longo demais
      ] });
    }
    if (u.pathname === "/api/user/posts") return j({ videos: [video("1", { play_count: 2_000_000, create_time: h(6) }), video("7", { play_count: 1_500_000, create_time: h(4), title: 'Cena de "Gladiador" 🎬' })] });
    return new Response("{}", { status: 404 });
  };
  const r = await buscarTendencias({ tags: "cenasdefilme,quebrada", perfis: "cortesfilmes", dias: 7, minViews: 10_000 }, { fetchFn: fetchFalso, agora: AGORA, pausa: 0 });
  const ids = r.itens.map((x) => x.id);
  check("junta hashtag e perfil sem repetir o mesmo vídeo", ids.filter((x) => x === "1").length === 1 && ids.includes("7") && ids.includes("2"), ids.join(","));
  check("tira poucas views, velhos, curtos e longos", !ids.includes("3") && !ids.includes("4") && !ids.includes("5") && !ids.includes("6"), ids.join(","));
  check("ordena pelo hype (o mais quente primeiro)", r.itens.every((x, i) => i === 0 || r.itens[i - 1].hype >= x.hype) && ids[0] === "7", ids.join(","));
  check("monta o link do TikTok", r.itens[0].url === "https://www.tiktok.com/@cortes7/video/7", r.itens[0].url);
  check("sugere o nome do filme da legenda", r.itens[0].candidatos.some((c) => c.titulo === "Gladiador"));
  check("uma fonte quebrada não derruba as outras (e aparece no estado)", r.estados.length === 3 && r.estados.filter((e) => e.ok).length === 2 && r.estados.find((e) => !e.ok).fonte === "#quebrada" && /erro interno/.test(r.estados.find((e) => !e.ok).erro), JSON.stringify(r.estados));
  check("a busca por hashtag usa #", chamadas.some((u) => /keywords=%23cenasdefilme/.test(u)));
}

console.log("\n⏱️ Limite de pedidos do tikwm: tenta outra vez");
{
  let n = 0;
  const fetchFalso = async () => {
    n++;
    if (n === 1) return new Response(JSON.stringify({ code: -1, msg: "Free Api Limit: 1 request/second." }));
    return new Response(JSON.stringify({ code: 0, data: { videos: [video("9")] } }));
  };
  const r = await buscarTendencias({ tags: "filmes" }, { fetchFn: fetchFalso, agora: AGORA, pausa: 0 });
  check("o segundo pedido passa", r.itens.length === 1 && n === 2, `${r.itens.length} / ${n}`);
}

console.log("\n🩺 Motivo real da falha");
{
  const via = async (fetchFn) => (await buscarTendencias({ tags: "filmes" }, { fetchFn, agora: AGORA, pausa: 0 })).estados[0].erro;
  check("bloqueio anti-robô (HTML do Cloudflare)", /bloqueado pelo anti-robô \(HTTP 403\)/.test(await via(async () => new Response("<html>Just a moment...</html>", { status: 403 }))));
  check("resposta que não é JSON", /resposta inesperada \(HTTP 502\)/.test(await via(async () => new Response("Bad gateway", { status: 502 }))));
  check("falha de rede mostra a causa (ex.: DNS)", /rede: ENOTFOUND/.test(await via(async () => { const e = new TypeError("fetch failed"); e.cause = { code: "ENOTFOUND" }; throw e; })));
  check("manda User-Agent de browser e Referer", await (async () => { let h; await buscarTendencias({ tags: "filmes" }, { fetchFn: async (u, o) => { h = o.headers; return new Response(JSON.stringify({ code: 0, data: { videos: [] } })); }, agora: AGORA, pausa: 0 }); return /Chrome/.test(h["User-Agent"]) && /tikwm/.test(h.Referer); })());
}

console.log("\n🧰 Apify (quando o tikwm bloqueia)");
{
  const chamadas = [];
  const itemApify = (id, o = {}) => ({ id, text: "Cena de \"Gladiador\" 🎬", createTime: h(5), playCount: 1_200_000, diggCount: 90_000, commentCount: 800, shareCount: 12_000, authorMeta: { name: "cortes" + id, nickName: "Cortes" }, videoMeta: { duration: 45, coverUrl: "https://x/c.jpg" }, ...o });
  const fetchApify = async (url, opts) => {
    chamadas.push({ url, opts });
    return new Response(JSON.stringify([itemApify("11"), itemApify("12", { playCount: 5 }), { error: "x" }]), { status: 200 });
  };
  const r = await buscarTendencias({ tags: "filmes,cenasdefilme", perfis: "conta1", apifyToken: "apify_api_x", minViews: 1000 }, { fetchFn: fetchApify, agora: AGORA, pausa: 0 });
  check("faz UMA execução para tudo e não toca no tikwm", chamadas.length === 1 && /api\.apify\.com\/v2\/acts\/clockworks~tiktok-scraper\/run-sync-get-dataset-items\?token=apify_api_x/.test(chamadas[0].url), chamadas.map((c) => c.url).join(" "));
  const entrada = JSON.parse(chamadas[0].opts.body);
  check("manda hashtags e perfis, sem baixar vídeos", JSON.stringify(entrada.hashtags) === JSON.stringify(["filmes", "cenasdefilme"]) && JSON.stringify(entrada.profiles) === JSON.stringify(["conta1"]) && entrada.shouldDownloadVideos === false);
  check("converte para o mesmo formato (link, views, capa, nome provável)", r.itens.length === 1 && r.itens[0].url === "https://www.tiktok.com/@cortes11/video/11" && r.itens[0].views === 1_200_000 && r.itens[0].capa === "https://x/c.jpg" && r.itens[0].candidatos.some((c) => c.titulo === "Gladiador"), JSON.stringify(r.itens[0]));
  check("estado mostra o Apify como fonte", r.estados.length === 1 && r.estados[0].fonte === "Apify" && r.estados[0].ok);
  const erro = async (status, corpo = "{}") => (await buscarTendencias({ tags: "filmes", apifyToken: "t" }, { fetchFn: async () => new Response(corpo, { status }), agora: AGORA, pausa: 0 })).estados[0].erro;
  check("401 → token recusado", /token do Apify recusado/.test(await erro(401)));
  check("402 → sem crédito", /sem crédito/.test(await erro(402)));
  check("outro erro mostra o HTTP e a mensagem", /HTTP 500: boom/.test(await erro(500, JSON.stringify({ error: { message: "boom" } }))));
}

console.log("\n🌐 Endpoint");
{
  const resp = () => ({ headers: {}, setHeader(n, v) { this.headers[n.toLowerCase()] = v; }, end(b) { this.body = b; } });
  const fetchFalso = async () => new Response(JSON.stringify({ code: 0, data: { videos: [video("1")] } }));
  const pedir = async (req) => { const r = resp(); await handler({ method: "GET", headers: { host: "cine-flowx.vercel.app" }, ...req }, r, { fetchFn: fetchFalso, pausa: 0, semCache: true }); return r; };
  let r = await pedir({ url: "/api/public/tendencias?tags=filmes&min=1000&dias=60" });
  check("200 com itens", r.statusCode === 200 && JSON.parse(r.body).itens.length >= 0 && JSON.parse(r.body).estados.length === 1, r.body);
  let tokenVisto = "";
  const rr = resp();
  await handler({ method: "GET", url: "/api/public/tendencias?tags=filmes", headers: { host: "cine-flowx.vercel.app", "x-apify-token": "apify_api_zzz" } }, rr, { fetchFn: async (u) => { tokenVisto = String(u); return new Response("[]", { status: 200 }); }, pausa: 0, semCache: true });
  check("o token do Apify vai por cabeçalho (não por URL do site) e chega ao Apify", /api\.apify\.com/.test(tokenVisto) && /apify_api_zzz/.test(tokenVisto));
  r = await pedir({ url: "/api/public/tendencias" });
  check("sem tags nem perfis → 400", r.statusCode === 400);
  r = await pedir({ method: "POST", url: "/api/public/tendencias?tags=a1" });
  check("só aceita GET", r.statusCode === 405);
  r = await pedir({ url: "/api/public/tendencias?tags=a1", headers: { host: "cine-flowx.vercel.app", origin: "https://site-alheio.example" } });
  check("recusa outro site (CORS)", r.statusCode === 403);
}

console.log("\n🎙️ Achados de Cortes de Filmes Narrados");
{
  check(
    "termosDeBusca preserva espaços nas frases e limpa repetidos/aspas",
    JSON.stringify(termosDeBusca('"filme narrado", Resumo de Filme; filme narrado\ncortes de filmes narrados')) ===
      JSON.stringify(["filme narrado", "Resumo de Filme", "cortes de filmes narrados"])
  );
  const cNarrado = candidatosDeTitulo("Nome do filme: O Preço do Amanhã - Parte 1 🎙️ #filmesnarrados #resumodefilmes #parte1").map((x) => x.titulo);
  check("tira «Parte 1» do candidato e ignora #filmesnarrados/#resumodefilmes", cNarrado.includes("O Preço do Amanhã") && !cNarrado.some((t) => /filmes\s*narrados|parte/i.test(t)), JSON.stringify(cNarrado));
  const cNarrado2 = candidatosDeTitulo("Filme narrado: Interestelar (2014) | Pt. 2").map((x) => x.titulo);
  check("reconhece «Filme narrado:» e limpa «Pt. 2»", cNarrado2.includes("Interestelar"), JSON.stringify(cNarrado2));

  const sigSim = analisarNarrado({
    legenda: "Resumo completo do filme 😱 Parte 1 #filmesnarrados",
    autor: "cinenarrado",
    musicaTitulo: "som original - Cine Narrado",
    musicaOriginal: true,
    duracao: 95,
  });
  check("deteta corte narrado com voz original e corte longo", sigSim.narrado === true && sigSim.somOriginal === true && sigSim.notaNarrado >= 70 && sigSim.sinaisNarrado.some((s) => /Narrado/.test(s)) && sigSim.sinaisNarrado.some((s) => /Voz original/.test(s)), JSON.stringify(sigSim));

  const sigNao = analisarNarrado({
    legenda: "edit brabo 🔥 #fyp #edit",
    autor: "editsx",
    musicaTitulo: "MONTAGEM PR FUNK",
    musicaOriginal: false,
    duracao: 14,
  });
  check("edit curto com música comercial não passa como narrado", sigNao.narrado === false && sigNao.notaNarrado === 0);

  const buscas = [];
  const fetchNarrados = async (url) => {
    buscas.push(String(url));
    const u = new URL(url);
    const kw = u.searchParams.get("keywords") || "";
    if (kw === "#filmesnarrados") {
      return new Response(JSON.stringify({
        code: 0,
        data: {
          videos: [
            video("n1", {
              title: 'Filme narrado: "Gladiador" - Parte 1 #filmesnarrados',
              duration: 185,
              play_count: 600_000,
              create_time: h(8),
              hdplay: "https://v16.tiktokcdn.com/hd_n1.mp4",
              hd_size: 18_500_000,
              music_info: { title: "som original", original: true },
            }),
            video("edit1", {
              title: "olha esse edit #fyp",
              duration: 30,
              play_count: 900_000,
              create_time: h(6),
              music_info: { title: "After Dark", original: false },
            }),
          ],
        },
      }));
    }
    if (kw === "resumo de filme") {
      return new Response(JSON.stringify({
        code: 0,
        data: {
          videos: [
            video("n2", {
              title: "Resumo de filme: O Poço (2019) completo",
              duration: 420,
              play_count: 500_000,
              create_time: h(5),
              hd_size: 32_000_000,
              music_info: { title: "som original - Resumos", original: true },
            }),
          ],
        },
      }));
    }
    return new Response(JSON.stringify({ code: 0, data: { videos: [] } }));
  };

  const rn = await buscarTendencias(
    { modo: "narrados", tags: "filmesnarrados", termos: "resumo de filme", minViews: 10_000, dias: 14 },
    { fetchFn: fetchNarrados, agora: AGORA, pausa: 0 }
  );
  check("busca hashtags (#) e frases livres com hd=1", buscas.some((u) => /keywords=%23filmesnarrados/.test(u) && /hd=1/.test(u)) && buscas.some((u) => /keywords=resumo\+de\+filme|keywords=resumo%20de%20filme/.test(u)));
  check("aceita cortes narrados longos (>5 min, até 10 min) e filtra edits sem narração", rn.itens.map((x) => x.id).includes("n1") && rn.itens.map((x) => x.id).includes("n2") && !rn.itens.map((x) => x.id).includes("edit1"), JSON.stringify(rn.itens.map((x) => x.id)));
  check("traz metadados de HD e sinais de narração em cada achado", rn.itens[0].temHd === true && rn.itens[0].tamanhoBytes > 0 && rn.itens[0].narrado === true);

  const resp = () => ({ headers: {}, setHeader(n, v) { this.headers[n.toLowerCase()] = v; }, end(b) { this.body = b; } });
  const rEnd = resp();
  await handler(
    { method: "GET", url: "/api/public/tendencias?modo=narrados&termos=resumo+de+filme&min=1000", headers: { host: "cine-flowx.vercel.app" } },
    rEnd,
    { fetchFn: fetchNarrados, pausa: 0, semCache: true }
  );
  const corpoEnd = JSON.parse(rEnd.body);
  check("endpoint aceita modo=narrados só com termos livres", rEnd.statusCode === 200 && corpoEnd.modo === "narrados" && corpoEnd.itens.length === 1 && corpoEnd.itens[0].id === "n2");
}

console.log("\n─────────────────────────────────────────────");
if (fail) { console.log(`❌ ${pass} passaram, ${fail} falharam:`); falhas.forEach((f) => console.log("   • " + f)); process.exit(1); }
console.log(`✅ ${pass} passaram, 0 falharam`);
