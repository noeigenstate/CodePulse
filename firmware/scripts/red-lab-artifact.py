"""Build-only Board1 lab records. No serial access, resetting or flashing."""
from pathlib import Path
import argparse
import datetime
import hashlib
import json
import re
import shutil
import subprocess

FIRMWARE = Path(__file__).resolve().parents[1]
ROOT = FIRMWARE.parent
VERSIONS = {"Fast47": "0.0.47-red-fast", "Color46": "0.0.46-red-activate",
            "Erase43": "0.0.43-red-black", "Production33": "0.0.33-status-region-pair150"}
CHAIN = ["CODEPULSE_EPD_RED_MASK_PROBE", "CODEPULSE_EPD_RED_MASK_BLACK",
         "CODEPULSE_EPD_RED_MASK_COLOR", "CODEPULSE_EPD_RED_MASK_PULSE",
         "CODEPULSE_EPD_RED_MASK_ACTIVATE", "CODEPULSE_EPD_RED_MASK_FAST"]
LEVELS = {"Production33": 0, "Erase43": 2, "Color46": 5, "Fast47": 6}
PARTITION_SHA = "5295e8c42d6fb5f95e4e8a185932c6191d27cfc5078322475347e40e71af815a"


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sources():
    files = []
    for directory in ("main", "fonts", "experiments"):
        files += [p for p in (FIRMWARE / directory).rglob("*") if p.is_file()
                  and (p.suffix in {".c", ".h", ".inc", ".cmake"} or p.name == "CMakeLists.txt")
                  and not any(x.startswith("build") for x in p.relative_to(FIRMWARE).parts)]
    files += [FIRMWARE / p for p in ("CMakeLists.txt", "sdkconfig", "sdkconfig.defaults",
                                    "dependencies.lock", "scripts/build-red-lab.ps1",
                                    "scripts/red-lab-artifact.py")]
    # Board1 uses IDF's single-app-large table; a project CSV is optional.
    custom_partition = FIRMWARE / "partitions.csv"
    if custom_partition.is_file():
        files.append(custom_partition)
    return {p.relative_to(ROOT).as_posix(): digest(p) for p in sorted(set(files))}


def inspect_image(image, partition, version):
    require(len(image) > 0x100, "Application is incomplete")
    require(int.from_bytes(image[0x20:0x24], "little") == 0xABCD5432, "Invalid ESP app descriptor")
    require(image[0x30:0x50].split(b"\0", 1)[0].decode("ascii") == version, "Wrong application version")
    require(image[0x50:0x70].split(b"\0", 1)[0] == b"codepulse_bringup", "Wrong project")
    require(hashlib.sha256(partition).hexdigest() == PARTITION_SHA, "Board1 partition table changed")
    apps = [(int.from_bytes(e[4:8], "little"), int.from_bytes(e[8:12], "little"))
            for i in range(0, len(partition), 32) if len(e := partition[i:i+32]) == 32
            and e[:2] == b"\xaa\x50" and e[2] == 0]
    require(apps == [(0x10000, 0x177000)], "Expected one unchanged factory application")
    require(len(image) <= 0x177000, "Application exceeds the actual partition")


def configured(build, profile):
    cache = (build / "CMakeCache.txt").read_text(encoding="utf-8")
    cmake = (FIRMWARE / "CMakeLists.txt").read_text(encoding="utf-8")
    reset = re.findall(r"option\((CODEPULSE_(?:EPD_[A-Z0-9_]+|AUDIO_[A-Z0-9_]+))\s", cmake)
    enabled = set(CHAIN[:LEVELS[profile]])
    for option in reset:
        value = "ON" if option in enabled else "OFF"
        require(f"{option}:BOOL={value}\n" in cache, f"Unexpected option: {option}")
    for option in ("CODEPULSE_QUIET_RECT_TRIAL", "CODEPULSE_QUIET_PAIR150_TRIAL"):
        require(f"{option}:BOOL=ON\n" in cache, f"Missing Board1 option: {option}")
    description = json.loads((build / "project_description.json").read_text(encoding="utf-8"))
    require(description["target"] == "esp32s3", "Unexpected target")
    require(description["project_version"] == VERSIONS[profile], "Unexpected build version")


def snapshot(build, profile):
    require(not (build / "package/manifest.json").exists(), "Keep the existing package immutable")
    configured(build, profile)
    commit = subprocess.check_output(["git", "-c", "safe.directory=" + ROOT.as_posix(),
                                      "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    record = {"profile": profile, "version": VERSIONS[profile], "rootCommit": commit,
              "sourceSha256": sources(), "sdkconfigSha256": digest(build / "sdkconfig")}
    (build / "lab-source.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    print("Source/configuration snapshot saved; no hardware access.")


def validate_inputs(build, profile):
    configured(build, profile)
    record = json.loads((build / "lab-source.json").read_text(encoding="utf-8"))
    require(record["profile"] == profile, "Snapshot profile differs")
    require(record["version"] == VERSIONS[profile], "Snapshot version differs")
    require(record["sourceSha256"] == sources(), "Sources changed after the build started; rebuild in a new directory")
    require(record["sdkconfigSha256"] == digest(build / "sdkconfig"), "SDK configuration changed")
    return record


def package(build, profile):
    record = validate_inputs(build, profile)
    app = build / "codepulse_bringup.bin"
    partition = build / "partition_table/partition-table.bin"
    inspect_image(app.read_bytes(), partition.read_bytes(), VERSIONS[profile])
    destination = build / "package"
    require(not destination.exists(), "Keep packages immutable; use a new build directory")
    destination.mkdir()
    for path in (app, partition):
        shutil.copy2(path, destination / path.name)
    record.update(schema=1, createdUtc=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  board="Board1 ESP32-S3 N16R8 / WFT0420CZ15 400x300 BWR",
                  appOffset="0x10000", appPartitionBytes=0x177000, appBytes=app.stat().st_size,
                  appSha256=digest(app), partitionSha256=digest(partition), sdk="ESP-IDF v6.0.1",
                  hardwareFlashed=False, opticalValidation=False)
    (destination / "manifest.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: record[k] for k in ("version", "appBytes", "appSha256", "hardwareFlashed")}))


def check(build, profile):
    record = validate_inputs(build, profile)
    package = build / "package"
    saved = json.loads((package / "manifest.json").read_text(encoding="utf-8"))
    for key in ("profile", "version", "rootCommit", "sourceSha256", "sdkconfigSha256"):
        require(saved[key] == record[key], "Package/snapshot mismatch: " + key)
    app, partition = package / "codepulse_bringup.bin", package / "partition-table.bin"
    require(digest(app) == saved["appSha256"] and digest(partition) == saved["partitionSha256"], "Package bytes changed")
    require(app.stat().st_size == saved["appBytes"], "Package size changed")
    inspect_image(app.read_bytes(), partition.read_bytes(), VERSIONS[profile])
    print(json.dumps({"packageVerified": True, "version": saved["version"], "deviceAccessed": False}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("snapshot", "package", "check"))
    parser.add_argument("--build", type=Path, required=True)
    parser.add_argument("--profile", choices=VERSIONS, required=True)
    args = parser.parse_args()
    {"snapshot": snapshot, "package": package, "check": check}[args.operation](args.build.resolve(), args.profile)


if __name__ == "__main__":
    main()
