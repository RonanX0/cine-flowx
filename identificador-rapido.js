/* Identificador rápido de filmes e séries — CineClip
 * ============================================================================
 * Este ficheiro é a versão legível (fora do bundle) da resolução de títulos no
 * TMDB. O bundle antigo fazia ~30 pedidos ao TMDB por identificação:
 *
 *   • 5 títulos × 2 variantes × 3 tipos de pedido (filme pt-BR, série pt-BR,
 *     filme en-US) = até 30 pedidos, todos em paralelo e sem cache;
 *   • mais 3 buscas de ator + 3 listas de créditos;
 *   • mais 1-2 pedidos para os detalhes (com repetição da sinopse em en-US).
 *
 * Em mobile isso dá filas de espera,_blocks de 429 e a sensação de "não
 * funciona". Aqui a resolução é feita em DEGRAUS: só se paga o degrau
 * seguinte quando o anterior não deu uma resposta confiante.
 *
 *   Degrau 0 — IMDb ID (1 pedido)     → resposta exacta, sem ambiguidade
 *   Degrau 1 — título principal (2)   → filme + série em paralelo
 *   Degrau 2 — variantes do título (4) → sem "(2014)", sem subtítulo, título PT
 *   Degrau 3 — outros títulos (6) + atores (4)
 *   Detalhes (1)                      → sinopse, póster, IMDb ID
 *
 * Caso comum (a IA acerta o título): 2 pedidos + 1 de detalhes = 3.
 * Caso difícil (remake, título em PT, atorneeded): até 15.
 *
 * Tudo o que é pedido fica memorizado em memória e em sessionStorage: no
 * "upload em massa" o mesmo filme aparece dezenas de vezes e só o primeiro
 * pedido sai para a rede.
 *
 * A pontuação é a mesma do bundle (para não perder precisão), com o
 * resultado guardado já normalizado e com os IDs canónicos:
 *
 *   tmdbId  "movie:550"      ID do TMDB com o tipo
 *   imdbId  "tt0133093"      ID do IMDb (vem em external_ids)
 *   chave   "movie-550"      chave estável para deduplicar
 */
(function (root) {
  "use strict";

  var API = "https://api.themoviedb.org/3";
  var TTL_CACHE = 12 * 60 * 60 * 1000; /* 12 horas */
  var TIMEOUT = 12000; /* ms por pedido */
  var LIMIAR = 40; /* pontuação mínima para devolver um título */
  var MAX_CANDIDATOS = 15; /* candidatos por pesquisa */
  var CHAVE_DISCO = "cineclip:tmdb-cache:v1";
  var MAX_DISCO = 250; /* entradas guardadas em sessionStorage */

  var memo = new Map(); /* url -> { t, d } */
  var aVoar = new Map(); /* url -> Promise (pedidos em curso) */
  var disco = null; /* { url: { t, d } } */
  var discoSujo = false;
  var relogio = null;

  var estatisticas = { pedidos: 0, rede: 0, cache: 0, erros: 0, ultimoMs: 0 };

  /* ------------------------------------------------------------- utilidades */

  function agora() {
    return Date.now();
  }

  /** Espera no máximo `ms` por uma promessa; expirado, devolve null. */
  function comTimeout(promessa, ms) {
    return new Promise(function (resolve) {
      var pronto = false;
      var timer = setTimeout(function () {
        if (pronto) return;
        pronto = true;
        resolve(null);
      }, ms);
      promessa.then(
        function (valor) {
          if (pronto) return;
          pronto = true;
          clearTimeout(timer);
          resolve(valor);
        },
        function () {
          if (pronto) return;
          pronto = true;
          clearTimeout(timer);
          resolve(null);
        }
      );
    });
  }

  function sessao() {
    try {
      return root.sessionStorage || null;
    } catch (e) {
      return null;
    }
  }

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

  /** Versões que vale a pena pesquisar: como está, sem o ano, sem subtítulo. */
  function variantes(titulo) {
    var bruto = String(titulo || "").trim();
    if (!bruto) return [];
    var limpo = bruto
      .replace(/\s*[(\[]?\b(19\d\d|20\d\d)\b[)\]]?.*$/, "")
      .replace(/[–—:.,\-]+$/, "")
      .trim();
    var base = limpo.split(/[:–—\-]/)[0].trim();
    var lista = [bruto, limpo, base];
    var vistos = [];
    for (var i = 0; i < lista.length; i++) {
      var q = String(lista[i] || "").trim();
      if (q && q.length >= 2 && vistos.indexOf(q) < 0) vistos.push(q);
    }
    return vistos;
  }

  function limparAtor(nome) {
    return String(nome || "")
      .replace(/\s+(as|como|interpretando|papel\s+de)\s+.*/i, "")
      .replace(/\([^)]*\)/g, "")
      .replace(/[-–—:].*/, "")
      .trim();
  }

  function normalizarImdb(valor) {
    var achado = String(valor || "").toLowerCase().match(/tt\d{7,9}/);
    return achado ? achado[0] : "";
  }

  function ehToken(chave) {
    /* A chave do TMDB v3 é curta; um token de leitura (v4) é muito mais longo. */
    return String(chave || "").trim().length > 60;
  }

  function chaveDe(media) {
    return media.kind + "-" + media.id;
  }

  /* ------------------------------------------------------------------ cache */

  function carregarDisco() {
    if (disco) return disco;
    disco = {};
    try {
      var s = sessao();
      if (!s) return disco;
      var bruto = s.getItem(CHAVE_DISCO);
      if (bruto) {
        var obj = JSON.parse(bruto);
        if (obj && typeof obj === "object") disco = obj;
      }
    } catch (e) {
      disco = {};
    }
    return disco;
  }

  function gravarDisco() {
    if (discoSujo) return;
    discoSujo = true;
    if (relogio) clearTimeout(relogio);
    relogio = setTimeout(function () {
      relogio = null;
      discoSujo = false;
      try {
        var s = sessao();
        if (!s) return;
        var d = carregarDisco();
        var chaves = Object.keys(d);
        if (chaves.length > MAX_DISCO) {
          chaves.sort(function (a, b) {
            return (d[b].t || 0) - (d[a].t || 0);
          });
          for (var i = MAX_DISCO; i < chaves.length; i++) delete d[chaves[i]];
        }
        s.setItem(CHAVE_DISCO, JSON.stringify(d));
      } catch (e) {
        /* sem espaço ou sem permissão: o cache em memória continua a servir */
      }
    }, 800);
  }

  function doDisco(url) {
    var d = carregarDisco();
    var registo = d[url];
    if (!registo) return null;
    if (agora() - (registo.t || 0) > TTL_CACHE) {
      delete d[url];
      return null;
    }
    return registo;
  }

  function limparCache() {
    memo.clear();
    aVoar.clear();
    disco = {};
    try {
      var s = sessao();
      if (s) s.removeItem(CHAVE_DISCO);
    } catch (e) {
      /* ignora */
    }
  }

  /* ---------------------------------------------------------------- pedidos */

  function montarUrl(chave, caminho, params) {
    var url = new root.URL(API + caminho);
    var token = String(chave || "").trim();
    if (!ehToken(token)) url.searchParams.set("api_key", token);
    url.searchParams.set("language", "pt-BR");
    var extras = params || {};
    for (var chaveParam in extras) {
      if (!Object.prototype.hasOwnProperty.call(extras, chaveParam)) continue;
      var valor = extras[chaveParam];
      if (valor === undefined || valor === null || valor === "") continue;
      url.searchParams.set(chaveParam, String(valor));
    }
    return url.toString();
  }

  /**
   * Um pedido ao TMDB com cache, deduplicação de pedidos em curso e timeout.
   * Nunca rebenta: devolve null quando o TMDB falha, para que a identificação
   * continue por outros caminhos em vez de mostrar um erro ao utilizador.
   */
  function pedir(chave, caminho, params) {
    var url = montarUrl(chave, caminho, params);
    var registo = memo.get(url);
    if (!registo) registo = doDisco(url);
    if (registo) {
      estatisticas.cache++;
      memo.set(url, registo);
      return Promise.resolve(registo.d);
    }
    if (aVoar.has(url)) {
      estatisticas.cache++;
      return aVoar.get(url);
    }

    var promessa = new Promise(function (resolve) {
      var ctrl = new root.AbortController();
      var timer = setTimeout(function () {
        try {
          ctrl.abort();
        } catch (e) {
          /* ignora */
        }
      }, TIMEOUT);
      var init = { signal: ctrl.signal };
      if (ehToken(chave)) init.headers = { Authorization: "Bearer " + String(chave).trim() };
      estatisticas.pedidos++;
      estatisticas.rede++;
      root
        .fetch(url, init)
        .then(function (res) {
          if (!res.ok) throw new Error("TMDB " + res.status);
          return res.json();
        })
        .then(function (dados) {
          var agora_ = { t: agora(), d: dados };
          memo.set(url, agora_);
          var d = carregarDisco();
          d[url] = agora_;
          gravarDisco();
          resolve(dados);
        })
        .catch(function (erro) {
          estatisticas.erros++;
          resolve(null);
        })
        .then(function () {
          clearTimeout(timer);
        });
    });

    aVoar.set(url, promessa);
    return promessa.then(function (dados) {
      aVoar.delete(url);
      return dados;
    });
  }

  /* ------------------------------------------------------------- normalizar */

  function normalizarTMDB(bruto, tipo) {
    var r = bruto || {};
    return {
      id: r.id,
      kind: tipo,
      title: r.title !== undefined && r.title !== null ? r.title : r.name || "",
      original:
        r.original_title !== undefined && r.original_title !== null
          ? r.original_title
          : r.original_name || r.title || r.name || "",
      year: String(r.release_date || r.first_air_date || "").slice(0, 4),
      overview: r.overview || "",
      poster: r.poster_path ? "https://image.tmdb.org/t/p/w342" + r.poster_path : undefined,
      genres: [],
      popularity: Number(r.popularity) || 0,
    };
  }

  /* ------------------------------------------------------------- pesquisa */

  function pesquisaGenero(chave, consulta, tipo) {
    return pedir(chave, "/search/" + tipo, { query: consulta, include_adult: "false" }).then(function (dados) {
      var lista = (dados && dados.results) || [];
      return lista.map(function (r) {
        return normalizarTMDB(r, tipo);
      });
    });
  }

  /** Pesquisa várias consultas em paralelo (filme + série) e funde resultados. */
  function pesquisarConsultas(chave, consultas) {
    var pedidos = [];
    consultas.forEach(function (q) {
      pedidos.push(pesquisaGenero(chave, q, "movie"));
      pedidos.push(pesquisaGenero(chave, q, "tv"));
    });
    if (!pedidos.length) return Promise.resolve([]);
    return Promise.all(pedidos).then(function (respostas) {
      var mapa = new Map();
      respostas.forEach(function (lista) {
        (lista || []).forEach(function (m) {
          var k = chaveDe(m);
          if (!mapa.has(k)) mapa.set(k, m);
        });
      });
      return Array.from(mapa.values())
        .sort(function (a, b) {
          return (b.popularity || 0) - (a.popularity || 0);
        })
        .slice(0, MAX_CANDIDATOS);
    });
  }

  /** Pesquisa simples (caixa de pesquisa manual do estúdio). */
  function buscar(chave, texto, opcoes) {
    var config = opcoes || {};
    var consultas = variantes(texto).slice(0, config.variantes || 1);
    if (!consultas.length) return Promise.resolve([]);
    return pesquisarConsultas(chave, consultas);
  }

  /* -------------------------------------------------------------- detalhes */

  /** Detalhes + IMDb ID + chave canónica. Uma só ida ao TMDB. */
  function detalhes(chave, media) {
    if (!media || media.id === undefined || media.id === null) return Promise.resolve(null);
    return pedir(chave, "/" + media.kind + "/" + media.id, {
      language: "pt-BR",
      append_to_response: "external_ids",
    }).then(function (dados) {
      if (!dados) return null;
      var sinopse = dados.overview || "";
      if (!sinopse) {
        return pedir(chave, "/" + media.kind + "/" + media.id, { language: "en-US" }).then(function (en) {
          return montarDetalhes(dados, media, (en && en.overview) || sinopse);
        });
      }
      return montarDetalhes(dados, media, sinopse);
    });
  }

  function montarDetalhes(dados, media, sinopse) {
    var out = normalizarTMDB(dados, media.kind);
    out.id = media.id;
    out.kind = media.kind;
    out.overview = sinopse || out.overview || "";
    out.genres = (dados.genres || []).map(function (g) {
      return g.name;
    });
    var externos = dados.external_ids || {};
    out.imdbId = externos.imdb_id || undefined;
    out.tmdbId = media.kind + ":" + media.id;
    out.chave = chaveDe(media);
    return out;
  }

  /** IMDb ID → título exacto (1 pedido). */
  function procurarPorImdb(chave, imdbId) {
    return pedir(chave, "/find/" + encodeURIComponent(imdbId), { external_source: "imdb_id" }).then(function (dados) {
      if (!dados) return null;
      var lista = [];
      (dados.movie_results || []).forEach(function (r) {
        lista.push(normalizarTMDB(r, "movie"));
      });
      (dados.tv_results || []).forEach(function (r) {
        lista.push(normalizarTMDB(r, "tv"));
      });
      return lista[0] || null;
    });
  }

  /* --------------------------------------------------------------- atores */

  function creditosDeAtores(chave, atores) {
    return Promise.all(
      atores.map(function (nome) {
        return pedir(chave, "/search/person", { query: nome, include_adult: "false" }).then(function (pessoas) {
          var pessoa = pessoas && pessoas.results && pessoas.results[0];
          if (!pessoa) return [];
          return pedir(chave, "/person/" + pessoa.id + "/combined_credits", { language: "pt-BR" }).then(
            function (creditos) {
              var lista = ((creditos && creditos.cast) || []).slice();
              lista.sort(function (a, b) {
                return (b.vote_count || 0) - (a.vote_count || 0);
              });
              return lista.slice(0, 25).map(function (c) {
                return normalizarTMDB(c, c.media_type);
              });
            },
            function () {
              return (pessoa.known_for || []).map(function (c) {
                return normalizarTMDB(c, c.media_type);
              });
            }
          );
        });
      })
    ).then(function (grupos) {
      var todos = [];
      grupos.forEach(function (g) {
        todos = todos.concat(g || []);
      });
      return todos;
    });
  }

  function contarAtores(lista) {
    var contagem = new Map();
    (lista || []).forEach(function (item) {
      var k = chaveDe(item);
      contagem.set(k, (contagem.get(k) || 0) + 1);
    });
    return contagem;
  }

  /* ------------------------------------------------------------- pontuação */

  /**
   * O título do candidato casa com o título que a IA deu?
   * (título original ou título em português, normalizados)
   */
  function casouTitulo(candidato, ia) {
    var x = normalizar(ia.titulo_original || "");
    var h = normalizar(ia.titulo || "");
    var D = normalizar(candidato.original);
    var O = normalizar(candidato.title);
    return !!((x && (D === x || O === x)) || (h && (O === h || D === h)));
  }

  /**
   * Mesma pontuação do bundle (o que já estava testado) — o que muda é que
   * agora é aplicada a um conjunto de candidatos muito mais pequeno.
   *
   * `pesoAtores` serve para o último degrau: quando NENHUM candidato tem o
   * título que a IA deu, os atores passam a ser a prova principal (é o único
   * sinal que resta) em vez de um bónus de 10 pontos.
   */
  function pontuar(candidato, ia, contagemAtores, pesoAtores) {
    var ano = ia.ano ? Number(String(ia.ano).slice(0, 4)) : 0;
    var x = normalizar(ia.titulo_original || "");
    var h = normalizar(ia.titulo || "");
    var alternativas = (ia.alternativas || []).map(function (a) {
      return { orig: normalizar(a.titulo_original || ""), pt: normalizar(a.titulo || "") };
    });

    var pontos = 0;
    var D = normalizar(candidato.original);
    var O = normalizar(candidato.title);
    var casou = false;

    if (x && (D === x || O === x)) {
      pontos += 85;
      casou = true;
    } else if (h && (O === h || D === h)) {
      pontos += 80;
      casou = true;
    }
    if (x && h && D === x && O === h) pontos += 30;

    if (!casou) {
      var palavrasCand = new Set((D + " " + O).split(" ").filter(Boolean));
      var palavrasIA = new Set((x + " " + h).split(" ").filter(Boolean));
      if (palavrasCand.size && palavrasIA.size) {
        var comuns = 0;
        palavrasIA.forEach(function (palavra) {
          if (palavrasCand.has(palavra)) comuns++;
        });
        if (comuns >= Math.min(palavrasIA.size, palavrasCand.size) && comuns >= 1) {
          pontos += 65;
          casou = true;
        } else if (comuns >= 2) {
          pontos += 45;
          casou = true;
        } else if (
          comuns === 1 &&
          ((x && (D.includes(x) || x.includes(D))) || (h && (O.includes(h) || h.includes(O))))
        ) {
          pontos += 35;
          casou = true;
        }
      }
    }

    if (!casou) {
      for (var i = 0; i < alternativas.length; i++) {
        var alt = alternativas[i];
        if ((alt.orig && (D === alt.orig || O === alt.orig)) || (alt.pt && (O === alt.pt || D === alt.pt))) {
          pontos += 55;
          casou = true;
          break;
        }
      }
    }

    var nAtores = (contagemAtores && contagemAtores.get(chaveDe(candidato))) || 0;
    if (casou) {
      if (nAtores >= 2) pontos += 55;
      else if (nAtores === 1) pontos += 35;
    } else if (pesoAtores) {
      pontos += nAtores >= 2 ? 55 : nAtores >= 1 ? 35 : 0;
    } else {
      if (!x && !h) pontos += nAtores >= 2 ? 55 : 35;
      else pontos += nAtores >= 1 ? 10 : 0;
    }

    if (ia.tipo && candidato.kind) {
      if (candidato.kind === ia.tipo) pontos += 15;
      else pontos -= 15;
    }

    var j = Number(candidato.year) || 0;
    if (ano && j) {
      var dif = Math.abs(ano - j);
      if (dif === 0) pontos += 25;
      else if (dif <= 1) pontos += 18;
      else if (dif <= 2) pontos += 12;
      else if (dif > 7 && candidato.kind === "movie") pontos -= 25;
    }

    pontos += Math.min(8, Math.log10((candidato.popularity || 1) + 1) * 3);
    return pontos;
  }

  /**
   * Uma resposta é "confiante" quando o título bate certo, o tipo bate certo e
   * o ano está a menos de 3 anos. Só nesse caso se pára a pesquisa.
   */
  function confiante(candidato, ia) {
    if (!candidato) return false;
    if (!casouTitulo(candidato, ia)) return false;
    if (ia.tipo && candidato.kind && candidato.kind !== ia.tipo) return false;
    var ano = Number(String(ia.ano || "").slice(0, 4)) || 0;
    var anoCandidato = Number(candidato.year) || 0;
    if (ano && anoCandidato && Math.abs(ano - anoCandidato) > 2) return false;
    return true;
  }

  /**
   * O ID do IMDb que a IA escreveu de cabeça pode estar errado (é um dos
   * campos que os modelos mais inventam). Só se confia nele quando o filme
   * que o TMDB devolve não contradiz o resto do que a IA disse:
   *   • sem título nem ano da IA → não há com que comparar, aceita;
   *   • com título → tem de casar (exacto, por palavras ou numa alternativa);
   *   • com ano → a diferença tem de ser de 2 anos ou menos.
   */
  function imdbConsistente(candidato, ia) {
    if (!candidato) return false;
    var tituloIA = normalizar((ia.titulo_original || "") + " " + (ia.titulo || "")).trim();
    if (tituloIA) {
      var D = normalizar(candidato.original);
      var O = normalizar(candidato.title);
      var palavrasCand = new Set((D + " " + O).split(" ").filter(Boolean));
      var palavrasIA = tituloIA.split(" ").filter(Boolean);
      var comuns = 0;
      palavrasIA.forEach(function (p) {
        if (palavrasCand.has(p)) comuns++;
      });
      var casa = casouTitulo(candidato, ia) || (comuns > 0 && comuns >= Math.min(palavrasIA.length, palavrasCand.size));
      if (!casa) {
        casa = (ia.alternativas || []).some(function (a) {
          var orig = normalizar(a.titulo_original || "");
          var pt = normalizar(a.titulo || "");
          return (orig && (D === orig || O === orig)) || (pt && (O === pt || D === pt));
        });
      }
      if (!casa) return false;
    }
    var ano = Number(String(ia.ano || "").slice(0, 4)) || 0;
    var anoCand = Number(candidato.year) || 0;
    if (ano && anoCand && Math.abs(ano - anoCand) > 2) return false;
    return true;
  }

  function escolher(candidatos, ia, contagemAtores, pesoAtores) {
    var melhor = null;
    candidatos.forEach(function (c) {
      var pontos = pontuar(c, ia, contagemAtores, pesoAtores);
      if (!melhor || pontos > melhor.pontos) melhor = { candidato: c, pontos: pontos };
    });
    return melhor;
  }

  /* ------------------------------------------------------------- resolver */

  /**
   * Resolve o título que a IA identificou. Devolve o mesmo formato de media
   * que o bundle usava, mais tmdbId / imdbId / chave.
   */
  function procurar(chave, ia) {
    ia = ia || {};
    var inicio = agora();

    /* ---------------------------------------------------------- fontes externas
     * A confirmação independente (Wikidata / TVmaze) arranca já, em paralelo
     * com a pesquisa no TMDB: não custa tempo — quando a resposta chega, o
     * candidato já está escolhido — e dá-nos três coisas:
     *   • um selo de certeza ("é mesmo esta obra");
     *   • a recusa da versão errada quando o nome é partilhado (remakes);
     *   • a ponte para o TMDB quando a pesquisa por título não acha nada. */
    var confirmador = root && root.CineConfirmacao ? root.CineConfirmacao : null;
    var confirmacaoBruta =
      confirmador && typeof confirmador.confirmar === "function"
        ? Promise.resolve()
            .then(function () {
              return confirmador.confirmar(ia);
            })
            .catch(function () {
              return null;
            })
        : Promise.resolve(null);
    /* Só se espera pela confirmação enquanto ela é barata (1,2 s): se a fonte
       externa estiver lenta, o resultado sai na mesma hora e a confirmação
       chega depois, ya em forma de selo. */
    var confirmacao = comTimeout(confirmacaoBruta, 1200);

    /**
     * Pega no melhor candidato e pede os detalhes. Se a fonte externa
     * desmentir o ano do candidato (e concordar com o ano que a IA deu),
     * passa-se ao candidato seguinte — é assim que se evita o remake errado.
     */
    var finalizar = function (lista, indice) {
      var escolhido = lista[indice];
      if (!escolhido) return Promise.resolve(null);
      return Promise.all([detalhes(chave, escolhido.candidato), confirmacao]).then(function (r) {
        var info = r[0] || escolhido.candidato;
        var conf = r[1];
        if (conf) info.confirmacao = conf;
        /* A fonte externa conhece a obra com OUTRO ano e esse ano é o mesmo
           que a IA deu: o candidato é a versão errada (remake). Antes de
           passar ao candidato seguinte, tenta-se a obra exacta que a fonte
           externa conhece — é o identificador canónico da obra. */
        var anoCandidato = String((escolhido.candidato && escolhido.candidato.year) || "").slice(0, 4);
        var anoIA = String(ia.ano || "").slice(0, 4);
        if (
          conf &&
          conf.forte &&
          conf.ano &&
          anoCandidato &&
          anoIA &&
          anoIA === conf.ano &&
          anoCandidato !== conf.ano
        ) {
          return exacto(conf).then(function (certo) {
            if (certo) return certo;
            if (indice + 1 < lista.length) return finalizar(lista, indice + 1);
            estatisticas.ultimoMs = agora() - inicio;
            return info;
          });
        }
        estatisticas.ultimoMs = agora() - inicio;
        /* Se a confirmação só chegou tarde, fica na mesma ficha. */
        confirmacaoBruta.then(function (tarde) {
          if (tarde && !info.confirmacao) info.confirmacao = tarde;
        });
        return info;
      });
    };

    /**
     * Traz a obra exacta que a fonte externa conhece (o ID do IMDb ou o
     * próprio ID do TMDB) — sem adivinhar, sem procurar às cegas.
     */
    function exactoComIds(ids, conf) {
      if (!ids) return Promise.resolve(null);
      if (ids.tmdb) {
        return detalhes(chave, { kind: ids.tmdb.kind, id: ids.tmdb.id }).then(function (info) {
          if (!info) return null;
          if (ids.imdbId) info.imdbId = ids.imdbId;
          info.confirmacao = conf;
          estatisticas.ultimoMs = agora() - inicio;
          return info;
        });
      }
      if (ids.imdbId) {
        return procurarPorImdb(chave, ids.imdbId).then(function (achado) {
          if (!achado) return null;
          return detalhes(chave, achado);
        }).then(function (info) {
          if (!info) return null;
          info.confirmacao = conf;
          estatisticas.ultimoMs = agora() - inicio;
          return info;
        });
      }
      return Promise.resolve(null);
    }

    function exacto(conf) {
      if (!confirmador) return Promise.resolve(null);
      if (conf.tmdb || conf.imdbId) return exactoComIds(conf, conf);
      if (!conf.qid || typeof confirmador.identificadores !== "function") return Promise.resolve(null);
      return comTimeout(
        Promise.resolve()
          .then(function () {
            return confirmador.identificadores(conf.qid);
          })
          .catch(function () {
            return null;
          }),
        3000
      ).then(function (ids) {
        if (!ids) return null;
        return exactoComIds(ids, conf);
      });
    }

    /* Degrau 0 — a IA deu o ID do IMDb: resposta exacta, 1 pedido. */
    var imdbId = normalizarImdb(ia.imdb_id || ia.imdbId);
    if (imdbId) {
      return procurarPorImdb(chave, imdbId).then(function (achado) {
        if (achado && imdbConsistente(achado, ia)) {
          achado.imdbId = imdbId;
          return finalizar([{ candidato: achado, pontos: 999 }], 0);
        }
        /* O ID não existe no TMDB ou aponta para outra obra (ID inventado):
           ignora-o e resolve pelo título, como se a IA não o tivesse dado. */
        return procurar(chave, Object.assign({}, ia, { imdb_id: "", imdbId: "" }));
      });
    }

    /* Títulos por ordem de confiança. */
    var titulos = [];
    function junta(titulo) {
      var v = String(titulo || "").trim();
      if (v && titulos.indexOf(v) < 0) titulos.push(v);
    }
    junta(ia.titulo_original);
    junta(ia.titulo);
    (ia.alternativas || []).slice(0, 3).forEach(function (alt) {
      junta(alt.titulo_original || alt.titulo);
    });
    var candidatos = new Map();
    function absorve(lista) {
      (lista || []).forEach(function (m) {
        var k = chaveDe(m);
        if (!candidatos.has(k)) candidatos.set(k, m);
      });
    }
    /* Candidatos por ordem de pontuação (o primeiro é o melhor). */
    function ordenados(contagem, pesoAtores) {
      var lista = [];
      candidatos.forEach(function (c) {
        lista.push({ candidato: c, pontos: pontuar(c, ia, contagem, pesoAtores) });
      });
      lista.sort(function (a, b) {
        return b.pontos - a.pontos;
      });
      return lista;
    }

    /* Resgate — o TMDB não achou (ou achou sem certeza): o Wikidata sabe o
       identificador exacto da obra (o ID do IMDb ou o próprio ID do TMDB).
       É o caminho que encontra o que a pesquisa por título não devolveu. */
    function resgatar() {
      if (!confirmador || typeof confirmador.ponte !== "function") return Promise.resolve(null);
      return comTimeout(
        Promise.resolve()
          .then(function () {
            return confirmador.ponte(ia);
          })
          .catch(function () {
            return null;
          }),
        4000
      ).then(function (ponte) {
        if (!ponte) return null;
        return exacto({
          fonte: "wikidata",
          ano: ponte.ano,
          titulo: ponte.titulo,
          qid: ponte.qid,
          tmdb: ponte.tmdb,
          imdbId: ponte.imdbId,
          detalhe: "encontrado no Wikidata",
        });
      });
    }

    /* Degrau 3 — outros títulos + atores (o degrau caro, o último recurso). */
    function degrau3(creditosAdiantados) {
      var outros = titulos
        .slice(2, 4)
        .map(function (t) {
          return variantes(t)[0];
        })
        .filter(Boolean);
      var atores = (ia.atores || [])
        .map(limparAtor)
        .filter(function (a) {
          return a.length >= 3;
        })
        .slice(0, 2);

      var promessaAtores = creditosAdiantados
        ? creditosAdiantados
        : atores.length
        ? creditosDeAtores(chave, atores)
        : Promise.resolve([]);

      return Promise.all([
        promessaAtores,
        outros.length ? pesquisarConsultas(chave, outros) : Promise.resolve([]),
      ]).then(function (resultados) {
        var porAtor = resultados[0] || [];
        absorve(resultados[1]);
        var contagem = contarAtores(porAtor);
        absorve(porAtor);
        var algumCasou = false;
        candidatos.forEach(function (c) {
          if (casouTitulo(c, ia)) algumCasou = true;
        });
        /* Se nenhum candidato tem o título da IA, os atores são a única
           prova que temos — e passam a valer como prova principal. */
        var lista = ordenados(contagem, !algumCasou);
        if (!lista.length || lista[0].pontos < LIMIAR) return resgatar();
        return finalizar(lista, 0);
      });
    }

    /* A IA pode não saber o título (só os atores) — nesse caso os atores
       são o único caminho e vamos directamente ao degrau 3. */
    if (!titulos.length) return degrau3();

    /* Quando a própria IA diz que tem pouca certeza do título, o título
       sozinho não chega: os atores têm de entrar. Em vez de os procurar
       só no degrau 3 (mais uma ida à rede), a busca começa já aqui, em
       paralelo com a pesquisa do título — assim o caso difícil não fica
       mais lento que a versão antiga, que fazia tudo ao mesmo tempo. */
    var confianca = Number(ia.confianca) || 0;
    var atores = (ia.atores || [])
      .map(limparAtor)
      .filter(function (a) {
        return a.length >= 3;
      })
      .slice(0, 2);
    var creditosAdiantados =
      confianca > 0 && confianca < 70 && atores.length
        ? creditosDeAtores(chave, atores).catch(function () {
            return [];
          })
        : null;

    /* Degrau 1 — o título principal tal como a IA o escreveu (2 pedidos). */
    var variantesPrincipal = variantes(titulos[0]);
    return pesquisarConsultas(chave, variantesPrincipal.slice(0, 1)).then(function (lista) {
      absorve(lista);
      var orden = ordenados(null);
      if (orden.length && confiante(orden[0].candidato, ia)) return finalizar(orden, 0);

      /* Degrau 2 — variantes do título e o título em português (até 4 pedidos). */
      var consultas = variantesPrincipal.slice(1, 3);
      if (titulos[1]) consultas = consultas.concat(variantes(titulos[1]).slice(0, 1));
      if (consultas.length) {
        return pesquisarConsultas(chave, consultas).then(function (extra) {
          absorve(extra);
          var orden2 = ordenados(null);
          if (orden2.length && confiante(orden2[0].candidato, ia)) return finalizar(orden2, 0);
          return degrau3(creditosAdiantados);
        });
      }
      return degrau3(creditosAdiantados);
    });
  }

  /* --------------------------------------------------------------- exports */

  var CineIdentificador = {
    versao: "1.0.0",
    procurar: procurar,
    buscar: buscar,
    detalhes: detalhes,
    creditos: function (chave, atores) {
      return creditosDeAtores(
        chave,
        (atores || [])
          .map(limparAtor)
          .filter(function (a) {
            return a.length >= 3;
          })
          .slice(0, 3)
      );
    },
    limparCache: limparCache,
    estatisticas: function () {
      return {
        pedidos: estatisticas.pedidos,
        rede: estatisticas.rede,
        cache: estatisticas.cache,
        erros: estatisticas.erros,
        ultimoMs: estatisticas.ultimoMs,
        externas:
          root && root.CineConfirmacao && typeof root.CineConfirmacao.estatisticas === "function"
            ? root.CineConfirmacao.estatisticas().pedidos
            : 0,
      };
    },
    /* internas, para os testes */
    _internas: {
      normalizar: normalizar,
      variantes: variantes,
      limparAtor: limparAtor,
      pontuar: pontuar,
      confiante: confiante,
      normalizarImdb: normalizarImdb,
      imdbConsistente: imdbConsistente,
      casouTitulo: casouTitulo,
      normalizarTMDB: normalizarTMDB,
      chaveDe: chaveDe,
    },
  };

  if (root) root.CineIdentificador = CineIdentificador;
  if (typeof module !== "undefined" && module.exports) module.exports = CineIdentificador;
})(typeof globalThis !== "undefined" ? globalThis : this);
