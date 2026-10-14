# ☁️ CineClip na nuvem (servidor)

Com o servidor ligado, você compartilha um vídeo do TikTok ou do Kwai no celular, toca em
**☁️ Processar na nuvem** e pode fechar tudo. O servidor baixa o vídeo, corta até 90 s,
identifica o filme, cria o gancho e a legenda, formata em 9:16, guarda no seu Cloudflare R2
e agenda o Reel. O **Robô 24h** publica no Instagram, como sempre. Celular e PC podem ficar
desligados.

O servidor usa **o mesmo código do site** (IA, TMDB, regras do upload em massa). Só a parte
de vídeo troca o FFmpeg do navegador pelo FFmpeg do servidor — por isso vídeos em H.265 deixam
de dar problema e o processamento é bem mais rápido.

## Antes de começar

- **Cloudflare R2 configurado no CineClip** (Configurações → Nuvem durável). O servidor guarda
  os vídeos lá.
- **Robô 24h ativo** (Agendador → Robô 24h). É ele que publica.
- Chaves de IA (NVIDIA ou Gemini) e TMDB nas configurações do app — o servidor usa as mesmas.

## Instalação (uns 15 minutos)

### 1. Criar o servidor na Hetzner

1. Crie uma conta em <https://console.hetzner.cloud> e cadastre o cartão.
2. Crie um projeto e clique em **Adicionar servidor**:
   - **Localização:** qualquer uma (Alemanha ou Finlândia são as mais baratas).
   - **Imagem:** **Ubuntu 24.04**.
   - **Tipo:** *Shared vCPU* → **x86** → **CX23** (2 vCPU, 4 GB).
   - **Rede:** deixe o **IPv4 público** ligado.
   - **Chave SSH:** pode pular. Sem chave, a Hetzner manda a senha do `root` por e-mail.
3. Clique em **Criar e comprar**. Em um minuto o servidor está pronto.

### 2. Abrir o terminal do servidor

Na página do servidor, clique no ícone **`>_` Console**. Entre com `root` e a senha do e-mail
(na primeira vez ele pede para trocar a senha).

> Colar texto no console da Hetzner às vezes falha. Se acontecer, use o PowerShell do
> Windows: `ssh root@IP_DO_SERVIDOR` (o IP aparece na página do servidor) e cole com o botão
> direito do mouse.

### 3. Instalar

Cole este comando e aperte Enter:

```bash
curl -fsSL https://raw.githubusercontent.com/RonanX0/cine-flowx/main/servidor/instalar.sh | bash
```

Ele instala tudo sozinho (Node.js, FFmpeg, fontes, o CineClip e o serviço). Leva uns 3 minutos.

### 4. Ligar o servidor à sua conta

1. No CineClip, no PC: **📦 Upload em massa** → **📱 Compartilhar do celular** →
   **🔑 Copiar chave do servidor**.
2. No servidor:

   ```bash
   cineclip configurar
   ```

   Cole a chave e aperte Enter. Ele testa tudo e mostra **✅ Tudo pronto**.

> A chave dá acesso ao seu cofre (como o código do Robô 24h). Não a compartilhe.

### 5. Usar no celular

Compartilhe um vídeo → **CineClip** → **☁️ Processar na nuvem**. Marque **Lembrar a minha
escolha** para os próximos irem direto. A opção aparece quando o app vê o servidor ligado
(em **📱 Compartilhar do celular** aparece "☁️ Servidor na nuvem: ligado").

## Comandos úteis (no servidor)

| Comando | O que faz |
|---|---|
| `cineclip logs` | Mostra o que o servidor está fazendo agora (Ctrl+C para sair) |
| `cineclip testar` | Confere cofre, R2, FFmpeg, fontes e chaves |
| `cineclip estado` | O serviço está rodando? |
| `cineclip reiniciar` | Reinicia o serviço |
| `cineclip atualizar` | Baixa a versão mais recente do GitHub (também roda sozinho todo dia às 4h20) |
| `cineclip configurar` | Troca a chave (por exemplo, depois de mudar a senha do CineClip) |

## O que acontece com cada link

| No app | Significado |
|---|---|
| **Na fila da nuvem** | O servidor ainda não pegou (verifica a cada minuto) |
| **Agendado** | Pronto: o Reel está no Agendador e no R2 |
| **Rever** | A IA teve menos de 65% de certeza do filme. Confira e toque em **Agendar mesmo assim (nuvem)** ou **Fazer aqui** |
| **Erro** | O motivo aparece embaixo (vídeo apagado, TikTok bloqueou o servidor…). **Tentar de novo na nuvem** ou **Fazer aqui** |

## Custos e como parar

- Hetzner CX23: preço fixo mensal (cerca de €6). Não há custo extra por vídeo.
- A Hetzner cobra **mesmo com o servidor desligado**. Para parar de pagar, **exclua** o servidor
  no painel da Hetzner.

## Detalhes técnicos

- `index.mjs` — comandos e ciclo (a cada `INTERVALO_S`, 60 s por padrão).
- `trabalhador.mjs` — lê o cofre, processa os links com destino `nuvem`, envia o vídeo para o
  R2, junta o Reel à fila e marca o link. Relê o cofre antes de gravar e, durante 30 min,
  repõe Reels que uma sincronização do app tenha atropelado — sem processar de novo
  (registo em `/var/lib/cineclip/registo.json`).
- `app-headless.mjs` — arranca o `index.html` num DOM simulado (jsdom) e usa
  `window.CineClipCore` e o `processarItem` do `lote-massa.js`.
- `video.mjs` — FFmpeg nativo no lugar de `bi`/`Nc`/`Cc`/`YS` do app; o gancho é desenhado
  com a fonte Inter e emoji coloridos.
- `cofre.mjs` — a cifra do cofre (igual à do app e do Robô 24h), leitura/gravação no R2/Drive,
  envio do vídeo e o "sinal de vida" (claim `servidor:…` que o app usa para mostrar o estado).
- Configuração em `/etc/cineclip/config.json` (só root e o utilizador `cineclip` leem).
  Opções extra: `INTERVALO_S`, `AGENDAR_POUCA_CERTEZA`, `SITE`, `NOME_SERVIDOR`.
- Testes: `npm run servidor:test` (ponta a ponta com FFmpeg e o código real do app; R2,
  TikTok, NVIDIA e TMDB simulados) e `npm run nuvem:app:test`.
