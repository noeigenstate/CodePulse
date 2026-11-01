"""Read-only CodePulse startup diagnosis; no flash, reset or provisioning.

Run with the existing station's Python. runner.py is an unchanged companion
from r2; no module is imported from the feedback ZIP or the user's run folder.
"""
from __future__ import annotations
import argparse
import json
import re
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
import runner

ANSI = re.compile(r'\x1b\[[0-9;]*[A-Za-z]')
VERSION = re.compile(r'0\.0\.\d{1,3}-[A-Za-z0-9-]{1,48}\Z')
STAGES = {
    'hold the power button for 3 seconds to start': 'awaiting_power_hold',
    'power button released before 3 seconds; shutting down': 'power_hold_rejected',
    '3-second power-on hold accepted; status LED is on': 'power_hold_accepted',
    'power button released; short press refresh is armed': 'power_button_released',
    'power session restored after USB reset; status LED is on': 'usb_power_session_restored',
    'buzzer self-test output completed': 'buzzer_test_completed',
    'display fault; stopping without automatic retry or full refresh': 'display_fault_stop',
}

def classify(line):
    """Emit fixed codes/numeric fields only; never export a raw serial line."""
    line = ANSI.sub('', line).strip()
    if line == 'waiting for download':
        return {'kind': 'boot_marker', 'code': 'rom_waiting_for_download'}
    if re.fullmatch(r'ESP-ROM:esp32s3-[0-9]{8}', line):
        return {'kind': 'boot_marker', 'code': 'esp32s3_rom_banner'}
    if re.match(r'rst:0x[0-9a-fA-F]+\([^)]*\),boot:0x[0-9a-fA-F]+\(DOWNLOAD', line):
        return {'kind': 'boot_marker', 'code': 'rom_download_mode'}
    if re.match(r'Guru Meditation Error:', line):
        return {'kind': 'boot_marker', 'code': 'panic'}
    if re.fullmatch(r'I \(\d+\) codepulse_usb: USB provisioning protocol v1 ready', line):
        return {'kind': 'boot_marker', 'code': 'usb_service_ready'}
    if re.match(r'(?:E \(\d+\) (?:esp_image|boot): )?(?:invalid header|No bootable app partitions)', line, re.I):
        return {'kind': 'boot_marker', 'code': 'boot_image_error'}
    match = re.fullmatch(r'[IWE] \(\d+\) codepulse_bringup: (.*)', line)
    if match:
        message = match[1]
        if message in STAGES:
            return {'kind': 'boot_marker', 'code': STAGES[message]}
        version = re.fullmatch(r'firmware=(\S+) idf=\S+ hw_rev=(\d+) reset_reason=(\d+)', message)
        if version and VERSION.fullmatch(version[1]):
            return {'kind': 'boot_identity_log', 'firmware_version': version[1],
                    'hardware_revision': int(version[2]), 'reset_reason': int(version[3])}
        for prefix, code in [('USB provisioning service failed: ', 'usb_service_failed'),
                             ('Wi-Fi connection failed: ', 'wifi_connection_failed'),
                             ('safe GPIO initialization failed: ', 'gpio_initialization_failed')]:
            if message.startswith(prefix):
                return {'kind': 'boot_marker', 'code': code}
    return runner.parse_metric(line)

class Lines:
    """Bound each line, drain complete lines immediately, count discarded data."""
    def __init__(self):
        self.pending = bytearray()
        self.dropping = False
        self.stats = dict(rx_bytes=0, lines=0, oversized_lines=0,
                          cp1_frames=0, malformed_cp1=0, unrelated_cp1=0,
                          tx_bytes=0, requests_sent=0)

    def feed(self, data):
        self.stats['rx_bytes'] += len(data)
        result = []
        for byte in data:
            if byte == 10:
                self.stats['lines'] += 1
                if not self.dropping:
                    result.append(self.pending.decode('utf-8', errors='replace').strip())
                self.pending.clear()
                self.dropping = False
            elif not self.dropping:
                if len(self.pending) >= 1024:
                    self.pending.clear()
                    self.dropping = True
                    self.stats['oversized_lines'] += 1
                else:
                    self.pending.append(byte)
        return result

def capture(stream, expected_version, seconds, emit, *, listen_only=False,
            clock=time.monotonic):
    reader = Lines()
    started = clock()
    hello_id, status_id = 'diag-' + uuid.uuid4().hex[:12], None
    hello_sent = False
    identity = 'not_requested' if listen_only else 'not_received'
    status_received = False
    rom_download = False

    def send(operation, request_id):
        payload = ('CP1 ' + json.dumps({'id': request_id, 'protocolVersion': 1,
                   'operation': operation}, separators=(',', ':')) + '\n').encode()
        written = stream.write(payload)
        reader.stats['tx_bytes'] += written
        reader.stats['requests_sent'] += 1
        if written != len(payload):
            raise OSError('Short serial write')
        emit({'kind': 'diagnostic_request', 'operation': operation})

    try:
        while clock() - started < seconds:
            data = stream.read(max(1, min(getattr(stream, 'in_waiting', 0), 4096)))
            for line in reader.feed(data):
                marker = classify(line)
                if marker:
                    emit(marker)
                    if marker.get('code') in ('rom_waiting_for_download', 'rom_download_mode'):
                        rom_download = True
                if not line.startswith('CP1 '):
                    continue
                reader.stats['cp1_frames'] += 1
                try:
                    frame = json.loads(line[4:])
                    if not isinstance(frame, dict):
                        raise ValueError()
                except ValueError:
                    reader.stats['malformed_cp1'] += 1
                    continue
                response_id = frame.get('id')
                is_hello = hello_sent and identity == 'not_received' and response_id == hello_id
                is_status = status_id is not None and response_id == status_id and not status_received
                if not is_hello and not is_status:
                    reader.stats['unrelated_cp1'] += 1
                    continue
                result = frame.get('result')
                if frame.get('ok') is not True or not isinstance(result, dict):
                    emit({'kind': 'diagnostic_protocol_error', 'operation': 'hello' if is_hello else 'getStatus'})
                    return reader.stats
                if is_hello:
                    version = result.get('firmwareVersion')
                    if (not isinstance(version, str) or not VERSION.fullmatch(version)
                            or result.get('protocolVersion') != 1
                            or not re.fullmatch(r'codepulse-[0-9a-fA-F]{12}', str(result.get('deviceId', '')))):
                        emit({'kind': 'diagnostic_protocol_error', 'operation': 'hello'})
                        return reader.stats
                    identity = 'matches' if version == expected_version else 'mismatch'
                    emit({'kind': 'identity', 'firmware_version': version,
                          'expected_version_matches': identity == 'matches'})
                    if identity == 'mismatch':
                        return reader.stats
                    status_id = 'diag-' + uuid.uuid4().hex[:12]
                    send('getStatus', status_id)
                else:
                    safe = {'kind': 'status'}
                    for key in ('provisioned', 'wifiConnected', 'desktopReachable'):
                        if type(result.get(key)) is bool:
                            safe[key] = result[key]
                    if result.get('state') in ('unprovisioned', 'applying', 'wifi_error', 'desktop_unreachable', 'ready'):
                        safe['state'] = result['state']
                    if type(result.get('configurationGeneration')) is int:
                        safe['configurationGeneration'] = result['configurationGeneration']
                    emit(safe)
                    status_received = True
            # Listen first. Exactly one hello; do not send commands into known ROM download mode.
            if not listen_only and not hello_sent and not rom_download and clock() - started >= 3:
                send('hello', hello_id)
                hello_sent = True
        return reader.stats
    finally:
        emit({'kind': 'diagnostic_summary', **reader.stats,
              'identity': identity, 'status_received': status_received,
              'rom_download_marker_seen': rom_download,
              'elapsed_seconds': round(clock() - started, 1),
              'partial_line_bytes': len(reader.pending),
              'interpretation': 'Missing markers do not prove a boot stage was not reached.'})

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--station', type=Path, required=True)
    parser.add_argument('--run', required=True)
    parser.add_argument('--port', required=True)
    parser.add_argument('--seconds', type=int, default=60)
    parser.add_argument('--listen-only', action='store_true')
    args = parser.parse_args()
    if not 5 <= args.seconds <= 180:
        parser.error('--seconds must be 5..180')
    folder, run = runner.run_folder(args.station.resolve(), args.run)
    manifest, _ = runner.release(args.station.resolve(), run['release_id'])
    if (manifest['application']['sha256'] != run['application_sha256']
            or manifest['firmware_version'] != run['expected_version']):
        raise ValueError('Run/release image mismatch')
    evidence = folder / ('observation-diagnostic-' + datetime.now(timezone.utc).strftime('%H%M%S')
                         + '-' + uuid.uuid4().hex[:6] + '.jsonl')
    with evidence.open('x', encoding='utf-8') as output:
        def emit(record):
            record = {'observed_at': runner.now(), **record}
            text = json.dumps(record, ensure_ascii=False)
            output.write(text + '\n')
            output.flush()
            print(text, flush=True)
        emit({'kind': 'diagnostic_started', 'run_id': run['run_id'],
              'tool_version': '1.0.0', 'listen_only': args.listen_only,
              'expected_version': run['expected_version']})
        try:
            with runner.serial_open(args.port) as stream:
                emit({'kind': 'serial_opened', 'dtr': False, 'rts': False})
                capture(stream, run['expected_version'], args.seconds, emit, listen_only=args.listen_only)
        except Exception as error:
            # Exception messages may embed paths or arbitrary incoming data. Keep only a fixed code.
            known = {'SerialException', 'SerialTimeoutException', 'PermissionError', 'OSError', 'TimeoutError'}
            name = type(error).__name__
            emit({'kind': 'diagnostic_error', 'code': name if name in known else 'unexpected_error'})
            return 1
        finally:
            emit({'kind': 'diagnostic_finished', 'boot_receipt_modified': False,
                  'note': 'Diagnostic capture ending is not a boot or visual success verdict.'})
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
