#!/usr/bin/env node
/**
 * Build the checked-in, already-bundled CineClip app for static hosting.
 *
 * There is no src/ tree in this repository: index.html contains the compiled
 * application. Running Vite's bundler on that generated bundle tries to resolve
 * an obsolete FFmpeg worker URL, so production builds should copy the static
 * files as-is instead of attempting to bundle them a second time.
 *
 * ── Porque é que este script faz mais do que copiar ────────────────────────────
 * Um build Vite normal emite ficheiros com hash no nome (`app.a1b2c3.js`), por isso
 * cada deploy muda os URLs e o browser é obrigado a ir buscar o código novo. Aqui não:
 * o app inteiro vive dentro de `index.html` e a camada de nuvem em `nuvem-duravel.js`
 * — dois nomes que NUNCA mudam. Sem `Cache-Control` e sem cache-busting, o browser e o
 * CDN continuam a servir a cópia anterior, e correções já publicadas simplesmente não
 * chegam ao utilizador. Foi assim que a correção do erro 2207077 do Instagram ficou no
 * repositório, verde nos testes, mas ausente no browser (a mensagem de erro que chegava
 * era a do bundle antigo, sem "(código …)" nem "· Dica:").
 *
 * Para fechar essa porta, o build:
 *   1) carimba `window.CINECLIP_BUILD` no HTML (versão, data e hashes) e escreve-o na
 *      consola — dá para saber num relance que versão está mesmo a correr;
 *   2) serve `nuvem-duravel.js?v=<hash>` — o URL muda com o conteúdo, por isso o
 *      cache-busting funciona mesmo onde não se controlam cabeçalhos (GitHub Pages);
 *   3) publica `_headers` com `max-age=0, must-revalidate` para o HTML e para a camada
 *      de nuvem (lido pela Netlify e pela Cloudflare Pages; a Vercel usa vercel.json).
 *
 * Os ficheiros de origem ficam intactos: a reescrita acontece só no que vai para dist/,
 * para os patches do bundle (`npm run patch:nuvem`) continuarem a encontrar a tag
 * `<script src="nuvem-duravel.js"></script>` tal como está no repositório.
 */
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");
const appPath = path.join(root, "index.html");

/** Ficheiros HTML que recebem o carimbo de versão e o cache-busting. */
const PAGINAS = ["index.html", "app-pronto.html", "404.html"];
/** Ficheiros copiados tal e qual. */
const ESTATICOS = ["nuvem-duravel.js", "_redirects", "_headers"];

const TAG_NUVEM = '<script src="nuvem-duravel.js"></script>';

for (const file of [...PAGINAS, ...ESTATICOS]) {
  if (!fs.existsSync(path.join(root, file))) {
    throw new Error(`Arquivo necessário para o build não encontrado: ${file}`);
  }
}

const html = fs.readFileSync(appPath, "utf8");
if (!html.includes(TAG_NUVEM)) {
  throw new Error("index.html não carrega nuvem-duravel.js; a sincronização da nuvem não funcionará no deploy.");
}

const hash = (buf) => crypto.createHash("sha256").update(buf).digest("hex").slice(0, 10);

/** Versão legível: o commit do deploy quando existe, senão o hash do bundle. */
function descobrirVersao(fallback) {
  const doAmbiente =
    process.env.COMMIT_REF /* Netlify */ ||
    process.env.VERCEL_GIT_COMMIT_SHA /* Vercel */ ||
    process.env.CF_PAGES_COMMIT_SHA /* Cloudflare Pages */ ||
    process.env.GITHUB_SHA /* GitHub Actions */ ||
    "";
  if (doAmbiente) return String(doAmbiente).slice(0, 10);
  try {
    return execFileSync("git", ["rev-parse", "--short=10", "HEAD"], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return fallback;
  }
}

const hashNuvem = hash(fs.readFileSync(path.join(root, "nuvem-duravel.js")));
const hashApp = hash(html);
const versao = descobrirVersao(hashApp);
const data = new Date().toISOString();

/* O bloco de publicação endurecido contra o 2207077 anuncia-se: assim o carimbo diz se
   a versão a correr já traz a correção, sem ser preciso ler o bundle minificado.
   Publicar um bundle pré-correção é pior do que não publicar nada — o utilizador voltaria
   a apanhar o 2207077 sem repetição nem dica —, por isso o build pára já aqui, antes de
   mexer em dist/, para não deixar um deploy meio feito para trás. */
const temCorrecao2207077 = html.includes("IG_DICAS") && html.includes('" (código "+numero+")"');
if (!temCorrecao2207077) {
  throw new Error(
    "O bundle não traz a correção do erro 2207077 do Instagram; corre `npm run patch:nuvem` antes do build."
  );
}

const carimbo = {
  versao,
  data,
  app: hashApp,
  nuvem: hashNuvem,
  ig2207077: temCorrecao2207077,
};

/** `</script>` dentro de uma string fecharia a tag no parser do HTML. */
const paraHtml = (valor) => JSON.stringify(valor).replace(/<\//g, "<\\/");

const scriptCarimbo =
  `<script>window.CINECLIP_BUILD=${paraHtml(carimbo)};` +
  `try{console.info("CineClip · versão "+window.CINECLIP_BUILD.versao+" · "+window.CINECLIP_BUILD.data+` +
  `(window.CINECLIP_BUILD.ig2207077?" · correção 2207077 ativa":" · ATENÇÃO: sem a correção 2207077"))}catch(e){}</script>`;

function prepararPagina(fonte) {
  return fonte.replace(
    TAG_NUVEM,
    `${scriptCarimbo}\n    <script src="nuvem-duravel.js?v=${hashNuvem}"></script>`
  );
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

// O fallback 404 deve conter o mesmo app e a mesma camada de nuvem que a home.
for (const file of PAGINAS) {
  const source = file === "404.html" ? appPath : path.join(root, file);
  const pagina = prepararPagina(fs.readFileSync(source, "utf8"));
  if (pagina.includes(TAG_NUVEM)) {
    throw new Error(`${file}: a tag de nuvem não recebeu o cache-busting (?v=) — o deploy serviria código em cache.`);
  }
  fs.writeFileSync(path.join(dist, file), pagina);
}

for (const file of ESTATICOS) {
  fs.copyFileSync(path.join(root, file), path.join(dist, file));
}

const total = PAGINAS.length + ESTATICOS.length;
console.log(`Build estático pronto em dist/ (${total} arquivos).`);
console.log(`   versão ${versao} · app ${hashApp} · nuvem ${hashNuvem}`);
console.log("   correção 2207077 no bundle: sim");
