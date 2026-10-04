/**
 * Arranque da aplicação: renderiza <App/> com react-dom/server num DOM falso.
 * Apanha erros de import, hooks fora de componente e quebras no primeiro render
 * (ecrã de login sem sessão).
 */
import { bundleTs, check, section, finish, setupDom } from "./test-helper.mjs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

await setupDom();

// main.tsx monta em #root — em Node isso falharia; importamos App diretamente.
const { default: App } = await import(await bundleTs("tools/tests-entry-app.ts", "tools/.t-app.mjs"));

section("render inicial (sem sessão)");
let html = "";
let erro = null;
try {
  html = renderToStaticMarkup(React.createElement(App));
} catch (e) {
  erro = e;
}
check("App renderiza sem lançar", erro === null, erro ? String(erro).slice(0, 300) : "");
check("mostra ecrã de login", /CineClip|Entrar|Utilizador|Palavra-passe/i.test(html), html.slice(0, 200));

section("render inicial (com sessão)");
localStorage.setItem(
  "cineclip.auth.session",
  JSON.stringify({ username: "teste", vaultHash: "0123456789abcdef0123", encryptionKeyB64: "abc", ts: Date.now() }),
);
localStorage.setItem(
  "cineclip.settings",
  JSON.stringify({ driveScriptUrl: "https://script.google.com/macros/s/x/exec", driveToken: "t" }),
);
let html2 = "";
let erro2 = null;
try {
  html2 = renderToStaticMarkup(React.createElement(App));
} catch (e) {
  erro2 = e;
}
check("App autenticada renderiza", erro2 === null, erro2 ? String(erro2).slice(0, 300) : "");
check("mostra separadores Estúdio/Agendador", /Est[uú]dio/.test(html2) && /Agendador/.test(html2), html2.slice(0, 300));

finish();
