"""Exercise patched native methods without importing pymobiledevice3 or using a phone."""
import ast
import asyncio
import contextlib
import importlib.util
import json
import logging
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('keyboard_patch', Path(__file__).with_name('pymobiledevice3-keyboard.py'))
patch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patch)
native_paths = list((ROOT / 'python/venv/lib').glob('python*/site-packages/pymobiledevice3/remote/core_device/screen_stream.py'))
logger = logging.getLogger('keyboard-patch-test')
logger.disabled = True


def methods(source, names, scope):
    selected = [node for cls in ast.parse(source).body if isinstance(cls, ast.ClassDef)
                for node in cls.body if isinstance(node, ast.AsyncFunctionDef) and node.name in names]
    assert len(selected) == len(names)
    exec(compile(ast.Module(body=selected, type_ignores=[]), '<actual patched native methods>', 'exec'), scope)
    return {name: scope[name] for name in names}


class Writer:
    def __init__(self):
        self.data = bytearray()
        self.closed = False

    def write(self, data):
        self.data.extend(data)

    async def drain(self):
        pass

    def close(self):
        self.closed = True


class Keyboard:
    def __init__(self):
        self.events = []
        self.entered = asyncio.Event()
        self.gate = None
        self.failure = False

    async def send(self, usages):
        self.events.append('send-start')
        self.entered.set()
        if self.gate:
            await self.gate.wait()
        self.events.append('send-finished')

    async def detach(self):
        self.events.append('detach-start')
        self.entered.set()
        if self.gate:
            await self.gate.wait()
        if self.failure:
            raise RuntimeError('private native error')
        self.events.append('detach-finished')


class SharedService:
    async def close(self):
        pass


class Harness:
    def __init__(self):
        self._hid_queue = asyncio.Queue()
        self._hid_lock = asyncio.Lock()
        self._keyboard = Keyboard()
        self._uhs = SharedService()
        self._indigo = SharedService()

    async def _ensure_hid(self):
        raise AssertionError('Detach must not connect touch/Indigo')

    def _refuse_request(self, _headers):
        return None

    async def _read_body(self, reader, headers):
        return await reader.readexactly(int(headers.get('content-length', 0)))


@unittest.skipUnless(native_paths, 'Native queue tests require the setup:ios source installation')
class NativeQueueTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        source = patch.patch_stream(native_paths[0].read_text())
        self.assertEqual(patch.patch_stream(source), source)
        names = {'_hid_worker', '_handle_key', '_handle_button', '_handle_keyboard_detach', '_stop_hid', '_serve_connection'}
        self.scope = {'asyncio': asyncio, 'contextlib': contextlib, 'json': json, 'logger': logger,
                      '_NAMED_BUTTONS': {'lock': (1, 2, 0.5)}, 'HID_BUTTON_STATE_DOWN': 1, 'HID_BUTTON_STATE_UP': 0}
        native = methods(source, names, self.scope)
        self.server = type('PatchedNativeHarness', (Harness,), native)()
        self.tasks = []

    async def asyncTearDown(self):
        for task in self.tasks:
            task.cancel()
        for task in self.tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await task

    def worker(self):
        task = asyncio.create_task(self.server._hid_worker())
        self.tasks.append(task)
        return task

    async def request(self, path='/keyboard/detach', body=b''):
        reader = asyncio.StreamReader()
        reader.feed_data(f'POST {path} HTTP/1.1\r\nContent-Length: {len(body)}\r\n\r\n'.encode() + body)
        reader.feed_eof()
        writer = Writer()
        task = asyncio.create_task(self.server._serve_connection(reader, writer))
        self.tasks.append(task)
        await asyncio.sleep(0)
        return task, writer

    async def test_button_reply_waits_for_hid_startup_and_the_actual_edge(self):
        connecting, connected = asyncio.Event(), asyncio.Event()
        edges = []

        async def ensure_hid():
            connecting.set()
            await connected.wait()

        class Buttons:
            async def send_button(self, page, usage, state):
                edges.append(state)

        self.server._ensure_hid = ensure_hid
        self.server._indigo = Buttons()
        self.worker()
        down, writer = await self.request('/button', b'{"name":"lock","state":"down"}')
        await connecting.wait()
        self.assertFalse(writer.data, 'DOWN must not be acknowledged while HID is still connecting')
        self.assertEqual(edges, [])
        connected.set()
        await down
        self.assertTrue(writer.data.startswith(b'HTTP/1.1 200 OK\r\n'))
        self.assertEqual(edges, [1])
        up, writer = await self.request('/button', b'{"name":"lock","state":"up"}')
        await up
        self.assertTrue(writer.data.startswith(b'HTTP/1.1 200 OK\r\n'))
        self.assertEqual(edges, [1, 0])

    async def test_button_failure_is_reported_instead_of_acknowledging_the_queue(self):
        async def ensure_hid():
            raise RuntimeError('private native error')
        self.server._ensure_hid = ensure_hid
        self.worker()
        request, writer = await self.request('/button', b'{"name":"lock","state":"down"}')
        await request
        self.assertTrue(writer.data.startswith(b'HTTP/1.1 503 '))
        self.assertNotIn(b'private native error', writer.data)

    async def test_http_200_waits_for_completed_detach(self):
        self.server._keyboard.gate = asyncio.Event()
        self.worker()
        request, writer = await self.request()
        await self.server._keyboard.entered.wait()
        self.assertFalse(writer.data)
        self.server._keyboard.gate.set()
        await request
        self.assertTrue(writer.data.startswith(b'HTTP/1.1 200 OK\r\n'))
        self.assertEqual(self.server._keyboard.events[-1], 'detach-finished')

    async def test_native_failure_returns_503_without_private_error(self):
        self.server._keyboard.failure = True
        self.worker()
        request, writer = await self.request()
        await request
        self.assertTrue(writer.data.startswith(b'HTTP/1.1 503 '))
        self.assertNotIn(b'private native error', writer.data)

    async def test_worker_cancellation_completes_waiting_http_with_503(self):
        self.server._keyboard.gate = asyncio.Event()
        worker = self.worker()
        request, writer = await self.request()
        await self.server._keyboard.entered.wait()
        worker.cancel()
        await request
        self.assertTrue(writer.data.startswith(b'HTTP/1.1 503 '))

    async def test_restart_drain_resolves_queued_detach_as_failure(self):
        request, writer = await self.request()
        await self.server._stop_hid()
        await request
        self.assertTrue(writer.data.startswith(b'HTTP/1.1 503 '))
        self.assertTrue(self.server._hid_queue.empty())

    async def test_timeout_cancels_pending_detach_so_it_cannot_run_late(self):
        class FastTimeout:
            def __getattr__(self, name):
                return getattr(asyncio, name)

            async def wait_for(self, awaitable, timeout):
                self_test.assertEqual(timeout, 8.0)
                return await asyncio.wait_for(awaitable, timeout=0.001)

        self_test = self
        self.scope['asyncio'] = FastTimeout()
        request, writer = await self.request()
        await request
        self.assertTrue(writer.data.startswith(b'HTTP/1.1 503 '))
        self.assertTrue(self.server._hid_queue._queue[0][2].cancelled())
        self.worker()
        await asyncio.sleep(0)
        self.assertEqual(self.server._keyboard.events, [])

    async def test_detach_stays_after_the_last_queued_key(self):
        gate = self.server._keyboard.gate = asyncio.Event()
        self.server._hid_queue.put_nowait(('/key', b'{"usages":[4]}'))
        self.worker()
        await self.server._keyboard.entered.wait()
        request, writer = await self.request()
        self.assertFalse(writer.data)
        gate.set()
        await request
        self.assertEqual(self.server._keyboard.events,
                         ['send-start', 'send-finished', 'detach-start', 'detach-finished'])

    async def test_key_waits_until_shared_hid_shutdown_finishes(self):
        entered, finish = asyncio.Event(), asyncio.Event()

        class ClosingSharedService:
            async def close(self):
                entered.set()
                await finish.wait()

        self.server._uhs = ClosingSharedService()
        stopping = asyncio.create_task(self.server._stop_hid())
        self.tasks.append(stopping)
        await entered.wait()
        sending = asyncio.create_task(self.server._handle_key(b'{"usages":[4]}'))
        self.tasks.append(sending)
        await asyncio.sleep(0)
        self.assertNotIn('send-start', self.server._keyboard.events)
        finish.set()
        await asyncio.gather(stopping, sending)
        self.assertEqual(self.server._keyboard.events[-1], 'send-finished')

    async def test_patch_upgrade_is_compilable_and_idempotent(self):
        source = patch.patch_stream(native_paths[0].read_text())
        compile(source, '<native patched stream>', 'exec')
        self.assertEqual(patch.patch_stream(source), source)


class NativeRemovalTests(unittest.IsolatedAsyncioTestCase):
    async def test_remove_requires_a_valid_list_with_own_service_absent(self):
        source = 'class Service:\n    async def send_keyboard(\n        self, identity, usages\n    ):\n        pass\n'
        source = patch.patch_hid(source)
        self.assertEqual(patch.patch_hid(source), source)
        native = methods(source, {'remove_keyboard_service'}, {'XpcUInt64Type': int})

        class HID:
            service = None
            response = None

            async def send_request(self, request):
                self.request = request

            async def list_connected_services(self):
                return self.response

        instance = type('PatchedHID', (HID,), native)()
        instance.service = instance
        for response in ({}, {'error': 'unavailable'}, {'connectedServices': {}}, {'connectedServices': [None]},
                         {'connectedServices': [{'_ServiceID': 123}]}):
            with self.subTest(response=response), self.assertRaises(RuntimeError):
                instance.response = response
                await instance.remove_keyboard_service(123)
        instance.response = {'connectedServices': [{'_ServiceID': 257}]}
        await instance.remove_keyboard_service(123)
        self.assertEqual(instance.request['payload'], {'removeService': {'_0': 123}})


if __name__ == '__main__':
    unittest.main()
