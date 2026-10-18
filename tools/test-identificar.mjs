#!/usr/bin/env node
/**
 * Identificação do filme e ganchos (patches 33–37), com a IA e o TMDB simulados.
 *
 *   • nS (procurarTmdb) confere o elenco: atores reconhecidos e personagens ouvidos
 *     têm de estar no elenco — um filme popular do mesmo ator já não ganha ao certo,
 *     e o ano escolhe entre remakes;
 *   • devolve `verificacao` (quantos atores/personagens bateram) para o lote baixar a
 *     confiança quando nada bate;
 *   • Zb manda as pistas (legenda do post) e lê os personagens;
 *   • Hm usa o contexto do filme, põe o "melhor" gancho primeiro e tira os genéricos;
 *   • o Gemini mais recente vem primeiro.
 *
 *   node tools/test-identificar.mjs
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const s = fs.readFileSync(path.join(root, "index.html"), "utf8");
let pass = 0, fail = 0;
const falhas = [];
const check = (n, ok, d = "") => { if (ok) { pass++; console.log(`   ✔ ${n}`); } else { fail++; falhas.push(n); console.log(`   ❌ ${n}${d ? " — " + d : ""}`); } };
const corta = (a, b) => { const i = s.indexOf(a); if (i < 0) throw new Error("sem " + a); return s.slice(i, s.indexOf(b, i)); };

/* ------------------------------------------------------------- TMDB falso */
const FILMES = {
  "movie-157336": { id: 157336, title: "Interestelar", original_title: "Interstellar", release_date: "2014-11-05", popularity: 120, overview: "Exploradores.", genres: [{ name: "Ficção científica" }],
    cast: [{ name: "Matthew McConaughey", character: "Cooper" }, { name: "Anne Hathaway", character: "Brand" }, { name: "Jessica Chastain", character: "Murph" }] },
  "movie-106646": { id: 106646, title: "O Lobo de Wall Street", original_title: "The Wolf of Wall Street", release_date: "2013-12-25", popularity: 300, overview: "Corretor.", genres: [{ name: "Comédia" }],
    cast: [{ name: "Leonardo DiCaprio", character: "Jordan Belfort" }, { name: "Matthew McConaughey", character: "Mark Hanna" }] },
  "movie-438631": { id: 438631, title: "Duna", original_title: "Dune", release_date: "2021-09-15", popularity: 200, overview: "Paul Atreides.", genres: [{ name: "Ficção" }],
    cast: [{ name: "Timothée Chalamet", character: "Paul Atreides" }, { name: "Rebecca Ferguson", character: "Jessica" }] },
  "movie-841": { id: 841, title: "Duna", original_title: "Dune", release_date: "1984-12-14", popularity: 60, overview: "Versão de 1984.", genres: [{ name: "Ficção" }],
    cast: [{ name: "Kyle MacLachlan", character: "Paul Atreides" }] },
  "movie-999": { id: 999, title: "A Casa", original_title: "The House", release_date: "2017-06-30", popularity: 40, overview: "Comédia.", genres: [{ name: "Comédia" }],
    cast: [{ name: "Will Ferrell", character: "Scott" }] },
};
const resumo = (k) => { const f = FILMES[k]; return { id: f.id, title: f.title, original_title: f.original_title, release_date: f.release_date, popularity: f.popularity, poster_path: "/p.jpg" }; };
const PESQUISA = { interestelar: ["movie-157336"], interstellar: ["movie-157336"], duna: ["movie-438631", "movie-841"], dune: ["movie-438631", "movie-841"], "a casa": ["movie-999"], "the house": ["movie-999"] };
const pedidos = [];
async function vo(_chave, caminho, params) {
  pedidos.push(caminho);
  let m;
  if (caminho === "/search/movie") return { results: (PESQUISA[String(params.query).toLowerCase()] || []).map(resumo) };
  if (caminho === "/search/tv") return { results: [] };
  if (caminho === "/search/person") return { results: /McConaughey/i.test(params.query) ? [{ id: 1, known_for: [] }] : [] };
  if (caminho === "/person/1/combined_credits") return { cast: [{ ...resumo("movie-106646"), media_type: "movie", vote_count: 9000 }, { ...resumo("movie-157336"), media_type: "movie", vote_count: 8000 }] };
  if ((m = /^\/(movie|tv)\/(\d+)\/(credits|aggregate_credits)$/.exec(caminho))) return { cast: (FILMES[`${m[1]}-${m[2]}`] || {}).cast || [] };
  if ((m = /^\/(movie|tv)\/(\d+)$/.exec(caminho))) { const f = FILMES[`${m[1]}-${m[2]}`]; return { ...resumo(`${m[1]}-${m[2]}`), overview: f.overview, genres: f.genres }; }
  return {};
}

const ctx = vm.createContext({ console, Promise, Map, Set, JSON, Number, String, Math, Array, Object, vo, ft: class extends Error {}, fg: (x) => (x ? String(x) : ""), cg: () => ({ mime_type: "image/jpeg", data: "x" }) });
vm.runInContext(["function Si(", "function fi(", "async function Ru(", "async function mg(", "async function pg(", "async function nS("].map((a) => {
  const fim = { "function Si(": "function fi(", "function fi(": "async function Ru(", "async function Ru(": "async function mg(", "async function mg(": "async function pg(", "async function pg(": "async function nS(", "async function nS(": "function rS(" }[a];
  return corta(a, fim);
}).join("\n") + ";this.nS=nS;", ctx);

console.log("\n🎬 Identificação e ganchos\n");
console.log("1. TMDB confere o elenco");
{
  // A IA reconhece o ator mas erra o título em português ("Interestelar" não bate com o pt do TMDB? bate) —
  // aqui o caso difícil: o título da IA não está no TMDB e só o ator ajuda.
  const r = await ctx.nS("k", { titulo: "Viagem às Estrelas", titulo_original: "Star Voyage", ano: 2014, atores: ["Matthew McConaughey (Cooper)"], personagens: ["Murph"], alternativas: [] });
  check("com título errado, o personagem ouvido escolhe o filme certo do ator (não o mais popular)", r && r.title === "Interestelar", r && r.title);
  check("devolve a verificação do elenco", r && r.verificacao && r.verificacao.atoresNoElenco === 1 && r.verificacao.personagensNoElenco === 1, JSON.stringify(r && r.verificacao));
}
{
  const r = await ctx.nS("k", { titulo: "Duna", titulo_original: "Dune", ano: 2021, atores: ["Timothée Chalamet"], personagens: ["Paul"], alternativas: [] });
  check("remake: o ano e o elenco escolhem o Duna de 2021", r && r.year === "2021", r && r.year);
}
{
  const r = await ctx.nS("k", { titulo: "Duna", titulo_original: "Dune", ano: 1984, atores: [], personagens: [], alternativas: [] });
  check("sem atores, o ano decide (Duna de 1984)", r && r.year === "1984", r && r.year);
}
{
  const r = await ctx.nS("k", { titulo: "A Casa", titulo_original: "The House", ano: 2017, atores: ["Timothée Chalamet", "Rebecca Ferguson"], personagens: [], alternativas: [] });
  check("quando nenhum ator reconhecido está no elenco, a verificação mostra 0", r && r.verificacao && r.verificacao.atores === 2 && r.verificacao.atoresNoElenco === 0, JSON.stringify(r && r.verificacao));
}

console.log("\n2. Pistas, personagens e ganchos");
let resposta = "";
let prompt = "";
const ctx2 = vm.createContext({ console, JSON, Number, String, Array, Set, fg: (x) => (x ? String(x) : ""), cg: () => ({ mime_type: "image/jpeg", data: "x" }), ju: async (_k, partes) => { prompt = partes[0].text; return resposta; }, dg: async () => resposta, ug: async () => resposta, ft: class extends Error {} });
vm.runInContext(corta("async function Hm(", "async function Zb(") + ";" + corta("async function Zb(", "function eS(") + ";this.Hm=Hm;this.Zb=Zb;", ctx2);
{
  resposta = JSON.stringify({ personagens: ["Murph", "desconhecido"], atores: ["Matthew McConaughey"], titulo: "Interestelar", titulo_original: "Interstellar", ano: 2014, confianca: 93, ganchos: ["g"], alternativas: [] });
  const z = await ctx2.Zb("", ["m", "q"], "pt-BR", { fileName: "video.mp4", legendaPost: "cena top #interestelar", autorPost: "@cortes", geminiKey: "k" });
  check("a legenda do post vai como pista (que pode enganar)", /Legenda do post original \(perfil @cortes\): "cena top #interestelar"/.test(prompt) && /podem ajudar ou enganar/.test(prompt));
  check("pede e lê os personagens (sem «desconhecido»)", JSON.stringify(z.personagens) === '["Murph"]' && /"personagens"/.test(prompt));
  check("pede confiança honesta (palpite ≤ 55)", /no máximo 55/.test(prompt));
}
{
  resposta = JSON.stringify({ cena: "Um homem entra numa casa escura", ganchos: ["Que cena! 😳", "Ele abriu a porta errada na hora errada 😨", "3 dias depois ninguém sabia onde ele estava 😱", "#filme Ela sabia de tudo 👀", "Você precisa assistir esse filme 🔥", "O que você faria no lugar dele? 👀"], melhor: 2 });
  const g = await ctx2.Hm("", ["m", "q"], "pt-BR", { title: "Interestelar", year: "2014", genres: ["Ficção"], overview: "Exploradores." }, "k", null, { cena: "cena X", fala: "Murph!" });
  check("o gancho escolhido pela IA vem primeiro (sem perder o número)", g.ganchos[0] === "3 dias depois ninguém sabia onde ele estava 😱", g.ganchos[0]);
  check("tira os genéricos e as hashtags", !g.ganchos.some((x) => /Que cena|precisa assistir|#/.test(x)) && g.ganchos.includes("Ela sabia de tudo 👀"), JSON.stringify(g.ganchos));
  check("usa o filme, a sinopse e a fala como contexto (sem pôr o nome no gancho)", /Interestelar/.test(prompt) && /Exploradores/.test(prompt) && /Murph!/.test(prompt) && /NUNCA escreva o nome/.test(prompt));
  check("pt-BR natural", /Português do Brasil/.test(prompt));
}
{
  resposta = "nada de json\n1. Ele não devia ter atendido aquele telefone 😨\n2. Que cena! 🔥";
  const g = await ctx2.Hm("", ["m"], "pt-BR", "clip.mp4", "k", null);
  check("se a IA não devolver JSON, aproveita as linhas", g.ganchos[0] === "Ele não devia ter atendido aquele telefone 😨", JSON.stringify(g.ganchos));
}

{
  resposta = JSON.stringify({ analise: { momento: "ele abre a porta", emocao: "medo", gatilho: "o que há lá dentro?", visual: "porta vermelha" }, cena: "Ele abre uma porta", ganchos: [{ texto: "Ele abriu a porta errada 😨", nota: 6 }, { texto: "Havia algo atrás da porta vermelha 😱", nota: 9 }, { texto: "Ninguém devia ter ouvido isso 👀", nota: 7 }] });
  const g = await ctx2.Hm("", ["m", "q"], "pt-BR", { title: "X", year: "2020", genres: [], overview: "" }, "k", null, {});
  check("ganchos com nota: o de nota mais alta vem primeiro", g.ganchos[0] === "Havia algo atrás da porta vermelha 😱" && g.ganchos[1] === "Ninguém devia ter ouvido isso 👀", JSON.stringify(g.ganchos));
  check("devolve a análise da cena (momento, emoção, gatilho, visual)", g.analise && g.analise.emocao === "medo");
  check("o prompt pede a análise antes dos ganchos e notas rigorosas", /ANALISE ANTES DE ESCREVER/.test(prompt) && /"gatilho"/.test(prompt) && /seja rigoroso/.test(prompt));
}

console.log("\n3. Modelos do Gemini");
{
  const fonte = /const f=p=>\{\/\* ==CINECLIP-GEMINI-MODELOS==[\s\S]*?\};/.exec(s)[0];
  const f = vm.runInNewContext(fonte + ";f", {});
  const ordem = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-3.6-flash", "gemini-3.6-flash-lite", "gemini-3.6-pro", "gemini-3.6-flash-preview-09-2026", "gemini-2.5-pro"].sort((a, b) => f(b) - f(a));
  check("o flash mais recente primeiro", ordem[0] === "gemini-3.6-flash", ordem.join(" > "));
  check("versão nova antes da antiga", ordem.indexOf("gemini-3.6-flash-lite") < ordem.indexOf("gemini-2.5-flash"), ordem.join(" > "));
}

console.log("\n4. Identificar direto pelo nome (sem IA)");
{
  const fonte = corta("function fg(", "async function Hm(") + ";" + corta("async function cineclipPorNome(", "function fg(");
  vm.runInContext(fonte + ";this.fg=fg;this.cineclipPorNome=cineclipPorNome;", ctx);
  const por = (o) => ctx.cineclipPorNome("k", o);
  let r = await por({ userHint: "Interestelar" });
  check("dica com o nome do filme → TMDB direto", r && r.title === "Interestelar" && r.verificacao.porNome === true, r && r.title);
  r = await por({ fileName: "Interstellar 2014.mp4" });
  check("nome do ficheiro com título e ano → direto", r && r.title === "Interestelar", r && r.title);
  r = await por({ fileName: "Duna 1984.mp4" });
  check("o ano do nome escolhe a versão certa (1984, não a mais popular)", r && String(r.year) === "1984", JSON.stringify(r && { t: r.title, y: r.year, id: r.id }));
  r = await por({ fileName: "VID_20240101.mp4" });
  check("nome sem título (VID_…) → não adivinha", r === null);
  r = await por({ userHint: "Matthew McConaughey" });
  check("dica que é nome de ator → não força um filme (a IA decide)", r === null);
  r = await por({ fileName: "interestelar_cena.mp4" });
  check("ignora palavras soltas como «cena» no nome do ficheiro", r && r.title === "Interestelar", r && r.title);
}

console.log("\n─────────────────────────────────────────────");
if (fail) { console.log(`❌ ${pass} passaram, ${fail} falharam:`); falhas.forEach((f) => console.log("   • " + f)); process.exit(1); }
console.log(`✅ ${pass} passaram, 0 falharam`);
