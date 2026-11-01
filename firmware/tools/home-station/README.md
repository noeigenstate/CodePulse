# Controlled flashing / observation tools

Portable source for preparing a reviewed Board1 application package and
collecting bounded, redacted observations. This directory does not contain
a release image, provisioned device identity or private household instructions.

`runner.py`, `diagnose.py`, `link.py` and `stimulus.py` are specialized tools;
read their `--help` and the tests before use. `make_release.py` exports an
explicitly selected application, known partition reference and manual plan.
It never builds or flashes automatically. Historical source hashes in this
tooling describe a specific Board1 profile, not permission to update unknown boards.

Run offline checks with:

```sh
python -m unittest discover -s firmware/tools/home-station -p "test_*.py"
```

Run from the repository root with the dependencies in `requirements.lock`.
`setup.ps1` installs into a local environment; use the standard ESP-IDF Python
environment if it already contains these modules. Do not commit generated
delivery packages, logs, manifests containing device identities or pairing files.
Flashing still requires the current user's explicit request and power-hold
confirmation; see [firmware development](../../doc/DEVELOPMENT.md).
