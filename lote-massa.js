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
 * Os vídeos são tratados até 5 ao mesmo tempo (pool paralelo de Web Workers
 * do FFmpeg + IA). Se a IA não tiver certeza do filme (confiança < 65%), o vídeo não é
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

  /* -------------------------------------------------- hash perceptual (videohash-like) */
  // Gera um hash perceptual estável do conteúdo do vídeo a partir dos frames já
  // extraídos pelo core.quadros(). Inspirado no `videohash` (near-duplicate video
  // detection): cada frame é reduzido a uma grelha 8x8, comparado com a média de
  // luminância e convertido em bits. O hash resultante é o mesmo (ou muito
  // próximo) para vídeos idênticos/near-duplicate, mesmo com re-encode, resize,
  // watermark ou barras pretas adicionadas/removidas.
  // Devolve uma string hex (ou null se não for possível).
  function _carregarImagem(dataUrl) {
    return new Promise(function (resolve, reject) {
      var terminado = false;
      var timer = setTimeout(function () {
        if (terminado) return;
        terminado = true;
        reject(new Error("timeout"));
      }, 2500);
      try {
        var img = new Image();
        img.onload = function () {
          if (terminado) return;
          terminado = true;
          clearTimeout(timer);
          resolve(img);
        };
        img.onerror = function () {
          if (terminado) return;
          terminado = true;
          clearTimeout(timer);
          reject(new Error("img"));
        };
        img.src = dataUrl;
      } catch (e) {
        if (!terminado) {
          terminado = true;
          clearTimeout(timer);
          reject(e);
        }
      }
    });
  }

  async function hashPerceptualVideo(quadros) {
    try {
      // Em ambientes simulados (jsdom no servidor da nuvem ou testes) new Image()
      // não decodifica JPEGs nem dispara onload: salta logo sem bloquear o servidor.
      if (typeof window === "undefined" || !window.navigator || /jsdom/i.test(String(window.navigator.userAgent || ""))) {
        return null;
      }
      // quadros[0] é a colagem (collage); os restantes são frames individuais.
      var frames = (quadros || []).slice(1);
      if (frames.length < 2) return null; // frames reais são >= 6; placeholder (testes) não cacheia
      var bits = [];
      var framesValidos = 0;
      for (var i = 0; i < frames.length; i++) {
        var img = await _carregarImagem(frames[i]);
        var c = document.createElement("canvas");
        c.width = 8; c.height = 8;
        var ctx = c.getContext("2d");
        if (!ctx) return null;
        ctx.drawImage(img, 0, 0, 8, 8);
        var data = ctx.getImageData(0, 0, 8, 8).data;
        var lum = [];
        var soma = 0;
        var minL = 255;
        var maxL = 0;
        for (var p = 0; p < data.length; p += 4) {
          var l = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
          lum.push(l);
          soma += l;
          if (l < minL) minL = l;
          if (l > maxL) maxL = l;
        }
        if ((maxL - minL) < 8) continue;
        framesValidos++;
        var media = soma / (lum.length || 1);
        for (var q = 0; q < lum.length; q++) bits.push(lum[q] > media ? "1" : "0");
      }
      if (framesValidos < 3 || !bits.length) return null;
      // converte bits -> hex (4 bits por dígito)
      var hex = "";
      for (var b = 0; b + 4 <= bits.length; b += 4) {
        hex += parseInt(bits.slice(b, b + 4).join(""), 2).toString(16);
      }
      if (!hex || /^([0f])\1+$/i.test(hex)) return null;
      return hex;
    } catch (e) {
      return null;
    }
  }

  /** Assinatura binária rápida (início + meio + fim + tamanho) para ficheiros reais (>32 KB). */
  async function _assinaturaBinaria(ficheiro) {
    try {
      var tam = Number(ficheiro && ficheiro.size) || 0;
      if (tam <= 32768 || typeof ficheiro.slice !== "function") return null;
      var meio = Math.max(0, Math.floor(tam / 2) - 1024);
      var fim = Math.max(0, tam - 2048);
      var partes = await Promise.all([
        ficheiro.slice(0, 2048).arrayBuffer(),
        ficheiro.slice(meio, meio + 2048).arrayBuffer(),
        ficheiro.slice(fim, tam).arrayBuffer(),
      ]);
      var h1 = 2166136261 >>> 0;
      var h2 = 2166136261 >>> 0;
      for (var p = 0; p < partes.length; p++) {
        var u8 = new Uint8Array(partes[p]);
        for (var i = 0; i < u8.length; i += 2) {
          h1 = Math.imul(h1 ^ u8[i], 16777619) >>> 0;
          if (i + 1 < u8.length) h2 = Math.imul(h2 ^ u8[i + 1], 16777619) >>> 0;
        }
      }
      return "sig_" + tam.toString(36) + "_" + h1.toString(36) + "_" + h2.toString(36);
    } catch (e) {
      return null;
    }
  }

  /** Compara dois hashes perceptuais hexadecimais (distância de Hamming <= 4 bits). */
  function _hashesPerceptuaisIguais(a, b) {
    if (!a || !b || typeof a !== "string" || typeof b !== "string") return false;
    if (a === b) return true;
    if (a.length !== b.length || a.length < 16) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) {
      var x = (parseInt(a[i], 16) ^ parseInt(b[i], 16)) & 15;
      while (x) {
        diff += x & 1;
        x >>= 1;
      }
      if (diff > 4) return false;
    }
    return true;
  }

  /* --------------------------------------------- cache de identificação por hash */
  var CACHE_IDENT_CHAVE = "cineclip.ident.cache.v1";
  var CACHE_IDENT_TTL = 30 * 24 * 60 * 60 * 1000; // 30 dias
  var CACHE_IDENT_MAX = 200;

  function _lerCacheIdent() {
    try {
      var raw = (window.localStorage && window.localStorage.getItem(CACHE_IDENT_CHAVE)) || "{}";
      var obj = JSON.parse(raw);
      return (obj && typeof obj === "object") ? obj : {};
    } catch (e) { return {}; }
  }
  function _salvarCacheIdent(cache) {
    try { if (window.localStorage) window.localStorage.setItem(CACHE_IDENT_CHAVE, JSON.stringify(cache)); } catch (e) {}
  }
  function cacheIdentLer(hash) {
    if (!hash) return null;
    var cache = _lerCacheIdent();
    var e = cache[hash];
    if (!e) return null;
    if (!e.t || (Date.now() - e.t) > CACHE_IDENT_TTL) {
      delete cache[hash];
      _salvarCacheIdent(cache);
      return null;
    }
    return e.v || null;
  }
  function cacheIdentGuardar(hash, valor) {
    if (!hash || !valor) return;
    var cache = _lerCacheIdent();
    cache[hash] = { t: Date.now(), v: valor };
    var keys = Object.keys(cache);
    if (keys.length > CACHE_IDENT_MAX) {
      keys.sort(function (a, b) { return (cache[a].t || 0) - (cache[b].t || 0); });
      for (var i = 0; i < keys.length - CACHE_IDENT_MAX; i++) delete cache[keys[i]];
    }
    _salvarCacheIdent(cache);
  }

  /* ----------------------------------------------------------- configuração */

  var MAX_SEGUNDOS = 90;
  var MAX_SIMULTANEOS = 5;
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
    itensAtivos: [],
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
      var sim = Number(o.simultaneos);
      return {
        agendarComPoucaCerteza: !!o.agendarComPoucaCerteza,
        simultaneos: (sim >= 1 && sim <= MAX_SIMULTANEOS) ? Math.round(sim) : MAX_SIMULTANEOS,
        aoPartilhar: o.aoPartilhar === "aqui" || o.aoPartilhar === "pc" || o.aoPartilhar === "nuvem" ? o.aoPartilhar : "perguntar",
        processarLinksDoCelular: typeof o.processarLinksDoCelular === "boolean" ? o.processarLinksDoCelular : !eCelular(),
        botaoColar: o.botaoColar !== false,
        avisarLinkCopiado: o.avisarLinkCopiado !== false,
      };
    } catch (e) {
      return { agendarComPoucaCerteza: false, simultaneos: MAX_SIMULTANEOS, aoPartilhar: "perguntar", processarLinksDoCelular: !eCelular(), botaoColar: true, avisarLinkCopiado: true };
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
    /** ☁️ Nuvem na própria Vercel (api/nuvem.js): está configurada? */
    consultarNuvem: function () {
      return fetch("/api/nuvem", { cache: "no-store" }).then(function (r) {
        return r.ok ? r.json() : null;
      });
    },
    /** Acorda a nuvem da Vercel para processar os links pendentes (responde logo). */
    acordarNuvem: function () {
      return fetch("/api/nuvem", { method: "POST", keepalive: true });
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
      var esperaMs = (typeof document !== "undefined" && document.hidden) ? 60000 : 20000;
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
    var f = new File(partes, nome, { type: "video/mp4" });
    var pista = ler("X-Cineclip-Pistas") || ler("X-Cineclip-Titulo") || "";
    if (pista && !/^corte$/i.test(pista.trim())) f.pistaLink = pista.trim();
    return f;
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
        var chave = idDoLink(u);
        if (!ok || vistos[u] || vistos[chave]) return false;
        vistos[u] = true;
        vistos[chave] = true;
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
    var concluidos = 0;
    var resultados = new Array(links.length);
    var proximoIdx = 0;
    var limiteImp = Math.max(1, Math.min(MAX_SIMULTANEOS, Number(estado.opcoes && estado.opcoes.simultaneos) || MAX_SIMULTANEOS));
    estado.links.estado = "A importar 1/" + links.length + "…";
    desenhar();
    async function trabalhadorImportacao() {
      while (proximoIdx < links.length) {
        var idx = proximoIdx++;
        var link = links[idx];
        try {
          var ficheiro = await ambiente.baixarLink(link, function (recebidos, total) {
            estado.links.estado =
              "A importar " + Math.min(links.length, concluidos + 1) + "/" + links.length + "… " +
              (total ? Math.round((recebidos / total) * 100) + "%" : tamanho(recebidos));
            desenharEstadoLinks();
          });
          resultados[idx] = { ok: true, ficheiro: ficheiro, link: link };
          ok++;
        } catch (e) {
          resultados[idx] = { ok: false, erro: e, link: link };
        }
        concluidos++;
        if (concluidos < links.length) {
          estado.links.estado = "A importar " + (concluidos + 1) + "/" + links.length + "…";
          desenharEstadoLinks();
        }
      }
    }
    var nTrabImp = Math.min(limiteImp, links.length);
    var listaTrabImp = [];
    for (var ti = 0; ti < nTrabImp; ti++) listaTrabImp.push(trabalhadorImportacao());
    await Promise.all(listaTrabImp);
    var linksFalhados = [];
    for (var ri = 0; ri < resultados.length; ri++) {
      var resImp = resultados[ri];
      if (!resImp) continue;
      if (resImp.ok) {
        resImp.ficheiro._origemLink = resImp.link;
        var antes = estado.itens.length;
        adicionarFicheiros([resImp.ficheiro]);
        if (estado.itens.length > antes) {
          var novo = estado.itens[estado.itens.length - 1];
          if (novo) novo.origem = resImp.link;
        }
      } else {
        linksFalhados.push(resImp.link);
        estado.itens.push({
          id: proximoId++,
          ficheiro: null,
          nome: resImp.link,
          bytes: 0,
          estado: "erro",
          invalido: true,
          passo: "",
          progresso: 0,
          erro: "Não importei este link: " + mensagemDeErro(resImp.erro, "falha desconhecida."),
          resultado: null,
          origem: resImp.link,
        });
      }
    }
    estado.links.aImportar = false;
    estado.links.texto = linksFalhados.join("\n");
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
      var nomeF = f.name || "video.mp4";
      var bytesF = f.size || 0;
      var origF = f._origemLink || f.origem || "";
      var caixaF = f._caixaId || f.caixaId || "";
      var jaExiste = estado.itens.some(function (it) {
        if (!it || (it.estado !== "pendente" && it.estado !== "a_processar")) return false;
        if (caixaF && it.caixaId && it.caixaId === caixaF) return true;
        if (origF && it.origem && idDoLink(it.origem) === idDoLink(origF)) return true;
        if (bytesF > 0 && it.nome === nomeF && it.bytes === bytesF) return true;
        return false;
      });
      if (jaExiste) return;
      var item = {
        id: proximoId++,
        ficheiro: f,
        nome: nomeF,
        bytes: bytesF,
        origem: origF || undefined,
        caixaId: caixaF || undefined,
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

  function estaAtivo(it) {
    return !!(it && (it.estado === "a_processar" || it === estado.itemAtual || (estado.itensAtivos && estado.itensAtivos.indexOf(it) !== -1)));
  }

  function removerItem(id) {
    estado.itens = estado.itens.filter(function (it) {
      return it.id !== id || estaAtivo(it);
    });
    desenhar();
  }

  function repetirItem(id) {
    estado.itens.forEach(function (it) {
      if (it.id === id && !estaAtivo(it) && !it.invalido) {
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
  async function processarItem(item, conta, ctx) {
    var core = (ctx && ctx.core) || ambiente.core();
    var app = (ctx && ctx.app) || ambiente.app();
    var lerVideoFn = (ctx && ctx.lerVideo) || ambiente.lerVideo;
    var permitirPoucaCerteza = (ctx && typeof ctx.agendarComPoucaCerteza === "boolean")
      ? ctx.agendarComPoucaCerteza
      : !!(estado.opcoes && estado.opcoes.agendarComPoucaCerteza);
    var s = app.settings || {};
    var ficheiro = item.ficheiro;

    /* 1. Ler o vídeo (metadados + dimensões em paralelo) ------------------- */
    if (estado.pararPedido) throw erroComTipo("Lote parado.", "parado");
    definirPasso(item, "A ler o vídeo…", 0.02);
    var duracao = 0;
    var tituloMetadados = "";
    var todosMetadados = "";
    var meta = null;
    var info = null;
    var erroVideo = null;
    var leituraParalela = await Promise.all([
      Promise.resolve().then(function () { return core.lerMetadados(ficheiro); }).catch(function () { return null; }),
      Promise.resolve().then(function () { return lerVideoFn(ficheiro); }).catch(function (e) { erroVideo = e; return null; }),
    ]);
    meta = leituraParalela[0];
    info = leituraParalela[1];
    if (meta) {
      duracao = Number(meta.duration) || 0;
      var campos = meta.fields || [];
      todosMetadados = campos.map(function (f) {
        if (!f || !f.label || !f.value) return "";
        if (/^(Encoder|Data)$/i.test(f.label)) return "";
        return f.label + ": " + f.value;
      }).filter(Boolean).join(" | ");
      var campo = campos.find(function (f) {
        return f && f.label === "Título";
      });
      tituloMetadados = campo ? campo.value : (campos[0] ? campos[0].value : "");
    }
    if (!info) {
      if (meta && meta.width && meta.height) {
        info = { largura: Number(meta.width) || 0, altura: Number(meta.height) || 0, duracao: duracao };
      } else {
        throw erroVideo || new Error("O navegador não consegue abrir este vídeo.");
      }
    }
    var codecMeta = String((meta && meta.codec) || "");
    var ehHevc = /(hevc|h265|hvc1|hev1|bytevc)/i.test(codecMeta);
    if ((!info.largura || !info.altura) && !ehHevc && meta && meta.width && meta.height) {
      info = { largura: Number(meta.width) || 0, altura: Number(meta.height) || 0, duracao: info.duracao || duracao };
    }
    if (!info.largura || !info.altura) {
      throw erroComTipo(
        "O navegador abre o som mas não a imagem deste vídeo (codec H.265/HEVC, comum em vídeos baixados do TikTok). Converte-o para H.264 e volta a enviar.",
        "codec"
      );
    }
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

    /* 2. Identificar o filme (quadros + áudio em paralelo, OCR nativo na IA) */
    if (estado.pararPedido) throw erroComTipo("Lote parado.", "parado");
    definirPasso(item, "A identificar o filme…", 0.1);
    var temGemini = !!String(s.geminiKey || "").trim();
    var capturaParalela = await Promise.all([
      core.quadros(ficheiro, 0, fim, corte),
      temGemini ? Promise.resolve().then(function () { return core.audio(ficheiro, 0, fim); }).catch(function () { return null; }) : Promise.resolve(null),
    ]);
    var quadros = capturaParalela[0];
    var audio = capturaParalela[1];
    var dicaLink = String((item && item.dica) || (ficheiro && ficheiro.pistaLink) || "").trim();
    var dicaEnriquecida = [dicaLink, todosMetadados].filter(Boolean).join(" · ");

    // Assinatura binária + Hash perceptual do conteúdo (videohash-like) -> chave de cache e anti-duplicado.
    var fileSig = await _assinaturaBinaria(ficheiro);
    var hashVideo = null;
    try { hashVideo = await hashPerceptualVideo(quadros); } catch (e) { hashVideo = null; }
    var baseNome = semExtensao(ficheiro.name);
    var nomeGen = /^(video|reel|clip|clipe|download|input|output|in|out)$/i.test(baseNome);
    function encontrarDuplicadoNaFila(filaLista) {
      return (filaLista || []).find(function (r) {
        if (!r || r.accountId !== conta.id || r.status === "error") return false;
        if (item.caixaId && r.caixaId && r.caixaId === item.caixaId) return true;
        if (item.origem && r.linkOrigem && idDoLink(r.linkOrigem) === idDoLink(item.origem)) return true;
        if (fileSig && r.fileSig && r.fileSig === fileSig) return true;
        if (hashVideo && r.videoHash && _hashesPerceptuaisIguais(r.videoHash, hashVideo)) return true;
        if (!nomeGen && r.videoFileName === baseNome + "_cineclip.mp4" && item.bytes > 0 && r.sourceBytes === item.bytes) return true;
        return false;
      });
    }
    var cacheHit = hashVideo ? cacheIdentLer(hashVideo) : null;

    var ia = null;
    var filme = null;
    if (cacheHit && cacheHit.ia && cacheHit.filme) {
      ia = cacheHit.ia;
      filme = cacheHit.filme;
    } else {
      ia = await core.identificar(s.nvidiaKey, quadros, s.lang, {
        fileName: ficheiro.name,
        metaTitle: tituloMetadados,
        userHint: dicaEnriquecida,
        geminiKey: s.geminiKey,
        audioClip: audio,
      });
      if (!ia || (!ia.titulo && !(ia.atores && ia.atores.length))) {
        throw erroComTipo("A IA não conseguiu identificar o filme deste clipe.", "identificacao");
      }
      filme = await core.procurarTmdb(s.tmdbKey, ia);
      if (!filme && Array.isArray(ia.alternativas) && ia.alternativas.length) {
        for (var altIdx = 0; altIdx < ia.alternativas.length; altIdx++) {
          var altCand = ia.alternativas[altIdx];
          if (altCand && (altCand.titulo || altCand.titulo_original)) {
            try {
              filme = await core.procurarTmdb(s.tmdbKey, {
                titulo: altCand.titulo,
                titulo_original: altCand.titulo_original,
                ano: altCand.ano,
                tipo: altCand.tipo,
                confianca: 75
              });
              if (filme) {
                ia.titulo = filme.title;
                ia.titulo_original = filme.original;
                ia.ano = filme.year;
                ia.confianca = Math.max(ia.confianca || 0, 75);
                break;
              }
            } catch (e) {}
          }
        }
      }
      if (!filme) {
        throw erroComTipo(
          'Não encontrei "' + (ia.titulo || ia.titulo_original || "o filme") + '" no TMDB.',
          "identificacao"
        );
      }
      if (hashVideo) cacheIdentGuardar(hashVideo, { ia: ia, filme: filme });
    }
    var confianca = Number(ia.confianca) || 0;
    item.resultado = { titulo: filme.title, ano: filme.year, confianca: confianca };
    if (confianca < CONFIANCA_MINIMA && !permitirPoucaCerteza) {
      throw erroComTipo(
        'A IA acha que é "' + filme.title + (filme.year ? " (" + filme.year + ")" : "") + '", mas só com ' +
          confianca + "% de certeza. Confere no Estúdio ou liga “Agendar mesmo com pouca certeza”.",
        "revisar"
      );
    }

    /* 3. Gancho ------------------------------------------------------------ */
    definirPasso(item, "A criar o gancho…", 0.2);
    var cena = ia.cena || "";
    /* A IA às vezes devolve "Gancho 1: texto" em vez de só o texto — limpa. */
    var limparGancho =
      typeof core.limparGancho === "function"
        ? core.limparGancho
        : function (t) {
            return String(t == null ? "" : t).trim();
          };
    function eGanchoValido(g) {
      var str = String(g || "").trim();
      if (!str || str.length < 8) return false;
      if (/^(gancho \d|opção \d|opcao \d|você precisa assistir|voce precisa assistir)/i.test(str)) return false;
      return true;
    }
    var gancho = (ia.ganchos || [])
      .map(limparGancho)
      .find(eGanchoValido);
    if (!gancho) {
      try {
        var g = await core.gerarGancho(s.nvidiaKey, quadros, s.lang, filme.title, s.geminiKey, audio);
        gancho = ((g && g.ganchos) || [])
          .map(limparGancho)
          .find(eGanchoValido);
        if (!cena && g && g.cena) cena = g.cena;
      } catch (e) {}
    }
    if (!gancho) {
      var poolVirais = [
        "O que acontece nessa cena deixou todo mundo em choque 😳",
        "Ele quebrou a única regra que nunca deveria ter quebrado 💀",
        "A reação dele ao descobrir a verdade foi a pior possível 😨",
        "A calma dele antes do caos começar é assustadora 🥶",
        "Ninguém imaginava que isso iria acontecer nessa cena 😱",
        "O momento exato em que tudo deu errado 🤯"
      ];
      var customOuPadrao = String(s.overlayText || core.ganchoPadrao || "").trim();
      gancho = (customOuPadrao && !/você precisa assistir|voce precisa assistir/i.test(customOuPadrao))
        ? customOuPadrao
        : poolVirais[Math.floor(Math.random() * poolVirais.length)];
    }
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

    /* 6. Agendar (serializado, com timeout anti-bloqueio e espelho em memória) */
    if (estado.pararPedido) throw erroComTipo("Lote parado.", "parado");
    definirPasso(item, "A agendar…", 0.95);
    return await comTravaAgendar(async function () {
      if (estado.pararPedido) throw erroComTipo("Lote parado.", "parado");
      var filaIdb = await _comTimeout(
        Promise.resolve().then(function () { return core.lerFila(); }),
        3500,
        null
      );
      var mapaFila = {};
      var baseLista = Array.isArray(filaIdb) ? filaIdb : reelsAgendadosSessao;
      baseLista.concat(reelsAgendadosFallback).forEach(function (r) {
        if (r && r.id) mapaFila[r.id] = r;
      });
      var fila = Object.keys(mapaFila).map(function (k) { return mapaFila[k]; });
      var chaveItem = item && item.id ? ("lote_" + sessaoLoteId + "_" + item.id) : "";
      var duplicado = fila.find(function (r) {
        if (!r || r.accountId !== conta.id || r.status === "error") return false;
        if (chaveItem && r._loteKey === chaveItem) return true;
        if (item.caixaId && r.caixaId === item.caixaId && (r.caixaTentativa || 0) === (item.tentativa || 0) && r.status === "scheduled") return true;
        return false;
      });
      if (duplicado) {
        item.resultado.horario = duplicado.scheduledAt;
        item.resultado.reelId = duplicado.id;
        return duplicado;
      }
      var horario = _proximoHorarioSeguro(core, fila, conta.dailySlots || [], conta.id);
      var base = semExtensao(ficheiro.name);
      var agora = ambiente.agora();
      var idDeterministico = item.caixaId
        ? ("reel_" + conta.id + "_" + item.caixaId + (item.tentativa ? "_t" + item.tentativa : ""))
        : ("reel_" + agora + "_" + (item.id || 0) + "_" + Math.random().toString(36).slice(2, 6));
      var legendaLimpa = typeof core.limparLegenda === "function"
        ? core.limparLegenda(String(legenda))
        : String(legenda).replace(/\*\*(.+?)\*\*/g, "$1").trim();
      var reel = {
        id: idDeterministico,
        accountId: conta.id,
        createdAt: agora,
        updatedAt: agora,
        scheduledAt: horario,
        status: "scheduled",
        title: filme.title || base,
        originalTitle: filme.original,
        year: filme.year,
        poster: filme.poster,
        hookText: gancho,
        caption: legendaLimpa,
        videoBlob: blob,
        videoFileName: base + "_cineclip.mp4",
        videoSize: blob.size || 0,
        sourceBytes: item.bytes || 0,
        caixaId: item.caixaId || undefined,
        caixaTentativa: item.tentativa || 0,
        linkOrigem: item.origem || undefined,
        videoHash: hashVideo || undefined,
        fileSig: fileSig || undefined,
        _loteKey: chaveItem || undefined,
        platforms: ["instagram"],
      };
      reelsAgendadosSessao.push(reel);
      try {
        if (typeof window !== "undefined" && window._ccMemQ && typeof window._ccMemQ.set === "function") {
          window._ccMemQ.set(reel.id, reel);
        }
      } catch (e) {}
      var guardou = await _comTimeout(
        Promise.resolve().then(function () { return core.guardarNaFila(reel); }).then(function () { return true; }),
        4000,
        false
      );
      if (!guardou) {
        reelsAgendadosFallback.push(reel);
        try {
          var reelLeve = Object.assign({}, reel);
          delete reelLeve.videoBlob;
          Promise.resolve().then(function () { return core.guardarNaFila(reelLeve); }).catch(function () {});
        } catch (e) {}
      }
      item.resultado.horario = horario;
      item.resultado.reelId = reel.id;
      return reel;
    });
  }

  /* --------------------------------------------------------- o ciclo */

  var sincronizacao = Promise.resolve();
  var travaAgendar = Promise.resolve();
  var sessaoLoteId = 1;
  var reelsAgendadosSessao = [];
  var reelsAgendadosFallback = [];

  function _comTimeout(promessa, ms, valorFallback) {
    return new Promise(function (resolve) {
      var terminado = false;
      var t = setTimeout(function () {
        if (terminado) return;
        terminado = true;
        resolve(valorFallback);
      }, ms);
      Promise.resolve(promessa).then(
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
    try {
      if (core && typeof core.proximoHorario === "function") {
        var h = core.proximoHorario(fila || [], Array.isArray(slots) && slots.length ? slots : ["12:00", "18:00", "21:30"], contaId);
        if (h && typeof h === "string") return h;
      }
    } catch (e) {}
    var listaSlots = (Array.isArray(slots) ? slots : []).map(function (s) { return String(s || "").trim(); }).filter(function (s) { return /^\d{1,2}:\d{2}$/.test(s); }).sort();
    if (!listaSlots.length) listaSlots = ["12:00", "18:00", "21:30"];
    var ocupados = {};
    (fila || []).forEach(function (r) {
      if (r && (!contaId || (r.accountId || "acc_default") === contaId) && (r.status === "scheduled" || r.status === "queued") && r.scheduledAt) {
        ocupados[String(r.scheduledAt).slice(0, 16)] = true;
      }
    });
    var baseAgora = new Date(ambiente.agora() + 10 * 60000);
    for (var d = 0; d < 60; d++) {
      var dia = new Date(baseAgora.getFullYear(), baseAgora.getMonth(), baseAgora.getDate() + d);
      var yyyy = dia.getFullYear();
      var mm = String(dia.getMonth() + 1).padStart(2, "0");
      var dd = String(dia.getDate()).padStart(2, "0");
      for (var si = 0; si < listaSlots.length; si++) {
        var partes = listaSlots[si].split(":");
        var hh = Number(partes[0]) || 12;
        var mi = Number(partes[1]) || 0;
        var cand = new Date(dia.getFullYear(), dia.getMonth(), dia.getDate(), hh, mi, 0, 0);
        if (cand <= baseAgora) continue;
        var chave = yyyy + "-" + mm + "-" + dd + "T" + String(hh).padStart(2, "0") + ":" + String(mi).padStart(2, "0");
        if (!ocupados[chave]) return chave;
      }
    }
    return new Date(ambiente.agora() + 3600000).toISOString().slice(0, 16);
  }

  function comTravaAgendar(fn) {
    var executar = function () {
      return new Promise(function (resolve, reject) {
        var terminado = false;
        var t = setTimeout(function () {
          if (terminado) return;
          terminado = true;
          reject(new Error("Tempo esgotado ao agendar na fila local."));
        }, 10000);
        Promise.resolve().then(fn).then(
          function (v) {
            if (terminado) return;
            terminado = true;
            clearTimeout(t);
            resolve(v);
          },
          function (e) {
            if (terminado) return;
            terminado = true;
            clearTimeout(t);
            reject(e);
          }
        );
      });
    };
    var p = travaAgendar.then(executar, executar);
    travaAgendar = p.catch(function () {});
    return p;
  }

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

  /** Mantém a aba ativa no gestor de ciclo de vida do browser (Web Locks API) enquanto o lote corre. */
  function comTravaDeSegundoPlano(fn) {
    try {
      if (typeof navigator !== "undefined" && navigator.locks && typeof navigator.locks.request === "function") {
        return navigator.locks.request("cineclip_lote_ativo", { mode: "shared" }, fn);
      }
    } catch (e) {}
    return fn();
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
    sessaoLoteId++;
    reelsAgendadosSessao = [];
    reelsAgendadosFallback = [];
    avisar("");
    desenhar();
    manterEcraLigado(true);
    var agendadosAntes = contar("agendado");
    await comTravaDeSegundoPlano(async function () {
      try {
        var limite = Math.max(1, Math.min(MAX_SIMULTANEOS, Number(estado.opcoes && estado.opcoes.simultaneos) || MAX_SIMULTANEOS));
        estado.itensAtivos = [];
        async function trabalhador() {
          var item;
          while (!estado.pararPedido && (item = pendentes()[0])) {
            item.estado = "a_processar";
            item.erro = "";
            estado.itensAtivos.push(item);
            estado.itemAtual = estado.itensAtivos[0] || null;
            desenhar();
            try {
              await processarItem(item, estado.conta);
              if (estado.pararPedido) {
                item.estado = "pendente";
                item.passo = "";
                item.progresso = 0;
              } else {
                item.estado = "agendado";
                item.passo = "";
                item.progresso = 1;
                desenhar();
                if (item.caixaId) marcarEntrada(item.caixaId, "feito", { reelId: item.resultado && item.resultado.reelId });
                pedirSincronizacao();
              }
            } catch (e) {
              if ((estado.pararPedido || (e && e.tipo === "parado")) && (!e || e.tipo !== "codec")) {
                item.estado = "pendente";
                item.passo = "";
                item.progresso = 0;
              } else {
                item.estado = e && e.tipo === "revisar" ? "revisar" : "erro";
                item.erro = mensagemDeErro(e, "Falha ao processar este vídeo.");
                item.passo = "";
                if (item.caixaId) {
                  marcarEntrada(item.caixaId, "erro", { erro: item.erro });
                  pedirSincronizacao();
                }
              }
            }
            var idx = estado.itensAtivos.indexOf(item);
            if (idx !== -1) estado.itensAtivos.splice(idx, 1);
            estado.itemAtual = estado.itensAtivos[0] || null;
            desenhar();
          }
        }
        var nTrabalhadores = Math.min(limite, pendentes().length);
        var trabalhadores = [];
        for (var w = 0; w < nTrabalhadores; w++) {
          trabalhadores.push(trabalhador());
        }
        await Promise.all(trabalhadores);
      } finally {
        estado.aCorrer = false;
        estado.itensAtivos = [];
        estado.itemAtual = null;
        var feitos = estado.itens.filter(function (it) {
          return it.estado === "agendado";
        }).length;
        if (estado.pararPedido) avisar("Lote parado. Os vídeos que faltam ficaram na lista.", "info");
        else if (feitos) avisar("Lote concluído. Os Reels estão no Agendador e vão para a nuvem durável.", "ok");
        estado.pararPedido = false;
        manterEcraLigado(false);
        desenhar();
        avisarFimDoLote(feitos - agendadosAntes);
      }
    });
    await _comTimeout(sincronizacao, 4000, null);
  }

  function parar() {
    if (!estado.aCorrer) return;
    estado.pararPedido = true;
    var core = ambiente.core();
    var ativos = (estado.itensAtivos && estado.itensAtivos.length) ? estado.itensAtivos : (estado.itemAtual ? [estado.itemAtual] : []);
    // Se algum dos vídeos ativos estiver a meio do FFmpeg, interrompe já; nas chamadas à IA espera que acabem.
    var emFfmpeg = ativos.some(function (it) { return it && /processar/.test(it.passo); });
    if (emFfmpeg && core && typeof core.cancelarProcessamento === "function") {
      try {
        core.cancelarProcessamento();
      } catch (e) {}
    }
    desenhar();
  }

  /* ----------------------------------------- 📱 compartilhar do celular */
  /*
   * Caixa de entrada de links. Cada link que chega pelo menu "Compartilhar" do
   * Android (ou que o celular manda para o PC) fica aqui até virar um Reel:
   *   { id, url, destino: "aqui" | "pc" | "nuvem", aparelho, estado: "pendente" | "feito" | "erro",
   *     criadoEm, atualizadoEm, erro?, reelId? }
   * A caixa vive no localStorage e viaja no cofre da nuvem (campo `linksCelular`,
   * patch 31-links-cofre), por isso um link mandado do celular aparece no PC.
   *   • destino "aqui": só o aparelho que o recebeu o processa;
   *   • destino "pc":   qualquer aparelho com "processar links do celular" ligado.
   */

  var CHAVE_CAIXA = "cineclip.links.caixa";
  var CHAVE_APARELHO = "cineclip.links.aparelho";
  var ORDEM_ESTADO = { pendente: 0, erro: 1, revisar: 1, feito: 2 };
  var GUARDAR_DIAS = 14;

  function lerJson(chave, alternativa) {
    try {
      var bruto = window.localStorage.getItem(chave);
      return bruto ? JSON.parse(bruto) : alternativa;
    } catch (e) {
      return alternativa;
    }
  }

  function gravarJson(chave, valor) {
    try {
      window.localStorage.setItem(chave, JSON.stringify(valor));
    } catch (e) {}
  }

  function meuAparelho() {
    var id = "";
    try {
      id = window.localStorage.getItem(CHAVE_APARELHO) || "";
      if (!id) {
        id = "ap_" + Math.random().toString(36).slice(2, 10);
        window.localStorage.setItem(CHAVE_APARELHO, id);
      }
    } catch (e) {
      id = id || "ap_sem_armazenamento";
    }
    return id;
  }

  function eCelular() {
    return /Android|iPhone|iPad|iPod|Mobile/i.test((navigator && navigator.userAgent) || "");
  }

  function lerCaixa() {
    var lista = lerJson(CHAVE_CAIXA, []);
    return Array.isArray(lista) ? lista.filter(function (e) { return e && e.id && e.url; }) : [];
  }

  function gravarCaixa(lista) {
    gravarJson(CHAVE_CAIXA, lista);
  }

  /** Id estável de um link (o mesmo link partilhado duas vezes não entra duas vezes). */
  function idDoLink(url) {
    var s = String(url || "").trim().replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return "lk_" + (h >>> 0).toString(36) + "_" + s.length;
  }

  function adicionarACaixa(urls, destino) {
    var lista = lerCaixa();
    var agora = ambiente.agora();
    var novos = [];
    var app = ambiente.app();
    var contaId = app && app.account && app.account.id ? app.account.id : undefined;
    urls.forEach(function (url) {
      var id = idDoLink(url);
      var existente = lista.find(function (e) { return e.id === id; });
      if (existente && existente.estado === "pendente") {
        existente.destino = destino;
        existente.contaId = contaId;
        existente.aparelho = meuAparelho();
        existente.atualizadoEm = agora;
        novos.push(existente);
        return;
      }
      if (existente) lista = lista.filter(function (e) { return e.id !== id; });
      var entrada = { id: id, url: url, destino: destino, contaId: contaId, aparelho: meuAparelho(), estado: "pendente", criadoEm: agora, atualizadoEm: agora };
      // Partilhar outra vez um link já tratado é uma nova tentativa: ganha à antiga ao juntar com a nuvem.
      if (existente) entrada.tentativa = (existente.tentativa || 0) + 1;
      lista.push(entrada);
      novos.push(entrada);
    });
    gravarCaixa(lista);
    return novos;
  }

  /** Nova tentativa de uma entrada que deu erro/ficou para rever (mesmo id). */
  function reabrirEntrada(id, destino, extra) {
    var lista = lerCaixa();
    var app = ambiente.app();
    lista.forEach(function (e) {
      if (e.id !== id) return;
      e.destino = destino;
      e.estado = "pendente";
      e.erro = "";
      e.tentativa = (e.tentativa || 0) + 1;
      e.forcar = !!(extra && extra.forcar);
      e.aparelho = meuAparelho();
      if (app && app.account && app.account.id) e.contaId = app.account.id;
      e.atualizadoEm = ambiente.agora();
    });
    gravarCaixa(lista);
  }

  function marcarEntrada(id, novoEstado, extra) {
    var lista = lerCaixa();
    lista.forEach(function (e) {
      if (e.id !== id) return;
      e.estado = novoEstado;
      e.atualizadoEm = ambiente.agora();
      Object.keys(extra || {}).forEach(function (k) {
        if (extra[k] != null) e[k] = extra[k];
      });
    });
    gravarCaixa(lista);
  }

  /**
   * Junta a caixa deste aparelho com a que veio do cofre da nuvem. Chamado pela
   * sincronização do app (patch 31) — devolve a lista que vai para o cofre.
   * Um link feito/com erro ganha a um pendente; entre iguais ganha o mais recente.
   */
  function mesclarLinks(remotas) {
    var mapa = {};
    var limite = ambiente.agora() - GUARDAR_DIAS * 86400000;
    lerCaixa().concat(Array.isArray(remotas) ? remotas : []).forEach(function (e) {
      if (!e || !e.id || !e.url) return;
      var atual = mapa[e.id];
      if (!atual) {
        mapa[e.id] = e;
        return;
      }
      // Uma tentativa mais nova ("Tentar de novo", partilhar outra vez) ganha sempre;
      // na mesma tentativa, feito/erro ganham a pendente (um aparelho atrasado não
      // ressuscita um link já tratado) e, entre iguais, ganha o mais recente.
      var ta = atual.tentativa || 0;
      var tb = e.tentativa || 0;
      if (tb !== ta) {
        if (tb > ta) mapa[e.id] = e;
        return;
      }
      var a = ORDEM_ESTADO[atual.estado] || 0;
      var b = ORDEM_ESTADO[e.estado] || 0;
      if (b > a || (b === a && (e.atualizadoEm || 0) > (atual.atualizadoEm || 0))) mapa[e.id] = e;
    });
    var lista = Object.keys(mapa).map(function (k) { return mapa[k]; }).filter(function (e) {
      return e.estado === "pendente" || (e.atualizadoEm || e.criadoEm || 0) >= limite;
    });
    gravarCaixa(lista);
    setTimeout(function () {
      desenhar();
      verificarCaixa();
      acordarNuvem(false);
    }, 0);
    return lista;
  }

  var caixaTratadaNestaSessao = {};

  /** Links que ESTE aparelho deve processar agora. */
  function entradasParaMim() {
    var eu = meuAparelho();
    var processoPC = estado.opcoes.processarLinksDoCelular;
    var noLote = {};
    estado.itens.forEach(function (it) {
      if (it.caixaId && it.estado !== "erro") noLote[it.caixaId] = true;
      if (it.origem && it.estado !== "erro") noLote[idDoLink(it.origem)] = true;
    });
    return lerCaixa().filter(function (e) {
      var chaveTentativa = e.id + ":" + (e.tentativa || 0);
      if (e.estado !== "pendente" || noLote[e.id] || caixaTratadaNestaSessao[chaveTentativa]) return false;
      if (e.destino === "aqui") return e.aparelho === eu;
      return e.destino === "pc" && processoPC;
    });
  }

  var caixaOcupada = false;

  /** Importa os links pendentes deste aparelho para o lote e começa sozinho. */
  async function verificarCaixa() {
    if (caixaOcupada || estado.links.aImportar) return;
    if (!ambiente.core() || !ambiente.app() || faltaConfigurar()) return;
    // Se o Estúdio estiver ocupado a processar um vídeo no FFmpeg, aguarda para não colidir ao mudar de aba.
    if (window.__CineClipBusy) {
      setTimeout(verificarCaixa, 3000);
      return;
    }
    var entradas = entradasParaMim();
    if (!entradas.length) {
      if (!estado.aCorrer && pendentes().some(function (it) { return it.caixaId; })) iniciar();
      return;
    }
    caixaOcupada = true;
    try {
      for (var i = 0; i < entradas.length; i++) {
        var e = entradas[i];
        var chaveTentativa = e.id + ":" + (e.tentativa || 0);
        caixaTratadaNestaSessao[chaveTentativa] = true;
        estado.links.estado = "📥 A importar link " + (i + 1) + "/" + entradas.length + " do celular…";
        desenhar();
        try {
          var ficheiro = await ambiente.baixarLink(e.url, function (recebidos, total) {
            estado.links.estado = "📥 A importar link " + (i + 1) + "/" + entradas.length + "… " +
              (total ? Math.round((recebidos / total) * 100) + "%" : tamanho(recebidos));
            desenharEstadoLinks();
          });
          ficheiro._origemLink = e.url;
          ficheiro._caixaId = e.id;
          var antes = estado.itens.length;
          adicionarFicheiros([ficheiro]);
          if (estado.itens.length > antes) {
            var novo = estado.itens[estado.itens.length - 1];
            if (novo) {
              novo.origem = e.url;
              novo.caixaId = e.id;
            }
          }
        } catch (erro) {
          delete caixaTratadaNestaSessao[chaveTentativa];
          var msg = "Não importei este link: " + mensagemDeErro(erro, "falha desconhecida.");
          marcarEntrada(e.id, "erro", { erro: msg });
          estado.itens.push({
            id: proximoId++, ficheiro: null, nome: e.url, bytes: 0, estado: "erro", invalido: true,
            passo: "", progresso: 0, erro: msg, resultado: null, origem: e.url, caixaId: e.id,
          });
        }
      }
      estado.links.estado = "";
    } finally {
      caixaOcupada = false;
      desenhar();
    }
    if (!estado.aCorrer && pendentes().length && !window.__CineClipBusy) iniciar();
  }

  /* -- ecrã ligado e aviso no fim -- */

  var bloqueioEcra = null;

  async function manterEcraLigado(ligar) {
    try {
      if (ligar) {
        if (!bloqueioEcra && navigator.wakeLock && document.visibilityState === "visible") {
          bloqueioEcra = await navigator.wakeLock.request("screen");
          bloqueioEcra.addEventListener("release", function () {
            bloqueioEcra = null;
          });
        }
      } else if (bloqueioEcra) {
        var b = bloqueioEcra;
        bloqueioEcra = null;
        await b.release();
      }
    } catch (e) {
      bloqueioEcra = null;
    }
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && estado.aCorrer) manterEcraLigado(true);
  });

  async function avisarFimDoLote(novos) {
    if (!(novos > 0)) return;
    try {
      if (navigator.vibrate) navigator.vibrate([120, 80, 120]);
    } catch (e) {}
    try {
      if (!("Notification" in window) || Notification.permission !== "granted") return;
      var texto = novos === 1 ? "1 Reel agendado." : novos + " Reels agendados.";
      var reg = navigator.serviceWorker && (await navigator.serviceWorker.getRegistration());
      if (reg && reg.showNotification) await reg.showNotification("CineClip", { body: texto, icon: "icone-192.png", tag: "cineclip-lote" });
      else new Notification("CineClip", { body: texto, icon: "icone-192.png" });
    } catch (e) {}
  }

  function pedirPermissaoDeAviso() {
    try {
      if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
    } catch (e) {}
  }

  /* -- ☁️ servidor na nuvem (servidor/ — Hetzner) -- */
  /*
   * O servidor mantém uma claim com dono "servidor:…" no Worker R2, renovada a
   * cada minuto. O app lista as claims ativas para saber se ele está ligado e só
   * então oferece "☁️ Processar na nuvem" (ou se o utilizador já o escolheu).
   */
  var CHAVE_SERVIDOR = "cineclip.servidor.visto";
  var LIGADO_MS = 15 * 60 * 1000;
  var verificandoServidor = null;
  /* A nuvem também pode ser a própria Vercel (api/nuvem.js, sem servidor ligado o
     tempo todo): basta a chave do servidor nas variáveis da Vercel. Ela não dá sinal
     de vida sozinha — o app pergunta-lhe se está configurada e acorda-a quando há
     links à espera. */
  var nuvemVercel = null;
  var ultimoAcordar = 0;

  function nuvemVercelPronta() {
    return !!(nuvemVercel && nuvemVercel.configurado);
  }

  /** Acorda a nuvem da Vercel se houver links à espera (no máximo 1x a cada 2 min, salvo `ja`). */
  function acordarNuvem(ja) {
    if (!nuvemVercelPronta()) return false;
    var espera = lerCaixa().some(function (e) { return e.destino === "nuvem" && e.estado === "pendente"; });
    if (!espera) return false;
    if (!ja && ambiente.agora() - ultimoAcordar < 2 * 60 * 1000) return false;
    ultimoAcordar = ambiente.agora();
    try {
      var p = ambiente.acordarNuvem();
      if (p && typeof p.catch === "function") p.catch(function () {});
    } catch (e) {}
    return true;
  }

  function servidorVistoEm() {
    return Number(lerJson(CHAVE_SERVIDOR, 0)) || 0;
  }

  function servidorLigado() {
    return ambiente.agora() - servidorVistoEm() < LIGADO_MS;
  }

  function mostrarBotaoNuvem() {
    return servidorLigado() || estado.opcoes.aoPartilhar === "nuvem" || lerCaixa().some(function (e) { return e.destino === "nuvem"; });
  }

  function verificarServidor() {
    if (verificandoServidor) return verificandoServidor;
    verificandoServidor = (async function () {
      try {
        try {
          nuvemVercel = await ambiente.consultarNuvem();
        } catch (e) {
          nuvemVercel = null;
        }
        if (nuvemVercelPronta()) {
          gravarJson(CHAVE_SERVIDOR, ambiente.agora());
          return true;
        }
        var cc = window.CineCloud;
        if (!cc || typeof cc.activeClaims !== "function") return servidorLigado();
        var lista = await cc.activeClaims();
        var vivo = (Array.isArray(lista) ? lista : []).some(function (c) {
          return c && /^servidor:/.test(String(c.owner || "")) && (!c.expiresAt || Number(c.expiresAt) > ambiente.agora());
        });
        if (vivo) gravarJson(CHAVE_SERVIDOR, ambiente.agora());
        return vivo;
      } catch (e) {
        return servidorLigado();
      } finally {
        setTimeout(function () {
          verificandoServidor = null;
        }, 0);
      }
    })();
    return verificandoServidor;
  }

  /* -- receber o que foi partilhado -- */

  var partilhasVistas = {};

  /** Links do TikTok/Kwai num URL de partilha (/compartilhar?title=&text=&url=). */
  function linksDaPartilha(href) {
    var u;
    try {
      u = new URL(href, window.location.href);
    } catch (e) {
      return null;
    }
    var p = u.searchParams;
    var ePartilha = /\/compartilhar\/?$/.test(u.pathname) || p.has("text") || p.has("url");
    if (!ePartilha) return null;
    return extrairLinks([p.get("title"), p.get("text"), p.get("url")].filter(Boolean).join("\n"));
  }

  function limparEnderecoDaPartilha() {
    try {
      var caminho = window.location.pathname.replace(/compartilhar\/?$/, "");
      window.history.replaceState(null, "", caminho + window.location.hash);
    } catch (e) {}
  }

  async function aguardarApp(maxMs) {
    var t0 = ambiente.agora();
    while (!(ambiente.core() && ambiente.app())) {
      if (ambiente.agora() - t0 > maxMs) return false;
      await new Promise(function (r) { setTimeout(r, 300); });
    }
    return true;
  }

  function receberPartilha(href) {
    var links = linksDaPartilha(href);
    if (links === null) return;
    var chave = String(href);
    if (partilhasVistas[chave]) return;
    partilhasVistas[chave] = true;
    limparEnderecoDaPartilha();
    if (!links.length) {
      mostrarRecebidos([], "Não encontrei nenhum link do TikTok ou do Kwai no que foi partilhado.");
      return;
    }
    var escolha = estado.opcoes.aoPartilhar;
    if (escolha === "aqui" || escolha === "pc" || escolha === "nuvem") enviarPara(links, escolha);
    else mostrarRecebidos(links, "");
  }

  async function enviarPara(links, destino) {
    adicionarACaixa(links, destino);
    if (destino === "aqui") {
      fecharRecebidos();
      abrir();
      avisar("📱 " + links.length + " link" + (links.length > 1 ? "s" : "") + " recebido" + (links.length > 1 ? "s" : "") + ". Deixa o ecrã ligado até terminar.", "info");
      desenhar();
      if (await aguardarApp(120000)) verificarCaixa();
      return;
    }
    var nuvem = destino === "nuvem";
    mostrarRecebidos(links, "", nuvem ? "A enviar para a nuvem…" : "A enviar para o PC…");
    var pronto = await aguardarApp(120000);
    var app = ambiente.app();
    if (!pronto || !app || typeof app.sincronizar !== "function") {
      mostrarRecebidos(links, "Entra na tua conta do CineClip neste celular para enviar " + (nuvem ? "para a nuvem" : "ao PC") + ". O link fica guardado e segue na próxima sincronização.");
      return;
    }
    try {
      await app.sincronizar();
      if (nuvem) {
        // O link já está no cofre: acorda a nuvem da Vercel (se for essa a nuvem).
        if (!nuvemVercelPronta()) await verificarServidor();
        acordarNuvem(true);
      }
      mostrarRecebidos(links, "", nuvem
        ? "✅ Enviado para a nuvem. O servidor processa e agenda sozinho em poucos minutos. Já podes fechar." +
          (servidorLigado() ? "" : " (O servidor não deu sinal de vida há algum tempo — confere se está ligado.)")
        : "✅ Enviado. O PC processa quando o CineClip estiver aberto nele. Já podes fechar.", true);
    } catch (e) {
      mostrarRecebidos(links, "Não consegui sincronizar agora (" + mensagemDeErro(e, "sem ligação") + "). O link fica guardado e segue na próxima sincronização.");
    }
  }

  var folhaRecebidos = null;

  function fecharRecebidos() {
    if (folhaRecebidos) folhaRecebidos.remove();
    folhaRecebidos = null;
  }

  /** Folha que aparece ao partilhar: "Processar agora aqui" ou "Mandar para o PC". */
  function mostrarRecebidos(links, erro, estadoTexto, concluido) {
    garantirEstilo();
    fecharRecebidos();
    var lembrar = el("input", { type: "checkbox" });
    var filhos = [
      el("h2", { text: links.length ? "📥 " + links.length + " vídeo" + (links.length > 1 ? "s" : "") + " recebido" + (links.length > 1 ? "s" : "") : "📥 Partilha recebida" }),
    ];
    if (links.length) {
      filhos.push(el("ul", { className: "cl-recebidos" }, links.map(function (l) {
        return el("li", { text: l });
      })));
    }
    if (erro) filhos.push(el("div", { className: "cl-aviso erro", text: erro }));
    if (estadoTexto) filhos.push(el("div", { className: "cl-aviso" + (concluido ? " ok" : ""), role: "status", text: estadoTexto }));
    if (links.length && !estadoTexto) {
      filhos.push(el("div", { className: "cl-botoes cl-escolha" }, [
        el("button", { type: "button", className: "cl-btn cl-prim", onClick: function () {
          if (lembrar.checked) guardarEscolha("aqui");
          pedirPermissaoDeAviso();
          enviarPara(links, "aqui");
        } }, ["▶ Processar agora aqui"]),
        mostrarBotaoNuvem() ? el("button", { type: "button", className: "cl-btn cl-sec", onClick: function () {
          if (lembrar.checked) guardarEscolha("nuvem");
          enviarPara(links, "nuvem");
        } }, ["☁️ Processar na nuvem"]) : null,
        el("button", { type: "button", className: "cl-btn cl-sec", onClick: function () {
          if (lembrar.checked) guardarEscolha("pc");
          enviarPara(links, "pc");
        } }, ["💻 Mandar para o PC"]),
      ]));
      filhos.push(el("label", { className: "cl-opcao" }, [lembrar, el("span", { text: "Lembrar a minha escolha (dá para mudar no upload em massa)" })]));
    }
    if (!links.length || erro || concluido) {
      filhos.push(el("div", { className: "cl-botoes" }, [el("button", { type: "button", className: "cl-btn cl-sec", onClick: fecharRecebidos }, ["Fechar"])]));
    }
    folhaRecebidos = el("div", { className: "cl-overlay cl-folha" }, [el("div", { className: "cl-painel cl-corpo", role: "dialog", "aria-modal": "true" }, filhos)]);
    document.body.appendChild(folhaRecebidos);
    // Se o servidor estiver ligado e o botão ainda não apareceu, volta a desenhar.
    if (links.length && !estadoTexto && !mostrarBotaoNuvem()) {
      var esta = folhaRecebidos;
      verificarServidor().then(function (vivo) {
        if (vivo && folhaRecebidos === esta) mostrarRecebidos(links, erro, estadoTexto, concluido);
      });
    }
  }

  function guardarEscolha(valor) {
    estado.opcoes.aoPartilhar = valor;
    gravarOpcoes();
  }

  /** Arranque: service worker, partilha no endereço e partilhas com o app já aberto. */
  function iniciarCompartilhar() {
    try {
      var local = /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);
      if ("serviceWorker" in navigator && (window.location.protocol === "https:" || local)) {
        navigator.serviceWorker.register("sw.js").catch(function () {});
      }
    } catch (e) {}
    try {
      if ("launchQueue" in window && window.launchQueue && window.launchQueue.setConsumer) {
        window.launchQueue.setConsumer(function (params) {
          if (params && params.targetURL) receberPartilha(params.targetURL);
        });
      }
    } catch (e) {}
    receberPartilha(window.location.href);
    iniciarBotaoColar();
    // Links "aqui" que ficaram a meio (a página recarregou) e links mandados para o PC.
    aguardarApp(10 * 60 * 1000).then(function (ok) {
      if (ok) {
        verificarCaixa();
        // Links que ficaram à espera da nuvem (ex.: o celular fechou antes de a acordar).
        verificarServidor().then(function () {
          acordarNuvem(false);
        });
      }
    });
  }

  /* ------------------------------------------ 📋 botão "Colar e processar" */
  /*
   * Um site não pode desenhar por cima do TikTok/Kwai (isso exige app nativo). O
   * mais perto disso: um botão flutuante no CineClip. No TikTok → "Copiar link",
   * volta ao CineClip, toca no botão → o link segue o mesmo caminho da partilha
   * (pergunta "aqui ou PC", ou usa a escolha lembrada).
   * Além disso, ao voltar ao app com um link novo copiado, o CineClip oferece
   * processá-lo — só quando o Chrome já deu permissão para ler a área de
   * transferência (nunca pede permissão sem um toque).
   */

  var CHAVE_OFERTADOS = "cineclip.links.ofertados";
  var botaoColar = null;
  var avisoCopiado = null;

  function appLogado() {
    var app = ambiente.app();
    return !!(app && ambiente.core() && app.logado !== false);
  }

  async function lerAreaDeTransferencia() {
    if (!navigator.clipboard || typeof navigator.clipboard.readText !== "function") {
      throw new Error("sem-acesso");
    }
    return String((await navigator.clipboard.readText()) || "");
  }

  async function permissaoDeLeitura() {
    try {
      if (!navigator.permissions || !navigator.permissions.query) return "desconhecida";
      var p = await navigator.permissions.query({ name: "clipboard-read" });
      return p.state;
    } catch (e) {
      return "desconhecida";
    }
  }

  function lembrarOfertado(link) {
    var lista = lerJson(CHAVE_OFERTADOS, []);
    if (!Array.isArray(lista)) lista = [];
    lista = lista.filter(function (l) { return l !== link; });
    lista.push(link);
    gravarJson(CHAVE_OFERTADOS, lista.slice(-50));
  }

  function jaConhecido(link) {
    var id = idDoLink(link);
    var ofertados = lerJson(CHAVE_OFERTADOS, []);
    return (Array.isArray(ofertados) && ofertados.indexOf(link) !== -1) ||
      lerCaixa().some(function (e) { return e.id === id; });
  }

  /** Os links copiados seguem o mesmo caminho de uma partilha do Android. */
  function tratarLinksColados(links) {
    links.forEach(lembrarOfertado);
    fecharAvisoCopiado();
    var escolha = estado.opcoes.aoPartilhar;
    if (escolha === "aqui" || escolha === "pc" || escolha === "nuvem") enviarPara(links, escolha);
    else mostrarRecebidos(links, "");
  }

  async function aoTocarColar() {
    var texto = null;
    try {
      texto = await lerAreaDeTransferencia();
    } catch (e) {
      texto = null;
    }
    if (texto === null) {
      mostrarColarAMao("O navegador não deixou ler o link copiado. Cola-o aqui:");
      return;
    }
    var links = extrairLinks(texto);
    if (!links.length) {
      mostrarColarAMao("Não há link do TikTok ou do Kwai copiado. No vídeo, toca em Partilhar → Copiar link e volta aqui — ou cola-o abaixo:");
      return;
    }
    tratarLinksColados(links);
  }

  /** Folha com uma caixa para colar à mão (quando ler a área de transferência falha). */
  function mostrarColarAMao(mensagem) {
    garantirEstilo();
    fecharRecebidos();
    var area = el("textarea", { className: "cl-texto", rows: "3", placeholder: "https://vm.tiktok.com/…", "aria-label": "Link do vídeo" });
    var aviso = el("div", { className: "cl-sub", role: "status" });
    folhaRecebidos = el("div", { className: "cl-overlay cl-folha" }, [
      el("div", { className: "cl-painel cl-corpo", role: "dialog", "aria-modal": "true" }, [
        el("h2", { text: "📋 Colar link" }),
        el("p", { className: "cl-sub", text: mensagem }),
        area,
        aviso,
        el("div", { className: "cl-botoes cl-escolha" }, [
          el("button", { type: "button", className: "cl-btn cl-prim", onClick: function () {
            var links = extrairLinks(area.value);
            if (!links.length) {
              aviso.textContent = "Isto não parece um link do TikTok ou do Kwai.";
              return;
            }
            tratarLinksColados(links);
          } }, ["Continuar"]),
          el("button", { type: "button", className: "cl-btn cl-sec", onClick: fecharRecebidos }, ["Cancelar"]),
        ]),
      ]),
    ]);
    document.body.appendChild(folhaRecebidos);
    try {
      area.focus();
    } catch (e) {}
  }

  function fecharAvisoCopiado() {
    if (avisoCopiado) avisoCopiado.remove();
    avisoCopiado = null;
  }

  /** Ao voltar ao app: há um link novo copiado? Oferece processá-lo. */
  async function verificarLinkCopiado() {
    if (!estado.opcoes.avisarLinkCopiado || !appLogado() || folhaRecebidos || avisoCopiado) return;
    if (document.visibilityState !== "visible") return;
    if ((await permissaoDeLeitura()) !== "granted") return;
    var texto;
    try {
      texto = await lerAreaDeTransferencia();
    } catch (e) {
      return;
    }
    var links = extrairLinks(texto).filter(function (l) { return !jaConhecido(l); });
    if (!links.length) return;
    garantirEstilo();
    avisoCopiado = el("div", { className: "cl-copiado", role: "alert" }, [
      el("span", { text: "🔗 Link copiado: " + (links.length > 1 ? links.length + " vídeos" : links[0].replace(/^https?:\/\/(www\.)?/, "").slice(0, 40)) }),
      el("div", { className: "cl-botoes" }, [
        el("button", { type: "button", className: "cl-btn cl-prim cl-mini", onClick: function () { tratarLinksColados(links); } }, ["Processar"]),
        el("button", { type: "button", className: "cl-btn cl-sec cl-mini", onClick: function () {
          links.forEach(lembrarOfertado);
          fecharAvisoCopiado();
        } }, ["Ignorar"]),
      ]),
    ]);
    document.body.appendChild(avisoCopiado);
  }

  /** Mostra/esconde o botão flutuante conforme o login e a opção. */
  function atualizarBotaoColar() {
    var mostrar = estado.opcoes.botaoColar && appLogado() && !estado.aberto;
    if (!mostrar) {
      if (botaoColar) botaoColar.remove();
      botaoColar = null;
      return;
    }
    if (botaoColar && botaoColar.isConnected) return;
    garantirEstilo();
    botaoColar = el("button", {
      type: "button",
      className: "cl-fab",
      title: "Colar o link copiado e processar",
      "aria-label": "Colar o link copiado do TikTok ou do Kwai e processar",
      onClick: aoTocarColar,
    }, [el("span", { className: "cl-fab-icone", "aria-hidden": "true", text: "📋" }), el("span", { className: "cl-fab-texto", text: "Colar link" })]);
    document.body.appendChild(botaoColar);
  }

  function iniciarBotaoColar() {
    atualizarBotaoColar();
    setInterval(atualizarBotaoColar, 1500);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") setTimeout(verificarLinkCopiado, 400);
    });
    window.addEventListener("focus", function () {
      setTimeout(verificarLinkCopiado, 400);
    });
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
    ".cl-links summary{cursor:pointer;font-size:14px;font-weight:700}",
    ".cl-links[open] summary{margin-bottom:6px}",
    ".cl-select{margin-left:6px;border-radius:8px;border:1px solid var(--border,rgba(255,255,255,.15));background:var(--background,#141418);color:inherit;padding:4px 8px;font:inherit}",
    ".cl-fab{position:fixed;right:16px;bottom:16px;z-index:9988;display:inline-flex;align-items:center;gap:8px;height:56px;padding:0 20px 0 16px;border-radius:28px;border:0;background:var(--primary,#e5484d);color:#fff;font:600 15px/1 inherit;font-family:inherit;box-shadow:0 10px 28px rgba(0,0,0,.45);cursor:pointer}",
    ".cl-fab:active{transform:scale(.96)}",
    ".cl-fab-icone{font-size:20px}",
    ".cl-copiado{position:fixed;left:12px;right:12px;bottom:84px;z-index:9989;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px;border-radius:14px;background:var(--card,#1c1c22);color:var(--foreground,#f4f4f6);border:1px solid var(--primary,#e5484d);box-shadow:0 12px 32px rgba(0,0,0,.5);font-size:14px;font-family:inherit;max-width:560px;margin:0 auto}",
    "@media (min-width:768px){.cl-fab{height:48px;font-size:14px}.cl-fab-texto{display:inline}}",
    ".cl-folha{align-items:flex-end;padding:0}",
    ".cl-folha .cl-painel{max-width:560px;border-radius:16px 16px 0 0;padding:20px;gap:12px;display:flex;flex-direction:column}",
    ".cl-folha h2{margin:0;font-size:18px}",
    ".cl-recebidos{margin:0;padding:0 0 0 18px;font-size:12px;color:var(--muted-foreground,#a3a3ad);word-break:break-all}",
    ".cl-escolha .cl-btn{flex:1;min-height:48px}",
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
    ".cl-pilula{position:fixed;right:16px;bottom:84px;z-index:9989;background:var(--card,#1c1c22);color:var(--foreground,#f4f4f6);border:1px solid var(--primary,#e5484d);border-radius:999px;padding:10px 16px;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.4);font-family:inherit}",
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
    if (!estado.aCorrer || !estaAtivo(it)) {
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

  function desenharSecaoCelular() {
    var seletor = el("select", { className: "cl-select", "aria-label": "Ao partilhar do celular" }, [
      el("option", { value: "perguntar", text: "Perguntar sempre" }),
      el("option", { value: "aqui", text: "Processar logo no celular" }),
      el("option", { value: "nuvem", text: "Processar na nuvem (servidor)" }),
      el("option", { value: "pc", text: "Mandar para o PC" }),
    ]);
    seletor.value = estado.opcoes.aoPartilhar;
    seletor.addEventListener("change", function () {
      guardarEscolha(seletor.value);
    });
    var caixaPC = el("input", { type: "checkbox", checked: estado.opcoes.processarLinksDoCelular || null });
    caixaPC.addEventListener("change", function () {
      estado.opcoes.processarLinksDoCelular = caixaPC.checked;
      gravarOpcoes();
      if (caixaPC.checked) verificarCaixa();
    });
    var aEsperar = lerCaixa().filter(function (e) { return e.estado === "pendente" && e.destino === "pc"; }).length;
    return el("details", { className: "cl-links" }, [
      el("summary", { text: "📱 Compartilhar do celular" + (aEsperar ? " · " + aEsperar + " link" + (aEsperar > 1 ? "s" : "") + " à espera do PC" : "") }),
      el("span", { className: "cl-sub", text: "No Android: abre o site no Chrome → menu ⋮ → «Instalar app». Depois, no TikTok ou no Kwai, toca em Partilhar → CineClip." }),
      el("label", { className: "cl-opcao" }, [el("span", { text: "Quando partilho um vídeo:" }), seletor]),
      el("label", { className: "cl-opcao" }, [caixaPC, el("span", { text: "Este aparelho processa sozinho os links mandados do celular para o PC (deixa-o com o CineClip aberto)." })]),
      opcaoSimples("botaoColar", "Mostrar o botão flutuante 📋 «Colar link»", atualizarBotaoColar),
      opcaoSimples("avisarLinkCopiado", "Ao voltar ao app com um link copiado, perguntar se quero processá-lo", null),
      desenharEstadoNuvem(),
    ]);
  }

  /**
   * Chave curta para instalar o servidor (servidor/README.md): o cofre, a chave de
   * cifra e a nuvem durável — o mesmo que vai no código do Robô 24h, em ~300
   * caracteres para colar no terminal. Dá acesso total ao cofre: não partilhar.
   */
  function chaveDoServidor() {
    var sessao = lerJson("cineclip.auth.session", null);
    var app = ambiente.app();
    var s = (app && app.settings) || {};
    if (!sessao || !sessao.vaultHash || !sessao.encryptionKeyB64) throw new Error("Entra na tua conta primeiro.");
    var cfg = {
      CONTA: sessao.username || "",
      VAULT_HASH: sessao.vaultHash,
      ENCRYPTION_KEY_B64: sessao.encryptionKeyB64,
      R2_WORKER_URL: String(s.r2WorkerUrl || "").trim().replace(/\/+$/, ""),
      R2_TOKEN: String(s.r2Token || "").trim(),
      DRIVE_SCRIPT_URL: String(s.driveScriptUrl || "").trim(),
      DRIVE_TOKEN: String(s.driveToken || "").trim(),
    };
    if ((!cfg.R2_WORKER_URL || !cfg.R2_TOKEN) && (!cfg.DRIVE_SCRIPT_URL || !cfg.DRIVE_TOKEN)) {
      throw new Error("O servidor precisa do Cloudflare R2 (ou Google Drive): configura-o nas definições primeiro.");
    }
    var json = JSON.stringify(cfg);
    var b64 = btoa(unescape(encodeURIComponent(json)));
    return "CINECLIP1:" + b64;
  }

  async function copiarChaveDoServidor(alvo) {
    var chave;
    try {
      chave = chaveDoServidor();
    } catch (e) {
      alvo.textContent = mensagemDeErro(e);
      return;
    }
    try {
      await navigator.clipboard.writeText(chave);
      alvo.textContent = "Copiada. Cola-a no servidor (sudo cineclip configurar). Não a partilhes: dá acesso ao teu cofre.";
    } catch (e) {
      var area = el("textarea", { className: "cl-texto", rows: "3", readonly: true });
      area.value = chave;
      alvo.textContent = "";
      alvo.appendChild(area);
      try {
        area.select();
      } catch (e2) {}
    }
  }

  var NOMES_NUVEM = { pendente: "Na fila da nuvem", feito: "Agendado", revisar: "Rever", erro: "Erro" };

  /** Estado do servidor e dos últimos links mandados para a nuvem. */
  function desenharEstadoNuvem() {
    var visto = servidorVistoEm();
    var minutos = visto ? Math.max(0, Math.round((ambiente.agora() - visto) / 60000)) : null;
    var linha = nuvemVercelPronta()
      ? "☁️ Nuvem (Vercel): pronta — processa quando mandas links"
      : servidorLigado()
      ? "☁️ Servidor na nuvem: ligado" + (minutos ? " (visto há " + minutos + " min)" : "")
      : visto
        ? "☁️ Servidor na nuvem: sem sinal há " + (minutos >= 120 ? Math.round(minutos / 60) + " h" : minutos + " min")
        : "☁️ Nuvem: ainda não configurada — cola a chave abaixo nas variáveis da Vercel (ver servidor/README.md)";
    var nuvem = lerCaixa()
      .filter(function (e) { return e.destino === "nuvem"; })
      .sort(function (a, b) { return (b.atualizadoEm || 0) - (a.atualizadoEm || 0); })
      .slice(0, 8);
    var filhos = [el("div", { className: "cl-sub", text: linha })];
    var estadoChave = el("span", { className: "cl-peso", role: "status" });
    filhos.push(el("div", { className: "cl-linha" }, [
      el("button", { type: "button", className: "cl-btn cl-sec cl-mini", onClick: function () {
        copiarChaveDoServidor(estadoChave);
      } }, ["🔑 Copiar chave do servidor"]),
      estadoChave,
    ]));
    if (nuvem.length) {
      filhos.push(el("ul", { className: "cl-lista" }, nuvem.map(function (e) {
        var acoes = [];
        if (e.estado === "erro" || e.estado === "revisar") {
          var rever = e.estado === "revisar";
          acoes.push(el("button", { type: "button", className: "cl-btn cl-sec cl-mini", onClick: function () {
            // "Rever" = a IA teve pouca certeza; repetir daria o mesmo. Quem viu e
            // concorda manda agendar assim mesmo.
            reabrirEntrada(e.id, "nuvem", { forcar: rever });
            pedirSincronizacao();
            sincronizacao.then(function () {
              acordarNuvem(true);
            });
            desenhar();
          } }, [rever ? "Agendar mesmo assim (nuvem)" : "Tentar de novo na nuvem"]));
          acoes.push(el("button", { type: "button", className: "cl-btn cl-sec cl-mini", onClick: function () {
            reabrirEntrada(e.id, "aqui");
            pedirSincronizacao();
            verificarCaixa();
            desenhar();
          } }, ["Fazer aqui"]));
        }
        return el("li", { className: "cl-item", "data-estado": e.estado }, [
          el("div", { className: "cl-linha" }, [
            el("span", { className: "cl-nome", title: e.url, text: e.url.replace(/^https?:\/\/(www\.)?/, "") }),
            el("span", { className: "cl-selo " + (e.estado === "feito" ? "agendado" : e.estado), text: NOMES_NUVEM[e.estado] || e.estado }),
          ]),
          e.erro ? el("div", { className: "cl-det " + e.estado, text: e.erro }) : null,
          acoes.length ? el("div", { className: "cl-acoes" }, acoes) : null,
        ]);
      })));
    }
    return el("div", { className: "cl-nuvem" }, filhos);
  }

  function opcaoSimples(chave, texto, depois) {
    var caixa = el("input", { type: "checkbox", checked: estado.opcoes[chave] || null });
    caixa.addEventListener("change", function () {
      estado.opcoes[chave] = caixa.checked;
      gravarOpcoes();
      if (depois) depois();
    });
    return el("label", { className: "cl-opcao" }, [caixa, el("span", { text: texto })]);
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
          (conta && conta.name ? " de " + conta.name : "") + ". Processa até " + (estado.opcoes.simultaneos || MAX_SIMULTANEOS) + " vídeos ao mesmo tempo. Podes fechar este painel e ver o Agendador enquanto isso.",
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

    var seletorSim = el("select", { className: "cl-select", "aria-label": "Vídeos ao mesmo tempo" }, [1, 2, 3, 4, 5].map(function (n) {
      return el("option", { value: String(n), text: n === 1 ? "1 vídeo de cada vez" : n + " vídeos ao mesmo tempo" + (n === 5 ? " (máximo)" : "") });
    }));
    seletorSim.value = String(estado.opcoes.simultaneos || MAX_SIMULTANEOS);
    seletorSim.addEventListener("change", function () {
      var v = Math.max(1, Math.min(MAX_SIMULTANEOS, Number(seletorSim.value) || MAX_SIMULTANEOS));
      estado.opcoes.simultaneos = v;
      gravarOpcoes();
      desenhar();
    });
    corpo.push(el("label", { className: "cl-opcao" }, [
      el("span", { text: "⚡ Processamento simultâneo:" }),
      seletorSim,
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

    corpo.push(desenharSecaoCelular());

    if (estado.itens.length) {
      corpo.push(el("ul", { className: "cl-lista" }, estado.itens.map(desenharItem)));
    }

    var resumo = [];
    if (estado.itens.length) {
      resumo.push(estado.itens.length + " vídeo" + (estado.itens.length > 1 ? "s" : ""));
      if (contar("a_processar")) resumo.push(contar("a_processar") + " a processar");
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
    var ativos = contar("a_processar");
    var total = feitos + contar("pendente") + ativos;
    var mostrados = ativos > 0 ? Math.min(total, Math.max(1, feitos)) : Math.min(total, feitos + 1);
    pilula.textContent = "📦 Upload em massa: " + mostrados + "/" + total + (ativos > 1 ? " (" + ativos + " simultâneos)" : "") + " — abrir";
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
    atualizarBotaoColar();
    verificarServidor().then(function () {
      if (estado.aberto) desenhar();
    });
    document.addEventListener("keydown", aoTeclar);
    if (ficheiros && ficheiros.length) adicionarFicheiros(ficheiros);
    else desenhar();
  }

  function fechar() {
    estado.aberto = false;
    setTimeout(atualizarBotaoColar, 0);
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
    /** Chamado pela sincronização do app (patch 31-links-cofre). */
    mesclarLinks: mesclarLinks,
    /** Só para os testes (tools/test-lote-massa.mjs). */
    _interno: {
      ambiente: ambiente,
      hashPerceptualVideo: hashPerceptualVideo,
      /**
       * Partilhados com o «⚡ Agendamento rápido» (agendamento-rapido.js): o
       * mesmo par {IA, TMDB} é reaproveitado nos dois modos, por isso o mesmo
       * vídeo não gasta duas chamadas à IA.
       */
      cacheIdentLer: cacheIdentLer,
      cacheIdentGuardar: cacheIdentGuardar,
      lerVideoNoNavegador: lerVideoNoNavegador,
      estado: estado,
      adicionarFicheiros: adicionarFicheiros,
      importarLinks: importarLinks,
      extrairLinks: extrairLinks,
      lerCaixa: lerCaixa,
      adicionarACaixa: adicionarACaixa,
      marcarEntrada: marcarEntrada,
      mesclarLinks: mesclarLinks,
      verificarCaixa: verificarCaixa,
      receberPartilha: receberPartilha,
      linksDaPartilha: linksDaPartilha,
      enviarPara: enviarPara,
      meuAparelho: meuAparelho,
      aoTocarColar: aoTocarColar,
      verificarServidor: verificarServidor,
      acordarNuvem: acordarNuvem,
      nuvemVercelPronta: nuvemVercelPronta,
      chaveDoServidor: chaveDoServidor,
      servidorLigado: servidorLigado,
      verificarLinkCopiado: verificarLinkCopiado,
      atualizarBotaoColar: atualizarBotaoColar,
      iniciar: iniciar,
      parar: parar,
      processarItem: processarItem,
      faltaConfigurar: faltaConfigurar,
      horarioLegivel: horarioLegivel,
      MAX_SEGUNDOS: MAX_SEGUNDOS,
      MAX_SIMULTANEOS: MAX_SIMULTANEOS,
      CONFIANCA_MINIMA: CONFIANCA_MINIMA,
    },
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", iniciarCompartilhar);
  else iniciarCompartilhar();
})();
