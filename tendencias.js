/*
 * 🔥 TENDÊNCIAS & 🎙️ ACHADOS DE FILMES NARRADOS — CineClip
 * ---------------------------------------------------------------------------
 * Painel duplo:
 *   • «🔥 Cortes em alta» — os cortes de filmes mais «hypados» do TikTok agora;
 *   • «🎙️ Filmes Narrados» — painel de achados focado em cortes/resumos de filmes
 *     narrados no TikTok (deteta locução/voz original, termos de resumo/recap,
 *     duração de corte narrado e confirma o nome do filme no TMDB).
 *
 * Download em Alta Qualidade + Upload direto:
 *   • «⬇️ Baixar HD + Upload» descarrega o .mp4 em alta qualidade (1080p/HD sem
 *     marca d'água via /api/public/importar?hd=1), guarda o .mp4 na pasta Downloads
 *     do dispositivo e já abre o «📦 Upload em massa» com o vídeo carregado na fila
 *     (e com a pista do filme confirmado no TMDB).
 *   • Se o stream 1080p master vier em H.265/HEVC num PC cujo navegador não abre
 *     imagem HEVC, o ficheiro 1080p continua salvo nos Downloads e o painel baixa
 *     automaticamente a versão H.264 em HD para o Upload em massa nunca travar.
 *
 * Código legível de propósito (o resto do app vive num bundle compilado). A aba é um
 * <div id="cc-tendencias-monte"> criado pelo bundle (patches 64 e 66).
 *
 * API pública:
 *   window.CineTendencias.montar() · .buscar(forcar?) · .abrirModo(modo)
 *   window.CineTendencias.baixarParaUpload(itens, opcoes?) · ._interno
 */
(function () {
  "use strict";

  if (window.CineTendencias) return;

  var ID_MONTE = "cc-tendencias-monte";
  var CHAVE_MODO = "cineclip.tendencias.modo";
  var CHAVE_OPCOES = "cineclip.tendencias.opcoes";
  var CHAVE_OPCOES_NARRADOS = "cineclip.tendencias.narrados.opcoes";
  var CHAVE_USADOS = "cineclip.tendencias.usados";
  var CHAVE_BAIXADOS = "cineclip.tendencias.baixados";
  var CHAVE_FILMES = "cineclip.tendencias.filmes";
  var CHAVE_RESULTADO = "cineclip.tendencias.resultado.v3";
  var CHAVE_RESULTADO_NARRADOS = "cineclip.tendencias.narrados.resultado.v3";
  var VALIDADE_RESULTADO_MS = 10 * 60 * 1000;

  var SUGESTOES_CORTES = ["cenasdefilme", "filmes", "movieclips", "cortesdefilmes", "melhorescenas", "seriesetv"];
  var SUGESTOES_NARRADOS_TAGS = [
    "filmesnarrados",
    "resumodefilmes",
    "filmenarrado",
    "cortesdefilmesnarrados",
    "explicandofilmes",
    "recapfilmes",
    "historiadefilmes",
    "cenasnarradas",
  ];
  var SUGESTOES_NARRADOS_TERMOS = [
    "filme narrado",
    "resumo de filme",
    "cortes de filmes narrados",
    "final explicado",
    "historia completa do filme",
  ];

  var MAX_DOWNLOADS_SIMULTANEOS = 6;
  var DOWNLOADS_SIMULTANEOS_OMISSAO = 4;

  var OPCOES_OMISSAO = {
    tags: "cenasdefilme, filmes, movieclips",
    perfis: "",
    dias: 7,
    minViews: 20000,
    esconderUsados: true,
    salvarNoDispositivo: true,
    iniciarAutomatico: false,
    downloadsSimultaneos: DOWNLOADS_SIMULTANEOS_OMISSAO,
  };

  var OPCOES_NARRADOS_OMISSAO = {
    tags: "filmesnarrados, resumodefilmes, filmenarrado",
    termos: "filme narrado, resumo de filme",
    perfis: "",
    dias: 14,
    minViews: 20000,
    minDuracao: 25,
    apenasNarrados: true,
    esconderUsados: true,
    salvarNoDispositivo: true,
    iniciarAutomatico: false,
    downloadsSimultaneos: DOWNLOADS_SIMULTANEOS_OMISSAO,
  };

  function lerModoInicial() {
    try {
      var m = localStorage.getItem(CHAVE_MODO);
      if (m === "narrados" || m === "cortes") return m;
    } catch (e) {}
    return "cortes";
  }

  var estado = {
    modo: lerModoInicial(),
    opcoes: lerJson(CHAVE_OPCOES, OPCOES_OMISSAO),
    opcoesNarrados: lerJson(CHAVE_OPCOES_NARRADOS, OPCOES_NARRADOS_OMISSAO),
    itens: [],
    estados: [],
    geradoEm: 0,
    carregando: false,
    erro: "",
    aviso: "",
    usados: lerJson(CHAVE_USADOS, {}),
    baixados: lerJson(CHAVE_BAIXADOS, {}),
    filmes: lerJson(CHAVE_FILMES, {}),
    selecionados: {},
    baixando: {},
    aBaixarLote: false,
    montado: false,
    jaBuscou: false,
    jaBuscouPorModo: { cortes: false, narrados: false },
  };
  if ("apifyKey" in estado.opcoes) {
    delete estado.opcoes.apifyKey;
    gravarJson(CHAVE_OPCOES, estado.opcoes);
  }
  var raiz = null;

  /* -------------------------------------------------- ambiente substituível */

  var ambiente = {
    salvarLocal: salvarArquivoLocalPadrao,
    podeDecodificar: podeDecodificarNoNavegador,
  };

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
    if (n == null) return "—";
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "").replace(".", ",") + " mi";
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, "").replace(".", ",") + " mil";
    return String(n);
  }
  function bytesLegiveis(bytes) {
    var b = Number(bytes) || 0;
    if (b <= 0) return "";
    if (b < 1024 * 1024) return Math.max(1, Math.round(b / 1024)) + " KB";
    return (b / (1024 * 1024)).toFixed(1).replace(/\.0$/, "").replace(".", ",") + " MB";
  }
  function duracaoCurta(seg) {
    if (seg == null) return "duração não informada";
    var s = Math.max(0, Math.round(Number(seg) || 0));
    if (s < 60) return s + " s";
    var m = Math.floor(s / 60);
    var r = s % 60;
    return m + ":" + (r < 10 ? "0" : "") + r + " (" + s + " s)";
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
  function opcoesAtuais() {
    return estado.modo === "narrados" ? estado.opcoesNarrados : estado.opcoes;
  }
  function chaveResultadoAtual() {
    return estado.modo === "narrados" ? CHAVE_RESULTADO_NARRADOS : CHAVE_RESULTADO;
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
    var ehNarrados = estado.modo === "narrados";
    var o = opcoesAtuais();
    var q = new URLSearchParams();
    if (ehNarrados) q.set("modo", "narrados");
    if (String(o.tags || "").trim()) q.set("tags", o.tags);
    if (ehNarrados && String(o.termos || "").trim()) q.set("termos", o.termos);
    if (String(o.perfis || "").trim()) q.set("perfis", o.perfis);
    q.set("dias", String(o.dias || (ehNarrados ? 14 : 7)));
    q.set("min", String(o.minViews != null ? o.minViews : 20000));
    if (ehNarrados) {
      q.set("minDur", String(o.minDuracao || 25));
      q.set("narrados", o.apenasNarrados === false ? "0" : "1");
    }
    q.set("max", "40");
    return q.toString();
  }

  var buscaAtual = 0;
  var controleBusca = null;

  async function buscar(forcar) {
    if (estado.carregando) return;
    var ehNarrados = estado.modo === "narrados";
    var o = opcoesAtuais();
    var temFonte =
      !!String(o.tags || "").trim() ||
      !!String(o.perfis || "").trim() ||
      (ehNarrados && !!String(o.termos || "").trim());
    if (!temFonte) {
      estado.erro = ehNarrados
        ? "Escreve pelo menos uma hashtag, um termo de busca ou um perfil."
        : "Escreve pelo menos uma hashtag ou um perfil.";
      desenhar();
      return;
    }
    var q = consultaDosFiltros();
    var chaveCache = chaveResultadoAtual();
    if (!forcar) {
      var guardado = lerJson(chaveCache, {});
      if (guardado.q === q && guardado.dados && Date.now() - guardado.t < VALIDADE_RESULTADO_MS) {
        aplicar(guardado.dados);
        return;
      }
    }
    var numeroBusca = ++buscaAtual;
    var modoBusca = estado.modo;
    controleBusca = new AbortController();
    var controle = controleBusca;
    estado.carregando = true;
    estado.erro = "";
    estado.aviso = "";
    desenhar();
    try {
      var r = await fetch(
        "/api/public/tendencias?" + q + (forcar ? "&fresco=1" : ""),
        { signal: controle.signal }
      );
      if (!r.ok) {
        var msg = "";
        try {
          msg = (await r.json()).error || "";
        } catch (e) {}
        if (r.status === 404 && !msg) msg = "As tendências só funcionam no site publicado na Vercel (ou com o servidor local ativo).";
        throw new Error(msg || "O servidor respondeu " + r.status + ".");
      }
      var dados = await r.json();
      if (numeroBusca !== buscaAtual || modoBusca !== estado.modo) return;
      // Falhas de fontes não devem bloquear novas tentativas por dez minutos.
      if (dados.itens && dados.itens.length) gravarJson(chaveCache, { q: q, t: Date.now(), dados: dados });
      aplicar(dados);
    } catch (e) {
      if (numeroBusca !== buscaAtual) return;
      estado.erro = e && e.message ? e.message : "Não consegui buscar os vídeos.";
    } finally {
      if (numeroBusca === buscaAtual) {
        controleBusca = null;
        estado.carregando = false;
        desenhar();
      }
    }
    resolverFilmes();
  }

  function aplicar(dados) {
    estado.itens = Array.isArray(dados.itens) ? dados.itens : [];
    estado.estados = Array.isArray(dados.estados) ? dados.estados : [];
    estado.geradoEm = dados.geradoEm || Date.now();
    estado.jaBuscou = true;
    estado.jaBuscouPorModo[estado.modo] = true;
    estado.selecionados = {};
    var falhas = estado.estados.filter(function (e) { return !e.ok; });
    if (!estado.itens.length) {
      estado.aviso = falhas.length === estado.estados.length && falhas.length
        ? "Nenhuma fonte respondeu (" + falhas[0].erro + ")." + " Tente novamente ou indique perfis públicos de filmes. Nenhum token é necessário."
        : estado.modo === "narrados"
        ? "Nenhum corte narrado passou nos filtros. Experimenta baixar o mínimo de views, aumentar os dias ou desmarcar «Só com sinais de narração»."
        : "Nada passou nos filtros. Baixa o mínimo de visualizações ou aumenta os dias.";
    } else if (falhas.length) {
      estado.aviso = "Mostrando vídeos das fontes disponíveis. " + falhas.length + " fonte(s) não respondeu(ram); veja os detalhes em Fontes da busca.";
    }
    desenhar();
    resolverFilmes();
  }

  function alternarModo(novoModo) {
    var m = novoModo === "narrados" ? "narrados" : "cortes";
    if (estado.modo === m && estado.montado) return;
    // Invalida a resposta antiga mesmo quando o transporte ignora o cancelamento.
    buscaAtual++;
    if (controleBusca) controleBusca.abort();
    controleBusca = null;
    estado.carregando = false;
    estado.modo = m;
    try {
      localStorage.setItem(CHAVE_MODO, m);
    } catch (e) {}
    estado.erro = "";
    estado.aviso = "";
    estado.selecionados = {};
    // Restaura cache imediato se existir para este modo, ou busca automaticamente.
    var q = consultaDosFiltros();
    var guardado = lerJson(chaveResultadoAtual(), {});
    if (guardado.q === q && guardado.dados && Date.now() - guardado.t < VALIDADE_RESULTADO_MS) {
      aplicar(guardado.dados);
      return;
    }
    estado.itens = [];
    estado.estados = [];
    estado.geradoEm = 0;
    estado.jaBuscou = !!estado.jaBuscouPorModo[m];
    desenhar();
    if (!estado.carregando) buscar(false);
  }

  function abrirModo(modo) {
    // Se estivermos noutra aba do app (ex.: Estúdio ou Upload em massa), clica no botão da aba Tendências.
    try {
      var botoes = document.querySelectorAll("button");
      for (var i = 0; i < botoes.length; i++) {
        if (/Tendências/.test(botoes[i].textContent || "")) {
          botoes[i].click();
          break;
        }
      }
    } catch (e) {}
    montar();
    var alvo = modo === "narrados" ? "narrados" : "cortes";
    if (estado.modo !== alvo) {
      alternarModo(alvo);
    } else if (!estado.jaBuscouPorModo[alvo] && !estado.carregando) {
      buscar(false);
    } else {
      desenhar();
    }
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
      var itensDaBusca = estado.itens;
      var fila = itensDaBusca.slice();
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
      if (estado.itens !== itensDaBusca) resolverFilmes();
    }
  }

  /* ------------------------------------- download HD + salvar + upload */

  function limparTrechoNome(s, max) {
    return String(s || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\w-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase()
      .slice(0, max || 40);
  }

  function nomeArquivoHd(item, nomeServidor) {
    var partes = [];
    if (item && item.filme && item.filme.titulo) {
      partes.push(limparTrechoNome(item.filme.titulo, 36));
      if (item.filme.ano) partes.push(limparTrechoNome(item.filme.ano, 6));
    } else if (item && item.candidatos && item.candidatos[0] && item.candidatos[0].titulo) {
      partes.push(limparTrechoNome(item.candidatos[0].titulo, 32));
    }
    if (item && item.autor) partes.push(limparTrechoNome(item.autor, 24));
    if (item && item.id) partes.push(limparTrechoNome(item.id, 24));
    var base = partes.filter(Boolean).join("_");
    if (!base && nomeServidor) return String(nomeServidor).replace(/\.mp4$/i, "") + "_hd.mp4";
    return (base || "tiktok_corte") + "_hd.mp4";
  }

  function pistaDoItem(item) {
    if (!item) return "";
    if (item.filme && item.filme.titulo) {
      return item.filme.titulo + (item.filme.ano ? " (" + item.filme.ano + ")" : "");
    }
    if (item.candidatos && item.candidatos.length && item.candidatos[0].titulo) {
      return item.candidatos[0].titulo;
    }
    return String(item.legenda || "").trim().slice(0, 140);
  }

  function salvarArquivoLocalPadrao(ficheiro) {
    try {
      if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return false;
      var blobUrl = URL.createObjectURL(ficheiro);
      var a = document.createElement("a");
      a.href = blobUrl;
      a.download = ficheiro.name || "corte_hd.mp4";
      a.rel = "noopener";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        try {
          if (a.parentNode) a.parentNode.removeChild(a);
        } catch (e) {}
        try {
          URL.revokeObjectURL(blobUrl);
        } catch (e) {}
      }, 2000);
      return true;
    } catch (e) {
      return false;
    }
  }

  function podeDecodificarNoNavegador(ficheiro) {
    return new Promise(function (resolve) {
      try {
        if (typeof navigator !== "undefined" && /jsdom/i.test(String(navigator.userAgent || ""))) {
          resolve(true);
          return;
        }
        if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
          resolve(true);
          return;
        }
        var url = URL.createObjectURL(ficheiro);
        var v = document.createElement("video");
        var pronto = false;
        var concluir = function (ok) {
          if (pronto) return;
          pronto = true;
          clearTimeout(timer);
          try {
            v.removeAttribute("src");
            v.load();
          } catch (e) {}
          try {
            URL.revokeObjectURL(url);
          } catch (e) {}
          resolve(ok);
        };
        var timer = setTimeout(function () {
          concluir(true);
        }, 4000);
        v.preload = "metadata";
        v.muted = true;
        v.playsInline = true;
        v.onloadedmetadata = function () {
          concluir((v.videoWidth || 0) > 0 && (v.videoHeight || 0) > 0);
        };
        v.onerror = function () {
          concluir(false);
        };
        v.src = url;
        try {
          v.load();
        } catch (e) {}
      } catch (e) {
        resolve(true);
      }
    });
  }

  async function requisitarImportacao(urlTikTok, queryExtra, aoProgresso) {
    var urlApi = "/api/public/importar?url=" + encodeURIComponent(urlTikTok) + (queryExtra || "");
    var r;
    try {
      r = await fetch(urlApi);
    } catch (e) {
      throw new Error("Sem ligação ao servidor de download do CineClip.");
    }
    if (!r.ok) {
      var msg = "";
      try {
        msg = ((await r.json()) || {}).error || "";
      } catch (e) {}
      if (r.status === 404 && !msg) msg = "O download direto precisa do servidor ativo (Vercel ou servidor local).";
      throw new Error(msg || "O servidor recusou o download (HTTP " + r.status + ").");
    }

    var lerCab = function (nome) {
      try {
        var val = r.headers && typeof r.headers.get === "function" ? r.headers.get(nome) : "";
        return decodeURIComponent(val || "");
      } catch (e) {
        return (r.headers && typeof r.headers.get === "function" && r.headers.get(nome)) || "";
      }
    };

    var total = Number(lerCab("content-length") || lerCab("X-Cineclip-Tamanho")) || 0;
    var partes = [];
    var recebidos = 0;

    if (r.body && typeof r.body.getReader === "function") {
      var leitor = r.body.getReader();
      for (;;) {
        var passo = await leitor.read();
        if (passo.done) break;
        partes.push(passo.value);
        recebidos += passo.value.length || passo.value.byteLength || 0;
        if (aoProgresso) aoProgresso(recebidos, total);
      }
    } else if (typeof r.arrayBuffer === "function") {
      var buf = new Uint8Array(await r.arrayBuffer());
      partes.push(buf);
      recebidos = buf.byteLength;
      if (aoProgresso) aoProgresso(recebidos, total || recebidos);
    }

    if (!recebidos) throw new Error("O vídeo veio vazio do servidor.");

    return {
      partes: partes,
      bytes: recebidos,
      nomeServidor: lerCab("X-Cineclip-Nome"),
      codec: lerCab("X-Cineclip-Codec") || "?",
      qualidade: lerCab("X-Cineclip-Qualidade") || "hd",
      tituloServidor: lerCab("X-Cineclip-Titulo"),
    };
  }

  /**
   * Quantos downloads HD correm ao mesmo tempo. Um corte narrado em 1080p são
   * dezenas de MB: em fila indiana, 17 cortes deixam a barra parada muito tempo
   * e a ligação subaproveitada. Em paralelo o tempo total cai para perto do
   * maior download de cada ronda, sem estourar a memória (cada ficheiro fica
   * inteiro em RAM até ir para o Upload em massa) nem levar bloqueio do CDN.
   */
  function limiteSimultaneos(total) {
    var o = opcoesAtuais();
    var pedido = Number(o && o.downloadsSimultaneos);
    if (!(pedido >= 1)) pedido = DOWNLOADS_SIMULTANEOS_OMISSAO;
    return Math.max(1, Math.min(MAX_DOWNLOADS_SIMULTANEOS, Math.round(pedido), total));
  }

  /**
   * Corre `tarefa(item, idx)` sobre a lista com no máximo `limite` em voo.
   * Cada corredor puxa o próximo índice livre, por isso um download lento não
   * segura os seguintes. `tarefa` trata os seus próprios erros (aqui, cada
   * falha fica no slot do item), logo não há promessa rejeitada à solta.
   */
  function emParalelo(lista, limite, tarefa) {
    var proximo = 0;
    function corredor() {
      if (proximo >= lista.length) return Promise.resolve();
      var meu = proximo++;
      return Promise.resolve(tarefa(lista[meu], meu)).then(corredor);
    }
    var corredores = [];
    for (var i = 0; i < limite; i++) corredores.push(corredor());
    return Promise.all(corredores);
  }

  function atualizarProgressoDOM(id) {
    if (!raiz) return;
    var info = estado.baixando[id];
    var caixa = raiz.querySelector('[data-progresso-id="' + id + '"]');
    if (!caixa) return;
    if (!info) {
      caixa.style.display = "none";
      return;
    }
    caixa.style.display = "flex";
    var txt = caixa.querySelector(".ct-prog-txt");
    var barra = caixa.querySelector(".ct-prog-enchimento");
    if (txt) txt.textContent = info.texto || "A baixar…";
    if (barra) barra.style.width = Math.max(6, Math.min(100, Math.round(info.pct || 0))) + "%";
  }

  /**
   * Baixa 1 ou mais vídeos em alta qualidade (HD sem marca d'água), salva o .mp4
   * no dispositivo (quando ativo) e já envia para o 📦 Upload em massa!
   */
  async function baixarParaUpload(entradaItens, opcoesAcao) {
    var lista = Array.isArray(entradaItens) ? entradaItens.filter(Boolean) : entradaItens ? [entradaItens] : [];
    if (!lista.length) return [];
    var acao = opcoesAcao || {};
    var soBaixar = !!acao.soBaixar;
    var o = opcoesAtuais();
    var deveSalvarNoDispositivo = soBaixar ? true : acao.salvarNoDispositivo != null ? !!acao.salvarNoDispositivo : o.salvarNoDispositivo !== false;
    var deveIniciarAuto = !soBaixar && (acao.iniciarAutomatico != null ? !!acao.iniciarAutomatico : !!o.iniciarAutomatico);

    if (!soBaixar) {
      var lote = window.CineLote;
      if (!lote || (typeof lote.receberVideos !== "function" && typeof lote.abrir !== "function")) {
        estado.erro = "O módulo de Upload em massa ainda está a carregar. Tenta de novo.";
        desenhar();
        return [];
      }
    }

    estado.erro = "";
    estado.aviso =
      lista.length === 1
        ? "⬇️ A baixar o vídeo em alta qualidade (HD)…"
        : "⬇️ A baixar " +
          lista.length +
          " vídeos em alta qualidade (HD), " +
          limiteSimultaneos(lista.length) +
          " ao mesmo tempo…";
    if (lista.length > 1) estado.aBaixarLote = true;
    lista.forEach(function (it) {
      estado.baixando[it.id] = { texto: "⬇️ A conectar ao CDN em HD…", pct: 8 };
    });
    desenhar();

    var ficheirosParaUpload = [];
    var falhasDownload = [];
    var qualidadesObtidas = [];
    var salvosLocal = 0;

    /* Os resultados vão para slots por índice, não com push: os downloads
       terminam fora de ordem e a fila do Upload em massa (e as mensagens) têm
       de sair na ordem em que os cartões foram selecionados. */
    var slotsUpload = new Array(lista.length);
    var slotsQualidade = new Array(lista.length);
    var slotsFalha = new Array(lista.length);

    async function baixarUm(item, idx) {
      try {
        var resHd = await requisitarImportacao(item.url, "&hd=1", function (rec, tot) {
          var pct = tot > 0 ? Math.round((rec / tot) * 100) : 55;
          estado.baixando[item.id] = {
            texto:
              "⬇️ Baixando HD… " +
              (tot > 0 ? pct + "% (" + bytesLegiveis(rec) + ")" : bytesLegiveis(rec)),
            pct: pct,
          };
          atualizarProgressoDOM(item.id);
        });

        var nomeFinal = nomeArquivoHd(item, resHd.nomeServidor);
        var ficheiroHd = new File(resHd.partes, nomeFinal, { type: "video/mp4" });
        var pista = pistaDoItem(item) || resHd.tituloServidor || "";
        ficheiroHd._origemLink = item.url;
        if (pista) ficheiroHd.pistaLink = pista;

        // 1) Salva o .mp4 em alta qualidade (master HD) no dispositivo do utilizador
        if (deveSalvarNoDispositivo) {
          if (ambiente.salvarLocal(ficheiroHd)) salvosLocal++;
        }

        // 2) Se também vai para o Upload em massa, garante que o navegador decodifica os frames
        var ficheiroUpload = ficheiroHd;
        if (!soBaixar && resHd.codec !== "h264") {
          estado.baixando[item.id] = { texto: "🔎 A validar codec de vídeo…", pct: 95 };
          atualizarProgressoDOM(item.id);
          var compativel = await ambiente.podeDecodificar(ficheiroHd);
          if (!compativel) {
            estado.baixando[item.id] = { texto: "🔄 A obter versão H.264 compatível para o Upload…", pct: 97 };
            atualizarProgressoDOM(item.id);
            try {
              var resH264 = await requisitarImportacao(item.url, "&hd=1&codec=h264");
              ficheiroUpload = new File(resH264.partes, nomeFinal.replace(/_hd\.mp4$/i, "_h264.mp4"), { type: "video/mp4" });
              ficheiroUpload._origemLink = item.url;
              if (pista) ficheiroUpload.pistaLink = pista;
            } catch (eFallback) {
              // Mantém o ficheiro original caso o fallback falhe
              ficheiroUpload = ficheiroHd;
            }
          }
        }

        delete estado.baixando[item.id];
        delete estado.selecionados[item.id];
        marcarUsado(item);
        estado.baixados[item.id] = {
          em: Date.now(),
          qualidade: resHd.qualidade || "hd",
          bytes: ficheiroHd.size,
        };
        gravarJson(CHAVE_BAIXADOS, estado.baixados);
        slotsQualidade[idx] = (resHd.qualidade || "HD").toUpperCase() + " · " + bytesLegiveis(ficheiroHd.size);
        if (!soBaixar) slotsUpload[idx] = ficheiroUpload;
      } catch (e) {
        delete estado.baixando[item.id];
        slotsFalha[idx] = (item.autor ? "@" + item.autor : item.id) + ": " + (e && e.message ? e.message : "falhou");
      }
      desenhar();
    }

    await emParalelo(lista, limiteSimultaneos(lista.length), baixarUm);

    for (var s = 0; s < lista.length; s++) {
      if (slotsUpload[s]) ficheirosParaUpload.push(slotsUpload[s]);
      if (slotsQualidade[s]) qualidadesObtidas.push(slotsQualidade[s]);
      if (slotsFalha[s]) falhasDownload.push(slotsFalha[s]);
    }

    estado.aBaixarLote = false;

    if (ficheirosParaUpload.length && !soBaixar) {
      var modLote = window.CineLote;
      if (modLote && typeof modLote.receberVideos === "function") {
        modLote.receberVideos(ficheirosParaUpload, { iniciar: deveIniciarAuto });
      } else if (modLote && typeof modLote.abrir === "function") {
        modLote.abrir(ficheirosParaUpload);
      }
    }

    if (falhasDownload.length && !ficheirosParaUpload.length && !salvosLocal) {
      estado.aviso = "";
      estado.erro = "Não consegui baixar em HD: " + falhasDownload.join(" · ");
    } else {
      var resumoQual = qualidadesObtidas.length === 1 ? " (" + qualidadesObtidas[0] + ")" : "";
      if (soBaixar) {
        estado.aviso = "✅ Vídeo baixado em alta qualidade" + resumoQual + " na pasta Downloads.";
      } else {
        estado.aviso =
          "✅ " +
          (ficheirosParaUpload.length === 1
            ? "Vídeo baixado em alta qualidade" + resumoQual
            : ficheirosParaUpload.length + " vídeos baixados em alta qualidade") +
          (deveSalvarNoDispositivo ? ", salvo" + (ficheirosParaUpload.length > 1 ? "s" : "") + " nos Downloads" : "") +
          " e já carregado" +
          (ficheirosParaUpload.length > 1 ? "s" : "") +
          " no 📦 Upload em massa!" +
          (falhasDownload.length ? " (Falharam: " + falhasDownload.join(", ") + ")" : "");
      }
    }
    desenhar();
    return ficheirosParaUpload;
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
    ".ct-abas{display:flex;flex-wrap:wrap;gap:8px;padding:5px;border-radius:12px;background:var(--background,#141418);border:1px solid var(--border,rgba(255,255,255,.09))}",
    ".ct-aba{flex:1 1 200px;display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:9px 14px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--muted-foreground,#a3a3ad);font:600 13px inherit;cursor:pointer;transition:background .15s,color .15s,border-color .15s}",
    ".ct-aba:hover{color:var(--foreground,#f4f4f6);background:rgba(255,255,255,.04)}",
    ".ct-aba.ativa{background:var(--primary,#e5484d);color:#fff;box-shadow:0 2px 10px rgba(229,72,77,.25)}",
    ".ct-aba-selo{font-size:10px;font-weight:700;padding:2px 6px;border-radius:999px;background:rgba(255,255,255,.16);color:inherit}",
    ".ct-topo{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px}",
    ".ct-topo h2{margin:0;font-size:18px;font-weight:700}",
    ".ct-sub{margin:0;font-size:13px;line-height:1.55;color:var(--muted-foreground,#a3a3ad)}",
    ".ct-filtros{display:grid;gap:10px;padding:12px;border:1px solid var(--border,rgba(255,255,255,.09));border-radius:12px}",
    ".ct-linha{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end}",
    ".ct-campo{display:flex;flex-direction:column;gap:4px;flex:1;min-width:150px;font-size:12px;color:var(--muted-foreground,#a3a3ad)}",
    ".ct-campo input,.ct-campo select{border-radius:8px;border:1px solid var(--border,rgba(255,255,255,.15));background:var(--background,#141418);color:var(--foreground,#f4f4f6);padding:8px 10px;font:13px inherit}",
    ".ct-campo input:focus,.ct-campo select:focus{outline:2px solid var(--primary,#e5484d);outline-offset:1px}",
    ".ct-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center}",
    ".ct-chips-rotulo{font-size:11px;color:var(--muted-foreground,#a3a3ad);margin-right:2px}",
    ".ct-chip{font-size:12px;padding:3px 10px;border-radius:999px;border:1px solid var(--border,rgba(255,255,255,.15));background:transparent;color:inherit;cursor:pointer}",
    ".ct-chip:hover{background:var(--muted,#2a2a31)}",
    ".ct-chip.termo{border-style:dashed;border-color:rgba(16,185,129,.45);color:#6ee7b7}",
    ".ct-opcoes-grade{display:flex;flex-wrap:wrap;gap:10px 18px;padding-top:2px}",
    ".ct-opcao{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted-foreground,#a3a3ad);cursor:pointer}",
    ".ct-opcao input{accent-color:var(--primary,#e5484d)}",
    ".ct-barra-lote{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;padding:10px 14px;border-radius:12px;border:1px solid rgba(16,185,129,.45);background:rgba(16,185,129,.1)}",
    ".ct-barra-lote strong{font-size:13px;color:#a7f3d0}",
    ".ct-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border-radius:8px;padding:9px 16px;font-size:14px;font-weight:600;cursor:pointer;border:1px solid transparent;font-family:inherit}",
    ".ct-btn[disabled]{opacity:.55;cursor:not-allowed}",
    ".ct-prim{background:var(--primary,#e5484d);color:#fff}",
    ".ct-hd-btn{background:linear-gradient(135deg,#059669,#10b981);color:#fff;box-shadow:0 2px 8px rgba(16,185,129,.22)}",
    ".ct-hd-btn:hover:not([disabled]){filter:brightness(1.06)}",
    ".ct-sec{background:transparent;color:inherit;border-color:var(--border,rgba(255,255,255,.15))}",
    ".ct-sec:hover:not([disabled]){background:var(--muted,#2a2a31)}",
    ".ct-mini{padding:6px 10px;font-size:12px;font-weight:600}",
    ".ct-aviso{font-size:13px;line-height:1.45;padding:10px 12px;border-radius:10px;border:1px solid var(--border,rgba(255,255,255,.1))}",
    ".ct-aviso.erro{border-color:rgba(229,72,77,.5);background:rgba(229,72,77,.1);color:#ffb3b5}",
    ".ct-grade{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(265px,1fr));gap:12px}",
    ".ct-card{display:flex;flex-direction:column;gap:8px;border:1px solid var(--border,rgba(255,255,255,.09));border-radius:12px;padding:10px;background:var(--background,#141418);transition:border-color .15s}",
    ".ct-card.selecionado{border-color:#10b981;box-shadow:0 0 0 1px rgba(16,185,129,.35)}",
    ".ct-card.usado{opacity:.58}",
    ".ct-corpo{display:flex;gap:10px;align-items:flex-start}",
    ".ct-capa{position:relative;width:88px;aspect-ratio:9/16;border-radius:8px;overflow:hidden;flex:none;background:var(--muted,#2a2a31)}",
    ".ct-capa img{width:100%;height:100%;object-fit:cover;display:block}",
    ".ct-sel{position:absolute;top:5px;left:5px;width:20px;height:20px;border-radius:6px;background:rgba(0,0,0,.68);display:flex;align-items:center;justify-content:center;cursor:pointer}",
    ".ct-sel input{margin:0;cursor:pointer;accent-color:#10b981}",
    ".ct-selo-hd{position:absolute;top:5px;right:5px;font-size:9px;font-weight:800;letter-spacing:.02em;padding:2px 5px;border-radius:5px;background:rgba(5,150,105,.9);color:#fff}",
    ".ct-hype{position:absolute;left:4px;bottom:4px;font-size:10px;font-weight:700;padding:2px 6px;border-radius:999px;background:rgba(0,0,0,.76);color:#ffb347}",
    ".ct-dados{flex:1;min-width:0;display:flex;flex-direction:column;gap:5px}",
    ".ct-filme{display:flex;gap:8px;align-items:center;font-size:13px;font-weight:700;line-height:1.3}",
    ".ct-filme img{width:28px;height:42px;object-fit:cover;border-radius:4px;flex:none}",
    ".ct-filme small{display:block;font-weight:500;color:var(--muted-foreground,#a3a3ad)}",
    ".ct-sinais{display:flex;flex-wrap:wrap;gap:4px}",
    ".ct-sinal{font-size:10px;font-weight:600;padding:2px 7px;border-radius:999px;background:rgba(16,185,129,.13);color:#6ee7b7;border:1px solid rgba(16,185,129,.28)}",
    ".ct-prov{font-size:12px;color:#f5c26b;line-height:1.35}",
    ".ct-nada{font-size:12px;color:var(--muted-foreground,#a3a3ad);line-height:1.35}",
    ".ct-meta{font-size:12px;color:var(--muted-foreground,#a3a3ad);line-height:1.45}",
    ".ct-leg{font-size:12px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}",
    ".ct-prog{display:none;flex-direction:column;gap:4px;padding:6px 8px;border-radius:8px;background:rgba(16,185,129,.09);border:1px solid rgba(16,185,129,.28)}",
    ".ct-prog-txt{font-size:11px;font-weight:600;color:#6ee7b7}",
    ".ct-prog-trilho{height:5px;border-radius:999px;background:rgba(255,255,255,.1);overflow:hidden}",
    ".ct-prog-enchimento{height:100%;width:12%;background:#10b981;transition:width .18s ease}",
    ".ct-acoes{display:flex;flex-wrap:wrap;gap:6px}",
    ".ct-acoes .ct-btn{flex:1 1 auto;min-width:0;white-space:nowrap}",
    ".ct-acoes .ct-destaque{flex:1 1 100%}",
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
    gravarJson(CHAVE_OPCOES_NARRADOS, estado.opcoesNarrados);
  }

  function campoTextoDe(alvo, rotulo, chave, ph) {
    var inp = el("input", { type: "text", value: alvo[chave] || "", placeholder: ph || "" });
    inp.addEventListener("input", function () {
      alvo[chave] = inp.value;
      gravarOpcoes();
    });
    inp.addEventListener("keydown", function (e) {
      if (e.key === "Enter") buscar(true);
    });
    return el("label", { className: "ct-campo" }, [el("span", { text: rotulo }), inp]);
  }
  function campoListaDe(alvo, rotulo, chave, opcoes) {
    var sel = el("select", {}, opcoes.map(function (o) {
      var opt = el("option", { value: String(o[0]), text: o[1] });
      if (String(alvo[chave]) === String(o[0])) opt.selected = true;
      return opt;
    }));
    sel.addEventListener("change", function () {
      alvo[chave] = Number(sel.value);
      gravarOpcoes();
    });
    return el("label", { className: "ct-campo", style: "flex:0 0 auto;min-width:130px" }, [el("span", { text: rotulo }), sel]);
  }

  function cartao(it) {
    var usado = !!estado.usados[it.id];
    var jaBaixou = estado.baixados[it.id];
    var prog = estado.baixando[it.id];
    var selecionado = !!estado.selecionados[it.id];
    var filme = it.filme;
    var temChave = !!chaveTmdb();
    var blocoFilme;
    if (filme) {
      blocoFilme = el("div", { className: "ct-filme" }, [
        filme.poster ? el("img", { src: filme.poster, alt: "" }) : null,
        el("div", {}, [
          el("div", { text: "🎬 " + filme.titulo }),
          el("small", { text: (filme.tipo === "tv" ? "Série" : "Filme") + (filme.ano ? " · " + filme.ano : "") + " · título da legenda encontrado no TMDB" }),
        ]),
      ]);
    } else if (it.candidatos && it.candidatos.length && (filme === undefined && temChave)) {
      blocoFilme = el("div", { className: "ct-nada", text: "🔎 A confirmar o nome…" });
    } else if (it.candidatos && it.candidatos.length) {
      blocoFilme = el("div", { className: "ct-prov", text: "Nome provável: " + it.candidatos[0].titulo + (temChave ? " (não confirmado)" : " — põe a chave TMDB para confirmar") });
    } else {
      blocoFilme = el("div", { className: "ct-nada", text: "❔ O nome não aparece na legenda. Importe o vídeo para tentar identificar o filme." });
    }

    var sinais = Array.isArray(it.sinaisNarrado) ? it.sinaisNarrado : [];
    var blocoSinais = sinais.length
      ? el("div", { className: "ct-sinais" }, sinais.slice(0, 4).map(function (s) { return el("span", { className: "ct-sinal", text: s }); }))
      : null;

    var porHora = Math.round(it.views / Math.max(1, (Date.now() - it.criadoEm * 1000) / 3600000));
    var seloHdTexto = jaBaixou
      ? "✓ " + String(jaBaixou.qualidade || "HD").toUpperCase()
      : it.temHd
      ? "HD" + (it.tamanhoBytes ? " · " + bytesLegiveis(it.tamanhoBytes) : "")
      : "Qualidade a verificar";

    var chkSel = el("input", {
      type: "checkbox",
      checked: selecionado ? true : null,
      title: "Selecionar para baixar vários em HD de uma vez",
      "aria-label": "Selecionar vídeo de @" + it.autor,
    });
    chkSel.addEventListener("change", function () {
      if (chkSel.checked) estado.selecionados[it.id] = true;
      else delete estado.selecionados[it.id];
      desenhar();
    });

    var ocupado = !!prog || estado.aBaixarLote;

    return el("li", { className: "ct-card" + (usado ? " usado" : "") + (selecionado ? " selecionado" : "") }, [
      el("div", { className: "ct-corpo" }, [
        el("div", { className: "ct-capa" }, [
          it.capa ? el("img", { src: it.capa, alt: "", loading: "lazy", referrerpolicy: "no-referrer" }) : null,
          el("label", { className: "ct-sel", onClick: function (e) { e.stopPropagation(); } }, [chkSel]),
          el("span", { className: "ct-selo-hd", text: seloHdTexto }),
          el("span", { className: "ct-hype", text: "🔥 " + numeroCurto(porHora) + "/h" }),
        ]),
        el("div", { className: "ct-dados" }, [
          blocoFilme,
          blocoSinais,
          el("div", { className: "ct-meta", text: "👁 " + numeroCurto(it.views) + " · ❤ " + numeroCurto(it.curtidas) + " · ↗ " + numeroCurto(it.compartilhamentos) }),
          el("div", { className: "ct-meta", text: "@" + it.autor + " · " + haQuanto(it.criadoEm) + (it.dataEstimada ? " (data estimada)" : "") + " · " + duracaoCurta(it.duracao) }),
          el("div", { className: "ct-leg", text: it.legenda || "(sem legenda)" }),
        ]),
      ]),
      el(
        "div",
        {
          className: "ct-prog",
          "data-progresso-id": it.id,
          style: prog ? "display:flex" : "display:none",
        },
        [
          el("span", { className: "ct-prog-txt", text: prog ? prog.texto : "" }),
          el("div", { className: "ct-prog-trilho" }, [
            el("div", { className: "ct-prog-enchimento", style: "width:" + (prog ? Math.max(6, Math.round(prog.pct || 10)) : 10) + "%" }),
          ]),
        ]
      ),
      el("div", { className: "ct-acoes" }, [
        el("button", {
          type: "button",
          className: "ct-btn ct-hd-btn ct-mini ct-destaque",
          disabled: ocupado ? true : null,
          title: "Baixa o vídeo em alta qualidade (HD sem marca d'água), salva o .mp4 e já abre carregado no Upload em massa",
          onClick: function () { baixarParaUpload([it]); },
          text: prog
            ? "⏳ A baixar em HD…"
            : jaBaixou
            ? "⬇️ Baixar HD + Upload de novo"
            : "⬇️ Baixar HD e ir pro Upload",
        }),
        el("button", {
          type: "button",
          className: "ct-btn " + (estado.modo === "cortes" ? "ct-prim" : "ct-sec") + " ct-mini",
          disabled: ocupado ? true : null,
          title: "Envia apenas o link para a fila do Upload em massa",
          onClick: function () { levar(it, "aqui"); },
          text: usado ? "📥 Levar de novo" : "📥 Levar pro CineClip",
        }),
        el("button", {
          type: "button",
          className: "ct-btn ct-sec ct-mini",
          disabled: ocupado ? true : null,
          title: "Baixar apenas o arquivo .mp4 em HD para o teu aparelho (sem abrir o Upload)",
          onClick: function () { baixarParaUpload([it], { soBaixar: true }); },
          text: "💾 Só .mp4",
        }),
        el("button", {
          type: "button",
          className: "ct-btn ct-sec ct-mini",
          title: "Processa na nuvem e agenda sozinho (precisa do servidor ligado)",
          onClick: function () { levar(it, "nuvem"); },
          text: "☁️ Nuvem",
        }),
        el("button", { type: "button", className: "ct-btn ct-sec ct-mini", onClick: function () { copiar(it); }, text: "🔗" }),
        el("a", { className: "ct-btn ct-sec ct-mini", href: it.url, target: "_blank", rel: "noreferrer", text: "↗ TikTok", style: "text-decoration:none" }),
      ]),
    ]);
  }

  function desenhar() {
    if (!raiz) return;
    var ehNarrados = estado.modo === "narrados";
    var o = opcoesAtuais();
    raiz.innerHTML = "";

    // Seletor de sub-painel: 🔥 Cortes em alta | 🎙️ Achados: Filmes Narrados
    raiz.appendChild(
      el("div", { className: "ct-abas", role: "tablist" }, [
        el(
          "button",
          {
            type: "button",
            role: "tab",
            "aria-selected": !ehNarrados ? "true" : "false",
            className: "ct-aba" + (!ehNarrados ? " ativa" : ""),
            onClick: function () { alternarModo("cortes"); },
          },
          ["🔥 Cortes em alta"]
        ),
        el(
          "button",
          {
            type: "button",
            role: "tab",
            "aria-selected": ehNarrados ? "true" : "false",
            className: "ct-aba" + (ehNarrados ? " ativa" : ""),
            onClick: function () { alternarModo("narrados"); },
          },
          [
            "🎙️ Filmes Narrados (Achados)",
            el("span", { className: "ct-aba-selo", text: "HD + Upload" }),
          ]
        ),
      ])
    );

    raiz.appendChild(
      el("div", { className: "ct-topo" }, [
        el("h2", {
          text: ehNarrados ? "🎙️ Achados de Cortes de Filmes Narrados" : "🔥 Tendências do TikTok",
        }),
        el("span", { className: "ct-meta", text: estado.geradoEm ? "Atualizado " + haQuanto(estado.geradoEm / 1000) : "" }),
      ])
    );

    raiz.appendChild(
      el("p", {
        className: "ct-sub",
        text: ehNarrados
          ? "Encontra cortes e resumos de filmes narrados no TikTok (voz original, recaps e cenas narradas), baixa o .mp4 em alta qualidade (HD sem marca d'água) no teu aparelho e já envia direto para o 📦 Upload em massa."
          : "Os cortes de filmes que mais estão bombando agora, ordenados por visualizações por hora. Baixa em alta qualidade direto pro Upload em massa ou leva o link para o CineClip.",
      })
    );

    var tagsSugeridas = ehNarrados ? SUGESTOES_NARRADOS_TAGS : SUGESTOES_CORTES;
    var chipsTags = el(
      "div",
      { className: "ct-chips" },
      [el("span", { className: "ct-chips-rotulo", text: "Hashtags:" })].concat(
        tagsSugeridas.map(function (s) {
          return el("button", {
            type: "button",
            className: "ct-chip",
            text: "#" + s,
            onClick: function () {
              var atuais = String(o.tags || "")
                .split(/[,\s]+/)
                .map(function (x) { return x.replace(/^#/, "").toLowerCase(); })
                .filter(Boolean);
              if (atuais.indexOf(s) < 0) atuais.push(s);
              o.tags = atuais.join(", ");
              gravarOpcoes();
              desenhar();
            },
          });
        })
      )
    );

    var chipsTermos = ehNarrados
      ? el(
          "div",
          { className: "ct-chips" },
          [el("span", { className: "ct-chips-rotulo", text: "Frases:" })].concat(
            SUGESTOES_NARRADOS_TERMOS.map(function (termo) {
              return el("button", {
                type: "button",
                className: "ct-chip termo",
                text: '+ "' + termo + '"',
                onClick: function () {
                  var atuais = String(o.termos || "")
                    .split(/[,;\n]+/)
                    .map(function (x) { return x.trim(); })
                    .filter(Boolean);
                  var jaTem = atuais.some(function (x) { return norm(x) === norm(termo); });
                  if (!jaTem) atuais.push(termo);
                  o.termos = atuais.join(", ");
                  gravarOpcoes();
                  desenhar();
                },
              });
            })
          )
        )
      : null;

    // Opção 1 (sempre a primeira .ct-opcao input, preservando compatibilidade total): esconder já usados
    var esconder = el("input", { type: "checkbox", checked: o.esconderUsados ? true : null });
    esconder.addEventListener("change", function () {
      o.esconderUsados = esconder.checked;
      gravarOpcoes();
      desenhar();
    });

    var chkSalvarLocal = el("input", { type: "checkbox", checked: o.salvarNoDispositivo !== false ? true : null });
    chkSalvarLocal.addEventListener("change", function () {
      o.salvarNoDispositivo = chkSalvarLocal.checked;
      gravarOpcoes();
    });

    var chkAuto = el("input", { type: "checkbox", checked: o.iniciarAutomatico ? true : null });
    chkAuto.addEventListener("change", function () {
      o.iniciarAutomatico = chkAuto.checked;
      gravarOpcoes();
    });

    var opcoesChecks = [
      el("label", { className: "ct-opcao" }, [esconder, el("span", { text: "Esconder os que já levei" })]),
    ];

    if (ehNarrados) {
      var chkNarrados = el("input", { type: "checkbox", checked: o.apenasNarrados !== false ? true : null });
      chkNarrados.addEventListener("change", function () {
        o.apenasNarrados = chkNarrados.checked;
        gravarOpcoes();
      });
      opcoesChecks.push(
        el("label", { className: "ct-opcao" }, [
          chkNarrados,
          el("span", { text: "🎙️ Só com sinais de narração / resumo" }),
        ])
      );
    }

    opcoesChecks.push(
      el("label", { className: "ct-opcao" }, [
        chkSalvarLocal,
        el("span", { text: "💾 Salvar .mp4 em HD nos Downloads ao ir pro Upload" }),
      ]),
      el("label", { className: "ct-opcao" }, [
        chkAuto,
        el("span", { text: "⚡ Iniciar processamento automático no Upload" }),
      ])
    );

    var linhaInputs = ehNarrados
      ? [
          campoTextoDe(o, "Hashtags narradas (separadas por vírgula)", "tags", "filmesnarrados, resumodefilmes"),
          campoTextoDe(o, "Termos de busca no TikTok (frases)", "termos", "filme narrado, resumo de filme"),
          campoTextoDe(o, "Perfis de cortes narrados (opcional)", "perfis", "@canal1, @canal2"),
        ]
      : [
          campoTextoDe(o, "Hashtags (separadas por vírgula)", "tags", "cenasdefilme, filmes"),
          campoTextoDe(o, "Perfis de cortes (opcional)", "perfis", "@conta1, @conta2"),
        ];

    var linhaSelects = [
      campoListaDe(o, "Postados nos últimos", "dias", [
        [1, "1 dia"],
        [3, "3 dias"],
        [7, "7 dias"],
        [14, "14 dias"],
        [30, "30 dias"],
        [60, "60 dias"],
      ]),
      campoListaDe(o, "Downloads ao mesmo tempo", "downloadsSimultaneos", [
        [1, "1 (um por vez)"],
        [2, "2"],
        [3, "3"],
        [4, "4 (padrão)"],
        [5, "5"],
        [6, "6 (ligação rápida)"],
      ]),
      campoListaDe(o, "Mínimo de views", "minViews", [
        [5000, "5 mil"],
        [20000, "20 mil"],
        [50000, "50 mil"],
        [100000, "100 mil"],
        [500000, "500 mil"],
      ]),
    ];

    if (ehNarrados) {
      linhaSelects.push(
        campoListaDe(o, "Duração mínima", "minDuracao", [
          [8, "Qualquer (8 s+)"],
          [25, "25 s+ (narrados)"],
          [45, "45 s+"],
          [60, "1 min+ (longos)"],
        ])
      );
    }

    linhaSelects.push(
      el("button", {
        type: "button",
        className: "ct-btn ct-prim",
        disabled: estado.carregando ? true : null,
        onClick: function () { buscar(true); },
        text: estado.carregando
          ? "A buscar… (até 45 s)"
          : ehNarrados
          ? "🎙️ Buscar cortes narrados"
          : "🔥 Buscar tendências",
      })
    );

    raiz.appendChild(
      el("div", { className: "ct-filtros" }, [
        el("div", { className: "ct-linha" }, linhaInputs),
        chipsTags,
        chipsTermos,
        el("div", { className: "ct-linha" }, linhaSelects),
        el("p", { className: "ct-meta", text: "Busca gratuita, sem token. Se hashtags e termos não responderem e nenhum perfil for indicado, tentamos @teusflix e @cinemaemminutos3. Perfis incorporados mostram até 10 vídeos recentes; não são um ranking global do TikTok. Duração e engajamento podem não ser informados: aparecem como —. O filtro de duração se aplica somente quando ela é conhecida." }),
        el("div", { className: "ct-opcoes-grade" }, opcoesChecks),
      ])
    );

    if (estado.erro) raiz.appendChild(el("div", { className: "ct-aviso erro", text: estado.erro }));
    else if (estado.aviso) raiz.appendChild(el("div", { className: "ct-aviso", text: estado.aviso }));

    if (estado.estados.length) {
      raiz.appendChild(el("details", { className: "ct-fontes" }, [
        el("summary", { text: "Fontes da busca" }),
        el("ul", {}, estado.estados.map(function (f) {
          return el("li", { text: (f.ok ? "✓ " : "⚠ ") + f.fonte + (f.ok ? " · " + (f.provedor === "tiktok-publico" ? "TikTok público" : "TikWM") + " · " + (f.videos || 0) + " vídeo(s)" : " · " + f.erro) });
        })),
      ]));
    }

    var itensVisiveis = estado.itens.filter(function (it) {
      return !(o.esconderUsados && estado.usados[it.id]);
    });

    var itensSelecionados = itensVisiveis.filter(function (it) {
      return !!estado.selecionados[it.id];
    });

    if (itensSelecionados.length > 0) {
      raiz.appendChild(
        el("div", { className: "ct-barra-lote" }, [
          el("strong", {
            text:
              "🎬 " +
              itensSelecionados.length +
              (itensSelecionados.length === 1 ? " corte selecionado" : " cortes selecionados"),
          }),
          el("div", { style: "display:flex;flex-wrap:wrap;gap:8px" }, [
            el("button", {
              type: "button",
              className: "ct-btn ct-hd-btn ct-mini",
              disabled: estado.aBaixarLote ? true : null,
              onClick: function () { baixarParaUpload(itensSelecionados); },
              text:
                "⬇️ Baixar " +
                itensSelecionados.length +
                " em HD e ir pro Upload",
            }),
            el("button", {
              type: "button",
              className: "ct-btn ct-sec ct-mini",
              onClick: function () {
                itensVisiveis.forEach(function (it) { estado.selecionados[it.id] = true; });
                desenhar();
              },
              text: "Selecionar todos (" + itensVisiveis.length + ")",
            }),
            el("button", {
              type: "button",
              className: "ct-btn ct-sec ct-mini",
              onClick: function () {
                estado.selecionados = {};
                desenhar();
              },
              text: "Limpar seleção",
            }),
          ]),
        ])
      );
    }

    if (!estado.jaBuscou && !estado.carregando && !estado.erro) {
      raiz.appendChild(
        el("div", {
          className: "ct-vazio",
          text: ehNarrados
            ? "Carrega em «Buscar cortes narrados» para encontrar os melhores achados de filmes narrados."
            : "Carrega em «Buscar tendências» para ver os cortes mais quentes.",
        })
      );
    } else if (estado.jaBuscou && !itensVisiveis.length && !estado.aviso) {
      raiz.appendChild(
        el("div", {
          className: "ct-vazio",
          text: "Já levaste/baixaste todos os vídeos desta lista. Busca de novo ou desmarca «Esconder os que já levei».",
        })
      );
    } else if (itensVisiveis.length) {
      raiz.appendChild(el("ul", { className: "ct-grade" }, itensVisiveis.map(cartao)));
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
    abrirModo: abrirModo,
    baixarParaUpload: baixarParaUpload,
    _interno: {
      ambiente: ambiente,
      estado: estado,
      desenhar: desenhar,
      aplicar: aplicar,
      alternarModo: alternarModo,
      resolverFilmes: resolverFilmes,
      levar: levar,
      baixarParaUpload: baixarParaUpload,
      nomeArquivoHd: nomeArquivoHd,
      pistaDoItem: pistaDoItem,
      consultaDosFiltros: consultaDosFiltros,
      procurarNoTmdb: procurarNoTmdb,
    },
  };
})();
