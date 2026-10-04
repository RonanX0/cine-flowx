/**
 * Testes de lógica pura contra o código-fonte real (src/):
 * fila/horários, geometria 9:16, legenda, cofre (crypto), robô 24h e sonda de links.
 */
import http from "node:http";
import { bundleTs, check, section, finish, setupDom } from "./test-helper.mjs";

await setupDom();
const mod = await import(await bundleTs("tools/tests-entry-logic.ts", "tools/.t-logic.mjs"));
const { nextFreeSlot, computeGeometry, normalizeCaption, deriveSession, encryptVault, decryptVault, generateRobo24hScript, assertRobo24hSadio, igProbeVideoUrl, stripMd, boostPoster } = mod;

section("fila e horários");
{
  const slot = nextFreeSlot([], ["12:00", "18:00"], "acc_default");
  check("próximo horário livre devolve HH:MM futuro", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(slot), slot);
  const taken = [{ id: "a", scheduledAt: slot, status: "scheduled", accountId: "acc_default" }];
  const slot2 = nextFreeSlot(taken, ["12:00", "18:00"], "acc_default");
  check("horário ocupado é saltado", slot2 !== slot, `${slot} vs ${slot2}`);
}

section("geometria 9:16");
{
  const g = computeGeometry(1920, 1080, null, 720);
  check("saída 720×1280", g.outWidth === 720 && g.outHeight === 1280, JSON.stringify(g));
  check("30% de espaço p/ gancho no topo", g.padY === 384, String(g.padY));
  const gc = computeGeometry(1920, 1080, { top: 140, bottom: 140, vw: 1920, vh: 1080 }, 720);
  check("corte de barras ativo", gc.hasCrop === true && gc.cropY === 140, JSON.stringify(gc));
}

section("legenda");
{
  const media = { kind: "movie", title: "Matrix", original: "The Matrix", year: 1999 };
  const raw = `QUER ASSISTIR A ESTE FILME? LINK NA BIO! 🎬\n\n🎬 Matrix (The Matrix)\n\nParágrafo um com gancho forte e tom de trailer épico sem spoilers nenhuns.\n\nParágrafo dois com transição e **momento de tensão** — sentindo o pânico, o desespero e a angústia —.\n\nParágrafo três de fecho curto e intenso.\n\n#Matrix #Filme #Cinema #SciFi #Extra`;
  const out = normalizeCaption(raw, media, "QUER ASSISTIR A ESTE FILME? LINK NA BIO! 🎬");
  check("máx. 4 hashtags", (out.match(/#[\p{L}\p{N}_]+/gu) || []).length === 4, out);
  check("primeira linha literal", out.startsWith("QUER ASSISTIR A ESTE FILME? LINK NA BIO! 🎬"));
  check("linha do título exata", out.includes("🎬 Matrix (The Matrix)"));
  check("stripMd remove negrito", stripMd("a **b** c") === "a b c");
  check("boostPoster eleva capa", boostPoster("https://image.tmdb.org/t/p/w300/x.jpg").includes("/w780/"));
}

section("cofre (criptografia compatível)");
{
  const s = await deriveSession("Teste", "senha123");
  check("vaultHash 20 hex", /^[0-9a-f]{20}$/.test(s.vaultHash), s.vaultHash);
  const s2 = await deriveSession("teste", "senha123");
  check("username normalizado", s.vaultHash === s2.vaultHash);
  const cipher = await encryptVault({ queue: [{ id: "r1" }] }, s.encryptionKeyB64);
  const back = await decryptVault(cipher, s.encryptionKeyB64);
  check("round-trip AES/XOR v2", back.queue[0].id === "r1");
  let wrong = null;
  try {
    await decryptVault(cipher, (await deriveSession("outro", "senha123")).encryptionKeyB64);
  } catch (e) {
    wrong = e;
  }
  check("chave errada falha", !!wrong);
}

section("robô 24h");
{
  localStorage.setItem("cineclip.settings", JSON.stringify({ driveScriptUrl: "/drive-api", driveToken: "t" }));
  const s = await deriveSession("robo", "senha123");
  const script = generateRobo24hScript(s);
  check("contém o hash do cofre", script.includes(`"${s.vaultHash}"`));
  check("sem placeholders por substituir", !script.includes("${"));
  check("sadio segundo a guarda", assertRobo24hSadio(script).length === 0, JSON.stringify(assertRobo24hSadio(script)));
}

section("sonda de links (como a Meta)");
{
  const server = http.createServer((req, res) => {
    const body = Buffer.alloc(100, 1);
    if (req.url?.startsWith("/ok")) {
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", "100");
      res.statusCode = 200;
      res.end(req.method === "HEAD" ? undefined : body);
    } else if (req.url?.startsWith("/nohead")) {
      if (req.method === "HEAD") {
        res.statusCode = 405;
        res.end();
      } else {
        res.setHeader("Content-Type", "video/mp4");
        res.statusCode = 200;
        res.end(body);
      }
    } else {
      res.statusCode = 404;
      res.end("nope");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  check("link saudável → ok", (await igProbeVideoUrl(`${base}/ok/v.mp4`)).estado === "ok");
  check("GET sem HEAD → fraco", (await igProbeVideoUrl(`${base}/nohead/v.mp4`)).estado === "fraco");
  check("404 → morto", (await igProbeVideoUrl(`${base}/dead/v.mp4`)).estado === "morto");
  server.close();
}

finish();
