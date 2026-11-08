"""Host-only package rejection and passive-capture filtering tests."""
from pathlib import Path
import hashlib
import importlib.util
import json
import re
import struct
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


lab = load('red_artifact', 'red-lab-artifact.py')
observer = load('red_observer', 'observe-red-lab.py')


class ImageTests(unittest.TestCase):
    def test_stagger51_requires_tail100_and_rejects_other_candidates(self):
        cmake = (lab.FIRMWARE / 'CMakeLists.txt').read_text(encoding='utf-8')
        options = re.findall(r'option\((CODEPULSE_(?:EPD_[A-Z0-9_]+|AUDIO_[A-Z0-9_]+))\s', cmake)
        with tempfile.TemporaryDirectory() as directory:
            build = Path(directory)
            (build / 'project_description.json').write_text(json.dumps({
                'target': 'esp32s3', 'project_version': '0.0.51-red-stagger'}), encoding='utf-8')
            enabled = set(lab.CHAIN[:5]) | {'CODEPULSE_EPD_RED_MASK_TAIL100', 'CODEPULSE_EPD_RED_MASK_STAGGER'}
            def configure(selected):
                cache = ''.join(f'{name}:BOOL={"ON" if name in selected else "OFF"}\n' for name in options)
                cache += 'CODEPULSE_QUIET_RECT_TRIAL:BOOL=ON\nCODEPULSE_QUIET_PAIR150_TRIAL:BOOL=ON\n'
                (build / 'CMakeCache.txt').write_text(cache, encoding='utf-8')
            configure(enabled)
            lab.configured(build, 'Stagger51')
            for invalid in (enabled - {'CODEPULSE_EPD_RED_MASK_TAIL100'},
                            enabled - {'CODEPULSE_EPD_RED_MASK_STAGGER'},
                            enabled | {'CODEPULSE_EPD_RED_MASK_FAST'},
                            enabled | {'CODEPULSE_EPD_RED_MASK_SPLIT'},
                            enabled | {'CODEPULSE_EPD_RED_MASK_NEUTRAL'}):
                configure(invalid)
                with self.assertRaises(ValueError):
                    lab.configured(build, 'Stagger51')

    def test_neutral50_requires_tail100_and_rejects_other_candidates(self):
        cmake = (lab.FIRMWARE / 'CMakeLists.txt').read_text(encoding='utf-8')
        options = re.findall(r'option\((CODEPULSE_(?:EPD_[A-Z0-9_]+|AUDIO_[A-Z0-9_]+))\s', cmake)
        with tempfile.TemporaryDirectory() as directory:
            build = Path(directory)
            (build / 'project_description.json').write_text(json.dumps({
                'target': 'esp32s3', 'project_version': '0.0.50-red-neutral'}), encoding='utf-8')
            enabled = set(lab.CHAIN[:5]) | {'CODEPULSE_EPD_RED_MASK_TAIL100', 'CODEPULSE_EPD_RED_MASK_NEUTRAL'}
            def configure(selected):
                cache = ''.join(f'{name}:BOOL={"ON" if name in selected else "OFF"}\n' for name in options)
                cache += 'CODEPULSE_QUIET_RECT_TRIAL:BOOL=ON\nCODEPULSE_QUIET_PAIR150_TRIAL:BOOL=ON\n'
                (build / 'CMakeCache.txt').write_text(cache, encoding='utf-8')
            configure(enabled)
            lab.configured(build, 'Neutral50')
            for invalid in (enabled - {'CODEPULSE_EPD_RED_MASK_TAIL100'},
                            enabled - {'CODEPULSE_EPD_RED_MASK_NEUTRAL'},
                            enabled | {'CODEPULSE_EPD_RED_MASK_FAST'},
                            enabled | {'CODEPULSE_EPD_RED_MASK_SPLIT'}):
                configure(invalid)
                with self.assertRaises(ValueError):
                    lab.configured(build, 'Neutral50')

    def test_split49_configuration_rejects_other_candidates(self):
        cmake = (lab.FIRMWARE / 'CMakeLists.txt').read_text(encoding='utf-8')
        options = re.findall(r'option\((CODEPULSE_(?:EPD_[A-Z0-9_]+|AUDIO_[A-Z0-9_]+))\s', cmake)
        with tempfile.TemporaryDirectory() as directory:
            build = Path(directory)
            (build / 'project_description.json').write_text(json.dumps({
                'target': 'esp32s3', 'project_version': '0.0.49-red-split'}), encoding='utf-8')
            enabled = set(lab.CHAIN[:5]) | {'CODEPULSE_EPD_RED_MASK_SPLIT'}
            def configure(selected):
                cache = ''.join(f'{name}:BOOL={"ON" if name in selected else "OFF"}\n' for name in options)
                cache += 'CODEPULSE_QUIET_RECT_TRIAL:BOOL=ON\nCODEPULSE_QUIET_PAIR150_TRIAL:BOOL=ON\n'
                (build / 'CMakeCache.txt').write_text(cache, encoding='utf-8')
            configure(enabled)
            lab.configured(build, 'Split49')
            for invalid in (enabled | {'CODEPULSE_EPD_RED_MASK_FAST'},
                            enabled | {'CODEPULSE_EPD_RED_MASK_TAIL100'},
                            enabled - {'CODEPULSE_EPD_RED_MASK_SPLIT'}):
                configure(invalid)
                with self.assertRaises(ValueError):
                    lab.configured(build, 'Split49')

    def test_tail48_configuration_rejects_fast_or_missing_tail_flag(self):
        cmake = (lab.FIRMWARE / 'CMakeLists.txt').read_text(encoding='utf-8')
        options = re.findall(r'option\((CODEPULSE_(?:EPD_[A-Z0-9_]+|AUDIO_[A-Z0-9_]+))\s', cmake)
        with tempfile.TemporaryDirectory() as directory:
            build = Path(directory)
            (build / 'project_description.json').write_text(json.dumps({
                'target': 'esp32s3', 'project_version': '0.0.48-red-tail100'}), encoding='utf-8')
            enabled = set(lab.CHAIN[:5]) | {'CODEPULSE_EPD_RED_MASK_TAIL100'}
            def configure(selected):
                cache = ''.join(f'{name}:BOOL={"ON" if name in selected else "OFF"}\n' for name in options)
                cache += 'CODEPULSE_QUIET_RECT_TRIAL:BOOL=ON\nCODEPULSE_QUIET_PAIR150_TRIAL:BOOL=ON\n'
                (build / 'CMakeCache.txt').write_text(cache, encoding='utf-8')
            configure(enabled)
            lab.configured(build, 'Tail48')
            for invalid in (enabled | {'CODEPULSE_EPD_RED_MASK_FAST'},
                            enabled - {'CODEPULSE_EPD_RED_MASK_TAIL100'}):
                configure(invalid)
                with self.assertRaises(ValueError):
                    lab.configured(build, 'Tail48')

    def test_actual_checkout_source_snapshot(self):
        files = lab.sources()
        self.assertIn('firmware/scripts/build-red-lab.ps1', files)
        self.assertIn('firmware/scripts/red-lab-artifact.py', files)
        self.assertIn('firmware/sdkconfig', files)
        self.assertEqual('firmware/partitions.csv' in files, (lab.FIRMWARE / 'partitions.csv').is_file())

    def setUp(self):
        self.app = bytearray(1024)
        self.app[0x20:0x24] = struct.pack('<I', 0xABCD5432)
        self.app[0x30:0x30+len(lab.VERSIONS['Fast47'])] = lab.VERSIONS['Fast47'].encode()
        self.app[0x50:0x50+len('codepulse_bringup')] = b'codepulse_bringup'
        self.partition = bytearray(0xc00)
        self.partition[0:12] = struct.pack('<HBBII', 0x50aa, 0, 0, 0x10000, 0x177000)
        self.accepted = hashlib.sha256(self.partition).hexdigest()

    def inspect(self, app=None, partition=None):
        with patch.object(lab, 'PARTITION_SHA', self.accepted):
            lab.inspect_image(self.app if app is None else app,
                              self.partition if partition is None else partition, lab.VERSIONS['Fast47'])

    def test_version_project_magic_and_size(self):
        self.inspect()
        for index in (0x20, 0x30, 0x50):
            bad = bytearray(self.app)
            bad[index] ^= 1
            with self.subTest(index=index), self.assertRaises(ValueError):
                self.inspect(bad)
        with self.assertRaises(ValueError):
            self.inspect(self.app + bytes(0x177000))

    def test_partition_bytes_and_layout(self):
        bad = bytearray(self.partition)
        bad[4] ^= 1
        with self.assertRaises(ValueError):
            self.inspect(partition=bad)
        # Even a matching table hash cannot authorize a different app offset.
        with patch.object(lab, 'PARTITION_SHA', hashlib.sha256(bad).hexdigest()):
            with self.assertRaises(ValueError):
                lab.inspect_image(self.app, bad, lab.VERSIONS['Fast47'])

    def test_snapshot_and_package_tampering(self):
        with tempfile.TemporaryDirectory() as directory:
            build = Path(directory)
            (build / 'sdkconfig').write_bytes(b'Board1 config')
            (build / 'codepulse_bringup.bin').write_bytes(self.app)
            (build / 'partition_table').mkdir()
            (build / 'partition_table/partition-table.bin').write_bytes(self.partition)
            snapshot = {'profile': 'Fast47', 'version': lab.VERSIONS['Fast47'],
                        'rootCommit': 'test-source-commit', 'sourceSha256': {'firmware/main/test.c': 'one'},
                        'sdkconfigSha256': lab.digest(build / 'sdkconfig')}
            (build / 'lab-source.json').write_text(json.dumps(snapshot), encoding='utf-8')
            with patch.object(lab, 'configured'), patch.object(lab, 'sources', return_value=snapshot['sourceSha256']), \
                    patch.object(lab, 'PARTITION_SHA', self.accepted):
                lab.package(build, 'Fast47')
                lab.check(build, 'Fast47')
                with self.assertRaises(ValueError):
                    lab.package(build, 'Fast47')
                with patch.object(lab, 'sources', return_value={'firmware/main/test.c': 'two'}):
                    with self.assertRaises(ValueError):
                        lab.check(build, 'Fast47')
                image = build / 'package/codepulse_bringup.bin'
                image.write_bytes(image.read_bytes() + b'changed')
                with self.assertRaises(ValueError):
                    lab.check(build, 'Fast47')

    def test_capture_excludes_unrelated_device_logs(self):
        self.assertTrue(observer.relevant('I red_mask_probe: frame=2 result=ESP_OK'))
        self.assertTrue(observer.relevant('I app_init: Project version: 0.0.47-red-fast'))
        self.assertFalse(observer.relevant('wifi: private-network-name'))
        self.assertFalse(observer.relevant('CP1 {"deviceId":"private"}'))


if __name__ == '__main__':
    unittest.main()
