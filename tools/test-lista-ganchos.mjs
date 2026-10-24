import assert from 'node:assert/strict';
import { arrancarApp } from '../servidor/app-headless.mjs';

let chamadas = 0;
const app = await arrancarApp({ fetchFn: async () => { chamadas++; throw new Error('Rede não deve ser usada para ganchos da lista'); } });
try {
  const motor = app.window.CineClipMotor;
  const escolher = (extra = {}) => app.core.gerarGancho('', [], 'pt-BR', '', '', null, null, extra);
  motor.configurar({ ganchosBons: '', ganchosRuins: '' });
  const iniciais = [];
  for (let i = 0; i < motor.ganchosPadrao.length; i++) iniciais.push((await escolher()).ganchos[0]);
  assert.equal(new Set(iniciais).size, motor.ganchosPadrao.length, 'lista inteira antes de repetir');
  assert.equal((await escolher()).ganchos[0], iniciais[0], 'recomeça pelo mais antigo');
  assert(iniciais.every(g => g.length <= 58), 'frases padrão cabem no gancho');
  motor.configurar({ ganchosBons: 'Meu primeiro gancho 👀\nMeu segundo gancho 🎬\nMeu primeiro gancho 👀', ganchosRuins: '' });
  const paralelo = await Promise.all([escolher(), escolher()]);
  assert.equal(new Set(paralelo.map(g => g.ganchos[0])).size, 2, 'reserva síncrona em paralelo');
  assert(paralelo.every(g => g.ganchos.length === 2), 'remove duplicados');
  const salvo = JSON.parse(app.window.localStorage.getItem('cineclip.ganchos.usados'));
  assert.equal(salvo.at(-1), paralelo[1].ganchos[0], 'persiste histórico');
  const evitado = await escolher({ evitar: ['Meu primeiro gancho 👀'] });
  assert.equal(evitado.ganchos[0], 'Meu segundo gancho 🎬');
  motor.configurar({ ganchosBons: 'Um gancho 👀\nOutro gancho 🎬', ganchosRuins: 'Um gancho 👀' });
  assert.deepEqual(Array.from((await escolher()).ganchos), ['Outro gancho 🎬']);
  motor.configurar({ ganchosBons: 'Um gancho 👀', ganchosRuins: 'Um gancho 👀' });
  await assert.rejects(escolher, /Todos os ganchos foram bloqueados/);
  app.window.localStorage.setItem('cineclip.settings', JSON.stringify({ ganchosBons: 'Lista antiga' }));
  motor.configurar({ ganchosBons: '', ganchosRuins: '' });
  assert(motor.ganchosPadrao.includes((await escolher()).ganchos[0]), 'limpar lista restaura padrão');
  assert.equal((await escolher({ hookMode: 'sem_gancho' })).ganchos.length, 0);
  app.lote.cacheIdentGuardar('fraco', { ia: { confianca: 30 }, filme: { id: 1 } });
  assert.equal(app.lote.cacheIdentLer('fraco'), null, 'não grava palpite fraco');
  app.window.localStorage.setItem('cineclip.ident.cache.v1', JSON.stringify({ antigo: { t: Date.now(), v: { ia: { confianca: 40 }, filme: { id: 2 } } } }));
  assert.equal(app.lote.cacheIdentLer('antigo'), null, 'descarta cache antigo de baixa confiança');
  app.lote.cacheIdentGuardar('forte', { ia: { confianca: 92 }, filme: { id: 3 } });
  assert.equal(app.lote.cacheIdentLer('forte').filme.id, 3, 'reutiliza identificação confiável');
  assert.equal(chamadas, 0, 'nenhuma requisição de rede');
  console.log('OK: lista, rotação, concorrência, persistência, bloqueios, configuração e ponte real do servidor; zero rede.');
} finally { app.fechar(); }
