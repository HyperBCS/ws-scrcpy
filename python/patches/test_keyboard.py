import asyncio
import unittest

from keyboard import VirtualKeyboard


class Service:
    def __init__(self, events, identity):
        self.events, self.identity = events, identity
        self.remove_error = False
        self.attach_gate = None
        self.send_gate = None

    async def connect(self):
        self.events.append(('connect', self.identity))

    async def create_keyboard_service(self):
        self.events.append(('attach', self.identity))
        if self.attach_gate:
            await self.attach_gate.wait()
        return self.identity

    async def send_keyboard(self, identity, usages):
        self.events.append(('keys', identity, tuple(usages)))
        if usages and self.send_gate:
            await self.send_gate.wait()

    async def remove_keyboard_service(self, identity):
        self.events.append(('remove', identity))
        if self.remove_error:
            raise RuntimeError('Removal failed')

    async def close(self):
        self.events.append(('close', self.identity))


class KeyboardTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.events = []
        self.services = []

        def factory():
            service = Service(self.events, len(self.services) + 100)
            self.services.append(service)
            return service

        self.keyboard = VirtualKeyboard(factory)

    async def test_empty_release_and_detach_never_attach(self):
        await self.keyboard.send([])
        await self.keyboard.detach()
        self.assertEqual(self.events, [])

    async def test_detach_releases_keys_removes_only_own_id_and_closes(self):
        await self.keyboard.send([225, 4])
        await self.keyboard.send([])
        await self.keyboard.detach()
        self.assertEqual(self.events, [
            ('connect', 100), ('attach', 100), ('keys', 100, (225, 4)),
            ('keys', 100, ()), ('keys', 100, ()), ('remove', 100), ('close', 100),
        ])

    async def test_typing_after_done_registers_a_fresh_keyboard(self):
        await self.keyboard.send([4])
        await self.keyboard.detach()
        await self.keyboard.send([])
        await self.keyboard.send([5])
        await self.keyboard.detach()
        self.assertEqual([e for e in self.events if e[0] == 'attach'], [('attach', 100), ('attach', 101)])
        self.assertIn(('keys', 101, (5,)), self.events)

    async def test_detach_waits_for_an_inflight_key(self):
        await self.keyboard.send([4])
        gate = self.services[0].send_gate = asyncio.Event()
        sending = asyncio.create_task(self.keyboard.send([5]))
        await asyncio.sleep(0)
        detaching = asyncio.create_task(self.keyboard.detach())
        await asyncio.sleep(0)
        self.assertNotIn(('remove', 100), self.events)
        gate.set()
        await asyncio.gather(sending, detaching)
        self.assertLess(self.events.index(('keys', 100, (5,))), self.events.index(('remove', 100)))

    async def test_failed_removal_closes_and_does_not_reuse_stale_service(self):
        await self.keyboard.send([4])
        self.services[0].remove_error = True
        with self.assertRaises(RuntimeError):
            await self.keyboard.detach()
        self.assertEqual(self.events[-1], ('close', 100))
        await self.keyboard.send([5])
        self.assertEqual(self.events[-1], ('keys', 101, (5,)))
        await self.keyboard.detach()

    async def test_cancelled_attach_closes_partial_connection(self):
        service = Service(self.events, 100)
        service.attach_gate = asyncio.Event()
        keyboard = VirtualKeyboard(lambda: service)
        task = asyncio.create_task(keyboard.send([4]))
        await asyncio.sleep(0)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(self.events[-1], ('close', 100))
        self.assertFalse(any(event[0] == 'keys' for event in self.events))
        await keyboard.detach()


if __name__ == '__main__':
    unittest.main()
