"""Exercise the collector state machine without importing BlueZ or opening D-Bus."""
import ast
from collections import deque
import json
from pathlib import Path
import struct
import time
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
        test = self

        class DBus:
            Array = staticmethod(lambda value, **kwargs: value)
            Dictionary = staticmethod(lambda value, **kwargs: value)
            DBusException = Exception

        class Interface:
            def WriteValue(self, payload, options, reply_handler, error_handler):
                test.writes.append(payload)
                test.write_errors.append(error_handler)
                test.write_replies.append(reply_handler)

            def Disconnect(self, **kwargs):
                test.disconnections.append(True)

        # Import only Client: the module's executable section owns a live system
        # bus and GLib loop. The class itself runs against these controlled stubs.
        tree = ast.parse(Path(__file__).with_name('collector.py').read_text())
        declarations = [node for node in tree.body if
                        isinstance(node, (ast.ClassDef, ast.FunctionDef)) and
                        node.name in ('Client', 'property_changed', 'handle_command')]
        self.scope = {
            'time': time, 'uuid': uuid, 'struct': struct, 'deque': deque, 'json': json,
            'ANCS': ANCS, 'SOURCE': SOURCE, 'DATA': DATA, 'CONTROL': CONTROL,
            'AttributeResponse': AttributeResponse, 'notification_request': notification_request,
            'app_request': app_request, 'negative_action_request': negative_action_request,
            'clients': {}, 'sources': {'AA:BB:CC:DD:EE:FF': 'phone'}, 'dbus': DBus,
            'objects': {}, 'owned_notifications': set(),
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

    def test_action_timeout_reconnects_and_late_ack_cannot_succeed(self):
        self.source(0, flags=16)
        self.reply(action='Clear')
        self.dismiss()
        parser, done, _, job = self.client.current
        self.client.current = (parser, done, 0, job)
        self.client.tick()
        self.assertEqual(self.disconnections, [True])
        self.assertFalse(self.action_results()[0]['ok'])
        self.write_replies[-1]()
        self.assertEqual(len(self.action_results()), 1)

    def test_queued_action_expires_before_delayed_attribute_request_finishes(self):
        self.source(0, flags=16)
        self.reply(action='Clear')
        self.source(0, uid=43)
        self.dismiss()
        self.client.queue[0]['expires'] = 0
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
