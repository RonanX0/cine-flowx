/*
 * 📦 UPLOAD EM MASSA — CineClip
 * ---------------------------------------------------------------------------
 * Escolhes vários vídeos de uma vez e, para cada um, o app faz sozinho o que o
 * Estúdio faz passo a passo:
 *
 *   1. lê o vídeo e usa só os primeiros 90 segundos;
 *   2. identifica o filme/série com a IA (NVIDIA/Gemini) + TMDB;
 *   3. cria um gancho (texto do topo) com a IA a partir da cena;
 *   4. limpa os metadados e formata em 9:16 com o gancho (FFmpeg);
 *   5. gera a legenda com a IA;
 *   6. coloca o Reel na fila do Agendador no próximo horário livre da conta ativa.
 *
 * Os vídeos são tratados um de cada vez (o FFmpeg do navegador só faz um de cada
 * vez). Se a IA não tiver certeza do filme (confiança < 65%), o vídeo não é
 * agendado — fica marcado para rever no Estúdio — a não ser que ligues a opção
 * "Agendar mesmo com pouca certeza".
 *
 * Este ficheiro é código legível de propósito: o resto do app vive num bundle
 * compilado. A ligação ao bundle são dois objetos que ele publica em `window`
 * (patch tools/patches/27-lote-ponte):
 *   • window.CineClipCore   — as funções internas (IA, FFmpeg, fila);
 *   • window.__CineClipApp  — o estado atual do app (definições, conta ativa…).
 *
 * API pública: window.CineLote.abrir(ficheiros?) · window.CineLote.fechar()
 */
(function () {
  "use strict";

  if (window.CineLote) return;

  /* ----------------------------------------------------------- configuração */

  var MAX_SEGUNDOS = 90;
  var MAX_BYTES = 300 * 1024 * 1024;
  var EXTENSOES = ["mp4", "mov", "mkv", "webm", "avi"];
  var CONFIANCA_MINIMA = 65;
  var CHAVE_OPCOES = "cineclip.lote.opcoes";

  /* ---------------------------------------------------------------- estado */

  var estado = {
    itens: [],
    aCorrer: false,
    pararPedido: false,
    itemAtual: null,
    conta: null,
    opcoes: lerOpcoes(),
    aberto: false,
    links: { texto: "", aImportar: false, estado: "" },
  };

  var proximoId = 1;

  function lerOpcoes() {
    try {
      var bruto = window.localStorage.getItem(CHAVE_OPCOES);
      var o = bruto ? JSON.parse(bruto) : {};
      return { agendarComPoucaCerteza: !!o.agendarComPoucaCerteza };
    } catch (e) {
      return { agendarComPoucaCerteza: false };
    }
  }

  function gravarOpcoes() {
    try {
      window.localStorage.setItem(CHAVE_OPCOES, JSON.stringify(estado.opcoes));
    } catch (e) {}
  }

  /* --------------------------------------------- ligação ao app (bundle) */

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
    baixarLink: baixarLinkDoServidor,
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
      var limite = setTimeout(function () {
        fim(new Error("O navegador demorou demasiado a abrir o vídeo."));
      }, 20000);
      video.preload = "metadata";
      video.muted = true;
      video.onloadedmetadata = function () {
        fim(null, {
          largura: video.videoWidth || 0,
          altura: video.videoHeight || 0,
          duracao: Number.isFinite(video.duration) ? video.duration : 0,
        });
      };
      video.onerror = function () {
        fim(new Error("O navegador não consegue abrir este vídeo."));
      };
      video.src = url;
    });
  }

  /**
   * Pede ao servidor (/api/public/importar) o vídeo de um link do TikTok/Kwai.
   * Devolve um File pronto a entrar no lote.
   */
  async function baixarLinkDoServidor(link, aoProgresso) {
    var r;
    try {
      r = await fetch("/api/public/importar?url=" + encodeURIComponent(link));
    } catch (e) {
      throw new Error("Sem ligação ao servidor do CineClip.");
    }
    if (!r.ok) {
      var msg = "";
      try {
        msg = (await r.json()).error || "";
      } catch (e) {}
      if (r.status === 404 && !msg) msg = "A importação por link só funciona no site publicado na Vercel.";
      throw new Error(msg || "O servidor recusou o link (HTTP " + r.status + ").");
    }
    var total = Number(r.headers.get("content-length")) || 0;
    var partes = [];
    var recebidos = 0;
    if (r.body && r.body.getReader) {
      var leitor = r.body.getReader();
      for (;;) {
        var passo = await leitor.read();
        if (passo.done) break;
        partes.push(passo.value);
        recebidos += passo.value.length;
        if (aoProgresso) aoProgresso(recebidos, total);
      }
    } else {
      partes.push(new Uint8Array(await r.arrayBuffer()));
    }
    if (!recebidos && !partes.reduce(function (s, p) { return s + (p.length || p.byteLength || 0); }, 0)) {
      throw new Error("O vídeo veio vazio.");
    }
    var ler = function (n) {
      try {
        return decodeURIComponent(r.headers.get(n) || "");
      } catch (e) {
        return r.headers.get(n) || "";
      }
    };
    var nome = ler("X-Cineclip-Nome") || "video_importado.mp4";
    return new File(partes, nome, { type: "video/mp4" });
  }

  /** Links do TikTok/Kwai num texto colado (um por linha, sem repetidos). */
  function extrairLinks(texto) {
    var vistos = {};
    return (String(texto || "").match(/https?:\/\/[^\s"'<>]+/gi) || [])
      .map(function (u) {
        return u.replace(/[).,;]+$/, "");
      })
      .filter(function (u) {
        var host = "";
        try {
          host = new URL(u).hostname.toLowerCase();
        } catch (e) {
          return false;
        }
        var ok = /(^|\.)(tiktok\.com|kwai\.com|kw\.ai|kwai\.net|kwai-pro\.com)$/.test(host);
        if (!ok || vistos[u]) return false;
        vistos[u] = true;
        return true;
      });
  }

  async function importarLinks() {
    if (estado.links.aImportar) return;
    var links = extrairLinks(estado.links.texto);
    if (!links.length) {
      estado.links.estado = "Cola pelo menos um link do TikTok ou do Kwai.";
      desenhar();
      return;
    }
    estado.links.aImportar = true;
    var ok = 0;
    for (var i = 0; i < links.length; i++) {
      var link = links[i];
      estado.links.estado = "A importar " + (i + 1) + "/" + links.length + "…";
      desenhar();
      try {
        var ficheiro = await ambiente.baixarLink(link, function (recebidos, total) {
          estado.links.estado =
            "A importar " + (i + 1) + "/" + links.length + "… " +
            (total ? Math.round((recebidos / total) * 100) + "%" : tamanho(recebidos));
          desenharEstadoLinks();
        });
        adicionarFicheiros([ficheiro]);
        var novo = estado.itens[estado.itens.length - 1];
        if (novo) novo.origem = link;
        ok++;
      } catch (e) {
        estado.itens.push({
          id: proximoId++,
          ficheiro: null,
          nome: link,
          bytes: 0,
          estado: "erro",
          invalido: true,
          passo: "",
          progresso: 0,
          erro: "Não importei este link: " + mensagemDeErro(e, "falha desconhecida."),
          resultado: null,
          origem: link,
        });
      }
    }
    estado.links.aImportar = false;
    estado.links.texto = ok === links.length ? "" : estado.links.texto;
    estado.links.estado = ok + " de " + links.length + " vídeo" + (links.length > 1 ? "s" : "") + " importado" + (ok === 1 ? "" : "s") + ".";
    desenhar();
  }

  function desenharEstadoLinks() {
    var alvo = raiz && raiz.querySelector(".cl-links-estado");
    if (alvo) alvo.textContent = estado.links.estado;
  }

  /* ------------------------------------------------------------ utilitários */

  function extensao(nome) {
    var partes = String(nome || "").split(".");
    return partes.length > 1 ? partes.pop().toLowerCase() : "";
  }

  function semExtensao(nome) {
    return String(nome || "video").replace(/\.[^.]+$/, "");
  }

  function tamanho(bytes) {
    var b = Number(bytes) || 0;
    if (b < 1048576) return Math.max(1, Math.round(b / 1024)) + " KB";
    return (b / 1048576).toFixed(1) + " MB";
  }

  /** "2026-10-14T12:00" → "14/10 às 12:00" */
  function horarioLegivel(valor) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(valor || ""));
    return m ? m[3] + "/" + m[2] + " às " + m[4] + ":" + m[5] : String(valor || "");
  }

  function mensagemDeErro(e, alternativa) {
    var texto = e && e.message ? e.message : e ? String(e) : "";
    return texto || alternativa || "Erro desconhecido.";
  }

  function erroComTipo(mensagem, tipo) {
    var e = new Error(mensagem);
    e.tipo = tipo;
    return e;
  }

  /* ------------------------------------------------------------- a fila */

  /** Junta ficheiros à lista. Devolve quantos entraram. */
  function adicionarFicheiros(lista) {
    var ficheiros = Array.prototype.slice.call(lista || []);
    var entraram = 0;
    ficheiros.forEach(function (f) {
      if (!f) return;
      var item = {
        id: proximoId++,
        ficheiro: f,
        nome: f.name || "video.mp4",
        bytes: f.size || 0,
        estado: "pendente",
        passo: "",
        progresso: 0,
        erro: "",
        resultado: null,
      };
      var ext = extensao(item.nome);
      if (EXTENSOES.indexOf(ext) === -1) {
        item.estado = "erro";
        item.invalido = true;
        item.erro = "Formato não suportado (." + (ext || "?") + "). Usa mp4, mov, mkv, webm ou avi.";
      } else if (item.bytes > MAX_BYTES) {
        item.estado = "erro";
        item.invalido = true;
        item.erro = "Ficheiro demasiado grande (" + tamanho(item.bytes) + "). Máximo: 300 MB.";
      } else {
        entraram++;
      }
      estado.itens.push(item);
    });
    desenhar();
    return entraram;
  }

  function removerItem(id) {
    estado.itens = estado.itens.filter(function (it) {
      return it.id !== id || it === estado.itemAtual;
    });
    desenhar();
  }

  function repetirItem(id) {
    estado.itens.forEach(function (it) {
      if (it.id === id && it !== estado.itemAtual && !it.invalido) {
        it.estado = "pendente";
        it.erro = "";
        it.passo = "";
        it.progresso = 0;
        it.resultado = null;
      }
    });
    desenhar();
  }

  function limparConcluidos() {
    estado.itens = estado.itens.filter(function (it) {
      return it.estado !== "agendado";
    });
    desenhar();
  }

  function pendentes() {
    return estado.itens.filter(function (it) {
      return it.estado === "pendente";
    });
  }

  /** O que falta configurar para o modo automático (null quando está tudo). */
  function faltaConfigurar() {
    var core = ambiente.core();
    var app = ambiente.app();
    if (!core || !app) return "O app ainda está a carregar. Tenta de novo dentro de alguns segundos.";
    var s = app.settings || {};
    var temIA = !!String(s.nvidiaKey || "").trim() || !!String(s.geminiKey || "").trim();
    if (!temIA) return "Adiciona a tua chave NVIDIA ou Google Gemini nas configurações — a IA identifica o filme e cria o gancho e a legenda.";
    if (!String(s.tmdbKey || "").trim()) return "Adiciona a tua chave TMDB nas configurações — é ela que confirma o filme e traz o pôster e a sinopse.";
    if (!app.account || !app.account.id) return "Escolhe uma conta do Instagram no topo do app.";
    return null;
  }

  /* ------------------------------------------------- processar um vídeo */

  function definirPasso(item, passo, progresso) {
    item.passo = passo;
    if (typeof progresso === "number") item.progresso = progresso;
    desenhar();
  }

  /**
   * Leva um vídeo do ficheiro original até à fila do Agendador.
   * Lança um erro (com `tipo`) quando não pode continuar.
   */
  async function processarItem(item, conta) {
    var core = ambiente.core();
    var app = ambiente.app();
    var s = app.settings || {};
    var ficheiro = item.ficheiro;

    /* 1. Ler o vídeo ------------------------------------------------------ */
    definirPasso(item, "A ler o vídeo…", 0.02);
    var info = await ambiente.lerVideo(ficheiro);
    if (!info.largura || !info.altura) {
      throw erroComTipo(
        "O navegador abre o som mas não a imagem deste vídeo (codec H.265/HEVC, comum em vídeos baixados do TikTok). Converte-o para H.264 e volta a enviar.",
        "codec"
      );
    }
    var duracao = 0;
    var tituloMetadados = "";
    try {
      var meta = await core.lerMetadados(ficheiro);
      duracao = Number(meta && meta.duration) || 0;
      var campo = ((meta && meta.fields) || []).find(function (f) {
        return f && f.label === "Título";
      });
      tituloMetadados = campo ? campo.value : "";
    } catch (e) {}
    if (!duracao) duracao = Number(info.duracao) || 0;
    if (!duracao) throw erroComTipo("Não consegui ler a duração do vídeo.", "leitura");
    var fim = Math.min(MAX_SEGUNDOS, duracao);
    if (fim < 3) throw erroComTipo("O vídeo tem menos de 3 segundos (o Instagram não aceita).", "leitura");

    var corte = { top: 0, bottom: 0, vw: info.largura, vh: info.altura };
    try {
      var barras = await core.detetarBarras(ficheiro, 0, fim);
      if (barras && barras.vh) {
        corte = {
          top: barras.y,
          bottom: barras.vh - barras.y - barras.h,
          vw: info.largura,
          vh: info.altura,
        };
      }
    } catch (e) {}

    /* 2. Identificar o filme --------------------------------------------- */
    definirPasso(item, "A identificar o filme…", 0.1);
    var temGemini = !!String(s.geminiKey || "").trim();
    var quadros = await core.quadros(ficheiro, 0, fim, corte);
    var audio = null;
    if (temGemini) {
      try {
        audio = await core.audio(ficheiro, 0, fim);
      } catch (e) {
        audio = null;
      }
    }
    var ia = await core.identificar(s.nvidiaKey, quadros, s.lang, {
      fileName: ficheiro.name,
      metaTitle: tituloMetadados,
      userHint: "",
      geminiKey: s.geminiKey,
      audioClip: audio,
    });
    if (!ia || (!ia.titulo && !(ia.atores && ia.atores.length))) {
      throw erroComTipo("A IA não conseguiu identificar o filme deste clipe.", "identificacao");
    }
    var filme = await core.procurarTmdb(s.tmdbKey, ia);
    if (!filme) {
      throw erroComTipo(
        'Não encontrei "' + (ia.titulo || ia.titulo_original || "o filme") + '" no TMDB.',
        "identificacao"
      );
    }
    var confianca = Number(ia.confianca) || 0;
    item.resultado = { titulo: filme.title, ano: filme.year, confianca: confianca };
    if (confianca < CONFIANCA_MINIMA && !estado.opcoes.agendarComPoucaCerteza) {
      throw erroComTipo(
        'A IA acha que é "' + filme.title + (filme.year ? " (" + filme.year + ")" : "") + '", mas só com ' +
          confianca + "% de certeza. Confere no Estúdio ou liga “Agendar mesmo com pouca certeza”.",
        "revisar"
      );
    }

    /* 3. Gancho ------------------------------------------------------------ */
    definirPasso(item, "A criar o gancho…", 0.2);
    var cena = ia.cena || "";
    var gancho = (ia.ganchos || []).find(function (g) {
      return g && String(g).trim();
    });
    if (!gancho) {
      try {
        var g = await core.gerarGancho(s.nvidiaKey, quadros, s.lang, filme.title, s.geminiKey, audio);
        gancho = ((g && g.ganchos) || []).find(function (x) {
          return x && String(x).trim();
        });
        if (!cena && g && g.cena) cena = g.cena;
      } catch (e) {}
    }
    gancho = String(gancho || s.overlayText || core.ganchoPadrao || "").trim();
    item.resultado.gancho = gancho;

    /* 4. Processar o vídeo -------------------------------------------------- */
    definirPasso(item, "A processar o vídeo… 0%", 0.25);
    var blob = await core.processar(ficheiro, 0, fim, s.resolution, gancho, function (fracao) {
      var pct = Math.max(0, Math.min(1, Number(fracao) || 0));
      definirPasso(item, "A processar o vídeo… " + Math.round(pct * 100) + "%", 0.25 + pct * 0.6);
    }, corte);
    if (!blob || !blob.size) throw erroComTipo("O FFmpeg não devolveu o vídeo processado.", "processamento");

    /* 5. Legenda ------------------------------------------------------------- */
    definirPasso(item, "A escrever a legenda…", 0.88);
    var legenda = await core.gerarLegenda(s.nvidiaKey, filme, s.lang, {
      cena: cena,
      hookText: gancho,
      geminiKey: s.geminiKey,
    });
    if (!legenda || !String(legenda).trim()) throw erroComTipo("A IA devolveu uma legenda vazia.", "legenda");
    try {
      core.guardarHistorico({ title: filme.title, year: filme.year, caption: legenda, date: ambiente.agora() });
    } catch (e) {}

    /* 6. Agendar ------------------------------------------------------------- */
    definirPasso(item, "A agendar…", 0.95);
    var fila = await core.lerFila();
    var horario = core.proximoHorario(fila, conta.dailySlots || [], conta.id);
    var base = semExtensao(ficheiro.name);
    var agora = ambiente.agora();
    var reel = {
      id: "reel_" + agora + "_" + Math.random().toString(36).slice(2, 6),
      accountId: conta.id,
      createdAt: agora,
      scheduledAt: horario,
      status: "scheduled",
      title: filme.title || base,
      originalTitle: filme.original,
      year: filme.year,
      poster: filme.poster,
      hookText: gancho,
      caption: core.limparLegenda(String(legenda)),
      videoBlob: blob,
      videoFileName: base + "_cineclip.mp4",
      videoSize: blob.size || 0,
      platforms: ["instagram"],
    };
    await core.guardarNaFila(reel);
    item.resultado.horario = horario;
    item.resultado.reelId = reel.id;
    return reel;
  }

  /* --------------------------------------------------------- o ciclo */

  var sincronizacao = Promise.resolve();

  function pedirSincronizacao() {
    var app = ambiente.app();
    try {
      if (app && typeof app.atualizarFila === "function") app.atualizarFila();
    } catch (e) {}
    try {
      if (app && typeof app.sincronizar === "function") {
        var p = app.sincronizar();
        if (p && typeof p.then === "function") sincronizacao = p.catch(function () {});
      }
    } catch (e) {}
  }

  async function iniciar() {
    if (estado.aCorrer) return;
    var falta = faltaConfigurar();
    if (falta) {
      avisar(falta, "erro");
      desenhar();
      return;
    }
    if (!pendentes().length) {
      avisar("Adiciona vídeos primeiro.", "erro");
      return;
    }
    var app = ambiente.app();
    estado.conta = app.account;
    estado.aCorrer = true;
    estado.pararPedido = false;
    avisar("");
    desenhar();
    try {
      var item;
      while (!estado.pararPedido && (item = pendentes()[0])) {
        estado.itemAtual = item;
        item.estado = "a_processar";
        item.erro = "";
        desenhar();
        try {
          await processarItem(item, estado.conta);
          item.estado = "agendado";
          item.passo = "";
          item.progresso = 1;
          pedirSincronizacao();
        } catch (e) {
          if (estado.pararPedido && e && e.tipo !== "codec") {
            item.estado = "pendente";
            item.passo = "";
            item.progresso = 0;
          } else {
            item.estado = e && e.tipo === "revisar" ? "revisar" : "erro";
            item.erro = mensagemDeErro(e, "Falha ao processar este vídeo.");
            item.passo = "";
          }
        }
        estado.itemAtual = null;
        desenhar();
      }
    } finally {
      estado.aCorrer = false;
      estado.itemAtual = null;
      var feitos = estado.itens.filter(function (it) {
        return it.estado === "agendado";
      }).length;
      if (estado.pararPedido) avisar("Lote parado. Os vídeos que faltam ficaram na lista.", "info");
      else if (feitos) avisar("Lote concluído. Os Reels estão no Agendador e vão para a nuvem durável.", "ok");
      estado.pararPedido = false;
      desenhar();
    }
    await sincronizacao;
  }

  function parar() {
    if (!estado.aCorrer) return;
    estado.pararPedido = true;
    var core = ambiente.core();
    var item = estado.itemAtual;
    // Se estiver a meio do FFmpeg, interrompe já; nas chamadas à IA espera que acabem.
    if (item && /processar/.test(item.passo) && core && typeof core.cancelarProcessamento === "function") {
      try {
        core.cancelarProcessamento();
      } catch (e) {}
    }
    desenhar();
  }

  /* ------------------------------------------------------------------ UI */

  var raiz = null;
  var pilula = null;
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
    ".cl-overlay{position:fixed;inset:0;z-index:9990;background:rgba(0,0,0,.66);display:flex;align-items:flex-start;justify-content:center;padding:24px 16px;overflow-y:auto;font-family:inherit}",
    ".cl-painel{width:100%;max-width:760px;background:var(--card,#1c1c22);color:var(--foreground,#f4f4f6);border:1px solid var(--border,rgba(255,255,255,.09));border-radius:16px;box-shadow:0 24px 64px rgba(0,0,0,.5)}",
    ".cl-topo{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 20px;border-bottom:1px solid var(--border,rgba(255,255,255,.09))}",
    ".cl-topo h2{margin:0;font-size:18px;font-weight:700}",
    ".cl-x{background:none;border:0;color:inherit;font-size:22px;line-height:1;cursor:pointer;padding:4px 8px;border-radius:8px}",
    ".cl-x:hover{background:var(--muted,#2a2a31)}",
    ".cl-corpo{padding:18px 20px;display:flex;flex-direction:column;gap:14px}",
    ".cl-sub{margin:0;font-size:13px;line-height:1.5;color:var(--muted-foreground,#a3a3ad)}",
    ".cl-zona{display:flex;flex-direction:column;align-items:center;gap:10px;padding:22px 16px;border:2px dashed var(--border,rgba(255,255,255,.15));border-radius:12px;text-align:center;cursor:pointer;transition:background .15s,border-color .15s}",
    ".cl-zona:hover,.cl-zona.cl-sobre{border-color:var(--primary,#e5484d);background:rgba(229,72,77,.08)}",
    ".cl-zona strong{font-size:15px}",
    ".cl-zona span{font-size:12px;color:var(--muted-foreground,#a3a3ad)}",
    ".cl-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border-radius:8px;padding:9px 16px;font-size:14px;font-weight:600;cursor:pointer;border:1px solid transparent;font-family:inherit}",
    ".cl-btn[disabled]{opacity:.5;cursor:not-allowed}",
    ".cl-prim{background:var(--primary,#e5484d);color:#fff}",
    ".cl-sec{background:transparent;color:inherit;border-color:var(--border,rgba(255,255,255,.15))}",
    ".cl-sec:hover:not([disabled]){background:var(--muted,#2a2a31)}",
    ".cl-mini{padding:4px 10px;font-size:12px;font-weight:500}",
    ".cl-links{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--border,rgba(255,255,255,.09));border-radius:12px}",
    ".cl-links strong{font-size:14px}",
    ".cl-texto{width:100%;box-sizing:border-box;resize:vertical;min-height:72px;border-radius:8px;border:1px solid var(--border,rgba(255,255,255,.15));background:var(--background,#141418);color:inherit;padding:8px 10px;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}",
    ".cl-texto:focus{outline:2px solid var(--primary,#e5484d);outline-offset:1px}",
    ".cl-opcao{display:flex;align-items:flex-start;gap:8px;font-size:13px;color:var(--muted-foreground,#a3a3ad);cursor:pointer}",
    ".cl-opcao input{margin-top:2px;accent-color:var(--primary,#e5484d)}",
    ".cl-aviso{font-size:13px;line-height:1.45;padding:10px 12px;border-radius:10px;border:1px solid var(--border,rgba(255,255,255,.1))}",
    ".cl-aviso.erro{border-color:rgba(229,72,77,.5);background:rgba(229,72,77,.1)}",
    ".cl-aviso.ok{border-color:rgba(48,164,108,.5);background:rgba(48,164,108,.1)}",
    ".cl-lista{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}",
    ".cl-item{border:1px solid var(--border,rgba(255,255,255,.09));border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:6px;background:var(--background,#141418)}",
    ".cl-linha{display:flex;align-items:center;gap:8px;min-width:0}",
    ".cl-nome{flex:1;min-width:0;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".cl-peso{font-size:12px;color:var(--muted-foreground,#a3a3ad);white-space:nowrap}",
    ".cl-selo{font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;white-space:nowrap;background:var(--muted,#2a2a31)}",
    ".cl-selo.agendado{background:rgba(48,164,108,.2);color:#4cc38a}",
    ".cl-selo.erro{background:rgba(229,72,77,.2);color:#ff6369}",
    ".cl-selo.revisar{background:rgba(245,166,35,.2);color:#f5a623}",
    ".cl-selo.a_processar{background:rgba(229,72,77,.25);color:#fff}",
    ".cl-det{font-size:12px;line-height:1.45;color:var(--muted-foreground,#a3a3ad);word-break:break-word}",
    ".cl-det.erro{color:#ff8b8f}",
    ".cl-det.revisar{color:#f5c26b}",
    ".cl-barra{height:6px;border-radius:999px;background:var(--muted,#2a2a31);overflow:hidden}",
    ".cl-barra > div{height:100%;background:var(--primary,#e5484d);transition:width .3s}",
    ".cl-acoes{display:flex;flex-wrap:wrap;gap:6px}",
    ".cl-rodape{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;padding:14px 20px;border-top:1px solid var(--border,rgba(255,255,255,.09))}",
    ".cl-resumo{font-size:13px;color:var(--muted-foreground,#a3a3ad)}",
    ".cl-botoes{display:flex;flex-wrap:wrap;gap:8px}",
    ".cl-pilula{position:fixed;right:16px;bottom:16px;z-index:9989;background:var(--card,#1c1c22);color:var(--foreground,#f4f4f6);border:1px solid var(--primary,#e5484d);border-radius:999px;padding:10px 16px;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.4);font-family:inherit}",
    "@media (max-width:560px){.cl-overlay{padding:0}.cl-painel{border-radius:0;min-height:100%}.cl-rodape{flex-direction:column;align-items:stretch}.cl-botoes .cl-btn{flex:1}}",
  ].join("\n");

  function garantirEstilo() {
    if (document.getElementById("cineclip-lote-css")) return;
    var st = document.createElement("style");
    st.id = "cineclip-lote-css";
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  var NOMES_ESTADO = {
    pendente: "Na fila",
    a_processar: "A processar",
    agendado: "Agendado",
    erro: "Erro",
    revisar: "Rever",
  };

  function contar(nomeEstado) {
    return estado.itens.filter(function (it) {
      return it.estado === nomeEstado;
    }).length;
  }

  function escolherFicheiros() {
    var input = el("input", { type: "file", multiple: true, accept: ".mp4,.mov,.mkv,.webm,.avi,video/*", style: "display:none" });
    input.addEventListener("change", function () {
      if (input.files && input.files.length) adicionarFicheiros(input.files);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  }

  function desenharItem(it) {
    var app = ambiente.app();
    var linha = el("div", { className: "cl-linha" }, [
      el("span", { className: "cl-nome", title: it.nome, text: it.nome }),
      el("span", { className: "cl-peso", text: tamanho(it.bytes) }),
      el("span", { className: "cl-selo " + it.estado, text: NOMES_ESTADO[it.estado] || it.estado }),
    ]);
    var partes = [linha];

    if (it.estado === "a_processar") {
      partes.push(el("div", { className: "cl-det", text: it.passo || "A começar…" }));
      partes.push(el("div", { className: "cl-barra" }, [el("div", { style: "width:" + Math.round((it.progresso || 0) * 100) + "%" })]));
    } else if (it.estado === "agendado" && it.resultado) {
      var r = it.resultado;
      partes.push(
        el("div", {
          className: "cl-det",
          text:
            "🎬 " + r.titulo + (r.ano ? " (" + r.ano + ")" : "") +
            " · 📅 " + horarioLegivel(r.horario) +
            (r.gancho ? " · “" + r.gancho + "”" : ""),
        })
      );
    } else if (it.estado === "erro" || it.estado === "revisar") {
      partes.push(el("div", { className: "cl-det " + it.estado, text: it.erro }));
    }

    var acoes = [];
    if (!estado.aCorrer || it !== estado.itemAtual) {
      if (it.estado === "erro" || it.estado === "revisar") {
        if (!it.invalido) {
          acoes.push(el("button", { type: "button", className: "cl-btn cl-sec cl-mini", disabled: estado.aCorrer || null, onClick: function () { repetirItem(it.id); } }, ["Tentar de novo"]));
        }
        if (app && typeof app.abrirNoEstudio === "function" && !it.invalido) {
          acoes.push(el("button", { type: "button", className: "cl-btn cl-sec cl-mini", disabled: estado.aCorrer || null, onClick: function () { fechar(); app.abrirNoEstudio(it.ficheiro); } }, ["Abrir no Estúdio"]));
        }
      }
      if (it.estado !== "a_processar" && it.estado !== "agendado") {
        acoes.push(el("button", { type: "button", className: "cl-btn cl-sec cl-mini", onClick: function () { removerItem(it.id); } }, ["Remover"]));
      }
    }
    if (acoes.length) partes.push(el("div", { className: "cl-acoes" }, acoes));
    return el("li", { className: "cl-item", "data-estado": it.estado }, partes);
  }

  function desenhar() {
    desenharPilula();
    if (!raiz || !estado.aberto) return;
    var app = ambiente.app();
    var conta = (estado.aCorrer && estado.conta) || (app && app.account) || null;
    var falta = faltaConfigurar();
    var nPend = contar("pendente");

    var zona = el("div", {
      className: "cl-zona",
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
        zona.classList.add("cl-sobre");
      },
      onDragleave: function () {
        zona.classList.remove("cl-sobre");
      },
      onDrop: function (e) {
        e.preventDefault();
        zona.classList.remove("cl-sobre");
        if (e.dataTransfer && e.dataTransfer.files) adicionarFicheiros(e.dataTransfer.files);
      },
    }, [
      el("strong", { text: "Arrasta os vídeos para aqui ou clica para escolher" }),
      el("span", { text: "Vários de uma vez · mp4, mov, mkv, webm ou avi · até 300 MB cada" }),
    ]);

    var corpo = [
      el("p", {
        className: "cl-sub",
        text:
          "Para cada vídeo o app usa até 90 segundos, identifica o filme, cria o gancho e a legenda com IA e agenda o Reel no próximo horário livre" +
          (conta && conta.name ? " de " + conta.name : "") + ". Um vídeo de cada vez. Podes fechar este painel e ver o Agendador enquanto isso, mas não processes outro vídeo no Estúdio até o lote acabar (o FFmpeg do navegador é só um).",
      }),
    ];
    if (falta && !estado.aCorrer) {
      var avisoFalta = el("div", { className: "cl-aviso erro" }, [falta]);
      if (app && typeof app.abrirConfiguracoes === "function" && /configura/.test(falta)) {
        avisoFalta.appendChild(document.createTextNode(" "));
        avisoFalta.appendChild(el("button", { type: "button", className: "cl-btn cl-sec cl-mini", onClick: function () { fechar(); app.abrirConfiguracoes(); } }, ["Abrir configurações"]));
      }
      corpo.push(avisoFalta);
    }
    if (aviso.texto) corpo.push(el("div", { className: "cl-aviso " + aviso.tipo, role: "status", text: aviso.texto }));
    corpo.push(zona);

    var areaLinks = el("textarea", {
      className: "cl-texto",
      rows: "3",
      placeholder: "https://www.tiktok.com/@perfil/video/…\nhttps://www.kwai.com/@perfil/video/…",
      "aria-label": "Links do TikTok ou do Kwai, um por linha",
      disabled: estado.links.aImportar || null,
    });
    areaLinks.value = estado.links.texto;
    areaLinks.addEventListener("input", function () {
      estado.links.texto = areaLinks.value;
    });
    corpo.push(el("div", { className: "cl-links" }, [
      el("strong", { text: "🔗 Importar do TikTok ou do Kwai" }),
      el("span", { className: "cl-sub", text: "Cola um link por linha. Os vídeos entram na lista acima. Só vídeos que os autores autorizaram repostar." }),
      areaLinks,
      el("div", { className: "cl-linha" }, [
        el("button", {
          type: "button",
          className: "cl-btn cl-sec",
          disabled: estado.links.aImportar || null,
          onClick: function () {
            estado.links.texto = areaLinks.value;
            importarLinks();
          },
        }, [estado.links.aImportar ? "A importar…" : "Importar links"]),
        el("span", { className: "cl-peso cl-links-estado", role: "status", text: estado.links.estado }),
      ]),
    ]));

    var caixa = el("input", { type: "checkbox", checked: estado.opcoes.agendarComPoucaCerteza || null });
    caixa.addEventListener("change", function () {
      estado.opcoes.agendarComPoucaCerteza = caixa.checked;
      gravarOpcoes();
    });
    corpo.push(el("label", { className: "cl-opcao" }, [
      caixa,
      el("span", { text: "Agendar mesmo quando a IA tem pouca certeza do filme (abaixo de " + CONFIANCA_MINIMA + "%). Desligado, esses vídeos ficam para rever." }),
    ]));

    if (estado.itens.length) {
      corpo.push(el("ul", { className: "cl-lista" }, estado.itens.map(desenharItem)));
    }

    var resumo = [];
    if (estado.itens.length) {
      resumo.push(estado.itens.length + " vídeo" + (estado.itens.length > 1 ? "s" : ""));
      if (contar("agendado")) resumo.push(contar("agendado") + " agendado" + (contar("agendado") > 1 ? "s" : ""));
      if (nPend) resumo.push(nPend + " na fila");
      if (contar("revisar")) resumo.push(contar("revisar") + " para rever");
      if (contar("erro")) resumo.push(contar("erro") + " com erro");
    }

    var botoes = [];
    if (contar("agendado") && !estado.aCorrer) {
      botoes.push(el("button", { type: "button", className: "cl-btn cl-sec", onClick: limparConcluidos }, ["Limpar agendados"]));
    }
    if (contar("agendado") && app && typeof app.abrirAgendador === "function") {
      botoes.push(el("button", { type: "button", className: "cl-btn cl-sec", onClick: function () { fechar(); app.abrirAgendador(); } }, ["Ver no Agendador"]));
    }
    if (estado.aCorrer) {
      botoes.push(el("button", { type: "button", className: "cl-btn cl-sec", disabled: estado.pararPedido || null, onClick: parar }, [estado.pararPedido ? "A parar…" : "Parar"]));
    } else {
      botoes.push(el("button", {
        type: "button",
        className: "cl-btn cl-prim",
        disabled: !nPend || !!falta || estado.links.aImportar || null,
        onClick: iniciar,
      }, [nPend ? "Começar (" + nPend + " vídeo" + (nPend > 1 ? "s" : "") + ")" : "Começar"]));
    }

    var painel = el("div", { className: "cl-painel", role: "dialog", "aria-modal": "true", "aria-labelledby": "cl-titulo" }, [
      el("div", { className: "cl-topo" }, [
        el("h2", { id: "cl-titulo", text: "📦 Upload em massa" }),
        el("button", { type: "button", className: "cl-x", "aria-label": "Fechar", onClick: fechar }, ["×"]),
      ]),
      el("div", { className: "cl-corpo" }, corpo),
      el("div", { className: "cl-rodape" }, [
        el("span", { className: "cl-resumo", text: resumo.join(" · ") }),
        el("div", { className: "cl-botoes" }, botoes),
      ]),
    ]);

    var rolagem = raiz.scrollTop;
    raiz.replaceChildren(painel);
    raiz.scrollTop = rolagem;
  }

  function desenharPilula() {
    var mostrar = estado.aCorrer && !estado.aberto;
    if (!mostrar) {
      if (pilula) {
        pilula.remove();
        pilula = null;
      }
      return;
    }
    if (!pilula) {
      pilula = el("button", { type: "button", className: "cl-pilula", onClick: function () { abrir(); } });
      document.body.appendChild(pilula);
    }
    var feitos = estado.itens.filter(function (it) {
      return it.estado !== "pendente" && it.estado !== "a_processar";
    }).length;
    var total = feitos + contar("pendente") + contar("a_processar");
    pilula.textContent = "📦 Upload em massa: " + Math.min(total, feitos + 1) + "/" + total + " — abrir";
  }

  function aoTeclar(e) {
    if (e.key === "Escape" && estado.aberto) fechar();
  }

  function abrir(ficheiros) {
    garantirEstilo();
    if (!raiz) {
      raiz = el("div", { className: "cl-overlay" });
      raiz.addEventListener("mousedown", function (e) {
        if (e.target === raiz) fechar();
      });
    }
    if (!raiz.isConnected) document.body.appendChild(raiz);
    estado.aberto = true;
    document.addEventListener("keydown", aoTeclar);
    if (ficheiros && ficheiros.length) adicionarFicheiros(ficheiros);
    else desenhar();
  }

  function fechar() {
    estado.aberto = false;
    document.removeEventListener("keydown", aoTeclar);
    if (raiz && raiz.isConnected) raiz.remove();
    desenhar();
  }

  window.addEventListener("beforeunload", function (e) {
    if (!estado.aCorrer) return;
    e.preventDefault();
    e.returnValue = "O upload em massa ainda está a correr.";
    return e.returnValue;
  });

  window.CineLote = {
    abrir: abrir,
    fechar: fechar,
    /** Só para os testes (tools/test-lote-massa.mjs). */
    _interno: {
      ambiente: ambiente,
      estado: estado,
      adicionarFicheiros: adicionarFicheiros,
      importarLinks: importarLinks,
      extrairLinks: extrairLinks,
      iniciar: iniciar,
      parar: parar,
      processarItem: processarItem,
      faltaConfigurar: faltaConfigurar,
      horarioLegivel: horarioLegivel,
      MAX_SEGUNDOS: MAX_SEGUNDOS,
      CONFIANCA_MINIMA: CONFIANCA_MINIMA,
    },
  };
})();
