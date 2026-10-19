#!/usr/bin/env node
/**
 * Provedores de IA do motor: Gemini → Groq (+ Serper) → OpenRouter free (+ DuckDuckGo),
 * no bundle REAL (jsdom, como o servidor da nuvem) com todas as APIs simuladas.
 *
 *   • Gemini forte (2.5 Pro) só na pesquisa, com o Flash de reserva;
 *   • sem Gemini: Whisper (áudio → texto) + visão da Groq com até 3 quadros; pesquisa no Serper;
 *   • sem Serper: DuckDuckGo; sem Groq: OpenRouter (modelos :free descobertos na lista);
 *   • se o Gemini falha, a Groq assume; modelo da Groq com 429 passa para o seguinte;
 *   • o Serper cai no proxy do site quando a chamada direta falha (CORS);
 *   • ganchos aprendem com os exemplos do utilizador e a identificação com as correções;
 *   • o app já não conhece a NVIDIA.
 *
 *   node tools/test-provedores.mjs
 */
import fs from "node:fs";
import { arrancarApp } from "../servidor/app-headless.mjs";

let pass = 0, fail = 0;
const falhas = [];
const check = (n, ok, d = "") => { if (ok) { pass++; console.log(`   ✔ ${n}`); } else { fail++; falhas.push(n); console.log(`   ❌ ${n}${d ? " — " + d : ""}`); } };
const json = (corpo, status = 200) => new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });

const OBRAS = {
  "tv-58841": { kind: "tv", id: 58841, name: "Chicago P.D.", original_name: "Chicago P.D.", first_air_date: "2014-01-08", popularity: 300, overview: "Polícia de Chicago.", cast: [{ name: "Patrick Flueger", roles: [{ character: "Adam Ruzek" }] }, { name: "Tracy Spiridakos", roles: [{ character: "Hailey Upton" }] }] },
  "tv-44006": { kind: "tv", id: 44006, name: "Chicago Fire", original_name: "Chicago Fire", first_air_date: "2012-10-10", popularity: 400, overview: "Bombeiros.", cast: [{ name: "Taylor Kinney", roles: [{ character: "Kelly Severide" }] }] },
};
const PESQUISA = { "chicago p d": ["tv-58841"], "chicago pd": ["tv-58841"], "chicago fire": ["tv-44006"] };
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
const resumo = (k) => { const o = OBRAS[k]; return { id: o.id, name: o.name, original_name: o.original_name, first_air_date: o.first_air_date, popularity: o.popularity, overview: o.overview, poster_path: "/p.jpg" }; };
function tmdb(u) {
  const caminho = u.pathname.replace(/^\/3/, "");
  let m;
  if (caminho === "/search/tv") return { results: (PESQUISA[norm(u.searchParams.get("query"))] || []).map(resumo) };
  if (caminho === "/search/movie" || /^\/search\/person/.test(caminho)) return { results: [] };
  if ((m = /^\/(movie|tv)\/(\d+)\/(credits|aggregate_credits)$/.exec(caminho))) return { cast: (OBRAS[`${m[1]}-${m[2]}`] || {}).cast || [] };
  if ((m = /^\/(movie|tv)\/(\d+)$/.exec(caminho))) return { ...resumo(`${m[1]}-${m[2]}`), genres: [{ name: "Drama" }] };
  return {};
}

const PERCECAO = { falas: ["Ruzek, cobre a porta dos fundos!"], nomes_ouvidos: ["Ruzek", "Upton"], atores: [{ nome: "Patrick Flueger", certeza: 70 }], formato: "serie", roteiro: "Dois policiais invadem um apartamento à procura de um suspeito. A detetive encontra uma arma escondida no armário e o parceiro percebe que o suspeito fugiu pela janela.", momento_forte: "A detetive acha a arma", emocao: "tensão", palpites: [] };
const PESQ = { candidatos: [{ titulo: "Chicago P.D.", titulo_original: "Chicago P.D.", ano: 2014, tipo: "tv", confianca: 80 }, { titulo: "Chicago Fire", titulo_original: "Chicago Fire", ano: 2012, tipo: "tv", confianca: 60 }] };
const GANCHOS = { ganchos: ["A detetive achou a arma onde ninguém olhou 😳", "Ela abriu o armário e congelou na hora 😱", "O suspeito fugiu e deixou a arma para trás 😨", "Ninguém viu o que estava no armário 👀", "Ruzek percebeu tarde demais 😨"] };
const NOTAS = { notas: [{ i: 0, fiel: 9, curiosidade: 8, clareza: 9 }, { i: 1, fiel: 9, curiosidade: 9, clareza: 9 }] };

/* ------------------------------------------------------------ estado das APIs falsas */
let S;
function zerar(extra = {}) {
  S = {
    gemini: "ok", geminiUrls: [], groqChats: [], orChats: [], whisper: [], serper: [], ddg: 0, proxy: 0,
    groq429: new Set(), groqMaxImgs: 99, serperDireto: true, orModelos: true, ...extra,
  };
}
function resposta(texto) {
  if (/NÃO tente adivinhar o nome da obra/.test(texto)) return PERCECAO;
  if (/pesquisador de cinema e TV/.test(texto)) return PESQ;
  if (/descreva SÓ o que acontece/.test(texto)) return PERCECAO;
  if (/Escreva 10 ganchos diferentes/.test(texto)) return GANCHOS;
  if (/editor-chefe/.test(texto)) return NOTAS;
  return {};
}
const chat = (corpo) => json({ choices: [{ message: { content: JSON.stringify(corpo) } }] });
function textoDe(body) {
  const c = body.messages[0].content;
  return Array.isArray(c) ? c.filter((p) => p.type === "text").map((p) => p.text).join("\n") : c;
}
const DDG_HTML = `<div class="result"><a rel="nofollow" class="result__a" href="//x">Chicago P.D. &amp; elenco</a><a class="result__snippet" href="//x">Adam <b>Ruzek</b> e Hailey Upton são policiais.</a></div>
<div class="result"><a rel="nofollow" class="result__a" href="//y">Chicago P.D. (série)</a><a class="result__snippet" href="//y">Série de TV de 2014.</a></div>`;

async function bytes(corpo) {
  if (corpo == null) return Buffer.alloc(0);
  return Buffer.from(corpo);
}
const fetchFalso = async (url, opts = {}) => {
  const u = new URL(String(url));
  if (u.hostname === "api.themoviedb.org") return json(tmdb(u));
  if (u.hostname === "generativelanguage.googleapis.com") {
    if (/:generateContent$/.test(u.pathname)) {
      S.geminiUrls.push(u.pathname);
      if (S.gemini === "falha") return json({ error: { message: "boom" } }, 500);
      if (S.gemini === "cota") return json({ error: { message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" } }, 429);
      const corpo = JSON.parse(String(opts.body));
      if (/gemini-2\.5-pro/.test(u.pathname) && S.proFalha) return json({ error: { message: "quota" } }, 429);
      const texto = corpo.contents[0].parts.map((p) => p.text || "").join("\n");
      if (/Gera uma legenda para redes sociais/.test(texto)) return json({ candidates: [{ content: { parts: [{ text: "LEGENDA-GEMINI" }] } }] });
      return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(resposta(texto)) }] } }] });
    }
    return json({ models: [] });
  }
  if (u.hostname === "api.groq.com") {
    if (u.pathname.endsWith("/models")) return json({ data: ["whisper-large-v3-turbo", "whisper-large-v3", "openai/gpt-oss-120b", "llama-3.3-70b-versatile", "qwen/qwen3.8-27b", "canopylabs/orpheus-v1-english"].map((id) => ({ id })) });
    if (u.pathname.endsWith("/audio/transcriptions")) {
      const b = await bytes(opts.body);
      S.whisper.push({ auth: opts.headers.Authorization, tipo: opts.headers["Content-Type"], texto: b.toString("latin1") });
      return json({ text: "Ruzek, cobre a porta dos fundos!" });
    }
    if (u.pathname.endsWith("/chat/completions")) {
      const body = JSON.parse(String(opts.body));
      S.groqChats.push(body);
      if (S.groq429.has(body.model)) return json({ error: { message: "rate" } }, 429);
      const nImgs = Array.isArray(body.messages[0].content) ? body.messages[0].content.filter((p) => p.type === "image_url").length : 0;
      if (nImgs > S.groqMaxImgs) return json({ error: { message: "Request too large for model `qwen/qwen3.8-27b` on input tokens per minute (ITPM): Limit 6000" } }, 413);
      if (/Gera uma legenda para redes sociais/.test(textoDe(body))) return json({ choices: [{ message: { content: "LEGENDA-GROQ" } }] });
      return chat(resposta(textoDe(body)));
    }
  }
  if (u.hostname === "openrouter.ai") {
    if (u.pathname.endsWith("/models")) {
      if (!S.orModelos) return json({}, 500);
      return json({ data: [
        { id: "meta-llama/llama-3.3-70b-instruct:free", architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
        { id: "google/gemma-3-27b-it:free", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
        { id: "pago/modelo-caro", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
      ] });
    }
    if (u.pathname.endsWith("/chat/completions")) {
      const body = JSON.parse(String(opts.body));
      S.orChats.push({ ...body, auth: opts.headers.Authorization });
      return chat(resposta(textoDe(body)));
    }
    if (u.pathname.endsWith("/key")) return json({ data: { label: "ok" } });
  }
  if (u.hostname === "google.serper.dev") {
    if (!S.serperDireto) throw new TypeError("Failed to fetch (CORS)");
    S.serper.push({ chave: opts.headers["X-API-KEY"], q: JSON.parse(String(opts.body)).q });
    return json({ organic: [{ title: "Chicago P.D. – Wikipedia", snippet: "Ruzek e Upton integram a Intelligence Unit." }] });
  }
  if (u.hostname === "html.duckduckgo.com") { S.ddg++; return new Response(DDG_HTML, { status: 200 }); }
  if (u.pathname === "/api/public/ia") {
    S.proxy++;
    const p = JSON.parse(String(opts.body));
    S.serper.push({ chave: p.headers["X-API-KEY"], q: JSON.parse(p.body).q, viaProxy: true });
    return json({ organic: [{ title: "Chicago P.D.", snippet: "Ruzek e Upton." }] });
  }
  return json({});
};

const app = await arrancarApp({ site: "https://exemplo.test", fetchFn: fetchFalso });
const core = app.core;
const motor = app.window.CineClipMotor;
const QUADROS = ["data:image/jpeg;base64,AAAA", "data:image/jpeg;base64,BBBB", "data:image/jpeg;base64,CCCC", "data:image/jpeg;base64,DDDD", "data:image/jpeg;base64,EEEE"];
const AUDIO = { mimeType: "audio/wav", base64: Buffer.from("RIFFfake-audio-bytes").toString("base64") };
const ident = (opcoes = {}) => core.identificar("", QUADROS, "pt-BR", { identMode: "auto", fileName: "tiktok_74000.mp4", ...opcoes });

console.log("\n🚫 Sem NVIDIA");
{
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  check("o app não menciona NVIDIA nas configurações nem nas chamadas", !/api\/public\/nvidia|build\.nvidia\.com|integrate\.api\.nvidia/.test(html));
  check("o proxy da NVIDIA foi removido", !fs.existsSync(new URL("../server/nvidia-proxy.mjs", import.meta.url)) && !fs.existsSync(new URL("../api/public/nvidia.js", import.meta.url)));
}

console.log("\n🧠 Gemini forte na pesquisa");
{
  zerar();
  motor.configurar({});
  const ia = await ident({ geminiKey: "gem" });
  const filme = await core.procurarTmdb("tmdb", ia);
  const ordem = S.geminiUrls.map((p) => p.match(/models\/([^:]+)/)[1]);
  check("a perceção usa o modelo normal (Flash)", /flash/.test(ordem[0]), ordem.join(","));
  check("a pesquisa tenta o 2.5 Pro primeiro", ordem.some((m) => m === "gemini-2.5-pro"), ordem.join(","));
  check("e identifica Chicago P.D.", filme && filme.title === "Chicago P.D.", filme && filme.title);
  check("o modelo forte não fica ligado depois da pesquisa", app.window.__ccGeminiModelos === undefined);
  zerar({ proFalha: true });
  const ia2 = await ident({ geminiKey: "gem" });
  const f2 = await core.procurarTmdb("tmdb", ia2);
  check("se o Pro falhar (cota), o Flash assume e a identificação segue", f2 && f2.title === "Chicago P.D.", f2 && f2.title);
}

console.log("\n⚡ Groq + Serper (sem Gemini)");
{
  zerar();
  motor.configurar({ groqKey: "gsk_teste", serperKey: "serper-1" });
  const ia = await ident({ audioClip: AUDIO });
  const filme = await core.procurarTmdb("tmdb", ia);
  check("identifica Chicago P.D. só com Groq + Serper", filme && filme.title === "Chicago P.D." && ia.confianca >= 92, `${filme && filme.title} ${ia.confianca}`);
  check("o áudio vai para o Whisper (multipart, modelo turbo, chave certa)", S.whisper.length === 1 && S.whisper[0].auth === "Bearer gsk_teste" && /multipart\/form-data; boundary=/.test(S.whisper[0].tipo) && /whisper-large-v3-turbo/.test(S.whisper[0].texto) && /RIFFfake-audio-bytes/.test(S.whisper[0].texto) && /filename="audio\.wav"/.test(S.whisper[0].texto));
  const visao = S.groqChats.find((b) => Array.isArray(b.messages[0].content));
  check("a visão da Groq recebe no máximo 3 quadros", visao && visao.messages[0].content.filter((p) => p.type === "image_url").length === 3);
  check("usa o modelo de visão descoberto na lista (qwen), não um nome fixo", visao && visao.model === "qwen/qwen3.8-27b", visao && visao.model);
  check("a transcrição do Whisper entra no pedido de perceção", visao && /TRANSCRIÇÃO AUTOMÁTICA[\s\S]*Ruzek, cobre a porta/.test(textoDe(visao)));
  check("a perceção não vê o nome do ficheiro", visao && !/tiktok_74000/.test(textoDe(visao)));
  check("busca no Serper com a chave do utilizador, com as falas e nomes", S.serper.length >= 2 && S.serper.every((x) => x.chave === "serper-1") && S.serper.some((x) => /cobre a porta/.test(x.q)) && S.serper.some((x) => /Ruzek/.test(x.q)), JSON.stringify(S.serper));
  const pesq = S.groqChats.find((b) => /pesquisador de cinema/.test(textoDe(b)));
  check("a Groq lê os resultados da busca", pesq && /RESULTADOS DA BUSCA NA WEB[\s\S]*Intelligence Unit/.test(textoDe(pesq)));
  check("nenhuma chamada ao Gemini", S.geminiUrls.length === 0);
  check("o selo mostra o provedor", ia.provedor === "groq", ia.provedor);
}

console.log("\n📉 Groq 413 (limite de tokens por minuto) → menos quadros");
{
  zerar({ groqMaxImgs: 1 });
  motor.configurar({ groqKey: "gsk_teste", serperKey: "serper-1" });
  const ia = await ident({ audioClip: AUDIO });
  const filme = await core.procurarTmdb("tmdb", ia);
  const visoes = S.groqChats.filter((b) => Array.isArray(b.messages[0].content));
  const ns = visoes.map((b) => b.messages[0].content.filter((p) => p.type === "image_url").length);
  check("depois do 413 repete a visão com menos quadros (3 → 2 → 1)", ns.slice(0, 3).join() === "3,2,1", ns.join());
  check("e a identificação conclui na Groq", filme && filme.title === "Chicago P.D." && ia.provedor === "groq", `${filme && filme.title} ${ia.provedor}`);
}

console.log("\n🔁 Serper cai no proxy do site (CORS)");
{
  zerar({ serperDireto: false });
  motor.configurar({ groqKey: "gsk_teste", serperKey: "serper-1" });
  const ia = await ident({});
  const filme = await core.procurarTmdb("tmdb", ia);
  check("a busca passa pelo /api/public/ia e identifica", S.proxy >= 1 && S.serper.every((x) => x.viaProxy) && filme && filme.title === "Chicago P.D.", `${S.proxy} ${filme && filme.title}`);
}

console.log("\n🛟 Groq: modelo com 429 passa para o seguinte");
{
  zerar({ groq429: new Set(["openai/gpt-oss-120b"]) });
  motor.prov._interno.limpar();
  motor.configurar({ groqKey: "gsk_teste" });
  const ia = await ident({});
  const filme = await core.procurarTmdb("tmdb", ia);
  const texto = S.groqChats.filter((b) => !Array.isArray(b.messages[0].content));
  check("tenta o gpt-oss-120b, leva 429 e usa o llama-3.3", texto.some((b) => b.model === "openai/gpt-oss-120b") && texto.some((b) => b.model === "llama-3.3-70b-versatile"), texto.map((b) => b.model).join(","));
  check("e a identificação sai certa", filme && filme.title === "Chicago P.D.", filme && filme.title);
}

console.log("\n🌐 OpenRouter free + DuckDuckGo");
{
  zerar();
  motor.prov._interno.limpar();
  motor.configurar({ openrouterKey: "sk-or-teste" });
  const ia = await ident({});
  const filme = await core.procurarTmdb("tmdb", ia);
  check("identifica só com OpenRouter + DuckDuckGo", filme && filme.title === "Chicago P.D." && ia.provedor === "openrouter", `${filme && filme.title} ${ia.provedor}`);
  const visao = S.orChats.find((b) => Array.isArray(b.messages[0].content));
  check("visão: só modelos :free que aceitam imagem (descobertos na lista)", visao && visao.model === "google/gemma-3-27b-it:free" && /:free$/.test(visao.model), visao && visao.model);
  check("texto: modelo :free preferido, nunca um modelo pago", S.orChats.every((b) => /:free$/.test(b.model)) && S.orChats.some((b) => b.model === "meta-llama/llama-3.3-70b-instruct:free"));
  check("a chave vai no Authorization", S.orChats.every((b) => b.auth === "Bearer sk-or-teste"));
  check("sem Serper, usa o DuckDuckGo e lê o HTML", S.ddg >= 1);
  const pesq = S.orChats.find((b) => /pesquisador de cinema/.test(textoDe(b)));
  check("o título do resultado do DuckDuckGo chega limpo (sem &amp; nem tags)", pesq && /Chicago P\.D\. & elenco/.test(textoDe(pesq)) && /Adam Ruzek e Hailey Upton/.test(textoDe(pesq)) && !/<b>/.test(textoDe(pesq)));
}
{
  zerar({ orModelos: false });
  motor.prov._interno.limpar();
  motor.configurar({ openrouterKey: "sk-or-teste" });
  const ia = await ident({});
  const filme = await core.procurarTmdb("tmdb", ia);
  check("se a lista do OpenRouter falhar, usa os modelos :free de reserva", filme && filme.title === "Chicago P.D.", filme && filme.title);
}

console.log("\n↪️ Gemini falha → Groq assume");
{
  zerar({ gemini: "falha" });
  motor.prov._interno.limpar();
  motor.configurar({ groqKey: "gsk_teste" });
  const ia = await ident({ geminiKey: "gem" });
  const filme = await core.procurarTmdb("tmdb", ia);
  check("com o Gemini fora do ar, a Groq identifica", filme && filme.title === "Chicago P.D." && S.geminiUrls.length > 0 && S.groqChats.length > 0, `${filme && filme.title}`);
  check("o resultado diz porque trocou de provedor", /Gemini/.test(ia.provedor_motivo || ""), ia.provedor_motivo);
}
{
  zerar({ gemini: "cota" });
  motor.prov._interno.limpar();
  motor.configurar({ groqKey: "gsk_teste" });
  const ia = await ident({ geminiKey: "gem" });
  check("cota do Gemini esgotada → motivo «Gemini sem cota»", ia.provedor === "groq" && ia.provedor_motivo === "Gemini sem cota", `${ia.provedor} / ${ia.provedor_motivo}`);
}
{
  zerar();
  motor.prov._interno.limpar();
  motor.configurar({ groqKey: "gsk_teste" });
  const ia = await ident({});
  check("sem chave Gemini → motivo «sem chave Gemini»", ia.provedor_motivo === "sem chave Gemini", ia.provedor_motivo);
  const ia2 = await ident({ geminiKey: "gem" });
  check("com o Gemini a responder não há motivo de troca", ia2.provedor === "gemini" && !ia2.provedor_motivo, `${ia2.provedor} ${ia2.provedor_motivo}`);
}
{
  zerar();
  motor.configurar({ geminiBuscaForte: false });
  await ident({ geminiKey: "gem" });
  check("com «Gemini Pro» desmarcado a busca não usa o 2.5 Pro", S.geminiUrls.length > 0 && !S.geminiUrls.some((u) => /gemini-2\.5-pro/.test(u)), S.geminiUrls.join(" "));
  zerar();
  motor.configurar({ geminiBuscaForte: true });
  await ident({ geminiKey: "gem" });
  check("com «Gemini Pro» marcado a busca usa o 2.5 Pro", S.geminiUrls.some((u) => /gemini-2\.5-pro/.test(u)), S.geminiUrls.join(" "));
}

console.log("\n🔑 Sem nenhuma chave de IA");
{
  zerar();
  motor.configurar({});
  let msg = "";
  try { await ident({}); } catch (e) { msg = e.message; }
  check("pede Gemini, Groq ou OpenRouter", /Gemini.*Groq.*OpenRouter/.test(msg), msg);
}

console.log("\n🎣 Ganchos aprendem com os exemplos do utilizador");
{
  zerar();
  motor.prov._interno.limpar();
  motor.configurar({ groqKey: "gsk_teste", ganchosBons: "1. O policial achou o corpo e viu quem era 😳\n- Ela abriu o armário e congelou na hora 😱", ganchosRuins: "Você precisa ver essa cena!\nQue cena incrível" });
  const filme = { id: 58841, kind: "tv", title: "Chicago P.D.", year: "2014", overview: "Polícia.", genres: ["Crime"] };
  const roteiro = PERCECAO.roteiro;
  const g = await core.gerarGancho("", [], "pt-BR", filme, "", null, null, { cena: roteiro, momento: "A detetive acha a arma", hookMode: "auto" });
  const esc = S.groqChats.find((b) => /Escreva 10 ganchos/.test(textoDe(b)));
  check("os ganchos aprovados vão no pedido, sem numeração", esc && /APROVOU[\s\S]*- O policial achou o corpo e viu quem era 😳/.test(textoDe(esc)) && !/- 1\. O policial/.test(textoDe(esc)));
  check("os reprovados vão como «nunca escreva assim»", esc && /REPROVOU[\s\S]*Você precisa ver essa cena!/.test(textoDe(esc)));
  check("não copia um gancho aprovado para o resultado", !g.ganchos.some((x) => /congelou na hora/.test(x) && x === "Ela abriu o armário e congelou na hora 😱"), g.ganchos.join(" | "));
  check("sai gancho bom pela Groq", g.ganchos.length >= 2 && g.ganchos.every((x) => x.length <= 60), g.ganchos.join(" | "));
}

console.log("\n🧩 Aprende com a correção do utilizador");
{
  zerar();
  motor.configurar({ groqKey: "gsk_teste" });
  app.window.localStorage.removeItem("cineclip.motor.memoria");
  // O vídeo é Chicago P.D., mas a pesquisa insiste em Chicago Fire.
  const pesqOriginal = { ...PESQ };
  PESQ.candidatos = [{ titulo: "Chicago Fire", titulo_original: "Chicago Fire", ano: 2012, tipo: "tv", confianca: 95 }];
  PERCECAO.atores = [];
  PERCECAO.nomes_ouvidos = [];
  const nome = "Cena do armário - corte final.mp4";
  const ia1 = await ident({ fileName: nome });
  const f1 = await core.procurarTmdb("tmdb", ia1);
  check("antes de corrigir: erra para Chicago Fire", f1 && f1.title === "Chicago Fire", f1 && f1.title);
  const salvo = motor.aprender({ certo: { title: "Chicago P.D.", original: "Chicago P.D.", year: "2014", kind: "tv", id: 58841 }, errado: f1, arquivo: nome, ia: ia1 });
  check("«Não é esse» guarda a correção", salvo === true);
  const ia2 = await ident({ fileName: nome });
  const f2 = await core.procurarTmdb("tmdb", ia2);
  check("depois de corrigir: o mesmo vídeo vai direto para Chicago P.D.", f2 && f2.title === "Chicago P.D." && ia2.confianca >= 90, `${f2 && f2.title} ${ia2.confianca}`);
  const falasOriginais = PERCECAO.falas;
  PERCECAO.falas = ["Tem alguém dentro do carro, abaixa a arma agora!"];
  const ia3 = await ident({ fileName: "Outro vídeo qualquer 2.mp4" });
  PERCECAO.falas = falasOriginais;
  const f3 = await core.procurarTmdb("tmdb", ia3);
  check("outros vídeos não são afetados", f3 && f3.title === "Chicago Fire", f3 && f3.title);
  check("nome genérico (video.mp4) não vira regra", motor.aprender({ certo: { title: "X" }, arquivo: "video.mp4", ia: {} }) === false);
  Object.assign(PESQ, pesqOriginal);
}

console.log("\n📂 Nome do ficheiro");
{
  zerar();
  motor.prov._interno.limpar();
  motor.configurar({ groqKey: "gsk_teste" });
  app.window.localStorage.removeItem("cineclip.motor.memoria");
  const pesqOriginal = JSON.parse(JSON.stringify(PESQ));
  const percOriginal = JSON.parse(JSON.stringify(PERCECAO));
  // A IA acha que é Chicago Fire e não há atores/nomes no vídeo; o ficheiro diz Chicago P.D.
  PESQ.candidatos = [{ titulo: "Chicago Fire", titulo_original: "Chicago Fire", ano: 2012, tipo: "tv", confianca: 90 }];
  PERCECAO.atores = []; PERCECAO.nomes_ouvidos = []; PERCECAO.falas = ["Abaixa a arma agora!"];
  const ia = await ident({ fileName: "Chicago PD.mp4" });
  const f = await core.procurarTmdb("tmdb", ia);
  check("o título no nome do ficheiro ganha da IA quando o vídeo não prova outra obra", f && f.title === "Chicago P.D." && ia.confianca >= 85, `${f && f.title} ${ia.confianca}`);
  const pesq = S.groqChats.find((b) => /pesquisador de cinema/.test(textoDe(b)));
  check("a pesquisa recebe o nome do ficheiro como pista forte", pesq && /Nome do ficheiro: "Chicago PD"/.test(textoDe(pesq)) && /costuma ser o NOME DA OBRA/.test(textoDe(pesq)));
  // Mas se o elenco/personagens provam outra obra, as provas mandam.
  Object.assign(PERCECAO, JSON.parse(JSON.stringify(percOriginal)), { atores: [{ nome: "Patrick Flueger", certeza: 80 }], nomes_ouvidos: ["Ruzek", "Upton"], falas: ["Cobre a porta dos fundos, vai!"] });
  PESQ.candidatos = [{ titulo: "Chicago P.D.", titulo_original: "Chicago P.D.", ano: 2014, tipo: "tv", confianca: 90 }];
  zerar();
  const ia2 = await ident({ fileName: "Chicago Fire.mp4" });
  const f2 = await core.procurarTmdb("tmdb", ia2);
  check("com personagens e ator provando outra obra, o nome errado do ficheiro perde", f2 && f2.title === "Chicago P.D.", f2 && f2.title);
  Object.assign(PESQ, pesqOriginal);
  Object.assign(PERCECAO, percOriginal);
}

console.log("\n✍️ Legendas: a Groq escreve, o Gemini é reserva");
{
  const filme = { title: "Chicago P.D.", original: "Chicago P.D.", year: "2014", kind: "tv", genres: ["Crime"], overview: "Policiais de Chicago." };
  zerar();
  motor.prov._interno.limpar();
  motor.configurar({ groqKey: "gsk_teste" });
  const l1 = await core.gerarLegenda("gsk_teste", filme, "pt-BR", { cena: "interrogatório", geminiKey: "gem" });
  check("com Groq e Gemini, quem escreve a legenda é a Groq", /LEGENDA-GROQ/.test(l1) && S.geminiUrls.length === 0, l1);
  zerar({ groq429: new Set(["openai/gpt-oss-120b", "llama-3.3-70b-versatile", "qwen/qwen3.8-27b", "openai/gpt-oss-20b", "llama-3.1-8b-instant"]) });
  motor.prov._interno.limpar();
  motor.configurar({ groqKey: "gsk_teste" });
  const l2 = await core.gerarLegenda("gsk_teste", filme, "pt-BR", { cena: "interrogatório", geminiKey: "gem" });
  check("se a Groq falhar (limite), o Gemini escreve a legenda", /LEGENDA-GEMINI/.test(l2), l2);
  zerar();
  motor.prov._interno.limpar();
  motor.configurar({});
  const l3 = await core.gerarLegenda("", filme, "pt-BR", { cena: "x", geminiKey: "gem" });
  check("sem chave Groq/OpenRouter, o Gemini escreve", /LEGENDA-GEMINI/.test(l3), l3);
}

app.fechar();
console.log("\n─────────────────────────────────────────────");
if (fail) { console.log(`❌ ${pass} passaram, ${fail} falharam:`); falhas.forEach((f) => console.log("   • " + f)); process.exit(1); }
console.log(`✅ ${pass} passaram, 0 falharam`);
