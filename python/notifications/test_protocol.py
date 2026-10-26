import struct
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'patches'))
from protocol import AttributeResponse, notification_request, app_request, negative_action_request
from multitouch import build_report


class ProtocolTests(unittest.TestCase):
    def test_every_fragment_boundary_and_utf8(self):
        _, prefix, attrs = notification_request(0x12345678)
        values = {0: 'com.example.app', 1: 'Hello 👋', 2: '', 3: '日本語 message', 5: '20261025T120000'}
        response = prefix + b''.join(struct.pack('<BH', a, len(values[a].encode())) + values[a].encode() for a in attrs)
        for split in range(1, len(response)):
            parser = AttributeResponse(prefix, attrs)
            self.assertIsNone(parser.feed(response[:split]))
            self.assertEqual(parser.feed(response[split:]), values)
        parser = AttributeResponse(prefix, attrs)
        for byte in response[:-1]: self.assertIsNone(parser.feed(bytes([byte])))
        self.assertEqual(parser.feed(response[-1:]), values)

    def test_command_encoding_and_empty_app_attribute(self):
        request, prefix, attrs = notification_request(1)
        self.assertEqual(request.hex(), '00010000000001000102000103000405')
        request, prefix, attrs = app_request('com.apple.Preferences')
        self.assertEqual(request, b'\1com.apple.Preferences\0\0')
        self.assertEqual(AttributeResponse(prefix, attrs).feed(prefix + b'\0\0\0'), {0: ''})

    def test_negative_action_label_and_command_encoding(self):
        request, prefix, attrs = notification_request(0x12345678, negative_action=True)
        self.assertEqual(attrs, [0, 1, 2, 3, 5, 7])
        self.assertEqual(request.hex(), '0078563412000100010200010300040507')
        values = {0: 'com.apple.mobilephone', 1: 'Incoming call', 2: '', 3: '', 5: '', 7: 'Decline'}
        response = prefix + b''.join(struct.pack('<BH', a, len(values[a].encode())) + values[a].encode() for a in attrs)
        parser = AttributeResponse(prefix, attrs)
        self.assertIsNone(parser.feed(response[:-3]))
        self.assertEqual(parser.feed(response[-3:]), values)
        self.assertEqual(negative_action_request(0x12345678), bytes.fromhex('027856341201'))
        for invalid in (-1, 0x100000000, True, 1.5, '42'):
            with self.assertRaises(ValueError): negative_action_request(invalid)

    def test_bad_headers_sizes_order_and_trailing_bytes(self):
        _, prefix, attrs = app_request('a')
        for response in [b'\0', prefix + b'\1\0\0', prefix + b'\0\1\x10', prefix + b'\0\0\0x', b'x' * 8193]:
            with self.assertRaises(ValueError): AttributeResponse(prefix, attrs).feed(response)

    def test_five_finger_wire_layout_and_releases(self):
        contacts = [dict(id=i, touching=i != 2, x=1000 + i, y=65000 - i) for i in range(5)]
        report = build_report(contacts, 0x010203040506)
        self.assertEqual(len(report), 58)
        self.assertEqual(report[:3], b'\x09\x05\x05')
        for i in range(5):
            self.assertEqual(struct.unpack_from('<BHH', report, 3 + 5*i), (i | (0 if i == 2 else 0xc0), 1000+i, 65000-i))
        self.assertEqual(report[40], 2)
        self.assertEqual(report[44:50], bytes.fromhex('060504030201'))
        released = build_report([dict(c, touching=False) for c in contacts])
        self.assertEqual([released[3+5*i] for i in range(5)], list(range(5)))

    def test_invalid_contacts(self):
        valid = dict(id=0, touching=True, x=0, y=65535)
        for contacts in [[], [valid]*6, [valid, valid], [dict(valid, id=5)], [dict(valid, x=-1)], [dict(valid, y=1.5)], [dict(valid, touching=1)], [dict(valid, id=True)]]:
            with self.assertRaises(ValueError): build_report(contacts)


if __name__ == '__main__': unittest.main()
