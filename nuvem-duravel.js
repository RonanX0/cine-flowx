/*!
 * ☁️ CINECLIP · NUVEM DURÁVEL (CineCloud)
 * ---------------------------------------------------------------------------
 * Camada de armazenamento que substitui os hosts temporários que faziam os
 * vídeos agendados desaparecerem da "nuvem".
 *
 *   ANTES                                          DEPOIS
 *   -------                                        ------
 *   bytebin.lucko.me  (defunto, expira)     →      Google Drive (Apps Script) e/ou
 *   kappa.lol         (100 MiB, apaga)      →      Cloudflare R2 (o teu bucket)
 *   uguu.se           (apaga em 3 h)        →      ↑ ambos duráveis, sem expiração
 *   litterbox         (12 h no app)         →
 *
 * Ordem dos providers ("cloudProvider" nas Configurações):
 *   auto     → R2 (se configurado) → Drive (se configurado) → hosts antigos
 *   r2       → só Cloudflare R2
 *   drive    → só Google Drive / Apps Script
 *   legacy   → só os hosts antigos (comportamento original)
 *
 * Regras novas que resolvem o "alguns vídeos não ficam na nuvem":
 *   1. O upload do .mp4 é AGUARDADO antes de gravar o cofre (antes o cofre era
 *      gravado sem o link e o upload corria em background sem await).
 *   2. Erros deixam de ser engolidos por catch{} — viram toast + diagnóstico.
 *   3. Retry com backoff (3 tentativas) por provider, e passagem ao seguinte.
 *   4. O File do <input> é copiado para memória antes do upload (evita
 *      NotReadableError quando o ficheiro local já não está acessível).
 *   5. R2: vídeos acima do limite de corpo do Worker usam URL pré-assinada S3.
 *      Drive: vídeos acima de 8 MB são enviados em blocos de 2 MB (resumable),
 *      para o Apps Script nunca ter de guardar o vídeo inteiro em memória.
 *   6. Guarda anti-apagão: se a leitura da nuvem falhou por rede, o app não
 *      sobrescreve o cofre com uma fila vazia.
 *   7. Migração automática: cofres antigos (bytebin/kappa) são copiados para o
 *      provider durável configurado.
 *   8. Claims: antes de publicar, o app reclama o item (`claimPublish`) e liberta-o
 *      no fim (`releaseClaim`). Impede que o app e o Robô 24h publiquem o mesmo
 *      Reel duas vezes. Se o backend ainda não tiver as rotas de claims, a
 *      publicação SEGUE na mesma (degradação segura) — só não fica protegida.
 *
 * Exposição: window.CineCloud
 * Configurado em: Configurações → "☁️ Nuvem durável"
 */
(function () {
  "use strict";

  var VERSION = "1.2.0";
  var SETTINGS_KEY = "cineclip.settings";
  var STATE_KEY = "cineclip.cloud.state";
  var MAX_LOG = 80;

  var KV_BASE = "https://keyvalue.immanuel.co/api/KeyVal";
  var KV_APP = "1729nxi0";
  var TEMP_VIDEO_HOSTS = [
    "kappa.lol", "segs.lol", "uguu.se", "litter.catbox.moe", "litterbox.catbox.moe",
    "filebin.net", "catbox.moe", "bytebin.lucko.me"
  ];
  var DRIVE_HOSTS = ["script.google.com", "googleusercontent.com"];

  var memoryLog = [];
  var lastError = "";

  /* ------------------------------------------------------------ utilidades */

  function now() {
    return Date.now();
  }

  function log(level, message, extra) {
    var entry = { t: new Date().toISOString(), level: level, message: String(message || "") };
    if (extra) entry.extra = extra;
    memoryLog.push(entry);
    if (memoryLog.length > MAX_LOG) memoryLog.shift();
    try {
      var method = level === "error" ? "error" : level === "warn" ? "warn" : "debug";
      // eslint-disable-next-line no-console
      console[method]("[CineCloud] " + entry.message, extra || "");
    } catch (e) {}
  }

  function readSettings() {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") || {};
    } catch (e) {
      return {};
    }
  }

  function loadState() {
    try {
      return JSON.parse(localStorage.getItem(STATE_KEY) || "{}") || {};
    } catch (e) {
      return {};
    }
  }

  function saveState(patch) {
    try {
      var st = loadState();
      Object.keys(patch || {}).forEach(function (k) {
        st[k] = patch[k];
      });
      localStorage.setItem(STATE_KEY, JSON.stringify(st));
    } catch (e) {
      log("warn", "Não foi possível gravar o estado local da nuvem: " + e.message);
    }
  }

  /** Resolve URLs relativas (útil no preview local: "/cloud-api", "/drive-api"). */
  function absolute(base) {
    try {
      return new URL(base, window.location.origin).toString().replace(/\/+$/, "");
    } catch (e) {
      return String(base || "").replace(/\/+$/, "");
    }
  }

  /**
   * Limpa o URL do Apps Script: espaços/zero-width colados da cópia e o "https://"
   * que quase toda a gente se esquece de incluir. Sem isto o URL vira um caminho
   * relativo do próprio site e o pedido morre com "Failed to fetch".
   */
  function normalizeScriptUrl(raw) {
    var u = String(raw || "").trim().replace(/[\u200b-\u200f\ufeff]/g, "");
    if (!u) return "";
    u = u.replace(/\s+/g, "");
    // O utilizador copia muitas vezes o URL de teste (?action=health) ou de uma
    // mensagem de erro anterior. O query string é sempre nosso — corta-se, senão
    // ficava "?action=health&action=health" e ninguém percebia o erro.
    u = u.split("?")[0].split("#")[0];
    // "/drive-api" é um caminho relativo do próprio site (usado no preview local
    // e em proxies) — deixa-se como está para o absolute() resolver contra a origem.
    if (/^\/[^/]/.test(u)) return u;
    if (/^\/\//.test(u)) u = "https:" + u;
    else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = "https://" + u;
    return u;
  }

  function config() {
    var s = readSettings();
    var r2Url = normalizeScriptUrl(s.r2WorkerUrl);
    var driveUrl = normalizeScriptUrl(s.driveScriptUrl);
    return {
      workerUrl: r2Url ? absolute(r2Url) : "",
      token: String(s.r2Token || "").trim(),
      driveUrl: driveUrl ? absolute(driveUrl) : "",
      driveToken: String(s.driveToken || "").trim(),
      driveChunkBytes: Number(s.driveChunkMb || 2) * 1024 * 1024,
      driveSingleMaxBytes: Number(s.driveSingleMaxMb || 8) * 1024 * 1024,
      maxMb: Number(s.r2MaxMb || 0) || 95,
      presign: s.r2Presign !== false,
      mirrorLegacy: s.cloudMirrorLegacy !== false,
      provider: String(s.cloudProvider || "auto").trim().toLowerCase(),
      timeoutMs: Number(s.cloudTimeoutMs || 0) || 300000
    };
  }

  /** Providers configurados, por ordem de prioridade. */
  function chain(cfg) {
    cfg = cfg || config();
    var hasR2 = !!(cfg.workerUrl && cfg.token);
    var hasDrive = !!(cfg.driveUrl && cfg.driveToken);
    var order = [];
    if (cfg.provider === "r2") {
      if (hasR2) order.push("r2");
    } else if (cfg.provider === "drive") {
      if (hasDrive) order.push("drive");
    } else if (cfg.provider === "legacy") {
      // só hosts antigos
    } else {
      if (hasR2) order.push("r2");
      if (hasDrive) order.push("drive");
    }
    order.push("legacy");
    return order;
  }

  function configured() {
    return chain().some(function (p) {
      return p !== "legacy";
    });
  }

  function activeProviders() {
    return chain();
  }

  function fmtSize(bytes) {
    if (!bytes && bytes !== 0) return "—";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1048576).toFixed(1) + " MB";
  }

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  /**
   * Classifica um URL de vídeo:
   *   "r2"    → Cloudflare R2 (durável)
   *   "drive" → Google Drive/Apps Script (durável)
   *   "temp"  → host que expira (kappa/uguu/litterbox/…)
   *   "local" → este próprio domínio (ex.: dev server)
   *   "none"  → não há URL
   */
  /** O URL pertence ao mesmo alvo configurado (host + prefixo de path)? */
  function sameTarget(url, base) {
    if (!base) return false;
    try {
      var u = new URL(url);
      var b = new URL(base);
      if (u.hostname !== b.hostname) return false;
      var bp = String(b.pathname || "/").replace(/\/+$/, "");
      if (bp && bp !== "/" && String(u.pathname || "/").indexOf(bp) !== 0) return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  function classifyUrl(url) {
    if (!url || !/^https?:/i.test(url)) return "none";
    var cfg = config();
    var host;
    try {
      host = new URL(url).hostname;
    } catch (e) {
      return "unknown";
    }
    // 1) alvo explícito configurado (funciona mesmo com os dois na mesma origem,
    //    como no preview local: /cloud-api vs /drive-api)
    if (sameTarget(url, cfg.driveUrl)) return "drive";
    if (sameTarget(url, cfg.workerUrl)) return "r2";
    // 2) heurísticas por hostname
    if (/workers\.dev$/i.test(host) || /r2\.cloudflarestorage\.com$/i.test(host) || /r2\.dev$/i.test(host)) return "r2";
    for (var d = 0; d < DRIVE_HOSTS.length; d++) {
      if (host === DRIVE_HOSTS[d] || host.slice(-DRIVE_HOSTS[d].length - 1) === "." + DRIVE_HOSTS[d]) return "drive";
    }
    for (var i = 0; i < TEMP_VIDEO_HOSTS.length; i++) {
      var t = TEMP_VIDEO_HOSTS[i];
      if (host === t || host.slice(-t.length - 1) === "." + t) return "temp";
    }
    if (host === window.location.hostname) return "local";
    return "unknown";
  }

  /** O URL aponta para armazenamento durável? */
  function isDurable(url) {
    var kind = classifyUrl(url);
    return kind === "r2" || kind === "drive";
  }

  /* --------------------------------------------------------------- toasts */

  var lastToast = {};

  function getToast() {
    return window.CineClipToast || window.je || null;
  }

  /** Toast no máximo 1x por `windowMs` para a mesma chave (evita spam do sync de 20 s). */
  function toastOnce(key, message, kind, windowMs) {
    var toast = getToast();
    if (toast) {
      try {
        var win = windowMs || 5 * 60 * 1000;
        if (lastToast[key] && now() - lastToast[key] < win) return false;
        lastToast[key] = now();
        var fn = kind && typeof toast[kind] === "function" ? toast[kind] : toast;
        fn(message);
        return true;
      } catch (e) {}
    }
    log(kind === "success" ? "info" : "warn", message);
    return false;
  }

  function toast(key, message, kind, toastId) {
    var t = getToast();
    if (t) {
      try {
        var fn = kind && typeof t[kind] === "function" ? t[kind] : t;
        fn(message, toastId ? { id: toastId } : undefined);
        return true;
      } catch (e) {}
    }
    log("info", message);
    return false;
  }

  function dismissToast(toastId) {
    var t = getToast();
    try {
      if (t && typeof t.dismiss === "function") t.dismiss(toastId);
    } catch (e) {}
  }

  /* ------------------------------------------------------------- HTTP base */

  function authHeaders(cfg, extra) {
    var h = { Authorization: "Bearer " + cfg.token };
    Object.keys(extra || {}).forEach(function (k) {
      h[k] = extra[k];
    });
    return h;
  }

  function describeFailure(status, data) {
    var msg = (data && (data.error || data.message)) || "";
    if (status === 401 || status === 403) return msg || "Token inválido ou em falta (401/403). Verifica em Configurações → Nuvem durável.";
    if (status === 404) return msg || "Recurso não encontrado (404). Confirma o URL.";
    if (status === 413) return msg || "Ficheiro demasiado grande para um só pedido (413).";
    if (status === 501) return msg || "Funcionalidade não configurada no backend (501).";
    if (status >= 500) return msg || "Erro no backend (HTTP " + status + ").";
    return msg || "HTTP " + status;
  }

  /** Apps Script devolve sempre HTTP 200 e reporta erros no corpo → validar o `ok`. */
  function driveFailure(data) {
    if (data && data.ok === false) return data.error || "Erro devolvido pelo Apps Script.";
    return null;
  }

  /**
   * Opções de fetch para o Apps Script:
   *   • redirect:"follow" — o /exec responde 302 para script.googleusercontent.com
   *     e é aí que vem o conteúdo (sem follow não se lê nada);
   *   • credentials:"omit" — um pedido anónimo não choca com Access-Control-Allow-Origin:*;
   *   • Content-Type text/plain (definido por quem chama) evita o preflight OPTIONS,
   *     que o Apps Script não responde e o browser reporta como "Failed to fetch".
   */
  function driveFetchOpts(options) {
    var o = options || {};
    o.redirect = "follow";
    o.cache = o.cache || "no-store";
    o.credentials = "omit";
    return o;
  }

  /** O app está dentro de um iframe? (aí o Google bloqueia cookies de terceiros) */
  function inIframe() {
    try {
      return window.self !== window.top;
    } catch (e) {
      return true;
    }
  }

  /**
   * Quando o fetch falha, um pedido no-cors distingue as causas reais:
   *   "blocked"     → o servidor respondeu, foi o browser que bloqueou a leitura
   *   "unreachable" → nem em no-cors chega lá (URL errado, sem deploy, sem rede)
   *   "reachable"   → chega e lê (falha intermitente)
   */
  async function probeBlocked(url) {
    try {
      var r = await fetch(url, driveFetchOpts({ mode: "no-cors" }));
      if (r && (r.type === "opaque" || r.status === 0)) return "blocked";
      return "reachable";
    } catch (e) {
      return "unreachable";
    }
  }

  /** Há DOM? (sem document não há JSONP — ex.: testes em Node) */
  function canJsonp() {
    try {
      return typeof document !== "undefined" && !!document && !!document.createElement && !!(document.head || document.documentElement);
    } catch (e) {
      return false;
    }
  }

  var jsonpSeq = 0;

  /**
   * MODO COMPATÍVEL (JSONP).
   * O Google não permite que um Web App do Apps Script defina cabeçalhos CORS,
   * por isso um fetch() a partir de outro domínio (Netlify, Vercel, localhost…)
   * é bloqueado pelo browser na hora de LER a resposta — aparece só
   * "Failed to fetch", mesmo com tudo bem configurado.
   *
   * Uma etiqueta <script src="…&callback=…"> não está sujeita a CORS: o backend
   * devolve JavaScript que chama a nossa função com o JSON como argumento.
   * Serve para TODAS as leituras (health, cofre, videohead, stats, complete).
   */
  function driveJsonp(cfg, params, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (!canJsonp()) {
        reject(new Error("Este ambiente não tem DOM — o modo compatível (JSONP) não está disponível."));
        return;
      }
      jsonpSeq++;
      var name = "__cineCloudCb" + jsonpSeq + "_" + Math.random().toString(36).slice(2, 8);
      var all = {};
      Object.keys(params || {}).forEach(function (k) {
        all[k] = params[k];
      });
      all.callback = "window." + name;

      var script = document.createElement("script");
      var finished = false;
      var timer = setTimeout(function () {
        finish(new Error("O Apps Script não respondeu a tempo (" + Math.round((timeoutMs || 45000) / 1000) + " s, modo compatível)."));
      }, timeoutMs || 45000);

      function cleanup() {
        clearTimeout(timer);
        try {
          delete window[name];
        } catch (e) {
          window[name] = undefined;
        }
        try {
          if (script && script.parentNode) script.parentNode.removeChild(script);
        } catch (e) {}
      }
      function finish(err, data) {
        if (finished) return;
        finished = true;
        cleanup();
        if (err) reject(err);
        else resolve(data);
      }

      window[name] = function (data) {
        finish(null, data);
      };
      script.src = q(cfg.driveUrl, all);
      script.async = true;
      script.onerror = function () {
        finish(new Error("Não consegui carregar a resposta do Apps Script (modo compatível). Confirma o URL e que a implantação é 'Qualquer pessoa'."));
      };
      script.onload = function () {
        // se o script carregou mas a callback não foi chamada, a resposta não era a nossa
        setTimeout(function () {
          finish(new Error("O Apps Script respondeu mas não devolveu dados (modo compatível) — confirma que colaste o ficheiro apps-script/cineclip-cloud-drive.js atualizado e criaste uma NOVA VERSÃO da implantação."));
        }, 0);
      };
      (document.head || document.documentElement).appendChild(script);
    });
  }

  /**
   * POST que o browser não deixa ler (mode:"no-cors"): o pedido CHEGA e é
   * processado pelo Apps Script, mas a resposta vem opaca. Usa-se só quando o
   * modo normal está bloqueado, e confirma-se o resultado com uma leitura JSONP.
   */
  async function postOpaque(url, bodyText) {
    await fetch(url, driveFetchOpts({
      mode: "no-cors",
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: bodyText
    }));
    return true;
  }

  /**
   * Leitura do backend Drive: tenta o fetch normal e, se o browser bloquear,
   * repete por JSONP. forceJsonp salta o fetch quando já sabemos que está bloqueado.
   */
  async function driveReadJson(cfg, params, forceJsonp) {
    if (!forceJsonp) {
      try {
        return await fetchJson(q(cfg.driveUrl, params), driveFetchOpts());
      } catch (e) {
        if (!canJsonp()) throw e;
        log("warn", "Leitura bloqueada pelo browser (CORS) — a usar o modo compatível (JSONP).");
      }
    } else if (!canJsonp()) {
      return await fetchJson(q(cfg.driveUrl, params), driveFetchOpts());
    }
    var data = await driveJsonp(cfg, params);
    return { status: 200, ok: true, data: data, text: JSON.stringify(data), jsonp: true };
  }

  function q(base, params) {
    var clean = String(base || "");
    var existing = clean.indexOf("?") >= 0 ? clean.slice(clean.indexOf("?") + 1).split("&") : [];
    var keep = clean.split("?")[0];
    var parts = [];
    Object.keys(params).forEach(function (k) {
      if (params[k] === undefined || params[k] === null || params[k] === "") return;
      // se o parâmetro já vinha no URL colado, o nosso valor ganha (não duplica)
      existing = existing.filter(function (kv) {
        return kv.split("=")[0] !== k;
      });
      parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(params[k]));
    });
    var all = existing.concat(parts).filter(function (kv) {
      return kv !== "";
    });
    return keep + (all.length ? "?" + all.join("&") : "");
  }

  async function fetchJson(url, options) {
    var res = await fetch(url, options);
    var text = await res.text();
    var data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      data = { ok: false, error: "Resposta não-JSON do backend: " + text.slice(0, 160) };
    }
    return { status: res.status, ok: res.ok, data: data, text: text };
  }

  /** XHR para ter progresso de upload real (fetch não expõe upload progress). */
  function xhrUpload(url, opts) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open(opts.method || "POST", url, true);
      xhr.timeout = opts.timeoutMs || 300000;
      Object.keys(opts.headers || {}).forEach(function (k) {
        xhr.setRequestHeader(k, opts.headers[k]);
      });
      xhr.upload.onprogress = function (ev) {
        if (opts.onProgress && ev.lengthComputable) {
          opts.onProgress(Math.round((ev.loaded / ev.total) * 100), ev.loaded, ev.total);
        }
      };
      xhr.onload = function () {
        resolve({ status: xhr.status, text: xhr.responseText || "" });
      };
      xhr.onerror = function () {
        reject(new Error("Falha de rede ao enviar para " + url + " (sem resposta do servidor)."));
      };
      xhr.ontimeout = function () {
        reject(new Error("Tempo esgotado ao enviar (" + Math.round((opts.timeoutMs || 0) / 1000) + " s). Verifica a ligação ou reduz o tamanho do clipe."));
      };
      xhr.onabort = function () {
        reject(new Error("Envio cancelado."));
      };
      xhr.send(opts.body);
    });
  }

  function bufferToBase64(buffer) {
    var bytes = new Uint8Array(buffer);
    var CHUNK = 0x8000;
    var out = "";
    for (var i = 0; i < bytes.length; i += CHUNK) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(out);
  }

  /* --------------------------------------------------------- upload vídeo */

  /**
   * Copia o conteúdo para memória. Um `File` de <input type=file> pode deixar de
   * ser legível mais tarde (ficheiro movido, limpeza de dados do navegador,
   * iOS/Android a libertar a referência) e lançava NotReadableError em silêncio.
   */
  async function readIntoMemory(blobOrFile, fileName) {
    try {
      var buf = await blobOrFile.arrayBuffer();
      return { buffer: buf, size: buf.byteLength };
    } catch (e) {
      var err = new Error(
        'Não consegui ler o ficheiro "' + (fileName || "vídeo") + '" neste aparelho (' +
        (e && e.name ? e.name : "erro") + "). O ficheiro original foi movido/apagado ou o navegador limpou os dados do site. " +
        "Reimporta o .mp4 neste agendamento para o voltares a ter na nuvem."
      );
      err.code = "unreadable_source";
      throw err;
    }
  }

  /* --- Cloudflare R2 --- */

  async function uploadToWorker(cfg, buffer, fileName, onProgress) {
    var url = cfg.workerUrl + "/api/video";
    var res = await xhrUpload(url, {
      method: "POST",
      headers: authHeaders(cfg, {
        "Content-Type": "video/mp4",
        "X-File-Name": fileName,
        "X-File-Size": String(buffer.byteLength),
        "X-Cineclip-Client": "web/" + VERSION
      }),
      body: buffer,
      timeoutMs: cfg.timeoutMs,
      onProgress: onProgress
    });

    var data = null;
    try {
      data = JSON.parse(res.text || "null");
    } catch (e) {}

    if (res.status === 413 && cfg.presign) {
      log("warn", "Vídeo acima do limite do Worker — a tentar URL pré-assinada S3.");
      return uploadPresigned(cfg, buffer, fileName, onProgress);
    }
    if (res.status < 200 || res.status >= 300) {
      var err = new Error(describeFailure(res.status, data));
      err.status = res.status;
      err.retryable = res.status === 429 || res.status >= 500 || res.status === 408;
      throw err;
    }
    if (!data || !data.ok || !data.url) throw new Error("O Worker respondeu sem um link público para o vídeo.");
    return { url: data.url, key: data.key, provider: data.provider || "cloudflare-r2", size: data.size || buffer.byteLength };
  }

  async function uploadPresigned(cfg, buffer, fileName, onProgress) {
    var sign = await fetchJson(cfg.workerUrl + "/api/video/presign", {
      method: "POST",
      headers: authHeaders(cfg, { "Content-Type": "application/json" }),
      body: JSON.stringify({ fileName: fileName, size: buffer.byteLength, expires: 3600 })
    });
    if (!sign.ok || !sign.data || !sign.data.ok || !sign.data.uploadUrl) {
      var err = new Error(
        "Vídeo demasiado grande para envio direto e o presign não está disponível no Worker: " +
          describeFailure(sign.status, sign.data)
      );
      err.code = "presign_unavailable";
      throw err;
    }

    var put = await xhrUpload(sign.data.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "video/mp4" },
      body: buffer,
      timeoutMs: cfg.timeoutMs,
      onProgress: onProgress
    });
    if (put.status < 200 || put.status >= 300) {
      var e2 = new Error("O R2 recusou o envio pré-assinado (HTTP " + put.status + ").");
      e2.retryable = put.status >= 500;
      throw e2;
    }
    return { url: sign.data.url, key: sign.data.key, provider: "cloudflare-r2-presigned", size: buffer.byteLength };
  }

  /* --- Google Drive (Apps Script) --- */

  var driveInfoCache = { url: "", at: 0, chunkBytes: 0, singleMaxBytes: 0, maxVideoBytes: 0, readable: true };

  /**
   * Lê as capacidades anunciadas pelo backend (?action=health) — tamanho do
   * bloco, limite de envio único e limite de vídeo. Assim o cliente não assume
   * valores: se mudares as constantes no Apps Script, o app adapta-se.
   */
  async function driveInfo(cfg) {
    if (driveInfoCache.url === cfg.driveUrl && now() - driveInfoCache.at < 10 * 60 * 1000) return driveInfoCache;
    var fallback = {
      url: cfg.driveUrl,
      at: now() - 9 * 60 * 1000,
      chunkBytes: cfg.driveChunkBytes > 0 ? cfg.driveChunkBytes : 2 * 1024 * 1024,
      singleMaxBytes: cfg.driveSingleMaxBytes > 0 ? cfg.driveSingleMaxBytes : 8 * 1024 * 1024,
      maxVideoBytes: 0
    };
    var d = null;
    var readable = false;
    try {
      var res = await fetchJson(q(cfg.driveUrl, { action: "health" }), driveFetchOpts());
      d = res.data || null;
      readable = true;
    } catch (e) {
      if (canJsonp()) {
        try {
          d = await driveJsonp(cfg, { action: "health" });
          log("warn", "O browser bloqueia a leitura direta do Apps Script (CORS) — a usar o modo compatível (JSONP).");
        } catch (e2) {
          log("warn", "Não consegui ler o Apps Script (" + e.message + " · JSONP: " + e2.message + ").");
        }
      } else {
        log("warn", "Não consegui ler as capacidades do Apps Script (" + e.message + ") — a usar os valores das Configurações.");
      }
    }
    if (!d || d.ok !== true) {
      fallback.readable = readable;
      return fallback;
    }
    driveInfoCache = {
      url: cfg.driveUrl,
      at: now(),
      chunkBytes: Number(d.chunkBytes) || fallback.chunkBytes,
      singleMaxBytes: Number(d.singleMaxBytes) || fallback.singleMaxBytes,
      maxVideoBytes: Number(d.maxVideoBytes) || 0,
      readable: readable
    };
    return driveInfoCache;
  }

  /**
   * Confirma um envio feito "às cegas" (modo compatível): pergunta ao backend se
   * o ficheiro ficou completo e devolve o link público.
   */
  async function confirmUpload(cfg, uploadId, total) {
    var res = await driveReadJson(cfg, { action: "complete", token: cfg.driveToken, id: uploadId }, true);
    var d = res.data;
    var f = driveFailure(d);
    if (f || !d || !d.url) {
      var err = new Error("Drive (modo compatível): o envio terminou mas o ficheiro não ficou completo (" + (f || "sem url") + ").");
      err.retryable = true;
      throw err;
    }
    saveState({ driveMode: "compatível (JSONP)" });
    return { url: d.url, key: d.fileId, provider: "google-drive", size: d.size || total, mode: "jsonp" };
  }

  async function uploadToDrive(cfg, buffer, fileName, onProgress) {
    var total = buffer.byteLength;
    var uploadId = "up_" + now().toString(36) + "_" + Math.random().toString(36).slice(2, 9);
    var info = await driveInfo(cfg);
    // o upload resumable do Drive exige blocos múltiplos de 256 KB
    var chunkSize = Math.max(262144, Math.floor((info.chunkBytes || 2 * 1024 * 1024) / 262144) * 262144);
    var singleMax = info.singleMaxBytes > 0 ? info.singleMaxBytes : 8 * 1024 * 1024;
    var base = cfg.driveUrl;

    if (info.maxVideoBytes && total > info.maxVideoBytes) {
      var errBig = new Error(
        "O vídeo tem " + fmtSize(total) + " e o backend do Drive aceita no máximo " + fmtSize(info.maxVideoBytes) +
        ". Corta o clipe ou aumenta MAX_VIDEO_MB no Apps Script (o Drive guarda até 15 GB na conta grátis)."
      );
      errBig.code = "too_large";
      throw errBig;
    }

    function chunkUrl(index) {
      return q(base, {
        action: "upload",
        token: cfg.driveToken,
        id: uploadId,
        index: index,
        total: total,
        name: fileName
      });
    }

    // Se o browser não deixa ler as respostas do Apps Script, envia-se "às cegas"
    // (o pedido chega na mesma) e confirma-se tudo no fim por JSONP.
    var opaque = info.readable === false && canJsonp();

    async function sendChunk(index, slice) {
      var b64 = bufferToBase64(slice);
      if (opaque) {
        await postOpaque(chunkUrl(index), b64);
        return {};
      }
      var res = await fetch(chunkUrl(index), driveFetchOpts({
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: b64
      }));
      var data = null;
      try {
        data = await res.json();
      } catch (e) {
        throw new Error("O Apps Script devolveu uma resposta inválida (HTTP " + res.status + "). Confirma que o deploy é 'App da Web' com acesso 'Qualquer pessoa'.");
      }
      var f = driveFailure(data);
      if (f) {
        var err = new Error("Drive: " + f);
        err.retryable = !/token|inválid|invalid|limite|excede/i.test(f);
        throw err;
      }
      return data || {};
    }

    // Vídeo pequeno: um único pedido (caminho mais simples e rápido)
    if (total <= singleMax) {
      var one = await sendChunk(0, buffer);
      if (onProgress) onProgress(100, total, total);
      if (opaque) return await confirmUpload(cfg, uploadId, total);
      if (!one.url) throw new Error("Drive: o Apps Script não devolveu o link do vídeo.");
      return { url: one.url, key: one.fileId, provider: "google-drive", size: one.size || total };
    }

    // Vídeo grande: blocos de 2 MB → o Drive monta o ficheiro (resumable upload)
    var sent = 0;
    var index = 0;
    for (var offset = 0; offset < total; offset += chunkSize, index++) {
      var slice = buffer.slice(offset, Math.min(offset + chunkSize, total));
      var out = await sendChunk(index, slice);
      sent += slice.byteLength;
      if (onProgress) onProgress(Math.round((sent / total) * 100), sent, total);
      if (out.done && out.url) {
        return { url: out.url, key: out.fileId, provider: "google-drive", size: out.size || total };
      }
    }

    // Modo compatível: nenhum bloco pôde ser lido → confirma-se agora
    if (opaque) return await confirmUpload(cfg, uploadId, total);

    // Nenhum bloco confirmou o fim → pergunta ao backend
    var done = await fetchJson(q(base, { action: "complete", token: cfg.driveToken, id: uploadId }), driveFetchOpts());
    var dd = driveFailure(done.data);
    if (dd || !done.data || !done.data.url) {
      throw new Error("Drive: o upload terminou mas o ficheiro não ficou completo (" + (dd || "sem url") + ").");
    }
    return { url: done.data.url, key: done.data.fileId, provider: "google-drive", size: total };
  }

  /* ------------------------------------------- upload legado (compatibilidade) */

  async function legacyUploadVideo(blobOrFile, fileName) {
    var name = String(fileName || "reel_cineclip.mp4").replace(/[^a-zA-Z0-9._-]/g, "_");
    if (!/\.mp4$/i.test(name)) name += ".mp4";
    var errors = [];

    try {
      var form = new FormData();
      form.append("file", new Blob([blobOrFile], { type: "video/mp4" }), name);
      var res = await fetch("https://kappa.lol/api/upload", { method: "POST", body: form });
      if (res.ok) {
        var j = await res.json();
        if (j && j.link) {
          var ext = j.ext || ".mp4";
          var link = String(j.link).endsWith(ext) ? String(j.link) : String(j.link) + ext;
          log("warn", "Vídeo enviado para host TEMPORÁRIO (kappa.lol) — pode ser apagado em horas/dias.");
          return link;
        }
      }
      errors.push("kappa.lol HTTP " + res.status);
    } catch (e) {
      errors.push("kappa.lol: " + e.message);
    }

    try {
      var res2 = await fetch("/api/public/upload-temp", {
        method: "POST",
        headers: { "Content-Type": "video/mp4", "X-File-Name": name },
        body: blobOrFile
      });
      if (res2.ok) {
        var j2 = await res2.json();
        if (j2 && j2.url && /^http/i.test(String(j2.url))) {
          log("warn", "Vídeo enviado para host TEMPORÁRIO (/api/public/upload-temp).");
          return String(j2.url);
        }
      }
      errors.push("/api/public/upload-temp HTTP " + res2.status);
    } catch (e) {
      errors.push("/api/public/upload-temp: " + e.message);
    }

    var err = new Error(
      "Nenhum armazenamento aceitou o vídeo (" + fmtSize(blobOrFile && blobOrFile.size) + "). " + errors.join(" | ")
    );
    err.code = "no_provider";
    throw err;
  }

  /* ------------------------------------------------------- API de upload */

  /**
   * Envia o vídeo para armazenamento durável e devolve o link público.
   * @param {Blob|File} blobOrFile
   * @param {string} fileName
   * @param {{onProgress?:Function, allowTemp?:boolean}} [opts]
   * @returns {Promise<string>} URL pública do .mp4
   */
  async function uploadVideo(blobOrFile, fileName, opts) {
    opts = opts || {};
    var cfg = config();
    var name = String(fileName || "reel_cineclip.mp4").replace(/[^a-zA-Z0-9._-]/g, "_");
    if (!/\.mp4$/i.test(name)) name += ".mp4";

    if (!blobOrFile) {
      var err0 = new Error("Este agendamento não tem vídeo associado neste aparelho.");
      err0.code = "no_blob";
      throw err0;
    }

    var providers = chain(cfg);
    var durable = providers.filter(function (p) {
      return p !== "legacy";
    });

    if (!durable.length) {
      if (opts.allowTemp === false) {
        var errNoProv = new Error(
          "Nenhum armazenamento durável configurado (Google Drive ou Cloudflare R2). " +
          "Abre Configurações → Nuvem durável e cola o URL + token."
        );
        errNoProv.code = "no_durable_provider";
        throw errNoProv;
      }
      log("warn", "Nenhum armazenamento durável configurado — a usar hosts temporários.");
      toastOnce(
        "no-provider",
        "⚠️ Nuvem durável não configurada: os vídeos vão para hosts temporários que apagam os ficheiros em 3–72 h. Configura o Google Drive (grátis) ou o Cloudflare R2 em Configurações → Nuvem durável.",
        "warning",
        10 * 60 * 1000
      );
      return await legacyUploadVideo(blobOrFile, name);
    }

    var mem = await readIntoMemory(blobOrFile, name);
    var size = mem.size;
    var failures = [];

    for (var i = 0; i < providers.length; i++) {
      var provider = providers[i];
      if (provider === "legacy") continue;

      if (provider === "r2" && size > cfg.maxMb * 1024 * 1024 && !cfg.presign) {
        failures.push("R2: vídeo com " + fmtSize(size) + " excede " + cfg.maxMb + " MB sem presign");
        continue;
      }

      log("info", "A enviar " + name + " (" + fmtSize(size) + ") para " + (provider === "r2" ? "Cloudflare R2" : "Google Drive") + "…");

      var attempt = 0;
      var lastErr = null;
      while (attempt < 3) {
        attempt++;
        try {
          var out = provider === "r2"
            ? await uploadToWorker(cfg, mem.buffer, name, opts.onProgress)
            : await uploadToDrive(cfg, mem.buffer, name, opts.onProgress);
          await verifyPublicUrl(out.url);
          log("info", "Vídeo na nuvem durável: " + out.url + " (" + out.provider + ")");
          saveState({ lastProvider: provider });
          return out.url;
        } catch (e) {
          lastErr = e;
          lastError = e && e.message ? e.message : String(e);
          // erros que não se resolvem repetindo: falha já, sem gastar 3 tentativas
          if (e && (e.code === "unreadable_source" || e.code === "presign_unavailable" || e.code === "too_large")) throw e;
          var retryable = !e.status || e.retryable || e.status === 429 || e.status >= 500;
          log("warn", provider + " tentativa " + attempt + "/3 falhou: " + lastError);
          if (!retryable || attempt === 3) break;
          await sleep(800 * Math.pow(3, attempt - 1));
        }
      }
      failures.push((provider === "r2" ? "R2" : "Drive") + ": " + (lastErr && lastErr.message ? lastErr.message : lastErr));
    }

    if (opts.allowTemp === false) {
      var errAll = new Error("Não foi possível colocar o vídeo na nuvem durável. " + failures.join(" | "));
      errAll.code = "durable_providers_failed";
      throw errAll;
    }

    // Último recurso: host temporário (mantém o fluxo antigo a funcionar)
    try {
      log("warn", "Providers duráveis falharam (" + failures.join(" | ") + ") — a tentar host temporário.");
      var temp = await legacyUploadVideo(blobOrFile, name);
      toastOnce(
        "durable-fallback",
        "⚠️ O armazenamento durável falhou (" + failures[0] + "). O vídeo foi para um host TEMPORÁRIO e pode expirar antes do horário agendado.",
        "warning",
        10 * 60 * 1000
      );
      return temp;
    } catch (e2) {
      var finalErr = new Error(
        "Não foi possível colocar o vídeo na nuvem. " + failures.join(" | ") + " · Temporário: " + (e2 && e2.message ? e2.message : e2)
      );
      finalErr.code = "all_providers_failed";
      throw finalErr;
    }
  }

  /**
   * Confirma que o link público responde.
   * No Drive usa-se o endpoint leve `videohead` (o Apps Script não suporta Range
   * e um GET descarregaria o vídeo inteiro).
   */
  async function verifyPublicUrl(url) {
    var cfg = config();
    try {
      if (classifyUrl(url) === "drive") {
        // videohead: resposta pequena, sem descarregar o vídeo (o Apps Script não tem Range)
        var idMatch = /[?&]id=([^&]+)/.exec(String(url));
        var videoId = idMatch ? decodeURIComponent(idMatch[1]) : "";
        var info = await driveInfo(cfg);
        var hres = videoId
          ? await driveReadJson(cfg, { action: "videohead", id: videoId, token: cfg.driveToken }, info.readable === false)
          : await fetchJson(String(url).replace(/action=video(&|$)/, "action=videohead$1"), driveFetchOpts());
        var hf = driveFailure(hres.data);
        if (hf) {
          log("warn", "Link do Drive não confirmado: " + hf);
          toastOnce("drive-verify", "⚠️ O vídeo foi para o Drive mas não consegui confirmar o link: " + hf, "warning");
          return false;
        }
        return true;
      }
      var res = await fetch(url, { method: "GET", headers: { Range: "bytes=0-0" }, cache: "no-store" });
      if (res.status >= 400) {
        log("warn", "Link público respondeu HTTP " + res.status + ": " + url);
        toastOnce("public-" + res.status, "⚠️ O vídeo foi guardado mas o link público respondeu HTTP " + res.status + ".", "warning");
        return false;
      }
      try {
        res.body && res.body.cancel && res.body.cancel();
      } catch (e) {}
      return true;
    } catch (e) {
      log("warn", "Não consegui validar o link público (" + e.message + ").");
      return false;
    }
  }

  /* ------------------------------------------------------------- cofre */

  async function legacyReadVaultCipher(vaultHash) {
    var res = await fetch(KV_BASE + "/GetValue/" + KV_APP + "/cc_" + vaultHash + "?t=" + now(), { cache: "no-store" });
    if (!res.ok) {
      var err = new Error("Índice de sincronização respondeu HTTP " + res.status);
      err.status = res.status;
      err.retryable = res.status >= 500;
      throw err;
    }
    var pointer = (await res.text()).replace(/^"|"$/g, "").trim();
    if (!pointer) return { data: null, source: null, missing: true };
    var parts = pointer.split("__");
    var errors = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      var url = "";
      if (p.indexOf("b_") === 0) url = "https://bytebin.lucko.me/" + p.slice(2) + "?t=" + now();
      else if (p.indexOf("k_") === 0) url = "https://kappa.lol/" + p.slice(2) + ".json?t=" + now();
      if (!url) continue;
      try {
        var r = await fetch(url, { cache: "no-store" });
        if (r.ok) {
          var text = await r.text();
          if (text && text.length > 2) {
            return { data: text, source: p.indexOf("b_") === 0 ? "legacy-bytebin" : "legacy-kappa", pointer: pointer };
          }
        } else errors.push(url + " → HTTP " + r.status);
      } catch (e) {
        errors.push(url + " → " + e.message);
      }
    }
    var errAll = new Error("O cofre antigo não pôde ser lido: " + (errors.join(" | ") || "apontador vazio"));
    errAll.expired = true;
    throw errAll;
  }

  async function legacyWriteVaultMirror(vaultHash, cipher) {
    var ids = [];
    try {
      var res = await fetch("https://bytebin.lucko.me/post", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: cipher,
        cache: "no-store"
      });
      if (res.ok) {
        var j = await res.json();
        if (j && j.key) ids.push("b_" + j.key);
      }
    } catch (e) {}
    try {
      var form = new FormData();
      form.append("file", new Blob([cipher], { type: "application/json" }), "vault.json");
      var res2 = await fetch("https://kappa.lol/api/upload", { method: "POST", body: form, cache: "no-store" });
      if (res2.ok) {
        var j2 = await res2.json();
        if (j2 && j2.id) ids.push("k_" + j2.id);
      }
    } catch (e) {}
    if (!ids.length) return false;
    var pointer = ids.join("__");
    var res3 = await fetch(KV_BASE + "/UpdateValue/" + KV_APP + "/cc_" + vaultHash + "/" + encodeURIComponent(pointer) + "?t=" + now(), {
      method: "POST",
      cache: "no-store"
    });
    return res3.ok;
  }

  async function r2PutVault(cfg, vaultHash, cipher) {
    var res = await fetch(cfg.workerUrl + "/api/vault/cc_" + encodeURIComponent(vaultHash), {
      method: "PUT",
      headers: authHeaders(cfg, { "Content-Type": "application/json" }),
      body: cipher,
      cache: "no-store"
    });
    if (!res.ok) {
      var err = new Error(describeFailure(res.status, null));
      err.status = res.status;
      err.retryable = res.status === 429 || res.status >= 500;
      throw err;
    }
    return { ok: true, provider: "cloudflare-r2" };
  }

  async function r2GetVaultCipher(cfg, vaultHash) {
    var res = await fetch(cfg.workerUrl + "/api/vault/cc_" + encodeURIComponent(vaultHash), {
      headers: authHeaders(cfg, { "X-Cineclip-Client": "web/" + VERSION }),
      cache: "no-store"
    });
    if (res.status === 404) return { answered: true, data: null };
    if (!res.ok) {
      var err = new Error(describeFailure(res.status, null));
      err.status = res.status;
      throw err;
    }
    var text = await res.text();
    return { answered: true, data: text && text.length > 2 ? text : null, source: "cloudflare-r2" };
  }

  async function drivePutVault(cfg, vaultHash, cipher) {
    var params = { action: "vault", hash: vaultHash, token: cfg.driveToken };
    var info = await driveInfo(cfg);

    if (info.readable !== false) {
      try {
        var res = await fetch(q(cfg.driveUrl, params), driveFetchOpts({
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=UTF-8" },
          body: cipher
        }));
        var data = null;
        try {
          data = await res.json();
        } catch (e) {
          throw new Error("Apps Script devolveu resposta inválida ao gravar o cofre (HTTP " + res.status + ").");
        }
        var f = driveFailure(data);
        if (f) {
          var err = new Error("Drive: " + f);
          err.retryable = !/token|inválid|invalid|vazio/i.test(f);
          throw err;
        }
        return { ok: true, provider: "google-drive", mode: "cors" };
      } catch (e) {
        // erro devolvido pelo servidor é definitivo; rede/CORS tenta-se às cegas
        if (!canJsonp() || /^Drive:/.test(e.message)) throw e;
        log("warn", "Gravação do cofre bloqueada pelo browser (CORS) — a enviar às cegas e a confirmar pela leitura.");
      }
    }

    // Modo compatível: o POST chega ao Apps Script mas a resposta não é legível.
    await postOpaque(q(cfg.driveUrl, params), cipher);
    var back = await driveReadJson(cfg, { action: "vault", hash: vaultHash, token: cfg.driveToken }, true);
    var d2 = back.data;
    if (d2 && d2.ok === true && d2.cipher === cipher) {
      saveState({ driveMode: "compatível (JSONP)" });
      return { ok: true, provider: "google-drive", mode: "jsonp" };
    }
    if (d2 && d2.ok === false) {
      var e2 = new Error("Drive: " + (d2.error || "falha a gravar o cofre"));
      e2.retryable = !/token|inválid|invalid|vazio/i.test(String(d2.error || ""));
      throw e2;
    }
    throw new Error("Drive: enviei o cofre mas não consegui confirmá-lo (modo compatível).");
  }

  async function driveGetVaultCipher(cfg, vaultHash) {
    var res = await driveReadJson(cfg, { action: "vault", hash: vaultHash, token: cfg.driveToken });
    var data = res.data;
    if (data && data.ok === false) {
      if (data.code === "not_found" || /não encontrado|not found/i.test(String(data.error || ""))) {
        return { answered: true, data: null };
      }
      var err = new Error("Drive: " + (data.error || "falha a ler o cofre"));
      err.retryable = !/token|inválid/i.test(String(data.error || ""));
      throw err;
    }
    if (!data || !data.cipher) throw new Error("Drive: resposta sem o cofre.");
    return { answered: true, data: data.cipher, source: "google-drive" };
  }

  /**
   * Lê o cofre (JSON encriptado, tal como foi gravado pelo app).
   * @returns {Promise<{data:?string, source:?string, readFailed:boolean}>}
   */
  async function getVaultCipher(vaultHash) {
    var cfg = config();
    var providers = chain(cfg);
    var failures = [];
    var answered = false;
    if (vaultHash) saveState({ vaultHash: String(vaultHash).slice(0, 64) });

    for (var i = 0; i < providers.length; i++) {
      var provider = providers[i];
      if (provider === "legacy") {
        // Cofre antigo em bytebin+kappa (índice em keyvalue.immanuel.co) — leitura/migração
        try {
          var legacy = await legacyReadVaultCipher(vaultHash);
          if (legacy && legacy.data) {
            log("info", "Cofre antigo encontrado (" + legacy.source + ").");
            await migrateToDurable_(cfg, providers, vaultHash, legacy.data);
            saveState({ readFailedAt: 0 });
            return { data: legacy.data, source: legacy.source, readFailed: false, migrated: true };
          }
        } catch (e) {
          if (e && e.expired) log("warn", "Cofre antigo expirou ou está inacessível: " + e.message);
          else failures.push("legado " + e.message);
        }
        continue;
      }

      try {
        var out = provider === "r2"
          ? await r2GetVaultCipher(cfg, vaultHash)
          : await driveGetVaultCipher(cfg, vaultHash);
        if (out.answered) answered = true;
        if (out.data) {
          saveState({ readFailedAt: 0, lastProvider: provider });
          return { data: out.data, source: out.source, readFailed: false };
        }
      } catch (e) {
        failures.push((provider === "r2" ? "R2" : "Drive") + " " + e.message);
      }
    }

    var all = failures;
    var readFailed = !answered && all.length > 0;
    if (readFailed) {
      lastError = all.join(" | ");
      log("error", "Leitura da nuvem falhou: " + lastError);
      saveState({ readFailedAt: now() });
    } else if (all.length) {
      log("warn", "Leitura concluída com avisos: " + all.join(" | "));
    }
    return { data: null, source: null, readFailed: readFailed, degraded: all.length > 0, failures: all };
  }

  /** Copia um cofre antigo para o provider durável configurado. */
  async function migrateToDurable_(cfg, providers, vaultHash, cipher) {
    var target = providers.filter(function (p) {
      return p !== "legacy";
    })[0];
    if (!target || !cfg.mirrorLegacy) return false;
    try {
      if (target === "r2") await r2PutVault(cfg, vaultHash, cipher);
      else await drivePutVault(cfg, vaultHash, cipher);
      log("info", "✅ Cofre antigo migrado para " + (target === "r2" ? "o Cloudflare R2" : "o Google Drive") + ".");
      toastOnce("migrated", "✅ O teu cofre antigo (bytebin/kappa) foi migrado para a nuvem durável.", "success");
      return true;
    } catch (e) {
      log("warn", "Falha a migrar o cofre: " + e.message);
      return false;
    }
  }

  /**
   * Grava o cofre encriptado. Devolve {ok, provider}. Lança erro real (sem catch{} vazio).
   */
  async function putVault(vaultHash, cipher) {
    var cfg = config();
    if (vaultHash) saveState({ vaultHash: String(vaultHash).slice(0, 64) });
    var providers = chain(cfg).filter(function (p) {
      return p !== "legacy";
    });

    if (!providers.length) {
      log("warn", "Sem armazenamento durável — a gravar o cofre apenas nos hosts antigos.");
      var okLegacy = await legacyWriteVaultMirror(vaultHash, cipher).catch(function (e) {
        lastError = e.message;
        return false;
      });
      if (!okLegacy) throw new Error("Falha ao salvar o cofre na nuvem (hosts antigos indisponíveis e nenhuma nuvem durável configurada).");
      return { ok: true, provider: "legacy" };
    }

    var failures = [];
    for (var i = 0; i < providers.length; i++) {
      var provider = providers[i];
      var attempt = 0;
      var lastErr = null;
      while (attempt < 3) {
        attempt++;
        try {
          var out = provider === "r2"
            ? await r2PutVault(cfg, vaultHash, cipher)
            : await drivePutVault(cfg, vaultHash, cipher);
          saveState({ readFailedAt: 0, lastProvider: provider });
          log("info", "Cofre gravado em " + (provider === "r2" ? "R2" : "Drive") + " (" + fmtSize(cipher.length) + ").");
          if (cfg.mirrorLegacy) legacyWriteVaultMirror(vaultHash, cipher).catch(function () {});
          return out;
        } catch (e) {
          lastErr = e;
          lastError = e.message;
          log("warn", "putVault " + provider + " tentativa " + attempt + "/3 falhou: " + e.message);
          if (!e.retryable || attempt === 3) break;
          await sleep(600 * Math.pow(3, attempt - 1));
        }
      }
      failures.push((provider === "r2" ? "R2" : "Drive") + ": " + (lastErr && lastErr.message ? lastErr.message : lastErr));
    }
    throw new Error("Falha ao salvar o cofre na nuvem durável: " + failures.join(" | "));
  }

  /* ------------------------------------------- guarda anti-apagão de fila */

  function markReadFailure(readFailed) {
    saveState({ readFailedAt: readFailed ? now() : 0 });
  }

  function noteQueueCount(n) {
    var count = Number(n) || 0;
    if (count > 0) saveState({ lastCloudQueueCount: count });
  }

  /**
   * Impede que um aparelho com fila vazia (porque a leitura da nuvem falhou por
   * rede) sobrescreva o cofre e apague os Reels dos outros dispositivos.
   */
  function blockEmptyOverwrite(vault) {
    var st = loadState();
    var queue = (vault && vault.queue) || [];
    if (queue.length > 0) return false;
    if (!st.readFailedAt || now() - st.readFailedAt > 10 * 60 * 1000) return false;
    if (!(st.lastCloudQueueCount > 0)) return false;
    log(
      "warn",
      "Bloqueada gravação de cofre vazio: a última leitura da nuvem falhou e existiam " +
        st.lastCloudQueueCount + " Reels. Nada foi sobrescrito."
    );
    toastOnce(
      "empty-overwrite",
      "🛡️ Sincronização protegida: não consegui ler a nuvem e não vou sobrescrever os " +
        st.lastCloudQueueCount + " Reels que lá estão. Verifica a ligação e o URL/token nas Configurações.",
      "warning",
      5 * 60 * 1000
    );
    return true;
  }

  /* ------------------------------- 🔒 claims (anti-publicação duplicada) */

  /**
   * O app (este browser) e o Robô 24h podem estar acordados ao mesmo tempo. Sem
   * uma trava, os dois leem o cofre, os dois veem `status: "scheduled"` e os dois
   * publicam o mesmo Reel no Instagram.
   *
   * A claim é uma reclamação temporária sobre o item: quem a tem é quem publica.
   * Vive no backend (Worker → `/api/claims/*`; Apps Script → `?action=claim`) e
   * expira sozinha (TTL), para uma execução interrompida nunca bloquear a fila.
   *
   * ⚠️ Degradação segura: se o backend ainda não tiver as rotas de claims (Worker
   * ou Apps Script antigos), `claimPublish` devolve `degraded: true` e a
   * publicação SEGUE — nunca se perde uma publicação por causa desta proteção.
   */

  var CLAIM_TTL_MS = 10 * 60 * 1000;

  /** Identificador estável deste aparelho — diz quem tem a claim. */
  function claimOwner(scope) {
    var st = loadState();
    var id = String(st.claimOwnerId || "");
    if (!id) {
      id = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
      saveState({ claimOwnerId: id });
    }
    return (scope ? scope + ":" : "") + id;
  }

  /** Chave da claim: por Reel e, quando conhecido, por cofre (multi-conta). */
  function claimKeyFor(item) {
    var id = typeof item === "string" ? item : item && item.id;
    if (!id) return "";
    var st = loadState();
    var hash = String((item && item.vaultHash) || st.vaultHash || "").slice(0, 64);
    return (
      "cc_" + (hash ? hash + "_" : "") +
      String(id).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100)
    );
  }

  function claimUnsupported(status, data) {
    if (status === 404 || status === 405 || status === 501) return true;
    var err = String((data && data.error) || "");
    return /rota desconhecida|a[çc][ãa]o desconhecida|unknown (route|action)|n[ãa]o suportad/i.test(err);
  }

  /** Claims no Worker (R2). */
  async function r2Claim(cfg, action, payload) {
    var res = await fetchJson(cfg.workerUrl + "/api/claims/" + action, {
      method: "POST",
      headers: authHeaders(cfg, {
        "Content-Type": "application/json",
        "X-Cineclip-Client": "web/" + VERSION
      }),
      body: JSON.stringify(payload),
      cache: "no-store"
    });
    return { status: res.status, ok: res.ok, data: res.data };
  }

  /** Estado de uma claim no Worker (GET /api/claims/:key) — usado quando o
   *  backend recusa uma claim mas não diz quem a tem. */
  async function r2ClaimStatus(cfg, key) {
    var res = await fetchJson(cfg.workerUrl + "/api/claims/" + encodeURIComponent(key), {
      headers: authHeaders(cfg, { "X-Cineclip-Client": "web/" + VERSION }),
      cache: "no-store"
    });
    var data = res.data || {};
    if (data.ok !== true) return null;
    if (data.claim && data.claim.owner) return data.claim;
    return null;
  }

  /** Claims no Apps Script: lista as ativas (usada para confirmar em modo compatível). */
  async function driveClaimsLookup(cfg, key, forceJsonp) {
    var res = await driveReadJson(cfg, { action: "claims", token: cfg.driveToken }, forceJsonp);
    var data = res.data;
    if (!data || data.ok !== true || !Array.isArray(data.active)) return null;
    for (var i = 0; i < data.active.length; i++) {
      if (data.active[i] && data.active[i].key === key) return data.active[i];
    }
    return null;
  }

  /**
   * POST para o Apps Script com confirmação. O Google não deixa o Apps Script
   * definir CORS: quando o browser bloqueia a leitura, o pedido segue "às cegas"
   * e o resultado é confirmado por um GET ?action=claims (JSONP).
   */
  async function driveClaimPost(cfg, action, payload, key, owner) {
    var body = JSON.stringify(payload);
    var params = { action: action, token: cfg.driveToken };
    var info = await driveInfo(cfg);

    if (info.readable !== false) {
      try {
        var res = await fetch(q(cfg.driveUrl, params), driveFetchOpts({
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=UTF-8" },
          body: body
        }));
        var data = null;
        try {
          data = await res.json();
        } catch (e) {
          throw new Error("Apps Script devolveu resposta inválida em '" + action + "' (HTTP " + res.status + ").");
        }
        return { status: res.status, data: data };
      } catch (e) {
        if (!canJsonp()) throw e;
        log("warn", "Claim bloqueado pelo browser (CORS) — a enviar às cegas e a confirmar pela leitura.");
      }
    }

    await postOpaque(q(cfg.driveUrl, params), body);
    var holder = await driveClaimsLookup(cfg, key, true);

    if (action === "claim") {
      if (holder && holder.owner === owner) {
        return { status: 200, data: { ok: true, provider: "google-drive", acquired: true, claim: holder } };
      }
      if (holder) {
        return {
          status: 200,
          data: {
            ok: true, provider: "google-drive", acquired: false,
            holder: { owner: holder.owner, expiresAt: holder.expiresAt }
          }
        };
      }
      throw new Error("Drive: enviei a claim mas não consegui confirmá-la (modo compatível).");
    }

    if (holder && holder.owner !== owner) {
      return {
        status: 200,
        data: {
          ok: true, provider: "google-drive", released: false,
          holder: { owner: holder.owner, expiresAt: holder.expiresAt }
        }
      };
    }
    return { status: 200, data: { ok: true, provider: "google-drive", released: !holder } };
  }

  /**
   * Reclama um item antes de publicar.
   * @returns {Promise<{ok:boolean, degraded?:boolean, reason?:string, holder?:object}>}
   *   ok:true  → pode publicar (tenho a claim, ou o backend não suporta claims)
   *   ok:false → NÃO publicar (reason:"held": outro dispositivo/Robô está a publicar)
   */
  async function claimPublish(item, opts) {
    var o = opts || {};
    var key = claimKeyFor(item);
    if (!key) return { ok: true, degraded: true, reason: "sem_id" };

    var cfg = config();
    var owner = String(o.owner || claimOwner("app")).slice(0, 120);
    var ttlMs = Number(o.ttlMs || CLAIM_TTL_MS);
    var providers = chain(cfg).filter(function (p) {
      return p !== "legacy";
    });
    if (!providers.length) return { ok: true, degraded: true, reason: "sem_nuvem" };

    var problems = [];
    for (var i = 0; i < providers.length; i++) {
      var provider = providers[i];
      try {
        var out = provider === "r2"
          ? await r2Claim(cfg, "acquire", { key: key, owner: owner, ttlMs: ttlMs })
          : await driveClaimPost(cfg, "claim", { key: key, owner: owner, ttlMs: ttlMs }, key, owner);

        var data = (out && out.data) || {};
        if (claimUnsupported(out && out.status, data)) {
          problems.push(provider + ": claims não suportadas neste backend");
          continue;
        }
        if (data.ok === false) {
          problems.push(provider + ": " + (data.error || "erro devolvido pelo backend"));
          continue;
        }
        if (data.acquired === true) {
          saveState({ lastClaimAt: now(), lastClaimProvider: provider });
          log("info", "Claim obtida (" + provider + ") para " + key + ".");
          return {
            ok: true, provider: provider, key: key, owner: owner,
            expiresAt: (data.claim && data.claim.expiresAt) || now() + ttlMs,
            claim: data.claim || null, ownerLabel: o.ownerLabel || owner
          };
        }
        if (data.acquired === false) {
          var holder = data.holder || null;
          if (!holder) {
            /* Recusa SEM dono: os backends só devolvem `acquired:false` com
               `holder` quando há mesmo outro aparelho a publicar. Isto é o
               sintoma de um Worker antigo (a renovação da própria claim e o
               takeover de uma claim expirada falhavam sempre e a resposta saía
               sem dono) — antes bloqueava a publicação para sempre com "Tenta
               novamente dentro de alguns minutos". Confirma-se o estado real da
               claim: se houver mesmo um dono, respeita-se; se não houver nada
               vivo, degrada-se em segurança em vez de prender a fila. */
            var live = null;
            try {
              live = provider === "r2"
                ? await r2ClaimStatus(cfg, key)
                : await driveClaimsLookup(cfg, key, true);
            } catch (e) {
              live = null;
            }
            if (live && live.owner) {
              return {
                ok: false, reason: "held", provider: provider, key: key, owner: owner,
                holder: { owner: live.owner, expiresAt: live.expiresAt }
              };
            }
            problems.push(provider + ": claim recusada sem dono (backend antigo ou claim presa)");
            continue;
          }
          return {
            ok: false, reason: "held", provider: provider, key: key, owner: owner,
            holder: holder
          };
        }
        problems.push(provider + ": resposta inesperada (" + JSON.stringify(data).slice(0, 120) + ")");
      } catch (e) {
        problems.push(provider + ": " + (e && e.message ? e.message : e));
      }
    }

    // Nenhum backend sabe responder → publica como antes, com aviso (nunca se
    // perde uma publicação por causa desta proteção).
    log("warn", "Claims indisponíveis (" + problems.join(" | ") + ") — a publicar sem proteção anti-duplicado.");
    toastOnce(
      "claims-off",
      "⚠️ Proteção anti-publicação duplicada indisponível: o Worker/Apps Script configurado ainda não tem " +
        "as rotas de claims. Publicação segue normalmente — atualiza o backend para evitar Reels repetidos.",
      "warning",
      10 * 60 * 1000
    );
    return { ok: true, degraded: true, key: key, owner: owner, problems: problems };
  }

  /** Liberta a claim (best-effort: se falhar, o TTL trata do assunto). */
  async function releaseClaim(claim) {
    if (!claim || !claim.ok || claim.degraded || !claim.key || !claim.owner) {
      return { ok: true, skipped: true };
    }
    try {
      var cfg = config();
      var out = claim.provider === "r2"
        ? await r2Claim(cfg, "release", { key: claim.key, owner: claim.owner })
        : await driveClaimPost(cfg, "release", { key: claim.key, owner: claim.owner }, claim.key, claim.owner);
      var data = (out && out.data) || {};
      if (data.released === true) {
        log("info", "Claim libertada (" + claim.provider + ") para " + claim.key + ".");
        return { ok: true, released: true };
      }
      return { ok: true, released: false, holder: data.holder || null, note: data.note || "" };
    } catch (e) {
      log("warn", "Não consegui libertar a claim " + claim.key + ": " + (e && e.message ? e.message : e));
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  }

  /** Texto para o utilizador quando o item está a ser publicado noutro lado. */
  function claimSkipMessage(claim, title) {
    var holder = (claim && claim.holder && claim.holder.owner) || "outro dispositivo";
    var until = claim && claim.holder && claim.holder.expiresAt ? new Date(claim.holder.expiresAt) : null;
    var hhmm = "";
    try {
      hhmm = until && !isNaN(until.getTime())
        ? until.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : "";
    } catch (e) {}
    return (
      "⏳ " + (title ? '"' + title + '" ' : "Este Reel ") + "já está a ser publicado por " +
      holder + (hhmm ? " (claim válida até " + hhmm + ")" : "") +
      " — envio ignorado para não publicar duas vezes."
    );
  }

  /** Claims ativas em todos os backends (diagnóstico). */
  async function activeClaims() {
    var cfg = config();
    var providers = chain(cfg).filter(function (p) {
      return p !== "legacy";
    });
    var out = [];
    for (var i = 0; i < providers.length; i++) {
      var provider = providers[i];
      try {
        var data = null;
        if (provider === "r2") {
          var res = await fetchJson(cfg.workerUrl + "/api/claims", {
            headers: authHeaders(cfg, { "X-Cineclip-Client": "web/" + VERSION }),
            cache: "no-store"
          });
          data = res.data;
        } else {
          data = (await driveReadJson(cfg, { action: "claims", token: cfg.driveToken })).data;
        }
        if (data && data.ok === true && Array.isArray(data.active)) {
          data.active.forEach(function (c) {
            if (!c) return;
            out.push({ provider: provider, key: c.key, owner: c.owner, expiresAt: c.expiresAt });
          });
        }
      } catch (e) {
        log("warn", "Não consegui listar as claims em " + provider + ": " + (e && e.message ? e.message : e));
      }
    }
    return out;
  }

  /* ------------------------------------------------------- diagnóstico */

  async function checkR2(cfg) {
    var out = { name: "Cloudflare R2", ok: false, message: "" };
    if (!cfg.workerUrl) {
      out.message = "não configurado";
      return out;
    }
    try {
      var health = await fetchJson(cfg.workerUrl + "/", { method: "GET", cache: "no-store" });
      if (!health.ok || !health.data || health.data.ok !== true) {
        out.message = "respondeu mas não parece ser o CineClip Cloud (HTTP " + health.status + ")";
        return out;
      }
      if (!health.data.bucket) {
        out.message = "no ar, mas sem o binding R2 (BUCKET)";
        return out;
      }
      out.presign = !!health.data.presign;
    } catch (e) {
      out.message = "inacessível: " + e.message;
      return out;
    }
    if (!cfg.token) {
      out.message = "no ar, mas falta o Token";
      return out;
    }
    try {
      var probe = "__healthcheck__";
      var put = await fetchJson(cfg.workerUrl + "/api/vault/" + probe, {
        method: "PUT",
        headers: authHeaders(cfg, { "Content-Type": "application/json" }),
        body: JSON.stringify({ probe: now() })
      });
      if (!put.ok) {
        out.message = describeFailure(put.status, put.data);
        return out;
      }
      var get = await fetchJson(cfg.workerUrl + "/api/vault/" + probe, { headers: authHeaders(cfg), cache: "no-store" });
      await fetch(cfg.workerUrl + "/api/vault/" + probe, { method: "DELETE", headers: authHeaders(cfg) }).catch(function () {});
      if (!get.ok) {
        out.message = describeFailure(get.status, get.data);
        return out;
      }
      var stats = await fetchJson(cfg.workerUrl + "/api/stats", { headers: authHeaders(cfg), cache: "no-store" });
      if (stats.ok && stats.data) out.stats = stats.data;
    } catch (e) {
      out.message = "erro no teste de escrita/leitura: " + e.message;
      return out;
    }
    out.ok = true;
    out.message =
      "ligado ✔ (" + (out.stats ? out.stats.videos + " vídeo(s), " + out.stats.vaults + " cofre(s), " + fmtSize(out.stats.bytes) : "escrita e leitura OK") +
      (out.presign ? " · presign ativo (>100 MB)" : " · presign desativado (limite 100 MB)") + ")";
    return out;
  }

  async function checkDrive(cfg) {
    var out = { name: "Google Drive (Apps Script)", ok: false, message: "" };
    if (!cfg.driveUrl) {
      out.message = "não configurado";
      return out;
    }
    var healthUrl = q(cfg.driveUrl, { action: "health" });

    // Erros de forma do URL, detetados antes de gastar um pedido.
    // http:// só é aceite em localhost/origem própria (preview e testes locais) —
    // um Apps Script a sério é sempre https://script.google.com/macros/s/…/exec
    var urlLocal = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(cfg.driveUrl) ||
      sameTarget(cfg.driveUrl, window.location.origin);
    if (!/^https:\/\//i.test(cfg.driveUrl) && !urlLocal) {
      out.message = "o URL tem de começar por https:// (recebi: " + cfg.driveUrl.slice(0, 60) + "). Copia o URL da implantação em Implantar → Gerir implantações.";
      return out;
    }
    if (/\/dev(\?|$)/.test(cfg.driveUrl)) {
      out.message = "esse é o URL de desenvolvimento (/dev), que só funciona para ti com sessão iniciada. Usa o URL da implantação (/exec): Implantar → Gerir implantações → URL da app da Web.";
      return out;
    }
    if (cfg.driveUrl.indexOf("script.google.com/macros/s/") < 0 && cfg.driveUrl.indexOf(window.location.hostname) < 0) {
      log("warn", "URL do Apps Script invulgar (esperava script.google.com/macros/s/…): " + cfg.driveUrl);
    }

    try {
      var health = await driveReadJson(cfg, { action: "health" });
      var f = driveFailure(health.data);
      if (f || !health.data || health.data.ok !== true) {
        out.message = f || "respondeu mas não parece ser o backend CineClip (HTTP " + health.status + ")";
        return out;
      }
      out.service = health.data.service;
    } catch (e) {
      var why = await probeBlocked(healthUrl);
      out.hint = why;
      if (why === "blocked") {
        out.message =
          "o Apps Script RESPONDEU mas o browser bloqueou a leitura (CORS/cookies de terceiros). " +
          (inIframe()
            ? "Estás com o app dentro de um iframe (pré-visualização): abre-o num separador normal do browser e volta a testar."
            : "Desativa extensões/bloqueadores para script.google.com, ou sai da navegação anónima, e volta a testar. Teste direto: " + healthUrl);
      } else if (why === "unreachable") {
        out.message =
          "não consegui chegar ao URL (" + e.message + "). Faz este teste num separador: " + healthUrl +
          " · se devolver JSON, o problema é só deste lado (browser/extensão); " +
          "se pedir para iniciar sessão ou autorizar, corre a função setup() no editor do Apps Script, autoriza e cria uma NOVA VERSÃO da implantação; " +
          "se der erro/404, confirma 'Quem pode aceder: Qualquer pessoa'.";
      } else {
        out.message = "inacessível: " + e.message + " (confirma que o deploy é 'App da Web' com acesso 'Qualquer pessoa')";
      }
      return out;
    }
    if (!cfg.driveToken) {
      out.message = "no ar, mas falta o Token (corre a função setup() no Apps Script)";
      return out;
    }
    var probeCipher = JSON.stringify({ probe: now() });
    var info2 = await driveInfo(cfg);
    var forceJsonp = info2.readable === false;
    out.mode = forceJsonp ? "compatível (JSONP)" : "direto (CORS)";
    try {
      var probeHash = "healthcheck";
      var putRes = await drivePutVault(cfg, probeHash, probeCipher);
      out.mode = putRes.mode === "jsonp" ? "compatível (JSONP)" : "direto (CORS)";
      var get = await driveReadJson(cfg, { action: "vault", hash: probeHash, token: cfg.driveToken }, forceJsonp);
      var gf = driveFailure(get.data);
      if (gf || !get.data || !get.data.cipher) {
        out.message = gf || "gravei o cofre de teste mas não o consegui ler de volta";
        return out;
      }
      if (get.data.cipher !== probeCipher) {
        out.message = "gravei o cofre de teste mas o que li de volta é diferente";
        return out;
      }
      var stats = await driveReadJson(cfg, { action: "stats", token: cfg.driveToken }, forceJsonp);
      if (!driveFailure(stats.data) && stats.data) out.stats = stats.data;
    } catch (e) {
      out.message = "erro no teste de escrita/leitura: " + e.message;
      return out;
    }
    out.ok = true;
    out.message =
      "ligado ✔ (" + (out.stats ? out.stats.videos + " vídeo(s), " + out.stats.vaults + " cofre(s), " + fmtSize(out.stats.bytes) : "escrita e leitura OK") +
      " · blocos de " + fmtSize(info2.chunkBytes || cfg.driveChunkBytes) + " · modo " + out.mode + ")";
    return out;
  }

  async function healthCheck() {
    var cfg = config();
    var report = {
      ok: false,
      provider: "none",
      order: chain(cfg),
      steps: [],
      config: {
        r2WorkerUrl: cfg.workerUrl,
        r2TokenSet: !!cfg.token,
        driveScriptUrl: cfg.driveUrl,
        driveTokenSet: !!cfg.driveToken,
        maxMb: cfg.maxMb
      }
    };

    var r2 = await checkR2(cfg);
    var drive = await checkDrive(cfg);
    report.r2 = r2;
    report.drive = drive;
    report.steps.push("R2: " + r2.message);
    report.steps.push("Drive: " + drive.message);

    var winner = null;
    if (cfg.provider === "r2") winner = r2.ok ? r2 : null;
    else if (cfg.provider === "drive") winner = drive.ok ? drive : null;
    else winner = r2.ok ? r2 : drive.ok ? drive : null;

    if (winner) {
      report.ok = true;
      report.provider = winner === r2 ? "cloudflare-r2" : "google-drive";
      report.stats = winner.stats;
      report.presign = winner.presign === true;
      report.message = winner.name + " " + winner.message;
      log("info", "Health check OK: " + report.message);
      return report;
    }

    if (!cfg.workerUrl && !cfg.driveUrl) {
      report.message =
        "Nenhuma nuvem durável configurada. Cola o URL do Google Apps Script (grátis, sem cartão) ou do Cloudflare Worker em Configurações → Nuvem durável.";
    } else {
      report.message = "Nenhum backend passou no teste. R2: " + r2.message + " · Drive: " + drive.message;
    }
    return report;
  }

  function diagnostics() {
    var cfg = config();
    return {
      version: VERSION,
      configured: configured(),
      order: chain(cfg),
      provider: configured() ? chain(cfg)[0] : "legacy-temporario",
      r2WorkerUrl: cfg.workerUrl || "(não configurado)",
      driveScriptUrl: cfg.driveUrl || "(não configurado)",
      maxMb: cfg.maxMb,
      driveChunkMb: Math.round(cfg.driveChunkBytes / 1048576),
      presign: cfg.presign,
      mirrorLegacy: cfg.mirrorLegacy,
      lastProvider: loadState().lastProvider || null,
      lastError: lastError || null,
      state: loadState(),
      log: memoryLog.slice(-40)
    };
  }

  function report() {
    var d = diagnostics();
    var lines = [
      "CineCloud " + d.version,
      "ordem: " + d.order.join(" → "),
      "provider ativo: " + d.provider,
      "R2: " + d.r2WorkerUrl,
      "Drive: " + d.driveScriptUrl,
      "maxMb: " + d.maxMb + " · driveChunkMb: " + d.driveChunkMb,
      "último provider usado: " + d.lastProvider,
      "lastError: " + d.lastError,
      "--- log ---"
    ];
    d.log.forEach(function (e) {
      lines.push(e.t + " [" + e.level + "] " + e.message);
    });
    return lines.join("\n");
  }

  /* ------------------------------------------------------------- export */

  window.CineCloud = {
    version: VERSION,
    config: config,
    configured: configured,
    providers: activeProviders,
    classifyUrl: classifyUrl,
    isDurable: isDurable,
    fmtSize: fmtSize,
    uploadVideo: uploadVideo,
    legacyUploadVideo: legacyUploadVideo,
    putVault: putVault,
    getVaultCipher: getVaultCipher,
    markReadFailure: markReadFailure,
    noteQueueCount: noteQueueCount,
    blockEmptyOverwrite: blockEmptyOverwrite,
    // 🔒 anti-publicação duplicada
    CLAIM_TTL_MS: CLAIM_TTL_MS,
    claimOwner: claimOwner,
    claimPublish: claimPublish,
    releaseClaim: releaseClaim,
    claimSkipMessage: claimSkipMessage,
    activeClaims: activeClaims,
    verifyPublicUrl: verifyPublicUrl,
    healthCheck: healthCheck,
    checkR2: checkR2,
    checkDrive: checkDrive,
    diagnostics: diagnostics,
    report: report,
    log: log,
    toastOnce: toastOnce,
    toast: toast,
    dismissToast: dismissToast,
    get lastError() {
      return lastError;
    }
  };

  log(
    "info",
    "CineCloud " + VERSION + " carregado (" +
      (configured() ? "providers: " + chain().join(" → ") : "SEM nuvem durável — a usar hosts temporários") + ")"
  );
})();
