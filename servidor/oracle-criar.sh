#!/usr/bin/env bash
# =============================================================================
# ☁️ CineClip — cria a máquina grátis da Oracle e insiste até ter vaga
#
# Roda no Cloud Shell da Oracle (ícone >_ no topo do painel), sem cartão extra:
#
#   curl -fsSL https://raw.githubusercontent.com/RonanX0/cine-flowx/main/servidor/oracle-criar.sh | bash
#
# Tenta criar a máquina VM.Standard.A1.Flex (Always Free) a cada minuto até a
# Oracle aceitar. Quando der certo, mostra o comando para entrar nela.
# Opções (variáveis):  OCPUS=1  MEMORIA_GB=6  ESPERA_S=60  NOME=cineclip
# =============================================================================
set -uo pipefail

OCPUS="${OCPUS:-1}"
MEMORIA_GB="${MEMORIA_GB:-6}"
ESPERA_S="${ESPERA_S:-60}"
NOME="${NOME:-cineclip}"
CHAVE="$HOME/.ssh/cineclip"

passo() { printf '\n\033[1;31m▶\033[0m \033[1m%s\033[0m\n' "$1"; }
ok() { printf '  \033[32m✔\033[0m %s\n' "$1"; }
falha() { printf '\n\033[31m✘ %s\033[0m\n' "$1" >&2; exit 1; }

command -v oci >/dev/null || falha "Rode isto no Cloud Shell da Oracle (ícone >_ no topo do painel)."

passo "1/4 Sua conta"
TENANCY="${OCI_TENANCY:-}"
if [ -z "$TENANCY" ]; then
  TENANCY="$(oci os ns get-metadata --query 'data."default-s3-compartment-id"' --raw-output 2>/dev/null || true)"
fi
[ -n "$TENANCY" ] || falha "Não consegui descobrir a conta (tenancy). Abra o Cloud Shell de novo e repita."
AD="$(oci iam availability-domain list --compartment-id "$TENANCY" --query 'data[0].name' --raw-output)"
ok "região ${OCI_REGION:-?}, domínio $AD"

# Já existe? Então só mostra o IP.
EXISTENTE="$(oci compute instance list --compartment-id "$TENANCY" --display-name "$NOME" \
  --query 'data[?"lifecycle-state"!=`TERMINATED` && "lifecycle-state"!=`TERMINATING`] | [0].id' --raw-output 2>/dev/null || true)"

if [ -z "$EXISTENTE" ] || [ "$EXISTENTE" = "null" ]; then
  passo "2/4 Rede, imagem e chave"
  SUBNET="$(oci network subnet list --compartment-id "$TENANCY" \
    --query 'data[?"prohibit-public-ip-on-vnic"==`false` && "lifecycle-state"==`AVAILABLE`] | [0].id' --raw-output 2>/dev/null || true)"
  if [ -z "$SUBNET" ] || [ "$SUBNET" = "null" ]; then
    falha "Não há sub-rede pública. No painel: ☰ → Networking → Virtual cloud networks → Start VCN Wizard → "Create VCN with Internet Connectivity" (nome: cineclip). Depois rode isto de novo."
  fi
  ok "sub-rede pública encontrada"

  IMAGEM="$(oci compute image list --compartment-id "$TENANCY" --operating-system "Canonical Ubuntu" \
    --operating-system-version "24.04" --shape VM.Standard.A1.Flex --sort-by TIMECREATED --sort-order DESC \
    --query 'data[0].id' --raw-output 2>/dev/null || true)"
  [ -n "$IMAGEM" ] && [ "$IMAGEM" != "null" ] || falha "Não encontrei a imagem Ubuntu 24.04 para ARM."
  ok "Ubuntu 24.04 (ARM)"

  mkdir -p "$HOME/.ssh"
  if [ ! -f "$CHAVE" ]; then
    ssh-keygen -q -t ed25519 -N "" -C cineclip -f "$CHAVE" || falha "Não consegui criar a chave SSH (ssh-keygen)."
    ok "chave SSH criada em ~/.ssh/cineclip (fica guardada no Cloud Shell)"
  else
    ok "usando a chave que já existe em ~/.ssh/cineclip"
  fi

  passo "3/4 Pedindo a máquina ($OCPUS OCPU, $MEMORIA_GB GB) — insistindo até ter vaga"
  echo "  Deixe esta aba aberta. Se fechar, rode o mesmo comando de novo."
  tentativa=0
  while :; do
    tentativa=$((tentativa + 1))
    SAIDA="$(oci compute instance launch \
      --availability-domain "$AD" \
      --compartment-id "$TENANCY" \
      --display-name "$NOME" \
      --shape VM.Standard.A1.Flex \
      --shape-config "{\"ocpus\":$OCPUS,\"memoryInGBs\":$MEMORIA_GB}" \
      --image-id "$IMAGEM" \
      --subnet-id "$SUBNET" \
      --assign-public-ip true \
      --ssh-authorized-keys-file "$CHAVE.pub" \
      --query 'data.id' --raw-output 2>&1)"
    if [[ "$SAIDA" == ocid1.instance* ]]; then
      EXISTENTE="$SAIDA"
      ok "conseguiu na tentativa $tentativa!"
      break
    fi
    if grep -qi "capacity" <<<"$SAIDA"; then
      printf '  %s  tentativa %d: sem vaga, tento de novo em %ss\n' "$(date +%H:%M)" "$tentativa" "$ESPERA_S"
      sleep "$ESPERA_S"
    elif grep -qiE "TooManyRequests|429" <<<"$SAIDA"; then
      printf '  %s  tentativa %d: a Oracle pediu calma, esperando mais um pouco\n' "$(date +%H:%M)" "$tentativa"
      sleep $((ESPERA_S * 3))
    elif grep -qiE "LimitExceeded|QuotaExceeded|limit" <<<"$SAIDA"; then
      echo "$SAIDA" | tail -5
      falha "Passou do limite grátis. Você já tem outra máquina ARM? Apague-a ou diminua OCPUS/MEMORIA_GB (ex.: OCPUS=1 MEMORIA_GB=6)."
    else
      echo "$SAIDA" | tail -8
      falha "A Oracle recusou por outro motivo (acima). Mande isto para o Claude."
    fi
  done
else
  passo "2/4 A máquina \"$NOME\" já existe"
fi

passo "4/4 Esperando ligar"
oci compute instance get --instance-id "$EXISTENTE" --wait-for-state RUNNING --max-wait-seconds 600 >/dev/null 2>&1 || true
IP=""
for _ in $(seq 1 30); do
  IP="$(oci compute instance list-vnics --instance-id "$EXISTENTE" --query 'data[0]."public-ip"' --raw-output 2>/dev/null || true)"
  [ -n "$IP" ] && [ "$IP" != "null" ] && break
  sleep 10
done
[ -n "$IP" ] && [ "$IP" != "null" ] || falha "A máquina ligou mas sem IP público. No painel: Instances → $NOME → Attached VNICs → IPv4 → Edit → Ephemeral public IP."
ok "ligada com o IP $IP"

cat <<FIM

✅ Máquina pronta. Agora, aqui mesmo no Cloud Shell:

   ssh -i ~/.ssh/cineclip ubuntu@$IP

(na primeira vez digite  yes  e Enter; se aparecer "Connection refused", espere 1 minuto)

Já dentro da máquina:

   curl -fsSL https://raw.githubusercontent.com/RonanX0/cine-flowx/main/servidor/instalar.sh | sudo bash
   sudo cineclip configurar

FIM
