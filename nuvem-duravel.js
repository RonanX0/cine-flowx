/*!
 * ☁️ CINECLIP · NUVEM DURÁVEL (CineCloud)
 * ---------------------------------------------------------------------------
 * Camada de armazenamento que substitui os hosts temporários que faziam os
 * vídeos agendados desaparecerem da "nuvem".
 *
 *   ANTES                                          DEPOIS
 *   -------                                        ------
 *   bytebin.lucko.me  (defunto, expira)     →      Cloudflare R2 (o teu bucket)
 *   kappa.lol         (100 MiB, apaga)      →      Cloudflare R2 + fallback antigo
 *   uguu.se           (apaga em 3 h)        →      Cloudflare R2
 *   litterbox         (12 h no app)         →      Cloudflare R2
 *
 * Regras novas que resolvem o "alguns vídeos não ficam na nuvem":
 *   1. O upload do .mp4 é AGUARDADO antes de gravar o cofre (antes o cofre era
 *      gravado sem o link e o upload corria em background sem await).
 *   2. Erros deixam de ser engolidos por catch{} — viram toast + diagnóstico.
 *   3. Retry com backoff (3 tentativas) para falhas de rede/429/5xx.
 *   4. O File do <input> é copiado para memória antes do upload (evita
 *      NotReadableError quando o ficheiro local já não está acessível).
 *   5. Vídeos acima do limite de corpo do Worker usam URL pré-assinada S3.
 *   6. Guarda anti-apagão: se a leitura da nuvem falhou por rede, o app não
 *      sobrescreve o cofre com uma fila vazia.
 *   7. Migração automática: cofres antigos (bytebin/kappa) são copiados para o R2.
 *
 * Exposição: window.CineCloud
 * Configurado em: Configurações → "Nuvem durável — Cloudflare R2"
 *   (localStorage["cineclip.settings"].r2WorkerUrl / .r2Token)
 */
(function () {
  "use strict";

  var VERSION = "1.0.0";
  var SETTINGS_KEY = "cineclip.settings";
  var STATE_KEY = "cineclip.cloud.state";
  var MAX_LOG = 80;

  var KV_BASE = "https://keyvalue.immanuel.co/api/KeyVal";
  var KV_APP = "1729nxi0";
  var LEGACY_VIDEO_HOSTS = ["kappa.lol", "uguu.se", "litter.catbox.moe", "litterbox.catbox.moe", "filebin.net", "catbox.moe", "bytebin.lucko.me"];

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

  /** Resolve URLs relativas (útil no preview local: "/cloud-api"). */
  function absolute(base) {
    try {
      return new URL(base, window.location.origin).toString().replace(/\/+$/, "");
    } catch (e) {
      return String(base || "").replace(/\/+$/, "");
    }
  }

  function config() {
    var s = readSettings();
    var workerUrl = String(s.r2WorkerUrl || "").trim();
    return {
      workerUrl: workerUrl ? absolute(workerUrl) : "",
      token: String(s.r2Token || "").trim(),
      maxMb: Number(s.r2MaxMb || 0) || 95,
      presign: s.r2Presign !== false,
      mirrorLegacy: s.cloudMirrorLegacy !== false,
      provider: String(s.cloudProvider || "auto").trim().toLowerCase(),
      timeoutMs: Number(s.cloudTimeoutMs || 0) || 300000
    };
  }

  function configured() {
    var c = config();
    return !!(c.workerUrl && c.token);
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

  /** Classifica um URL de vídeo: "r2" (durável), "temp" (host que expira) ou "local". */
  function classifyUrl(url) {
    if (!url || !/^https?:/i.test(url)) return "none";
    var c = config();
    try {
      var host = new URL(url).hostname;
      if (c.workerUrl && host === new URL(c.workerUrl).hostname) return "r2";
      for (var i = 0; i < LEGACY_VIDEO_HOSTS.length; i++) {
        if (host === LEGACY_VIDEO_HOSTS[i] || host.slice(-LEGACY_VIDEO_HOSTS[i].length - 1) === "." + LEGACY_VIDEO_HOSTS[i]) return "temp";
      }
      if (/workers\.dev$/i.test(host) || /r2\.cloudflarestorage\.com$/i.test(host) || /r2\.dev$/i.test(host)) return "r2";
      if (host === window.location.hostname) return "local";
      return "unknown";
    } catch (e) {
      return "unknown";
    }
  }

  /* --------------------------------------------------------------- toasts */

  var lastToast = {};

  /**
   * Mostra um toast no máximo 1x por `windowMs` para a mesma chave.
   * Evita o spam do sync automático (que corre a cada 20 s).
   */
  function toastOnce(key, message, kind, windowMs) {
    try {
      if (typeof window.je === "function" || (window.CineClipToast && typeof window.CineClipToast === "function")) {
        var toast = window.CineClipToast || window.je;
        var win = windowMs || 5 * 60 * 1000;
        if (lastToast[key] && now() - lastToast[key] < win) return false;
        lastToast[key] = now();
        var fn = toast[kind || "error"];
        if (typeof fn === "function") fn(message);
        else toast(message);
        return true;
      }
    } catch (e) {}
    log(kind === "success" ? "info" : "warn", message);
    return false;
  }

  function toast(key, message, kind, toastId) {
    try {
      var toast = window.CineClipToast || window.je;
      if (typeof toast === "function") {
        var fn = kind && typeof toast[kind] === "function" ? toast[kind] : toast;
        fn(message, toastId ? { id: toastId } : undefined);
        return true;
      }
    } catch (e) {}
    log("info", message);
    return false;
  }

  function dismissToast(toastId) {
    try {
      var toast = window.CineClipToast || window.je;
      if (toast && typeof toast.dismiss === "function") toast.dismiss(toastId);
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

  async function httpJson(url, options, cfg) {
    var res = await fetch(url, options);
    var text = await res.text();
    var data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      data = { raw: text };
    }
    return { status: res.status, ok: res.ok, data: data, text: text };
  }

  function describeFailure(status, data) {
    var msg = (data && (data.error || data.message)) || "";
    if (status === 401 || status === 403) return "Token do Worker inválido ou em falta (401/403). Verifica em Configurações → Nuvem durável.";
    if (status === 404) return msg || "Recurso não encontrado no Worker (404). Confirma a URL do Worker.";
    if (status === 413) return msg || "Ficheiro demasiado grande para o corpo do Worker (413).";
    if (status === 501) return msg || "Funcionalidade não configurada no Worker (501).";
    if (status >= 500) return msg || "Erro no Worker (HTTP " + status + ").";
    return msg || "HTTP " + status;
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
        reject(new Error("Tempo esgotado ao enviar o vídeo (" + Math.round((opts.timeoutMs || 0) / 1000) + " s). Verifica a tua ligação ou reduz o tamanho do clipe."));
      };
      xhr.onabort = function () {
        reject(new Error("Envio cancelado."));
      };
      xhr.send(opts.body);
    });
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
    var sign = await httpJson(
      cfg.workerUrl + "/api/video/presign",
      {
        method: "POST",
        headers: authHeaders(cfg, { "Content-Type": "application/json" }),
        body: JSON.stringify({ fileName: fileName, size: buffer.byteLength, expires: 3600 })
      },
      cfg
    );
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

  /* ------------------------------------------- upload legado (compatibilidade) */

  async function legacyUploadVideo(blobOrFile, fileName) {
    var name = String(fileName || "reel_cineclip.mp4").replace(/[^a-zA-Z0-9._-]/g, "_");
    if (!/\.mp4$/i.test(name)) name += ".mp4";
    var errors = [];

    // 1) kappa.lol (100 MiB, sem garantia de retenção)
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

    // 2) endpoint próprio do dev server / serverless (quando existir)
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

    var size = blobOrFile.size || 0;
    var maxBytes = cfg.maxMb * 1024 * 1024;

    if (!configured() || cfg.provider === "legacy") {
      log(
        "warn",
        "R2 não configurado — a usar hosts temporários. Configura em Configurações → Nuvem durável."
      );
      toastOnce(
        "no-r2",
        "⚠️ Nuvem durável (R2) não configurada: os vídeos vão para hosts temporários que apagam os ficheiros em 3–72 h. Configura em Configurações → Nuvem durável.",
        "warning",
        10 * 60 * 1000
      );
      var legacyUrl = await legacyUploadVideo(blobOrFile, name);
      return legacyUrl;
    }

    if (size > maxBytes && !cfg.presign) {
      var errSize = new Error(
        "O vídeo tem " + fmtSize(size) + " e o limite configurado é " + cfg.maxMb + " MB. " +
          "Ativa o presign (R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY no Worker) ou reduz a resolução/bitrate."
      );
      errSize.code = "too_large";
      throw errSize;
    }

    var mem = await readIntoMemory(blobOrFile, name);
    log("info", "A enviar " + name + " (" + fmtSize(mem.size) + ") para o R2…");

    var attempt = 0;
    var lastErr = null;
    while (attempt < 3) {
      attempt++;
      try {
        var out = await uploadToWorker(cfg, mem.buffer, name, function (pct, loaded, total) {
          if (opts.onProgress) opts.onProgress(pct, loaded, total);
        });
        await verifyPublicUrl(out.url);
        log("info", "Vídeo na nuvem durável: " + out.url + " (" + out.provider + ")");
        return out.url;
      } catch (e) {
        lastErr = e;
        lastError = e && e.message ? e.message : String(e);
        if (e && e.code === "unreadable_source") throw e;
        if (e && e.code === "presign_unavailable") throw e;
        var retryable = !e.status || e.retryable || e.status === 429 || e.status >= 500;
        log("warn", "Tentativa " + attempt + "/3 falhou: " + lastError);
        if (!retryable || attempt === 3) break;
        await sleep(800 * Math.pow(3, attempt - 1));
      }
    }

    if (opts.allowTemp === false) throw lastErr || new Error("Falha no upload para o R2.");

    // Último recurso: host temporário (mantém o fluxo antigo a funcionar)
    try {
      log("warn", "R2 falhou (" + lastError + ") — a tentar host temporário como último recurso.");
      var temp = await legacyUploadVideo(blobOrFile, name);
      toastOnce(
        "r2-fallback",
        "⚠️ O R2 falhou (" + lastError + "). O vídeo foi para um host TEMPORÁRIO e pode expirar antes do horário agendado.",
        "warning",
        10 * 60 * 1000
      );
      return temp;
    } catch (e2) {
      var finalErr = new Error(
        "Não foi possível colocar o vídeo na nuvem. R2: " + lastError + " · Temporário: " + (e2 && e2.message ? e2.message : e2)
      );
      finalErr.code = "all_providers_failed";
      throw finalErr;
    }
  }

  /** Confirma que o link público responde (é este URL que a Meta vai buscar). */
  async function verifyPublicUrl(url) {
    try {
      var res = await fetch(url, { method: "GET", headers: { Range: "bytes=0-0" }, cache: "no-store" });
      if (res.status >= 400) {
        log("warn", "Link público respondeu HTTP " + res.status + ": " + url);
        toastOnce(
          "r2-public-" + res.status,
          "⚠️ O vídeo foi guardado mas o link público respondeu HTTP " + res.status + ". Verifica PUBLIC_BASE/rotas do Worker.",
          "warning"
        );
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
          if (text && text.length > 2) return { data: text, source: p.indexOf("b_") === 0 ? "legacy-bytebin" : "legacy-kappa", pointer: pointer };
        } else errors.push(url + " → HTTP " + r.status);
      } catch (e) {
        errors.push(url + " → " + e.message);
      }
    }
    log("warn", "Cofre antigo inacessível (bytebin/kappa expiraram?): " + errors.join(" | "));
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

  /**
   * Lê o cofre (JSON encriptado, tal como foi gravado pelo app).
   * @returns {Promise<{data:?string, source:?string, readFailed:boolean}>}
   */
  async function getVaultCipher(vaultHash) {
    var cfg = config();
    var failures = [];
    var legacyFailures = [];
    // r2Answered = o R2 respondeu de forma fiável (200 com dados, 200 vazio ou 404).
    // Se sim, ele é a fonte de verdade: uma falha do host antigo NÃO conta como
    // falha de leitura (senão um cofre novo ficava com a guarda anti-apagão armada).
    var r2Answered = false;

    if (configured() && cfg.provider !== "legacy") {
      try {
        var res = await fetch(cfg.workerUrl + "/api/vault/cc_" + encodeURIComponent(vaultHash), {
          headers: authHeaders(cfg, { "X-Cineclip-Client": "web/" + VERSION }),
          cache: "no-store"
        });
        if (res.ok) {
          var text = await res.text();
          if (text && text.length > 2) {
            saveState({ readFailedAt: 0 });
            return { data: text, source: "cloudflare-r2", readFailed: false };
          }
          r2Answered = true;
        } else if (res.status === 404) {
          r2Answered = true;
        } else {
          failures.push("R2 " + describeFailure(res.status, null));
        }
      } catch (e) {
        failures.push("R2 " + e.message);
      }
    }

    // Fallback/migração: cofre antigo em bytebin+kappa (índice em keyvalue.immanuel.co)
    try {
      var legacy = await legacyReadVaultCipher(vaultHash);
      if (legacy && legacy.data) {
        log("info", "Cofre antigo encontrado (" + legacy.source + ").");
        if (configured() && cfg.provider !== "legacy" && cfg.mirrorLegacy) {
          try {
            await putVaultCipherToWorker(cfg, vaultHash, legacy.data);
            log("info", "✅ Cofre antigo migrado para o R2.");
            toastOnce("migrated", "✅ O teu cofre antigo (bytebin/kappa) foi migrado para o R2.", "success");
          } catch (e) {
            log("warn", "Falha a migrar o cofre para o R2: " + e.message);
          }
        }
        saveState({ readFailedAt: 0 });
        return { data: legacy.data, source: legacy.source, readFailed: false };
      }
    } catch (e) {
      legacyFailures.push(e && e.expired ? "legado expirado/inacessível" : "legado " + e.message);
      log("warn", "Cofre antigo (bytebin/kappa) não pôde ser lido: " + e.message);
    }

    // Só há "falha de leitura" quando NENHUMA fonte fiável respondeu.
    // (R2 respondeu 404 = o cofre ainda não existe → não é falha.)
    var all = failures.concat(legacyFailures);
    var readFailed = !r2Answered && all.length > 0;
    if (readFailed) {
      lastError = all.join(" | ");
      log("error", "Leitura da nuvem falhou: " + lastError);
      saveState({ readFailedAt: now() });
    } else if (all.length) {
      log("warn", "Leitura concluída com avisos: " + all.join(" | "));
    }
    return { data: null, source: null, readFailed: readFailed, degraded: all.length > 0, failures: all };
  }

  async function putVaultCipherToWorker(cfg, vaultHash, cipher) {
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
    return true;
  }

  /**
   * Grava o cofre encriptado. Devolve {ok, provider}. Lança erro real (sem catch{} vazio).
   */
  async function putVault(vaultHash, cipher) {
    var cfg = config();

    if (!configured() || cfg.provider === "legacy") {
      log("warn", "R2 não configurado — a gravar o cofre apenas nos hosts antigos.");
      var okLegacy = await legacyWriteVaultMirror(vaultHash, cipher).catch(function (e) {
        lastError = e.message;
        return false;
      });
      if (!okLegacy) throw new Error("Falha ao salvar o cofre na nuvem (hosts antigos indisponíveis e R2 não configurado).");
      return { ok: true, provider: "legacy" };
    }

    var attempt = 0;
    var lastErr = null;
    while (attempt < 3) {
      attempt++;
      try {
        await putVaultCipherToWorker(cfg, vaultHash, cipher);
        saveState({ readFailedAt: 0 });
        log("info", "Cofre gravado no R2 (" + fmtSize(cipher.length) + ").");
        if (cfg.mirrorLegacy) {
          // espelho opcional, para versões antigas do app / Robô 24h antigo
          legacyWriteVaultMirror(vaultHash, cipher).catch(function () {});
        }
        return { ok: true, provider: "cloudflare-r2" };
      } catch (e) {
        lastErr = e;
        lastError = e.message;
        log("warn", "putVault tentativa " + attempt + "/3 falhou: " + e.message);
        if (!e.retryable || attempt === 3) break;
        await sleep(600 * Math.pow(3, attempt - 1));
      }
    }
    throw new Error("Falha ao salvar o cofre no R2: " + (lastErr && lastErr.message ? lastErr.message : lastErr));
  }

  /* ------------------------------------------- guarda anti-apagão de fila */

  function markReadFailure(readFailed) {
    if (readFailed) saveState({ readFailedAt: now() });
    else saveState({ readFailedAt: 0 });
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
        st.lastCloudQueueCount + " Reels que lá estão. Verifica a ligação/URL do Worker.",
      "warning",
      5 * 60 * 1000
    );
    return true;
  }

  /* ------------------------------------------------------- diagnóstico */

  async function healthCheck() {
    var cfg = config();
    var report = { ok: false, provider: "none", steps: [], config: { workerUrl: cfg.workerUrl, tokenSet: !!cfg.token, maxMb: cfg.maxMb } };

    if (!cfg.workerUrl) {
      report.message = "Sem URL do Worker. Cola em Configurações → Nuvem durável a URL do teu Worker (ex.: https://cineclip-cloud.TUA-CONTA.workers.dev).";
      return report;
    }

    try {
      var health = await httpJson(cfg.workerUrl + "/", { method: "GET", cache: "no-store" }, cfg);
      report.steps.push("GET / → HTTP " + health.status);
      if (!health.ok || !health.data || health.data.ok !== true) {
        report.message = "O Worker respondeu mas não parece ser o CineClip Cloud (HTTP " + health.status + ").";
        return report;
      }
      if (!health.data.bucket) {
        report.message = "O Worker está no ar mas não tem o binding R2 (BUCKET). Verifica o wrangler.toml.";
        return report;
      }
      report.presign = !!health.data.presign;
    } catch (e) {
      report.message = "Não consegui falar com o Worker: " + e.message + " (verifica a URL, o CORS e se fizeste deploy).";
      return report;
    }

    if (!cfg.token) {
      report.message = "Worker OK, mas falta o Token (Configurações → Nuvem durável → Token do Worker).";
      return report;
    }

    try {
      var probeName = "__healthcheck__";
      var put = await httpJson(
        cfg.workerUrl + "/api/vault/" + probeName,
        { method: "PUT", headers: authHeaders(cfg, { "Content-Type": "application/json" }), body: JSON.stringify({ probe: now() }) },
        cfg
      );
      report.steps.push("PUT /api/vault → HTTP " + put.status);
      if (!put.ok) {
        report.message = "Escrita recusada: " + describeFailure(put.status, put.data);
        return report;
      }
      var get = await httpJson(cfg.workerUrl + "/api/vault/" + probeName, { headers: authHeaders(cfg), cache: "no-store" }, cfg);
      report.steps.push("GET /api/vault → HTTP " + get.status);
      await fetch(cfg.workerUrl + "/api/vault/" + probeName, { method: "DELETE", headers: authHeaders(cfg) }).catch(function () {});
      if (!get.ok) {
        report.message = "Leitura falhou: " + describeFailure(get.status, get.data);
        return report;
      }
    } catch (e) {
      report.message = "Erro no teste de escrita/leitura: " + e.message;
      return report;
    }

    var stats = null;
    try {
      stats = await httpJson(cfg.workerUrl + "/api/stats", { headers: authHeaders(cfg), cache: "no-store" }, cfg);
      if (stats.ok && stats.data) report.stats = stats.data;
    } catch (e) {}

    report.ok = true;
    report.provider = "cloudflare-r2";
    report.message =
      "R2 ligado ✔ (" + (report.stats ? report.stats.videos + " vídeo(s), " + report.stats.vaults + " cofre(s), " + fmtSize(report.stats.bytes) : "escrita e leitura OK") +
      (report.presign ? " · presign ativo (>100 MB)" : " · presign desativado (limite 100 MB)") + ")";
    log("info", "Health check OK: " + report.message);
    return report;
  }

  function diagnostics() {
    var cfg = config();
    return {
      version: VERSION,
      configured: configured(),
      provider: configured() ? "cloudflare-r2" : "legacy-temporario",
      workerUrl: cfg.workerUrl || "(não configurado)",
      maxMb: cfg.maxMb,
      presign: cfg.presign,
      mirrorLegacy: cfg.mirrorLegacy,
      lastError: lastError || null,
      state: loadState(),
      log: memoryLog.slice(-40)
    };
  }

  function report() {
    var d = diagnostics();
    var lines = ["CineCloud " + d.version, "provider: " + d.provider, "worker: " + d.workerUrl, "maxMb: " + d.maxMb, "lastError: " + d.lastError, "--- log ---"];
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
    classifyUrl: classifyUrl,
    fmtSize: fmtSize,
    uploadVideo: uploadVideo,
    legacyUploadVideo: legacyUploadVideo,
    putVault: putVault,
    getVaultCipher: getVaultCipher,
    markReadFailure: markReadFailure,
    noteQueueCount: noteQueueCount,
    blockEmptyOverwrite: blockEmptyOverwrite,
    verifyPublicUrl: verifyPublicUrl,
    healthCheck: healthCheck,
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

  log("info", "CineCloud " + VERSION + " carregado (" + (configured() ? "R2 configurado" : "R2 NÃO configurado — a usar hosts temporários") + ")");
})();
