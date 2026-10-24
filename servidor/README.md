# ☁️ CineClip na nuvem (servidor)

Com o servidor ligado, você compartilha um vídeo do TikTok ou do Kwai no celular, toca em
**☁️ Processar na nuvem** e pode fechar tudo. O servidor baixa o vídeo, corta até 90 s,
identifica o filme, cria o gancho e a legenda, formata em 9:16, guarda no seu Cloudflare R2
e agenda o Reel. O **Robô 24h** publica no Instagram, como sempre. Celular e PC podem ficar
desligados.

O jeito mais simples é a **própria Vercel**, onde o site já está: grátis, sem cartão e sem
máquina para criar ([Opção 0](#opção-0-vercel-grátis-sem-servidor-recomendado)). Também pode
rodar numa máquina só sua, de graça na **Oracle Cloud** ou por cerca de €6/mês na **Hetzner**.

O servidor usa **o mesmo código do site** (IA, TMDB, regras do upload em massa). Só a parte
de vídeo troca o FFmpeg do navegador pelo FFmpeg do servidor — por isso vídeos em H.265 deixam
de dar problema e o processamento é bem mais rápido.

## Antes de começar

- **Cloudflare R2 configurado no CineClip** (Configurações → Nuvem durável). O servidor guarda
  os vídeos lá.
- **Robô 24h ativo** (Agendador → Robô 24h). É ele que publica.
- Chaves de IA (Gemini, Groq ou OpenRouter) e TMDB nas configurações do app — o servidor usa as mesmas.

## Opção 0: Vercel (grátis, sem servidor) — recomendado

A nuvem corre dentro do próprio site (`api/nuvem.js`). Não fica nada ligado: quando um link
chega, a Vercel acorda, trata **1 vídeo por pedido** (até 5 minutos) e volta a dormir. Quem a
acorda é o celular, logo depois de mandar o link, e o **Robô 24h**, a cada 5 minutos, enquanto
houver links à espera.

1. **Copie a chave.** No CineClip: **📦 Upload em massa → 📱 Compartilhar do celular →
   🔑 Copiar chave do servidor**.
2. **Cole na Vercel.** Em <https://vercel.com> abra o projeto **cine-flowx** → **Settings →
   Environment Variables**:
   - **Key:** `CINECLIP_CHAVE_SERVIDOR`
   - **Value:** a chave copiada (começa com `CINECLIP1:`)
   - **Environments:** *Production* (pode marcar **Sensitive**)
   - **Save**.
3. **Publique de novo.** As variáveis só valem para publicações novas: **Deployments** → na
   mais recente, **⋯ → Redeploy**.
4. **Atualize o Robô 24h.** Copie de novo o código do Robô (**Agendador → Robô 24h → 1. Copiar
   Código**) e cole por cima no Apps Script (💾 Salvar). É ele que acorda a nuvem se o celular
   fechar antes.
5. **Confira.** Em **📱 Compartilhar do celular** deve aparecer **"☁️ Nuvem (Vercel): pronta"**.
   Compartilhe um vídeo → **CineClip** → **☁️ Processar na nuvem**.

**Limites do plano grátis (Hobby) da Vercel:** cerca de **4 horas de processador por mês** —
dá uns 120 a 200 vídeos (cada um gasta 1 a 2 minutos) — e **5 minutos por vídeo**. Um vídeo
que não termine em 3 tentativas fica com **Erro** e o botão **Fazer aqui**. O plano grátis é
para uso pessoal (não comercial). Para ver o que a nuvem fez: projeto na Vercel → **Logs**,
filtrando por `/api/nuvem` (guardados durante 1 hora).

Opcional: `CINECLIP_AGENDAR_POUCA_CERTEZA=1` agenda também os vídeos em que a IA teve menos de
65% de certeza do filme.

## Instalação num servidor próprio

Escolha onde o servidor vai rodar:

- **[Oracle Cloud — grátis](#opção-a-oracle-cloud-grátis)** (máquina ARM com 2 processadores e
  12 GB, sem prazo). Cadastro mais chato e acesso por chave SSH.
- **[Hetzner — cerca de €6/mês](#opção-b-hetzner-pago)**. Mais simples de criar.

Os passos 3 a 5 (instalar, ligar à conta e usar) são iguais nas duas.

### Opção A: Oracle Cloud (grátis)

#### A1. Criar a conta

1. Cadastre-se em <https://signup.cloud.oracle.com>.
2. Em **Home Region**, escolha **Brazil East (São Paulo)**. ⚠️ Não dá para mudar depois, e a
   máquina grátis só pode ficar na região principal.
3. A Oracle pede um cartão de crédito **só para verificar** a identidade (pode aparecer uma
   pré-autorização pequena que some depois). A conta pode levar alguns minutos para ativar.

#### A2. Criar a máquina

1. No painel: menu **☰ → Compute → Instances → Create instance**.
2. **Name:** `cineclip`.
3. **Image and shape → Edit:**
   - **Change image** → **Ubuntu** → **Canonical Ubuntu 24.04**.
   - **Change shape** → **Ampere** → **VM.Standard.A1.Flex** → **2 OCPUs** e **12 GB** de memória.
     Confira se aparece o selo **Always Free-eligible**.
4. **Networking:** deixe criar uma rede nova (*Create new virtual cloud network*) com sub-rede
   pública e **Assign a public IPv4 address** marcado.
5. **Add SSH keys:** escolha **Generate a key pair for me** e clique em **Save private key**.
   Guarde o arquivo baixado na pasta **Downloads** e renomeie para `cineclip.key`.
6. Clique em **Create**. Quando ficar verde (**Running**), copie o **Public IP address**.

> **"Out of capacity"?** A máquina grátis esgota com frequência (São Paulo só tem um
> *availability domain*). Em vez de clicar em Create várias vezes, deixe a Oracle insistir por
> você: veja [A2b](#a2b-out-of-capacity-criar-pelo-cloud-shell-insistindo-sozinho).

#### A2b. "Out of capacity": criar pelo Cloud Shell, insistindo sozinho

1. Crie a rede uma vez: **☰ → Networking → Virtual cloud networks → Start VCN Wizard →
   Create VCN with Internet Connectivity**, nome `cineclip`, **Next → Create**.
2. Abra o **Cloud Shell** (ícone **`>_`** no topo do painel) e cole:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/RonanX0/cine-flowx/main/servidor/oracle-criar.sh | bash
   ```

   Ele tenta criar a máquina (1 OCPU, 6 GB) a cada minuto até a Oracle aceitar, e no fim
   mostra o comando `ssh` para entrar nela **pelo próprio Cloud Shell** — não precisa baixar
   chave nem usar o PowerShell (pule o A4). Deixe a aba aberta; se ela fechar, rode de novo.
   Para pedir a máquina maior: `curl … | OCPUS=2 MEMORIA_GB=12 bash`.

#### A3. Pay As You Go (opcional)

Não é obrigatório e **não tem custo**, mas a Oracle faz uma pré-autorização no cartão (que
depois é estornada) — se o cartão não tiver limite, pule este passo. Vantagens: contas Pay As
You Go conseguem vaga com mais facilidade e a Oracle não recolhe a máquina por ficar parada.
Menu **☰ → Billing & Cost Management → Upgrade and Manage Payment → Upgrade to Pay As You Go**,
e crie um alerta de gastos em **Billing → Budgets → Create Budget** (US$ 1).

Sem Pay As You Go, se a máquina passar 7 dias quase parada a Oracle pode desligá-la (avisa por
e-mail antes). Basta ligá-la de novo em **Instances → cineclip → Start**: o CineClip arranca
sozinho.

#### A4. Entrar no servidor pelo Windows

Abra o **PowerShell** e rode, um comando por vez (troque `IP_DO_SERVIDOR` pelo IP copiado):

```powershell
cd $HOME\Downloads
icacls cineclip.key /inheritance:r /grant:r "$($env:USERNAME):(R)"
ssh -i cineclip.key ubuntu@IP_DO_SERVIDOR
```

Na primeira vez ele pergunta se confia no servidor: digite `yes` e Enter. O segundo comando
existe porque o SSH do Windows recusa chaves que outros utilizadores do PC podem ler.

Agora siga para o [passo 3](#3-instalar).

### Opção B: Hetzner (pago)

#### B1. Criar o servidor

1. Crie uma conta em <https://console.hetzner.cloud> e cadastre o cartão.
2. Crie um projeto e clique em **Adicionar servidor**:
   - **Localização:** qualquer uma (Alemanha ou Finlândia são as mais baratas).
   - **Imagem:** **Ubuntu 24.04**.
   - **Tipo:** *Shared vCPU* → **x86** → **CX23** (2 vCPU, 4 GB).
   - **Rede:** deixe o **IPv4 público** ligado.
   - **Chave SSH:** pode pular. Sem chave, a Hetzner manda a senha do `root` por e-mail.
3. Clique em **Criar e comprar**. Em um minuto o servidor está pronto.

#### B2. Abrir o terminal do servidor

Na página do servidor, clique no ícone **`>_` Console**. Entre com `root` e a senha do e-mail
(na primeira vez ele pede para trocar a senha).

> Colar texto no console da Hetzner às vezes falha. Se acontecer, use o PowerShell do
> Windows: `ssh root@IP_DO_SERVIDOR` (o IP aparece na página do servidor) e cole com o botão
> direito do mouse.

### 3. Instalar

Cole este comando e aperte Enter (no PowerShell, cola-se com o botão direito do mouse):

```bash
curl -fsSL https://raw.githubusercontent.com/RonanX0/cine-flowx/main/servidor/instalar.sh | sudo bash
```

Ele instala tudo sozinho (Node.js, FFmpeg, fontes, o CineClip e o serviço). Leva uns 3 a 5
minutos. Funciona tanto na máquina ARM da Oracle como no x86 da Hetzner.

### 4. Ligar o servidor à sua conta

1. No CineClip, no PC: **📦 Upload em massa** → **📱 Compartilhar do celular** →
   **🔑 Copiar chave do servidor**.
2. No servidor:

   ```bash
   sudo cineclip configurar
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
| `sudo cineclip logs` | Mostra o que o servidor está fazendo agora (Ctrl+C para sair) |
| `sudo cineclip testar` | Confere cofre, R2, FFmpeg, fontes e chaves |
| `sudo cineclip estado` | O serviço está rodando? |
| `sudo cineclip reiniciar` | Reinicia o serviço |
| `sudo cineclip atualizar` | Baixa a versão mais recente do GitHub (também roda sozinho todo dia às 4h20) |
| `sudo cineclip configurar` | Troca a chave (por exemplo, depois de mudar a senha do CineClip) |

## O que acontece com cada link

| No app | Significado |
|---|---|
| **Na fila da nuvem** | O servidor ainda não pegou (verifica a cada minuto) |
| **Agendado** | Pronto: o Reel está no Agendador e no R2 |
| **Rever** | A IA teve menos de 65% de certeza do filme. Confira e toque em **Agendar mesmo assim (nuvem)** ou **Fazer aqui** |
| **Erro** | O motivo aparece embaixo (vídeo apagado, TikTok bloqueou o servidor…). **Tentar de novo na nuvem** ou **Fazer aqui** |

## Custos e como parar

- **Oracle Always Free:** grátis dentro dos limites (2 OCPUs ARM e 12 GB no total da conta).
  Não crie outras máquinas além desta, para não sair do gratuito, e mantenha o alerta de gastos.
- **Hetzner CX23:** preço fixo mensal (cerca de €6). Não há custo extra por vídeo. A Hetzner
  cobra **mesmo com o servidor desligado**; para parar de pagar, **exclua** o servidor.

## Detalhes técnicos

- `vercel.mjs` + `../api/nuvem.js` — a nuvem na Vercel: `GET` diz se está configurada,
  `POST` responde logo e trata 1 link em segundo plano (`waitUntil`), com um trinco nas
  claims do R2 (um pedido de cada vez) e o registo cifrado no R2 (o disco da Vercel é
  temporário). Usa o FFmpeg do pacote `ffmpeg-static` (sem ffprobe) e as fontes de `fontes/`.
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
  TikTok, Groq e TMDB simulados) e `npm run nuvem:app:test`.
