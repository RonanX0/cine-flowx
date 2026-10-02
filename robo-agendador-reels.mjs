#!/usr/bin/env node
/**
 * 🤖 ROBÔ AGENDADOR DE REELS — CINECLIP (Meta Business Suite)
 *
 * Como usar no teu computador:
 * 1) Na pasta do projeto, instala o Playwright uma única vez:
 *      npm install -D playwright
 *      npx playwright install chromium
 *
 * 2) Na aba "Agendador de Reels" do CineClip:
 *    - Baixa os pacotes/vídeos (.mp4) e o arquivo "fila-agendamento-cineclip.json"
 *    - Coloca os arquivos .mp4 e o "fila-agendamento-cineclip.json" na mesma pasta deste script (ou em ~/Downloads)
 *
 * 3) Executa no terminal:
 *      node robo-agendador-reels.mjs
 *
 * Na primeira vez, o navegador abrirá o Meta Business Suite e aguardará que faças login.
 * A sessão fica guardada na pasta "./sessao-meta" para não precisares logar novamente!
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

async function main() {
  let chromium;
  try {
    const pw = await import("playwright");
    chromium = pw.chromium;
  } catch {
    console.error(
      "❌ Playwright não encontrado. Executa primeiro:\n   npm install -D playwright && npx playwright install chromium"
    );
    process.exit(1);
  }

  const possiblePaths = [
    path.resolve(process.cwd(), "fila-agendamento-cineclip.json"),
    path.resolve(os.homedir(), "Downloads", "fila-agendamento-cineclip.json"),
  ];

  const queueFile = possiblePaths.find((p) => fs.existsSync(p));
  if (!queueFile) {
    console.error(
      "❌ Arquivo 'fila-agendamento-cineclip.json' não encontrado na pasta atual nem em Downloads.\n" +
        "   Na aba 'Agendador de Reels' do CineClip, clica em 'Exportar Fila (.json)'."
    );
    process.exit(1);
  }

  const baseDir = path.dirname(queueFile);
  const queue = JSON.parse(fs.readFileSync(queueFile, "utf-8"));
  console.log(`🎬 Fila carregada de: ${queueFile} (${queue.length} Reels)`);

  const userDataDir = path.resolve(process.cwd(), "sessao-meta");
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1360, height: 860 },
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto("https://business.facebook.com/latest/reels_composer", {
    waitUntil: "domcontentloaded",
  });

  console.log(
    "🔐 Se ainda não estiveres logado no Meta Business Suite, faz login na janela aberta..."
  );

  for (const item of queue) {
    const videoPath = [
      path.resolve(baseDir, item.arquivoVideo),
      path.resolve(process.cwd(), item.arquivoVideo),
      path.resolve(os.homedir(), "Downloads", item.arquivoVideo),
    ].find((p) => fs.existsSync(p));

    console.log(`\n--------------------------------------------------`);
    console.log(`📽️  Filme/Série: ${item.titulo}`);
    console.log(`⏰ Agendado para: ${item.agendadoPara}`);
    console.log(`🎞️  Arquivo: ${videoPath || "Não encontrado localmente"}`);

    await page.goto("https://business.facebook.com/latest/reels_composer", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(4000);

    // Tenta anexar o vídeo automaticamente se o input file estiver visível na página
    if (videoPath) {
      try {
        const fileInput = page.locator('input[type="file"]').first();
        await fileInput.setInputFiles(videoPath, { timeout: 15000 });
        console.log("✅ Vídeo enviado para o compositor do Meta Business Suite!");
      } catch {
        console.log(
          "⚠️ Seleciona o ficheiro manualmente na janela se o botão de upload pedir confirmação."
        );
      }
    }

    // Copia a legenda para a área de transferência do navegador e tenta preencher o campo de texto
    await page.evaluate((captionText) => {
      navigator.clipboard?.writeText(captionText).catch(() => {});
    }, item.legenda || "");

    try {
      const textBox = page
        .locator('[role="textbox"][contenteditable="true"]')
        .first();
      await textBox.click({ timeout: 12000 });
      await page.keyboard.insertText(item.legenda || "");
      console.log("✅ Legenda preenchida automaticamente!");
    } catch {
      console.log(
        "📋 A legenda já está na área de transferência (basta pressionar Ctrl+V no campo de descrição)."
      );
    }

    console.log(
      "⏳ Confirma a data/hora no painel do Meta Business Suite e avança. A aguardar 45s antes do próximo item..."
    );
    await page.waitForTimeout(45000);
  }

  console.log("\n🎉 Todos os itens da fila foram processados!");
}

main().catch((err) => {
  console.error("Erro no robô:", err);
});
