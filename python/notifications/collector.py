#!/usr/bin/env python3
"""BlueZ ANCS collector. JSON commands on stdin, JSON events on stdout.

Run with the system Python (python3-dbus/python3-gi). Bluetooth is owned by the
host daemon; this process never creates a competing bluetoothd or deletes bonds.
"""
import json
import os
import signal
import sys
import time
import uuid
import struct
from collections import deque
import dbus
import dbus.service
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib
from protocol import ANCS, SOURCE, DATA, CONTROL, AttributeResponse, notification_request, app_request, negative_action_request

DBusGMainLoop(set_as_default=True)
bus = dbus.SystemBus()
loop = GLib.MainLoop()
sources = {}
clients = {}
objects = {}
pair_until = 0
pair_attempts = {}
confirmation = None
advert_ready = False
advert_pending = False
owned_notifications = set()
input_buffer = bytearray()
AGENT = '/org/wsscrcpy/agent'
ADVERT = '/org/wsscrcpy/advert'
ADAPTER = '/org/bluez/hci0'


def emit(kind, **values):
    print(json.dumps({'kind': kind, **values}, ensure_ascii=False), flush=True)


def iface(path, name):
    return dbus.Interface(bus.get_object('org.bluez', path), name)


class Rejected(dbus.DBusException):
    _dbus_error_name = 'org.bluez.Error.Rejected'


class Agent(dbus.service.Object):
    @dbus.service.method('org.bluez.Agent1', in_signature='ou', out_signature='', async_callbacks=('reply', 'error'))
    def RequestConfirmation(self, device, passkey, reply, error):
        global confirmation
        if time.monotonic() > pair_until or confirmation:
            error(Rejected('Pairing window closed')); return
        address = str(objects.get(str(device), {}).get('org.bluez.Device1', {}).get('Address', ''))
        confirmation = (address, f'{int(passkey):06d}', reply, error, time.monotonic() + 40)
        emit('pairing', address=address, code=confirmation[1])

    @dbus.service.method('org.bluez.Agent1', in_signature='', out_signature='')
    def Cancel(self):
        global confirmation
        confirmation = None
        emit('pairing', address='', code='')

    @dbus.service.method('org.bluez.Agent1', in_signature='', out_signature='')
    def Release(self): pass

    @dbus.service.method('org.bluez.Agent1', in_signature='o', out_signature='')
    def RequestAuthorization(self, device): raise Rejected('Confirm the numeric pairing code')

    @dbus.service.method('org.bluez.Agent1', in_signature='os', out_signature='')
    def AuthorizeService(self, device, service): raise Rejected('Only ANCS is requested')


class Advertisement(dbus.service.Object):
    @dbus.service.method('org.freedesktop.DBus.Properties', in_signature='s', out_signature='a{sv}')
    def GetAll(self, interface):
        return {'Type': dbus.String('peripheral'), 'LocalName': dbus.String('ws-scrcpy'),
                'SolicitUUIDs': dbus.Array([ANCS], signature='s'), 'Discoverable': dbus.Boolean(True)}

    @dbus.service.method('org.bluez.LEAdvertisement1', in_signature='', out_signature='')
    def Release(self):
        global advert_ready, advert_pending
        advert_ready = advert_pending = False


class Client:
    def __init__(self, path, source, chars):
        self.path, self.source, self.chars = path, source, chars
        self.session = uuid.uuid4().hex
        self.ready, self.pending = set(), set()
        self.queue, self.current = deque(), None
        self.revisions, self.apps = {}, {}
        self.active_notifications = {}
        self.action_requests = {}
        self.revision = 0
        # An Added event can be superseded before its attributes/app name arrive.
        # Keep its initial flag until the newest revision is actually published.
        self.pending_added = {}
        self.last_probe, self.retry_at, self.authorized = 0, 0, False
        self.last_status = ''
        emit('session', source=self.source, session=self.session)

    def alive(self): return clients.get(self.source) is self

    def status(self, status):
        if status != self.last_status:
            self.last_status = status
            emit('status', source=self.source, status=status)

    def reset(self, reason):
        if not self.alive(): return
        self.fail_actions('Bluetooth disconnected before the iPhone confirmed the action')
        self.status(reason)
        clients.pop(self.source, None)
        # A timed-out fragmented response has no cancellation command. Reconnect to
        # establish a new session instead of mixing late fragments into the next request.
        iface(self.path, 'org.bluez.Device1').Disconnect(reply_handler=lambda: None, error_handler=lambda e: None)

    def fail_actions(self, reason):
        for complete in list(self.action_requests.values()): complete(False, reason)

    def dismiss(self, command):
        request_id = command['requestId']
        uid = command['uid']
        fields = dict(requestId=request_id, source=command['source'], session=command['session'], uid=uid)
        if request_id in self.action_requests:
            return  # Do not perform the same pending command twice.
        state = self.active_notifications.get(uid)
        if (not self.alive() or self.source not in sources.values() or command['source'] != self.source or
                command['session'] != self.session):
            emit('action-result', **fields, ok=False, error='This notification is from an earlier Bluetooth connection')
            return
        if not state or not state['canDismiss'] or not state.get('negativeActionLabel'):
            emit('action-result', **fields, ok=False, error='This notification no longer offers that iPhone action')
            return
        if command.get('expectedLabel', state['negativeActionLabel']) != state['negativeActionLabel']:
            emit('action-result', **fields, ok=False, error='The iPhone action changed; refresh notifications and try again')
            return
        completed = False
        def complete(ok, error=''):
            nonlocal completed
            if completed: return
            completed = True
            self.action_requests.pop(request_id, None)
            emit('action-result', **fields, ok=ok, **({'error': error} if error else {}))
        self.action_requests[request_id] = complete
        def valid():
            return (not completed and self.alive() and self.source in sources.values() and
                    self.active_notifications.get(uid) is state and state['canDismiss'])
        self.enqueue((negative_action_request(uid), None, None), lambda _: complete(True), valid=valid,
                     action_failed=lambda reason: complete(False, reason))

    def enqueue(self, request, done, failed=None, valid=None, action_failed=None):
        if len(self.queue) >= 128:
            if action_failed: action_failed('Bluetooth is busy; the action was not sent')
            self.reset('Notification queue overflow; reconnecting'); return
        self.queue.append(dict(request=request, done=done, failed=failed, valid=valid, attempts=0,
                               action_failed=action_failed, expires=time.monotonic() + 10))
        self.pump()

    def pump(self):
        if not self.alive() or self.current or not self.queue or time.monotonic() < self.retry_at: return
        while self.queue:
            job = self.queue.popleft()
            expired = bool(job['action_failed'] and time.monotonic() > job['expires'])
            if not expired and (not job['valid'] or job['valid']()): break
            if job['action_failed']:
                job['action_failed']('The notification changed or Bluetooth was busy; the action was not sent')
        else: return
        payload, prefix, attrs = job['request']
        job['attempts'] += 1
        parser = None if job['action_failed'] else AttributeResponse(prefix, attrs)
        deadline = min(time.monotonic() + 10, job['expires']) if job['action_failed'] else time.monotonic() + 10
        self.current = (parser, job['done'], deadline, job)
        def accepted():
            if not job['action_failed'] or not self.alive() or not self.current or self.current[3] is not job: return
            self.current = None
            job['done']({})
            self.pump()
        def failed(error):
            if not self.alive() or not self.current or self.current[3] is not job: return
            self.current = None
            # Action writes must never be retried automatically: a lost ACK may
            # follow a successful action, and its effect can be more than dismissal.
            if job['action_failed']:
                job['action_failed']('The iPhone did not confirm the action; check the phone before trying again')
                self.pump(); return
            if job['valid'] and not job['valid']():
                self.pump(); return
            name = getattr(error, 'get_dbus_name', lambda: '')()
            detail = str(error).lower()
            permission = name.endswith(('.NotPermitted', '.NotAuthorized')) or any(
                text in detail for text in ('notpermitted', 'notauthorized', 'insufficient authentication',
                                           'insufficient authorization', 'insufficient encryption',
                                           '0x05', '0x08', '0x0f'))
            # ANCS A0-A3 errors have no Data Source response and are definitive;
            # A2 includes a UID/app which no longer exists (Apple ANCS spec).
            terminal = name.endswith(('.NotSupported', '.InvalidArguments', '.DoesNotExist')) or any(
                code in detail for code in ('0xa0', '0xa1', '0xa2', '0xa3'))
            if permission:
                self.authorized = False
                self.retry_at = time.monotonic() + 10
                self.status('Allow notification sharing in the iPhone Bluetooth settings')
            if not terminal and job['attempts'] < 3 and len(self.queue) < 128:
                self.queue.append(job)  # Other UIDs keep their place ahead of this retry.
                if not permission:
                    self.retry_at = time.monotonic() + 2 ** job['attempts']
                    self.status('Retrying notification request')
            elif job['failed']:
                job['failed']()
            self.pump()
        try:
            iface(self.chars[CONTROL], 'org.bluez.GattCharacteristic1').WriteValue(
                dbus.Array(payload, signature='y'), dbus.Dictionary({'type': 'request'}, signature='sv'),
                reply_handler=accepted, error_handler=failed)
        except dbus.DBusException as error:
            failed(error)

    def tick(self):
        if not self.alive(): return
        now = time.monotonic()
        for job in list(self.queue):
            if job['action_failed'] and now > job['expires']:
                self.queue.remove(job)
                job['action_failed']('Bluetooth was busy; the action was not sent')
        if self.current and now > self.current[2]:
            self.reset('Notification response timed out; reconnecting'); return
        if now < self.retry_at: return
        for characteristic in [DATA, SOURCE]:
            if characteristic == SOURCE and DATA not in self.ready: break
            if (self.chars[characteristic] in owned_notifications and
                    objects.get(self.chars[characteristic], {}).get('org.bluez.GattCharacteristic1', {}).get('Notifying')):
                self.ready.add(characteristic)
            if characteristic not in self.ready and characteristic not in self.pending:
                self.pending.add(characteristic)
                def ok(characteristic=characteristic):
                    if self.alive():
                        self.pending.discard(characteristic); self.ready.add(characteristic)
                        owned_notifications.add(self.chars[characteristic])
                def failed(error, characteristic=characteristic):
                    if self.alive():
                        self.pending.discard(characteristic); self.retry_at = time.monotonic() + 5
                        self.status('Waiting for Bluetooth notification permission')
                iface(self.chars[characteristic], 'org.bluez.GattCharacteristic1').StartNotify(reply_handler=ok, error_handler=failed)
        if len(self.ready) == 2 and not self.current and not self.queue and now - self.last_probe > (60 if self.authorized else 10):
            self.last_probe = now
            def probed(values):
                self.authorized = True; self.status('Receiving notifications')
            self.enqueue(app_request('com.apple.Preferences'), probed)
        self.pump()

    def data(self, path, value):
        if path == self.chars[DATA]:
            if not self.current or self.current[0] is None: return
            try: values = self.current[0].feed(value)
            except ValueError:
                self.reset('Invalid notification response; reconnecting'); return
            if values is not None:
                done = self.current[1]; self.current = None
                self.authorized = True; self.status('Receiving notifications')
                done(values); self.pump()
        elif path == self.chars[SOURCE] and len(value) == 8:
            event, flags, category, count, uid = struct.unpack('<BBBBI', value)
            if event not in (0, 1, 2): return
            self.revision += 1
            revision = self.revision
            self.revisions[uid] = revision
            if event != 2:
                self.active_notifications[uid] = dict(canDismiss=bool(flags & 16))
            else:
                self.active_notifications.pop(uid, None)
            if event == 0: self.pending_added.setdefault(uid, bool(flags & 4))
            if len(self.revisions) > 512:
                evicted = next(iter(self.revisions))
                self.revisions.pop(evicted)
                self.pending_added.pop(evicted, None)
                self.active_notifications.pop(evicted, None)
            common = dict(source=self.source, session=self.session, uid=uid, preExisting=bool(flags & 4),
                          event=['added', 'modified', 'removed'][event])
            if event == 2:
                self.pending_added.pop(uid, None)
                emit('notification', **common); return
            def valid(): return self.alive() and self.revisions.get(uid) == revision
            def unavailable():
                if valid(): self.pending_added.pop(uid, None)
            def fetched(attrs):
                if not valid(): return
                app = attrs.get(0, '')
                if not app:
                    unavailable(); return
                def publish(name):
                    if valid():
                        label = attrs.get(7, '') if flags & 16 else ''
                        self.active_notifications[uid]['negativeActionLabel'] = label
                        published = dict(common)
                        if uid in self.pending_added:
                            published.update(event='added', preExisting=self.pending_added.pop(uid))
                        emit('notification', **published, app=app, appName=name, title=attrs.get(1, ''),
                             subtitle=attrs.get(2, ''), body=attrs.get(3, ''), date=attrs.get(5, ''),
                             canDismiss=bool(flags & 16), negativeActionLabel=label)
                if app in self.apps: publish(self.apps[app])
                else:
                    def named(values):
                        if len(self.apps) >= 256: self.apps.clear()
                        self.apps[app] = values.get(0) or app
                        publish(self.apps[app])
                    self.enqueue(app_request(app), named, failed=lambda: named({}), valid=valid)
            self.enqueue(notification_request(uid, bool(flags & 16)), fetched, failed=unavailable, valid=valid)


def property_changed(interface, changes, invalidated, path=None):
    if interface == 'org.bluez.GattCharacteristic1' and 'Value' in changes:
        for client in list(clients.values()):
            if str(path).startswith(client.path + '/'): client.data(str(path), bytes(changes['Value']))
    elif interface == 'org.bluez.Device1' and changes.get('Connected') is not None and not changes['Connected']:
        for source, client in list(clients.items()):
            if client.path == str(path):
                client.fail_actions('Bluetooth disconnected before the iPhone confirmed the action')
                client.status('Bluetooth disconnected; waiting for iPhone')
                clients.pop(source, None)


def tick():
    global objects, advert_ready, advert_pending, confirmation
    try:
        objects = iface('/', 'org.freedesktop.DBus.ObjectManager').GetManagedObjects(timeout=5)
        desired_advert = bool(sources) or time.monotonic() < pair_until
        if desired_advert and not advert_ready and not advert_pending:
            advert_pending = True
            def ready():
                global advert_ready, advert_pending
                advert_ready = True; advert_pending = False
            def failed(error):
                global advert_pending
                advert_pending = False
                emit('error', message='Bluetooth advertising unavailable: ' + str(error))
            iface(ADAPTER, 'org.bluez.LEAdvertisingManager1').RegisterAdvertisement(ADVERT, {}, reply_handler=ready, error_handler=failed)
        elif not desired_advert and advert_ready:
            iface(ADAPTER, 'org.bluez.LEAdvertisingManager1').UnregisterAdvertisement(ADVERT)
            advert_ready = False
        devices = []
        for path, interfaces in objects.items():
            props = interfaces.get('org.bluez.Device1')
            if not props or ANCS not in props.get('UUIDs', []): continue
            address = str(props['Address']).upper()
            devices.append(dict(address=address, name=str(props.get('Name', 'iPhone')),
                                paired=bool(props.get('Paired')), connected=bool(props.get('Connected'))))
            if not props.get('Paired') and props.get('Connected') and time.monotonic() < pair_until:
                if time.monotonic() - pair_attempts.get(address, 0) > 60:
                    pair_attempts[address] = time.monotonic()
                    iface(path, 'org.bluez.Device1').Pair(reply_handler=lambda: None,
                        error_handler=lambda e: emit('error', message='Pairing failed: ' + str(e)))
            source = sources.get(address)
            if not source or not props.get('Connected') or not props.get('Paired'): continue
            chars = {str(v['org.bluez.GattCharacteristic1']['UUID']): str(p) for p, v in objects.items()
                     if str(p).startswith(str(path) + '/') and 'org.bluez.GattCharacteristic1' in v}
            if not all(c in chars for c in (DATA, SOURCE, CONTROL)): continue
            if source not in clients:
                clients[source] = Client(str(path), source, chars)
                clients[source].status('Authorizing notifications')
        emit('devices', devices=devices, pairingOpen=time.monotonic() < pair_until)
        for client in list(clients.values()): client.tick()
        if confirmation and time.monotonic() > confirmation[4]:
            confirmation[3](Rejected('Confirmation timed out')); confirmation = None
            emit('pairing', address='', code='')
    except dbus.DBusException as error:
        emit('error', message='Bluetooth unavailable: ' + str(error))
        loop.quit()  # Parent restarts us; registrations are rebuilt after a daemon restart.
        return False
    return True


def handle_command(line):
    global sources, pair_until, confirmation
    try:
        command = json.loads(line)
        if command['type'] == 'configure':
            sources = {s['address'].upper(): s['id'] for s in command.get('sources', [])}
            for key in list(clients):
                if key not in sources.values():
                    clients[key].fail_actions('This iPhone was removed from notification setup')
                    clients.pop(key, None)
        elif command['type'] == 'pair': pair_until = time.monotonic() + 120
        elif command['type'] == 'confirm' and confirmation:
            if (command.get('address'), command.get('code')) == confirmation[:2]:
                confirmation[2](); confirmation = None
                emit('pairing', address='', code='')
        elif command['type'] == 'dismiss':
            if (any(not isinstance(command.get(field), str) or not 0 < len(command[field]) <= 128
                    for field in ('requestId', 'source', 'session')) or
                    type(command.get('uid')) is not int or not 0 <= command['uid'] <= 0xffffffff):
                raise ValueError('Invalid action command')
            client = clients.get(command['source'])
            if client:
                client.dismiss(command)
            else:
                emit('action-result', **{key: command[key] for key in ('requestId', 'source', 'session', 'uid')},
                     ok=False, error='This iPhone is not connected to Bluetooth')
    except (ValueError, KeyError, TypeError): emit('error', message='Invalid collector command')
    return True


def command_input(source, condition):
    chunk = os.read(sys.stdin.fileno(), 8192)
    if not chunk: loop.quit(); return False
    input_buffer.extend(chunk)
    if len(input_buffer) > 65536: loop.quit(); return False
    while b'\n' in input_buffer:
        line, _, tail = input_buffer.partition(b'\n')
        input_buffer[:] = tail
        handle_command(line)
    return True


agent = Agent(bus, AGENT)
advert = Advertisement(bus, ADVERT)
try:
    manager = iface('/org/bluez', 'org.bluez.AgentManager1')
    manager.RegisterAgent(AGENT, 'DisplayYesNo')
    manager.RequestDefaultAgent(AGENT)
    bus.add_signal_receiver(property_changed, bus_name='org.bluez', dbus_interface='org.freedesktop.DBus.Properties',
                            signal_name='PropertiesChanged', path_keyword='path')
    GLib.io_add_watch(sys.stdin, GLib.IO_IN | GLib.IO_HUP, command_input)
    GLib.timeout_add_seconds(2, tick)
    signal.signal(signal.SIGTERM, lambda *_: loop.quit())
    signal.signal(signal.SIGINT, lambda *_: loop.quit())
    tick(); loop.run()
finally:
    for client in list(clients.values()):
        client.fail_actions('Bluetooth collector stopped before the iPhone confirmed the action')
    try: iface(ADAPTER, 'org.bluez.LEAdvertisingManager1').UnregisterAdvertisement(ADVERT)
    except dbus.DBusException: pass
    try: iface('/org/bluez', 'org.bluez.AgentManager1').UnregisterAgent(AGENT)
    except dbus.DBusException: pass
