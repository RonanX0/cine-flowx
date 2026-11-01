/*
 * 📊 MÉTRICAS — CineClip
 * ---------------------------------------------------------------------------
 * Uma aba com as métricas de cada Reel já publicado na conta ativa: views,
 * alcance, curtidas, comentários, compartilhamentos, salvos e seguidores
 * ganhos.
 *
 * De onde vêm os números:
 *   • AUTOMÁTICO — quando o app publica, guarda no Reel o `publishedId` (o id do
 *     media no Instagram). Com ele e o token da conta (`metaAccessToken`, o
 *     mesmo que publica), pergunta-se à Graph API:
 *       - curtidas e comentários pelos campos do próprio media (`like_count`,
 *         `comments_count`), que são os mais estáveis;
 *       - o resto pelos insights (`views`, `reach`, `shares`, `saved`,
 *         `follows`). Se o pedido conjunto falhar — basta uma métrica que a
 *         API já não aceite —, refaz-se uma a uma e fica o que funcionar.
 *   • MANUAL — qualquer número pode ser escrito à mão. O que foi escrito à mão
 *     fica marcado e uma atualização automática NÃO o sobrescreve.
 *
 * Os números vão no próprio Reel (`item.metricas`), gravado com o
 * `guardarNaFila` do app — por isso sincronizam com a nuvem como o resto da
 * fila, em vez de ficarem presos a um navegador.
 *
 * Código legível de propósito (o resto do app vive num bundle compilado). A
 * aba é um <div id="cc-metricas-monte"> criado pelo bundle.
 *
 * API pública:
 *   window.CineMetricas.montar() · .carregar() · .atualizarTudo() · ._interno
 */
(function () {
  "use strict";

  if (window.CineMetricas) return;

  var ID_MONTE = "cc-metricas-monte";
  var GRAPH = "https://graph.facebook.com/v22.0";

  /* As métricas da aba, pela ordem das colunas. `api` diz onde a Graph API as
     tem: "campo" é um campo do media, "insight" vem de /insights. */
  var METRICAS = [
    { id: "views", rotulo: "Views", api: "insight" },
    { id: "reach", rotulo: "Alcance", api: "insight" },
    { id: "likes", rotulo: "Curtidas", api: "campo", campo: "like_count" },
    { id: "comments", rotulo: "Coment.", api: "campo", campo: "comments_count" },
    { id: "shares", rotulo: "Compart.", api: "insight" },
    { id: "saved", rotulo: "Salvos", api: "insight" },
    { id: "follows", rotulo: "Seguidores", api: "insight" },
  ];
  var INSIGHTS = METRICAS.filter(function (m) { return m.api === "insight"; }).map(function (m) { return m.id; });
  var SIMULTANEOS_API = 3;
  var ATRASO_GRAVAR_MS = 700;

  var estado = {
    montado: false,
    itens: [],
    carregando: false,
    erro: "",
    aviso: "",
    buscando: {},
    autoFeito: false,
  };
  var raiz = null;
  var temporizadores = {};

  /* Pontos de contacto com o resto do app — trocáveis nos testes. */
  var ambiente = {
    core: function () { return window.CineClipCore || null; },
    app: function () { return window.__CineClipApp || null; },
    fetch: function (url, opts) { return window.fetch(url, opts); },
    agora: function () { return Date.now(); },
  };

  /* ------------------------------------------------------------- ajudantes */

  function el(tag, props, filhos) {
    var n = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v == null || v === false) return;
        if (k === "className") n.className = v;
        else if (k === "text") n.textContent = v;
        else if (k.slice(0, 2) === "on" && typeof v === "function") n.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === "style") n.setAttribute("style", v);
        else if (k === "value") n.value = v;
        else n.setAttribute(k, v === true ? "" : v);
      });
    }
    (filhos || []).forEach(function (f) {
      if (f == null || f === false) return;
      n.appendChild(typeof f === "string" ? document.createTextNode(f) : f);
    });
    return n;
  }

  function numero(v) {
    var n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
  }

  function formatar(n) {
    if (n == null) return "—";
    try { return Number(n).toLocaleString("pt-BR"); } catch (_) { return String(n); }
  }

  function contaAtiva() {
    var app = ambiente.app();
    return (app && app.account) || null;
  }

  function quandoPublicado(item) {
    var t = item.publishedAt || item.postedAt || item.updatedAt || item.scheduledTimestamp || item.scheduledAt;
    var d = typeof t === "number" ? new Date(t) : new Date(String(t || ""));
    return isNaN(d.getTime()) ? null : d;
  }

  function dataLegivel(item) {
    var d = quandoPublicado(item);
    if (!d) return "";
    try {
      return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) + " " +
        d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    } catch (_) {
      return d.toISOString().slice(0, 16).replace("T", " ");
    }
  }

  /* ------------------------------------------------------------- dados */

  /** Reels publicados da conta ativa, do mais recente para o mais antigo. */
  async function carregar() {
    var core = ambiente.core();
    var conta = contaAtiva();
    if (!core || typeof core.lerFila !== "function") {
      estado.erro = "A fila do app ainda está a carregar. Tenta de novo daqui a pouco.";
      desenhar();
      return [];
    }
    estado.carregando = true;
    estado.erro = "";
    desenhar();
    try {
      var fila = (await core.lerFila()) || [];
      var idConta = conta && conta.id;
      estado.itens = fila
        .filter(function (it) {
          return it && it.status === "published" && (!idConta || (it.accountId || "acc_default") === idConta);
        })
        .sort(function (a, b) {
          var da = quandoPublicado(a), db = quandoPublicado(b);
          return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
        });
    } catch (e) {
      estado.erro = "Não consegui ler a fila: " + ((e && e.message) || e);
    }
    estado.carregando = false;
    desenhar();
    return estado.itens;
  }

  /** Grava o Reel com as métricas novas. O `updatedAt` sobe para a sincronização com a nuvem o levar. */
  async function gravar(item) {
    var core = ambiente.core();
    if (!core || typeof core.guardarNaFila !== "function") return;
    item.updatedAt = ambiente.agora();
    await core.guardarNaFila(item);
  }

  /* ------------------------------------------------------------- Graph API */

  async function pedirGraph(caminho, token) {
    var url = GRAPH + caminho + (caminho.indexOf("?") >= 0 ? "&" : "?") + "access_token=" + encodeURIComponent(token);
    var r = await ambiente.fetch(url);
    var corpo = null;
    try { corpo = await r.json(); } catch (_) { corpo = null; }
    if (!r.ok || (corpo && corpo.error)) {
      var e = (corpo && corpo.error) || {};
      var erro = new Error(e.message || ("HTTP " + r.status));
      erro.codigo = e.code;
      throw erro;
    }
    return corpo || {};
  }

  /** O valor de uma métrica de insights, venha em `values[0].value` ou em `total_value.value`. */
  function valorDoInsight(d) {
    if (!d) return null;
    if (d.total_value && d.total_value.value != null) return numero(d.total_value.value);
    if (Array.isArray(d.values) && d.values.length) return numero(d.values[0].value);
    return null;
  }

  /** Traduz o erro da Graph API para algo que se possa fazer alguma coisa com. */
  function explicarErro(e) {
    var m = String((e && e.message) || e || "");
    if (e && e.codigo === 190) return "O token do Instagram expirou — gera um novo nas Configurações da conta.";
    if ((e && (e.codigo === 10 || e.codigo === 200)) || /permission|instagram_manage_insights/i.test(m)) {
      return "O token não tem permissão de métricas (instagram_manage_insights). Dá para preencher à mão.";
    }
    return m || "falhou";
  }

  /**
   * Busca as métricas de um Reel. Devolve { valores, falharam, erro }: os
   * valores que a API deu, as métricas que ela não deu, e um erro geral se
   * nem os campos básicos vieram (token, permissão…).
   */
  async function buscarDoInstagram(item, conta) {
    var token = String((conta && conta.metaAccessToken) || "").trim();
    var id = String(item.publishedId || "").trim();
    if (!token) return { valores: {}, falharam: [], erro: "Esta conta não tem o token do Instagram — preenche à mão." };
    if (!id) return { valores: {}, falharam: [], erro: "Este Reel não tem o id do Instagram guardado (foi publicado fora do app?)." };

    var valores = {};
    var falharam = [];

    // 1) Curtidas e comentários: campos do próprio media.
    try {
      var campos = METRICAS.filter(function (m) { return m.api === "campo"; });
      var media = await pedirGraph("/" + encodeURIComponent(id) + "?fields=" + campos.map(function (m) { return m.campo; }).join(","), token);
      campos.forEach(function (m) {
        var v = numero(media[m.campo]);
        if (v != null) valores[m.id] = v;
        else falharam.push(m.id);
      });
    } catch (e) {
      // Sem os campos básicos não vale a pena tentar os insights: o problema é
      // o token ou o id, e a mensagem diz qual.
      return { valores: {}, falharam: METRICAS.map(function (m) { return m.id; }), erro: explicarErro(e) };
    }

    // 2) Insights: tudo num pedido; se a API recusar o conjunto, um a um.
    var porNome = {};
    try {
      var r = await pedirGraph("/" + encodeURIComponent(id) + "/insights?metric=" + INSIGHTS.join(","), token);
      (r.data || []).forEach(function (d) { porNome[d.name] = valorDoInsight(d); });
    } catch (eConjunto) {
      for (var i = 0; i < INSIGHTS.length; i++) {
        try {
          var r1 = await pedirGraph("/" + encodeURIComponent(id) + "/insights?metric=" + INSIGHTS[i], token);
          var d1 = (r1.data || [])[0];
          porNome[INSIGHTS[i]] = valorDoInsight(d1);
        } catch (_) {
          porNome[INSIGHTS[i]] = null;
        }
      }
    }
    INSIGHTS.forEach(function (nome) {
      if (porNome[nome] != null) valores[nome] = porNome[nome];
      else falharam.push(nome);
    });
    return { valores: valores, falharam: falharam, erro: "" };
  }

  /**
   * Junta o que veio da API às métricas do Reel. O que foi escrito à mão
   * (`manual[campo]`) ganha: uma atualização automática nunca o apaga.
   */
  function juntar(item, resultado) {
    var m = item.metricas || {};
    var manual = m.manual || {};
    var novo = {};
    METRICAS.forEach(function (met) {
      if (manual[met.id] && m[met.id] != null) novo[met.id] = m[met.id];
      else if (resultado.valores[met.id] != null) novo[met.id] = resultado.valores[met.id];
      else if (m[met.id] != null) novo[met.id] = m[met.id];
    });
    novo.manual = manual;
    novo.atualizadoEm = ambiente.agora();
    novo.erroApi = resultado.erro || "";
    novo.semApi = resultado.falharam.filter(function (id) { return !manual[id]; });
    return novo;
  }

  async function atualizarItem(item) {
    if (estado.buscando[item.id]) return;
    estado.buscando[item.id] = true;
    desenhar();
    try {
      var resultado = await buscarDoInstagram(item, contaAtiva());
      item.metricas = juntar(item, resultado);
      await gravar(item);
    } catch (e) {
      item.metricas = Object.assign({}, item.metricas || {}, { erroApi: explicarErro(e) });
    }
    delete estado.buscando[item.id];
    desenhar();
  }

  /** Corre `tarefa` sobre a lista com no máximo `limite` em voo. */
  function emParalelo(lista, limite, tarefa) {
    var proximo = 0;
    function corredor() {
      if (proximo >= lista.length) return Promise.resolve();
      var meu = proximo++;
      return Promise.resolve(tarefa(lista[meu])).then(corredor, corredor);
    }
    var corredores = [];
    for (var i = 0; i < Math.min(limite, lista.length); i++) corredores.push(corredor());
    return Promise.all(corredores);
  }

  async function atualizarTudo(soSemNumeros) {
    var conta = contaAtiva();
    if (!conta || !String(conta.metaAccessToken || "").trim()) {
      estado.aviso = "Esta conta não tem o token do Instagram, por isso as métricas não vêm sozinhas — preenche à mão.";
      desenhar();
      return;
    }
    var alvo = estado.itens.filter(function (it) {
      if (!it.publishedId) return false;
      if (!soSemNumeros) return true;
      return !it.metricas || !it.metricas.atualizadoEm;
    });
    if (!alvo.length) {
      if (!soSemNumeros) estado.aviso = "Nenhum Reel com o id do Instagram para atualizar.";
      desenhar();
      return;
    }
    estado.aviso = "A buscar as métricas de " + alvo.length + " Reel" + (alvo.length > 1 ? "s" : "") + " no Instagram…";
    desenhar();
    await emParalelo(alvo, SIMULTANEOS_API, atualizarItem);
    var comErro = alvo.filter(function (it) { return it.metricas && it.metricas.erroApi; });
    estado.aviso = comErro.length
      ? "Atualizado, mas " + comErro.length + " com erro: " + comErro[0].metricas.erroApi
      : "✅ Métricas atualizadas do Instagram.";
    desenhar();
  }

  /** Escrita à mão: marca o campo como manual e grava 700 ms depois da última tecla. */
  function editar(item, campo, texto) {
    var m = item.metricas || {};
    var manual = Object.assign({}, m.manual || {});
    var v = String(texto).trim() === "" ? null : numero(String(texto).replace(/[^\d]/g, ""));
    if (v == null) {
      delete manual[campo];
      delete m[campo];
    } else {
      manual[campo] = true;
      m[campo] = v;
    }
    m.manual = manual;
    item.metricas = m;
    var chave = item.id + ":" + campo;
    clearTimeout(temporizadores[chave]);
    temporizadores[chave] = setTimeout(function () {
      delete temporizadores[chave];
      gravar(item).then(desenharTotais);
    }, ATRASO_GRAVAR_MS);
    desenharTotais();
  }

  /** Grava já tudo o que ficou à espera (ao sair do campo). */
  function gravarPendentes(item, campo) {
    var chave = item.id + ":" + campo;
    if (temporizadores[chave]) {
      clearTimeout(temporizadores[chave]);
      delete temporizadores[chave];
      gravar(item);
    }
  }

  /* ------------------------------------------------------------- totais */

  function totais() {
    var t = { reels: estado.itens.length };
    METRICAS.forEach(function (m) {
      var soma = 0, n = 0;
      estado.itens.forEach(function (it) {
        var v = it.metricas && it.metricas[m.id];
        if (v != null) { soma += v; n++; }
      });
      t[m.id] = n ? soma : null;
      t[m.id + "_n"] = n;
    });
    // Engajamento = (curtidas + coment. + compart. + salvos) / alcance, só nos
    // Reels que têm alcance — sem ele a conta mentia.
    var inter = 0, alc = 0;
    estado.itens.forEach(function (it) {
      var m = it.metricas || {};
      if (m.reach) {
        alc += m.reach;
        inter += (m.likes || 0) + (m.comments || 0) + (m.shares || 0) + (m.saved || 0);
      }
    });
    t.engajamento = alc ? inter / alc : null;
    return t;
  }

  /* ------------------------------------------------------------- desenho */

  /* Ícone e nome comprido de cada métrica, só para o desenho. */
  var VISUAL = {
    views: { icone: "▶", nome: "Views" },
    reach: { icone: "◎", nome: "Alcance" },
    likes: { icone: "♥", nome: "Curtidas" },
    comments: { icone: "💬", nome: "Comentários" },
    shares: { icone: "↗", nome: "Compartilh." },
    saved: { icone: "🔖", nome: "Salvos" },
    follows: { icone: "＋", nome: "Seguidores" },
  };

  var ORDENS = [
    { id: "recentes", rotulo: "Mais recentes" },
    { id: "views", rotulo: "Mais views" },
    { id: "engajamento", rotulo: "Mais engajamento" },
    { id: "follows", rotulo: "Mais seguidores" },
  ];

  function garantirEstilo() {
    if (document.getElementById("cm-estilo")) return;
    var B = "var(--border,rgba(255,255,255,.09))";
    var FG = "var(--foreground,#f4f4f6)";
    var MUT = "var(--muted-foreground,#a3a3ad)";
    var BG = "var(--background,#141418)";
    var PRI = "var(--primary,#e5484d)";
    var OK = "var(--success,#3dd68c)";
    var css = [
      ".cm-painel{display:flex;flex-direction:column;gap:16px;border:1px solid " + B + ";border-radius:16px;background:var(--card,#1c1c22);color:" + FG + ";padding:20px;font-size:13px;font-family:inherit}",
      ".cm-topo{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px}",
      ".cm-cab{display:flex;align-items:center;gap:12px;min-width:0}",
      ".cm-icone{flex:none;display:grid;place-items:center;width:40px;height:40px;border-radius:12px;background:color-mix(in oklab," + PRI + " 18%,transparent);font-size:20px}",
      ".cm-titulo{margin:0;font-size:18px;font-weight:700;line-height:1.2}",
      ".cm-sub{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:3px;font-size:12px;color:" + MUT + "}",
      ".cm-ponto{width:7px;height:7px;border-radius:50%;background:" + MUT + "}",
      ".cm-ponto.ligado{background:" + OK + ";box-shadow:0 0 0 3px color-mix(in oklab," + OK + " 22%,transparent)}",
      ".cm-acoes{display:flex;flex-wrap:wrap;gap:8px}",
      ".cm-botao{display:inline-flex;align-items:center;gap:6px;border:1px solid " + B + ";background:" + BG + ";color:" + FG + ";border-radius:10px;padding:8px 14px;cursor:pointer;font:600 12.5px/1 inherit;transition:background .15s,border-color .15s,opacity .15s}",
      ".cm-botao:hover:not(:disabled){border-color:color-mix(in oklab," + FG + " 25%,transparent)}",
      ".cm-botao.primario{background:" + PRI + ";border-color:transparent;color:#fff;box-shadow:0 2px 12px color-mix(in oklab," + PRI + " 30%,transparent)}",
      ".cm-botao.primario:hover:not(:disabled){filter:brightness(1.08)}",
      ".cm-botao:disabled{opacity:.45;cursor:default}",
      ".cm-botao.icone{padding:7px 9px;border-radius:9px;font-size:13px}",
      ".cm-girando{display:inline-block;animation:cm-gira 1s linear infinite}",
      "@keyframes cm-gira{to{transform:rotate(360deg)}}",
      ".cm-aviso,.cm-erro{padding:10px 12px;border-radius:10px;font-size:12.5px;line-height:1.5;border:1px solid " + B + ";border-left-width:3px;background:" + BG + "}",
      ".cm-aviso{border-left-color:" + MUT + ";color:" + MUT + "}",
      ".cm-erro{border-left-color:var(--destructive,#e5484d);color:" + FG + ";background:color-mix(in oklab,var(--destructive,#e5484d) 10%," + BG + ")}",
      ".cm-vazio{display:flex;flex-direction:column;align-items:center;gap:6px;padding:36px 16px;border:1px dashed " + B + ";border-radius:12px;text-align:center;color:" + MUT + "}",
      ".cm-vazio b{font-size:15px;color:" + FG + "}",
      ".cm-totais{display:flex;flex-direction:column;gap:10px}",
      ".cm-destaques{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}",
      ".cm-kpi{position:relative;overflow:hidden;border:1px solid " + B + ";border-radius:12px;background:" + BG + ";padding:14px 16px}",
      ".cm-kpi:before{content:'';position:absolute;inset:0 auto 0 0;width:3px;background:var(--cm-cor," + PRI + ")}",
      ".cm-kpi-rot{display:flex;align-items:center;gap:6px;font-size:11.5px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;color:" + MUT + "}",
      ".cm-kpi-val{margin-top:6px;font-size:26px;font-weight:800;line-height:1.1;font-variant-numeric:tabular-nums;letter-spacing:-.01em}",
      ".cm-kpi-pe{margin-top:4px;font-size:11.5px;color:" + MUT + "}",
      ".cm-pilulas{display:flex;flex-wrap:wrap;gap:8px}",
      ".cm-pilula{display:inline-flex;align-items:center;gap:6px;padding:6px 11px;border:1px solid " + B + ";border-radius:999px;font-size:12px;color:" + MUT + "}",
      ".cm-pilula b{color:" + FG + ";font-variant-numeric:tabular-nums}",
      ".cm-secao{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin-top:4px}",
      ".cm-secao h3{margin:0;font-size:14px;font-weight:700}",
      ".cm-ordem{border:1px solid " + B + ";background:" + BG + ";color:" + FG + ";border-radius:9px;padding:6px 10px;font:12px inherit;cursor:pointer}",
      ".cm-lista{display:flex;flex-direction:column;gap:10px}",
      ".cm-reel{border:1px solid " + B + ";border-radius:12px;background:" + BG + ";padding:12px 14px;display:flex;flex-direction:column;gap:10px;transition:border-color .15s}",
      ".cm-reel:hover{border-color:color-mix(in oklab," + FG + " 18%,transparent)}",
      ".cm-reel-topo{display:flex;align-items:flex-start;gap:10px}",
      ".cm-pos{flex:none;display:grid;place-items:center;min-width:26px;height:26px;padding:0 6px;border-radius:8px;background:var(--secondary,#26262c);font-size:11.5px;font-weight:700;color:" + MUT + "}",
      ".cm-pos.ouro{background:color-mix(in oklab,#f5b70a 22%,transparent);color:#f5c542}",
      ".cm-reel-info{flex:1;min-width:0}",
      ".cm-nome{display:block;font-size:14px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:" + FG + ";text-decoration:none}",
      "a.cm-nome:hover{text-decoration:underline}",
      ".cm-meta{display:flex;flex-wrap:wrap;gap:4px 10px;margin-top:2px;font-size:11.5px;color:" + MUT + "}",
      ".cm-meta .cm-falhou{color:var(--destructive,#ff6b6b)}",
      ".cm-eng{flex:none;padding:4px 9px;border-radius:999px;font-size:11.5px;font-weight:700;background:color-mix(in oklab," + OK + " 14%,transparent);color:" + OK + ";font-variant-numeric:tabular-nums}",
      ".cm-eng.vazio{background:var(--secondary,#26262c);color:" + MUT + ";font-weight:600}",
      ".cm-barra{height:4px;border-radius:999px;background:var(--secondary,#26262c);overflow:hidden}",
      ".cm-barra i{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg," + PRI + ",color-mix(in oklab," + PRI + " 55%,#f5b70a))}",
      ".cm-numeros{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px}",
      ".cm-num{display:flex;flex-direction:column;gap:2px;padding:6px 8px;border-radius:9px;background:var(--card,#1c1c22);border:1px solid transparent}",
      ".cm-num label{display:flex;align-items:center;gap:4px;font-size:10.5px;font-weight:600;color:" + MUT + ";white-space:nowrap}",
      ".cm-num input{width:100%;min-width:0;background:transparent;border:1px solid transparent;border-radius:6px;margin:0 -5px;padding:2px 5px;color:" + FG + ";font:700 15px/1.3 inherit;font-variant-numeric:tabular-nums;outline:none;transition:border-color .15s,background .15s}",
      ".cm-num input::placeholder{color:color-mix(in oklab," + MUT + " 60%,transparent);font-weight:500}",
      ".cm-num input:hover{border-color:" + B + "}",
      ".cm-num input:focus{border-color:" + PRI + ";background:" + BG + "}",
      ".cm-num.manual{border-color:color-mix(in oklab,#f59e0b 45%,transparent)}",
      ".cm-num.manual label:after{content:'à mão';margin-left:auto;font-size:9px;font-weight:700;color:#f59e0b;text-transform:uppercase}",
      ".cm-num.sem-api{border:1px dashed " + B + "}",
      ".cm-legenda{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:11.5px;color:" + MUT + "}",
      ".cm-legenda span{display:inline-flex;align-items:center;gap:6px}",
      ".cm-legenda i{display:inline-block;width:14px;height:10px;border-radius:3px}",
      "@media (max-width:860px){.cm-numeros{grid-template-columns:repeat(4,minmax(0,1fr))}}",
      "@media (max-width:640px){.cm-painel{padding:14px;border-radius:14px}.cm-destaques{grid-template-columns:repeat(2,minmax(0,1fr))}.cm-kpi{padding:12px}.cm-kpi-val{font-size:22px}.cm-acoes{width:100%}.cm-acoes .cm-botao{flex:1;justify-content:center}" +
        ".cm-reel{padding:12px}.cm-reel-topo{flex-wrap:wrap}.cm-reel-info{flex:1 1 calc(100% - 80px)}.cm-nome{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}" +
        ".cm-numeros{gap:5px}.cm-num{padding:5px 6px}.cm-num label{font-size:10px;overflow:hidden;text-overflow:ellipsis}.cm-num input{font-size:13.5px;margin:0;padding:2px 0}.cm-num.manual label:after{content:'✎'}}",
    ].join("\n");
    var s = el("style", { id: "cm-estilo" });
    s.textContent = css;
    document.head.appendChild(s);
  }

  function porcento(x) {
    return x != null ? (x * 100).toFixed(1).replace(".", ",") + "%" : "—";
  }

  function engajamentoDe(item) {
    var m = item.metricas || {};
    if (!m.reach) return null;
    return ((m.likes || 0) + (m.comments || 0) + (m.shares || 0) + (m.saved || 0)) / m.reach;
  }

  function desenharTotais() {
    if (!raiz) return;
    var caixa = raiz.querySelector(".cm-totais");
    if (!caixa) return;
    var novo = blocoTotais();
    caixa.parentNode.replaceChild(novo, caixa);
  }

  function media(t, id) {
    return t[id] != null && t[id + "_n"] ? Math.round(t[id] / t[id + "_n"]) : null;
  }

  function kpi(rotulo, valor, pe, cor, titulo) {
    return el("div", { className: "cm-kpi", style: "--cm-cor:" + cor, title: titulo || null }, [
      el("div", { className: "cm-kpi-rot", text: rotulo }),
      el("div", { className: "cm-kpi-val", text: valor }),
      el("div", { className: "cm-kpi-pe", text: pe }),
    ]);
  }

  function blocoTotais() {
    var t = totais();
    var mv = media(t, "views"), ma = media(t, "reach");
    var destaques = el("div", { className: "cm-destaques" }, [
      kpi("▶ Views", formatar(t.views), mv != null ? "média " + formatar(mv) + " por Reel" : "sem números ainda", "var(--primary,#e5484d)"),
      kpi("◎ Alcance", formatar(t.reach), ma != null ? "média " + formatar(ma) + " por Reel" : "sem números ainda", "var(--accent,#8e4ec6)"),
      kpi("⚡ Engajamento", porcento(t.engajamento), "interações ÷ alcance", "var(--success,#3dd68c)",
        "(curtidas + comentários + compartilhamentos + salvos) ÷ alcance"),
      kpi("＋ Seguidores", t.follows != null ? "+" + formatar(t.follows) : "—", t.reels + (t.reels === 1 ? " Reel publicado" : " Reels publicados"), "#f5b70a"),
    ]);
    var pilulas = el("div", { className: "cm-pilulas" }, ["likes", "comments", "shares", "saved"].map(function (id) {
      var v = VISUAL[id];
      var md = media(t, id);
      return el("span", { className: "cm-pilula", title: md != null ? "média por Reel: " + formatar(md) : null }, [
        v.icone + " " + v.nome, el("b", { text: formatar(t[id]) }),
      ]);
    }));
    return el("div", { className: "cm-totais" }, [destaques, pilulas]);
  }

  function ordenados() {
    var lista = estado.itens.slice();
    var o = estado.ordem || "recentes";
    if (o === "recentes") return lista;
    var valor = o === "engajamento" ? engajamentoDe : function (it) { return it.metricas ? it.metricas[o] : null; };
    return lista.sort(function (a, b) {
      var va = valor(a), vb = valor(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return vb - va;
    });
  }

  function cartaoReel(item, posicao, maxViews) {
    var m = item.metricas || {};
    var manual = m.manual || {};
    var semApi = m.semApi || [];
    var titulo = item.title || item.originalTitle || item.fileName || "Reel";
    var a = !!estado.buscando[item.id];
    var eng = engajamentoDe(item);

    var meta = [el("span", { text: dataLegivel(item) || "data desconhecida" })];
    if (a) meta.push(el("span", { text: "a buscar no Instagram…" }));
    else if (m.erroApi) meta.push(el("span", { className: "cm-falhou", text: m.erroApi }));
    else if (m.atualizadoEm) meta.push(el("span", { text: "atualizado " + dataLegivel({ updatedAt: m.atualizadoEm }) }));
    if (!item.publishedId) meta.push(el("span", { text: "publicado fora do app — só à mão" }));

    var numeros = METRICAS.map(function (met) {
      var v = VISUAL[met.id];
      var faltou = semApi.indexOf(met.id) >= 0;
      var idCampo = "cm-" + item.id + "-" + met.id;
      var inp = el("input", {
        id: idCampo,
        type: "text",
        inputmode: "numeric",
        autocomplete: "off",
        "aria-label": v.nome + " de " + titulo,
        value: m[met.id] != null ? formatar(m[met.id]) : "",
        placeholder: faltou ? "preencher" : "—",
        title: manual[met.id] ? "Escrito à mão — a atualização automática não mexe" : "Clica para escrever à mão",
      });
      inp.addEventListener("focus", function () { inp.select(); });
      inp.addEventListener("input", function () { editar(item, met.id, inp.value); });
      inp.addEventListener("blur", function () {
        gravarPendentes(item, met.id);
        var atual = item.metricas && item.metricas[met.id];
        inp.value = atual != null ? formatar(atual) : "";
        inp.parentNode.className = "cm-num" + (item.metricas && item.metricas.manual && item.metricas.manual[met.id] ? " manual" : faltou ? " sem-api" : "");
      });
      return el("div", { className: "cm-num" + (manual[met.id] ? " manual" : faltou ? " sem-api" : "") }, [
        el("label", { for: idCampo, text: v.icone + " " + v.nome }),
        inp,
      ]);
    });

    var largura = maxViews && m.views ? Math.max(2, Math.round((m.views / maxViews) * 100)) : 0;
    return el("div", { className: "cm-reel", "data-id": item.id }, [
      el("div", { className: "cm-reel-topo" }, [
        el("span", { className: "cm-pos" + (posicao === 1 && estado.ordem && estado.ordem !== "recentes" ? " ouro" : ""), text: String(posicao) }),
        el("div", { className: "cm-reel-info" }, [
          item.publishedUrl
            ? el("a", { className: "cm-nome", href: item.publishedUrl, target: "_blank", rel: "noopener", title: titulo + " — abrir no Instagram", text: titulo })
            : el("span", { className: "cm-nome", title: titulo, text: titulo }),
          el("div", { className: "cm-meta" }, meta),
        ]),
        el("span", { className: "cm-eng" + (eng == null ? " vazio" : ""), title: "Engajamento deste Reel: interações ÷ alcance", text: eng == null ? "— eng." : porcento(eng) + " eng." }),
        el("button", {
          type: "button",
          className: "cm-botao icone",
          disabled: a || !item.publishedId ? true : null,
          "aria-label": "Atualizar " + titulo + " do Instagram",
          title: item.publishedId ? "Buscar as métricas deste Reel no Instagram" : "Sem o id do Instagram — preenche à mão",
          onClick: function () { atualizarItem(item); },
        }, [el("span", { className: a ? "cm-girando" : "", text: "↻" })]),
      ]),
      el("div", { className: "cm-barra", title: m.views ? formatar(m.views) + " views" : "sem views ainda" }, [
        el("i", { style: "width:" + largura + "%" }),
      ]),
      el("div", { className: "cm-numeros" }, numeros),
    ]);
  }

  function desenhar() {
    if (!raiz) return;
    raiz.innerHTML = "";
    var conta = contaAtiva();
    var temToken = !!(conta && String(conta.metaAccessToken || "").trim());
    var ocupado = estado.carregando || Object.keys(estado.buscando).length > 0;

    raiz.appendChild(el("div", { className: "cm-topo" }, [
      el("div", { className: "cm-cab" }, [
        el("div", { className: "cm-icone", text: "📊" }),
        el("div", {}, [
          el("h2", { className: "cm-titulo", text: "Métricas dos Reels" }),
          el("div", { className: "cm-sub" }, [
            el("span", { className: "cm-ponto" + (temToken ? " ligado" : "") }),
            (conta && conta.name ? conta.name + " · " : "") + (temToken ? "busca automática ligada" : "sem token do Instagram — só à mão"),
          ]),
        ]),
      ]),
      el("div", { className: "cm-acoes" }, [
        el("button", { type: "button", className: "cm-botao", disabled: ocupado ? true : null, title: "Ler de novo os Reels publicados", text: "↻ Recarregar", onClick: function () { carregar(); } }),
        el("button", {
          type: "button", className: "cm-botao primario", disabled: ocupado || !temToken ? true : null,
          title: temToken ? "Buscar os números de todos os Reels no Instagram" : "Esta conta não tem o token do Instagram",
          onClick: function () { atualizarTudo(false); },
        }, [el("span", { className: ocupado && !estado.carregando ? "cm-girando" : "", text: "↻" }), "Atualizar tudo do Instagram"]),
      ]),
    ]));

    if (estado.erro) raiz.appendChild(el("div", { className: "cm-erro", text: estado.erro }));
    if (estado.aviso) raiz.appendChild(el("div", { className: "cm-aviso", text: estado.aviso }));

    if (estado.carregando && !estado.itens.length) {
      raiz.appendChild(el("div", { className: "cm-vazio" }, [el("span", { className: "cm-girando", text: "↻" }), "A carregar os Reels publicados…"]));
      return;
    }
    if (!estado.itens.length) {
      raiz.appendChild(el("div", { className: "cm-vazio" }, [
        el("div", { style: "font-size:28px", text: "🎬" }),
        el("b", { text: "Ainda não há Reels publicados nesta conta" }),
        "Assim que o app (ou o Robô 24h) publicar, eles aparecem aqui com os números.",
      ]));
      return;
    }

    raiz.appendChild(blocoTotais());

    var seletor = el("select", { className: "cm-ordem", "aria-label": "Ordenar os Reels" }, ORDENS.map(function (o) {
      var op = el("option", { value: o.id, text: o.rotulo });
      if ((estado.ordem || "recentes") === o.id) op.selected = true;
      return op;
    }));
    seletor.addEventListener("change", function () { estado.ordem = seletor.value; desenhar(); });
    raiz.appendChild(el("div", { className: "cm-secao" }, [el("h3", { text: "Por Reel" }), seletor]));

    var lista = ordenados();
    var maxViews = lista.reduce(function (mx, it) { return Math.max(mx, (it.metricas && it.metricas.views) || 0); }, 0);
    raiz.appendChild(el("div", { className: "cm-lista" }, lista.map(function (it, i) { return cartaoReel(it, i + 1, maxViews); })));

    raiz.appendChild(el("div", { className: "cm-legenda" }, [
      el("span", {}, [el("i", { style: "border:1px solid #f59e0b" }), "escrito à mão (a atualização automática não mexe)"]),
      el("span", {}, [el("i", { style: "border:1px dashed currentColor" }), "o Instagram não deu este número — dá para preencher"]),
      el("span", { text: "Clica num número para o corrigir." }),
    ]));
  }

  /* ------------------------------------------------------------- montagem */

  function montar() {
    if (estado.montado) return true;
    if (typeof document === "undefined" || !document.getElementById) return false;
    var alvo = document.getElementById(ID_MONTE);
    if (!alvo) return false;
    garantirEstilo();
    raiz = el("div", { className: "cm-painel" });
    alvo.appendChild(raiz);
    estado.montado = true;
    desenhar();
    // Carrega quando a aba fica visível; na primeira vez busca sozinho os
    // números dos Reels que ainda não têm nenhum.
    var visivelAntes = false;
    setInterval(function () {
      if (!raiz || !raiz.isConnected) return;
      var dono = document.getElementById(ID_MONTE);
      var visivel = !!dono && !/hidden/.test(dono.className);
      if (visivel && !visivelAntes) {
        carregar().then(function () {
          if (!estado.autoFeito) {
            estado.autoFeito = true;
            var conta = contaAtiva();
            if (conta && String(conta.metaAccessToken || "").trim()) atualizarTudo(true);
          }
        });
      }
      visivelAntes = visivel;
    }, 600);
    return true;
  }

  function iniciarObservador() {
    if (montar()) return;
    if (typeof MutationObserver === "undefined") {
      var tentativas = 0;
      var t = setInterval(function () {
        if (montar() || ++tentativas > 200) clearInterval(t);
      }, 250);
      return;
    }
    var obs = new MutationObserver(function () {
      if (montar()) obs.disconnect();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", iniciarObservador);
    else iniciarObservador();
  }

  window.CineMetricas = {
    montar: montar,
    carregar: carregar,
    atualizarTudo: atualizarTudo,
    _interno: {
      ambiente: ambiente,
      estado: estado,
      desenhar: desenhar,
      buscarDoInstagram: buscarDoInstagram,
      juntar: juntar,
      editar: editar,
      gravarPendentes: gravarPendentes,
      atualizarItem: atualizarItem,
      totais: totais,
      METRICAS: METRICAS,
    },
  };
})();
