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
LABEL maintainer="Vitaly Repin <vitaly.repin@gmail.com>"
# adb: AdbUtils.ts spawns the binary for `forward --remove`, so the client must exist
# even though adbkit speaks the protocol itself. python3: the venv symlinks to it.
# ffmpeg: CoreDeviceAudio.ts:307 spawns it to decode the phone's AAC-ELD audio.
RUN apt-get update && apt-get install -y --no-install-recommends \
        adb python3 python3-dbus python3-gi ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/dist /app/dist
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/python /app/python
# Server dist; `resolveBin()` walks cwd and its parent, finding /app/python/venv.
WORKDIR /app/dist
CMD ["node", "index.js"]
