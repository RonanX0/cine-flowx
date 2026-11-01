#!/usr/bin/env node
/**
 * Aba «📊 Métricas» (metricas.js) — o código real, num DOM do jsdom, com a fila
 * e a Graph API do Instagram simuladas.
 *
 *   node tools/test-metricas.mjs
 *
 * O que se fixa aqui:
 *   • só entram os Reels PUBLICADOS da conta ativa, do mais recente ao mais antigo;
 *   • curtidas/comentários vêm dos campos do media, o resto dos insights;
 *   • se a API recusar o pedido conjunto de insights, refaz um a um e fica com
 *     o que funcionar (a que falhar fica para preencher à mão);
 *   • o que foi escrito à mão NÃO é apagado por uma atualização automática;
 *   • tudo é gravado no próprio Reel (guardarNaFila) com o updatedAt a subir,
 *     para a sincronização com a nuvem o levar;
 *   • sem token, ou com token expirado, a mensagem diz o que fazer.
 */
import fs from "node:fs";
import { JSDOM } from "jsdom";

let pass = 0, fail = 0;
const falhas = [];
const check = (n, ok, d = "") => {
  if (ok) { pass++; console.log(`   ✔ ${n}`); }
  else { fail++; falhas.push(n); console.log(`   ❌ ${n}${d ? " — " + d : ""}`); }
};
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const CODIGO = fs.readFileSync(new URL("../metricas.js", import.meta.url), "utf8");

function fila() {
  return [
    { id: "r1", accountId: "acc_a", status: "published", publishedId: "1801", publishedUrl: "https://instagram.com/reel/AAA", title: "Se Beber, Não Case!", publishedAt: "2026-10-30T12:00:00Z" },
    { id: "r2", accountId: "acc_a", status: "published", publishedId: "1802", publishedUrl: "https://instagram.com/reel/BBB", title: "A Pequena Sereia", publishedAt: "2026-10-31T18:00:00Z" },
    { id: "r3", accountId: "acc_a", status: "scheduled", title: "Ainda não publicado", scheduledAt: "2026-11-02T12:00" },
    { id: "r4", accountId: "acc_b", status: "published", publishedId: "1899", title: "Da outra conta", publishedAt: "2026-10-31T20:00:00Z" },
    { id: "r5", accountId: "acc_a", status: "published", title: "Publicado fora do app (sem id)", publishedAt: "2026-10-29T09:00:00Z" },
  ];
}

/**
 * Graph API simulada. `recusarConjunto` faz o pedido com várias métricas
 * falhar (como a API faz quando uma delas já não existe), e `semFollows`
 * faz a métrica `follows` falhar sozinha.
 */
function graph({ recusarConjunto = false, semFollows = false, erroToken = false } = {}) {
  const pedidos = [];
  const dados = {
    1801: { like_count: 1200, comments_count: 85, views: 45000, reach: 30000, shares: 310, saved: 140, follows: 22 },
    1802: { like_count: 800, comments_count: 40, views: 20000, reach: 15000, shares: 90, saved: 60, follows: 9 },
  };
  const responder = (status, corpo) => ({ ok: status === 200, status, json: async () => corpo });
  const fetch = async (url) => {
    const u = new URL(url);
    pedidos.push(u.pathname + u.search.replace(/access_token=[^&]+/, "access_token=***"));
    if (erroToken) return responder(400, { error: { message: "Error validating access token: Session has expired", code: 190 } });
    const partes = u.pathname.split("/").filter(Boolean); // [v22.0, id] ou [v22.0, id, insights]
    const id = partes[1];
    const d = dados[id];
    if (!d) return responder(400, { error: { message: "Unsupported get request", code: 100 } });
    if (partes[2] !== "insights") {
      return responder(200, { id, like_count: d.like_count, comments_count: d.comments_count });
    }
    const metricas = (u.searchParams.get("metric") || "").split(",");
    if (metricas.length > 1 && recusarConjunto) {
      return responder(400, { error: { message: "(#100) metric[4] must be one of the following values: views, reach, shares, saved", code: 100 } });
    }
    if (semFollows && metricas.includes("follows")) {
      return responder(400, { error: { message: "(#100) follows is not supported for this media", code: 100 } });
    }
    return responder(200, { data: metricas.map((m) => ({ name: m, period: "lifetime", values: [{ value: d[m] }] })) });
  };
  return { fetch, pedidos };
}

function criar({ token = "EAAtoken", g = graph(), itens = fila() } = {}) {
  const dom = new JSDOM('<!doctype html><head></head><body><div id="cc-metricas-monte"></div></body>', {
    url: "https://exemplo.test/", runScripts: "outside-only", pretendToBeVisual: true,
  });
  const w = dom.window;
  const gravados = [];
  const base = itens.map((x) => ({ ...x }));
  w.CineClipCore = {
    lerFila: async () => base.map((x) => ({ ...x })),
    guardarNaFila: async (item) => {
      gravados.push(JSON.parse(JSON.stringify(item)));
      const i = base.findIndex((b) => b.id === item.id);
      if (i >= 0) base[i] = JSON.parse(JSON.stringify(item));
    },
  };
  w.__CineClipApp = { account: { id: "acc_a", name: "@cena.seguinte", metaAccessToken: token, igUserId: "17841" } };
  w.eval(CODIGO);
  const M = w.CineMetricas;
  M._interno.ambiente.fetch = g.fetch;
  return { w, M, g, gravados, base, texto: () => w.document.getElementById("cc-metricas-monte").textContent };
}

console.log("\n📊 Lista: só os publicados da conta ativa");
{
  const c = criar();
  const itens = await c.M.carregar();
  check("entram só os Reels publicados da conta ativa", itens.length === 3 && itens.every((i) => i.status === "published" && i.accountId === "acc_a"), itens.map((i) => i.id).join(","));
  check("do mais recente para o mais antigo", itens.map((i) => i.id).join(",") === "r2,r1,r5", itens.map((i) => i.id).join(","));
  check("o agendado e o da outra conta ficam de fora", !itens.some((i) => i.id === "r3" || i.id === "r4"));
  check("desenha uma linha por Reel", c.w.document.querySelectorAll(".cm-lista .cm-reel").length === 3);
  check("o título liga para o Reel no Instagram", !!c.w.document.querySelector('a[href="https://instagram.com/reel/BBB"]'));
  c.w.close();
}

console.log("\n🔄 Busca automática no Instagram");
{
  const c = criar();
  await c.M.carregar();
  await c.M.atualizarTudo(false);
  const r1 = c.base.find((b) => b.id === "r1").metricas;
  check("curtidas e comentários vêm dos campos do media", r1.likes === 1200 && r1.comments === 85, JSON.stringify(r1));
  check("views, alcance, compart., salvos e seguidores vêm dos insights", r1.views === 45000 && r1.reach === 30000 && r1.shares === 310 && r1.saved === 140 && r1.follows === 22, JSON.stringify(r1));
  check("os insights vêm num só pedido quando a API aceita", c.g.pedidos.filter((p) => /insights/.test(p)).length === 2, c.g.pedidos.join(" | "));
  check("o Reel sem id do Instagram não gera pedido nenhum", !c.g.pedidos.some((p) => /undefined|null/.test(p)));
  check("grava no próprio Reel (guardarNaFila)", c.gravados.some((g) => g.id === "r1" && g.metricas && g.metricas.views === 45000));
  check("o updatedAt sobe, para a nuvem levar a alteração", c.gravados.every((g) => typeof g.updatedAt === "number" && g.updatedAt > 0));
  check("o token não aparece na lista de pedidos registada", c.g.pedidos.every((p) => !/EAAtoken/.test(p)));
  c.w.close();
}

console.log("\n🧩 A API recusa o pedido conjunto → refaz um a um");
{
  const c = criar({ g: graph({ recusarConjunto: true, semFollows: true }) });
  await c.M.carregar();
  await c.M.atualizarTudo(false);
  const r1 = c.base.find((b) => b.id === "r1").metricas;
  check("mesmo com o conjunto recusado, vêm views e alcance", r1.views === 45000 && r1.reach === 30000, JSON.stringify(r1));
  check("compartilhamentos e salvos também", r1.shares === 310 && r1.saved === 140);
  check("a métrica que a API não deu fica vazia (não inventa)", r1.follows == null, String(r1.follows));
  check("e fica marcada para preencher à mão", Array.isArray(r1.semApi) && r1.semApi.includes("follows"), JSON.stringify(r1.semApi));
  check("sem erro geral: os campos básicos vieram", !r1.erroApi, r1.erroApi);
  c.w.close();
}

console.log("\n✍️ O que foi escrito à mão ganha à atualização automática");
{
  const c = criar();
  await c.M.carregar();
  const item = c.M._interno.estado.itens.find((i) => i.id === "r1");
  c.M._interno.editar(item, "views", "50.000");
  c.M._interno.editar(item, "follows", "30");
  await dormir(800); // espera a gravação com atraso
  check("o número escrito à mão é lido sem pontos de milhar", item.metricas.views === 50000, String(item.metricas.views));
  check("fica marcado como manual", item.metricas.manual.views === true && item.metricas.manual.follows === true);
  check("grava depois de parar de escrever", c.gravados.some((g) => g.id === "r1" && g.metricas && g.metricas.views === 50000));

  await c.M._interno.atualizarItem(item);
  check("a atualização automática NÃO apaga as views escritas à mão", item.metricas.views === 50000, String(item.metricas.views));
  check("nem os seguidores escritos à mão", item.metricas.follows === 30, String(item.metricas.follows));
  check("mas preenche o que não foi mexido", item.metricas.likes === 1200 && item.metricas.reach === 30000);

  c.M._interno.editar(item, "views", "");
  check("apagar o campo tira a marca de manual", !item.metricas.manual.views && item.metricas.views == null);
  c.w.close();
}

console.log("\n🔑 Sem token, ou com o token expirado");
{
  const c = criar({ token: "" });
  await c.M.carregar();
  await c.M.atualizarTudo(false);
  check("sem token não faz pedido nenhum", c.g.pedidos.length === 0);
  check("e diz que dá para preencher à mão", /token do Instagram/.test(c.M._interno.estado.aviso) && /à mão/.test(c.M._interno.estado.aviso), c.M._interno.estado.aviso);
  check("o botão de atualizar tudo fica desligado", !!Array.from(c.w.document.querySelectorAll("button")).find((b) => /Atualizar tudo/.test(b.textContent))?.disabled);
  c.w.close();
}
{
  const c = criar({ g: graph({ erroToken: true }) });
  await c.M.carregar();
  await c.M.atualizarTudo(false);
  const r1 = c.M._interno.estado.itens.find((i) => i.id === "r1").metricas;
  check("token expirado: a mensagem diz para gerar um novo", /expirou/.test(r1.erroApi || ""), r1.erroApi);
  check("e o aviso geral também mostra o erro", /com erro/.test(c.M._interno.estado.aviso), c.M._interno.estado.aviso);
  c.w.close();
}

console.log("\n🧮 Totais e engajamento");
{
  const c = criar();
  await c.M.carregar();
  await c.M.atualizarTudo(false);
  const t = c.M._interno.totais();
  check("soma as views dos Reels", t.views === 65000, String(t.views));
  check("soma os seguidores ganhos", t.follows === 31, String(t.follows));
  // (1200+85+310+140 + 800+40+90+60) / (30000+15000) = 2725 / 45000
  check("engajamento = interações ÷ alcance", Math.abs(t.engajamento - 2725 / 45000) < 1e-9, String(t.engajamento));
  check("o Reel sem números não estraga a soma", t.views_n === 2, String(t.views_n));
  c.w.close();
}

console.log("\n🎨 Cartões, ordem e botão de cada Reel");
{
  const c = criar();
  await c.M.carregar();
  await c.M.atualizarTudo(false);
  const doc = c.w.document;
  const valorDe = (id, campo) => doc.querySelector(`.cm-reel[data-id="${id}"] input[id$="-${campo}"]`).value;
  check("os números aparecem com ponto de milhar", valorDe("r1", "views") === "45.000", valorDe("r1", "views"));
  check("o engajamento de cada Reel aparece no cartão", /5,8% eng\./.test(doc.querySelector('.cm-reel[data-id="r1"] .cm-eng').textContent), doc.querySelector('.cm-reel[data-id="r1"] .cm-eng').textContent);
  const sel = doc.querySelector("select.cm-ordem");
  sel.value = "views";
  sel.dispatchEvent(new c.w.Event("change"));
  const ordem = Array.from(doc.querySelectorAll(".cm-lista .cm-reel")).map((x) => x.getAttribute("data-id")).join(",");
  check("«Mais views» põe o Reel com mais views primeiro e o sem números no fim", ordem === "r1,r2,r5", ordem);
  check("ordenar não mexe na ordem guardada", c.M._interno.estado.itens.map((i) => i.id).join(",") === "r2,r1,r5");
  const antes = c.g.pedidos.length;
  doc.querySelector('.cm-reel[data-id="r2"] button').click();
  await dormir(50);
  check("o ↻ do cartão busca só aquele Reel", c.g.pedidos.length - antes === 2 && c.g.pedidos.slice(antes).every((p) => /1802/.test(p)), c.g.pedidos.slice(antes).join(" | "));
  check("o Reel sem id do Instagram tem o ↻ desligado", doc.querySelector('.cm-reel[data-id="r5"] button').disabled === true);
  c.w.close();
}

console.log("\n─────────────────────────────────────────────");
if (fail) { console.log(`❌ ${pass} passaram, ${fail} falharam:`); falhas.forEach((f) => console.log("   • " + f)); process.exit(1); }
console.log(`✅ ${pass} passaram, 0 falharam`);
process.exit(0);
