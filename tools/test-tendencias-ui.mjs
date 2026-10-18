#!/usr/bin/env node
/**
 * Aba «🔥 Tendências» (tendencias.js) num DOM simulado: busca, nome do filme
 * confirmado no TMDB, esconder os já levados, «Levar pro CineClip», erros.
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

function criar({ tmdbKey = "tmdb-k", resposta } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="cc-tendencias-monte"></div></body>', { url: "https://exemplo.test/", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  const chamadas = { api: [], tmdb: [], levar: [] };
  w.fetch = async (url, init) => {
    const u = new URL(String(url), "https://exemplo.test");
    if (u.pathname === "/api/public/tendencias") {
      chamadas.api.push(u.search); chamadas.cabecalhos = init && init.headers;
      const r = resposta ? resposta() : { status: 200, corpo: { geradoEm: Date.now(), estados: [{ fonte: "#cenasdefilme", ok: true }], itens: JSON.parse(JSON.stringify(ITENS)) } };
      return { ok: r.status === 200, status: r.status, json: async () => r.corpo };
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
  w.CineLote = { levarLinks: async (links, destino) => { chamadas.levar.push([links, destino]); } };
  w.navigator.clipboard = { writeText: async () => {} };
  w.eval(fs.readFileSync(new URL("../tendencias.js", import.meta.url), "utf8"));
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
  check("o filme é confirmado no TMDB (nome do TMDB, ano, tipo)", /Se Beber, Não Case!/.test(c.cartoes()[0].textContent) && /2009/.test(c.cartoes()[0].textContent) && /confirmado no TMDB/.test(c.cartoes()[0].textContent), c.cartoes()[0].textContent);
  check("o título tem de bater por inteiro (The Hangover ≠ Part II)", !/Part II/.test(c.cartoes()[0].textContent));
  check("sem nome na legenda, diz que o CineClip identifica pelo vídeo", /não aparece na legenda/.test(c.cartoes()[1].textContent));
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

console.log("\n🧰 Token do Apify");
{
  const c = criar();
  c.w.document.getElementById("cc-tendencias-monte").className = "";
  await dormir(900);
  check("sem token não manda o cabeçalho", !c.chamadas.cabecalhos);
  const campo = [...c.w.document.querySelectorAll(".ct-campo input")].find((i) => i.type === "password");
  check("há um campo de senha para o token", !!campo);
  campo.value = "apify_api_abc"; campo.dispatchEvent(new c.w.Event("input"));
  [...c.w.document.querySelectorAll("button")].find((b) => /Buscar tendências/.test(b.textContent)).click();
  await dormir(200);
  check("com token manda X-Apify-Token", c.chamadas.cabecalhos && c.chamadas.cabecalhos["X-Apify-Token"] === "apify_api_abc", JSON.stringify(c.chamadas.cabecalhos));
  check("o token fica guardado só neste aparelho", /apify_api_abc/.test(c.w.localStorage.getItem("cineclip.tendencias.opcoes") || ""));
}
{
  const c = criar({ resposta: () => ({ status: 200, corpo: { geradoEm: Date.now(), estados: [{ fonte: "#a", ok: false, erro: "bloqueado pelo anti-robô (HTTP 403)" }], itens: [] } }) });
  c.w.document.getElementById("cc-tendencias-monte").className = "";
  await dormir(900);
  check("bloqueado e sem token → sugere o Apify", /token do Apify/.test(c.texto()) && /bloqueado pelo anti-robô/.test(c.texto()));
}

console.log("\n─────────────────────────────────────────────");
if (fail) { console.log(`❌ ${pass} passaram, ${fail} falharam:`); falhas.forEach((f) => console.log("   • " + f)); process.exit(1); }
console.log(`✅ ${pass} passaram, 0 falharam`);
process.exit(0);
