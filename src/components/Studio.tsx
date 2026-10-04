import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Clapperboard,
  Copy,
  Download,
  Film,
  Loader2,
  PackageCheck,
  PencilLine,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Upload,
  CalendarClock,
  FileText,
  Wand2,
} from "lucide-react";
import { Badge, Button, Card, Input, Label, Progress, Slider, Switch, Textarea, cn } from "./ui";
import { Preview916 } from "./Preview916";
import { probeVideo, processVideo, detectBlackBars, estimateOutput, type Crop } from "../lib/video";
import { analyzeScene, buildCaption, identifyFilm, tmdbSearchMulti, tmdbDetails } from "../lib/ai";
import { captureForAi } from "../lib/video";
import { download, fmtDuration, fmtSize, stripMd } from "../lib/util";
import { toast } from "../lib/toast";
import { loadQueue, nextFreeSlot, saveQueueItem } from "../lib/queue";
import { uid } from "../lib/util";
import type { Account, Ident, Settings } from "../lib/types";

export interface CurrentClip {
  fileName: string;
  file: Blob;
  fileUrl: string;
  duration: number;
  vw: number;
  vh: number;
  range: [number, number];
  hookText: string;
  crop: Crop | null;
  cropTouched: boolean;
  cleanBlob: Blob | null;
  cleanUrl: string;
  title: string;
  originalTitle?: string;
  year?: number | string;
  poster?: string;
  caption: string;
  ident?: Ident;
}

interface Props {
  settings: Settings;
  onSettingsChange: (s: Settings) => void;
  accounts: Account[];
  activeAccountId: string;
  onQueueChanged: () => void;
  onOpenSettings: () => void;
  currentClip: CurrentClip | null;
  setCurrentClip: (c: CurrentClip | null) => void;
}

function StepCard({ n, title, icon, disabled, children }: { n: number; title: string; icon?: React.ReactNode; disabled?: boolean; children: React.ReactNode }) {
  return (
    <Card className={cn("space-y-4", disabled && "opacity-60")}>
      <div className="flex items-center gap-3">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">{n}</span>
        <h2 className="flex items-center gap-2 text-lg font-bold">
          {title} {icon}
        </h2>
      </div>
      {children}
    </Card>
  );
}

function MetaCard({ title, fields, exposed }: { title: string; fields: [string, string][]; exposed?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3">
      <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
        {exposed ? <Badge variant="destructive">antes</Badge> : <Badge variant="success">depois</Badge>} {title}
      </p>
      {fields.length === 0 ? (
        <p className="text-xs text-muted-foreground">Limpo — nenhum metadado ✔</p>
      ) : (
        <div className="space-y-1">
          {fields.map(([k, v]) => (
            <p key={k} className="flex items-center gap-2 text-xs">
              {exposed && <Badge variant="destructive">exposto</Badge>}
              <span className="text-muted-foreground">{k}:</span> <span className="font-medium">{v}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

export function Studio(props: Props) {
  const { settings, onSettingsChange, accounts, activeAccountId, onQueueChanged, onOpenSettings, currentClip: clip, setCurrentClip } = props;
  const [dragOver, setDragOver] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [identifying, setIdentifying] = useState(false);
  const [sampling, setSampling] = useState(false);
  const [captionBusy, setCaptionBusy] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [autoHook, setAutoHook] = useState(settings.autoHook !== false);
  const cancelRef = useRef(false);

  const account = accounts.find((a) => a.id === activeAccountId) || accounts[0];

  const setClip = (patch: Partial<CurrentClip>) => {
    if (!clip) return;
    setCurrentClip({ ...clip, ...patch });
  };

  const acceptFile = useCallback(
    async (file: File) => {
      const url = URL.createObjectURL(file);
      const v = document.createElement("video");
      v.preload = "metadata";
      v.muted = true;
      v.src = url;
      await new Promise<void>((res) => {
        v.onloadedmetadata = () => res();
        v.onerror = () => res();
      });
      const duration = v.duration || 0;
      const dims = await probeVideo(file);
      const end = Math.min(duration || 150, 150);
      setCurrentClip({
        fileName: file.name,
        file,
        fileUrl: url,
        duration,
        vw: dims.vw,
        vh: dims.vh,
        range: [0, end],
        hookText: settings.overlayText,
        crop: null,
        cropTouched: false,
        cleanBlob: null,
        cleanUrl: "",
        title: file.name.replace(/\.[^.]+$/, ""),
        caption: "",
      });
    },
    [settings.overlayText, setCurrentClip]
  );

  const recomputeCrop = async () => {
    if (!clip) return;
    const c = await detectBlackBars(clip.file);
    setClip({ crop: c, cropTouched: false });
  };

  const process = async () => {
    if (!clip) return;
    setProcessing(true);
    setProgress(0);
    cancelRef.current = false;
    try {
      const { blob } = await processVideo(
        clip.file,
        clip.fileName,
        clip.range[0],
        clip.range[1],
        clip.hookText,
        clip.crop,
        settings.resolution === "1080" ? 1080 : 720,
        (p) => setProgress(p)
      );
      const url = URL.createObjectURL(blob);
      setClip({ cleanBlob: blob, cleanUrl: url });
      toast.success("Vídeo limpo e cortado!");
      if (autoHook && (settings.geminiKey || settings.nvidiaKey)) {
        generateHook(blob).catch(() => {});
      }
    } catch (e: any) {
      toast.error(e?.message || "Falha ao processar o vídeo.");
    } finally {
      setProcessing(false);
    }
  };

  const sampleAndIdentify = async () => {
    if (!clip || !clip.cleanBlob) {
      toast.error("Processa primeiro o vídeo no Passo 1.");
      return;
    }
    setIdentifying(true);
    setSampling(true);
    try {
      const hasAudioKey = !!(settings.geminiKey || settings.nvidiaKey);
      if (!hasAudioKey) throw new Error("Adiciona a tua chave Google Gemini ou NVIDIA nas configurações para gerar o gancho pelo conteúdo do vídeo.");
      const { frames, audio } = await captureForAi(clip.cleanBlob, 0, Math.min(clip.range[1] - clip.range[0], 150));
      setSampling(false);
      const scene = await analyzeScene(settings, frames, audio, clip.fileName);
      if (scene.ganchos.length) {
        setClip({ hookText: scene.ganchos[0] });
        toast.success("Gancho gerado de acordo com a cena do vídeo!");
      }
      const res = await identifyFilm(settings, frames, audio, scene, "", clip.fileName);
      setClip({
        ident: res.media,
        title: res.media.title,
        originalTitle: res.media.original,
        year: res.media.year,
        poster: res.media.poster,
      });
    } catch (e: any) {
      toast.error(e?.message || "A IA não conseguiu identificar o clipe.");
    } finally {
      setIdentifying(false);
      setSampling(false);
    }
  };

  const generateHook = async (clean: Blob) => {
    try {
      const { frames, audio } = await captureForAi(clean, 0, Math.min(60, clip?.duration || 60));
      const scene = await analyzeScene(settings, frames, audio, clip?.fileName);
      if (scene.ganchos.length) setClip({ hookText: scene.ganchos[0] });
    } catch {
      /* gancho automático é best-effort */
    }
  };

  const generateCaption = async () => {
    if (!clip?.ident) {
      toast.error("Identifica primeiro o filme no Passo 2.");
      return;
    }
    setCaptionBusy(true);
    try {
      const text = await buildCaption(settings, clip.ident, { cena: clip.ident.cena, hookText: clip.hookText });
      const finalText = settings.bold ? text : stripMd(text);
      setClip({ caption: finalText });
    } catch (e: any) {
      toast.error(e?.message || "Não foi possível gerar a legenda com IA.");
    } finally {
      setCaptionBusy(false);
    }
  };

  const doSearch = async (q: string) => {
    setSearchQ(q);
    if (!q.trim()) return setSearchResults([]);
    const r = await tmdbSearchMulti(settings.tmdbKey, q).catch(() => []);
    setSearchResults(r);
  };

  const pickIdent = async (kind: "movie" | "tv", id: number) => {
    const d = await tmdbDetails(settings.tmdbKey, kind, id);
    setClip({
      ident: { ...d, alternativas: [], atores: [] },
      title: d.title,
      originalTitle: d.original,
      year: d.year,
      poster: d.poster,
    });
    setSearchOpen(false);
  };

  const sendToQueue = async () => {
    if (!clip?.cleanBlob) {
      toast.error("Processa primeiro o vídeo no Passo 1.");
      return;
    }
    const caption = stripMd(clip.caption || "");
    if (!caption) {
      toast.error("Gera ou escreve primeiro a legenda no Passo 3.");
      return;
    }
    const queue = await loadQueue();
    const slot = nextFreeSlot(queue, account.dailySlots, account.id);
    const base = clip.fileName.replace(/\.[^.]+$/, "");
    const item = {
      id: uid("reel"),
      accountId: account.id,
      createdAt: Date.now(),
      scheduledAt: slot,
      status: "scheduled" as const,
      title: clip.title || base,
      originalTitle: clip.originalTitle,
      year: clip.year,
      poster: clip.poster,
      hookText: clip.hookText,
      caption,
      videoBlob: clip.cleanBlob,
      videoFileName: `${base}_clean.mp4`,
      videoSize: clip.cleanBlob.size,
      platforms: ["instagram"],
    };
    await saveQueueItem(item);
    onQueueChanged();
    toast.success(`"${item.title}" agendado em ${account.name} para ${slot.replace("T", " às ")} e a sincronizar na nuvem!`);
  };

  const exportPackage = () => {
    if (!clip?.cleanBlob) {
      toast.error("Processa primeiro o vídeo no Passo 1.");
      return;
    }
    const base = clip.fileName.replace(/\.[^.]+$/, "");
    download(clip.cleanBlob, `${base}_clean.mp4`);
    const meta = {
      version: 1,
      exportedAt: Date.now(),
      accountId: account.id,
      accountName: account.name,
      title: clip.title || base,
      originalTitle: clip.originalTitle,
      year: clip.year,
      poster: clip.poster,
      hookText: clip.hookText,
      caption: stripMd(clip.caption || ""),
      scheduledAt: "",
      videoFileName: `${base}_clean.mp4`,
      platforms: ["instagram"],
    };
    setTimeout(() => {
      download(new Blob([JSON.stringify(meta, null, 2)], { type: "application/json;charset=utf-8" }), `${base}.cineclip.json`);
    }, 350);
    toast.success("Pacote exportado (.mp4 + .cineclip.json)! Podes importá-lo em qualquer altura na Central de Agendamento.");
  };

  const est = useMemo(
    () => (clip ? estimateOutput({ outWidth: 720, outHeight: 1280, vw: clip.vw, vh: clip.vh, hasCrop: !!clip.crop, cropX: 0, cropY: 0, cropW: clip.vw, cropH: clip.vh, videoW: 720, videoH: 1280, padX: 0, padY: 384 } as any, clip.range[1] - clip.range[0]) : null),
    [clip]
  );

  const captionStats = useMemo(() => {
    const text = clip?.caption || "";
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    const tags = (text.match(/#[\p{L}\p{N}_]+/gu) ?? []).length;
    return { chars: text.length, words, tags };
  }, [clip?.caption]);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6">
      {/* PASSO 1 */}
      <StepCard n={1} title="Upload e limpeza" icon={<Upload className="h-4 w-4 text-muted-foreground" />}>
        {clip ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between text-sm">
              <p>
                <span className="font-medium">{clip.fileName}</span>
                <span className="text-muted-foreground"> · {fmtSize(clip.file.size)}</span>
              </p>
              <Button variant="ghost" size="sm" onClick={() => setCurrentClip(null)}>
                ✕ Trocar
              </Button>
            </div>
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
              <video src={clip.fileUrl} controls className="aspect-video w-full rounded-lg bg-black" />
              <Preview916 src={clip.fileUrl} hookText={clip.hookText} manualCrop={clip.cropTouched ? clip.crop : undefined} timeRange={clip.range} className="w-28 sm:w-40" />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <MetaCard
                title="Antes"
                exposed
                fields={[
                  ["Título", clip.fileName.replace(/\.[^.]+$/, "")],
                  ["Duração", fmtDuration(clip.duration)],
                  ["Resolução", `${clip.vw}×${clip.vh}`],
                ]}
              />
              {clip.cleanBlob ? <MetaCard title="Depois" fields={[]} /> : <div />}
            </div>

            <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-3">
              <Label>Gancho no topo do vídeo</Label>
              <Input value={clip.hookText} onChange={(e) => setClip({ hookText: e.target.value })} placeholder="Texto do gancho…" />
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-xs text-muted-foreground">
                  Início do corte: {fmtDuration(clip.range[0])}
                  <Slider
                    className="mt-1"
                    min={0}
                    max={Math.max(1, Math.floor(clip.duration - 1))}
                    step={1}
                    value={[Math.floor(clip.range[0])]}
                    onValueChange={([v]) => setClip({ range: [v, Math.max(v + 1, clip.range[1])] })}
                  />
                </label>
                <label className="block text-xs text-muted-foreground">
                  Fim do corte (máx. 2:30): {fmtDuration(clip.range[1])}
                  <Slider
                    className="mt-1"
                    min={1}
                    max={Math.min(Math.ceil(clip.duration) || 150, 150)}
                    step={1}
                    value={[Math.ceil(clip.range[1])]}
                    onValueChange={([v]) => setClip({ range: [Math.min(v - 1, clip.range[0]), v] })}
                  />
                </label>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-xs text-muted-foreground">
                  Corte cima: {Math.round(clip.crop?.top ?? 0)} px
                  <Slider
                    className="mt-1"
                    min={0}
                    max={Math.floor(clip.vh * 0.4)}
                    step={2}
                    value={[Math.round(clip.crop?.top ?? 0)]}
                    onValueChange={([v]) => setClip({ crop: { top: v, bottom: clip.crop?.bottom ?? 0, vw: clip.vw, vh: clip.vh }, cropTouched: true })}
                  />
                </label>
                <label className="block text-xs text-muted-foreground">
                  Corte baixo: {Math.round(clip.crop?.bottom ?? 0)} px
                  <Slider
                    className="mt-1"
                    min={0}
                    max={Math.floor(clip.vh * 0.4)}
                    step={2}
                    value={[Math.round(clip.crop?.bottom ?? 0)]}
                    onValueChange={([v]) => setClip({ crop: { top: clip.crop?.top ?? 0, bottom: v, vw: clip.vw, vh: clip.vh }, cropTouched: true })}
                  />
                </label>
              </div>
              <div className="flex items-center justify-between gap-2">
                <Button variant="ghost" size="sm" onClick={recomputeCrop}>
                  <SlidersHorizontal className="h-4 w-4" /> Detetar barras de novo
                </Button>
                {est && (
                  <p className="text-xs text-muted-foreground">
                    Estimativa: ~{fmtSize(est.size)} · cerca de {fmtDuration(est.secs)} de processamento
                  </p>
                )}
              </div>
            </div>

            {processing && (
              <div className="space-y-2">
                <p className="text-sm">A limpar e cortar… {Math.round(progress * 100)}%</p>
                <Progress value={progress * 100} />
              </div>
            )}

            {clip.cleanBlob && !processing && (
              <div className="space-y-4">
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 sm:gap-4">
                  <video src={clip.cleanUrl} controls className="aspect-video min-w-0 w-full rounded-lg bg-muted" />
                  <Preview916 src={clip.cleanUrl} hookText="" alreadyProcessed className="w-24 shrink-0 sm:w-40" />
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Button variant="secondary" onClick={() => clip.cleanBlob && download(clip.cleanBlob, `${clip.fileName.replace(/\.[^.]+$/, "")}_clean.mp4`)}>
                    <Download className="h-4 w-4" /> Baixar vídeo limpo ({fmtSize(clip.cleanBlob.size)})
                  </Button>
                  <Button onClick={sampleAndIdentify} disabled={identifying}>
                    <Search className="h-4 w-4" /> Identificar o filme deste vídeo
                  </Button>
                </div>
              </div>
            )}

            {!clip.cleanBlob && !processing && (
              <Button size="lg" className="w-full" onClick={process}>
                <Wand2 className="h-4 w-4" /> Limpar metadados e cortar em 2:30
              </Button>
            )}
          </div>
        ) : (
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files[0];
              if (f) acceptFile(f);
            }}
            className={cn(
              "flex cursor-pointer flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed px-6 py-14 text-center transition-colors",
              dragOver ? "border-primary bg-primary/10" : "border-border hover:border-primary/60 hover:bg-muted/40"
            )}
          >
            <div className="relative">
              <div className="absolute inset-0 rounded-full bg-brand opacity-40 blur-2xl" />
              <div className="relative flex h-20 w-20 items-center justify-center rounded-2xl bg-brand shadow-lg">
                <Clapperboard className="h-10 w-10 text-primary-foreground" />
              </div>
            </div>
            <div>
              <p className="text-lg font-semibold">Arrasta o teu clipe para aqui</p>
              <p className="mt-1 text-sm text-muted-foreground">mp4, mov, mkv, webm ou avi · até 300 MB · nada sai do teu navegador</p>
            </div>
            <span className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Escolher ficheiro</span>
            <input
              type="file"
              accept=".mp4,.mov,.mkv,.webm,.avi,video/*"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && acceptFile(e.target.files[0])}
            />
          </label>
        )}
      </StepCard>

      {/* PASSO 2 */}
      <StepCard n={2} title="Identificação do filme" icon={<Film className="h-4 w-4 text-muted-foreground" />} disabled={!clip}>
        {!clip ? (
          <NeedKeys onOpen={onOpenSettings} />
        ) : (
          <div className="space-y-4">
            {!(settings.geminiKey || settings.nvidiaKey) && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-xs">
                <span>
                  💡 <strong>Dica:</strong> adiciona uma chave gratuita do <strong>Google Gemini</strong> (ou NVIDIA) nas configurações para a IA ver a cena.
                </span>
                <Button size="sm" variant="secondary" onClick={onOpenSettings}>
                  Configurar
                </Button>
              </div>
            )}
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                className="flex-1 text-xs"
                placeholder="Dica opcional para a IA (ex.: nome do ator, personagem ou detalhe)…"
                defaultValue=""
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    sampleAndIdentify();
                  }
                }}
              />
              <div className="flex gap-2">
                <Button onClick={sampleAndIdentify} disabled={identifying || !clip.cleanBlob}>
                  {identifying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  {clip.ident ? "Identificar novamente" : "Identificar filme"}
                </Button>
                <Button variant="secondary" onClick={() => setSearchOpen(!searchOpen)} disabled={!clip.cleanBlob}>
                  Pesquisar nome
                </Button>
              </div>
            </div>
            {sampling && <p className="text-xs text-muted-foreground">A capturar 6 quadros nítidos + áudio do diálogo…</p>}
            {identifying && !sampling && (
              <div className="flex gap-4">
                <div className="h-40 w-28 animate-pulse rounded-lg bg-muted" />
                <div className="flex-1 space-y-2">
                  <div className="h-6 w-2/3 animate-pulse rounded bg-muted" />
                  <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
                  <div className="h-16 w-full animate-pulse rounded bg-muted" />
                </div>
              </div>
            )}
            {clip.ident && !identifying && (
              <div className="flex flex-col gap-4 rounded-xl border border-border bg-muted/30 p-4 sm:flex-row">
                {clip.ident.poster ? (
                  <img src={clip.ident.poster} alt={clip.ident.title} className="w-32 self-start rounded-lg" />
                ) : (
                  <div className="flex h-44 w-32 items-center justify-center rounded-lg bg-secondary">
                    <Film className="h-8 w-8 text-muted-foreground" />
                  </div>
                )}
                <div className="flex-1 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-xl font-bold">{clip.ident.title}</h3>
                    <Badge variant="secondary">{clip.ident.kind === "tv" ? "Série" : "Filme"}</Badge>
                    {clip.ident.via && (
                      <Badge variant="outline" className="text-[10px]">
                        {clip.ident.via === "gemini" ? "Gemini 2.5 (Vídeo + Áudio + Google)" : "NVIDIA Vision"}
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {clip.ident.original} · {clip.ident.year || "—"}
                  </p>
                  {clip.ident.genres.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {clip.ident.genres.map((g) => (
                        <Badge key={g} variant="outline">
                          {g}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {clip.ident.cena && (
                    <p className="text-xs text-muted-foreground">
                      <strong className="text-foreground">Cena identificada:</strong> {clip.ident.cena}
                    </p>
                  )}
                  {clip.ident.atores && clip.ident.atores.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      <strong className="text-foreground">Atores na cena:</strong> {clip.ident.atores.join(", ")}
                    </p>
                  )}
                  <p className="text-sm leading-relaxed">{clip.ident.overview || "Sem sinopse disponível."}</p>
                </div>
              </div>
            )}
            {searchOpen && (
              <div className="space-y-2 rounded-lg border border-border bg-card p-3">
                <Input autoFocus value={searchQ} onChange={(e) => doSearch(e.target.value)} placeholder="Escreve o nome do filme ou série…" />
                {searchResults.length > 0 && (
                  <ul className="max-h-80 divide-y divide-border overflow-auto">
                    {searchResults.map((r) => (
                      <li key={r.kind + r.id}>
                        <button onClick={() => pickIdent(r.kind, r.id)} className="flex w-full cursor-pointer items-center gap-3 p-2 text-left hover:bg-muted/50">
                          {r.poster ? (
                            <img src={r.poster} alt="" className="h-14 w-10 rounded object-cover" />
                          ) : (
                            <div className="h-14 w-10 rounded bg-secondary" />
                          )}
                          <div className="text-sm">
                            <p className="font-medium">
                              {r.title} <span className="text-muted-foreground">({r.year || "—"})</span>
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {r.kind === "tv" ? "Série" : "Filme"} · {r.original}
                            </p>
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </StepCard>

      {/* PASSO 3 */}
      <StepCard n={3} title="Legenda gerada" icon={<FileText className="h-4 w-4 text-muted-foreground" />} disabled={!clip}>
        {!clip ? (
          <NeedKeys onOpen={onOpenSettings} />
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-1 rounded-md bg-secondary p-1 text-xs">
                {(["pt-PT", "pt-BR"] as const).map((l) => (
                  <button
                    key={l}
                    onClick={() => onSettingsChange({ ...settings, lang: l })}
                    className={cn("cursor-pointer rounded px-3 py-1", settings.lang === l ? "bg-primary text-primary-foreground" : "text-muted-foreground")}
                  >
                    {l === "pt-PT" ? "Português (Portugal)" : "Português (Brasil)"}
                  </button>
                ))}
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <Switch checked={settings.bold} onCheckedChange={(v) => onSettingsChange({ ...settings, bold: v })} />
                Negrito markdown (**texto**) {settings.bold ? "ligado" : "desligado"}
              </label>
            </div>

            {!clip.caption && !captionBusy && (
              <Button size="lg" className="w-full" onClick={generateCaption} disabled={!clip.ident}>
                <Sparkles className="h-4 w-4" /> Gerar legenda
              </Button>
            )}
            {captionBusy && (
              <div className="space-y-2">
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="h-4 w-full animate-pulse rounded bg-muted" />
                ))}
              </div>
            )}
            {clip.caption && !captionBusy && (
              <>
                <Textarea value={clip.caption} onChange={(e) => setClip({ caption: e.target.value })} className="min-h-[420px] font-sans text-sm leading-relaxed" />
                <div className="flex flex-wrap gap-2 text-xs">
                  <Badge variant="secondary">{captionStats.chars} caracteres</Badge>
                  <Badge variant="secondary">{captionStats.words} palavras</Badge>
                  <Badge className={captionStats.tags > 4 ? "bg-destructive" : "bg-success text-background"}>hashtags: {captionStats.tags}/4</Badge>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      navigator.clipboard.writeText(clip.caption);
                      toast.success("Legenda copiada!");
                    }}
                  >
                    <Copy className="h-4 w-4" /> Copiar
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => download(new Blob([clip.caption], { type: "text/plain;charset=utf-8" }), `${clip.title || "legenda"}.txt`)}
                  >
                    <FileText className="h-4 w-4" /> Baixar .txt
                  </Button>
                  <Button variant="secondary" onClick={generateCaption}>
                    <RefreshCw className="h-4 w-4" /> Outra versão
                  </Button>
                  <Button variant="ghost" onClick={() => setClip({ caption: "" })}>
                    <PencilLine className="h-4 w-4" /> Voltar e ajustar
                  </Button>
                </div>
                <div className="grid gap-2 pt-2 sm:grid-cols-2">
                  <Button size="lg" className="bg-brand text-primary-foreground" onClick={sendToQueue}>
                    <CalendarClock className="h-4 w-4" /> Enviar p/ Fila de {account?.name}
                  </Button>
                  <Button size="lg" variant="secondary" onClick={exportPackage}>
                    <PackageCheck className="h-4 w-4" /> Baixar Pacote p/ Agendador (.cineclip)
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </StepCard>

      <footer className="border-t border-border py-6 text-center text-xs text-muted-foreground">
        Use apenas trechos que você tem direito de publicar.
      </footer>
    </div>
  );
}

function NeedKeys({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-xs">
      <span>Para identificar o filme e gerar a legenda, adiciona as tuas chaves NVIDIA & TMDB.</span>
      <Button size="sm" onClick={onOpen}>
        Abrir configurações
      </Button>
    </div>
  );
}
