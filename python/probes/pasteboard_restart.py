#!/usr/bin/env python3
"""
Restarts the iPhone's CoreDevice pasteboard daemon (`dtpasteboardd`).

Why this exists: `dtpasteboardd` -- the Developer-Disk-Image daemon behind
`com.apple.coredevice.pasteboardservice`, which is the only way to read an iPhone's clipboard over
USB -- can stop answering. It keeps accepting connections and still rejects a malformed request in
a few milliseconds, but a well-formed PULL (read) or SET (write) gets no reply at all, for ever.
Measured on an iPhone 13 Pro Max / iOS 27: a valid read produced *zero* bytes back over 12 s while
a deliberately malformed one was refused in 6 ms on the same channel.

What is *not* the cause (all tested on hardware, 2026-09-16): serve-web, the screen session, the
RSD tunnel, lock/sleep state, the pasteboard's contents, and `pasted` (the system pasteboard
daemon), which stays perfectly healthy throughout -- Cmd+C/Cmd+V on the phone itself keep working
while every read over USB hangs. Restarting serve-web or the whole session does nothing, because a
fresh serve-web talks to the same wedged daemon.

Killing `dtpasteboardd` fixes it instantly: launchd starts a new one for the next connection, and
that one answers in ~40 ms with the clipboard contents intact (`pasted` holds the data, so nothing
is lost). SIGKILL rather than SIGTERM because the daemon is, by definition, stuck.

Output on stdout, one JSON object:

    {"restarted": true, "pids": [651]}

`restarted` is false when no such daemon was running, which is not an error: launchd starts it on
demand, so there was nothing to kill and the clipboard's trouble lies elsewhere. Exits non-zero
with a one-line reason on stderr if the device could not be reached.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys

DAEMON = "dtpasteboardd"
SIGKILL = 9
# Bringing the tunnel up takes well under a second on USB; the two CoreDevice round-trips are
# milliseconds. The bound only has to be shorter than the caller's patience.
RESTART_TIMEOUT_S = 25.0


async def restart_pasteboard_daemon(serial: str) -> dict:
    from pymobiledevice3.remote.core_device.app_service import AppServiceService
    from pymobiledevice3.remote.userspace_tunnel import establish_userspace_rsd

    rsd = await establish_userspace_rsd(serial=serial)
    async with AppServiceService(rsd) as app:
        processes = await app.list_processes()
    pids = []
    for process in processes:
        url = str((process.get("executableURL") or {}).get("relative", ""))
        if url.rsplit("/", 1)[-1] == DAEMON:
            pids.append(int(process["processIdentifier"]))
    for pid in pids:
        # A fresh connection per request on purpose: the app service closes the channel under us
        # when a signal follows a listing on the same one (seen as "0 bytes read on a total of 9").
        async with AppServiceService(rsd) as app:
            await app.send_signal_to_process(pid, SIGKILL)
    return {"restarted": bool(pids), "pids": pids}


async def main() -> int:
    serial = os.environ.get("PYMOBILEDEVICE3_UDID")
    if not serial:
        print("PYMOBILEDEVICE3_UDID is not set", file=sys.stderr)
        return 2
    try:
        result = await asyncio.wait_for(restart_pasteboard_daemon(serial), timeout=RESTART_TIMEOUT_S)
    except asyncio.TimeoutError:
        print(f"Timed out restarting {DAEMON}", file=sys.stderr)
        return 1
    except Exception as error:  # noqa: BLE001 - the message is what the server logs
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        sys.exit(130)
