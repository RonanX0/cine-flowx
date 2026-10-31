#!/usr/bin/env node
/**
 * Motor de identificação e ganchos v2 (motor-ia.js + patches 67–74), no bundle REAL
 * (jsdom, como o servidor da nuvem) com o Gemini e o TMDB simulados.
 *
 * Identificação (perceção → pesquisa → conferência no TMDB):
 *   • série: dois nomes de personagens ouvidos ("Ruzek", "Upton") escolhem Chicago P.D.
 *     mesmo quando a pesquisa põe Chicago Fire primeiro;
 *   • filme famoso errado: a IA diz Sherlock Holmes (92%), mas o ator reconhecido
 *     (Willem Dafoe) só está em Inside (2023) — que também é o nome do ficheiro;
 *   • nada do que a IA viu bate com o elenco → confiança baixa («revisar»);
 *   • a perceção não recebe o nome do ficheiro (não é enviesada); a pesquisa recebe-o
 *     como pista que pode enganar e usa a Pesquisa Google;
 *   • «Rápido por Nome» não chama nenhuma IA.
 * Ganchos (ver → escrever 10 → julgar):
 *   • tira "**Momento:** A cena mostra…", "Gancho 1:", nomes de personagens e frases
 *     genéricas; o de melhor nota no julgamento vem primeiro; os infiéis à cena caem.
 *
 *   node tools/test-identificar.mjs
 */
import { arrancarApp } from "../servidor/app-headless.mjs";

let pass = 0, fail = 0;
const falhas = [];
const check = (n, ok, d = "") => { if (ok) { pass++; console.log(`   ✔ ${n}`); } else { fail++; falhas.push(n); console.log(`   ❌ ${n}${d ? " — " + d : ""}`); } };
const json = (corpo) => new Response(JSON.stringify(corpo), { status: 200, headers: { "content-type": "application/json" } });

/* ------------------------------------------------------------------ TMDB falso */
const OBRAS = {
  "movie-999": { kind: "movie", id: 999, title: "Acusado", original_title: "Accused", release_date: "2023-01-01", popularity: 10, overview: "Filme de teste.", cast: [] },
  "tv-58841": { kind: "tv", id: 58841, name: "Chicago P.D.", original_name: "Chicago P.D.", first_air_date: "2014-01-08", popularity: 300, overview: "A unidade de Inteligência da polícia de Chicago.", cast: [{ name: "Jason Beghe", roles: [{ character: "Hank Voight" }] }, { name: "Patrick Flueger", roles: [{ character: "Adam Ruzek" }] }, { name: "Tracy Spiridakos", roles: [{ character: "Hailey Upton" }] }] },
  "tv-44006": { kind: "tv", id: 44006, name: "Chicago Fire", original_name: "Chicago Fire", first_air_date: "2012-10-10", popularity: 400, overview: "Bombeiros de Chicago.", cast: [{ name: "Taylor Kinney", roles: [{ character: "Kelly Severide" }] }, { name: "Jesse Spencer", roles: [{ character: "Matthew Casey" }] }] },
  "movie-10528": { kind: "movie", id: 10528, title: "Sherlock Holmes", original_title: "Sherlock Holmes", release_date: "2009-12-23", popularity: 90, overview: "Detetive em Londres.", cast: [{ name: "Robert Downey Jr.", character: "Sherlock Holmes" }, { name: "Jude Law", character: "Dr. John Watson" }] },
  "movie-1000837": { kind: "movie", id: 1000837, title: "Inside", original_title: "Inside", release_date: "2023-03-10", popularity: 20, overview: "Um ladrão de arte fica preso numa cobertura.", cast: [{ name: "Willem Dafoe", character: "Nemo" }] },
  "movie-777": { kind: "movie", id: 777, title: "Inside", original_title: "Inside", release_date: "2007-06-01", popularity: 15, overview: "Terror francês.", cast: [{ name: "Alysson Paradis", character: "Sarah" }] },
  "movie-555": { kind: "movie", id: 555, title: "A Fuga Silenciosa", original_title: "The Quiet Escape", release_date: "2016-05-01", popularity: 3, overview: "Pouco conhecido.", cast: [{ name: "Fulano Ator", character: "Ana" }] },
};
const PESQUISA = {
  accused: ["movie-999"],
  "chicago p d": ["tv-58841"], "chicago fire": ["tv-44006"], "sherlock holmes": ["movie-10528"], inside: ["movie-1000837", "movie-777"],
  "the quiet escape": ["movie-555"], "a fuga silenciosa": ["movie-555"],
};
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
function resumo(k) {
  const o = OBRAS[k];
  return { id: o.id, name: o.name, title: o.title, original_name: o.original_name, original_title: o.original_title, first_air_date: o.first_air_date, release_date: o.release_date, popularity: o.popularity, overview: o.overview, poster_path: "/p.jpg" };
}
function tmdb(u) {
  const caminho = u.pathname.replace(/^\/3/, "");
  const q = norm(u.searchParams.get("query"));
  let m;
  if (caminho === "/search/movie" || caminho === "/search/tv") {
    const tipo = caminho.endsWith("tv") ? "tv" : "movie";
    return { results: (PESQUISA[q] || []).filter((k) => k.startsWith(tipo)).map(resumo) };
  }
  if ((m = /^\/(movie|tv)\/(\d+)\/(credits|aggregate_credits)$/.exec(caminho))) return { cast: (OBRAS[`${m[1]}-${m[2]}`] || {}).cast || [] };
  if ((m = /^\/(movie|tv)\/(\d+)$/.exec(caminho))) { const k = `${m[1]}-${m[2]}`; return { ...resumo(k), genres: [{ name: "Drama" }] }; }
  if (/^\/search\/person/.test(caminho)) return { results: [] };
  return {};
}

/* -------------------------------------------------------------- Gemini falso */
const pedidosIA = [];
let respostas = {};
function respostaGemini(texto, comBusca) {
  pedidosIA.push({ texto, comBusca });
  if (/NÃO tente adivinhar o nome da obra/.test(texto)) return respostas.percecao;
  if (/pesquisador de cinema e TV/.test(texto)) return respostas.pesquisa;
  if (/descreva SÓ o que acontece/.test(texto)) return respostas.cena;
  if (/Escreva 10 ganchos diferentes/.test(texto)) return respostas.escrever;
  if (/editor-chefe/.test(texto)) return respostas.julgar;
  return "{}";
}
const fetchFalso = async (url, opts) => {
  const u = new URL(String(url));
  if (u.hostname === "api.themoviedb.org") return json(tmdb(u));
  if (u.hostname === "generativelanguage.googleapis.com") {
    if (/:generateContent$/.test(u.pathname)) {
      const corpo = JSON.parse(String(opts.body));
      const texto = corpo.contents[0].parts.map((p) => p.text || "").join("\n");
      const r = respostaGemini(texto, !!(corpo.tools && corpo.tools.length));
      return json({ candidates: [{ content: { parts: [{ text: typeof r === "string" ? r : JSON.stringify(r) }] } }] });
    }
    return json({ models: [{ name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] }] });
  }
  if (u.pathname === "/api/public/ia") return json({ choices: [{ message: { content: "{}" } }] });
  return json({});
};

const app = await arrancarApp({ site: "https://exemplo.test", fetchFn: fetchFalso });
const core = app.core;
const QUADROS = ["data:image/jpeg;base64,AAAA", "data:image/jpeg;base64,BBBB", "data:image/jpeg;base64,CCCC"];
const identificar = (opcoes) => core.identificar("", QUADROS, "pt-BR", { geminiKey: "gem", identMode: "auto", ...opcoes });

check("o motor v2 está carregado", app.window.CineClipMotor && app.window.CineClipMotor.versao === 2);

console.log("\n📺 Série: os nomes ouvidos decidem (Chicago P.D., não Chicago Fire)");
{
  respostas.percecao = { falas: ["Ruzek, cobre a porta dos fundos!"], nomes_ouvidos: ["Ruzek", "Upton", "Inteligência"], texto_na_tela: "", atores: [{ nome: "Patrick Flueger", certeza: 70 }], formato: "serie", roteiro: "Dois policiais invadem um apartamento à procura de um suspeito. A detetive encontra uma arma escondida no armário e o parceiro percebe que o suspeito fugiu pela janela.", momento_forte: "A detetive acha a arma no armário", emocao: "tensão", palpites: [{ titulo: "Chicago Fire", ano: 2012, tipo: "tv", motivo: "Chicago" }] };
  respostas.pesquisa = { candidatos: [{ titulo: "Chicago Fire", titulo_original: "Chicago Fire", ano: 2012, tipo: "tv", confianca: 80 }, { titulo: "Chicago P.D.", titulo_original: "Chicago P.D.", ano: 2014, tipo: "tv", confianca: 70 }] };
  pedidosIA.length = 0;
  const ia = await identificar({ fileName: "tiktok_7400000000.mp4" });
  const filme = await core.procurarTmdb("tmdb", ia);
  check("escolhe Chicago P.D.", filme && filme.title === "Chicago P.D.", filme && filme.title);
  check("confiança alta com 2+ provas no elenco", ia.confianca >= 92, String(ia.confianca));
  check("conferência: ator e personagens batem", filme.verificacao.atoresNoElenco === 1 && filme.verificacao.personagensNoElenco >= 2, JSON.stringify(filme.verificacao));
  const perc = pedidosIA.find((p) => /NÃO tente adivinhar/.test(p.texto));
  const pesq = pedidosIA.find((p) => /pesquisador de cinema/.test(p.texto));
  check("a perceção não usa a Pesquisa Google e não vê o nome do ficheiro", perc && !perc.comBusca && !/tiktok_7400/.test(perc.texto));
  check("a pesquisa usa a Pesquisa Google, com as falas e os nomes ouvidos", pesq && pesq.comBusca && /Ruzek/.test(pesq.texto) && /cobre a porta/.test(pesq.texto));
  check("o roteiro da cena e os personagens chegam ao app", /arma escondida/.test(ia.cena || "") && ia.personagens.includes("Upton"));
  check("a identificação já não traz ganchos de rascunho", Array.isArray(ia.ganchos) && ia.ganchos.length === 0);
}

console.log("\n🎬 Filme famoso errado: o elenco desmente o chute");
{
  respostas.percecao = { falas: ["Ninguém vai vir te buscar."], nomes_ouvidos: [], atores: [{ nome: "Willem Dafoe", certeza: 80 }], formato: "filme", roteiro: "Um homem preso numa cobertura de luxo tenta abrir a porta trancada. O alarme dispara e ele percebe que ninguém vai aparecer.", momento_forte: "Ele percebe que está preso", palpites: [] };
  respostas.pesquisa = { candidatos: [{ titulo: "Sherlock Holmes", titulo_original: "Sherlock Holmes", ano: 2009, tipo: "movie", confianca: 92 }] };
  const ia = await identificar({ fileName: "Inside 2023.mp4" });
  const filme = await core.procurarTmdb("tmdb", ia);
  check("escolhe Inside (2023), não Sherlock Holmes", filme && filme.title === "Inside" && String(filme.year) === "2023", filme && `${filme.title} ${filme.year}`);
  check("o nome do ficheiro foi pista na pesquisa (não na perceção)", pedidosIA.some((p) => /pesquisador de cinema/.test(p.texto) && /Inside \(2023\)/.test(p.texto)));
}

console.log("\n❓ Nada bate com o elenco → confiança baixa («revisar»)");
{
  respostas.percecao = { falas: [], nomes_ouvidos: ["Marcos"], atores: [{ nome: "Ator Desconhecido", certeza: 70 }], roteiro: "Uma conversa num carro à noite, com muita tensão entre os dois.", palpites: [] };
  respostas.pesquisa = { candidatos: [{ titulo: "Sherlock Holmes", titulo_original: "Sherlock Holmes", ano: 2009, tipo: "movie", confianca: 90 }] };
  const ia = await identificar({ fileName: "video.mp4" });
  const filme = await core.procurarTmdb("tmdb", ia);
  check("devolve o candidato, mas com confiança ≤ 55", filme && ia.confianca <= 55, `${filme && filme.title} ${ia.confianca}`);
}

console.log("\n🔎 Filme pouco conhecido: a pesquisa acha e o elenco confirma");
{
  respostas.percecao = { falas: [], nomes_ouvidos: ["Ana"], atores: [], roteiro: "Uma mulher foge de casa no meio da noite levando só uma mochila.", palpites: [] };
  respostas.pesquisa = { candidatos: [{ titulo: "A Fuga Silenciosa", titulo_original: "The Quiet Escape", ano: 2016, tipo: "movie", confianca: 70 }] };
  const ia = await identificar({ fileName: "corte.mp4" });
  const filme = await core.procurarTmdb("tmdb", ia);
  check("acha The Quiet Escape e confirma pelo personagem", filme && filme.original === "The Quiet Escape" && ia.confianca >= 80, `${filme && filme.original} ${ia.confianca}`);
}

console.log("\n⚡ «Rápido por Nome» não chama nenhuma IA");
{
  pedidosIA.length = 0;
  const ia = await identificar({ identMode: "dica", fileName: "Inside 2023.mp4" });
  const filme = await core.procurarTmdb("tmdb", ia);
  check("vai direto: Inside (2023)", filme && filme.title === "Inside" && String(filme.year) === "2023", filme && `${filme.title} ${filme.year}`);
  check("zero chamadas à IA", pedidosIA.length === 0, String(pedidosIA.length));
}

console.log("\n⚡ «Rápido por Nome»: o ano entre parênteses não suja o título");
{
  /* O ano era tirado como dígitos soltos ANTES da limpeza dos parênteses, por
     isso "O Amor Não Tira Férias (2006).mp4" ia ao TMDB como
     "O Amor Não Tira Férias (" — não achava nada, e o modo parecia estar a
     ignorar o nome do ficheiro. O caso antigo ("Inside 2023.mp4") passava
     porque o ano não estava entre parênteses. */
  pedidosIA.length = 0;
  const comParentese = await identificar({ identMode: "dica", fileName: "O Amor Não Tira Férias (2006).mp4" });
  check("título sem o parêntese órfão", comParentese.titulo === "O Amor Não Tira Férias", JSON.stringify(comParentese.titulo));
  check("e o ano lido de dentro dele", String(comParentese.ano) === "2006", String(comParentese.ano));
  const comColchete = await identificar({ identMode: "dica", fileName: "Se Beber Não Case [2009].mp4" });
  check("colchetes também", comColchete.titulo === "Se Beber Não Case" && String(comColchete.ano) === "2009", `${comColchete.titulo} ${comColchete.ano}`);
  check("e continua sem chamar a IA", pedidosIA.length === 0, String(pedidosIA.length));
}


console.log("\n⚡ Regressão: Accused.mp4 com a dica geral desativada");
{
  pedidosIA.length = 0;
  const ia = await identificar({ identMode: "dica", fileName: "Accused.mp4", useFileNameHint: false });
  check("usa Accused mesmo com useFileNameHint=false", ia.titulo === "Accused" && ia.provedor === "dica", JSON.stringify(ia));
  const filme = await core.procurarTmdb("tmdb", ia);
  check("consulta TMDB pelo título e aceita título original em inglês", filme?.original === "Accused" && ia.confianca >= 65, JSON.stringify(filme));
  const comMeta = await identificar({ identMode: "dica", fileName: "Accused.mp4", metaTitle: "Data Death" });
  check("nome do arquivo tem prioridade sobre metadados antigos", comMeta.titulo === "Accused", comMeta.titulo);
  let erro = "";
  try { await identificar({ identMode: "dica", fileName: "video.mp4" }); } catch (e) { erro = e.message; }
  check("nome genérico pede um título legível", /nome do arquivo|dica/i.test(erro), erro);
  check("nenhum dos casos chama a IA de identificação", pedidosIA.length === 0, String(pedidosIA.length));
}

console.log("\n🎣 Ganchos: ver → escrever 10 → julgar");
{
  respostas.escrever = { ganchos: [
    "**Momento:** A cena mostra Adam Ruzek e Hailey Upton em uma",
    "Gancho 1: A detetive achou a arma onde ninguém olhou 😳",
    "Ruzek percebeu tarde demais que o suspeito fugiu 😨",
    "Você precisa ver isso 😱",
    "O suspeito fugiu e deixou a arma para trás 😨",
    "Ela abriu o armário e congelou na hora 😱",
    "A cena mostra dois policiais num apartamento",
    "Eles chegaram tarde demais e ele já tinha sumido 💀",
  ] };
  respostas.julgar = { notas: [{ i: 0, fiel: 9, curiosidade: 6, clareza: 8 }, { i: 1, fiel: 8, curiosidade: 7, clareza: 8 }, { i: 2, fiel: 9, curiosidade: 9, clareza: 9 }, { i: 3, fiel: 9, curiosidade: 8, clareza: 9 }] };
  pedidosIA.length = 0;
  const roteiro = "Dois policiais invadem um apartamento à procura de um suspeito. A detetive encontra uma arma escondida no armário e o parceiro percebe que o suspeito fugiu pela janela.";
  const filme = { id: 58841, kind: "tv", title: "Chicago P.D.", year: "2014", overview: "A unidade de Inteligência.", genres: ["Drama", "Crime"] };
  const g = await core.gerarGancho("", [], "pt-BR", filme, "gem", null, null, { cena: roteiro, momento: "A detetive acha a arma", personagens: ["Ruzek", "Upton"], hookMode: "suspense" });
  const todos = g.ganchos.join(" | ");
  check("nada de rótulos nem descrições («Momento:», «A cena mostra»)", !/Momento|A cena mostra/i.test(todos), todos);
  check("o «Gancho 1:» é limpo e o texto aproveitado", g.ganchos.includes("A detetive achou a arma onde ninguém olhou 😳"), todos);
  check("sem nomes de personagens", !/Ruzek|Upton/.test(todos), todos);
  check("sem frases genéricas", !/precisa ver isso/i.test(todos), todos);
  check("o melhor do julgamento vem primeiro", g.ganchos[0] === "Ela abriu o armário e congelou na hora 😱", g.ganchos[0]);
  const esc = pedidosIA.find((p) => /Escreva 10 ganchos/.test(p.texto));
  check("o roteiro vai como única fonte de verdade, e o título não pode aparecer", esc && /arma escondida no armário/.test(esc.texto) && /NÃO cite o nome/.test(esc.texto));
  check("com o roteiro já visto, não reabre o vídeo", !pedidosIA.some((p) => /descreva SÓ o que acontece/.test(p.texto)));
  check("o julgamento recebe os ganchos já limpos", pedidosIA.some((p) => /editor-chefe/.test(p.texto) && /0\. A detetive achou a arma/.test(p.texto)));
}
{
  respostas.cena = { roteiro: "Um garoto encontra uma carta escondida no sótão da casa do avô e começa a ler em voz alta, assustado.", momento_forte: "O garoto lê a carta", emocao: "medo" };
  respostas.escrever = { ganchos: ["O garoto achou a carta que o avô escondeu 😨", "Ninguém devia ter lido aquela carta no sótão 👀"] };
  respostas.julgar = { notas: [{ i: 0, fiel: 9, curiosidade: 6, clareza: 9 }, { i: 1, fiel: 9, curiosidade: 9, clareza: 8 }] };
  pedidosIA.length = 0;
  const g = await core.gerarGancho("", QUADROS, "pt-BR", "video_123.mp4", "gem", null, null, { hookMode: "suspense" });
  check("sem roteiro: a IA assiste primeiro e depois escreve", pedidosIA.findIndex((p) => /descreva SÓ/.test(p.texto)) === 0 && /sótão/.test(g.cena), JSON.stringify(g));
  check("ordem pelo julgamento", g.ganchos[0] === "Ninguém devia ter lido aquela carta no sótão 👀", g.ganchos[0]);
}
{
  respostas.escrever = "Aqui estão:\n1. Ele trancou a porta e escondeu a chave 😨\n**Emoção:** medo\n2. Ela ouviu tudo atrás da parede 👀";
  respostas.julgar = "não é json";
  const g = await core.gerarGancho("", [], "pt-BR", "Filme", "gem", null, null, { cena: "Um homem tranca a porta e esconde a chave enquanto a mulher escuta tudo atrás da parede.", hookMode: "suspense" });
  check("resposta sem JSON: aproveita as linhas boas e descarta rótulos", g.ganchos.length === 2 && g.ganchos[0] === "Ele trancou a porta e escondeu a chave 😨" && !/Emoção/.test(g.ganchos.join("|")), JSON.stringify(g.ganchos));
}
{
  const g = await core.gerarGancho("", [], "pt-BR", "Filme", "gem", null, null, { hookMode: "sem_gancho" });
  check("modo sem gancho continua a devolver vazio", g.ganchos.length === 0);
}

app.fechar();
console.log("\n─────────────────────────────────────────────");
if (fail) { console.log(`❌ ${pass} passaram, ${fail} falharam:`); falhas.forEach((f) => console.log("   • " + f)); process.exit(1); }
console.log(`✅ ${pass} passaram, 0 falharam`);
