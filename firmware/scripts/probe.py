#!/usr/bin/env python3
"""Read-only CodePulse USB discovery; never provision, reset, erase or flash."""
import argparse
import json
import sys
import time
import serial
from serial.tools import list_ports


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', help='Explicit ESP32-S3 port, e.g. COM5')
    parser.add_argument('--list', action='store_true', help='List USB candidates without opening them')
    parser.add_argument('--timeout', type=float, default=5.0)
    args = parser.parse_args()
    if not 0 < args.timeout <= 60:
        parser.error('--timeout must be between 0 and 60 seconds')
    candidates = [p for p in list_ports.comports() if p.vid == 0x303A]
    if args.list:
        print(json.dumps([{'port': p.device, 'vid': p.vid, 'pid': p.pid, 'description': p.description} for p in candidates], indent=2))
        return 0
    if not args.port:
        if len(candidates) != 1:
            print('Expected one Espressif USB device. Connect and power on Board1, or select --port explicitly.', file=sys.stderr)
            return 2
        args.port = candidates[0].device
    connection = serial.Serial(port=None, baudrate=115200, timeout=0.2, write_timeout=2)
    connection.dtr = False
    connection.rts = False
    connection.port = args.port
    try:
        connection.open()
        for operation in ('hello', 'getStatus'):
            request_id = 'probe-' + operation
            request = {'id': request_id, 'protocolVersion': 1, 'operation': operation}
            connection.write(('CP1 ' + json.dumps(request, separators=(',', ':')) + '\n').encode('utf-8'))
            connection.flush()
            deadline = time.monotonic() + args.timeout
            line = bytearray()
            oversized = False
            response = None
            while time.monotonic() < deadline:
                chunk = connection.read(1)
                if not chunk:
                    continue
                if chunk != b'\n':
                    if len(line) >= 1024:
                        oversized = True
                    if not oversized:
                        line.extend(chunk)
                    continue
                if not oversized and line.startswith(b'CP1 '):
                    try:
                        frame = json.loads(line[4:])
                    except (ValueError, UnicodeError):
                        frame = None
                    if isinstance(frame, dict) and frame.get('id') == request_id:
                        response = frame
                        break
                line.clear()
                oversized = False
            if response is None:
                raise RuntimeError('No matching CP1 response for ' + operation)
            if response.get('ok') is not True:
                raise RuntimeError('Device rejected ' + operation)
            result = response.get('result')
            if not isinstance(result, dict):
                raise RuntimeError('Malformed CP1 result')
            if operation == 'hello':
                if result.get('protocolVersion') != 1 or not str(result.get('deviceId', '')).startswith('codepulse-'):
                    raise RuntimeError('Unsupported CodePulse USB identity')
                keys = ('deviceId', 'protocolVersion', 'firmwareVersion', 'hardwareRevision', 'provisioned', 'capabilities')
            else:
                keys = ('state', 'provisioned', 'wifiConnected', 'desktopReachable', 'configurationGeneration')
            print(json.dumps({'operation': operation, 'result': {key: result[key] for key in keys if key in result}}, indent=2))
        return 0
    except (serial.SerialException, OSError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        return 1
    finally:
        if connection.is_open:
            connection.close()


if __name__ == '__main__':
    sys.exit(main())
