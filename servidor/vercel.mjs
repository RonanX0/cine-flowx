/**
 * ☁️ A "nuvem" do CineClip a correr na própria Vercel (api/nuvem.js) — sem Oracle,
 * sem Hetzner, sem cartão.
 *
 * Em vez de um servidor ligado o tempo todo, cada pedido a /api/nuvem trata UM link
 * pendente (o limite da Vercel grátis é 5 min por pedido) e, se ficarem mais, volta
 * a chamar-se a si próprio. Quem acorda a nuvem:
 *   • o celular, logo depois de mandar um link para a nuvem;
 *   • o Robô 24h, a cada 5 min, enquanto houver links à espera;
 *   • o app, ao abrir, se encontrar links à espera.
 *
 * A configuração é só uma variável de ambiente na Vercel:
 *   CINECLIP_CHAVE_SERVIDOR = a chave do servidor (CINECLIP1:…), copiada no app em
 *   📦 Upload em massa → 📱 Compartilhar do celular → 🔑 Copiar chave do servidor.
 */
import { lerConfigDoRobo, lerCofre, reclamar, libertar, registoNoR2 } from "./cofre.mjs";

const TRINCO = "nuvem_vercel";
/** Um pouco mais do que o limite de 5 min da Vercel: se o pedido for cortado a meio,
 *  o trinco expira sozinho e o próximo pedido continua. */
const TRINCO_MS = 330 * 1000;

/** Lê a chave das variáveis da Vercel. Devolve { cfg } ou { erro }. */
export function configDaVercel(env = process.env, origem = "") {
  const chave = String(env.CINECLIP_CHAVE_SERVIDOR || "").trim();
  if (!chave) return { erro: "Falta a variável CINECLIP_CHAVE_SERVIDOR na Vercel." };
  try {
    const cfg = lerConfigDoRobo(chave);
    if (!(cfg.R2_WORKER_URL && cfg.R2_TOKEN)) {
      return { erro: "A nuvem precisa do Cloudflare R2 configurado no CineClip (copia a chave outra vez depois de o configurar)." };
    }
    return {
      cfg: {
        ...cfg,
        SITE: String(env.CINECLIP_SITE || origem || "https://cine-flowx.vercel.app").replace(/\/+$/, ""),
        NOME_SERVIDOR: "vercel",
        AGENDAR_POUCA_CERTEZA: /^(1|true|sim)$/i.test(String(env.CINECLIP_AGENDAR_POUCA_CERTEZA || "")),
      },
    };
  } catch (e) {
    return { erro: (e && e.message) || String(e) };
  }
}

/** O que o app vê em GET /api/nuvem (nada de segredos). */
export function estadoDaNuvem(env = process.env) {
  const { cfg, erro } = configDaVercel(env);
  return { ok: true, configurado: !!cfg, erro: erro || "", tipo: "vercel", versao: 1 };
}

/**
 * Trata até 1 link pendente. Devolve { feito, restantes, motivo }.
 * `prepararVideo` deixa os testes trocarem o FFmpeg; na Vercel aponta para o
 * ffmpeg-static e desliga o ffprobe (não existe lá).
 */
export async function trabalharNaVercel({
  env = process.env,
  origem = "",
  fetchFn = fetch,
  log = (...a) => console.log("[nuvem]", ...a),
  pastaDados = "/tmp/cineclip",
  ffmpeg = "",
  arrancar,
} = {}) {
  const { cfg, erro } = configDaVercel(env, origem);
  if (!cfg) {
    log("⚠️ " + erro);
    return { feito: false, restantes: 0, motivo: erro };
  }
  if (ffmpeg && !process.env.CINECLIP_FFMPEG) process.env.CINECLIP_FFMPEG = ffmpeg;
  if (ffmpeg && !process.env.CINECLIP_FFPROBE) process.env.CINECLIP_FFPROBE = "nenhum";

  // Nada à espera? Não vale a pena arrancar o app (poupa o tempo grátis da Vercel).
  const cofre = await lerCofre(cfg, { fetchFn });
  const espera = ((cofre && cofre.linksCelular) || []).filter((e) => e && e.destino === "nuvem" && e.estado === "pendente");
  if (!espera.length) {
    log("Sem links à espera da nuvem.");
    return { feito: false, restantes: 0, motivo: "sem links" };
  }

  const dono = "vercel:" + Math.random().toString(36).slice(2, 10);
  if (!(await reclamar(cfg, TRINCO, dono, { fetchFn, ttlMs: TRINCO_MS }))) {
    log("Já há um pedido da nuvem a trabalhar — este fica por aqui.");
    return { feito: false, restantes: espera.length, motivo: "ocupado" };
  }

  let resultado = { feito: false, restantes: 0, motivo: "" };
  try {
    const { criarTrabalhador } = await import("./trabalhador.mjs");
    const iniciarApp = arrancar || (await import("./app-headless.mjs")).arrancarApp;
    const app = await iniciarApp({ site: cfg.SITE, fetchFn });
    try {
      const trabalhador = criarTrabalhador({ cfg, app, pastaDados, registo: registoNoR2(cfg, { fetchFn }), fetchFn, log });
      const r = await trabalhador.ciclo({ maxLinks: 1 });
      resultado = { feito: r.processados > 0, restantes: r.restantes, motivo: "" };
    } finally {
      try {
        app.fechar();
      } catch {}
    }
  } finally {
    await libertar(cfg, TRINCO, dono, { fetchFn });
  }
  return resultado;
}
