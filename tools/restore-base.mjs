#!/usr/bin/env node
/**
 * Repõe os bundles (index.html / app-pronto.html) no estado ORIGINAL do commit
 * base, para o patch da nuvem poder ser regenerado do zero e de forma
 * determinística:
 *
 *   npm run patch:base       # repõe os bundles originais
 *   npm run patch:extrair    # regenera os tools/patches/*.find a partir do base
 *   npm run patch:nuvem      # aplica os 16 patches e verifica
 *
 * O commit base vem de CINECLIP_BASE_COMMIT (default: o commit onde a camada de
 * nuvem foi introduzida pela primeira vez).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const BASE = process.env.CINECLIP_BASE_COMMIT || "b6ebed853fae2fb1b5e9a138fb2af7f4cea4cfa3";
const FILES = ["index.html", "app-pronto.html"];

function gitShow(file) {
  return execFileSync("git", ["show", `${BASE}:${file}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
}

for (const file of FILES) {
  const buf = gitShow(file);
  fs.writeFileSync(path.join(root, file), buf);
  console.log(`✔ ${file} reposto a partir de ${BASE.slice(0, 7)} (${buf.length} bytes)`);
}
console.log("\nAgora: npm run patch:extrair && npm run patch:nuvem");
