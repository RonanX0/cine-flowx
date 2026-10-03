#!/usr/bin/env node
/**
 * Build the checked-in, already-bundled CineClip app for static hosting.
 *
 * There is no src/ tree in this repository: index.html contains the compiled
 * application. Running Vite's bundler on that generated bundle tries to resolve
 * an obsolete FFmpeg worker URL, so production builds should copy the static
 * files as-is instead of attempting to bundle them a second time.
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");
const files = ["index.html", "app-pronto.html", "404.html", "nuvem-duravel.js", "_redirects"];
const appPath = path.join(root, "index.html");

for (const file of files) {
  if (!fs.existsSync(path.join(root, file))) {
    throw new Error(`Arquivo necessário para o build não encontrado: ${file}`);
  }
}

const html = fs.readFileSync(appPath, "utf8");
if (!html.includes('<script src="nuvem-duravel.js"></script>')) {
  throw new Error("index.html não carrega nuvem-duravel.js; a sincronização da nuvem não funcionará no deploy.");
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

// O fallback 404 deve conter o mesmo app e a mesma camada de nuvem que a home.
for (const file of files) {
  const destination = file === "404.html" ? "404.html" : file;
  const source = file === "404.html" ? appPath : path.join(root, file);
  fs.copyFileSync(source, path.join(dist, destination));
}

console.log(`Build estático pronto em dist/ (${files.length} arquivos).`);
