#!/usr/bin/env node
/**
 * Gera e aplica os patches do bundle para o Identificador Rápido.
 *
 *   node tools/build-identificador-patch.mjs         # só gera os .find/.replace
 *   node tools/build-identificador-patch.mjs --apply # gera e aplica ao bundle
 *
 * O bundle do CineClip é compilado (não há src/ neste repositório), por isso
 * a ligação entre o bundle e o módulo legível `identificador-rapido.js` faz-se
 * com patches reproduzíveis:
 *
 *   44-identificador-rapido  Ru/mg/pg/nS passam a delegar em
 *                             window.CineIdentificador (com fallback para a
 *                             implementação antiga, caso o ficheiro não carregue)
 *   45-identificador-script  <script src="identificador-rapido.js"></script>
 *   46/47/48                 o prompt pede o ID do IMDb e o parser leva-o
 *   49/50                    os reels agendados guardam os IDs canónicos
 *   51                       <script src="confirmacao-externa.js"> (Wikidata/TVmaze)
 *
 * As implementações legadas ficam com o sufixo "Legado" — é assim que o
 * fallback continua a funcionar sem duplicar código.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const htmlPath = path.join(root, "index.html");
const patchDir = path.join(root, "tools", "patches");
const targets = ["index.html", "app-pronto.html", "404.html"];
const aplicar = process.argv.includes("--apply");

const count = (text, needle) => text.split(needle).length - 1;

/** Extrai uma função (com o nome) do texto, respeitando as chavetas. */
function extrairFuncao(html, assinatura) {
  const inicio = html.indexOf(assinatura);
  if (inicio < 0) return null;
  const chave = html.indexOf("{", html.indexOf(")", inicio));
  if (chave < 0) return null;
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

const html = fs.readFileSync(htmlPath, "utf8");
const jaDelegado = html.includes("window.CineIdentificador");

const TAG_LOTE = '    <script src="lote-massa.js"></script>';
const TAG_NUVEM = '    <script src="nuvem-duravel.js"></script>';
const TAG_IDENT = '    <script src="identificador-rapido.js"></script>';

const patches = [];

/* ------------------------------------------------- 44 e 45 (gerados do bundle) */

if (jaDelegado) {
  console.log("✔ O bundle já delega no Identificador Rápido — o patch 44 é regenerado a partir da base.");
} else {
  console.log("✔ O bundle ainda não delega no Identificador Rápido — o patch 44 é gerado daqui.");
}

/* O bloco original (Ru/mg/pg/nS) vem do bundle. Se o bundle já estiver
 * delegado, o original já não está lá — nesse caso vem da base do git,
 * para que o patch descreva sempre "base → estado atual". */
function blocoOriginal() {
  const assinaturaRu = "async function Ru(";
  const assinaturaNs = "async function nS(";
  const extrair = (texto) => {
    const inicio = texto.indexOf(assinaturaRu);
    const fim = extrairFuncao(texto, assinaturaNs);
    if (inicio < 0 || !fim) return null;
    return texto.slice(inicio, texto.indexOf(fim) + fim.length);
  };
  if (!jaDelegado) {
    const bloco = extrair(html);
    if (!bloco) {
      throw new Error(
        "Não encontrei o bloco Ru/mg/pg/nS no bundle — regenere os alvos com tools/extract-patch-targets.mjs."
      );
    }
    return bloco;
  }
  /* Já delegado: o original está na base do repositório. */
  const base = execFileSync("git", ["show", `${process.env.CINECLIP_BASE_COMMIT || "HEAD"}:index.html`], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
    encoding: "utf8",
  });
  const bloco = extrair(base);
  if (!bloco) throw new Error("Não encontrei o bloco Ru/mg/pg/nS na base do git.");
  return bloco;
}

{
  const original = blocoOriginal();
  const legado = original
    .replace("async function Ru(", "async function RuLegado(")
    .replace("async function mg(", "async function mgLegado(")
    .replace("async function pg(", "async function pgLegado(")
    .replace("async function nS(", "async function nSLegado(");

  const delegacao = [
    'async function Ru(r,o,a){const w=window.CineIdentificador;if(w&&typeof w.buscar==="function")try{return await w.buscar(r,o,{variantes:1})}catch(e){console.warn("[CineClip] busca no TMDB falhou",e)}return await RuLegado(r,o,a)}',
    'async function mg(r,o){const w=window.CineIdentificador;if(w&&typeof w.creditos==="function")try{return await w.creditos(r,o)}catch(e){console.warn("[CineClip] créditos no TMDB falharam",e)}return await mgLegado(r,o)}',
    'async function pg(r,o){const w=window.CineIdentificador;if(w&&typeof w.detalhes==="function")try{return await w.detalhes(r,o)}catch(e){console.warn("[CineClip] detalhes no TMDB falharam",e)}return await pgLegado(r,o)}',
    'async function nS(r,o){const w=window.CineIdentificador;if(w&&typeof w.procurar==="function")try{return await w.procurar(r,o)}catch(e){console.warn("[CineClip] identificador rápido falhou",e)}return await nSLegado(r,o)}',
  ].join("");

  patches.push({ nome: "44-identificador-rapido", find: original, replace: delegacao + legado, regenerarSempre: true });
}

/* A tag do identificador fica ANTES da tag da nuvem: assim a nuvem continua
 * colada ao <script type="module"> e o patch 01 continua a ser reconhecido
 * como aplicado (é o que o teste de integridade do bundle verifica). */
patches.push({
  nome: "45-identificador-script",
  find: TAG_LOTE + "\n" + TAG_NUVEM,
  replace: TAG_LOTE + "\n" + TAG_IDENT + "\n" + TAG_NUVEM,
  permiteTag: true,
  regenerarSempre: true,
});

/* ------------------------------------- 46 a 51 (ficheiros fixos no repositório) */

for (const nome of [
  "38-agendador-destravar",
  "46-identificador-imdb-prompt",
  "47-identificador-imdb-json",
  "48-identificador-imdb-parser",
  "49-identificador-reel-ids",
  "50-identificador-clip-ids",
  "51-confirmacao-externa-script",
]) {
  const ficheiroFind = path.join(patchDir, `${nome}.find`);
  const ficheiroReplace = path.join(patchDir, `${nome}.replace`);
  if (!fs.existsSync(ficheiroFind) || !fs.existsSync(ficheiroReplace)) continue;
  const patch = {
    nome,
    find: fs.readFileSync(ficheiroFind, "utf8").replace(/\n$/, ""),
    replace: fs.readFileSync(ficheiroReplace, "utf8").replace(/\n$/, ""),
    /* O patch 51 insere uma tag <script> — é o único que pode. */
    permiteTag: nome === "51-confirmacao-externa-script",
  };
  /* O 38 já estava aplicado no bundle versionado: a versão nova (com os IDs
   * canónicos no reel do agendador) substitui a antiga no lugar. */
  const ficheiroAnterior = path.join(patchDir, `${nome}.anterior`);
  if (fs.existsSync(ficheiroAnterior)) {
    patch.anterior = fs.readFileSync(ficheiroAnterior, "utf8").replace(/\n$/, "");
  }
  patches.push(patch);
}

fs.mkdirSync(patchDir, { recursive: true });

for (const patch of patches) {
  if (!patch.find || !patch.replace) throw new Error(`${patch.nome}: patch vazio.`);
  if (patch.replace.includes("</script") && !patch.permiteTag) {
    throw new Error(`${patch.nome}: não pode conter </script>.`);
  }
  /* Se o bundle já tem o resultado, o .find já não existe — o patch fica
     como está no disco (é o registo do que foi aplicado). */
  const jaAplicado = count(html, patch.replace) >= 1;
  if (jaAplicado && !patch.regenerarSempre) {
    console.log(`   ⏭  ${patch.nome} já aplicado — mantido como está`);
    continue;
  }
  const upgrade = patch.anterior && count(html, patch.anterior) === 1;
  if (!jaAplicado && !upgrade) {
    const ocorrencias = count(html, patch.find);
    if (ocorrencias !== 1) {
      throw new Error(`${patch.nome}: o alvo aparece ${ocorrencias} vezes no bundle (esperava 1).`);
    }
  }
  fs.writeFileSync(path.join(patchDir, `${patch.nome}.find`), `${patch.find}\n`);
  fs.writeFileSync(path.join(patchDir, `${patch.nome}.replace`), `${patch.replace}\n`);
  console.log(`✔ ${patch.nome} · ${patch.replace.length} caracteres`);
}

if (aplicar) {
  /* Aplicação dirigida: só os patches deste módulo, nos ficheiros que
   * servem o app. O `apply-cloud-patch.mjs` completo pressupõe um bundle
   * "base + todos os patches" e falha em bundles já parcialmente alterados
   * (o caso do index.html versionado), por isso aqui aplicamos só o que é
   * nosso — com a mesma regra: o alvo tem de aparecer exactamente uma vez. */
  for (const alvo of targets) {
    const ficheiro = path.join(root, alvo);
    if (!fs.existsSync(ficheiro)) continue;
    let conteudo = fs.readFileSync(ficheiro, "utf8");
    let mudou = false;
    for (const patch of patches) {
      if (count(conteudo, patch.replace) >= 1) {
        console.log(`   ⏭  ${alvo}: ${patch.nome} já aplicado`);
        continue;
      }
      if (patch.anterior && count(conteudo, patch.anterior) === 1) {
        conteudo = conteudo.replace(patch.anterior, () => patch.replace);
        mudou = true;
        console.log(`   ✔  ${alvo}: ${patch.nome} (upgrade da versão anterior)`);
        continue;
      }
      const ocorrencias = count(conteudo, patch.find);
      if (ocorrencias !== 1) {
        throw new Error(`${alvo}: ${patch.nome} tem ${ocorrencias} ocorrências (esperava 1).`);
      }
      conteudo = conteudo.replace(patch.find, () => patch.replace);
      mudou = true;
      console.log(`   ✔  ${alvo}: ${patch.nome}`);
    }
    if (mudou) fs.writeFileSync(ficheiro, conteudo);
  }
  console.log("\n✔ Identificador Rápido ligado ao bundle.");
}
