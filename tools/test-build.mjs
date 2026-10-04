/**
 * Teste de build de produção: assets com hash no nome (sem regressão de cache)
 * e sem bundle inline gigante no HTML.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { check, section, finish } from "./test-helper.mjs";

const root = path.resolve(import.meta.dirname, "..");
execSync("npx vite build", { cwd: root, stdio: "inherit" });

const dist = path.join(root, "dist");
const html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
const assets = fs.readdirSync(path.join(dist, "assets"));

section("build de produção");
check("dist/index.html existe", html.length > 200, `${html.length} bytes`);
check("referencia JS com hash", /assets\/index-[A-Za-z0-9_-]+\.js/.test(html));
check("referencia CSS com hash", /assets\/index-[A-Za-z0-9_-]+\.css/.test(html));
check("sem bundle inline (>100 KB) no HTML", html.length < 100 * 1024, `${html.length} bytes`);
check("assets emitidos", assets.length >= 2, assets.join(", "));
const jsFile = assets.find((f) => /^index-.*\.js$/.test(f));
check("JS principal tem tamanho razoável (<2 MB)", fs.statSync(path.join(dist, "assets", jsFile)).size < 2 * 1024 * 1024);

finish();
