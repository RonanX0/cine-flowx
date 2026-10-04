#!/usr/bin/env node
/**
 * Testes do build estático: carimbo de versão e cache-busting.
 *
 * Porque é que isto é testado: o CineClip não tem src/ nem ficheiros com hash no nome.
 * O app inteiro é um `index.html` e a camada de nuvem é o `nuvem-duravel.js` — dois nomes
 * que se repetem em todos os deploys. Quando o build se limitava a copiá-los, o browser e
 * o CDN continuavam a servir a cópia anterior e as correções publicadas não chegavam ao
 * utilizador. Foi o que aconteceu com a correção do erro 2207077 do Instagram: estava no
 * repositório e verde nos testes, mas o erro que chegava ao utilizador vinha do bundle
 * pré-correção (sem "(código …)" e sem "· Dica:" na mensagem).
 *
 * Estes testes garantem que um deploy novo chega sempre ao browser:
 *   • o URL da camada de nuvem muda com o conteúdo (?v=<hash>);
 *   • o HTML traz `window.CINECLIP_BUILD` para se saber que versão está a correr;
 *   • o HTML publicado traz mesmo o bloco de publicação endurecido;
 *   • os três anfitriões (Netlify, Cloudflare Pages, Vercel) revalidam o HTML;
 *   • os ficheiros de origem ficam intactos, para `npm run patch:nuvem` continuar a achar
 *     a tag `<script src="nuvem-duravel.js"></script>` tal como está no repositório.
 *
 *   node tools/test-build-cache.mjs
 */
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");

let pass = 0;
let fail = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    pass++;
    console.log(`   ✔ ${name}`);
  } else {
    fail++;
    failures.push(name + (detail ? ` — ${detail}` : ""));
    console.log(`   ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const ler = (p) => fs.readFileSync(p, "utf8");
const hash = (buf) => crypto.createHash("sha256").update(buf).digest("hex").slice(0, 10);
const PAGINAS = ["index.html", "app-pronto.html", "404.html"];
const TAG_SIMPLES = '<script src="nuvem-duravel.js"></script>';

/* ------------------------------------------------------------------ 1. build */

console.log("\n1. O build corre e produz dist/");
let saida = "";
let rebentou = "";
try {
  saida = execFileSync("node", [path.join(root, "tools", "build-static.mjs")], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();
} catch (e) {
  rebentou = String((e && e.stderr) || e);
}
check("o build termina sem erro", !rebentou, rebentou.slice(0, 200));
check("dist/ foi criado", fs.existsSync(dist));
for (const f of [...PAGINAS, "nuvem-duravel.js", "_redirects", "_headers"]) {
  check(`dist/${f} existe`, fs.existsSync(path.join(dist, f)));
}
check("o build anuncia a versão", /versão \S+ · app \S+ · nuvem \S+/.test(saida), saida.trim().slice(-120));

/* --------------------------------------------------- 2. cache-busting da nuvem */

console.log("\n2. nuvem-duravel.js é servido com cache-busting");
const hashNuvem = hash(fs.readFileSync(path.join(dist, "nuvem-duravel.js")));
for (const f of PAGINAS) {
  const html = ler(path.join(dist, f));
  check(`${f}: a tag leva ?v=<hash>`, html.includes(`nuvem-duravel.js?v=${hashNuvem}`), `esperado ?v=${hashNuvem}`);
  check(`${f}: já não há a tag sem versão`, !html.includes(TAG_SIMPLES));
  check(`${f}: a camada de nuvem carrega antes do bundle`, html.indexOf("nuvem-duravel.js?v=") < html.indexOf('<script type="module">'));
}

/* O hash tem de acompanhar o conteúdo: é isso que invalida a cache num deploy novo. */
const hashReal = hash(fs.readFileSync(path.join(root, "nuvem-duravel.js")));
check("o hash no URL é o do ficheiro publicado", hashNuvem === hashReal, `${hashNuvem} ≠ ${hashReal}`);

/* ------------------------------------------------------- 3. carimbo de versão */

console.log("\n3. O HTML diz que versão está a correr");
for (const f of PAGINAS) {
  const html = ler(path.join(dist, f));
  const m = /window\.CINECLIP_BUILD=(\{.*?\});/.exec(html);
  check(`${f}: tem window.CINECLIP_BUILD`, !!m);
  if (!m) continue;
  let carimbo = null;
  try {
    carimbo = JSON.parse(m[1]);
  } catch (e) {
    /* fica null e o check abaixo falha */
  }
  check(`${f}: o carimbo é JSON válido`, !!carimbo, m[1].slice(0, 80));
  if (!carimbo) continue;
  check(`${f}: traz versão e data`, !!carimbo.versao && !!carimbo.data, JSON.stringify(carimbo));
  check(`${f}: o hash da nuvem bate certo`, carimbo.nuvem === hashNuvem, `${carimbo.nuvem} ≠ ${hashNuvem}`);
  check(`${f}: assinala a correção 2207077`, carimbo.ig2207077 === true, JSON.stringify(carimbo));
}

/* ------------------------------------- 4. o que vai para o ar traz a correção */

console.log("\n4. O HTML publicado traz mesmo o bloco de publicação corrigido");
for (const f of PAGINAS) {
  const html = ler(path.join(dist, f));
  check(`${f}: tem a tabela de dicas (IG_DICAS)`, html.includes("IG_DICAS"));
  check(`${f}: a mensagem de erro inclui o código`, html.includes('" (código "+numero+")"'));
  check(`${f}: tem o envio direto (resumable)`, html.includes("upload_type"));
  check(`${f}: o bloco de publicação está fechado`, html.includes("/* ==CINECLIP-IG-FIM== */"));
  /* O botão "Publicar agora" do Agendador não pode voltar a usar o ref do
     <input type="file"> (`oe`) como cadeado: esse ref está SEMPRE preenchido depois
     de o componente montar, o handler saía pelo `if(oe.current)return` e o clique
     não fazia nada (nem erro, nem pedido à Meta). O clique real é testado por
     tools/test-agendador-publish.mjs; aqui garante-se que o deploy publicado tem
     o cadeado dedicado. */
  check(`${f}: o cadeado de publicação tem ref próprio`, html.includes("ccPubLock=b.useRef(null)"));
  check(`${f}: o handler de publicar não usa o ref do input de ficheiro`, !html.includes("if(oe.current)return"));
}
const [a, b, c] = PAGINAS.map((f) => hash(fs.readFileSync(path.join(dist, f))));
check("as três páginas servem o mesmo app", a === b && b === c);

/* --------------------------------------------- 5. política de cache dos hosts */

console.log("\n5. Netlify, Cloudflare Pages e Vercel revalidam o HTML");
const headers = ler(path.join(dist, "_headers"));
check("_headers cobre o HTML", /\/\*\.html[\s\S]*?must-revalidate/.test(headers));
check("_headers cobre a raiz", /^\/$[\s\S]*?must-revalidate/m.test(headers));
check("_headers cobre a camada de nuvem", /\/nuvem-duravel\.js[\s\S]*?must-revalidate/.test(headers));

const netlify = ler(path.join(root, "netlify.toml"));
check("netlify.toml declara Cache-Control", netlify.includes("Cache-Control"));
check("netlify.toml revalida o HTML", /for = "\/\*\.html"[\s\S]*?must-revalidate/.test(netlify));
check("netlify.toml revalida a camada de nuvem", /for = "\/nuvem-duravel\.js"[\s\S]*?must-revalidate/.test(netlify));

let vercel = null;
try {
  vercel = JSON.parse(ler(path.join(root, "vercel.json")));
} catch (e) {
  /* fica null */
}
check("vercel.json é JSON válido", !!vercel);
check(
  "Vercel executa o build estático e publica dist/",
  !!vercel && vercel.buildCommand === "npm run build" && vercel.outputDirectory === "dist",
  vercel ? `buildCommand=${vercel.buildCommand}; outputDirectory=${vercel.outputDirectory}` : "configuração inválida"
);
const cabecalhosVercel = (vercel && vercel.headers) || [];
const regraVercel = cabecalhosVercel.find((h) => (h.headers || []).some((x) => x.key === "Cache-Control"));
check("vercel.json declara Cache-Control", !!regraVercel, JSON.stringify(cabecalhosVercel));
check(
  "vercel.json revalida o HTML",
  !!regraVercel && regraVercel.headers.some((x) => /must-revalidate/.test(x.value)),
  JSON.stringify(regraVercel)
);
check(
  "vercel.json não intercepta /api/",
  !!regraVercel && /\(\?!api\//.test(regraVercel.source),
  regraVercel ? regraVercel.source : ""
);

/* ------------------------------------------- 6. a origem continua a ser a origem */

console.log("\n6. Os ficheiros de origem ficam intactos (os patches dependem disso)");
for (const f of PAGINAS) {
  const fonte = ler(path.join(root, f));
  check(`${f}: mantém a tag sem versão no repositório`, fonte.includes(TAG_SIMPLES));
  check(`${f}: não ficou com o carimbo do build`, !fonte.includes("CINECLIP_BUILD"));
}

/* --------------------------------------------------------- 7. build defensivo */

console.log("\n7. O build recusa publicar um bundle sem a correção");
/* Simula exatamente a regressão que chegou ao utilizador: um bundle cuja mensagem de erro
   não traz o "(código …)" — o sinal de que o bloco endurecido não está lá. */
const guardado = ler(path.join(root, "index.html"));
const marcaDist = hash(fs.readFileSync(path.join(dist, "index.html")));
let recusou = false;
let mensagem = "";
try {
  fs.writeFileSync(path.join(root, "index.html"), guardado.replace('" (código "+numero+")"', '""'));
  try {
    execFileSync("node", [path.join(root, "tools", "build-static.mjs")], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    recusou = true;
    mensagem = String((e && e.stderr) || "");
  }
} finally {
  fs.writeFileSync(path.join(root, "index.html"), guardado);
}
check("o build falha se faltar a correção 2207077", recusou);
check("e explica como repor", /patch:nuvem/.test(mensagem), mensagem.slice(0, 160));
/* Falhar a meio seria pior: deixaria em dist/ um deploy parcial pronto a ir para o ar. */
check(
  "o dist/ anterior fica intacto quando o build recusa",
  fs.existsSync(path.join(dist, "index.html")) && hash(fs.readFileSync(path.join(dist, "index.html"))) === marcaDist
);

/* Deixa o dist/ coerente com o repositório reposto. */
execFileSync("node", [path.join(root, "tools", "build-static.mjs")], { cwd: root, stdio: "ignore" });

/* ------------------------------------------------------------------ resultado */

console.log("");
if (fail) {
  console.log(`❌ ${pass} passaram, ${fail} falharam`);
  for (const f of failures) console.log(`   · ${f}`);
  process.exit(1);
}
console.log(`✅ ${pass} passaram, 0 falharam`);
