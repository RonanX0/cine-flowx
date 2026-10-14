#!/usr/bin/env bash
# Comando «cineclip» do servidor (instalado em /usr/local/bin/cineclip).
#   sudo cineclip configurar   cola a chave do servidor e arranca o serviço
#   sudo cineclip testar       confere tudo (cofre, R2, FFmpeg, fontes, chaves)
#   sudo cineclip logs         acompanha o que o servidor está a fazer (Ctrl+C sai)
#   sudo cineclip estado       o serviço está a correr?
#   sudo cineclip reiniciar    reinicia o serviço
#   sudo cineclip atualizar    baixa a versão mais recente e reinicia
set -euo pipefail

PASTA=/opt/cineclip
export CINECLIP_CONFIG=/etc/cineclip/config.json
export CINECLIP_DADOS=/var/lib/cineclip

precisa_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "Usa: sudo cineclip $1" >&2
    exit 1
  fi
}

case "${1:-ajuda}" in
  configurar)
    precisa_root configurar
    CINECLIP_DONO_CONFIG="$(id -u cineclip):$(id -g cineclip)" node "$PASTA/servidor/index.mjs" configurar
    chmod 640 "$CINECLIP_CONFIG"
    chown root:cineclip "$CINECLIP_CONFIG"
    echo
    sudo -u cineclip env CINECLIP_CONFIG="$CINECLIP_CONFIG" CINECLIP_DADOS="$CINECLIP_DADOS" node "$PASTA/servidor/index.mjs" testar || true
    systemctl restart cineclip.service
    echo "☁️ Serviço a correr. Acompanha com:  sudo cineclip logs"
    ;;
  testar)
    precisa_root testar
    sudo -u cineclip env CINECLIP_CONFIG="$CINECLIP_CONFIG" CINECLIP_DADOS="$CINECLIP_DADOS" node "$PASTA/servidor/index.mjs" testar
    ;;
  logs)
    journalctl -u cineclip.service -n 50 -f --output=cat
    ;;
  estado)
    systemctl --no-pager status cineclip.service | head -12
    ;;
  reiniciar)
    precisa_root reiniciar
    systemctl restart cineclip.service
    echo "Reiniciado."
    ;;
  atualizar)
    precisa_root atualizar
    antes="$(git -C "$PASTA" rev-parse --short HEAD)"
    git -C "$PASTA" fetch -q --depth 1 origin main
    git -C "$PASTA" reset -q --hard origin/main
    depois="$(git -C "$PASTA" rev-parse --short HEAD)"
    if [ "$antes" != "$depois" ]; then
      (cd "$PASTA/servidor" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
      install -m 755 "$PASTA/servidor/cineclip.sh" /usr/local/bin/cineclip
      systemctl restart cineclip.service
      echo "Atualizado: $antes → $depois"
    else
      echo "Já estava na versão mais recente ($depois)."
    fi
    ;;
  *)
    sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
    ;;
esac
