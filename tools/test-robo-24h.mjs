#!/usr/bin/env node
/**
 * Guarda da publicação AUTOMÁTICA (Robô 24h).
 *
 * Houve uma versão do CineClip em que a publicação passou a ser só manual
 * ("device-only"): o gerador do Robô 24h foi substituído por um stub que apagava
 * o acionador do Apps Script, as claims saíram do bloco de publicação e a fila
 * passou a sincronizar-se como `device_scheduled`. Nada disso se via nos testes
 * da altura — o robô simplesmente deixou de publicar.
 *
 * Este teste fecha essa porta: gera o Robô 24h a partir do bundle (o mesmo código
 * que o botão "1. Copiar Código do Robô 24h" copia) e exige que ele seja o robô a
 * sério — acionador de 5 min, Graph API, claims — e que o bundle não contenha
 * nenhum vestígio do modo só-manual.
 *
 *   node tools/test-robo-24h.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");

let pass = 0;
let fail = 0;
const failures = [];

function check(nome, condicao, detalhe) {
  if (condicao) {
    pass++;
    console.log(`   ✔ ${nome}`);
  } else {
    fail++;
    failures.push(nome + (detalhe ? ` — ${detalhe}` : ""));
    console.log(`   ❌ ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
  }
}

for (const file of ["index.html", "app-pronto.html", "404.html"]) {
  const h = fs.readFileSync(path.join(root, file), "utf8");
  if (h.length) continue;
}

const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

/* ------------------------------------------------- 1. o gerador do Robô 24h */
console.log("\n1. O bundle gera o Robô 24h ( Apps Script )");

const ksStart = html.indexOf("function kS(r){");
const ksEnd = html.indexOf("`}function ES(", ksStart);
check("a função kS (gerador do Robô 24h) existe no bundle", ksStart > 0 && ksEnd > ksStart);
if (ksStart < 0 || ksEnd <= ksStart) {
  console.log(`\n❌ ${pass} passaram, ${fail} falharam`);
  process.exit(1);
}
const ksSource = html.slice(ksStart, ksEnd + 2);

let gas = "";
try {
  const kS = new Function(
    "Eg",
    `${ksSource}; return kS;`
  )(() => ({
    r2WorkerUrl: "https://cineclip-cloud.exemplo.workers.dev/",
    r2Token: "cc_r2_token_de_teste",
    driveScriptUrl: "https://script.google.com/macros/s/ABC/exec",
    driveToken: "cc_drive_token_de_teste",
  }));
  gas = kS({
    username: "teste@exemplo.com",
    vaultHash: "abc123def456",
    encryptionKeyB64: "QUJDREVG",
  });
} catch (err) {
  console.log(`   ❌ o gerador do Robô 24h rebentou — ${err.message}`);
  console.log(`\n❌ ${pass} passaram, ${fail + 1} falharam`);
  process.exit(1);
}

check("gera código não vazio", gas.length > 5000, `${gas.length} bytes`);
check("não é o stub que só desativa o robô", !/function ativarRobo24h\(\)\s*\{\s*desativarRobo24h\(\);\s*\}/.test(gas));
check("não é o stub que só apaga o acionador", !/function verificarEPostarReels\(\)\s*\{\s*desativarRobo24h\(\);\s*\}/.test(gas));

const tmp = path.join(root, "tools", ".robo-24h-teste.js");
let sintaxeOk = true;
let erroSintaxe = "";
try {
  fs.writeFileSync(tmp, gas);
  execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
} catch (err) {
  sintaxeOk = false;
  erroSintaxe = String(err.stderr || err.message).slice(0, 400);
} finally {
  fs.rmSync(tmp, { force: true });
}
check("o Robô 24h gerado tem sintaxe válida", sintaxeOk, erroSintaxe);

/* --------------------------------------- 2. publica sozinho, com PC desligado */
console.log("\n2. O robô publica sozinho (PC e telemóvel desligados)");

check("cria o acionador de 5 em 5 minutos", /ScriptApp\.newTrigger\(\s*"verificarEPostarReels"\s*\)/.test(gas) && /everyMinutes\(5\)/.test(gas));
check("a função do acionador existe e publica", /function verificarEPostarReels\(\)/.test(gas) && /publicarMetaGraphApi\(/.test(gas));
check("fala com a Graph API (media / media_publish)", gas.includes('/" + igId + "/media"') && gas.includes('/" + igId + "/media_publish"'));
check("vai buscar a fila à nuvem (UrlFetchApp)", gas.includes("UrlFetchApp.fetch"));
check("usa o endereço do Worker R2 configurado", gas.includes('R2_WORKER_URL = "https://cineclip-cloud.exemplo.workers.dev"'));
check("marca o resultado na fila (published / error)", gas.includes('"published"') && gas.includes('"error"'));

/* -------------------------------------------------- 3. anti-publicação dupla */
console.log("\n3. Claims: o robô e o app não publicam o mesmo Reel");

check("pede a claim antes de publicar", gas.includes("/api/claims/acquire") || /action:\s*"claim"/.test(gas));
check("liberta a claim no fim (sucesso ou erro)", /libertarReclamacao\(/.test(gas));
check("ignora um Reel já reclamado por outrem", /ocupado/.test(gas) && /claim/.test(gas));
check("degrada com segurança se o backend não tiver claims", /claimsIndisponiveis/.test(gas));

/* ------------------------------------------- 4. o bundle não está em modo manual */
console.log("\n4. O bundle não está em modo «só no dispositivo»");

check("a publicação do app usa claims", html.includes("renovarClaim"));
check("avisa quando outro aparelho/Robô está a publicar", html.includes("Outro aparelho ou o Robô 24h está a publicar"));
check("sem o comentário «Publicação apenas no dispositivo»", !html.includes("Publicação apenas no dispositivo"));
check("sem o aviso de desativação do robô", !html.includes("A publicação automática funciona apenas enquanto"));
check("a fila continua a gravar-se como «scheduled» (a versão só-manual reescrevia para device_scheduled)", !html.includes('?"device_scheduled":'));
check("a aba Robô 24h oferece o botão de instalação", html.includes("Copiar Código do Robô 24h"));

/* ---------------------------- 5. fila gravada pela versão «só no dispositivo» */
console.log("\n5. Migração: fila gravada como device_scheduled volta à fila do robô");

check(
  "o robô aceita um Reel guardado como device_scheduled",
  /item\.status !== "scheduled" && item\.status !== "device_scheduled"/.test(gas)
);
{
  // Lê-se o SS do bundle (o mesmo bloco que o patch 05 instala) e corre-se num
  // contexto vm com a camada de nuvem falsa — a fila vem com device_scheduled.
  const i0 = html.indexOf("async function SS(r){");
  const i1 = html.indexOf("let Oa=null,", i0);
  check("a função SS (leitura do cofre) existe no bundle", i0 > 0 && i1 > i0);
  if (i0 > 0 && i1 > i0) {
    const fonte = html.slice(i0, i1);
    const fila = {
      queue: [
        { id: "r1", title: "Reel antigo", status: "device_scheduled" },
        { id: "r2", title: "Publicado", status: "published" },
        { id: "r3", title: "Com erro", status: "error" },
      ],
    };
    const contexto = vm.createContext({
      window: {
        CineCloud: {
          getVaultCipher: async () => ({ data: JSON.stringify(fila) }),
          markReadFailure() {},
          log() {
            return null;
          },
        },
      },
      Gm: async (v) => JSON.parse(v),
      fetch: async () => ({ ok: false }),
    });
    vm.runInContext(fonte + ";this.api={SS}", contexto);
    let lido = null;
    try {
      lido = await contexto.api.SS({});
    } catch (err) {
      console.log(`   ❌ a leitura do cofre rebentou — ${err.message}`);
      fail++;
    }
    check("device_scheduled volta a «scheduled»", !!lido && lido.queue[0].status === "scheduled", lido && JSON.stringify(lido.queue[0]));
    check("não mexe nos outros estados", !!lido && lido.queue[1].status === "published" && lido.queue[2].status === "error");
    check("o Robô 24h volta a ver esse Reel na fila", !!lido && lido.queue[0].status === "scheduled" && gas.includes('item.status !== "scheduled"'));
  }
}

/* ------------------------------------------------- 6. as três páginas iguais */
console.log("\n6. Home, app-pronto.html e 404 servem o mesmo robô");

for (const file of ["app-pronto.html", "404.html"]) {
  const outro = fs.readFileSync(path.join(root, file), "utf8");
  check(`${file}: igual a index.html (mesmo Robô 24h)`, outro === html);
}

/* -------------------------------------------------------------------- fim */
if (failures.length) {
  console.log("\nFalhas:");
  for (const f of failures) console.log(`  • ${f}`);
}
console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passaram, ${fail} falharam`);
process.exit(fail === 0 ? 0 : 1);
