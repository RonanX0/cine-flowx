/**
 * Presets de formatação do Reel — cópia exata do `PRESETS_DO_REEL` do app
 * (index.html). O bundle é compilado e não pode importar módulos, por isso a
 * tabela vive aqui também; `tools/test-presets.mjs` compara as duas e falha se
 * alguma medida divergir.
 *
 * Os dois formatos foram medidos pixel a pixel em capturas de Reels reais
 * (formato-1.png e formato-2.png, na raiz do repositório):
 *
 *   escuro — fundo preto, gancho fluorescente em duas linhas coladas, caixa do
 *            vídeo 1:1 com 5% de margem lateral, cantos arredondados (~4,6% da
 *            caixa) a começar em 27,4% da altura, e rodapé verde a 93,55%.
 *   claro  — fundo branco, gancho preto, faixa de vídeo 4:3 de ponta a ponta
 *            (100% da largura) entre 30,1% e 72,2% da altura, sem rodapé.
 *
 * Todas as medidas são frações da largura/altura do 9:16 final.
 */
export const PRESETS_DO_REEL = {
  atual: {
    id: "atual",
    nome: "Padrão do app",
    caixa: "auto",
    margem: 0,
    raio: 0,
    topo: 0.46,
    fundo: "preto",
    bgMode: "preto",
    ganchoPill: true,
    ganchoTamanho: 0.062,
    ganchoEntrelinha: 1.28,
    ganchoCor: "#FFFFFF",
    rodapeTamanho: 0,
    rodapeY: 0,
    rodapeCor: "#2DBD2C",
  },
  escuro: {
    id: "escuro",
    nome: "Escuro · caixa 1:1",
    caixa: "quadrado",
    margem: 0.05,
    raio: 0.046,
    topo: 0.274,
    fundo: "preto",
    bgMode: "preto",
    ganchoPill: false,
    ganchoTamanho: 0.072,
    ganchoEntrelinha: 0.88,
    ganchoCor: "#ECFA12",
    rodapeTamanho: 0.049,
    rodapeY: 0.9355,
    rodapeCor: "#2DBD2C",
  },
  claro: {
    id: "claro",
    nome: "Claro · faixa 4:3",
    caixa: "banda",
    margem: 0,
    raio: 0,
    topo: 0.301,
    fundo: "branco",
    bgMode: "branco",
    ganchoPill: false,
    ganchoTamanho: 0.056,
    ganchoEntrelinha: 1.35,
    ganchoCor: "#000000",
    rodapeTamanho: 0,
    rodapeY: 0,
    rodapeCor: "#2DBD2C",
  },
};

/** Preset por id; qualquer valor desconhecido cai no "atual". */
export function presetDoReel(id) {
  return PRESETS_DO_REEL[id] || PRESETS_DO_REEL.atual;
}

/** Proporção (largura/altura) da caixa do vídeo: 1 = quadrado, 4/3 = faixa, 0 = automática. */
export function alvoDaCaixa(preset) {
  return preset.caixa === "quadrado" ? 1 : preset.caixa === "banda" ? 4 / 3 : 0;
}

/**
 * Geometria que o desenho do gancho precisa de conhecer (caixa do vídeo + fundo
 * + rodapé). É o que o app passa ao `_h` e o que o servidor passa ao
 * `imagemDoGancho`, para os cantos arredondados e o rodapé saírem iguais.
 */
export function caixaDoPreset(preset, geo, rodape, rodapeCor) {
  const P = presetDoReel(preset);
  return {
    padX: geo.padX,
    padY: geo.padY,
    videoW: geo.videoW,
    videoH: geo.videoH,
    radius: geo.radius || 0,
    fundo: P.fundo,
    rodape: rodape || "",
    rodapeCor: rodapeCor || P.rodapeCor,
  };
}
