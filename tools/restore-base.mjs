#!/usr/bin/env node
/**
 * Restores the original, unpatched bundles before regenerating the cloud patch.
 *
 * If the historical base commit is available, it is the source of truth. Some
 * checkouts (including shallow clones) do not contain that git object, so this
 * script can also reconstruct the baseline by reversing the versioned patches
 * from the current index.html/app-pronto.html. The reverse is validated by
 * reapplying every patch in order before any file is written.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const BASE = process.env.CINECLIP_BASE_COMMIT || "b6ebed853fae2fb1b5e9a138fb2af7f4cea4cfa3";
const FILES = ["index.html", "app-pronto.html"];
const patchDir = path.join(root, "tools", "patches");
const stripOneNewline = (text) => (text.endsWith("\n") ? text.slice(0, -1) : text);
const count = (text, needle) => text.split(needle).length - 1;

function gitShow(file) {
  return execFileSync("git", ["show", `${BASE}:${file}`], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function readPatches() {
  const names = fs.readdirSync(patchDir)
    .filter((file) => file.endsWith(".find"))
    .map((file) => file.replace(/\.find$/, ""))
    .sort();
  if (!names.length) throw new Error("Nenhum patch .find encontrado em tools/patches.");
  return names.map((name) => ({
    name,
    find: stripOneNewline(fs.readFileSync(path.join(patchDir, `${name}.find`), "utf8")),
    replace: stripOneNewline(fs.readFileSync(path.join(patchDir, `${name}.replace`), "utf8")),
  }));
}

function reconstructFromCurrent(file, patches) {
  const current = fs.readFileSync(path.join(root, file), "utf8");
  let base = current;
  for (const patch of patches.slice().reverse()) {
    const matches = count(base, patch.replace);
    if (matches !== 1) {
      throw new Error(`${file}: não dá para reverter ${patch.name} (${matches} ocorrências do replace; esperava 1).`);
    }
    base = base.replace(patch.replace, () => patch.find);
  }

  let rebuilt = base;
  for (const patch of patches) {
    const matches = count(rebuilt, patch.find);
    if (matches !== 1) {
      throw new Error(`${file}: baseline reconstruída não contém ${patch.name} uma única vez (${matches}).`);
    }
    rebuilt = rebuilt.replace(patch.find, () => patch.replace);
  }
  if (rebuilt !== current) {
    throw new Error(`${file}: validar a reconstrução falhou; nenhum ficheiro foi alterado.`);
  }
  return base;
}

const patches = readPatches();
let restored = {};
try {
  for (const file of FILES) restored[file] = gitShow(file);
  console.log(`Bundle original lido do git (${BASE.slice(0, 7)}).`);
} catch {
  console.warn(`Commit base ${BASE.slice(0, 7)} não está disponível; reconstruindo a versão-base a partir dos patches atuais.`);
  for (const file of FILES) restored[file] = reconstructFromCurrent(file, patches);
}

// Calcular e validar tudo antes de gravar evita deixar os bundles em estados
// diferentes se uma das cópias não puder ser reconstruída.
for (const file of FILES) {
  fs.writeFileSync(path.join(root, file), restored[file]);
  console.log(`✔ ${file} restaurado (${Buffer.byteLength(restored[file])} bytes)`);
}
fs.copyFileSync(path.join(root, "index.html"), path.join(root, "404.html"));
console.log("✔ 404.html sincronizado com index.html");
console.log("\nAgora: npm run patch:extrair && npm run patch:nuvem");
