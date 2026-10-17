/*
 * ⚡ AGENDAMENTO RÁPIDO — CineClip
 * ---------------------------------------------------------------------------
 * Uma aba à parte para agendar EM LOTE vídeos que já estão editados. Ao
 * contrário do «📦 Upload em massa», aqui o FFmpeg nunca é chamado: o ficheiro
 * original entra na fila do Agendador exatamente como está. O que o app faz
 * por cada vídeo é só isto:
 *
 *   1. lê a duração e as dimensões (um <video> escondido, sem reencodificar);
 *   2. (opcional) identifica o filme/série com a IA + TMDB — é o que dá o
 *      título, a sinopse e o PÔSTER OFICIAL, que vai como CAPA do Reel;
 *   3. escreve a LEGENDA (com a IA quando há filme identificado; com o modelo
 *      do painel quando a IA está desligada ou falha);
 *   4. coloca o Reel na fila, no próximo horário livre da conta ativa.
 *
 * Este ficheiro é código legível de propósito (o resto do app vive num bundle
 * compilado). A ligação ao bundle são os mesmos dois objetos que o
 * lote-massa.js usa (patch tools/patches/27-lote-ponte):
 *   • window.CineClipCore   — as funções internas (IA, TMDB, fila);
 *   • window.__CineClipApp  — o estado atual do app (definições, conta ativa…).
 *
 * Nenhuma destas funções usa o FFmpeg: `lerMetadados` usa o mediainfo.js,
 * `quadros` usa <video> + <canvas>, `audio` usa a Web Audio API. É por isso
 * que este modo é rápido e não descarrega o motor de vídeo (~30 MB).
 *
 * API pública: window.CineRapido.montar() · window.CineRapido.abrir(ficheiros?)
 */
(function () {
  "use strict";

  if (window.CineRapido) return;

  var CHAVE_OPCOES = "cineclip.rapido.opcoes";
  var ID_MONTE = "cc-rapido-monte";
  var MAX_SIMULTANEOS = 4;
  var CONFIANCA_MINIMA = 65;
  var MIN_SEGUNDOS = 3;
  var MAX_SEGUNDOS_ANALISE = 90;
  var SLOTS_OMISSAO = ["12:00", "18:00", "21:30"];
  var EXTENSOES = ["mp4", "mov", "mkv", "webm", "avi", "m4v"];
  var MAX_BYTES = 300 * 1024 * 1024;

  var MODELO_OMISSAO = "🎬 {titulo}\n\n#Reels #Cinema";

  var NOMES_ESTADO = {
    pendente: "Na fila",
    a_processar: "A tratar",
    agendado: "Agendado",
    revisar: "Rever",
    erro: "Erro",
  };

  var estado = {
    itens: [],
    aCorrer: false,
    pararPedido: false,
    conta: null,
    opcoes: lerOpcoes(),
    montado: false,
  };

  var proximoId = 1;

  /* ------------------------------------------------------------- opções */

  function lerOpcoes() {
    var omissao = {
      identificar: true,
      usarCapa: true,
      agendarComPoucaCerteza: false,
      simultaneos: 3,
      modelo: MODELO_OMISSAO,
    };
    try {
      var bruto = window.localStorage.getItem(CHAVE_OPCOES);
      var o = bruto ? JSON.parse(bruto) : {};
      var sim = Number(o.simultaneos);
      return {
        identificar: typeof o.identificar === "boolean" ? o.identificar : omissao.identificar,
        usarCapa: typeof o.usarCapa === "boolean" ? o.usarCapa : omissao.usarCapa,
        agendarComPoucaCerteza: !!o.agendarComPoucaCerteza,
        simultaneos: sim >= 1 && sim <= MAX_SIMULTANEOS ? Math.round(sim) : omissao.simultaneos,
        modelo: typeof o.modelo === "string" && o.modelo.trim() ? o.modelo : omissao.modelo,
      };
    } catch (e) {
      return omissao;
    }
  }

  function gravarOpcoes() {
    try {
      window.localStorage.setItem(CHAVE_OPCOES, JSON.stringify(estado.opcoes));
    } catch (e) {}
  }

  /* ------------------------------------------------- ligação ao app (bundle) */

  /**
   * Funções que podem ser trocadas nos testes. Em produção vêm do bundle
   * (window.CineClipCore / window.__CineClipApp) e do próprio navegador.
   */
  var ambiente = {
    core: function () {
      return window.CineClipCore || null;
    },
    app: function () {
      return window.__CineClipApp || null;
    },
    lerVideo: lerVideoNoNavegador,
    agora: function () {
      return Date.now();
    },
  };

  /** Dimensões e duração do vídeo, lidas por um <video> escondido. */
  function lerVideoNoNavegador(ficheiro) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(ficheiro);
      var video = document.createElement("video");
      var terminado = false;
      function fim(erro, valor) {
        if (terminado) return;
        terminado = true;
        clearTimeout(limite);
        try {
          video.removeAttribute("src");
          video.load();
        } catch (e) {}
        URL.revokeObjectURL(url);
        if (erro) reject(erro);
        else resolve(valor);
      }
      var esperaMs = typeof document !== "undefined" && document.hidden ? 60000 : 20000;
      var limite = setTimeout(function () {
        fim(new Error("O navegador demorou demasiado a abrir o vídeo."));
      }, esperaMs);
      video.preload = "metadata";
      video.muted = true;
      video.playsInline = true;
      var pronto = function () {
        fim(null, {
          largura: video.videoWidth || 0,
          altura: video.videoHeight || 0,
          duracao: Number.isFinite(video.duration) ? video.duration : 0,
        });
      };
      video.onloadedmetadata = pronto;
      video.onloadeddata = pronto;
      video.onerror = function () {
        fim(new Error("O navegador não consegue abrir este vídeo."));
      };
      video.src = url;
      try {
        video.load();
      } catch (e) {}
    });
  }

  /* ------------------------------------------------------------- ajudas */

  function erroComTipo(mensagem, tipo) {
    var e = new Error(mensagem);
    e.tipo = tipo || "geral";
    return e;
  }

  function mensagemDeErro(e, alternativa) {
    return (e && e.message) || alternativa || "Erro desconhecido.";
  }

  function tamanho(bytes) {
    var b = Number(bytes) || 0;
    if (b < 1024) return b + " B";
    if (b < 1024 * 1024) return (b / 1024).toFixed(0) + " KB";
    if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + " MB";
    return (b / 1024 / 1024 / 1024).toFixed(2) + " GB";
  }

  function duracaoLegivel(segundos) {
    var s = Math.max(0, Math.round(Number(segundos) || 0));
    var m = Math.floor(s / 60);
    var r = s % 60;
    return m + ":" + (r < 10 ? "0" : "") + r;
  }

  function horarioLegivel(valor) {
    var txt = String(valor || "");
    if (!txt) return "";
    var d = new Date(txt.length <= 16 ? txt + ":00" : txt);
    if (isNaN(d.getTime())) return txt;
    return d.toLocaleDateString(undefined, { day: "2-digit", month: "2-digit" }) +
      " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }

  function semExtensao(nome) {
    return String(nome || "").replace(/\.[^.]+$/, "");
  }

  function extensao(nome) {
    var m = /\.([a-z0-9]+)$/i.exec(String(nome || ""));
    return m ? m[1].toLowerCase() : "";
  }

  /** Nome do ficheiro → título apresentável (usado quando a IA está desligada). */
  function tituloDoNome(nome) {
    var base = semExtensao(nome);
    base = base.replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();
    base = base
      .replace(/\b(cineclip|clean|final|editado|edit|reels?|tiktok|kwai|download|downloads|video|output|input)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    return base || "Reels";
  }

  /** Preenche o modelo de legenda: {titulo}, {ano} e {nome}. */
  function aplicarModelo(modelo, dados) {
    return String(modelo == null ? MODELO_OMISSAO : modelo)
      .replace(/\{titulo\}/g, dados.titulo || "")
      .replace(/\{ano\}/g, dados.ano || "")
      .replace(/\{nome\}/g, dados.nome || "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /**
   * Reaproveita o cache de identificação e o hash perceptual do lote-massa.js
   * (o script carrega primeiro). Se ele não estiver disponível, funciona na
   * mesma — só não poupa chamadas à IA repetidas.
   */
  function ajudasDoLote() {
    return (window.CineLote && window.CineLote._interno) || null;
  }

  function assinaturaDoFicheiro(ficheiro) {
    return String(ficheiro.name || "") + "|" + (ficheiro.size || 0) + "|" + (ficheiro.lastModified || 0);
  }

  /* ----------------------------------------------------------- os itens */

  function adicionarFicheiros(lista) {
    var aceites = 0;
    var vistos = {};
    estado.itens.forEach(function (it) {
      vistos[it.assinatura] = true;
    });
    Array.prototype.forEach.call(lista || [], function (f) {
      if (!f) return;
      var assinatura = assinaturaDoFicheiro(f);
      if (vistos[assinatura]) return;
      vistos[assinatura] = true;
      var item = {
        id: proximoId++,
        ficheiro: f,
        nome: f.name || "video.mp4",
        bytes: f.size || 0,
        assinatura: assinatura,
        duracao: 0,
        estado: "pendente",
        passo: "",
        progresso: 0,
        titulo: "",
        ano: "",
        poster: "",
        confianca: 0,
        legenda: "",
        legendaManual: false,
        horario: "",
        reelId: "",
        erro: "",
        aviso: "",
      };
      var ext = extensao(item.nome);
      var bytes = f.size || 0;
      if (EXTENSOES.indexOf(ext) === -1) {
        // Fica na lista a dizer porquê: desaparecer sem explicação é pior.
        item.estado = "erro";
        item.invalido = true;
        item.erro = "Formato não suportado (." + (ext || "?") + "). Usa mp4, mov, mkv, webm ou avi.";
      } else if (bytes > MAX_BYTES) {
        item.estado = "erro";
        item.invalido = true;
        item.erro = "Ficheiro demasiado grande (" + tamanho(bytes) + "). Máximo: 300 MB.";
      } else {
        aceites++;
      }
      estado.itens.push(item);
    });
    if (aceites) desenhar();
    return aceites;
  }

  function pendentes() {
    return estado.itens.filter(function (it) {
      return it.estado === "pendente";
    });
  }

  function contar(nomeEstado) {
    return estado.itens.filter(function (it) {
      return it.estado === nomeEstado;
    }).length;
  }

  function removerItem(id) {
    estado.itens = estado.itens.filter(function (it) {
      return it.id !== id || it.estado === "a_processar";
    });
    desenhar();
  }

  function repetirItem(id) {
    estado.itens.forEach(function (it) {
      if (it.id !== id) return;
      it.estado = "pendente";
      it.erro = "";
      it.aviso = "";
      it.passo = "";
      it.progresso = 0;
    });
    desenhar();
  }

  function limparConcluidos() {
    estado.itens = estado.itens.filter(function (it) {
      return it.estado !== "agendado" && it.estado !== "erro" && it.estado !== "revisar";
    });
    desenhar();
  }

  /** O que falta configurar para o modo com IA (null quando está tudo). */
  function faltaConfigurar() {
    var core = ambiente.core();
    var app = ambiente.app();
    if (!core || !app) return "O app ainda está a carregar. Tenta de novo dentro de alguns segundos.";
    var s = app.settings || {};
    if (!app.account || !app.account.id) return "Escolhe uma conta do Instagram no topo do app.";
    if (!estado.opcoes.identificar) return null;
    var temIA = !!String(s.nvidiaKey || "").trim() || !!String(s.geminiKey || "").trim();
    if (!temIA) return "Desliga «Identificar o filme com IA» ou adiciona a chave NVIDIA/Gemini nas configurações.";
    if (!String(s.tmdbKey || "").trim()) return "Desliga «Identificar o filme com IA» ou adiciona a chave TMDB nas configurações — é ela que traz a capa.";
    return null;
  }

  function definirPasso(item, passo, progresso) {
    item.passo = passo;
    if (typeof progresso === "number") item.progresso = progresso;
    desenhar();
  }

  /* ------------------------------------------------- processar um vídeo */

  /**
   * Leva um vídeo já editado até à fila do Agendador — SEM passar pelo FFmpeg.
   * Lança um erro (com `tipo`) quando não pode continuar.
   */
  async function processarItem(item, conta, ctx) {
    var core = (ctx && ctx.core) || ambiente.core();
    var app = (ctx && ctx.app) || ambiente.app();
    var lerVideoFn = (ctx && ctx.lerVideo) || ambiente.lerVideo;
    var permitirPoucaCerteza = ctx && typeof ctx.agendarComPoucaCerteza === "boolean"
      ? ctx.agendarComPoucaCerteza
      : !!estado.opcoes.agendarComPoucaCerteza;
    var identificar = ctx && typeof ctx.identificar === "boolean" ? ctx.identificar : !!estado.opcoes.identificar;
    var usarCapa = ctx && typeof ctx.usarCapa === "boolean" ? ctx.usarCapa : !!estado.opcoes.usarCapa;
    var s = (app && app.settings) || {};
    var ficheiro = item.ficheiro;

    /* 1. Ler o vídeo ------------------------------------------------------ */
    if (estado.pararPedido) throw erroComTipo("Lote parado.", "parado");
    definirPasso(item, "A ler o vídeo…", 0.05);
    var info = null;
    var erroVideo = null;
    try {
      info = await lerVideoFn(ficheiro);
    } catch (e) {
      erroVideo = e;
    }
    if (!info && core && typeof core.lerMetadados === "function") {
      try {
        var meta = await core.lerMetadados(ficheiro);
        if (meta && meta.width && meta.height) {
          info = {
            largura: Number(meta.width) || 0,
            altura: Number(meta.height) || 0,
            duracao: Number(meta.duration) || 0,
          };
        }
      } catch (e) {}
    }
    if (!info) throw erroVideo || erroComTipo("O navegador não consegue abrir este vídeo.", "leitura");
    var duracao = Number(info.duracao) || 0;
    if (!duracao) duracao = 0;
    item.duracao = duracao;
    if (duracao && duracao < MIN_SEGUNDOS) {
      throw erroComTipo("O vídeo tem menos de " + MIN_SEGUNDOS + " segundos (o Instagram não aceita).", "leitura");
    }

    // Aviso (não bloqueia): o Instagram só garante o Reel em 9:16.
    if (info.largura && info.altura) {
      var proporcao = info.largura / info.altura;
      if (Math.abs(proporcao - 9 / 16) > 0.06) {
        item.aviso = "Atenção: este vídeo não está em 9:16 (" + info.largura + "×" + info.altura +
          "). Vai como está porque este modo não edita — o Instagram pode recusar ou mostrar barras.";
      }
    }

    var titulo = tituloDoNome(ficheiro.name);
    var legenda = "";
    var poster = "";
    var filme = null;
    var confianca = 0;

    /* 2. Identificar (opcional) + 3. Legenda + capa ----------------------- */
    if (identificar) {
      definirPasso(item, "A identificar o filme…", 0.2);
      var fim = Math.min(MAX_SEGUNDOS_ANALISE, duracao || MAX_SEGUNDOS_ANALISE);
      if (fim < 1) fim = 1;
      var corte = { top: 0, bottom: 0, vw: info.largura || 0, vh: info.altura || 0 };
      var quadros = await core.quadros(ficheiro, 0, fim, corte);
      var temGemini = !!String(s.geminiKey || "").trim();
      var audio = null;
      if (temGemini && typeof core.audio === "function") {
        try {
          audio = await core.audio(ficheiro, 0, fim);
        } catch (e) {
          audio = null;
        }
      }

      var ajudas = ajudasDoLote();
      var hashVideo = null;
      if (ajudas && typeof ajudas.hashPerceptualVideo === "function") {
        try {
          hashVideo = await ajudas.hashPerceptualVideo(quadros);
        } catch (e) {
          hashVideo = null;
        }
      }
      item.videoHash = hashVideo || undefined;

      var cacheHit = null;
      if (hashVideo && ajudas && typeof ajudas.cacheIdentLer === "function") {
        try {
          cacheHit = ajudas.cacheIdentLer(hashVideo);
        } catch (e) {
          cacheHit = null;
        }
      }

      var ia = null;
      if (cacheHit && cacheHit.ia && cacheHit.filme) {
        ia = cacheHit.ia;
        filme = cacheHit.filme;
      } else {
        ia = await core.identificar(s.nvidiaKey, quadros, s.lang || "pt-PT", {
          fileName: ficheiro.name,
          metaTitle: titulo,
          userHint: titulo,
          geminiKey: s.geminiKey,
          audioClip: audio,
        });
        if (!ia || (!ia.titulo && !(ia.atores && ia.atores.length))) {
          throw erroComTipo("A IA não conseguiu identificar o filme deste clipe.", "identificacao");
        }
        filme = await core.procurarTmdb(s.tmdbKey, ia);
        if (!filme && Array.isArray(ia.alternativas) && ia.alternativas.length) {
          for (var a = 0; a < ia.alternativas.length; a++) {
            var alt = ia.alternativas[a];
            if (!alt || !(alt.titulo || alt.titulo_original)) continue;
            try {
              filme = await core.procurarTmdb(s.tmdbKey, {
                titulo: alt.titulo,
                titulo_original: alt.titulo_original,
                ano: alt.ano,
                tipo: alt.tipo,
                confianca: 75,
              });
            } catch (e) {
              filme = null;
            }
            if (filme) {
              ia.titulo = filme.title;
              ia.titulo_original = filme.original;
              ia.ano = filme.year;
              ia.confianca = Math.max(Number(ia.confianca) || 0, 75);
              break;
            }
          }
        }
        if (!filme) {
          throw erroComTipo(
            'Não encontrei "' + (ia.titulo || ia.titulo_original || "o filme") + '" no TMDB.',
            "identificacao"
          );
        }
        if (hashVideo && ajudas && typeof ajudas.cacheIdentGuardar === "function") {
          try {
            ajudas.cacheIdentGuardar(hashVideo, { ia: ia, filme: filme });
          } catch (e) {}
        }
      }

      confianca = Number(ia.confianca) || 0;
      titulo = filme.title || titulo;
      if (usarCapa) poster = filme.poster || "";
      item.titulo = titulo;
      item.ano = filme.year || "";
      item.poster = poster;
      item.confianca = confianca;

      if (confianca < CONFIANCA_MINIMA && !permitirPoucaCerteza) {
        throw erroComTipo(
          'A IA acha que é "' + titulo + (filme.year ? " (" + filme.year + ")" : "") + '", mas só com ' +
            confianca + "% de certeza. Liga “Agendar mesmo com pouca certeza” ou agenda à mão.",
          "revisar"
        );
      }

      if (!item.legendaManual) {
        definirPasso(item, "A escrever a legenda…", 0.6);
        try {
          legenda = await core.gerarLegenda(s.nvidiaKey, filme, s.lang || "pt-PT", {
            cena: ia.cena || "",
            geminiKey: s.geminiKey,
          });
        } catch (e) {
          legenda = "";
        }
      }
      try {
        core.guardarHistorico({ title: filme.title, year: filme.year, caption: legenda, date: ambiente.agora() });
      } catch (e) {}
    }

    if (!legenda || !String(legenda).trim()) {
      legenda = aplicarModelo(estado.opcoes.modelo, {
        titulo: titulo,
        ano: item.ano || "",
        nome: semExtensao(ficheiro.name),
      });
    }
    if (item.legendaManual && String(item.legenda).trim()) legenda = item.legenda;
    item.legenda = legenda;

    /* 4. Agendar ---------------------------------------------------------- */
    if (estado.pararPedido) throw erroComTipo("Lote parado.", "parado");
    definirPasso(item, "A agendar…", 0.9);
    return await comTravaAgendar(async function () {
      if (estado.pararPedido) throw erroComTipo("Lote parado.", "parado");
      var fila = await _comTimeout(
        Promise.resolve().then(function () {
          return core.lerFila();
        }),
        3500,
        []
      );
      if (!Array.isArray(fila)) fila = [];

      var chaveItem = "rapido_" + item.id;
      var duplicado = fila.find(function (r) {
        if (!r || r.accountId !== conta.id) return false;
        return r._rapidoKey === chaveItem;
      });
      if (duplicado) {
        item.horario = duplicado.scheduledAt;
        item.reelId = duplicado.id;
        return duplicado;
      }

      var horario = _proximoHorarioSeguro(core, fila, conta.dailySlots || [], conta.id);
      var agora = ambiente.agora();
      var legendaLimpa = typeof core.limparLegenda === "function"
        ? core.limparLegenda(String(legenda))
        : String(legenda).replace(/\*\*(.+?)\*\*/g, "$1").trim();

      var reel = {
        id: "reel_" + agora + "_" + item.id + "_" + Math.random().toString(36).slice(2, 6),
        accountId: conta.id,
        createdAt: agora,
        updatedAt: agora,
        scheduledAt: horario,
        status: "scheduled",
        title: titulo || semExtensao(ficheiro.name),
        originalTitle: filme ? filme.original : undefined,
        year: item.ano || undefined,
        poster: poster || undefined,
        hookText: "",
        caption: legendaLimpa,
        videoBlob: ficheiro,
        videoFileName: ficheiro.name || "video.mp4",
        videoSize: ficheiro.size || 0,
        sourceBytes: ficheiro.size || 0,
        videoHash: item.videoHash || undefined,
        fileSig: undefined,
        _rapidoKey: chaveItem,
        semEdicao: true,
        platforms: ["instagram"],
      };
      delete reel.fileSig;

      await _comTimeout(
        Promise.resolve().then(function () {
          return core.guardarNaFila(reel);
        }),
        6000,
        false
      );

      item.horario = horario;
      item.reelId = reel.id;
      return reel;
    });
  }

  /* --------------------------------------------------------- o ciclo */

  var travaAgendar = Promise.resolve();

  function _comTimeout(promessa, ms, valorFallback) {
    return new Promise(function (resolve) {
      var terminado = false;
      var t = setTimeout(function () {
        if (terminado) return;
        terminado = true;
        resolve(valorFallback);
      }, ms);
      Promise.resolve()
        .then(function () {
          return promessa;
        })
        .then(
          function (v) {
            if (terminado) return;
            terminado = true;
            clearTimeout(t);
            resolve(v);
          },
          function () {
            if (terminado) return;
            terminado = true;
            clearTimeout(t);
            resolve(valorFallback);
          }
        );
    });
  }

  function _proximoHorarioSeguro(core, fila, slots, contaId) {
    if (core && typeof core.proximoHorario === "function") {
      try {
        var h = core.proximoHorario(
          fila || [],
          Array.isArray(slots) && slots.length ? slots : SLOTS_OMISSAO,
          contaId
        );
        if (h) return h;
      } catch (e) {}
    }
    var d = new Date(Date.now() + 3600000);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }

  /** Um agendamento de cada vez: dois vídeos nunca escolhem o mesmo horário. */
  function comTravaAgendar(fn) {
    var anterior = travaAgendar;
    var atual = anterior.then(fn, fn);
    travaAgendar = atual.then(
      function () {},
      function () {}
    );
    return atual;
  }

  function pedirSincronizacao() {
    var app = ambiente.app();
    if (app && typeof app.atualizarFila === "function") {
      try {
        app.atualizarFila();
      } catch (e) {}
    }
  }

  async function iniciar() {
    if (estado.aCorrer) return;
    var falta = faltaConfigurar();
    if (falta) {
      avisar(falta, "erro");
      desenhar();
      return;
    }
    if (!pendentes().length) return;
    var app = ambiente.app();
    var conta = (app && app.account) || null;
    if (!conta || !conta.id) {
      avisar("Escolhe uma conta do Instagram no topo do app.", "erro");
      desenhar();
      return;
    }
    estado.conta = conta;
    estado.aCorrer = true;
    estado.pararPedido = false;
    avisar("", "");

    var quantos = Math.max(1, Math.min(MAX_SIMULTANEOS, Number(estado.opcoes.simultaneos) || 1));
    var ctx = {
      identificar: !!estado.opcoes.identificar,
      usarCapa: !!estado.opcoes.usarCapa,
      agendarComPoucaCerteza: !!estado.opcoes.agendarComPoucaCerteza,
    };

    async function trabalhador() {
      for (;;) {
        if (estado.pararPedido) return;
        var item = pendentes()[0];
        if (!item) return;
        item.estado = "a_processar";
        item.progresso = 0;
        item.erro = "";
        desenhar();
        try {
          var reel = await processarItem(item, conta, ctx);
          item.estado = "agendado";
          item.passo = "";
          item.progresso = 1;
        } catch (e) {
          item.estado = e && e.tipo === "revisar" ? "revisar" : e && e.tipo === "parado" ? "pendente" : "erro";
          item.erro = mensagemDeErro(e, "Falha ao agendar este vídeo.");
          item.passo = "";
        }
        desenhar();
      }
    }

    var grupo = [];
    for (var i = 0; i < quantos; i++) grupo.push(trabalhador());
    await Promise.all(grupo);

    estado.aCorrer = false;
    estado.pararPedido = false;
    pedirSincronizacao();
    var appFim = ambiente.app();
    if (appFim && typeof appFim.sincronizar === "function") {
      try {
        appFim.sincronizar();
      } catch (e) {}
    }
    var agendados = contar("agendado");
    if (agendados) avisar("✔ " + agendados + " Reel(s) agendado(s). Vê a aba Agendador.", "ok");
    desenhar();
  }

  function parar() {
    if (!estado.aCorrer) return;
    estado.pararPedido = true;
  }

  /** O utilizador editou a legenda: guarda e, se já está agendado, atualiza a fila. */
  function guardarLegenda(item, texto) {
    item.legenda = texto;
    item.legendaManual = true;
    if (item.estado !== "agendado" || !item.reelId) return;
    comTravaAgendar(async function () {
      var core = ambiente.core();
      if (!core) return;
      var fila = await _comTimeout(
        Promise.resolve().then(function () {
          return core.lerFila();
        }),
        3500,
        []
      );
      var reel = (Array.isArray(fila) ? fila : []).find(function (r) {
        return r && r.id === item.reelId;
      });
      if (!reel) return;
      reel.caption = typeof core.limparLegenda === "function"
        ? core.limparLegenda(String(texto))
        : String(texto).trim();
      reel.updatedAt = ambiente.agora();
      await core.guardarNaFila(reel);
      pedirSincronizacao();
    });
  }

  /* ------------------------------------------------------------------ UI */

  var raiz = null;
  var aviso = { texto: "", tipo: "" };

  function avisar(texto, tipo) {
    aviso = { texto: texto || "", tipo: tipo || "info" };
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

  var CSS = [
    ".cr-painel{display:flex;flex-direction:column;gap:14px;border:1px solid var(--border,rgba(255,255,255,.09));border-radius:16px;background:var(--card,#1c1c22);color:var(--foreground,#f4f4f6);padding:18px 20px;font-family:inherit}",
    ".cr-topo{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px}",
    ".cr-topo h2{margin:0;font-size:18px;font-weight:700}",
    ".cr-topo .cr-selo{font-size:11px;font-weight:700;padding:3px 10px;border-radius:999px;background:rgba(229,72,77,.18);color:#ff8b8f;white-space:nowrap}",
    ".cr-sub{margin:0;font-size:13px;line-height:1.55;color:var(--muted-foreground,#a3a3ad)}",
    ".cr-zona{display:flex;flex-direction:column;align-items:center;gap:8px;padding:22px 16px;border:2px dashed var(--border,rgba(255,255,255,.15));border-radius:12px;text-align:center;cursor:pointer;transition:background .15s,border-color .15s}",
    ".cr-zona:hover,.cr-zona.cr-sobre{border-color:var(--primary,#e5484d);background:rgba(229,72,77,.08)}",
    ".cr-zona strong{font-size:15px}",
    ".cr-zona span{font-size:12px;color:var(--muted-foreground,#a3a3ad)}",
    ".cr-opcoes{display:grid;gap:8px;padding:12px;border:1px solid var(--border,rgba(255,255,255,.09));border-radius:12px}",
    ".cr-opcoes-titulo{font-size:13px;font-weight:700}",
    ".cr-opcao{display:flex;align-items:flex-start;gap:8px;font-size:13px;color:var(--muted-foreground,#a3a3ad);cursor:pointer;line-height:1.4}",
    ".cr-opcao input{margin-top:3px;accent-color:var(--primary,#e5484d)}",
    ".cr-modelo{width:100%;box-sizing:border-box;resize:vertical;min-height:64px;border-radius:8px;border:1px solid var(--border,rgba(255,255,255,.15));background:var(--background,#141418);color:inherit;padding:8px 10px;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}",
    ".cr-modelo:focus{outline:2px solid var(--primary,#e5484d);outline-offset:1px}",
    ".cr-dica{font-size:11px;color:var(--muted-foreground,#a3a3ad);line-height:1.45}",
    ".cr-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border-radius:8px;padding:9px 16px;font-size:14px;font-weight:600;cursor:pointer;border:1px solid transparent;font-family:inherit}",
    ".cr-btn[disabled]{opacity:.5;cursor:not-allowed}",
    ".cr-prim{background:var(--primary,#e5484d);color:#fff}",
    ".cr-sec{background:transparent;color:inherit;border-color:var(--border,rgba(255,255,255,.15))}",
    ".cr-sec:hover:not([disabled]){background:var(--muted,#2a2a31)}",
    ".cr-mini{padding:4px 10px;font-size:12px;font-weight:500}",
    ".cr-acoes{display:flex;flex-wrap:wrap;gap:8px;align-items:center}",
    ".cr-resumo{font-size:13px;color:var(--muted-foreground,#a3a3ad);margin-right:auto}",
    ".cr-aviso{font-size:13px;line-height:1.45;padding:10px 12px;border-radius:10px;border:1px solid var(--border,rgba(255,255,255,.1))}",
    ".cr-aviso.erro{border-color:rgba(229,72,77,.5);background:rgba(229,72,77,.1);color:#ffb3b5}",
    ".cr-aviso.ok{border-color:rgba(48,164,108,.5);background:rgba(48,164,108,.1);color:#7fd7ab}",
    ".cr-lista{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}",
    ".cr-item{border:1px solid var(--border,rgba(255,255,255,.09));border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;background:var(--background,#141418)}",
    ".cr-linha{display:flex;align-items:center;gap:8px;min-width:0}",
    ".cr-nome{flex:1;min-width:0;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".cr-peso{font-size:12px;color:var(--muted-foreground,#a3a3ad);white-space:nowrap}",
    ".cr-selo{font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;white-space:nowrap;background:var(--muted,#2a2a31)}",
    ".cr-selo.agendado{background:rgba(48,164,108,.2);color:#4cc38a}",
    ".cr-selo.erro{background:rgba(229,72,77,.2);color:#ff6369}",
    ".cr-selo.revisar{background:rgba(245,166,35,.2);color:#f5a623}",
    ".cr-selo.a_processar{background:rgba(229,72,77,.25);color:#fff}",
    ".cr-corpo{display:flex;gap:10px;align-items:flex-start}",
    ".cr-capa{width:46px;height:69px;border-radius:6px;object-fit:cover;flex:none;background:var(--muted,#2a2a31)}",
    ".cr-capa-vazio{width:46px;height:69px;border-radius:6px;flex:none;background:var(--muted,#2a2a31)}",
    ".cr-dados{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}",
    ".cr-filme{font-size:13px;font-weight:600;line-height:1.35}",
    ".cr-meta{font-size:12px;color:var(--muted-foreground,#a3a3ad);line-height:1.4}",
    ".cr-legenda{width:100%;box-sizing:border-box;resize:vertical;min-height:54px;border-radius:8px;border:1px solid var(--border,rgba(255,255,255,.15));background:var(--background,#0f0f13);color:inherit;padding:7px 9px;font:12px/1.45 inherit}",
    ".cr-legenda:focus{outline:2px solid var(--primary,#e5484d);outline-offset:1px}",
    ".cr-legenda[readonly]{opacity:.75}",
    ".cr-det{font-size:12px;line-height:1.45;color:var(--muted-foreground,#a3a3ad);word-break:break-word}",
    ".cr-det.erro{color:#ff8b8f}",
    ".cr-det.revisar{color:#f5c26b}",
    ".cr-barra{height:6px;border-radius:999px;background:var(--muted,#2a2a31);overflow:hidden}",
    ".cr-barra > div{height:100%;background:var(--primary,#e5484d);transition:width .3s}",
    ".cr-vazio{font-size:13px;color:var(--muted-foreground,#a3a3ad);text-align:center;padding:14px 0}",
    "@media (max-width:560px){.cr-painel{padding:14px 14px}.cr-acoes{flex-direction:column;align-items:stretch}.cr-acoes .cr-btn{width:100%}.cr-resumo{margin:0}}",
  ].join("\n");

  function garantirEstilo() {
    if (document.getElementById("cineclip-rapido-css")) return;
    var st = document.createElement("style");
    st.id = "cineclip-rapido-css";
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function opcaoSimples(chave, texto) {
    var caixa = el("input", { type: "checkbox", checked: estado.opcoes[chave] || null });
    caixa.addEventListener("change", function () {
      estado.opcoes[chave] = caixa.checked;
      gravarOpcoes();
      desenhar();
    });
    return el("label", { className: "cr-opcao" }, [caixa, el("span", { text: texto })]);
  }

  function escolherFicheiros() {
    var input = el("input", { type: "file", multiple: true, accept: ".mp4,.mov,.mkv,.webm,.avi,video/*", style: "display:none" });
    input.addEventListener("change", function () {
      adicionarFicheiros(input.files);
      input.value = "";
    });
    document.body.appendChild(input);
    input.click();
    setTimeout(function () {
      input.remove();
    }, 0);
  }

  function zonaDeLargar() {
    var zona = el("div", {
      className: "cr-zona",
      role: "button",
      tabindex: "0",
      onClick: escolherFicheiros,
      onKeydown: function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          escolherFicheiros();
        }
      },
      onDragover: function (e) {
        e.preventDefault();
        zona.classList.add("cr-sobre");
      },
      onDragleave: function () {
        zona.classList.remove("cr-sobre");
      },
      onDrop: function (e) {
        e.preventDefault();
        zona.classList.remove("cr-sobre");
        if (e.dataTransfer && e.dataTransfer.files) adicionarFicheiros(e.dataTransfer.files);
      },
    }, [
      el("strong", { text: "Arrasta os vídeos já editados ou clica para escolher" }),
      el("span", { text: "Vários de uma vez · mp4, mov, mkv, webm ou avi · entram na fila sem qualquer edição" }),
    ]);
    return zona;
  }

  function blocoOpcoes() {
    var app = ambiente.app();
    var modelo = el("textarea", {
      className: "cr-modelo",
      rows: "3",
      value: estado.opcoes.modelo,
      spellcheck: "false",
    });
    modelo.addEventListener("change", function () {
      estado.opcoes.modelo = modelo.value;
      gravarOpcoes();
    });

    var select = el("select", { className: "cr-mini cr-sec", style: "border-radius:8px;padding:4px 8px;font:inherit" });
    [1, 2, 3, 4].forEach(function (n) {
      var o = el("option", { value: String(n), text: String(n) });
      if (n === Number(estado.opcoes.simultaneos)) o.selected = true;
      select.appendChild(o);
    });
    select.addEventListener("change", function () {
      estado.opcoes.simultaneos = Number(select.value) || 1;
      gravarOpcoes();
    });

    return el("div", { className: "cr-opcoes" }, [
      el("div", { className: "cr-opcoes-titulo", text: "Opções" }),
      opcaoSimples("identificar", "🔎 Identificar o filme com a IA — escreve a legenda e traz a capa (pôster) do TMDB"),
      opcaoSimples("usarCapa", "🖼 Usar o pôster oficial do TMDB como capa do Reel"),
      opcaoSimples("agendarComPoucaCerteza", "Agendar mesmo com pouca certeza (menos de " + CONFIANCA_MINIMA + "%)"),
      el("label", { className: "cr-opcao" }, [
        el("span", { text: "Vídeos ao mesmo tempo: " }),
        select,
      ]),
      el("div", { style: "display:flex;flex-direction:column;gap:4px" }, [
        el("span", { className: "cr-opcao", text: "Modelo de legenda (quando a IA está desligada ou falha)" }),
        modelo,
        el("span", { className: "cr-dica", text: "Marcadores: {titulo} · {ano} · {nome}. Podes editar a legenda de cada vídeo em baixo, mesmo depois de agendado." }),
      ]),
      app && typeof app.abrirConfiguracoes === "function"
        ? el("div", { className: "cr-acoes" }, [
            el("button", {
              type: "button",
              className: "cr-btn cr-sec cr-mini",
              onClick: function () {
                app.abrirConfiguracoes();
              },
            }, ["Abrir configurações"]),
            el("button", {
              type: "button",
              className: "cr-btn cr-sec cr-mini",
              onClick: function () {
                app.abrirAgendador();
              },
            }, ["Ver a fila no Agendador"]),
          ])
        : null,
    ]);
  }

  function desenharItem(it) {
    var filhos = [];

    filhos.push(
      el("div", { className: "cr-linha" }, [
        el("span", { className: "cr-nome", text: it.nome, title: it.nome }),
        el("span", {
          className: "cr-peso",
          text: (it.duracao ? duracaoLegivel(it.duracao) + " · " : "") + tamanho(it.bytes),
        }),
        el("span", { className: "cr-selo " + it.estado, text: NOMES_ESTADO[it.estado] || it.estado }),
      ])
    );

    if (it.estado === "a_processar") {
      filhos.push(
        el("div", { className: "cr-barra" }, [
          el("div", { style: "width:" + Math.round((Number(it.progresso) || 0) * 100) + "%" }),
        ]),
        el("span", { className: "cr-det", text: it.passo || "A tratar…" })
      );
    }

    var capa = it.poster
      ? el("img", { className: "cr-capa", src: it.poster, alt: "", loading: "lazy" })
      : el("div", { className: "cr-capa-vazio" });

    var dados = [];
    if (it.titulo) {
      dados.push(
        el("div", { className: "cr-filme", text: it.titulo + (it.ano ? " (" + it.ano + ")" : "") })
      );
    }
    if (it.estado === "agendado" && it.horario) {
      dados.push(el("div", { className: "cr-meta", text: "📅 " + horarioLegivel(it.horario) }));
    }
    if (it.titulo && it.confianca) {
      dados.push(el("div", { className: "cr-meta", text: it.confianca + "% de certeza da IA" }));
    }
    if (it.poster) {
      dados.push(el("div", { className: "cr-meta", text: "🖼 Capa: pôster do TMDB" }));
    }
    if (it.erro) {
      dados.push(el("div", { className: "cr-det " + it.estado, text: it.erro }));
    }
    if (it.aviso) {
      dados.push(el("div", { className: "cr-det revisar", text: it.aviso }));
    }

    if (!it.invalido) {
      var legenda = el("textarea", {
        className: "cr-legenda",
        rows: "3",
        spellcheck: "false",
        readonly: it.estado === "a_processar" || null,
        placeholder: "Legenda deste Reel…",
        value: it.legenda || "",
      });
      legenda.addEventListener("change", function () {
        guardarLegenda(it, legenda.value);
      });
      dados.push(legenda);
    }

    var acoes = el("div", { className: "cr-acoes" }, [
      (it.estado === "erro" || it.estado === "revisar") && !it.invalido &&
        el("button", {
          type: "button",
          className: "cr-btn cr-sec cr-mini",
          onClick: function () {
            repetirItem(it.id);
          },
        }, ["🔄 Tentar de novo"]),
      it.estado === "revisar" &&
        el("button", {
          type: "button",
          className: "cr-btn cr-prim cr-mini",
          onClick: function () {
            estado.itens.forEach(function (x) {
              if (x.id === it.id) x.legendaManual = true;
            });
            repetirItem(it.id);
            iniciar();
          },
        }, ["Agendar mesmo assim"]),
      it.estado !== "a_processar" &&
        el("button", {
          type: "button",
          className: "cr-btn cr-sec cr-mini",
          onClick: function () {
            removerItem(it.id);
          },
        }, ["🗑 Remover"]),
    ]);
    dados.push(acoes);

    filhos.push(el("div", { className: "cr-corpo" }, [capa, el("div", { className: "cr-dados" }, dados)]));

    return el("li", { className: "cr-item" }, filhos);
  }

  /**
   * Está alguém a escrever dentro do painel? Aí o painel não é reconstruído
   * (perderia o texto a meio e o foco). Clicar num botão ou numa caixa não
   * conta: esses têm de continuar a redesenhar.
   */
  function aEscreverDentro() {
    if (!raiz || !document.activeElement) return false;
    var a = document.activeElement;
    if (!raiz.contains(a)) return false;
    if (a.tagName === "TEXTAREA") return true;
    if (a.tagName === "INPUT") return !/^(checkbox|radio|button|submit|file|range)$/i.test(a.type || "");
    return false;
  }

  function desenhar() {
    if (!raiz) return;
    if (aEscreverDentro() && estado.aCorrer === false) {
      // Não reconstrói enquanto o utilizador escreve (perderia o foco).
      atualizarResumo();
      return;
    }
    var app = ambiente.app();
    var conta = (estado.aCorrer && estado.conta) || (app && app.account) || null;
    var falta = faltaConfigurar();
    var nPend = contar("pendente");

    raiz.textContent = "";

    raiz.appendChild(
      el("div", { className: "cr-topo" }, [
        el("h2", { text: "⚡ Agendamento rápido" }),
        el("span", { className: "cr-selo", text: "sem edição · legenda + capa" }),
      ])
    );

    raiz.appendChild(
      el("p", {
        className: "cr-sub",
        text:
          "Junta os vídeos JÁ EDITADOS e o app agenda-os em lote na fila " +
          (conta && conta.name ? "de " + conta.name : "da conta ativa") +
          ", um em cada horário livre. O ficheiro original vai tal e qual: não há corte, nem reconversão, " +
          "nem texto por cima — por isso não demora e não gasta o motor de vídeo.",
      })
    );

    if (falta) {
      var avisoFalta = el("div", { className: "cr-aviso erro" }, [falta]);
      if (app && typeof app.abrirConfiguracoes === "function" && /configura/i.test(falta)) {
        avisoFalta.appendChild(document.createTextNode(" "));
        avisoFalta.appendChild(
          el("button", {
            type: "button",
            className: "cr-btn cr-sec cr-mini",
            onClick: function () {
              app.abrirConfiguracoes();
            },
          }, ["Abrir configurações"])
        );
      }
      raiz.appendChild(avisoFalta);
    }

    if (aviso.texto) {
      raiz.appendChild(el("div", { className: "cr-aviso " + (aviso.tipo === "erro" ? "erro" : "ok") }, [aviso.texto]));
    }

    raiz.appendChild(zonaDeLargar());
    raiz.appendChild(blocoOpcoes());

    raiz.appendChild(
      el("div", { className: "cr-acoes" }, [
        el("span", { className: "cr-resumo", id: "cr-resumo" }),
        estado.aCorrer
          ? el("button", {
              type: "button",
              className: "cr-btn cr-sec",
              onClick: parar,
            }, ["⏹ Parar"])
          : el("button", {
              type: "button",
              className: "cr-btn cr-prim",
              disabled: !nPend || null,
              onClick: iniciar,
            }, ["🚀 Agendar " + (nPend || "")]),
        el("button", {
          type: "button",
          className: "cr-btn cr-sec",
          disabled: !estado.itens.length || null,
          onClick: limparConcluidos,
        }, ["🧹 Limpar concluídos"]),
      ])
    );

    if (!estado.itens.length) {
      raiz.appendChild(el("p", { className: "cr-vazio", text: "Ainda não há vídeos na lista." }));
    } else {
      var lista = el("ul", { className: "cr-lista" });
      estado.itens.forEach(function (it) {
        lista.appendChild(desenharItem(it));
      });
      raiz.appendChild(lista);
    }

    atualizarResumo();
  }

  function atualizarResumo() {
    var alvo = raiz && raiz.querySelector("#cr-resumo");
    if (!alvo) return;
    var partes = [];
    var p = contar("pendente");
    var a = contar("agendado");
    var e = contar("erro");
    var r = contar("revisar");
    if (p) partes.push(p + " na fila");
    if (a) partes.push(a + " agendado(s)");
    if (r) partes.push(r + " p/ rever");
    if (e) partes.push(e + " com erro");
    alvo.textContent = partes.join(" · ");
  }

  /* -------------------------------------------------------------- montar */

  /** Espera que o bundle crie o <div> da aba e monta o painel lá dentro. */
  function montar() {
    if (estado.montado) return true;
    if (typeof document === "undefined" || !document.getElementById) return false;
    var alvo = document.getElementById(ID_MONTE);
    if (!alvo) return false;
    garantirEstilo();
    raiz = el("div", { className: "cr-painel" });
    alvo.appendChild(raiz);
    estado.montado = true;
    desenhar();
    /**
     * A conta ativa escolhe-se na barra de cima, fora deste painel. Sem isto o
     * texto «…na fila de @conta» ficava desatualizado sem o utilizador perceber
     * por que conta ia agendar.
     */
    var ultimaConta = null;
    setInterval(function () {
      if (!raiz || !raiz.isConnected) return;
      var dono = document.getElementById(ID_MONTE);
      if (!dono || /hidden/.test(dono.className)) return;
      var app = ambiente.app();
      var conta = (estado.aCorrer && estado.conta) || (app && app.account) || null;
      var id = (conta && conta.id) || "";
      if (id === ultimaConta) return;
      ultimaConta = id;
      desenhar();
    }, 2000);
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

  window.CineRapido = {
    /** Monta o painel quando a aba existir (idempotente). */
    montar: montar,
    /** Junta ficheiros à lista (atalho usado pelos testes e por outros scripts). */
    abrir: function (ficheiros) {
      if (ficheiros && ficheiros.length) adicionarFicheiros(ficheiros);
      desenhar();
    },
    iniciar: iniciar,
    parar: parar,
    /** Só para os testes (tools/test-agendamento-rapido.mjs). */
    _interno: {
      ambiente: ambiente,
      estado: estado,
      adicionarFicheiros: adicionarFicheiros,
      processarItem: processarItem,
      iniciar: iniciar,
      parar: parar,
      desenhar: desenhar,
      montar: montar,
      lerVideoNoNavegador: lerVideoNoNavegador,
      aplicarModelo: aplicarModelo,
      tituloDoNome: tituloDoNome,
      guardarLegenda: guardarLegenda,
      faltaConfigurar: faltaConfigurar,
      horarioLegivel: horarioLegivel,
      duracaoLegivel: duracaoLegivel,
      MAX_SIMULTANEOS: MAX_SIMULTANEOS,
      CONFIANCA_MINIMA: CONFIANCA_MINIMA,
      MIN_SEGUNDOS: MIN_SEGUNDOS,
    },
  };
})();
