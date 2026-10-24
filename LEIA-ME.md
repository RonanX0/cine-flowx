# Correção CineClip — lista de ganchos

Preparada sobre RonanX0/cine-flowx, commit 378a1531c97a404a7bcfbff6dbf66cd51605dc7d.
A integração GitHub recusou a escrita (403 Resource not accessible by integration).
Nenhuma alteração foi enviada ao GitHub nem publicada no site.

## Alterações
- Modo padrão usa 24 ganchos prontos sem analisar a cena nem chamar IA.
- Configurações → Lista de ganchos: uma frase por linha; vazio usa a lista pronta.
- Rotação com histórico local, bloqueios e consideração da fila persistida.
- Estilos com IA permanecem opcionais.
- Modo sem identificação deixa de extrair áudio/preparar vídeo para IA.
- Cache deixa de armazenar e reutilizar identificações abaixo de 65% de confiança.
- Patches reproduzíveis do bundle e testes atualizados.

## Aplicar
Na raiz de uma cópia limpa do repositório, crie uma branch e execute:

    git apply --check /caminho/cine-flowx-ganchos.patch
    git apply /caminho/cine-flowx-ganchos.patch
    npm ci
    npm run ganchos:test
    npm run lote:test
    npm run build

A pasta arquivos-alterados contém as versões completas para consulta.
Não substitua arquivos se o repositório tiver avançado sem comparar as alterações.

## Validação
Passaram: build, TypeScript, sintaxe/reaplicação dos patches, teste novo da lista
com zero rede e cache, lotes (77), identificação (26), provedores (52), identificação
legada (101), compartilhamento (40), botão colar (21), nuvem no app (29), publicação
Instagram (99), agendador (11), horários (17), agendamento rápido (62), barras (8),
presets (114), importação (54), build/cache (73), tendências (35) e interface de
tendências (24), além do proxy de busca.

A suíte completa NÃO está verde: teste de nuvem tem 2 falhas de indisponibilidade;
teste de servidor tem 3 falhas relativas ao tratamento de identificação incerta.
As mesmas falhas foram reproduzidas na versão original, sem estas alterações.
Não houve teste com contas reais, publicação real no Instagram ou deploy.
A identificação por IA continua probabilística. A rotação não é um bloqueio
distribuído entre aparelhos/servidores independentes.
