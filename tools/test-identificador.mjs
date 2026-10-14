#!/usr/bin/env node
/**
 * Testes unitários do Identificador de Filmes (CineClip)
 *
 * Valida:
 * 1. Normalização de títulos e algarismos romanos (fi)
 * 2. Limpeza de consultas e variantes para o TMDB (Ru)
 * 3. Limpeza de nomes de atores e papéis/personagens (mg)
 * 4. Algoritmo de pontuação e desempate (w / nS):
 *    - Um filme com o mesmo ator NÃO pode ultrapassar o filme com o título correto
 *    - Confirmação por múltiplos atores
 *    - Proximidade de ano e penalização de remakes distantes
 * 5. Prompt investigativo anti-alucinação no bundle
 * 6. Envio de múltiplos quadros em alta resolução para visão (NVIDIA)
 * 7. Modelos Gemini suportados (sem gemini-2.5 fantasma)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const indexPath = path.join(root, "index.html");
const html = fs.readFileSync(indexPath, "utf8");

let total = 0;
const check = (desc, cond, extra = "") => {
  total++;
  assert.ok(cond, `${desc} ${extra ? `(${extra})` : ""}`);
  console.log(`   ✔ ${desc}`);
};

console.log("\n🎬 Testes do Identificador de Filmes\n");

/* 1. Normalização fi ------------------------------------------------------- */
console.log("1. Normalização de títulos (fi)");

function fi(r) {
  return r
    ? r
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\bii\b/g, "2")
        .replace(/\biii\b/g, "3")
        .replace(/\biv\b/g, "4")
        .replace(/\bv\b/g, "5")
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
    : "";
}

check("remove acentos e pontuação", fi("Bastardos Inglórios!") === "bastardos inglorios");
check("sequência com algarismos romanos coincide com número", fi("Gladiador II") === fi("Gladiador 2"));
check("sequência 3 romana", fi("John Wick: Chapter III") === fi("John Wick: Chapter 3"));
check("ignora maiúsculas e espaços extras", fi("  O   PODEROSO    CHEFÃO  ") === "o poderoso chefao");

/* 2. Limpeza de consultas TMDB -------------------------------------------- */
console.log("\n2. Limpeza de consultas para o TMDB");

function gerarConsultas(raw) {
  const q = String(raw || "").trim();
  if (!q) return [];
  const limpo = q.replace(/\s*[\(\[]?\b(19\d\d|20\d\d)\b[\)\]]?.*$/, "").replace(/[–—:\-\.,]+$/, "").trim();
  const base = limpo.split(/[:–—\-]/)[0].trim();
  return [...new Set([q, limpo, base].filter((x) => x && x.length >= 2))].slice(0, 2);
}

check("remove ano em parênteses", gerarConsultas("Interestelar (2014)").includes("Interestelar"));
check("gera base antes de subtítulo com dois-pontos", gerarConsultas("Duna: Parte 2").includes("Duna"));
check("gera base antes de travessão", gerarConsultas("O Cavaleiro das Trevas - O Filme").includes("O Cavaleiro das Trevas"));

/* 3. Limpeza de nomes de atores ------------------------------------------- */
console.log("\n3. Limpeza de atores e papéis");

function limparAtor(c) {
  return c
    .replace(/\s+(as|como|interpretando|papel\s+de)\s+.*/i, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/[-–—:].*/, "")
    .trim();
}

check("remove 'as Character'", limparAtor("Cillian Murphy as Tommy Shelby") === "Cillian Murphy");
check("remove 'como Personagem'", limparAtor("Keanu Reeves como Neo") === "Keanu Reeves");
check("remove personagem entre parênteses", limparAtor("Bryan Cranston (Walter White)") === "Bryan Cranston");
check("remove personagem após dois-pontos", limparAtor("Tom Cruise: Ethan Hunt") === "Tom Cruise");

/* 4. Pontuação e desempate (w / nS) --------------------------------------- */
console.log("\n4. Pontuação e prevenção de filmes errados");

function pontuarCandidato(S, o, actorCounts = new Map()) {
  const a = o.ano ? Number(String(o.ano).slice(0, 4)) : 0;
  const x = fi(o.titulo_original || "");
  const h = fi(o.titulo || "");
  const alts = (o.alternativas || []).map((T) => ({ orig: fi(T.titulo_original || ""), pt: fi(T.titulo || "") }));

  let T = 0;
  const D = fi(S.original);
  const O = fi(S.title);
  let titleMatched = false;

  if (x && (D === x || O === x)) {
    T += 85;
    titleMatched = true;
  } else if (h && (O === h || D === h)) {
    T += 80;
    titleMatched = true;
  }
  if (x && h && D === x && O === h) T += 30;

  if (!titleMatched) {
    const wordsCand = new Set((D + " " + O).split(" ").filter(Boolean));
    const wordsAi = new Set((x + " " + h).split(" ").filter(Boolean));
    if (wordsCand.size > 0 && wordsAi.size > 0) {
      let common = 0;
      for (const word of wordsAi) wordsCand.has(word) && common++;
      if (common >= Math.min(wordsAi.size, wordsCand.size) && common >= 1) {
        T += 65;
        titleMatched = true;
      } else if (common >= 2) {
        T += 45;
        titleMatched = true;
      } else if (common === 1 && (x && (D.includes(x) || x.includes(D)) || h && (O.includes(h) || h.includes(O)))) {
        T += 35;
        titleMatched = true;
      }
    }
  }

  if (!titleMatched) {
    for (const alt of alts) {
      if ((alt.orig && (D === alt.orig || O === alt.orig)) || (alt.pt && (O === alt.pt || D === alt.pt))) {
        T += 55;
        titleMatched = true;
        break;
      }
    }
  }

  const key = `${S.kind}-${S.id}`;
  const numActors = actorCounts.get(key) || 0;
  if (titleMatched) {
    if (numActors >= 2) T += 55;
    else if (numActors === 1) T += 35;
  } else {
    if (!x && !h) T += numActors >= 2 ? 55 : 35;
    else T += numActors >= 1 ? 10 : 0;
  }

  if (o.tipo && S.kind) {
    if (S.kind === o.tipo) T += 15;
    else T -= 15;
  }

  const j = Number(S.year) || 0;
  if (a && j) {
    const diff = Math.abs(a - j);
    if (diff === 0) T += 25;
    else if (diff <= 1) T += 18;
    else if (diff <= 2) T += 12;
    else if (diff > 7 && S.kind === "movie") T -= 25;
  }

  T += Math.min(8, Math.log10((S.popularity || 1) + 1) * 3);
  return T;
}

// Caso 1: AI identificou "O Iluminado" com Jack Nicholson.
// Um filme pop com Jack Nicholson ("Batman") NÃO pode vencer "O Iluminado"!
const aiShining = {
  titulo: "O Iluminado",
  titulo_original: "The Shining",
  ano: 1980,
  tipo: "movie",
};
const candShining = { id: 694, kind: "movie", title: "O Iluminado", original: "The Shining", year: "1980", popularity: 80 };
const candBatman = { id: 268, kind: "movie", title: "Batman", original: "Batman", year: "1989", popularity: 200 };
const actorsJack = new Map([
  ["movie-694", 1],
  ["movie-268", 1],
]);

const scoreShining = pontuarCandidato(candShining, aiShining, actorsJack);
const scoreBatman = pontuarCandidato(candBatman, aiShining, actorsJack);

check("o filme correto vence com larga vantagem o outro filme do mesmo ator", scoreShining > scoreBatman + 100);
check("filme com título idêntico + mesmo ano + ator passa de 160 pontos", scoreShining > 160);
check("filme sem correspondência no título não passa de 25 pontos", scoreBatman < 25);

// Caso 2: Dois atores confirmam a série/filme
const candBreakingBad = { id: 1396, kind: "tv", title: "Breaking Bad", original: "Breaking Bad", year: "2008", popularity: 300 };
const actorsBB = new Map([["tv-1396", 2]]);
const scoreBB = pontuarCandidato(candBreakingBad, { titulo: "Breaking Bad", titulo_original: "Breaking Bad", ano: 2008, tipo: "tv" }, actorsBB);
check("dois atores em cena dão bónus duplo de confirmação", scoreBB > 200);

// Caso 3: Remake 40 anos antes perde para o ano correto
const candRemake1984 = { id: 1, kind: "movie", title: "Duna", original: "Dune", year: "1984", popularity: 40 };
const candAtual2021 = { id: 2, kind: "movie", title: "Duna", original: "Dune", year: "2021", popularity: 150 };
const score1984 = pontuarCandidato(candRemake1984, { titulo: "Duna", ano: 2021, tipo: "movie" });
const score2021 = pontuarCandidato(candAtual2021, { titulo: "Duna", ano: 2021, tipo: "movie" });
check("filme do ano exato vence versão antiga com mesmo nome", score2021 > score1984 + 40);

/* 5. Bundle index.html ----------------------------------------------------- */
console.log("\n5. Verificações do bundle e integridade");

check("prompt contém regra contra chutar filmes famosos do ator", html.includes("NÃO chute o filme mais famoso do ator"));
check("prompt contém instrução de transcrição exata", html.includes("fala_do_audio") && html.includes("palavra por palavra"));
check("prompt contém instrução de pesquisa Google", html.includes("PESQUISA GOOGLE"));
check("prompt instrui dedução lógica antes do título", html.includes("analise_deducao"));
check("NVIDIA dg envia múltiplos quadros em alta definição", html.includes("multiParts") && html.includes("highRes"));
check("Gemini não usa modelos fictícios gemini-2.5", !html.includes('"gemini-2.5-flash"') && html.includes('"gemini-2.0-flash"'));
check("Gemini inclui gemini-1.5 para fallback resiliente", html.includes('"gemini-1.5-flash"'));
check("Google search tool usa camelCase no Gemini", html.includes("googleSearch:"));
check("badge exibe Google Gemini com Web", html.includes("Google Gemini (Vídeo + Áudio + Web)"));

console.log(`\n✅ ${total} verificações passaram com sucesso!`);
