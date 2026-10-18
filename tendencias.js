/*
 * 🔥 TENDÊNCIAS — CineClip
 * ---------------------------------------------------------------------------
 * Painel com os cortes de filmes mais «hypados» do TikTok neste momento, com o
 * nome do filme. Tu escolhes o corte e levas para o CineClip com um clique (o
 * link entra no fluxo normal: baixa, identifica, escreve o gancho e agenda).
 *
 *   1. /api/public/tendencias busca por hashtags e perfis (ver server/tendencias.mjs)
 *      e ordena por «hype» (visualizações por hora + engajamento);
 *   2. o nome do filme vem da legenda e é confirmado no TMDB (o título tem de bater
 *      por inteiro) — sem chave TMDB mostra só «nome provável»;
 *   3. «Levar pro CineClip» → CineLote.levarLinks([link], "aqui"|"nuvem").
 *
 * Código legível de propósito (o resto do app vive num bundle compilado). A aba é um
 * <div id="cc-tendencias-monte"> criado pelo bundle (patches 64 e 66).
 *
 * API pública: window.CineTendencias.montar() · .buscar() · ._interno
 */
(function () {
  "use strict";

  if (window.CineTendencias) return;

  var ID_MONTE = "cc-tendencias-monte";
  var CHAVE_OPCOES = "cineclip.tendencias.opcoes";
  var CHAVE_USADOS = "cineclip.tendencias.usados";
  var CHAVE_FILMES = "cineclip.tendencias.filmes";
  var CHAVE_RESULTADO = "cineclip.tendencias.resultado";
  var VALIDADE_RESULTADO_MS = 10 * 60 * 1000;
  var SUGESTOES = ["cenasdefilme", "filmes", "movieclips", "cortesdefilmes", "melhorescenas", "seriesetv"];
  var OPCOES_OMISSAO = { tags: "cenasdefilme, filmes, movieclips", perfis: "", dias: 7, minViews: 20000, esconderUsados: true, apifyKey: "" };

  var estado = {
    opcoes: lerJson(CHAVE_OPCOES, OPCOES_OMISSAO),
    itens: [],
    estados: [],
    geradoEm: 0,
    carregando: false,
    erro: "",
    aviso: "",
    usados: lerJson(CHAVE_USADOS, {}),
    filmes: lerJson(CHAVE_FILMES, {}),
    montado: false,
    jaBuscou: false,
  };
  var raiz = null;

  /* ------------------------------------------------------------ utilitários */

  function lerJson(chave, omissao) {
    try {
      var v = JSON.parse(localStorage.getItem(chave) || "null");
      if (v && typeof v === "object") return Array.isArray(omissao) ? v : Object.assign({}, omissao, v);
    } catch (e) {}
    return Array.isArray(omissao) ? omissao.slice() : Object.assign({}, omissao);
  }
  function gravarJson(chave, valor) {
    try {
      localStorage.setItem(chave, JSON.stringify(valor));
    } catch (e) {}
  }
  function norm(s) {
    return String(s == null ? "" : s)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  function colado(s) {
    return norm(s).replace(/ /g, "");
  }
  function numeroCurto(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "").replace(".", ",") + " mi";
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, "").replace(".", ",") + " mil";
    return String(n);
  }
  function haQuanto(criadoEmSeg) {
    var h = Math.max(0, (Date.now() - criadoEmSeg * 1000) / 3600000);
    if (h < 1) return "há minutos";
    if (h < 24) return "há " + Math.round(h) + " h";
    return "há " + Math.round(h / 24) + (Math.round(h / 24) === 1 ? " dia" : " dias");
  }
  function app() {
    return window.__CineClipApp || null;
  }
  function chaveTmdb() {
    var a = app();
    var s = (a && a.settings) || {};
    if (s.tmdbKey) return String(s.tmdbKey).trim();
    try {
      return String((JSON.parse(localStorage.getItem("cineclip.settings") || "{}") || {}).tmdbKey || "").trim();
    } catch (e) {
      return "";
    }
  }
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

  /* ------------------------------------------------------------- busca */

  function consultaDosFiltros() {
    var o = estado.opcoes;
    var q = new URLSearchParams();
    if (String(o.apifyKey || "").trim()) q.set("via", "apify");
    if (String(o.tags || "").trim()) q.set("tags", o.tags);
    if (String(o.perfis || "").trim()) q.set("perfis", o.perfis);
    q.set("dias", String(o.dias || 7));
    q.set("min", String(o.minViews || 0));
    q.set("max", "40");
    return q.toString();
  }

  async function buscar(forcar) {
    if (estado.carregando) return;
    var q = consultaDosFiltros();
    if (!String(estado.opcoes.tags || "").trim() && !String(estado.opcoes.perfis || "").trim()) {
      estado.erro = "Escreve pelo menos uma hashtag ou um perfil.";
      desenhar();
      return;
    }
    if (!forcar) {
      var guardado = lerJson(CHAVE_RESULTADO, {});
      if (guardado.q === q && guardado.dados && Date.now() - guardado.t < VALIDADE_RESULTADO_MS) {
        aplicar(guardado.dados);
        return;
      }
    }
    estado.carregando = true;
    estado.erro = "";
    estado.aviso = "";
    desenhar();
    try {
      var token = String(estado.opcoes.apifyKey || "").trim();
      var r = await fetch("/api/public/tendencias?" + q + (forcar ? "&fresco=1" : ""), token ? { headers: { "X-Apify-Token": token } } : undefined);
      if (!r.ok) {
        var msg = "";
        try {
          msg = (await r.json()).error || "";
        } catch (e) {}
        if (r.status === 404 && !msg) msg = "As tendências só funcionam no site publicado na Vercel.";
        throw new Error(msg || "O servidor respondeu " + r.status + ".");
      }
      var dados = await r.json();
      gravarJson(CHAVE_RESULTADO, { q: q, t: Date.now(), dados: dados });
      aplicar(dados);
    } catch (e) {
      estado.erro = e && e.message ? e.message : "Não consegui buscar as tendências.";
    } finally {
      estado.carregando = false;
      desenhar();
    }
    resolverFilmes();
  }

  function aplicar(dados) {
    estado.itens = Array.isArray(dados.itens) ? dados.itens : [];
    estado.estados = Array.isArray(dados.estados) ? dados.estados : [];
    estado.geradoEm = dados.geradoEm || Date.now();
    estado.jaBuscou = true;
    var falhas = estado.estados.filter(function (e) { return !e.ok; });
    if (!estado.itens.length) {
      var semToken = !String(estado.opcoes.apifyKey || "").trim();
      estado.aviso = falhas.length === estado.estados.length && falhas.length
        ? "Nenhuma fonte respondeu (" + falhas[0].erro + ")." + (semToken ? " O serviço grátis bloqueia servidores com frequência: cola abaixo um token do Apify (tem crédito grátis todo mês) para buscar de forma estável." : "")
        : "Nada passou nos filtros. Baixa o mínimo de visualizações ou aumenta os dias.";
    } else if (falhas.length) {
      estado.aviso = "Algumas fontes falharam: " + falhas.map(function (f) { return f.fonte + " (" + f.erro + ")"; }).join(", ") + ".";
    }
    desenhar();
    resolverFilmes();
  }

  /* ---------------------------------------------- nome do filme (TMDB) */

  /** O título do TMDB tem de bater por inteiro com o candidato (sem espaços/acentos). */
  function procurarNoTmdb(chave, candidato) {
    var url = "https://api.themoviedb.org/3/search/multi?include_adult=false&language=pt-BR&query=" + encodeURIComponent(candidato) + "&api_key=" + encodeURIComponent(chave);
    return fetch(url)
      .then(function (r) { return r.ok ? r.json() : { results: [] }; })
      .then(function (j) {
        var alvo = colado(candidato);
        var achados = (j.results || []).filter(function (x) {
          return (x.media_type === "movie" || x.media_type === "tv") && [x.title, x.name, x.original_title, x.original_name].some(function (t) { return t && colado(t) === alvo; });
        });
        achados.sort(function (a, b) { return (b.popularity || 0) - (a.popularity || 0); });
        var x = achados[0];
        if (!x) return null;
        return {
          id: x.id,
          tipo: x.media_type === "tv" ? "tv" : "movie",
          titulo: x.title || x.name,
          ano: String(x.release_date || x.first_air_date || "").slice(0, 4),
          poster: x.poster_path ? "https://image.tmdb.org/t/p/w92" + x.poster_path : "",
        };
      })
      .catch(function () { return null; });
  }

  async function resolverFilme(item, chave) {
    var chaves = (item.candidatos || []).slice(0, 4).map(function (c) { return c.titulo; });
    for (var i = 0; i < chaves.length; i++) {
      var k = colado(chaves[i]);
      if (!k) continue;
      if (k in estado.filmes) {
        if (estado.filmes[k]) return estado.filmes[k];
        continue;
      }
      var f = await procurarNoTmdb(chave, chaves[i]);
      estado.filmes[k] = f; // null também fica guardado: não pergunta duas vezes
      if (f) return f;
    }
    return null;
  }

  var aResolver = false;
  async function resolverFilmes() {
    var chave = chaveTmdb();
    if (!chave || aResolver) return;
    aResolver = true;
    try {
      var fila = estado.itens.slice();
      var paralelo = 3;
      var proximo = 0;
      await Promise.all(
        Array.from({ length: paralelo }, async function () {
          while (proximo < fila.length) {
            var item = fila[proximo++];
            if (item.filme !== undefined) continue;
            item.filme = await resolverFilme(item, chave);
            desenhar();
          }
        })
      );
      gravarJson(CHAVE_FILMES, estado.filmes);
    } finally {
      aResolver = false;
    }
  }

  /* -------------------------------------------------------------- ações */

  function marcarUsado(item) {
    estado.usados[item.id] = Date.now();
    gravarJson(CHAVE_USADOS, estado.usados);
  }

  async function levar(item, destino) {
    var lote = window.CineLote;
    if (!lote || typeof lote.levarLinks !== "function") {
      estado.erro = "O módulo de importação ainda está a carregar. Tenta de novo.";
      desenhar();
      return;
    }
    marcarUsado(item);
    estado.aviso = destino === "nuvem" ? "☁️ A enviar para a nuvem…" : "📥 A levar para o CineClip…";
    desenhar();
    try {
      await lote.levarLinks([item.url], destino);
      estado.aviso = destino === "nuvem" ? "☁️ Link na nuvem: o servidor processa e agenda sozinho." : "📥 Link enviado ao Upload em massa — acompanha por lá.";
    } catch (e) {
      estado.erro = "Não consegui levar o link: " + (e && e.message ? e.message : "erro");
    }
    desenhar();
  }

  function copiar(item) {
    var fim = function (ok) {
      estado.aviso = ok ? "🔗 Link copiado." : "Não consegui copiar — abre no TikTok e copia lá.";
      desenhar();
    };
    try {
      navigator.clipboard.writeText(item.url).then(function () { fim(true); }, function () { fim(false); });
    } catch (e) {
      fim(false);
    }
  }

  /* ----------------------------------------------------------------- UI */

  var CSS = [
    ".ct-painel{display:flex;flex-direction:column;gap:14px;border:1px solid var(--border,rgba(255,255,255,.09));border-radius:16px;background:var(--card,#1c1c22);color:var(--foreground,#f4f4f6);padding:18px 20px;font-family:inherit}",
    ".ct-topo{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px}",
    ".ct-topo h2{margin:0;font-size:18px;font-weight:700}",
    ".ct-sub{margin:0;font-size:13px;line-height:1.55;color:var(--muted-foreground,#a3a3ad)}",
    ".ct-filtros{display:grid;gap:10px;padding:12px;border:1px solid var(--border,rgba(255,255,255,.09));border-radius:12px}",
    ".ct-linha{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end}",
    ".ct-campo{display:flex;flex-direction:column;gap:4px;flex:1;min-width:150px;font-size:12px;color:var(--muted-foreground,#a3a3ad)}",
    ".ct-campo input,.ct-campo select{border-radius:8px;border:1px solid var(--border,rgba(255,255,255,.15));background:var(--background,#141418);color:var(--foreground,#f4f4f6);padding:8px 10px;font:13px inherit}",
    ".ct-campo input:focus,.ct-campo select:focus{outline:2px solid var(--primary,#e5484d);outline-offset:1px}",
    ".ct-chips{display:flex;flex-wrap:wrap;gap:6px}",
    ".ct-chip{font-size:12px;padding:3px 10px;border-radius:999px;border:1px solid var(--border,rgba(255,255,255,.15));background:transparent;color:inherit;cursor:pointer}",
    ".ct-chip:hover{background:var(--muted,#2a2a31)}",
    ".ct-opcao{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted-foreground,#a3a3ad);cursor:pointer}",
    ".ct-opcao input{accent-color:var(--primary,#e5484d)}",
    ".ct-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border-radius:8px;padding:9px 16px;font-size:14px;font-weight:600;cursor:pointer;border:1px solid transparent;font-family:inherit}",
    ".ct-btn[disabled]{opacity:.5;cursor:not-allowed}",
    ".ct-prim{background:var(--primary,#e5484d);color:#fff}",
    ".ct-sec{background:transparent;color:inherit;border-color:var(--border,rgba(255,255,255,.15))}",
    ".ct-sec:hover:not([disabled]){background:var(--muted,#2a2a31)}",
    ".ct-mini{padding:5px 10px;font-size:12px;font-weight:500}",
    ".ct-aviso{font-size:13px;line-height:1.45;padding:10px 12px;border-radius:10px;border:1px solid var(--border,rgba(255,255,255,.1))}",
    ".ct-aviso.erro{border-color:rgba(229,72,77,.5);background:rgba(229,72,77,.1);color:#ffb3b5}",
    ".ct-grade{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}",
    ".ct-card{display:flex;flex-direction:column;gap:8px;border:1px solid var(--border,rgba(255,255,255,.09));border-radius:12px;padding:10px;background:var(--background,#141418)}",
    ".ct-card.usado{opacity:.55}",
    ".ct-corpo{display:flex;gap:10px;align-items:flex-start}",
    ".ct-capa{position:relative;width:84px;aspect-ratio:9/16;border-radius:8px;overflow:hidden;flex:none;background:var(--muted,#2a2a31)}",
    ".ct-capa img{width:100%;height:100%;object-fit:cover;display:block}",
    ".ct-hype{position:absolute;left:4px;bottom:4px;font-size:10px;font-weight:700;padding:2px 6px;border-radius:999px;background:rgba(0,0,0,.72);color:#ffb347}",
    ".ct-dados{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}",
    ".ct-filme{display:flex;gap:8px;align-items:center;font-size:13px;font-weight:700;line-height:1.3}",
    ".ct-filme img{width:28px;height:42px;object-fit:cover;border-radius:4px;flex:none}",
    ".ct-filme small{display:block;font-weight:500;color:var(--muted-foreground,#a3a3ad)}",
    ".ct-prov{font-size:12px;color:#f5c26b;line-height:1.35}",
    ".ct-nada{font-size:12px;color:var(--muted-foreground,#a3a3ad);line-height:1.35}",
    ".ct-meta{font-size:12px;color:var(--muted-foreground,#a3a3ad);line-height:1.45}",
    ".ct-leg{font-size:12px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}",
    ".ct-acoes{display:flex;flex-wrap:wrap;gap:6px}",
    ".ct-acoes .ct-btn{flex:1 1 auto;min-width:0;white-space:nowrap}",
    ".ct-acoes .ct-prim{flex:1 1 100%}",
    ".ct-vazio{font-size:13px;color:var(--muted-foreground,#a3a3ad);text-align:center;padding:18px 0}",
    "@media (max-width:560px){.ct-painel{padding:14px}.ct-grade{grid-template-columns:1fr}}",
  ].join("\n");

  function garantirEstilo() {
    if (document.getElementById("cineclip-tendencias-css")) return;
    var st = document.createElement("style");
    st.id = "cineclip-tendencias-css";
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function gravarOpcoes() {
    gravarJson(CHAVE_OPCOES, estado.opcoes);
  }

  function campoTexto(rotulo, chave, ph) {
    var inp = el("input", { type: "text", value: estado.opcoes[chave] || "", placeholder: ph || "" });
    inp.addEventListener("input", function () {
      estado.opcoes[chave] = inp.value;
      gravarOpcoes();
    });
    inp.addEventListener("keydown", function (e) {
      if (e.key === "Enter") buscar(true);
    });
    return el("label", { className: "ct-campo" }, [el("span", { text: rotulo }), inp]);
  }
  function campoSenha(rotulo, chave, ph) {
    var inp = el("input", { type: "password", value: estado.opcoes[chave] || "", placeholder: ph || "", autocomplete: "off" });
    inp.addEventListener("input", function () {
      estado.opcoes[chave] = inp.value;
      gravarOpcoes();
    });
    return el("label", { className: "ct-campo" }, [el("span", { text: rotulo }), inp]);
  }
  function campoLista(rotulo, chave, opcoes) {
    var sel = el("select", {}, opcoes.map(function (o) {
      var opt = el("option", { value: String(o[0]), text: o[1] });
      if (String(estado.opcoes[chave]) === String(o[0])) opt.selected = true;
      return opt;
    }));
    sel.addEventListener("change", function () {
      estado.opcoes[chave] = Number(sel.value);
      gravarOpcoes();
    });
    return el("label", { className: "ct-campo", style: "flex:0 0 auto;min-width:130px" }, [el("span", { text: rotulo }), sel]);
  }

  function cartao(it) {
    var usado = !!estado.usados[it.id];
    var filme = it.filme;
    var temChave = !!chaveTmdb();
    var blocoFilme;
    if (filme) {
      blocoFilme = el("div", { className: "ct-filme" }, [
        filme.poster ? el("img", { src: filme.poster, alt: "" }) : null,
        el("div", {}, [el("div", { text: "🎬 " + filme.titulo }), el("small", { text: (filme.tipo === "tv" ? "Série" : "Filme") + (filme.ano ? " · " + filme.ano : "") + " · confirmado no TMDB" })]),
      ]);
    } else if (it.candidatos && it.candidatos.length && (filme === undefined && temChave)) {
      blocoFilme = el("div", { className: "ct-nada", text: "🔎 A confirmar o nome…" });
    } else if (it.candidatos && it.candidatos.length) {
      blocoFilme = el("div", { className: "ct-prov", text: "Nome provável: " + it.candidatos[0].titulo + (temChave ? " (não confirmado)" : " — põe a chave TMDB para confirmar") });
    } else {
      blocoFilme = el("div", { className: "ct-nada", text: "❔ O nome não aparece na legenda — o CineClip identifica pelo vídeo." });
    }
    var porHora = Math.round(it.views / Math.max(1, (Date.now() - it.criadoEm * 1000) / 3600000));
    return el("li", { className: "ct-card" + (usado ? " usado" : "") }, [
      el("div", { className: "ct-corpo" }, [
        el("div", { className: "ct-capa" }, [it.capa ? el("img", { src: it.capa, alt: "", loading: "lazy", referrerpolicy: "no-referrer" }) : null, el("span", { className: "ct-hype", text: "🔥 " + numeroCurto(porHora) + "/h" })]),
        el("div", { className: "ct-dados" }, [
          blocoFilme,
          el("div", { className: "ct-meta", text: "👁 " + numeroCurto(it.views) + " · ❤ " + numeroCurto(it.curtidas) + " · ↗ " + numeroCurto(it.compartilhamentos) }),
          el("div", { className: "ct-meta", text: "@" + it.autor + " · " + haQuanto(it.criadoEm) + " · " + Math.round(it.duracao) + " s" }),
          el("div", { className: "ct-leg", text: it.legenda || "(sem legenda)" }),
        ]),
      ]),
      el("div", { className: "ct-acoes" }, [
        el("button", { type: "button", className: "ct-btn ct-prim ct-mini", onClick: function () { levar(it, "aqui"); }, text: usado ? "📥 Levar de novo" : "📥 Levar pro CineClip" }),
        el("button", { type: "button", className: "ct-btn ct-sec ct-mini", title: "Processa na nuvem e agenda sozinho (precisa do servidor ligado)", onClick: function () { levar(it, "nuvem"); }, text: "☁️ Nuvem" }),
        el("button", { type: "button", className: "ct-btn ct-sec ct-mini", onClick: function () { copiar(it); }, text: "🔗" }),
        el("a", { className: "ct-btn ct-sec ct-mini", href: it.url, target: "_blank", rel: "noreferrer", text: "↗ TikTok", style: "text-decoration:none" }),
      ]),
    ]);
  }

  function desenhar() {
    if (!raiz) return;
    var o = estado.opcoes;
    raiz.innerHTML = "";

    raiz.appendChild(el("div", { className: "ct-topo" }, [el("h2", { text: "🔥 Tendências do TikTok" }), el("span", { className: "ct-meta", text: estado.geradoEm ? "Atualizado " + haQuanto(estado.geradoEm / 1000) : "" })]));
    raiz.appendChild(el("p", { className: "ct-sub", text: "Os cortes de filmes que mais estão bombando agora, ordenados por visualizações por hora. Escolhe um e leva para o CineClip: ele baixa, identifica o filme, cria o gancho e agenda." }));

    var chips = el("div", { className: "ct-chips" }, SUGESTOES.map(function (s) {
      return el("button", { type: "button", className: "ct-chip", text: "#" + s, onClick: function () {
        var atuais = String(o.tags || "").split(/[,\s]+/).map(function (x) { return x.replace(/^#/, "").toLowerCase(); }).filter(Boolean);
        if (atuais.indexOf(s) < 0) atuais.push(s);
        o.tags = atuais.join(", ");
        gravarOpcoes();
        desenhar();
      } });
    }));
    var esconder = el("input", { type: "checkbox", checked: o.esconderUsados ? true : null });
    esconder.addEventListener("change", function () { o.esconderUsados = esconder.checked; gravarOpcoes(); desenhar(); });
    raiz.appendChild(el("div", { className: "ct-filtros" }, [
      el("div", { className: "ct-linha" }, [campoTexto("Hashtags (separadas por vírgula)", "tags", "cenasdefilme, filmes"), campoTexto("Perfis de cortes (opcional)", "perfis", "@conta1, @conta2")]),
      chips,
      el("div", { className: "ct-linha" }, [
        campoLista("Postados nos últimos", "dias", [[1, "1 dia"], [3, "3 dias"], [7, "7 dias"], [14, "14 dias"], [30, "30 dias"]]),
        campoLista("Mínimo de views", "minViews", [[5000, "5 mil"], [20000, "20 mil"], [50000, "50 mil"], [100000, "100 mil"], [500000, "500 mil"]]),
        el("button", { type: "button", className: "ct-btn ct-prim", disabled: estado.carregando ? true : null, onClick: function () { buscar(true); }, text: estado.carregando ? "A buscar… (pode levar uns 10 s)" : "🔥 Buscar tendências" }),
      ]),
      campoSenha("Token do Apify (opcional, mais estável)", "apifyKey", "apify_api_..."),
      el("p", { className: "ct-meta", style: "margin:0" }, [
        "O serviço grátis do TikTok costuma bloquear servidores. O ",
        el("a", { href: "https://console.apify.com/account/integrations", target: "_blank", rel: "noreferrer", text: "Apify", style: "color:inherit;text-decoration:underline" }),
        " resolve isso: conta grátis com crédito mensal (confere o preço atual lá). O token fica só neste aparelho.",
      ]),
      el("label", { className: "ct-opcao" }, [esconder, el("span", { text: "Esconder os que já levei" })]),
    ]));

    if (estado.erro) raiz.appendChild(el("div", { className: "ct-aviso erro", text: estado.erro }));
    else if (estado.aviso) raiz.appendChild(el("div", { className: "ct-aviso", text: estado.aviso }));

    var itens = estado.itens.filter(function (it) { return !(o.esconderUsados && estado.usados[it.id]); });
    if (!estado.jaBuscou && !estado.carregando && !estado.erro) {
      raiz.appendChild(el("div", { className: "ct-vazio", text: "Carrega em «Buscar tendências» para ver os cortes mais quentes." }));
    } else if (estado.jaBuscou && !itens.length && !estado.aviso) {
      raiz.appendChild(el("div", { className: "ct-vazio", text: "Já levaste todos os da lista. Busca de novo daqui a pouco." }));
    } else if (itens.length) {
      raiz.appendChild(el("ul", { className: "ct-grade" }, itens.map(cartao)));
    }
  }

  /* -------------------------------------------------------------- montar */

  function montar() {
    if (estado.montado) return true;
    if (typeof document === "undefined" || !document.getElementById) return false;
    var alvo = document.getElementById(ID_MONTE);
    if (!alvo) return false;
    garantirEstilo();
    raiz = el("div", { className: "ct-painel" });
    alvo.appendChild(raiz);
    estado.montado = true;
    desenhar();
    // Busca sozinho na primeira vez que a aba fica visível.
    var t = setInterval(function () {
      if (!raiz || !raiz.isConnected) return;
      var dono = document.getElementById(ID_MONTE);
      if (!dono || /hidden/.test(dono.className)) return;
      clearInterval(t);
      if (!estado.jaBuscou && !estado.carregando) buscar(false);
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

  window.CineTendencias = {
    montar: montar,
    buscar: buscar,
    _interno: { estado: estado, desenhar: desenhar, aplicar: aplicar, resolverFilmes: resolverFilmes, levar: levar, consultaDosFiltros: consultaDosFiltros, procurarNoTmdb: procurarNoTmdb },
  };
})();
