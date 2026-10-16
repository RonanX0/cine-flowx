#!/usr/bin/env node
/**
 * Testes das melhorias de:
 * 1. Ganchos virais (formato, estilo e geração)
 * 2. Identificação de filmes (VidScio engine, pontuação TMDB e tolerância do parser)
 * 3. Corte de formato 9:16 (centralização, fundo preto cinematográfico e preservação de vídeos verticais)
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

let pass = 0;
let fail = 0;
function check(nome, ok, detalhe = "") {
  if (ok) {
    pass++;
    console.log(`   ✔ ${nome}`);
  } else {
    fail++;
    console.log(`   ❌ ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
  }
}

console.log("\n🎬 Testes de Ganchos Virais, Identificação e Corte de Formato\n");

// -----------------------------------------------------------------------------
// 1. Corte de formato (Eh)
// -----------------------------------------------------------------------------
console.log("1. Corte de Formato 9:16 e Dimensões");
{
  const modulo = /<script type="module">([\s\S]*?)<\/script>/.exec(html)[1];
  const ehMatch = modulo.match(/function Eh\(r,o,a,i=720\)\{[\s\S]*?return\{outWidth[\s\S]*?\}\}/);
  if (!ehMatch) throw new Error("Função Eh não encontrada no bundle.");

  const ctx = vm.createContext({ Math, Number });
  vm.runInContext(ehMatch[0], ctx);

  // Vídeo 16:9 (1920x1080) -> deve ser centralizado em 720x1280 com margem vertical equilibrada
  const r169 = ctx.Eh(1920, 1080, null, 720);
  check("16:9 largura total 720", r169.videoW === 720);
  check("16:9 altura proporcional ~406", r169.videoH >= 404 && r169.videoH <= 406);
  check("16:9 centralizado verticalmente (padY ~402)", r169.padY >= 390 && r169.padY <= 415, `padY=${r169.padY}`);
  check("16:9 sem deslocamento horizontal", r169.padX === 0);

  // Vídeo já vertical 9:16 (1080x1920) -> deve ocupar a tela toda sem encolher nem criar barras
  const r916 = ctx.Eh(1080, 1920, null, 720);
  check("9:16 ocupa 100% da largura (720)", r916.videoW === 720);
  check("9:16 ocupa 100% da altura (1280)", r916.videoH === 1280);
  check("9:16 sem bordas (padX=0, padY=0)", r916.padX === 0 && r916.padY === 0);

  // Vídeo ultra-widescreen 2.39:1 (1920x804)
  const r239 = ctx.Eh(1920, 804, null, 720);
  check("2.39:1 centralizado verticalmente", r239.padY > 430 && r239.padY < 460, `padY=${r239.padY}`);
}

// -----------------------------------------------------------------------------
// 2. Fundo preto cinematográfico no FFmpeg e Preview
// -----------------------------------------------------------------------------
console.log("\n2. Estética Cinematográfica (Fundo Preto)");
{
  check("FFmpeg processa com fundo preto (pad=...:black)", html.includes(":black,setsar=1"));
  check("FFmpeg não usa mais fundo branco (:white)", !html.includes(":white,setsar=1"));
  check("Preview 9:16 usa container preto (bg-black)", html.includes('aspect-[9/16] w-full overflow-hidden rounded-xl border border-border bg-black'));
}

// -----------------------------------------------------------------------------
// 3. Renderização e Ganchos Virais
// -----------------------------------------------------------------------------
console.log("\n3. Ganchos Virais e Tipografia Moderna");
{
  check("Gancho padrão não é o clichê genérico", !html.includes('overlayText:"Você precisa assistir esse filme 😳"'));
  check("Renderizador _h usa tipografia em negrito 900", html.includes('900 ${g}px "Inter", "Montserrat"'));
  check("Renderizador _h usa badge de alto contraste com cantos arredondados", html.includes('rgba(10, 10, 14, 0.78)'));
  check("Renderizador _h usa texto branco puro com sombra", html.includes('#FFFFFF') && html.includes('shadowColor="rgba(0, 0, 0, 0.9)"'));

  // Prompt do Hm deve conter fórmulas virais comprovadas
  check("Prompt do Hm ensina quebra de expectativa", html.includes("QUEBRA DE EXPECTATIVA"));
  check("Prompt do Hm ensina tensão extrema e dilema", html.includes("TENSÃO EXTREMA"));
  check("Prompt do Hm proíbe frases vazias genéricas", html.includes('NUNCA use frases vazias como "Você precisa assistir esse filme"'));
}

// -----------------------------------------------------------------------------
// 4. Identificação de Filmes (VidScio Engine e TMDB)
// -----------------------------------------------------------------------------
console.log("\n4. Motor de Identificação e TMDB");
{
  // _vsParseIA tolerante a markdown
  const parseMatch = html.match(/function _vsParseIA\(v,x\)\{[\s\S]*?return\{[\s\S]*?\}\;[\s\n]*\}/);
  check("Parser tolerante a JSON com blocos markdown", html.includes("```json"));
  check("Parser limpa vírgulas extras no JSON", html.includes('raw=raw.replace(/,\\s*([}\\]])/g,"$1")'));

  // Multi-frame Gemini
  check("Gemini recebe múltiplos frames nítidos em vez de cortar", html.includes("frames.length>=4?frames.slice(1):frames"));

  // Áudio até 120MB
  check("Limite de áudio aceita filmes de até 120MB", html.includes("r.size>120*1024*1024"));
  check("Timeout de áudio estendido para 12s", html.includes('setTimeout(()=>j(new Error("audio timeout")),12000)'));

  // Pontuação TMDB: título exato deve vencer ator coincidente
  check("Título exato original recebe pontuação dominante (+145)", html.includes("if(x&&(D===x||O===x))T+=145"));
  check("Título exato em português recebe pontuação dominante (+135)", html.includes("else if(h&&(O===h||D===h))T+=135"));
  check("Pontuação de ator calibrada para não sobrepor título (+45 max)", html.includes("T+=(ac.actorMatches||1)>=2?45:25"));
}

console.log("\n─────────────────────────────────────────────");
if (fail) {
  console.log(`❌ ${pass} passaram, ${fail} falharam`);
  process.exit(1);
}
console.log(`✅ ${pass} passaram, 0 falharam`);
