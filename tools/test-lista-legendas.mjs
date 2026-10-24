import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { arrancarApp } from '../servidor/app-headless.mjs';

const root = path.resolve(import.meta.dirname, '..');

let chamadas = 0;
const app = await arrancarApp({ fetchFn: async () => { chamadas++; throw new Error('Rede não deve ser usada para legendas da lista'); } });
try {
  const motor = app.window.CineClipMotor;
  assert.equal(typeof motor.legendasDaLista, 'function', 'motor expõe legendasDaLista');
  assert.equal(motor.comentarioDireto, 'LINK DO FILME NA MINHA B10');
  assert.equal(motor.legendasPadrao.length, 12, '12 legendas prontas');
  assert(motor.legendasPadrao.every((m) => m.includes('{gancho}') && m.includes('#')), 'padrão: {gancho} + hashtags');

  const escolher = (extra = {}) => motor.legendasDaLista(Object.assign({ gancho: 'Um gancho de teste 👀' }, extra));

  // Rotação: a lista inteira antes de repetir; depois recomeça pelo mais antigo.
  motor.configurar({ legendasBoas: '' });
  const modelos = [];
  for (let i = 0; i < motor.legendasPadrao.length; i++) modelos.push(escolher().modelo);
  assert.equal(new Set(modelos).size, 12, 'lista inteira antes de repetir');
  assert.equal(escolher().modelo, modelos[0], 'recomeça pelo mais antigo');

  // {gancho} substituído; sem marcador nenhum; dentro do limite do Instagram.
  const um = escolher();
  assert(um.legenda.includes('Um gancho de teste 👀') && !um.legenda.includes('{gancho}'), '{gancho} substituído');
  assert(um.legenda.length <= 2200, 'cabe no limite de 2200');

  // Sem gancho: a linha do {gancho} sai, mas o resto (CTA/hashtags) fica.
  const semGancho = motor.legendasDaLista({});
  assert(!semGancho.legenda.includes('{gancho}') && semGancho.legenda.includes('#'), 'sem gancho mantém as hashtags');

  // Lista personalizada: blocos por ---, {filme}/{ano}, duplicadas removidas.
  motor.configurar({ legendasBoas: 'Filme: {filme} ({ano})\n{gancho}\n---\nSó hashtags #X\n---\nSó hashtags #X' });
  const p1 = motor.legendasDaLista({ gancho: 'G!', filme: 'Matrix', ano: '1999' });
  assert.equal(p1.legenda, 'Filme: Matrix (1999)\nG!');
  const p2 = motor.legendasDaLista({ gancho: 'G!' });
  assert.equal(p2.legenda, 'Só hashtags #X', 'remove duplicadas e roda');
  const p3 = motor.legendasDaLista({ gancho: 'G!' });
  assert.equal(p3.legenda, 'G!', 'sem filme/ano, a linha {filme} ({ano}) sai');

  // Histórico persistido (modelo cru, antes da substituição).
  const salvo = JSON.parse(app.window.localStorage.getItem('cineclip.legendas.usadas'));
  assert.equal(salvo.at(-1), p3.modelo, 'persiste histórico');

  // Reserva síncrona: duas escolhas seguidas nunca repetem o modelo.
  motor.configurar({ legendasBoas: 'L1\n---\nL2' });
  assert.notEqual(motor.legendasDaLista({}).modelo, motor.legendasDaLista({}).modelo, 'nunca repete em sequência');

  // Limpar a lista nas Configurações restaura a padrão (mesmo com uma antiga no localStorage).
  app.window.localStorage.setItem('cineclip.settings', JSON.stringify({ legendasBoas: 'Lista antiga' }));
  motor.configurar({ legendasBoas: '' });
  assert(motor.legendasPadrao.includes(escolher().modelo), 'limpar lista restaura padrão');

  // Bundle: Estúdio guarda o firstComment sem filme identificado, Configurações têm
  // a lista de legendas e os publicadores (app + Robô 24h) preferem o texto do Reel.
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert(html.includes('firstComment:Pe?void 0:"LINK DO FILME NA MINHA B10"'), 'Estúdio: firstComment sem identificação');
  assert(html.includes('id:"legendasBoas"'), 'Configurações: Lista de legendas prontas');
  assert(html.includes('if(r&&r.firstComment)return'), 'publicador do app prefere o firstComment do Reel');
  assert(html.includes('if (item && item.firstComment) return'), 'Robô 24h prefere o firstComment do Reel');
  assert(html.includes('CineClipMotor.legendasDaLista({gancho:ue'), 'Estúdio gera a legenda da lista no modo Lista');

  assert.equal(chamadas, 0, 'nenhuma requisição de rede');
  console.log('OK: legendas prontas — rotação, {gancho}/{filme}/{ano}, blocos por ---, persistência, reserva síncrona, configuração e bundle; zero rede.');
} finally { app.fechar(); }
