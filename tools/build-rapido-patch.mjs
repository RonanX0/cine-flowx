#!/usr/bin/env node
/**
 * Gera e (re)aplica os patches da aba «⚡ Agendamento rápido»:
 *
 *   63-rapido-script-tag    → carrega agendamento-rapido.js antes da nuvem
 *   64-rapido-aba-nav       → botão «⚡ Rápido» na barra (Estúdio · Agendador · Rápido)
 *   65-rapido-aba-estudio   → com três abas, o Estúdio só aparece na aba dele
 *   66-rapido-aba-monte     → <div id="cc-rapido-monte"> onde o painel é desenhado
 *
 *   node tools/build-rapido-patch.mjs        (ou: npm run patch:rapido)
 *   npm run patch:nuvem                      (aplica todos os patches)
 *
 * Como o repositório não tem src/, estes quatro patches são gerados a partir de
 * âncoras do bundle compilado — é este ficheiro que guarda essas âncoras, para
 * o patch poder ser refeito se o bundle mudar. O script é idempotente: se os
 * patches já estiverem aplicados, reverte e volta a aplicar com as âncoras
 * atuais (é isso que permite editar e recarregar sem deixar o bundle sujo).
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const patchDir = path.join(root, "tools", "patches");
const TARGETS = ["index.html", "app-pronto.html"];
const strip = (s) => (s.endsWith("\n") ? s.slice(0, -1) : s);
const count = (hay, needle) => hay.split(needle).length - 1;

/* ------------------------------------------------------------------ âncoras */

/** O fecho do botão «Agendador» dentro da barra de abas. */
const FIM_AGENDADOR =
  `})," Agendador",a>0&&d.jsx("span",{className:"ml-0.5 rounded-full bg-brand px-1.5 py-0.2 text-[10px] font-bold text-primary-foreground",children:a})]})]}),`;

/**
 * O novo botão, como irmão do botão do Agendador (a vírgula vem primeiro).
 * Em ecrãs estreitos só aparece o raio — a barra de abas tem de caber ao lado do
 * seletor de contas sem partir o cabeçalho.
 */
const BOTAO_RAPIDO =
  `,d.jsx("button",{type:"button",title:"Agendamento rápido: agenda vídeos já editados em lote, sem edição — só legenda e capa",onClick:()=>o("rapido"),className:qe("flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition-colors cursor-pointer",r==="rapido"?"bg-primary text-primary-foreground":"text-muted-foreground hover:text-foreground"),children:d.jsxs(d.Fragment,{children:["⚡",d.jsx("span",{className:"hidden sm:inline",children:" Rápido"})]})})`;

/** Abertura do bloco do Estúdio dentro do <main>. */
const ESTUDIO =
  `d.jsxs("div",{className:v==="scheduler"?"hidden":"space-y-6",children:[d.jsx(jc,{n:1,title:"Upload e limpeza"`;

/** Fecho do bloco do Agendador (último filho do <main> antes do rodapé). */
const FIM_MAIN = `onQueueChanged:()=>{C(),j(S,c,g.id,!1)}})})]}),d.jsx("footer"`;

/*
 * A âncora do 63 é o resultado do patch 26 (lote-massa.js + nuvem-duravel.js),
 * não só a tag da nuvem: assim o agendamento-rapido.js fica entre os dois e o
 * apply-cloud-patch.mjs reconhece que o 26 «já está incluído em 63» em vez de
 * voltar a aplicá-lo (o que duplicaria as duas tags).
 */
const TAGS_26 = `    <script src="lote-massa.js"></script>\n    <script src="nuvem-duravel.js"></script>`;

const PATCHES = {
  "63-rapido-script-tag": [
    TAGS_26,
    `    <script src="lote-massa.js"></script>\n    <script src="agendamento-rapido.js"></script>\n    <script src="nuvem-duravel.js"></script>`,
  ],
  // FIM_AGENDADOR termina com "]})" (fecha o botão) + "]})" (fecha a barra) + ",".
  // O botão novo entra entre os dois, como irmão do botão do Agendador.
  "64-rapido-aba-nav": [
    FIM_AGENDADOR,
    FIM_AGENDADOR.slice(0, -"]}),".length) + BOTAO_RAPIDO + "]})" + ",",
  ],
  "65-rapido-aba-estudio": [
    ESTUDIO,
    `d.jsxs("div",{className:v==="studio"?"space-y-6":"hidden",children:[d.jsx(jc,{n:1,title:"Upload e limpeza"`,
  ],
  "66-rapido-aba-monte": [
    FIM_MAIN,
    `onQueueChanged:()=>{C(),j(S,c,g.id,!1)}})}),d.jsx("div",{id:"cc-rapido-monte",className:v==="rapido"?"":"hidden"})]}),d.jsx("footer"`,
  ],
};

const NOMES = Object.keys(PATCHES);
const PATCHES_COMO_LISTA = NOMES.map((nome) => ({ nome, find: PATCHES[nome][0], replace: PATCHES[nome][1] }));

/**
 * Ordem de desfazer: cada patch, da versão atual para a gravada, em sentido
 * descendente (o 66 foi o último a ser aplicado, é o primeiro a sair).
 */
function ordemDeDesfazer() {
  const noDisco = new Map(patchesNoDisco().map((p) => [p.nome, p]));
  const lista = [];
  for (const nome of NOMES) {
    lista.push(PATCHES_COMO_LISTA.find((p) => p.nome === nome));
    if (noDisco.has(nome)) lista.push(noDisco.get(nome));
  }
  return lista.reverse();
}

/* ------------------------------------------------------- desfazer (se já lá) */

/**
 * Le os patches já gravados em disco. É com ESTES que o bundle é revertido: se o
 * texto do patch mudou desde a última vez (por exemplo, o rótulo do botão), é a
 * versão antiga que está no bundle e é ela que tem de ser desfeita.
 */
function patchesNoDisco() {
  const fora = [];
  for (const nome of NOMES) {
    const f = path.join(patchDir, nome + ".find");
    const r = path.join(patchDir, nome + ".replace");
    if (!fs.existsSync(f) || !fs.existsSync(r)) continue;
    fora.push({ nome, find: strip(fs.readFileSync(f, "utf8")), replace: strip(fs.readFileSync(r, "utf8")) });
  }
  return fora;
}

function desaplicarTudo(html, ordem) {
  let fora = html;
  const feitos = new Set();
  for (const p of ordem) {
    if (feitos.has(p.nome)) continue; // já desfeito por outra versão do mesmo patch
    const n = count(fora, p.replace);
    if (n === 0) continue;
    if (n !== 1) {
      throw new Error(`${p.nome}: o patch aparece ${n}x no bundle — reverte à mão (git checkout -- index.html).`);
    }
    fora = fora.replace(p.replace, () => p.find);
    feitos.add(p.nome);
  }
  return fora;
}

function aplicar(html) {
  let dentro = html;
  for (const nome of NOMES) {
    const [find, replace] = PATCHES[nome];
    const n = count(dentro, find);
    if (n !== 1) throw new Error(`${nome}: a âncora ocorre ${n}x (esperava 1) — o bundle mudou?`);
    dentro = dentro.replace(find, () => replace);
    if (count(dentro, replace) !== 1) throw new Error(`${nome}: aplicado mas o resultado não é único.`);
  }
  return dentro;
}

/* --------------------------------------------------------------- gravar */

/**
 * Calcula tudo em memória e só no fim grava: se uma âncora não bater certo,
 * nenhum ficheiro fica meio patchado.
 */
const resultado = {};
/*
 * Para desfazer valem as duas versões dos patches: a gravada no disco (é a que
 * provavelmente está no bundle) e a que este script vai escrever agora (caso o
 * bundle já tenha sido refeito à mão). Sem isto, mudar o texto de um patch
 * deixava a versão antiga presa no bundle e a âncora deixava de ser encontrada.
 */
const paraDesfazer = ordemDeDesfazer();
for (const file of TARGETS) {
  const p = path.join(root, file);
  if (!fs.existsSync(p)) {
    console.log(`⚠️  ${file} não existe — ignorado.`);
    continue;
  }
  const original = fs.readFileSync(p, "utf8");
  const base = desaplicarTudo(original, paraDesfazer);
  const final = aplicar(base);
  // Ida e volta: desfazer o que acabámos de aplicar tem de devolver o mesmo texto.
  if (desaplicarTudo(final, PATCHES_COMO_LISTA.slice().reverse()) !== base) {
    throw new Error(`${file}: a ida e volta do patch não bate certo.`);
  }
  resultado[file] = { original, final };
}

for (const nome of NOMES) {
  fs.writeFileSync(path.join(patchDir, nome + ".find"), PATCHES[nome][0] + "\n");
  fs.writeFileSync(path.join(patchDir, nome + ".replace"), PATCHES[nome][1] + "\n");
  console.log(`✔ ${nome}.find / .replace escritos`);
}

for (const file of TARGETS) {
  if (!resultado[file]) continue;
  const { original, final } = resultado[file];
  if (final === original) {
    console.log(`✔ ${file} já estava com os patches do Agendamento rápido`);
    continue;
  }
  fs.writeFileSync(path.join(root, file), final);
  const delta = final.length - original.length;
  console.log(`💾 ${file} atualizado (${delta >= 0 ? "+" : ""}${delta} bytes)`);
}

const indexPath = path.join(root, "index.html");
const fallbackPath = path.join(root, "404.html");
if (fs.existsSync(indexPath) && fs.existsSync(fallbackPath)) {
  const indexHtml = fs.readFileSync(indexPath, "utf8");
  if (fs.readFileSync(fallbackPath, "utf8") !== indexHtml) {
    fs.copyFileSync(indexPath, fallbackPath);
    console.log("✔ 404.html sincronizado com index.html");
  }
}

console.log(`\n✅ ${NOMES.length} patches do Agendamento rápido prontos. Depois: npm run patch:nuvem`);
