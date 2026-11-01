import json
import unittest
import diagnose

class Clock:
    def __init__(self): self.time = 0
    def __call__(self): return self.time

class Stream:
    def __init__(self, clock, incoming=b'', reply=False, version='0.0.22-pair150-trial'):
        self.clock, self.incoming, self.reply, self.version = clock, incoming, reply, version
        self.writes = []
    @property
    def in_waiting(self): return len(self.incoming)
    def read(self, size):
        self.clock.time += 0.2
        data, self.incoming = self.incoming[:size], self.incoming[size:]
        return data
    def write(self, payload):
        request = json.loads(payload.decode()[4:])
        self.writes.append(request)
        if self.reply:
            result = ({'protocolVersion': 1, 'deviceId': 'codepulse-012345abcdef', 'firmwareVersion': self.version}
                      if request['operation'] == 'hello' else
                      {'state': 'ready', 'wifiConnected': True, 'provisioned': True,
                       'wifiPassword': 'SECRET', 'deviceToken': 'SECRET'})
            self.incoming += ('CP1 ' + json.dumps({'id': request['id'], 'ok': True, 'result': result}) + '\n').encode()
        return len(payload)

class DiagnosisTests(unittest.TestCase):
    def test_known_boot_stage_and_no_raw_secrets(self):
        self.assertEqual(diagnose.classify('I (3200) codepulse_bringup: 3-second power-on hold accepted; status LED is on')['code'], 'power_hold_accepted')
        self.assertIsNone(diagnose.classify('wifi password=SECRET token=SECRET'))
        self.assertIsNone(diagnose.classify('CP1 {"wifiPassword":"SECRET"}'))
        self.assertEqual(diagnose.classify('waiting for download')['code'], 'rom_waiting_for_download')
        self.assertEqual(diagnose.classify('I (4000) codepulse_bringup: firmware=0.0.22-pair150-trial idf=v6.0.1 hw_rev=1 reset_reason=1')['reset_reason'], 1)

    def test_lines_preserve_burst_and_drop_only_oversize_line(self):
        reader = diagnose.Lines()
        lines = reader.feed(b'x' * 1500 + b'\n' + b'noise\n' * 2000 + b'CP1 {}\n')
        self.assertEqual(len(lines), 2001)
        self.assertEqual(lines[-1], 'CP1 {}')
        self.assertEqual(reader.stats['oversized_lines'], 1)
        self.assertEqual(reader.pending, b'')
        self.assertEqual(reader.feed(b'CP'), [])
        self.assertEqual(reader.feed(b'1 {}\r\n'), ['CP1 {}'])

    def test_silent_transport_records_zero_bytes_and_sends_once(self):
        clock, events = Clock(), []
        stream = Stream(clock)
        diagnose.capture(stream, '0.0.22-pair150-trial', 60, events.append, clock=clock)
        self.assertEqual([r['operation'] for r in stream.writes], ['hello'])
        self.assertEqual(events[-1]['rx_bytes'], 0)
        self.assertEqual(events[-1]['identity'], 'not_received')

    def test_matching_identity_then_one_status_and_redaction(self):
        clock, events = Clock(), []
        stream = Stream(clock, reply=True)
        diagnose.capture(stream, stream.version, 10, events.append, clock=clock)
        self.assertEqual([r['operation'] for r in stream.writes], ['hello', 'getStatus'])
        self.assertEqual(events[-1]['identity'], 'matches')
        self.assertTrue(events[-1]['status_received'])
        self.assertNotIn('SECRET', json.dumps(events))
        self.assertNotIn('deviceToken', json.dumps(events))

    def test_wrong_version_stops_without_status(self):
        clock, events = Clock(), []
        stream = Stream(clock, reply=True, version='0.0.21-retained-session')
        diagnose.capture(stream, '0.0.22-pair150-trial', 10, events.append, clock=clock)
        self.assertEqual(len(stream.writes), 1)
        self.assertEqual(events[-1]['identity'], 'mismatch')

    def test_download_marker_or_passive_mode_never_writes(self):
        for incoming, passive in [(b'waiting for download\n', False), (b'', True)]:
            clock, events = Clock(), []
            stream = Stream(clock, incoming)
            diagnose.capture(stream, '0.0.22-pair150-trial', 10, events.append, clock=clock, listen_only=passive)
            self.assertEqual(stream.writes, [])

    def test_transport_failure_still_emits_summary(self):
        clock, events = Clock(), []
        stream = Stream(clock)
        def broken_read(_): raise OSError('SECRET')
        stream.read = broken_read
        with self.assertRaises(OSError):
            diagnose.capture(stream, '0.0.22-pair150-trial', 10, events.append, clock=clock)
        self.assertEqual(events[-1]['kind'], 'diagnostic_summary')
        self.assertNotIn('SECRET', json.dumps(events))

if __name__ == '__main__': unittest.main()
