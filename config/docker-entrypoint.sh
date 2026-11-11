#!/bin/sh
# Starts the server as the unprivileged `node` user.
#
# The container starts as root for one job: the data volume of an existing installation belongs to
# root, and the server has to own it to keep its settings, keys and notification history. Once the
# volume is handed over, root is given up for good and the command runs as `node`. The groups
# Docker added with `group_add` (the host's bluetooth group) are kept.
#
# Started with `user:` set in compose, there is nothing to hand over and nothing to give up.
set -eu

RUN_AS="${WS_SCRCPY_USER:-node}"
DATA_DIR="${WS_NOTIFICATION_DATA:-/app/data}"

if [ "$(id -u)" != "0" ]; then
    exec "$@"
fi

mkdir -p "$DATA_DIR"
chown -R "$RUN_AS:$RUN_AS" "$DATA_DIR"

# pymobiledevice3 and npm keep their caches under the home directory.
HOME="$(getent passwd "$RUN_AS" | cut -d: -f6)"
export HOME

exec setpriv --reuid="$RUN_AS" --regid="$RUN_AS" --keep-groups -- "$@"
