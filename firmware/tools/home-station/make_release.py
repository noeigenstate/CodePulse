"""Primary-machine-only exporter. Never builds, flashes or publishes firmware."""
from __future__ import annotations
import argparse
import re
import shutil
from pathlib import Path
import runner

def make_release(destination, image, partition, plan, release_id, version, kind, source_commit, status):
    destination, image, partition, plan = map(Path, (destination, image, partition, plan))
    if not runner.SAFE_ID.fullmatch(release_id):
        raise ValueError('Invalid release ID')
    if not re.fullmatch(r'[0-9a-f]{40}', source_commit):
        raise ValueError('Record the full source checkpoint commit')
    if kind not in ('baseline', 'trial') or not version or not status:
        raise ValueError('Version, baseline/trial kind and verification status are required')
    if not 0 < image.stat().st_size <= runner.APP_BYTES:
        raise ValueError('Image exceeds the known application partition')
    with image.open('rb') as stream:
        if stream.read(1) != b'\xe9':
            raise ValueError('Invalid ESP application image')
    if runner.sha(partition) != runner.PARTITION_SHA:
        raise ValueError('Partition differs from this prototype; do not reuse this station')
    plan_text = plan.read_text(encoding='utf-8')
    if not plan_text.strip():
        raise ValueError('A concrete manual test plan is required')
    folder = destination / release_id
    folder.mkdir(parents=True, exist_ok=False)  # Never overwrite a delivered release.
    shutil.copyfile(image, folder / 'app.bin')
    shutil.copyfile(partition, folder / 'partition-reference.bin')
    (folder / 'TEST-PLAN.md').write_text(plan_text, encoding='utf-8')
    manifest = {'schema': 1, 'release_id': release_id, 'firmware_version': version,
        'kind': kind, 'created_at': runner.now(), 'test_plan_id': release_id + '-plan1',
        'source_checkpoint': source_commit, 'verification_status': status,
        'target': {'chip': runner.CHIP, 'board': 'CodePulse-Board1-existing-prototype',
            'flash_size': '16MB', 'app_offset': runner.APP_OFFSET, 'app_bytes': runner.APP_BYTES},
        'application': {'file': 'app.bin', 'bytes': image.stat().st_size, 'sha256': runner.sha(image)},
        'partition_reference': {'file': 'partition-reference.bin', 'sha256': runner.PARTITION_SHA,
            'note': 'Reference only; never written. Not proof of an unknown board layout.'},
        'test_plan': {'file': 'TEST-PLAN.md', 'sha256': runner.sha(folder / 'TEST-PLAN.md')},
        'flash_automatically': False}
    runner.write_json(folder / 'release.json', manifest)
    files = sorted(p for p in folder.iterdir() if p.is_file())
    (folder / 'SHA256SUMS.txt').write_text(''.join(runner.sha(p) + '  ' + p.name + '\n' for p in files), encoding='ascii')
    return folder

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('destination', 'image', 'partition', 'plan', 'release-id', 'version', 'source-commit', 'status'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--kind', choices=('baseline', 'trial'), required=True)
    args = parser.parse_args()
    print(make_release(args.destination, args.image, args.partition, args.plan,
        args.release_id, args.version, args.kind, args.source_commit, args.status))

if __name__ == '__main__':
    main()
