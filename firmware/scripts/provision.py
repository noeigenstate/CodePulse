#!/usr/bin/env python3

"""Provision CodePulse Wi-Fi and desktop API settings into the NVS partition."""

from __future__ import annotations

import argparse
import csv
import getpass
import glob
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

NVS_OFFSET = "0x9000"
NVS_SIZE = "0x6000"
DEFAULT_DEVICE_PORT = 17889
DEFAULT_FLASH_BAUD = 115200


def prompt(label: str, default: str = "") -> str:
    suffix = f" [{default}]" if default else ""
    value = input(f"{label}{suffix}: ").strip()
    return value or default


def current_wifi_ssid() -> str:
    if sys.platform != "darwin":
        return ""
    try:
        result = subprocess.run(
            ["networksetup", "-getairportnetwork", "en0"],
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError:
        return ""
    prefix = "Current Wi-Fi Network: "
    output = result.stdout.strip()
    return output[len(prefix) :] if output.startswith(prefix) else ""


def current_lan_ip() -> str:
    if sys.platform != "darwin":
        return ""
    for interface in ("en0", "en1"):
        try:
            result = subprocess.run(
                ["ipconfig", "getifaddr", interface],
                check=False,
                capture_output=True,
                text=True,
            )
        except OSError:
            continue
        address = result.stdout.strip()
        if address:
            return address
    return ""


def validate_settings(
    ssid: str, password: str, host: str, port: int, token: str
) -> None:
    ssid_length = len(ssid.encode("utf-8"))
    password_bytes = password.encode("utf-8")
    host_length = len(host.encode("utf-8"))
    token_length = len(token.encode("utf-8"))
    if not 1 <= ssid_length <= 32:
        raise ValueError("Wi-Fi SSID must contain 1-32 UTF-8 bytes")
    if password and not (
        8 <= len(password_bytes) <= 63
        or (len(password_bytes) == 64 and re.fullmatch(r"[0-9a-fA-F]{64}", password))
    ):
        raise ValueError("Wi-Fi password must be blank, 8-63 bytes, or a 64-digit hex PSK")
    if not 1 <= host_length <= 63 or any(char in host for char in " /:\t\r\n"):
        raise ValueError("server host must be a plain IPv4 address or hostname")
    if not 1 <= port <= 65535:
        raise ValueError("server port must be between 1 and 65535")
    if not 16 <= token_length <= 128:
        raise ValueError("device token must contain 16-128 UTF-8 bytes")


def wait_for_port(requested: str | None, timeout_seconds: int) -> str:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() <= deadline:
        if requested:
            if Path(requested).exists():
                return requested
        else:
            preferred = Path("/dev/cu.usbmodem14101")
            if preferred.exists():
                return str(preferred)
            ports = sorted(glob.glob("/dev/cu.usbmodem*"))
            if len(ports) == 1:
                return ports[0]
            if len(ports) > 1:
                raise RuntimeError(
                    "multiple USB serial ports found; pass one as the first argument"
                )
        time.sleep(0.2)
    raise TimeoutError("ESP32-S3 USB serial port did not appear")


def write_csv(
    path: Path, ssid: str, password: str, host: str, port: int, token: str
) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(("key", "type", "encoding", "value"))
        writer.writerow(("codepulse", "namespace", "", ""))
        writer.writerow(("wifi_ssid", "data", "string", ssid))
        writer.writerow(("wifi_pass", "data", "string", password))
        writer.writerow(("server_host", "data", "string", host))
        writer.writerow(("server_port", "data", "u16", str(port)))
        writer.writerow(("device_token", "data", "string", token))


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Securely provision CodePulse network settings into ESP32 NVS"
    )
    parser.add_argument("port", nargs="?", help="serial port, e.g. /dev/cu.usbmodem14101")
    parser.add_argument(
        "--wait", type=int, default=int(os.getenv("PORT_WAIT_SECONDS", "60"))
    )
    args = parser.parse_args()

    idf_path = Path(os.environ.get("IDF_PATH", ""))
    generator = (
        idf_path
        / "components"
        / "nvs_flash"
        / "nvs_partition_generator"
        / "nvs_partition_gen.py"
    )
    if not generator.is_file():
        raise RuntimeError("ESP-IDF NVS partition generator was not found")

    token_path = Path(
        os.getenv("CODEPULSE_DEVICE_TOKEN_PATH", "~/.codepulse/device-auth")
    ).expanduser()
    token = token_path.read_text(encoding="utf-8").strip()
    ssid = os.getenv("CODEPULSE_WIFI_SSID") or prompt("Wi-Fi SSID", current_wifi_ssid())
    password = os.getenv("CODEPULSE_WIFI_PASSWORD")
    if password is None:
        password = getpass.getpass("Wi-Fi password (hidden; blank for open network): ")
    host = os.getenv("CODEPULSE_SERVER_HOST") or prompt(
        "CodePulse desktop IPv4/hostname", current_lan_ip()
    )
    port_text = os.getenv("CODEPULSE_SERVER_PORT") or prompt(
        "CodePulse device API port", str(DEFAULT_DEVICE_PORT)
    )
    port = int(port_text)
    validate_settings(ssid, password, host, port, token)

    with tempfile.TemporaryDirectory(prefix="codepulse-nvs-") as temporary:
        temp = Path(temporary)
        csv_path = temp / "codepulse.csv"
        image_path = temp / "codepulse-nvs.bin"
        write_csv(csv_path, ssid, password, host, port, token)
        subprocess.run(
            [
                sys.executable,
                str(generator),
                "generate",
                str(csv_path),
                str(image_path),
                NVS_SIZE,
            ],
            check=True,
        )

        print("Hold only the multifunction/power button until provisioning finishes.")
        print("Do not press BOOT.")
        print(f"Waiting up to {args.wait}s for the ESP32-S3 USB serial port...")
        serial_port = wait_for_port(args.port, args.wait)
        print(f"Writing local settings through: {serial_port}")
        subprocess.run(
            [
                sys.executable,
                "-m",
                "esptool",
                "--chip",
                "esp32s3",
                "--port",
                serial_port,
                "--baud",
                os.getenv("FLASH_BAUD", str(DEFAULT_FLASH_BAUD)),
                "--before",
                "usb-reset",
                "--after",
                "no-reset",
                "write-flash",
                NVS_OFFSET,
                str(image_path),
            ],
            check=True,
        )

    print("Provisioning complete. Release both buttons, then power on normally.")
    print("The Wi-Fi password and device token were not printed or stored in the project.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, TimeoutError, ValueError) as error:
        print(f"Provisioning failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
