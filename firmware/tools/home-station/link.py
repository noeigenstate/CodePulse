"""One home LAB pairing attempt with bounded, redacted display observation.

Companion to the unchanged r2 station. Never flashes, resets, retries pairing,
changes test scenarios, or modifies the original flash receipt.
"""
from __future__ import annotations
import argparse
from collections import deque
import getpass
import http.client
import ipaddress
import json
import re
import sys
import time
import uuid
import warnings
from pathlib import Path
import diagnose
import runner

class Stop(Exception):
    """Fixed, non-sensitive failure code."""

class Protocol:
    def __init__(self, stream, emit, clock=time.monotonic):
        self.stream, self.emit, self.clock = stream, emit, clock
        self.reader, self.pending = diagnose.Lines(), deque()

    def line(self):
        # Drain buffered lines before another potentially blocking read.
        if not self.pending:
            self.pending.extend(self.reader.feed(self.stream.read(
                max(1, min(getattr(self.stream, 'in_waiting', 0), 4096)))))
        if not self.pending:
            return None
        line = self.pending.popleft()
        event = diagnose.classify(line)
        if event:
            self.emit(event)
            if (event.get('code') in ('display_fault_stop', 'panic', 'boot_image_error',
                                     'rom_waiting_for_download', 'rom_download_mode',
                                     'power_hold_rejected')
                    or (event.get('kind') == 'display' and event.get('result') != 'ESP_OK')):
                raise Stop('device_fault')
        return line

    def request(self, operation, params=None, timeout=15):
        request_id = 'link-' + uuid.uuid4().hex[:12]
        frame = dict(id=request_id, protocolVersion=1, operation=operation)
        if params is not None:
            frame['params'] = params
        payload = ('CP1 ' + json.dumps(frame, ensure_ascii=False, separators=(',', ':')) + '\n').encode()
        if len(payload) > 1024:
            raise Stop('request_too_large')
        written = self.stream.write(payload)
        self.reader.stats['requests_sent'] += 1
        if isinstance(written, int):
            self.reader.stats['tx_bytes'] += written
        if written != len(payload):
            raise Stop('short_write')
        self.emit(dict(kind='link_request', operation=operation))
        until = self.clock() + timeout
        while self.clock() < until:
            line = self.line()
            if not line or not line.startswith('CP1 '):
                continue
            self.reader.stats['cp1_frames'] += 1
            try:
                response = json.loads(line[4:])
                if not isinstance(response, dict):
                    raise ValueError()
            except ValueError:
                self.reader.stats['malformed_cp1'] += 1
                continue
            if response.get('id') != request_id:
                self.reader.stats['unrelated_cp1'] += 1
                continue
            if response.get('ok') is not True or not isinstance(response.get('result'), dict):
                raise Stop('protocol_rejected')
            return response['result']
        raise Stop('reply_timeout')

def safe_status(value):
    if (any(type(value.get(k)) is not bool for k in ('provisioned', 'wifiConnected', 'desktopReachable'))
            or value.get('state') not in ('unprovisioned', 'applying', 'wifi_error', 'desktop_unreachable', 'ready')
            or type(value.get('configurationGeneration')) is not int
            or not 0 <= value['configurationGeneration'] <= 0xffffffff):
        raise Stop('invalid_status')
    return {k: value[k] for k in ('provisioned', 'wifiConnected', 'desktopReachable', 'state', 'configurationGeneration')}

def pair(protocol, expected_version, params, emit, *, clock=time.monotonic,
         ready_seconds=90, settle_seconds=25):
    # A pending display fault/ROM marker must stop us before any request.
    listen_until = clock() + 3
    while clock() < listen_until:
        protocol.line()
    identity = protocol.request('hello', timeout=15)
    if (identity.get('firmwareVersion') != expected_version or identity.get('protocolVersion') != 1
            or identity.get('hardwareRevision') != 1
            or not re.fullmatch(r'codepulse-[0-9a-fA-F]{12}', str(identity.get('deviceId', '')))):
        raise Stop('identity_mismatch')
    emit(dict(kind='identity', firmware_version=expected_version, expected_version_matches=True))
    before = safe_status(protocol.request('getStatus'))
    emit(dict(kind='status', phase='before', **before))
    # Exactly one provision. A missing reply may still mean saved: never retry it.
    result = protocol.request('provision', params)
    if result.get('saved') is not True or result.get('applyQueued') is not True:
        raise Stop('save_not_confirmed')
    emit(dict(kind='pairing_saved', saved=True, apply_queued=True))
    until, poll_at, ready_at = clock() + ready_seconds, clock(), None
    while clock() < until:
        if clock() >= poll_at:
            status = safe_status(protocol.request('getStatus', timeout=min(5, max(0.1, until - clock()))))
            emit(dict(kind='status', phase='after', **status))
            changed = status['configurationGeneration'] != before['configurationGeneration']
            if (changed and status['state'] == 'ready' and
                    all(status[k] for k in ('provisioned', 'wifiConnected', 'desktopReachable'))):
                if ready_at is None:
                    ready_at = clock()
                    until = ready_at + settle_seconds
                    emit(dict(kind='network_ready', new_configuration=True, optical_verified=False))
            elif ready_at is not None:
                raise Stop('connection_lost_after_ready')
            poll_at = clock() + 2
        protocol.line()
    if ready_at is None:
        raise Stop('ready_timeout')
    emit(dict(kind='link_complete', network_ready=True, optical_acceptance='requires_operator_observation'))

def local_pairing(station, host, port):
    address = ipaddress.IPv4Address(host)
    if not address.is_private or address.is_loopback or address.is_unspecified or address.is_multicast:
        raise Stop('invalid_lan_address')
    if not 1024 <= port <= 65535:
        raise Stop('invalid_port')
    # Reuse, never regenerate, the token already used by the running LAB server.
    state = json.loads((station / '.local' / 'station.json').read_text(encoding='utf-8'))
    if (not re.fullmatch(r'lab-[0-9a-f]{32}', str(state.get('server_id', '')))
            or not re.fullmatch(r'[!-~]{16,128}', str(state.get('token', '')))):
        raise Stop('invalid_local_station')
    for path in ('health', 'status'):
        connection = http.client.HTTPConnection(host, port, timeout=5)
        try:
            connection.request('GET', '/api/v1/device/' + path,
                               headers={'X-CodePulse-Device-Token': state['token']} if path == 'status' else {})
            response = connection.getresponse()
            body = response.read(65537)
            if response.status != 200 or len(body) > 65536:
                raise Stop('lab_preflight_failed')
            data = json.loads(body)
            if path == 'health':
                if data.get('testData') is not True or data.get('protocolVersion') != 1:
                    raise Stop('not_lab_service')
            elif data.get('revision') != 'lab-1b1c14df1dd22b9146608a85':
                raise Stop('lab_not_initial_wait')
        finally:
            connection.close()
    return state

def credentials():
    if not sys.stdin.isatty():
        raise Stop('interactive_terminal_required')
    ssid = input('Home 2.4GHz Wi-Fi SSID (not recorded): ')
    # Never allow getpass to silently fall back to echoed password entry.
    with warnings.catch_warnings():
        warnings.simplefilter('error', getpass.GetPassWarning)
        password = getpass.getpass('Wi-Fi password (hidden; not saved): ')
    size = len(password.encode())
    if not 1 <= len(ssid.encode()) <= 32 or (password and not (
            8 <= size <= 63 or (size == 64 and re.fullmatch('[0-9a-fA-F]{64}', password)))):
        raise Stop('invalid_wifi_fields')
    return ssid, password

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--station', required=True, type=Path)
    parser.add_argument('--run', required=True)
    parser.add_argument('--port', required=True)
    parser.add_argument('--host', required=True)
    parser.add_argument('--server-port', type=int, default=17889)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    station = args.station.resolve()
    folder, run = runner.run_folder(station, args.run)
    manifest, _ = runner.release(station, run['release_id'])
    if (not args.apply or not re.fullmatch(r'COM[1-9][0-9]*', args.port)
            or run['expected_version'] != '0.0.22-pair150-trial'
            or manifest['firmware_version'] != run['expected_version']
            or manifest['application']['sha256'] != run['application_sha256']):
        raise Stop('invalid_request_or_release')
    evidence = folder / ('observation-link-' + uuid.uuid4().hex[:12] + '.jsonl')
    with evidence.open('x', encoding='utf-8') as output:
        def emit(event):
            text = json.dumps(dict(observed_at=runner.now(), **event), ensure_ascii=False)
            output.write(text + '\n'); output.flush()
            print(text, flush=True)
        emit(dict(kind='link_started', run_id=run['run_id'], tool_version='1.0.0'))
        protocol = None
        try:
            state = local_pairing(station, args.host, args.server_port)
            emit(dict(kind='lab_preflight', local_http_authenticated=True, scenario='wait', device_reachability_proven=False))
            ssid, password = credentials()
            with runner.serial_open(args.port) as stream:
                emit(dict(kind='serial_opened', dtr=False, rts=False))
                protocol = Protocol(stream, emit)
                pair(protocol, run['expected_version'], dict(wifiSsid=ssid, wifiPassword=password,
                    serverId=state['server_id'], deviceToken=state['token'],
                    fallbackHost=args.host, fallbackPort=args.server_port), emit)
            return 0
        except (Exception, KeyboardInterrupt) as error:
            emit(dict(kind='link_error', code=str(error) if isinstance(error, Stop) else
                      'operator_cancelled' if isinstance(error, KeyboardInterrupt) else 'operation_failed'))
            return 1
        finally:
            if protocol:
                emit(dict(kind='link_transport', **protocol.reader.stats))
            emit(dict(kind='link_finished', flash_receipt_modified=False, automatic_retry=False))

if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        print('STOP: ' + (str(error) if isinstance(error, Stop) else 'validation_failed'), file=sys.stderr)
        raise SystemExit(1)
