/**
 * ☁️ Trabalhador do CineClip — processa na nuvem os links que o celular manda
 * com "☁️ Nuvem" (caixa de links no cofre, destino "nuvem").
 *
 * Em cada ciclo:
 *   1. sinal de vida (o app mostra "☁️ Servidor ligado");
 *   2. lê o cofre; para cada link pendente com destino "nuvem":
 *      descarrega (TikTok/Kwai) → fluxo do lote do próprio app com FFmpeg nativo
 *      → envia o .mp4 para o R2 → relê o cofre → junta o Reel à fila e marca o
 *      link como feito (ou "revisar"/"erro") → grava o cofre;
 *   3. confere os Reels gravados há pouco: se uma sincronização do app os tiver
 *      atropelado, volta a pô-los (nunca processa o mesmo link duas vezes).
 */
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { lerCofre, gravarCofre, enviarVideoR2, sinalDeVida } from "./cofre.mjs";
import * as video from "./video.mjs";
import { resolverVideo, abrirVideo, nomeDoFicheiro } from "../server/importar-video.mjs";

const POR_CICLO = 3;
const CONFERIR_DURANTE_MS = 30 * 60 * 1000;
/** Tentativas por link antes de desistir (na Vercel, um vídeo que passe dos 5 min é
 *  cortado a meio: sem este limite, o mesmo link voltava a ser tentado para sempre). */
const MAX_TENTATIVAS = 3;
const GUARDAR_REGISTO_MS = 7 * 24 * 60 * 60 * 1000;

const agora = () => Date.now();
const carimbo = () => new Date().toISOString().replace("T", " ").slice(0, 19);

/** Registo num ficheiro (servidor com disco próprio: Oracle, Hetzner…). */
export function registoEmFicheiro(pastaDados) {
  const ficheiro = path.join(pastaDados, "registo.json");
  return {
    async ler() {
      try {
        return JSON.parse(fs.readFileSync(ficheiro, "utf8"));
      } catch {
        return { links: {}, reels: {}, tentativas: {} };
      }
    },
    async gravar(r) {
      fs.mkdirSync(pastaDados, { recursive: true });
      const tmp = ficheiro + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(r, null, 1));
      fs.renameSync(tmp, ficheiro);
    },
  };
}

export function criarTrabalhador({ cfg, app, pastaDados, registo: guardaRegisto, fetchFn = fetch, log = (...a) => console.log(carimbo(), ...a) }) {
  const guarda = guardaRegisto || registoEmFicheiro(pastaDados);
  const dono = "servidor:" + (cfg.NOME_SERVIDOR || "nuvem");

  async function lerRegisto() {
    const r = (await guarda.ler()) || {};
    return { links: r.links || {}, reels: r.reels || {}, tentativas: r.tentativas || {} };
  }
  async function gravarRegisto(r) {
    // Não deixa o registo crescer para sempre (o da Vercel vai cifrado no R2).
    const limite = agora() - GUARDAR_REGISTO_MS;
    for (const [id, l] of Object.entries(r.links)) if ((l.quando || 0) < limite) delete r.links[id];
    for (const [id, reel] of Object.entries(r.reels)) if ((reel.updatedAt || 0) < limite) delete r.reels[id];
    await guarda.gravar(r);
  }

  /** Descarrega o vídeo do link para um ficheiro. */
  async function descarregar(link, pasta) {
    const info = await resolverVideo(link, { fetchFn });
    const { resposta } = await abrirVideo(info, { fetchFn });
    const nome = nomeDoFicheiro(info);
    const destino = path.join(pasta, nome);
    await pipeline(Readable.fromWeb(resposta.body), fs.createWriteStream(destino));
    const st = await fs.promises.stat(destino);
    if (!st.size) throw new Error("O vídeo veio vazio.");
    return { caminho: destino, name: nome, size: st.size };
  }

  /** O fluxo do lote do app (lote-massa.js) com as peças do servidor. */
  async function processarComOApp(ficheiro, cofre, conta, entrada) {
    const core = app.core;
    const reels = [];
    const servidorCore = {
      ...core,
      lerMetadados: async (f) => ({ duration: (await video.sondar(f.caminho)).duracao, fields: [] }),
      detetarBarras: (f, ini, fim) => video.detetarBarras(f.caminho, ini, fim),
      quadros: (f, ini, fim, corte) => video.quadros(f.caminho, ini, fim, corte),
      audio: (f, ini, fim) => video.audio(f.caminho, ini, fim),
      videoParaIA: (f, ini, fim) => video.videoParaIA(f.caminho, ini, fim),
      processar: async (f, ini, fim, res, gancho, progresso, corte, bgMode, hookColor, preset, footerText, footerColor) => {
        // O lote em massa envia a formatação da conta (preset/fundo/gancho/rodapé)
        // nos argumentos 8..12; se vier vazia, usa-se a que está na própria conta.
        const estilo = {
          preset: preset || conta.preset || conta.reelPreset || "atual",
          bgMode: bgMode || conta.bgMode || conta.backgroundMode || "preto",
          hookColor: hookColor || conta.hookColor || conta.hookTextColor || "#FFFFFF",
          footerText: footerText || conta.footerText || conta.rodapeTexto || "",
          footerColor: footerColor || conta.footerColor || conta.rodapeCor || "",
        };
        const r = await video.processar(f.caminho, ini, fim, res, gancho, progresso, corte, path.join(path.dirname(f.caminho), "final.mp4"), estilo);
        return r;
      },
      guardarNaFila: async (reel) => {
        reels.push(reel);
      },
      lerFila: async () => (cofre.queue || []).slice(),
      guardarHistorico: () => {},
    };
    const lote = app.lote;
    lote.ambiente.core = () => servidorCore;
    lote.ambiente.app = () => ({ logado: true, settings: cofre.settings || {}, account: conta });
    lote.ambiente.lerVideo = async (f) => {
      const s = await video.sondar(f.caminho);
      return { largura: s.largura, altura: s.altura, duracao: s.duracao };
    };
    lote.estado.opcoes.agendarComPoucaCerteza = !!cfg.AGENDAR_POUCA_CERTEZA || !!(entrada && entrada.forcar);
    const item = { id: "nuvem_" + ((entrada && entrada.id) || Date.now()), ficheiro, nome: ficheiro.name, bytes: ficheiro.size, estado: "a_processar", passo: "", progresso: 0, erro: "", resultado: null };
    const reel = await lote.processarItem(item, conta);
    return { reel: reel || reels[0], resultado: item.resultado };
  }

  function contaDoLink(cofre, entrada) {
    const contas = Array.isArray(cofre.accounts) ? cofre.accounts : [];
    return contas.find((c) => c.id === entrada.contaId) ||
      contas.find((c) => c.id === cofre.activeAccountId) ||
      contas[0] || { id: "acc_default", name: "@conta.principal", dailySlots: [] };
  }

  /** Relê o cofre e aplica uma alteração (minimiza o atropelo com o app). */
  async function alterarCofre(alterar) {
    const cofre = await lerCofre(cfg, { fetchFn });
    if (!cofre) throw new Error("O cofre desapareceu entretanto.");
    const mudou = alterar(cofre);
    if (mudou !== false) {
      cofre.updatedAt = agora();
      await gravarCofre(cfg, cofre, { fetchFn });
    }
    return cofre;
  }

  function marcarLink(cofre, id, estado, extra) {
    cofre.linksCelular = Array.isArray(cofre.linksCelular) ? cofre.linksCelular : [];
    const e = cofre.linksCelular.find((x) => x.id === id);
    if (!e) return false;
    Object.assign(e, extra || {}, { estado, atualizadoEm: agora() });
    return true;
  }

  function juntarReel(cofre, reel) {
    cofre.queue = Array.isArray(cofre.queue) ? cofre.queue : [];
    const apagados = new Set(cofre.deletedReelIds || []);
    if (apagados.has(reel.id) || cofre.queue.some((r) => r.id === reel.id)) return false;
    cofre.queue.push(reel);
    cofre.queue.sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)));
    return true;
  }

  async function processarLink(entrada) {
    const registo = await lerRegisto();
    const feito = registo.links[entrada.id];
    if (feito && feito.reelId && registo.reels[feito.reelId]) {
      // Já processado (o cofre perdeu a marca): só repõe o Reel e a marca.
      log(`↺ ${entrada.url} já tinha sido processado — a repor no cofre.`);
      await alterarCofre((c) => {
        const a = juntarReel(c, registo.reels[feito.reelId]);
        const b = marcarLink(c, entrada.id, "feito", { reelId: feito.reelId });
        return a || b;
      });
      return;
    }

    // Conta a tentativa ANTES de começar: se o processo for cortado a meio (limite de
    // tempo da Vercel), a próxima chamada já sabe que esta falhou.
    const n = (registo.tentativas[entrada.id] || 0) + 1;
    if (n > MAX_TENTATIVAS) {
      const msg = "A nuvem tentou " + MAX_TENTATIVAS + " vezes e não conseguiu terminar este vídeo (pode ser longo demais para o limite de tempo). Toque em «Fazer aqui».";
      log(`  ❌ ${entrada.url}: ${msg}`);
      await alterarCofre((c) => marcarLink(c, entrada.id, "erro", { erro: msg }));
      delete registo.tentativas[entrada.id];
      await gravarRegisto(registo);
      return;
    }
    registo.tentativas[entrada.id] = n;
    await gravarRegisto(registo);

    log(`▶ ${entrada.url}${n > 1 ? ` (tentativa ${n}/${MAX_TENTATIVAS})` : ""}`);
    const pasta = await video.pastaTemporaria();
    try {
      const cofre = await lerCofre(cfg, { fetchFn });
      const conta = contaDoLink(cofre, entrada);
      const ficheiro = await descarregar(entrada.url, pasta);
      log(`  descarregado: ${ficheiro.name} (${(ficheiro.size / 1048576).toFixed(1)} MB)`);
      const { reel } = await processarComOApp(ficheiro, cofre, conta, entrada);
      if (!reel) throw new Error("O fluxo terminou sem Reel.");
      const final = reel.videoBlob;
      if (!final || !final.caminho) {
        // O app reconheceu o vídeo (mesmo conteúdo) como já agendado e devolveu esse Reel:
        // não há vídeo novo para enviar — só liga o link a ele.
        if (reel.id && (reel.remoteVideoUrl || (cofre.queue || []).some((r) => r && r.id === reel.id))) {
          await alterarCofre((c) => marcarLink(c, entrada.id, "feito", { reelId: reel.id }));
          delete registo.tentativas[entrada.id];
          await gravarRegisto(registo);
          log(`  ↺ já estava agendado: "${reel.title || reel.id}"`);
          return;
        }
        throw new Error("O vídeo final não foi gerado.");
      }
      const bytes = await fs.promises.readFile(final.caminho);
      const enviado = await enviarVideoR2(cfg, bytes, reel.videoFileName, { fetchFn });
      const pronto = { ...reel, remoteVideoUrl: enviado.url, cloudProvider: "r2", videoSize: bytes.length, origem: "nuvem", linkOrigem: entrada.url, updatedAt: agora() };
      delete pronto.videoBlob;
      // O horário foi escolhido com a fila lida no início; volta a escolher com a
      // fila mais recente para não ficar em cima de um Reel agendado entretanto.
      await alterarCofre((c) => {
        const ocupado = (c.queue || []).some((r) => r.id !== pronto.id && r.accountId === pronto.accountId && String(r.scheduledAt).slice(0, 16) === String(pronto.scheduledAt).slice(0, 16) && (r.status === "scheduled" || r.status === "queued"));
        if (ocupado) pronto.scheduledAt = app.core.proximoHorario(c.queue || [], conta.dailySlots || [], conta.id);
        juntarReel(c, pronto);
        marcarLink(c, entrada.id, "feito", { reelId: pronto.id });
      });
      registo.links[entrada.id] = { reelId: pronto.id, quando: agora() };
      registo.reels[pronto.id] = pronto;
      delete registo.tentativas[entrada.id];
      await gravarRegisto(registo);
      log(`  ✅ agendado: "${pronto.title}" para ${String(pronto.scheduledAt).replace("T", " às ")}`);
    } catch (e) {
      const revisar = e && e.tipo === "revisar";
      const msg = (e && e.message) || String(e);
      log(`  ${revisar ? "🟡 para rever" : "❌ erro"}: ${msg}`);
      await alterarCofre((c) => marcarLink(c, entrada.id, revisar ? "revisar" : "erro", { erro: msg })).catch((e2) => log("  (não consegui marcar o erro no cofre: " + e2.message + ")"));
      delete registo.tentativas[entrada.id];
      await gravarRegisto(registo).catch(() => {});
    } finally {
      fs.promises.rm(pasta, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Repõe Reels que uma sincronização do app tenha atropelado. */
  async function conferirRecentes(cofre) {
    const registo = await lerRegisto();
    const recentes = Object.values(registo.reels).filter((r) => agora() - (r.updatedAt || 0) < CONFERIR_DURANTE_MS);
    const faltam = recentes.filter((r) => !(cofre.queue || []).some((q) => q.id === r.id) && !(cofre.deletedReelIds || []).includes(r.id));
    if (!faltam.length) return;
    log(`↺ ${faltam.length} Reel(s) do servidor sumiram do cofre (sincronização a meio) — a repor.`);
    await alterarCofre((c) => faltam.map((r) => juntarReel(c, r)).some(Boolean));
  }

  /**
   * Um ciclo: trata até `maxLinks` links pendentes. `restantes` diz quantos ficaram
   * por tratar (a Vercel usa-o para se chamar outra vez).
   */
  async function ciclo({ maxLinks = POR_CICLO } = {}) {
    await sinalDeVida(cfg, dono, { fetchFn });
    const cofre = await lerCofre(cfg, { fetchFn });
    if (!cofre) {
      log("Cofre ainda vazio: abre o CineClip, faz login e sincroniza uma vez.");
      return { processados: 0, restantes: 0 };
    }
    await conferirRecentes(cofre).catch((e) => log("conferir: " + e.message));
    const todos = (cofre.linksCelular || []).filter((e) => e && e.destino === "nuvem" && e.estado === "pendente");
    const pendentes = todos.slice(0, maxLinks);
    for (const entrada of pendentes) {
      await processarLink(entrada);
      await sinalDeVida(cfg, dono, { fetchFn });
    }
    return { processados: pendentes.length, restantes: todos.length - pendentes.length };
  }

  return { ciclo, processarLink, lerRegisto };
}
