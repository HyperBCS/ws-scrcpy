#!/usr/bin/env python3
"""
Reads whether an iPhone is on its lock screen, without drawing anything on its screen.

iOS exposes no lock-state API over USB (CoreDevice's `getlockstate` action answers "not
implemented" on iOS 27), so this asks the accessibility audit daemon what is on screen: the lock
screen carries a padlock captioned "Locked"/"Unlocked" and the passcode keypad "Enter Passcode".

Why not `pymobiledevice3 developer accessibility list-items`, which reads the same elements:

- it leaves the inspector's on-device overlay enabled, so the phone draws a green highlight box
  around every element the walk visits -- a light show on the screen on each probe;
- it turns on foreground-app monitoring, which makes the daemon attach to whatever app is open;
- it walks the whole screen, which on a busy app is dozens of focus moves.

This turns the overlay off first (`deviceInspectorShowVisuals:` and `deviceEnableHighlight:`),
never enables app monitoring, and stops at the first caption that settles the question -- on a
lock screen, usually the first element.

Pinned to pymobiledevice3 11.12.5, like python/patches/: it uses a few private members of
`AccessibilityAudit` because the public `iter_elements()` is the thing whose side effects are
the problem. If a future version breaks this, the caller degrades to "lock state unknown", which
hides the Locked badge but leaves the screen/sleep detection (a different service) working.

Output on stdout, one JSON object:

    {"locked": true|false|null, "captions": ["...", ...], "monitored": false}

`locked` is null when nothing recognisable was on screen; the caller decides what that means in
the phone's language. Exits non-zero with a one-line reason on stderr if the device could not be
reached.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys

# Captions that settle the question on an English phone. The caller applies its own (possibly
# localized) table to `captions`; these only decide when to stop walking early.
LOCKED_MARKERS = ["locked", "enter passcode"]
UNLOCKED_MARKERS = ["unlocked"]
# A lock screen has ~5 focusable elements and the decisive one comes first. The bound is what
# keeps a probe of a busy app short; past it the caller gets the captions seen so far.
MAX_ELEMENTS = 24
# Per focus-move wait. The daemon answers in well under a second on a reachable device.
EVENT_TIMEOUT_S = 1.5
# Whole-probe bound, including bringing the tunnel up.
WALK_TIMEOUT_S = 20.0


def _markers() -> tuple[list[str], list[str]]:
    """Locked markers, plus any the server passes for a non-English phone."""
    extra = [
        caption.strip().lower()
        for caption in (os.environ.get("IOS_LOCKED_CAPTIONS") or "").split(",")
        if caption.strip()
    ]
    return LOCKED_MARKERS + extra, UNLOCKED_MARKERS


def _decide(caption: str) -> bool | None:
    locked_markers, unlocked_markers = _markers()
    lowered = caption.strip().lower()
    if not lowered:
        return None
    if any(marker == lowered or marker in lowered for marker in locked_markers):
        return True
    if any(marker == lowered for marker in unlocked_markers):
        return False
    return None


async def _hide_overlay(audit) -> None:
    """Turn the inspector's on-device highlight off, both knobs, before any focus moves."""
    for selector, value in (("deviceInspectorShowVisuals:", 0), ("deviceEnableHighlight:", 0)):
        try:
            await audit._invoke(selector, value, expects_reply=False)
        except Exception:
            # An iOS version without one of them still gets the other.
            pass
    # The toggle is applied asynchronously; without this the first element can still flash.
    await asyncio.sleep(0.2)


async def _walk(audit) -> list[str]:
    """
    Focus each element in turn and collect its caption, stopping at the first decisive one.

    Deliberately does not call `deviceSetAppMonitoringEnabled:` (which `iter_elements()` does):
    verified on iOS 27 that focus events arrive without it, and not attaching to the foreground
    app is one less thing this probe does to a phone somebody is using.
    """
    from pymobiledevice3.services.accessibilityaudit import Direction, Event, deserialize_object

    await audit._ensure_ready()
    await audit.set_monitored_event_type()
    await audit.move_focus(Direction.Next)
    captions: list[str] = []
    seen: set[str] = set()
    while len(captions) < MAX_ELEMENTS:
        try:
            name, args = await asyncio.wait_for(audit._event_queue.get(), timeout=EVENT_TIMEOUT_S)
        except asyncio.TimeoutError:
            break
        payload = audit._extract_event_payload(args)
        if payload is None:
            continue
        event = Event(name=name, data=deserialize_object(payload))
        if event.name != "hostInspectorCurrentElementChanged:":
            continue
        elements = event.data if isinstance(event.data, list) else [event.data]
        decided = False
        for element in elements:
            caption = (getattr(element, "caption", None) or "").strip()
            if not caption:
                continue
            captions.append(caption)
            if _decide(caption) is not None:
                decided = True
        if decided:
            break
        # A short screen loops the focus back to where it started; stop rather than spin.
        if captions and captions[-1] in seen:
            break
        if captions:
            seen.add(captions[-1])
        await audit.move_focus(Direction.Next)
    return captions


async def read_lock_state(serial: str) -> dict:
    from pymobiledevice3.remote.userspace_tunnel import establish_userspace_rsd
    from pymobiledevice3.services.accessibilityaudit import AccessibilityAudit

    rsd = await establish_userspace_rsd(serial=serial)
    async with AccessibilityAudit(rsd) as audit:
        await _hide_overlay(audit)
        captions = await _walk(audit)
        monitored = False
        if not captions:
            # No focus events at all. Some iOS versions may only drive the inspector while the
            # daemon is monitoring the foreground app, so try once more with that on rather than
            # reporting "unknown" for the rest of the session.
            await audit.set_app_monitoring_enabled(True)
            monitored = True
            captions = await _walk(audit)
    locked = None
    for caption in captions:
        decision = _decide(caption)
        if decision is not None:
            locked = decision
            break
    return {"locked": locked, "captions": captions, "monitored": monitored}


async def main() -> int:
    serial = os.environ.get("PYMOBILEDEVICE3_UDID")
    if not serial:
        print("PYMOBILEDEVICE3_UDID is not set", file=sys.stderr)
        return 2
    try:
        result = await asyncio.wait_for(read_lock_state(serial), timeout=WALK_TIMEOUT_S)
    except asyncio.TimeoutError:
        # A screen with nothing focusable is not an error: say "could not tell" and let the
        # caller keep whatever it knew before.
        result = {"locked": None, "captions": [], "monitored": False}
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
