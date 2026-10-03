#!/usr/bin/env bash
# Recria o botão "☁️ Enviar todos p/ nuvem" no CineClip a partir de um clone limpo
# (commit d4c2cfc ou o main com o PR #1 mergeado).
#
#   bash recriar-botao-migrar.sh            # corre dentro do repo
#
# Faz 4 coisas: os patches 17/18, as 2 entradas no extractor, os 3 helpers no
# nuvem-duravel.js (v1.1.0 -> v1.2.0) e no fim regenera os bundles + valida.
set -euo pipefail

if [ -f tools/apply-cloud-patch.mjs ]; then :; else echo "❌ Corre isto dentro do repositório cine-flowx (não vejo tools/apply-cloud-patch.mjs)"; exit 1; fi

echo "── 1/4  patches 17 e 18"
write() { cat > "$1"; }

write tools/patches/17-migrar-fn.find <<'FIND17'
function Tg(){try{const r=localStorage.getItem(Jc);if(!r)return null;
FIND17

write tools/patches/17-migrar-fn.replace <<'REPL17'
let CcMig=0;
// "Enviar todos p/ nuvem": migra a fila TODA de uma vez. O sync normal (Pg) só trata
// de 5 itens por ciclo, por isso uma fila grande demorava vários minutos (ou ficava
// para trás se o utilizador fechasse a aba). Usa o mesmo bg()/Rn()/Pg() do resto do
// app, com progresso, erros visíveis e o dedupe CcUp para não chocar com o auto-sync.
async function CcMigrarTodos(){
const id="cineclip-cloud-migrate";
if(CcMig){je("☁️ Já está a decorrer uma migração para a nuvem — espera acabar.");return{running:!0}}
if(!window.CineCloud||!window.CineCloud.configured()){je.error("⚠️ Configura primeiro a nuvem durável: Configurações → ☁️ Nuvem durável — Google Drive (URL + token) → Guardar.");return{ok:!1,reason:"sem_nuvem"}}
const S=Tg();
if(!S||!S.vaultHash){je.error("⚠️ Inicia sessão primeiro — sem login não há cofre na nuvem onde guardar os links.");return{ok:!1,reason:"sem_sessao"}}
CcMig=1;let enviados=0,falhou=0;
try{
const all=await Wr().catch(()=>[]);
const pl=window.CineCloud.migrationPlan(all),P=pl.pending;
if(!P.length){je.success(pl.semVideo.length?`Nada para enviar — mas ${pl.semVideo.length} agendamento(s) já não têm o vídeo neste aparelho. Só reimportando o .mp4.`:"☁️ Todos os vídeos desta fila já estão na nuvem durável.");return{ok:!0,total:pl.total,enviados:0,falhou:0,semVideo:pl.semVideo.length}}
je.loading(`☁️ A enviar ${P.length} vídeo(s) (${window.CineCloud.fmtSize(pl.bytes)}) para a nuvem durável…`,{id});
for(let K=0;K<P.length;K++){
const H=P[K],nm=H.title||H.videoFileName||"vídeo";
if(CcUp.has(H.id))continue;
CcUp.add(H.id),delete H.needsReupload,delete H.cloudError;
try{
const ne=await bg(H.videoBlob,H.videoFileName,q=>{je.loading(`☁️ ${K+1}/${P.length} — "${nm}"… ${q}%`,{id})});
H.remoteVideoUrl=ne,H.cloudProvider=window.CineCloud.classifyUrl(ne),H.updatedAt=Date.now(),await Rn(H),enviados++;
je.loading(`☁️ ${enviados}/${P.length} já na nuvem durável…`,{id})}catch(Be){
const ms=(Be==null?void 0:Be.message)||"Falha ao enviar o vídeo para a nuvem";
H.cloudError=ms,H.updatedAt=Date.now(),await Rn(H),falhou++;
je.error(`⚠️ "${nm}" NÃO foi para a nuvem: ${ms}`,{id})}finally{CcUp.delete(H.id)}}
// Grava o cofre já com os links novos (o 2º argumento força uma leitura fresca da fila,
// mesmo que esteja um auto-sync a decorrer).
try{await Pg(S,{})}catch{}
je.dismiss(id);
const res={ok:!falhou,total:pl.total,enviados,falhou,semVideo:pl.semVideo.length};
const msg=window.CineCloud.migrateSummary(res);
falhou?je.warning(msg,{id,duration:12e3}):je.success(msg,{id,duration:9e3});
return res}catch(Be){
je.dismiss(id);const ms=(Be==null?void 0:Be.message)||String(Be);
je.error(`⚠️ Migração interrompida: ${ms}`,{duration:12e3});
return{ok:!1,enviados,falhou,error:ms}}finally{CcMig=0}}
function Tg(){try{const r=localStorage.getItem(Jc);if(!r)return null;
REPL17

write tools/patches/18-migrar-button.find <<'FIND18'
d.jsxs(Ae,{variant:x?"default":"outline",size:"sm",onClick:()=>{h(N=>!N),v(!1)},className:"border-primary/40 text-primary hover:bg-primary/10",title:"Ativar Robô gratuito na nuvem para publicar nos horários exatos mesmo com PC e Celular desligados",children:[d.jsx(Kr,{className:"h-4 w-4"})," Robô 24h (PC Desligado)"]}),
FIND18

write tools/patches/18-migrar-button.replace <<'REPL18'
d.jsxs(Ae,{variant:"outline",size:"sm",onClick:()=>{const N=CcMigrarTodos();N&&N.then?N.then(()=>{u==null||u()},()=>{u==null||u()}):u==null||u()},className:"border-primary/40 text-primary hover:bg-primary/10",title:"Enviar para a nuvem durável (Google Drive ou R2) TODOS os vídeos desta fila que ainda estão só neste aparelho — incluindo os que ficaram com link temporário expirado",children:[d.jsx(Kr,{className:"h-4 w-4"})," Enviar todos p/ nuvem"]}),d.jsxs(Ae,{variant:x?"default":"outline",size:"sm",onClick:()=>{h(N=>!N),v(!1)},className:"border-primary/40 text-primary hover:bg-primary/10",title:"Ativar Robô gratuito na nuvem para publicar nos horários exatos mesmo com PC e Celular desligados",children:[d.jsx(Kr,{className:"h-4 w-4"})," Robô 24h (PC Desligado)"]}),
REPL18

echo "── 2/4  entradas no extract-patch-targets.mjs"
cat > /tmp/entradas-extractor.txt <<'ENTRADAS'
  // "Enviar todos p/ nuvem": a função fica mesmo antes de Tg() (o getter da sessão,
  // que ela usa) e o botão na barra de ações da fila, antes do "Robô 24h".
  "17-migrar-fn":
    "function Tg(){try{const r=localStorage.getItem(Jc);if(!r)return null;",
  "18-migrar-button": between(
    'd.jsxs(Ae,{variant:x?"default":"outline",size:"sm",onClick:()=>{h(N=>!N),v(!1)}',
    '" Robô 24h (PC Desligado)"]}),'
  ),
ENTRADAS
node <<'NODE_EXTRACT'
const fs = require("node:fs");
const p = "tools/extract-patch-targets.mjs";
let s = fs.readFileSync(p, "utf8");
if (s.includes('"17-migrar-fn"')) { console.log("   (já tem as entradas)"); }
else {
  const entradas = fs.readFileSync("/tmp/entradas-extractor.txt", "utf8").replace(/\n$/, "");
  const ancora = "\n};\n\nlet failed = 0;";
  if (s.split(ancora).length !== 2) throw new Error("âncora do mapa P não encontrada — o extractor mudou?");
  s = s.replace(ancora, "\n" + entradas + "\n};\n\nlet failed = 0;");
  fs.writeFileSync(p, s);
  console.log("   ✔ 2 entradas acrescentadas");
}
NODE_EXTRACT

echo "── 3/4  nuvem-duravel.js: helpers + v1.2.0"
cat > /tmp/helpers-migracao.js <<'HELPERS'
  /* ------------------------------------------------- migração em massa */

  /**
   * Este agendamento precisa de ir para a nuvem durável?
   * Só conta se este aparelho ainda tiver os bytes (videoBlob) — sem eles não há
   * nada para enviar e o item cai no grupo "semVideo".
   * Um item marcado com needsReupload volta a contar mesmo que já tenha link.
   */
  function needsCloudUpload(item) {
    if (!item || !item.videoBlob) return false;
    if (item.needsReupload) return true;
    return !isDurable(item.remoteVideoUrl || "");
  }

  /**
   * Divide a fila em três grupos (é o que o botão "Enviar todos p/ nuvem" usa):
   *   pending  — tem os bytes E o link não é durável (temporário, expirado ou vazio)
   *   naNuvem  — já está em armazenamento durável (R2/Drive)
   *   semVideo — não tem os bytes neste aparelho: só reimportando o .mp4
   */
  function migrationPlan(items) {
    var list = items && items.length ? items : [];
    var pending = [];
    var semVideo = [];
    var naNuvem = [];
    var i;
    for (i = 0; i < list.length; i++) {
      var it = list[i];
      if (!it) continue;
      if (needsCloudUpload(it)) pending.push(it);
      else if (isDurable(it.remoteVideoUrl || "")) naNuvem.push(it);
      else semVideo.push(it);
    }
    var bytes = 0;
    for (i = 0; i < pending.length; i++) {
      var b = pending[i].videoBlob;
      if (b && typeof b.size === "number" && b.size > 0) bytes += b.size;
    }
    return {
      total: list.length,
      pending: pending,
      semVideo: semVideo,
      naNuvem: naNuvem,
      bytes: bytes
    };
  }

  /** Mensagem final da migração, em português (é o que aparece no toast). */
  function migrateSummary(res) {
    var r = res || {};
    var enviados = Number(r.enviados) || 0;
    var falhou = Number(r.falhou) || 0;
    var semVideo = Number(r.semVideo) || 0;
    var parts = [enviados === 1 ? "1 vídeo na nuvem durável" : enviados + " vídeos na nuvem durável"];
    if (falhou) parts.push(falhou === 1 ? "1 com erro" : falhou + " com erros");
    if (semVideo) parts.push(semVideo + " sem vídeo neste aparelho");
    var msg = "☁️ Migração concluída: " + parts.join(", ") + ".";
    if (semVideo) msg += " Esses só voltam à nuvem se reimportares o .mp4 neste aparelho.";
    if (falhou && !enviados) msg += " Vê a Configurações → Testar ligação.";
    return msg;
  }
HELPERS
node <<'NODE_NUVEM'
const fs = require("node:fs");
const p = "nuvem-duravel.js";
let s = fs.readFileSync(p, "utf8");
if (s.includes("function migrationPlan(")) { console.log("   (já tem os helpers)"); }
else {
  const helpers = fs.readFileSync("/tmp/helpers-migracao.js", "utf8").replace(/\n$/, "") + "\n\n";
  let n = 0;
  const troca = (de, para) => {
    if (s.split(de).length !== 2) throw new Error("âncora não encontrada (única?): " + de.slice(0, 50));
    s = s.replace(de, () => para); n++;
  };
  troca('  var VERSION = "1.1.0";', '  var VERSION = "1.2.0";');
  troca("  /* ------------------------------------------------------------- export */", helpers + "  /* ------------------------------------------------------------- export */");
  troca("    isDurable: isDurable,", "    isDurable: isDurable,\n    needsCloudUpload: needsCloudUpload,\n    migrationPlan: migrationPlan,\n    migrateSummary: migrateSummary,");
  fs.writeFileSync(p, s);
  console.log("   ✔ " + n + " alterações");
}
NODE_NUVEM

echo "── 4/4  regenerar os bundles e validar"
npm run patch:full
node --check nuvem-duravel.js && echo "✔ nuvem-duravel.js sintaxe OK"
echo
echo "Pronto. Confirmação:"
grep -c "Enviar todos p/ nuvem" index.html app-pronto.html
echo "Agora: git add -A && git commit && git push"
