#!/usr/bin/env node
/**
 * ☁️ RENOVAR O CLOUDFLARE — `npm run cloudflare:renovar`
 * ---------------------------------------------------------------------------
 * "Renovar o Cloudflare" neste projeto são três coisas, e este script faz as
 * três por ordem, com verificação a sério no fim:
 *
 *   1. verificar que o Worker e o `cloudflare/wrangler.toml` estão coerentes com
 *      o runtime de 2026 (compatibility_date/flags, TOML, segredos fora do repo);
 *   2. fazer `npx wrangler deploy` (o site sozinho NUNCA atualiza o backend);
 *   3. provar que o backend novo funciona: health, o link público /v/:key a
 *      devolver bytes (200/206/HEAD — foi aqui que o 500 com HTML gerou
 *      2207077s), o round-trip do cofre, as claims e o espaço usado no R2.
 *
 * Uso:
 *   npm run cloudflare:renovar                     # testes + deploy + verificação
 *   npm run cloudflare:renovar -- --so-verificar    # não faz deploy; só sonda a URL
 *   npm run cloudflare:renovar -- --dry            # só as verificações locais (offline)
 *   npm run cloudflare:renovar -- --url=https://cineclip-cloud.<conta>.workers.dev
 *   npm run cloudflare:renovar -- --token-stdin    # lê o CINECLIP_TOKEN do stdin e
 *                                                   # faz o round-trip autenticado
 *   npm run cloudflare:renovar -- --rotacionar-token  # token NOVO na conta (mostra o
 *                                                   # plano; escreve só com --confirmo;
 *                                                   # o valor sai no terminal, nunca no git)
 *
 * Não há credenciais gravadas aqui: o acesso vem do `npx wrangler login` ou de
 * CLOUDFLARE_API_TOKEN na tua máquina. Sem isso, o script para e diz o que falta.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR_CF = path.join(RAIZ, "cloudflare");
const CONFIG = path.join(DIR_CF, "wrangler.toml");
const WORKER = path.join(DIR_CF, "r2-worker.js");
const NODE_MIN = 20;

const argv = process.argv.slice(2);
const tem = (f) => argv.includes(f);
const valor = (name) => {
  const igual = argv.find((a) => a.startsWith(`--${name}=`));
  if (igual) return igual.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
};

let okCount = 0;
let failCount = 0;
const falhas = [];
const ok = (m) => { okCount++; console.log(`  ✔ ${m}`); };
const fail = (m, detalhe = "") => { failCount++; falhas.push(m); console.log(`  ✘ ${m}${detalhe ? `  (${detalhe})` : ""}`); };
const nota = (m) => console.log(`  · ${m}`);
const titulo = (m) => console.log(`\n${m}`);

const run = (cmd, args, { cwd = RAIZ, input, captura = true } = {}) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", input, shell: process.platform === "win32" });
  const saida = `${r.stdout || ""}${r.stderr || ""}`;
  return { code: r.status ?? 1, out: saida, erro: r.error ? String(r.error.message || r.error) : null };
};

/* ------------------------------------------------- 0. pré-voo (sem rede) */

titulo("0. Pré-voo");
{
  const node = process.versions.node.split(".").map(Number);
  if (node[0] >= NODE_MIN) ok(`Node ${process.versions.node} (≥ ${NODE_MIN} para o wrangler 4)`);
  else fail(`Node ${process.versions.node} é velho demais para o wrangler 4`, `precisa de ≥ ${NODE_MIN}`);

  for (const [ficheiro, texto] of [[WORKER, fs.existsSync(WORKER) ? fs.readFileSync(WORKER, "utf8") : ""], [CONFIG, fs.existsSync(CONFIG) ? fs.readFileSync(CONFIG, "utf8") : ""]]) {
    if (!texto) fail(`${path.relative(RAIZ, ficheiro)} existe`, "em falta");
  }

  if (!tem("--dry")) {
    const wv = run("npx", ["--no-install", "wrangler", "--version"], {});
    if (wv.code === 0) ok(`wrangler ${wv.out.trim().split("\n").pop().trim()}`);
    else fail("`npx wrangler --version`", "sem wrangler: corre `npm i -D wrangler@latest` (ou deixa o npx baixá-lo)");
  }
}

/* ------------------------------- 1. coerência do Worker e da configuração */

titulo("1. O Worker e o wrangler.toml");
{
  const testes = run(process.execPath, [path.join(RAIZ, "tools", "test-r2-worker.mjs")], {});
  const resumo = (testes.out.match(/(\d+) passaram, (\d+) falharam/) || [])[0] || "sem resumo";
  if (testes.code === 0) ok(`npm run worker:test verde — ${resumo}`);
  else {
    const linhas = (testes.out || "").split("\n").filter(Boolean);
    const relevantes = linhas.filter((l) => /^\s*- |✘/.test(l)).slice(0, 12);
    fail(`npm run worker:test falhou`, resumo);
    console.log((relevantes.length ? relevantes : linhas.slice(-10))
      .map((l) => `      ${l.trim()}`).join("\n"));
  }
}
{
  const src = fs.readFileSync(WORKER, "utf8");
  const versao = (/const VERSION = "([\d.]+)"/.exec(src) || [])[1];
  if (versao) ok(`cloudflare/r2-worker.js é a versão ${versao}`);
  else fail("versão anunciada no Worker", "sem `const VERSION`");

  const toml = fs.readFileSync(CONFIG, "utf8");
  const linhas = toml.split("\n").map((l) => (/^\s*#/.test(l) ? "" : l)).join("\n");
  const data = (/compatibility_date\s*=\s*"([\d-]+)"/.exec(linhas) || [])[1] || "";
  if (data >= "2026-08-04") ok(`compatibility_date ${data} (runtime atual)`);
  else fail(`compatibility_date ${data || "em falta"}`, "renova para hoje; antes de 2026-08-04 precisa de compatibility_flags = [\"nodejs_compat\"]");

  if (/^\s*workers_dev\s*=\s*true\s*$/m.test(linhas)) ok("workers_dev ativo (o /v/:key é público)");
  else fail("workers_dev = true no topo do TOML", "sem isto o subdomínio workers.dev pode ser desligado");

  if (/CINECLIP_TOKEN\s*=\s*"[^"]/.test(linhas)) fail("nenhum segredo no wrangler.toml", "o token vai com `wrangler secret put`");
  else ok("nenhum segredo no wrangler.toml");

  // O /v/:key é o único caminho que a Meta lê sem token: tem de usar `new Headers`
  const serve = src.slice(src.indexOf("async function handleServeVideo"), src.indexOf("function parseRange"));
  if (/new Headers\(/.test(serve) && !/const headers = corsHeaders\(/.test(serve)) ok("o /v/:key constrói um `Headers` (não um objeto simples → 500)");
  else fail("o /v/:key usa `new Headers(...)`", "corsHeaders() devolve um objeto e `headers.set` rebenta → 500 com HTML no lugar do .mp4");
  if (/if-none-match/i.test(serve)) ok("If-None-Match → 304 (o .mp4 é imutável)");
  if (/if \(wanted && object\.range\)/.test(serve)) ok("o 200/206 decide-se pelo pedido, não pelo backend");
}

/* ----------------------------------------------- 2. token novo (opcional) */

if (tem("--rotacionar-token")) {
  titulo("2. Rotacionar o CINECLIP_TOKEN");
  const novo = "cc_r2_" + crypto.randomBytes(16).toString("hex");
  if (!tem("--confirmo")) {
    console.log("  Vou pôr um token NOVO na conta. Consequências:")
    console.log("    · o Robô 24h no script.google.com fica com o token velho → volta a");
    console.log("      copiar o código na aba Agendador → Robô 24h e correr `ativarRobo24h`;");
    console.log("    · em cada aparelho, atualiza a chave do cofre em Nuvem → Cloudflare R2;");
    console.log("    · os vídeos já gravados NÃO são tocados (só a chave de escrita muda).");
    nota("Nada foi escrito. Quando tiveres lido, confirma com --confirmo (o token só é");
    nota("gerado nessa segunda execução e não fica em nenhum ficheiro do repositório).");
    fail("rotação pedida sem confirmação", "volta com: npm run cloudflare:renovar -- --rotacionar-token --confirmo");
  } else {
    const r = run("npx", ["wrangler", "secret", "put", "CINECLIP_TOKEN", "--config", CONFIG], { input: novo + "\n" });
    if (r.code === 0) {
      ok("secret CINECLIP_TOKEN atualizado na conta");
      console.log("\n  ⚠️ Novo token (dá-te 30 segundos e não o guardes em ficheiros do repo):");
      console.log(`     ${novo}`);
      console.log("     Cola-o no app (Nuvem → Cloudflare R2 → Token) e no Robô 24h.");
      nota("Os aparelhos com o token velho passam a levar 401 — é isso que se quis.");
    } else fail("`wrangler secret put CINECLIP_TOKEN` falhou", r.out.trim().split("\n").slice(-1)[0] || "");
  }
} else {
  titulo("2. Rotacionar o CINECLIP_TOKEN — não pedido");
  nota("Se o objetivo era trocar a chave: npm run cloudflare:renovar -- --rotacionar-token");
}

/* ------------------------------------------------------ 3. login / conta */

const urlArg = valor("url");
let workerUrl = urlArg;
if (tem("--dry")) {
  titulo("3. Deploy — saltado (--dry)");
  ok("verificações locais concluídas; nada foi à Cloudflare");
} else {
  titulo("3. Acesso à Cloudflare");
  const soVerificar = tem("--so-verificar") && !!workerUrl;
  const who = soVerificar ? { code: 0, out: "" } : run("npx", ["wrangler", "whoami"], {});
  const comSessao = soVerificar ? true : who.code === 0 && /Logged in|API Token|Authorized/i.test(who.out);
  if (soVerificar) nota("--so-verificar com --url: não é preciso sessão, vou só sonder");
  else if (comSessao) {
    ok(`sessão ativa: ${(who.out.match(/ℹ️\s*([\w.+-]+@[\w.-]+\.\w+)/) || [])[1] || "conta autenticada"}`);
  } else if (process.env.CLOUDFLARE_API_TOKEN) {
    ok("a usar CLOUDFLARE_API_TOKEN do ambiente");
  } else {
    fail("sem sessão Cloudflare nesta máquina");
    console.log("      Abre o OAuth tu mesmo (eu não peço nem guardo tokens):");
    console.log("        npx wrangler login");
    console.log("      ou, em CI: export CLOUDFLARE_API_TOKEN=… (Token de API do dashboard)");
    console.log("      Depois: npm run cloudflare:renovar -- --so-verificar");
  }

  /* ---------------------------------------------------------- 4. deploy */
  titulo("4. npx wrangler deploy");
  if (tem("--so-verificar")) {
    nota("deploy não faz parte deste pedido (--so-verificar)");
  } else if (!comSessao && !process.env.CLOUDFLARE_API_TOKEN) {
    fail("deploy não feito", "sem sessão");
  } else if (tem("--so-verificar")) {
    nota("--so-verificar: sem deploy, vou só sonder" + (workerUrl ? ` ${workerUrl}` : " a URL do health"));
  } else {
    const dep = run("npx", ["wrangler", "deploy", "--config", CONFIG], {});
    const saida = dep.out;
    if (dep.code === 0) {
      ok("`wrangler deploy` concluído");
      const detectada = (saida.match(/https:\/\/[a-z0-9.-]*workers\.dev/i) || [])[0];
      if (detectada) workerUrl = detectada;
      nota("Current Version ID / Worker Startup Duration aparecem no output acima, se precisar deles.");
    } else {
      fail("`wrangler deploy` falhou", saida.trim().split("\n").filter((l) => /ERROR|error|Unexpected/i.test(l)).slice(0, 3).join(" | ") || "vê o output");
      console.log(saida.split("\n").slice(-18).map((l) => `      ${l}`).join("\n"));
    }
  }
}

/* --------------------------------------------------- 5. verificar online */

const tokenStdin = tem("--token-stdin")
  ? fs.readFileSync(0, "utf8").trim()
  : process.env.CINECLIP_TOKEN || "";

const j = async (r) => { try { return await r.json(); } catch { return null; } };

/**
 * O Worker monta a URL pública a partir do `request.url` dele — em produção é
 * https, mas num `wrangler dev` local isso dá um https:// num servidor http e o
 * pedido nem sai. Para verificar, fico sempre com o caminho (/v/…) e uso a origem
 * com que me deram o health.
 */
const mesmaOrigem = (base, absoluto) => {
  try {
    const u = new URL(absoluto);
    const b = new URL(base);
    return `${b.origin}${u.pathname}${u.search}`;
  } catch {
    return new URL(absoluto || "", base.endsWith("/") ? base : base + "/").href;
  }
};

if (!tem("--dry")) {
  titulo("5. O backend responde?");
  if (!workerUrl) {
    fail("URL do Worker", "passa --url=https://cineclip-cloud.<conta>.workers.dev");
  } else {
    let health = null;
    try {
      const h = await fetch(`${workerUrl}/`, { headers: { "cache-control": "no-store" } });
      health = await j(h);
      if (h.status === 200 && health?.service === "cineclip-cloud") ok(`health ${workerUrl}/ → ${JSON.stringify({ version: health.version, bucket: health.bucket, claims: health.claims })}`);
      else fail("health check do Worker", `HTTP ${h.status}`);
    } catch (e) {
      fail("health check do Worker", e.message);
      nota("401/403 de `workers.dev` com política de acesso? Liga o domínio no dashboard ou usa PUBLIC_BASE.");
    }
    if (health) {
      const local = (/const VERSION = "([\d.]+)"/.exec(fs.readFileSync(WORKER, "utf8")) || [])[1];
      if (local && health.version === local) ok(`a versão online bate certo com o repositório (${local})`);
      else fail("versão online = versão do repositório", `online ${health.version} vs repo ${local} → o deploy não apanhou o código`);
      if (health.bucket === true) ok("binding BUCKET → R2 ligado");
      else fail("binding BUCKET", "o `[[r2_buckets]]` não chegou ao deploy");
      nota(health.presign ? "presign ativo (vídeos > 100 MB por URL pré-assinada)" : "sem presign: vídeos > 100 MB vão falhar (R2_ACCOUNT_ID + chaves S3)");
    }

    if (!tokenStdin) {
      nota("Sem token não testo o /v/:key nem as claims. Para o round-trip completo:");
      nota("  CINECLIP_TOKEN=… npm run cloudflare:renovar -- --so-verificar --url=<URL>");
      nota("  (ou escreve-o no stdin com --token-stdin, que não fica no histórico)");
    } else {
      titulo("6. O que o Instagram vai ler (o /v/:key)");
      const auth = { Authorization: `Bearer ${tokenStdin}` };
      const corpo = Buffer.alloc(1024 * 64, 0x41);
      try {
        const up = await fetch(`${workerUrl}/api/video`, {
          method: "POST",
          headers: { ...auth, "content-type": "video/mp4", "x-file-name": "renovar-check.mp4", "x-file-size": String(corpo.length) },
          body: corpo,
        });
        const upj = await j(up);
        if (up.status !== 200 || !upj?.key) fail("upload de verificação", `HTTP ${up.status} ${JSON.stringify(upj?.error || "").slice(0, 160)}`);
        else {
          ok(`upload → ${upj.key.slice(0, 24)}… (${corpo.length} bytes gravados no R2)`);
          const urlVideo = mesmaOrigem(workerUrl, String(upj.url || `/v/${encodeURIComponent(upj.key)}`));
          nota(`link público tal como o app o vê: ${upj.url}`);
          const completo = await fetch(urlVideo, { headers: { "cache-control": "no-store" } });
          const bytes = Buffer.from(await completo.arrayBuffer());
          if (completo.status === 200 && bytes.length === corpo.length) ok("GET /v/:key → 200 com os bytes todos (chegam intactos)");
          else fail("GET /v/:key", `HTTP ${completo.status}, ${bytes.length} bytes`);
          const sonda = await fetch(urlVideo, { headers: { Range: "bytes=0-1" } });
          const sondaBytes = await sonda.arrayBuffer();
          if (sonda.status === 206 && sondaBytes.byteLength === 2) ok("GET com Range → 206 + 2 bytes (a sonda do app antes de publicar)");
          else fail("GET com Range", `HTTP ${sonda.status}, ${sondaBytes.byteLength} bytes`);
          const cab = await fetch(urlVideo, { method: "HEAD" });
          if (cab.status === 200 && cab.headers.get("content-length") === String(corpo.length)) ok("HEAD → 200 com Content-Length (a outra metade da sonda)");
          else fail("HEAD", `HTTP ${cab.status}/${cab.headers.get("content-length")}`);
          if (String(completo.headers.get("content-type")).startsWith("video/")) ok("Content-Type é vídeo (e não text/html — o sabor do 2207077)");
          else fail("Content-Type do link", String(completo.headers.get("content-type")));

          titulo("7. Claims e cofre");
          const acl = await j(await fetch(`${workerUrl}/api/claims/acquire`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ key: "renovar-check", owner: "renovar:check", ttlMs: 120000 }) }));
          const outro = await j(await fetch(`${workerUrl}/api/claims/acquire`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ key: "renovar-check", owner: "renovar:intruso", ttlMs: 120000 }) }));
          const renova = await j(await fetch(`${workerUrl}/api/claims/acquire`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ key: "renovar-check", owner: "renovar:check", ttlMs: 120000 }) }));
          if (acl?.acquired === true) ok("claim criada");
          else fail("claim criada", JSON.stringify(acl)?.slice(0, 160));
          if (outro?.acquired === false) ok("outro dono é recusado com o holder certo");
          else fail("anti-publicação duplicada", `outro dono obteve acquired:${outro?.acquired}`);
          if (renova?.acquired === true) ok("o mesmo dono renova a sua claim (o retry não se auto-bloqueia)");
          else fail("renovação da claim", JSON.stringify(renova)?.slice(0, 160) + " ← se isto falha, é a regressão da claim presa");
          await fetch(`${workerUrl}/api/claims/release`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ key: "renovar-check", owner: "renovar:check" }) });

          const cofre = JSON.stringify({ renovar: Date.now() });
          const put = await fetch(`${workerUrl}/api/vault/__renovar__`, { method: "PUT", headers: auth, body: cofre });
          const get = await fetch(`${workerUrl}/api/vault/__renovar__`, { headers: { ...auth, "cache-control": "no-store" } });
          if (put.status === 200 && (await get.text()) === cofre) ok("cofre: escrever e ler volta igual");
          else fail("cofre (round-trip)", `PUT ${put.status}`);
          await fetch(`${workerUrl}/api/vault/__renovar__`, { method: "DELETE", headers: auth });

          titulo("8. Espaço no R2 (o plano grátis são 10 GB-mês)");
          const stats = await j(await fetch(`${workerUrl}/api/stats`, { headers: { ...auth, "cache-control": "no-store" } }));
          if (stats?.ok) {
            const gb = (stats.bytes / 1024 ** 3).toFixed(2);
            nota(`${stats.videos} vídeos · ${stats.vaults} cofres · ${stats.claims} claims · ${gb} GB usados`);
            if (stats.bytes > 9 * 1024 ** 3) fail("espaço livre no R2", `${gb} GB dos 10 GB grátis → apaga vídeos já publicados`);
            else ok(`espaço confortável (${gb} GB de 10 GB)`);
            nota(`Para limpar: npx wrangler r2 object delete cineclip-reels/${upj.key} (o vídeo de teste ficou lá)`);
          } else fail("/api/stats", "o backend responde mas não sabe os números");
        }
      } catch (e) {
        fail("verificação autenticada", e.message);
      }
    }
  }
}

/* ------------------------------------------------------------------ fim */

console.log(`\n${failCount === 0 ? "✅" : "❌"} renovação: ${okCount} ok, ${failCount} problema(s)`);
if (falhas.length) {
  console.log("\nPor resolver:");
  falhas.forEach((f) => console.log(`  - ${f}`));
} else if (!tem("--dry")) {
  console.log("\nNo browser: abre o app → Nuvem → ⚙ Testar nuvem R2. Se aí estiver verde,");
  console.log("o Agendador volta a publicar sem 2207077. Se tinhas a URL antiga do Worker");
  console.log("noutro aparelho, volta a colá-la (o deploy não muda a URL, mas muda o código).");
}
process.exit(failCount === 0 ? 0 : 1);
