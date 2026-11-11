#!/usr/bin/env python3
"""
Reports whether the installed pymobiledevice3 carries every ws-scrcpy patch.

The patches in this directory are applied by `npm run patch:ios`. A venv that was set up before
a patch was added keeps running the older helper, and nothing else notices: the server starts,
and the behaviour the patch was written for is quietly missing. The server runs this script
before it starts an iPhone screen session and refuses the session when something is missing.

Every patch leaves a marker comment in the file it changes. A patch that changes what an already
patched file must contain needs a new marker, listed here, as "keyboard lifecycle v2" did. The
two modules that are copied whole are compared with their source in this directory.

Prints one JSON object on stdout: {"version": "11.44.0", "missing": ["...", ...]}.
"""
from __future__ import annotations

import importlib.metadata
import importlib.util
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

# File in pymobiledevice3/remote/core_device -> the markers the patches leave in it.
MARKERS: dict[str, list[str]] = {
    'screen_stream.py': [
        'ws-scrcpy raw audio',
        '# ws-scrcpy multitouch',
        '# ws-scrcpy keyboard lifecycle v2',
        '# ws-scrcpy button completion',
        '# ws-scrcpy input queue bound',
        '# ws-scrcpy early stop',
    ],
    'hid_service.py': ['# ws-scrcpy keyboard lifecycle v2'],
}
# Installed module -> the file in this directory it is a copy of.
COPIES: dict[str, str] = {
    'ws_scrcpy_keyboard.py': 'keyboard.py',
    'ws_scrcpy_multitouch.py': 'multitouch.py',
}


def label(marker: str) -> str:
    return marker.lstrip('# ').replace('ws-scrcpy ', '')


def missing_patches(core_device: Path, patches: Path = HERE) -> list[str]:
    """What `core_device` (the installed package directory) lacks, in words for a log line."""
    missing: list[str] = []
    for name, markers in MARKERS.items():
        try:
            source = (core_device / name).read_text()
        except OSError:
            missing.append(f'{name} not found')
            continue
        missing.extend(label(marker) for marker in markers if marker not in source)
    for installed, original in COPIES.items():
        try:
            same = (core_device / installed).read_bytes() == (patches / original).read_bytes()
        except OSError:
            same = False
        if not same:
            missing.append(f'current {original}')
    return missing


def pinned_version(requirements: Path) -> str | None:
    try:
        match = re.search(r'^pymobiledevice3==(\S+)', requirements.read_text(), re.MULTILINE)
    except OSError:
        return None
    return match.group(1) if match else None


def check() -> dict:
    # The top-level spec is found without importing the package.
    spec = importlib.util.find_spec('pymobiledevice3')
    if spec is None or not spec.origin:
        return {'version': None, 'missing': ['pymobiledevice3 itself']}
    try:
        version = importlib.metadata.version('pymobiledevice3')
    except importlib.metadata.PackageNotFoundError:
        version = None
    missing = missing_patches(Path(spec.origin).parent / 'remote' / 'core_device')
    pinned = pinned_version(HERE.parent / 'requirements.txt')
    if pinned and version and pinned != version:
        missing.insert(0, f'pymobiledevice3 {pinned} (installed: {version})')
    return {'version': version, 'missing': missing}


if __name__ == '__main__':
    print(json.dumps(check()))
    sys.exit(0)
