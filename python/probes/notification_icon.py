#!/usr/bin/env python3
"""Read one installed app's PNG icon from the paired USB iPhone to stdout."""

import asyncio
import logging
import re
import sys

MAX_BYTES = 1024 * 1024


async def icon(source: str, bundle: str) -> bytes:
    from pymobiledevice3.lockdown import create_using_usbmux
    from pymobiledevice3.services.springboard import SpringBoardServicesService

    # Validate existing trust, but never trigger a new pairing prompt for an icon.
    async with await create_using_usbmux(serial=source, connection_type="USB", autopair=False) as lockdown:
        async with SpringBoardServicesService(lockdown) as springboard:
            png = await springboard.get_icon_pngdata(bundle)
            if not isinstance(png, bytes) or not png.startswith(b"\x89PNG\r\n\x1a\n") or len(png) > MAX_BYTES:
                raise ValueError("Icon unavailable")
            return png


if __name__ == "__main__":
    logging.disable(logging.CRITICAL)
    try:
        if len(sys.argv) != 3:
            raise ValueError("Invalid arguments")
        source, bundle = sys.argv[1:]
        if not re.fullmatch(r"[\w-]{1,128}", source, flags=re.ASCII):
            raise ValueError("Invalid source")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,255}", bundle):
            raise ValueError("Invalid app")
        sys.stdout.buffer.write(asyncio.run(asyncio.wait_for(icon(source, bundle), timeout=6)))
    except Exception:
        # Never write a device response, pairing record, or identifier to logs.
        print("Notification icon unavailable", file=sys.stderr)
        sys.exit(1)
