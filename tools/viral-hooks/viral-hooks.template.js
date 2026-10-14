/*
 * Gancho viral seguro para o campo de texto do Estúdio.
 * Este ficheiro é a fonte legível do patch 41; o gerador injeta estas funções no bundle.
 */
function ccViralGraphemes(value) {
  try {
    if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
      return Array.from(new Intl.Segmenter("pt", { granularity: "grapheme" }).segment(value), (part) => part.segment);
    }
  } catch {}
  return Array.from(value);
}

function ccNormalizeViralHooks(values) {
  if (!Array.isArray(values)) return [];
  const output = [];
  const seen = new Set();
  const generic = /^(?:voce precisa assistir (?:esse filme|a esse filme)|assista ate o final|voce nao vai acreditar|ninguem estava preparado para o que acontece(?: nessa cena)?)$/i;

  for (const candidate of values) {
    if (typeof candidate !== "string") continue;
    let text = candidate.normalize("NFC")
      .replace(/[\u0000-\u001F\u007F-\u009F\u200B\u200E\u200F\u2028\u2029\uFEFF]+/g, " ")
      .replace(/```(?:json)?/gi, " ")
      .replace(/^\s*(?:[-*•]\s*|\d{1,2}[.)]\s*|(?:gancho|op[cç][ãa]o)\s*\d+\s*[:.)-]?\s*)/i, "")
      .replace(/^\s*["'“”‘’`]+|["'“”‘’`]+\s*$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;

    let graphemes = ccViralGraphemes(text);
    if (graphemes.length > 64) {
      const clipped = graphemes.slice(0, 64).join("");
      const boundary = clipped.lastIndexOf(" ");
      text = (boundary > 16 ? clipped.slice(0, boundary) : clipped).trim();
      graphemes = ccViralGraphemes(text);
    }
    const words = text.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) || [];
    if (graphemes.length < 8 || words.length < 3 || words.length > 14) continue;

    const key = text.normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase("pt-BR")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
    if (!key || generic.test(key) || seen.has(key)) continue;
    seen.add(key);
    output.push(text);
    if (output.length >= 3) break;
  }
  return output;
}

async function Hm(r, o, a = "pt-BR", i, c, u) {
  const f = fg(i);
  const p = a === "pt-PT" ? "Escreve em Português de Portugal." : "Escreva em Português do Brasil.";
  const g = `Analise as imagens e, se fornecido, o áudio desta cena de filme ou série${f ? ` (pista do ficheiro: "${f}")` : ""}.
${p}
1. Descreva fielmente em 1 ou 2 frases o que acontece na cena, sem inventar contexto, no campo "cena".
2. Crie exatamente 3 ganchos virais, cada um com 5 a 9 palavras e no máximo 64 caracteres, em uma única linha, com um emoji expressivo no final.
REGRAS DOS GANCHOS:
- Use um detalhe real das imagens ou do diálogo para criar curiosidade (revelação, tensão, contraste ou reação); não conte algo que a cena não mostra.
- Faça as três opções diferentes entre si, naturais e fáceis de ler no telemóvel.
- Não invente factos, não prometa um desfecho que não aparece e não cite atores.
- Evite chamadas genéricas como "Você precisa assistir esse filme", "assista até o final" ou "você não vai acreditar".
- Não inclua hashtags, aspas, números, rótulos como "Gancho 1" ou texto fora dos campos.
Responda SOMENTE com JSON válido:
{"cena":"descrição fiel da cena","ganchos":["gancho específico da cena 😳","outra opção curta 🔥","terceira opção diferente 😱"]}`;
  let v = "";
  const x = (c && c.trim()) || "";
  const h = (r && r.trim()) || "";
  if (x) {
    try {
      const frames = o.length > 1 ? o.slice(1, 7) : o;
      const parts = [{ text: g }];
      for (const frame of frames) {
        const image = cg(frame);
        if (image) parts.push({ inline_data: image });
      }
      if (u) parts.push({ inline_data: { mime_type: u.mimeType, data: u.base64 } });
      v = await ju(x, parts, false, false);
    } catch (err) {
      if (!h) throw err;
    }
  }
  if (!v && h) {
    try {
      v = await dg(h, g, o, false);
    } catch (err) {
      if (err instanceof ft && (err.status === 401 || err.status === 403)) throw err;
      const fallbackPrompt = `${p}
Analise as imagens desta cena e gere exatamente 3 ganchos virais, naturais e específicos do que se vê ou se ouve. Use 5 a 9 palavras, no máximo 64 caracteres e um emoji no final. Não invente, não use frases genéricas, hashtags, números ou rótulos. Responda somente com JSON válido: {"cena":"descrição fiel da cena","ganchos":["gancho específico 😳","outra opção 🔥","terceira opção 😱"]}${f ? ` Pista do ficheiro: "${f}".` : ""}`;
      v = await ug(h, fallbackPrompt, false);
    }
  }

  let parsed = null;
  try {
    const match = String(v || "").match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : String(v || ""));
  } catch {}
  const plainLines = String(v || "").split(/\r?\n/).filter((line) => line.trim() && !/^\s*[{}]/.test(line));
  const candidates = parsed && Array.isArray(parsed.ganchos) ? parsed.ganchos : plainLines;
  const scene = parsed && typeof parsed.cena === "string"
    ? parsed.cena.replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 240)
    : "";
  return { cena: scene, ganchos: ccNormalizeViralHooks(candidates) };
}
