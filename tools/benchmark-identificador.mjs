#!/usr/bin/env node
/**
 * Benchmark do identificador: implementação antiga vs. nova.
 *
 *   node tools/benchmark-identificador.mjs
 *   BENCH_LATENCIA=200 node tools/benchmark-identificador.mjs   # rede mais lenta
 *
 * O bundle continua a guardar a implementação antiga (com o sufixo "Legado",
 * usada como fallback), por isso este script corre as DUAS lado a lado contra
 * o mesmo TMDB simulado — com a mesma latência artificial por pedido — e
 * compara:
 *
 *   • pedidos ao TMDB
 *   • tempo total
 *   • o resultado (tem de ser o mesmo filme nos dois)
 *   • o custo de identificar o mesmo filme outra vez (cache)
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

/** Latência artificial por pedido (o que domina a perceção em mobile). */
const LATENCIA = Number(process.env.BENCH_LATENCIA || 80);

/* ------------------------------------------------------------- catálogo TMDB */

const FILMES = [
  ["Duna: Parte Dois", "Dune: Part Two", "2024-02-27", 158.4, "tt15239678"],
  ["Duna", "Dune", "2021-09-15", 141.2, "tt1160419"],
  ["Duna", "Dune", "1984-12-13", 42.1, "tt0087182"],
  ["Oppenheimer", "Oppenheimer", "2023-07-19", 121.7, "tt15398776"],
  ["O Iluminado", "The Shining", "1980-05-23", 88.3, "tt0086759"],
  ["Batman", "Batman", "1989-06-23", 96.5, "tt0096165"],
  ["Matrix", "The Matrix", "1999-03-30", 112.9, "tt0133093"],
  ["A Origem", "Inception", "2010-07-15", 134.2, "tt1375666"],
  ["Interstellar", "Interstellar", "2014-11-05", 118.6, "tt0816692"],
  ["Tenet", "Tenet", "2020-08-26", 97.4, "tt15398776x"],
  ["Blade Runner 2049", "Blade Runner 2049", "2017-10-04", 89.1, "tt1856101"],
  ["Alien", "Alien", "1979-05-25", 71.8, "tt0078748"],
  ["O Exorcista", "The Exorcist", "1973-12-26", 54.3, "tt0070043"],
  ["Psicose", "Vertigo", "1958-07-16", 42.9, "tt0052357"],
  ["2001: Uma Odisseia no Espaço", "2001: A Space Odyssey", "1968-04-02", 61.7, "tt0062622"],
  ["A Arrancada", "Chinatown", "1974-08-16", 38.2, "tt0071206"],
  ["O Irlandês", "The Irishman", "2019-11-01", 79.5, "tt7280898"],
  ["Cidade de Deus", "City of God", "2002-08-30", 64.3, "tt0312852"],
  ["Bacurau", "Bacurau", "2019-08-23", 58.9, "tt8443356"],
  ["Rashomon", "Rashomon", "1950-08-25", 36.4, "tt0042546"],
];

const SERIES = [
  ["Breaking Bad", "Breaking Bad", "2008-01-20", 312.4, "tt0903747"],
  ["Melhor齐 Ligar", "Better Call Saul", "2015-02-08", 187.3, "tt3032476"],
  ["Chernobyl", "Chernobyl", "2019-05-06", 154.8, "tt7366338"],
  ["Succession", "Succession", "2018-06-03", 132.1, "tt7660850"],
  ["The Last of Us", "The Last of Us", "2023-01-15", 201.5, "tt3581920"],
  ["Shōgun", "Shōgun", "2024-02-27", 118.7, "tt12365286"],
  ["The Bear", "The Bear", "2022-06-23", 96.2, "tt14452776"],
  ["Severance", "Severance", "2022-02-18", 88.4, "tt11280740"],
];

const PESSOAS = [
  ["Timothée Chalamet", 1001],
  ["Zendaya", 1002],
  ["Christopher Nolan", 1003],
  ["Jack Nicholson", 1004],
  ["Michael Keaton", 1005],
  ["Bryan Cranston", 1006],
];

function normalizar(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const CATALOGO = {
  filmes: FILMES.map(([title, original, date, pop, imdb], i) => ({
    id: 100 + i,
    kind: "movie",
    title,
    original_title: original,
    release_date: date,
    popularity: pop,
    overview: `Sinopse de ${title}.`,
    poster_path: `/p${100 + i}.jpg`,
    genres: [{ name: "Drama" }],
    imdb,
  })),
  series: SERIES.map(([title, original, date, pop, imdb], i) => ({
    id: 200 + i,
    kind: "tv",
    name: title,
    original_name: original,
    first_air_date: date,
    popularity: pop,
    overview: `Sinopse de ${title}.`,
    poster_path: `/p${200 + i}.jpg`,
    genres: [{ name: "Drama" }],
    imdb,
  })),
};
CATALOGO.todos = [...CATALOGO.filmes, ...CATALOGO.series];

/* ----------------------------------------------- Wikidata / TVmaze simulados */

/* As fontes externas são simuladas a partir do mesmo catálogo: o Wikidata
 * "sabe" o ano e o ID do IMDb/TMDB de cada obra, e a TVmaze sabe as séries.
 * É o cenário real: a confirmação responde à mesma velocidade da rede. */

const WIKIDATA_BUSCA = new Map();
const WIKIDATA_CLAIMS = new Map();
CATALOGO.todos.forEach((m) => {
  const original = m.original_title || m.original_name;
  const pt = m.title || m.name;
  const ano = (m.release_date || m.first_air_date || "").slice(0, 4);
  const id = "Q" + m.id;
  WIKIDATA_BUSCA.set(normalizar(original), {
    id,
    label: original,
    description: `${ano} ${m.kind === "movie" ? "film" : "television series"}`,
    aliases: [pt],
  });
  const claims = { P345: [{ mainsnak: { datavalue: { value: m.imdb } } }] };
  claims[m.kind === "movie" ? "P4947" : "P4983"] = [{ mainsnak: { datavalue: { value: m.id } } }];
  WIKIDATA_CLAIMS.set(id, claims);
});

const TVMAZE = new Map();
CATALOGO.series.forEach((m) => {
  TVMAZE.set(m.imdb, {
    id: m.id,
    name: m.name,
    premiered: m.first_air_date,
    rating: { average: Math.round((6 + (m.popularity % 300) / 100) * 10) / 10 },
    externals: { imdb: m.imdb },
  });
});

/* ------------------------------------------------------------ TMDB simulado */

/** Cria um fetch falso: conta pedidos e simula a latência da rede. */
function criarFetch(contador) {
  return async (url) => {
    const u = new URL(url);

    /* Fontes externas (confirmação independente). */
    if (u.hostname === "www.wikidata.org") {
      const acao = u.searchParams.get("action");
      contador.requests.push("wikidata:" + acao);
      await new Promise((r) => setTimeout(r, LATENCIA));
      if (acao === "wbsearchentities") {
        const termo = normalizar(u.searchParams.get("search"));
        const achado = WIKIDATA_BUSCA.get(termo);
        return { ok: true, status: 200, json: async () => ({ search: achado ? [achado] : [] }) };
      }
      if (acao === "wbgetentities") {
        const ids = (u.searchParams.get("ids") || "").split("|");
        const entities = {};
        ids.forEach((id) => {
          if (WIKIDATA_CLAIMS.has(id)) entities[id] = { claims: WIKIDATA_CLAIMS.get(id) };
        });
        return { ok: true, status: 200, json: async () => ({ entities }) };
      }
      return { ok: false, status: 400, json: async () => ({}) };
    }
    if (u.hostname === "api.tvmaze.com") {
      const imdb = u.searchParams.get("imdb") || "";
      contador.requests.push("tvmaze:" + imdb);
      await new Promise((r) => setTimeout(r, LATENCIA));
      const show = TVMAZE.get(imdb);
      if (!show) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => show };
    }

    const caminho = u.pathname.replace(/^\/3/, "");
    contador.requests.push(caminho + u.search);
    await new Promise((r) => setTimeout(r, LATENCIA));

    if (caminho === "/search/movie" || caminho === "/search/tv") {
      const tipo = caminho.includes("/movie") ? "filmes" : "series";
      const consulta = normalizar(u.searchParams.get("query"));
      const resultados = CATALOGO[tipo].filter((m) => {
        const nomes = [m.title || m.name, m.original_title || m.original_name].map(normalizar);
        return nomes.some((n) => n === consulta || n.includes(consulta) || consulta.includes(n));
      });
      return { ok: true, status: 200, json: async () => ({ results: resultados }) };
    }
    if (caminho === "/search/person") {
      const consulta = normalizar(u.searchParams.get("query"));
      const results = PESSOAS.filter((p) => normalizar(p[0]).includes(consulta)).map(([name, id]) => ({ id, name }));
      return { ok: true, status: 200, json: async () => ({ results }) };
    }
    if (caminho.startsWith("/person/")) {
      const id = Number(caminho.split("/")[2]);
      const pessoa = PESSOAS.find((p) => p[1] === id);
      const cast = (pessoa ? CATALOGO.todos : []).slice(0, 6).map((m) => ({
        ...m,
        media_type: m.kind,
        vote_count: 500 - Number(m.id) % 300,
      }));
      return { ok: true, status: 200, json: async () => ({ cast }) };
    }
    if (caminho.startsWith("/find/")) {
      const imdb = decodeURIComponent(caminho.split("/")[2]).toLowerCase();
      const movie = CATALOGO.filmes.find((m) => m.imdb === imdb);
      const tv = CATALOGO.series.find((m) => m.imdb === imdb);
      return {
        ok: true,
        status: 200,
        json: async () => ({ movie_results: movie ? [movie] : [], tv_results: tv ? [tv] : [] }),
      };
    }
    const detalhe = caminho.match(/^\/(movie|tv)\/(\d+)$/);
    if (detalhe) {
      const item = CATALOGO.todos.find((m) => String(m.id) === detalhe[2]);
      if (!item) return { ok: false, status: 404, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ ...item, external_ids: { imdb_id: item.imdb } }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

/* ------------------------------------------- a implementação antiga (bundle) */

/** Extrai uma função do bundle pelas chavetas. */
function extrair(assinatura) {
  const inicio = html.indexOf(assinatura);
  if (inicio < 0) throw new Error(`bundle: não encontrei ${assinatura}`);
  const chave = html.indexOf("{", html.indexOf(")", inicio));
  let profundidade = 0;
  let i = chave;
  for (; i < html.length; i++) {
    if (html[i] === "{") profundidade++;
    else if (html[i] === "}") {
      profundidade--;
      if (profundidade === 0) break;
    }
  }
  return html.slice(inicio, i + 1);
}

/**
 * A implementação antiga, tal como estava antes: as funções "Legado" do
 * bundle, renomeadas para se chamarem entre si como antes.
 */
function codigoAntigo() {
  const legadas = [
    extrair("async function RuLegado("),
    extrair("async function mgLegado("),
    extrair("async function pgLegado("),
    extrair("async function nSLegado("),
  ].join("\n");
  return (
    extrair("function eS(") +
    "\n" +
    extrair("function Si(") +
    "\n" +
    extrair("async function vo(") +
    "\n" +
    extrair("function fi(") +
    "\n" +
    legadas
      .replace("RuLegado(", "Ru(")
      .replace("mgLegado(", "mg(")
      .replace("pgLegado(", "pg(")
      .replace("nSLegado(", "nS(")
  );
}

function ambienteAntigo(contador) {
  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    qb: "https://api.themoviedb.org/3",
    Promise,
    Map,
    Set,
    Math,
    JSON,
    Date,
    Number,
    String,
    Array,
    Object,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    ft: class extends Error {},
    /* Ka: o fetch do bundle, com a latência simulada */
    Ka: async (nome, endereco, init) => {
      const res = await contador.fetch(endereco, init);
      if (!res.ok) throw new Error("TMDB " + res.status);
      return res;
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(codigoAntigo(), sandbox, { filename: "bundle-antigo.js" });
  return sandbox;
}

function ambienteNovo(contador) {
  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    fetch: contador.fetch,
    AbortController,
    URL,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    JSON,
    Promise,
    Map,
    Set,
    sessionStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "confirmacao-externa.js"), "utf8"), sandbox, {
    filename: "confirmacao-externa.js",
  });
  vm.runInContext(fs.readFileSync(path.join(root, "identificador-rapido.js"), "utf8"), sandbox, {
    filename: "identificador-rapido.js",
  });
  return sandbox;
}

/* ------------------------------------------------------------------ ensaios */

const CASOS = [
  {
    nome: "A IA acertou o título (caso comum)",
    ia: {
      titulo: "Duna: Parte Dois",
      titulo_original: "Dune: Part Two",
      ano: 2024,
      tipo: "movie",
      confianca: 94,
      atores: ["Timothée Chalamet", "Zendaya"],
      alternativas: [
        { titulo: "Duna", titulo_original: "Dune", ano: 2021 },
        { titulo: "Interstellar", titulo_original: "Interstellar", ano: 2014 },
      ],
    },
  },
  {
    nome: "A IA só sabe o título em português",
    ia: {
      titulo: "A Origem",
      titulo_original: "",
      ano: 2010,
      tipo: "movie",
      confianca: 80,
      atores: ["Leonardo DiCaprio"],
    },
  },
  {
    nome: "A IA errou o título mas acertou os atores",
    ia: {
      titulo: "Um Filme Que Não Existe",
      titulo_original: "Not A Real Movie",
      ano: 1989,
      tipo: "movie",
      confianca: 55,
      atores: ["Jack Nicholson", "Michael Keaton"],
    },
  },
];

const linha = (t) => console.log(t);

async function medir(rotulo, exec) {
  const contador = { requests: [], fetch: null };
  contador.fetch = criarFetch(contador);
  const inicio = Date.now();
  const resultado = await exec(contador);
  const ms = Date.now() - inicio;
  const externos = contador.requests.filter((r) => r.startsWith("wikidata:") || r.startsWith("tvmaze:")).length;
  return {
    rotulo,
    ms,
    pedidos: contador.requests.length,
    externos,
    resultado,
    requests: contador.requests,
  };
}

console.log(`\n🎞️  Benchmark do identificador (latência simulada: ${LATENCIA} ms por pedido)\n`);

for (const caso of CASOS) {
  console.log(`── ${caso.nome}`);
  const antiga = await medir("antiga", async (c) => {
    const amb = ambienteAntigo(c);
    return amb.nS("chave-de-teste", caso.ia);
  });
  const nova = await medir("nova", async (c) => {
    const amb = ambienteNovo(c);
    return amb.CineIdentificador.procurar("chave-de-teste", caso.ia);
  });

  const idAntigo = antiga.resultado ? `${antiga.resultado.kind}:${antiga.resultado.id}` : "nada";
  const idNovo = nova.resultado ? `${nova.resultado.kind}:${nova.resultado.id}` : "nada";

  linha(`   antiga: ${String(antiga.pedidos).padStart(3)} pedidos · ${String(antiga.ms).padStart(5)} ms · ${idAntigo}`);
  const externa = nova.externos ? ` (${nova.pedidos - nova.externos} ao TMDB + ${nova.externos} a fontes externas)` : "";
  linha(`   nova  : ${String(nova.pedidos).padStart(3)} pedidos${externa} · ${String(nova.ms).padStart(5)} ms · ${idNovo}`);
  const selo = nova.resultado && nova.resultado.confirmacao ? ` · confirmado (${nova.resultado.confirmacao.fonte})` : "";
  linha(`   → selo externo${selo}`);
  const mesma = idAntigo === idNovo ? "mesmo filme ✔" : "filme diferente ✘";
  linha(`   → ${mesma} · ${Math.round((antiga.ms / Math.max(nova.ms, 1)) * 10) / 10}× mais rápido`);
  linha("");
}

/* ------------------------------------ o mesmo filme outra vez (cache + lote) */

console.log("── O mesmo filme identificado outra vez (o que acontece num lote)");
{
  const contador = { requests: [], fetch: null };
  contador.fetch = criarFetch(contador);
  const amb = ambienteNovo(contador);
  const ia = CASOS[0].ia;
  const t1 = Date.now();
  await amb.CineIdentificador.procurar("chave-de-teste", ia);
  const primeiro = { ms: Date.now() - t1, pedidos: contador.requests.length };
  const t2 = Date.now();
  await amb.CineIdentificador.procurar("chave-de-teste", ia);
  const segundo = { ms: Date.now() - t2, pedidos: contador.requests.length - primeiro.pedidos };
  linha(`   1.ª vez: ${primeiro.pedidos} pedidos · ${primeiro.ms} ms`);
  linha(`   2.ª vez: ${segundo.pedidos} pedidos · ${segundo.ms} ms  (cache)`);

  const contadorAntigo = { requests: [], fetch: null };
  contadorAntigo.fetch = criarFetch(contadorAntigo);
  const ambAntigo = ambienteAntigo(contadorAntigo);
  const t3 = Date.now();
  await ambAntigo.nS("chave-de-teste", ia);
  const p1 = { ms: Date.now() - t3, pedidos: contadorAntigo.requests.length };
  const t4 = Date.now();
  await ambAntigo.nS("chave-de-teste", ia);
  const p2 = { ms: Date.now() - t4, pedidos: contadorAntigo.requests.length - p1.pedidos };
  linha(`   (a antiga) 1.ª vez: ${p1.pedidos} pedidos · ${p1.ms} ms`);
  linha(`   (a antiga) 2.ª vez: ${p2.pedidos} pedidos · ${p2.ms} ms  (sem cache)`);
}

console.log("\n💡 O número de pedidos é o que pesa: o browser só abre 6 ligações por\n");
console.log("   host, o TMDB tem limite de pedidos e cada um gasta dados móveis.\n");
