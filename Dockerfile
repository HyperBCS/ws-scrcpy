# ws-scrcpy with BOTH platforms: Android via adb, iOS via pymobiledevice3.
#
# Device access comes from the HOST daemons -- the adb server on 127.0.0.1:5037 and
# usbmuxd on /var/run/usbmuxd -- so this image needs no `privileged`, no /dev/bus/usb
# and no NET_ADMIN. The iOS userspace tunnel needs no capabilities either
# (see src/server/appl-device/services/PyMobileDevice.ts). Run it with host
# networking; docker-compose.yml explains why.
FROM node:22-bookworm-slim AS base
WORKDIR /app

FROM base AS builder
# python3-venv/make/g++ are for node-gyp and for `npm run setup:ios`.
RUN apt-get update && apt-get install -y --no-install-recommends \
        git python3 python3-venv make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY python ./python
RUN npm run setup:ios
COPY . .
RUN npm run dist && npm prune --omit=dev --ignore-scripts
# The iOS toolchain: venv + python/patches/pymobiledevice3-raw-audio.py. Stock
# pymobiledevice3 cannot decode the phone's AAC-ELD audio off macOS; the patch is
# what makes serve-web hand us raw audio instead. Built at /app so the venv's
# absolute shebangs stay valid in the runner, which also uses /app.

FROM base AS runner
# adb: Device.ts and RemoteShell.ts spawn the client for `adb shell`. It talks to the host's adb
# server; nothing here starts one (src/server/goog-device/adb/index.ts). python3: the venv
# symlinks to it. ffmpeg: CoreDeviceAudio.ts spawns it to decode the phone's AAC-ELD audio.
RUN apt-get update && apt-get install -y --no-install-recommends \
        adb python3 python3-dbus python3-gi ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/dist /app/dist
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/python /app/python
# The server runs as `node`, not root: the entrypoint hands the data volume over and drops root.
COPY config/docker-entrypoint.sh /usr/local/bin/ws-scrcpy-entrypoint
RUN chmod 755 /usr/local/bin/ws-scrcpy-entrypoint \
    && mkdir -p /app/data && chown node:node /app/data
# Server dist; `resolveBin()` walks cwd and its parent, finding /app/python/venv.
WORKDIR /app/dist
ENTRYPOINT ["ws-scrcpy-entrypoint"]
CMD ["node", "index.js"]
