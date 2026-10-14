#!/usr/bin/env node
/**
 * Gera os patches reproduzíveis de ganchos virais a partir de
 * tools/viral-hooks/viral-hooks.template.js.
 *
 * `npm run patch:viral` regenera os patches, aplica-os ao bundle e valida-o.
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const htmlPath = path.join(root, "index.html");
const patchDir = path.join(root, "tools", "patches");
const sourcePath = path.join(root, "tools", "viral-hooks", "viral-hooks.template.js");
const targets = ["index.html", "app-pronto.html", "404.html"];
const source = fs.readFileSync(sourcePath, "utf8").trim();
const count = (text, needle) => text.split(needle).length - 1;

function readOrExtract(name, extract) {
  const file = path.join(patchDir, `${name}.find`);
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").replace(/\n$/, "");
  const value = extract();
  if (!value) throw new Error(`${name}: alvo original não encontrado.`);
  return value;
}

const hmName = "41-viral-hooks";
const hmFind = readOrExtract(hmName, () => {
  const html = fs.readFileSync(htmlPath, "utf8");
  if (html.includes("function ccNormalizeViralHooks(")) {
    throw new Error("O bundle já tem o patch de ganchos; restaura a base antes de recriar os .find.");
  }
  const start = html.indexOf("async function Hm(");
  const end = html.indexOf("async function Zb(", start);
  if (start < 0 || end < 0) return "";
  return html.slice(start, end);
});

const patches = [
  { name: hmName, find: hmFind, replace: source },
  {
    name: "42-viral-hook-shape",
    find: "ganchos:Array.isArray(k.ganchos)?k.ganchos.map(T=>String(T).trim()).filter(Boolean):void 0",
    replace: "ganchos:Array.isArray(k.ganchos)?ccNormalizeViralHooks(k.ganchos):void 0",
  },
  {
    name: "43-viral-hook-prompt",
    find: String.raw`6. ALTERNATIVAS ("alternativas"):
   - Liste até 6 outros títulos possíveis caso haja dúvida (especialmente outros filmes do mesmo ator ou da mesma franquia).`,
    replace: String.raw`6. GANCHOS VIRAIS ("ganchos"):
   - Gere exatamente 3 opções, cada uma com 5 a 9 palavras, no máximo 64 caracteres e um emoji no final.
   - Prenda cada opção a um detalhe visível ou a uma fala real; crie curiosidade sem inventar nem prometer um desfecho.
   - Varie a estrutura, use linguagem natural e evite frases genéricas, hashtags, aspas e rótulos como "Gancho 1".

7. ALTERNATIVAS ("alternativas"):
   - Liste até 6 outros títulos possíveis caso haja dúvida (especialmente outros filmes do mesmo ator ou da mesma franquia).`,
  },
];

fs.mkdirSync(patchDir, { recursive: true });

/* Se o template mudou desde o último build, reverte só os patches anteriores antes
   de gerar os novos .replace. Assim `patch:viral` funciona tanto na primeira aplicação
   como ao iterar no template, sem deixar o bundle preso a uma versão antiga. */
const oldReplacements = new Map(patches.map((patch) => {
  const file = path.join(patchDir, `${patch.name}.replace`);
  return [patch.name, fs.existsSync(file) ? fs.readFileSync(file, "utf8").replace(/\n$/, "") : null];
}));
for (const target of targets) {
  const file = path.join(root, target);
  if (!fs.existsSync(file)) continue;
  let html = fs.readFileSync(file, "utf8");
  const before = html;
  for (const patch of patches.slice().reverse()) {
    const oldReplace = oldReplacements.get(patch.name);
    if (!oldReplace || oldReplace === patch.replace) continue;
    const occurrences = count(html, oldReplace);
    if (occurrences > 1) throw new Error(`${target}: ${patch.name} antigo aparece ${occurrences} vezes.`);
    if (occurrences === 1) html = html.replace(oldReplace, () => patch.find);
  }
  if (html !== before) {
    fs.writeFileSync(file, html);
    console.log(`↺ ${target}: versão anterior dos ganchos revertida antes de regenerar`);
  }
}

const html = fs.readFileSync(htmlPath, "utf8");
for (const patch of patches) {
  if (!patch.find || !patch.replace) throw new Error(`${patch.name}: patch vazio.`);
  if (patch.replace.includes("</script")) throw new Error(`${patch.name}: não pode conter </script>.`);
  const findCount = count(html, patch.find);
  const replaceCount = count(html, patch.replace);
  if (findCount !== 1 && replaceCount !== 1) {
    throw new Error(`${patch.name}: find=${findCount}, replace=${replaceCount}; esperado 1 de cada no bundle.`);
  }
  fs.writeFileSync(path.join(patchDir, `${patch.name}.find`), `${patch.find}\n`);
  fs.writeFileSync(path.join(patchDir, `${patch.name}.replace`), `${patch.replace}\n`);
  console.log(`✔ ${patch.name} · ${patch.replace.length} caracteres`);
}
