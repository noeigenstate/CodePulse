import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import link
import stimulus

VERSION = '0.0.22-pair150-trial'
METRIC = ('I (120) codepulse_bringup: dashboard mode=pair150 y=25 height=240 total=3390 '
          'refresh=3133 busy=1 result=ESP_OK init=0 upload=200 off=50 busy_assert=1 busy_low=3133\n')

class Clock:
    def __init__(self): self.value = 0
    def __call__(self): return self.value

class Stream:
    def __init__(self, clock, *, version=VERSION, mode='ready', noise=b''):
        self.clock, self.version, self.mode = clock, version, mode
        self.incoming, self.writes, self.saved = noise, [], False
        self.reads = 0
    @property
    def in_waiting(self): return len(self.incoming)
    def read(self, size):
        self.reads += 1
        self.clock.value += .2
        data, self.incoming = self.incoming[:size], self.incoming[size:]
        return data
    def write(self, payload):
        frame = json.loads(payload[4:]); self.writes.append(frame)
        op = frame['operation']
        if self.mode == 'silent': return len(payload)
        if self.mode == 'short': return len(payload) - 1
        if op == 'hello':
            result = dict(protocolVersion=1, hardwareRevision=1, deviceId='codepulse-012345abcdef', firmwareVersion=self.version)
        elif op == 'getStatus':
            ready = self.saved and self.mode != 'offline'
            result = dict(provisioned=True, wifiConnected=ready, desktopReachable=ready,
                          state='ready' if ready else 'wifi_error',
                          configurationGeneration=int(self.saved and self.mode != 'stale'))
        else:
            self.saved = True
            result = dict(saved=True, applyQueued=True)
            self.incoming += METRIC.encode()
        result['wifiPassword'] = 'SECRET'
        result['deviceToken'] = 'SECRET'
        self.incoming += ('CP1 ' + json.dumps(dict(id=frame['id'], ok=True, result=result)) + '\n').encode()
        return len(payload)

class LinkTests(unittest.TestCase):
    def test_success_one_pairing_redacted_metrics_generation_and_settle(self):
        clock, events = Clock(), []
        stream = Stream(clock)
        protocol = link.Protocol(stream, events.append, clock)
        link.pair(protocol, VERSION, dict(wifiPassword='SECRET'), events.append,
                  clock=clock, ready_seconds=10, settle_seconds=3)
        self.assertEqual([x['operation'] for x in stream.writes].count('provision'), 1)
        self.assertTrue(any(x['kind'] == 'network_ready' for x in events))
        self.assertTrue(any(x.get('drive_ms') == 3133 for x in events))
        self.assertEqual(events[-1]['optical_acceptance'], 'requires_operator_observation')
        self.assertNotIn('SECRET', json.dumps(events))
        self.assertGreater(clock.value, 6)

    def test_version_mismatch_never_provisions(self):
        clock, events = Clock(), []
        stream = Stream(clock, version='0.0.21-retained-session')
        with self.assertRaisesRegex(link.Stop, 'identity_mismatch'):
            link.pair(link.Protocol(stream, events.append, clock), VERSION, {}, events.append, clock=clock)
        self.assertEqual([x['operation'] for x in stream.writes], ['hello'])

    def test_offline_or_stale_generation_never_accepted_or_retried(self):
        for mode in ('offline', 'stale'):
            clock, events = Clock(), []
            stream = Stream(clock, mode=mode)
            with self.assertRaisesRegex(link.Stop, 'ready_timeout'):
                link.pair(link.Protocol(stream, events.append, clock), VERSION, {}, events.append,
                          clock=clock, ready_seconds=4)
            self.assertFalse(any(x['kind'] == 'network_ready' for x in events))
            self.assertEqual([x['operation'] for x in stream.writes].count('provision'), 1)

    def test_backlog_drained_and_oversize_line_does_not_drop_next_reply(self):
        clock, events = Clock(), []
        stream = Stream(clock, noise=b'x' * 9000 + b'\n' + b'noise\n' * 2000)
        protocol = link.Protocol(stream, events.append, clock)
        self.assertEqual(protocol.request('hello', timeout=3)['firmwareVersion'], VERSION)
        self.assertLess(stream.reads, 10)
        self.assertEqual(protocol.reader.stats['oversized_lines'], 1)

    def test_no_response_or_short_write_stops_once(self):
        for mode, code in [('silent', 'reply_timeout'), ('short', 'short_write')]:
            clock, events = Clock(), []
            stream = Stream(clock, mode=mode)
            with self.assertRaisesRegex(link.Stop, code):
                link.Protocol(stream, events.append, clock).request('hello', timeout=1)
            self.assertEqual(len(stream.writes), 1)

    def test_boot_or_display_fault_before_pairing_stops(self):
        for noise in ('waiting for download\n',
                      'E (1) codepulse_bringup: display fault; stopping without automatic retry or full refresh\n',
                      METRIC.replace('ESP_OK', 'ESP_ERR_TIMEOUT')):
            clock, events = Clock(), []
            stream = Stream(clock, noise=noise.encode())
            with self.assertRaisesRegex(link.Stop, 'device_fault'):
                link.pair(link.Protocol(stream, events.append, clock), VERSION, {}, events.append, clock=clock)
            self.assertFalse(stream.writes)

    def test_invalid_status_and_hidden_input_requirement(self):
        with self.assertRaisesRegex(link.Stop, 'invalid_status'):
            link.safe_status(dict(state='ready', wifiConnected=True))
        with patch('link.sys.stdin.isatty', return_value=False):
            with self.assertRaisesRegex(link.Stop, 'interactive_terminal_required'): link.credentials()
        self.assertEqual(stimulus.sample('wait')['revision'], 'lab-1b1c14df1dd22b9146608a85')

    def test_existing_lab_pairing_preflight_is_read_only(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = stimulus.station_state(root)
            original = (root / '.local/station.json').read_bytes()
            calls = []
            class Connection:
                def __init__(self, host, port, timeout): pass
                def request(self, method, path, headers):
                    calls.append((method, path)); self.path = path
                    if path.endswith('status'):
                        self_outer.assertEqual(headers['X-CodePulse-Device-Token'], state['token'])
                def getresponse(self): return self
                status = 200
                def read(self, size):
                    return json.dumps(dict(testData=True, protocolVersion=1) if self.path.endswith('health')
                                      else stimulus.sample('wait')).encode()
                def close(self): pass
            self_outer = self
            with patch('link.http.client.HTTPConnection', Connection):
                self.assertEqual(link.local_pairing(root, '192.168.3.10', 17889), state)
            self.assertEqual((root / '.local/station.json').read_bytes(), original)
            self.assertEqual([c[0] for c in calls], ['GET', 'GET'])

if __name__ == '__main__': unittest.main()
