#!/usr/bin/env node
/**
 * ☁️ CineClip — servidor na nuvem
 *
 *   node servidor/index.mjs configurar   # cola o código do Robô 24h (lê do stdin)
 *   node servidor/index.mjs testar       # confere cofre, R2, FFmpeg, fontes e chaves
 *   node servidor/index.mjs uma-vez      # um ciclo e sai
 *   node servidor/index.mjs              # fica a correr (o serviço systemd usa isto)
 *
 * Ficheiros: config em $CINECLIP_CONFIG (/etc/cineclip/config.json) e registo em
 * $CINECLIP_DADOS (/var/lib/cineclip). Ver servidor/README.md.
 */
import fs from "node:fs";
import path from "node:path";
import { lerConfigDoRobo, lerCofre } from "./cofre.mjs";
import { arrancarApp } from "./app-headless.mjs";
import { criarTrabalhador } from "./trabalhador.mjs";
import * as video from "./video.mjs";

const CONFIG = process.env.CINECLIP_CONFIG || "/etc/cineclip/config.json";
const DADOS = process.env.CINECLIP_DADOS || "/var/lib/cineclip";
const comando = process.argv[2] || "correr";
const carimbo = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const log = (...a) => console.log(carimbo(), ...a);

function lerConfig() {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  } catch {
    throw new Error(`Sem configuração em ${CONFIG}. Corre: node servidor/index.mjs configurar`);
  }
  return {
    SITE: "https://cine-flowx.vercel.app",
    INTERVALO_S: 60,
    AGENDAR_POUCA_CERTEZA: false,
    NOME_SERVIDOR: "nuvem",
    ...cfg,
  };
}

/** Lê o que o utilizador cola: a chave curta acaba no Enter; o código do Robô no Ctrl+D. */
async function lerColado() {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, terminal: false });
  const linhas = [];
  return new Promise((resolve) => {
    rl.on("line", (linha) => {
      linhas.push(linha);
      if (/CINECLIP1:[A-Za-z0-9+/=]{40,}/.test(linha)) rl.close();
    });
    rl.on("close", () => resolve(linhas.join("\n")));
  });
}

async function configurar() {
  console.log("Cola a CHAVE DO SERVIDOR e carrega Enter.");
  console.log("(CineClip → 📦 Upload em massa → 📱 Compartilhar do celular → 🔑 Copiar chave do servidor)");
  console.log("Também aceita o código do Robô 24h inteiro — nesse caso termina com Ctrl+D.\n");
  const codigo = await lerColado();
  const doRobo = lerConfigDoRobo(codigo);
  let anterior = {};
  try {
    anterior = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  } catch {}
  const cfg = { ...anterior, ...doRobo };
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  if (process.env.CINECLIP_DONO_CONFIG) {
    // O instalador corre como root; o serviço lê a config com o utilizador "cineclip".
    try {
      const [uid, gid] = process.env.CINECLIP_DONO_CONFIG.split(":").map(Number);
      fs.chownSync(CONFIG, uid, gid);
    } catch {}
  }
  console.log(`\n✅ Configuração guardada em ${CONFIG} (conta: ${cfg.CONTA || "?"}).`);
  console.log("   A seguir: node servidor/index.mjs testar");
}

async function testar() {
  const cfg = lerConfig();
  const ok = (m) => console.log("  ✔ " + m);
  const mal = (m) => {
    console.log("  ✘ " + m);
    process.exitCode = 1;
  };
  console.log("\n☁️  Teste do servidor CineClip\n");
  try {
    await video.correr(process.env.CINECLIP_FFMPEG || "ffmpeg", ["-version"]);
    ok("FFmpeg instalado");
  } catch {
    mal("FFmpeg não encontrado (sudo apt install ffmpeg)");
  }
  const f = await video.fontesDisponiveis().catch(() => ({}));
  f.inter ? ok("fonte Inter (a do gancho)") : mal("falta a fonte Inter (sudo apt install fonts-inter)");
  f.emoji ? ok("fonte de emoji") : mal("falta a fonte de emoji (sudo apt install fonts-noto-color-emoji)");
  let cofre = null;
  try {
    cofre = await lerCofre(cfg);
    cofre ? ok(`cofre lido e decifrado (${(cofre.queue || []).length} Reels na fila)`) : mal("cofre vazio — abre o CineClip e sincroniza");
  } catch (e) {
    mal(e.message);
  }
  if (cfg.R2_WORKER_URL && cfg.R2_TOKEN) ok("Cloudflare R2 configurado (os vídeos vão para lá)");
  else mal("sem Cloudflare R2: o servidor precisa dele para guardar os vídeos");
  if (cofre) {
    const s = cofre.settings || {};
    s.geminiKey || s.groqKey || s.openrouterKey ? ok("chave de IA (Gemini/Groq/OpenRouter)") : mal("sem chave Gemini, Groq nem OpenRouter nas definições do app");
    s.tmdbKey ? ok("chave TMDB") : mal("sem chave TMDB nas definições do app");
    ok(`${(cofre.accounts || []).length} conta(s) do Instagram`);
    const espera = (cofre.linksCelular || []).filter((e) => e.destino === "nuvem" && e.estado === "pendente").length;
    ok(`${espera} link(s) à espera na nuvem`);
  }
  try {
    const app = await arrancarApp({ site: cfg.SITE });
    ok("o app CineClip arrancou no servidor (IA, TMDB e lote)");
    app.fechar();
  } catch (e) {
    mal("o app não arrancou: " + e.message);
  }
  console.log(process.exitCode ? "\n❌ Corrige o que está com ✘ e testa outra vez.\n" : "\n✅ Tudo pronto.\n");
}

async function correr(umaVez) {
  const cfg = lerConfig();
  const app = await arrancarApp({ site: cfg.SITE });
  const trabalhador = criarTrabalhador({ cfg, app, pastaDados: DADOS, log });
  log(`☁️ Servidor CineClip ligado (conta ${cfg.CONTA || "?"}, a cada ${cfg.INTERVALO_S}s).`);
  let parar = false;
  for (const sinal of ["SIGINT", "SIGTERM"]) process.on(sinal, () => {
    log("A parar depois do vídeo atual…");
    parar = true;
  });
  do {
    try {
      const r = await trabalhador.ciclo();
      if (r.processados) log(`ciclo: ${r.processados} link(s) tratados.`);
    } catch (e) {
      log("⚠️ ciclo falhou: " + ((e && e.message) || e));
    }
    if (umaVez || parar) break;
    await new Promise((r) => setTimeout(r, Number(cfg.INTERVALO_S || 60) * 1000));
  } while (!parar);
  app.fechar();
}

const acoes = { configurar, testar, "uma-vez": () => correr(true), correr: () => correr(false) };
if (!acoes[comando]) {
  console.error(`Comando desconhecido: ${comando}. Usa: configurar | testar | uma-vez`);
  process.exit(2);
}
acoes[comando]().then(
  () => process.exit(process.exitCode || 0),
  (e) => {
    console.error("❌ " + ((e && e.message) || e));
    process.exit(1);
  }
);
