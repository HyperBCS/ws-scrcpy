"""An independently owned CoreDevice keyboard; touch and media stay connected."""
import asyncio
import contextlib


class VirtualKeyboard:
    def __init__(self, service_factory):
        self._factory = service_factory
        self._service = None
        self._identity = None
        self._lock = asyncio.Lock()

    async def send(self, usages):
        async with self._lock:
            # A release is not a reason to register a hardware keyboard on iOS.
            if not usages and self._identity is None:
                return
            try:
                async with asyncio.timeout(4):
                    if self._service is None:
                        self._service = self._factory()
                        await self._service.connect()
                        self._identity = await self._service.create_keyboard_service()
                    await self._service.send_keyboard(self._identity, usages)
            except BaseException:
                # Includes cancellation during attach: do not strand a partly registered
                # keyboard or reuse a connection with an unread XPC response.
                with contextlib.suppress(Exception):
                    await self._detach()
                raise

    async def detach(self):
        async with self._lock:
            await self._detach()

    async def _detach(self):
        service, identity = self._service, self._identity
        self._service = self._identity = None
        if service is None:
            return
        try:
            async with asyncio.timeout(2):
                if identity is not None:
                    await service.send_keyboard(identity, [])
                    await service.remove_keyboard_service(identity)
        finally:
            # Closing this dedicated connection also releases iOS's hardware-keyboard
            # presence assertion. Never close the shared touch/Indigo/media connections.
            await asyncio.wait_for(service.close(), timeout=2)
