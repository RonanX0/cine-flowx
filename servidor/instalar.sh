#!/usr/bin/env bash
# =============================================================================
# ☁️ CineClip — instalação do servidor na nuvem (Ubuntu 24.04: Oracle Cloud ARM ou Hetzner x86)
#
#   curl -fsSL https://raw.githubusercontent.com/RonanX0/cine-flowx/main/servidor/instalar.sh | sudo bash
#
# Instala Node.js 22, FFmpeg, as fontes do gancho (Inter + emoji), o CineClip em
# /opt/cineclip, o serviço "cineclip" (arranca sozinho e reinicia se cair) e uma
# atualização automática diária. Pode correr-se outra vez sem problema.
# Depois:  sudo cineclip configurar   (cola a chave do servidor)
# =============================================================================
set -euo pipefail

REPO="${CINECLIP_REPO:-https://github.com/RonanX0/cine-flowx.git}"
RAMO="${CINECLIP_RAMO:-main}"
PASTA=/opt/cineclip
DADOS=/var/lib/cineclip
CONFIG_DIR=/etc/cineclip
UTILIZADOR=cineclip

passo() { printf '\n\033[1;31m▶\033[0m \033[1m%s\033[0m\n' "$1"; }
ok() { printf '  \033[32m✔\033[0m %s\n' "$1"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Corre com sudo:  curl -fsSL …/instalar.sh | sudo bash" >&2
  exit 1
fi
if ! grep -qiE 'ubuntu|debian' /etc/os-release; then
  echo "Este instalador é para Ubuntu/Debian (no Hetzner escolhe Ubuntu 24.04)." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
# Máquinas acabadas de criar (Oracle, Hetzner) correm as atualizações automáticas no
# arranque e prendem o apt durante uns minutos: espera em vez de falhar.
APT="apt-get -o DPkg::Lock::Timeout=600"

passo "1/6 Pacotes do sistema (FFmpeg, fontes, git)"
$APT update -qq
$APT install -y -qq ca-certificates curl git ffmpeg fonts-inter fonts-noto-color-emoji >/dev/null
ok "ffmpeg $(ffmpeg -version | head -1 | awk '{print $3}')"

passo "2/6 Node.js 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  $APT install -y -qq nodejs >/dev/null
fi
ok "node $(node -v) ($(uname -m))"

passo "3/6 Utilizador e pastas"
id -u "$UTILIZADOR" >/dev/null 2>&1 || useradd --system --home "$DADOS" --shell /usr/sbin/nologin "$UTILIZADOR"
mkdir -p "$DADOS" "$CONFIG_DIR"
chown "$UTILIZADOR:$UTILIZADOR" "$DADOS"
chown root:"$UTILIZADOR" "$CONFIG_DIR"
chmod 750 "$CONFIG_DIR"
ok "utilizador $UTILIZADOR, dados em $DADOS, config em $CONFIG_DIR"

passo "4/6 CineClip em $PASTA"
if [ -d "$PASTA/.git" ]; then
  git -C "$PASTA" fetch -q --depth 1 origin "$RAMO"
  git -C "$PASTA" reset -q --hard "origin/$RAMO"
else
  rm -rf "$PASTA"
  git clone -q --depth 1 --branch "$RAMO" "$REPO" "$PASTA"
fi
(cd "$PASTA/servidor" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
ok "versão $(git -C "$PASTA" rev-parse --short HEAD)"

passo "5/6 Comando «cineclip» e serviço"
install -m 755 "$PASTA/servidor/cineclip.sh" /usr/local/bin/cineclip

cat >/etc/systemd/system/cineclip.service <<UNIT
[Unit]
Description=CineClip — servidor na nuvem (processa os links do celular)
After=network-online.target
Wants=network-online.target

[Service]
User=$UTILIZADOR
WorkingDirectory=$PASTA
Environment=CINECLIP_CONFIG=$CONFIG_DIR/config.json
Environment=CINECLIP_DADOS=$DADOS
Environment=NODE_ENV=production
ExecStart=/usr/bin/node $PASTA/servidor/index.mjs
Restart=always
RestartSec=15
Nice=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DADOS
ReadOnlyPaths=$CONFIG_DIR $PASTA

[Install]
WantedBy=multi-user.target
UNIT

cat >/etc/systemd/system/cineclip-atualizar.service <<UNIT
[Unit]
Description=CineClip — atualizar para a versão mais recente do GitHub

[Service]
Type=oneshot
ExecStart=/usr/local/bin/cineclip atualizar
UNIT

cat >/etc/systemd/system/cineclip-atualizar.timer <<UNIT
[Unit]
Description=CineClip — atualização diária

[Timer]
OnCalendar=*-*-* 04:20:00
RandomizedDelaySec=30min
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now cineclip-atualizar.timer >/dev/null 2>&1
systemctl enable cineclip.service >/dev/null 2>&1
ok "serviço cineclip e atualização diária às 04:20"

passo "6/6 Configuração"
if [ -s "$CONFIG_DIR/config.json" ]; then
  systemctl restart cineclip.service
  ok "já configurado — serviço reiniciado"
  echo
  echo "Pronto. Vê o que está a acontecer com:  sudo cineclip logs"
else
  echo
  echo "Falta só um passo: cola a chave do servidor."
  echo "  1. No CineClip: 📦 Upload em massa → 📱 Compartilhar do celular → 🔑 Copiar chave do servidor"
  echo "  2. Aqui no servidor:   sudo cineclip configurar"
fi
