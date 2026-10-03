/**
 * ☁️ CINECLIP CLOUD · GOOGLE DRIVE (Apps Script Web App) — 100% grátis, sem cartão
 * ============================================================================
 * Backend durável alternativo ao Cloudflare R2: guarda os vídeos dos Reels e o
 * "cofre" (fila/chaves/contas) numa pasta do TEU Google Drive (15 GB grátis).
 *
 * PORQUÊ ESTE FICHEIRO
 *   Os hosts que o app usava antes apagam os ficheiros: uguu.se (3 h),
 *   litterbox (12 h no app, máx. 72 h), kappa.lol ("may remove content at any
 *   time") e bytebin.lucko.me (serviço defunto). O Drive não apaga nada.
 *
 * COMO ATIVAR (3 minutos)
 *   1. https://script.google.com → "Novo projeto"
 *   2. Apaga tudo e cola ESTE ficheiro inteiro → 💾 Guardar
 *   3. Escolhe a função `setup` no seletor e clica em ▶ Executar
 *      → autoriza (Avançado → "Aceder a <projeto> sem título")
 *      → o Logger mostra: TOKEN, URL do Web App e o ID da pasta
 *   4. **Implantar → Nova implantação → Tipo: App da Web**
 *        - Executar como: **Eu**
 *        - Quem pode aceder: **Qualquer pessoa**
 *      → clica em **Implantar** e **copia o URL** (https://script.google.com/macros/s/…/exec)
 *   5. No CineClip: Configurações → ☁️ Nuvem durável → **Google Drive (Apps Script)**
 *      → cola o URL e o TOKEN → **Testar ligação** → **Guardar**
 *
 * ⚠️ Sempre que alterares este código tens de fazer **Implantar → Gerir
 *    implantações → ✏️ → Nova versão**, senão o URL antigo continua a servir a
 *    versão velha.
 *
 * LIMITES PRÁTICOS (Apps Script, conta gratuita)
 *   - ~20 000 execuções/dia e 6 min por execução: para Reels chega e sobra
 *     (1 vídeo = 1–20 pedidos consoante o tamanho; o Robô 24h = 288/dia).
 *   - Vídeos até `SINGLE_MAX_MB` são gravados num só pedido; acima disso o
 *     envio é feito em blocos de 2 MB para um upload "resumable" do Drive
 *     (assim o Apps Script nunca precisa de ter o vídeo inteiro em memória).
 *   - O link do vídeo (`?action=video&id=…`) não suporta HTTP Range: devolve o
 *     ficheiro completo. A Meta aceita; para verificar se o link está vivo usa
 *     `?action=videohead&id=…` (leve, devolve só o tamanho).
 */

var VERSION = "1.0.0";
var FOLDER_NAME = "CineClip Cloud";
var SINGLE_MAX_MB = 8;              // até aqui: 1 só pedido
var CHUNK_RAW_BYTES = 2 * 1024 * 1024; // blocos de 2 MB (≈2,7 MB em base64)
// Limite duro do Apps Script: um Blob tem no máximo 50 MB (52.428.800 bytes),
// tanto para gravar como para devolver. Como o link público (?action=video) serve o
// ficheiro com file.getBlob(), acima de ~45 MB o vídeo deixaria de poder ser lido
// pela Meta — mesmo que o upload resumable o tivesse gravado sem problema.
// Um Reel de 60 s a 720p/1080p tem normalmente 5–30 MB, por isso 45 MB chega.
// Precisas de mais? Usa o Cloudflare R2 (cloudflare/r2-worker.js, até 5 GB).
var MAX_VIDEO_MB = 45;
var UPLOAD_TTL_HOURS = 24;          // limpa uploads incompletos com mais de 24 h

/* ============================================================ instalação */

/** Cria a pasta + o token e mostra tudo no Logger. Corre UMA vez. */
function setup() {
  var props = PropertiesService.getScriptProperties();
  var folder = getOrCreateFolder_(props);
  var token = props.getProperty("CINECLIP_TOKEN");
  if (!token) {
    token = "cc_drive_" + randomId_(24);
    props.setProperty("CINECLIP_TOKEN", token);
  }
  Logger.log("✅ CineClip Cloud (Drive) pronto!");
  Logger.log("   Pasta no Drive : " + FOLDER_NAME + "  (id " + folder.getId() + ")");
  Logger.log("   TOKEN          : " + token);
  Logger.log("");
  Logger.log("Agora: Implantar → Nova implantação → App da Web");
  Logger.log("   Executar como: Eu   ·   Quem pode aceder: Qualquer pessoa");
  Logger.log("Copia o URL /exec e cola-o no CineClip (Configurações → Nuvem durável → Google Drive).");
  Logger.log("Testa com: " + getWebAppUrlHint_() + "?action=health");
  return { ok: true, folderId: folder.getId(), token: token };
}

/** Diagnóstico rápido: corre manualmente para ver se está tudo ligado. */
function testarBackend() {
  var props = PropertiesService.getScriptProperties();
  var folder = getOrCreateFolder_(props);
  Logger.log("Pasta: " + folder.getName() + " (" + folder.getId() + ")");
  Logger.log("Vídeos: " + getSubFolder_(folder, "videos").getFiles().hasNext());
  Logger.log("Cofres: " + countFiles_(getSubFolder_(folder, "vaults")));
  Logger.log("Health: " + JSON.stringify(doGet({ parameter: { action: "health" } })));
  Logger.log("TOKEN: " + props.getProperty("CINECLIP_TOKEN"));
}

/* ============================================================ rotas GET */

function doGet(e) {
  var p = (e && e.parameter) || {};
  var action = String(p.action || "health");
  try {
    if (action === "health") return jsonOut_(health_());
    if (action === "video") return videoOut_(p);
    if (action === "videohead") return jsonOut_(videoHead_(p));

    var authErr = requireToken_(p);
    if (authErr) return jsonOut_(authErr);

    if (action === "vault") return jsonOut_(vaultGet_(p));
    if (action === "stats") return jsonOut_(stats_());
    if (action === "complete") return jsonOut_(uploadComplete_(p));
    if (action === "abort") return jsonOut_(uploadAbort_(p));
    return jsonOut_({ ok: false, error: "Ação desconhecida: " + action });
  } catch (err) {
    return jsonOut_({ ok: false, error: err && err.message ? err.message : String(err) });
  }
}

/* ============================================================ rotas POST */

function doPost(e) {
  var p = (e && e.parameter) || {};
  var action = String(p.action || "");
  try {
    var authErr = requireToken_(p);
    if (authErr) return jsonOut_(authErr);

    var body = e && e.postData && e.postData.contents ? e.postData.contents : "";
    if (action === "vault") return jsonOut_(vaultPut_(p, body));
    if (action === "upload") return jsonOut_(uploadChunk_(p, body));
    if (action === "complete") return jsonOut_(uploadComplete_(p));
    if (action === "abort") return jsonOut_(uploadAbort_(p));
    return jsonOut_({ ok: false, error: "Ação desconhecida: " + action });
  } catch (err) {
    return jsonOut_({ ok: false, error: err && err.message ? err.message : String(err) });
  }
}

/* ================================================================ saúde */

function health_() {
  var props = PropertiesService.getScriptProperties();
  var folder = getOrCreateFolder_(props);
  return {
    ok: true,
    service: "cineclip-cloud-drive",
    version: VERSION,
    bucket: true,
    provider: "google-drive",
    folder: folder.getId(),
    chunkBytes: CHUNK_RAW_BYTES,
    singleMaxBytes: SINGLE_MAX_MB * 1024 * 1024,
    maxVideoBytes: MAX_VIDEO_MB * 1024 * 1024,
    durable: true,
    time: new Date().toISOString()
  };
}

function stats_() {
  var props = PropertiesService.getScriptProperties();
  var folder = getOrCreateFolder_(props);
  var videos = getSubFolder_(folder, "videos");
  var vaults = getSubFolder_(folder, "vaults");
  var bytes = 0;
  var nVideos = 0;
  var it = videos.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    bytes += f.getSize();
    nVideos++;
  }
  return {
    ok: true,
    provider: "google-drive",
    videos: nVideos,
    vaults: countFiles_(vaults),
    bytes: bytes,
    version: VERSION
  };
}

/* ================================================================ cofre */

function vaultFile_(hash) {
  var name = "cc_" + String(hash).replace(/[^a-zA-Z0-9_-]/g, "") + ".json";
  if (!name || name === "cc_.json") throw new Error("Hash do cofre inválido.");
  var folder = getSubFolder_(getOrCreateFolder_(PropertiesService.getScriptProperties()), "vaults");
  var it = folder.getFilesByName(name);
  return it.hasNext() ? it.next() : null;
}

function vaultGet_(p) {
  var file = vaultFile_(p.hash || p.name || "");
  if (!file) return { ok: false, error: "Cofre não encontrado.", code: "not_found" };
  return {
    ok: true,
    provider: "google-drive",
    cipher: file.getBlob().getDataAsString(),
    savedAt: file.getLastUpdated().toISOString(),
    size: file.getSize()
  };
}

function vaultPut_(p, body) {
  var cipher = String(body || "").trim();
  if (!cipher) return { ok: false, error: "Cofre vazio." };
  if (cipher.length > 4 * 1024 * 1024) return { ok: false, error: "Cofre demasiado grande (> 4 MB)." };
  var name = "cc_" + String(p.hash || p.name || "").replace(/[^a-zA-Z0-9_-]/g, "") + ".json";
  var folder = getSubFolder_(getOrCreateFolder_(PropertiesService.getScriptProperties()), "vaults");
  var file = vaultFile_(p.hash || p.name || "");
  if (file) {
    file.setContent(cipher);
  } else {
    file = folder.createFile(name, cipher, "application/json");
  }
  return { ok: true, provider: "google-drive", name: name, size: cipher.length, savedAt: new Date().toISOString() };
}

/* ============================================================== vídeos */

/** Link público do vídeo — é este URL que a Meta/Instagram descarrega. */
function videoOut_(p) {
  var id = String(p.id || "");
  if (!id) throw new Error("Falta o parâmetro id.");
  var file = DriveApp.getFileById(id);
  var blob = file.getBlob();
  return ContentService.createBlobOutput(blob)
    .setMimeType("video/mp4")
    .downloadAsFileName(file.getName());
}

/** Verificação leve (sem descarregar o vídeo): usada pelo Robô 24h. */
function videoHead_(p) {
  var id = String(p.id || "");
  var file = DriveApp.getFileById(id);
  return {
    ok: true,
    provider: "google-drive",
    id: id,
    name: file.getName(),
    size: file.getSize(),
    contentType: "video/mp4",
    url: videoUrl_(id)
  };
}

function videoUrl_(fileId) {
  return ScriptApp.getService().getUrl() + "?action=video&id=" + encodeURIComponent(fileId);
}

/**
 * Recebe um bloco (base64) do vídeo.
 *   - total ≤ SINGLE_MAX_MB → grava direto num só pedido
 *   - total maior           → upload "resumable" do Drive, bloco a bloco
 * Devolve {ok, done, url} — `done:true` na última peça.
 */
function uploadChunk_(p, bodyB64) {
  var uploadId = String(p.id || "");
  if (!uploadId) return { ok: false, error: "Falta o id do upload." };
  var total = Number(p.total || 0);
  var name = sanitizeName_(p.name || "reel_cineclip.mp4");
  if (total > MAX_VIDEO_MB * 1024 * 1024) {
    return { ok: false, error: "Vídeo com " + Math.round(total / 1048576) + " MB excede o limite de " + MAX_VIDEO_MB + " MB." };
  }

  var props = PropertiesService.getScriptProperties();
  var state = readUploadState_(props, uploadId);
  var index = Number(p.index || 0);
  var bytes = decodeBase64_(bodyB64);

  // Caso simples: vídeo pequeno, um único pedido
  if (total <= SINGLE_MAX_MB * 1024 * 1024) {
    if (index !== 0) return { ok: false, error: "Vídeo pequeno deve ser enviado num só bloco." };
    var videosFolder = getSubFolder_(getOrCreateFolder_(props), "videos");
    var blob = Utilities.newBlob(bytes, "video/mp4", name);
    var created = videosFolder.createFile(blob);
    var url = videoUrl_(created.getId());
    saveUploadState_(props, uploadId, {
      name: name, total: bytes.length, fileId: created.getId(), url: url, done: true, at: Date.now()
    });
    return { ok: true, done: true, provider: "google-drive", fileId: created.getId(), url: url, size: bytes.length, durable: true };
  }

  // Caso grande: resumable upload (o Apps Script nunca guarda o vídeo inteiro)
  if (!state) {
    if (index !== 0) return { ok: false, error: "Upload não iniciado (esperava o bloco 0)." };
    var session = startResumableSession_(props, name, total);
    state = { name: name, total: total, session: session, sent: 0, at: Date.now() };
  } else if (state.done) {
    return { ok: true, done: true, provider: "google-drive", fileId: state.fileId, url: state.url, size: state.total, durable: true };
  }

  var start = state.sent;
  var end = start + bytes.length - 1;
  var res = UrlFetchApp.fetch(state.session, {
    method: "put",
    headers: {
      "Authorization": "Bearer " + ScriptApp.getOAuthToken(),
      "Content-Length": String(bytes.length),
      "Content-Range": "bytes " + start + "-" + end + "/" + total
    },
    payload: bytes,
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();

  if (code === 200 || code === 201) {
    var meta = {};
    try { meta = JSON.parse(res.getContentText()); } catch (ignored) {}
    if (!meta.id) return { ok: false, error: "O Drive terminou o upload mas não devolveu o id do ficheiro." };
    var finalUrl = videoUrl_(meta.id);
    saveUploadState_(props, uploadId, {
      name: name, total: total, fileId: meta.id, url: finalUrl, done: true, at: Date.now()
    });
    return { ok: true, done: true, provider: "google-drive", fileId: meta.id, url: finalUrl, size: total, durable: true };
  }

  if (code === 308) {
    state.sent = end + 1;
    state.at = Date.now();
    var rangeHeader = res.getHeaders ? res.getHeaders()["Range"] : res.getAllHeaders()["Range"];
    if (rangeHeader) {
      var m = /bytes=(\d+)-(\d+)/.exec(String(rangeHeader));
      if (m) state.sent = Number(m[2]) + 1;
    }
    saveUploadState_(props, uploadId, state);
    return { ok: true, done: false, received: state.sent, total: total };
  }

  return {
    ok: false,
    error: "O Drive recusou o bloco " + index + " (HTTP " + code + "): " + res.getContentText().substring(0, 300),
    httpStatus: code
  };
}

function startResumableSession_(props, name, total) {
  var folder = getSubFolder_(getOrCreateFolder_(props), "videos");
  var res = UrlFetchApp.fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable", {
    method: "post",
    contentType: "application/json; charset=UTF-8",
    headers: {
      "Authorization": "Bearer " + ScriptApp.getOAuthToken(),
      "X-Upload-Content-Type": "video/mp4",
      "X-Upload-Content-Length": String(total)
    },
    payload: JSON.stringify({
      name: name,
      mimeType: "video/mp4",
      parents: [folder.getId()]
    }),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code !== 200) {
    throw new Error("Não consegui iniciar o upload resumable no Drive (HTTP " + code + "): " + res.getContentText().substring(0, 300));
  }
  var headers = res.getAllHeaders ? res.getAllHeaders() : res.getHeaders();
  var location = headers["Location"] || headers["location"];
  if (!location) throw new Error("O Drive não devolveu o Location da sessão de upload.");
  return String(location);
}

function uploadComplete_(p) {
  var props = PropertiesService.getScriptProperties();
  var state = readUploadState_(props, String(p.id || ""));
  if (!state) return { ok: false, error: "Upload desconhecido ou expirado." };
  if (!state.done) return { ok: false, error: "Upload incompleto (" + (state.sent || 0) + "/" + (state.total || 0) + " bytes).", received: state.sent || 0 };
  return { ok: true, done: true, provider: "google-drive", fileId: state.fileId, url: state.url, size: state.total, durable: true };
}

function uploadAbort_(p) {
  PropertiesService.getScriptProperties().deleteProperty("upload_" + String(p.id || ""));
  return { ok: true, aborted: String(p.id || "") };
}

/* ============================================================ utilitários */

function requireToken_(p) {
  var expected = PropertiesService.getScriptProperties().getProperty("CINECLIP_TOKEN");
  if (!expected) return { ok: false, error: "Backend sem token. Corre a função setup() e volta a tentar." };
  if (String(p.token || "") !== expected) return { ok: false, error: "Token inválido." };
  return null;
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function getOrCreateFolder_(props) {
  var id = props.getProperty("FOLDER_ID");
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) {}
  }
  var it = DriveApp.getFoldersByName(FOLDER_NAME);
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder(FOLDER_NAME);
  props.setProperty("FOLDER_ID", folder.getId());
  getSubFolder_(folder, "videos");
  getSubFolder_(folder, "vaults");
  return folder;
}

function getSubFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function countFiles_(folder) {
  var n = 0;
  var it = folder.getFiles();
  while (it.hasNext()) { it.next(); n++; }
  return n;
}

function sanitizeName_(name) {
  var s = String(name || "reel.mp4").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  return /\.mp4$/i.test(s) ? s : s + ".mp4";
}

function randomId_(len) {
  var alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  var out = "";
  for (var i = 0; i < len; i++) out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  return out;
}

function decodeBase64_(b64) {
  var clean = String(b64 || "").replace(/[\r\n\s]/g, "");
  if (!clean) throw new Error("Bloco vazio.");
  return Utilities.base64Decode(clean);
}

function readUploadState_(props, uploadId) {
  var raw = props.getProperty("upload_" + uploadId);
  if (!raw) return null;
  try {
    var st = JSON.parse(raw);
    if (st.at && Date.now() - st.at > UPLOAD_TTL_HOURS * 3600 * 1000) {
      props.deleteProperty("upload_" + uploadId);
      return null;
    }
    return st;
  } catch (e) {
    return null;
  }
}

function saveUploadState_(props, uploadId, state) {
  props.setProperty("upload_" + uploadId, JSON.stringify(state));
}

function getWebAppUrlHint_() {
  try {
    return ScriptApp.getService().getUrl() || "https://script.google.com/macros/s/…/exec";
  } catch (e) {
    return "https://script.google.com/macros/s/…/exec";
  }
}
