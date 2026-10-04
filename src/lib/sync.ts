/**
 * 🔄 Sincronização PC ↔ Celular: junta o estado local (IndexedDB + localStorage)
 * com o cofre encriptado na nuvem, envia primeiro os vídeos pendentes para a
 * nuvem durável e SÓ DEPOIS grava o cofre — já com os links dentro.
 */
import * as cloud from "./cloud";
import { loadSettings, saveSettings, loadHistory } from "./settings";
import { loadAccounts, saveAccounts, loadActiveAccountId, saveActiveAccountId, loadDeletedIds, saveDeletedIds } from "./accounts";
import { loadQueue, saveQueueItem, deleteQueueItem } from "./queue";
import { readVault, writeVault } from "./vault";
import { toast } from "./toast";
import type { Account, QueueItem, Session, Settings, VaultData } from "./types";

let running: Promise<VaultData> | null = null;
const uploading = new Set<string>();

export interface SyncInput {
  settings?: Settings;
  accounts?: Account[];
  activeAccountId?: string;
}

export async function syncAll(session: Session, input?: SyncInput, announce = false): Promise<VaultData> {
  if (running && !input) return running;
  const job = (async () => {
    const local = input?.settings || loadSettings();
    const localAccounts = input?.accounts || loadAccounts();
    const localActive = input?.activeAccountId || loadActiveAccountId(localAccounts);
    const localQueue = await loadQueue();
    const localDeleted = loadDeletedIds();
    const history = loadHistory();
    const remote = await readVault(session);

    /* settings: local ganha em campos preenchidos; remote preenche os vazios */
    const rs = remote?.settings || {};
    const merged: Settings = {
      ...local,
      geminiKey: local.geminiKey.trim() || (rs.geminiKey || "").trim() || "",
      tmdbKey: local.tmdbKey.trim() || (rs.tmdbKey || "").trim() || "",
      nvidiaKey: local.nvidiaKey.trim() || (rs.nvidiaKey || "").trim() || "",
      overlayText: local.overlayText.trim() || (rs.overlayText || "").trim() || "Você precisa assistir esse filme 😳",
      driveScriptUrl: (local.driveScriptUrl || "").trim() || (rs.driveScriptUrl || "").trim(),
      driveToken: (local.driveToken || "").trim() || (rs.driveToken || "").trim(),
      driveChunkMb: Number(local.driveChunkMb) || Number(rs.driveChunkMb) || 2,
      driveSingleMaxMb: Number(local.driveSingleMaxMb) || Number(rs.driveSingleMaxMb) || 8,
      r2WorkerUrl: (local.r2WorkerUrl || "").trim() || (rs.r2WorkerUrl || "").trim(),
      r2Token: (local.r2Token || "").trim() || (rs.r2Token || "").trim(),
      r2MaxMb: Number(local.r2MaxMb) || Number(rs.r2MaxMb) || 95,
      r2Presign: local.r2Presign !== false,
      cloudMirrorLegacy: local.cloudMirrorLegacy !== false,
      cloudProvider: ((local.cloudProvider || "").trim() || String(rs.cloudProvider || "auto").trim()) as Settings["cloudProvider"],
    };
    saveSettings(merged);

    /* accounts: merge por id (updatedAt mais recente ganha; credenciais preenchidas ganham) */
    const accMap = new Map<string, Account>();
    for (const a of remote?.accounts || []) accMap.set(a.id, a);
    for (const a of localAccounts) {
      const other = accMap.get(a.id);
      if (!other) accMap.set(a.id, a);
      else {
        const mine = a.updatedAt || 0;
        const theirs = other.updatedAt || 0;
        const newer = mine >= theirs ? a : other;
        const older = mine >= theirs ? other : a;
        accMap.set(a.id, {
          ...older,
          ...newer,
          webhookUrl: (newer.webhookUrl || "").trim() || (older.webhookUrl || "").trim() || "",
          igUserId: (newer.igUserId || "").trim() || (older.igUserId || "").trim() || "",
          metaAccessToken: (newer.metaAccessToken || "").trim() || (older.metaAccessToken || "").trim() || "",
        });
      }
    }
    const accounts = Array.from(accMap.values());
    saveAccounts(accounts);
    const active = accounts.some((a) => a.id === localActive)
      ? localActive
      : accounts.some((a) => a.id === remote?.activeAccountId)
        ? remote!.activeAccountId
        : accounts[0]?.id || "acc_default";
    saveActiveAccountId(active);

    /* deletados: união */
    const deleted = new Set([...localDeleted, ...(remote?.deletedReelIds || [])]);
    saveDeletedIds(Array.from(deleted));

    /* fila: merge por id (publicado ganha; updatedAt mais recente ganha; blobs/links locais preservam-se) */
    const queueMap = new Map<string, QueueItem>();
    for (const item of remote?.queue || []) {
      if (!deleted.has(item.id)) queueMap.set(item.id, item);
    }
    for (const item of localQueue) {
      if (deleted.has(item.id)) {
        await deleteQueueItem(item.id);
        continue;
      }
      const other = queueMap.get(item.id);
      if (!other) queueMap.set(item.id, item);
      else {
        const mine = item.updatedAt || item.createdAt || 0;
        const theirs = other.updatedAt || other.createdAt || 0;
        const winner = other.status === "published" && item.status !== "published" ? other : mine >= theirs ? item : other;
        queueMap.set(item.id, {
          ...winner,
          videoBlob: item.videoBlob || other.videoBlob,
          remoteVideoUrl: item.remoteVideoUrl || other.remoteVideoUrl,
          poster: item.poster || other.poster,
        });
      }
    }
    const queue = Array.from(queueMap.values()).sort((a, b) => (a.scheduledAt || "").localeCompare(b.scheduledAt || ""));
    for (const item of queue) await saveQueueItem(item);

    const vault: VaultData = {
      version: 1,
      updatedAt: Date.now(),
      settings: merged,
      accounts,
      activeAccountId: active,
      queue,
      deletedReelIds: Array.from(deleted),
      history: history.length > 0 ? history : remote?.history || [],
    };

    /* 1) PRIMEIRO envia os vídeos pendentes para a nuvem durável (aguardado). */
    const pending = queue
      .filter((k) => k.videoBlob && (k.needsReupload || k.cloudError || !k.remoteVideoUrl) && !uploading.has(k.id))
      .slice(0, 5);
    const toastId = pending.length > 0 ? "cineclip-cloud-upload" : null;
    for (let i = 0; i < pending.length; i++) {
      const item = pending[i];
      if (uploading.has(item.id)) continue;
      uploading.add(item.id);
      delete item.needsReupload;
      delete item.cloudError;
      try {
        if (toastId) toast.loading(`☁️ A enviar "${item.title}" para a nuvem durável (${i + 1}/${pending.length})…`, { id: toastId });
        const url = await cloud.uploadVideo(item.videoBlob, item.videoFileName || "reel_cineclip.mp4", {
          onProgress: (p) => toastId && toast.loading(`☁️ A enviar "${item.title}" (${i + 1}/${pending.length})… ${p}%`, { id: toastId }),
        });
        item.remoteVideoUrl = url;
        item.cloudProvider = cloud.classifyUrl(url);
        item.updatedAt = Date.now();
        await saveQueueItem(item);
        if (toastId) toast.success(`☁️ "${item.title}" guardado na nuvem durável — já pode ser publicado com o PC desligado.`, { id: toastId });
      } catch (e: any) {
        const msg = e?.message || "Falha ao enviar o vídeo para a nuvem";
        item.cloudError = msg;
        item.updatedAt = Date.now();
        await saveQueueItem(item);
        toast.error(`⚠️ "${item.title}" NÃO foi para a nuvem: ${msg}`, toastId ? { id: toastId } : undefined);
      } finally {
        uploading.delete(item.id);
      }
    }
    if (toastId) toast.dismiss(toastId);

    /* 2) SÓ DEPOIS grava o cofre — já com os links da nuvem dentro. */
    vault.queue = queue;
    vault.updatedAt = Date.now();
    await writeVault(session, vault);
    return vault;
  })().finally(() => {
    running = null;
  });
  running = job;
  const out = await job;
  if (announce) {
    const n = out.queue?.length || 0;
    const accs = out.accounts?.length || 1;
    toast.success(`Sincronizado! ${accs} conta(s) do Instagram e ${n} Reels na fila compartilhados entre PC e Celular.`);
  }
  return out;
}
