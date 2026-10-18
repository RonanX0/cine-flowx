#!/usr/bin/env node
/**
 * Identificação «Rápido por Nome» e análise dos ganchos (patches 67–72), no bundle REAL
 * (jsdom, como o servidor da nuvem) com a IA e o TMDB simulados.
 *
 *   • modo «dica» com um título legível no nome do ficheiro/dica: NÃO chama nenhuma IA
 *     (antes reanalisava quadros e diálogo e ainda contrariava o nome);
 *   • sem título legível (VID_2024…), o modo «dica» não adivinha — segue para a IA;
 *   • os outros modos continuam a chamar a IA;
 *   • ganchos: o prompt pede a análise da cena e notas; o de nota mais alta vem primeiro.
 *
 *   node tools/test-identificar.mjs
 */
import { arrancarApp } from "../servidor/app-headless.mjs";

let pass = 0, fail = 0;
const falhas = [];
const check = (n, ok, d = "") => { if (ok) { pass++; console.log(`   ✔ ${n}`); } else { fail++; falhas.push(n); console.log(`   ❌ ${n}${d ? " — " + d : ""}`); } };

const chamadas = [];
let respostaIA = "";
const json = (corpo) => new Response(JSON.stringify(corpo), { status: 200, headers: { "content-type": "application/json" } });
const fetchFalso = async (url, opts) => {
  const u = String(url);
  chamadas.push(u);
  if (/generativelanguage|\/api\/public\/nvidia/.test(u)) {
    const corpo = opts && opts.body ? String(opts.body) : "";
    ultimoPedido = corpo;
    if (/generativelanguage/.test(u)) return json({ candidates: [{ content: { parts: [{ text: respostaIA }] } }] });
    return json({ choices: [{ message: { content: respostaIA } }] });
  }
  return json({});
};
let ultimoPedido = "";
const ia = () => chamadas.filter((u) => /generativelanguage|\/api\/public\/nvidia/.test(u)).length;

const app = await arrancarApp({ site: "https://exemplo.test", fetchFn: fetchFalso });
const core = app.core;
const pedir = (opcoes) => core.identificar("nv-key", [], "pt-BR", { geminiKey: "gem-key", ...opcoes });

console.log("\n⚡ Modo «Rápido por Nome» não chama a IA");
{
  chamadas.length = 0;
  let r = await pedir({ identMode: "dica", fileName: "Interestelar 2014.mp4" });
  check("nome do ficheiro com título e ano → resposta direta", r.titulo === "Interestelar" && String(r.ano) === "2014" && r.provedor === "dica", JSON.stringify({ t: r.titulo, a: r.ano, p: r.provedor }));
  check("nenhuma chamada à IA (Gemini/NVIDIA)", ia() === 0, String(ia()));
  check("sem ganchos de enchimento (o gancho vem depois, com o filme)", Array.isArray(r.ganchos) && r.ganchos.length === 0, JSON.stringify(r.ganchos));
  r = await pedir({ identMode: "dica", userHint: "O Lobo de Wall Street", fileName: "video.mp4" });
  check("dica digitada → direto", r.titulo === "O Lobo de Wall Street" && ia() === 0, r.titulo);
}

console.log("\n🧠 Sem título legível, ou outros modos: a IA continua a trabalhar");
{
  respostaIA = JSON.stringify({ titulo: "Duna", titulo_original: "Dune", ano: 2021, confianca: 90, atores: [], personagens: [], cena: "x", ganchos: [], alternativas: [] });
  chamadas.length = 0;
  let r = await pedir({ identMode: "dica", fileName: "VID_20240101.mp4" });
  check("nome sem título (VID_…) → não adivinha, usa a IA", ia() >= 1 && r.titulo === "Duna", `${ia()} ${r.titulo}`);
  chamadas.length = 0;
  r = await pedir({ identMode: "auto", fileName: "Interestelar 2014.mp4" });
  check("modo IA completa continua a usar a IA", ia() >= 1, String(ia()));
}

console.log("\n🎣 Ganchos: análise da cena + nota");
{
  respostaIA = JSON.stringify({
    analise: { momento: "ele abre a porta", emocao: "medo", gatilho: "o que há lá dentro?", visual: "porta vermelha" },
    cena: "Ele abre uma porta",
    ganchos: [{ texto: "Ele abriu a porta errada 😨", nota: 6 }, { texto: "Havia algo atrás da porta vermelha 😱", nota: 9 }, { texto: "Ninguém devia ter ouvido isso 👀", nota: 7 }],
  });
  const g = await core.gerarGancho("nv-key", ["m", "q"], "pt-BR", "Filme X", "gem-key", null, null, { sinopse: "Uma casa." });
  check("o de nota mais alta vem primeiro", g.ganchos[0] === "Havia algo atrás da porta vermelha 😱", JSON.stringify(g.ganchos));
  check("devolve a análise (emoção, gatilho…)", g.analise && g.analise.emocao === "medo");
  const prompt = JSON.parse(ultimoPedido).contents[0].parts[0].text;
  check("o prompt pede análise antes e notas rigorosas", /ANÁLISE ANTES DE ESCREVER/.test(prompt) && /seja rigoroso/.test(prompt) && /"gatilho"/.test(prompt));
  respostaIA = JSON.stringify({ cena: "c", ganchos: ["Ele achou que estava seguro até ouvir isso 😳", "Ela sabia de tudo desde o começo 👀"] });
  const g2 = await core.gerarGancho("nv-key", ["m", "q"], "pt-BR", "Filme X", "gem-key", null, null, {});
  check("formato antigo (só texto) continua a funcionar, na mesma ordem", g2.ganchos[0] === "Ele achou que estava seguro até ouvir isso 😳", JSON.stringify(g2.ganchos));
}

app.fechar();
console.log("\n─────────────────────────────────────────────");
if (fail) { console.log(`❌ ${pass} passaram, ${fail} falharam:`); falhas.forEach((f) => console.log("   • " + f)); process.exit(1); }
console.log(`✅ ${pass} passaram, 0 falharam`);
