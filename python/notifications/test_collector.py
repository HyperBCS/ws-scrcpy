"""Exercise the collector state machine without importing BlueZ or opening D-Bus."""
import ast
from collections import deque
import contextlib
import io
import json
from pathlib import Path
import struct
import time
import traceback
import unittest
import uuid

from protocol import ANCS, SOURCE, DATA, CONTROL, AttributeResponse, notification_request, app_request, negative_action_request


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.writes = []
        self.disconnections = []
        self.write_errors = []
        self.write_replies = []
        self.unregistered = []
        self.registered = []
        self.subscriptions = []
        self.managed = dict
        self.quits = []
        self.stdin = []
        test = self

        class DBus:
            Array = staticmethod(lambda value, **kwargs: value)
            Dictionary = staticmethod(lambda value, **kwargs: value)

            class DBusException(Exception): pass

            class service:
                Object = object
                method = staticmethod(lambda *args, **kwargs: lambda function: function)

        class Interface:
            def WriteValue(self, payload, options, reply_handler, error_handler):
                test.writes.append(payload)
                test.write_errors.append(error_handler)
                test.write_replies.append(reply_handler)

            def GetManagedObjects(self, **kwargs):
                return test.managed()

            def StartNotify(self, reply_handler, error_handler):
                test.subscriptions.append((reply_handler, error_handler))

            def Disconnect(self, **kwargs):
                test.disconnections.append(True)

            def UnregisterAdvertisement(self, path):
                test.unregistered.append(path)

            def RegisterAdvertisement(self, path, options, reply_handler, error_handler):
                test.registered.append(path)

        # Import only Client: the module's executable section owns a live system
        # bus and GLib loop. The class itself runs against these controlled stubs.
        tree = ast.parse(Path(__file__).with_name('collector.py').read_text())
        declarations = [node for node in tree.body if
                        isinstance(node, (ast.ClassDef, ast.FunctionDef)) and
                        node.name in ('Client', 'property_changed', 'handle_command', 'refresh_advert',
                                      'Rejected', 'Agent', 'tick', 'command_input', 'stop_after')]

        class Loop:
            quit = staticmethod(lambda: test.quits.append(True))

        class Os:
            read = staticmethod(lambda descriptor, size: test.stdin.pop(0))

        class Sys:
            class stdin:
                fileno = staticmethod(lambda: 0)
        self.scope = {
            'time': time, 'uuid': uuid, 'struct': struct, 'deque': deque, 'json': json,
            'ANCS': ANCS, 'SOURCE': SOURCE, 'DATA': DATA, 'CONTROL': CONTROL,
            'AttributeResponse': AttributeResponse, 'notification_request': notification_request,
            'app_request': app_request, 'negative_action_request': negative_action_request,
            'clients': {}, 'sources': {'AA:BB:CC:DD:EE:FF': 'phone'}, 'dbus': DBus,
            'objects': {}, 'owned_notifications': set(),
            'advert_ready': False, 'advert_since': 0, 'ADVERT_REFRESH': 120, 'ADAPTER': '/hci0', 'ADVERT': '/advert',
            'pair_until': 0, 'confirmation': None, 'RESET_HOLDOFF': 35,
            'MAX_UIDS': 512, 'MAX_QUEUED_ACTIONS': 32, 'pair_attempts': {}, 'advert_pending': False,
            'loop': Loop, 'os': Os, 'sys': Sys, 'traceback': traceback, 'input_buffer': bytearray(),
            'emit': lambda kind, **fields: self.events.append(dict(kind=kind, **fields)),
            'iface': lambda *args: Interface(),
        }
        exec(compile(ast.Module(body=declarations, type_ignores=[]), 'collector.Client', 'exec'), self.scope)
        self.client = self.scope['Client']('/phone', 'phone', {DATA: '/data', SOURCE: '/source', CONTROL: '/control'})
        self.scope['clients']['phone'] = self.client
        self.client.apps['example.app'] = 'Example'

    def source(self, event, uid=42, flags=0):
        self.client.data('/source', struct.pack('<BBBBI', event, flags, 0, 1, uid))

    def reply(self, uid=42, title='Alert', app='example.app', action=None):
        _, prefix, attributes = notification_request(uid, negative_action=action is not None)
        self.attributes(prefix, attributes, {0: app, 1: title, 2: '', 3: 'Body', 5: '20261025T120000', 7: action})

    def app_reply(self, app, name):
        _, prefix, attributes = app_request(app)
        self.attributes(prefix, attributes, {0: name})

    def attributes(self, prefix, attributes, values):
        response = prefix + b''.join(
            struct.pack('<BH', attribute, len(values[attribute].encode())) + values[attribute].encode()
            for attribute in attributes
        )
        self.client.data('/data', response)

    def notifications(self):
        return [event for event in self.events if event['kind'] == 'notification']

    def error(self, name='org.bluez.Error.Failed', message='Temporary GATT failure'):
        class Error(Exception):
            def get_dbus_name(self): return name
        self.write_errors[-1](Error(message))

    def resume(self):
        self.client.retry_at = 0
        self.client.pump()

    def dismiss(self, **changes):
        command = dict(type='dismiss', requestId='request-1', source='phone', session=self.client.session, uid=42)
        self.scope['handle_command'](json.dumps(dict(command, **changes)))

    def action_results(self):
        return [event for event in self.events if event['kind'] == 'action-result']

    def time_out(self):
        parser, done, _, job = self.client.current
        self.client.current = (parser, done, 0, job)
        self.client.tick()

    def statuses(self):
        return [event['status'] for event in self.events if event['kind'] == 'status']

    def test_advert_is_registered_again_only_while_a_source_is_disconnected(self):
        refresh, now = self.scope['refresh_advert'], time.monotonic()
        self.scope.update(advert_ready=True, advert_since=now - 121)
        refresh()
        self.assertEqual(self.unregistered, [])
        self.scope['clients'].clear()
        self.scope['advert_since'] = now - 60
        refresh()
        self.assertEqual(self.unregistered, [])
        self.scope['advert_since'] = now - 121
        refresh()
        self.assertEqual(self.unregistered, ['/advert'])
        self.assertFalse(self.scope['advert_ready'])
        refresh()
        self.assertEqual(self.unregistered, ['/advert'])

    def test_poll_reports_devices_and_keeps_its_timer(self):
        self.assertIs(self.scope['tick'](), True)
        self.assertEqual(self.events[-1], dict(kind='devices', devices=[], pairingOpen=False))
        self.assertEqual(self.registered, ['/advert'])
        self.assertEqual(self.quits, [])

    def test_unexpected_error_in_the_poll_stops_the_process_for_a_restart(self):
        def broken(): raise RuntimeError('unexpected')
        self.managed = broken
        output = io.StringIO()
        with contextlib.redirect_stderr(output):
            self.assertIs(self.scope['tick'](), False)
        self.assertEqual(self.events[-1], dict(
            kind='error', message='Bluetooth collector stopped after an internal error (RuntimeError)'))
        self.assertEqual(self.quits, [True], 'a dropped timer must not leave the process idle')
        self.assertIn('RuntimeError: unexpected', output.getvalue(), 'the traceback goes to the server log')

    def test_bluetooth_error_in_the_poll_still_reports_bluetooth_unavailable(self):
        def unavailable(): raise self.scope['dbus'].DBusException('org.bluez was not provided')
        self.managed = unavailable
        self.assertIs(self.scope['tick'](), False)
        self.assertEqual(self.events[-1], dict(kind='error', message='Bluetooth unavailable: org.bluez was not provided'))
        self.assertEqual(self.quits, [True])

    def test_unexpected_error_in_a_command_stops_the_process_for_a_restart(self):
        handled = []
        self.scope['handle_command'] = handled.append
        self.stdin = [b'{"type":"pa', b'ir"}\n{"type":"confirm"}\n']
        self.assertIs(self.scope['command_input'](None, None), True)
        self.assertIs(self.scope['command_input'](None, None), True)
        self.assertEqual(handled, [b'{"type":"pair"}', b'{"type":"confirm"}'])
        def broken(line): raise RuntimeError('unexpected')
        self.scope['handle_command'] = broken
        self.stdin = [b'{}\n']
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertIs(self.scope['command_input'](None, None), False)
        self.assertEqual(self.events[-1]['kind'], 'error')
        self.assertEqual(self.quits, [True])

    def confirm_pairing(self):
        errors = []
        self.scope['objects'] = {'/dev': {'org.bluez.Device1': {'Address': 'AA:BB:CC:DD:EE:FF'}}}
        self.scope['Agent']().RequestConfirmation('/dev', 699933, lambda: None, errors.append)
        return errors

    def test_pairing_request_with_no_open_window_is_rejected_and_reported(self):
        errors = self.confirm_pairing()
        self.assertEqual([str(error) for error in errors], ['Pairing window closed'])
        self.assertEqual(self.events[-1], dict(kind='pairing-rejected', address='AA:BB:CC:DD:EE:FF'))
        self.assertIsNone(self.scope['confirmation'])

    def test_pair_command_reopens_the_remaining_window(self):
        self.scope['handle_command'](json.dumps(dict(type='pair', seconds=30)))
        self.assertAlmostEqual(self.scope['pair_until'] - time.monotonic(), 30, delta=1)
        self.assertEqual(self.confirm_pairing(), [])
        self.assertEqual(self.events[-1], dict(kind='pairing', address='AA:BB:CC:DD:EE:FF', code='699933'))
        for seconds in (0, 121, '30', True):
            self.events.clear()
            self.scope['handle_command'](json.dumps(dict(type='pair', seconds=seconds)))
            self.assertEqual(self.events, [dict(kind='error', message='Invalid collector command')])

    def test_added_then_modified_during_fetch_publishes_latest_once_as_added(self):
        self.source(0)
        self.source(1)
        self.reply(title='Initial')
        self.assertEqual(self.notifications(), [])
        self.reply(title='Updated')
        self.assertEqual([(n['event'], n['title'], n['preExisting']) for n in self.notifications()],
                         [('added', 'Updated', False)])
        self.source(1)
        self.reply(title='Later edit')
        self.assertEqual(self.notifications()[-1]['event'], 'modified')
        self.assertEqual(self.client.pending_added, {})

    def test_preexisting_flag_survives_modified_attributes_and_app_name_fetch(self):
        self.source(0, flags=4)
        self.reply(app='uncached.app')
        self.source(1)  # Modified carries no PreExisting bit.
        self.app_reply('uncached.app', 'Uncached')
        self.assertEqual(self.notifications(), [])
        self.reply(title='Updated old alert', app='uncached.app')
        self.assertEqual([(n['event'], n['preExisting']) for n in self.notifications()], [('added', True)])

    def test_removal_cancels_pending_added_and_a_new_added_can_reuse_uid(self):
        self.source(0, flags=4)
        self.source(2)
        self.reply(title='Removed')
        self.assertEqual([n['event'] for n in self.notifications()], ['removed'])
        self.assertEqual(self.client.pending_added, {})
        self.source(0)
        self.reply(title='New')
        self.assertEqual((self.notifications()[-1]['event'], self.notifications()[-1]['preExisting']), ('added', False))

    def test_multiple_uids_keep_independent_pending_intent_and_serial_requests(self):
        self.source(0, uid=1)
        self.source(0, uid=2, flags=4)
        self.source(1, uid=1)
        self.assertEqual(len(self.writes), 1, 'only one control-point request is in flight')
        self.reply(uid=1, title='Stale A')
        self.reply(uid=2, title='B')
        self.reply(uid=1, title='Latest A')
        self.assertEqual([(n['uid'], n['event'], n['preExisting']) for n in self.notifications()],
                         [(2, 'added', True), (1, 'added', False)])
        self.assertIsNone(self.client.current)
        self.assertEqual(len(self.writes), 3)

    def test_bounded_uid_eviction_discards_pending_added_intent(self):
        self.source(0, uid=1)
        # Removed tombstones exercise the UID bound without overflowing the
        # independent attribute request queue.
        for uid in range(2, 514):
            self.source(2, uid=uid)
        self.assertEqual(len(self.client.revisions), 512)
        self.assertNotIn(1, self.client.pending_added)
        self.reply(uid=1, title='Evicted')
        self.assertFalse(any(n['event'] == 'added' for n in self.notifications()))

    def test_reconnect_burst_larger_than_the_uid_limit_keeps_the_session(self):
        for uid in range(1, 601):
            self.source(0, uid=uid, flags=4)
        self.assertIs(self.scope['clients'].get('phone'), self.client, 'the burst must not reset the session')
        self.assertEqual(self.client.retry_at, 0)
        self.assertFalse(any(event['kind'] == 'status' for event in self.events))
        self.assertEqual(len(self.client.queue), 512, 'one fetch per tracked UID')
        self.assertEqual(len(self.writes), 1, 'only one control-point request is in flight')
        self.reply(uid=1, title='Gave up')
        for uid in range(89, 601):
            self.reply(uid=uid, title=f'Alert {uid}')
        self.assertEqual([(n['uid'], n['event'], n['preExisting']) for n in self.notifications()],
                         [(uid, 'added', True) for uid in range(89, 601)], 'only the oldest announcements are dropped')
        self.assertEqual(self.client.queue, {})
        self.source(0, uid=601)
        self.reply(uid=601, title='New')
        self.assertEqual((self.notifications()[-1]['uid'], self.notifications()[-1]['preExisting']), (601, False))

    def test_repeated_changes_to_one_alert_queue_a_single_fetch_in_its_place(self):
        self.source(0, uid=1)
        self.source(0, uid=2)
        self.source(0, uid=3)
        for _ in range(300):
            self.source(1, uid=2)
        self.assertEqual(list(self.client.queue), [2, 3])
        self.source(2, uid=3)
        self.assertEqual(list(self.client.queue), [2], 'a removed alert needs no fetch')
        self.reply(uid=1)
        self.reply(uid=2, title='Latest')
        self.assertEqual([(n['uid'], n['event']) for n in self.notifications()],
                         [(3, 'removed'), (1, 'added'), (2, 'added')])
        self.assertEqual(len(self.writes), 2)

    def test_action_queue_is_bounded_without_resetting_the_session(self):
        self.source(0, uid=1)  # Keeps the control point busy so the actions stay queued.
        for uid in range(100, 133):
            self.client.active_notifications[uid] = dict(canDismiss=True, negativeActionLabel='Clear')
            self.dismiss(requestId=f'request-{uid}', uid=uid)
        results = self.action_results()
        self.assertEqual([(result['uid'], result['ok']) for result in results], [(132, False)])
        self.assertIn('busy', results[0]['error'])
        self.assertIs(self.scope['clients'].get('phone'), self.client)
        self.assertEqual(len(self.client.queue), 32)

    def test_evicted_uid_reuse_cannot_publish_an_old_inflight_response(self):
        self.source(0, uid=1, flags=4)
        for uid in range(2, 514):
            self.source(2, uid=uid)
        self.source(0, uid=1)
        self.reply(uid=1, title='Evicted old value')
        self.assertFalse(any(n['event'] == 'added' for n in self.notifications()))
        self.reply(uid=1, title='New value')
        self.assertEqual((self.notifications()[-1]['title'], self.notifications()[-1]['preExisting']), ('New value', False))

    def test_transient_write_failure_preserves_other_uids_and_retries_in_order(self):
        self.source(0, uid=1)
        self.source(0, uid=2)
        self.error()
        self.assertEqual(len(self.client.queue), 2)
        self.assertEqual(len(self.writes), 1, 'backoff prevents an immediate write storm')
        self.resume()
        self.reply(uid=2, title='B')
        self.reply(uid=1, title='Retried A')
        self.assertEqual([(n['uid'], n['event']) for n in self.notifications()], [(2, 'added'), (1, 'added')])
        self.assertEqual([struct.unpack_from('<I', p, 1)[0] for p in self.writes], [1, 2, 1])

    def test_exhausted_write_retries_drop_only_failed_uid_and_clear_fresh_intent(self):
        self.source(0, uid=1)
        for _ in range(2):
            self.error()
            self.resume()
        self.source(0, uid=2)
        self.error()
        self.assertEqual(len(self.writes), 4, 'three writes for UID1, then UID2 proceeds')
        self.assertNotIn(1, self.client.pending_added)
        self.reply(uid=2)
        self.assertEqual([n['uid'] for n in self.notifications()], [2])

    def test_removed_uid_is_not_retried_and_does_not_block_other_uids(self):
        self.source(0, uid=1)
        self.source(0, uid=2)
        self.error()
        self.source(2, uid=1)
        self.resume()
        self.reply(uid=2)
        self.assertEqual(len(self.writes), 2)
        self.assertEqual([(n['uid'], n['event']) for n in self.notifications()], [(1, 'removed'), (2, 'added')])
        self.assertEqual(self.client.pending_added, {})

    def test_invalid_ancs_uid_does_not_retry_or_discard_next_notification(self):
        self.source(0, uid=1)
        self.source(0, uid=2)
        self.error(message='ATT error: 0xa2')
        self.assertNotIn(1, self.client.pending_added)
        self.assertEqual(len(self.writes), 2)
        self.reply(uid=2)
        self.assertEqual([n['uid'] for n in self.notifications()], [2])

    def test_missing_app_name_falls_back_to_bundle_id_and_preserves_next_uid(self):
        self.source(0, uid=1)
        self.reply(uid=1, app='unknown.app')
        self.source(0, uid=2)
        self.error(message='ATT error: 0xa2')
        first = self.notifications()[0]
        self.assertEqual((first['uid'], first['event'], first['appName']), (1, 'added', 'unknown.app'))
        self.reply(uid=2)
        self.assertEqual([n['uid'] for n in self.notifications()], [1, 2])

    def test_permission_failure_is_throttled_without_discarding_pending_uids(self):
        self.source(0, uid=1)
        self.source(0, uid=2)
        before = time.monotonic()
        self.error(name='org.bluez.Error.NotPermitted', message='Not permitted')
        self.assertGreaterEqual(self.client.retry_at, before + 10)
        self.assertEqual(len(self.client.queue), 2)
        self.client.pump()
        self.assertEqual(len(self.writes), 1)
        self.assertIn('Allow notification sharing', self.client.last_status)
        self.resume()
        self.reply(uid=2)
        self.reply(uid=1)
        self.assertEqual([n['uid'] for n in self.notifications()], [2, 1])

    def test_action_metadata_uses_real_label_and_write_ack_does_not_invent_removal(self):
        self.source(0, flags=16)
        self.reply(action='Decline')
        self.assertEqual((self.notifications()[0]['canDismiss'], self.notifications()[0]['negativeActionLabel']),
                         (True, 'Decline'))
        self.dismiss()
        self.assertEqual(self.writes[-1], negative_action_request(42))
        self.assertEqual(self.action_results(), [], 'wait for the ATT write reply')
        self.source(0, uid=43)
        self.assertEqual(len(self.writes), 2, 'attribute reads wait for the action ACK')
        self.write_replies[-1]()
        self.assertTrue(self.action_results()[0]['ok'])
        self.assertEqual(len(self.writes), 3, 'next read starts without waiting for nonexistent action data')
        self.reply(uid=43)
        self.assertEqual([n['event'] for n in self.notifications()], ['added', 'added'])
        self.source(2)
        self.assertEqual(self.notifications()[-1]['event'], 'removed')

    def test_no_action_without_current_flag_and_label(self):
        for flags, label in [(0, None), (16, '')]:
            self.source(0, flags=flags)
            self.reply(action=label)
            count = len(self.writes)
            self.dismiss(requestId=f'request-{flags}')
            self.assertEqual(len(self.writes), count)
            self.assertFalse(self.action_results()[-1]['ok'])

    def test_stale_session_source_and_uid_never_write_action(self):
        self.source(0, flags=16)
        self.reply(action='Clear')
        for changes in [{'session': 'previous-session'}, {'source': 'another-phone'}, {'uid': 999}]:
            self.dismiss(**changes)
            self.assertFalse(self.action_results()[-1]['ok'])
        self.assertEqual(len(self.writes), 1)

    def test_stale_action_label_is_rejected_before_write(self):
        self.source(0, flags=16)
        self.reply(action='Decline')
        self.dismiss(expectedLabel='Dismiss')
        self.assertFalse(self.action_results()[-1]['ok'])
        self.assertEqual(len(self.writes), 1)
        self.dismiss(requestId='request-2', expectedLabel='Decline')
        self.assertEqual(self.writes[-1], negative_action_request(42))
        self.write_replies[-1]()
        self.assertTrue(self.action_results()[-1]['ok'])

    def test_queued_action_is_cancelled_when_notification_changes_or_is_removed(self):
        self.source(0, flags=16)
        self.reply(action='Clear')
        self.source(0, uid=43)
        self.dismiss()
        self.source(1, flags=0)
        self.reply(uid=43)
        self.assertFalse(self.action_results()[-1]['ok'])
        self.assertFalse(any(payload[0] == 2 for payload in self.writes))
        self.reply()
        self.source(0, flags=16)
        self.reply(action='Clear')
        self.source(0, uid=44)
        self.dismiss(requestId='request-2')
        self.source(2)
        self.reply(uid=44)
        self.assertEqual(len(self.action_results()), 2)
        self.assertFalse(self.action_results()[-1]['ok'])
        self.assertFalse(any(payload[0] == 2 for payload in self.writes))

    def test_action_write_failure_is_not_retried_or_reported_successfully(self):
        self.source(0, flags=16)
        self.reply(action='Clear')
        self.dismiss()
        action_reply = self.write_replies[-1]
        self.source(0, uid=43)
        self.error(message='Connection failed after write')
        self.assertFalse(self.action_results()[0]['ok'])
        self.assertEqual(len(self.writes), 3)
        action_reply()  # Late/double callbacks cannot succeed or complete the next read.
        self.assertEqual(len(self.action_results()), 1)
        self.reply(uid=43)
        self.resume()
        self.assertEqual(sum(payload[0] == 2 for payload in self.writes), 1)

    def test_disconnect_fails_current_and_queued_actions_once(self):
        self.source(0, flags=16)
        self.reply(action='Clear')
        self.source(0, uid=43, flags=16)
        self.reply(uid=43, action='Clear')
        self.dismiss()
        self.dismiss(requestId='request-2', uid=43)
        self.scope['property_changed']('org.bluez.Device1', {'Connected': False}, [], path='/phone')
        self.assertEqual(len(self.action_results()), 2)
        self.assertTrue(all(not result['ok'] for result in self.action_results()))
        self.assertEqual(self.client.action_requests, {})
        self.write_replies[-1]()
        self.assertEqual(len(self.action_results()), 2)
        self.assertEqual(sum(payload[0] == 2 for payload in self.writes), 1)

    def test_action_timeout_waits_on_the_same_session_and_late_ack_cannot_succeed(self):
        self.source(0, flags=16)
        self.reply(action='Clear')
        self.dismiss()
        self.source(0, uid=43, flags=16)
        self.dismiss(requestId='request-2', uid=43)
        self.time_out()
        self.assertEqual(self.disconnections, [], 'the iPhone does not reconnect after we drop it')
        self.assertIs(self.scope['clients'].get('phone'), self.client)
        self.assertGreater(self.client.retry_at, time.monotonic() + 30)
        self.assertEqual([result['ok'] for result in self.action_results()], [False, False])
        self.write_replies[-1]()
        self.assertEqual(len(self.action_results()), 2)
        self.resume()
        self.reply(uid=43, action='Clear')
        self.assertEqual(sum(payload[0] == 2 for payload in self.writes), 1, 'an unconfirmed action is never sent again')
        self.assertEqual(self.client.queue, {})

    def test_response_timeout_keeps_the_session_the_queue_and_new_alerts(self):
        session = self.client.session
        self.source(0, uid=1)
        self.reply(uid=1)
        self.source(0, uid=2)
        self.events.clear()
        self.time_out()
        self.assertIs(self.scope['clients'].get('phone'), self.client)
        self.assertEqual(self.client.session, session)
        self.assertEqual(self.statuses(), ['Notification response timed out; retrying'])
        self.assertGreater(self.client.retry_at, time.monotonic() + 30)
        self.reply(uid=2, title='Late fragment')
        self.source(0, uid=3)
        self.source(1, uid=1)
        self.source(2, uid=4)
        self.client.ready = {SOURCE, DATA}
        self.client.tick()
        self.assertEqual(len(self.writes), 2, 'nothing is requested while late fragments can still arrive')
        self.assertEqual([(n['uid'], n['event']) for n in self.notifications()], [(4, 'removed')])
        self.resume()
        self.reply(uid=2, title='Second try')
        self.reply(uid=3)
        self.reply(uid=1, title='Edited')
        self.assertEqual([(n['uid'], n['event'], n['title'], n['session']) for n in self.notifications()[1:]],
                         [(2, 'added', 'Second try', session), (3, 'added', 'Alert', session),
                          (1, 'modified', 'Edited', session)])
        self.assertFalse(any(event['kind'] == 'session' for event in self.events), 'no new session is announced')
        self.assertEqual(self.statuses()[-1], 'Receiving notifications')

    def test_invalid_response_waits_and_fetches_the_alert_again(self):
        self.source(0, uid=1)
        self.source(0, uid=2)
        self.client.data('/data', b'\xff\xff')
        self.assertIs(self.scope['clients'].get('phone'), self.client)
        self.assertEqual(self.statuses(), ['Invalid notification response; retrying'])
        self.assertGreater(self.client.retry_at, time.monotonic() + 30)
        self.assertEqual(len(self.writes), 1)
        self.resume()
        self.reply(uid=2)
        self.reply(uid=1)
        self.assertEqual([(n['uid'], n['event']) for n in self.notifications()], [(2, 'added'), (1, 'added')])

    def test_alert_that_never_answers_is_given_up_after_three_requests(self):
        self.source(0, uid=1)
        self.source(0, uid=2)
        self.time_out()
        self.resume()
        self.reply(uid=2)
        for _ in range(2):
            self.assertIn(1, self.client.pending_added)
            self.time_out()
            self.resume()
        self.assertEqual([struct.unpack_from('<I', payload, 1)[0] for payload in self.writes], [1, 2, 1, 1])
        self.assertNotIn(1, self.client.pending_added)
        self.assertEqual(self.client.queue, {})
        self.assertEqual([n['uid'] for n in self.notifications()], [2])

    def test_probe_follows_the_wait_and_a_failed_subscription_cannot_shorten_it(self):
        self.client.tick()
        self.assertEqual(len(self.subscriptions), 1)
        self.source(0)
        self.client.last_probe = time.monotonic()
        self.time_out()
        wait = self.client.retry_at
        self.subscriptions[0][1](Exception('Not permitted'))
        self.assertEqual(self.client.retry_at, wait)
        self.client.ready = {SOURCE, DATA}
        self.client.authorized = True
        self.resume()
        self.reply()
        self.client.tick()
        self.assertEqual(self.writes[-1], app_request('com.apple.Preferences')[0])

    def test_queued_action_expires_before_delayed_attribute_request_finishes(self):
        self.source(0, flags=16)
        self.reply(action='Clear')
        self.source(0, uid=43)
        self.dismiss()
        next(iter(self.client.queue.values()))['expires'] = 0
        self.client.ready = {SOURCE, DATA}
        self.client.last_probe = time.monotonic()
        self.client.tick()
        self.assertFalse(self.action_results()[0]['ok'])
        self.reply(uid=43)
        self.assertFalse(any(payload[0] == 2 for payload in self.writes))

    def test_repeated_pending_command_does_not_repeat_action(self):
        self.source(0, flags=16)
        self.reply(action='Clear')
        self.dismiss()
        self.dismiss()
        self.assertEqual(sum(payload[0] == 2 for payload in self.writes), 1)
        self.write_replies[-1]()
        self.assertEqual(len(self.action_results()), 1)

    def test_removing_source_rejects_actions_and_invalid_commands_do_not_write(self):
        self.source(0, flags=16)
        self.reply(action='Clear')
        self.dismiss()
        self.scope['handle_command'](json.dumps({'type': 'configure', 'sources': []}))
        self.assertFalse(self.action_results()[0]['ok'])
        for invalid in [True, -1, 0x100000000, '42']:
            self.dismiss(uid=invalid)
            self.assertEqual(self.events[-1]['kind'], 'error')
        self.assertEqual(sum(payload[0] == 2 for payload in self.writes), 1)


if __name__ == '__main__':
    unittest.main()
