#!/usr/bin/env node
/** Regressões de qualidade e segurança para os ganchos que alimentam o campo do Estúdio. */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(root, "tools", "viral-hooks", "viral-hooks.template.js"), "utf8");
const sandbox = {};
vm.runInNewContext(`${source}\nthis.normalizeViralHooks = ccNormalizeViralHooks;`, sandbox);
const normalize = sandbox.normalizeViralHooks;

let pass = 0;
let fail = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) {
    pass++;
    console.log(`   ✔ ${name}`);
  } else {
    fail++;
    failures.push(name + (detail ? ` — ${detail}` : ""));
    console.log(`   ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("\n🪝 Ganchos virais — qualidade, deduplicação e campo de texto\n");

const normalized = normalize([
  " 1. “A porta estava fechada até ele ouvir o nome 😱”\n",
  "• a PORTA estava fechada até ele ouvir o nome 😱",
  "Ela encontrou a carta que ninguém devia ler 🔥",
  null,
  { text: "não deve virar [object Object]" },
]);
check("remove numeração, bullets, aspas e quebras de linha sem alterar o gancho", normalized[0] === "A porta estava fechada até ele ouvir o nome 😱", normalized[0]);
check("remove sugestões repetidas ignorando maiúsculas e acentos", normalized.length === 2, JSON.stringify(normalized));
check("ignora valores que poderiam corromper o input controlado", normalized.every((hook) => typeof hook === "string" && !hook.includes("[object Object]")));
check("mantém as sugestões em uma única linha", normalized.every((hook) => !/[\r\n\t]/.test(hook)));
check("mantém até três sugestões distintas", normalize([
  "Ele abriu a porta e ouviu uma voz conhecida 😳",
  "Ela escondeu a carta durante todos aqueles anos 🔥",
  "O detetive percebeu tarde demais quem mentia 😱",
  "A testemunha revelou o segredo que mudou tudo 🤯",
]).length === 3);
check("não devolve chamadas genéricas nem campos vazios", normalize([
  "Você precisa assistir esse filme",
  "Assista até o final",
  "Ninguém estava preparado para o que acontece nessa cena 😳",
  "   ",
  "Gancho 1 😳",
  "🔥",
]).length === 0);

check("recusa hashtags, menções e a palavra spoiler", normalize([
  "Ele abriu a porta e ouviu uma voz conhecida #filme 😳",
  "Ela falou com @alguem sobre o segredo antigo 🔥",
  "Spoiler: o detetive percebeu quem mentia o tempo todo 😱",
]).length === 0);
check("recusa clichês novos de elogio vazio", normalize([
  "Essa cena é simplesmente incrível demais 😱",
  "Melhor cena do filme inteiro sem dúvida 🔥",
  "Plot twist que ninguém viu chegando 😳",
]).length === 0);
const comEmoji = normalize(["A porta estava fechada até ele ouvir o nome 😱😱🔥", "Quem mandou aquela carta para a velha casa?"]);
check("termina sempre com exatamente um emoji", comEmoji.every((hook) => (hook.match(/\p{Extended_Pictographic}/gu) || []).length === 1 && /\p{Extended_Pictographic}$/u.test(hook)), JSON.stringify(comEmoji));
check("acrescenta o emoji que a IA esqueceu", comEmoji.some((hook) => hook.startsWith("Quem mandou aquela carta") && hook.endsWith("😳")), JSON.stringify(comEmoji));
const reordenado = normalize([
  "Ele descobre que o irmão morre no final do filme 😱",
  "Por que ela escondeu a chave debaixo do tapete? 😳",
]);
check("passa à frente a opção que não entrega o desfecho", reordenado[0].startsWith("Por que ela escondeu"), JSON.stringify(reordenado));
const cheio = normalize(["A verdade daquela noite finalmente aparece para todos e muda tudo o que eles acreditavam 😳"]);
check("o limite de 64 conta o emoji e o espaço", cheio.length === 1 && Array.from(new Intl.Segmenter("pt", { granularity: "grapheme" }).segment(cheio[0])).length <= 64, JSON.stringify(cheio));

const long = normalize(["A verdade daquela noite finalmente aparece para todos e muda tudo o que eles acreditavam ".repeat(4) + "😳"]);
const graphemes = long[0] && typeof Intl.Segmenter === "function"
  ? Array.from(new Intl.Segmenter("pt", { granularity: "grapheme" }).segment(long[0])).length
  : Array.from(long[0] || "").length;
check("limita ganchos longos a 64 caracteres para caber no campo/overlay", !!long[0] && graphemes <= 64, `${graphemes} caracteres`);
check("nunca corta um par surrogate ao limitar o texto", long.every((hook) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(hook)));

const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
check("o bundle usa o normalizador antes de devolver sugestões", html.includes("ganchos: ccNormalizeViralHooks(candidates)"));
check("a identificação principal também protege os ganchos", html.includes("ganchos:Array.isArray(k.ganchos)?ccNormalizeViralHooks(k.ganchos):void 0"));
check("o prompt pede ganchos curtos, específicos e sem promessas falsas",
  html.includes("5 a 9 palavras") && html.includes("64 caracteres") && html.includes("sem inventar nem prometer um desfecho"));
check("o gancho com a obra confirmada corre em segundo plano (não trava a identificação)",
  html.includes("Xa&&ne.length===0&&Hm(S.nvidiaKey,Ue,S.lang,{titulo:Xa.title") && !html.includes("const gh=await Hm("));
const generatedHookPatch = fs.readFileSync(path.join(root, "tools", "patches", "41-viral-hooks.replace"), "utf8").trim();
check("o patch gerado corresponde ao template mantido", generatedHookPatch === source.trim());
const legacyUpdater = fs.readFileSync(path.join(root, "tools", "update-identificador.py"), "utf8");
check("o atualizador legado também usa o template e os patches de ganchos",
  legacyUpdater.includes('viral_source = Path("tools/viral-hooks/viral-hooks.template.js")')
  && legacyUpdater.includes('42-viral-hook-shape.replace')
  && legacyUpdater.includes('43-viral-hook-prompt.replace'));
check("as três páginas estáticas mantêm o mesmo bundle", ["app-pronto.html", "404.html"].every((file) =>
  fs.readFileSync(path.join(root, file), "utf8") === html));

console.log("");
if (fail) {
  console.log(`❌ ${pass} passaram, ${fail} falharam`);
  for (const failure of failures) console.log(`   · ${failure}`);
  process.exit(1);
}
console.log(`✅ ${pass} passaram, 0 falharam`);
