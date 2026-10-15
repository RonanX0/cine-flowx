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
      return {
        agendarComPoucaCerteza: !!o.agendarComPoucaCerteza,
        aoPartilhar: o.aoPartilhar === "aqui" || o.aoPartilhar === "pc" || o.aoPartilhar === "nuvem" ? o.aoPartilhar : "perguntar",
        processarLinksDoCelular: typeof o.processarLinksDoCelular === "boolean" ? o.processarLinksDoCelular : !eCelular(),
        botaoColar: o.botaoColar !== false,
        avisarLinkCopiado: o.avisarLinkCopiado !== false,
      };
    } catch (e) {
      return { agendarComPoucaCerteza: false, aoPartilhar: "perguntar", processarLinksDoCelular: !eCelular(), botaoColar: true, avisarLinkCopiado: true };
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

  function comLimite(promessa, ms, msg) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () {
        reject(new Error(msg || "A operação demorou demasiado tempo."));
      }, ms);
      if (t && typeof t.unref === "function") t.unref();
      Promise.resolve(promessa).then(
        function (v) {
          clearTimeout(t);
          resolve(v);
        },
        function (e) {
          clearTimeout(t);
          reject(e);
        }
      );
    });
  }

  /* ------------------------------------ leitor binário de cabeçalho de vídeo */
  /*
   * Lê largura, altura (com rotação aplicada), duração, codec e título diretamente
   * dos bytes do container (MP4/MOV/M4V, WebM/MKV e AVI) usando File.slice().
   * Demora poucos milissegundos e não depende do elemento <video> (que trava em
   * abas em segundo plano ou devolve duration = Infinity) nem do download do
   * MediaInfoModule.wasm a partir do unpkg.
   */
  async function lerCabecalhoVideo(ficheiro) {
    var vazio = { largura: 0, altura: 0, duracao: 0, temAudio: null, codec: "", titulo: "" };
    if (!ficheiro || typeof ficheiro.slice !== "function" || !(ficheiro.size > 16)) return vazio;
    var tamanhoTotal = Number(ficheiro.size) || 0;

    async function lerBytes(inicio, comp) {
      var ini = Math.max(0, Math.min(tamanhoTotal, Math.floor(inicio)));
      var fim = Math.max(ini, Math.min(tamanhoTotal, ini + Math.floor(comp)));
      if (fim <= ini) return new Uint8Array(0);
      var fatia = ficheiro.slice(ini, fim);
      if (typeof fatia.arrayBuffer === "function") {
        return new Uint8Array(await fatia.arrayBuffer());
      }
      return new Promise(function (res, rej) {
        var fr = new FileReader();
        fr.onload = function () {
          res(fr.result instanceof ArrayBuffer ? new Uint8Array(fr.result) : new Uint8Array(0));
        };
        fr.onerror = function () {
          rej(new Error("leitura"));
        };
        fr.readAsArrayBuffer(fatia);
      });
    }

    function ascii(u8, pos, len) {
      var s = "";
      var lim = Math.min(u8.length, pos + len);
      for (var i = pos; i < lim; i++) s += String.fromCharCode(u8[i]);
      return s;
    }

    function utf8(u8, pos, len) {
      var sub = u8.subarray(pos, Math.min(u8.length, pos + len));
      try {
        return new TextDecoder("utf-8").decode(sub).replace(/\0+$/g, "").trim();
      } catch (e) {
        return ascii(u8, pos, len).replace(/\0+$/g, "").trim();
      }
    }

    function lerU64(dv, pos) {
      var hi = dv.getUint32(pos);
      var lo = dv.getUint32(pos + 4);
      return hi * 4294967296 + lo;
    }

    try {
      var cab = await lerBytes(0, Math.min(tamanhoTotal, 65536));
      if (cab.length < 12) return vazio;
      var dv0 = new DataView(cab.buffer, cab.byteOffset, cab.byteLength);

      /* 1. WebM / MKV (EBML 0x1A 0x45 0xDF 0xA3) */
      if (cab[0] === 0x1a && cab[1] === 0x45 && cab[2] === 0xdf && cab[3] === 0xa3) {
        var bufEbml = cab.length < Math.min(tamanhoTotal, 262144)
          ? await lerBytes(0, Math.min(tamanhoTotal, 262144))
          : cab;
        var resMkv = analisarEbml(bufEbml, utf8);
        if (!resMkv.duracao && tamanhoTotal > 4096) {
          var caudaMkv = await lerBytes(Math.max(0, tamanhoTotal - 262144), 262144);
          var durCauda = estimarDuracaoClusterEbml(caudaMkv, resMkv._escala || 1000000);
          if (durCauda > 0) resMkv.duracao = durCauda;
        }
        delete resMkv._escala;
        return resMkv;
      }

      /* 2. AVI (RIFF....AVI ) */
      if (ascii(cab, 0, 4) === "RIFF" && ascii(cab, 8, 4) === "AVI ") {
        return analisarAvi(cab, dv0, ascii);
      }

      /* 3. MP4 / MOV / M4V (ISO BMFF) */
      var tipo0 = ascii(cab, 4, 4);
      if (/^(ftyp|moov|mdat|wide|free|skip|pnot|pict|styp|sidx|moof|uuid)$/.test(tipo0)) {
        return await analisarIsoBmff(lerBytes, tamanhoTotal, ascii, utf8, lerU64);
      }
    } catch (e) {}
    return vazio;
  }

  function analisarAvi(u8, dv, ascii) {
    var res = { largura: 0, altura: 0, duracao: 0, temAudio: false, codec: "", titulo: "" };
    for (var i = 12; i + 8 <= u8.length; ) {
      var id = ascii(u8, i, 4);
      var tam = dv.getUint32(i + 4, true);
      if (id === "LIST" && i + 12 <= u8.length) {
        i += 12;
        continue;
      }
      if (id === "avih" && i + 8 + 40 <= u8.length) {
        var usPorQuadro = dv.getUint32(i + 8, true);
        var totalQuadros = dv.getUint32(i + 8 + 16, true);
        var larg = dv.getUint32(i + 8 + 32, true);
        var alt = dv.getUint32(i + 8 + 36, true);
        if (larg > 0 && alt > 0) {
          res.largura = larg;
          res.altura = alt;
        }
        if (usPorQuadro > 0 && totalQuadros > 0) {
          res.duracao = (usPorQuadro * totalQuadros) / 1e6;
        }
      } else if (id === "strh" && i + 8 + 32 <= u8.length) {
        var fccType = ascii(u8, i + 8, 4);
        var fccHandler = ascii(u8, i + 12, 4).trim().toLowerCase();
        if (fccType === "vids") {
          if (fccHandler && !res.codec) res.codec = fccHandler;
          if (i + 8 + 36 <= u8.length && !res.duracao) {
            var scale = dv.getUint32(i + 8 + 20, true);
            var rate = dv.getUint32(i + 8 + 24, true);
            var length = dv.getUint32(i + 8 + 32, true);
            if (scale > 0 && rate > 0 && length > 0) res.duracao = (length * scale) / rate;
          }
        } else if (fccType === "auds") {
          res.temAudio = true;
        }
      }
      if (tam <= 0) break;
      i += 8 + tam + (tam % 2);
    }
    return res;
  }

  function lerVintEbml(u8, pos, removerMascara) {
    if (pos >= u8.length) return null;
    var b0 = u8[pos];
    if (b0 === 0) return null;
    var len = 1;
    var mask = 0x80;
    while (len <= 8 && !(b0 & mask)) {
      len++;
      mask >>= 1;
    }
    if (len > 8 || pos + len > u8.length) return null;
    var val = removerMascara ? (b0 & (mask - 1)) : b0;
    var desconhecido = removerMascara && val === mask - 1;
    for (var i = 1; i < len; i++) {
      if (desconhecido && u8[pos + i] !== 0xff) desconhecido = false;
      val = val * 256 + u8[pos + i];
    }
    return { valor: desconhecido ? -1 : val, bytes: len };
  }

  function lerUintEbml(u8, pos, len) {
    var v = 0;
    for (var i = 0; i < len && pos + i < u8.length; i++) v = v * 256 + u8[pos + i];
    return v;
  }

  function lerFloatEbml(u8, pos, len) {
    if (pos + len > u8.length) return 0;
    var dv = new DataView(u8.buffer, u8.byteOffset + pos, len);
    if (len === 4) return dv.getFloat32(0, false);
    if (len === 8) return dv.getFloat64(0, false);
    return 0;
  }

  function analisarEbml(u8, utf8) {
    var res = { largura: 0, altura: 0, duracao: 0, temAudio: false, codec: "", titulo: "", _escala: 1000000 };
    var escala = 1000000;
    var durBruta = 0;

    function percorrer(ini, fim, ctx) {
      var pos = ini;
      while (pos + 2 <= fim && pos + 2 <= u8.length) {
        var idObj = lerVintEbml(u8, pos, false);
        if (!idObj) break;
        var szObj = lerVintEbml(u8, pos + idObj.bytes, true);
        if (!szObj) break;
        var hdr = idObj.bytes + szObj.bytes;
        var dadosIni = pos + hdr;
        var dadosFim = szObj.valor < 0 ? fim : Math.min(fim, dadosIni + szObj.valor);
        var id = idObj.valor;
        var tam = Math.max(0, dadosFim - dadosIni);

        if (id === 0x18538067 || id === 0x1549a966 || id === 0x1654ae6b || id === 0xae || id === 0xe0) {
          var subCtx = id === 0xae ? { tipo: 0, codec: "", larg: 0, alt: 0, dLarg: 0, dAlt: 0 } : ctx;
          percorrer(dadosIni, dadosFim, subCtx);
          if (id === 0xae && subCtx) {
            if (subCtx.tipo === 1) {
              if (!res.largura && (subCtx.larg || subCtx.dLarg)) res.largura = subCtx.larg || subCtx.dLarg;
              if (!res.altura && (subCtx.alt || subCtx.dAlt)) res.altura = subCtx.alt || subCtx.dAlt;
              if (subCtx.codec && !res.codec) res.codec = subCtx.codec.toLowerCase();
            } else if (subCtx.tipo === 2) {
              res.temAudio = true;
            }
          }
        } else if (id === 0x2ad7b1 && tam > 0 && tam <= 8) {
          escala = lerUintEbml(u8, dadosIni, tam) || 1000000;
          res._escala = escala;
        } else if (id === 0x4489 && (tam === 4 || tam === 8)) {
          durBruta = lerFloatEbml(u8, dadosIni, tam);
        } else if (id === 0x7ba9 && tam > 0 && tam < 512) {
          res.titulo = utf8(u8, dadosIni, tam);
        } else if (ctx && id === 0x83 && tam === 1) {
          ctx.tipo = u8[dadosIni];
        } else if (ctx && id === 0x86 && tam > 0 && tam < 128) {
          ctx.codec = utf8(u8, dadosIni, tam);
        } else if (ctx && id === 0xb0 && tam > 0 && tam <= 4) {
          ctx.larg = lerUintEbml(u8, dadosIni, tam);
        } else if (ctx && id === 0xba && tam > 0 && tam <= 4) {
          ctx.alt = lerUintEbml(u8, dadosIni, tam);
        } else if (ctx && id === 0x54b0 && tam > 0 && tam <= 4) {
          ctx.dLarg = lerUintEbml(u8, dadosIni, tam);
        } else if (ctx && id === 0x54ba && tam > 0 && tam <= 4) {
          ctx.dAlt = lerUintEbml(u8, dadosIni, tam);
        } else if (id === 0x1f43b675) {
          break;
        }
        if (dadosFim <= pos) break;
        pos = dadosFim;
      }
    }

    percorrer(0, u8.length, null);
    if (durBruta > 0 && escala > 0) {
      res.duracao = (durBruta * escala) / 1e9;
    }
    return res;
  }

  function estimarDuracaoClusterEbml(u8, escala) {
    var maxTc = 0;
    for (var i = 0; i + 12 < u8.length; i++) {
      if (u8[i] === 0x1f && u8[i + 1] === 0x43 && u8[i + 2] === 0xb6 && u8[i + 3] === 0x75) {
        var sz = lerVintEbml(u8, i + 4, true);
        if (!sz) continue;
        var pos = i + 4 + sz.bytes;
        var fim = sz.valor < 0 ? u8.length : Math.min(u8.length, pos + sz.valor);
        var clusterTc = 0;
        var maxRelTc = 0;
        var passos = 0;
        while (pos + 2 < fim && passos++ < 500) {
          var idObj = lerVintEbml(u8, pos, false);
          if (!idObj) break;
          var sObj = lerVintEbml(u8, pos + idObj.bytes, true);
          if (!sObj || sObj.valor < 0) break;
          var dIni = pos + idObj.bytes + sObj.bytes;
          var dFim = Math.min(fim, dIni + sObj.valor);
          if (idObj.valor === 0xe7 && sObj.valor >= 1 && sObj.valor <= 8) {
            clusterTc = lerUintEbml(u8, dIni, sObj.valor);
          } else if ((idObj.valor === 0xa3 || idObj.valor === 0xa1) && dIni + 4 <= dFim) {
            var trkVint = lerVintEbml(u8, dIni, true);
            if (trkVint && dIni + trkVint.bytes + 2 <= dFim) {
              var rel = (u8[dIni + trkVint.bytes] << 8) | u8[dIni + trkVint.bytes + 1];
              if (rel & 0x8000) rel -= 0x10000;
              if (rel > maxRelTc) maxRelTc = rel;
            }
          }
          pos = dFim;
        }
        if (clusterTc + maxRelTc > maxTc) maxTc = clusterTc + maxRelTc;
      }
    }
    return maxTc > 0 ? (maxTc * (escala || 1000000)) / 1e9 : 0;
  }

  async function analisarIsoBmff(lerBytes, tamanhoTotal, ascii, utf8, lerU64) {
    var res = { largura: 0, altura: 0, duracao: 0, temAudio: false, codec: "", titulo: "" };
    var moovPos = -1;
    var moovTam = 0;
    var sidxPos = -1;
    var sidxTam = 0;
    var temMoof = false;

    var pos = 0;
    for (var iter = 0; iter < 80 && pos + 8 <= tamanhoTotal; iter++) {
      var hdr = await lerBytes(pos, 16);
      if (hdr.length < 8) break;
      var dv = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength);
      var tam = dv.getUint32(0);
      var tipo = ascii(hdr, 4, 4);
      var hLen = 8;
      if (tam === 1) {
        if (hdr.length < 16) break;
        tam = lerU64(dv, 8);
        hLen = 16;
      } else if (tam === 0) {
        tam = tamanhoTotal - pos;
      }
      if (tam < hLen || pos + tam > tamanhoTotal) break;
      if (tipo === "moov") {
        moovPos = pos + hLen;
        moovTam = tam - hLen;
        break;
      } else if (tipo === "sidx" && sidxPos < 0) {
        sidxPos = pos + hLen;
        sidxTam = tam - hLen;
      } else if (tipo === "moof") {
        temMoof = true;
      }
      pos += tam;
    }

    // Caso o ficheiro tenha bytes extras ou mdat truncado, procura a assinatura "moov" no início e no fim
    if (moovPos < 0) {
      var janelas = [[0, Math.min(tamanhoTotal, 262144)]];
      if (tamanhoTotal > 262144) {
        janelas.push([Math.max(0, tamanhoTotal - 1048576), Math.min(tamanhoTotal, 1048576)]);
      }
      for (var j = 0; j < janelas.length && moovPos < 0; j++) {
        var offJ = janelas[j][0];
        var bufJ = await lerBytes(offJ, janelas[j][1]);
        var dvJ = new DataView(bufJ.buffer, bufJ.byteOffset, bufJ.byteLength);
        for (var k = 4; k + 8 <= bufJ.length; k++) {
          if (bufJ[k] === 0x6d && bufJ[k + 1] === 0x6f && bufJ[k + 2] === 0x6f && bufJ[k + 3] === 0x76) {
            var szCand = dvJ.getUint32(k - 4);
            if (szCand >= 32 && szCand <= 16 * 1024 * 1024 && offJ + k - 4 + szCand <= tamanhoTotal) {
              moovPos = offJ + k + 4;
              moovTam = szCand - 8;
              break;
            }
          }
        }
      }
    }

    if (moovPos < 0) return res;
    var moovBuf = await lerBytes(moovPos, Math.min(moovTam, 16 * 1024 * 1024));
    var moovDv = new DataView(moovBuf.buffer, moovBuf.byteOffset, moovBuf.byteLength);
    var mvhdEscala = 0;
    var mvhdDur = 0;
    var mehdDur = 0;
    var videoEscala = 0;
    var padraoSampleDur = 0;

    function caixasFilhas(buf, dv, ini, fim, fn) {
      var p = ini;
      while (p + 8 <= fim && p + 8 <= buf.length) {
        var sz = dv.getUint32(p);
        var tp = ascii(buf, p + 4, 4);
        var hl = 8;
        if (sz === 1) {
          if (p + 16 > fim) break;
          sz = lerU64(dv, p + 8);
          hl = 16;
        } else if (sz === 0) {
          sz = fim - p;
        }
        if (sz < hl || p + sz > fim) break;
        fn(tp, p + hl, p + sz);
        p += sz;
      }
    }

    caixasFilhas(moovBuf, moovDv, 0, moovBuf.length, function (tipo, ini, fim) {
      if (tipo === "mvhd" && ini + 20 <= fim) {
        var v = moovBuf[ini];
        var esc = v === 1 ? (ini + 28 <= fim ? moovDv.getUint32(ini + 20) : 0) : moovDv.getUint32(ini + 12);
        var dur = v === 1 ? (ini + 28 <= fim ? lerU64(moovDv, ini + 24) : 0) : moovDv.getUint32(ini + 16);
        if (v === 0 && dur === 0xffffffff) dur = 0;
        mvhdEscala = esc;
        if (esc > 0 && dur > 0 && dur < 0xffffffffffff) mvhdDur = dur / esc;
      } else if (tipo === "mvex") {
        temMoof = true;
        caixasFilhas(moovBuf, moovDv, ini, fim, function (tp2, i2, f2) {
          if (tp2 === "mehd" && i2 + 8 <= f2) {
            var v2 = moovBuf[i2];
            var d2 = v2 === 1 ? (i2 + 12 <= f2 ? lerU64(moovDv, i2 + 4) : 0) : moovDv.getUint32(i2 + 4);
            if (v2 === 0 && d2 === 0xffffffff) d2 = 0;
            mehdDur = d2;
          } else if (tp2 === "trex" && i2 + 20 <= f2) {
            var defDur = moovDv.getUint32(i2 + 12);
            if (defDur > 0 && !padraoSampleDur) padraoSampleDur = defDur;
          }
        });
      } else if (tipo === "udta") {
        for (var u = ini; u + 24 <= fim; u++) {
          if (moovBuf[u + 4] === 0xa9 && moovBuf[u + 5] === 0x6e && moovBuf[u + 6] === 0x61 && moovBuf[u + 7] === 0x6d) {
            var namSz = moovDv.getUint32(u);
            if (namSz >= 24 && u + namSz <= fim && ascii(moovBuf, u + 12, 4) === "data") {
              var dSz = moovDv.getUint32(u + 8);
              if (dSz > 16 && u + 8 + dSz <= u + namSz) {
                res.titulo = utf8(moovBuf, u + 24, dSz - 16);
                break;
              }
            }
          }
        }
      } else if (tipo === "trak") {
        var trk = { hdlr: "", larg: 0, alt: 0, stsdLarg: 0, stsdAlt: 0, rot: false, escala: 0, dur: 0, sttsDur: 0, codec: "" };
        caixasFilhas(moovBuf, moovDv, ini, fim, function (tpT, iT, fT) {
          if (tpT === "tkhd") {
            var vt = moovBuf[iT];
            var base = iT + (vt === 1 ? 36 : 24);
            if (base + 60 <= fT) {
              var matA = moovDv.getInt32(base + 16);
              var matB = moovDv.getInt32(base + 20);
              var matC = moovDv.getInt32(base + 28);
              var matD = moovDv.getInt32(base + 32);
              if (matA === 0 && matD === 0 && (matB !== 0 || matC !== 0)) trk.rot = true;
              trk.larg = Math.round(moovDv.getUint32(base + 52) / 65536);
              trk.alt = Math.round(moovDv.getUint32(base + 56) / 65536);
            }
          } else if (tpT === "mdia") {
            caixasFilhas(moovBuf, moovDv, iT, fT, function (tpM, iM, fM) {
              if (tpM === "mdhd" && iM + 20 <= fM) {
                var vm = moovBuf[iM];
                trk.escala = vm === 1 ? (iM + 28 <= fM ? moovDv.getUint32(iM + 20) : 0) : moovDv.getUint32(iM + 12);
                var dm = vm === 1 ? (iM + 28 <= fM ? lerU64(moovDv, iM + 24) : 0) : moovDv.getUint32(iM + 16);
                if (vm === 0 && dm === 0xffffffff) dm = 0;
                if (trk.escala > 0 && dm > 0 && dm < 0xffffffffffff) trk.dur = dm / trk.escala;
              } else if (tpM === "hdlr" && iM + 12 <= fM) {
                trk.hdlr = ascii(moovBuf, iM + 8, 4);
              } else if (tpM === "minf") {
                caixasFilhas(moovBuf, moovDv, iM, fM, function (tpI, iI, fI) {
                  if (tpI === "stbl") {
                    caixasFilhas(moovBuf, moovDv, iI, fI, function (tpS, iS, fS) {
                      if (tpS === "stsd" && iS + 16 <= fS) {
                        var fourcc = ascii(moovBuf, iS + 12, 4).trim().toLowerCase();
                        trk.codec = fourcc;
                        if (iS + 44 <= fS) {
                          trk.stsdLarg = moovDv.getUint16(iS + 40);
                          trk.stsdAlt = moovDv.getUint16(iS + 42);
                        }
                      } else if (tpS === "stts" && iS + 8 <= fS) {
                        var nEnt = moovDv.getUint32(iS + 4);
                        var soma = 0;
                        for (var k = 0; k < nEnt && k < 50000 && iS + 8 + (k + 1) * 8 <= fS; k++) {
                          soma += moovDv.getUint32(iS + 8 + k * 8) * moovDv.getUint32(iS + 12 + k * 8);
                        }
                        trk.sttsDur = soma;
                      }
                    });
                  }
                });
              }
            });
          }
        });

        var ehVideo = trk.hdlr === "vide" || (!trk.hdlr && (trk.larg > 0 || trk.stsdLarg > 0));
        var ehAudio = trk.hdlr === "soun";
        if (ehVideo) {
          var w = trk.larg || trk.stsdLarg || 0;
          var h = trk.alt || trk.stsdAlt || 0;
          if (trk.rot && w > 0 && h > 0) {
            var tmp = w;
            w = h;
            h = tmp;
          }
          if (w > 0 && h > 0 && !res.largura) {
            res.largura = w;
            res.altura = h;
          }
          if (trk.codec && !res.codec) res.codec = trk.codec;
          if (trk.escala > 0 && !videoEscala) videoEscala = trk.escala;
          var dTrk = trk.dur || (trk.escala > 0 && trk.sttsDur > 0 ? trk.sttsDur / trk.escala : 0);
          if (dTrk > res.duracao) res.duracao = dTrk;
        } else if (ehAudio) {
          res.temAudio = true;
          var dAud = trk.dur || (trk.escala > 0 && trk.sttsDur > 0 ? trk.sttsDur / trk.escala : 0);
          if (dAud > res.duracao) res.duracao = dAud;
        }
      }
    });

    if (!res.duracao && mvhdDur > 0) res.duracao = mvhdDur;
    if (!res.duracao && mehdDur > 0 && mvhdEscala > 0) res.duracao = mehdDur / mvhdEscala;

    if (!res.duracao && sidxPos > 0 && sidxTam >= 16) {
      var sidxBuf = await lerBytes(sidxPos, Math.min(sidxTam, 65536));
      if (sidxBuf.length >= 16) {
        var sdv = new DataView(sidxBuf.buffer, sidxBuf.byteOffset, sidxBuf.byteLength);
        var sv = sidxBuf[0];
        var sEsc = sdv.getUint32(8);
        var sOff = (sv === 0 ? 16 : 24) + 2;
        if (sEsc > 0 && sOff + 2 <= sidxBuf.length) {
          var refCnt = sdv.getUint16(sOff);
          var somaSidx = 0;
          for (var r = 0; r < refCnt && sOff + 2 + (r + 1) * 12 <= sidxBuf.length; r++) {
            somaSidx += sdv.getUint32(sOff + 2 + r * 12 + 4);
          }
          if (somaSidx > 0) res.duracao = somaSidx / sEsc;
        }
      }
    }

    if (!res.duracao && temMoof && videoEscala > 0) {
      var cauda = await lerBytes(Math.max(0, tamanhoTotal - 524288), 524288);
      var cdv = new DataView(cauda.buffer, cauda.byteOffset, cauda.byteLength);
      var maxFim = 0;
      for (var c = 0; c + 16 <= cauda.length; c++) {
        if (cauda[c + 4] === 0x74 && cauda[c + 5] === 0x72 && cauda[c + 6] === 0x61 && cauda[c + 7] === 0x66) {
          var trafSz = cdv.getUint32(c);
          if (trafSz >= 16 && c + trafSz <= cauda.length) {
            var decTime = 0;
            var defDur = padraoSampleDur;
            var trunDur = 0;
            caixasFilhas(cauda, cdv, c + 8, c + trafSz, function (tpF, iF, fF) {
              if (tpF === "tfhd" && iF + 8 <= fF) {
                var tfFlags = cdv.getUint32(iF) & 0xffffff;
                var offH = iF + 8 + ((tfFlags & 1) ? 8 : 0) + ((tfFlags & 2) ? 4 : 0);
                if ((tfFlags & 8) && offH + 4 <= fF) defDur = cdv.getUint32(offH);
              } else if (tpF === "tfdt" && iF + 8 <= fF) {
                var tv = cauda[iF];
                decTime = tv === 1 ? (iF + 12 <= fF ? lerU64(cdv, iF + 4) : 0) : cdv.getUint32(iF + 4);
              } else if (tpF === "trun" && iF + 8 <= fF) {
                var trFlags = cdv.getUint32(iF) & 0xffffff;
                var sCnt = cdv.getUint32(iF + 4);
                var offR = iF + 8 + ((trFlags & 1) ? 4 : 0) + ((trFlags & 4) ? 4 : 0);
                var passo = ((trFlags & 0x100) ? 4 : 0) + ((trFlags & 0x200) ? 4 : 0) + ((trFlags & 0x400) ? 4 : 0) + ((trFlags & 0x800) ? 4 : 0);
                if ((trFlags & 0x100) && passo > 0) {
                  for (var s = 0; s < sCnt && s < 10000 && offR + s * passo + 4 <= fF; s++) {
                    trunDur += cdv.getUint32(offR + s * passo);
                  }
                } else if (defDur > 0) {
                  trunDur += sCnt * defDur;
                }
              }
            });
            if (decTime + trunDur > maxFim) maxFim = decTime + trunDur;
          }
        }
      }
      if (maxFim > 0) res.duracao = maxFim / videoEscala;
    }

    return res;
  }

  /** Fallback de duração via Web Audio API (quando o container não traz duração no cabeçalho). */
  async function lerDuracaoPorAudio(ficheiro) {
    if (!ficheiro || !(ficheiro.size > 64) || ficheiro.size > 60 * 1024 * 1024) return 0;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return 0;
    var ctx = null;
    try {
      ctx = new Ctx();
      var ab = await comLimite(ficheiro.arrayBuffer(), 6000);
      var buf = await new Promise(function (res, rej) {
        var t = setTimeout(function () {
          rej(new Error("timeout"));
        }, 6000);
        if (t && typeof t.unref === "function") t.unref();
        ctx.decodeAudioData(
          ab,
          function (b) {
            clearTimeout(t);
            res(b);
          },
          function (e) {
            clearTimeout(t);
            rej(e);
          }
        );
      });
      return buf && Number.isFinite(buf.duration) && buf.duration > 0 ? buf.duration : 0;
    } catch (e) {
      return 0;
    } finally {
      try {
        if (ctx && typeof ctx.close === "function") await ctx.close();
      } catch (e2) {}
    }
  }

  /** Dimensões e duração do vídeo, lidas por <video> + cabeçalho binário em paralelo. */
  function lerVideoNoNavegador(ficheiro) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(ficheiro);
      var video = document.createElement("video");
      var terminado = false;
      var buscouInfinito = false;
      var timerInfinito = null;
      var timerRapido = null;
      var cabInfo = { largura: 0, altura: 0, duracao: 0 };

      var promCab = lerCabecalhoVideo(ficheiro)
        .then(function (c) {
          if (c) cabInfo = c;
          return c || cabInfo;
        })
        .catch(function () {
          return cabInfo;
        });

      function duracaoValida(d) {
        return Number.isFinite(d) && d > 0 && d < 1e7 ? d : 0;
      }

      function fim(erro, valor) {
        if (terminado) return;
        terminado = true;
        clearTimeout(limite);
        if (timerInfinito) clearTimeout(timerInfinito);
        if (timerRapido) clearTimeout(timerRapido);
        try {
          video.onloadedmetadata = null;
          video.onloadeddata = null;
          video.oncanplay = null;
          video.ondurationchange = null;
          video.ontimeupdate = null;
          video.onseeked = null;
          video.onerror = null;
          if (video.pause) video.pause();
          video.removeAttribute("src");
          if (video.load) video.load();
          if (video.parentNode) video.parentNode.removeChild(video);
        } catch (e) {}
        URL.revokeObjectURL(url);
        if (erro) reject(erro);
        else resolve(valor);
      }

      function concluirComVideo() {
        var larg = video.videoWidth || cabInfo.largura || 0;
        var alt = video.videoHeight || cabInfo.altura || 0;
        var dur = duracaoValida(video.duration) || duracaoValida(cabInfo.duracao);
        fim(null, { largura: larg, altura: alt, duracao: dur });
      }

      function aoCarregar() {
        if (terminado) return;
        var d = duracaoValida(video.duration);
        if (d > 0) {
          concluirComVideo();
          return;
        }
        // Se o cabeçalho binário já tiver a duração, não precisa forçar seek no <video>
        promCab.then(function (c) {
          if (terminado) return;
          if (duracaoValida(video.duration) > 0 || duracaoValida(c && c.duracao) > 0) {
            concluirComVideo();
            return;
          }
          // Workaround clássico HTML5 para WebM/MKV/streams com video.duration === Infinity/0
          if (!buscouInfinito) {
            buscouInfinito = true;
            timerInfinito = setTimeout(function () {
              try {
                video.currentTime = 0;
              } catch (e) {}
              concluirComVideo();
            }, 1500);
            if (timerInfinito && typeof timerInfinito.unref === "function") timerInfinito.unref();
            try {
              video.currentTime = 1e101;
            } catch (e) {
              concluirComVideo();
            }
          }
        });
      }

      function aoMudarTempoOuDuracao() {
        if (terminado) return;
        if (duracaoValida(video.duration) > 0) {
          if (buscouInfinito) {
            try {
              video.currentTime = 0;
            } catch (e) {}
          }
          concluirComVideo();
        }
      }

      // Se o cabeçalho binário já leu dimensões e duração, não deixa o <video> prender mais de 2,5 s
      promCab.then(function (c) {
        if (terminado || !c || !c.largura || !c.altura || !c.duracao) return;
        timerRapido = setTimeout(function () {
          if (!terminado) {
            fim(null, { largura: c.largura, altura: c.altura, duracao: c.duracao });
          }
        }, 2500);
        if (timerRapido && typeof timerRapido.unref === "function") timerRapido.unref();
      });

      var limite = setTimeout(function () {
        promCab.then(function (c) {
          if (c && (c.largura > 0 || c.duracao > 0)) {
            fim(null, { largura: c.largura || 0, altura: c.altura || 0, duracao: c.duracao || 0 });
          } else {
            fim(new Error("O navegador demorou demasiado a abrir o vídeo."));
          }
        });
      }, 15000);
      if (limite && typeof limite.unref === "function") limite.unref();

      video.preload = "auto";
      video.muted = true;
      video.playsInline = true;
      video.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none";
      video.onloadedmetadata = aoCarregar;
      video.onloadeddata = aoCarregar;
      video.oncanplay = aoCarregar;
      video.ondurationchange = aoMudarTempoOuDuracao;
      video.ontimeupdate = aoMudarTempoOuDuracao;
      video.onseeked = aoMudarTempoOuDuracao;
      video.onerror = function () {
        promCab.then(function (c) {
          if (c && (c.largura > 0 || c.duracao > 0)) {
            fim(null, { largura: c.largura || 0, altura: c.altura || 0, duracao: c.duracao || 0 });
          } else {
            fim(new Error("O navegador não consegue abrir este vídeo."));
          }
        });
      };
      try {
        if (document.body) document.body.appendChild(video);
      } catch (e) {}
      video.src = url;
      try {
        if (video.load) video.load();
      } catch (e) {}
    });
  }

  /**
   * Pede ao servidor (/api/public/importar) o vídeo de um link do TikTok/Kwai.
   * Devolve um File pronto a entrar no lote.
   */
  async function baixarLinkDoServidor(link, aoProgresso) {
    var ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var r;
    try {
      r = await comLimite(
        fetch("/api/public/importar?url=" + encodeURIComponent(link), ctl ? { signal: ctl.signal } : undefined),
        60000,
        "O servidor demorou demasiado a responder ao link."
      );
    } catch (e) {
      try { if (ctl) ctl.abort(); } catch (err) {}
      throw new Error(e && /demasiado/.test(e.message) ? e.message : "Sem ligação ao servidor do CineClip.");
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
    try {
      if (r.body && r.body.getReader) {
        var leitor = r.body.getReader();
        for (;;) {
          var passo = await comLimite(leitor.read(), 30000, "A transferência do vídeo parou de responder.");
          if (passo.done) break;
          partes.push(passo.value);
          recebidos += passo.value.length;
          if (aoProgresso) aoProgresso(recebidos, total);
        }
      } else {
        partes.push(new Uint8Array(await comLimite(r.arrayBuffer(), 60000, "A transferência do vídeo demorou demasiado.")));
      }
    } catch (e) {
      try { if (ctl) ctl.abort(); } catch (err) {}
      throw e;
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
    var arq = new File(partes, nome, { type: "video/mp4" });
    var durSrv = Number(ler("X-Cineclip-Duracao")) || 0;
    var titSrv = ler("X-Cineclip-Titulo") || "";
    if (durSrv > 0) arq._duracaoServidor = durSrv;
    if (titSrv) arq._tituloServidor = titSrv;
    return arq;
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
    for (var i = 0; i < links.length; i++) {
      var link = links[i];
      var chaveLink = idDoLink(link);
      if (estado.itens.some(function (it) { return it.origem && idDoLink(it.origem) === chaveLink && it.estado !== "erro"; })) {
        ok++;
        continue;
      }
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
      var nomeF = f.name || "video.mp4";
      var bytesF = f.size || 0;
      var jaExiste = estado.itens.some(function (it) {
        if (!it || !it.ficheiro) return false;
        if (it.ficheiro === f) return true;
        if (!it.origem && bytesF > 64 && it.nome === nomeF && it.bytes === bytesF && f.lastModified && it.ficheiro.lastModified === f.lastModified && (it.estado === "pendente" || it.estado === "a_processar")) {
          return true;
        }
        return false;
      });
      if (jaExiste) return;
      var item = {
        id: proximoId++,
        ficheiro: f,
        nome: nomeF,
        bytes: bytesF,
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

  function lerDefinicoesApp() {
    var app = ambiente.app();
    var s = (app && app.settings) || {};
    if (s.nvidiaKey || s.geminiKey || s.tmdbKey) return s;
    var guardadas = lerJson("cineclip.settings", null);
    if (guardadas && (guardadas.nvidiaKey || guardadas.geminiKey || guardadas.tmdbKey)) {
      return Object.assign({}, s, guardadas);
    }
    return s;
  }

  /** O que falta configurar para o modo automático (null quando está tudo). */
  function faltaConfigurar() {
    var core = ambiente.core();
    var app = ambiente.app();
    if (!core || !app) return "O app ainda está a carregar. Tenta de novo dentro de alguns segundos.";
    var s = lerDefinicoesApp();
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
    var s = lerDefinicoesApp();
    var ficheiro = item.ficheiro;

    /* 1. Ler o vídeo (em paralelo: <video>, MediaInfo e cabeçalho binário) --- */
    definirPasso(item, "A ler o vídeo…", 0.02);
    var info = { largura: 0, altura: 0, duracao: 0 };
    var erroVideo = null;

    var cabProm = lerCabecalhoVideo(ficheiro).catch(function () {
      return { largura: 0, altura: 0, duracao: 0, temAudio: null, codec: "", titulo: "" };
    });
    var metaProm = core && typeof core.lerMetadados === "function"
      ? comLimite(core.lerMetadados(ficheiro), 18000).catch(function () { return null; })
      : Promise.resolve(null);
    var videoProm = comLimite(ambiente.lerVideo(ficheiro), 20000, "O navegador demorou demasiado a abrir o vídeo.").then(
      function (v) { return { ok: true, valor: v }; },
      function (e) { return { ok: false, erro: e }; }
    );

    var lidos = await Promise.all([videoProm, metaProm, cabProm]);
    var resVid = lidos[0];
    var meta = lidos[1];
    var cab = lidos[2] || {};

    if (resVid.ok && resVid.valor) {
      info = {
        largura: Number(resVid.valor.largura) || 0,
        altura: Number(resVid.valor.altura) || 0,
        duracao: Number.isFinite(Number(resVid.valor.duracao)) && Number(resVid.valor.duracao) > 0 ? Number(resVid.valor.duracao) : 0,
      };
    } else if (resVid.erro) {
      erroVideo = resVid.erro;
    }

    var duracao = (meta && Number.isFinite(Number(meta.duration)) && Number(meta.duration) > 0) ? Number(meta.duration) : 0;
    if (!duracao && info.duracao > 0) duracao = info.duracao;
    if (!duracao && cab.duracao > 0) duracao = Number(cab.duracao);
    if (!duracao && ficheiro && ficheiro._duracaoServidor > 0) duracao = Number(ficheiro._duracaoServidor);

    if ((!info.largura || !info.altura) && meta && meta.width > 0 && meta.height > 0) {
      info = { largura: Number(meta.width), altura: Number(meta.height), duracao: info.duracao || duracao };
    }
    if ((!info.largura || !info.altura) && cab.largura > 0 && cab.altura > 0) {
      info = { largura: Number(cab.largura), altura: Number(cab.altura), duracao: info.duracao || duracao };
    }

    var campo = ((meta && meta.fields) || []).find(function (f) {
      return f && f.label === "Título";
    });
    var tituloMetadados = (campo && campo.value) || cab.titulo || (ficheiro && ficheiro._tituloServidor) || "";

    // Se ainda faltar dimensão ou duração, sonda com o FFmpeg (quando disponível)
    if ((!info.largura || !info.altura || !duracao) && core && typeof core.sondarVideo === "function") {
      try {
        var sonda = await comLimite(core.sondarVideo(ficheiro), 25000);
        if (sonda) {
          if ((!info.largura || !info.altura) && sonda.width > 0 && sonda.height > 0) {
            info = { largura: Number(sonda.width), altura: Number(sonda.height), duracao: info.duracao || duracao || Number(sonda.duration) || 0 };
          }
          if (!duracao && Number.isFinite(Number(sonda.duration)) && Number(sonda.duration) > 0) {
            duracao = Number(sonda.duration);
          }
        }
      } catch (e) {}
    }

    // Fallback de duração via Web Audio API
    if (!duracao) {
      var durAudio = await lerDuracaoPorAudio(ficheiro);
      if (durAudio > 0) duracao = durAudio;
    }

    // Se o <video> deu timeout (ex.: aba em segundo plano) num ficheiro válido, prossegue com dimensões padrão
    if ((!info.largura || !info.altura) && erroVideo && /demorou demasiado/i.test(erroVideo.message || "") && (duracao > 0 || (ficheiro && ficheiro.size > 1024))) {
      info = { largura: 1080, altura: 1920, duracao: duracao || MAX_SEGUNDOS };
      erroVideo = null;
    }

    if (!info.largura || !info.altura) {
      if (erroVideo) throw erroVideo;
      throw erroComTipo(
        "O navegador abre o som mas não a imagem deste vídeo (codec H.265/HEVC, comum em vídeos baixados do TikTok). Converte-o para H.264 e volta a enviar.",
        "codec"
      );
    }
    if (!duracao) duracao = Number(info.duracao) || 0;
    if (!duracao && info.largura > 0 && info.altura > 0 && ficheiro && ficheiro.size > 0) {
      // Vídeo válido cujo container não declarou a duração final (ex.: stream WebM/MP4):
      // assume o limite máximo de 90 s (o FFmpeg encerra no fim real com -shortest).
      duracao = MAX_SEGUNDOS;
    }
    if (!duracao) throw erroComTipo("Não consegui ler a duração do vídeo.", "leitura");
    var fim = Math.min(MAX_SEGUNDOS, duracao);
    if (fim < 3) throw erroComTipo("O vídeo tem menos de 3 segundos (o Instagram não aceita).", "leitura");

    var corte = { top: 0, bottom: 0, vw: info.largura, vh: info.altura };
    var videoAbriuNoNavegador = !!(resVid.ok && resVid.valor && resVid.valor.largura > 0);
    if (videoAbriuNoNavegador) {
      try {
        var barras = await comLimite(core.detetarBarras(ficheiro, 0, fim), 25000);
        if (barras && barras.vh) {
          corte = {
            top: barras.y,
            bottom: barras.vh - barras.y - barras.h,
            vw: info.largura,
            vh: info.altura,
          };
        }
      } catch (e) {}
    }

    /* 2. Identificar o filme (quadros + áudio em paralelo) --------------- */
    definirPasso(item, "A identificar o filme…", 0.1);
    var temGemini = !!String(s.geminiKey || "").trim();
    var promQuadros = comLimite(core.quadros(ficheiro, 0, fim, corte), 90000, "A extração de quadros do vídeo demorou demasiado.");
    var promAudio = temGemini && typeof core.audio === "function"
      ? comLimite(core.audio(ficheiro, 0, fim), 12000).catch(function () { return null; })
      : Promise.resolve(null);
    var parMidia = await Promise.all([promQuadros, promAudio]);
    var quadros = parMidia[0];
    var audio = parMidia[1];
    var ia = await comLimite(
      core.identificar(s.nvidiaKey, quadros, s.lang, {
        fileName: ficheiro.name,
        metaTitle: tituloMetadados,
        userHint: "",
        geminiKey: s.geminiKey,
        audioClip: audio,
      }),
      120000,
      "A identificação do filme pela IA demorou demasiado."
    );
    if (!ia || (!ia.titulo && !ia.titulo_original && !ia._pistaDireta && !(ia.atores && ia.atores.length) && !(ia.alternativas && ia.alternativas.length))) {
      throw erroComTipo("A IA não conseguiu identificar o filme deste clipe.", "identificacao");
    }
    var filme = await comLimite(core.procurarTmdb(s.tmdbKey, ia), 30000, "A pesquisa no TMDB demorou demasiado.");
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
    var primeiroGancho = function (lista) {
      return (lista || []).find(function (x) {
        return x && String(x).trim();
      });
    };
    /* O gancho é escrito com o filme JÁ confirmado no TMDB (título, ano, sinopse,
       géneros). Os ganchos que vieram da identificação foram escritos quando a obra
       ainda era só um palpite — ficam como reserva. */
    var gancho;
    try {
      var g = await comLimite(
        core.gerarGancho(
          s.nvidiaKey,
          quadros,
          s.lang,
          { titulo: filme.title, ano: filme.year, tipo: filme.kind, sinopse: filme.overview, generos: filme.genres },
          s.geminiKey,
          audio
        ),
        60000
      );
      gancho = primeiroGancho(g && g.ganchos);
      if (!cena && g && g.cena) cena = g.cena;
    } catch (e) {}
    if (!gancho) gancho = primeiroGancho(ia.ganchos);
    gancho = String(gancho || s.overlayText || core.ganchoPadrao || "").trim();
    item.resultado.gancho = gancho;

    /* 4. Processar o vídeo -------------------------------------------------- */
    definirPasso(item, "A processar o vídeo… 0%", 0.25);
    var blob;
    try {
      blob = await comLimite(
        core.processar(ficheiro, 0, fim, s.resolution, gancho, function (fracao) {
          var pct = Math.max(0, Math.min(1, Number(fracao) || 0));
          definirPasso(item, "A processar o vídeo… " + Math.round(pct * 100) + "%", 0.25 + pct * 0.6);
        }, corte),
        240000,
        "O processamento do vídeo (FFmpeg) demorou demasiado."
      );
    } catch (e) {
      if (!estado.pararPedido && e && /demorou demasiado/.test(e.message) && core && typeof core.cancelarProcessamento === "function") {
        try { core.cancelarProcessamento(); } catch (err) {}
      }
      throw e;
    }
    if (!blob || !blob.size) throw erroComTipo("O FFmpeg não devolveu o vídeo processado.", "processamento");

    /* 5. Legenda ------------------------------------------------------------- */
    definirPasso(item, "A escrever a legenda…", 0.88);
    var legenda = await comLimite(
      core.gerarLegenda(s.nvidiaKey, filme, s.lang, {
        cena: cena,
        hookText: gancho,
        geminiKey: s.geminiKey,
      }),
      90000,
      "A criação da legenda pela IA demorou demasiado."
    );
    if (!legenda || !String(legenda).trim()) throw erroComTipo("A IA devolveu uma legenda vazia.", "legenda");
    try {
      core.guardarHistorico({ title: filme.title, year: filme.year, caption: legenda, date: ambiente.agora() });
    } catch (e) {}

    /* 6. Agendar ------------------------------------------------------------- */
    definirPasso(item, "A agendar…", 0.95);
    var fila = await core.lerFila();
    var chaveOrig = item.caixaId || (item.origem ? idDoLink(item.origem) : "");
    var tentItem = item.caixaTentativa || 0;
    var jaAgendado = chaveOrig
      ? (fila || []).find(function (r) {
          if (!r || r.status === "deleted" || (r.accountId || "acc_default") !== conta.id) return false;
          var chR = r.caixaId || (r.linkOrigem ? idDoLink(r.linkOrigem) : "");
          return chR === chaveOrig && (r.caixaTentativa || 0) === tentItem;
        })
      : null;
    var horario = jaAgendado && jaAgendado.scheduledAt ? jaAgendado.scheduledAt : core.proximoHorario(fila, conta.dailySlots || [], conta.id);
    var base = semExtensao(ficheiro.name);
    var agora = ambiente.agora();
    var reel = {
      id: jaAgendado ? jaAgendado.id : "reel_" + agora + "_" + Math.random().toString(36).slice(2, 6),
      accountId: conta.id,
      createdAt: jaAgendado ? jaAgendado.createdAt || agora : agora,
      updatedAt: agora,
      scheduledAt: horario,
      status: jaAgendado && jaAgendado.status === "published" ? "published" : "scheduled",
      title: filme.title || base,
      originalTitle: filme.original,
      year: filme.year,
      tmdbId: filme.tmdbId,
      imdbId: filme.imdbId,
      chave: filme.chave,
      poster: filme.poster,
      hookText: gancho,
      caption: core.limparLegenda(String(legenda)),
      videoBlob: blob,
      videoFileName: base + "_cineclip.mp4",
      videoSize: blob.size || 0,
      platforms: ["instagram"],
    };
    if (item.origem) reel.linkOrigem = item.origem;
    if (item.caixaId) {
      reel.caixaId = item.caixaId;
      reel.caixaTentativa = tentItem;
    }
    if (!jaAgendado) await core.guardarNaFila(reel);
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
    manterEcraLigado(true);
    var agendadosAntes = contar("agendado");
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
          if (item.caixaId) marcarEntrada(item.caixaId, "feito", { reelId: item.resultado && item.resultado.reelId });
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
            if (item.caixaId) {
              marcarEntrada(item.caixaId, "erro", { erro: item.erro });
              pedirSincronizacao();
            }
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
      manterEcraLigado(false);
      desenhar();
      avisarFimDoLote(feitos - agendadosAntes);
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

  /* ----------------------------------------- 📱 compartilhar do celular */
  /*
   * Caixa de entrada de links. Cada link que chega pelo menu "Compartilhar" do
   * Android (ou que o celular manda para o PC) fica aqui até virar um Reel:
   *   { id, url, destino: "aqui" | "pc", aparelho, estado: "pendente" | "feito" | "erro",
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
        delete caixaProcessados[id + ":" + (existente.tentativa || 0)];
        novos.push(existente);
        return;
      }
      if (existente) lista = lista.filter(function (e) { return e.id !== id; });
      var entrada = { id: id, url: url, destino: destino, contaId: contaId, aparelho: meuAparelho(), estado: "pendente", criadoEm: agora, atualizadoEm: agora };
      // Partilhar outra vez um link já tratado é uma nova tentativa: ganha à antiga ao juntar com a nuvem.
      if (existente) entrada.tentativa = (existente.tentativa || 0) + 1;
      delete caixaProcessados[id + ":" + (entrada.tentativa || 0)];
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
      delete caixaProcessados[id + ":" + (e.tentativa || 0)];
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
      verificarCaixa();
      acordarNuvem(false);
    }, 0);
    return lista;
  }

  var caixaProcessados = {};

  /** Links que ESTE aparelho deve processar agora. */
  function entradasParaMim() {
    var eu = meuAparelho();
    var processoPC = estado.opcoes.processarLinksDoCelular;
    var noLote = {};
    estado.itens.forEach(function (it) {
      if (it.caixaId) noLote[it.caixaId] = true;
    });
    return lerCaixa().filter(function (e) {
      var chaveTent = e.id + ":" + (e.tentativa || 0);
      if (e.estado !== "pendente" || noLote[e.id] || caixaProcessados[chaveTent]) return false;
      if (e.destino === "aqui") return e.aparelho === eu;
      return e.destino === "pc" && processoPC;
    });
  }

  var caixaOcupada = false;

  /** Importa os links pendentes deste aparelho para o lote e começa sozinho. */
  async function verificarCaixa() {
    if (caixaOcupada || estado.links.aImportar) return;
    if (!ambiente.core() || !ambiente.app() || faltaConfigurar()) return;
    var entradas = entradasParaMim();
    if (!entradas.length) {
      if (!estado.aCorrer && pendentes().some(function (it) { return it.caixaId; })) iniciar();
      return;
    }
    caixaOcupada = true;
    try {
      for (var i = 0; i < entradas.length; i++) {
        var e = entradas[i];
        var chaveTent = e.id + ":" + (e.tentativa || 0);
        if (caixaProcessados[chaveTent] || estado.itens.some(function (it) { return it.caixaId === e.id; })) continue;
        caixaProcessados[chaveTent] = true;
        estado.links.estado = "📥 A importar link " + (i + 1) + "/" + entradas.length + " do celular…";
        desenhar();
        try {
          var ficheiro = await ambiente.baixarLink(e.url, function (recebidos, total) {
            estado.links.estado = "📥 A importar link " + (i + 1) + "/" + entradas.length + "… " +
              (total ? Math.round((recebidos / total) * 100) + "%" : tamanho(recebidos));
            desenharEstadoLinks();
          });
          var antesLen = estado.itens.length;
          adicionarFicheiros([ficheiro]);
          var novo = estado.itens.length > antesLen ? estado.itens[estado.itens.length - 1] : null;
          if (novo) {
            novo.origem = e.url;
            novo.caixaId = e.id;
            novo.caixaTentativa = e.tentativa || 0;
          }
        } catch (erro) {
          var msg = "Não importei este link: " + mensagemDeErro(erro, "falha desconhecida.");
          marcarEntrada(e.id, "erro", { erro: msg });
          estado.itens.push({
            id: proximoId++, ficheiro: null, nome: e.url, bytes: 0, estado: "erro", invalido: true,
            passo: "", progresso: 0, erro: msg, resultado: null, origem: e.url, caixaId: e.id, caixaTentativa: e.tentativa || 0,
          });
        }
      }
      estado.links.estado = "";
    } finally {
      caixaOcupada = false;
      desenhar();
    }
    if (!estado.aCorrer && pendentes().length) iniciar();
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
      await new Promise(function (r) { var t = setTimeout(r, 300); if (t && typeof t.unref === "function") t.unref(); });
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
    var iv = setInterval(atualizarBotaoColar, 1500); if (iv && typeof iv.unref === "function") iv.unref();
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
    if (!cfg.R2_WORKER_URL || !cfg.R2_TOKEN) throw new Error("O servidor precisa do Cloudflare R2: configura-o nas definições primeiro.");
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

    corpo.push(desenharSecaoCelular());

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
      lerCabecalhoVideo: lerCabecalhoVideo,
      lerDuracaoPorAudio: lerDuracaoPorAudio,
      iniciar: iniciar,
      parar: parar,
      processarItem: processarItem,
      faltaConfigurar: faltaConfigurar,
      horarioLegivel: horarioLegivel,
      MAX_SEGUNDOS: MAX_SEGUNDOS,
      CONFIANCA_MINIMA: CONFIANCA_MINIMA,
    },
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", iniciarCompartilhar);
  else iniciarCompartilhar();
})();
