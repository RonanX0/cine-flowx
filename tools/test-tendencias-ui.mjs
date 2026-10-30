#!/usr/bin/env node
/**
 * Aba «🔥 Tendências» (tendencias.js) num DOM simulado: busca, nome do filme
 * título da legenda encontrado no TMDB, esconder os já levados, «Levar pro CineClip», erros.
 *
 *   node tools/test-tendencias-ui.mjs
 */
import fs from "node:fs";
import { JSDOM } from "jsdom";

let pass = 0, fail = 0;
const falhas = [];
const check = (n, ok, d = "") => { if (ok) { pass++; console.log(`   ✔ ${n}`); } else { fail++; falhas.push(n); console.log(`   ❌ ${n}${d ? " — " + d : ""}`); } };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const agoraS = Math.floor(Date.now() / 1000);
const ITENS = [
  { id: "1", url: "https://www.tiktok.com/@cortes/video/1", autor: "cortes", legenda: "Que cena 😱 #TheHangover #fyp", capa: "https://x/1.jpg", duracao: 40, views: 2_000_000, curtidas: 300_000, comentarios: 900, compartilhamentos: 20_000, criadoEm: agoraS - 6 * 3600, hype: 90000, candidatos: [{ titulo: "The Hangover", origem: "hashtag" }] },
  { id: "2", url: "https://www.tiktok.com/@outro/video/2", autor: "outro", legenda: "olha isso", capa: "", duracao: 30, views: 500_000, curtidas: 50_000, comentarios: 100, compartilhamentos: 1000, criadoEm: agoraS - 20 * 3600, hype: 30000, candidatos: [] },
  { id: "3", url: "https://www.tiktok.com/@x/video/3", autor: "x", legenda: "#Zzzzz Nome Inventado", capa: "", duracao: 30, views: 300_000, curtidas: 1000, comentarios: 10, compartilhamentos: 10, criadoEm: agoraS - 10 * 3600, hype: 20000, candidatos: [{ titulo: "Zzzzz", origem: "hashtag" }] },
];

function criar({ tmdbKey = "tmdb-k", resposta, respostaImportar } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="cc-tendencias-monte"></div></body>', { url: "https://exemplo.test/", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  const chamadas = { api: [], tmdb: [], levar: [], receberVideos: [], importar: [], salvosLocal: [] };
  w.fetch = async (url, init) => {
    const u = new URL(String(url), "https://exemplo.test");
    if (u.pathname === "/api/public/tendencias") {
      chamadas.api.push(u.search); chamadas.cabecalhos = init && init.headers;
      const r = resposta ? await resposta(u) : { status: 200, corpo: { geradoEm: Date.now(), estados: [{ fonte: "#cenasdefilme", ok: true }], itens: JSON.parse(JSON.stringify(ITENS)) } };
      return { ok: r.status === 200, status: r.status, json: async () => r.corpo };
    }
    if (u.pathname === "/api/public/importar") {
      chamadas.importar.push(u.search);
      const padrao = {
        status: 200,
        bytes: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 97, 118, 99, 49]),
        cabecalhos: {
          "content-length": "12",
          "X-Cineclip-Nome": "tiktok_cortes_1.mp4",
          "X-Cineclip-Codec": "h264",
          "X-Cineclip-Qualidade": "1080p",
          "X-Cineclip-Titulo": "Corte narrado",
        },
      };
      const cfg = respostaImportar ? respostaImportar(u) : padrao;
      const mapaCab = new Map(Object.entries(cfg.cabecalhos || padrao.cabecalhos).map(([k, v]) => [k.toLowerCase(), String(v)]));
      return {
        ok: cfg.status === 200,
        status: cfg.status,
        headers: { get: (n) => mapaCab.get(String(n).toLowerCase()) || null },
        arrayBuffer: async () => (cfg.bytes || padrao.bytes).buffer,
        json: async () => cfg.corpo || {},
      };
    }
    if (u.hostname === "api.themoviedb.org") {
      const q = u.searchParams.get("query");
      chamadas.tmdb.push(q);
      const resultados = /hangover/i.test(q) ? [{ media_type: "movie", id: 18785, title: "Se Beber, Não Case!", original_title: "The Hangover", release_date: "2009-06-05", popularity: 80, poster_path: "/p.jpg" }, { media_type: "movie", id: 5, title: "The Hangover Part II", original_title: "The Hangover Part II", release_date: "2011-05-01", popularity: 70 }] : [];
      return { ok: true, json: async () => ({ results: resultados }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  w.__CineClipApp = { settings: { tmdbKey } };
  w.CineLote = {
    levarLinks: async (links, destino) => { chamadas.levar.push([links, destino]); },
    receberVideos: (ficheiros, opcoes) => { chamadas.receberVideos.push({ ficheiros, opcoes }); },
  };
  w.navigator.clipboard = { writeText: async () => {} };
  w.eval(fs.readFileSync(new URL("../tendencias.js", import.meta.url), "utf8"));
  w.CineTendencias._interno.ambiente.salvarLocal = (f) => { chamadas.salvosLocal.push(f); return true; };
  return { w, chamadas, texto: () => w.document.getElementById("cc-tendencias-monte").textContent, cartoes: () => [...w.document.querySelectorAll(".ct-card")] };
}

console.log("\n🔥 Monta, busca e mostra");
{
  const c = criar();
  await dormir(50);
  check("monta o painel na aba", !!c.w.document.querySelector(".ct-painel"));
  check("a aba escondida não busca sozinha", c.chamadas.api.length === 0);
  c.w.document.getElementById("cc-tendencias-monte").className = ""; // a aba fica visível
  await dormir(900);
  check("ao abrir a aba pela primeira vez, busca sozinha", c.chamadas.api.length === 1, String(c.chamadas.api.length));
  check("a busca leva hashtags, dias e mínimo de views", /tags=cenasdefilme/.test(c.chamadas.api[0]) && /dias=7/.test(c.chamadas.api[0]) && /min=20000/.test(c.chamadas.api[0]), c.chamadas.api[0]);
  check("mostra um cartão por corte", c.cartoes().length === 3);
  await dormir(200);
  check("o título da legenda é encontrado no TMDB (nome, ano, tipo)", /Se Beber, Não Case!/.test(c.cartoes()[0].textContent) && /2009/.test(c.cartoes()[0].textContent) && /título da legenda encontrado no TMDB/.test(c.cartoes()[0].textContent), c.cartoes()[0].textContent);
  check("o título tem de bater por inteiro (The Hangover ≠ Part II)", !/Part II/.test(c.cartoes()[0].textContent));
  check("sem nome na legenda, orienta importar para tentar identificar", /não aparece na legenda/.test(c.cartoes()[1].textContent) && /Importe o vídeo para tentar identificar/.test(c.cartoes()[1].textContent));
  check("candidato que o TMDB não conhece fica como «não confirmado»", /Nome provável: Zzzzz \(não confirmado\)/.test(c.cartoes()[2].textContent), c.cartoes()[2].textContent);
  check("mostra views e hype por hora", /2 mi/.test(c.cartoes()[0].textContent) && /🔥/.test(c.cartoes()[0].textContent));

  console.log("\n📥 Levar pro CineClip");
  [...c.cartoes()[0].querySelectorAll("button")].find((b) => /Levar pro CineClip/.test(b.textContent)).click();
  await dormir(50);
  check("envia o link ao Upload em massa (destino «aqui»)", JSON.stringify(c.chamadas.levar[0]) === JSON.stringify([["https://www.tiktok.com/@cortes/video/1"], "aqui"]), JSON.stringify(c.chamadas.levar));
  check("o que já foi levado some da lista", c.cartoes().length === 2 && !/Se Beber/.test(c.texto()));
  check("e fica guardado para a próxima vez", /"1"/.test(c.w.localStorage.getItem("cineclip.tendencias.usados") || ""));
  [...c.cartoes()[0].querySelectorAll("button")].find((b) => /Nuvem/.test(b.textContent)).click();
  await dormir(50);
  check("«☁️ Nuvem» usa o destino nuvem", c.chamadas.levar[1] && c.chamadas.levar[1][1] === "nuvem");
  const caixa = c.w.document.querySelector(".ct-opcao input");
  caixa.checked = false; caixa.dispatchEvent(new c.w.Event("change"));
  check("desmarcando «Esconder», os levados voltam (esmaecidos)", c.cartoes().length === 3 && c.cartoes().some((x) => /usado/.test(x.className)));
}

console.log("\n🔑 Sem chave TMDB");
{
  const c = criar({ tmdbKey: "" });
  c.w.document.getElementById("cc-tendencias-monte").className = "";
  await dormir(900);
  check("não chama o TMDB e mostra o nome provável", c.chamadas.tmdb.length === 0 && /Nome provável: The Hangover — põe a chave TMDB/.test(c.cartoes()[0].textContent), c.cartoes()[0] && c.cartoes()[0].textContent);
}

console.log("\n⚠️ Erros");
{
  const c = criar({ resposta: () => ({ status: 404, corpo: {} }) });
  c.w.document.getElementById("cc-tendencias-monte").className = "";
  await dormir(900);
  check("404 → explica que só funciona no site publicado", /só funcionam no site publicado/.test(c.texto()), c.texto().slice(0, 200));
}
{
  const c = criar({ resposta: () => ({ status: 200, corpo: { geradoEm: Date.now(), estados: [{ fonte: "#a", ok: false, erro: "Free Api Limit" }], itens: [] } }) });
  c.w.document.getElementById("cc-tendencias-monte").className = "";
  await dormir(900);
  check("todas as fontes falharam → avisa o motivo", /Nenhuma fonte respondeu \(Free Api Limit\)/.test(c.texto()), c.texto().slice(0, 300));
}
{
  const c = criar();
  c.w.document.getElementById("cc-tendencias-monte").className = "";
  await dormir(900);
  const inp = c.w.document.querySelector(".ct-campo input");
  inp.value = ""; inp.dispatchEvent(new c.w.Event("input"));
  c.w.document.querySelectorAll(".ct-campo input")[1].value = "";
  [...c.w.document.querySelectorAll("button")].find((b) => /Buscar tendências/.test(b.textContent)).click();
  await dormir(50);
  check("sem hashtag nem perfil não busca e avisa", /pelo menos uma hashtag/.test(c.texto()));
}

console.log("\n🌍 Busca sem token");
{
  const c = criar({ tmdbKey: "" });
  c.w.document.getElementById("cc-tendencias-monte").className = "";
  await dormir(900);
  check("não pede token nem envia credenciais", !c.w.document.querySelector('input[type="password"]') && !c.chamadas.cabecalhos);
  check("explica os perfis sugeridos e limites dos dados públicos", /@teusflix/.test(c.texto()) && /até 10 vídeos/.test(c.texto()));
  c.w.CineTendencias._interno.aplicar({ itens: [{ ...ITENS[0], duracao: null, curtidas: null, compartilhamentos: null, dataEstimada: true }], estados: [] });
  check("duração e métricas desconhecidas aparecem como indisponíveis", /duração não informada/.test(c.cartoes()[0].textContent) && /❤ —/.test(c.cartoes()[0].textContent) && /data estimada/.test(c.cartoes()[0].textContent));
  c.w.close();
}
{
  const c = criar({ resposta: () => ({ status: 200, corpo: { estados: [{ fonte: "#a", ok: false, erro: "bloqueado pelo anti-robô (HTTP 403)" }], itens: [] } }) });
  c.w.document.getElementById("cc-tendencias-monte").className = "";
  await dormir(900);
  check("bloqueio sugere perfis sem exigir serviço pago", /indique perfis públicos/.test(c.texto()) && !/Apify/.test(c.texto()));
  c.w.close();
}

console.log("\n🎙️ Achados de Filmes Narrados + Baixar HD e ir pro Upload");
{
  const itensNarrados = [
    {
      id: "n10",
      url: "https://www.tiktok.com/@cinenarrado/video/10",
      autor: "cinenarrado",
      legenda: 'Filme narrado: "The Hangover" - Parte 1 #filmesnarrados',
      capa: "https://x/10.jpg",
      duracao: 125,
      views: 1_500_000,
      curtidas: 180_000,
      comentarios: 950,
      compartilhamentos: 14_000,
      criadoEm: agoraS - 5 * 3600,
      hype: 85000,
      temHd: true,
      tamanhoBytes: 16 * 1024 * 1024,
      narrado: true,
      sinaisNarrado: ["🎙️ Narrado", "🔊 Voz original", "⏱️ 1min+"],
      candidatos: [{ titulo: "The Hangover", origem: "aspas" }],
    },
    {
      id: "n11",
      url: "https://www.tiktok.com/@resumoshd/video/11",
      autor: "resumoshd",
      legenda: "Resumo completo de filme #resumodefilmes",
      capa: "https://x/11.jpg",
      duracao: 92,
      views: 800_000,
      curtidas: 70_000,
      comentarios: 300,
      compartilhamentos: 4000,
      criadoEm: agoraS - 8 * 3600,
      hype: 55000,
      temHd: true,
      tamanhoBytes: 12 * 1024 * 1024,
      narrado: true,
      sinaisNarrado: ["📖 Resumo", "🔊 Voz original"],
      candidatos: [],
    },
  ];

  const c = criar({
    resposta: (u) => ({
      status: 200,
      corpo: {
        geradoEm: Date.now(),
        modo: u.searchParams.get("modo") || "cortes",
        estados: [{ fonte: "#filmesnarrados", ok: true }],
        itens: u.searchParams.get("modo") === "narrados" ? JSON.parse(JSON.stringify(itensNarrados)) : JSON.parse(JSON.stringify(ITENS)),
      },
    }),
  });
  c.w.document.getElementById("cc-tendencias-monte").className = "";
  await dormir(900);

  const btnAbaNarrados = [...c.w.document.querySelectorAll(".ct-aba")].find((b) => /Filmes Narrados/.test(b.textContent));
  check("mostra a aba «🎙️ Filmes Narrados (Achados)»", !!btnAbaNarrados);
  btnAbaNarrados.click();
  await dormir(250);

  const ultimaQuery = c.chamadas.api[c.chamadas.api.length - 1] || "";
  check("ao mudar para Filmes Narrados, busca modo=narrados com hashtags e frases narradas", /modo=narrados/.test(ultimaQuery) && /tags=filmesnarrados/.test(ultimaQuery) && /termos=filme\+narrado/.test(ultimaQuery) && /minDur=25/.test(ultimaQuery), ultimaQuery);
  check("mostra os sinais de narração e o selo HD com tamanho", /🎙️ Narrado/.test(c.cartoes()[0].textContent) && /🔊 Voz original/.test(c.cartoes()[0].textContent) && /HD · 16 MB/.test(c.cartoes()[0].textContent), c.cartoes()[0].textContent);

  // Clicar em «⬇️ Baixar HD e ir pro Upload» no 1.º cartão
  const btnBaixarUpload = [...c.cartoes()[0].querySelectorAll("button")].find((b) => /Baixar HD e ir pro Upload/.test(b.textContent));
  check("cartão tem o botão principal «⬇️ Baixar HD e ir pro Upload»", !!btnBaixarUpload);
  btnBaixarUpload.click();
  await dormir(150);

  check("chama /api/public/importar com hd=1", c.chamadas.importar.length === 1 && /hd=1/.test(c.chamadas.importar[0]) && /cinenarrado/.test(decodeURIComponent(c.chamadas.importar[0])), JSON.stringify(c.chamadas.importar));
  check("salva o arquivo .mp4 em HD nos Downloads com o nome do filme confirmado", c.chamadas.salvosLocal.length === 1 && /se_beber_nao_case_2009_cinenarrado_n10_hd\.mp4/.test(c.chamadas.salvosLocal[0].name), c.chamadas.salvosLocal[0] && c.chamadas.salvosLocal[0].name);
  check("envia automaticamente o File para o 📦 Upload em massa com pista do filme e link de origem", c.chamadas.receberVideos.length === 1 && c.chamadas.receberVideos[0].ficheiros.length === 1 && c.chamadas.receberVideos[0].ficheiros[0].pistaLink === "Se Beber, Não Case! (2009)" && c.chamadas.receberVideos[0].ficheiros[0]._origemLink === "https://www.tiktok.com/@cinenarrado/video/10");
  check("avisa que baixou em 1080P, salvou nos Downloads e carregou no Upload em massa", /1080P/.test(c.texto()) && /Downloads/.test(c.texto()) && /Upload em massa/.test(c.texto()), c.texto().slice(0, 350));

  // Desmarcar esconder para selecionar os 2 e baixar em lote
  const chkEsconder = c.w.document.querySelector(".ct-opcao input");
  chkEsconder.checked = false;
  chkEsconder.dispatchEvent(new c.w.Event("change"));
  c.cartoes().forEach((card) => {
    const sel = card.querySelector(".ct-sel input");
    sel.checked = true;
    sel.dispatchEvent(new c.w.Event("change"));
  });
  const btnLote = [...c.w.document.querySelectorAll(".ct-barra-lote button")].find((b) => /Baixar 2 em HD/.test(b.textContent));
  check("selecionar múltiplos cartões abre barra para baixar todos em HD + Upload", !!btnLote);
  btnLote.click();
  await dormir(200);
  check("baixa os 2 vídeos em HD e envia os 2 juntos para o Upload em massa", c.chamadas.receberVideos.length === 2 && c.chamadas.receberVideos[1].ficheiros.length === 2 && c.chamadas.salvosLocal.length === 3);
}

console.log("\n🛡️ Fallback automático HEVC → H.264 para o Upload em massa + Integração real com lote-massa.js");
{
  const dom = new JSDOM('<!doctype html><body><div id="cc-tendencias-monte"></div></body>', { url: "https://exemplo.test/", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  const pedidosImp = [];
  const salvos = [];
  w.__CineClipApp = { settings: { groqKey: "g", tmdbKey: "t" }, account: { id: "acc1", name: "@cine" } };
  w.CineClipCore = {};
  w.navigator.clipboard = { writeText: async () => {} };
  w.fetch = async (url) => {
    const u = new URL(String(url), "https://exemplo.test");
    if (u.pathname === "/api/public/tendencias") {
      return { ok: true, status: 200, json: async () => ({ geradoEm: Date.now(), estados: [{ fonte: "#filmesnarrados", ok: true }], itens: [ITENS[0]] }) };
    }
    if (u.pathname === "/api/public/importar") {
      pedidosImp.push(u.search);
      const ehH264 = u.searchParams.get("codec") === "h264";
      const cab = new Map([
        ["content-length", ehH264 ? "16" : "24"],
        ["x-cineclip-nome", "tiktok_cortes_1.mp4"],
        ["x-cineclip-codec", ehH264 ? "h264" : "bytevc1"],
        ["x-cineclip-qualidade", ehH264 ? "720p" : "1080p"],
      ]);
      return {
        ok: true,
        status: 200,
        headers: { get: (n) => cab.get(String(n).toLowerCase()) || null },
        arrayBuffer: async () => new Uint8Array(ehH264 ? 16 : 24).buffer,
      };
    }
    return { ok: true, status: 200, json: async () => ({ results: [] }) };
  };
  w.eval(fs.readFileSync(new URL("../lote-massa.js", import.meta.url), "utf8"));
  w.eval(fs.readFileSync(new URL("../tendencias.js", import.meta.url), "utf8"));
  w.CineTendencias._interno.ambiente.salvarLocal = (f) => { salvos.push(f); return true; };
  // Simula um navegador de PC sem suporte a imagem HEVC
  w.CineTendencias._interno.ambiente.podeDecodificar = async () => false;

  await w.CineTendencias.baixarParaUpload([ITENS[0]]);
  check("salva o master 1080p (24 bytes) nos Downloads do utilizador", salvos.length === 1 && salvos[0].size === 24);
  check("busca automaticamente codec=h264 (16 bytes) para o Upload em massa não travar", pedidosImp.length === 2 && /codec=h264/.test(pedidosImp[1]));
  const estadoLote = w.CineLote._interno.estado;
  check("abre o modal real do 📦 Upload em massa já com o vídeo H.264 pendente e com a dica do filme", estadoLote.aberto === true && estadoLote.itens.length === 1 && estadoLote.itens[0].bytes === 16 && estadoLote.itens[0].dica === "The Hangover");
  dom.window.close();
}

console.log("\n🔁 Troca de modo durante uma busca e qualidade desconhecida");
{
  const pendentes = [];
  const c = criar({ tmdbKey: "", resposta: (u) => new Promise((resolve) => pendentes.push({ modo: u.searchParams.get("modo") || "cortes", resolve })) });
  c.w.CineTendencias.montar();
  const primeira = c.w.CineTendencias.buscar(true);
  c.w.CineTendencias._interno.alternarModo("narrados");
  check("mudar de modo inicia a nova busca sem esperar a anterior", pendentes.length === 2 && pendentes[1].modo === "narrados");
  pendentes[1].resolve({ status: 200, corpo: { itens: [{ ...ITENS[1], id: "narrado", legenda: "Filme narrado novo", temHd: false }], estados: [] } });
  await dormir(20);
  pendentes[0].resolve({ status: 200, corpo: { itens: ITENS, estados: [] } });
  await primeira;
  const estado = c.w.CineTendencias._interno.estado;
  check("resposta atrasada não substitui os narrados nem marca Cortes como buscado", estado.itens.length === 1 && estado.itens[0].id === "narrado" && estado.jaBuscouPorModo.narrados && !estado.jaBuscouPorModo.cortes);
  check("sem informação de HD, mostra qualidade a verificar", c.cartoes()[0].querySelector(".ct-selo-hd").textContent === "Qualidade a verificar");
  c.w.close();
}
{
  const pendentes = [];
  const c = criar({ tmdbKey: "", resposta: () => new Promise((resolve) => pendentes.push(resolve)) });
  c.w.CineTendencias.montar();
  const primeira = c.w.CineTendencias.buscar(true);
  c.w.CineTendencias._interno.alternarModo("narrados");
  pendentes[0]({ status: 500, corpo: { error: "erro da aba anterior" } });
  await primeira;
  check("erro antigo não encerra nem exibe erro na busca nova", c.w.CineTendencias._interno.estado.carregando && !c.w.CineTendencias._interno.estado.erro);
  pendentes[1]({ status: 200, corpo: { itens: [], estados: [{ ok: false, erro: "falha temporária" }] } });
  await dormir(20);
  check("falha temporária de fontes não é gravada no cache", !c.w.localStorage.getItem("cineclip.tendencias.narrados.resultado.v3"));
  c.w.close();
}


console.log("\n⚡ Download HD em paralelo (lote de 6 cortes narrados)");
{
  /* Um corte em 1080p são dezenas de MB. Em fila indiana, um download lento no
     início segura todos os seguintes — era o que acontecia antes. Aqui o 1.º da
     lista é de propósito o mais lento: se o lote voltasse a ser sequencial, o
     pico de pedidos em voo seria 1 e o tempo total ≥ soma de todos os atrasos. */
  const itensLote = Array.from({ length: 6 }, (_, i) => ({
    id: "p" + i,
    url: "https://www.tiktok.com/@narra/video/" + (100 + i),
    autor: "narra" + i,
    legenda: "resumo do filme",
    capa: "",
    duracao: 60,
    views: 100_000,
    curtidas: 10,
    comentarios: 1,
    compartilhamentos: 1,
    criadoEm: agoraS - 3600,
    hype: 100,
    narrado: true,
    sinaisNarrado: ["📖 Resumo"],
    candidatos: [],
  }));

  const c = criar();
  await dormir(50);

  const fetchOriginal = c.w.fetch;
  let emVoo = 0;
  let pico = 0;
  const ordemFim = [];
  const ATRASOS = [140, 20, 20, 20, 20, 20];
  const avisos = [];
  c.w.fetch = async (url, init) => {
    const u = new URL(String(url), "https://exemplo.test");
    if (u.pathname !== "/api/public/importar") return fetchOriginal(url, init);
    const alvo = u.searchParams.get("url") || "";
    const n = Number((alvo.match(/video\/(\d+)/) || [])[1] || 0) - 100;
    avisos.push(c.w.CineTendencias._interno.estado.aviso || "");
    emVoo++;
    pico = Math.max(pico, emVoo);
    await dormir(ATRASOS[n] != null ? ATRASOS[n] : 20);
    emVoo--;
    ordemFim.push(n);
    return fetchOriginal(url, init);
  };

  const t0 = Date.now();
  const ficheiros = await c.w.CineTendencias.baixarParaUpload(itensLote, { salvarNoDispositivo: false });
  const demorou = Date.now() - t0;

  check("baixa os 6 cortes do lote", c.chamadas.importar.length === 6 && ficheiros.length === 6, `importar=${c.chamadas.importar.length} ficheiros=${ficheiros.length}`);
  check("mais de um download corre ao mesmo tempo", pico > 1, `pico=${pico}`);
  check("respeita o limite de 4 simultâneos (padrão)", pico <= 4, `pico=${pico}`);
  check("o download lento do 1.º item não segura os seguintes", ordemFim.length === 6 && ordemFim.indexOf(0) > 0, JSON.stringify(ordemFim));
  check("o lote inteiro não demora a soma dos downloads", demorou < ATRASOS.reduce((a, b) => a + b, 0), `${demorou}ms`);

  const envio = c.chamadas.receberVideos[c.chamadas.receberVideos.length - 1];
  const ordemUpload = envio.ficheiros.map((f) => Number((String(f._origemLink).match(/video\/(\d+)/) || [])[1] || 0) - 100);
  check("o Upload em massa recebe na ordem em que os cartões foram selecionados", JSON.stringify(ordemUpload) === JSON.stringify([0, 1, 2, 3, 4, 5]), JSON.stringify(ordemUpload));
  check("terminaram fora de ordem, mas a fila saiu ordenada", JSON.stringify(ordemFim) !== JSON.stringify([0, 1, 2, 3, 4, 5]), JSON.stringify(ordemFim));
  check("avisa quantos vão ao mesmo tempo", /6 vídeos em alta qualidade \(HD\), 4 ao mesmo tempo/.test(avisos[0] || ""), String(avisos[0]));
  c.w.close();
}

/* Com o limite em 1, o comportamento antigo (um por vez) continua disponível. */
console.log("\n🐢 Limite em 1 volta ao download um-por-vez");
{
  const c = criar();
  await dormir(50);
  c.w.CineTendencias._interno.estado.opcoes.downloadsSimultaneos = 1;

  const fetchOriginal = c.w.fetch;
  let emVoo = 0;
  let pico = 0;
  c.w.fetch = async (url, init) => {
    const u = new URL(String(url), "https://exemplo.test");
    if (u.pathname !== "/api/public/importar") return fetchOriginal(url, init);
    emVoo++;
    pico = Math.max(pico, emVoo);
    await dormir(20);
    emVoo--;
    return fetchOriginal(url, init);
  };

  await c.w.CineTendencias.baixarParaUpload(JSON.parse(JSON.stringify(ITENS)), { salvarNoDispositivo: false });
  check("limite 1 mantém um download por vez", pico === 1, `pico=${pico}`);
  check("e ainda entrega os 3 na ordem", c.chamadas.receberVideos[c.chamadas.receberVideos.length - 1].ficheiros.length === 3);
  c.w.close();
}


console.log("\n🔢 Quantos vídeos o painel pede ao servidor");
{
  /* O endpoint aceita 5–100 (server/tendencias.mjs) e o painel pedia 40 fixos.
     `total` é quantos passaram pelas fontes antes do corte, e serve para o
     utilizador saber se vale subir a opção ou aliviar os filtros. */
  const c = criar({
    resposta: () => ({
      status: 200,
      corpo: { geradoEm: Date.now(), total: 137, estados: [{ fonte: "#cenasdefilme", ok: true }], itens: JSON.parse(JSON.stringify(ITENS)) },
    }),
  });
  c.w.document.getElementById("cc-tendencias-monte").className = "";
  await dormir(900);

  check("por omissão pede 60, não os 40 fixos de antes", /max=60/.test(c.chamadas.api[0] || ""), c.chamadas.api[0]);
  check("avisa quantos cortes ficaram de fora", /Mostrando 3 de 137/.test(c.texto()), c.texto().slice(0, 200));

  c.w.CineTendencias._interno.estado.opcoes.quantosVideos = 100;
  await c.w.CineTendencias.buscar(true);
  await dormir(250);
  check("subir a opção pede mais ao servidor", /max=100/.test(c.chamadas.api[c.chamadas.api.length - 1] || ""), c.chamadas.api[c.chamadas.api.length - 1]);

  c.w.CineTendencias._interno.estado.opcoes.quantosVideos = 500;
  await c.w.CineTendencias.buscar(true);
  await dormir(250);
  check("nunca pede acima do teto do endpoint", /max=100/.test(c.chamadas.api[c.chamadas.api.length - 1] || ""), c.chamadas.api[c.chamadas.api.length - 1]);

  c.w.CineTendencias._interno.estado.opcoes.quantosVideos = 0;
  await c.w.CineTendencias.buscar(true);
  await dormir(250);
  check("valor inválido cai no padrão", /max=60/.test(c.chamadas.api[c.chamadas.api.length - 1] || ""), c.chamadas.api[c.chamadas.api.length - 1]);
  c.w.close();
}

console.log("\n─────────────────────────────────────────────");
if (fail) { console.log(`❌ ${pass} passaram, ${fail} falharam:`); falhas.forEach((f) => console.log("   • " + f)); process.exit(1); }
console.log(`✅ ${pass} passaram, 0 falharam`);
process.exit(0);
