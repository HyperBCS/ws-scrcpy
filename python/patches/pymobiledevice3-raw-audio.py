#!/usr/bin/env python3
"""
Patches the installed pymobiledevice3 so `display serve-web` serves the iPhone's audio on hosts
without macOS AudioToolbox.

Upstream decodes the device's AAC-ELD frames with AudioToolbox and answers `/audio.bin` with 503
everywhere else. This patch makes the receive loop pass the undecoded access units through when
the decoder cannot be created, and adds an `X-Audio-Codec: pcm|aac-eld` response header so the
subscriber (ws-scrcpy's CoreDeviceAudioRelay, which decodes with ffmpeg) knows what it gets.

Idempotent: run it after every `pip install`. `npm run setup:ios` does.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

MARKER = "ws-scrcpy raw audio"

REPLACEMENTS: list[tuple[str, str]] = [
    (
        '''        try:
            decoder = AACELDDecoder(AAC_ELD_ASC_48K_STEREO_480)
        except Exception:
            logger.exception("AudioToolbox AAC-ELD decoder failed to open")
            return
        logger.info("audio decoder ready: AudioToolbox AAC-ELD -> s16le 48k stereo")
''',
        '''        try:
            decoder = AACELDDecoder(AAC_ELD_ASC_48K_STEREO_480)
            logger.info("audio decoder ready: AudioToolbox AAC-ELD -> s16le 48k stereo")
        except Exception:
            # ws-scrcpy raw audio: no AudioToolbox on this host. Pass the AAC-ELD access units
            # through untouched; the /audio.bin subscriber decodes them (see X-Audio-Codec).
            decoder = None
            logger.info("audio passthrough: raw AAC-ELD access units (no AudioToolbox on this host)")
''',
    ),
    (
        '''            try:
                pcm = decoder.decode(payload)
                consecutive_errors = 0
            except Exception as exc:
''',
        '''            try:
                pcm = payload if decoder is None else decoder.decode(payload)  # ws-scrcpy raw audio
                consecutive_errors = 0
            except Exception as exc:
''',
    ),
    (
        '''            missing = self._missing_audio_deps()
            if missing:
''',
        '''            missing = []  # ws-scrcpy raw audio: raw AAC-ELD is served where AudioToolbox is missing
            if missing:
''',
    ),
    (
        '''            writer.write(
                b"HTTP/1.1 200 OK\\r\\n"
                b"Content-Type: application/octet-stream\\r\\n"
                b"Cache-Control: no-cache\\r\\n"
                b"Transfer-Encoding: chunked\\r\\n"
                b"Connection: close\\r\\n\\r\\n"
            )
            await writer.drain()
            # ~64 packets at 10 ms each = 640 ms of headroom.''',
        '''            audio_codec = b"pcm" if not self._missing_audio_deps() else b"aac-eld"  # ws-scrcpy raw audio
            writer.write(
                b"HTTP/1.1 200 OK\\r\\n"
                b"Content-Type: application/octet-stream\\r\\n"
                b"X-Audio-Codec: " + audio_codec + b"\\r\\n"
                b"Cache-Control: no-cache\\r\\n"
                b"Transfer-Encoding: chunked\\r\\n"
                b"Connection: close\\r\\n\\r\\n"
            )
            await writer.drain()
            # ~64 packets at 10 ms each = 640 ms of headroom.''',
    ),
]


def main() -> int:
    spec = importlib.util.find_spec("pymobiledevice3.remote.core_device.screen_stream")
    if spec is None or not spec.origin:
        print("pymobiledevice3 is not installed in this Python environment", file=sys.stderr)
        return 1
    target = Path(spec.origin)
    source = target.read_text()
    if MARKER in source:
        print(f"already patched: {target}")
        return 0
    for old, new in REPLACEMENTS:
        if source.count(old) != 1:
            print(
                f"cannot patch {target}: expected exactly one match for a block starting "
                f"{old.strip().splitlines()[0]!r} (found {source.count(old)}). "
                "The installed pymobiledevice3 differs from the version this patch was written for (11.12.5).",
                file=sys.stderr,
            )
            return 2
        source = source.replace(old, new)
    target.write_text(source)
    print(f"patched: {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
