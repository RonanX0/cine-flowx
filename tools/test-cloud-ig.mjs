/**
 * Testes de integração da nuvem durável (src/lib/cloud.ts) contra os mocks reais
 * usados no dev (R2 worker + Apps Script Drive): upload, links públicos, cofre e
 * claims anti-duplicação.
 */
import http from "node:http";
import fs from "node:fs";
import { bundleTs, check, section, finish, setupDom } from "./test-helper.mjs";
import { createMockCloud } from "./mock-r2-worker.mjs";
import { createMockDrive } from "./mock-drive-backend.mjs";

await setupDom();
const storeDir = fs.mkdtempSync("/tmp/cineclip-cloud-test-");
const handleCloud = createMockCloud({ storeDir, noClaims: false });
const handleDrive = createMockDrive({ storeDir, singleMaxMb: 1 });

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://localhost");
    if (u.pathname === "/cloud" || u.pathname.startsWith("/cloud/")) {
      return await handleCloud(req, res, u.pathname.replace(/^\/cloud/, "") || "/");
    }
    if (u.pathname === "/drive") return await handleDrive(req, res);
    res.statusCode = 404;
    res.end("nope");
  } catch (e) {
    res.statusCode = 500;
    res.end(String(e));
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

localStorage.setItem(
  "cineclip.settings",
  JSON.stringify({
    cloudProvider: "r2",
    r2WorkerUrl: `${base}/cloud`,
    r2Token: "cc_r2_token_de_teste",
    r2MaxMb: 200,
    driveScriptUrl: `${base}/drive`,
    driveToken: "cc_drive_token_de_teste",
  }),
);

const mod = await import(await bundleTs("tools/tests-entry-cloud.ts", "tools/.t-cloud.mjs"));
const { uploadVideo, verifyPublicUrl, putVault, getVaultCipher, claimPublish, releaseClaim, activeClaims, healthCheck, classifyUrl } = mod;

const blob = new Blob([new Uint8Array(200_000).map((_, i) => i % 251)], { type: "video/mp4" });

section("Cloudflare R2 (direto)");
{
  const url = await uploadVideo(blob, "teste-r2.mp4", { owner: "teste" });
  check("upload devolve URL pública", /^https?:\/\//.test(url), url);
  check("classificado como r2", classifyUrl(url) === "r2", classifyUrl(url));
  check("link público verifica (HEAD/GET bytes)", await verifyPublicUrl(url));
}

section("claims anti-duplicação (R2)");
{
  const item = { id: "r1", vaultHash: "0123456789abcdef0123" };
  const a = await claimPublish(item, { owner: "maquina-a", ownerLabel: "A" });
  check("primeira máquina reserva", a.ok === true, JSON.stringify(a));
  const b = await claimPublish(item, { owner: "maquina-b", ownerLabel: "B" });
  check("segunda máquina fica em espera", b.ok === false && b.reason === "held", JSON.stringify(b));
  const a2 = await claimPublish(item, { owner: "maquina-a" });
  check("dono renova o claim", a2.ok === true, JSON.stringify(a2));
  const claims = await activeClaims();
  check("claim visível em activeClaims", claims.some((c) => c.key.includes("r1")));
  const rel = await releaseClaim(a2);
  check("libertação ok", rel.ok === true, JSON.stringify(rel));
  const c = await claimPublish(item, { owner: "maquina-b", ownerLabel: "B" });
  check("após libertação outra máquina avança", c.ok === true, JSON.stringify(c));
  await releaseClaim(c);
}

section("cofre encriptado (R2)");
{
  const put = await putVault("0123456789abcdef0123", "CIPHERTEXT-DE-TESTE");
  check("putVault ok", put.ok === true, JSON.stringify(put));
  const back = await getVaultCipher("0123456789abcdef0123", "maquina-x");
  check("getVaultCipher devolve o mesmo ciphertext", back?.data === "CIPHERTEXT-DE-TESTE", JSON.stringify(back));
}

section("Google Drive (Apps Script mock, 2 MB chunks)");
{
  localStorage.setItem(
    "cineclip.settings",
    JSON.stringify({
      cloudProvider: "drive",
      r2WorkerUrl: `${base}/cloud`,
      r2Token: "cc_r2_token_de_teste",
      driveScriptUrl: `${base}/drive`,
      driveToken: "cc_drive_token_de_teste",
    }),
  );
  const url = await uploadVideo(blob, "teste-drive.mp4", { owner: "teste" });
  check("upload devolve URL de vídeo", typeof url === "string" && url.length > 10, url);
  check("link público verifica", await verifyPublicUrl(url));
}

section("diagnóstico");
{
  const h = await healthCheck();
  check("healthCheck reporta provedores ligados", h.ok === true && Array.isArray(h.steps) && h.steps.length >= 1, JSON.stringify(h).slice(0, 200));
}

server.close();
fs.rmSync(storeDir, { recursive: true, force: true });
finish();
