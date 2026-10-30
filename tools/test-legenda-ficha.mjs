/**
 * Legenda em ficha técnica (motor-ia.js: montarFicha / dadosFicha).
 *
 * Esta legenda vai para o Reel público, por isso o que se testa aqui é
 * sobretudo o que ela NÃO pode fazer: inventar campos, imprimir "undefined",
 * mostrar nota do IMDb (o TMDB não a fornece) ou estourar o limite do
 * Instagram perdendo o CTA pelo caminho.
 */
import assert from 'node:assert/strict';
import { arrancarApp } from '../servidor/app-headless.mjs';

const app = await arrancarApp({ fetchFn: async () => { throw new Error('Rede não deve ser usada por montarFicha'); } });
let pass = 0;
const ok = (nome, cond, detalhe = '') => {
  assert(cond, `${nome}${detalhe ? ' — ' + detalhe : ''}`);
  pass++;
  console.log(`   ✔ ${nome}`);
};

try {
  const motor = app.window.CineClipMotor;
  ok('motor expõe montarFicha e dadosFicha', typeof motor.montarFicha === 'function' && typeof motor.dadosFicha === 'function');

  const completo = {
    ehSerie: false,
    titulo: 'Se Beber, Não Case!',
    original: 'The Hangover',
    ano: '2009',
    generos: ['Comédia', 'Aventura'],
    duracao: '~1h40min',
    pais: 'Estados Unidos',
    bandeira: '🇺🇸',
    classificacao: '16 anos',
    sinopse: 'Três amigos acordam sem memória da despedida de solteiro e sem o noivo.',
    elenco: [
      { nome: 'Bradley Cooper', papel: 'Phil' },
      { nome: 'Ed Helms', papel: 'Stu' },
      { nome: 'Zach Galifianakis', papel: 'Alan' },
    ],
    diretor: 'Todd Phillips',
    slogan: 'Some guys just can’t handle Vegas.',
    temporadas: 0,
    episodios: 0,
    estreia: '2009-06-05',
    temas: ['las vegas', 'despedida de solteiro', 'amizade'],
  };

  console.log('\n🎬 Ficha completa');
  const f = motor.montarFicha(completo, {});
  ok('abre com o título e o ano', f.startsWith('🎬 Filme: Se Beber, Não Case! (2009)'), f.split('\n')[0]);
  ok('traz título original, gênero, duração, país e classificação',
    /📘 Título original: The Hangover/.test(f) && /🎭 Gênero: Comédia \| Aventura/.test(f) &&
    /⏰ Duração: ~1h40min/.test(f) && /🌍 País: Estados Unidos 🇺🇸/.test(f) &&
    /🏆 Classificação Indicativa: 16 anos/.test(f));
  ok('lista o elenco com os personagens', /🔹 Bradley Cooper como Phil/.test(f) && /🔹 Ed Helms como Stu/.test(f));
  ok('traz a sinopse', /📜 Sinopse:\nTrês amigos acordam/.test(f));
  ok('fecha com o CTA da B10', f.trimEnd().endsWith('🔗 Assista no LINK DA B10'), f.slice(-60));

  console.log('\n🎯 Curiosidades só com fatos do TMDB');
  const cur = f.split('🎯 Curiosidades:')[1].split('\n').filter((l) => l.startsWith('🔹'));
  ok('no máximo três', cur.length > 0 && cur.length <= 3, String(cur.length));
  ok('saem do slogan, da direção e da estreia — nada inventado',
    cur.some((c) => c.includes('slogan')) && cur.some((c) => c.includes('Todd Phillips')), cur.join(' | '));

  console.log('\n🚫 O que a ficha nunca faz');
  ok('não mostra nota do IMDb', !/IMDb/i.test(f));
  ok('nunca imprime undefined ou null', !/undefined|null|NaN/.test(f));

  const vazio = motor.montarFicha({
    ehSerie: false, titulo: 'Filme Só Com Nome', original: '', ano: '', generos: [], duracao: '',
    pais: '', bandeira: '', classificacao: '', sinopse: '', elenco: [], diretor: '', slogan: '',
    temporadas: 0, episodios: 0, estreia: '', temas: [],
  }, {});
  ok('campo sem dado é campo que não aparece',
    !/Título original|Gênero|Duração|País|Classificação|Elenco|Sinopse|Curiosidades/.test(vazio), vazio);
  ok('mesmo vazia, mantém título e CTA',
    /🎬 Filme: Filme Só Com Nome/.test(vazio) && vazio.includes('🔗 Assista no LINK DA B10'));
  ok('sem título confirmado, recusa montar', (() => {
    try { motor.montarFicha({ titulo: '' }, {}); return false; } catch (_) { return true; }
  })());

  console.log('\n📺 Séries');
  const serie = motor.montarFicha(Object.assign({}, completo, {
    ehSerie: true, titulo: 'The Rookie', original: 'The Rookie', temporadas: 4, episodios: 21,
  }), {});
  ok('diz «Série», não «Filme»', serie.startsWith('🎬 Série: The Rookie (4 temporadas)'), serie.split('\n')[0]);
  ok('conta temporadas e episódios nas curiosidades', /4 temporadas e 21 episódios/.test(serie));
  ok('título original igual ao título não se repete', !/📘 Título original/.test(serie));
  ok('temporada e episódio do pedido ganham do padrão',
    motor.montarFicha(Object.assign({}, completo, { ehSerie: true, temporadas: 4 }), { temporadaEpisodio: 'Temp. 4, Ep. 21' })
      .startsWith('🎬 Série: Se Beber, Não Case! (Temp. 4, Ep. 21)'));

  console.log('\n📏 Limite do Instagram');
  const longa = motor.montarFicha(Object.assign({}, completo, { sinopse: 'A'.repeat(4000) }), {});
  ok('nunca passa de 2200 caracteres', longa.length <= 2200, String(longa.length));
  ok('corta a sinopse, não o CTA', longa.trimEnd().endsWith('🔗 Assista no LINK DA B10'), longa.slice(-50));
  ok('mantém a ficha de cima intacta', /📘 Título original: The Hangover/.test(longa) && /🌟 Elenco Principal:/.test(longa));

  console.log('\n🔑 Sem chave TMDB');
  motor.configurar({ tmdbKey: '' });
  let recusou = false;
  try { await motor.legendaFicha({ id: 1, kind: 'movie' }, {}); } catch (e) { recusou = /TMDB/.test(e.message); }
  ok('a ficha exige a chave TMDB e diz isso', recusou);

  console.log('\n─────────────────────────────────────────────');
  console.log(`✅ ${pass} passaram, 0 falharam`);
  process.exit(0);
} catch (e) {
  console.log(`\n❌ falhou: ${e.message}`);
  process.exit(1);
} finally {
  if (app && typeof app.fechar === 'function') app.fechar();
}
