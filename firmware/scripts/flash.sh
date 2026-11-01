#!/usr/bin/env bash

set -euo pipefail
shopt -s nullglob

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PORT_WAIT_SECONDS="${PORT_WAIT_SECONDS:-30}"
FLASH_BAUD="${FLASH_BAUD:-115200}"
IDF_PYTHON=""

usage() {
  echo "Usage: $0 [serial-port]"
  echo "Example: $0 /dev/cu.usbmodem14101"
}

activate_idf() {
  local activation_script="${IDF_ACTIVATE_SCRIPT:-}"
  local environment_output=""
  if [[ -z "${activation_script}" &&
        -f "${HOME}/.espressif/tools/activate_idf_v6.0.1.sh" ]]; then
    activation_script="${HOME}/.espressif/tools/activate_idf_v6.0.1.sh"
  elif [[ -z "${activation_script}" && -n "${IDF_PATH:-}" &&
          -f "${IDF_PATH}/export.sh" ]]; then
    activation_script="${IDF_PATH}/export.sh"
  elif [[ -z "${activation_script}" && -f "${HOME}/esp/esp-idf/export.sh" ]]; then
    activation_script="${HOME}/esp/esp-idf/export.sh"
  fi

  if [[ -z "${activation_script}" || ! -f "${activation_script}" ]]; then
    echo "ESP-IDF environment was not found." >&2
    echo "Open an ESP-IDF terminal or set IDF_ACTIVATE_SCRIPT." >&2
    exit 1
  fi

  if environment_output="$("${activation_script}" -e 2>/dev/null)" &&
      [[ "${environment_output}" == *"IDF_PATH="* ]]; then
    local assignment=""
    local key=""
    local value=""
    while IFS= read -r assignment; do
      [[ "${assignment}" == *=* ]] || continue
      key="${assignment%%=*}"
      value="${assignment#*=}"
      [[ "${key}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
      if [[ "${key}" == "PATH" ]]; then
        export PATH="${value}:${PATH}"
      else
        export "${key}=${value}"
      fi
    done <<< "${environment_output}"
  else
    set +u
    # shellcheck disable=SC1090
    source "${activation_script}"
    set -u
  fi

  if [[ -z "${IDF_PATH:-}" || ! -f "${IDF_PATH}/tools/idf.py" ]]; then
    echo "IDF_PATH is invalid after activating ESP-IDF." >&2
    exit 1
  fi
  if [[ -z "${IDF_PYTHON_ENV_PATH:-}" ]]; then
    echo "IDF_PYTHON_ENV_PATH is invalid after activating ESP-IDF." >&2
    exit 1
  fi
  if [[ -x "${IDF_PYTHON_ENV_PATH}/bin/python" ]]; then
    IDF_PYTHON="${IDF_PYTHON_ENV_PATH}/bin/python"
  elif [[ -x "${IDF_PYTHON_ENV_PATH}/bin/python3" ]]; then
    IDF_PYTHON="${IDF_PYTHON_ENV_PATH}/bin/python3"
  else
    echo "IDF_PYTHON_ENV_PATH is invalid after activating ESP-IDF." >&2
    exit 1
  fi
  if ! "${IDF_PYTHON}" -c 'import esptool' >/dev/null 2>&1; then
    echo "The ESP-IDF Python environment does not provide esptool." >&2
    exit 1
  fi
}

detect_port() {
  if [[ -e /dev/cu.usbmodem14101 ]]; then
    printf '%s\n' /dev/cu.usbmodem14101
    return 0
  fi

  local ports=(/dev/cu.usbmodem*)
  if (( ${#ports[@]} == 1 )); then
    printf '%s\n' "${ports[0]}"
    return 0
  fi
  if (( ${#ports[@]} > 1 )); then
    echo "Multiple USB serial ports found; pass one to this script:" >&2
    printf '  %s\n' "${ports[@]}" >&2
    return 2
  fi
  return 1
}

wait_for_port() {
  local requested_port="$1"
  local deadline=$((SECONDS + PORT_WAIT_SECONDS))
  local detected_port=""

  while (( SECONDS <= deadline )); do
    if [[ -n "${requested_port}" ]]; then
      if [[ -e "${requested_port}" ]]; then
        printf '%s\n' "${requested_port}"
        return 0
      fi
    else
      if detected_port="$(detect_port)"; then
        printf '%s\n' "${detected_port}"
        return 0
      else
        local detect_status=$?
        if (( detect_status == 2 )); then
          return 2
        fi
      fi
    fi
    sleep 0.2
  done

  if [[ -n "${requested_port}" ]]; then
    echo "Serial port did not appear: ${requested_port}" >&2
  else
    echo "No /dev/cu.usbmodem* port appeared within ${PORT_WAIT_SECONDS}s." >&2
  fi
  return 1
}

if (( $# > 1 )); then
  usage >&2
  exit 2
fi
if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi
if [[ ! "${PORT_WAIT_SECONDS}" =~ ^[0-9]+$ ]]; then
  echo "PORT_WAIT_SECONDS must be a non-negative integer." >&2
  exit 2
fi
if [[ ! "${FLASH_BAUD}" =~ ^[0-9]+$ || "${FLASH_BAUD}" == "0" ]]; then
  echo "FLASH_BAUD must be a positive integer." >&2
  exit 2
fi

required_images=(
  "${PROJECT_ROOT}/build/bootloader/bootloader.bin"
  "${PROJECT_ROOT}/build/partition_table/partition-table.bin"
  "${PROJECT_ROOT}/build/codepulse_bringup.bin"
)
for image in "${required_images[@]}"; do
  if [[ ! -f "${image}" ]]; then
    echo "Missing firmware image: ${image}" >&2
    echo "Run ${PROJECT_ROOT}/scripts/build.sh first." >&2
    exit 1
  fi
done

activate_idf

requested_port="${1:-${CODEPULSE_PORT:-${ESPPORT:-}}}"
echo "Hold only the multifunction/power button during the entire flash operation."
echo "Do not press BOOT."
echo "Waiting up to ${PORT_WAIT_SECONDS}s for the ESP32-S3 USB serial port..."
port="$(wait_for_port "${requested_port}")"
echo "Flashing through: ${port}"

cd -- "${PROJECT_ROOT}"
"${IDF_PYTHON}" -m esptool \
  --chip esp32s3 \
  --port "${port}" \
  --baud "${FLASH_BAUD}" \
  --before usb-reset \
  --after no-reset \
  write-flash \
  --flash-mode dio \
  --flash-freq 80m \
  --flash-size 16MB \
  0x0 build/bootloader/bootloader.bin \
  0x8000 build/partition_table/partition-table.bin \
  0x10000 build/codepulse_bringup.bin

echo
echo "Flash complete. Release the power button to turn the board fully off."
echo "Start scripts/monitor.sh before the next 3-second power-on hold."
