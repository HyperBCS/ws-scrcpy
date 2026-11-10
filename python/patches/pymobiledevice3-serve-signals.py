"""Idempotent: serve-web takes SIGTERM in order from the start. Pinned to python/requirements.txt.

Stock serve() runs its preflight (up to 25 s, which starts the phone's video and audio) and binds
HTTP before it installs its SIGINT and SIGTERM handlers. A SIGTERM before that ends the process at
once, with no stop_all_streams, and the phone keeps both media sessions until its RTCP timeout
reclaims them about 20 s later: the same as a SIGKILL. A burst of those wedges the phone's display
service until a reboot (docs/HANDOFF.md). This patch installs the handlers at the top of serve().
A stop requested during the preflight then runs the normal shutdown once the preflight is over.
"""
import importlib.util
from pathlib import Path

MARKER = '# ws-scrcpy early stop'

PREFLIGHT = '''        # Any other start failure is non-fatal: serve anyway and bring the
        # stream up lazily; a wedged device just delays the warm start.
        try:
            await asyncio.wait_for(self._eager_stream_start(), timeout=25.0)
'''

HANDLERS = '''        # Install signal handlers so Ctrl-C / SIGTERM trigger an
        # orderly, fast shutdown instead of waiting for blocked RPCs.
        # On Windows add_signal_handler isn't supported -- fall back to
        # the default KeyboardInterrupt-raising behaviour.
        loop = asyncio.get_running_loop()
        stop_event = asyncio.Event()

        def _request_stop():
            if not stop_event.is_set():
                logger.info("shutting down...")
                stop_event.set()

        for signame in ("SIGINT", "SIGTERM"):
            with contextlib.suppress(NotImplementedError, AttributeError):
                import signal

                loop.add_signal_handler(getattr(signal, signame), _request_stop)

'''

EARLY_HANDLERS = f'''        {MARKER}: the handlers below are installed before the preflight,
        # not after the HTTP bind. A SIGTERM during the preflight used to end the process with no
        # cleanup, leaving the phone's video and audio sessions allocated. Now it sets stop_event,
        # the preflight finishes, and the shutdown in the finally block below returns them.
''' + HANDLERS


def replace_once(source, old, new):
    if source.count(old) != 1:
        raise RuntimeError('The installed pymobiledevice3 differs from the supported version')
    return source.replace(old, new)


def patch_stream(source):
    if MARKER in source:
        return source
    # Order matters: the handler block is taken out of its late position first, then put in
    # front of the preflight, so each replacement sees exactly one copy.
    source = replace_once(source, HANDLERS, '')
    return replace_once(source, PREFLIGHT, PREFLIGHT.replace('        try:\n', EARLY_HANDLERS + '        try:\n', 1))


def main():
    spec = importlib.util.find_spec('pymobiledevice3.remote.core_device.screen_stream')
    stream = Path(spec.origin)
    source = patch_stream(stream.read_text())
    compile(source, str(stream), 'exec')
    stream.write_text(source)
    print('serve-web early stop patch ready')


if __name__ == '__main__':
    main()
