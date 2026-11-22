#!/usr/bin/env bash
# Boots a headless GNOME Shell with this extension enabled, drives it with
# dev/drive.js and saves screenshots + the shell log.
#
# Everything runs against throwaway XDG dirs and a private D-Bus session, so
# it never touches your running desktop, your settings or your installed
# extensions.
#
# Usage: dev/headless-test.sh [OUT_DIR]
#   SCENARIO=full|multimonitor|perf   what drive.js does (default: full)
#   MONITORS="1920x1080 1280x720"     virtual monitors, first is primary
#   PACKAGE=dist/....zip              install this zip instead of the source
#   MODE=user                         stock GNOME look instead of Ubuntu's
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
UUID=notch@hoho-san
OUT=$(realpath -m "${1:-$ROOT/dev/out}")
MODE=${MODE:-ubuntu}
SCENARIO=${SCENARIO:-full}
MONITORS=${MONITORS:-1920x1080}
PACKAGE=${PACKAGE:+$(realpath "$PACKAGE")}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP"/{data/gnome-shell/extensions,config,cache,runtime} "$OUT"
chmod 700 "$TMP/runtime"
glib-compile-schemas "$ROOT/$UUID/schemas"
rm -f "$OUT"/*.png "$OUT"/*.log

# A bus that can only auto-start dconf and the shell's notification service
# (which provides org.freedesktop.Notifications). The stock session config
# would also start portals, file indexers, evolution etc. for this throwaway
# session.
mkdir -p "$TMP/services"
for service in ca.desrt.dconf org.gnome.Shell.Notifications; do
    ln -s "/usr/share/dbus-1/services/$service.service" "$TMP/services/"
done
cat >"$TMP/bus.conf" <<EOF
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:dir=$TMP/runtime</listen>
  <auth>EXTERNAL</auth>
  <servicedir>$TMP/services</servicedir>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
EOF

export XDG_DATA_HOME="$TMP/data" XDG_CONFIG_HOME="$TMP/config" \
       XDG_CACHE_HOME="$TMP/cache" XDG_RUNTIME_DIR="$TMP/runtime"
unset WAYLAND_DISPLAY DISPLAY

if [ -n "$PACKAGE" ]; then
    # The real install path: unpacks, and compiles the settings schema.
    gnome-extensions install --force "$PACKAGE"
else
    ln -s "$ROOT/$UUID" "$TMP/data/gnome-shell/extensions/$UUID"
fi

VIRTUAL_MONITORS=""
for size in $MONITORS; do
    VIRTUAL_MONITORS+=" --virtual-monitor $size"
done

export ROOT UUID OUT MODE VIRTUAL_MONITORS
export NOTCH_SCENARIO=$SCENARIO NOTCH_MONITORS=$MONITORS
status=0
dbus-run-session --config-file="$TMP/bus.conf" -- bash -c '
    gsettings set org.gnome.shell enabled-extensions "[\"$UUID\"]"
    gsettings set org.gnome.shell welcome-dialog-last-shown-version "999"

    # A fake battery, up before the shell like the real UPower would be.
    gjs -m "$ROOT/dev/fake-upower.js" >"$OUT/fake-upower.log" 2>&1 &
    upower=$!

    # A private sound server with one fake output, so the volume controls
    # exist. It uses this session'"'"'s runtime dir, never real hardware.
    pipewire -c "$ROOT/dev/pipewire-test.conf" >"$OUT/pipewire.log" 2>&1 &
    pipewire=$!

    NOTCH_UPOWER_BUS=session \
    gnome-shell --headless $VIRTUAL_MONITORS --no-x11 \
        --force-animations --mode="$MODE" --wayland-display=notch-test \
        >"$OUT/shell.log" 2>&1 &
    shell=$!

    status=0
    NOTCH_SHELL_PID=$shell gjs -m "$ROOT/dev/drive.js" "$OUT" "$UUID" || status=$?

    kill "$shell" "$upower" "$pipewire" 2>/dev/null
    wait "$shell" "$upower" "$pipewire" 2>/dev/null
    exit $status
' || status=$?

# Anything the shell logged about this extension is a problem.
if grep -n -E "$UUID|JS ERROR|already disposed" "$OUT/shell.log"; then
    echo "FAIL shell log mentions the extension (above)"
    status=1
else
    echo "PASS shell log is clean"
fi
exit $status
