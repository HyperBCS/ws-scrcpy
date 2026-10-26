"""CoreDevice 58-byte mainTouchscreen report, up to five identified contacts.

Wire layout verified by jkcoxson/idevice PR #119; encoded independently here.
Every frame includes active fingers and an explicit release before reusing an ID.
"""
import struct
import time


def build_report(contacts, timestamp=None):
    if not isinstance(contacts, list) or not 1 <= len(contacts) <= 5:
        raise ValueError('Expected one to five contacts')
    report = bytearray(58)
    report[:3] = bytes((9, len(contacts), 5))
    report[40] = 2
    stamp = time.monotonic_ns() if timestamp is None else timestamp
    report[44:50] = (stamp & ((1 << 48) - 1)).to_bytes(6, 'little')
    seen = set()
    for slot, contact in enumerate(contacts):
        identity, x, y = contact['id'], contact['x'], contact['y']
        touching = contact['touching']
        if (type(identity) is not int or identity not in range(5) or identity in seen
                or type(x) is not int or type(y) is not int or not 0 <= x <= 65535
                or not 0 <= y <= 65535 or type(touching) is not bool):
            raise ValueError('Invalid contact')
        seen.add(identity)
        struct.pack_into('<BHH', report, 3 + slot * 5, identity | (0xC0 if touching else 0), x, y)
    return bytes(report)
