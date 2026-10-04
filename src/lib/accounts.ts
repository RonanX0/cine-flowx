import type { Account } from "./types";

const CONFIG_KEY = "cineclip.scheduler.config";
const ACCOUNTS_KEY = "cineclip.ig.accounts";
const ACTIVE_KEY = "cineclip.ig.active";
const DELETED_KEY = "cineclip.scheduler.deleted";

export const DEFAULT_ACCOUNT: Omit<Account, "id" | "name"> = {
  mode: "graph",
  igUserId: "",
  fbPageId: "",
  metaAccessToken: "",
  webhookUrl: "",
  dailySlots: ["12:00", "18:00", "21:30"],
  autoPilot: true,
  shareToFeed: true,
};

function withSlots(a: Partial<Account>): Account {
  return {
    ...DEFAULT_ACCOUNT,
    ...a,
    id: a.id || "acc_default",
    name: a.name || "@conta.principal",
    dailySlots:
      Array.isArray(a.dailySlots) && a.dailySlots.length > 0
        ? a.dailySlots
        : [...DEFAULT_ACCOUNT.dailySlots],
  } as Account;
}

export function loadSchedulerConfig(): Account {
  try {
    return withSlots(JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}"));
  } catch {
    return withSlots({});
  }
}

export function loadAccounts(): Account[] {
  try {
    const raw = JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || "null");
    if (Array.isArray(raw) && raw.length > 0) return raw.map(withSlots);
  } catch {
    /* ignore */
  }
  const initial = [withSlots({ id: "acc_default", name: "@conta.principal" })];
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(initial));
  return initial;
}

export function saveAccounts(list: Account[]) {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list));
}

export function loadActiveAccountId(accounts: Account[]): string {
  const saved = localStorage.getItem(ACTIVE_KEY) || "";
  if (saved && accounts.some((a) => a.id === saved)) return saved;
  return accounts[0]?.id || "acc_default";
}

export function saveActiveAccountId(id: string) {
  localStorage.setItem(ACTIVE_KEY, id);
}

export function loadDeletedIds(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(DELETED_KEY) || "[]");
    return Array.isArray(raw) ? raw.slice(-200) : [];
  } catch {
    return [];
  }
}

export function addDeletedId(id: string) {
  const set = new Set(loadDeletedIds());
  set.add(id);
  localStorage.setItem(DELETED_KEY, JSON.stringify(Array.from(set).slice(-200)));
}

export function saveDeletedIds(ids: string[]) {
  localStorage.setItem(DELETED_KEY, JSON.stringify(Array.from(new Set(ids)).slice(-200)));
}

/** Valida a conta profissional na Graph API (devolve id/username). */
export async function validateMetaAccount(
  igUserId: string,
  accessToken: string
): Promise<{ id: string; username: string; name?: string }> {
  const u = igUserId.trim();
  const t = accessToken.trim();
  if (!u || !t)
    throw new Error("Preenche o ID da Conta Instagram Profissional e o Access Token da Meta.");
  const url = new URL(`https://graph.facebook.com/v21.0/${encodeURIComponent(u)}`);
  url.searchParams.set("fields", "id,username,name");
  url.searchParams.set("access_token", t);
  const res = await fetch(url.toString());
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.error)
    throw new Error(json?.error?.message || `Erro ${res.status} ao validar conta na Meta.`);
  return { id: String(json.id), username: String(json.username || json.name || json.id), name: json.name };
}
