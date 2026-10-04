/**
 * 📣 Publicação de Reels na Graph API do Instagram.
 * Duas estratégias (a ordem depende do estado do link guardado):
 *   1) ENVIO DIRETO (upload_type=resumable → rupload.facebook.com): o .mp4 sai do
 *      browser direto para a Meta, sem link público — mata o erro 2207077;
 *   2) VIDEO_URL verificado: o link é sondado antes de gastar a tentativa e é
 *      renovado na nuvem durável quando está morto/expirado/é de host temporário.
 * Repetição com container novo até 3 tentativas; erros permanentes não repetem.
 */
import * as cloud from "./cloud";
import { boostPoster, fmtSize, sleep } from "./util";
import type { Account, QueueItem } from "./types";

const GRAPH_BASE = "https://graph.facebook.com/v21.0";

export const IG_DICAS: Record<string, string> = {
  "2207077": "não consegui descarregar o vídeo a partir do link",
  "2207052": "o Instagram não conseguiu descarregar o vídeo nem a capa — confirma que o link é público e responde video/mp4.",
  "2207003": "o Instagram demorou demasiado a descarregar o vídeo (link lento ou instável).",
  "2207042": "limite de publicações do Instagram atingido (50 em 24 h) — tenta mais tarde.",
  "2207050": "a conta do Instagram está restringida — resolve isso na app do Instagram.",
  "2207051": "o Instagram restringiu a atividade desta conta (possível spam) — abranda as publicações.",
  "2207032": "instabilidade temporária da API do Instagram — vale a pena repetir.",
  "2207053": "erro temporário no upload para o Instagram — vale a pena repetir.",
  "2207001": "erro temporário no servidor do Instagram — vale a pena repetir.",
};

const IG_PERMANENTES: Record<string, 1> = { "2207026": 1, "2207042": 1, "2207050": 1, "2207051": 1 };
const IG_ERROS_DOWNLOAD: Record<string, 1> = { "2207077": 1, "2207052": 1, "2207003": 1 };

export class IgError extends Error {
  igCode?: string;
  igSubcode?: string;
  igTrace?: string;
  igPermanente?: boolean;
  igRede?: boolean;
  igEtapa?: string;
  igStatus?: string;
  igTentativas?: number;
  igLinkMorto?: boolean;
}

export function igNumeroErro(e: unknown): string {
  const m = /(?:error code|code)\D{0,6}(\d{4,})/i.exec(String((e as any)?.message || e || ""));
  return m ? m[1] : "";
}

export const igDica = (cod: string) => (cod && IG_DICAS[cod] ? IG_DICAS[cod] : "");

export function igErroTemporario(e: any): boolean {
  if (e && (e.igPermanente || e.igEtapa === "publish" || e.igEtapa === "processamento")) return false;
  const cod = igNumeroErro(e);
  return cod ? !IG_PERMANENTES[cod] : true;
}

/** Reconstrói o link ?action=video do Drive contra o /exec configurado AGORA. */
export function igLinkDriveAtual(url: string): string {
  try {
    const cfg = cloud.config();
    if (!cfg.driveUrl) return "";
    const m = /[?&]id=([^&\s]+)/.exec(String(url || ""));
    if (!m || !/[?&]action=video\b/.test(String(url || ""))) return "";
    const novo = String(cfg.driveUrl).replace(/[?#].*$/, "") + "?action=video&id=" + m[1];
    return novo === String(url) ? "" : novo;
  } catch {
    return "";
  }
}

async function igLinkNuvemVivo(url: string): Promise<boolean | null> {
  try {
    return (await cloud.verifyPublicUrl(url)) ? true : false;
  } catch {
    return null;
  }
}

/** Tamanho do vídeo servido pelo Apps Script (?action=videohead). */
async function igDriveVideoHead(url: string): Promise<{ ok: boolean; size: number } | null> {
  try {
    const u = String(url || "").replace(/([?&])action=video\b/, "$1action=videohead");
    if (u === String(url)) return null;
    const res = await fetch(u, { cache: "no-store" });
    if (!res.ok) return null;
    const j: any = await res.json();
    if (j && j.ok) return { ok: true, size: Number(j.size) || 0 };
    if (j && (j.ok === false || j.error)) return { ok: false, size: 0 };
    return null;
  } catch {
    return null;
  }
}

export interface ProbeResult {
  estado: "ok" | "fraco" | "morto" | "inconclusivo";
  status: number;
  tipo: string;
  ranges: boolean;
  motivo: string;
}

/** Sonda o link do vídeo como a Meta o vai buscar. */
export async function igProbeVideoUrl(url: string): Promise<ProbeResult> {
  const out: ProbeResult = { estado: "inconclusivo", status: 0, tipo: "", ranges: false, motivo: "" };
  if (!url || !/^https?:/i.test(url)) {
    out.estado = "morto";
    out.motivo = "sem url";
    return out;
  }
  let ctl: AbortController | null = null;
  let to: ReturnType<typeof setTimeout> | null = null;
  const parar = () => {
    if (to) {
      clearTimeout(to);
      to = null;
    }
  };
  try {
    ctl = new AbortController();
  } catch {
    ctl = null;
  }
  const pedir = async (metodo: string, extra?: RequestInit | null, limite = 9000) => {
    const r = { status: 0, tipo: "", ranges: false };
    parar();
    if (ctl)
      to = setTimeout(() => {
        try {
          ctl!.abort();
        } catch {
          /* ignore */
        }
      }, limite);
    const res = await fetch(url, { method: metodo, cache: "no-store", signal: ctl ? ctl.signal : undefined, ...(extra || {}) });
    r.status = res.status;
    r.tipo = (res.headers.get("content-type") || "").toLowerCase();
    r.ranges = (res.headers.get("accept-ranges") || "").toLowerCase().indexOf("bytes") >= 0;
    try {
      if (res.body) (res.body as any).cancel();
    } catch {
      /* ignore */
    }
    return r;
  };
  const aplicar = (r: any) => {
    out.status = r.status;
    out.tipo = r.tipo;
    out.ranges = r.ranges;
  };
  const bom = (r: any) => r.status >= 200 && r.status < 300 && !/^text\/html/.test(r.tipo);
  const morto = (r: any) =>
    r.status === 400 || r.status === 401 || r.status === 403 || r.status === 404 || r.status === 410 ||
    (r.status >= 200 && r.status < 300 && /^text\/html/.test(r.tipo));
  try {
    let head: any = null;
    let headFalhou = false;
    try {
      head = await pedir("HEAD", null, 9000);
    } catch {
      headFalhou = true;
    }
    let get: any = null;
    if (!(head && bom(head))) {
      try {
        get = await pedir("GET", { headers: { Range: "bytes=0-1" } }, 12000);
      } catch {
        /* ignore */
      }
    }
    if (head && bom(head)) {
      aplicar(head);
      out.estado = "ok";
    } else if (get && bom(get)) {
      aplicar(get);
      out.estado = "fraco";
    } else if (get && morto(get)) {
      aplicar(get);
      out.estado = "morto";
    } else if (head && morto(head)) {
      aplicar(head);
      out.estado = "morto";
    } else if (head) {
      aplicar(head);
      out.estado = "inconclusivo";
    } else if (get) {
      aplicar(get);
      out.estado = "inconclusivo";
    } else {
      out.estado = "inconclusivo";
      out.motivo = headFalhou ? "cors/rede" : "timeout";
    }
  } catch (e: any) {
    out.estado = "inconclusivo";
    out.motivo = e?.name === "AbortError" ? "timeout" : "cors/rede";
  } finally {
    parar();
  }
  return out;
}

function igErroGraph(res: { json?: any; status?: number }, prefixo: string): IgError {
  const j = res && res.json;
  const e = j && j.error;
  const err = new IgError((e && e.message) || prefixo || "Erro na API do Instagram.");
  err.igCode = e && e.code ? String(e.code) : "";
  err.igSubcode = e && e.error_subcode ? String(e.error_subcode) : "";
  err.igTrace = (e && e.fbtrace_id) || "";
  if (err.igCode === "190" || err.igCode === "102" || err.igCode === "10" || err.igCode === "200")
    err.igPermanente = true;
  return err;
}

async function igGraphPost(caminho: string, params: URLSearchParams) {
  let res: Response;
  try {
    res = await fetch(GRAPH_BASE + caminho, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
  } catch (e: any) {
    const err = new IgError(`Sem ligação à API do Instagram (${e?.message || e}). Verifica a internet e tenta outra vez.`);
    err.igRede = true;
    throw err;
  }
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* ignore */
  }
  return { ok: res.ok, status: res.status, json };
}

async function igGraphGet(caminho: string, params: Record<string, string>) {
  let res: Response;
  try {
    res = await fetch(GRAPH_BASE + caminho + "?" + new URLSearchParams(params).toString(), { cache: "no-store" });
  } catch (e: any) {
    const err = new IgError(`Sem ligação à API do Instagram (${e?.message || e}).`);
    err.igRede = true;
    throw err;
  }
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* ignore */
  }
  return { ok: res.ok, status: res.status, json };
}

/** Cria o container REELS (com a capa; se o Instagram recusar a capa, tenta sem ela). */
async function igCriarContainer(igUserId: string, token: string, base: Record<string, string>, capa: string) {
  const tentar = async (comCapa: boolean) => {
    const p = new URLSearchParams(base);
    if (comCapa && capa) p.set("cover_url", capa);
    return await igGraphPost("/" + encodeURIComponent(igUserId) + "/media", p);
  };
  let res = await tentar(!!capa);
  if ((!res.ok || !res.json || res.json.error || !res.json.id) && capa) res = await tentar(false);
  return res;
}

/** Estratégia 1: envio direto (upload_type=resumable). */
async function igContainerDireto(
  igUserId: string,
  token: string,
  item: QueueItem,
  account: Account,
  onStep?: (s: string) => void
): Promise<string> {
  onStep && onStep("A abrir a sessão de envio direto no Instagram (sem link público)…");
  const base: Record<string, string> = {
    media_type: "REELS",
    upload_type: "resumable",
    caption: item.caption || "",
    share_to_feed: account.shareToFeed === false ? "false" : "true",
    access_token: token,
  };
  const res = await igCriarContainer(igUserId, token, base, boostPoster(item.poster));
  if (!res.ok || !res.json || res.json.error || !res.json.id)
    throw igErroGraph(res, "Falha ao abrir a sessão de envio direto na API do Instagram.");
  const id = String(res.json.id);
  const uri =
    (res.json.uri && String(res.json.uri)) ||
    "https://rupload.facebook.com/ig-api-upload/v21.0/" + encodeURIComponent(id);
  onStep && onStep(`A enviar o .mp4 direto para o Instagram (${fmtSize(item.videoBlob?.size)}) — sem link público…`);
  const up = await igUploadBinario(uri, token, item.videoBlob!, (pct) =>
    onStep && onStep("A enviar o .mp4 direto para o Instagram… " + pct + "%")
  );
  if (up.status < 200 || up.status >= 300) {
    const err = new IgError(`A Meta recusou o envio direto do .mp4 (HTTP ${up.status} ${String(up.text || "").slice(0, 160)}).`);
    err.igRede = true;
    throw err;
  }
  return id;
}

/** Envio binário com XHR (progresso + timeout próprios). */
function igUploadBinario(
  url: string,
  token: string,
  blob: Blob,
  onProgress?: (pct: number) => void
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    let xhr: XMLHttpRequest;
    try {
      xhr = new XMLHttpRequest();
    } catch {
      reject(new IgError("Este navegador não suporta o envio direto (XMLHttpRequest indisponível)."));
      return;
    }
    xhr.open("POST", url, true);
    xhr.timeout = 15 * 60 * 1000;
    try {
      xhr.setRequestHeader("Authorization", "OAuth " + token);
      xhr.setRequestHeader("offset", "0");
      xhr.setRequestHeader("file_size", String(blob.size));
    } catch {
      /* ignore */
    }
    if (onProgress && xhr.upload) {
      xhr.upload.onprogress = (ev) => {
        if (ev && ev.lengthComputable && ev.total > 0) onProgress(Math.round((ev.loaded * 100) / ev.total));
      };
    }
    xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText || "" });
    xhr.onerror = () => {
      const e = new IgError("O envio direto para o Instagram falhou (rede ou bloqueio CORS do navegador).");
      e.igRede = true;
      reject(e);
    };
    xhr.ontimeout = () => {
      const e = new IgError("O envio direto para o Instagram excedeu o tempo limite.");
      e.igRede = true;
      reject(e);
    };
    xhr.onabort = () => {
      const e = new IgError("O envio direto para o Instagram foi cancelado.");
      e.igRede = true;
      reject(e);
    };
    try {
      xhr.send(blob);
    } catch (e: any) {
      const err = new IgError("O navegador recusou iniciar o envio direto: " + (e?.message || e));
      err.igRede = true;
      reject(err);
    }
  });
}

/** Estratégia 2: video_url (a Meta vai buscar o ficheiro ao link público). */
async function igContainerLink(
  igUserId: string,
  token: string,
  item: QueueItem,
  account: Account,
  link: string
): Promise<string> {
  const base: Record<string, string> = {
    media_type: "REELS",
    video_url: link,
    caption: item.caption || "",
    share_to_feed: account.shareToFeed === false ? "false" : "true",
    access_token: token,
  };
  const res = await igCriarContainer(igUserId, token, base, boostPoster(item.poster));
  if (!res.ok || !res.json || res.json.error || !res.json.id)
    throw igErroGraph(res, "Falha ao criar container de Reels na API do Instagram.");
  return String(res.json.id);
}

function igMediaAindaProcessa(e: unknown): boolean {
  const msg = String((e as any)?.message || e || "");
  return /(media|m[ií]dia|reel|v[ií]deo|video).*(process|not ready|still|ready)|(process|not ready).*(media|m[ií]dia|reel|v[ií]deo|video)/i.test(msg);
}

/** Espera o processamento (status_code) e publica (repõe o MESMO creation_id). */
async function waitForProcessingAndPublish(
  igUserId: string,
  containerId: string,
  token: string,
  onStep?: (s: string) => void
): Promise<{ publishedId: string; publishedUrl: string }> {
  const inicio = Date.now();
  let n = 0;
  for (;;) {
    n++;
    const st = await igGraphGet("/" + encodeURIComponent(containerId), {
      fields: "status_code,status",
      access_token: token,
    });
    if (!st.ok || !st.json) throw igErroGraph(st, "Falha ao consultar o estado do vídeo no Instagram.");
    const codigo = st.json.status_code;
    if (codigo === "FINISHED") break;
    if (codigo === "ERROR" || codigo === "EXPIRED") {
      const detalhe = String(st.json.status || codigo);
      const numero = (/(\d{4,})/.exec(detalhe) || [])[1] || "";
      const dica = igDica(numero);
      const erro = new IgError(
        "O Instagram recusou o processamento do vídeo" +
          (numero ? ` (código ${numero})` : "") +
          ": " +
          detalhe +
          (dica ? ` · Dica: ${dica}` : "")
      );
      erro.igCode = numero;
      erro.igStatus = detalhe;
      throw erro;
    }
    if (Date.now() - inicio > 360000) {
      const t = new IgError(
        "Tempo limite excedido enquanto o Instagram processava o vídeo (6 minutos). O container pode ainda ficar pronto — tenta publicar outra vez dentro de alguns minutos."
      );
      t.igEtapa = "processamento";
      throw t;
    }
    const passados = Math.round((Date.now() - inicio) / 1000);
    onStep && onStep(`O Instagram está a processar o vídeo (${passados}s)…`);
    await sleep(n <= 6 ? 5000 : n <= 14 ? 10000 : 15000);
  }
  onStep && onStep("A publicar Reels no perfil do Instagram…");
  let pub: any = null;
  let ultimo: IgError | null = null;
  let mediaAindaProcessa = false;
  for (let tentativa = 1; tentativa <= 12; tentativa++) {
    let res: any = null;
    try {
      res = await igGraphPost(
        "/" + encodeURIComponent(igUserId) + "/media_publish",
        new URLSearchParams({ creation_id: containerId, access_token: token })
      );
    } catch (e) {
      if (e && (e as IgError).igRede) (e as IgError).igEtapa = "publish";
      throw e;
    }
    if (res.ok && res.json && res.json.id && !res.json.error) {
      pub = res;
      break;
    }
    ultimo = igErroGraph(res, "Falha ao finalizar publicação do Reels.");
    mediaAindaProcessa = igMediaAindaProcessa(ultimo);
    const codErro = res.json?.error?.code ? String(res.json.error.code) : "";
    const limite = mediaAindaProcessa ? 12 : 4;
    if (tentativa === limite || IG_PERMANENTES[codErro] || codErro === "190" || codErro === "10" || codErro === "200") break;
    if (mediaAindaProcessa) {
      onStep && onStep("O Instagram ainda está a processar o Reel — a aguardar antes de publicar novamente…");
      await sleep(Math.min(15000, 3000 * tentativa));
    } else {
      await sleep(4000 * tentativa);
    }
  }
  const j = pub && pub.json;
  if (!pub || !pub.ok || !j || j.error || !j.id) {
    if (ultimo) {
      if (mediaAindaProcessa) {
        ultimo.igEtapa = "processamento";
        ultimo.message =
          "O Instagram ainda está a processar este Reel. Aguarda alguns instantes e tenta novamente — o mesmo vídeo não será enviado outra vez automaticamente.";
      } else ultimo.igEtapa = "publish";
      throw ultimo;
    }
    throw new IgError("Falha ao finalizar publicação do Reels.");
  }
  const id = String(j.id);
  let link = "";
  try {
    const g = await igGraphGet("/" + encodeURIComponent(id), { fields: "permalink", access_token: token });
    link = (g.json && g.json.permalink) || "";
  } catch {
    /* ignore */
  }
  return { publishedId: id, publishedUrl: link };
}

/** Envia o .mp4 do item para a nuvem e devolve {url, erro}. */
async function enviarArquivo(
  item: QueueItem,
  onStep?: (s: string) => void,
  motivo?: string
): Promise<{ url: string; erro: string }> {
  if (!item.videoBlob) return { url: "", erro: "Este aparelho não tem o ficheiro .mp4 deste Reel." };
  onStep && onStep(motivo || "A enviar ficheiro .mp4 direto da tua internet…");
  try {
    const url = await cloud.uploadVideo(item.videoBlob, item.videoFileName || "reel_cineclip.mp4", {
      onProgress: (p) => onStep && onStep(typeof p === "number" ? `A enviar o .mp4 para a nuvem… ${Math.round(p)}%` : p),
    });
    if (!url) return { url: "", erro: "A nuvem não devolveu um link para o vídeo." };
    return { url: String(url), erro: "" };
  } catch (e: any) {
    return { url: "", erro: e?.message || String(e) };
  }
}

export interface PublishResult {
  publishedId: string;
  publishedUrl: string;
  remoteVideoUrl?: string;
}

/**
 * Publica um Reel (Graph API ou Webhook), com claims anti-duplicado,
 * envio direto/link verificado e retries com container novo.
 */
export async function publishReel(
  item: QueueItem,
  account: Account,
  onStep?: (s: string) => void,
  claim?: cloud.ClaimResult
): Promise<PublishResult> {
  if (!item.videoBlob && !item.remoteVideoUrl)
    throw new IgError("Este item não possui o ficheiro de vídeo (.mp4) anexado nem URL na nuvem.");
  const capa = boostPoster(item.poster);
  const temBlob = !!item.videoBlob;

  if (account.mode === "webhook") {
    const w = (account.webhookUrl || "").trim();
    if (!w) throw new IgError("Configura a URL do Webhook (Make / n8n) antes de enviar.");
    let url = item.remoteVideoUrl && /^https?:/i.test(item.remoteVideoUrl) ? item.remoteVideoUrl : "";
    if (!url) {
      const env = await enviarArquivo(item, onStep);
      if (!env.url) throw new IgError("Não foi possível gerar link direto (.mp4) do vídeo: " + env.erro);
      url = env.url;
    }
    onStep && onStep(capa ? "A acionar Webhook com vídeo + pôster oficial de capa…" : "A acionar Webhook (Make.com / n8n)…");
    const k = await fetch(w, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: item.id,
        accountId: account.id || item.accountId || "acc_default",
        accountName: account.name || "@conta.principal",
        title: item.title,
        originalTitle: item.originalTitle,
        year: item.year,
        hookText: item.hookText,
        caption: item.caption,
        scheduledAt: item.scheduledAt,
        platforms: item.platforms,
        videoUrl: url,
        coverUrl: capa || "",
        poster: capa || "",
        videoFileName: item.videoFileName,
      }),
    });
    if (!k.ok) throw new IgError("O Webhook respondeu com erro HTTP " + k.status + ".");
    return { publishedId: "webhook_" + Date.now(), publishedUrl: url, remoteVideoUrl: url };
  }

  const u = (account.igUserId || "").trim();
  const f = (account.metaAccessToken || "").trim();
  if (!u || !f)
    throw new IgError("Configura o ID da Conta Instagram e o Access Token da Meta (ou muda para Webhook / Meta Business Suite).");
  if (temBlob && item.videoBlob!.size > 300 * 1048576)
    throw new IgError(`O ficheiro tem ${fmtSize(item.videoBlob!.size)} e o Instagram aceita no máximo 300 MB por Reel.`);

  let link = item.remoteVideoUrl && /^https?:/i.test(item.remoteVideoUrl) ? item.remoteVideoUrl : "";
  let linkFresco = false;
  let linkSuspeito = false;
  const usarLink = (url: string) => {
    if (!url) return;
    link = url;
    item.remoteVideoUrl = url;
    try {
      item.cloudProvider = cloud.classifyUrl(url);
    } catch {
      /* ignore */
    }
  };

  /* O link guardado ainda serve? */
  if (link) {
    const atual = igLinkDriveAtual(link);
    if (atual) {
      usarLink(atual);
      onStep && onStep("O link do vídeo apontava para uma implantação antiga do Apps Script — atualizado para a atual.");
    }
    const tipo = cloud.classifyUrl(link);
    if (tipo === "temp") {
      linkSuspeito = true;
      if (temBlob) {
        onStep && onStep("O link guardado é de um host temporário (pode já ter expirado) — a enviar o .mp4 para a nuvem durável…");
        const env = await enviarArquivo(item, onStep, "A renovar o link do vídeo na nuvem durável…");
        if (env.url) {
          usarLink(env.url);
          linkFresco = true;
          linkSuspeito = false;
        }
      } else {
        onStep && onStep("⚠️ Este Reel só tem um link de host temporário (pode já ter expirado). Se o Instagram recusar, reimporta o .mp4 neste aparelho.");
      }
    } else if (tipo === "r2" || tipo === "drive" || tipo === "local") {
      const vivo = tipo === "local" ? null : await igLinkNuvemVivo(link);
      if (vivo === false) {
        linkSuspeito = true;
        if (temBlob) {
          onStep && onStep("Não consegui confirmar o link do vídeo na nuvem durável — a enviar o .mp4 de novo…");
          const env = await enviarArquivo(item, onStep, "A refazer o link do vídeo na nuvem…");
          if (env.url) {
            usarLink(env.url);
            linkFresco = true;
            linkSuspeito = false;
          }
        } else {
          onStep && onStep("⚠️ O link deste Reel na nuvem não respondeu e este aparelho não tem o .mp4. Se o Instagram recusar (erro 2207077), reimporta o .mp4 neste aparelho.");
        }
      } else if (tipo === "drive") {
        const cab = await igDriveVideoHead(link);
        if (cab && cab.ok === false) {
          linkSuspeito = true;
          if (temBlob) {
            onStep && onStep("O vídeo já não está no Google Drive — a enviar o .mp4 de novo…");
            const env = await enviarArquivo(item, onStep, "A refazer o link do vídeo na nuvem…");
            if (env.url) {
              usarLink(env.url);
              linkFresco = true;
              linkSuspeito = false;
            } else
              throw new IgError("O vídeo já não está no Google Drive e não foi possível reenviá-lo. Reimporta o .mp4 neste aparelho antes de publicar.");
          } else {
            throw new IgError("O vídeo já não está no Google Drive e este aparelho não tem o ficheiro .mp4. Reimporta o .mp4 neste aparelho e volta a publicar.");
          }
        } else if (cab && cab.ok && cab.size > 49 * 1048576) {
          if (temBlob) {
            linkSuspeito = true;
            onStep && onStep(`O vídeo tem ${fmtSize(cab.size)} e o link do Apps Script só serve até ~50 MB — a dar prioridade ao envio direto.`);
          } else
            throw new IgError(
              `O vídeo tem ${fmtSize(cab.size)} e o link do Google Drive (Apps Script) só consegue servir ficheiros até ~50 MB — o Instagram não vai conseguir descarregá-lo (erro 2207077). Reimporta o .mp4 neste aparelho (envio direto, sem link) ou usa o Cloudflare R2 para vídeos grandes.`
            );
        }
      }
    } else if (tipo === "unknown" || tipo === "local") {
      const sonda = await igProbeVideoUrl(link);
      if (sonda.estado === "morto") {
        linkSuspeito = true;
        if (temBlob) {
          onStep && onStep(`O link guardado já não devolve o vídeo (HTTP ${sonda.status}) — a enviar o .mp4 de novo…`);
          const env = await enviarArquivo(item, onStep, "A refazer o link do vídeo…");
          if (env.url) {
            usarLink(env.url);
            linkFresco = true;
            linkSuspeito = false;
          } else
            throw new IgError(`O link do vídeo já não existe (HTTP ${sonda.status}) e não foi possível reenviá-lo (${env.erro}). Reimporta o .mp4 neste aparelho antes de publicar.`);
        } else {
          throw new IgError(`O link do vídeo já não existe (HTTP ${sonda.status}). Reimporta o .mp4 neste aparelho e volta a publicar.`);
        }
      } else if (sonda.estado === "fraco" && temBlob) {
        linkSuspeito = true;
        onStep && onStep("O host do link recusa pedidos HEAD (causa conhecida do erro 2207077) — a enviar o .mp4 de novo…");
        const env = await enviarArquivo(item, onStep, "A refazer o link do vídeo num host compatível…");
        if (env.url) {
          usarLink(env.url);
          linkFresco = true;
          linkSuspeito = false;
        }
      }
    }
  }

  if (!link && !temBlob)
    throw new IgError("Este Reel não tem ficheiro .mp4 neste aparelho nem link na nuvem. Reimporta o .mp4 para o publicares.");

  const preferirDireto = temBlob && (!link || linkSuspeito);
  const plano: string[] = temBlob ? (preferirDireto ? ["direto", "link", "link"] : ["link", "direto", "link"]) : ["link", "link"];

  const renovarClaim = async (): Promise<boolean> => {
    try {
      const c = await cloud.claimPublish(item, { ttlMs: 30 * 60 * 1000, owner: claim?.owner });
      return !(c && c.ok === false);
    } catch {
      return true;
    }
  };

  let ultimoErro: IgError | null = null;
  let tentativasFeitas = 0;
  for (let t = 0; t < plano.length; t++) {
    const modo = plano[t];
    if (!(await renovarClaim())) {
      const erroClaim = new IgError(
        "Outro aparelho ou o Robô 24h está a publicar este Reel agora (proteção anti-duplicado). Tenta novamente dentro de alguns minutos."
      );
      erroClaim.igPermanente = true;
      ultimoErro = erroClaim;
      break;
    }
    tentativasFeitas++;
    try {
      let containerId = "";
      if (modo === "direto") {
        containerId = await igContainerDireto(u, f, item, account, onStep);
      } else {
        if (t > 0 && temBlob && !linkFresco) {
          onStep && onStep("A repetir com um link novo — a enviar o .mp4 para a nuvem…");
          const env = await enviarArquivo(item, onStep, "A refazer o link do vídeo…");
          if (env.url) {
            usarLink(env.url);
            linkFresco = true;
          }
        }
        if (!link) {
          const env = await enviarArquivo(item, onStep, "A enviar ficheiro .mp4 direto da tua internet…");
          if (!env.url) throw new IgError("Não foi possível gerar link direto (.mp4) do vídeo para o Instagram: " + env.erro);
          usarLink(env.url);
          linkFresco = true;
        }
        onStep && onStep(capa ? "A criar container do Reels no Instagram (com Pôster Oficial de Capa)…" : "A criar container do Reels no Instagram…");
        containerId = await igContainerLink(u, f, item, account, link);
      }
      const res = await waitForProcessingAndPublish(u, containerId, f, onStep);
      return { ...res, remoteVideoUrl: link || item.remoteVideoUrl };
    } catch (e) {
      ultimoErro = e as IgError;
      const cod = String((e as IgError)?.igCode || igNumeroErro(e) || "");
      if (!igErroTemporario(e)) break;
      if (t < plano.length - 1) {
        if (!temBlob && IG_ERROS_DOWNLOAD[cod] && link) {
          const sonda = await igProbeVideoUrl(link);
          if (sonda.estado === "morto") {
            (ultimoErro as IgError).igLinkMorto = true;
            break;
          }
        }
        onStep && onStep(`O Instagram recusou esta tentativa${cod ? ` (erro ${cod})` : ""} — a repetir com um container novo (${t + 2}/${plano.length})…`);
        await sleep(2000 + 3000 * t);
      }
    }
  }

  const codigo = String((ultimoErro as IgError)?.igCode || igNumeroErro(ultimoErro) || "");
  const dica = igDica(codigo);
  const base = (ultimoErro && ultimoErro.message) || "Falha ao publicar o Reels no Instagram.";
  const semArquivo =
    !temBlob && (IG_ERROS_DOWNLOAD[codigo] || (ultimoErro && ultimoErro.igLinkMorto))
      ? ((ultimoErro && ultimoErro.igLinkMorto) ? " · O link do vídeo já não responde." : "") +
        " · Este aparelho não tem o ficheiro .mp4 deste Reel: reimporta o .mp4 no Agendador para o app o enviar direto para o Instagram, sem depender do link."
      : "";
  const erro = new IgError(
    base + ((dica && !/Dica:/.test(base)) ? ` · Dica: ${dica}` : "") + semArquivo + (tentativasFeitas > 1 ? ` (após ${tentativasFeitas} tentativas)` : "")
  );
  erro.igCode = codigo;
  erro.igTentativas = tentativasFeitas;
  if (ultimoErro && ultimoErro.igEtapa) erro.igEtapa = ultimoErro.igEtapa;
  throw erro;
}
