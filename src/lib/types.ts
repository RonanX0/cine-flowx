/** Tipos partilhados da aplicação CineClip. */

export interface Settings {
  geminiKey: string;
  nvidiaKey: string;
  tmdbKey: string;
  overlayText: string;
  lang: "pt-PT" | "pt-BR";
  bold: boolean;
  resolution: "720" | "1080";
  autoHook: boolean;
  driveScriptUrl: string;
  driveToken: string;
  driveChunkMb: number;
  driveSingleMaxMb: number;
  r2WorkerUrl: string;
  r2Token: string;
  r2MaxMb: number;
  r2Presign: boolean;
  cloudMirrorLegacy: boolean;
  cloudProvider: "auto" | "r2" | "drive" | "legacy";
}

export interface Account {
  id: string;
  name: string;
  mode: "graph" | "webhook" | "manual";
  igUserId: string;
  fbPageId: string;
  metaAccessToken: string;
  webhookUrl: string;
  dailySlots: string[];
  autoPilot: boolean;
  shareToFeed: boolean;
  updatedAt?: number;
}

export type ReelStatus =
  | "scheduled"
  | "device_scheduled"
  | "queued"
  | "publishing"
  | "published"
  | "error";

export interface QueueItem {
  id: string;
  accountId: string;
  title: string;
  originalTitle?: string;
  year?: number | string;
  poster?: string;
  hookText?: string;
  caption: string;
  scheduledAt: string; // YYYY-MM-DDTHH:MM
  scheduledTimestamp?: number;
  videoFileName?: string;
  videoSize?: number;
  videoBlob?: Blob;
  remoteVideoUrl?: string;
  cloudProvider?: string;
  cloudError?: string;
  needsReupload?: boolean;
  platforms: string[];
  status: ReelStatus;
  publishError?: string;
  publishedUrl?: string;
  publishedId?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface Ident {
  kind: "movie" | "tv";
  id: number;
  title: string;
  original: string;
  year: number | string;
  poster: string;
  overview: string;
  genres: string[];
  popularity?: number;
  cena?: string;
  atores?: string[];
  alternativas: Ident[];
  via?: string;
  confianca?: number;
}

export interface Session {
  username: string;
  vaultHash: string;
  encryptionKeyB64: string;
}

export interface VaultData {
  version: number;
  updatedAt: number;
  settings: Partial<Settings>;
  accounts: Account[];
  activeAccountId: string;
  queue: QueueItem[];
  deletedReelIds: string[];
  history: unknown[];
  lastSyncedAt?: number;
}
