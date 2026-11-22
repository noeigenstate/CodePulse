"""Passive e-paper lab log capture. Never sends data or changes reset lines."""
from pathlib import Path
import argparse
import datetime
import json
import re
import time


def relevant(line):
    return "red_mask_probe:" in line or "wft0420-old:" in line or "Project version:" in line


def main():
    import serial  # Provided by the pinned ESP-IDF Python environment.
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", required=True)
    parser.add_argument("--seconds", type=int, default=7200)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if not 1 <= args.seconds <= 43200:
        parser.error("--seconds must be between 1 and 43200")
    now = lambda: datetime.datetime.now(datetime.timezone.utc).isoformat()
    root = Path(__file__).resolve().parents[2]
    output = args.output or root / ".tmpshots/red-lab" / f"observe-{time.time_ns()}.jsonl"
    output.parent.mkdir(parents=True, exist_ok=True)
    connection = None
    buffer = bytearray()
    began = time.monotonic()
    with output.open("x", encoding="utf-8", buffering=1) as log:
        def event(value):
            entry = {"receivedUtc": now(), **value}
            log.write(json.dumps(entry, ensure_ascii=False) + "\n")
            if value.get("line"):
                print(value["line"], flush=True)
        event({"kind": "capture-start", "durationLimitSeconds": args.seconds,
               "passive": True, "identityVerified": False, "opticalValidation": False})
        print(f"Passive capture for {args.seconds}s: {output}. Ctrl+C stops. No reset or refresh commands.", flush=True)
        try:
            while time.monotonic() - began < args.seconds:
                if connection is None:
                    try:
                        connection = serial.Serial(port=None, baudrate=115200, timeout=.5)
                        connection.dtr = False
                        connection.rts = False
                        connection.port = args.port
                        connection.open()
                        buffer.clear()
                        event({"kind": "connected"})
                    except (serial.SerialException, OSError):
                        if connection and connection.is_open:
                            connection.close()
                        connection = None
                        time.sleep(1)
                        continue
                try:
                    buffer.extend(connection.read(4096))
                except (serial.SerialException, OSError):
                    connection.close()
                    connection = None
                    event({"kind": "disconnected"})
                    continue
                while b"\n" in buffer:
                    line, _, rest = buffer.partition(b"\n")
                    buffer = bytearray(rest)
                    line = re.sub(r"\x1b\[[0-9;]*m", "", line.decode("utf-8", errors="replace")).strip()
                    if relevant(line):
                        event({"kind": "panel-log", "line": line})
                if len(buffer) > 65536:
                    buffer.clear()
                    event({"kind": "overlong-line-discarded"})
        except KeyboardInterrupt:
            pass
        finally:
            if connection and connection.is_open:
                connection.close()
            event({"kind": "capture-end", "elapsedSeconds": round(time.monotonic() - began, 1)})


if __name__ == "__main__":
    main()
