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

  function garantirEstilo() {
    if (document.getElementById("cm-estilo")) return;
    var css = [
      ".cm-painel{padding:12px 4px;font-size:13px}",
      ".cm-topo{display:flex;flex-wrap:wrap;align-items:center;gap:8px;justify-content:space-between;margin-bottom:10px}",
      ".cm-titulo{font-size:16px;font-weight:700}",
      ".cm-sub{color:#9ca3af;font-size:12px}",
      ".cm-botao{border:1px solid #374151;background:#111827;color:#f3f4f6;border-radius:6px;padding:6px 10px;cursor:pointer;font-size:12px}",
      ".cm-botao:disabled{opacity:.5;cursor:default}",
      ".cm-aviso{margin:8px 0;padding:8px 10px;border-radius:6px;background:#111827;border:1px solid #374151;font-size:12px}",
      ".cm-erro{margin:8px 0;padding:8px 10px;border-radius:6px;background:#3b0d0d;border:1px solid #7f1d1d;font-size:12px}",
      ".cm-totais{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin:10px 0}",
      ".cm-cartao{border:1px solid #374151;border-radius:8px;padding:8px 10px}",
      ".cm-cartao b{display:block;font-size:16px}",
      ".cm-cartao span{color:#9ca3af;font-size:11px}",
      ".cm-tabela-wrap{overflow-x:auto}",
      ".cm-tabela{width:100%;border-collapse:collapse;min-width:820px}",
      ".cm-tabela th{text-align:left;font-weight:600;color:#9ca3af;font-size:11px;padding:6px 4px;border-bottom:1px solid #374151}",
      ".cm-tabela td{padding:6px 4px;border-bottom:1px solid #1f2937;vertical-align:middle}",
      ".cm-tabela input{width:72px;background:#0b0f19;border:1px solid #374151;border-radius:4px;color:#f3f4f6;padding:4px;font-size:12px}",
      ".cm-tabela input.cm-manual{border-color:#d97706}",
      ".cm-tabela input.cm-sem-api{border-style:dashed}",
      ".cm-nome{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".cm-nome a{color:#93c5fd;text-decoration:none}",
      ".cm-estado{font-size:11px;color:#9ca3af;max-width:180px}",
      ".cm-estado.cm-falhou{color:#fca5a5}",
      ".cm-legenda{margin-top:8px;color:#9ca3af;font-size:11px}",
    ].join("\n");
    var s = el("style", { id: "cm-estilo" });
    s.textContent = css;
    document.head.appendChild(s);
  }

  function desenharTotais() {
    if (!raiz) return;
    var caixa = raiz.querySelector(".cm-totais");
    if (!caixa) return;
    var novo = blocoTotais();
    caixa.parentNode.replaceChild(novo, caixa);
  }

  function blocoTotais() {
    var t = totais();
    var cartoes = [el("div", { className: "cm-cartao" }, [el("b", { text: String(t.reels) }), el("span", { text: "Reels publicados" })])];
    METRICAS.forEach(function (m) {
      var media = t[m.id] != null && t[m.id + "_n"] ? Math.round(t[m.id] / t[m.id + "_n"]) : null;
      cartoes.push(el("div", { className: "cm-cartao", title: media != null ? "média por Reel: " + formatar(media) : "" }, [
        el("b", { text: formatar(t[m.id]) }),
        el("span", { text: m.rotulo + (media != null ? " · média " + formatar(media) : "") }),
      ]));
    });
    cartoes.push(el("div", { className: "cm-cartao", title: "(curtidas + comentários + compartilhamentos + salvos) ÷ alcance" }, [
      el("b", { text: t.engajamento != null ? (t.engajamento * 100).toFixed(1).replace(".", ",") + "%" : "—" }),
      el("span", { text: "Engajamento" }),
    ]));
    return el("div", { className: "cm-totais" }, cartoes);
  }

  function linha(item) {
    var m = item.metricas || {};
    var manual = m.manual || {};
    var semApi = m.semApi || [];
    var titulo = item.title || item.originalTitle || item.fileName || "Reel";
    var celulas = [
      el("td", { className: "cm-nome", title: titulo }, [
        item.publishedUrl ? el("a", { href: item.publishedUrl, target: "_blank", rel: "noopener", text: titulo }) : titulo,
      ]),
      el("td", { text: dataLegivel(item) }),
    ];
    METRICAS.forEach(function (met) {
      var inp = el("input", {
        type: "text",
        inputmode: "numeric",
        "aria-label": met.rotulo + " de " + titulo,
        value: m[met.id] != null ? String(m[met.id]) : "",
        placeholder: semApi.indexOf(met.id) >= 0 ? "à mão" : "—",
        className: manual[met.id] ? "cm-manual" : semApi.indexOf(met.id) >= 0 ? "cm-sem-api" : "",
        title: manual[met.id] ? "escrito à mão — a atualização automática não mexe" : "",
      });
      inp.addEventListener("input", function () { editar(item, met.id, inp.value); });
      inp.addEventListener("blur", function () { gravarPendentes(item, met.id); });
      celulas.push(el("td", {}, [inp]));
    });
    var a = !!estado.buscando[item.id];
    var estadoTxt = a ? "A buscar…" : m.erroApi ? m.erroApi : m.atualizadoEm ? "atualizado " + dataLegivel({ updatedAt: m.atualizadoEm }) : "";
    celulas.push(el("td", { className: "cm-estado" + (m.erroApi && !a ? " cm-falhou" : "") }, [estadoTxt]));
    celulas.push(el("td", {}, [
      el("button", {
        type: "button",
        className: "cm-botao",
        disabled: a || !item.publishedId ? true : null,
        title: item.publishedId ? "Buscar as métricas deste Reel no Instagram" : "Sem o id do Instagram — preenche à mão",
        text: "🔄",
        onClick: function () { atualizarItem(item); },
      }),
    ]));
    return el("tr", { "data-id": item.id }, celulas);
  }

  function desenhar() {
    if (!raiz) return;
    raiz.innerHTML = "";
    var conta = contaAtiva();
    var temToken = !!(conta && String(conta.metaAccessToken || "").trim());
    var ocupado = estado.carregando || Object.keys(estado.buscando).length > 0;

    raiz.appendChild(el("div", { className: "cm-topo" }, [
      el("div", {}, [
        el("div", { className: "cm-titulo", text: "📊 Métricas dos Reels" }),
        el("div", { className: "cm-sub", text: (conta && conta.name ? conta.name + " · " : "") + (temToken ? "busca automática ligada" : "sem token do Instagram — só à mão") }),
      ]),
      el("div", {}, [
        el("button", { type: "button", className: "cm-botao", disabled: ocupado ? true : null, text: "↻ Recarregar lista", onClick: function () { carregar(); } }),
        " ",
        el("button", {
          type: "button", className: "cm-botao", disabled: ocupado || !temToken ? true : null,
          title: temToken ? "" : "Esta conta não tem o token do Instagram",
          text: "🔄 Atualizar tudo do Instagram", onClick: function () { atualizarTudo(false); },
        }),
      ]),
    ]));

    if (estado.erro) raiz.appendChild(el("div", { className: "cm-erro", text: estado.erro }));
    if (estado.aviso) raiz.appendChild(el("div", { className: "cm-aviso", text: estado.aviso }));

    if (estado.carregando && !estado.itens.length) {
      raiz.appendChild(el("div", { className: "cm-aviso", text: "A carregar os Reels publicados…" }));
      return;
    }
    if (!estado.itens.length) {
      raiz.appendChild(el("div", { className: "cm-aviso", text: "Ainda não há Reels publicados nesta conta. Assim que o app (ou o Robô 24h) publicar, eles aparecem aqui." }));
      return;
    }

    raiz.appendChild(blocoTotais());
    var cab = [el("th", { text: "Reel" }), el("th", { text: "Publicado" })]
      .concat(METRICAS.map(function (m) { return el("th", { text: m.rotulo }); }))
      .concat([el("th", { text: "Estado" }), el("th", {})]);
    raiz.appendChild(el("div", { className: "cm-tabela-wrap" }, [
      el("table", { className: "cm-tabela" }, [
        el("thead", {}, [el("tr", {}, cab)]),
        el("tbody", {}, estado.itens.map(linha)),
      ]),
    ]));
    raiz.appendChild(el("div", { className: "cm-legenda", text: "Borda laranja = escrito à mão (a atualização automática não mexe). Tracejado = a API não deu este número — dá para preencher à mão." }));
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
