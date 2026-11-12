#!/bin/sh
# Starts the server as the unprivileged `node` user.
#
# The container starts as root for one job: the data volume of an existing installation belongs to
# root, and the server has to own it to keep its settings, keys and notification history. Once the
# volume is handed over, root is given up for good and the command runs as `node`. The groups
# Docker added with `group_add` (the host's bluetooth group) are kept; root's own group 0 is not.
#
# Started with `user:` set in compose, there is nothing to hand over and nothing to give up.
set -eu

RUN_AS="${WS_SCRCPY_USER:-node}"
DATA_DIR="${WS_DATA_DIR:-${WS_NOTIFICATION_DATA:-/app/data}}"

if [ "$(id -u)" != "0" ]; then
    exec "$@"
fi

mkdir -p "$DATA_DIR"
chown -R "$RUN_AS:$RUN_AS" "$DATA_DIR"

# pymobiledevice3 and npm keep their caches under the home directory.
HOME="$(getent passwd "$RUN_AS" | cut -d: -f6)"
export HOME

# Docker lists the primary group 0 among root's supplementary groups. Keeping it would leave the
# server in the root group.
KEPT_GROUPS=""
for gid in $(id -G); do
    if [ "$gid" != "0" ]; then
        KEPT_GROUPS="${KEPT_GROUPS:+$KEPT_GROUPS,}$gid"
    fi
done

if [ -n "$KEPT_GROUPS" ]; then
    exec setpriv --reuid="$RUN_AS" --regid="$RUN_AS" --groups="$KEPT_GROUPS" -- "$@"
fi
exec setpriv --reuid="$RUN_AS" --regid="$RUN_AS" --clear-groups -- "$@"
