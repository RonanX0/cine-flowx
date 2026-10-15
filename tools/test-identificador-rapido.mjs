#!/usr/bin/env node
/**
 * Testes do Identificador Rápido (CineClip)
 *
 * O TMDB é simulado — nenhuma ida à Internet. Valida:
 *
 *  1. Normalização de títulos, algarismos romanos e variantes de pesquisa
 *  2. Limpeza de nomes de atores
 *  3. Pontuação e desempate (a mesma do bundle, para não perder precisão)
 *  4. Regra de confiança: só se para a pesquisa com título + tipo + ano
 *  5. Caminho rápido: 2 pedidos de pesquisa + 1 de detalhes (e nada de atores)
 *  6. Caminho IMDb: 1 pedido (/find) + 1 de detalhes
 *  7. Cache: a segunda pesquisa do mesmo título não vai à rede
 *  8. Atores como último recurso (quando o título da IA está errado)
 *  9. Remake: o ano certo ganha ao título igual de outro ano
 * 10. Robustez: erro de rede / resposta inválida não rebenta a identificação
 * 11. Ligação ao bundle: o bundle delega no módulo e carrega-o
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const modPath = path.join(root, "identificador-rapido.js");
const confPath = path.join(root, "confirmacao-externa.js");

let total = 0;
const check = (desc, cond, extra = "") => {
  total++;
  assert.ok(cond, `${desc} ${extra ? `(${extra})` : ""}`);
  console.log(`   ✔ ${desc}`);
};

console.log("\n🎬 Testes do Identificador Rápido\n");

/* ----------------------------------------------------------- TMDB simulado */

const CATALOGO = {
  movie: [
    { id: 694, title: "O Iluminado", original_title: "The Shining", release_date: "1980-05-23", popularity: 80, overview: "Um hotel隔离…", poster_path: "/iluminado.jpg", genres: [{ name: "Terror" }, { name: "Drama" }] },
    { id: 268, title: "Batman", original_title: "Batman", release_date: "1989-06-23", popularity: 200, overview: " Gotham.", poster_path: "/batman.jpg", genres: [{ name: "Ação" }] },
    { id: 2, title: "Duna", original_title: "Dune", release_date: "2021-09-15", popularity: 150, overview: "Paul Atreides.", poster_path: "/duna.jpg", genres: [{ name: "Ficção" }] },
    { id: 1, title: "Duna", original_title: "Dune", release_date: "1984-12-13", popularity: 40, overview: "Dune de 1984.", poster_path: "/duna84.jpg", genres: [{ name: "Ficção" }] },
    { id: 438631, title: "Duna: Parte Dois", original_title: "Dune: Part Two", release_date: "2024-02-27", popularity: 160, overview: "Paul Atreides parte dois.", poster_path: "/duna2.jpg", genres: [{ name: "Ficção" }] },
  ],
  tv: [
    { id: 1396, title: "Breaking Bad", original_name: "Breaking Bad", first_air_date: "2008-01-20", popularity: 300, overview: "Walter White.", poster_path: "/bb.jpg", genres: [{ name: "Drama" }] },
  ],
};

const PESSOAS = [
  { id: 51, name: "Jack Nicholson" },
  { id: 7467, name: "Michael Keaton" },
];

const CREDITOS = {
  51: [
    { media_type: "movie", id: 694, title: "O Iluminado", original_title: "The Shining", release_date: "1980-05-23", vote_count: 900 },
    { media_type: "movie", id: 268, title: "Batman", original_title: "Batman", release_date: "1989-06-23", vote_count: 800 },
  ],
  7467: [
    { media_type: "movie", id: 268, title: "Batman", original_title: "Batman", release_date: "1989-06-23", vote_count: 800 },
  ],
};

const EXTERNOS = { 694: "tt0086759", 268: "tt0096165", 2: "tt1160419", 1: "tt0087182", 438631: "tt15239678", 1396: "tt0903747" };

/* ------------------------------------------------ Wikidata / TVmaze simulados */

const WIKIDATA = {
  busca: {
    "the shining": [
      { id: "Q219356", label: "The Shining", description: "1980 American supernatural horror film directed by Stanley Kubrick", aliases: ["The Shining"] },
    ],
    dune: [
      { id: "Q130232", label: "Dune", description: "1984 American epic science fiction film directed by David Lynch", aliases: [] },
    ],
    "dune part two": [
      { id: "Q109228991", label: "Dune: Part Two", description: "2024 film directed by Denis Villeneuve", aliases: ["Dune Part Two"] },
    ],
    "breaking bad": [
      { id: "Q1079", label: "Breaking Bad", description: "American crime drama television series (2008-2013)", aliases: [] },
    ],
    "sinal de fogo": [
      { id: "Q555", label: "Fogo Florestal", description: "1995 film", aliases: [] },
    ],
    "eternal sunshine": [
      { id: "Q100000", label: "Eternal Sunshine of the Spotless Mind", description: "2004 American romantic science fiction film", aliases: ["Eternal Sunshine"] },
    ],
  },
  claims: {
    Q219356: { P345: [{ mainsnak: { datavalue: { value: "tt0086759" } } }] },
    Q130232: { P345: [{ mainsnak: { datavalue: { value: "tt0087182" } } }] },
    Q109228991: {
      P345: [{ mainsnak: { datavalue: { value: "tt15239678" } } }],
      P4947: [{ mainsnak: { datavalue: { value: 438631 } } }],
    },
    Q1079: {
      P345: [{ mainsnak: { datavalue: { value: "tt0903747" } } }],
      P4983: [{ mainsnak: { datavalue: { value: 1396 } } }],
    },
    Q100000: { P345: [{ mainsnak: { datavalue: { value: "tt0086759" } } }] },
  },
};

const TVMAZE = {
  tt0903747: {
    id: 169,
    name: "Breaking Bad",
    premiered: "2008-01-20",
    rating: { average: 9.2 },
    externals: { imdb: "tt0903747" },
  },
};

function normalizar(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\bii\b/g, "2")
    .replace(/\biii\b/g, "3")
    .replace(/\biv\b/g, "4")
    .replace(/\bv\b/g, "5")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Cria uma instalação isolada do módulo com um fetch simulado. */
function instalar(opcoes = {}) {
  const pedidos = [];
  const armazenamento = new Map();

  const fakeFetch = async (url) => {
    const u = new URL(url);

    /* --- Wikidata (confirmação independente + ponte para o TMDB) --- */
    if (u.hostname === "www.wikidata.org") {
      const acao = u.searchParams.get("action");
      pedidos.push("wikidata:" + acao);
      if (opcoes.falharExternas) throw new Error("wikidata em baixo");
      if (acao === "wbsearchentities") {
        const termo = normalizar(u.searchParams.get("search"));
        const achados = WIKIDATA.busca[termo] || [];
        return { ok: true, status: 200, json: async () => ({ search: achados }) };
      }
      if (acao === "wbgetentities") {
        const ids = (u.searchParams.get("ids") || "").split("|");
        const entities = {};
        ids.forEach((id) => {
          if (WIKIDATA.claims[id]) entities[id] = { claims: WIKIDATA.claims[id] };
        });
        return { ok: true, status: 200, json: async () => ({ entities }) };
      }
      return { ok: false, status: 400, json: async () => ({}) };
    }

    /* --- TVmaze (séries) --- */
    if (u.hostname === "api.tvmaze.com") {
      const imdb = u.searchParams.get("imdb") || "";
      pedidos.push("tvmaze:" + imdb);
      if (opcoes.falharExternas) throw new Error("tvmaze em baixo");
      const show = TVMAZE[imdb];
      if (!show) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => show };
    }

    /* A API real é https://api.themoviedb.org/3/... — o prefixo "/3" não faz
       parte do caminho do recurso. */
    const caminho = u.pathname.replace(/^\/3/, "");
    pedidos.push(caminho + u.search);
    if (opcoes.falhar) throw new Error("rede em baixo");

    if (caminho.startsWith("/search/movie") || caminho.startsWith("/search/tv")) {
      const tipo = caminho.includes("/movie") ? "movie" : "tv";
      const consulta = normalizar(u.searchParams.get("query"));
      const resultados = CATALOGO[tipo].filter((m) => {
        if (opcoes.esconder && opcoes.esconder.includes(String(m.id))) return false;
        const nomes = [m.title, m.original_title || m.original_name].map(normalizar);
        return nomes.some((n) => n === consulta || n.includes(consulta) || consulta.includes(n));
      });
      return { ok: true, status: 200, json: async () => ({ results: resultados }) };
    }
    if (caminho.startsWith("/search/person")) {
      const consulta = normalizar(u.searchParams.get("query"));
      const results = PESSOAS.filter((p) => normalizar(p.name).includes(consulta));
      return { ok: true, status: 200, json: async () => ({ results }) };
    }
    if (caminho.startsWith("/person/")) {
      const id = caminho.split("/")[2];
      return { ok: true, status: 200, json: async () => ({ cast: CREDITOS[id] || [] }) };
    }
    if (caminho.startsWith("/find/")) {
      const imdb = decodeURIComponent(caminho.split("/")[2]).toLowerCase();
      const achado = Object.entries(EXTERNOS).find(([, v]) => v === imdb);
      if (!achado) return { ok: false, status: 404, json: async () => ({}) };
      const [id] = achado;
      const movie = CATALOGO.movie.find((m) => String(m.id) === id);
      const tv = CATALOGO.tv.find((m) => String(m.id) === id);
      return {
        ok: true,
        status: 200,
        json: async () => ({ movie_results: movie ? [movie] : [], tv_results: tv ? [tv] : [] }),
      };
    }
    const detalhes = caminho.match(/^\/(movie|tv)\/(\d+)$/);
    if (detalhes) {
      const [, tipo, id] = detalhes;
      const lista = tipo === "movie" ? CATALOGO.movie : CATALOGO.tv;
      const item = lista.find((m) => String(m.id) === id);
      if (!item) return { ok: false, status: 404, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ ...item, external_ids: { imdb_id: EXTERNOS[id] } }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const sandbox = {
    console,
    fetch: fakeFetch,
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
      getItem: (k) => (armazenamento.has(k) ? armazenamento.get(k) : null),
      setItem: (k, v) => armazenamento.set(k, String(v)),
      removeItem: (k) => armazenamento.delete(k),
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(confPath, "utf8"), sandbox, { filename: "confirmacao-externa.js" });
  vm.runInContext(fs.readFileSync(modPath, "utf8"), sandbox, { filename: "identificador-rapido.js" });
  return {
    ident: sandbox.CineIdentificador,
    confirmacao: sandbox.CineConfirmacao,
    pedidos,
    armazenamento,
  };
}

/* ------------------------------------------------- 1. normalização / variantes */

console.log("1. Normalização e variantes de pesquisa");
{
  const { ident } = instalar();
  const n = ident._internas.normalizar;
  check("remove acentos e pontuação", n("Bastardos Ingl\u00f3rios!") === "bastardos inglorios");
  check("algarismos romanos convertidos", n("Gladiador II") === n("Gladiador 2"));
  check("ignora maiúsculas e espaços", n("  O   PODEROSO    CHEFÃO  ") === "o poderoso chefao");

  const v = ident._internas.variantes;
  check("remove o ano entre parênteses", v("Interestelar (2014)").includes("Interestelar"));
  check("separa a base do subtítulo", v("Duna: Parte 2").includes("Duna"));
  check("não repete variantes iguais", new Set(v("Duna")).size === v("Duna").length);
  check("ignora títulos vazios", v("").length === 0);

  const ator = ident._internas.limparAtor;
  check("remove o papel do ator", ator("Cillian Murphy as Tommy Shelby") === "Cillian Murphy");
  check("remove o personagem entre parênteses", ator("Bryan Cranston (Walter White)") === "Bryan Cranston");

  check("aceita IMDb ID em qualquer formato", ident._internas.normalizarImdb("IMDb: tt0086759") === "tt0086759");
  check("rejeita IMDb ID inventado", ident._internas.normalizarImdb("tt12") === "");
}

/* --------------------------------------------------------- 2. pontuação */

console.log("\n2. Pontuação (mesma do bundle)");
{
  const { ident } = instalar();
  const p = ident._internas.pontuar;
  const ia = { titulo: "O Iluminado", titulo_original: "The Shining", ano: 1980, tipo: "movie" };
  const shining = { id: 694, kind: "movie", title: "O Iluminado", original: "The Shining", year: "1980", popularity: 80 };
  const batman = { id: 268, kind: "movie", title: "Batman", original: "Batman", year: "1989", popularity: 200 };
  check("o filme com o título certo ganha ao popular do ator", p(shining, ia) > p(batman, ia) + 100, `${p(shining, ia)} vs ${p(batman, ia)}`);
  check("filme sem correspondência de título fica abaixo de 25 pontos", p(batman, ia) < 25);

  const duna2021 = { id: 2, kind: "movie", title: "Duna", original: "Dune", year: "2021", popularity: 150 };
  const duna1984 = { id: 1, kind: "movie", title: "Duna", original: "Dune", year: "1984", popularity: 40 };
  const iaDuna = { titulo: "Duna", ano: 2021, tipo: "movie" };
  check("o remake do ano certo ganha ao antigo", p(duna2021, iaDuna) > p(duna1984, iaDuna) + 40);

  const comAtores = new Map([["movie-694", 2]]);
  check("dois atores confirmam a obra", p(shining, ia, comAtores) > p(shining, ia) + 40);
}

/* ---------------------------------------------------- 3. regra de confiança */

console.log("\n3. Regra de confiança (quando se pode parar a pesquisa)");
{
  const { ident } = instalar();
  const c = ident._internas.confiante;
  const bom = { id: 694, kind: "movie", title: "O Iluminado", original: "The Shining", year: "1980" };
  check("título + tipo + ano certainos → confiante", c(bom, { titulo: "O Iluminado", titulo_original: "The Shining", ano: 1980, tipo: "movie" }));
  check("ano muito diferente → não confiante", !c(bom, { titulo: "O Iluminado", titulo_original: "The Shining", ano: 1990, tipo: "movie" }));
  check("tipo diferente → não confiante", !c(bom, { titulo: "O Iluminado", titulo_original: "The Shining", ano: 1980, tipo: "tv" }));
  check("título diferente → não confiante", !c(bom, { titulo: "Batman", titulo_original: "Batman", ano: 1980, tipo: "movie" }));
}

/* -------------------------------------------------------- 4. caminho rápido */

console.log("\n4. Caminho rápido (2 pedidos de pesquisa + 1 de detalhes)");
{
  const { ident, pedidos } = instalar();
  const resultado = await ident.procurar("chave-de-teste", {
    titulo: "O Iluminado",
    titulo_original: "The Shining",
    ano: 1980,
    tipo: "movie",
    confianca: 92,
  });
  const pesquisas = pedidos.filter((p) => p.startsWith("/search/"));
  check("encontrou o filme certo", resultado && resultado.id === 694 && resultado.kind === "movie", JSON.stringify(resultado));
  check("devolve o título em português", resultado.title === "O Iluminado");
  check("guarda o ID canónico do TMDB", resultado.tmdbId === "movie:694");
  check("guarda o ID do IMDb", resultado.imdbId === "tt0086759");
  check("guarda a chave estável", resultado.chave === "movie-694");
  check("traz o póster", resultado.poster === "https://image.tmdb.org/t/p/w342/iluminado.jpg");
  check("traz os géneros", Array.isArray(resultado.genres) && resultado.genres.includes("Terror"));
  check("faz só 2 pesquisas (filme + série)", pesquisas.length === 2, pesquisas.join(" | "));
  check("não procura atores no caminho rápido", !pedidos.some((p) => p.startsWith("/search/person")));
  check("pede os detalhes uma vez", pedidos.filter((p) => p.startsWith("/movie/694")).length === 1);
}

/* ------------------------------------------------------- 5. caminho IMDb */

console.log("\n5. Caminho IMDb (1 pedido /find + 1 de detalhes)");
{
  const { ident, pedidos } = instalar();
  const resultado = await ident.procurar("chave-de-teste", {
    titulo: "O Iluminado",
    titulo_original: "The Shining",
    ano: 1980,
    tipo: "movie",
    imdb_id: "tt0086759",
  });
  check("resolve pelo IMDb ID", resultado && resultado.id === 694);
  check("faz só 1 pesquisa", pedidos.filter((p) => p.startsWith("/search/")).length === 0);
  check("usa /find com external_source", pedidos.some((p) => p.startsWith("/find/tt0086759") && p.includes("external_source=imdb_id")));
  check("mantém o IMDb ID no resultado", resultado.imdbId === "tt0086759");
}

/* ------------------------------------------------------------- 6. cache */

console.log("\n6. Cache (o mesmo título não vai duas vezes à rede)");
{
  const { ident, pedidos } = instalar();
  await ident.buscar("chave-de-teste", "O Iluminado");
  const depoisDaPrimeira = pedidos.length;
  await ident.buscar("chave-de-teste", "O Iluminado");
  check("a segunda pesquisa não gera pedidos", pedidos.length === depoisDaPrimeira, `${depoisDaPrimeira} -> ${pedidos.length}`);
  check("a primeira pesquisa fez 2 pedidos", depoisDaPrimeira === 2);
}

/* ------------------------------------------------- 7. atores (último recurso) */

console.log("\n7. Atores como último recurso");
{
  const { ident, pedidos } = instalar();
  const resultado = await ident.procurar("chave-de-teste", {
    titulo: "Um Título Que Não Existe",
    titulo_original: "Not A Real Movie",
    tipo: "movie",
    atores: ["Jack Nicholson", "Michael Keaton"],
  });
  check("a pesquisa por atores é usada", pedidos.some((p) => p.startsWith("/search/person")));
  check(
    "devolve o filme partilhado pelos dois atores",
    resultado && resultado.id === 268,
    JSON.stringify(resultado && resultado.id)
  );
}

/* A IA pode não saber o título (só os atores) — e um título único, sem
   variantes, não pode ficar sem tentar os atores. */
{
  const { ident } = instalar();
  const soAtores = await ident.procurar("chave-de-teste", {
    tipo: "movie",
    atores: ["Jack Nicholson", "Michael Keaton"],
  });
  check("sem título, os atores são o único caminho", soAtores && soAtores.id === 268, JSON.stringify(soAtores && soAtores.id));

  const tituloUnico = await ident.procurar("chave-de-teste", {
    titulo_original: "Not A Real Movie",
    tipo: "movie",
    atores: ["Jack Nicholson", "Michael Keaton"],
  });
  check(
    "um título só, sem variantes, ainda tenta os atores",
    tituloUnico && tituloUnico.id === 268,
    JSON.stringify(tituloUnico && tituloUnico.id)
  );
}

/* -------------------------------------------------------- 8. remake/ano */

console.log("\n8. Remake: o ano certo vence");
{
  const { ident } = instalar();
  const resultado = await ident.procurar("chave-de-teste", {
    titulo: "Duna",
    titulo_original: "Dune",
    ano: 2021,
    tipo: "movie",
  });
  check("escolhe a versão de 2021 e não a de 1984", resultado && resultado.id === 2, String(resultado && resultado.id));
}

/* ------------------------------------------------------- 9. robustez */

console.log("\n9. Robustez");
{
  const { ident } = instalar({ falhar: true });
  const resultado = await ident.procurar("chave-de-teste", {
    titulo: "O Iluminado",
    titulo_original: "The Shining",
    ano: 1980,
    tipo: "movie",
  });
  check("a rede em baixo devolve null em vez de rebentar", resultado === null);
  const { ident: ident2 } = instalar();
  const stats = ident2.estatisticas();
  check("as estatísticas ficam acessíveis", typeof stats.pedidos === "number" && typeof stats.cache === "number");
}

/* ----------------------------------------------- 10. ligação ao bundle */

console.log("\n10. Ligação ao bundle");
{
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  check("o bundle carrega o identificador-rapido.js", html.includes('<script src="identificador-rapido.js"></script>'));
  check("o bundle carrega a confirmação externa", html.includes('<script src="confirmacao-externa.js"></script>'));
  check("o bundle delega a pesquisa no módulo", html.includes('typeof w.procurar==="function"'));
  check("o bundle delega a busca manual", html.includes('typeof w.buscar==="function"'));
  check("o bundle delega os detalhes", html.includes('typeof w.detalhes==="function"'));
  check("o bundle delega os atores", html.includes('typeof w.creditos==="function"'));
  check("o bundle lê o módulo do window", html.includes("window.CineIdentificador"));
  check("a implementação antiga fica como fallback", html.includes("async function nSLegado(") && html.includes("async function RuLegado("));

  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const build = fs.readFileSync(path.join(root, "tools", "build-static.mjs"), "utf8");
  check("o build copia o novo ficheiro", build.includes("identificador-rapido.js"));
  check("o build copia a confirmação externa", build.includes("confirmacao-externa.js"));
  check(
    "a confirmação externa é carregada antes do identificador",
    html.indexOf("confirmacao-externa.js") < html.indexOf("identificador-rapido.js")
  );
  check("o package.json tem o script de testes", Boolean(pkg.scripts["identificador:rapido:test"]));

  check("o prompt pede o ID do IMDb", html.includes('"imdb_id": ID do IMDb no formato "tt1234567"'));
  check("o prompt mostra o campo no JSON", html.includes('"imdb_id": "tt0000000"'));
  check("o parser leva o IMDb ID para o resultado", html.includes("imdb_id:typeof k.imdb_id"));
  check("o reel agendado guarda os IDs canónicos", html.includes("tmdbId:Pe==null?void 0:Pe.tmdbId,imdbId:Pe==null?void 0:Pe.imdbId"));
  check("o agendador copia os IDs para a fila", html.includes("tmdbId:r.tmdbId,imdbId:r.imdbId,chave:r.chave"));

  const lote = fs.readFileSync(path.join(root, "lote-massa.js"), "utf8");
  check("o upload em massa guarda os IDs canónicos", lote.includes("tmdbId: filme.tmdbId") && lote.includes("imdbId: filme.imdbId"));

  /* Os patches do identificador têm de ser reconhecidos como aplicados — o
     teste de integridade do bundle (test-barras-pretas) verifica isto para
     todos os patches do repositório. */
  const dir = path.join(root, "tools", "patches");
  const nomes = fs.readdirSync(dir).filter((f) => f.endsWith(".find")).map((f) => f.slice(0, -5)).sort();
  const ler = (n, ext) => {
    const t = fs.readFileSync(path.join(dir, `${n}.${ext}`), "utf8");
    return t.endsWith("\n") ? t.slice(0, -1) : t;
  };
  const meus = nomes.filter((n) => n.startsWith("4") || n.startsWith("5"));
  const naoAplicados = meus.filter(
    (n) => !html.includes(ler(n, "replace")) && !nomes.some((m) => m > n && ler(m, "find").includes(ler(n, "replace")) && html.includes(ler(m, "replace")))
  );
  check("os patches do identificador estão aplicados", naoAplicados.length === 0, naoAplicados.join(", "));
}

/* ------------------------------------- 11. o glue do bundle (execução real) */

console.log("\n11. As funções do bundle delegam mesmo (execução real)");
{
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

  /** Extrai uma função do bundle pelas chavetas. */
  const extrair = (assinatura) => {
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
  };

  const codigo = [
    extrair("function eS("),
    extrair("function Si("),
    extrair("async function Ru("),
    extrair("async function mg("),
    extrair("async function pg("),
    extrair("async function nS("),
    extrair("async function RuLegado("),
    extrair("async function mgLegado("),
    extrair("async function pgLegado("),
    extrair("async function nSLegado("),
  ].join("\n");

  /* Ambiente com as dependências do bundle e um módulo rápido falso. */
  const criar = (identificador) => {
    const chamadas = [];
    const mod = identificador || {
      procurar: async (chave, ia) => {
        chamadas.push(["procurar", chave, ia]);
        return { id: 1, kind: "movie", title: "Do módulo rápido" };
      },
      buscar: async (chave, texto) => {
        chamadas.push(["buscar", chave, texto]);
        return [{ id: 2, kind: "tv", title: "Busca rápida" }];
      },
      detalhes: async (chave, media) => {
        chamadas.push(["detalhes", chave, media.id]);
        return { id: media.id, kind: media.kind, title: "Detalhes rápidos" };
      },
      creditos: async (chave, atores) => {
        chamadas.push(["creditos", chave, atores]);
        return [{ id: 3, kind: "movie", title: "Crédito rápido" }];
      },
    };
    const sandbox = {
      console: { warn() {}, log() {}, error() {} },
      window: { CineIdentificador: mod },
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
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) }),
      /* dependências do caminho legado */
      ft: class extends Error {},
      Ka: async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) }),
      vo: async () => ({ results: [] }),
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(codigo, sandbox, { filename: "bundle-glue.js" });
    return { sandbox, chamadas, mod };
  };

  const { sandbox, chamadas } = criar();
  const pesquisa = await sandbox.nS("chave", { titulo: "O Iluminado" });
  check("nS pede a pesquisa ao módulo rápido", chamadas[0] && chamadas[0][0] === "procurar", JSON.stringify(chamadas[0]));
  check("nS devolve o resultado do módulo rápido", pesquisa && pesquisa.title === "Do módulo rápido");

  const busca = await sandbox.Ru("chave", "O Iluminado");
  check("Ru pede a busca ao módulo rápido", chamadas.some((c) => c[0] === "buscar"));
  check("Ru devolve a lista do módulo rápido", Array.isArray(busca) && busca[0] && busca[0].title === "Busca rápida");

  const detalhe = await sandbox.pg("chave", { id: 7, kind: "movie" });
  check("pg pede os detalhes ao módulo rápido", chamadas.some((c) => c[0] === "detalhes"));
  check("pg devolve os detalhes do módulo rápido", detalhe && detalhe.title === "Detalhes rápidos");

  const credito = await sandbox.mg("chave", ["Jack Nicholson"]);
  check("mg pede os créditos ao módulo rápido", chamadas.some((c) => c[0] === "creditos"));
  check("mg devolve os créditos do módulo rápido", Array.isArray(credito) && credito[0].title === "Crédito rápido");

  /* Sem o módulo (ficheiro em falta na rede) o bundle tem de cair no legado. */
  const semModulo = criar(null);
  semModulo.sandbox.window.CineIdentificador = undefined;
  const legado = await semModulo.sandbox.Ru("chave", "O Iluminado");
  check("sem o módulo, o bundle usa a implementação antiga", Array.isArray(legado), JSON.stringify(legado));
  check("sem o módulo, o bundle não entra em ciclo", semModulo.chamadas.length === 0);
}

/* ------------------------------------------------- 12. fontes externas */

console.log("\n12. Fontes externas (Wikidata / TVmaze)");
{
  /* 12.1 — a confirmação do Wikidata aparece no resultado (filme) */
  const { ident, pedidos } = instalar();
  const resultado = await ident.procurar("chave", {
    titulo: "O Iluminado",
    titulo_original: "The Shining",
    ano: 1980,
    tipo: "movie",
    confianca: 92,
  });
  check("o filme continua a ser encontrado", resultado && resultado.id === 694);
  check("a confirmação do Wikidata está no resultado", !!(resultado && resultado.confirmacao), JSON.stringify(resultado && resultado.confirmacao));
  check("a confirmação diz de onde veio", resultado.confirmacao.fonte === "wikidata", resultado.confirmacao.fonte);
  check("a confirmação traz o ano externo", resultado.confirmacao.ano === "1980", String(resultado.confirmacao.ano));
  check("a confirmação foi pedida à Wikidata", pedidos.some((p) => p.startsWith("wikidata:")));
  check(
    "a confirmação não acrescenta pedidos ao TMDB",
    pedidos.filter((p) => p.startsWith("/search/") || p.startsWith("/movie/") || p.startsWith("/tv/")).length === 3,
    JSON.stringify(pedidos)
  );

  /* 12.2 — a confirmação da TVmaze aparece numa série */
  const serie = await ident.procurar("chave-serie", {
    titulo: "Breaking Bad",
    titulo_original: "Breaking Bad",
    ano: 2008,
    tipo: "tv",
    imdb_id: "tt0903747",
    confianca: 95,
  });
  check("a série continua a ser encontrada", serie && serie.id === 1396);
  check("a confirmação é da TVmaze", serie.confirmacao && serie.confirmacao.fonte === "tvmaze", JSON.stringify(serie.confirmacao));
  check("a confirmação traz a nota", serie.confirmacao.nota === 9.2, String(serie.confirmacao.nota));

  /* 12.3 — a fonte externa desmente o remake e traz a obra exacta */
  const { ident: ident2, pedidos: pedidos2 } = instalar({ esconder: ["1"] });
  const corrigido = await ident2.procurar("chave", {
    titulo: "Duna",
    titulo_original: "Dune",
    ano: 1984,
    tipo: "movie",
    confianca: 80,
  });
  check(
    "a fonte externa corrige o remake errado",
    corrigido && corrigido.id === 1 && corrigido.year === "1984",
    JSON.stringify(corrigido && { id: corrigido.id, ano: corrigido.year })
  );
  check("a correção veio marcada como externa", corrigido.confirmacao && corrigido.confirmacao.fonte === "wikidata");
  check("a obra exacta foi buscada pelo ID do IMDb externo", pedidos2.some((p) => p.startsWith("/find/tt0087182")), JSON.stringify(pedidos2));

  /* 12.4 — resgate: o TMDB não acha, o Wikidata sabe o ID */
  const { ident: ident3 } = instalar();
  const resgatado = await ident3.procurar("chave", {
    titulo: "Eternal Sunshine",
    titulo_original: "Eternal Sunshine of the Spotless Mind",
    ano: 2004,
    tipo: "movie",
    confianca: 70,
  });
  check("sem resultado no TMDB, a ponte encontra a obra", resgatado && resgatado.id === 694, JSON.stringify(resgatado && resgatado.id));
  check("a ponte é marcada como vinda do Wikidata", resgatado.confirmacao && resgatado.confirmacao.fonte === "wikidata");

  /* 12.5 — as fontes externas em baixo não podem estragar a identificação */
  const { ident: ident4 } = instalar({ falharExternas: true });
  const semRede = await ident4.procurar("chave", {
    titulo: "O Iluminado",
    titulo_original: "The Shining",
    ano: 1980,
    tipo: "movie",
    confianca: 92,
  });
  check("sem as fontes externas, o filme é encontrado na mesma", semRede && semRede.id === 694);
  check("sem as fontes externas, não há selo de confirmação", !semRede.confirmacao);

  /* 12.6 — o módulo de confirmação por si só */
  const { confirmacao } = instalar();
  const r = await confirmacao.confirmar({ titulo_original: "The Shining", tipo: "movie", ano: 1980 });
  check("a confirmação devolve a fonte e o ano", r && r.fonte === "wikidata" && r.ano === "1980", JSON.stringify(r));
  const p = await confirmacao.ponte({ titulo_original: "Dune: Part Two", ano: 2024 });
  check("a ponte devolve o ID do TMDB", p && p.tmdb && p.tmdb.kind === "movie" && p.tmdb.id === "438631", JSON.stringify(p && p.tmdb));
  const p2 = await confirmacao.ponte({ titulo_original: "Breaking Bad", tipo: "tv", ano: 2008 });
  check("a ponte devolve o ID do IMDb", p2 && p2.imdbId === "tt0903747", JSON.stringify(p2 && p2.imdbId));
  check("a ponte reconhece a série no Wikidata", p2 && p2.tmdb && p2.tmdb.kind === "tv" && p2.tmdb.id === "1396", JSON.stringify(p2 && p2.tmdb));
  const fraco = await confirmacao.confirmar({ titulo_original: "Sinal de Fogo", tipo: "movie", ano: 1995 });
  check("uma coincidência fraca de título não confirma", fraco && fraco.forte === false, JSON.stringify(fraco));
  const p3 = await confirmacao.ponte({ titulo_original: "Sinal de Fogo", ano: 1995 });
  check("uma coincidência fraca de título não abre a ponte", p3 === null, JSON.stringify(p3));
}

console.log(`\n✅ ${total} verificações passaram com sucesso!\n`);
