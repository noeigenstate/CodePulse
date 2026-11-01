import argparse
import json
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.request
import urllib.error
import zipfile
from pathlib import Path
from unittest.mock import patch
import runner
import stimulus
import make_release

class StationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.folder = self.root / 'releases/test-release'
        self.folder.mkdir(parents=True)
        (self.folder / 'app.bin').write_bytes(b'\xe9' + b'test-image' * 50)
        (self.folder / 'partition.bin').write_bytes(b'partition fixture')
        (self.folder / 'TEST-PLAN.md').write_text('Manual observation plan', encoding='utf-8')
        self.data = {'schema': 1, 'release_id': 'test-release', 'kind': 'trial',
                     'firmware_version': 'test-version', 'test_plan_id': 'test-plan',
                     'target': {'chip': 'esp32s3', 'board': 'CodePulse-Board1-existing-prototype', 'flash_size': '16MB', 'app_offset': '0x10000', 'app_bytes': runner.APP_BYTES},
                     'application': {'file': 'app.bin', 'bytes': (self.folder/'app.bin').stat().st_size, 'sha256': runner.sha(self.folder/'app.bin')},
                     'partition_reference': {'file': 'partition.bin', 'sha256': runner.sha(self.folder/'partition.bin')},
                     'test_plan': {'file': 'TEST-PLAN.md', 'sha256': runner.sha(self.folder/'TEST-PLAN.md')}}
        runner.write_json(self.folder/'release.json', self.data)
        self.addCleanup(patch.stopall)
        patch.object(runner, 'PARTITION_SHA', self.data['partition_reference']['sha256']).start()
        (self.root/'FEEDBACK-TEMPLATE.md').write_text('RUN {{RUN_ID}}\n{{RELEASE_ID}}\nPending', encoding='utf-8')
        self.run = runner.create_run(self.root, 'test-release')

    def args(self, **changes):
        values = {'run': self.run.name, 'port': 'COM6', 'execute': False, 'power_held': False, 'known_prototype': False, 'trial_approved': False}
        values.update(changes)
        return argparse.Namespace(**values)

    def test_verify_never_opens_serial(self):
        with patch.object(runner, 'serial_open', side_effect=AssertionError('serial')):
            self.assertEqual(runner.release(self.root, 'test-release')[0]['firmware_version'], 'test-version')

    def test_export_release_checks_partition_and_never_overwrites(self):
        args = [self.root/'releases', self.folder/'app.bin', self.folder/'partition.bin', self.folder/'TEST-PLAN.md',
                'generated-release', 'test-version', 'trial', 'a'*40, 'not physically tested']
        output = make_release.make_release(*args)
        self.assertTrue((output/'SHA256SUMS.txt').exists())
        self.assertEqual(runner.release(self.root, 'generated-release')[0]['source_checkpoint'], 'a'*40)
        with self.assertRaises(FileExistsError): make_release.make_release(*args)

    def test_rejects_bad_hash_size_path_and_layout(self):
        mutations = [lambda d: d['application'].update(sha256='0'*64),
                     lambda d: d['application'].update(bytes=1),
                     lambda d: d['application'].update(file='../../outside.bin'),
                     lambda d: d['target'].update(app_offset='0x9000')]
        for mutation in mutations:
            copy = json.loads(json.dumps(self.data)); mutation(copy)
            runner.write_json(self.folder/'release.json', copy)
            with self.assertRaises((ValueError, FileNotFoundError)):
                runner.release(self.root, 'test-release')
        runner.write_json(self.folder/'release.json', self.data)

    def test_dry_run_never_invokes_flasher(self):
        result = runner.flash(self.root, self.args(), invoke=lambda *a,**k: self.fail('must not flash'))
        self.assertFalse(result['serial_opened'])
        self.assertFalse((self.run/'flash.json').exists())

    def test_all_three_physical_trial_guards_precede_flash(self):
        for flags in ({}, {'power_held': True}, {'power_held': True, 'known_prototype': True}):
            with self.assertRaises(ValueError):
                runner.flash(self.root, self.args(execute=True, **flags), invoke=lambda *a,**k: self.fail('guard bypass'))
        self.assertFalse((self.run/'flash.json').exists())

    def test_app_only_write_and_verification_separate_from_boot(self):
        def invoke(command, **kwargs):
            self.assertEqual(command[-2], '0x10000')
            self.assertEqual(command.count('write-flash'), 1)
            self.assertIn('no-reset', command)
            for forbidden in ('erase-flash', '--erase-all', '--force', '0x9000', '0x8000', '0x0'):
                self.assertNotIn(forbidden, command)
            return subprocess.CompletedProcess(command, 0, 'Hash of data verified.\n', '')
        with patch.object(runner.importlib.metadata, 'version', return_value='5.6.0'):
            args = self.args(execute=True,power_held=True,known_prototype=True,trial_approved=True)
            result = runner.flash(self.root, args, invoke)
            self.assertTrue(result['write_verified'])
            self.assertFalse(result['boot_verified'])
            self.assertEqual(result['visual_acceptance'], 'not_observed')
            with self.assertRaises(ValueError): runner.flash(self.root, args, invoke)

    def test_nonzero_or_missing_hash_is_failure_without_retry(self):
        for code, text in [(1, 'Hash of data verified.'), (0, 'write ended')]:
            new = runner.create_run(self.root, 'test-release')
            calls = []
            def invoke(command, **kwargs):
                calls.append(command); return subprocess.CompletedProcess(command, code, text, '')
            with patch.object(runner.importlib.metadata,'version',return_value='5.6.0'):
                result = runner.flash(self.root, self.args(run=new.name,execute=True,power_held=True,known_prototype=True,trial_approved=True), invoke)
            self.assertFalse(result['write_verified']); self.assertEqual(len(calls), 1)

    def test_unknown_logs_do_not_enter_metrics(self):
        self.assertIsNone(runner.parse_metric('CP1 {"wifiPassword":"DO-NOT-EXPORT","deviceToken":"SECRET"}'))
        value = runner.parse_metric('I board: dashboard mode=pair125 y=39 height=216 total=2871 refresh=2632 busy=1 result=ESP_OK init=81 upload=87 off=69 busy_assert=2 busy_low=2630')
        self.assertEqual(value['drive_ms'], 2632)
        self.assertEqual(value['result'], 'ESP_OK')
        self.assertEqual(value['init_ms'], 81)
        self.assertEqual(value['busy_low_ms'], 2630)

    def test_serial_control_lines_set_before_open(self):
        events=[]
        class FakeSerial:
            def __init__(self,**kwargs): self.assert_port = kwargs['port']
            def __setattr__(self,key,value): events.append((key,value)); object.__setattr__(self,key,value)
            def open(self): events.append(('open',True))
        import serial
        with patch.object(serial,'Serial',FakeSerial): runner.serial_open('COM7')
        self.assertLess(events.index(('dtr',False)), events.index(('open',True)))
        self.assertLess(events.index(('rts',False)), events.index(('open',True)))

    def test_cp1_fragmented_reply_noise_and_unrelated_id(self):
        class Stream:
            in_waiting = 7
            buffer = b''
            def write(self, request):
                frame = json.loads(request.decode()[4:])
                response = {'id': frame['id'], 'ok': True, 'result': {'firmwareVersion': 'test'}}
                self.buffer = b'noise\nCP1 []\nCP1 {"id":"another"}\n' + ('CP1 ' + json.dumps(response) + '\n').encode()
            def read(self, size):
                chunk, self.buffer = self.buffer[:size], self.buffer[size:]
                return chunk
        self.assertEqual(runner.CP1(Stream()).request('hello')['firmwareVersion'], 'test')

    def test_provision_rejects_noninteractive_password_entry(self):
        args = argparse.Namespace(host='192.168.1.2', apply=True, server_port=17889)
        with patch.object(stimulus.sys.stdin, 'isatty', return_value=False), patch.object(stimulus.getpass, 'getpass', side_effect=AssertionError('must not prompt')):
            with self.assertRaises(ValueError): stimulus.provision(args)

    def test_feedback_export_omits_local_secrets_and_unlisted_files(self):
        (self.root/'.local').mkdir(); (self.root/'.local/station.json').write_text('SECRET')
        (self.run/'raw.log').write_text('SECRET')
        (self.run/'photos/panel.png').write_bytes(b'photo fixture')
        result = runner.export_feedback(self.root, self.run.name)
        with zipfile.ZipFile(result['archive']) as z:
            self.assertTrue(any(n.endswith('panel.png') for n in z.namelist()))
            self.assertFalse(any(n.endswith('raw.log') or '.local' in n for n in z.namelist()))
            self.assertTrue(any(n.endswith('SHA256SUMS.txt') for n in z.namelist()))

    def test_fixed_data_keeps_task_identity_and_revision_stable(self):
        wait=stimulus.sample('wait'); run=stimulus.sample('run')
        self.assertEqual(wait['revision'],stimulus.sample('wait')['revision'])
        self.assertEqual([t['id'] for t in wait['threads']],[t['id'] for t in run['threads']])
        self.assertNotEqual(wait['revision'],run['revision'])
        self.assertEqual(len(stimulus.sample('nine')['threads']),9)

    def test_station_has_no_automatic_sequence_and_requires_manual_set(self):
        station=stimulus.TestStation('token')
        self.assertEqual(station.current,'wait')
        self.assertFalse(station.set('wait'))
        self.assertTrue(station.set('run'))
        with self.assertRaises(ValueError): station.set('done')

    def test_http_auth_read_only_conditional_wait_and_wakeup(self):
        token='fixture-token-not-real'
        station=stimulus.TestStation(token)
        server=stimulus.ThreadingHTTPServer(('127.0.0.1',0),stimulus.handler(station))
        server.daemon_threads=True
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        url=f'http://127.0.0.1:{server.server_port}/api/v1/device/status'
        with self.assertRaises(urllib.error.HTTPError) as denied: urllib.request.urlopen(url)
        self.assertEqual(denied.exception.code,401)
        headers={'X-CodePulse-Device-Token':token}
        with urllib.request.urlopen(urllib.request.Request(url,headers=headers)) as response:
            etag=response.headers['ETag']; self.assertEqual(json.load(response)['threadTotal'],3)
        with self.assertRaises(urllib.error.HTTPError) as unchanged:
            urllib.request.urlopen(urllib.request.Request(url,headers={**headers,'If-None-Match':etag}))
        self.assertEqual(unchanged.exception.code,304)
        timer=threading.Timer(.15,lambda:station.set('run'));timer.start()
        with urllib.request.urlopen(urllib.request.Request(url,headers={**headers,'If-None-Match':etag,'X-CodePulse-Wait-Ms':'1000'})) as response:
            self.assertNotEqual(response.headers['ETag'],etag)
        timer.join()
        with self.assertRaises(urllib.error.HTTPError) as post:
            urllib.request.urlopen(urllib.request.Request(url,method='POST',headers=headers))
        self.assertEqual(post.exception.code,405)

if __name__=='__main__': unittest.main()
