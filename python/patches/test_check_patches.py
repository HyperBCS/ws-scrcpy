"""The patch check: its marker list against the patch scripts, and against the installed helper."""
import importlib.util
from pathlib import Path
import re
import shutil
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
spec = importlib.util.spec_from_file_location('check_patches', HERE / 'check_patches.py')
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)
native_paths = list((ROOT / 'python/venv/lib').glob('python*/site-packages/pymobiledevice3/remote/core_device/screen_stream.py'))


class MarkerListTests(unittest.TestCase):
    def test_every_marker_a_patch_script_writes_is_checked(self):
        listed = [marker for markers in check.MARKERS.values() for marker in markers]
        scripts = sorted(HERE.glob('pymobiledevice3-*.py'))
        self.assertGreaterEqual(len(scripts), 4)
        for script in scripts:
            written = set(re.findall(r'''=\s*['"]((?:# )?ws-scrcpy [a-z0-9 ]+)['"]''', script.read_text()))
            self.assertTrue(written, f'{script.name} defines no marker')
            for marker in written:
                # A later version of a marker ("... v2") stands in for the one it replaced.
                self.assertTrue(any(item.startswith(marker) for item in listed),
                                f'{marker!r} from {script.name} is not in check_patches.MARKERS')

    def test_every_copied_module_is_compared(self):
        for script in HERE.glob('pymobiledevice3-*.py'):
            for original, installed in re.findall(r"with_name\('(\w+\.py)'\), \w+\.with_name\('(\w+\.py)'\)",
                                                  script.read_text()):
                self.assertEqual(check.COPIES.get(installed), original)


class MissingPatchesTests(unittest.TestCase):
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix='ws-scrcpy-patch-check-'))
        self.addCleanup(shutil.rmtree, self.directory, ignore_errors=True)
        for name, markers in check.MARKERS.items():
            (self.directory / name).write_text('\n'.join(markers) + '\n')
        for installed, original in check.COPIES.items():
            shutil.copyfile(HERE / original, self.directory / installed)

    def test_a_fully_patched_install_has_nothing_missing(self):
        self.assertEqual(check.missing_patches(self.directory), [])

    def test_each_absent_marker_is_named(self):
        stream = self.directory / 'screen_stream.py'
        stream.write_text(stream.read_text().replace('# ws-scrcpy button completion\n', '')
                          .replace('# ws-scrcpy early stop\n', ''))
        self.assertEqual(check.missing_patches(self.directory), ['button completion', 'early stop'])

    def test_an_unpatched_or_absent_file_is_reported(self):
        (self.directory / 'screen_stream.py').write_text('class WebRtcScreenStreamServer:\n    pass\n')
        (self.directory / 'hid_service.py').unlink()
        missing = check.missing_patches(self.directory)
        self.assertEqual(len(missing), len(check.MARKERS['screen_stream.py']) + 1)
        self.assertIn('hid_service.py not found', missing)

    def test_a_copied_module_that_differs_from_the_repository_is_reported(self):
        (self.directory / 'ws_scrcpy_keyboard.py').write_text('# an older copy\n')
        (self.directory / 'ws_scrcpy_multitouch.py').unlink()
        self.assertEqual(check.missing_patches(self.directory), ['current keyboard.py', 'current multitouch.py'])

    def test_an_interpreter_without_the_package_says_so_instead_of_naming_patches(self):
        with mock.patch.object(check.importlib.util, 'find_spec', return_value=None):
            self.assertEqual(check.check(), {'version': None, 'found': False, 'missing': []})

    def test_the_pinned_version_is_read_from_requirements(self):
        self.assertRegex(check.pinned_version(ROOT / 'python/requirements.txt'), r'^\d+\.\d+\.\d+$')
        self.assertIsNone(check.pinned_version(self.directory / 'requirements.txt'))


@unittest.skipUnless(native_paths, 'Requires the setup:ios source installation')
class InstalledHelperTests(unittest.TestCase):
    def test_the_installed_helper_carries_every_patch(self):
        missing = check.missing_patches(native_paths[0].parent)
        self.assertEqual(missing, [], 'python/venv is behind python/patches. Run "npm run patch:ios".')


if __name__ == '__main__':
    unittest.main()
