"""Run the patched serve-web serve() against stubs: no pymobiledevice3 import, no phone."""
import ast
import asyncio
import contextlib
import importlib.util
import logging
import os
from pathlib import Path
import signal
import unittest
from collections.abc import Awaitable
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('serve_signals_patch', Path(__file__).with_name('pymobiledevice3-serve-signals.py'))
patch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patch)
native_paths = list((ROOT / 'python/venv/lib').glob('python*/site-packages/pymobiledevice3/remote/core_device/screen_stream.py'))
logger = logging.getLogger('serve-signals-patch-test')
logger.disabled = True


def serve_source(source):
    for cls in ast.parse(source).body:
        if isinstance(cls, ast.ClassDef):
            for node in cls.body:
                if isinstance(node, ast.AsyncFunctionDef) and node.name == 'serve':
                    return node
    raise AssertionError('serve() not found')


class CoreDeviceError(Exception):
    def __init__(self, message='', code=None):
        super().__init__(message)
        self.code = code


async def forever():
    await asyncio.Event().wait()


@unittest.skipUnless(native_paths, 'Requires the setup:ios source installation')
class EarlyStopTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.source = native_paths[0].read_text()
        self.events = []
        self.entered, self.release = asyncio.Event(), asyncio.Event()
        self.server = self.build_server(patch.patch_stream(self.source))
        # A safety net: if serve() does not take SIGTERM over, the signal lands here instead of
        # ending the test run.
        self.previous = signal.signal(signal.SIGTERM, lambda *_: self.events.append('killed in preflight'))

    def build_server(self, source):
        events = self.events

        class DisplayService:
            @staticmethod
            async def stop_all_streams(_rsd):
                events.append('stop_all_streams')

        node = serve_source(source)
        scope = {
            'asyncio': asyncio, 'contextlib': contextlib, 'logger': logger, 'Awaitable': Awaitable, 'Any': Any,
            'CoreDeviceError': CoreDeviceError, 'MEDIA_IN_USE_MESSAGE': 'in use', 'DisplayService': DisplayService,
            '_build_self_signed_ssl_context': lambda _bind: None,
        }
        exec(compile(ast.Module(body=[node], type_ignores=[]), '<serve>', 'exec'), scope)
        test = self

        class Server:
            _bind, _http_port, _https, _rsd = '127.0.0.1', 0, False, None
            serve = scope['serve']

            def __init__(self):
                self._http_tasks, self._pli_tasks = set(), set()
                self._stream_lock, self._audio_lock = asyncio.Lock(), asyncio.Lock()

            async def _eager_stream_start(self):
                events.append('preflight-start')
                test.entered.set()
                await test.release.wait()
                events.append('preflight-done')

            async def _handle_http(self, _reader, writer):
                writer.close()

            _stall_watchdog = _decoder_refresh_loop = _rctl_feedback_loop = staticmethod(forever)
            _reconnect_loop = _keep_awake_loop = _hid_worker = staticmethod(forever)

            async def _stop_hid(self):
                events.append('stop_hid')

            async def _stop_active_stream(self):
                events.append('stop_video')

            async def _stop_audio_stream(self):
                events.append('stop_audio')

            async def _stop_clipboard_monitor(self):
                events.append('stop_clipboard')

            async def _stop_accessibility(self):
                events.append('stop_accessibility')

        return Server()

    async def asyncTearDown(self):
        loop = asyncio.get_running_loop()
        for signum in (signal.SIGINT, signal.SIGTERM):
            loop.remove_signal_handler(signum)
        signal.signal(signal.SIGTERM, self.previous)

    def require_stock(self):
        # `npm run patch:ios` edits the installed file in place. Once it has run, the stock
        # behaviour can no longer be observed from that file.
        if patch.MARKER in self.source:
            self.skipTest('The installed screen_stream.py is already patched')

    def test_stock_serve_installs_its_handlers_only_after_the_preflight(self):
        # What the patch is for. If upstream moves the handlers itself, the patch stops applying.
        self.require_stock()
        body = ast.unparse(serve_source(self.source))
        self.assertLess(body.index('_eager_stream_start'), body.index('add_signal_handler'))

    def test_patch_is_compilable_and_idempotent(self):
        patched = patch.patch_stream(self.source)
        compile(patched, '<patched stream>', 'exec')
        self.assertEqual(patch.patch_stream(patched), patched)
        self.assertEqual(patched.count('add_signal_handler'), self.source.count('add_signal_handler'))
        body = ast.unparse(serve_source(patched))
        self.assertLess(body.index('add_signal_handler'), body.index('_eager_stream_start'))

    async def test_sigterm_during_the_preflight_runs_the_orderly_shutdown(self):
        serving = asyncio.create_task(self.server.serve())
        await asyncio.wait_for(self.entered.wait(), 5)
        os.kill(os.getpid(), signal.SIGTERM)
        await asyncio.sleep(0.05)
        self.assertNotIn('killed in preflight', self.events)
        self.assertFalse(serving.done(), 'the preflight is not cut short')
        self.release.set()
        await asyncio.wait_for(serving, 10)
        self.assertEqual(self.events, [
            'preflight-start', 'preflight-done', 'stop_hid', 'stop_video', 'stop_audio',
            'stop_all_streams', 'stop_clipboard', 'stop_accessibility',
        ])

    async def test_without_the_patch_a_sigterm_in_the_preflight_finds_no_handler(self):
        # The defect, shown with the same stubs: the signal reaches the default handler (here the
        # safety net; in serve-web, the end of the process) and no cleanup step runs.
        self.require_stock()
        serving = asyncio.create_task(self.build_server(self.source).serve())
        await asyncio.wait_for(self.entered.wait(), 5)
        os.kill(os.getpid(), signal.SIGTERM)
        await asyncio.sleep(0.05)
        self.assertEqual(self.events, ['preflight-start', 'killed in preflight'])
        self.release.set()
        await asyncio.sleep(0.1)
        os.kill(os.getpid(), signal.SIGTERM)
        await asyncio.wait_for(serving, 10)

    async def test_sigterm_after_the_preflight_still_stops_in_order(self):
        self.release.set()
        serving = asyncio.create_task(self.server.serve())
        await asyncio.sleep(0.1)
        self.assertFalse(serving.done(), 'serving until a stop is requested')
        os.kill(os.getpid(), signal.SIGTERM)
        await asyncio.wait_for(serving, 10)
        self.assertNotIn('killed in preflight', self.events)
        self.assertIn('stop_all_streams', self.events)


if __name__ == '__main__':
    unittest.main()
