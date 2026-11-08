"""Restore/verify archived lab sources in a NEW detached worktree. No SDK/device IO."""
from pathlib import Path, PurePosixPath
import argparse
import hashlib
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parents[2]
ARCHIVE = ROOT / "firmware/experiments/red-lab-handoff/2026-11-08"
PROFILES = ("Fast47", "Tail48", "Split49", "Neutral50", "Stagger51")


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load(profile):
    folder = ARCHIVE / profile
    record = json.loads((folder / "record.json").read_text(encoding="utf-8"))
    manifest = json.loads((folder / "original-build-manifest.json").read_text(encoding="utf-8"))
    require(record["profile"] == manifest["profile"] == profile, "Profile mismatch")
    require(record["baseCommit"] == manifest["rootCommit"], "Git base mismatch")
    require(digest(folder / "source.patch") == record["sourcePatchSha256"], "Archive patch changed")
    require(digest(folder / "original-build-manifest.json") == record["originalManifestSha256"], "Original manifest copy changed")
    expected_lines = "".join(f"{sha}  {name}\n" for name, sha in sorted(manifest["sourceSha256"].items()))
    require((folder / "source-sha256.txt").read_bytes() == expected_lines.encode(), "Source hash list differs")
    patch = (folder / "source.patch").read_bytes()
    require(b"GIT binary patch" not in patch, "Only textual source patches are accepted")
    for old, new in re.findall(rb"^diff --git a/(.+) b/(.+)$", patch, re.M):
        require(old == new, "Unexpected rename in archival patch")
        path = PurePosixPath(old.decode("utf-8"))
        require(not path.is_absolute() and ".." not in path.parts, "Unsafe patch path")
        require(old.startswith(b"firmware/") or old in (b"README.md", b"AGENTS.md"), "Patch outside lab source/document scope")
    return record, manifest, folder


def verify(profile, source):
    record, manifest, _ = load(profile)
    source = source.resolve()
    for name, sha in manifest["sourceSha256"].items():
        relative = PurePosixPath(name)
        require(not relative.is_absolute() and ".." not in relative.parts, "Unsafe source path")
        path = source.joinpath(*relative.parts)
        require(path.resolve().is_relative_to(source), "Source escapes output directory")
        require(path.is_file() and digest(path) == sha, f"Frozen source mismatch: {profile}/{name}")
    require(digest(source / "firmware/sdkconfig") == manifest["sdkconfigSha256"], "Build sdkconfig mismatch")
    print(json.dumps({"profile": profile, "version": manifest["version"],
                      "baseCommit": record["baseCommit"], "sourceFilesVerified": len(manifest["sourceSha256"]),
                      "hardwareAccessed": False, "firmwareBuilt": False}))


def restore(profile, output):
    record, _, folder = load(profile)
    output = output.resolve()
    require(not output.exists(), "Output must not exist; keep existing work untouched")
    require(output != ROOT and not ROOT.is_relative_to(output), "Output cannot contain the current repository")
    require(".git" not in output.parts, "Output cannot be inside Git metadata")
    hooks = ROOT / ".tmpshots/red-handoff/empty-hooks"
    hooks.mkdir(parents=True, exist_ok=True)
    require(not any(hooks.iterdir()), "The isolated hook directory must be empty")
    subprocess.run(["git", "cat-file", "-e", record["baseCommit"] + "^{commit}"], cwd=ROOT, check=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "-c", "core.autocrlf=false", "-c", "core.eol=lf", "-c", f"core.hooksPath={hooks}",
                    "worktree", "add", "--detach", str(output), record["baseCommit"]], cwd=ROOT, check=True)
    patch = folder / "source.patch"
    if patch.stat().st_size:
        for operation in ("--check", None):
            args = ["git", "-c", "core.autocrlf=false", "-C", str(output), "apply", "--whitespace=nowarn"]
            if operation:
                args.append(operation)
            subprocess.run(args + [str(patch)], check=True)
    verify(profile, output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="operation", required=True)
    restore_parser = sub.add_parser("restore", help="Create a new detached baseline worktree, apply its saved text patch, verify hashes")
    restore_parser.add_argument("--profile", choices=PROFILES, required=True)
    restore_parser.add_argument("--output", type=Path, required=True)
    verify_parser = sub.add_parser("verify", help="Verify the original manifest inputs without executing firmware")
    verify_parser.add_argument("--profile", choices=PROFILES, required=True)
    verify_parser.add_argument("--source", type=Path, required=True)
    args = parser.parse_args()
    if args.operation == "restore":
        restore(args.profile, args.output)
    else:
        verify(args.profile, args.source)


if __name__ == "__main__":
    main()
