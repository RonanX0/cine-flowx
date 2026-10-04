#!/usr/bin/env node
/**
 * Gera os patches do NOVO LAYOUT DO AGENDADOR a partir de ficheiros legíveis:
 *
 *   tools/agendador-ui/agendador.template.js  →  tools/patches/21-agendador-ui.replace
 *   tools/agendador-ui/agendador.css          →  tools/patches/22-agendador-css.replace
 *
 *   node tools/build-agendador-patch.mjs   (ou: npm run patch:agendador)
 *   npm run patch:nuvem                    (aplica todos os patches ao bundle)
 *
 * Para mudar o visual do Agendador edita SÓ os dois ficheiros em
 * tools/agendador-ui/, corre `npm run patch:agendador` e recarrega o app.
 *
 * O patch 21 é aplicado DEPOIS dos patches 01–20, por isso o seu .find é o
 * "return" do componente do Agendador já com os patches 09/10 aplicados. Se o
 * .find ainda não existir, é extraído do index.html atual (antes do patch 21).
 * Se o 21 já estiver aplicado no index.html, ele é revertido e reaplicado com
 * o template novo (é isso que torna a edição iterativa simples).
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const uiDir = path.join(root, "tools", "agendador-ui");
const patchDir = path.join(root, "tools", "patches");
const TARGETS = ["index.html", "app-pronto.html", "404.html"];
const strip = (s) => (s.endsWith("\n") ? s.slice(0, -1) : s);
const count = (hay, needle) => hay.split(needle).length - 1;

const RENDER_START =
  'return d.jsxs("section",{className:"rounded-2xl border border-primary/30 bg-card p-6 shadow-lg",children:[';
const RENDER_END = "]})}var Je;";

const files = {
  uiFind: path.join(patchDir, "21-agendador-ui.find"),
  uiReplace: path.join(patchDir, "21-agendador-ui.replace"),
  cssFind: path.join(patchDir, "22-agendador-css.find"),
  cssReplace: path.join(patchDir, "22-agendador-css.replace"),
};

/* ---------------------------------------------------------------- .find */
let FIND;
if (fs.existsSync(files.uiFind)) {
  FIND = strip(fs.readFileSync(files.uiFind, "utf8"));
} else {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  if (count(html, RENDER_START) !== 1) throw new Error("Render original do Agendador não encontrado no index.html.");
  const i = html.indexOf(RENDER_START);
  const e = html.indexOf(RENDER_END, i);
  FIND = html.slice(i, e + RENDER_END.length - "var Je;".length);
  fs.writeFileSync(files.uiFind, FIND);
  console.log(`✔ 21-agendador-ui.find extraído (${FIND.length} bytes)`);
}

/** Recorta FIND entre dois marcadores (start incluído, end excluído). */
function cut(start, end, label) {
  if (count(FIND, start) !== 1) throw new Error(`${label}: início não é único no render original.`);
  const i = FIND.indexOf(start);
  const j = FIND.indexOf(end, i + start.length);
  if (j < 0) throw new Error(`${label}: fim não encontrado.`);
  return FIND.slice(i, j);
}

// Painel "Robô 24h" original (sem o "x&&" que o mostrava/escondia)
let robo = cut('x&&d.jsxs("div",{className:"mt-4 space-y-3 rounded-xl', ',g&&d.jsxs("div",{className:"mt-4 space-y-4', "ROBO").slice(3);
robo = robo.replace('className:"mt-4 space-y-3 rounded-xl', 'className:"space-y-3 rounded-xl');

// Painel de configuração original (modo da conta, webhook, token…)
let config = cut('g&&d.jsxs("div",{className:"mt-4 space-y-4', ',d.jsx("div",{className:"mt-5 rounded-xl border border-primary/25', "CONFIG").slice(3);
config = config.replace('className:"mt-4 space-y-4 rounded-xl border border-border bg-muted/30 p-4"', 'className:"space-y-4 rounded-xl border border-border bg-card p-4"');
// Os horários / Auto-Pilot / Feed passam para o novo editor de horários (cc_slotEditor)
const slotsGridStart = 'd.jsxs("div",{className:"grid gap-3 pt-2 sm:grid-cols-2",children:[';
const slotsGridEnd = ',d.jsx("div",{className:"flex justify-end pt-2"';
if (count(config, slotsGridStart) !== 1) throw new Error("CONFIG: grelha de horários não encontrada.");
config =
  config.slice(0, config.indexOf(slotsGridStart)) +
  config.slice(config.indexOf(slotsGridEnd) + 1);

// Selo da nuvem (patch 09) e botão "Reenviar p/ nuvem" (patch 10)
const cloudBadge = cut("N.remoteVideoUrl?window.CineCloud", ',o.length>1&&d.jsx("select"', "CLOUD_BADGE");
const reenviar = cut(
  "(!N.remoteVideoUrl||N.needsReupload||N.cloudError)&&",
  ',d.jsx(Ae,{size:"sm",variant:"ghost",onClick:()=>H(N.id)',
  "REENVIAR"
);

/* ------------------------------------------------------------- .replace */
let tpl = fs.readFileSync(path.join(uiDir, "agendador.template.js"), "utf8");
tpl = tpl.replace(/^\/\*[\s\S]*?\*\/\n/, ""); // cabeçalho de documentação fica só no ficheiro fonte
for (const [mark, code] of Object.entries({
  __CC_ROBO__: robo,
  __CC_CONFIG__: config,
  __CC_CLOUD_BADGE__: cloudBadge,
  __CC_REENVIAR__: reenviar,
})) {
  if (count(tpl, mark) !== 1) throw new Error(`Template: marcador ${mark} tem de aparecer 1x.`);
  tpl = tpl.replace(mark, () => code);
}
if (tpl.includes("</script")) throw new Error("O template não pode conter </script>.");
const REPLACE = "/*cc-agendador:inicio*/\n" + tpl.trim() + "\n/*cc-agendador:fim*/";

const css = fs.readFileSync(path.join(uiDir, "agendador.css"), "utf8").trim();
if (css.includes("</style")) throw new Error("O CSS não pode conter </style>.");
const CSS_FIND = "  </head>";
const CSS_REPLACE = `    <style id="cc-agendador-css">\n${css}\n    </style>\n  </head>`;

/* --------------------------------- reverte versões antigas já aplicadas
 * Procura pelos marcadores (e não pelo conteúdo exato), para funcionar mesmo
 * que o .replace antigo já tenha sido apagado/alterado. */
const UI_START = "/*cc-agendador:inicio*/";
const UI_END = "/*cc-agendador:fim*/";
const CSS_START = '    <style id="cc-agendador-css">';
for (const t of TARGETS) {
  const p = path.join(root, t);
  if (!fs.existsSync(p)) continue;
  let html = fs.readFileSync(p, "utf8");
  const before = html;
  const a = html.indexOf(UI_START);
  if (a >= 0) {
    const e = html.indexOf(UI_END, a);
    if (e < 0) throw new Error(`${t}: marcador ${UI_END} em falta.`);
    html = html.slice(0, a) + FIND + html.slice(e + UI_END.length);
  }
  const c = html.indexOf(CSS_START);
  if (c >= 0) {
    const e = html.indexOf(CSS_FIND, c);
    if (e < 0) throw new Error(`${t}: fim do CSS do Agendador não encontrado.`);
    html = html.slice(0, c) + CSS_FIND + html.slice(e + CSS_FIND.length);
  }
  if (html !== before) {
    fs.writeFileSync(p, html);
    console.log(`↺ ${t}: versão anterior do Agendador revertida`);
  }
}

fs.writeFileSync(files.uiReplace, REPLACE);
fs.writeFileSync(files.cssFind, CSS_FIND);
fs.writeFileSync(files.cssReplace, CSS_REPLACE);
console.log(`✔ 21-agendador-ui.replace (${REPLACE.length} bytes)`);
console.log(`✔ 22-agendador-css.replace (${CSS_REPLACE.length} bytes)`);
console.log("\nAgora corre: npm run patch:nuvem");
