import { useState } from "react";
import { Clapperboard, KeyRound, Lock, RefreshCcw, ShieldCheck, User } from "lucide-react";
import { Button, Input, Label } from "./ui";
import { deriveSession, saveSession } from "../lib/vault";
import { syncAll } from "../lib/sync";
import { toast } from "../lib/toast";
import type { Session, VaultData } from "../lib/types";

export function Login({ onLoginSuccess }: { onLoginSuccess: (s: Session, v: VaultData | null) => void }) {
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const u = user.trim();
    const p = pass.trim();
    if (u.length < 3) {
      toast.error("Digite seu usuário ou e-mail (mínimo 3 caracteres).");
      return;
    }
    if (p.length < 4) {
      toast.error("Digite uma senha de pelo menos 4 caracteres.");
      return;
    }
    setBusy(true);
    try {
      const session = await deriveSession(u, p);
      const vault = await syncAll(session, undefined, false);
      saveSession(session);
      const n = vault.queue?.length || 0;
      const accs = vault.accounts?.length || 1;
      toast.success(`Sincronizado! ${accs} conta(s) do Instagram e ${n} Reels na fila compartilhados entre PC e Celular.`);
      onLoginSuccess(session, vault);
    } catch (err: any) {
      toast.error(err?.message || "Erro ao autenticar e sincronizar.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-10 font-sans text-foreground">
      <div className="w-full max-w-md space-y-6 rounded-2xl border border-border bg-card p-6 shadow-xl sm:p-8">
        <div className="flex flex-col items-center text-center">
          <div className="relative mb-3">
            <div className="absolute inset-0 rounded-full bg-brand opacity-40 blur-xl" />
            <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl bg-brand shadow-lg">
              <Clapperboard className="h-8 w-8 text-primary-foreground" />
            </div>
          </div>
          <h1 className="text-2xl font-extrabold tracking-tight">
            Cine<span className="text-primary">Clip</span> Studio
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">Sincronização Total PC ↔ Celular (Chaves, Contas e Fila de Reels)</p>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="login-user">Usuário ou E-mail</Label>
            <div className="relative">
              <User className="pointer-events-none absolute top-2.5 left-3 h-4 w-4 text-muted-foreground" />
              <Input
                id="login-user"
                type="text"
                autoComplete="username"
                value={user}
                onChange={(e) => setUser(e.target.value)}
                placeholder="Ex.: teu@email.com ou admin"
                className="pl-9"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="login-pass">Senha de Acesso e Criptografia</Label>
            <div className="relative">
              <Lock className="pointer-events-none absolute top-2.5 left-3 h-4 w-4 text-muted-foreground" />
              <Input
                id="login-pass"
                type="password"
                autoComplete="current-password"
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                placeholder="••••••••"
                className="pl-9"
              />
            </div>
          </div>
          <Button type="submit" size="lg" disabled={busy} className="w-full bg-brand text-primary-foreground">
            {busy ? (
              <>
                <RefreshCcw className="h-4 w-4 animate-spin" /> A sincronizar dados entre PC e Celular…
              </>
            ) : (
              <>
                <KeyRound className="h-4 w-4" /> Entrar e Sincronizar Tudo
              </>
            )}
          </Button>
        </form>
        <div className="space-y-2 rounded-xl border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
          <p className="flex items-center gap-2 font-medium text-foreground">
            <ShieldCheck className="h-4 w-4 shrink-0 text-primary" />
            O que fica igualzinho no PC e no Celular:
          </p>
          <p>
            Ao entrar com o mesmo <strong>Usuário</strong> e <strong>Senha</strong>, o aplicativo sincroniza automaticamente suas{" "}
            <strong>Chaves (Gemini/TMDB)</strong>, suas <strong>Contas do Instagram</strong> e toda a sua{" "}
            <strong>Fila de Reels Agendados</strong> (incluindo os vídeos, legendas e pôsteres de capa!).
          </p>
          <p className="flex items-center gap-1.5 text-[11px] text-success">
            <ShieldCheck className="h-3.5 w-3.5" /> Criptografia AES-256-GCM de ponta a ponta.
          </p>
        </div>
      </div>
    </div>
  );
}
