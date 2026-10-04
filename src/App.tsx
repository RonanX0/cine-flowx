import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, Clapperboard, Settings as SettingsIcon } from "lucide-react";
import { Toaster } from "sonner";
import { Login } from "./components/Login";
import { Studio, type CurrentClip } from "./components/Studio";
import { Agendador } from "./components/Agendador";
import { SettingsDialog } from "./components/Settings";
import { loadSession, saveSession } from "./lib/vault";
import { syncAll } from "./lib/sync";
import { loadSettings, saveSettings } from "./lib/settings";
import { loadAccounts, saveAccounts, loadActiveAccountId, saveActiveAccountId } from "./lib/accounts";
import { cn } from "./components/ui";
import type { Account, Session, Settings, VaultData } from "./lib/types";

type Tab = "studio" | "agendador";

export default function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [accounts, setAccounts] = useState<Account[]>(() => loadAccounts());
  const [activeAccountId, setActiveAccountId] = useState<string>(() => loadActiveAccountId(loadAccounts()));
  const [tab, setTab] = useState<Tab>("studio");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [clip, setClip] = useState<CurrentClip | null>(null);
  const [queueTick, setQueueTick] = useState(0);
  const [refreshTick, setRefreshTick] = useState(0);

  /* sincroniza em segundo plano quando a fila muda */
  useEffect(() => {
    if (!session) return;
    const t = setTimeout(() => {
      syncAll(session, { settings, accounts, activeAccountId }).catch((e) => console.warn("sync", e));
    }, 1500);
    return () => clearTimeout(t);
  }, [queueTick, session, settings, accounts, activeAccountId]);

  const onLogin = useCallback((s: Session, vault: VaultData | null) => {
    setSession(s);
    if (vault?.settings) setSettings(loadSettings());
    if (Array.isArray(vault?.accounts) && vault!.accounts.length) {
      setAccounts(loadAccounts());
      setActiveAccountId(loadActiveAccountId(loadAccounts()));
    }
    setRefreshTick((t) => t + 1);
  }, []);

  const saveSettingsAndSync = useCallback(
    (s: Settings) => {
      setSettings(s);
      saveSettings(s);
      if (session) syncAll(session, { settings: s, accounts, activeAccountId }).catch(() => {});
    },
    [session, accounts, activeAccountId]
  );

  const changeAccounts = useCallback(
    (list: Account[], active?: string) => {
      setAccounts(list);
      saveAccounts(list);
      if (active) {
        setActiveAccountId(active);
        saveActiveAccountId(active);
      }
      if (session) syncAll(session, { settings, accounts: list, activeAccountId: active || activeAccountId }).catch(() => {});
    },
    [session, settings, activeAccountId]
  );

  const logout = () => {
    saveSession(null);
    setSession(null);
  };

  const stepDone = { upload: !!clip, filme: !!clip?.ident, legenda: !!clip?.caption };

  return (
    <div className="min-h-screen bg-background text-foreground">
      {!session ? (
        <Login onLoginSuccess={onLogin} />
      ) : (
        <>
          <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur">
            <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4">
              <button className="flex cursor-pointer items-center gap-2" onClick={() => setTab("studio")}>
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand">
                  <Clapperboard className="h-4 w-4 text-primary-foreground" />
                </span>
                <span className="text-lg font-extrabold">
                  Cine<span className="text-primary">Clip</span>
                </span>
              </button>
              <nav className="flex items-center gap-1 text-sm">
                <button
                  onClick={() => setTab("studio")}
                  className={cn("flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5", tab === "studio" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
                >
                  <Clapperboard className="h-4 w-4" /> Estúdio
                </button>
                <button
                  onClick={() => setTab("agendador")}
                  className={cn("flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5", tab === "agendador" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
                >
                  <CalendarClock className="h-4 w-4" /> Agendador
                </button>
              </nav>
              <button className="cursor-pointer rounded-md p-2 text-muted-foreground hover:text-foreground" onClick={() => setSettingsOpen(true)} title="Configurações">
                <SettingsIcon className="h-5 w-5" />
              </button>
            </div>
            {tab === "studio" && (
              <div className="mx-auto flex max-w-6xl items-center justify-center gap-2 pb-2 text-xs">
                <StepPill done={stepDone.upload} label="Upload" />
                <span className="text-muted-foreground">→</span>
                <StepPill done={stepDone.filme} label="Filme" active={!stepDone.upload} />
                <span className="text-muted-foreground">→</span>
                <StepPill done={stepDone.legenda} label="Legenda" />
              </div>
            )}
          </header>

          {tab === "studio" ? (
            <Studio
              settings={settings}
              onSettingsChange={saveSettingsAndSync}
              accounts={accounts}
              activeAccountId={activeAccountId}
              onQueueChanged={() => setQueueTick((t) => t + 1)}
              onOpenSettings={() => setSettingsOpen(true)}
              currentClip={clip}
              setCurrentClip={setClip}
            />
          ) : (
            <Agendador
              session={session}
              accounts={accounts}
              activeAccountId={activeAccountId}
              onAccountsChange={changeAccounts}
              refreshTick={refreshTick + queueTick}
              onQueueChanged={() => setQueueTick((t) => t + 1)}
            />
          )}

          <SettingsDialog
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
            settings={settings}
            onSave={saveSettingsAndSync}
            onLogout={logout}
          />
        </>
      )}
      <Toaster richColors position="bottom-right" />
    </div>
  );
}

function StepPill({ done, label, active }: { done: boolean; label: string; active?: boolean }) {
  return (
    <span
      className={cn(
        "rounded-full px-3 py-1",
        done ? "bg-success text-background" : active ? "bg-secondary text-muted-foreground" : "bg-primary text-primary-foreground"
      )}
    >
      {label}
    </span>
  );
}
