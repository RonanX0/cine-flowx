#!/usr/bin/env node
/**
 * Extrai os segmentos exatos do bundle (index.html) para tools/patches/*.find.
 * Correr uma vez antes de aplicar o patch:
 *   node tools/extract-patch-targets.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");

/**
 * Fonte da verdade: o bundle ORIGINAL (commit base), para o script continuar a
 * funcionar mesmo depois de o patch já ter sido aplicado ao index.html.
 */
const BASE_COMMIT = process.env.CINECLIP_BASE_COMMIT || "b6ebed853fae2fb1b5e9a138fb2af7f4cea4cfa3";
let src;
try {
  src = execFileSync("git", ["show", `${BASE_COMMIT}:index.html`], {
    cwd: root,
    maxBuffer: 1 << 28,
    stdio: ["ignore", "pipe", "ignore"],
  }).toString("utf8");
  console.log(`Bundle original lido do git (${BASE_COMMIT.slice(0, 7)}), ${src.length} chars`);
} catch {
  src = fs.readFileSync(path.join(root, "index.html"), "utf8");
  console.log(`Commit base indisponível — a usar o index.html atual (${src.length} chars)`);
}
const outDir = path.join(root, "tools", "patches");
fs.mkdirSync(outDir, { recursive: true });

const count = (needle) => {
  let c = 0;
  let i = -1;
  while ((i = src.indexOf(needle, i + 1)) >= 0) c++;
  return c;
};

/** Texto exato entre `start` e `endMarker` (inclusive). */
function between(start, endMarker) {
  const i = src.indexOf(start);
  if (i < 0) throw new Error("start não encontrado: " + start.slice(0, 60));
  const j = src.indexOf(endMarker, i);
  if (j < 0) throw new Error("end não encontrado para: " + start.slice(0, 60));
  return src.slice(i, j + endMarker.length);
}

// Nota: os patches 22 (layout do Agendador) e 23 (CSS do Agendador) NÃO são
// extraídos aqui — são gerados por tools/build-agendador-patch.mjs a partir de
// tools/agendador-ui/ e aplicados por cima dos patches 01–21.
const P = {
  "01-script-tag": `    <script type="module">`,
  "02-toast-export": `Iy.createRoot(document.getElementById("root"))`,
  "03-bg": between("async function bg(r,o){", "async function fS(r,o){").slice(
    0,
    -"async function fS(r,o){".length
  ),
  "04-Km": between("async function Km(r,o){", "async function SS(r){").slice(
    0,
    -"async function SS(r){".length
  ),
  "05-SS": between("async function SS(r){", "let Oa=null;").slice(0, -"let Oa=null;".length),
  "06-oa-decl": "let Oa=null;",
  "07-pg-tail": between(
    "const D={version:1,updatedAt:Date.now(),settings:h,",
    "})().finally(()=>{Oa=null})),Oa}"
  ),
  "08-j-catch": `catch(rt){Ue&&je.error((rt==null?void 0:rt.message)||"Erro ao sincronizar na nuvem.")}finally{i(!1)}},[r,C]);`,
  "09-badge": between(
    'N.remoteVideoUrl&&d.jsx(fn,{variant:"outline"',
    'children:"☁️ PC + Celular"})'
  ),
  "10-reenviar-button": between(
    "(N.videoBlob||N.remoteVideoUrl)&&d.jsx(Ae,{size:\"sm\",variant:\"outline\",onClick:()=>{N.videoBlob?Zn(N.videoBlob,N.videoFileName)",
    'title:"Baixar vídeo .mp4 deste agendamento",children:d.jsx(Ko,{className:"h-3.5 w-3.5"})})'
  ),
  "11-settings-defaults": between('const Sg="cineclip.settings"', "function Eg(){").slice(
    0,
    -"function Eg(){".length
  ),
  "12-settings-state": `function aS({open:r,onOpenChange:o,settings:a,onSave:i}){const[c,u]=b.useState(a);`,
  "13-settings-ui": `d.jsxs("div",{className:"space-y-2",children:[d.jsx(er,{htmlFor:"ovl",children:"Texto por cima do vídeo"}),d.jsx(dn,{id:"ovl",value:c.overlayText,onChange:f=>u({...c,overlayText:f.target.value})})]}),`,
  "14-ji-addqueue": between('ji=async()=>{const F=Ya();', 'x("scheduler")}'),
  "15-robo-24h": between("function kS(r){return`", "`}function ES("),
  // As definições vindas da nuvem não podem ser sobrescritas por valores locais
  // vazios (senão o 2º aparelho perdia a configuração do R2).
  "16-settings-merge": between(
    "overlayText:((ye=c.overlayText)==null?void 0:ye.trim())",
    "_g(h);"
  ),
  // 🔒 Claims: reclama o item antes de publicar (impede publicar o mesmo Reel
  // duas vezes quando o app e o Robô 24h correm ao mesmo tempo).
  "19-claims-abrir": between(
    'try{const q={...N,status:"publishing",lastStep:`A iniciar envio (${G.name})…`,errorMsg:void 0};',
    "lastStep:`Publicado em ${G.name} com sucesso!`};"
  ),
  // 🔒 Claims: fecha o try interno e liberta a claim (sucesso ou erro).
  "20-claims-libertar": between(
    '}catch(q){const Z={...N,status:"error",errorMsg:',
    "lastStep:void 0};"
  ),
  // 🎬 Publicação de Reels à prova do erro 2207077: envio direto (resumable), link
  // verificado/renovado e repetição com container novo.
  "24-ig-2207077": between("async function mS(r){", "return await pS(u,String(x.id),f,a)}"),
};

let failed = 0;
for (const [name, text] of Object.entries(P)) {
  const c = count(text);
  if (c !== 1) {
    console.log(`❌ ${name}: ${c} ocorrências (esperava 1) — ${text.slice(0, 70)}`);
    failed++;
    continue;
  }
  fs.writeFileSync(path.join(outDir, name + ".find"), text);
  console.log(`✔ ${name.padEnd(22)} ${String(text.length).padStart(6)} bytes`);
}
if (failed) {
  console.error(`\n${failed} segmento(s) falharam.`);
  process.exit(1);
}
console.log("\nSegmentos gravados em tools/patches/*.find");
