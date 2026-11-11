"""The lock probe's caption reading, without pymobiledevice3 or a phone."""
import importlib.util
import os
from pathlib import Path
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('lockstate', Path(__file__).with_name('lockstate.py'))
lockstate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lockstate)


class DecideTests(unittest.TestCase):
    def test_padlock_and_keypad_captions_mean_locked(self):
        for caption in ('Locked', ' locked ', 'Enter Passcode'):
            self.assertIs(lockstate._decide(caption), True, caption)

    def test_unlocked_padlock_is_not_read_as_locked(self):
        # Face ID has recognised the owner; the caption contains "locked".
        self.assertIs(lockstate._decide('Unlocked'), False)

    def test_other_captions_containing_the_word_decide_nothing(self):
        for caption in ('Blocked Contacts', 'Locked Notes', 'Screen Time, Unlocked apps', 'Safari', ''):
            self.assertIsNone(lockstate._decide(caption), caption)

    def test_localized_captions_from_the_server_are_whole_matches_too(self):
        with mock.patch.dict(os.environ, {'IOS_LOCKED_CAPTIONS': 'Gesperrt, Code eingeben'}):
            self.assertIs(lockstate._decide('gesperrt'), True)
            self.assertIs(lockstate._decide('Code eingeben'), True)
            self.assertIsNone(lockstate._decide('Entsperrt'))
            self.assertIsNone(lockstate._decide('Nicht gesperrt'))


if __name__ == '__main__':
    unittest.main()
