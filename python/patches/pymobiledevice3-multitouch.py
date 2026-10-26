"""Idempotent extension of serve-web /touch, pinned to requirements.txt."""
import importlib.util
from pathlib import Path
import shutil

spec = importlib.util.find_spec('pymobiledevice3.remote.core_device.screen_stream')
target = Path(spec.origin)
source = target.read_text()
marker = '# ws-scrcpy multitouch'
old = '            op = str(data["type"])\n            x = int(data["x"])'
new = '''            # ws-scrcpy multitouch
            if data.get("type") == "frame":
                from .ws_scrcpy_multitouch import build_report
                report = build_report(data["contacts"])
                await self._ensure_hid()
                await self._uhs.send_report(DIGITIZER_SURFACE_MAIN_TOUCHSCREEN, report)
                return 200, b"ok"
            op = str(data["type"])
            x = int(data["x"])'''
if marker not in source:
    if source.count(old) != 1:
        raise RuntimeError('The installed screen_stream differs from the supported version')
    target.write_text(source.replace(old, new))
shutil.copyfile(Path(__file__).with_name('multitouch.py'), target.with_name('ws_scrcpy_multitouch.py'))
print('Multitouch patch ready')
