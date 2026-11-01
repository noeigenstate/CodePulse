"""Optional local fixed-data station; manual scenario changes only, never real accounts."""
from __future__ import annotations
import argparse
import getpass
import hashlib
import hmac
import ipaddress
import json
import secrets
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from runner import ROOT, CP1, now, run_folder, serial_open, write_json

SCENARIOS = ('wait', 'run', 'done', 'long-title', 'six', 'nine', 'usage')

def sample(scenario):
    if scenario not in SCENARIOS:
        raise ValueError('Choose a documented test scenario')
    count = 9 if scenario == 'nine' else 6 if scenario == 'six' else 3
    state = 'thinking' if scenario == 'run' else 'done' if scenario == 'done' else 'waiting_permission'
    quota = 12 if scenario == 'run' else 1
    rows = [{'id': f'lab-task-{i}', 'type': 'codex',
             'title': ('低闪烁标题与状态更新对照' if scenario == 'long-title' and i == 0 else f'LAB 任务 {i + 1}'),
             'detail': '固定测试数据', 'state': state if i == 0 else 'thinking'} for i in range(count)]
    data = {'protocolVersion': 1, 'mainState': 'running' if scenario == 'run' else 'done' if scenario == 'done' else 'waiting_permission',
            'activeAgent': 'codex', 'message': 'LAB 固定测试数据',
            'agents': [{'type': 'codex', 'state': state, 'project': 'LAB', 'model': None,
                        'activity': '固定测试数据', 'needsAttention': state == 'waiting_permission',
                        'tokens': None, 'quotas': [{'id': 'codex', 'name': 'Codex', 'fiveHour': None,
                            'weekly': {'usedPercent': quota, 'resetsAt': None, 'windowMinutes': 10080}}], 'updatedAt': 0}],
            'updatedAt': 0, 'display': {'version': 1, 'mode': 'usage' if scenario == 'usage' else 'hud',
                'metric': 'remaining', 'showQuota': True, 'showEnvironment': True, 'agents': ['codex'], 'page': 0},
            'threadTotal': count, 'threads': rows}
    encoded = json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()
    data['revision'] = 'lab-' + hashlib.sha256(encoded).hexdigest()[:24]
    return data

def station_state(root):
    folder = Path(root) / '.local'
    folder.mkdir(exist_ok=True)
    path = folder / 'station.json'
    if path.exists():
        value = json.loads(path.read_text(encoding='utf-8'))
        if not isinstance(value.get('token'), str) or not 16 <= len(value['token']) <= 128:
            raise ValueError('Invalid local station state')
        return value
    value = {'server_id': 'lab-' + uuid.uuid4().hex, 'token': secrets.token_hex(32)}
    with path.open('x', encoding='utf-8') as stream:
        json.dump(value, stream)
    return value

class TestStation:
    def __init__(self, token, initial='wait', record=None):
        self.token, self.current = token, initial
        self.condition = threading.Condition()
        self.record = record or (lambda value: None)
        self.stopped = False
        self.last_change = 0.0

    def set(self, name):
        sample(name)
        with self.condition:
            if name == self.current:
                return False
            # This is the manual test's observation interval, not device refresh policy.
            if time.monotonic() - self.last_change < 10:
                raise ValueError('Wait at least 10 seconds and inspect the panel before the next test step')
            self.current = name
            self.last_change = time.monotonic()
            self.record({'kind': 'stimulus', 'at': now(), 'scenario': name, 'revision': sample(name)['revision']})
            self.condition.notify_all()
            return True

    def payload(self, conditional, wait_ms):
        with self.condition:
            initial = self.current
            data = sample(self.current)
            etag = 'W/"' + data['revision'] + '"'
            if conditional == etag and wait_ms:
                self.condition.wait_for(lambda: self.stopped or self.current != initial, wait_ms / 1000)
                data = sample(self.current)
                etag = 'W/"' + data['revision'] + '"'
            return data, etag

def handler(station):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'
        def log_message(self, *_):
            pass  # No request URLs, tokens, client identities or raw headers in logs.
        def send(self, code, data=None, etag=None):
            body = json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode() if data is not None else b''
            self.send_response(code)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Cache-Control', 'private, no-cache')
            self.send_header('X-CodePulse-Protocol-Version', '1')
            if etag:
                self.send_header('ETag', etag)
            self.end_headers()
            if body:
                self.wfile.write(body)
        def do_GET(self):
            if self.path == '/api/v1/device/health':
                return self.send(200, {'ok': True, 'service': 'codepulse-device', 'protocolVersion': 1, 'testData': True})
            if self.path != '/api/v1/device/status':
                return self.send(404, {'error': 'not_found'})
            supplied = self.headers.get('X-CodePulse-Device-Token', '')
            if not hmac.compare_digest(supplied.encode('utf-8'), station.token.encode('utf-8')):
                return self.send(401, {'error': 'unauthorized'})
            try:
                wait = int(self.headers.get('X-CodePulse-Wait-Ms', '0'))
                if not 0 <= wait <= 1000:
                    raise ValueError()
            except ValueError:
                return self.send(400, {'error': 'invalid_wait'})
            data, etag = station.payload(self.headers.get('If-None-Match'), wait)
            return self.send(304 if self.headers.get('If-None-Match') == etag else 200,
                             None if self.headers.get('If-None-Match') == etag else data, etag)
        def do_POST(self):
            self.send(405, {'error': 'read_only'})
    return Handler

def serve(args):
    address = ipaddress.IPv4Address(args.bind)
    if not address.is_private or address.is_unspecified or address.is_multicast:
        raise ValueError('Bind a specific private LAN IPv4 (or loopback for software tests)')
    if not 1024 <= args.port <= 65535:
        raise ValueError('Use an unprivileged local port')
    folder, _ = run_folder(ROOT, args.run)
    state = station_state(ROOT)
    evidence = folder / ('stimulus-' + uuid.uuid4().hex[:8] + '.jsonl')
    def record(value):
        with evidence.open('a', encoding='utf-8') as stream:
            stream.write(json.dumps(value, ensure_ascii=False) + '\n')
    station = TestStation(state['token'], record=record)
    server = ThreadingHTTPServer((args.bind, args.port), handler(station))
    server.daemon_threads = True
    record({'kind': 'stimulus_started', 'at': now(), 'scenario': 'wait', 'revision': sample('wait')['revision']})
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    print('LAB fixed data only. No automatic sequence. Commands: ' + ', '.join(SCENARIOS) + ', quit', flush=True)
    try:
        while True:
            command = input('scenario> ').strip()
            if command == 'quit':
                break
            try:
                changed = station.set(command)
                print('Changed; inspect the physical panel.' if changed else 'Unchanged; no new revision.')
            except ValueError as error:
                print(error)
    finally:
        with station.condition:
            station.stopped = True
            station.condition.notify_all()
        server.shutdown(); server.server_close()
        record({'kind': 'stimulus_stopped', 'at': now()})

def provision(args):
    address = ipaddress.IPv4Address(args.host)
    if not address.is_private or address.is_loopback or address.is_unspecified or address.is_multicast:
        raise ValueError('Use the reachable home LAN IPv4; not localhost or the office address')
    if not args.apply:
        raise ValueError('Provisioning changes the device Wi-Fi/host pairing; pass --apply only after choosing this setup')
    if not sys.stdin.isatty():
        raise ValueError('Run provisioning in an interactive local terminal so the user can enter a hidden password')
    if not 1024 <= args.server_port <= 65535:
        raise ValueError('Invalid station port')
    state = station_state(ROOT)
    ssid = input('Home 2.4GHz Wi-Fi SSID (not recorded): ')
    password = getpass.getpass('Wi-Fi password (hidden, not saved): ')
    size = len(password.encode())
    if not 1 <= len(ssid.encode()) <= 32 or (password and not (8 <= size <= 63 or (size == 64 and all(c in '0123456789abcdefABCDEF' for c in password)))):
        raise ValueError('Invalid Wi-Fi field length')
    with serial_open(args.port) as stream:
        protocol = CP1(stream)
        identity = protocol.request('hello', timeout=40)
        if identity.get('protocolVersion') != 1 or identity.get('hardwareRevision') != 1:
            raise ValueError('Unexpected board identity')
        result = protocol.request('provision', {'wifiSsid': ssid, 'wifiPassword': password,
            'serverId': state['server_id'], 'deviceToken': state['token'],
            'fallbackHost': args.host, 'fallbackPort': args.server_port})
        if result.get('saved') is not True:
            raise ValueError('Provisioning did not report saved')
        print('Pairing saved; waiting for Wi-Fi AND authenticated station access.', flush=True)
        until = time.monotonic() + 90
        while time.monotonic() < until:
            status = protocol.request('getStatus', timeout=15)
            if all(status.get(k) is True for k in ('provisioned', 'wifiConnected', 'desktopReachable')) and status.get('state') == 'ready':
                print('READY: connected to home fixed-data station. This is not office live synchronization.')
                return
            time.sleep(1)
        raise TimeoutError('Pairing saved but READY not confirmed; inspect Wi-Fi, station bind and private-network firewall')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    s = sub.add_parser('serve'); s.add_argument('--run', required=True); s.add_argument('--bind', required=True); s.add_argument('--port', type=int, default=17889)
    p = sub.add_parser('provision'); p.add_argument('--port', required=True); p.add_argument('--host', required=True); p.add_argument('--server-port', type=int, default=17889); p.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if args.command == 'serve': serve(args)
    else: provision(args)

if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as error:
        print(f'STOP: {type(error).__name__}: ' + (str(error) if isinstance(error, (ValueError, TimeoutError)) else 'station operation failed; no request payload logged'), file=sys.stderr)
        sys.exit(1)
