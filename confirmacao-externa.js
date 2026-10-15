/* Confirmação externa de filmes e séries — CineClip
 * ============================================================================
 * O TMDB é um catálogo comunitário: por vezes tem o filme, por vezes tem
 * remakes com o mesmo nome, por vezes falta a série. Este módulo consulta
 * mais duas bases —gratuitas e sem chave— para confirmar (ou desmentir) o
 * que a IA e o TMDB disseram:
 *
 *   • Wikidata (wikidata.org) — a enciclopédia estruturada da Wikimedia.
 *     Confirma título + ano numa base independente e guarda os identificadores
 *     de interoperabilidade: P345 (IMDb) e P4947/P4983 (ID do TMDB).
 *     É a ponte que permite encontrar uma obra que a pesquisa por título
 *     do TMDB não devolveu.
 *
 *   • TVmaze (api.tvmaze.com) — base de séries, sem chave, com o ID do IMDb,
 *     a nota e a data de estreia. Serve para confirmar uma série noutra fonte.
 *
 * Nada disto bloqueia a identificação: a confirmação corre **em paralelo** com
 * o TMDB e, se a fonte externa estiver em baixo ou demorar, o app continua
 * exactamente como antes (sem selo de confirmação).
 */
(function (root) {
  "use strict";

  var WIKIDATA = "https://www.wikidata.org/w/api.php";
  var TVMAZE = "https://api.tvmaze.com";
  var TIMEOUT = 6000; /* ms por pedido */
  var TTL_CACHE = 12 * 60 * 60 * 1000;

  var memo = new Map();
  var estatisticas = { pedidos: 0, cache: 0, erros: 0 };

  /* ------------------------------------------------------------- utilidades */

  function normalizar(texto) {
    return texto
      ? String(texto)
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\bii\b/g, "2")
          .replace(/\biii\b/g, "3")
          .replace(/\biv\b/g, "4")
          .replace(/\bv\b/g, "5")
          .replace(/[^\p{L}\p{N}\s]/gu, " ")
          .replace(/\s+/g, " ")
          .trim()
      : "";
  }

  /** O primeiro ano que aparece num texto ("2024 film directed by X"). */
  function anoDe(texto) {
    var achado = String(texto || "").match(/\b(19\d\d|20\d\d)\b/);
    return achado ? achado[1] : "";
  }

  /** "tt0133093" → "tt0133093"; qualquer outra coisa → "". */
  function normalizarImdb(valor) {
    var limpo = String(valor || "").trim().toLowerCase();
    var achado = limpo.match(/tt\d{7,9}/);
    return achado ? achado[0] : "";
  }

  function comTimeout(promessa, ms) {
    return new Promise(function (resolve) {
      var resolvido = false;
      var timer = setTimeout(function () {
        if (!resolvido) {
          resolvido = true;
          resolve(null);
        }
      }, ms);
      promessa.then(
        function (valor) {
          if (resolvido) return;
          resolvido = true;
          clearTimeout(timer);
          resolve(valor);
        },
        function () {
          if (resolvido) return;
          resolvido = true;
          clearTimeout(timer);
          resolve(null);
        }
      );
    });
  }

  /** Um GET com cache e timeout. Nunca rebenta: devolve null. */
  function pedir(url) {
    var registo = memo.get(url);
    if (registo && Date.now() - registo.t < TTL_CACHE) {
      estatisticas.cache++;
      return Promise.resolve(registo.d);
    }
    estatisticas.pedidos++;
    return new Promise(function (resolve) {
      var ctrl = new root.AbortController();
      var timer = setTimeout(function () {
        try {
          ctrl.abort();
        } catch (e) {
          /* ignora */
        }
      }, TIMEOUT);
      root
        .fetch(url, { signal: ctrl.signal })
        .then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.json();
        })
        .then(function (dados) {
          memo.set(url, { t: Date.now(), d: dados });
          resolve(dados);
        })
        .catch(function () {
          estatisticas.erros++;
          resolve(null);
        })
        .then(function () {
          clearTimeout(timer);
        });
    });
  }

  /* -------------------------------------------------------------- Wikidata */

  function buscarWikidata(titulo, idioma) {
    if (!titulo) return Promise.resolve([]);
    var url =
      WIKIDATA +
      "?action=wbsearchentities&format=json&origin=*&limit=5&language=" +
      encodeURIComponent(idioma || "en") +
      "&search=" +
      encodeURIComponent(titulo);
    return pedir(url).then(function (dados) {
      return (dados && dados.search) || [];
    });
  }

  function claimsWikidata(qid) {
    var url =
      WIKIDATA + "?action=wbgetentities&format=json&origin=*&props=claims&ids=" + encodeURIComponent(qid);
    return pedir(url).then(function (dados) {
      var entidade = dados && dados.entities && dados.entities[qid];
      return (entidade && entidade.claims) || null;
    });
  }

  function valorDe(claims, propriedade) {
    var lista = claims && claims[propriedade];
    if (!lista || !lista.length) return "";
    for (var i = 0; i < lista.length; i++) {
      var valor = lista[i] && lista[i].mainsnak && lista[i].mainsnak.datavalue && lista[i].mainsnak.datavalue.value;
      if (valor !== undefined && valor !== null && valor !== "") return valor;
    }
    return "";
  }

  function imdbDe(claims) {
    var valor = String(valorDe(claims, "P345") || "");
    return /^tt\d{7,9}$/.test(valor) ? valor : "";
  }

  /** ID do TMDB: P4947 (filme) ou P4983 (série). */
  function tmdbDe(claims) {
    var filme = valorDe(claims, "P4947");
    if (filme) return { kind: "movie", id: String(filme) };
    var serie = valorDe(claims, "P4983");
    if (serie) return { kind: "tv", id: String(serie) };
    return null;
  }

  /**
   * Escolhe a entidade que mais se parece com o título pedido.
   * Pontua: o rótulo (ou um alias) é igual ao título → +100; o ano bate
   * certo → +60; o ano está perto → +20.
   */
  function melhorEntidade(lista, titulo, ano) {
    var alvo = normalizar(titulo);
    var melhor = null;
    lista.forEach(function (item) {
      var nomes = [item.label].concat(item.aliases || []).map(normalizar);
      var pontosTitulo = 0;
      var anoItem = anoDe(item.description || "");
      nomes.forEach(function (nome) {
        if (!nome || !alvo) return;
        if (nome === alvo) pontosTitulo = Math.max(pontosTitulo, 100);
        else if (nome.includes(alvo) || alvo.includes(nome)) pontosTitulo = Math.max(pontosTitulo, 70);
        else if (nome.split(" ").some((p) => p.length > 3 && alvo.includes(p))) pontosTitulo = Math.max(pontosTitulo, 40);
      });
      /* O ano só pesa se o título já bateu — senão seria confirmar o ano
         de uma obra que não é a procurada. */
      var pontos = pontosTitulo;
      if (ano && anoItem && pontosTitulo >= 40) {
        if (ano === anoItem) pontos += 60;
        else if (Math.abs(Number(ano) - Number(anoItem)) <= 2) pontos += 20;
        else pontos -= 40;
      }
      if (!melhor || pontos > melhor.pontos) {
        melhor = {
          item: item,
          pontos: pontos,
          pontosTitulo: pontosTitulo,
          ano: anoItem,
          qid: item.id,
          titulo: item.label,
        };
      }
    });
    return melhor;
  }

  /* ---------------------------------------------------------------- TVmaze */

  function confirmarTvmaze(imdbId) {
    if (!imdbId) return Promise.resolve(null);
    return pedir(TVMAZE + "/lookup/shows?imdb=" + encodeURIComponent(imdbId)).then(function (dados) {
      if (!dados || !dados.name) return null;
      return {
        fonte: "tvmaze",
        id: dados.id,
        titulo: dados.name,
        ano: String(dados.premiered || "").slice(0, 4),
        nota: dados.rating && Number(dados.rating.average) ? Number(dados.rating.average) : undefined,
        imdbId: (dados.externals && dados.externals.imdb) || imdbId,
      };
    });
  }

  /* --------------------------------------------------------------- público */

  /**
   * Confirma o título que a IA propose numa fonte externa.
   *
   *   • Série com ID do IMDb  → TVmaze (nota, data, nome oficial)
   *   • Tudo o resto          → Wikidata (rótulo/alias + ano)
   *
   * Devolve { fonte, ano, titulo, ... }. O `ano` é o que a fonte externa
   * conhece: quem chama compara-o com o ano do candidato — é a pista que
   * permite descartar a versão errada de um remake.
   */
  function confirmar(ia) {
    ia = ia || {};
    var imdbId = normalizarImdb(ia.imdb_id || ia.imdbId);
    var tituloOriginal = String(ia.titulo_original || "").trim();
    var tituloPt = String(ia.titulo || "").trim();
    var titulo = tituloOriginal || tituloPt;
    var ehSerie = ia.tipo === "tv";

    if (ehSerie && imdbId) {
      return confirmarTvmaze(imdbId).then(function (tv) {
        if (!tv) return null;
        return {
          fonte: "tvmaze",
          ano: tv.ano,
          titulo: tv.titulo,
          nota: tv.nota,
          imdbId: tv.imdbId,
          detalhe: "confirmado na TVmaze" + (tv.nota ? " (nota " + tv.nota + ")" : ""),
        };
      });
    }

    if (!titulo) return Promise.resolve(null);
    return buscarWikidata(titulo, tituloOriginal ? "en" : "pt").then(function (lista) {
      if (!lista.length) return null;
      var anoIA = Number(String(ia.ano || "").slice(0, 4)) || 0;
      var melhor = melhorEntidade(lista, titulo, anoIA);
      if (!melhor || melhor.pontos < 40) return null;
      return {
        fonte: "wikidata",
        ano: melhor.ano,
        titulo: melhor.titulo,
        qid: melhor.qid,
        /* Só uma correspondência forte de título (rótulo ou alias) permite
           recusar um candidato — uma coincidência de uma palavra não. */
        forte: melhor.pontosTitulo >= 70,
        detalhe: "confirmado no Wikidata" + (melhor.qid ? " (" + melhor.qid + ")" : ""),
      };
    });
  }

  /**
   * O identificador exacto da obra a partir do Q-id do Wikidata:
   * P345 (IMDb) e P4947/P4983 (ID do TMDB). É o atalho para a obra certa.
   */
  function identificadores(qid) {
    if (!qid) return Promise.resolve(null);
    return claimsWikidata(qid).then(function (claims) {
      if (!claims) return null;
      var imdb = imdbDe(claims);
      var tmdb = tmdbDe(claims);
      if (!imdb && !tmdb) return null;
      return { imdbId: imdb, tmdb: tmdb };
    });
  }

  /**
   * Ponte para o TMDB: quando a pesquisa por título falha, o Wikidata sabe
   * qual é o identificador exacto da obra (IMDb ou o próprio ID do TMDB).
   * É o caminho que encontra filmes que o índice de pesquisa do TMDB não devolve.
   */
  function ponte(ia) {
    ia = ia || {};
    var titulos = [ia.titulo_original, ia.titulo].filter(function (t) {
      return t && String(t).trim();
    });
    if (!titulos.length) return Promise.resolve(null);
    var ano = Number(String(ia.ano || "").slice(0, 4)) || 0;

    return Promise.all(
      titulos.map(function (titulo) {
        return buscarWikidata(titulo, "en").then(function (lista) {
          if (!lista.length) return null;
          var melhor = melhorEntidade(lista, titulo, ano);
          return melhor && melhor.pontosTitulo >= 70 ? melhor : null;
        });
      })
    ).then(function (melhores) {
      var melhor = melhores.filter(Boolean)[0];
      if (!melhor) return null;
      return claimsWikidata(melhor.qid).then(function (claims) {
        if (!claims) return null;
        var imdb = imdbDe(claims);
        var tmdb = tmdbDe(claims);
        if (!imdb && !tmdb) return null;
        return { qid: melhor.qid, titulo: melhor.titulo, ano: melhor.ano, imdbId: imdb, tmdb: tmdb };
      });
    });
  }

  var CineConfirmacao = {
    versao: "1.0.0",
    confirmar: confirmar,
    ponte: ponte,
    identificadores: identificadores,
    estatisticas: function () {
      return { pedidos: estatisticas.pedidos, cache: estatisticas.cache, erros: estatisticas.erros };
    },
    limparCache: function () {
      memo.clear();
    },
    /* internas, para os testes */
    _internas: {
      normalizar: normalizar,
      anoDe: anoDe,
      normalizarImdb: normalizarImdb,
      melhorEntidade: melhorEntidade,
      imdbDe: imdbDe,
      tmdbDe: tmdbDe,
    },
  };

  if (root) root.CineConfirmacao = CineConfirmacao;
  if (typeof module !== "undefined" && module.exports) module.exports = CineConfirmacao;
})(typeof globalThis !== "undefined" ? globalThis : this);
