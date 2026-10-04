/* ==========================================================================
 * CineClip — novo layout do AGENDADOR (patch 21)
 *
 * Este ficheiro é o código LEGÍVEL que substitui o "return" do componente
 * do Agendador (RS) no bundle. É inserido tal como está (sem minificar) por
 *   node tools/build-agendador-patch.mjs   →   tools/patches/21-agendador-ui.replace
 *
 * Variáveis do componente original que podes usar aqui (nomes minificados):
 *   r  clipe atual (currentClip)          o  contas           i(contas,id) trocar conta
 *   f  fila completa                      X  fila da conta    j  conta ativa
 *   D  id a publicar                      fe próximo horário livre
 *   se/$  data escolhida p/ agendar       V/te  horários (texto "12:00, 18:00")
 *   w/_  form. nova conta  k/C nome nova conta   g/v painel config (legado)
 *   oe ref do <input file>   he() recarregar fila   u() avisar a app (sync)
 *   ye(patch) gravar conta  Te() criar conta  le(item) publicar agora
 *   ce() agendar clipe atual  z() salvar pacote  R(files) importar
 *   U(item,data) reagendar  K(item,conta) mover  H(id) remover  ne() exportar
 *   Ícones: xi CalendarClock, Kr Sparkles, Z0 Settings2, T0 FolderUp, Ko Download,
 *   cp PackageCheck, wm Plus, bm Trash2, Pc Copy, J0 Send, rr Loader, cx Alert,
 *   w0 Clock, ip Film, lp Instagram, vx Users, ou X, ap CircleCheck
 *   Componentes: Ae Button, fn Badge, dn Input, er Label, qe(...) classnames
 *
 * Marcadores substituídos pelo gerador com o código ORIGINAL do bundle
 * (para não perder nada do que os patches anteriores já fazem):
 *   __CC_ROBO__         painel "Robô 24h"
 *   __CC_CONFIG__       painel de configuração da conta (modo, webhook, token…)
 *   __CC_CLOUD_BADGE__  selo da nuvem de cada item (patch 09)
 *   __CC_REENVIAR__     botão "Reenviar p/ nuvem" de cada item (patch 10)
 * ========================================================================== */
const cc_h = (t, p, ...c) => {
  const { key: k, ...q } = p || {};
  return c.length > 1 ? d.jsxs(t, { ...q, children: c }, k) : d.jsx(t, c.length ? { ...q, children: c[0] } : q, k);
};
const [cc_tab, cc_setTab] = b.useState("fila");
const [cc_filter, cc_setFilter] = b.useState("pendentes");
const [cc_open, cc_setOpen] = b.useState(null);
const [cc_newSlot, cc_setNewSlot] = b.useState("");
const [cc_custom, cc_setCustom] = b.useState(false);
const [cc_sort, cc_setSortRaw] = b.useState(() => { try { return localStorage.getItem("cineclip.agenda.sort") || "hora"; } catch { return "hora"; } });
const cc_setSort = (val) => { cc_setSortRaw(val); try { localStorage.setItem("cineclip.agenda.sort", val); } catch {} };
const [cc_q, cc_setQ] = b.useState("");
const [cc_drag, cc_setDrag] = b.useState(null);
const [cc_over, cc_setOver] = b.useState(null);
const [cc_busy, cc_setBusy] = b.useState(false);
b.useEffect(() => {
  // Criar conta / abrir configuração (código antigo) passa a abrir a aba "Conta"
  if (g) { cc_setTab("conta"); v(!1); }
  if (x) { cc_setTab("robo"); h(!1); }
}, [g, x]);

const cc_pad = (n) => String(n).padStart(2, "0");
const cc_localKey = (dt) => `${dt.getFullYear()}-${cc_pad(dt.getMonth() + 1)}-${cc_pad(dt.getDate())}`;
const cc_nowStr = new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
const cc_dayLabel = (key, long) => {
  const today = new Date();
  const t0 = cc_localKey(today);
  const t1 = cc_localKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1));
  const tm = cc_localKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1));
  const dt = new Date(`${key}T00:00`);
  const pretty = isNaN(dt) ? key : dt.toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "short" }).replace(/\./g, "").replace(/^./, (c0) => c0.toUpperCase());
  const rel = key === t0 ? "Hoje" : key === t1 ? "Amanhã" : key === tm ? "Ontem" : "";
  if (long) return rel ? `${rel} · ${pretty}` : pretty;
  return rel || pretty;
};
const cc_when = (s) => (s ? `${cc_dayLabel(s.slice(0, 10))} às ${s.slice(11, 16)}` : "—");

const cc_isPending = (it) => it.status !== "published";
const cc_counts = {
  todos: X.length,
  pendentes: X.filter(cc_isPending).length,
  publicados: X.filter((it) => it.status === "published").length,
  erros: X.filter((it) => it.status === "error").length,
};
const cc_next = X.filter((it) => it.status === "scheduled" && it.scheduledAt.slice(0, 16) >= cc_nowStr)
  .sort((a1, a2) => a1.scheduledAt.localeCompare(a2.scheduledAt))[0];
const cc_late = X.filter((it) => it.status === "scheduled" && it.scheduledAt.slice(0, 16) < cc_nowStr).length;

/* ---------------------------------------------- filtro, busca e ordenação */
const cc_norm = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const cc_isLate = (it) => it.status === "scheduled" && it.scheduledAt.slice(0, 16) < cc_nowStr;
const cc_rank = (it) => (it.status === "error" ? 0 : cc_isLate(it) ? 1 : it.status === "publishing" ? 2 : it.status === "published" ? 4 : 3);
const cc_byTime = (a1, a2) => (a1.scheduledAt || "").localeCompare(a2.scheduledAt || "");
const cc_sorters = {
  hora: cc_byTime,
  hora_desc: (a1, a2) => cc_byTime(a2, a1),
  titulo: (a1, a2) => (a1.title || "").localeCompare(a2.title || "", "pt", { sensitivity: "base" }) || cc_byTime(a1, a2),
  situacao: (a1, a2) => cc_rank(a1) - cc_rank(a2) || cc_byTime(a1, a2),
};
const cc_sortLabels = { hora: "Horário (mais cedo)", hora_desc: "Horário (mais tarde)", titulo: "Título (A–Z)", situacao: "Situação (erros primeiro)" };
const cc_qn = cc_norm(cc_q.trim());
const cc_list = X.filter((it) =>
  cc_filter === "todos" ? !0 : cc_filter === "publicados" ? it.status === "published" : cc_filter === "erros" ? it.status === "error" : cc_isPending(it),
).filter((it) => !cc_qn || cc_norm(`${it.title} ${it.originalTitle || ""} ${it.year || ""} ${it.caption || ""}`).includes(cc_qn))
 .sort(cc_sorters[cc_sort] || cc_byTime);
const cc_byDay = cc_sort === "hora" || cc_sort === "hora_desc";
const cc_groups = [];
for (const it of cc_list) {
  const key = cc_byDay ? (it.scheduledAt || "").slice(0, 10) : "__all";
  const last = cc_groups[cc_groups.length - 1];
  if (last && last.key === key) last.items.push(it);
  else cc_groups.push({ key, items: [it] });
}

/* ------------------------------------------- reordenar (troca de horários)
 * Os horários ficam onde estão; o que muda é QUAL Reel ocupa cada horário. */
const cc_orderable = X.filter((it) => it.status === "scheduled" || it.status === "error").sort(cc_byTime);
const cc_canReorder = cc_sort === "hora" && !cc_qn && (cc_filter === "pendentes" || cc_filter === "todos") && cc_orderable.length > 1 && !D;
const cc_applyOrder = async (order, msg) => {
  if (cc_busy) return;
  const slots = order.map((it) => it.scheduledAt).sort();
  const changed = order.map((it, n) => ({ it, at: slots[n] })).filter((c2) => c2.it.scheduledAt !== c2.at);
  if (!changed.length) return;
  cc_setBusy(!0);
  try {
    for (const c2 of changed) await Rn({ ...c2.it, scheduledAt: c2.at, updatedAt: Date.now() });
    await he();
    u == null || u();
    je.success(msg || "Ordem atualizada — os Reels trocaram de horário.");
  } catch (err) {
    je.error((err == null ? void 0 : err.message) || "Não foi possível reordenar a fila.");
  } finally { cc_setBusy(!1); }
};
const cc_moveBy = (it, dir) => {
  const list = [...cc_orderable];
  const n = list.findIndex((x2) => x2.id === it.id);
  const m = n + dir;
  if (n < 0 || m < 0 || m >= list.length) return;
  [list[n], list[m]] = [list[m], list[n]];
  cc_applyOrder(list, `"${it.title}" agora sai ${cc_when(cc_orderable[m].scheduledAt)}.`);
};
const cc_dropOn = (dragId, targetId) => {
  if (!dragId || dragId === targetId) return;
  const list = [...cc_orderable];
  const from = list.findIndex((x2) => x2.id === dragId);
  const to = list.findIndex((x2) => x2.id === targetId);
  if (from < 0 || to < 0) return;
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
  cc_applyOrder(list, `"${moved.title}" agora sai ${cc_when(cc_orderable[to].scheduledAt)}.`);
};
// Redistribui os Reels agendados pelos próximos horários livres (fecha buracos e corrige atrasados)
const cc_repack = async () => {
  const items = X.filter((it) => it.status === "scheduled").sort(cc_byTime);
  if (!items.length) { je.error("Não há Reels agendados para reorganizar."); return; }
  if (!window.confirm(`Redistribuir ${items.length} Reel(s) de ${j.name} pelos próximos horários livres (${j.dailySlots.join(" · ")}), mantendo a ordem atual?`)) return;
  const ids = new Set(items.map((it) => it.id));
  const base = f.filter((it) => !ids.has(it.id));
  cc_setBusy(!0);
  try {
    let n = 0;
    for (const it of items) {
      const at = za(base, j.dailySlots, j.id);
      base.push({ ...it, scheduledAt: at });
      if (at !== it.scheduledAt) { await Rn({ ...it, scheduledAt: at, updatedAt: Date.now() }); n++; }
    }
    await he();
    u == null || u();
    je.success(n ? `${n} Reel(s) reorganizado(s) nos próximos horários livres.` : "A fila já estava organizada.");
  } finally { cc_setBusy(!1); }
};
const cc_nextFreeFor = (it) => za(f.filter((x2) => x2.id !== it.id), j.dailySlots, j.id);

// Próximos horários livres desta conta (atalhos rápidos para agendar)
const cc_quick = b.useMemo(() => {
  const fake = [...f];
  const out = [];
  for (let n = 0; n < 6; n++) {
    const s = za(fake, j.dailySlots, j.id);
    if (out.includes(s)) break;
    out.push(s);
    fake.push({ accountId: j.id, status: "scheduled", scheduledAt: s });
  }
  return out;
}, [f, j.dailySlots, j.id]);
const cc_chosen = se || fe;

const cc_slots = V.split(",").map((s) => s.trim()).filter((s) => /^\d{2}:\d{2}$/.test(s));
const cc_saveSlots = (list) => {
  const uniq = Array.from(new Set(list)).sort();
  te(uniq.join(", "));
  ye({ dailySlots: uniq });
};
const cc_addSlot = () => {
  if (!/^\d{2}:\d{2}$/.test(cc_newSlot)) { je.error("Escolhe um horário (HH:MM)."); return; }
  if (cc_slots.includes(cc_newSlot)) { je.error("Esse horário já existe."); return; }
  cc_saveSlots([...cc_slots, cc_newSlot]);
  cc_setNewSlot("");
  je.success(`Horário ${cc_newSlot} adicionado em ${j.name}.`);
};
const cc_removeSlot = (s) => {
  if (cc_slots.length <= 1) { je.error("Mantém pelo menos 1 horário diário."); return; }
  cc_saveSlots(cc_slots.filter((x2) => x2 !== s));
};

const cc_modeLabel = j.mode === "meta_api" ? "API Oficial Meta" : j.mode === "webhook" ? "Webhook Make/n8n" : "Robô Meta Business Suite";
const cc_configured = (acc) =>
  acc.mode === "webhook" ? !!acc.webhookUrl.trim() : acc.mode === "meta_api" ? !!(acc.igUserId.trim() && acc.metaAccessToken.trim()) : !0;

const cc_statusInfo = (it, late) =>
  it.status === "published" ? { cls: "cc-st-ok", label: "Publicado" }
  : it.status === "publishing" ? { cls: "cc-st-run", label: "A publicar…" }
  : it.status === "error" ? { cls: "cc-st-err", label: "Erro" }
  : late ? { cls: "cc-st-late", label: "Atrasado" }
  : { cls: "cc-st-wait", label: "Agendado" };

/* ------------------------------------------------------------ peças da UI */
const cc_stat = (label, value, hint, onClick, tone) =>
  cc_h("button", { type: "button", className: qe("cc-stat", tone && `cc-stat-${tone}`, !onClick && "cc-stat-static"), onClick, disabled: !onClick },
    cc_h("span", { className: "cc-stat-label" }, label),
    cc_h("span", { className: "cc-stat-value" }, value),
    cc_h("span", { className: "cc-stat-hint" }, hint),
  );

const cc_tabBtn = (id, icon, label, count) =>
  cc_h("button", { type: "button", role: "tab", "aria-selected": cc_tab === id, className: qe("cc-tab", cc_tab === id && "cc-tab-on"), onClick: () => cc_setTab(id) },
    d.jsx(icon, { className: "h-4 w-4" }),
    cc_h("span", null, label),
    count > 0 ? cc_h("span", { className: "cc-tab-count" }, count) : null,
  );

const cc_accounts = cc_h("div", { className: "cc-accounts" },
  cc_h("div", { className: "cc-acc-scroll" },
    o.map((acc) => {
      const on = acc.id === j.id;
      const n = f.filter((it) => (it.accountId || "acc_default") === acc.id && it.status !== "published").length;
      const ok = cc_configured(acc);
      return cc_h("button", { key: acc.id, type: "button", className: qe("cc-acc", on && "cc-acc-on"), onClick: () => { i(o, acc.id); $(""); cc_setOpen(null); }, title: ok ? "Conta configurada" : "Falta configurar Webhook/Token desta conta" },
        cc_h("span", { className: qe("cc-dot", ok ? "cc-dot-ok" : "cc-dot-warn") }),
        cc_h("span", { className: "cc-acc-name" }, acc.name),
        cc_h("span", { className: "cc-acc-count" }, n),
      );
    }),
    cc_h("button", { type: "button", className: "cc-acc cc-acc-add", onClick: () => _((s) => !s), title: "Adicionar outra conta do Instagram" },
      d.jsx(wm, { className: "h-3.5 w-3.5" }), cc_h("span", null, "Nova conta")),
  ),
  w && cc_h("div", { className: "cc-newacc" },
    d.jsx(dn, { value: k, autoFocus: !0, onChange: (ev) => C(ev.target.value), onKeyDown: (ev) => { ev.key === "Enter" && Te(); ev.key === "Escape" && _(!1); }, placeholder: "@cortes.series", className: "h-9 flex-1 text-sm" }),
    d.jsx(Ae, { size: "sm", onClick: Te, className: "bg-brand text-primary-foreground", children: "Criar" }),
    d.jsx(Ae, { size: "sm", variant: "ghost", onClick: () => _(!1), children: "Cancelar" }),
  ),
);

const cc_composeEmpty = cc_h("div", { className: "cc-card cc-compose-empty" },
  cc_h("div", { className: "cc-poster cc-poster-empty" }, d.jsx(ip, { className: "h-4 w-4" })),
  cc_h("div", { className: "cc-compose-txt" },
    cc_h("strong", null, "Nenhum vídeo pronto para agendar"),
    cc_h("span", { className: "cc-sub" }, "Processa um vídeo no Estúdio ou importa um .mp4 / pacote .cineclip — próximo horário livre: ", cc_when(fe))),
  cc_h(Ae, { variant: "outline", onClick: () => { var el = oe.current; el && el.click(); }, title: "Importar vídeo .mp4 ou pacote .cineclip.json" },
    d.jsx(T0, { className: "h-4 w-4" }), "Importar"),
);
const cc_compose = !(r && r.cleanBlob) ? cc_composeEmpty : cc_h("div", { className: "cc-card cc-compose" },
  cc_h("div", { className: "cc-compose-clip" },
    r && r.poster
      ? d.jsx("img", { src: r.poster, alt: "", className: "cc-poster cc-poster-lg" })
      : cc_h("div", { className: "cc-poster cc-poster-lg cc-poster-empty" }, d.jsx(ip, { className: "h-5 w-5" })),
    cc_h("div", { className: "cc-compose-txt" },
      cc_h("span", { className: "cc-kicker" }, "Novo agendamento"),
      r && r.cleanBlob
        ? cc_h("strong", { className: "cc-compose-title" }, r.title, r.year ? ` (${r.year})` : "")
        : cc_h("strong", { className: "cc-compose-title cc-muted" }, "Nenhum vídeo pronto"),
      cc_h("span", { className: "cc-sub" }, r && r.cleanBlob ? `Vai para a fila de ${j.name}` : "Processa um vídeo no editor ou importa um pacote .cineclip"),
    ),
  ),
  cc_h("div", { className: "cc-compose-when" },
    cc_h("span", { className: "cc-label" }, d.jsx(w0, { className: "h-3.5 w-3.5" }), " Quando publicar"),
    cc_h("div", { className: "cc-chips" },
      cc_quick.map((s) => cc_h("button", { key: s, type: "button", className: qe("cc-chip", !cc_custom && cc_chosen === s && "cc-chip-on"), onClick: () => { $(s); cc_setCustom(!1); } },
        cc_h("span", { className: "cc-chip-day" }, cc_dayLabel(s.slice(0, 10))), cc_h("span", { className: "cc-chip-time" }, s.slice(11, 16)))),
      cc_h("button", { type: "button", className: qe("cc-chip cc-chip-other", (cc_custom || !cc_quick.includes(cc_chosen)) && "cc-chip-on"), onClick: () => cc_setCustom((s) => !s) },
        cc_h("span", { className: "cc-chip-day" }, "Outro"), cc_h("span", { className: "cc-chip-time" }, "📅")),
    ),
    (cc_custom || !cc_quick.includes(cc_chosen)) && d.jsx("input", { type: "datetime-local", value: cc_chosen, onChange: (ev) => $(ev.target.value), className: "cc-input cc-input-dt" }),
  ),
  cc_h("div", { className: "cc-compose-actions" },
    cc_h(Ae, { size: "lg", disabled: !(r && r.cleanBlob), onClick: ce, className: "bg-brand text-primary-foreground cc-grow" },
      d.jsx(xi, { className: "h-4 w-4" }), `Agendar · ${cc_when(cc_chosen)}`),
    cc_h(Ae, { size: "lg", variant: "secondary", disabled: !(r && r.cleanBlob), onClick: z, title: "Baixa o .mp4 + .cineclip.json para agendares noutra altura" },
      d.jsx(cp, { className: "h-4 w-4" }), cc_h("span", { className: "cc-hide-sm" }, "Salvar pacote")),
    cc_h(Ae, { size: "lg", variant: "outline", onClick: () => { var el = oe.current; el && el.click(); }, title: "Importar vídeo .mp4 ou pacote .cineclip.json" },
      d.jsx(T0, { className: "h-4 w-4" }), cc_h("span", { className: "cc-hide-sm" }, "Importar")),
  ),
);

const cc_filterBtn = (id, label) =>
  cc_h("button", { type: "button", className: qe("cc-fchip", cc_filter === id && "cc-fchip-on", id === "erros" && cc_counts.erros > 0 && "cc-fchip-err"), onClick: () => { cc_setFilter(id); cc_setOpen(null); } },
    label, cc_h("span", { className: "cc-fchip-n" }, cc_counts[id]));

const cc_item = (N) => {
  const G = D === N.id || N.status === "publishing";
  const late = N.status === "scheduled" && N.scheduledAt.slice(0, 16) < cc_nowStr;
  const st = cc_statusInfo(N, late);
  const opened = cc_open === N.id;
  const canPublish = N.status !== "published" && !G && !!(N.videoBlob || N.remoteVideoUrl);
  const pos = cc_orderable.findIndex((x2) => x2.id === N.id);
  const movable = cc_canReorder && pos >= 0 && !G;
  const dragProps = movable ? {
    draggable: !0,
    onDragStart: (ev) => { cc_setDrag(N.id); ev.dataTransfer.effectAllowed = "move"; try { ev.dataTransfer.setData("text/plain", N.id); } catch {} },
    onDragEnd: () => { cc_setDrag(null); cc_setOver(null); },
    onDragOver: (ev) => { if (cc_drag && cc_drag !== N.id) { ev.preventDefault(); cc_over !== N.id && cc_setOver(N.id); } },
    onDragLeave: () => cc_over === N.id && cc_setOver(null),
    onDrop: (ev) => { ev.preventDefault(); const id = cc_drag; cc_setDrag(null); cc_setOver(null); cc_dropOn(id, N.id); },
  } : {};
  return cc_h("div", { key: N.id, ...dragProps, className: qe("cc-item", st.cls, opened && "cc-item-open", cc_drag === N.id && "cc-item-drag", cc_over === N.id && "cc-item-over", cc_busy && "cc-item-busy") },
    cc_h("div", { className: "cc-row", onClick: (ev) => { ev.target.closest("button,input,select,a") || cc_setOpen(opened ? null : N.id); } },
      movable && cc_h("span", { className: "cc-grip", title: "Arrasta para mudar a ordem (os horários ficam, os Reels trocam)" },
        d.jsx("svg", { viewBox: "0 0 24 24", width: 14, height: 14, fill: "currentColor", children: d.jsx("path", { d: "M9 5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm0 7a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm-1.5 8.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM18 5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm-1.5 8.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM18 19a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z" }) })),
      cc_h("div", { className: "cc-time" }, !cc_byDay && cc_h("span", { className: "cc-time-day" }, cc_dayLabel((N.scheduledAt || "").slice(0, 10))), cc_h("strong", null, (N.scheduledAt || "").slice(11, 16)), cc_h("span", { className: qe("cc-pill", st.cls) }, st.label)),
      N.poster ? d.jsx("img", { src: N.poster, alt: "", className: "cc-poster" }) : cc_h("div", { className: "cc-poster cc-poster-empty" }, d.jsx(ip, { className: "h-4 w-4" })),
      cc_h("div", { className: "cc-main" },
        cc_h("div", { className: "cc-title" }, cc_h("span", { className: "cc-title-txt" }, N.title), N.year && cc_h("span", { className: "cc-muted" }, ` (${N.year})`)),
        cc_h("div", { className: "cc-badges" }, __CC_CLOUD_BADGE__, N.videoSize > 0 && cc_h("span", { className: "cc-size" }, Fa(N.videoSize))),
        N.lastStep && cc_h("p", { className: "cc-step" }, G && d.jsx(rr, { className: "h-3 w-3 animate-spin" }), N.lastStep),
        N.errorMsg && cc_h("p", { className: "cc-err" }, d.jsx(cx, { className: "h-3.5 w-3.5 shrink-0" }), N.errorMsg),
        (late || N.status === "error") && !G && cc_h("button", { type: "button", className: "cc-link", onClick: () => U(N, cc_nextFreeFor(N)) },
          d.jsx(w0, { className: "h-3 w-3" }), ` Mover p/ próximo horário livre (${cc_when(cc_nextFreeFor(N))})`),
      ),
      cc_h("div", { className: "cc-actions" },
        movable && cc_h("div", { className: "cc-move" },
          cc_h("button", { type: "button", disabled: pos === 0 || cc_busy, title: "Subir (troca de horário com o anterior)", onClick: () => cc_moveBy(N, -1) },
            d.jsx("svg", { viewBox: "0 0 24 24", width: 14, height: 14, fill: "none", stroke: "currentColor", strokeWidth: 2.5, strokeLinecap: "round", strokeLinejoin: "round", children: d.jsx("path", { d: "m18 15-6-6-6 6" }) })),
          cc_h("button", { type: "button", disabled: pos === cc_orderable.length - 1 || cc_busy, title: "Descer (troca de horário com o seguinte)", onClick: () => cc_moveBy(N, 1) },
            d.jsx("svg", { viewBox: "0 0 24 24", width: 14, height: 14, fill: "none", stroke: "currentColor", strokeWidth: 2.5, strokeLinecap: "round", strokeLinejoin: "round", children: d.jsx("path", { d: "m6 9 6 6 6-6" }) }))),
        N.status !== "published" && cc_h(Ae, { size: "sm", disabled: !canPublish, onClick: () => le(N), title: N.videoBlob || N.remoteVideoUrl ? `Publicar agora em ${j.name}` : "Sem vídeo — importa o .mp4", className: "cc-pub" },
          G ? d.jsx(rr, { className: "h-3.5 w-3.5 animate-spin" }) : d.jsx(J0, { className: "h-3.5 w-3.5" }), cc_h("span", { className: "cc-hide-sm" }, "Publicar")),
        d.jsx(Ae, { size: "sm", variant: "ghost", className: "cc-icon-btn", title: "Copiar legenda", onClick: () => { navigator.clipboard.writeText(N.caption); je.success("Legenda copiada!"); }, children: d.jsx(Pc, { className: "h-4 w-4" }) }),
        d.jsx(Ae, { size: "sm", variant: "ghost", className: qe("cc-icon-btn cc-chev", opened && "cc-chev-on"), title: opened ? "Fechar detalhes" : "Editar / mais opções", "aria-expanded": opened, onClick: () => cc_setOpen(opened ? null : N.id), children: d.jsx("svg", { viewBox: "0 0 24 24", width: 16, height: 16, fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", children: d.jsx("path", { d: "m6 9 6 6 6-6" }) }) }),
      ),
    ),
    opened && cc_h("div", { className: "cc-details" },
      cc_h("div", { className: "cc-fields" },
        cc_h("label", { className: "cc-field" }, cc_h("span", { className: "cc-label" }, "Data e hora"),
          d.jsx("input", { type: "datetime-local", value: N.scheduledAt, disabled: N.status === "published" || G, onChange: (ev) => U(N, ev.target.value), className: "cc-input" })),
        o.length > 1 && cc_h("label", { className: "cc-field" }, cc_h("span", { className: "cc-label" }, "Conta"),
          d.jsx("select", { value: N.accountId || j.id, disabled: G, onChange: (ev) => { K(N, ev.target.value); cc_setOpen(null); }, className: "cc-input", children: o.map((acc) => d.jsx("option", { value: acc.id, children: acc.name }, acc.id)) })),
      ),
      cc_h("div", { className: "cc-field" }, cc_h("span", { className: "cc-label" }, "Legenda"), cc_h("div", { className: "cc-caption" }, N.caption || "—")),
      N.poster && cc_h("span", { className: "cc-sub" }, "✔ O pôster do TMDB vai como capa do Reel."),
      cc_h("div", { className: "cc-detail-actions" },
        (N.videoBlob || N.remoteVideoUrl) && cc_h(Ae, { size: "sm", variant: "outline", onClick: () => { N.videoBlob ? Zn(N.videoBlob, N.videoFileName) : N.remoteVideoUrl && window.open(N.remoteVideoUrl, "_blank"); } },
          d.jsx(Ko, { className: "h-3.5 w-3.5" }), " Baixar vídeo"),
        __CC_REENVIAR__,
        cc_h(Ae, { size: "sm", variant: "ghost", disabled: G, className: "cc-del", onClick: () => { window.confirm(`Remover "${N.title}" da fila de ${j.name}?`) && (H(N.id), cc_setOpen(null)); } },
          d.jsx(bm, { className: "h-3.5 w-3.5" }), " Remover"),
      ),
    ),
  );
};

const cc_queue = cc_h("div", { className: "cc-queue" },
  cc_h("div", { className: "cc-queue-bar" },
    cc_h("div", { className: "cc-fchips" },
      cc_filterBtn("pendentes", "A publicar"), cc_filterBtn("publicados", "Publicados"), cc_filterBtn("erros", "Erros"), cc_filterBtn("todos", "Todos")),
    X.length > 0 && cc_h(Ae, { variant: "ghost", size: "sm", onClick: ne, title: "Exportar a fila para o Robô Playwright (.json)" }, d.jsx(Ko, { className: "h-3.5 w-3.5" }), cc_h("span", { className: "cc-hide-sm" }, "Exportar .json")),
  ),
  X.length > 0 && cc_h("div", { className: "cc-tools" },
    cc_h("label", { className: "cc-search" },
      d.jsx(dp, { className: "h-3.5 w-3.5" }),
      d.jsx("input", { type: "search", value: cc_q, onChange: (ev) => cc_setQ(ev.target.value), placeholder: "Buscar por título ou legenda…" })),
    cc_h("label", { className: "cc-sort", title: "Ordenar a fila" },
      cc_h("span", { className: "cc-hide-sm" }, "Ordenar:"),
      d.jsx("select", { value: cc_sort, onChange: (ev) => cc_setSort(ev.target.value), className: "cc-input", children: Object.entries(cc_sortLabels).map(([id, label]) => d.jsx("option", { value: id, children: label }, id)) })),
    cc_h(Ae, { variant: "outline", size: "sm", disabled: cc_busy || !!D, onClick: cc_repack, title: "Redistribui os Reels agendados pelos próximos horários livres, mantendo a ordem (corrige atrasados e fecha buracos)" },
      cc_busy ? d.jsx(rr, { className: "h-3.5 w-3.5 animate-spin" }) : d.jsx(K0, { className: "h-3.5 w-3.5" }), "Reorganizar horários"),
  ),
  cc_canReorder && cc_h("p", { className: "cc-hint" }, "↕ Arrasta os Reels (ou usa as setas) para mudar a ordem — os horários ficam fixos, os Reels trocam de lugar."),
  !cc_canReorder && cc_sort !== "hora" && cc_orderable.length > 1 && cc_h("p", { className: "cc-hint" }, `A ordenar por ${cc_sortLabels[cc_sort].toLowerCase()}. Para mudar a ordem de publicação, escolhe “Horário (mais cedo)”.`),
  cc_list.length === 0
    ? cc_h("div", { className: "cc-empty" },
        d.jsx(xi, { className: "h-8 w-8" }),
        cc_h("strong", null, X.length === 0 ? `A fila de ${j.name} está vazia` : cc_qn ? `Nada encontrado para “${cc_q.trim()}”` : "Nada neste filtro"),
        cc_h("span", null, X.length === 0 ? "Agenda o vídeo processado no Estúdio ou usa Importar para carregar vídeos já prontos." : cc_qn ? "Tenta outra palavra ou limpa a busca." : "Escolhe outro filtro para ver os restantes Reels."))
    : cc_groups.map((grp) => cc_h("div", { key: grp.key, className: "cc-day" },
        cc_h("div", { className: "cc-day-head" }, cc_h("span", null, grp.key === "__all" ? `Ordenado por ${cc_sortLabels[cc_sort].toLowerCase()}` : cc_dayLabel(grp.key, !0)), cc_h("span", { className: "cc-day-n" }, `${grp.items.length} ${grp.items.length === 1 ? "Reel" : "Reels"}`)),
        cc_h("div", { className: "cc-day-list" }, grp.items.map(cc_item)))),
);

const cc_slotEditor = cc_h("div", { className: "cc-card cc-slots" },
  cc_h("div", { className: "cc-slots-head" },
    cc_h("div", null, cc_h("strong", null, "Horários diários de ", j.name), cc_h("span", { className: "cc-sub" }, "Cada Reel novo vai para o próximo horário livre desta conta.")),
    cc_h("label", { className: "cc-switch" },
      d.jsx("input", { type: "checkbox", checked: j.autoPilot, onChange: (ev) => ye({ autoPilot: ev.target.checked }) }),
      cc_h("span", null, cc_h("strong", null, "Auto-Pilot"), " publica sozinho no horário"))),
  cc_h("div", { className: "cc-chips" },
    cc_slots.map((s) => cc_h("span", { key: s, className: "cc-slot" }, s,
      cc_h("button", { type: "button", title: `Remover ${s}`, onClick: () => cc_removeSlot(s) }, d.jsx(ou, { className: "h-3 w-3" })))),
    cc_h("span", { className: "cc-slot-add" },
      d.jsx("input", { type: "time", value: cc_newSlot, onChange: (ev) => cc_setNewSlot(ev.target.value), onKeyDown: (ev) => ev.key === "Enter" && cc_addSlot(), className: "cc-input cc-input-time" }),
      cc_h(Ae, { size: "sm", variant: "secondary", onClick: cc_addSlot }, d.jsx(wm, { className: "h-3.5 w-3.5" }), "Adicionar")),
  ),
  cc_h("label", { className: "cc-switch cc-switch-sm" },
    d.jsx("input", { type: "checkbox", checked: j.shareToFeed, onChange: (ev) => ye({ shareToFeed: ev.target.checked }) }),
    cc_h("span", null, "Partilhar os Reels também na grelha do Feed")),
);

return cc_h("section", { className: "cc-ag" },
  d.jsx("input", { ref: oe, type: "file", multiple: !0, accept: ".mp4,.mov,.webm,.json", className: "hidden", onChange: (ev) => { R(ev.target.files); ev.currentTarget.value = ""; } }),
  cc_h("header", { className: "cc-head" },
    cc_h("div", { className: "cc-head-l" },
      cc_h("div", { className: "cc-logo bg-brand" }, d.jsx(xi, { className: "h-5 w-5" })),
      cc_h("div", null,
        cc_h("h2", { className: "cc-h2" }, "Agendador"),
        cc_h("span", { className: "cc-sub" }, cc_h("span", { className: qe("cc-dot", cc_configured(j) ? "cc-dot-ok" : "cc-dot-warn") }), ` ${j.name} · ${cc_modeLabel}${j.autoPilot ? " · Auto-Pilot ligado" : ""}`))),
    !cc_configured(j) && cc_h("button", { type: "button", className: "cc-warn-btn", onClick: () => cc_setTab("conta") }, d.jsx(cx, { className: "h-3.5 w-3.5" }), "Configurar conta"),
  ),
  cc_accounts,
  cc_h("div", { className: "cc-stats" },
    cc_stat("Na fila", cc_counts.pendentes, cc_late > 0 ? `${cc_late} atrasado(s)` : "a publicar", () => { cc_setTab("fila"); cc_setFilter("pendentes"); }, cc_late > 0 ? "warn" : null),
    cc_stat("Próximo post", cc_next ? cc_next.scheduledAt.slice(11, 16) : "—", cc_next ? cc_dayLabel(cc_next.scheduledAt.slice(0, 10)) : "nada agendado", null),
    cc_stat("Publicados", cc_counts.publicados, "nesta conta", () => { cc_setTab("fila"); cc_setFilter("publicados"); }, "ok"),
    cc_stat("Erros", cc_counts.erros, cc_counts.erros ? "ver e corrigir" : "tudo certo", () => { cc_setTab("fila"); cc_setFilter("erros"); }, cc_counts.erros ? "err" : null),
  ),
  cc_h("div", { className: "cc-tabs", role: "tablist" },
    cc_tabBtn("fila", xi, "Fila", cc_counts.pendentes),
    cc_tabBtn("conta", Z0, cc_h("span", null, "Conta", cc_h("span", { className: "cc-hide-sm" }, " e horários")), 0),
    cc_tabBtn("robo", Kr, "Robô 24h", 0),
  ),
  cc_tab === "fila" && cc_h("div", { className: "cc-panel" }, cc_compose, cc_queue),
  cc_tab === "conta" && cc_h("div", { className: "cc-panel" }, cc_slotEditor, __CC_CONFIG__),
  cc_tab === "robo" && cc_h("div", { className: "cc-panel" }, __CC_ROBO__),
);
}
