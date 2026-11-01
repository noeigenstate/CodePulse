#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
IDF_PYTHON=""

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
  if [[ -x "${IDF_PYTHON_ENV_PATH:-}/bin/python" ]]; then
    IDF_PYTHON="${IDF_PYTHON_ENV_PATH}/bin/python"
  elif [[ -x "${IDF_PYTHON_ENV_PATH:-}/bin/python3" ]]; then
    IDF_PYTHON="${IDF_PYTHON_ENV_PATH}/bin/python3"
  else
    echo "IDF_PYTHON_ENV_PATH is invalid after activating ESP-IDF." >&2
    exit 1
  fi
}

activate_idf
exec "${IDF_PYTHON}" "${PROJECT_ROOT}/scripts/provision.py" "$@"
