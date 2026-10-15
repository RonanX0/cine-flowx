#!/usr/bin/env node
/** A resposta da IA pode vir como texto puro, com cercas ```json ou cortada: nunca deve rebentar com "Unexpected token". */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const start = html.indexOf("function ccParseIaJson(");
const end = html.indexOf("async function Zb(", start);
if (start < 0 || end < 0) throw new Error("ccParseIaJson não está no bundle.");
const sandbox = {};
vm.runInNewContext(`${html.slice(start, end)}\nthis.parse = ccParseIaJson;`, sandbox);
const parse = (v) => JSON.parse(JSON.stringify(sandbox.parse(v)));

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  if (ok) { pass++; console.log(`   ✔ ${name}`); } else { fail++; console.log(`   ❌ ${name}${detail ? " — " + detail : ""}`); }
}

console.log("\n🧩 JSON da IA — tolerante a texto puro, cercas e respostas cortadas\n");
check("JSON válido passa intacto", parse('{"titulo":"Matrix","ano":1999}').titulo === "Matrix");
check("texto puro (\"Não consigo identificar…\") dá objeto vazio em vez de erro", Object.keys(parse("Não consigo identificar este clipe.")).length === 0);
check("resposta vazia ou nula dá objeto vazio", Object.keys(parse("")).length === 0 && Object.keys(parse(null)).length === 0);
check("cerca ```json é ignorada", parse('```json\n{"titulo":"Duna","confianca":90}\n```').confianca === 90);
check("texto antes e depois do JSON é ignorado", parse('Aqui vai: {"titulo":"Alien"} espero ter ajudado').titulo === "Alien");
const cortado = parse('{"titulo":"Interstellar","ano":2014,"confianca":88,"atores":["A","B"],"cena":"Ele chega ao pl');
check("JSON cortado mantém os campos completos", cortado.titulo === "Interstellar" && cortado.confianca === 88 && cortado.atores.length === 2, JSON.stringify(cortado));
const cortado2 = parse('{"titulo":"Tenet","alternativas":[{"titulo":"A","ano":1},{"titulo":"B","an');
check("JSON cortado dentro de um array é fechado", cortado2.titulo === "Tenet" && Array.isArray(cortado2.alternativas), JSON.stringify(cortado2));
check("vírgula e chaves dentro de strings não confundem o reparo", parse('{"fala":"olá, {mundo}, tudo bem","titulo":"X","ano":20').titulo === "X");
check("o parseResp usa o parser tolerante", html.includes("k=ccParseIaJson(raw)") && !html.includes("k=JSON.parse(m?m[0]:raw)"));
check("o Gemini é chamado em modo JSON quando não usa pesquisa", html.includes('responseMimeType:"application/json"'));
check("as três páginas estáticas continuam iguais", ["app-pronto.html", "404.html"].every((f) => fs.readFileSync(path.join(root, f), "utf8") === html));

console.log("");
if (fail) { console.log(`❌ ${pass} passaram, ${fail} falharam`); process.exit(1); }
console.log(`✅ ${pass} passaram, 0 falharam`);
