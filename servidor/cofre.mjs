/**
 * Cofre do CineClip no servidor — a mesma cifra e os mesmos endereços que o app
 * (index.html: bS/Gm) e o Robô 24h (encriptarTexto/desencriptarTexto) usam.
 *
 * A configuração vem do código do Robô 24h que o utilizador cola na instalação
 * (VAULT_HASH, ENCRYPTION_KEY_B64, R2_WORKER_URL, R2_TOKEN, DRIVE_SCRIPT_URL,
 * DRIVE_TOKEN) — ver lerConfigDoRobo().
 */
import { webcrypto } from "node:crypto";

/* ------------------------------------------------------------ cifra (v2) */

/** Fluxo de cifra do cofre v2 — cópia fiel de Rg (app) / cryptStream256 (Robô). */
export function cifraFluxo(dados, chave, iv) {
  const s = new Uint32Array(8);
  for (let i = 0; i < 8; i++) {
    s[i] = ((chave[i * 4] || 0) << 24) | ((chave[i * 4 + 1] || 0) << 16) | ((chave[i * 4 + 2] || 0) << 8) | (chave[i * 4 + 3] || 0);
    s[i] ^= (((iv[(i * 2) % iv.length] || 0) << 8) | (iv[(i * 2 + 1) % iv.length] || 0)) ^ Math.imul(i + 1, 0x9e3779b9);
  }
  const proximo = (idx) => {
    const k = idx & 7;
    let x = (s[k] + 0x9e3779b9 + idx) | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    s[k] = x;
    s[(k + 1) & 7] = (s[(k + 1) & 7] ^ Math.imul(x, 0x85ebca6b)) | 0;
    return (x ^ (x >>> 8) ^ (x >>> 16) ^ (x >>> 24)) & 0xff;
  };
  for (let aquecer = 0; aquecer < 64; aquecer++) proximo(aquecer);
  const saida = new Uint8Array(dados.length);
  for (let i = 0; i < dados.length; i++) saida[i] = dados[i] ^ proximo(i);
  return saida;
}

const b64 = (u8) => Buffer.from(u8).toString("base64");
const deB64 = (s) => new Uint8Array(Buffer.from(String(s), "base64"));

export function cifrar(objeto, chaveB64) {
  const iv = webcrypto.getRandomValues(new Uint8Array(16));
  const texto = new TextEncoder().encode(JSON.stringify(objeto));
  return JSON.stringify({ v: 2, iv: b64(iv), ct: b64(cifraFluxo(texto, deB64(chaveB64), iv)) });
}

export async function decifrar(cifrado, chaveB64) {
  const p = JSON.parse(cifrado);
  if (p.v === 2) {
    return JSON.parse(new TextDecoder().decode(cifraFluxo(deB64(p.ct), deB64(chaveB64), deB64(p.iv))));
  }
  // v1 (AES-GCM) — cofres muito antigos; o app ainda os lê.
  const chave = await webcrypto.subtle.importKey("raw", deB64(chaveB64), { name: "AES-GCM" }, false, ["decrypt"]);
  const claro = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: deB64(p.iv) }, chave, deB64(p.ct));
  return JSON.parse(new TextDecoder().decode(claro));
}

/* ------------------------------------------------------------- config */

const CAMPOS = ["VAULT_HASH", "ENCRYPTION_KEY_B64", "R2_WORKER_URL", "R2_TOKEN", "DRIVE_SCRIPT_URL", "DRIVE_TOKEN"];

/** Extrai a configuração do código do Robô 24h colado pelo utilizador. */
export function lerConfigDoRobo(codigo) {
  const texto = String(codigo || "").trim();
  const chave = /CINECLIP1:([A-Za-z0-9+/=]+)/.exec(texto);
  if (chave) {
    // Chave curta do painel (📱 Compartilhar do celular → 🔑 Copiar chave do servidor).
    let cfg;
    try {
      cfg = JSON.parse(Buffer.from(chave[1], "base64").toString("utf8"));
    } catch {
      throw new Error("A chave do servidor está incompleta — copia-a outra vez no CineClip.");
    }
    return validarConfig(Object.fromEntries([...CAMPOS, "CONTA"].map((c) => [c, String(cfg[c] || "").trim()])));
  }
  return lerConfigDoCodigo(texto);
}

function validarConfig(cfg) {
  if (!cfg.VAULT_HASH || !cfg.ENCRYPTION_KEY_B64) {
    throw new Error("Não encontrei VAULT_HASH e ENCRYPTION_KEY_B64 — cola a chave do servidor (ou o código do Robô 24h inteiro).");
  }
  if (!(cfg.R2_WORKER_URL && cfg.R2_TOKEN) && !(cfg.DRIVE_SCRIPT_URL && cfg.DRIVE_TOKEN)) {
    throw new Error("A configuração não tem nuvem durável (R2 ou Drive). Configura a nuvem no CineClip e copia de novo.");
  }
  return cfg;
}

function lerConfigDoCodigo(codigo) {
  const cfg = {};
  for (const campo of CAMPOS) {
    const m = new RegExp(`const\\s+${campo}\\s*=\\s*"([^"]*)"`).exec(String(codigo || ""));
    cfg[campo] = m ? m[1].trim() : "";
  }
  const usuario = /Conta vinculada:\s*(.+)/.exec(String(codigo || ""));
  cfg.CONTA = usuario ? usuario[1].trim() : "";
  return validarConfig(cfg);
}

/* --------------------------------------------------------- ler/gravar */

function urlDrive(cfg, params) {
  const sep = cfg.DRIVE_SCRIPT_URL.includes("?") ? "&" : "?";
  return cfg.DRIVE_SCRIPT_URL + sep + new URLSearchParams(params).toString();
}

const r2 = (cfg) => !!(cfg.R2_WORKER_URL && cfg.R2_TOKEN);
const drive = (cfg) => !!(cfg.DRIVE_SCRIPT_URL && cfg.DRIVE_TOKEN);

/** Lê e decifra o cofre. Devolve null se ainda não existir. */
export async function lerCofre(cfg, { fetchFn = fetch } = {}) {
  const falhas = [];
  if (r2(cfg)) {
    try {
      const r = await fetchFn(`${cfg.R2_WORKER_URL}/api/vault/cc_${encodeURIComponent(cfg.VAULT_HASH)}`, {
        headers: { Authorization: "Bearer " + cfg.R2_TOKEN, "X-Cineclip-Client": "servidor" },
      });
      if (r.status === 200) {
        const texto = await r.text();
        if (texto && texto.length > 2) return await decifrar(texto, cfg.ENCRYPTION_KEY_B64);
      } else if (r.status !== 404) {
        falhas.push("R2 HTTP " + r.status);
      }
    } catch (e) {
      falhas.push("R2 " + (e.message || e));
    }
  }
  if (drive(cfg)) {
    try {
      const r = await fetchFn(urlDrive(cfg, { action: "vault", hash: cfg.VAULT_HASH, token: cfg.DRIVE_TOKEN }), { redirect: "follow" });
      const j = await r.json();
      if (j && j.ok === true && j.cipher) return await decifrar(j.cipher, cfg.ENCRYPTION_KEY_B64);
      if (j && j.ok === false && j.code !== "not_found") falhas.push("Drive " + (j.error || "erro"));
    } catch (e) {
      falhas.push("Drive " + (e.message || e));
    }
  }
  if (falhas.length) throw new Error("Não consegui ler o cofre: " + falhas.join(" | "));
  return null;
}

/** Cifra e grava o cofre (R2 primeiro; Drive se o R2 não estiver configurado ou falhar). */
export async function gravarCofre(cfg, cofre, { fetchFn = fetch } = {}) {
  // Igual ao Km do app: a fila no cofre leva scheduledTimestamp e nunca o blob.
  const pronto = {
    ...cofre,
    queue: (cofre.queue || []).map(({ videoBlob, ...item }) => {
      const t = item.scheduledAt ? new Date(item.scheduledAt).getTime() : item.scheduledTimestamp;
      return { ...item, scheduledTimestamp: Number.isFinite(t) ? t : item.scheduledTimestamp };
    }),
  };
  const cifrado = cifrar(pronto, cfg.ENCRYPTION_KEY_B64);
  const falhas = [];
  if (r2(cfg)) {
    const r = await fetchFn(`${cfg.R2_WORKER_URL}/api/vault/cc_${encodeURIComponent(cfg.VAULT_HASH)}`, {
      method: "PUT",
      headers: { Authorization: "Bearer " + cfg.R2_TOKEN, "Content-Type": "application/json" },
      body: cifrado,
    }).catch((e) => ({ ok: false, status: 0, erro: e }));
    if (r.ok) return { provider: "r2" };
    falhas.push("R2 HTTP " + r.status);
  }
  if (drive(cfg)) {
    const r = await fetchFn(urlDrive(cfg, { action: "vault", hash: cfg.VAULT_HASH, token: cfg.DRIVE_TOKEN }), {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: cifrado,
      redirect: "follow",
    }).catch(() => null);
    let j = null;
    try {
      j = r && (await r.json());
    } catch {}
    if (j && j.ok !== false) return { provider: "drive" };
    falhas.push("Drive " + ((j && j.error) || (r ? "HTTP " + r.status : "sem resposta")));
  }
  throw new Error("Não consegui gravar o cofre: " + falhas.join(" | "));
}

/* ------------------------------------------------------- vídeo e sinal */

/** Envia o .mp4 para o Worker R2 (POST /api/video) e devolve o link público. */
export async function enviarVideoR2(cfg, bytes, nome, { fetchFn = fetch } = {}) {
  if (!r2(cfg)) throw new Error("O servidor precisa do Cloudflare R2 para guardar os vídeos (configura-o no CineClip e copia de novo o código do Robô 24h).");
  const r = await fetchFn(`${cfg.R2_WORKER_URL}/api/video`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + cfg.R2_TOKEN,
      "Content-Type": "video/mp4",
      "X-File-Name": nome,
      "X-File-Size": String(bytes.byteLength),
      "X-Cineclip-Client": "servidor",
    },
    body: bytes,
  });
  let j = null;
  try {
    j = await r.json();
  } catch {}
  if (!r.ok || !j || !j.ok || !j.url) {
    throw new Error("O R2 recusou o vídeo: " + ((j && (j.error || j.message)) || "HTTP " + r.status));
  }
  return { url: j.url, key: j.key };
}

/**
 * "Estou vivo": o servidor mantém uma claim no Worker (cc_<cofre>_servidor_nuvem,
 * dono "servidor:…") renovada a cada ciclo. O app lista as claims ativas e mostra
 * "☁️ Servidor ligado". Falhar aqui nunca impede o processamento.
 */
export async function sinalDeVida(cfg, dono, { fetchFn = fetch, ttlMs = 5 * 60 * 1000 } = {}) {
  if (!r2(cfg)) return false;
  try {
    const r = await fetchFn(`${cfg.R2_WORKER_URL}/api/claims/acquire`, {
      method: "POST",
      headers: { Authorization: "Bearer " + cfg.R2_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ key: `cc_${cfg.VAULT_HASH}_servidor_nuvem`, owner: dono, ttlMs }),
    });
    const j = await r.json().catch(() => null);
    return !!(j && j.acquired);
  } catch {
    return false;
  }
}

/* ------------------------------------------------- trinco e registo (R2) */

/**
 * Trinco simples com as claims do Worker: só um processamento de cada vez (na
 * Vercel podem chegar dois pedidos ao mesmo tempo — o do celular e o do Robô).
 * Devolve true se ficou com o trinco. Sem R2 não há trinco (devolve true).
 */
export async function reclamar(cfg, nome, dono, { fetchFn = fetch, ttlMs = 5 * 60 * 1000 } = {}) {
  if (!r2(cfg)) return true;
  const r = await fetchFn(`${cfg.R2_WORKER_URL}/api/claims/acquire`, {
    method: "POST",
    headers: { Authorization: "Bearer " + cfg.R2_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ key: `cc_${cfg.VAULT_HASH}_${nome}`, owner: dono, ttlMs }),
  });
  const j = await r.json().catch(() => null);
  return !!(j && j.acquired);
}

export async function libertar(cfg, nome, dono, { fetchFn = fetch } = {}) {
  if (!r2(cfg)) return;
  await fetchFn(`${cfg.R2_WORKER_URL}/api/claims/release`, {
    method: "POST",
    headers: { Authorization: "Bearer " + cfg.R2_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ key: `cc_${cfg.VAULT_HASH}_${nome}`, owner: dono }),
  }).catch(() => {});
}

const REGISTO_VAZIO = () => ({ links: {}, reels: {}, tentativas: {} });

/**
 * Registo do servidor guardado no R2 (cifrado como o cofre). Na Vercel o disco é
 * temporário: sem isto, um link já tratado podia ser processado outra vez se uma
 * sincronização do app o devolvesse a "pendente".
 */
export function registoNoR2(cfg, { fetchFn = fetch } = {}) {
  const url = `${cfg.R2_WORKER_URL}/api/vault/cc_${encodeURIComponent(cfg.VAULT_HASH)}_registo_nuvem`;
  return {
    async ler() {
      const r = await fetchFn(url, { headers: { Authorization: "Bearer " + cfg.R2_TOKEN } });
      if (r.status === 404) return REGISTO_VAZIO();
      if (!r.ok) throw new Error("Não consegui ler o registo da nuvem (HTTP " + r.status + ").");
      const texto = await r.text();
      if (!texto || texto.length < 3) return REGISTO_VAZIO();
      return { ...REGISTO_VAZIO(), ...(await decifrar(texto, cfg.ENCRYPTION_KEY_B64)) };
    },
    async gravar(registo) {
      const r = await fetchFn(url, {
        method: "PUT",
        headers: { Authorization: "Bearer " + cfg.R2_TOKEN, "Content-Type": "application/json" },
        body: cifrar(registo, cfg.ENCRYPTION_KEY_B64),
      });
      if (!r.ok) throw new Error("Não consegui gravar o registo da nuvem (HTTP " + r.status + ").");
    },
  };
}
