import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Bot,
  CalendarClock,
  Copy,
  Download,
  FolderUp,
  Instagram,
  Loader2,
  PackageCheck,
  Plus,
  Send,
  Settings2,
  Trash2,
  Users,
  X,
  CircleCheck,
  AlertTriangle,
  Clock,
  Film,
  RefreshCw,
  CloudUpload,
} from "lucide-react";
import { Badge, Button, Card, Dialog, DialogContent, DialogTitle, Input, Label, Switch, cn } from "./ui";
import { loadQueue, saveQueueItem, deleteQueueItem, nextFreeSlot } from "../lib/queue";
import { addDeletedId, DEFAULT_ACCOUNT, validateMetaAccount } from "../lib/accounts";
import { publishReel } from "../lib/ig";
import * as cloud from "../lib/cloud";
import { generateRobo24hScript, assertRobo24hSadio } from "../lib/robo";
import { download, dayLabel, localDayKey, pad2, stripMd, uid } from "../lib/util";
import { toast } from "../lib/toast";
import type { Account, QueueItem, Session } from "../lib/types";

interface Props {
  session: Session;
  accounts: Account[];
  activeAccountId: string;
  onAccountsChange: (a: Account[], activeId?: string) => void;
  refreshTick: number;
  onQueueChanged: () => void;
}

const STATUS_LABEL: Record<string, string> = {
  scheduled: "agendado",
  device_scheduled: "agendado",
  queued: "na fila",
  publishing: "a publicar…",
  published: "publicado",
  error: "erro",
};

export function Agendador({ session, accounts, activeAccountId, onAccountsChange, refreshTick, onQueueChanged }: Props) {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [tab, setTab] = useState<"fila" | "conta" | "robo">("fila");
  const [filter, setFilter] = useState<"pendentes" | "publicados" | "erros" | "todos">("pendentes");
  const [sort, setSort] = useState<string>(() => {
    try {
      return localStorage.getItem("cineclip.agenda.sort") || "hora";
    } catch {
      return "hora";
    }
  });
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [newSlot, setNewSlot] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const pubLock = useRef<string | null>(null);

  const account = accounts.find((a) => a.id === activeAccountId) || accounts[0];
  const accountQueue = useMemo(() => queue.filter((i) => (i.accountId || "acc_default") === account?.id), [queue, account]);
  const nextFree = useMemo(() => nextFreeSlot(queue, account?.dailySlots || [], account?.id), [queue, account]);

  const reload = useCallback(async () => {
    try {
      setQueue(await loadQueue());
    } catch (e) {
      console.error(e);
    }
  }, []);
  useEffect(() => {
    reload();
  }, [reload, refreshTick]);

  const setSortAndSave = (v: string) => {
    setSort(v);
    try {
      localStorage.setItem("cineclip.agenda.sort", v);
    } catch {
      /* ignore */
    }
  };

  /* ------------------------------------------------------------ publicação */
  const publishNow = useCallback(
    async (item: QueueItem) => {
      if (pubLock.current) return;
      const acc = accounts.find((a) => a.id === (item.accountId || "acc_default")) || account;
      setBusyId(item.id);
      pubLock.current = item.id;
      const claim = await cloud.claimPublish(item).catch(() => ({ ok: true, degraded: true } as cloud.ClaimResult));
      try {
        if (!claim.ok) {
          toast.warning(cloud.claimSkipMessage(claim, item.title));
          return;
        }
        const live: QueueItem = { ...item, status: "publishing" };
        await saveQueueItem(live);
        await reload();
        const res = await publishReel({ ...live }, acc, () => {}, claim);
        const done: QueueItem = {
          ...live,
          status: "published",
          publishedId: res.publishedId,
          publishedUrl: res.publishedUrl,
          remoteVideoUrl: res.remoteVideoUrl || live.remoteVideoUrl,
          publishError: undefined,
        };
        await saveQueueItem(done);
        await reload();
        onQueueChanged();
        toast.success(`Reels "${item.title}" publicado em ${acc.name}!`);
      } catch (e: any) {
        const err: QueueItem = { ...item, status: "error", publishError: e?.message || "Erro ao publicar Reels" };
        await saveQueueItem(err);
        await reload();
        onQueueChanged();
        toast.error(`Erro em ${acc.name}: ${e?.message || "Falha ao publicar Reels."}`);
      } finally {
        await cloud.releaseClaim(claim);
        pubLock.current = null;
        setBusyId(null);
      }
    },
    [accounts, account, reload, onQueueChanged]
  );

  /* auto-pilot: verifica a cada 30 s */
  useEffect(() => {
    const t = setInterval(() => {
      const nowStr = new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
      const due = queue.find((z) => {
        const acc = accounts.find((a) => a.id === (z.accountId || "acc_default")) || account;
        if (!acc?.autoPilot || acc.mode === ("manual" as any)) return false;
        return z.status === "scheduled" && (z.scheduledAt || "").slice(0, 16) <= nowStr && !!(z.videoBlob || z.remoteVideoUrl);
      });
      if (due) publishNow(due);
    }, 30000);
    return () => clearInterval(t);
  }, [queue, accounts, account, publishNow]);

  /* ------------------------------------------------------------ operações */
  const reschedule = async (item: QueueItem, when: string) => {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(when)) {
      toast.error("Escolhe um horário (HH:MM).");
      return;
    }
    await saveQueueItem({ ...item, scheduledAt: when.slice(0, 16), updatedAt: Date.now(), status: item.status === "published" ? "published" : "scheduled" });
    await reload();
    onQueueChanged();
    toast.success("Horário de agendamento atualizado.");
  };

  const moveToAccount = async (item: QueueItem, accId: string) => {
    const target = accounts.find((a) => a.id === accId);
    if (!target) return;
    await saveQueueItem({ ...item, accountId: accId, updatedAt: Date.now() });
    await reload();
    onQueueChanged();
    toast.success(`Clipe "${item.title}" movido para ${target.name}!`);
  };

  const remove = async (item: QueueItem) => {
    if (!confirm(`Remover "${item.title}" da fila?`)) return;
    addDeletedId(item.id);
    await deleteQueueItem(item.id);
    await reload();
    onQueueChanged();
    toast.success("Item removido da fila.");
  };

  const reupload = async (item: QueueItem) => {
    if (!item.videoBlob) {
      toast.error("Este item não tem o ficheiro .mp4 neste aparelho. Reimporta-o.");
      return;
    }
    setBusyId(item.id);
    try {
      const url = await cloud.uploadVideo(item.videoBlob, item.videoFileName || "reel.mp4", {});
      await saveQueueItem({ ...item, remoteVideoUrl: url, cloudProvider: cloud.classifyUrl(url), cloudError: undefined, updatedAt: Date.now() });
      await reload();
      onQueueChanged();
      toast.success(`☁️ "${item.title}" reenviado para a nuvem durável.`);
    } catch (e: any) {
      await saveQueueItem({ ...item, cloudError: e?.message });
      await reload();
      toast.error(`⚠️ Falha ao reenviar: ${e?.message}`);
    } finally {
      setBusyId(null);
    }
  };

  const swap = async (item: QueueItem, dir: -1 | 1) => {
    const sorted = [...accountQueue].sort((a, b) => (a.scheduledAt || "").localeCompare(b.scheduledAt || ""));
    const idx = sorted.findIndex((i) => i.id === item.id);
    const other = sorted[idx + dir];
    if (!other) return;
    const t = item.scheduledAt;
    await saveQueueItem({ ...item, scheduledAt: other.scheduledAt, updatedAt: Date.now() });
    await saveQueueItem({ ...other, scheduledAt: t, updatedAt: Date.now() });
    await reload();
    onQueueChanged();
    toast.success("Ordem atualizada — os Reels trocaram de horário.");
  };

  const dropOn = async (target: QueueItem) => {
    if (!dragId || dragId === target.id) return;
    const dragged = queue.find((i) => i.id === dragId);
    if (!dragged) return;
    const t = dragged.scheduledAt;
    await saveQueueItem({ ...dragged, scheduledAt: target.scheduledAt, updatedAt: Date.now() });
    await saveQueueItem({ ...target, scheduledAt: t, updatedAt: Date.now() });
    setDragId(null);
    setOverId(null);
    await reload();
    onQueueChanged();
    toast.success("Ordem atualizada — os Reels trocaram de horário.");
  };

  const importFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const all = Array.from(files);
    const jsons = all.filter((f) => f.name.endsWith(".json"));
    const videos = all.filter((f) => /\.(mp4|mov|webm|mkv)$/i.test(f.name));
    let count = 0;
    let current = await loadQueue();
    for (const jf of jsons) {
      try {
        const meta = JSON.parse(await jf.text());
        const video = videos.find((v) => v.name === meta.videoFileName) || videos[0];
        const when = meta.scheduledAt || nextFreeSlot(current, account.dailySlots, account.id);
        const item: QueueItem = {
          id: uid("reel"),
          accountId: account.id,
          createdAt: Date.now(),
          scheduledAt: when,
          status: "scheduled",
          title: meta.title || "Clipe Importado",
          originalTitle: meta.originalTitle,
          year: meta.year,
          poster: meta.poster,
          hookText: meta.hookText || "",
          caption: meta.caption || "",
          videoBlob: video,
          videoFileName: video?.name || meta.videoFileName || "video.mp4",
          videoSize: video?.size || 0,
          platforms: meta.platforms || ["instagram"],
        };
        await saveQueueItem(item);
        current = await loadQueue();
        count++;
      } catch (e) {
        console.error("Falha ao importar JSON:", e);
      }
    }
    if (jsons.length === 0 && videos.length > 0) {
      for (const vf of videos) {
        const when = nextFreeSlot(current, account.dailySlots, account.id);
        const base = vf.name.replace(/_clean\.mp4$/i, "").replace(/\.[^.]+$/, "");
        const item: QueueItem = {
          id: uid("reel"),
          accountId: account.id,
          createdAt: Date.now(),
          scheduledAt: when,
          status: "scheduled",
          title: base,
          hookText: "",
          caption: `🎬 ${base}\n\n#Filme #Reels #Cinema`,
          videoBlob: vf,
          videoFileName: vf.name,
          videoSize: vf.size,
          platforms: ["instagram"],
        };
        await saveQueueItem(item);
        current = await loadQueue();
        count++;
      }
    }
    await reload();
    if (count > 0) {
      onQueueChanged();
      toast.success(`${count} clipe(s) importado(s) para a fila de ${account.name}!`);
    } else {
      toast.error("Seleciona um ficheiro .mp4 e/ou o pacote .cineclip.json exportado.");
    }
  };

  const saveSlots = (slots: string[]) => {
    const next = accounts.map((a) => (a.id === account.id ? { ...a, dailySlots: slots, updatedAt: Date.now() } : a));
    onAccountsChange(next);
    toast.success(`Configuração de ${account.name} salva e sincronizada na nuvem!`);
  };

  /* ----------------------------------------------------------------- view */
  const filtered = accountQueue.filter((i) => {
    if (filter === "pendentes") return i.status === "scheduled" || i.status === "queued" || i.status === "device_scheduled" || i.status === "publishing" || i.status === "error";
    if (filter === "publicados") return i.status === "published";
    if (filter === "erros") return i.status === "error";
    return true;
  });
  const sortedList = [...filtered].sort((a, b) => {
    if (sort === "hora_desc") return (b.scheduledAt || "").localeCompare(a.scheduledAt || "");
    if (sort === "titulo") return (a.title || "").localeCompare(b.title || "");
    if (sort === "situacao") {
      const rank = (s: string) => (s === "error" ? 0 : s === "published" ? 2 : 1);
      return rank(a.status) - rank(b.status) || (a.scheduledAt || "").localeCompare(b.scheduledAt || "");
    }
    return (a.scheduledAt || "").localeCompare(b.scheduledAt || "");
  });
  const byDay = new Map<string, QueueItem[]>();
  for (const item of sortedList) {
    const day = (item.scheduledAt || "").slice(0, 10);
    byDay.set(day, [...(byDay.get(day) || []), item]);
  }

  const nPendentes = accountQueue.filter((i) => i.status !== "published").length;
  const nPublicados = accountQueue.filter((i) => i.status === "published").length;
  const nErros = accountQueue.filter((i) => i.status === "error").length;
  const nextPost = accountQueue.filter((i) => i.status === "scheduled").sort((a, b) => (a.scheduledAt || "").localeCompare(b.scheduledAt || ""))[0];

  return (
    <div className="mx-auto w-full max-w-5xl space-y-5 px-4 py-6">
      {/* topo */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-extrabold">
            <CalendarClock className="h-5 w-5 text-primary" /> Central de Agendamento
          </h1>
          <p className="text-xs text-muted-foreground">Cada Reel novo vai para o próximo horário livre desta conta.</p>
        </div>
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-muted-foreground" />
          <select
            value={account?.id}
            onChange={(e) => onAccountsChange(accounts, e.target.value)}
            className="h-9 rounded-md border border-border bg-muted/30 px-2 text-sm"
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
            <FolderUp className="h-4 w-4" /> Importar
          </Button>
          <input ref={fileRef} type="file" multiple accept=".mp4,.mov,.webm,.mkv,.json" className="hidden" onChange={(e) => importFiles(e.target.files)} />
        </div>
      </div>

      {/* resumo */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="p-3 text-center">
          <p className="text-2xl font-extrabold">{nPendentes}</p>
          <p className="text-[11px] text-muted-foreground">na fila</p>
        </Card>
        <Card className="p-3 text-center">
          <p className="truncate text-sm font-bold">{nextPost ? nextPost.scheduledAt.slice(11, 16) : "—"}</p>
          <p className="text-[11px] text-muted-foreground">próximo post</p>
        </Card>
        <Card className="p-3 text-center">
          <p className="text-2xl font-extrabold text-success">{nPublicados}</p>
          <p className="text-[11px] text-muted-foreground">publicados</p>
        </Card>
        <Card className="p-3 text-center">
          <p className="text-2xl font-extrabold text-destructive">{nErros}</p>
          <p className="text-[11px] text-muted-foreground">erros</p>
        </Card>
      </div>

      {/* abas */}
      <div className="flex gap-1 rounded-lg bg-secondary p-1 text-sm">
        {(
          [
            ["fila", "Fila"],
            ["conta", "Conta e horários"],
            ["robo", "Robô 24h"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cn("flex-1 cursor-pointer rounded-md px-3 py-1.5", tab === id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "fila" && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input placeholder="Buscar por título ou legenda…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
            <select value={sort} onChange={(e) => setSortAndSave(e.target.value)} className="h-9 rounded-md border border-border bg-muted/30 px-2 text-sm">
              <option value="hora">Horário (mais cedo)</option>
              <option value="hora_desc">Horário (mais tarde)</option>
              <option value="titulo">Título (A–Z)</option>
              <option value="situacao">Situação (erros primeiro)</option>
            </select>
            <div className="ml-auto flex gap-1">
              {(["pendentes", "publicados", "erros", "todos"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={cn("cursor-pointer rounded-md px-2.5 py-1 text-xs", filter === f ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground")}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>
          {sort === "hora" && <p className="text-[11px] text-muted-foreground">Arrasta para mudar a ordem (os horários ficam, os Reels trocam) ou usa ↑↓.</p>}

          {accountQueue.length === 0 && (
            <Card className="space-y-2 p-6 text-center text-sm text-muted-foreground">
              <Film className="mx-auto h-8 w-8" />
              <p className="font-medium text-foreground">Nenhum vídeo pronto para agendar</p>
              <p>
                Processa um vídeo no Estúdio ou importa um .mp4 / pacote .cineclip — próximo horário livre: <strong>{nextFree.replace("T", " às ")}</strong>
              </p>
            </Card>
          )}

          {[...byDay.entries()].map(([day, items]) => (
            <div key={day} className="space-y-2">
              <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">{dayLabel(day, true)}</p>
              {items
                .filter((i) => !q || (i.title || "").toLowerCase().includes(q.toLowerCase()) || (i.caption || "").toLowerCase().includes(q.toLowerCase()))
                .map((item) => (
                  <QueueRow
                    key={item.id}
                    item={item}
                    accounts={accounts}
                    open={open === item.id}
                    setOpen={(v) => setOpen(v ? item.id : null)}
                    busy={busyId === item.id}
                    publishNow={publishNow}
                    reschedule={reschedule}
                    moveToAccount={moveToAccount}
                    remove={remove}
                    reupload={reupload}
                    swap={swap}
                    dragProps={
                      sort === "hora"
                        ? {
                            draggable: true,
                            onDragStart: () => setDragId(item.id),
                            onDragOver: (e) => {
                              e.preventDefault();
                              setOverId(item.id);
                            },
                            onDragLeave: () => setOverId(null),
                            onDrop: () => dropOn(item),
                          }
                        : {}
                    }
                    dragging={overId === item.id && dragId !== item.id}
                  />
                ))}
            </div>
          ))}
        </div>
      )}

      {tab === "conta" && (
        <AccountTab accounts={accounts} account={account} onAccountsChange={onAccountsChange} saveSlots={saveSlots} />
      )}

      {tab === "robo" && <RoboTab session={session} />}
    </div>
  );
}

/* ------------------------------------------------------------------ linha */
function QueueRow(props: {
  item: QueueItem;
  accounts: Account[];
  open: boolean;
  setOpen: (v: boolean) => void;
  busy: boolean;
  publishNow: (i: QueueItem) => void;
  reschedule: (i: QueueItem, when: string) => void;
  moveToAccount: (i: QueueItem, acc: string) => void;
  remove: (i: QueueItem) => void;
  reupload: (i: QueueItem) => void;
  swap: (i: QueueItem, d: -1 | 1) => void;
  dragProps: React.HTMLAttributes<HTMLDivElement>;
  dragging: boolean;
}) {
  const { item, accounts, open, setOpen, busy, publishNow, reschedule, moveToAccount, remove, reupload, swap, dragProps, dragging } = props;
  const cloudKind = item.remoteVideoUrl ? cloud.classifyUrl(item.remoteVideoUrl) : "none";
  return (
    <div
      {...dragProps}
      className={cn("rounded-lg border border-border bg-card", dragging && "border-primary", open && "ring-1 ring-primary/40")}
    >
      <button onClick={() => setOpen(!open)} className="flex w-full cursor-pointer items-center gap-3 p-3 text-left">
        {item.poster ? (
          <img src={item.poster} alt="" className="h-14 w-10 rounded object-cover" />
        ) : (
          <div className="flex h-14 w-10 items-center justify-center rounded bg-secondary">
            <Film className="h-4 w-4 text-muted-foreground" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{item.title}</p>
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" /> {item.scheduledAt?.replace("T", " às ")}
          </p>
        </div>
        <StatusBadge status={item.status} />
        {item.remoteVideoUrl ? (
          cloudKind === "drive" ? (
            <Badge variant="outline" className="text-[10px]">☁️ Drive · PC + Celular</Badge>
          ) : cloudKind === "r2" ? (
            <Badge variant="outline" className="text-[10px]">☁️ R2 · PC + Celular</Badge>
          ) : (
            <Badge variant="destructive" className="text-[10px]">⚠️ link temporário</Badge>
          )
        ) : item.videoBlob ? (
          <Badge variant="secondary" className="text-[10px]">⚠️ só neste aparelho</Badge>
        ) : (
          <Badge variant="secondary" className="text-[10px]">sem vídeo</Badge>
        )}
      </button>
      {open && (
        <div className="space-y-3 border-t border-border p-3 text-sm">
          {item.publishError && (
            <p className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {item.publishError}
            </p>
          )}
          {item.cloudError && (
            <p className="flex items-start gap-1.5 rounded-md border border-accent/40 bg-accent/10 p-2 text-xs text-accent">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Nuvem: {item.cloudError}
            </p>
          )}
          {item.caption && <p className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-muted/30 p-2 text-xs">{item.caption}</p>}
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block text-xs text-muted-foreground">
              Horário
              <Input type="datetime-local" defaultValue={item.scheduledAt} onBlur={(e) => reschedule(item, e.target.value)} className="mt-1" />
            </label>
            <label className="block text-xs text-muted-foreground">
              Conta
              <select value={item.accountId || "acc_default"} onChange={(e) => moveToAccount(item, e.target.value)} className="mt-1 h-9 w-full rounded-md border border-border bg-muted/30 px-2 text-sm">
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            {item.status !== "published" && (
              <Button size="sm" onClick={() => publishNow(item)} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Publicar agora
              </Button>
            )}
            {item.videoBlob && (
              <Button size="sm" variant="secondary" onClick={() => download(item.videoBlob!, item.videoFileName || "reel.mp4")}>
                <Download className="h-4 w-4" /> Baixar vídeo
              </Button>
            )}
            {item.videoBlob && (
              <Button size="sm" variant="secondary" onClick={() => reupload(item)} disabled={busy} title={item.cloudError ? `Tentar outra vez. Último erro: ${item.cloudError}` : undefined}>
                <CloudUpload className="h-4 w-4" /> Reenviar p/ nuvem
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => swap(item, -1)} title="Subir (troca de horário com o anterior)">
              <ArrowUp className="h-4 w-4" />
            </Button>
            <Button size="sm" variant="ghost" onClick={() => swap(item, 1)} title="Descer (troca de horário com o seguinte)">
              <ArrowDown className="h-4 w-4" />
            </Button>
            <Button size="sm" variant="ghost" className="text-destructive" onClick={() => remove(item)}>
              <Trash2 className="h-4 w-4" /> Remover
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === "published")
    return (
      <Badge variant="success" className="gap-1">
        <CircleCheck className="h-3 w-3" /> publicado
      </Badge>
    );
  if (status === "error") return <Badge variant="destructive">erro</Badge>;
  if (status === "publishing")
    return (
      <Badge variant="secondary">
        <Loader2 className="h-3 w-3 animate-spin" /> a publicar
      </Badge>
    );
  return <Badge variant="secondary">{STATUS_LABEL[status] || status}</Badge>;
}

/* ------------------------------------------------------------- conta tab */
function AccountTab({
  accounts,
  account,
  onAccountsChange,
  saveSlots,
}: {
  accounts: Account[];
  account: Account;
  onAccountsChange: (a: Account[], activeId?: string) => void;
  saveSlots: (s: string[]) => void;
}) {
  const [newName, setNewName] = useState("");
  const [slotText, setSlotText] = useState(account.dailySlots.join(", "));
  const [testing, setTesting] = useState(false);
  useEffect(() => setSlotText(account.dailySlots.join(", ")), [account.id, account.dailySlots]);

  const patch = (p: Partial<Account>) => {
    onAccountsChange(accounts.map((a) => (a.id === account.id ? { ...a, ...p, updatedAt: Date.now() } : a)));
  };

  const addAccount = () => {
    const n = newName.trim();
    if (!n) {
      toast.error("Digite o @ ou nome da nova conta do Instagram.");
      return;
    }
    const name = n.startsWith("@") ? n : `@${n}`;
    const acc: Account = { ...DEFAULT_ACCOUNT, id: `acc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, name, mode: "graph", dailySlots: [...DEFAULT_ACCOUNT.dailySlots] } as Account;
    onAccountsChange([...accounts, acc], acc.id);
    setNewName("");
    toast.success(`Conta ${name} adicionada! Configure o Webhook ou Token dela abaixo.`);
  };

  const removeAccount = () => {
    if (accounts.length <= 1) {
      toast.error("Você precisa manter pelo menos 1 conta cadastrada.");
      return;
    }
    const rest = accounts.filter((a) => a.id !== account.id);
    addDeletedId("acc:" + account.id);
    onAccountsChange(rest, rest[0].id);
    toast.success(`Conta ${account.name} removida.`);
  };

  const testConn = async () => {
    if (!account.igUserId.trim() || !account.metaAccessToken.trim()) {
      toast.error("Preenche o ID da Conta Instagram Profissional e o Access Token da Meta.");
      return;
    }
    setTesting(true);
    try {
      const r = await validateMetaAccount(account.igUserId, account.metaAccessToken);
      toast.success(`Conectado ao Instagram @${r.username} (${r.name})!`);
    } catch (e: any) {
      toast.error(e?.message || "Falha na conexão com a API do Instagram.");
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-bold">
            <Instagram className="h-4 w-4 text-primary" /> Contas do Instagram
          </h3>
          <Button size="sm" variant="ghost" className="text-destructive" onClick={removeAccount}>
            <Trash2 className="h-4 w-4" /> Remover atual
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          {accounts.map((a) => (
            <button
              key={a.id}
              onClick={() => onAccountsChange(accounts, a.id)}
              className={cn("cursor-pointer rounded-md px-3 py-1.5 text-xs", a.id === account.id ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground")}
            >
              {a.name}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="@nova.conta" />
          <Button onClick={addAccount}>
            <Plus className="h-4 w-4" /> Criar conta
          </Button>
        </div>
      </Card>

      <Card className="space-y-3">
        <h3 className="flex items-center gap-2 text-sm font-bold">
          <Settings2 className="h-4 w-4 text-primary" /> Configuração exclusiva da conta: {account.name}
        </h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs text-muted-foreground">
            Modo de publicação
            <select value={account.mode} onChange={(e) => patch({ mode: e.target.value as Account["mode"] })} className="mt-1 h-9 w-full rounded-md border border-border bg-muted/30 px-2 text-sm">
              <option value="graph">Graph API (token da Meta)</option>
              <option value="webhook">Webhook (Make / n8n)</option>
              <option value="manual">Robô Meta Business Suite</option>
            </select>
          </label>
          {account.mode === "webhook" ? (
            <label className="block text-xs text-muted-foreground">
              URL do Webhook
              <Input value={account.webhookUrl} onChange={(e) => patch({ webhookUrl: e.target.value })} placeholder="https://hook.make.com/…" className="mt-1" />
            </label>
          ) : (
            <>
              <label className="block text-xs text-muted-foreground">
                ID da Conta Instagram Profissional
                <Input value={account.igUserId} onChange={(e) => patch({ igUserId: e.target.value })} placeholder="178414…" className="mt-1" />
              </label>
              <label className="block text-xs text-muted-foreground">
                Access Token da Meta
                <Input type="password" value={account.metaAccessToken} onChange={(e) => patch({ metaAccessToken: e.target.value })} placeholder="EAAG…" className="mt-1" />
              </label>
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="flex cursor-pointer items-center gap-2">
            <Switch checked={account.autoPilot} onCheckedChange={(v) => patch({ autoPilot: v })} /> publica sozinho no horário
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <Switch checked={account.shareToFeed} onCheckedChange={(v) => patch({ shareToFeed: v })} /> Partilhar os Reels também na grelha do Feed
          </label>
          <Button size="sm" variant="secondary" onClick={testConn} disabled={testing}>
            {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Instagram className="h-4 w-4" />} Testar ligação
          </Button>
        </div>
      </Card>

      <Card className="space-y-3">
        <h3 className="text-sm font-bold">Horários diários de {account.name}</h3>
        <div className="flex flex-wrap gap-2">
          {account.dailySlots.map((s) => (
            <span key={s} className="flex items-center gap-1 rounded-md bg-secondary px-2 py-1 text-xs">
              {s}
              <button
                className="cursor-pointer text-muted-foreground hover:text-destructive"
                onClick={() => {
                  if (account.dailySlots.length <= 1) {
                    toast.error("Mantém pelo menos 1 horário diário.");
                    return;
                  }
                  patch({ dailySlots: account.dailySlots.filter((x) => x !== s) });
                }}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <Input value={slotText} onChange={(e) => setSlotText(e.target.value)} placeholder="12:00, 18:00, 21:30" />
          <Button
            onClick={() => {
              const slots = slotText
                .split(",")
                .map((s) => s.trim())
                .filter((s) => /^\d{2}:\d{2}$/.test(s));
              if (!slots.length) {
                toast.error("Escolhe um horário (HH:MM).");
                return;
              }
              patch({ dailySlots: slots });
              saveSlots(slots);
            }}
          >
            Guardar horários
          </Button>
        </div>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------- robo tab */
function RoboTab({ session }: { session: Session }) {
  const copy = async () => {
    const script = generateRobo24hScript(session);
    const problems = assertRobo24hSadio(script);
    if (problems.length) {
      toast.error("Robô incompleto: " + problems.join(", "));
      return;
    }
    await navigator.clipboard.writeText(script);
    toast.success("✅ Código do Robô 24h copiado! Cola em script.google.com e corre ativarRobo24h.");
  };
  return (
    <Card className="space-y-4">
      <h3 className="flex items-center gap-2 text-sm font-bold">
        <Bot className="h-4 w-4 text-primary" /> Robô 24h — publicação com o PC e o celular desligados
      </h3>
      <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
        <li>
          Clica em <strong className="text-foreground">1. Copiar Código do Robô 24h</strong> (já vem pré-configurado com a chave criptografada do seu login!).
        </li>
        <li>
          Cola em <a className="text-primary underline" href="https://script.google.com" target="_blank" rel="noreferrer">script.google.com</a> (Novo projeto) e guarda 💾.
        </li>
        <li>
          Seleciona <code className="rounded bg-secondary px-1">ativarRobo24h</code> e clica em ▶ Executar; autoriza a conta Google.
        </li>
        <li>Fica um acionador de 5 em 5 minutos nos servidores do Google — ele abre a fila na nuvem e publica todos os vídeos nos horários definidos, mesmo com seu PC e seu celular totalmente desligados!</li>
      </ol>
      <Button size="lg" onClick={copy}>
        <Copy className="h-4 w-4" /> 1. Copiar Código do Robô 24h
      </Button>
      <p className="text-[11px] text-muted-foreground">
        ⚠️ Se reimplantares o Apps Script/Worker, volta a correr <code>ativarRobo24h</code>. Só um aparelho deve publicar a mesma fila (claims anti-duplicado).
      </p>
    </Card>
  );
}
