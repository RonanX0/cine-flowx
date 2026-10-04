/**
 * 🤖 Gerador do Robô 24h (Apps Script).
 * O script corre nos servidores do Google a cada 5 minutos e publica a fila
 * mesmo com o PC/telemóvel desligados. O corpo do script vive em
 * `robo-script.txt` (importado como texto) e recebe aqui os valores do cofre.
 */
import roboBody from "./robo-script.txt?raw";
import { loadSettings } from "./settings";
import type { Session } from "./types";

export function generateRobo24hScript(session: Session): string {
  const s = loadSettings();
  const cw = String(s.r2WorkerUrl || "").trim().replace(/\/+$/, "");
  const ct = String(s.r2Token || "").trim();
  const du = String(s.driveScriptUrl || "").trim().replace(/\/+$/, "");
  const dt = String(s.driveToken || "").trim();
  const nuvem =
    cw && ct
      ? `Cloudflare R2 ✔ (${cw})`
      : du && dt
        ? `Google Drive ✔ (${du})`
        : "⚠️ SEM NUVEM DURÁVEL — vai usar bytebin/kappa.lol, que EXPIRAM. No CineClip: Configurações → Nuvem durável (o Google Drive é grátis), e volta a copiar este código.";

  const header = `// ============================================================================
// ROBÔ 24H NA NUVEM — CINECLIP STUDIO · versão NUVEM DURÁVEL (Google Drive / Cloudflare R2)
// Conta vinculada: ${session.username}
// Armazenamento: ${nuvem}
// ============================================================================
// COMO ATIVAR EM 30 SEGUNDOS:
// 1. Acede a https://script.google.com → clica em "Novo projeto"
// 2. Apaga tudo, cola este código inteiro e clica no ícone do Disquete 💾 (Guardar)
// 3. No menu superior (ao lado de "Executar"), seleciona "ativarRobo24h" e clica em ▶ Executar
// 4. Autoriza a tua conta Google quando pedir. PRONTO! Corre a cada 5 minutos, 24h/dia,
//    com o PC e o celular 100% desligados.
//
// Funções de diagnóstico: "estadoDaFila", "testarLigacaoDrive" e "testarLigacaoR2".
// ============================================================================

`;

  const body = roboBody
    .replaceAll('"${r.vaultHash}"', JSON.stringify(session.vaultHash))
    .replaceAll('"${r.encryptionKeyB64}"', JSON.stringify(session.encryptionKeyB64))
    .replaceAll('"${cw}"', JSON.stringify(cw))
    .replaceAll('"${ct}"', JSON.stringify(ct))
    .replaceAll('"${du}"', JSON.stringify(du))
    .replaceAll('"${dt}"', JSON.stringify(dt));

  return header + body;
}

/** Guarda da regressão: o robô gerado tem de ser o robô a sério. */
export function assertRobo24hSadio(script: string): string[] {
  const problems: string[] = [];
  if (!/ScriptApp\.newTrigger\("verificarEPostarReels"\)[\s\S]*?everyMinutes\(5\)/.test(script))
    problems.push("acionador de 5 em 5 minutos em falta");
  if (!/graph\.facebook\.com/.test(script)) problems.push("publicação pela Graph API em falta");
  if (!/reclamarPublicacao|claim/i.test(script)) problems.push("claims anti-duplicado em falta");
  if (/device_scheduled_only|modo.s[oó].manual/i.test(script)) problems.push("vestígios do modo só-manual");
  if (script.includes("${")) problems.push("placeholder por substituir no script gerado");
  return problems;
}
