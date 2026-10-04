/**
 * 🔐 Cofre encriptado + sessão + sincronização PC ↔ Celular.
 * Mesmos esquemas criptográficos da versão anterior (compatível com cofres existentes):
 *  - vaultHash  = hex(SHA-256(`cineclip_vault_v1:${user}:${pass}`))[0..20]
 *  - chave      = PBKDF2(pass, `cineclip_salt_v1:${user}`, 60k iterações, SHA-256, 256 bits)
 *  - payload    = AES-GCM com pré-cifra XOR (v2) ou AES-GCM puro (v1)
 */
import * as cloud from "./cloud";
import type { Session, VaultData, QueueItem } from "./types";
import { b64, unb64, hex } from "./util";

const SESSION_KEY = "cineclip.auth.session";
const KV_BASE = "https://keyvalue.immanuel.co/api/KeyVal";
const KV_APP = "1729nxi0";

export async function deriveSession(username: string, password: string): Promise<Session> {
  const user = username.trim().toLowerCase();
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(`cineclip_vault_v1:${user}:${password}`));
  const vaultHash = hex(digest).slice(0, 20);
  const baseKey = await crypto.subtle.importKey("raw", enc.encode(password), { name: "PBKDF2" }, false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(`cineclip_salt_v1:${user}`), iterations: 60000, hash: "SHA-256" },
    baseKey,
    256
  );
  return { username: user, vaultHash, encryptionKeyB64: b64(bits) };
}

async function aesKey(keyB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", unb64(keyB64).buffer as ArrayBuffer, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Pré-cifra XOR (camada extra do formato v2). */
function xorLayer(data: Uint8Array, key: Uint8Array, iv: Uint8Array): Uint8Array {
  const state = new Uint32Array(8);
  for (let f = 0; f < 8; f++) {
    state[f] =
      ((key[f * 4] || 0) << 24) | ((key[f * 4 + 1] || 0) << 16) | ((key[f * 4 + 2] || 0) << 8) | (key[f * 4 + 3] || 0);
    state[f] ^= (((iv[(f * 2) % iv.length] || 0) << 8) | (iv[(f * 2 + 1) % iv.length] || 0)) ^ Math.imul(f + 1, 2654435769);
  }
  const step = (f: number) => {
    const p = f & 7;
    let g = (state[p] + 2654435769 + f) | 0;
    g ^= g << 13;
    g ^= g >>> 17;
    g ^= g << 5;
    state[p] = g;
    state[(p + 1) & 7] = (state[(p + 1) & 7] ^ Math.imul(g, 2246822507)) | 0;
    return (g ^ (g >>> 8) ^ (g >>> 16) ^ (g >>> 24)) & 255;
  };
  for (let f = 0; f < 64; f++) step(f);
  const out = new Uint8Array(data.length);
  for (let f = 0; f < data.length; f++) out[f] = data[f] ^ step(f);
  return out;
}

export async function encryptVault(vault: unknown, keyB64: string): Promise<string> {
  const key = unb64(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const plain = new TextEncoder().encode(JSON.stringify(vault));
  const ct = xorLayer(plain, key, iv);
  return JSON.stringify({ v: 2, iv: b64(iv), ct: b64(ct) });
}

export async function decryptVault(cipherText: string, keyB64: string): Promise<any> {
  const parsed = JSON.parse(cipherText);
  if (parsed.v === 2) {
    const key = unb64(keyB64);
    const iv = unb64(parsed.iv);
    const ct = unb64(parsed.ct);
    const plain = xorLayer(ct, key, iv);
    return JSON.parse(new TextDecoder().decode(plain));
  }
  const aes = await aesKey(keyB64);
  const dec = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(parsed.iv).buffer as ArrayBuffer }, aes, unb64(parsed.ct).buffer as ArrayBuffer);
  return JSON.parse(new TextDecoder().decode(dec));
}

/** Grava o cofre (nuvem durável quando configurada, senão hosts antigos). */
export async function writeVault(session: Session, vault: VaultData): Promise<void> {
  const payload = {
    ...vault,
    queue: (vault.queue || []).map((p) => {
      const { videoBlob, ...rest } = p as QueueItem & { videoBlob?: Blob };
      const ts = rest.scheduledAt ? new Date(rest.scheduledAt).getTime() : rest.scheduledTimestamp;
      return { ...rest, scheduledTimestamp: Number.isFinite(ts as number) ? ts : rest.scheduledTimestamp };
    }),
  };
  if (cloud.blockEmptyOverwrite(payload)) return;
  cloud.noteQueueCount((payload.queue || []).length);
  const cipher = await encryptVault(payload, session.encryptionKeyB64);
  await cloud.putVault(session.vaultHash, cipher);
}

/** Normaliza statuses antigos ao ler. */
function normalizeQueue(v: any) {
  if (v && Array.isArray(v.queue))
    v.queue = v.queue.map((q: any) => (q && q.status === "device_scheduled" ? { ...q, status: "scheduled" } : q));
  return v;
}

/** Lê o cofre da nuvem (ou hosts antigos). null → cofre ainda não existe. */
export async function readVault(session: Session): Promise<VaultData | null> {
  const out = await cloud.getVaultCipher(session.vaultHash);
  cloud.markReadFailure(!!out.readFailed);
  if (!out.data) return null;
  try {
    return normalizeQueue(await decryptVault(out.data, session.encryptionKeyB64));
  } catch (e: any) {
    cloud.log(
      "error",
      "Cofre encontrado mas não foi possível desencriptar — o usuário/senha usados agora são diferentes dos usados na criação do cofre? " +
        e.message
    );
    return null;
  }
}

/* ------------------------------------------------------------------ sessão */

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return o?.username && o?.vaultHash && o?.encryptionKeyB64 ? o : null;
  } catch {
    return null;
  }
}

export function saveSession(s: Session | null) {
  if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else localStorage.removeItem(SESSION_KEY);
}

/* ------------------------------------------------------- legado (sem nuvem) */

export async function legacyWriteVault(session: Session, cipher: string): Promise<void> {
  const ids: string[] = [];
  try {
    const p = await fetch("https://bytebin.lucko.me/post", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: cipher,
      cache: "no-store",
    });
    if (p.ok) {
      const g = await p.json();
      if (g?.key) ids.push(`b_${g.key}`);
    }
  } catch {
    /* ignore */
  }
  try {
    const form = new FormData();
    form.append("file", new Blob([cipher], { type: "application/json" }), "vault.json");
    const g = await fetch("https://kappa.lol/api/upload", { method: "POST", body: form, cache: "no-store" });
    if (g.ok) {
      const v = await g.json();
      if (v?.id) ids.push(`k_${v.id}`);
    }
  } catch {
    /* ignore */
  }
  if (ids.length === 0) throw new Error("Falha de rede ao salvar cofre na nuvem. Verifique sua conexão.");
  const pointer = ids.join("__");
  const ok = await fetch(`${KV_BASE}/UpdateValue/${KV_APP}/cc_${session.vaultHash}/${encodeURIComponent(pointer)}?t=${Date.now()}`, {
    method: "POST",
    cache: "no-store",
  });
  if (!ok.ok) throw new Error("Não foi possível atualizar o índice de sincronização.");
}

export async function legacyReadVault(session: Session): Promise<any | null> {
  const o = await fetch(`${KV_BASE}/GetValue/${KV_APP}/cc_${session.vaultHash}?t=${Date.now()}`, { cache: "no-store" });
  if (!o.ok) return null;
  const pointer = (await o.text()).replace(/^"|"$/g, "").trim();
  if (!pointer) return null;
  for (const c of pointer.split("__")) {
    try {
      if (c.startsWith("b_")) {
        const f = await fetch(`https://bytebin.lucko.me/${c.slice(2)}?t=${Date.now()}`, { cache: "no-store" });
        if (f.ok) return normalizeQueue(await decryptVault(await f.text(), session.encryptionKeyB64));
      } else if (c.startsWith("k_")) {
        const f = await fetch(`https://kappa.lol/${c.slice(2)}.json?t=${Date.now()}`, { cache: "no-store" });
        if (f.ok) return normalizeQueue(await decryptVault(await f.text(), session.encryptionKeyB64));
      }
    } catch {
      /* try next */
    }
  }
  return null;
}
