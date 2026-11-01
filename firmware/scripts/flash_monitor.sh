#!/usr/bin/env bash

set -euo pipefail
shopt -s nullglob

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PORT_WAIT_SECONDS="${PORT_WAIT_SECONDS:-60}"
POWER_OFF_WAIT_SECONDS="${POWER_OFF_WAIT_SECONDS:-30}"
FLASH_BAUD="${FLASH_BAUD:-115200}"

usage() {
  echo "Usage: $0 [serial-port]"
  echo "Example: $0 /dev/cu.usbmodem14101"
  echo "Environment: SKIP_BUILD=1 FLASH_BAUD=115200 PORT_WAIT_SECONDS=60"
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
    elif detected_port="$(detect_port)"; then
      printf '%s\n' "${detected_port}"
      return 0
    else
      local detect_status=$?
      if (( detect_status == 2 )); then
        return 2
      fi
    fi
    sleep 0.2
  done

  echo "ESP32-S3 USB serial port did not appear within ${PORT_WAIT_SECONDS}s." >&2
  return 1
}

wait_for_power_off() {
  local port="$1"
  local deadline=$((SECONDS + POWER_OFF_WAIT_SECONDS))
  while (( SECONDS <= deadline )); do
    if [[ ! -e "${port}" ]]; then
      return 0
    fi
    sleep 0.2
  done
  echo "The serial port is still present. Release the function button fully." >&2
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
if [[ ! "${PORT_WAIT_SECONDS}" =~ ^[0-9]+$ ||
      ! "${POWER_OFF_WAIT_SECONDS}" =~ ^[0-9]+$ ||
      ! "${FLASH_BAUD}" =~ ^[0-9]+$ || "${FLASH_BAUD}" == "0" ]]; then
  echo "Wait intervals must be non-negative integers and FLASH_BAUD must be positive." >&2
  exit 2
fi

requested_port="${1:-${CODEPULSE_PORT:-${ESPPORT:-}}}"

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  echo "Phase 1/3: building firmware. No button is needed yet."
  "${PROJECT_ROOT}/scripts/build.sh"
fi

echo
echo "Phase 2/3: press and keep holding only the function/power button."
echo "Do not press BOOT. Waiting for the USB serial port..."
port="$(wait_for_port "${requested_port}")"

PORT_WAIT_SECONDS=1 FLASH_BAUD="${FLASH_BAUD}" \
  "${PROJECT_ROOT}/scripts/flash.sh" "${port}"

echo
echo "Flash verification passed. Release the function button completely."
wait_for_power_off "${port}"

echo
echo "Phase 3/3: long-press only the function button for normal power-on."
echo "Keep holding for 3 seconds; release it after the status LED turns on."
echo "The monitor will attach automatically when the USB port returns."

if [[ -n "${requested_port}" ]]; then
  PORT_WAIT_SECONDS="${PORT_WAIT_SECONDS}" \
    "${PROJECT_ROOT}/scripts/monitor.sh" "${requested_port}"
else
  PORT_WAIT_SECONDS="${PORT_WAIT_SECONDS}" \
    "${PROJECT_ROOT}/scripts/monitor.sh"
fi
