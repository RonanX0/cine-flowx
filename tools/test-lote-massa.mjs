#!/usr/bin/env node
/**
 * Testes do upload em massa (lote-massa.js).
 *
 *   node tools/test-lote-massa.mjs
 *
 * Parte A — a lógica do lote com a IA, o FFmpeg e a fila falsos: o que entra na
 *           fila do Agendador, o corte em 90 s, o gancho da IA, a confiança baixa,
 *           o vídeo H.265, as chaves em falta e o botão Parar.
 * Parte B — o bundle REAL num DOM (jsdom + IndexedDB falso): a ponte
 *           window.CineClipCore / window.__CineClipApp existe, o botão "Upload em
 *           massa" abre o painel, escolher vários ficheiros abre o lote, e um lote
 *           com a IA/FFmpeg falsos grava os Reels na fila verdadeira (IndexedDB) nos
 *           horários livres certos.
 *
 * Precisa de jsdom e fake-indexeddb (npm install --no-save jsdom fake-indexeddb);
 * sem eles, o teste é saltado.
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const LOTE = fs.readFileSync(path.join(root, "lote-massa.js"), "utf8");

let JSDOM, fakeIndexedDB, IDBKeyRange;
try {
  ({ JSDOM } = await import("jsdom"));
  ({ indexedDB: fakeIndexedDB, IDBKeyRange } = await import("fake-indexeddb"));
} catch {
  console.log("\n⚠️  jsdom/fake-indexeddb não estão instalados — teste do upload em massa saltado.\n" +
    "   Corre: npm install --no-save jsdom fake-indexeddb\n");
  process.exit(0);
}

let pass = 0;
let fail = 0;
const failures = [];
function check(nome, ok, detalhe = "") {
  if (ok) {
    pass++;
    console.log(`   ✔ ${nome}`);
  } else {
    fail++;
    failures.push(nome);
    console.log(`   ❌ ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(desc, fn, timeout = 8000) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`Tempo esgotado à espera de: ${desc}`);
    await sleep(25);
  }
}

/* ======================================================================
   Parte A — lógica com dependências falsas
   ====================================================================== */

function novoDom() {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url: "http://localhost/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  dom.window.URL.createObjectURL = () => "blob:stub";
  dom.window.URL.revokeObjectURL = () => {};
  dom.window.eval(fs.readFileSync(path.join(root, "motor-ia.js"), "utf8"));
  dom.window.eval(LOTE);
  return dom;
}

/** Ficheiro falso: o nome decide o comportamento dos falsos. */
function ficheiro(window, nome, bytes = 4096) {
  return new window.File([new Uint8Array(Math.min(bytes, 64))], nome, { type: "video/mp4" });
}

function cenario(window, opcoes = {}) {
  const fila = [];
  const chamadas = { processar: [], identificar: 0, gerarGancho: 0, sincronizar: 0, atualizarFila: 0, historico: 0, cancelar: 0 };
  const slots = ["12:00", "18:00"];
  let travarProcessamento = null;

  const duracoes = { "longo.mp4": 120, "curto.mp4": 40, "sem-gancho.mp4": 70, "duvida.mp4": 60, "parar.mp4": 50, "depois.mp4": 50, "hevc.mp4": 60 };

  const core = {
    lerMetadados: async (f) => ({ duration: duracoes[f.name] || 30, fields: [{ label: "Título", value: "meta-" + f.name }] }),
    detetarBarras: async () => ({ y: 100, h: 800, vh: 1080 }),
    quadros: async () => ["data:image/jpeg;base64,AAA"],
    audio: async () => null,
    videoParaIA: async (f, ini, fim) => {
      chamadas.videoParaIA = (chamadas.videoParaIA || 0) + 1;
      return { data: new Uint8Array([1, 2, 3]), mimeType: "video/mp4", ini: ini || 0, fim: fim || 0 };
    },
    identificar: async (chave, quadros, lang, info) => {
      chamadas.identificar++;
      chamadas.videoRecebido = info.video || null;
      const nome = info.fileName;
      if (info.identMode === "dica") return { titulo: "Nome Estranho", confianca: 88, provedor: "dica", ganchos: [] };
      if (nome === "duvida.mp4") return { titulo: "Talvez Este", confianca: 50, cena: "cena incerta", ganchos: ["Gancho incerto 🤔"] };
      if (nome === "sem-gancho.mp4") return { titulo: "Sem Gancho", confianca: 90, cena: "", ganchos: [] };
      return { titulo: "Filme " + nome, confianca: 92, cena: "cena de " + nome, ganchos: ["Gancho de " + nome + " 😳", "outro"] };
    },
    procurarTmdb: async (chave, ia) => ia.titulo === "Nome Estranho" ? null : ({ title: ia.titulo, original: ia.titulo + " (orig)", year: 2024, poster: "https://img/p.jpg", kind: "movie", genres: [], overview: "" }),
    gerarGancho: async (chave, quadros, lang, titulo, geminiKey, audio, video) => {
      chamadas.gerarGancho++;
      chamadas.videoGancho = video || null;
      // O gancho agora é feito depois do TMDB, com o filme certo (o título chega como 4.º argumento).
      if (/^Filme /.test(String(titulo))) return { cena: "cena gerada", ganchos: ["Gancho de " + String(titulo).replace(/^Filme /, "") + " 😳"] };
      return { cena: "cena gerada", ganchos: ["Gancho gerado 🔥"] };
    },
    processar: async (f, inicio, fim, resolucao, gancho, progresso, corte) => {
      chamadas.processar.push({ nome: f.name, inicio, fim, resolucao, gancho, corte });
      progresso(0.5);
      if (f.name === "parar.mp4") {
        await new Promise((resolve, reject) => {
          travarProcessamento = { resolve, reject };
        });
      }
      progresso(1);
      return new window.Blob([new Uint8Array(100)], { type: "video/mp4" });
    },
    cancelarProcessamento: () => {
      chamadas.cancelar++;
      if (travarProcessamento) travarProcessamento.reject(new Error("terminated"));
    },
    gerarLegenda: async (chave, filme, lang, extra) => `**${filme.title}** — ${extra.hookText}`,
    limparLegenda: (t) => t.replace(/\*\*(.+?)\*\*/g, "$1").trim(),
    proximoHorario: (filaAtual, horarios, conta) => {
      const n = filaAtual.filter((it) => it.accountId === conta).length;
      const dia = 14 + Math.floor(n / horarios.length);
      return `2026-10-${dia}T${horarios[n % horarios.length]}`;
    },
    guardarNaFila: async (reel) => { fila.push(reel); },
    lerFila: async () => fila.slice(),
    guardarHistorico: () => { chamadas.historico++; },
    ganchoPadrao: "O que acontece nessa cena deixou todo mundo em choque 😳",
  };
  const app = {
    settings: Object.assign({ groqKey: "nv-key", geminiKey: "", tmdbKey: "tmdb-key", lang: "pt-BR", resolution: "720", overlayText: "Texto padrão" }, opcoes.settings || {}),
    account: { id: "acc_cena", name: "@cena.oculta", dailySlots: slots },
    accounts: [],
    atualizarFila: () => { chamadas.atualizarFila++; },
    sincronizar: async () => { chamadas.sincronizar++; },
    abrirConfiguracoes: () => {},
    abrirAgendador: () => {},
    abrirNoEstudio: () => {},
  };
  const lote = window.CineLote._interno;
  // These fixtures exercise the optional AI styles. List defaults are covered below.
  lote.estado.opcoes.modoGancho = "suspense";
  lote.ambiente.core = () => core;
  lote.ambiente.app = () => app;
  lote.ambiente.lerVideo = async (f) => (f.name === "hevc.mp4"
    ? { largura: 0, altura: 0, duracao: 60 }
    : { largura: 1920, altura: 1080, duracao: duracoes[f.name] || 30 });
  return { fila, chamadas, core, app, lote, liberar: () => travarProcessamento && travarProcessamento.resolve() };
}

console.log("\n📦 Upload em massa — lote-massa.js\n");
console.log("Lista padrão + sem identificação: nenhuma análise de mídia ou IA de gancho");
{
  const dom = novoDom();
  const c = cenario(dom.window, { settings: { geminiKey: "gem", ganchosBons: "Primeiro gancho 👀\nSegundo gancho 🎬" } });
  c.lote.estado.opcoes.modoIdentificacao = "sem_id";
  c.lote.estado.opcoes.modoGancho = "auto";
  let audio = 0;
  c.core.audio = async () => { audio++; throw new Error("não deve extrair áudio"); };
  c.lote.adicionarFicheiros([ficheiro(dom.window, "longo.mp4"), ficheiro(dom.window, "curto.mp4")]);
  await c.lote.iniciar();
  check("usa os ganchos personalizados sem repetir no lote paralelo", c.fila.length === 2 && new Set(c.fila.map(r => r.hookText)).size === 2 && c.fila.every(r => ["Primeiro gancho 👀", "Segundo gancho 🎬"].includes(r.hookText)));
  check("sem identificação não prepara áudio nem upload de vídeo para IA", audio === 0 && !c.chamadas.videoParaIA && c.chamadas.identificar === 0);
  check("lista não chama a IA de ganchos", c.chamadas.gerarGancho === 0);
  dom.window.close();
}

console.log("🚀 Modo direto: sem identificação e sem IA — legenda da lista e 1.º comentário fixo");
{
  const dom = novoDom();
  const { window } = dom;
  const c = cenario(window, { settings: { legendasBoas: "GANCHO: {gancho}\n\n#TesteA\n---\nOutra legenda {gancho} #TesteB" } });
  // Mesmo com os modos de IA selecionados no painel, o direto ignora-os.
  c.lote.estado.opcoes.modoDireto = true;
  c.lote.estado.opcoes.modoIdentificacao = "auto";
  c.lote.estado.opcoes.modoGancho = "suspense";
  let chamLegenda = 0;
  c.core.gerarLegenda = async () => { chamLegenda++; return "LEGENDA DA IA"; };
  let audio = 0;
  c.core.audio = async () => { audio++; throw new Error("não deve extrair áudio"); };
  window.CineLote.abrir();
  check("o painel tem a opção 🚀 Modo direto", /Modo direto/.test(window.document.querySelector(".cl-painel").textContent));
  c.lote.adicionarFicheiros([ficheiro(window, "longo.mp4"), ficheiro(window, "curto.mp4")]);
  await c.lote.iniciar();
  check("direto: os 2 Reels entram na fila", c.fila.length === 2, `fila=${c.fila.length}`);
  check("direto: não identifica o filme nem chama a IA (gancho/legenda)", c.chamadas.identificar === 0 && c.chamadas.gerarGancho === 0 && chamLegenda === 0, `identificar=${c.chamadas.identificar} legenda=${chamLegenda}`);
  check("direto: não prepara áudio nem vídeo para IA", audio === 0 && !c.chamadas.videoParaIA);
  check("direto: a legenda sai da lista pronta com o gancho no lugar de {gancho}", c.fila.every((r) => r.caption.includes(r.hookText) && /#Teste[AB]/.test(r.caption) && !r.caption.includes("{gancho}")), c.fila.map((r) => r.caption).join(" // "));
  check("direto: as 2 legendas-modelo rodam sem repetir no lote", new Set(c.fila.map((r) => r.caption.includes("#TesteA"))).size === 2);
  check("direto: o gancho também vem da lista pronta (sem IA)", c.fila.every((r) => window.CineClipMotor.ganchosPadrao.includes(r.hookText)), c.fila.map((r) => r.hookText).join(" | "));
  check("direto: o Reel leva o 1.º comentário «LINK DO FILME NA MINHA B10»", c.fila.every((r) => r.firstComment === "LINK DO FILME NA MINHA B10"), JSON.stringify(c.fila.map((r) => r.firstComment)));
  dom.window.close();
}

console.log("A1. Um lote com vídeos bons, um H.265, um com pouca certeza e um inválido");
{
  const dom = novoDom();
  const { window } = dom;
  const c = cenario(window);
  window.CineLote.abrir();
  const entraram = c.lote.adicionarFicheiros([
    ficheiro(window, "longo.mp4"),
    ficheiro(window, "hevc.mp4"),
    ficheiro(window, "curto.mp4"),
    ficheiro(window, "duvida.mp4"),
    ficheiro(window, "notas.txt"),
  ]);
  check("4 ficheiros válidos entram na lista (o .txt fica com erro)", entraram === 4, `entraram=${entraram}`);
  const botaoComecar = [...window.document.querySelectorAll("button")].find((b) => /Começar \(4 vídeos\)/.test(b.textContent));
  check("o painel mostra «Começar (4 vídeos)»", !!botaoComecar);

  await c.lote.iniciar();
  const porNome = Object.fromEntries(c.lote.estado.itens.map((it) => [it.nome, it]));

  check("3 Reels entram na fila do Agendador (o duvidoso também)", c.fila.length === 3, `fila=${c.fila.length}`);
  check("longo.mp4 é cortado em 90 s", c.chamadas.processar.find((p) => p.nome === "longo.mp4")?.fim === 90);
  check("curto.mp4 usa o vídeo todo (40 s)", c.chamadas.processar.find((p) => p.nome === "curto.mp4")?.fim === 40);
  check("o corte começa sempre no início (0 s)", c.chamadas.processar.every((p) => p.inicio === 0));
  check("as barras pretas detetadas vão para o FFmpeg", c.chamadas.processar[0]?.corte?.top === 100 && c.chamadas.processar[0]?.corte?.bottom === 180);
  check("o gancho de cada vídeo vem da IA", c.fila[0].hookText === "Gancho de longo.mp4 😳" && c.fila[1].hookText === "Gancho de curto.mp4 😳", c.fila.map((r) => r.hookText).join(" | "));
  check("o gancho vai para o vídeo (FFmpeg)", c.chamadas.processar[0].gancho === "Gancho de longo.mp4 😳");
  check("a legenda é da IA e sem **negrito**", c.fila[0].caption === "Filme longo.mp4 — Gancho de longo.mp4 😳", c.fila[0].caption);
  check("os Reels vão para a conta ativa", c.fila.every((r) => r.accountId === "acc_cena"));
  check("horários diferentes, nos horários livres da conta", c.fila[0].scheduledAt === "2026-10-14T12:00" && c.fila[1].scheduledAt === "2026-10-14T18:00", c.fila.map((r) => r.scheduledAt).join(", "));
  check("o Reel leva título, ano e pôster do TMDB", c.fila[0].title === "Filme longo.mp4" && c.fila[0].year === 2024 && c.fila[0].poster === "https://img/p.jpg");
  check("o Reel leva o vídeo processado e o nome _cineclip.mp4", c.fila[0].videoBlob && c.fila[0].videoBlob.size === 100 && c.fila[0].videoFileName === "longo_cineclip.mp4");
  check("o Reel fica «scheduled» para Instagram", c.fila.every((r) => r.status === "scheduled" && r.platforms[0] === "instagram"));
  check("H.265: erro claro sem gastar a IA", porNome["hevc.mp4"].estado === "erro" && /H\.265\/HEVC/.test(porNome["hevc.mp4"].erro), porNome["hevc.mp4"].erro);
  check("pouca certeza: agenda na mesma, sem o palpite da IA, e avisa", porNome["duvida.mp4"].estado === "agendado" && /50%/.test(porNome["duvida.mp4"].aviso) && /sem identificação/.test(porNome["duvida.mp4"].aviso), porNome["duvida.mp4"].aviso);
  const rDuvida = c.fila.find((r) => r.title !== "Talvez Este" && !r.poster && /duvida/i.test(r.title));
  check("pouca certeza: título do nome do ficheiro, sem capa", !!rDuvida && !c.fila.some((r) => r.title === "Talvez Este"), c.fila.map((r) => r.title).join(" | "));
  check("o .txt fica com erro de formato", porNome["notas.txt"].estado === "erro" && /Formato não suportado/.test(porNome["notas.txt"].erro));
  check("cada Reel agendado pede a sincronização (upload para a nuvem)", c.chamadas.sincronizar === 3 && c.chamadas.atualizarFila === 3);
  check("a legenda vai para o histórico de legendas", c.chamadas.historico === 3);

  const textoPainel = window.document.querySelector(".cl-painel").textContent;
  check("o painel mostra o resumo do lote", /3 agendados/.test(textoPainel) && /2 com erro/.test(textoPainel), textoPainel.slice(-160));
  check("o painel mostra o horário legível", /14\/10 às 12:00/.test(textoPainel));
  check("o aviso aparece no item agendado", /seguiu sem identificação/.test(textoPainel));
  check("«Abrir no Estúdio» aparece para os vídeos com erro", [...window.document.querySelectorAll(".cl-item[data-estado=erro] button")].some((b) => b.textContent === "Abrir no Estúdio"));
  check("o .txt não tem «Tentar de novo»", ![...window.document.querySelectorAll(".cl-item")].find((li) => /notas\.txt/.test(li.textContent))?.textContent.includes("Tentar de novo"));
  dom.window.close();
}

console.log("\nA2. Sem gancho na identificação → pede um gancho à IA");
{
  const dom = novoDom();
  const c = cenario(dom.window);
  c.lote.adicionarFicheiros([ficheiro(dom.window, "sem-gancho.mp4")]);
  await c.lote.iniciar();
  check("chama a IA de ganchos", c.chamadas.gerarGancho === 1);
  check("usa o gancho gerado", c.fila[0]?.hookText === "Gancho gerado 🔥", c.fila[0]?.hookText);
  dom.window.close();
}

console.log("\nA2b. Com Gemini: o vídeo vai para a IA («assistir» em vez de frames)");
{
  const dom = novoDom();
  const c = cenario(dom.window, { settings: { geminiKey: "gm-key" } });
  c.lote.adicionarFicheiros([ficheiro(dom.window, "sem-gancho.mp4")]);
  await c.lote.iniciar();
  check("prepara o vídeo para a IA (videoParaIA)", c.chamadas.videoParaIA === 1, "chamadas=" + c.chamadas.videoParaIA);
  check("a identificação recebe o vídeo", !!c.chamadas.videoRecebido && c.chamadas.videoRecebido.mimeType === "video/mp4" && c.chamadas.videoRecebido.fim === 70, JSON.stringify(c.chamadas.videoRecebido));
  check("o gerarGancho recebe o vídeo (7.º argumento)", !!c.chamadas.videoGancho && c.chamadas.videoGancho.mimeType === "video/mp4", JSON.stringify(c.chamadas.videoGancho));
  check("usa o gancho gerado", c.fila[0]?.hookText === "Gancho gerado 🔥", c.fila[0]?.hookText);
  dom.window.close();
}

console.log("\nA2b. Modo «Rápido por Nome»: se o TMDB não acha o nome, cai para a IA completa");
{
  const dom = novoDom();
  const c = cenario(dom.window);
  c.lote.estado.opcoes.modoIdentificacao = "dica";
  c.lote.adicionarFicheiros([ficheiro(dom.window, "Nome Estranho.mp4")]);
  await c.lote.iniciar();
  check("chamou a identificação 2 vezes (nome, depois IA completa)", c.chamadas.identificar === 2, String(c.chamadas.identificar));
  check("agendou com o filme da IA completa", c.fila[0]?.title === "Filme Nome Estranho.mp4", c.fila[0]?.title);
  dom.window.close();
}

console.log("\nA2c. A IA falha (cota/rede) na identificação e na legenda → o vídeo sobe na mesma");
{
  const dom = novoDom();
  const c = cenario(dom.window);
  const erroCota = Object.assign(new Error("Groq: limite de pedidos atingido. Espera um pouco."), { status: 429 });
  c.core.identificar = async () => { throw erroCota; };
  c.core.gerarGancho = async () => { throw erroCota; };
  c.core.gerarLegenda = async () => { throw erroCota; };
  c.lote.adicionarFicheiros([ficheiro(dom.window, "Chicago PD.mp4")]);
  await c.lote.iniciar();
  const it = c.lote.estado.itens[0];
  check("o vídeo é processado e agendado", it.estado === "agendado" && c.fila.length === 1, `${it.estado} fila=${c.fila.length} ${it.erro || ""}`);
  check("título do nome do ficheiro, sem capa", c.fila[0] && /Chicago PD/.test(c.fila[0].title) && !c.fila[0].poster, c.fila[0] && c.fila[0].title);
  check("leva um gancho e uma legenda simples", c.fila[0] && c.fila[0].hookText && /#Filmes/.test(c.fila[0].caption), c.fila[0] && c.fila[0].caption);
  check("o item explica o que aconteceu", /limite de pedidos/.test(it.aviso) && /legenda simples/.test(it.aviso), it.aviso);
  dom.window.close();
}

console.log("\nA2d. Metadados do TikTok (VideoHandle, ByteVC1-v1.10.0.2) não viram título");
{
  const dom = novoDom();
  const c = cenario(dom.window);
  let dicaRecebida = null;
  c.core.lerMetadados = async () => ({ duration: 30, fields: [{ label: "Handler", value: "VideoHandle" }, { label: "Título", value: "ByteVC1-v1.10.0.2" }, { label: "Comentário", value: "bvc0ot v2.2.1.3-20250220" }] });
  c.core.identificar = async (k, q, l, info) => { dicaRecebida = info; throw new Error("sem cota"); };
  c.lote.adicionarFicheiros([ficheiro(dom.window, "O_troll_da_montanha_.mp4")]);
  await c.lote.iniciar();
  check("o título vem do nome do ficheiro", c.fila[0] && c.fila[0].title === "O troll da montanha", c.fila[0] && c.fila[0].title);
  check("o lixo do codificador não vai para a IA", dicaRecebida && !dicaRecebida.metaTitle && !/VideoHandle|ByteVC|bvc0ot/.test(dicaRecebida.userHint || ""), JSON.stringify(dicaRecebida && [dicaRecebida.metaTitle, dicaRecebida.userHint]));
  check("o gancho de reserva não cita lixo", c.fila[0] && !/ByteVC|bvc0ot|VideoHandle/.test(c.fila[0].hookText + c.fila[0].caption), c.fila[0] && c.fila[0].hookText);
  dom.window.close();
}

console.log("\nA2e. Reels de lotes antigos (mesma chave lote_1_1) não bloqueiam os novos");
{
  const dom = novoDom();
  const c = cenario(dom.window);
  c.fila.push({ id: "velho1", accountId: "acc_cena", status: "published", scheduledAt: "2026-10-16T18:30", _loteKey: "lote_1_1", title: "Antigo" });
  c.fila.push({ id: "velho2", accountId: "acc_cena", status: "scheduled", scheduledAt: "2026-10-20T09:30", _loteKey: "lote_1_2", title: "Outro" });
  c.fila.push({ id: "velho3", accountId: "acc_cena", status: "scheduled", scheduledAt: "2026-10-20T10:15", _loteKey: "lote_2_1", title: "Outro 2" });
  c.lote.adicionarFicheiros([ficheiro(dom.window, "longo.mp4"), ficheiro(dom.window, "curto.mp4")]);
  await c.lote.iniciar();
  const novos = c.fila.filter((r) => !/^velho/.test(r.id));
  check("os 2 vídeos novos entram na fila", novos.length === 2, `novos=${novos.length} estados=${c.lote.estado.itens.map((i) => i.estado + "@" + (i.resultado && i.resultado.horario)).join(",")}`);
  check("nenhum item aponta para um Reel antigo", c.lote.estado.itens.every((i) => i.resultado && i.resultado.reelId && !/^velho/.test(i.resultado.reelId)));
  dom.window.close();
}

console.log("\nA3. Opção «Agendar mesmo com pouca certeza»");
{
  const dom = novoDom();
  const c = cenario(dom.window);
  c.lote.estado.opcoes.agendarComPoucaCerteza = true;
  c.lote.adicionarFicheiros([ficheiro(dom.window, "duvida.mp4")]);
  await c.lote.iniciar();
  check("agenda o vídeo com 50% de certeza", c.fila.length === 1 && c.fila[0].title === "Talvez Este");
  dom.window.close();
}

console.log("\nA3b. Modo Sem Identificação (sem_id) + Modo Sem Gancho (sem_gancho)");
{
  const dom = novoDom();
  const c = cenario(dom.window, { settings: { tmdbKey: "" } });
  c.lote.estado.opcoes.modoIdentificacao = "sem_id";
  c.lote.estado.opcoes.modoGancho = "sem_gancho";
  c.lote.adicionarFicheiros([ficheiro(dom.window, "curto.mp4")]);
  await c.lote.iniciar();
  check("modo sem_id não chama core.identificar nem precisa de chave TMDB", c.chamadas.identificar === 0 && c.fila.length === 1);
  check("modo sem_gancho processa o vídeo com gancho vazio", c.chamadas.processar[0]?.gancho === "" && c.fila[0]?.hookText === "");
  dom.window.close();
}

console.log("\nA4. Chaves em falta");
{
  const dom = novoDom();
  const c = cenario(dom.window, { settings: { groqKey: "", geminiKey: "", tmdbKey: "" } });
  dom.window.CineLote.abrir();
  c.lote.adicionarFicheiros([ficheiro(dom.window, "longo.mp4")]);
  await c.lote.iniciar();
  check("não processa nada", c.chamadas.identificar === 0 && c.fila.length === 0);
  const texto = dom.window.document.querySelector(".cl-painel").textContent;
  check("explica que falta a chave da IA", /chave Google Gemini, Groq ou OpenRouter/.test(texto));
  check("oferece «Abrir configurações»", /Abrir configurações/.test(texto));
  const c2 = cenario(dom.window, { settings: { tmdbKey: "" } });
  check("explica que falta a chave TMDB", /chave TMDB/.test(c2.lote.faltaConfigurar() || ""));
  dom.window.close();
}

console.log("\nA5. Botão Parar a meio do FFmpeg");
{
  const dom = novoDom();
  const { window } = dom;
  const c = cenario(window);
  /* O lote processa vários vídeos ao mesmo tempo (opção «simultâneos»);
     este cenário trava o FFmpeg a meio, por isso força 1 vídeo de cada vez. */
  c.lote.estado.opcoes.simultaneos = 1;
  window.CineLote.abrir();
  c.lote.adicionarFicheiros([ficheiro(window, "parar.mp4"), ficheiro(window, "depois.mp4")]);
  const corrida = c.lote.iniciar();
  await waitFor("FFmpeg a correr", () => c.chamadas.processar.length === 1);
  const botaoParar = [...window.document.querySelectorAll("button")].find((b) => b.textContent === "Parar");
  check("aparece o botão Parar", !!botaoParar);
  botaoParar.click();
  await corrida;
  check("interrompe o FFmpeg", c.chamadas.cancelar === 1);
  check("nada é agendado", c.fila.length === 0);
  check("os dois vídeos voltam a ficar na fila do lote", c.lote.estado.itens.every((it) => it.estado === "pendente"), c.lote.estado.itens.map((it) => it.estado).join(","));
  check("o segundo vídeo não começou", c.chamadas.processar.length === 1);
  dom.window.close();
}

console.log("\nA6. Fechar o painel durante o lote");
{
  const dom = novoDom();
  const { window } = dom;
  const c = cenario(window);
  /* Sequencial, como no A5: o 1.º vídeo trava no FFmpeg e o 2.º fica pendente. */
  c.lote.estado.opcoes.simultaneos = 1;
  window.CineLote.abrir();
  c.lote.adicionarFicheiros([ficheiro(window, "parar.mp4"), ficheiro(window, "curto.mp4")]);
  const corrida = c.lote.iniciar();
  await waitFor("FFmpeg a correr", () => c.chamadas.processar.length === 1);
  window.CineLote.fechar();
  const pilula = window.document.querySelector(".cl-pilula");
  check("o lote continua e aparece o atalho no canto", !!pilula && /1\/2/.test(pilula.textContent), pilula && pilula.textContent);
  c.liberar();
  await corrida;
  check("o lote termina com o painel fechado", c.fila.length === 2);
  check("o atalho desaparece no fim", !window.document.querySelector(".cl-pilula"));
  dom.window.close();
}

/* ======================================================================
   Parte B — o bundle real
   ====================================================================== */

console.log("\nB. O app real (bundle) com o upload em massa");

const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
check("index.html carrega lote-massa.js", html.includes('<script src="lote-massa.js"></script>'));
const moduleSource = /<script type="module">([\s\S]*?)<\/script>/.exec(html)[1].replace(/import\.meta\.url/g, '"file:///index.html"');
const cineCloudSource = fs.readFileSync(path.join(root, "nuvem-duravel.js"), "utf8");
const CONTA = { id: "acc_default", name: "@conta.teste", mode: "graph", igUserId: "1", fbPageId: "", metaAccessToken: "x", webhookUrl: "", dailySlots: ["12:00"], autoPilot: false, shareToFeed: true };

function resposta(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => headers[String(n).toLowerCase()] ?? null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body ?? {})),
    json: async () => (typeof body === "string" ? JSON.parse(body) : body ?? {}),
    body: { cancel: async () => {} },
  };
}

const dom = new JSDOM(html, { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
const { window } = dom;
window.indexedDB = fakeIndexedDB;
window.IDBKeyRange = IDBKeyRange;
window.TextEncoder = globalThis.TextEncoder;
window.TextDecoder = globalThis.TextDecoder;
try { Object.defineProperty(window, "crypto", { value: globalThis.crypto, configurable: true }); } catch {}
window.fetch = async () => resposta(200, { key: "stub", id: "stub" }, { "content-type": "application/json" });
window.matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false });
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.HTMLMediaElement.prototype.play = () => Promise.resolve();
window.HTMLMediaElement.prototype.pause = () => {};
window.HTMLMediaElement.prototype.load = () => {};
window.scrollTo = () => {};
window.confirm = () => true;
window.URL.createObjectURL = () => "blob:stub";
window.URL.revokeObjectURL = () => {};
const logs = [];
for (const n of ["log", "info", "debug", "warn"]) window.console[n] = (...a) => logs.push(a.map(String).join(" "));
window.localStorage.setItem("cineclip.ig.accounts", JSON.stringify([CONTA]));
window.localStorage.setItem("cineclip.ig.active", CONTA.id);

window.eval(cineCloudSource);
window.eval(fs.readFileSync(path.join(root, "motor-ia.js"), "utf8"));
window.eval(LOTE);
window.eval(moduleSource);

const entrar = await waitFor("ecrã de login", () => [...window.document.querySelectorAll("button")].find((b) => /Entrar e Sincronizar Tudo/.test(b.textContent)));
const [u, p] = window.document.querySelectorAll("input");
for (const [input, valor] of [[u, "teste@cineclip"], [p, "senha-de-teste"]]) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, valor);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}
entrar.click();
const botaoLote = await waitFor("botão Upload em massa", () => [...window.document.querySelectorAll("button")].find((b) => /Upload em massa/.test(b.textContent)));
check("o Estúdio mostra o botão «📦 Upload em massa»", !!botaoLote);

const nomesCore = ["lerMetadados", "detetarBarras", "quadros", "audio", "identificar", "procurarTmdb", "gerarGancho", "processar", "cancelarProcessamento", "gerarLegenda", "limparLegenda", "proximoHorario", "guardarNaFila", "lerFila", "guardarHistorico"];
const coreReal = window.CineClipCore;
check("window.CineClipCore expõe as 15 funções do bundle", !!coreReal && nomesCore.every((n) => typeof coreReal[n] === "function"), coreReal ? nomesCore.filter((n) => typeof coreReal[n] !== "function").join(",") : "sem CineClipCore");
check("o gancho padrão vem das definições do app", coreReal && coreReal.ganchoPadrao === "O que acontece nessa cena deixou todo mundo em choque 😳");
const appReal = window.__CineClipApp;
check("window.__CineClipApp tem a conta ativa", appReal && appReal.account && appReal.account.id === "acc_default", appReal && JSON.stringify(appReal.account && appReal.account.id));
check("window.__CineClipApp tem as definições e as ações", appReal && appReal.settings && typeof appReal.sincronizar === "function" && typeof appReal.abrirNoEstudio === "function");

const inputFicheiro = window.document.querySelector('input[type="file"]');
check("o seletor de ficheiros aceita vários", !!inputFicheiro && inputFicheiro.multiple === true);

botaoLote.click();
check("o botão abre o painel do upload em massa", !!window.document.querySelector(".cl-painel"));
check("o painel diz para que conta agenda", /@conta\.teste/.test(window.document.querySelector(".cl-painel").textContent));
window.CineLote.fechar();

const f1 = new window.File([new Uint8Array(32)], "a.mp4", { type: "video/mp4" });
const f2 = new window.File([new Uint8Array(32)], "b.mp4", { type: "video/mp4" });
Object.defineProperty(inputFicheiro, "files", { value: [f1, f2], configurable: true });
inputFicheiro.dispatchEvent(new window.Event("change", { bubbles: true }));
await waitFor("painel aberto pela escolha múltipla", () => window.document.querySelector(".cl-painel"));
check("escolher 2 vídeos no Estúdio abre o lote com os 2", window.CineLote._interno.estado.itens.length === 2);
check("…e não carrega nenhum no Estúdio", !/Trocar/.test(window.document.querySelector("main")?.textContent || ""));

/* Lote com a IA e o FFmpeg falsos, mas a fila, os horários e as definições reais */
const lote = window.CineLote._interno;
lote.ambiente.lerVideo = async () => ({ largura: 1920, altura: 1080, duracao: 100 });
lote.ambiente.core = () => Object.assign({}, coreReal, {
  lerMetadados: async () => ({ duration: 100, fields: [] }),
  detetarBarras: async () => null,
  quadros: async () => ["q"],
  audio: async () => null,
  identificar: async (k, q, l, info) => ({ titulo: "Filme " + info.fileName, confianca: 95, cena: "cena", ganchos: ["Gancho " + info.fileName] }),
  procurarTmdb: async (k, ia) => ({ title: ia.titulo, original: ia.titulo, year: 2020, poster: "", kind: "movie", genres: [], overview: "" }),
  processar: async (f, i, fim, res, g, prog) => { prog(1); return new window.Blob([new Uint8Array(50)], { type: "video/mp4" }); },
  gerarLegenda: async (k, filme) => `**${filme.title}** é incrível`,
});
lote.ambiente.app = () => Object.assign({}, window.__CineClipApp, {
  settings: Object.assign({}, window.__CineClipApp.settings, { groqKey: "nv", tmdbKey: "tm" }),
});
await lote.iniciar();

const filaReal = await coreReal.lerFila();
const doLote = filaReal.filter((r) => /^Filme [ab]\.mp4$/.test(r.title));
check("os 2 Reels ficam na fila real (IndexedDB)", doLote.length === 2, `fila=${filaReal.length}`);
check("na conta ativa, com estado scheduled", doLote.every((r) => r.accountId === "acc_default" && r.status === "scheduled"));
check("em horários diferentes às 12:00 (o horário da conta)", doLote.length === 2 && doLote[0].scheduledAt !== doLote[1].scheduledAt && doLote.every((r) => r.scheduledAt.endsWith("T12:00")), doLote.map((r) => r.scheduledAt).join(", "));
check("a legenda é limpa pelo app (sem **)", doLote.every((r) => !r.caption.includes("**")), doLote.map((r) => r.caption).join(" | "));
check("o vídeo processado fica guardado com o Reel", doLote.every((r) => r.videoBlob && r.videoSize === 50));

dom.window.close();

console.log("\n─────────────────────────────────────────────");
if (fail) {
  console.log(`❌ ${pass} passaram, ${fail} falharam:`);
  for (const f of failures) console.log(`   • ${f}`);
  process.exit(1);
}
console.log(`✅ ${pass} passaram, 0 falharam`);
