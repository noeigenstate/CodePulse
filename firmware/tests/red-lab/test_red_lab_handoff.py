"""Integrity and refusal checks for source-only handoff tooling; no device IO."""
from pathlib import Path
from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
import json
import tempfile
import unittest
from unittest.mock import patch

tool_path=Path(__file__).resolve().parents[2]/'scripts/red-lab-handoff.py'
spec=importlib.util.spec_from_file_location('red_handoff',tool_path)
handoff=importlib.util.module_from_spec(spec)
spec.loader.exec_module(handoff)


class ArchiveTests(unittest.TestCase):
    def test_published_archive_metadata_integrity(self):
        for profile in handoff.PROFILES:
            record,manifest,_=handoff.load(profile)
            self.assertEqual(len(manifest['sourceSha256']),157)
            self.assertTrue(record['archiveValidation']['restoredSourceHashesVerified'])

    def test_source_tampering_is_rejected_without_git_or_device_access(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            source=root/'source'
            (source/'firmware').mkdir(parents=True)
            (source/'firmware/sdkconfig').write_bytes(b'changed\n')
            manifest={'sourceSha256':{'firmware/sdkconfig':hashlib.sha256(b'original\n').hexdigest()},
                      'sdkconfigSha256':hashlib.sha256(b'original\n').hexdigest()}
            with patch.object(handoff,'load',return_value=({},manifest,root)),patch.object(handoff.subprocess,'run') as run:
                with self.assertRaisesRegex(ValueError,'Frozen source mismatch'):
                    handoff.verify('Tail48',source)
                run.assert_not_called()

    def test_existing_restore_target_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            marker=root/'keep.txt'
            marker.write_bytes(b'keep existing work')
            with patch.object(handoff,'load',return_value=({}, {},root)),patch.object(handoff.subprocess,'run') as run:
                with self.assertRaisesRegex(ValueError,'must not exist'):
                    handoff.restore('Tail48',root)
                run.assert_not_called()
            self.assertEqual(marker.read_bytes(),b'keep existing work')

    def test_source_path_escape_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            manifest={'sourceSha256':{'../private.txt':'0'*64},'sdkconfigSha256':'0'*64}
            with patch.object(handoff,'load',return_value=({},manifest,root)):
                with self.assertRaisesRegex(ValueError,'Unsafe source path'):
                    handoff.verify('Tail48',root)


if __name__=='__main__':
    unittest.main()
