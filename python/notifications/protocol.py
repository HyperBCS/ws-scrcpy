"""ANCS framing; independent of Bluetooth, so fragmentation can be tested offline."""
import struct

ANCS = '7905f431-b5ce-4e99-a40f-4b1e122d00d0'
SOURCE = '9fbf120d-6301-42d9-8c58-25e699a21dbd'
CONTROL = '69d1d8f3-45e1-49a8-9821-9bbdfdaad9d9'
DATA = '22eac6e9-24d6-4bb5-be44-b36ace7c7bfb'


def notification_request(uid, negative_action=False):
    prefix = b'\0' + struct.pack('<I', uid)
    payload, attributes = prefix + b'\0\1\0\1\2\0\1\3\0\4\5', [0, 1, 2, 3, 5]
    # Action labels have no length argument, unlike title/subtitle/message.
    if negative_action:
        payload += b'\7'
        attributes.append(7)
    return payload, prefix, attributes


def negative_action_request(uid):
    if type(uid) is not int or not 0 <= uid <= 0xffffffff:
        raise ValueError('Invalid notification identifier')
    # ANCS command 2 has no Data Source response: its ATT write is the ACK.
    return b'\2' + struct.pack('<I', uid) + b'\1'


def app_request(app):
    prefix = b'\1' + app.encode('utf-8') + b'\0'
    return prefix + b'\0', prefix, [0]


class AttributeResponse:
    def __init__(self, prefix, attributes):
        self.prefix = prefix
        self.attributes = attributes
        self.buffer = bytearray()

    def feed(self, fragment):
        self.buffer.extend(fragment)
        if len(self.buffer) > 8192:
            raise ValueError('ANCS response exceeds limit')
        n = min(len(self.buffer), len(self.prefix))
        if self.buffer[:n] != self.prefix[:n]:
            raise ValueError('Unexpected ANCS response')
        if len(self.buffer) < len(self.prefix):
            return None
        pos = len(self.prefix)
        values = {}
        for expected in self.attributes:
            if pos + 3 > len(self.buffer):
                return None
            attr, length = struct.unpack_from('<BH', self.buffer, pos)
            if attr != expected or length > 4096:
                raise ValueError('Invalid ANCS attribute')
            pos += 3
            if pos + length > len(self.buffer):
                return None
            values[attr] = bytes(self.buffer[pos:pos + length]).decode('utf-8', 'replace')
            pos += length
        if pos != len(self.buffer):
            raise ValueError('Unexpected ANCS trailing bytes')
        return values
