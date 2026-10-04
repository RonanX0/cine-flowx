#!/usr/bin/env node
/**
 * Aplica o patch "nuvem durável (Cloudflare R2)" ao bundle do CineClip.
 *
 *   node tools/apply-cloud-patch.mjs            # aplica em index.html e app-pronto.html
 *   node tools/apply-cloud-patch.mjs --dry      # só verifica
 *   node tools/apply-cloud-patch.mjs --verify   # aplica + valida sintaxe do bundle e do Robô 24h
 *
 * O repo não tem src/ (só o build), por isso o patch é feito sobre o ficheiro
 * compilado. Cada substituição vive em tools/patches/NN-nome.find|.replace para
 * ser exata, revisável e reproduzível (regenera os .find com
 * tools/extract-patch-targets.mjs).
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const patchDir = path.join(root, "tools", "patches");
const targets = ["index.html", "app-pronto.html"];
const argv = process.argv.slice(2);
const dry = argv.includes("--dry");
const verify = argv.includes("--verify");

const stripOneNewline = (s) => (s.endsWith("\n") ? s.slice(0, -1) : s);
const readPatch = (name) => ({
  find: stripOneNewline(fs.readFileSync(path.join(patchDir, name + ".find"), "utf8")),
  replace: stripOneNewline(fs.readFileSync(path.join(patchDir, name + ".replace"), "utf8")),
});

const names = fs
  .readdirSync(patchDir)
  .filter((f) => f.endsWith(".find"))
  .map((f) => f.replace(/\.find$/, ""))
  .sort();

console.log(`\n☁️  Patch nuvem durável — ${names.length} substituições\n`);

let totalApplied = 0;
let totalSkipped = 0;

for (const file of targets) {
  const filePath = path.join(root, file);
  if (!fs.existsSync(filePath)) {
    console.log(`⚠️  ${file} não existe — ignorado.`);
    continue;
  }
  let html = fs.readFileSync(filePath, "utf8");
  const originalLength = html.length;
  console.log(`── ${file} (${originalLength} bytes)`);

  for (const name of names) {
    const { find, replace } = readPatch(name);
    const countOf = (hay, needle) => hay.split(needle).length - 1;

    // 1) Já aplicado? (alguns .replace CONTÊM o .find, por isso esta verificação
    //    tem de vir primeiro — senão o patch era aplicado em duplicado)
    if (countOf(html, replace) >= 1) {
      totalSkipped++;
      console.log(`   ⏭  ${name} (já aplicado)`);
      continue;
    }

    // 1b) Absorvido por um patch posterior? (ex.: o 21-sync-queue reescreve a
    //     zona que o 08-j-catch já tinha alterado — o .find do 21 contém o
    //     .replace do 08). Se esse patch posterior já está aplicado, o 08 também.
    const absorbedBy = names
      .filter((later) => later > name)
      .find((later) => {
        const lp = readPatch(later);
        return lp.find.includes(replace) && countOf(html, lp.replace) >= 1;
      });
    if (absorbedBy) {
      totalSkipped++;
      console.log(`   ⏭  ${name} (já incluído em ${absorbedBy})`);
      continue;
    }

    // 2) O alvo tem de existir exatamente 1x
    const occurrences = countOf(html, find);
    if (occurrences !== 1) {
      throw new Error(
        `${file}: patch "${name}" tem ${occurrences} ocorrências (esperava 1). ` +
          `O bundle mudou? Regenera os .find com tools/extract-patch-targets.mjs.`
      );
    }

    html = html.replace(find, () => replace);

    // 3) Confirma que ficou exatamente 1x
    if (countOf(html, replace) !== 1) {
      throw new Error(`${file}: patch "${name}" aplicado mas o resultado não é único.`);
    }
    totalApplied++;
    console.log(`   ✔ ${name}`);
  }

  if (!dry && html !== fs.readFileSync(filePath, "utf8")) {
    fs.writeFileSync(filePath, html);
    console.log(`   💾 gravado (${html.length} bytes, ${html.length - originalLength >= 0 ? "+" : ""}${html.length - originalLength})\n`);
  } else {
    console.log(`   ${dry ? "(dry-run)" : "(sem alterações)"}\n`);
  }
}

// O 404 do GitHub Pages é outro ponto de entrada para o app; mantê-lo igual à
// home impede que usuários de rotas de fallback recebam um bundle antigo.
const indexPath = path.join(root, "index.html");
const fallbackPath = path.join(root, "404.html");
if (fs.existsSync(indexPath) && fs.existsSync(fallbackPath)) {
  const indexHtml = fs.readFileSync(indexPath, "utf8");
  const fallbackHtml = fs.readFileSync(fallbackPath, "utf8");
  if (indexHtml !== fallbackHtml) {
    if (dry) console.log("\n(404.html seria sincronizado com index.html)");
    else {
      fs.copyFileSync(indexPath, fallbackPath);
      console.log("\n✔ 404.html sincronizado com index.html");
    }
  }
}

console.log(`Aplicadas: ${totalApplied} · Já presentes: ${totalSkipped}`);

if (!verify) {
  if (!dry) console.log("\nDica: corre com --verify para validar a sintaxe do bundle e do Robô 24h.");
  process.exit(0);
}

/* ------------------------------------------------------------ verificação */

console.log("\n── Verificação");

if (fs.readFileSync(path.join(root, "404.html"), "utf8") !== fs.readFileSync(indexPath, "utf8")) {
  console.error("   ❌ 404.html está diferente de index.html");
  process.exitCode = 1;
} else {
  console.log("   ✔ 404.html: fallback sincronizado com index.html");
}

function extractModuleScript(html) {
  const start = html.indexOf('<script type="module">');
  if (start < 0) throw new Error("script module não encontrado");
  const from = start + '<script type="module">'.length;
  const end = html.indexOf("</script>", from);
  return html.slice(from, end);
}

for (const file of targets) {
  const filePath = path.join(root, file);
  if (!fs.existsSync(filePath)) continue;
  const html = fs.readFileSync(filePath, "utf8");
  const code = extractModuleScript(html);
  const tmp = path.join(root, "tools", `.syntax-${file.replace(/\W/g, "_")}.mjs`);
  fs.writeFileSync(tmp, code);
  try {
    execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
    console.log(`   ✔ ${file}: sintaxe do bundle OK (${code.length} bytes de módulo)`);
  } catch (err) {
    console.error(`   ❌ ${file}: erro de sintaxe\n${err.stderr?.toString().slice(0, 2000)}`);
    process.exitCode = 1;
  } finally {
    fs.rmSync(tmp, { force: true });
  }

  if (!html.includes('<script src="nuvem-duravel.js"></script>')) {
    console.error(`   ❌ ${file}: falta a inclusão do nuvem-duravel.js`);
    process.exitCode = 1;
  } else {
    console.log(`   ✔ ${file}: nuvem-duravel.js incluído antes do bundle`);
  }

  // Gera o código do Robô 24h e valida a sintaxe do resultado
  const ksStart = html.indexOf("function kS(r){");
  const ksEnd = html.indexOf("`}function ES(", ksStart);
  if (ksStart > 0 && ksEnd > ksStart) {
    // inclui o "`}"  final para termos a declaração completa da função kS
    const ksSource = html.slice(ksStart, ksEnd + 2);
    try {
      const makeKs = new Function(
        "Eg",
        `${ksSource}; return kS;`
      );
      const kS = makeKs(() => ({
        r2WorkerUrl: "https://cineclip-cloud.exemplo.workers.dev/",
        r2Token: "cc_r2_token_de_teste",
      }));
      const gas = kS({
        username: "teste@exemplo.com",
        vaultHash: "abc123def456",
        encryptionKeyB64: "QUJDREVG",
      });
      const tmpGas = path.join(root, "tools", `.robo-24h-${file.replace(/\W/g, "_")}.js`);
      fs.writeFileSync(tmpGas, gas);
      execFileSync(process.execPath, ["--check", tmpGas], { stdio: "pipe" });
      console.log(`   ✔ ${file}: Robô 24h gerado e com sintaxe OK (${gas.length} bytes)`);
      if (!gas.includes("R2_WORKER_URL = \"https://cineclip-cloud.exemplo.workers.dev\"")) {
        console.error(`   ❌ ${file}: o Robô 24h não recebeu a URL do Worker`);
        process.exitCode = 1;
      }
      fs.rmSync(tmpGas, { force: true });
    } catch (err) {
      console.error(`   ❌ ${file}: falha no Robô 24h\n${err.stderr?.toString().slice(0, 2000) || err.message}`);
      process.exitCode = 1;
    }
  } else {
    console.error(`   ❌ ${file}: função kS (Robô 24h) não encontrada`);
    process.exitCode = 1;
  }
}

// Sintaxe da camada de nuvem e do Worker
for (const f of ["nuvem-duravel.js", "cloudflare/r2-worker.js", "apps-script/cineclip-cloud-drive.js", "tools/mock-r2-worker.mjs", "tools/mock-drive-backend.mjs", "tools/dev-server.mjs", "tools/restore-base.mjs", "tools/test-cinecloud.mjs", "tools/test-r2-worker.mjs"]) {
  const p = path.join(root, f);
  if (!fs.existsSync(p)) continue;
  try {
    execFileSync(process.execPath, ["--check", p], { stdio: "pipe" });
    console.log(`   ✔ ${f}: sintaxe OK`);
  } catch (err) {
    console.error(`   ❌ ${f}:\n${err.stderr?.toString().slice(0, 1500)}`);
    process.exitCode = 1;
  }
}

console.log(process.exitCode ? "\n❌ Verificação com erros." : "\n✅ Tudo verificado.");
