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

  async function perceber(h, o) {
    var op = o.opcoes || {};
    var gem = txt(op.geminiKey, 200);
    var nv = txt(o.nvidiaKey, 200);
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
        if (!nv) throw e;
      }
    }
    if (nv && quadros.length) {
      var r2 = json(await h.nvidiaVisao(nv, prompt, quadros, true));
      if (r2) return { provas: normalizarProvas(r2), provedor: "nvidia" };
    }
    if (erro) throw erro;
    return { provas: normalizarProvas({}), provedor: gem ? "gemini" : "nvidia" };
  }

  /* ------------------------------------------------------------- 2. pesquisa */

  function promptPesquisa(p, pistas, modo) {
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
      "Você é um pesquisador de cinema e TV. Descubra de que FILME ou SÉRIE é este corte, usando a Pesquisa Google.\n\n" +
      "PROVAS TIRADAS DO VÍDEO:\n" + (linhas.join("\n") || "- (quase nenhuma prova)") + "\n" +
      (ext.length ? "\nPISTAS DE FORA (podem ajudar ou enganar — o nome do ficheiro às vezes é só do perfil ou do app):\n" + ext.join("\n") + "\n" : "") +
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
    var nv = txt(o.nvidiaKey, 200);
    var pn = o.pistaNome;
    var pistas = {
      arquivo: pn && pn.titulo ? pn.titulo + (pn.ano ? " (" + pn.ano + ")" : "") : "",
      arquivoBruto: txt(String(op.fileName || "").replace(/\.[a-z0-9]{2,4}$/i, ""), 120),
      dica: txt(o.dica, 200),
      legenda: txt(op.legendaPost, 400),
      autor: txt(op.autorPost, 60),
    };
    var prompt = promptPesquisa(provas, pistas, o.identMode);
    var r = null;
    if (gem) {
      try {
        r = json(await h.gemini(gem, [{ text: prompt }], true, true));
      } catch (e) {}
    }
    if (!r && nv) {
      try {
        r = json(await h.nvidiaTexto(nv, prompt, true));
      } catch (e) {}
    }
    return normalizarCandidatos(r && r.candidatos, "pesquisa");
  }

  /* --------------------------------------------------------- identificar (Zb) */

  async function identificar(h, o) {
    o = o || {};
    var op = o.opcoes || {};
    var gem = txt(op.geminiKey, 200);
    var nv = txt(o.nvidiaKey, 200);
    var pn = o.pistaNome || null;
    if (!gem && !nv) {
      if (pn && pn.titulo) {
        return montar({ provas: normalizarProvas({}), provedor: "dica" }, [candidatoDoArquivo(pn, 80)], o);
      }
      throw new (h.Erro || Error)("Adiciona a tua chave Google Gemini (recomendada) ou NVIDIA nas configurações.");
    }

    var visto = await perceber(h, o);
    var candidatos = await pesquisar(h, o, visto.provas);

    // Os palpites da perceção e o nome do ficheiro entram como candidatos mais fracos:
    // a conferência no TMDB decide pelas provas, não pela ordem.
    visto.provas.palpites.forEach(function (p) {
      candidatos.push({ titulo: p.titulo, titulo_original: p.titulo_original, ano: p.ano, tipo: p.tipo, confianca: 45, provas: p.motivo ? [p.motivo] : [], conflitos: [], origem: "palpite" });
    });
    if (pn && pn.titulo) candidatos.push(candidatoDoArquivo(pn, 40));
    if (pn && Array.isArray(pn.alternativas)) {
      pn.alternativas.slice(0, 2).forEach(function (a) {
        candidatos.push({ titulo: a.titulo, titulo_original: a.titulo_original || a.titulo, ano: a.ano || 0, tipo: a.tipo || "", confianca: 25, provas: [], conflitos: [], origem: "arquivo" });
      });
    }
    return montar(visto, unicos(candidatos), o);
  }

  function candidatoDoArquivo(pn, conf) {
    return { titulo: pn.titulo, titulo_original: pn.titulo, ano: pn.ano || 0, tipo: pn.tipo === "tv" ? "tv" : "", temporada_episodio: pn.temporada_episodio || "", confianca: conf, provas: ["nome do ficheiro"], conflitos: [], origem: "arquivo" };
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
        ja.idx = Math.min(ja.idx, idx);
        return;
      }
      itens.set(k, { item: item, cands: [cand], idx: idx, exato: exato });
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
            var exato = nt === nq || no === nq;
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
    if (doArquivo && vencedor.exato && !temProvas) conf = Math.max(conf, 85);
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

  function promptEscrever(lang, cena, obra, instModo, evitar) {
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
      "EXEMPLOS DO ESTILO (são de OUTRAS cenas — não copie):\n- " + EXEMPLOS.join("\n- ") + "\n\n" +
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

  async function chamarTexto(h, gem, nv, prompt, jsonModo) {
    if (gem) {
      try {
        return await h.gemini(gem, [{ text: prompt }], false, jsonModo);
      } catch (e) {
        if (!nv) throw e;
      }
    }
    if (nv) return await h.nvidiaTexto(nv, prompt, jsonModo);
    throw new (h.Erro || Error)("Adiciona a tua chave Google Gemini ou NVIDIA nas configurações para gerar o gancho.");
  }

  async function ganchos(h, o) {
    o = o || {};
    var ex = o.extra && typeof o.extra === "object" ? o.extra : {};
    var modo = norm(ex.hookMode || ex.modo || o.modo || "auto").replace(/ /g, "_") || "auto";
    if (modo === "sem_gancho") return { cena: "", ganchos: [], modo: modo };
    var gem = txt(o.geminiKey, 200);
    var nv = txt(o.nvidiaKey, 200);
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
        } else if (nv && quadros.length) {
          r = json(await h.nvidiaVisao(nv, promptCena(o.lang), quadros, true));
        }
        if (r) {
          cena.roteiro = txt(r.roteiro || r.cena, 900) || cena.roteiro;
          cena.momento = cena.momento || txt(r.momento_forte, 200);
          cena.emocao = cena.emocao || txt(r.emocao, 60);
          cena.falas = cena.falas || lista(r.falas, 4).join(" / ");
        }
      } catch (e) {
        if (!cena.roteiro && !obra.sinopse && !nv && !gem) throw e;
      }
    }

    // 2. Escrever 10.
    var instModo = modo !== "auto" && h.instrucaoModo ? txt(h.instrucaoModo(modo), 900).replace(/Crie 3 varia[cç][oõ]es/gi, "Crie variações") : "";
    var evitar = Array.isArray(ex.evitar) ? ex.evitar.slice(-8).map(function (x) { return txt(x, 80); }).filter(Boolean) : [];
    var bruto = await chamarTexto(h, gem, nv, promptEscrever(o.lang, cena, obra, instModo, evitar), false);
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
      if (!k || vistos.has(k) || evitar.some(function (e) { return norm(e) === k; })) return;
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
        var r3 = json(await chamarTexto(h, gem, nv, promptJulgar(cena, candidatos), true));
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

  raiz.CineClipMotor = {
    versao: VERSAO,
    identificar: identificar,
    escolher: escolher,
    ganchos: ganchos,
    _interno: { json: json, norm: norm, normalizarProvas: normalizarProvas, limparGancho: limparGancho, ganchoValido: ganchoValido, atorBate: atorBate, nomeBate: nomeBate, promptPercecao: promptPercecao, promptPesquisa: promptPesquisa, promptEscrever: promptEscrever },
  };
})(typeof window !== "undefined" ? window : globalThis);
