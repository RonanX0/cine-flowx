/**
 * Utilitários partilhados sobre o bloco de publicação de Reels do CineClip.
 *
 * O bloco não tem ficheiro próprio: vive dentro do bundle compilado
 * (`index.html`/`app-pronto.html`/`404.html`), entre `INICIO_BLOCO_IG` e
 * `FIM_BLOCO_IG`, e é produzido pelo patch `24-ig-2207077`. Como o patch substitui um
 * troço do bundle base, qualquer nome que existisse nesse troço e passe a ser chamado
 * sem nova declaração rebenta só no browser — foi o caso do `hS` (`ReferenceError:
 * hS is not defined`), que bloqueava todas as publicações.
 *
 * `analisarAutossuficiencia` faz a análise estática que apanha isso: devolve as chamadas
 * a nomes que não são declarados dentro do bloco, builtins da linguagem, nem os helpers
 * que o bundle realmente define fora do bloco (`bg` e `Yo`).
 */

export const INICIO_BLOCO_IG = "async function mS(r){";
export const FIM_BLOCO_IG = "/* ==CINECLIP-IG-FIM== */";

/** Nomes definidos pelo bundle que envolve o bloco (nuvem `bg` e base da Graph API `Yo`). */
export const BUNDLE_FORA_DO_BLOCO = ["bg", "Yo"];

export const BUILTINS_JS = [
  "fetch", "URL", "URLSearchParams", "XMLHttpRequest", "Promise", "Date", "Math", "JSON",
  "Object", "Array", "String", "Number", "Boolean", "Error", "TypeError", "RegExp", "Set",
  "Map", "WeakMap", "encodeURIComponent", "decodeURIComponent", "parseInt", "parseFloat",
  "isNaN", "isFinite", "console", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "AbortController", "Blob", "FormData", "atob", "btoa", "window", "document", "navigator",
  "crypto", "TextDecoder", "TextEncoder", "Uint8Array", "ArrayBuffer", "structuredClone",
  "if", "for", "while", "switch", "catch", "return", "typeof", "new", "function", "await",
  "async", "of", "in", "do", "else", "try", "throw", "delete", "void", "instanceof", "super",
  "this", "class", "extends", "yield", "require", "import",
];

/** Devolve o código do bloco de publicação de Reels, ou `null` se os marcadores não existirem. */
export function extrairBlocoIG(html, inicio = INICIO_BLOCO_IG, fim = FIM_BLOCO_IG) {
  const i0 = html.indexOf(inicio);
  if (i0 < 0) return null;
  const i1 = html.indexOf(fim, i0);
  if (i1 < 0) return null;
  return html.slice(i0, i1 + fim.length);
}

/** Tira comentários e conteúdos de strings (mantendo os buracos `${...}` dos templates). */
export function semComentariosNemStrings(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "*") {
      const e = src.indexOf("*/", i + 2);
      i = e < 0 ? n : e + 2;
      out += " ";
      continue;
    }
    if (c === "/" && d === "/") {
      const e = src.indexOf("\n", i);
      i = e < 0 ? n : e;
      out += " ";
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === c) { j++; break; }
        j++;
      }
      i = j;
      out += '""';
      continue;
    }
    if (c === "`") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "$" && src[j + 1] === "{") {
          let k = j + 2;
          let prof = 1;
          while (k < n && prof > 0) {
            if (src[k] === "{") prof++;
            else if (src[k] === "}") prof--;
            k++;
          }
          out += " " + src.slice(j + 2, k - 1) + " ";
          j = k;
          continue;
        }
        if (src[j] === "`") { j++; break; }
        j++;
      }
      i = j;
      out += " `` ";
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Nomes chamados (`nome(`) no bloco que não são declarados lá dentro, nem builtins da
 * linguagem, nem os dois helpers que o bundle define fora do bloco. Lista vazia = o bloco
 * é autossuficiente.
 */
export function analisarAutossuficiencia(fonte) {
  const codigo = semComentariosNemStrings(fonte);
  const declarados = new Set();
  const juntar = (lista) =>
    lista
      .split(",")
      .map((p) => p.trim().replace(/=.*$/s, "").trim().replace(/^\.\.\./, "").split(/[\s.[]/)[0])
      .filter(Boolean)
      .forEach((p) => declarados.add(p));

  for (const m of codigo.matchAll(/\bfunction\s*([A-Za-z_$][\w$]*)?\s*\(([^)]*)\)/g)) {
    if (m[1]) declarados.add(m[1]);
    juntar(m[2]);
  }
  for (const m of codigo.matchAll(/\b(?:var|let|const)\s+([^;]+)/g)) juntar(m[1]);
  for (const m of codigo.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) declarados.add(m[1]);
  for (const m of codigo.matchAll(/\(([^()]*)\)\s*=>/g)) juntar(m[1]);
  for (const m of codigo.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) declarados.add(m[1]);

  const chamados = new Set();
  for (const m of codigo.matchAll(/(?:^|[^\w$.\s])([A-Za-z_$][\w$]*)\s*\(/g)) chamados.add(m[1]);

  const permitidos = new Set([...BUILTINS_JS, ...BUNDLE_FORA_DO_BLOCO]);
  return [...chamados]
    .filter((nome) => !declarados.has(nome) && !permitidos.has(nome))
    .sort();
}
