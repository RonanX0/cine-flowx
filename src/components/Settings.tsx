import { useState } from "react";
import { Copy, Info, KeyRound, LogOut, TestTube2 } from "lucide-react";
import { Button, Dialog, DialogContent, DialogTitle, Input, Label, Select, Switch, Textarea, cn } from "./ui";
import { testGeminiKey, testNvidiaKey, testTmdbKey } from "../lib/ai";
import * as cloud from "../lib/cloud";
import { toast } from "../lib/toast";
import type { Settings as TSettings } from "../lib/types";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  settings: TSettings;
  onSave: (s: TSettings) => void;
  onLogout: () => void;
}

function TestButton({ onClick }: { onClick: () => Promise<void> }) {
  const [state, setState] = useState("");
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={async () => {
        setState("…");
        try {
          await onClick();
          setState("✔");
        } catch (e: any) {
          setState("✖");
          toast.error(e?.message || "Falha no teste.");
        }
      }}
    >
      <TestTube2 className="h-3.5 w-3.5" /> {state || "Testar"}
    </Button>
  );
}

export function SettingsDialog({ open, onOpenChange, settings, onSave, onLogout }: Props) {
  const [s, setS] = useState<TSettings>(settings);
  const [cloudState, setCloudState] = useState("");
  const patch = (p: Partial<TSettings>) => setS({ ...s, ...p });

  const save = () => {
    onSave({ ...s, geminiKey: (s.geminiKey || "").trim(), nvidiaKey: (s.nvidiaKey || "").trim(), tmdbKey: (s.tmdbKey || "").trim() });
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (v) setS(settings);
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogTitle>⚙️ Configurações</DialogTitle>
        <div className="space-y-5 text-sm">
          <section className="space-y-2.5">
            <h3 className="flex items-center gap-2 text-sm font-bold">
              <KeyRound className="h-4 w-4 text-primary" /> Chaves de IA
            </h3>
            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
              <div className="space-y-1">
                <Label>Chave da API Google Gemini (recomendada)</Label>
                <Input type="password" value={s.geminiKey} onChange={(e) => patch({ geminiKey: e.target.value })} placeholder="AIza…" />
              </div>
              <div className="self-end">
                <TestButton onClick={() => testGeminiKey(s.geminiKey)} />
              </div>
              <div className="space-y-1">
                <Label>Chave da API NVIDIA (alternativa)</Label>
                <Input type="password" value={s.nvidiaKey} onChange={(e) => patch({ nvidiaKey: e.target.value })} placeholder="nvapi-…" />
              </div>
              <div className="self-end">
                <TestButton onClick={() => testNvidiaKey(s.nvidiaKey)} />
              </div>
              <div className="space-y-1">
                <Label>Chave da API TMDB</Label>
                <Input type="password" value={s.tmdbKey} onChange={(e) => patch({ tmdbKey: e.target.value })} placeholder="themoviedb.org → Configurações → API" />
              </div>
              <div className="self-end">
                <TestButton onClick={() => testTmdbKey(s.tmdbKey)} />
              </div>
            </div>
          </section>

          <section className="space-y-2.5">
            <h3 className="text-sm font-bold">🎬 Vídeo</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>Texto por cima do vídeo (gancho padrão)</Label>
                <Input value={s.overlayText} onChange={(e) => patch({ overlayText: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label>Resolução de saída</Label>
                <Select value={s.resolution} onChange={(e) => patch({ resolution: e.target.value as "720" | "1080" })}>
                  <option value="720">720×1280 (rápido)</option>
                  <option value="1080">1080×1920 (máxima)</option>
                </Select>
              </div>
            </div>
          </section>

          <section className="space-y-2.5 rounded-lg border border-primary/35 bg-primary/5 p-3">
            <h3 className="text-sm font-bold">☁️ Nuvem durável — Google Drive (grátis, sem cartão)</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>URL da implantação (/exec)</Label>
                <Input value={s.driveScriptUrl} onChange={(e) => patch({ driveScriptUrl: e.target.value })} placeholder="https://script.google.com/macros/s/…/exec" />
              </div>
              <div className="space-y-1">
                <Label>Token (da função setup)</Label>
                <Input type="password" value={s.driveToken} onChange={(e) => patch({ driveToken: e.target.value })} placeholder="cc_drive_…" />
              </div>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Como ativar (5 min, grátis): 1) script.google.com → Novo projeto → cola o conteúdo de apps-script/cineclip-cloud-drive.js; 2) corre a função setup() e copia o TOKEN; 3) Implantar → Nova implantação → App da Web → Executar como: Eu · Quem pode aceder: Qualquer pessoa; 4) cola aqui o URL /exec e o token. Os vídeos ficam na pasta 'CineClip Cloud' do teu Drive e não expiram.
            </p>
          </section>

          <section className="space-y-2.5 rounded-lg border border-border bg-muted/30 p-3">
            <h3 className="text-sm font-bold">⚡ Alternativa — Cloudflare R2 (mais rápida, precisa de conta/cartão)</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>URL do Worker</Label>
                <Input value={s.r2WorkerUrl} onChange={(e) => patch({ r2WorkerUrl: e.target.value })} placeholder="https://cineclip-cloud.TUA-CONTA.workers.dev" />
              </div>
              <div className="space-y-1">
                <Label>Token do Worker (CINECLIP_TOKEN)</Label>
                <Input type="password" value={s.r2Token} onChange={(e) => patch({ r2Token: e.target.value })} placeholder="cc_r2_…" />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <label className="flex items-center gap-2">
                Limite de envio direto (MB)
                <Input type="number" min={1} max={5000} value={s.r2MaxMb} onChange={(e) => patch({ r2MaxMb: Number(e.target.value) || 95 })} className="h-8 w-24 font-mono text-xs" />
              </label>
              <label className="flex items-center gap-2">
                <Switch checked={s.cloudProvider === "auto"} onCheckedChange={(v) => patch({ cloudProvider: v ? "auto" : "r2" })} /> failover automático R2 → Drive
              </label>
            </div>
          </section>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              onClick={async () => {
                setCloudState("a testar…");
                onSave({ ...s });
                const p = await cloud.healthCheck();
                setCloudState(p.ok ? "✔ ligada" : "✖ falhou");
                if (p.ok) toast.success(p.message);
                else toast.error(p.message || "Nenhum backend passou no teste.");
              }}
            >
              Testar ligação à nuvem {cloudState && <span className="text-xs">({cloudState})</span>}
            </Button>
            <Button
              variant="ghost"
              onClick={async () => {
                await navigator.clipboard.writeText(cloud.report());
                toast.success("Diagnóstico copiado.");
              }}
            >
              <Copy className="h-4 w-4" /> Copiar diagnóstico
            </Button>
            <Button variant="ghost" className="ml-auto text-destructive" onClick={onLogout}>
              <LogOut className="h-4 w-4" /> Terminar sessão
            </Button>
          </div>

          <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 p-3 text-xs">
            <Info className="h-4 w-4 shrink-0 text-primary" />
            As chaves ficam só neste navegador e no teu cofre encriptado. Não publiques este app num link público com as tuas chaves preenchidas.
          </div>

          <Button className="w-full" onClick={save}>
            Guardar
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
