"""Idempotent keyboard lifecycle extension, pinned to python/requirements.txt."""
import importlib.util
from pathlib import Path
import shutil

MARKER = '# ws-scrcpy keyboard lifecycle'
VERSION_MARKER = '# ws-scrcpy keyboard lifecycle v2'


def replace_once(source, old, new):
    if source.count(old) != 1:
        raise RuntimeError('The installed pymobiledevice3 differs from the supported version')
    return source.replace(old, new)


def patch_stream_initial(source):
    if MARKER in source:
        return source
    source = replace_once(source, '        self._kb_service_id: Optional[int] = None', '''        # ws-scrcpy keyboard lifecycle
        from .ws_scrcpy_keyboard import VirtualKeyboard
        # Resolve RSD at attach time, including after a USB reconnection.
        self._keyboard = VirtualKeyboard(lambda: UniversalHIDServiceService(self._rsd))''')
    source = replace_once(source, '        async with self._hid_lock:\n            if self._uhs is not None:', '''        with contextlib.suppress(Exception):
            await self._keyboard.detach()
        async with self._hid_lock:
            if self._uhs is not None:''')
    start = source.index('            # The keyboard surface is host-registered against the live')
    end = source.index('\n    async def _hid_worker', start)
    source = source[:start] + source[end:]
    source = replace_once(source, '''                    elif path == "/button":
                        handler = self._handle_button
                    else:''', '''                    elif path == "/button":
                        handler = self._handle_button
                    elif path == "/keyboard/detach":
                        handler = self._handle_keyboard_detach
                    else:''')
    start = source.index('    async def _ensure_keyboard(self) -> None:')
    end = source.index('    async def _handle_button', start)
    source = source[:start] + '''    async def _handle_key(self, body: bytes) -> tuple[int, bytes]:
        try:
            usages = json.loads(body).get("usages", [])
            if not isinstance(usages, list) or len(usages) > 240 or any(
                type(usage) is not int or not 0 <= usage < 240 for usage in usages
            ):
                raise ValueError("Invalid keyboard report")
        except (AttributeError, TypeError, ValueError, json.JSONDecodeError):
            return 400, b"invalid keyboard report"
        await self._keyboard.send(usages)
        return 200, b"ok"

    async def _handle_keyboard_detach(self, body: bytes) -> tuple[int, bytes]:
        # Runs in the same queue as /key: removal cannot overtake pending text.
        await self._keyboard.detach()
        return 200, b"ok"

''' + source[end:]
    source = replace_once(source, 'path in ("/touch", "/button", "/key"):', 'path in ("/touch", "/button", "/key", "/keyboard/detach"):')
    # HID reports may contain passwords. Failures must never log their payloads.
    source = replace_once(source, 'logger.exception("queued HID dispatch failed: %s body=%r", path, body[:200])', 'logger.exception("queued HID dispatch failed: %s", path)')
    source = replace_once(source, 'logger.debug("enqueue %s body=%r conn=%s", path, body[:80], headers.get("connection", "?"))', 'logger.debug("enqueue %s conn=%s", path, headers.get("connection", "?"))')
    return source


def patch_stream_v2(source):
    source = patch_stream_initial(source)
    if VERSION_MARKER in source:
        return source
    source = replace_once(source, '''        with contextlib.suppress(Exception):
            await self._keyboard.detach()
        async with self._hid_lock:''', '''        async with self._hid_lock:
            with contextlib.suppress(Exception):
                await self._keyboard.detach()''')
    source = replace_once(source, '        await self._keyboard.send(usages)', '''        async with self._hid_lock:
            await self._keyboard.send(usages)''')
    source = replace_once(source, '''        await self._keyboard.detach()
        return 200, b"ok"''', '''        async with self._hid_lock:
            await self._keyboard.detach()
        return 200, b"ok"''')
    source = replace_once(source, '                self._hid_queue.get_nowait()', '''                request = self._hid_queue.get_nowait()
                if len(request) == 3 and not request[2].done():
                    request[2].set_result((503, b"Input session restarted"))''')
    source = replace_once(source, 'self._hid_queue: asyncio.Queue[tuple[str, bytes]] = asyncio.Queue()',
                          'self._hid_queue: asyncio.Queue[tuple[str, bytes] | tuple[str, bytes, asyncio.Future]] = asyncio.Queue()')
    source = replace_once(source, '                path, body = await self._hid_queue.get()', '''                request = await self._hid_queue.get()
                path, body = request[:2]
                completion = request[2] if len(request) == 3 else None
                if completion is not None and completion.cancelled():
                    continue''')
    source = replace_once(source, '                    if self._uhs is None or self._indigo is None:',
                          '                    if path != "/keyboard/detach" and (self._uhs is None or self._indigo is None):')
    source = replace_once(source, '                    code, msg = await handler(body)', '''                    code, msg = await handler(body)
                    if completion is not None and not completion.done():
                        completion.set_result((code, msg))''')
    source = replace_once(source, '''                except Exception:
                    logger.exception("queued HID dispatch failed: %s", path)''', '''                except asyncio.CancelledError:
                    if completion is not None and not completion.done():
                        completion.set_result((503, b"Keyboard disconnect interrupted"))
                    raise
                except Exception:
                    if completion is not None and not completion.done():
                        completion.set_result((503, b"Keyboard disconnect failed"))
                    logger.exception("queued HID dispatch failed: %s", path)''')
    source = replace_once(source, '''            if method == "POST" and path in ("/touch", "/button", "/key", "/keyboard/detach"):''', '''            # ws-scrcpy keyboard lifecycle v2
            if method == "POST" and path == "/keyboard/detach":
                body = await self._read_body(reader, headers)
                completion = asyncio.get_running_loop().create_future()
                self._hid_queue.put_nowait((path, body, completion))
                try:
                    code, message = await asyncio.wait_for(asyncio.shield(completion), timeout=8.0)
                except asyncio.TimeoutError:
                    code, message = 503, b"Keyboard disconnect timed out"
                finally:
                    if not completion.done():
                        completion.cancel()
                status = b"200 OK" if code == 200 else b"503 Service Unavailable"
                writer.write(b"HTTP/1.1 " + status + b"\\r\\nContent-Type: text/plain\\r\\n"
                             + b"Content-Length: " + str(len(message)).encode()
                             + b"\\r\\nConnection: close\\r\\n\\r\\n" + message)
                await writer.drain()
                writer.close()
                return

            if method == "POST" and path in ("/touch", "/button", "/key"):''')
    return source


def patch_stream(source):
    source = patch_stream_v2(source)
    marker = '# ws-scrcpy button completion'
    if marker in source:
        return source
    # The proxy measures each button hold after DOWN reaches the phone. A queue
    # acknowledgement can arrive before HID connects, collapsing DOWN/UP together.
    source = replace_once(source, '            if method == "POST" and path == "/keyboard/detach":',
                          f'''            {marker}
            if method == "POST" and path in ("/keyboard/detach", "/button"):''')
    for suffix in ('timed out', 'interrupted', 'failed'):
        source = source.replace(f'Keyboard disconnect {suffix}', f'Device input {suffix}')
    return source


def patch_hid_initial(source):
    if MARKER in source:
        return source
    return replace_once(source, '    async def send_keyboard(\n', '''    # ws-scrcpy keyboard lifecycle
    async def remove_keyboard_service(self, service_id: int) -> None:
        # removeService is one-way, unlike createService/connectedServices.
        # Only called with the ID returned by our own create_keyboard_service.
        await self.service.send_request({
            "featureIdentifier": "com.apple.coredevice.feature.remote.universalhidservice",
            "messageType": "Request",
            "payload": {"removeService": {"_0": XpcUInt64Type(service_id)}},
        })
        response = await self.list_connected_services()
        if any(int(item.get("_ServiceID", -1)) == service_id
               for item in response.get("connectedServices", [])):
            raise RuntimeError("Virtual keyboard removal was not acknowledged")

    async def send_keyboard(
''')


def patch_hid(source):
    source = patch_hid_initial(source)
    if VERSION_MARKER in source:
        return source
    return replace_once(source, '''        if any(int(item.get("_ServiceID", -1)) == service_id
               for item in response.get("connectedServices", [])):''', '''        # ws-scrcpy keyboard lifecycle v2
        connected = response.get("connectedServices") if isinstance(response, dict) else None
        if not isinstance(connected, list) or any(not isinstance(item, dict) for item in connected):
            raise RuntimeError("Invalid virtual keyboard removal response")
        if any(int(item.get("_ServiceID", -1)) == service_id for item in connected):''')


def main():
    spec = importlib.util.find_spec('pymobiledevice3.remote.core_device.screen_stream')
    stream = Path(spec.origin)
    hid = stream.with_name('hid_service.py')
    # Check both files before writing either, so version mismatches fail cleanly.
    stream_source, hid_source = patch_stream(stream.read_text()), patch_hid(hid.read_text())
    compile(stream_source, str(stream), 'exec')
    compile(hid_source, str(hid), 'exec')
    stream.write_text(stream_source)
    hid.write_text(hid_source)
    shutil.copyfile(Path(__file__).with_name('keyboard.py'), stream.with_name('ws_scrcpy_keyboard.py'))
    print('Keyboard lifecycle patch ready')


if __name__ == '__main__':
    main()
