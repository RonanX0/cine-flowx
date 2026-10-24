/*
 * motor-ia.js — CineClip: identificação de filmes/séries e ganchos (motor v2).
 *
 * Código legível fora do bundle (como lote-massa.js). O bundle chama-o a partir de
 * Zb (identificar), nS (escolher no TMDB) e Hm (ganchos), passando as suas funções
 * de rede num objeto `h` (ver _ccMotorH no patch 74):
 *   h.gemini(chave, partes, busca, json)  h.geminiVideo(chave, video)  h.imagem(quadro)
 *   h.nvidiaVisao(chave, prompt, quadros, json)  h.nvidiaTexto(chave, prompt, json)
 *   h.tmdb(chave, caminho, params)  h.buscarTmdb(chave, q)  h.detalhes(chave, item)
 *   h.imdb(chave, id)  h.limparTitulo(t)  h.instrucaoModo(m)  h.generico(t)  h.limparGancho(t)  h.Erro
 *
 * IDENTIFICAÇÃO — três passos, para a IA não "inventar provas" para um chute:
 *   1. Perceção: a IA assiste ao corte e só regista o que dá para comprovar (falas,
 *      nomes ouvidos, texto na tela, atores com grau de certeza, ambiente, roteiro).
 *      Não recebe o nome do ficheiro nem a legenda do post, para não ser enviesada.
 *   2. Pesquisa: com essas provas (e as pistas externas, marcadas como "podem enganar"),
 *      a IA pesquisa no Google (falas entre aspas, nomes de personagens, filmografia)
 *      e propõe candidatos com as provas que batem e as que não batem.
 *   3. Conferência (sem IA): cada candidato é procurado no TMDB e o elenco é conferido —
 *      os atores reconhecidos e os nomes ouvidos têm de estar lá. Ganha quem tem provas;
 *      sem provas que batam, a confiança desce e o vídeo vai para «revisar».
 *
 * GANCHOS — escrever muitos, julgar contra a cena e ficar com os melhores:
 *   1. Se ainda não há roteiro da cena, a IA assiste e descreve (sem escrever ganchos).
 *   2. A IA escreve 10 ganchos com regras e exemplos do estilo brasileiro de cortes.
 *   3. Um segundo passo dá notas a cada gancho (fiel à cena, curiosidade, clareza);
 *      os que inventam coisas caem e o melhor vem primeiro.
 *   4. Limpeza final: tira rótulos ("Momento:", "Gancho 1:"), descrições ("A cena
 *      mostra…"), nomes de personagens e frases genéricas.
 */
(function (raiz) {
  "use strict";

  var VERSAO = 2;
  var VAZIO = /^(nenhum|nenhuma|desconhecid[oa]|indefinid[oa]|n\/a|na|none|unknown|nao sei|não sei|-+|\?+|sem|nada|ator \d+|personagem \d+|nome d[oa] (ator|atriz|personagem).*)$/i;
  var PALAVRAS_COMUNS = new Set(
    ("de da do das dos e o a os as um uma the and of in on to for with mr mrs ms dr " +
      "sargento sgt detetive det agente oficial policial policia doutor doutora senhor senhora " +
      "capitao tenente chefe comandante mae pai filho filha irmao irma tio tia vovo vo " +
      "detective officer agent captain lieutenant sergeant chief doctor mister miss sir").split(" ")
  );

  /* ------------------------------------------------------------------ utilitários */

  function norm(s) {
    return String(s == null ? "" : s)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  function txt(v, max) {
    return String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max || 600);
  }
  function lista(v, max) {
    if (!Array.isArray(v)) v = v ? [v] : [];
    var vistos = new Set();
    var saida = [];
    for (var i = 0; i < v.length; i++) {
      var s = txt(v[i] && typeof v[i] === "object" ? v[i].nome || v[i].name || v[i].texto || "" : v[i], 200);
      if (!s || VAZIO.test(s)) continue;
      var k = norm(s);
      if (!k || vistos.has(k)) continue;
      vistos.add(k);
      saida.push(s);
    }
    return saida.slice(0, max || 12);
  }
  function ano(v) {
    var m = String(v == null ? "" : v).match(/(19|20)\d{2}/);
    return m ? Number(m[0]) : 0;
  }
  function tipo(v) {
    var s = norm(v);
    if (/^(tv|serie|series|show|anime|novela|minisserie|miniserie)/.test(s)) return "tv";
    if (/^(movie|filme|film|longa)/.test(s)) return "movie";
    return "";
  }

  /** JSON de uma resposta de IA (com ```json, texto à volta ou vírgulas a mais). */
  function json(texto) {
    var s = String(texto || "").replace(/```(?:json)?/gi, "").trim();
    var i = s.indexOf("{");
    if (i < 0) return null;
    var j = s.lastIndexOf("}");
    if (j < i) return null;
    var bruto = s.slice(i, j + 1);
    try {
      return JSON.parse(bruto);
    } catch (e) {}
    try {
      return JSON.parse(bruto.replace(/,\s*([}\]])/g, "$1"));
    } catch (e) {}
    return null;
  }

  function tokensNome(s) {
    return norm(s)
      .split(" ")
      .filter(function (t) {
        return t.length >= 3 && !PALAVRAS_COMUNS.has(t);
      });
  }

  /* ------------------------------------------------------------ 1. perceção */

  function promptPercecao(modo) {
    var foco =
      modo === "dialogo"
        ? "\nFOCO: as falas e os textos na tela são o mais importante — transcreva-os com o máximo de cuidado.\n"
        : "";
    return (
      "Você vai ASSISTIR a um corte de filme ou série (às vezes vertical 9:16, às vezes dublado em português).\n" +
      "NÃO tente adivinhar o nome da obra agora. Primeiro registre só o que dá para COMPROVAR no vídeo." +
      foco +
      "\n\nREGRAS:\n" +
      "- Escreva só o que você realmente vê ou ouve. Se não tiver certeza, deixe vazio. Inventar texto na tela, nomes ou atores estraga a identificação.\n" +
      '- "falas": as frases ditas, transcritas exatamente como ouvidas, no idioma em que são ditas (até 6, as mais marcantes).\n' +
      '- "nomes_ouvidos": nomes próprios DITOS no áudio ou ESCRITOS na imagem (personagens, apelidos, lugares, empresas, unidades, naves). Só os que aparecem de verdade.\n' +
      '- "texto_na_tela": texto realmente legível nos quadros (legendas, placas, crachás, letreiros, títulos). Ignore marcas d\'água de TikTok/Kwai/CapCut e @perfis.\n' +
      '- "atores": só atores que você reconhece pelo rosto com segurança, cada um com "certeza" de 0 a 100. Se não reconhecer ninguém, deixe a lista vazia.\n' +
      '- "idioma_audio" e "dublado" (true se parece dublagem em português).\n' +
      '- "formato": "serie" se parece episódio de série de TV (policial, médica, sitcom, novela, anime…), "filme" se parece longa-metragem, "?" se não dá para saber; explique em "pistas_formato".\n' +
      '- "epoca" (década aproximada) e "ambiente" (país/cidade aparente, tipo de lugar, uniformes).\n' +
      '- "roteiro": o que acontece no corte, em ordem, em 3 a 6 frases curtas e concretas: quem faz o quê, o que é dito, qual é a virada ou o momento mais tenso. Chame as pessoas pelo PAPEL (o policial, a detetive, o homem de terno, a garota), não pelo nome.\n' +
      '- "momento_forte": numa frase curta, o instante mais tenso ou surpreendente.\n' +
      '- "emocao": a emoção dominante (medo, tensão, raiva, choque, tristeza, humor, romance…).\n' +
      '- "palpites": até 3 obras que podem ser, cada uma com o "motivo" (qual prova acima aponta para ela). Pode ficar vazio.\n' +
      "Escreva roteiro, momento_forte e motivos em Português do Brasil.\n\n" +
      "Responda SOMENTE com JSON válido:\n" +
      '{"falas": [], "nomes_ouvidos": [], "texto_na_tela": "", "atores": [{"nome": "", "certeza": 0}], "idioma_audio": "", "dublado": false, ' +
      '"formato": "?", "pistas_formato": "", "epoca": "", "ambiente": "", "roteiro": "", "momento_forte": "", "emocao": "", ' +
      '"palpites": [{"titulo": "", "titulo_original": "", "ano": 0, "tipo": "movie", "motivo": ""}]}'
    );
  }

  function normalizarProvas(e) {
    e = e && typeof e === "object" ? e : {};
    var atores = [];
    (Array.isArray(e.atores) ? e.atores : []).forEach(function (a) {
      var nome = txt(a && typeof a === "object" ? a.nome || a.name : a, 80);
      if (!nome || VAZIO.test(nome)) return;
      var c = a && typeof a === "object" ? Number(a.certeza != null ? a.certeza : a.confianca) : 70;
      atores.push({ nome: nome.replace(/\s*\(.*\)\s*$/, ""), certeza: isFinite(c) ? c : 70 });
    });
    var palpites = (Array.isArray(e.palpites) ? e.palpites : [])
      .map(function (p) {
        return {
          titulo: txt(p && (p.titulo || p.titulo_original), 120),
          titulo_original: txt(p && p.titulo_original, 120),
          ano: ano(p && p.ano),
          tipo: tipo(p && p.tipo),
          motivo: txt(p && p.motivo, 200),
        };
      })
      .filter(function (p) {
        return p.titulo && !VAZIO.test(p.titulo);
      });
    var formato = norm(e.formato);
    return {
      falas: lista(e.falas, 6),
      nomes: lista(e.nomes_ouvidos || e.personagens, 10),
      texto: VAZIO.test(txt(e.texto_na_tela)) ? "" : txt(e.texto_na_tela, 300),
      atores: atores.slice(0, 6),
      idioma: txt(e.idioma_audio, 40),
      dublado: e.dublado === true,
      formato: /^serie|^tv/.test(formato) ? "tv" : /^filme|^movie/.test(formato) ? "movie" : "",
      pistasFormato: txt(e.pistas_formato, 200),
      epoca: txt(e.epoca, 80),
      ambiente: txt(e.ambiente, 200),
      roteiro: txt(e.roteiro || e.cena, 900),
      momento: txt(e.momento_forte, 200),
      emocao: txt(e.emocao, 60),
      palpites: palpites.slice(0, 3),
    };
  }

  function espalhar(q, n) {
    q = (q || []).filter(Boolean);
    if (q.length <= n) return q;
    if (n <= 1) return [q[Math.floor(q.length / 2)]];
    var saida = [];
    for (var i = 0; i < n; i++) saida.push(q[Math.round((i * (q.length - 1)) / (n - 1))]);
    return saida;
  }

  /** Porque é que o Gemini não respondeu — vai no selo do resultado para não trocar de provedor em silêncio. */
  function motivoGemini(gem, e) {
    if (!gem) return "sem chave Gemini";
    var st = e && e.status, m = String((e && e.message) || "");
    if (st === 429 || /\b429\b|quota|cota|RESOURCE_EXHAUSTED|limite de pedidos/i.test(m)) return "Gemini sem cota";
    if (st === 401 || st === 403 || /\b40[13]\b|API key|chave.*(recusada|inválida)|PERMISSION_DENIED/i.test(m)) return "chave Gemini recusada";
    if (st === 503 || st === 500 || st === 502) return "Gemini fora do ar";
    return "Gemini falhou";
  }

  async function perceber(h, o) {
    var op = o.opcoes || {};
    var gem = txt(op.geminiKey, 200);
    var alt = Prov.temAlgumaIA(o);
    var quadros = Array.isArray(o.frames) ? o.frames : [];
    var prompt = promptPercecao(o.identMode);
    var erro = null;
    if (gem) {
      try {
        var partes = [{ text: prompt }];
        var vp = op.video && h.geminiVideo ? await h.geminiVideo(gem, op.video) : null;
        if (vp) {
          partes.push(vp);
          partes.push({ text: "O vídeo anexado é o corte COMPLETO (imagem + áudio). Assista inteiro antes de responder." });
        } else {
          quadros.slice(0, 8).forEach(function (q) {
            var img = h.imagem(q);
            if (img) partes.push({ inline_data: img });
          });
          if (op.audioClip) partes.push({ inline_data: { mime_type: op.audioClip.mimeType, data: op.audioClip.base64 } });
        }
        var r = json(await h.gemini(gem, partes, false, true));
        if (r) return { provas: normalizarProvas(r), provedor: "gemini" };
      } catch (e) {
        erro = e;
        if (!alt) throw e;
      }
    }
    if (alt) {
      // Sem Gemini (ou se ele falhou): o áudio vira texto no Whisper da Groq e os quadros vão para um modelo de visão.
      var fala = "";
      if (op.audioClip) {
        try { fala = await Prov.transcrever(o, op.audioClip); } catch (e) {}
      }
      var p2 = prompt + (fala ? '\n\nTRANSCRIÇÃO AUTOMÁTICA DO ÁUDIO (feita por um programa; pode ter erros de nomes): "' + fala + '"\nUse-a para preencher "falas" e "nomes_ouvidos" — copie as falas como estão.' : "\n\n(Você não tem o áudio, só os quadros: não invente falas.)");
      var r2 = null;
      if (quadros.length || fala) {
        r2 = json(await Prov.visao(o, p2, espalhar(quadros, 3), true));
      }
      if (r2) {
        var provas = normalizarProvas(r2);
        if (fala && !provas.falas.length) provas.falas = [fala.slice(0, 300)];
        return { provas: provas, provedor: Prov.ultimo || "groq", motivo: motivoGemini(gem, erro) };
      }
    }
    if (erro) throw erro;
    return { provas: normalizarProvas({}), provedor: gem ? "gemini" : "groq" };
  }

  /* ------------------------------------------------------------- 2. pesquisa */

  function promptPesquisa(p, pistas, modo, resultados) {
    var linhas = [];
    if (p.falas.length) linhas.push("- Falas ouvidas: " + p.falas.map(function (f) { return '"' + f + '"'; }).join(" | ") + (p.dublado ? " (parece dublado em português — a fala original deve ser outra; traduza para pesquisar)" : ""));
    if (p.nomes.length) linhas.push("- Nomes ditos/escritos: " + p.nomes.join(", "));
    if (p.texto) linhas.push('- Texto na tela: "' + p.texto + '"');
    if (p.atores.length) linhas.push("- Atores reconhecidos: " + p.atores.map(function (a) { return a.nome + " (" + a.certeza + "% de certeza)"; }).join(", "));
    if (p.formato) linhas.push("- Formato aparente: " + (p.formato === "tv" ? "série de TV" : "filme") + (p.pistasFormato ? " — " + p.pistasFormato : ""));
    if (p.epoca || p.ambiente) linhas.push("- Época/ambiente: " + [p.epoca, p.ambiente].filter(Boolean).join(" · "));
    if (p.roteiro) linhas.push("- O que acontece: " + p.roteiro);
    if (p.palpites.length) linhas.push("- Palpites de quem assistiu (NÃO confiáveis, confira): " + p.palpites.map(function (x) { return (x.titulo_original || x.titulo) + (x.ano ? " (" + x.ano + ")" : "") + (x.motivo ? " — " + x.motivo : ""); }).join("; "));
    var ext = [];
    if (pistas.arquivo) ext.push('- Nome do ficheiro: "' + pistas.arquivo + '"');
    if (pistas.arquivoBruto && norm(pistas.arquivoBruto) !== norm(pistas.arquivo)) ext.push('- Nome original do ficheiro (pode trazer o ID do vídeo do TikTok/Kwai): "' + pistas.arquivoBruto + '"');
    if (pistas.dica) ext.push('- Dica do utilizador: "' + pistas.dica + '"');
    if (pistas.legenda) ext.push('- Legenda do post original' + (pistas.autor ? " (@" + String(pistas.autor).replace(/^@/, "") + ")" : "") + ': "' + pistas.legenda + '"');
    return (
      "Você é um pesquisador de cinema e TV. Descubra de que FILME ou SÉRIE é este corte, usando " + (resultados ? "os RESULTADOS DE BUSCA abaixo (e o que você sabe)" : "a Pesquisa Google") + ".\n\n" +
      "PROVAS TIRADAS DO VÍDEO:\n" + (linhas.join("\n") || "- (quase nenhuma prova)") + "\n" +
      textoResultados(resultados) +
      (ext.length ? "\nPISTAS DE FORA:\n" + ext.join("\n") + "\n" +
        (pistas.arquivo ? "O nome do ficheiro costuma ser o NOME DA OBRA escrito pelo utilizador: se for um título de filme/série que existe e as provas não o contradizem, ele deve ser o 1º candidato. Só o descarte se as provas (falas, personagens, atores) apontarem claramente para outra obra.\n" : "") : "") +
      "\nCOMO PESQUISAR:\n" +
      "1. Pesquise as falas entre aspas (no idioma original; se for dublado, traduza para inglês) junto com \"movie\", \"series\" ou \"quote\".\n" +
      "2. Pesquise os nomes ditos/escritos juntos (ex.: \"Ruzek\" \"Upton\"). Dois nomes de personagens juntos identificam uma série quase sempre.\n" +
      "3. Confira na filmografia dos atores reconhecidos qual obra tem este ambiente, esta época e estes personagens.\n" +
      "4. Séries e filmes pouco conhecidos também contam — não troque por um título famoso só porque o ator é o mesmo.\n" +
      "5. Se for série, o título é o da SÉRIE (não o do episódio); se souber, diga a temporada/episódio.\n" +
      (modo === "dialogo" ? "6. Dê peso máximo às falas e aos nomes ditos.\n" : "") +
      "\nDê até 4 candidatos, do mais provável para o menos provável. Para cada um, liste as \"provas\" que batem e os \"conflitos\" (o que não bate). " +
      "\"confianca\" (0–100) só passa de 85 com prova forte: fala encontrada, nome de personagem confirmado ou texto na tela com o título.\n\n" +
      "Responda SOMENTE com JSON válido:\n" +
      '{"candidatos": [{"titulo": "título em português do Brasil", "titulo_original": "", "ano": 0, "tipo": "movie ou tv", "temporada_episodio": "", "imdb_id": "", "confianca": 0, "provas": [""], "conflitos": [""]}]}'
    );
  }

  function textoResultados(resultados) {
    if (!resultados || !resultados.length) return "";
    var linhas = [];
    resultados.forEach(function (r) {
      if (!r.itens.length) return;
      linhas.push('Busca: ' + r.q);
      r.itens.slice(0, 5).forEach(function (it) { linhas.push("  • " + (it.titulo || "") + (it.trecho ? " — " + it.trecho : "")); });
    });
    return linhas.length ? "\nRESULTADOS DA BUSCA NA WEB (confira com as provas; ignore o que não bate):\n" + linhas.join("\n") + "\n" : "\n(A busca na web não trouxe resultados: use o que você sabe, com cautela.)\n";
  }

  /** Consultas para o Serper/DuckDuckGo, tiradas só das provas (sem IA). */
  function montarConsultas(p, pistas) {
    var q = [];
    p.falas.slice(0, 2).forEach(function (f) {
      var t = txt(f, 120);
      if (t.split(" ").length >= 3) q.push('"' + t + '" movie OR series quote');
    });
    if (p.nomes.length) q.push(p.nomes.slice(0, 3).join(" ") + " characters movie OR series");
    var atores = p.atores.filter(function (a) { return a.certeza >= 55; }).slice(0, 2).map(function (a) { return a.nome; });
    if (atores.length) q.push(atores.join(" ") + " " + txt(p.ambiente || p.momento || p.roteiro, 70) + " movie scene");
    if (p.texto) q.push(txt(p.texto, 80) + " filme");
    if (pistas.dica) q.push(txt(pistas.dica, 80) + " filme série");
    if (!q.length && p.roteiro) q.push(txt(p.roteiro, 110) + " movie scene");
    var vistos = new Set();
    return q.filter(function (x) { var k = norm(x); if (!k || vistos.has(k)) return false; vistos.add(k); return true; }).slice(0, 4);
  }

  /** Gemini mais forte (2.5 Pro) só nesta etapa — é onde o título certo se decide; o app cai no Flash se o Pro falhar. */
  var MODELOS_GEMINI = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash-lite"];
  async function geminiBusca(h, gem, partes) {
    var forte = settingsAtuais().geminiBuscaForte !== false;
    var antes = raiz.__ccGeminiModelos;
    if (forte) raiz.__ccGeminiModelos = ["gemini-2.5-pro"].concat(MODELOS_GEMINI);
    try {
      return await h.gemini(gem, partes, true, true);
    } finally {
      raiz.__ccGeminiModelos = antes;
    }
  }

  function normalizarCandidatos(v, origem) {
    return (Array.isArray(v) ? v : [])
      .map(function (c) {
        var imdb = txt(c && (c.imdb_id || c.imdbId), 20).toLowerCase();
        return {
          titulo: txt(c && (c.titulo || c.titulo_original || c.title), 140),
          titulo_original: txt(c && (c.titulo_original || c.original_title), 140),
          ano: ano(c && c.ano),
          tipo: tipo(c && c.tipo),
          temporada_episodio: txt(c && c.temporada_episodio, 20),
          imdb_id: /^tt\d{6,10}$/.test(imdb) && !/^tt0+$/.test(imdb) ? imdb : "",
          confianca: Math.max(0, Math.min(100, Number(c && c.confianca) || 0)),
          provas: lista(c && c.provas, 6),
          conflitos: lista(c && c.conflitos, 6),
          origem: origem,
        };
      })
      .filter(function (c) {
        return c.titulo && !VAZIO.test(c.titulo);
      });
  }

  async function pesquisar(h, o, provas) {
    var op = o.opcoes || {};
    var gem = txt(op.geminiKey, 200);
    var alt = Prov.temAlgumaIA(o);
    var pn = o.pistaNome;
    var pistas = {
      arquivo: pn && pn.titulo ? pn.titulo + (pn.ano ? " (" + pn.ano + ")" : "") : "",
      arquivoBruto: txt(String(op.fileName || "").replace(/\.[a-z0-9]{2,4}$/i, ""), 120),
      dica: txt(o.dica, 200),
      legenda: txt(op.legendaPost, 400),
      autor: txt(op.autorPost, 60),
    };
    var r = null;
    if (gem) {
      try {
        r = json(await geminiBusca(h, gem, [{ text: promptPesquisa(provas, pistas, o.identMode) }]));
      } catch (e) {}
    }
    if (!r && alt) {
      // Sem a Pesquisa Google do Gemini: busca no Serper (ou DuckDuckGo) e a IA lê os resultados.
      var chaves = Prov.chaves(o);
      var consultas = montarConsultas(provas, pistas);
      var resultados = await Promise.all(consultas.map(function (q) {
        return Prov.buscar(q, chaves.serper).then(function (itens) { return { q: q, itens: itens }; }, function () { return { q: q, itens: [] }; });
      }));
      try {
        r = json(await Prov.texto(o, promptPesquisa(provas, pistas, o.identMode, resultados), true));
      } catch (e) {}
    }
    return normalizarCandidatos(r && r.candidatos, "pesquisa");
  }

  /* --------------------------------------------------------- identificar (Zb) */

  async function identificar(h, o) {
    o = o || {};
    var op = o.opcoes || {};
    var gem = txt(op.geminiKey, 200);
    var pn = o.pistaNome || null;
    if (!gem && !Prov.temAlgumaIA(o)) {
      if (pn && pn.titulo) {
        return montar({ provas: normalizarProvas({}), provedor: "dica" }, [candidatoDoArquivo(pn, 80)], o);
      }
      throw new (h.Erro || Error)("Adiciona a tua chave Google Gemini (recomendada), Groq ou OpenRouter nas configurações.");
    }

    var visto = await perceber(h, o);
    var candidatos = await pesquisar(h, o, visto.provas);

    // Os palpites da perceção e o nome do ficheiro entram como candidatos mais fracos:
    // a conferência no TMDB decide pelas provas, não pela ordem.
    visto.provas.palpites.forEach(function (p) {
      candidatos.push({ titulo: p.titulo, titulo_original: p.titulo_original, ano: p.ano, tipo: p.tipo, confianca: 45, provas: p.motivo ? [p.motivo] : [], conflitos: [], origem: "palpite" });
    });
    // Um título legível no nome do ficheiro é uma pista forte: se bater certinho com uma obra do TMDB,
    // ganha — a não ser que o elenco/personagens provem outra obra (ver pontos()).
    if (pn && pn.titulo) candidatos.push(candidatoDoArquivo(pn, 75));
    // O que o utilizador já corrigiu para este mesmo vídeo vale mais do que qualquer palpite da IA.
    var lembrados = lembrar(op.fileName, visto.provas.falas);
    if (lembrados.length) {
      var rejeitados = new Set();
      var certos = [];
      lembrados.forEach(function (e) {
        if (e.errado && e.errado.titulo) rejeitados.add(norm(e.errado.titulo));
        certos.push({ titulo: e.certo.titulo, titulo_original: e.certo.original || e.certo.titulo, ano: e.certo.ano || 0, tipo: e.certo.tipo || "", confianca: 96, provas: ["Você já corrigiu este vídeo para este título", "Correção guardada pelo CineClip"], conflitos: [], origem: "memoria" });
      });
      certos.forEach(function (c) { rejeitados.delete(norm(c.titulo)); });
      candidatos = candidatos.filter(function (c) { return !rejeitados.has(norm(c.titulo)) && !rejeitados.has(norm(c.titulo_original)); });
      candidatos = certos.concat(candidatos);
    }
    if (pn && Array.isArray(pn.alternativas)) {
      pn.alternativas.slice(0, 2).forEach(function (a) {
        candidatos.push({ titulo: a.titulo, titulo_original: a.titulo_original || a.titulo, ano: a.ano || 0, tipo: a.tipo || "", confianca: 25, provas: [], conflitos: [], origem: "arquivo" });
      });
    }
    return montar(visto, unicos(candidatos), o);
  }

  function candidatoDoArquivo(pn, conf) {
    return { titulo: pn.titulo, titulo_original: pn.titulo, ano: pn.ano || 0, tipo: pn.tipo === "tv" ? "tv" : "", temporada_episodio: pn.temporada_episodio || "", confianca: conf, provas: ["nome do ficheiro"], conflitos: [], origem: "arquivo", doNome: true };
  }

  function unicos(cands) {
    var mapa = new Map();
    cands.forEach(function (c) {
      var k = norm(c.titulo_original || c.titulo) + "|" + (c.ano || "");
      var k2 = norm(c.titulo) + "|" + (c.ano || "");
      var ja = mapa.get(k) || mapa.get(k2);
      if (ja) {
        ja.votos = (ja.votos || 1) + 1;
        ja.confianca = Math.max(ja.confianca, c.confianca);
        if (!ja.imdb_id && c.imdb_id) ja.imdb_id = c.imdb_id;
        return;
      }
      c.votos = 1;
      mapa.set(k, c);
      if (k2 !== k) mapa.set(k2, c);
    });
    return Array.from(new Set(mapa.values()));
  }

  function montar(visto, candidatos, o) {
    var p = visto.provas;
    var topo = candidatos[0] || {};
    return {
      motor: VERSAO,
      titulo: topo.titulo || topo.titulo_original || "",
      titulo_original: topo.titulo_original || topo.titulo || void 0,
      ano: topo.ano || void 0,
      tipo: topo.tipo || p.formato || void 0,
      temporada_episodio: topo.temporada_episodio || void 0,
      imdb_id: topo.imdb_id || void 0,
      confianca: topo.confianca || 0,
      atores: p.atores.filter(function (a) { return a.certeza >= 60; }).map(function (a) { return a.nome; }),
      personagens: p.nomes,
      fala_do_audio: p.falas.join(" / ") || void 0,
      texto_na_tela: p.texto || void 0,
      ancoras_visuais: [p.epoca, p.ambiente].filter(Boolean).join(" · ") || void 0,
      cena: p.roteiro || void 0,
      momento_forte: p.momento || void 0,
      emocao: p.emocao || void 0,
      ganchos: [],
      provedor: visto.provedor,
      provedor_motivo: visto.motivo || void 0,
      acordo_provedores: false,
      alternativas: candidatos.slice(1, 6).map(function (c) {
        return { titulo: c.titulo, titulo_original: c.titulo_original || void 0, ano: c.ano || void 0, tipo: c.tipo || void 0 };
      }),
      candidatos: candidatos.slice(0, 7),
      evidencias: p,
      modo_identificacao: o.identMode || "auto",
      modo_gancho: o.hookMode || "auto",
    };
  }

  /* ------------------------------------------------- 3. conferência (nS) */

  async function creditos(h, chave, item) {
    var caminho = item.kind === "tv" ? "/tv/" + item.id + "/aggregate_credits" : "/movie/" + item.id + "/credits";
    try {
      var r = await h.tmdb(chave, caminho, { language: "pt-BR" });
      var elenco = ((r && r.cast) || []).slice(0, 90);
      var nomes = [];
      var papeis = [];
      elenco.forEach(function (c) {
        nomes.push(norm(c.name || c.original_name || ""));
        if (c.character) papeis.push(norm(c.character));
        (c.roles || []).forEach(function (x) {
          if (x && x.character) papeis.push(norm(x.character));
        });
      });
      return { nomes: nomes, papeis: papeis };
    } catch (e) {
      return null;
    }
  }

  function atorBate(ator, nomes) {
    var a = norm(ator);
    if (!a) return false;
    var ta = a.split(" ");
    return nomes.some(function (n) {
      if (!n) return false;
      if (n === a) return true;
      var tn = n.split(" ");
      // "Robert Downey Jr" ↔ "Robert Downey Jr." ; primeiro + último nome iguais
      return ta.length >= 2 && tn.length >= 2 && ta[0] === tn[0] && ta[ta.length - 1] === tn[tn.length - 1];
    });
  }

  function nomeBate(nome, papeis) {
    var tk = tokensNome(nome);
    if (!tk.length) return false;
    return papeis.some(function (p) {
      if (!p) return false;
      var tp = p.split(/[\s\/]+/);
      return tk.some(function (t) { return tp.indexOf(t) !== -1; });
    });
  }

  async function escolher(h, chave, ia) {
    if (!ia) return null;
    var prov = ia.evidencias || {
      atores: (ia.atores || []).map(function (n) { return { nome: n, certeza: 70 }; }),
      nomes: ia.personagens || [],
      texto: ia.texto_na_tela || "",
      falas: [],
    };
    var cands = Array.isArray(ia.candidatos) && ia.candidatos.length
      ? ia.candidatos.slice()
      : [{ titulo: ia.titulo, titulo_original: ia.titulo_original, ano: ano(ia.ano), tipo: tipo(ia.tipo), imdb_id: ia.imdb_id, confianca: Number(ia.confianca) || 50, origem: ia.provedor === "dica" ? "arquivo" : "ia", votos: 1 }]
          .concat((ia.alternativas || []).map(function (a) {
            return { titulo: a.titulo, titulo_original: a.titulo_original, ano: ano(a.ano), tipo: tipo(a.tipo), confianca: 30, origem: ia.provedor === "dica" ? "arquivo" : "alt", votos: 1 };
          }));
    cands = cands.filter(function (c) { return c && (c.titulo || c.titulo_original); }).slice(0, 7);
    if (!cands.length) return null;

    var atoresProva = (prov.atores || []).filter(function (a) { return a.certeza >= 50; });
    var nomesProva = (prov.nomes || []).filter(function (n) { return tokensNome(n).length > 0; });
    var temProvas = atoresProva.length > 0 || nomesProva.length > 0;

    // TMDB: procura cada candidato pelo título (e pelo IMDb quando a IA o deu).
    var itens = new Map();
    function juntar(item, cand, idx, exato) {
      if (!item || !item.id) return;
      var k = item.kind + "-" + item.id;
      var ja = itens.get(k);
      if (ja) {
        ja.cands.push(cand);
        ja.exato = ja.exato || exato;
        if (exato && cand.doNome) ja.nomeExato = true;
        ja.idx = Math.min(ja.idx, idx);
        return;
      }
      itens.set(k, { item: item, cands: [cand], idx: idx, exato: exato, nomeExato: !!(exato && cand.doNome) });
    }
    await Promise.all(
      cands.map(async function (c, idx) {
        if (c.imdb_id && h.imdb) {
          var hit = await h.imdb(chave, c.imdb_id).catch(function () { return null; });
          if (hit) juntar(hit, c, idx, true);
        }
        var limpar = h.limparTitulo || function (t) { return t; };
        var qs = Array.from(new Set([c.titulo_original, c.titulo].map(function (t) { return txt(limpar(t || ""), 140); }).filter(Boolean)));
        for (var qi = 0; qi < qs.length; qi++) {
          var q = qs[qi];
          var nq = norm(q);
          var res = await h.buscarTmdb(chave, q).catch(function () { return []; });
          (res || []).slice(0, 8).forEach(function (r) {
            var nt = norm(r.title), no = norm(r.original);
            var sq = function (x) { return String(x || "").replace(/\s+/g, ""); };
            var exato = nt === nq || no === nq || (nq.length >= 4 && (sq(nt) === sq(nq) || sq(no) === sq(nq)));
            var parcial = !exato && nq.length >= 4 && [nt, no].some(function (t) {
              return t && (t.indexOf(nq) === 0 || nq.indexOf(t) === 0) && Math.min(t.length, nq.length) / Math.max(t.length, nq.length) >= 0.5;
            });
            if (!exato && !parcial) return;
            if (c.tipo && r.kind !== c.tipo && !exato) return;
            juntar(r, c, idx, exato);
          });
        }
      })
    );
    if (!itens.size) return null;

    function pontos(it) {
      var melhor = it.cands.reduce(function (m, c) { return (c.confianca || 0) > (m.confianca || 0) ? c : m; }, it.cands[0]);
      var t = (melhor.confianca || 40) * 0.5 - it.idx * 5 + (it.cands.length - 1) * 10;
      if (melhor.origem === "arquivo" && !temProvas) t += 25;
      // O título do nome do ficheiro bateu exatamente com esta obra: pesa como uma prova forte.
      if (it.nomeExato) t += 60;
      if (it.cands.some(function (c) { return c.origem === "memoria"; })) t += 140;
      t += it.exato ? 30 : 8;
      var a = melhor.ano, y = Number(it.item.year) || 0;
      if (a && y) {
        var d = Math.abs(a - y);
        if (d === 0) t += 18;
        else if (d <= 1) t += 12;
        else if (it.item.kind === "tv" && a >= y && a - y <= 25) t += 8;
        else if (d >= 4) t -= 15;
      }
      if (melhor.tipo && it.item.kind === melhor.tipo) t += 8;
      t += Math.min(8, Math.log10((Number(it.item.popularity) || 0) + 1) * 4);
      var tt = norm(it.item.title), to = norm(it.item.original);
      var tela = norm(prov.texto);
      if (tela && ((tt.length >= 4 && tela.indexOf(tt) !== -1) || (to.length >= 4 && tela.indexOf(to) !== -1))) {
        t += 40;
        it.textoBate = true;
      }
      return t;
    }
    var lista2 = Array.from(itens.values());
    lista2.forEach(function (it) { it.pontos = pontos(it); });
    lista2.sort(function (a, b) { return b.pontos - a.pontos; });

    // Elenco: os atores reconhecidos e os nomes ouvidos têm de estar na obra.
    if (temProvas) {
      var topo = lista2.slice(0, 6);
      var cr = await Promise.all(topo.map(function (it) { return creditos(h, chave, it.item); }));
      topo.forEach(function (it, i) {
        var c = cr[i];
        if (!c || (!c.nomes.length && !c.papeis.length)) return;
        it.creditos = true;
        it.atoresBatem = atoresProva.filter(function (a) { return atorBate(a.nome, c.nomes); }).length;
        it.nomesBatem = nomesProva.filter(function (n) { return nomeBate(n, c.papeis); }).length;
        it.pontos += Math.min(2, it.atoresBatem) * 35 + Math.min(3, it.nomesBatem) * 40;
        if (it.atoresBatem + it.nomesBatem === 0) it.pontos -= 35;
      });
      lista2.sort(function (a, b) { return b.pontos - a.pontos; });
    }

    var vencedor = lista2[0];
    var det = await h.detalhes(chave, vencedor.item);
    var base = vencedor.cands.reduce(function (m, c) { return Math.max(m, c.confianca || 0); }, 0) || 50;
    var provasOk = (vencedor.atoresBatem || 0) + (vencedor.nomesBatem || 0) + (vencedor.textoBate ? 1 : 0);
    var conf = base;
    if (provasOk >= 2) conf = Math.max(base, 92);
    else if (provasOk === 1) conf = Math.max(base, 80);
    else if (temProvas && vencedor.creditos) conf = Math.min(base, 55);
    var doArquivo = vencedor.cands.some(function (c) { return c.origem === "arquivo"; });
    if (vencedor.cands.some(function (c) { return c.origem === "memoria"; })) conf = Math.max(conf, 90);
    if (doArquivo && vencedor.exato && !temProvas) conf = Math.max(conf, 85);
    if (vencedor.nomeExato && (provasOk > 0 || !temProvas || !vencedor.creditos)) conf = Math.max(conf, 88);
    if (doArquivo && vencedor.exato && vencedor.cands.length > 1) conf = Math.max(conf, 90);
    conf = Math.round(Math.max(0, Math.min(99, conf)));

    // Quem chamou (Estúdio e lote) lê a confiança e o título no objeto da IA.
    ia.confianca = conf;
    ia.titulo = det.title;
    ia.titulo_original = det.original;
    ia.ano = det.year;
    ia.tipo = det.kind;
    det.verificacao = {
      atores: atoresProva.length,
      atoresNoElenco: vencedor.creditos ? vencedor.atoresBatem || 0 : null,
      personagens: nomesProva.length,
      personagensNoElenco: vencedor.creditos ? vencedor.nomesBatem || 0 : null,
      textoNaTela: !!vencedor.textoBate,
      confianca: conf,
    };
    det.candidatos = lista2.slice(1, 5).map(function (it) { return it.item; });
    return det;
  }

  /* --------------------------------------------------------------- ganchos (Hm) */

  var EXEMPLOS = [
    "O policial percebeu tarde demais que era uma armadilha 😨",
    "Ela só queria ajudar e virou a principal suspeita 😳",
    "Ele contou a verdade e ninguém acreditou nele 💀",
    "POV: seu parceiro esconde algo de você 👀",
    "A mãe descobriu tudo pelo celular do filho 😱",
    "Você entregaria seu próprio irmão nessa situação? 🤔",
  ];
  var EXEMPLOS_NORM = new Set(EXEMPLOS.map(norm));

  function limparGancho(h, t) {
    var s = String(t == null ? "" : t).replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();
    if (h && h.limparGancho) {
      try {
        s = h.limparGancho(s) || s;
      } catch (e) {}
    }
    for (var n = 0; n < 3; n++) {
      s = s
        .replace(/^[\-–—•·>#*]+\s*/, "")
        .replace(/^\d{1,2}\s*[.)\-:]\s+/, "")
        .replace(/^(momento(?: forte)?|emo[cç][aã]o|gatilho|visual|cena|an[aá]lise|roteiro|texto|gancho|hook|op[cç][aã]o|resposta|sugest[aã]o)\s*\d*\s*[:\-–—]\s*/i, "")
        .replace(/^["'“”«»]+|["'“”«»]+$/g, "")
        .trim();
    }
    return s;
  }

  function ganchoValido(h, s, proibidos) {
    if (!s || s.length < 12 || s.length > 64) return false;
    var palavras = s.split(/\s+/).length;
    if (palavras < 4 || palavras > 14) return false;
    if (/^[^:]{0,18}:\s/.test(s) && !/^POV:/i.test(s)) return false; // rótulo que sobrou
    if (/^(a|nesta|nessa|na|esta|essa) cena\b|\b(a cena|o v[ií]deo|o corte) mostra\b|^(cena|v[ií]deo) (de|em|com)\b/i.test(s)) return false;
    if (/\{|\}|\[|\]|"ganchos"|escreva aqui|gancho in[eé]dito/i.test(s)) return false;
    var k = norm(s);
    if (EXEMPLOS_NORM.has(k)) return false;
    if (h && h.generico) {
      try {
        if (h.generico(s)) return false;
      } catch (e) {}
    }
    if (/^(voce precisa (ver|assistir)|que cena|cena (incrivel|top|perfeita)|o final (e|vai)|assista ate o final|veja ate o final|nao vai acreditar|o momento (exato )?(em )?que tudo mudou)/.test(k)) return false;
    var palavrasK = " " + k + " ";
    for (var i = 0; i < proibidos.length; i++) {
      if (palavrasK.indexOf(" " + proibidos[i] + " ") !== -1) return false;
    }
    return true;
  }

  function promptCena(lang) {
    return (
      "Assista a este corte de filme/série e descreva SÓ o que acontece (não escreva ganchos).\n" +
      '- "roteiro": 3 a 6 frases curtas e concretas, em ordem: quem faz o quê, o que é dito, qual é a virada. Chame as pessoas pelo papel (o policial, a mulher, o garoto), nunca pelo nome.\n' +
      '- "momento_forte": o instante mais tenso ou surpreendente, numa frase curta.\n' +
      '- "emocao": a emoção dominante.\n' +
      '- "falas": as frases mais marcantes ditas (até 4).\n' +
      (lang === "pt-PT" ? "Escreve em Português de Portugal.\n" : "Escreva em Português do Brasil.\n") +
      'Responda SOMENTE com JSON válido: {"roteiro": "", "momento_forte": "", "emocao": "", "falas": []}'
    );
  }

  function promptEscrever(lang, cena, obra, instModo, evitar, usuario) {
    usuario = usuario || { bons: [], ruins: [] };
    var pt = lang === "pt-PT";
    var ctx = [];
    if (obra.titulo) ctx.push("Título: " + obra.titulo + (obra.ano ? " (" + obra.ano + ")" : ""));
    if (obra.generos) ctx.push("Gênero: " + obra.generos);
    if (obra.sinopse) ctx.push("Sinopse: " + obra.sinopse);
    return (
      "Você escreve os ganchos de uma página " + (pt ? "portuguesa" : "brasileira") + " de cortes de filmes e séries com milhões de seguidores no TikTok e no Reels. " +
      "O gancho é a frase no topo do vídeo que decide se a pessoa para de rolar.\n\n" +
      "O QUE ACONTECE NESTE CORTE (é a ÚNICA fonte de verdade — não invente nada além disto):\n" +
      (cena.roteiro ? "- Roteiro: " + cena.roteiro + "\n" : "") +
      (cena.momento ? "- Momento mais forte: " + cena.momento + "\n" : "") +
      (cena.emocao ? "- Emoção: " + cena.emocao + "\n" : "") +
      (cena.falas ? "- Falas: " + cena.falas + "\n" : "") +
      (ctx.length ? "\nCONTEXTO DA OBRA (só para entender — NÃO cite o nome):\n- " + ctx.join("\n- ") + "\n" : "") +
      "\nEscreva 10 ganchos diferentes.\n\n" +
      "COMO OS BONS GANCHOS FUNCIONAM:\n" +
      "- Mostram o COMEÇO da situação e escondem o desfecho: a pessoa precisa assistir para saber o que acontece.\n" +
      "- São concretos: citam o que realmente está em jogo NESTE corte (a confissão, a arma, o segredo, a ligação, a porta, o dinheiro).\n" +
      "- Usam o papel das pessoas (o policial, a detetive, o pai, a garota, o chefe), NUNCA nomes de personagens ou atores.\n" +
      "- São frases faladas, como " + (pt ? "um português" : "um brasileiro") + " escreveria no TikTok: 6 a 10 palavras, no máximo 52 caracteres, 1 emoji no fim.\n" +
      "- Variam o formato: situação tensa, revelação pela metade, pergunta para quem assiste, POV, contraste (\"Ele só queria X e acabou Y\"), aviso.\n\n" +
      (usuario.bons.length
        ? "GANCHOS QUE O DONO DA PÁGINA APROVOU (são de OUTRAS cenas — imite o jeito, o ritmo e o tamanho, mas não copie):\n- " + usuario.bons.join("\n- ") + "\n\n"
        : "") +
      (usuario.bons.length < 5 ? "EXEMPLOS DO ESTILO (são de OUTRAS cenas — não copie):\n- " + EXEMPLOS.slice(0, usuario.bons.length ? 4 : EXEMPLOS.length).join("\n- ") + "\n\n" : "") +
      (usuario.ruins.length ? "GANCHOS QUE O DONO DA PÁGINA REPROVOU (nunca escreva neste estilo):\n- " + usuario.ruins.join("\n- ") + "\n\n" : "") +
      "NUNCA ESCREVA:\n" +
      "- rótulos ou numeração (\"Momento:\", \"Gancho 1:\", \"1.\");\n" +
      "- descrições (\"A cena mostra…\", \"Nesta cena…\");\n" +
      "- frases que servem para qualquer vídeo (\"Você precisa ver isso\", \"Que cena!\", \"O final é chocante\");\n" +
      "- o desfecho, nomes de personagens, atores ou da obra.\n" +
      (instModo ? "\n" + instModo + "\n(Escreva os 10 ganchos neste tom.)\n" : "") +
      (evitar && evitar.length ? "\nJÁ USADOS (proibido repetir ou parafrasear): " + evitar.map(function (x) { return '"' + x + '"'; }).join(", ") + "\n" : "") +
      (pt ? "\nEscreve em Português de Portugal.\n" : "\nEscreva em Português do Brasil.\n") +
      'Responda SOMENTE com JSON válido: {"ganchos": ["...", "...", "...", "...", "...", "...", "...", "...", "...", "..."]}'
    );
  }

  function promptJulgar(cena, lista3) {
    return (
      "Você é o editor-chefe de uma página de cortes de filmes. Avalie cada gancho para ESTE corte.\n\n" +
      "O CORTE:\n" +
      (cena.roteiro ? "- Roteiro: " + cena.roteiro + "\n" : "") +
      (cena.momento ? "- Momento mais forte: " + cena.momento + "\n" : "") +
      (cena.falas ? "- Falas: " + cena.falas + "\n" : "") +
      "\nGANCHOS:\n" + lista3.map(function (g, i) { return i + ". " + g; }).join("\n") + "\n\n" +
      "Dê a cada um notas de 0 a 10:\n" +
      '- "fiel": fala de algo que REALMENTE acontece neste corte? (0 se inventa algo que não está no roteiro, ou se serve para qualquer vídeo)\n' +
      '- "curiosidade": dá vontade de assistir até o fim para saber o que acontece?\n' +
      '- "clareza": dá para entender em 2 segundos, sem conhecer o filme?\n\n' +
      'Responda SOMENTE com JSON válido: {"notas": [{"i": 0, "fiel": 0, "curiosidade": 0, "clareza": 0}]}'
    );
  }

  async function chamarTexto(h, o, gem, prompt, jsonModo) {
    var alt = Prov.temAlgumaIA(o);
    if (gem) {
      try {
        return await h.gemini(gem, [{ text: prompt }], false, jsonModo);
      } catch (e) {
        if (!alt) throw e;
      }
    }
    if (alt) return await Prov.texto(o, prompt, jsonModo);
    throw new (h.Erro || Error)("Adiciona a tua chave Google Gemini, Groq ou OpenRouter nas configurações para gerar o gancho.");
  }

  // Lista local: a reserva acontece antes de qualquer await, inclusive em lotes paralelos.
  var GANCHOS_PRONTOS = [
    "Só mais uma cena antes de dormir 👀",
    "Esse corte merece sua atenção 🎬",
    "Quem mais ficou preso nessa cena? 👀",
    "Dá o play e me conta o que achou 🎬",
    "Uma cena para quem ama cinema 🍿",
    "Qual seria a sua reação? 🤔",
    "Esse é o seu tipo de filme? 🍿",
    "Eu precisava compartilhar essa cena 🎬",
    "Pausa no feed para um pouco de cinema 🍿",
    "Você assistiria até o fim? 👀",
    "Vale um lugar na sua lista? 🎬",
    "Quem você chamaria para assistir? 🍿",
    "Uma cena, muitas opiniões 🤔",
    "O que você faria nessa situação? 👀",
    "Já viu essa cena antes? 🎬",
    "Deixa sua opinião depois do play 💬",
    "Cinema combina com uma boa conversa 🍿",
    "Esse corte entrou no meu feed e ficou 👀",
    "Mais um motivo para falar de cinema 🎬",
    "Hoje o convite é dar o play 🍿",
    "Sua próxima pausa começa aqui 🎬",
    "Assiste e me diz: valeu o play? 👀",
    "Marca quem gosta de uma boa cena 🍿",
    "Uma pausa para os fãs de cinema 🎬"
  ];
  var historicoGanchos = [];
  function usaLista(modo) { return !modo || modo === "auto" || modo === "lista"; }
  function ganchosDaLista(extra) {
    extra = extra || {};
    var s = settingsAtuais();
    var personalizados = String(s.ganchosBons || "").split(/\r?\n/).map(function (v) { return v.trim(); }).filter(Boolean);
    var pool = Array.from(new Set(personalizados.length ? personalizados : GANCHOS_PRONTOS));
    var bloqueados = new Set(String(s.ganchosRuins || "").split(/\r?\n/).map(norm).filter(Boolean));
    pool = pool.filter(function (v) { return !bloqueados.has(norm(v)); });
    if (!pool.length) throw new Error("Todos os ganchos foram bloqueados. Edite a lista nas Configurações.");
    try { var salvo = JSON.parse(raiz.localStorage.getItem("cineclip.ganchos.usados") || "[]"); if (Array.isArray(salvo)) historicoGanchos = salvo; } catch (_) {}
    var evitar = Array.isArray(extra.evitar) ? extra.evitar.map(norm) : [];
    var usados = historicoGanchos.map(norm);
    // Mais antigo primeiro quando toda a lista já foi usada.
    pool.sort(function (a, b) {
      var ea = evitar.includes(norm(a)), eb = evitar.includes(norm(b));
      if (ea !== eb) return ea ? 1 : -1;
      return usados.lastIndexOf(norm(a)) - usados.lastIndexOf(norm(b));
    });
    var escolhido = pool[0];
    historicoGanchos = historicoGanchos.filter(function (v) { return norm(v) !== norm(escolhido); }).concat(escolhido).slice(-500);
    try { raiz.localStorage.setItem("cineclip.ganchos.usados", JSON.stringify(historicoGanchos)); } catch (_) {}
    return { cena: "", ganchos: pool.slice(0, 5), modo: "lista" };
  }

  // Legendas prontas do «modo direto»: sem identificar o filme e sem IA. {gancho}
  // vira o gancho sorteado da lista; {filme}/{ano} só entram quando existem
  // (a linha que os usa sai, como no primeiro comentário). Nas Configurações,
  // uma legenda por bloco, blocos separados por uma linha só com ---.
  var LEGENDAS_PRONTAS = [
    "{gancho}\n\n🎬 Nome do filme? Tá no link da minha B10 👀\n\n#Filmes #Cinema #Reels #CenasDeFilme #DicaDeFilme",
    "{gancho}\n\nAssiste até o fim e me conta: valeu o play? 💬\n\n#Cinema #Filmes #CenaDeFilme #ReelsBrasil #DicaDeFilme",
    "{gancho}\n\nSalva pra assistir depois 🍿\nLink do filme na minha B10 🎬\n\n#Filmes #Series #Cinema #Reels #FilmeBom",
    "{gancho}\n\nMarca aquela pessoa que precisa ver essa cena 👀\n\n#CenasDeFilme #Filmes #Reels #Cinema #Maratona",
    "{gancho}\n\nQuer o filme completo? Link na minha B10 🎬\n\n#Filmes #Cinema #DicaDeFilme #Reels #Pipoca",
    "{gancho}\n\nDe 0 a 10, que nota essa cena merece? Comenta aí 💬\n\n#Cinema #Filmes #Reels #CenasQueMarcam #Filme",
    "{gancho}\n\n🍿 Pausa rápida no feed pra uma boa cena.\nNome e link na minha B10 🎬\n\n#Filmes #Cinema #Reels #Series #CenaDeFilme",
    "{gancho}\n\nSegue a página pra uma cena dessas todo dia 🎬\n\n#Filmes #DicaDeFilme #Cinema #ReelsBrasil #FilmesESeries",
    "{gancho}\n\nVocê já conhecia esse filme? Conta nos comentários 👇\n\n#Cinema #CenasDeFilme #Filmes #Reels #Curiosidades",
    "{gancho}\n\n🔗 Link do filme na minha B10\nSalva o post pra não perder 🍿\n\n#Filmes #Cinema #Reels #FilmeBom #DicaDeFilme",
    "{gancho}\n\nCompartilha com quem ama cinema 🎥\n\n#CenaDeFilme #Filmes #Cinema #Reels #Series",
    "{gancho}\n\nQual filme você quer ver aqui? Pede nos comentários 💬\n\n#Filmes #Cinema #Reels #Maratona #CenasDeFilme"
  ];
  // 1.º comentário fixo dos Reels do modo direto (guardado no próprio Reel como
  // `firstComment`; os publicadores — app, Robô 24h e webhook — preferem-no ao modelo).
  var COMENTARIO_DIRETO = "LINK DO FILME NA MINHA B10";
  var historicoLegendas = [];
  function legendasPersonalizadas(texto) {
    var blocos = [];
    var atual = [];
    String(texto || "").split(/\r?\n/).forEach(function (linha) {
      if (linha.trim() === "---") { blocos.push(atual.join("\n")); atual = []; }
      else atual.push(linha);
    });
    blocos.push(atual.join("\n"));
    return blocos.map(function (b) { return b.trim(); }).filter(Boolean);
  }
  function aplicarLegenda(modelo, extra) {
    var gancho = String(extra.gancho || "").trim();
    var filme = String(extra.filme || "").trim();
    var ano = String(extra.ano || "").trim();
    var linhas = String(modelo).replace(/\r/g, "").split("\n").map(function (l) {
      if (!ano) l = l.replace(/\s*\(\{ano\}\)/g, "");
      if ((!gancho && l.indexOf("{gancho}") >= 0) || (!filme && l.indexOf("{filme}") >= 0) || (!ano && l.indexOf("{ano}") >= 0)) return null;
      return l.split("{gancho}").join(gancho).split("{filme}").join(filme).split("{ano}").join(ano);
    }).filter(function (l) { return l !== null; });
    return linhas.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 2200);
  }
  // Mesma disciplina dos ganchos: reserva síncrona (lotes em paralelo nunca
  // repetem), histórico persistido e lista inteira antes de recomeçar.
  function legendasDaLista(extra) {
    extra = extra || {};
    var s = settingsAtuais();
    var personalizadas = legendasPersonalizadas(s.legendasBoas);
    var pool = Array.from(new Set(personalizadas.length ? personalizadas : LEGENDAS_PRONTAS));
    if (!pool.length) throw new Error("Não há legendas prontas. Edite a lista nas Configurações.");
    try { var salvoL = JSON.parse(raiz.localStorage.getItem("cineclip.legendas.usadas") || "[]"); if (Array.isArray(salvoL)) historicoLegendas = salvoL; } catch (_) {}
    var evitarL = Array.isArray(extra.evitar) ? extra.evitar.map(norm) : [];
    var usadasL = historicoLegendas.map(norm);
    pool.sort(function (a, b) {
      var ea = evitarL.includes(norm(a)), eb = evitarL.includes(norm(b));
      if (ea !== eb) return ea ? 1 : -1;
      return usadasL.lastIndexOf(norm(a)) - usadasL.lastIndexOf(norm(b));
    });
    var escolhido = pool[0];
    historicoLegendas = historicoLegendas.filter(function (v) { return norm(v) !== norm(escolhido); }).concat(escolhido).slice(-500);
    try { raiz.localStorage.setItem("cineclip.legendas.usadas", JSON.stringify(historicoLegendas)); } catch (_) {}
    var legenda = aplicarLegenda(escolhido, extra);
    if (!legenda) legenda = String(extra.gancho || "").trim() || "#Filmes #Cinema #Reels #CenasDeFilme";
    return { legenda: legenda, modelo: escolhido, modo: "lista" };
  }

  async function ganchos(h, o) {
    o = o || {};
    var ex = o.extra && typeof o.extra === "object" ? o.extra : {};
    var modo = norm(ex.hookMode || ex.modo || o.modo || "auto").replace(/ /g, "_") || "auto";
    if (modo === "sem_gancho") return { cena: "", ganchos: [], modo: modo };
    if (usaLista(modo)) return ganchosDaLista(ex);
    var gem = txt(o.geminiKey, 200);
    var alt = Prov.temAlgumaIA(o);
    var quadros = Array.isArray(o.frames) ? o.frames : [];
    var obraObj = o.obra && typeof o.obra === "object" ? o.obra : null;
    var obra = {
      titulo: txt(obraObj ? obraObj.title || obraObj.titulo : typeof o.obra === "string" && !/\.(mp4|mov|webm|mkv)$/i.test(o.obra) && !/^cena de filme/i.test(o.obra) ? o.obra : "", 120),
      ano: txt(obraObj ? obraObj.year || obraObj.ano : "", 4),
      generos: obraObj && Array.isArray(obraObj.genres) ? obraObj.genres.slice(0, 3).join(", ") : "",
      sinopse: txt(ex.sinopse || (obraObj && (obraObj.overview || obraObj.sinopse)) || "", 500),
    };
    var cena = {
      roteiro: txt(ex.roteiro || ex.cena || "", 900),
      momento: txt(ex.momento || ex.momento_forte || "", 200),
      emocao: txt(ex.emocao || "", 60),
      falas: txt(Array.isArray(ex.fala) ? ex.fala.join(" / ") : ex.fala || "", 400),
    };

    // 1. Sem roteiro da cena? A IA assiste primeiro (não dá para escrever bem sem saber o que acontece).
    if (cena.roteiro.length < 60) {
      try {
        var r = null;
        if (gem && (o.video || quadros.length)) {
          var partes = [{ text: promptCena(o.lang) }];
          var vp = o.video && h.geminiVideo ? await h.geminiVideo(gem, o.video) : null;
          if (vp) partes.push(vp);
          else {
            quadros.slice(0, 7).forEach(function (q) {
              var img = h.imagem(q);
              if (img) partes.push({ inline_data: img });
            });
            if (o.audio) partes.push({ inline_data: { mime_type: o.audio.mimeType, data: o.audio.base64 } });
          }
          r = json(await h.gemini(gem, partes, false, true));
        } else if (alt && (quadros.length || o.audio)) {
          var falaAudio = "";
          if (o.audio) { try { falaAudio = await Prov.transcrever(o, o.audio); } catch (e) {} }
          var pc = promptCena(o.lang) + (falaAudio ? '\n\nTRANSCRIÇÃO AUTOMÁTICA DO ÁUDIO: "' + falaAudio + '"' : "");
          r = json(await Prov.visao(o, pc, espalhar(quadros, 3), true));
          if (r && falaAudio && !(r.falas && r.falas.length)) r.falas = [falaAudio.slice(0, 300)];
        }
        if (r) {
          cena.roteiro = txt(r.roteiro || r.cena, 900) || cena.roteiro;
          cena.momento = cena.momento || txt(r.momento_forte, 200);
          cena.emocao = cena.emocao || txt(r.emocao, 60);
          cena.falas = cena.falas || lista(r.falas, 4).join(" / ");
        }
      } catch (e) {
        if (!cena.roteiro && !obra.sinopse && !alt && !gem) throw e;
      }
    }

    // 2. Escrever 10.
    var instModo = modo !== "auto" && h.instrucaoModo ? txt(h.instrucaoModo(modo), 900).replace(/Crie 3 varia[cç][oõ]es/gi, "Crie variações") : "";
    var evitar = Array.isArray(ex.evitar) ? ex.evitar.slice(-8).map(function (x) { return txt(x, 80); }).filter(Boolean) : [];
    var usuario = exemplosDoUsuario();
    var bonsNorm = new Set(usuario.bons.map(norm));
    var bruto = await chamarTexto(h, o, gem, promptEscrever(o.lang, cena, obra, instModo, evitar, usuario), false);
    var r2 = json(bruto);
    var escritos = r2 && Array.isArray(r2.ganchos)
      ? r2.ganchos
      : String(bruto || "").split(/\n+/).filter(function (l) { return !/^\s*[{}\[\]]/.test(l); });

    var proibidos = [];
    (ex.personagens || []).concat(ex.atores || []).forEach(function (n) {
      tokensNome(n).forEach(function (t) { if (t.length >= 4) proibidos.push(t); });
    });
    if (obra.titulo && norm(obra.titulo).length >= 5) proibidos.push(norm(obra.titulo));

    var vistos = new Set();
    var candidatos = [];
    escritos.forEach(function (g) {
      var s = limparGancho(h, g);
      var k = norm(s);
      if (!k || vistos.has(k) || bonsNorm.has(k) || evitar.some(function (e) { return norm(e) === k; })) return;
      if (!ganchoValido(h, s, proibidos)) return;
      vistos.add(k);
      candidatos.push(s);
    });
    if (!candidatos.length) {
      var reserva = cena.momento ? limparGancho(h, cena.momento.replace(/[.!]+$/, "")) : "";
      if (reserva && reserva.length <= 64) return { cena: cena.roteiro, ganchos: [reserva + " 😳"], modo: modo };
      return { cena: cena.roteiro, ganchos: [], modo: modo };
    }

    // 3. Julgar contra a cena.
    var ordem = candidatos.map(function (g, i) { return { g: g, i: i, nota: 0, fiel: 10 }; });
    if (candidatos.length > 1 && (cena.roteiro || cena.momento)) {
      try {
        var r3 = json(await chamarTexto(h, o, gem, promptJulgar(cena, candidatos), true));
        var notas = r3 && Array.isArray(r3.notas) ? r3.notas : [];
        notas.forEach(function (n) {
          var it = ordem[Number(n && n.i)];
          if (!it) return;
          var fiel = Number(n.fiel), cur = Number(n.curiosidade), cla = Number(n.clareza);
          if (!isFinite(fiel) || !isFinite(cur)) return;
          it.fiel = fiel;
          it.nota = fiel * 0.45 + cur * 0.4 + (isFinite(cla) ? cla : 7) * 0.15 - (it.g.length > 52 ? 1 : 0);
          it.avaliado = true;
        });
        var avaliados = ordem.filter(function (it) { return it.avaliado; });
        if (avaliados.length) {
          var fieis = avaliados.filter(function (it) { return it.fiel >= 6; });
          ordem = (fieis.length ? fieis : avaliados).sort(function (a, b) { return b.nota - a.nota || a.i - b.i; });
        }
      } catch (e) {}
    }
    return {
      cena: cena.roteiro,
      ganchos: ordem.slice(0, 5).map(function (it) { return it.g; }),
      modo: modo,
      analise: { momento: cena.momento, emocao: cena.emocao },
    };
  }

  /* ========================================================================
   * PROVEDORES DE IA — Gemini (principal) → Groq (+Serper) → OpenRouter free (+DuckDuckGo)
   *
   * Groq e OpenRouter aceitam chamadas direto do browser. Serper e DuckDuckGo não
   * (CORS), por isso, se a chamada direta falhar, o pedido vai pelo proxy do próprio
   * site (/api/public/ia). Os modelos são descobertos pela lista da própria API
   * (os nomes mudam), com uma lista de preferência e reserva.
   * ====================================================================== */

  var GROQ = "https://api.groq.com/openai/v1";
  var OPENROUTER = "https://openrouter.ai/api/v1";
  var cfgManual = {};
  var cacheModelos = {};
  var bloqueados = {};

  function settingsAtuais() {
    var s = {};
    try {
      var raw = raiz.localStorage && raiz.localStorage.getItem("cineclip.settings");
      if (raw) s = JSON.parse(raw) || {};
    } catch (e) {}
    [raiz.__CineClipApp && raiz.__CineClipApp.settings, cfgManual].forEach(function (fonte) {
      if (!fonte || typeof fonte !== "object") return;
      Object.keys(fonte).forEach(function (k) {
        if (fonte[k] != null && (k === "ganchosBons" || k === "ganchosRuins" || k === "legendasBoas" || String(fonte[k]).trim() !== "")) s[k] = fonte[k];
      });
    });
    return s;
  }
  function chaveDe(nome, explicita) {
    return txt(explicita || settingsAtuais()[nome], 300);
  }
  function erroHttp(msg, status, extra) {
    var e = new Error(msg);
    e.status = status || 0;
    if (extra) e.retryAfter = extra;
    return e;
  }

  async function http(url, init, opcoes) {
    opcoes = opcoes || {};
    var f = raiz.fetch ? raiz.fetch.bind(raiz) : fetch;
    var ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, opcoes.timeout || 60000) : null;
    var base = Object.assign({}, init || {});
    if (ctl) base.signal = ctl.signal;
    try {
      var r;
      try {
        r = await f(url, base);
      } catch (e) {
        if (!opcoes.proxy || (e && e.name === "AbortError")) throw e;
        r = await f("/api/public/ia", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: url, method: base.method || "POST", headers: base.headers || {}, body: base.body == null ? "" : base.body }),
          signal: base.signal,
        });
      }
      return r;
    } catch (e) {
      if (e && e.status) throw e;
      throw erroHttp(e && e.name === "AbortError" ? "Tempo esgotado ao contactar " + (opcoes.nome || "o serviço") + "." : "Falha de rede ao contactar " + (opcoes.nome || "o serviço") + ".", 0);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async function ler(r, nome) {
    if (r.ok) return r;
    var corpo = "";
    try { corpo = await r.text(); } catch (e) {}
    var detalhe = "";
    try { var j = JSON.parse(corpo); detalhe = (j.error && (j.error.message || j.error)) || j.message || ""; } catch (e) {}
    var msg = r.status === 401 || r.status === 403 ? "A chave " + nome + " foi recusada (" + r.status + "). Confere se está certa." :
      r.status === 429 ? nome + ": limite de pedidos atingido. Espera um pouco." :
      r.status === 402 ? nome + ": sem créditos." :
      nome + " respondeu " + r.status + (detalhe ? ": " + txt(detalhe, 160) : ".");
    var ra = Number(r.headers && r.headers.get && r.headers.get("retry-after")) || 0;
    throw erroHttp(msg, r.status, ra);
  }

  function ordenarPorPreferencia(ids, preferencias) {
    var escolhidos = [];
    preferencias.forEach(function (p) {
      ids.forEach(function (id) {
        if (escolhidos.indexOf(id) < 0 && (typeof p === "string" ? id === p : p.test(id))) escolhidos.push(id);
      });
    });
    return escolhidos;
  }

  /* ---------------- Groq ---------------- */
  var GROQ_TEXTO = ["openai/gpt-oss-120b", "llama-3.3-70b-versatile", "qwen/qwen3.8-27b", "openai/gpt-oss-20b", "llama-3.1-8b-instant"];
  var GROQ_VISAO = ["qwen/qwen3.8-27b", "meta-models/muse-spark-open", "meta-llama/llama-4-scout-17b-16e-instruct", "meta-llama/llama-4-maverick-17b-128e-instruct", /vision|scout|maverick|-vl\b/i];
  var GROQ_AUDIO = ["whisper-large-v3-turbo", "whisper-large-v3"];

  async function groqModelos(chave) {
    var c = cacheModelos.groq;
    if (c && c.chave === chave && Date.now() - c.t < 600000) return c;
    var ids = [];
    try {
      var r = await ler(await http(GROQ + "/models", { headers: { Authorization: "Bearer " + chave } }, { nome: "Groq", timeout: 20000 }), "Groq");
      var d = await r.json();
      ids = (d.data || []).map(function (m) { return m.id; }).filter(Boolean);
    } catch (e) {
      if (e.status === 401 || e.status === 403) throw e;
    }
    var c2 = {
      chave: chave,
      t: Date.now(),
      texto: ids.length ? ordenarPorPreferencia(ids, GROQ_TEXTO) : GROQ_TEXTO.slice(0, 3),
      visao: ids.length ? ordenarPorPreferencia(ids, GROQ_VISAO) : GROQ_VISAO.slice(0, 2),
      audio: ids.length ? ordenarPorPreferencia(ids, GROQ_AUDIO) : GROQ_AUDIO.slice(),
    };
    if (!c2.texto.length) c2.texto = GROQ_TEXTO.slice(0, 3);
    cacheModelos.groq = c2;
    return c2;
  }

  function bloquear(modelo, segundos) {
    bloqueados[modelo] = Date.now() + Math.max(15, Math.min(300, segundos || 60)) * 1000;
  }
  function livres(lista) {
    var livre = lista.filter(function (m) { return !(bloqueados[m] > Date.now()); });
    return livre.length ? livre : lista;
  }

  /** Chat compatível com OpenAI (Groq e OpenRouter). `mensagens` no formato OpenAI. */
  async function chatOpenAI(base, nome, chave, modelos, mensagens, jsonModo, extraHeaders) {
    var ultimo = null;
    var lista = livres(modelos);
    for (var i = 0; i < lista.length && i < 4; i++) {
      var modelo = lista[i];
      var corpo = { model: modelo, messages: mensagens, temperature: jsonModo ? 0.2 : 0.8, max_tokens: 2500 };
      if (jsonModo) corpo.response_format = { type: "json_object" };
      for (var tentativa = 0; tentativa < 2; tentativa++) {
        try {
          var headers = Object.assign({ "Content-Type": "application/json", Authorization: "Bearer " + chave }, extraHeaders || {});
          var r = await ler(await http(base + "/chat/completions", { method: "POST", headers: headers, body: JSON.stringify(corpo) }, { nome: nome, timeout: 90000 }), nome);
          var d = await r.json();
          var ch = d && d.choices && d.choices[0];
          var texto = (ch && ch.message && ch.message.content) || "";
          if (Array.isArray(texto)) texto = texto.map(function (p) { return p && p.text || ""; }).join("");
          texto = String(texto).replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
          if (!texto) throw erroHttp(nome + " devolveu uma resposta vazia.", 0);
          return texto;
        } catch (e) {
          ultimo = e;
          if (e.status === 401 || e.status === 403) throw e;
          if (e.status === 400 && corpo.response_format) { delete corpo.response_format; continue; } // modelo sem modo JSON
          if (e.status === 429) bloquear(modelo, e.retryAfter);
          if (e.status === 404 || e.status === 402) bloquear(modelo, 600);
          break;
        }
      }
    }
    throw ultimo || erroHttp(nome + ": não foi possível obter resposta.", 0);
  }

  function msgComImagens(prompt, quadros, max) {
    var partes = [{ type: "text", text: prompt }];
    (quadros || []).filter(Boolean).slice(0, max).forEach(function (q) {
      partes.push({ type: "image_url", image_url: { url: q } });
    });
    return [{ role: "user", content: partes }];
  }

  async function groqTexto(chave, prompt, jsonModo) {
    var m = await groqModelos(chave);
    return chatOpenAI(GROQ, "Groq", chave, m.texto, [{ role: "user", content: prompt }], jsonModo);
  }
  /** Encolhe um quadro (data URL) para `lado` px — menos tokens de imagem. Sem canvas, devolve o original. */
  function reduzirQuadro(url, lado) {
    return new Promise(function (resolve) {
      var fim = false;
      function acabar(v) { if (!fim) { fim = true; resolve(v); } }
      try {
        if (typeof document === "undefined" || typeof Image === "undefined" || !/^data:image\//.test(String(url))) return acabar(url);
        var img = new Image();
        img.onload = function () {
          try {
            var r = Math.min(1, lado / Math.max(img.width || 1, img.height || 1));
            if (r >= 1) return acabar(url);
            var c = document.createElement("canvas");
            c.width = Math.max(1, Math.round(img.width * r));
            c.height = Math.max(1, Math.round(img.height * r));
            c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
            acabar(c.toDataURL("image/jpeg", 0.7));
          } catch (e) { acabar(url); }
        };
        img.onerror = function () { acabar(url); };
        img.src = url;
        setTimeout(function () { acabar(url); }, 2000);
      } catch (e) { acabar(url); }
    });
  }

  /**
   * Visão com as imagens cada vez mais leves: o limite grátis de tokens por minuto (413) ou um
   * pedido grande demais (400) não deve deitar a identificação abaixo — tenta com menos quadros e menores.
   */
  var NIVEIS_VISAO = [{ n: 3, lado: 640 }, { n: 2, lado: 448 }, { n: 1, lado: 320 }];
  async function visaoEscalonada(enviar, quadros, maxQuadros) {
    var ultimo = null;
    for (var i = 0; i < NIVEIS_VISAO.length; i++) {
      var nivel = NIVEIS_VISAO[i];
      var qs = espalhar(quadros, Math.min(nivel.n, maxQuadros));
      var leves = await Promise.all(qs.map(function (q) { return reduzirQuadro(q, nivel.lado); }));
      try {
        return await enviar(leves);
      } catch (e) {
        ultimo = e;
        if (e.status === 401 || e.status === 403) throw e;
        if (e.status !== 413 && e.status !== 400 && e.status !== 429) throw e;
      }
    }
    throw ultimo;
  }

  async function groqVisao(chave, prompt, quadros, jsonModo) {
    var m = await groqModelos(chave);
    if (!m.visao.length) throw erroHttp("A tua conta Groq não lista nenhum modelo com visão.", 404);
    // Os modelos de visão da Groq aceitam poucas imagens por pedido (3 no Qwen) e têm limite de tokens por minuto.
    return visaoEscalonada(function (imgs) {
      bloqueados = {};
      return chatOpenAI(GROQ, "Groq", chave, m.visao, msgComImagens(prompt, imgs, 3), jsonModo);
    }, quadros, 3);
  }

  var EXT_AUDIO = { "audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "m4a", "audio/webm": "webm", "audio/ogg": "ogg", "audio/flac": "flac" };

  function bytesDeBase64(b64) {
    var bin = atob(b64);
    var u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  /** multipart/form-data montado à mão (funciona no browser e no servidor/jsdom). */
  function multipart(campos, arquivo) {
    var limite = "----cineclip" + Math.random().toString(16).slice(2);
    var enc = new TextEncoder();
    var partes = [];
    Object.keys(campos).forEach(function (k) {
      partes.push(enc.encode("--" + limite + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + campos[k] + "\r\n"));
    });
    partes.push(enc.encode("--" + limite + '\r\nContent-Disposition: form-data; name="file"; filename="' + arquivo.nome + '"\r\nContent-Type: ' + arquivo.tipo + "\r\n\r\n"));
    partes.push(arquivo.bytes);
    partes.push(enc.encode("\r\n--" + limite + "--\r\n"));
    var total = partes.reduce(function (n, p) { return n + p.length; }, 0);
    var corpo = new Uint8Array(total);
    var pos = 0;
    partes.forEach(function (p) { corpo.set(p, pos); pos += p.length; });
    return { corpo: corpo, tipo: "multipart/form-data; boundary=" + limite };
  }

  /** Whisper da Groq: devolve o texto falado no áudio (ou ""). */
  async function groqTranscrever(chave, audio, idioma) {
    if (!audio || !audio.base64) return "";
    if (audio.base64.length > 33000000) return ""; // > ~24 MB: acima do limite grátis
    var tipo = String(audio.mimeType || "audio/wav").split(";")[0].toLowerCase();
    var ext = EXT_AUDIO[tipo] || "wav";
    var bytes = bytesDeBase64(audio.base64);
    var m = await groqModelos(chave);
    var ultimo = null;
    for (var i = 0; i < m.audio.length && i < 2; i++) {
      try {
        var campos = { model: m.audio[i], response_format: "json", temperature: "0" };
        if (idioma) campos.language = idioma;
        var mp = multipart(campos, { nome: "audio." + ext, tipo: tipo, bytes: bytes });
        var r = await ler(await http(GROQ + "/audio/transcriptions", { method: "POST", headers: { Authorization: "Bearer " + chave, "Content-Type": mp.tipo }, body: mp.corpo }, { nome: "Groq", timeout: 90000 }), "Groq");
        var d = await r.json();
        return txt(d && d.text, 1500);
      } catch (e) {
        ultimo = e;
        if (e.status === 401 || e.status === 403) throw e;
      }
    }
    if (ultimo) throw ultimo;
    return "";
  }

  /* ---------------- OpenRouter (modelos :free) ---------------- */
  var OR_TEXTO_FIXOS = ["meta-llama/llama-3.3-70b-instruct:free", "openai/gpt-oss-120b:free", "google/gemma-3-27b-it:free"];
  var OR_VISAO_FIXOS = ["google/gemma-3-27b-it:free", "nvidia/nemotron-3.5-super-vl:free"];
  var OR_PREFERIDOS = [/llama-3\.3-70b/i, /gpt-oss-120b/i, /qwen.*(72|235|122|80|32)b/i, /deepseek/i, /gemma-3-27b/i, /nemotron/i];

  async function orModelos() {
    var c = cacheModelos.or;
    if (c && Date.now() - c.t < 1800000) return c;
    var texto = [], visao = [];
    try {
      var r = await ler(await http(OPENROUTER + "/models", {}, { nome: "OpenRouter", timeout: 25000 }), "OpenRouter");
      var d = await r.json();
      var livresLista = (d.data || []).filter(function (m) { return m && /:free$/.test(m.id || ""); });
      var ids = livresLista.map(function (m) { return m.id; });
      var porVisao = livresLista.filter(function (m) {
        var im = m.architecture && m.architecture.input_modalities;
        return Array.isArray(im) && im.indexOf("image") >= 0;
      }).map(function (m) { return m.id; });
      var porTexto = livresLista.filter(function (m) {
        var im = m.architecture && m.architecture.input_modalities;
        var om = m.architecture && m.architecture.output_modalities;
        return (!Array.isArray(im) || im.indexOf("text") >= 0) && (!Array.isArray(om) || om.indexOf("text") >= 0);
      }).map(function (m) { return m.id; });
      var pref = ordenarPorPreferencia(porTexto, OR_PREFERIDOS);
      texto = pref.concat(porTexto.filter(function (id) { return pref.indexOf(id) < 0; })).slice(0, 6);
      visao = porVisao.slice(0, 5);
      if (!ids.length) { texto = []; visao = []; }
    } catch (e) {}
    var c2 = { t: Date.now(), texto: texto.length ? texto : OR_TEXTO_FIXOS.slice(), visao: visao.length ? visao : OR_VISAO_FIXOS.slice() };
    cacheModelos.or = c2;
    return c2;
  }
  function orHeaders() {
    var h = { "X-Title": "CineClip" };
    try { if (raiz.location && /^https?:/.test(raiz.location.origin || "")) h["HTTP-Referer"] = raiz.location.origin; } catch (e) {}
    return h;
  }
  async function orTexto(chave, prompt, jsonModo) {
    var m = await orModelos();
    return chatOpenAI(OPENROUTER, "OpenRouter", chave, m.texto, [{ role: "user", content: prompt }], jsonModo, orHeaders());
  }
  async function orVisao(chave, prompt, quadros, jsonModo) {
    var m = await orModelos();
    return visaoEscalonada(function (imgs) {
      return chatOpenAI(OPENROUTER, "OpenRouter", chave, m.visao, msgComImagens(prompt, imgs, 4), jsonModo, orHeaders());
    }, quadros, 4);
  }

  /* ---------------- Busca: Serper e DuckDuckGo ---------------- */
  function limparHtml(s) {
    return String(s || "")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ").trim();
  }
  async function serperBuscar(chave, q) {
    var r = await ler(await http("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": chave, "Content-Type": "application/json" },
      body: JSON.stringify({ q: q, gl: "br", hl: "pt-br", num: 6 }),
    }, { nome: "Serper", timeout: 25000, proxy: true }), "Serper");
    var d = await r.json();
    var saida = [];
    if (d.answerBox) saida.push({ titulo: txt(d.answerBox.title, 120), trecho: txt(d.answerBox.snippet || d.answerBox.answer, 300) });
    if (d.knowledgeGraph) saida.push({ titulo: txt(d.knowledgeGraph.title, 120) + (d.knowledgeGraph.type ? " (" + txt(d.knowledgeGraph.type, 40) + ")" : ""), trecho: txt(d.knowledgeGraph.description, 300) });
    (d.organic || []).slice(0, 6).forEach(function (o) {
      saida.push({ titulo: txt(o.title, 140), trecho: txt(o.snippet, 300) });
    });
    return saida.filter(function (x) { return x.titulo || x.trecho; });
  }
  async function ddgBuscar(q) {
    var r = await ler(await http("https://html.duckduckgo.com/html/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "q=" + encodeURIComponent(q) + "&kl=br-pt",
    }, { nome: "DuckDuckGo", timeout: 25000, proxy: true }), "DuckDuckGo");
    var html = await r.text();
    var saida = [];
    var re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
    var m;
    while ((m = re.exec(html)) && saida.length < 6) {
      saida.push({ titulo: txt(limparHtml(m[1]), 140), trecho: txt(limparHtml(m[2]), 300) });
    }
    return saida.filter(function (x) { return x.titulo || x.trecho; });
  }
  /** Serper quando há chave (resultado do Google); senão, ou se falhar, DuckDuckGo. */
  async function buscar(q, serperKey) {
    if (serperKey) {
      try {
        var a = await serperBuscar(serperKey, q);
        if (a.length) return a;
      } catch (e) {
        if (e.status === 401 || e.status === 403) { /* chave errada: cai para o DuckDuckGo */ }
      }
    }
    try { return await ddgBuscar(q); } catch (e) { return []; }
  }

  /* ---------------- Fachada usada pelo motor e pelo bundle ---------------- */
  function chaves(o) {
    o = o || {};
    return { groq: chaveDe("groqKey", o.groqKey), openrouter: chaveDe("openrouterKey", o.openrouterKey), serper: chaveDe("serperKey", o.serperKey) };
  }
  function temAlgumaIA(o) {
    var c = chaves(o);
    return !!(c.groq || c.openrouter);
  }

  /** Quando todos os provedores falham, mostra o motivo de cada um (não só o do último). */
  function juntarErros(erros) {
    if (!erros.length) return null;
    if (erros.length === 1) return erros[0];
    var e = new Error(erros.map(function (x) { return String((x && x.message) || x).replace(/\.$/, ""); }).join(" · ") + ".");
    e.status = erros[erros.length - 1].status;
    return e;
  }

  /** Texto: Groq → OpenRouter. */
  async function textoAlternativo(o, prompt, jsonModo) {
    var c = chaves(o), erros = [];
    if (c.groq) { try { var t1 = await groqTexto(c.groq, prompt, jsonModo); Prov.ultimo = "groq"; return t1; } catch (e) { erros.push(e); } }
    if (c.openrouter) { try { var t2 = await orTexto(c.openrouter, prompt, jsonModo); Prov.ultimo = "openrouter"; return t2; } catch (e) { erros.push(e); } }
    throw juntarErros(erros) || erroHttp("Adiciona uma chave Gemini, Groq ou OpenRouter nas configurações.", 401);
  }
  /** Visão: Groq → OpenRouter. */
  async function visaoAlternativa(o, prompt, quadros, jsonModo) {
    var c = chaves(o), erros = [];
    if (!quadros || !quadros.length) return textoAlternativo(o, prompt, jsonModo);
    if (c.groq) { try { var v1 = await groqVisao(c.groq, prompt, quadros, jsonModo); Prov.ultimo = "groq"; return v1; } catch (e) { erros.push(e); } }
    if (c.openrouter) { try { var v2 = await orVisao(c.openrouter, prompt, quadros, jsonModo); Prov.ultimo = "openrouter"; return v2; } catch (e) { erros.push(e); } }
    throw juntarErros(erros) || erroHttp("Adiciona uma chave Gemini, Groq ou OpenRouter nas configurações.", 401);
  }

  async function testarChave(qual, chave) {
    chave = txt(chave, 300);
    if (!chave) throw new Error("Cola a chave primeiro.");
    if (qual === "groq") {
      if (!/^gsk_/.test(chave)) throw new Error('A chave Groq começa por "gsk_".');
      var m = await groqModelos(chave);
      if (!m.texto.length) throw new Error("A chave funciona, mas a conta não lista modelos.");
    } else if (qual === "openrouter") {
      if (!/^sk-or-/.test(chave)) throw new Error('A chave OpenRouter começa por "sk-or-".');
      await ler(await http(OPENROUTER + "/key", { headers: { Authorization: "Bearer " + chave } }, { nome: "OpenRouter", timeout: 25000 }), "OpenRouter");
    } else if (qual === "serper") {
      var r = await serperBuscar(chave, "cinema");
      if (!r) throw new Error("Sem resposta do Serper.");
    }
    return true;
  }

  var Prov = {
    configurar: function (s) { cfgManual = s && typeof s === "object" ? s : {}; },
    chaves: chaves,
    temAlgumaIA: temAlgumaIA,
    texto: textoAlternativo,
    visao: visaoAlternativa,
    transcrever: function (o, audio, idioma) {
      var c = chaves(o);
      return c.groq ? groqTranscrever(c.groq, audio, idioma) : Promise.resolve("");
    },
    buscar: buscar,
    testar: testarChave,
    _interno: { groqModelos: groqModelos, orModelos: orModelos, ddgBuscar: ddgBuscar, serperBuscar: serperBuscar, multipart: multipart, limpar: function () { cacheModelos = {}; bloqueados = {}; } },
  };

  /* ------------------------------------------- exemplos de ganchos do utilizador */
  function linhasDe(v, max) {
    return String(v == null ? "" : v).split(/\r?\n/).map(function (l) { return txt(l.replace(/^[\s\-•*\d.)]+/, ""), 90); }).filter(Boolean).slice(0, max);
  }
  function exemplosDoUsuario() {
    var s = settingsAtuais();
    return { bons: linhasDe(s.ganchosBons, 12), ruins: linhasDe(s.ganchosRuins, 8) };
  }

  /* ------------------------------------------------ memória de correções (aprender) */
  var CHAVE_MEMORIA = "cineclip.motor.memoria";
  function lerMemoria() {
    try {
      var m = JSON.parse(raiz.localStorage.getItem(CHAVE_MEMORIA) || "[]");
      return Array.isArray(m) ? m : [];
    } catch (e) { return []; }
  }
  function gravarMemoria(m) {
    try { raiz.localStorage.setItem(CHAVE_MEMORIA, JSON.stringify(m.slice(-200))); } catch (e) {}
  }
  /** Chaves que identificam "o mesmo vídeo" entre sessões: nome do ficheiro e primeira fala. */
  function chavesMemoria(fileName, fala) {
    var ks = [];
    var f = norm(String(fileName || "").replace(/\.[a-z0-9]{2,4}$/i, "").replace(/_(cineclip|clean)$/i, ""));
    if (f.length >= 6 && !/^(video|corte|cena|tiktok|kwai|download|snaptik|ssstik)\b/.test(f)) ks.push("f:" + f);
    var l = norm(Array.isArray(fala) ? fala[0] : fala).split(" ").slice(0, 10).join(" ");
    if (l.length >= 18) ks.push("l:" + l);
    return ks;
  }
  function lembrar(fileName, fala) {
    var ks = chavesMemoria(fileName, fala);
    if (!ks.length) return [];
    return lerMemoria().filter(function (e) { return e.k.some(function (k) { return ks.indexOf(k) >= 0; }); });
  }
  /**
   * Chamado quando o utilizador escolhe o filme à mão (ex.: "Não é esse (pesquisar)").
   * Guarda "este vídeo é X (e não Y)": da próxima vez que o mesmo vídeo aparecer, X sobe e Y desce.
   */
  function aprender(info) {
    try {
      info = info || {};
      var certo = info.certo || {};
      var titulo = txt(certo.title || certo.titulo, 140);
      if (!titulo) return false;
      var ia = info.ia || {};
      var ks = chavesMemoria(info.arquivo, ia.fala_do_audio || ia.falas);
      if (!ks.length) return false;
      var errado = info.errado && (info.errado.title || info.errado.titulo) ? { titulo: txt(info.errado.title || info.errado.titulo, 140), ano: ano(info.errado.year || info.errado.ano) } : null;
      if (errado && norm(errado.titulo) === norm(titulo)) errado = null;
      var m = lerMemoria().filter(function (e) { return !e.k.some(function (k) { return ks.indexOf(k) >= 0; }); });
      m.push({
        k: ks,
        certo: { titulo: titulo, original: txt(certo.original || certo.original_title, 140), ano: ano(certo.year || certo.ano), tipo: tipo(certo.kind || certo.tipo || certo.media_type), id: certo.id || null },
        errado: errado,
        t: Date.now(),
      });
      gravarMemoria(m);
      return true;
    } catch (e) { return false; }
  }

  raiz.CineClipMotor = {
    versao: VERSAO,
    identificar: identificar,
    escolher: escolher,
    ganchos: ganchos,
    usaLista: usaLista,
    ganchosDaLista: ganchosDaLista,
    ganchosPadrao: GANCHOS_PRONTOS.slice(),
    legendasDaLista: legendasDaLista,
    legendasPadrao: LEGENDAS_PRONTAS.slice(),
    comentarioDireto: COMENTARIO_DIRETO,
    aprender: aprender,
    configurar: function (s) { Prov.configurar(s); },
    prov: Prov,
    _interno: { json: json, norm: norm, normalizarProvas: normalizarProvas, limparGancho: limparGancho, ganchoValido: ganchoValido, atorBate: atorBate, nomeBate: nomeBate, promptPercecao: promptPercecao, promptPesquisa: promptPesquisa, promptEscrever: promptEscrever, montarConsultas: montarConsultas, lembrar: lembrar, exemplosDoUsuario: exemplosDoUsuario },
  };
})(typeof window !== "undefined" ? window : globalThis);
