import type { Settings } from "./types";

const SETTINGS_KEY = "cineclip.settings";
const HISTORY_KEY = "cineclip.history";

export const DEFAULT_SETTINGS: Settings = {
  geminiKey: "",
  nvidiaKey: "",
  tmdbKey: "",
  overlayText: "Você precisa assistir esse filme 😳",
  lang: "pt-PT",
  bold: true,
  resolution: "720",
  autoHook: true,
  driveScriptUrl: "",
  driveToken: "",
  driveChunkMb: 2,
  driveSingleMaxMb: 8,
  r2WorkerUrl: "",
  r2Token: "",
  r2MaxMb: 95,
  r2Presign: true,
  cloudMirrorLegacy: true,
  cloudProvider: "auto",
};

export function loadSettings(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

export function loadHistory(): unknown[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}

export function pushHistory(entry: unknown) {
  const list = [entry, ...loadHistory()].slice(0, 10);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
}
