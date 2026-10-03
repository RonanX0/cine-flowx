#!/usr/bin/env node
/**
 * Repõe o bundle (index.html) no estado base, para o patch da nuvem poder ser
 * regenerado do zero e de forma determinística:
 *
 *   npm run patch:base       # repõe o bundle original
 *   npm run patch:extrair    # regenera os tools/patches/*.find a partir do base
 *   npm run patch:nuvem      # aplica os patches e verifica
 *
 * O commit base vem de CINECLIP_BASE_COMMIT (default: o commit onde a camada de
 * nuvem foi introduzida pela primeira vez).
 *
 * ⚠️ O commit base só existe em clones com histórico completo. Num clone
 * raso/achatado (um único commit) ele não existe e o `git show` rebenta. Nesses
 * casos caímos para o INDEX_POR_DEFECTO (o index.html tal como está no HEAD),
 * que é a melhor aproximação disponível — e dizemos isso ao utilizador em vez
 * de despejar um stack trace do Node.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const BASE = process.env.CINECLIP_BASE_COMMIT || "b6ebed853fae2fb1b5e9a138fb2af7f4cea4cfa3";

// Só existe um bundle. O antigo `app-pronto.html` era byte-idêntico ao
// index.html (mesmo md5) e só duplicava 514 KB no repo.
const FILES = ["index.html"];

/** `git show <rev>:<path>`, ou null se o rev não existir neste clone. */
function tryGitShow(rev, file) {
  try {
    return execFileSync("git", ["show", `${rev}:${file}`], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

const baseBundle = tryGitShow(BASE, "index.html");
let origem;

if (baseBundle) {
  origem = `commit base ${BASE.slice(0, 7)}`;
} else {
  // O commit base não está neste clone. A origem correcta é o index.html
  // tal como está versionado.
  const head = tryGitShow("HEAD", "index.html");
  if (!head) {
    console.error(
      `✖ Não consegui repôr o bundle.\n` +
        `  - o commit base ${BASE.slice(0, 7)} não existe neste clone, e\n` +
        `  - também não há index.html no HEAD.\n\n` +
        `  Se este clone é raso, deepen-o:  git fetch --unshallow\n` +
        `  Ou indique o commit certo:    CINECLIP_BASE_COMMIT=<sha> npm run patch:base`
    );
    process.exit(1);
  }
  origem = `HEAD (o commit base ${BASE.slice(0, 7)} não existe neste clone)`;
  console.warn(
    `⚠️  O commit base ${BASE.slice(0, 7)} não está neste repositório.\n` +
      `   A usar o index.html do HEAD como origem. Num clone raso faz\n` +
      `   "git fetch --unshallow" para ter o base verdadeiro.\n`
  );
}

const bundle = baseBundle || tryGitShow("HEAD", "index.html");
for (const file of FILES) {
  fs.writeFileSync(path.join(root, file), bundle);
  console.log(`✔ ${file} reposto a partir de ${origem} (${bundle.length} bytes)`);
}
console.log(`\nAgora: npm run patch:extrair && npm run patch:nuvem`);
