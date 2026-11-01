"""CodePulse field station: verify, app-only flash, observe and return evidence.

No firmware build, project Git operations, automatic reset or automatic retry.
"""
from __future__ import annotations
import argparse
import hashlib
import importlib.metadata
import json
import re
import subprocess
import sys
import time
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHIP = 'esp32s3'
APP_OFFSET = '0x10000'
APP_BYTES = 1536000
PARTITION_SHA = '5295e8c42d6fb5f95e4e8a185932c6191d27cfc5078322475347e40e71af815a'
SAFE_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}\Z')
METRIC = re.compile(r'dashboard mode=(\w+) y=(\d+) height=(\d+) total=(\d+) refresh=(\d+) busy=(\d+) result=(\w+) init=(\d+) upload=(\d+) off=(\d+)(?: busy_assert=(\d+) busy_low=(\d+))?')

def now():
    return datetime.now(timezone.utc).isoformat()

def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()

def inside(root, relative):
    root = Path(root).resolve()
    path = (root / relative).resolve()
    if not path.is_relative_to(root) or path == root:
        raise ValueError('Path must stay inside its package/run directory')
    return path

def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

def release(root, release_id):
    if not SAFE_ID.fullmatch(release_id):
        raise ValueError('Invalid release ID')
    folder = inside(root, 'releases/' + release_id)
    data = json.loads((folder / 'release.json').read_text(encoding='utf-8'))
    if data.get('schema') != 1 or data.get('release_id') != release_id:
        raise ValueError('Release manifest identity mismatch')
    target = data.get('target', {})
    if target != {'chip': CHIP, 'board': 'CodePulse-Board1-existing-prototype',
                  'flash_size': '16MB', 'app_offset': APP_OFFSET, 'app_bytes': APP_BYTES}:
        raise ValueError('Unsupported board or partition layout')
    if data.get('kind') not in ('baseline', 'trial'):
        raise ValueError('Unsupported release kind')
    image = inside(folder, data['application']['file'])
    if image.stat().st_size != data['application']['bytes'] or not 0 < image.stat().st_size <= APP_BYTES:
        raise ValueError('Application size mismatch/out of partition')
    if sha(image) != data['application']['sha256']:
        raise ValueError('Application SHA256 mismatch')
    with image.open('rb') as stream:
        if stream.read(1) != b'\xe9':
            raise ValueError('Not an ESP application image')
    partition = inside(folder, data['partition_reference']['file'])
    if data['partition_reference']['sha256'] != PARTITION_SHA or sha(partition) != PARTITION_SHA:
        raise ValueError('Unexpected partition reference')
    plan = inside(folder, data['test_plan']['file'])
    if sha(plan) != data['test_plan']['sha256']:
        raise ValueError('Test plan SHA256 mismatch')
    return data, image

def create_run(root, release_id):
    data, _ = release(root, release_id)
    run_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8]
    folder = inside(root, 'runs/' + run_id)
    folder.mkdir(parents=True, exist_ok=False)
    (folder / 'photos').mkdir()
    write_json(folder / 'run.json', {'schema': 1, 'run_id': run_id, 'release_id': release_id,
        'expected_version': data['firmware_version'], 'application_sha256': data['application']['sha256'],
        'created_at': now(), 'test_plan_id': data['test_plan_id']})
    template = (Path(root) / 'FEEDBACK-TEMPLATE.md').read_text(encoding='utf-8')
    (folder / 'report.md').write_text(template.replace('{{RUN_ID}}', run_id).replace('{{RELEASE_ID}}', release_id), encoding='utf-8')
    return folder

def run_folder(root, run_id):
    if not SAFE_ID.fullmatch(run_id):
        raise ValueError('Invalid run ID')
    folder = inside(root, 'runs/' + run_id)
    data = json.loads((folder / 'run.json').read_text(encoding='utf-8'))
    if data.get('run_id') != run_id:
        raise ValueError('Run ID mismatch')
    return folder, data

def flash_command(image, port):
    if not re.fullmatch(r'COM[1-9][0-9]*', port):
        raise ValueError('Select the actual Windows COM port; no automatic port selection')
    return [sys.executable, '-m', 'esptool', '--chip', CHIP, '--port', port, '--baud', '115200',
            '--before', 'usb-reset', '--after', 'no-reset', 'write-flash',
            '--flash-mode', 'dio', '--flash-freq', '80m', '--flash-size', '16MB', APP_OFFSET, str(image)]

def flash(root, args, invoke=subprocess.run):
    folder, run = run_folder(root, args.run)
    data, image = release(root, run['release_id'])
    if run['application_sha256'] != data['application']['sha256']:
        raise ValueError('Release changed after run creation')
    command = flash_command(image, args.port)
    if not args.execute:
        return {'dry_run': True, 'release_id': run['release_id'], 'version': data['firmware_version'],
                'app_sha256': sha(image), 'write_offset': APP_OFFSET,
                'command_arguments': command[2:-1] + [image.name], 'serial_opened': False}
    if not args.power_held or not args.known_prototype:
        raise ValueError('Fresh physical power-hold and known-prototype confirmations are required')
    if data['kind'] == 'trial' and not args.trial_approved:
        raise ValueError('This experimental release needs explicit trial approval')
    if importlib.metadata.version('esptool') != '5.6.0':
        raise ValueError('Use the pinned station environment with esptool 5.6.0')
    receipt_path = folder / 'flash.json'
    if receipt_path.exists():
        raise ValueError('This run already has a flash attempt; inspect it, then create a NEW run if approved')
    receipt = {'run_id': run['run_id'], 'release_id': run['release_id'], 'started_at': now(),
               'port': args.port, 'app_sha256': sha(image), 'offset': APP_OFFSET,
               'app_only': True, 'after': 'no-reset', 'esptool_version': '5.6.0',
               'write_verified': False, 'boot_verified': False, 'visual_acceptance': 'not_observed'}
    write_json(receipt_path, receipt)
    print('Writing application only. Keep holding function/power, not BOOT. No automatic retry.', flush=True)
    try:
        result = invoke(command, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=300)
        combined = result.stdout + result.stderr
        receipt['exit_code'] = result.returncode
        receipt['write_verified'] = result.returncode == 0 and 'Hash of data verified.' in combined
        # Only allowlisted conclusions return to the primary machine, not arbitrary process output.
        receipt['verification_message_seen'] = 'Hash of data verified.' in combined
        if not receipt['write_verified']:
            receipt['failure'] = 'write_or_verification_failed'
            print('Write did not pass the expected verification. Stop; do not automatically retry.', flush=True)
    except subprocess.TimeoutExpired:
        receipt['failure'] = 'write_timeout'
    except OSError:
        receipt['failure'] = 'flasher_launch_failed'
    finally:
        receipt['finished_at'] = now()
        write_json(receipt_path, receipt)
    return receipt

def serial_open(port):
    import serial
    # Configure both control lines before opening. Never intentionally pulse reset.
    stream = serial.Serial(port=None, baudrate=115200, timeout=0.2, write_timeout=2)
    stream.dtr = False
    stream.rts = False
    stream.port = port
    stream.open()
    return stream

class CP1:
    def __init__(self, stream):
        self.stream, self.buffer = stream, b''

    def line(self):
        self.buffer += self.stream.read(max(1, min(getattr(self.stream, 'in_waiting', 0), 4096)))
        if len(self.buffer) > 8192:
            self.buffer = b''
        if b'\n' not in self.buffer:
            return None
        line, self.buffer = self.buffer.split(b'\n', 1)
        return line.decode('utf-8', errors='replace').strip()

    def request(self, operation, params=None, timeout=15, observe=None):
        request_id = uuid.uuid4().hex[:12]
        frame = {'id': request_id, 'protocolVersion': 1, 'operation': operation}
        if params is not None:
            frame['params'] = params
        payload = ('CP1 ' + json.dumps(frame, ensure_ascii=False, separators=(',', ':')) + '\n').encode()
        if len(payload) > 1024:
            raise ValueError('CP1 request too long')
        self.stream.write(payload)
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            line = self.line()
            if line is None:
                continue
            if observe:
                observe(line)
            if not line.startswith('CP1 '):
                continue
            try:
                response = json.loads(line[4:])
            except (ValueError, TypeError):
                continue
            if not isinstance(response, dict):
                continue
            if response.get('id') == request_id:
                if response.get('ok') is not True:
                    raise RuntimeError('Device rejected CP1 operation (request contents omitted)')
                if not isinstance(response.get('result'), dict):
                    raise ValueError('Malformed CP1 response')
                return response['result']
        raise TimeoutError('CP1 reply timeout; no reset or automatic retry was performed')

def parse_metric(line):
    match = METRIC.search(line)
    if not match:
        return None
    values = match.groups()
    result = {'kind': 'display', 'observed_at': now(), 'mode': values[0], 'result': values[6]}
    for key, index in [('y', 1), ('height', 2), ('total_ms', 3), ('drive_ms', 4), ('busy_seen', 5),
                       ('init_ms', 7), ('upload_ms', 8), ('off_ms', 9), ('busy_assert_ms', 10), ('busy_low_ms', 11)]:
        result[key] = int(values[index]) if values[index] is not None else None
    return result

def observe(root, args):
    folder, run = run_folder(root, args.run)
    if not 5 <= args.seconds <= 900:
        raise ValueError('Observation must last 5..900 seconds')
    evidence = folder / ('observation-' + datetime.now(timezone.utc).strftime('%H%M%S') + '-' + uuid.uuid4().hex[:4] + '.jsonl')
    def record(value):
        with evidence.open('a', encoding='utf-8') as stream:
            stream.write(json.dumps(value, ensure_ascii=False) + '\n')
        print(json.dumps(value, ensure_ascii=False), flush=True)
    def consume(line):
        value = parse_metric(line)
        if value:
            record(value)
        elif 'display fault; stopping' in line:
            record({'kind': 'fault', 'observed_at': now(), 'code': 'display_fault'})
    record({'kind': 'observation_started', 'at': now(), 'run_id': run['run_id']})
    with serial_open(args.port) as stream:
        protocol = CP1(stream)
        hello = protocol.request('hello', timeout=40, observe=consume)
        version = hello.get('firmwareVersion')
        matches = version == run['expected_version']
        record({'kind': 'identity', 'observed_at': now(), 'firmware_version': version,
                'expected_version_matches': matches,
                'device_fingerprint': hashlib.sha256(str(hello.get('deviceId', '')).encode()).hexdigest()[:16]})
        if not matches:
            raise ValueError('Running firmware differs from selected release; stop this test')
        until = time.monotonic() + args.seconds
        poll_at = 0
        while time.monotonic() < until:
            if time.monotonic() >= poll_at:
                status = protocol.request('getStatus', timeout=15, observe=consume)
                record({'kind': 'status', 'observed_at': now(), **{key: status.get(key) for key in
                    ('provisioned', 'state', 'wifiConnected', 'desktopReachable', 'configurationGeneration')}})
                poll_at = time.monotonic() + 5
            line = protocol.line()
            if line:
                consume(line)
    record({'kind': 'observation_finished', 'at': now()})
    return {'evidence': evidence.name, 'visual_acceptance': 'ask the person viewing the panel'}

def export_feedback(root, run_id):
    folder, run = run_folder(root, run_id)
    allowed = [folder / 'run.json', folder / 'report.md']
    allowed += list(folder.glob('flash.json')) + list(folder.glob('observation-*.jsonl')) + list(folder.glob('stimulus-*.jsonl'))
    for p in (folder / 'photos').iterdir():
        if p.is_file() and p.suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp', '.mp4', '.mov'):
            allowed.append(p)
    for p in allowed:
        if p.is_symlink() or not p.resolve().is_relative_to(folder.resolve()):
            raise ValueError('Feedback file escapes run directory')
    if sum(p.stat().st_size for p in allowed) > 250 * 1024 * 1024:
        raise ValueError('Feedback exceeds 250 MB; shorten clips or transfer them separately')
    out = Path(root) / 'feedback'
    out.mkdir(exist_ok=True)
    archive = out / (run_id + '-' + uuid.uuid4().hex[:6] + '.zip')
    checks = '\n'.join(sha(p) + '  ' + p.relative_to(folder).as_posix() for p in sorted(allowed)) + '\n'
    with zipfile.ZipFile(archive, 'x', zipfile.ZIP_DEFLATED) as z:
        for p in allowed:
            z.write(p, run_id + '/' + p.relative_to(folder).as_posix())
        z.writestr(run_id + '/SHA256SUMS.txt', checks)
    archive.with_suffix('.zip.sha256').write_text(sha(archive) + '  ' + archive.name + '\n', encoding='ascii')
    return {'archive': str(archive), 'sha256': sha(archive), 'release_id': run['release_id'],
            'note': 'Only allowlisted evidence exported; review report/photos for private content before transfer'}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('ports')
    for name in ('verify', 'new-run'):
        sub.add_parser(name).add_argument('--release', required=True)
    f = sub.add_parser('flash')
    f.add_argument('--run', required=True); f.add_argument('--port', required=True)
    for flag in ('execute', 'power-held', 'known-prototype', 'trial-approved'):
        f.add_argument('--' + flag, action='store_true')
    o = sub.add_parser('observe')
    o.add_argument('--run', required=True); o.add_argument('--port', required=True)
    o.add_argument('--seconds', type=int, default=120)
    sub.add_parser('export').add_argument('--run', required=True)
    args = parser.parse_args()
    if args.command == 'ports':
        from serial.tools.list_ports import comports
        result = [{'port': p.device, 'description': p.description, 'vid': p.vid, 'pid': p.pid} for p in comports()]
    elif args.command == 'verify':
        data, _ = release(ROOT, args.release)
        result = {'verified': True, 'release_id': args.release, 'version': data['firmware_version'], 'kind': data['kind'], 'serial_opened': False}
    elif args.command == 'new-run':
        result = {'run': create_run(ROOT, args.release).name}
    elif args.command == 'flash':
        result = flash(ROOT, args)
    elif args.command == 'observe':
        result = observe(ROOT, args)
    else:
        result = export_feedback(ROOT, args.run)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if args.command == 'flash' and args.execute and not result.get('write_verified') else 0

if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('Stopped by operator. No automatic retry.', file=sys.stderr); sys.exit(130)
    except Exception as error:
        # Serial/transport exception strings may contain host/device information.
        print(f'STOP: {type(error).__name__}: ' + (str(error) if isinstance(error, (ValueError, TimeoutError)) else 'operation failed; stop and report the stage'), file=sys.stderr)
        sys.exit(1)
