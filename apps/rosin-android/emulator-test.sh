#!/usr/bin/env bash
# Run by .github/workflows/rosin-apps.yml on an Android emulator: installs the APK, opens Rosin, leaves the
# app so Rosin floats over the home screen, shows a test line in the speech bubble, taps Rosin, and prints
# small screenshots into the log (between ROSIN-SHOT lines, base64 JPEG) plus any crash.
set -u
APK=$(ls apk/*.apk | head -1)
PKG=dev.tavernworks.rosin
a() { timeout 60 adb "$@"; }
alive() { [ "$(timeout 10 adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; }
finish() {
  echo "---- last log lines before the end:"
  grep -E "AndroidRuntime|FATAL|DEBUG|$PKG|Rosin|chromium|lowmemorykiller|ActivityManager: (Kill|Process)" logcat.txt | tail -80
  echo "---- emulator memory:"; a shell cat /proc/meminfo | head -3
  exit "$1"
}
# shot NAME [X Y]: the whole screen, small; with X Y (pixels), a close-up around that point instead.
shot() {
  if ! alive; then echo "!!!! the emulator stopped answering before shot $1"; finish 1; fi
  a shell screencap -p /data/local/tmp/s.png && a pull -q /data/local/tmp/s.png "shot-$1.png" >/dev/null
  python3 - "shot-$1.png" "shot-$1.jpg" "${2:-}" "${3:-}" <<'PY'
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert("RGB")
if sys.argv[3]:
    x, y, r = int(sys.argv[3]), int(sys.argv[4]), im.width // 5
    im = im.crop((max(0, x - r), max(0, y - r), min(im.width, x + r), min(im.height, y + r)))
    im.thumbnail((420, 420))
else:
    im.thumbnail((300, 700))
im.save(sys.argv[2], quality=55)
PY
  echo "ROSIN-SHOT-BEGIN $1"; base64 -w 0 "shot-$1.jpg"; echo; echo "ROSIN-SHOT-END $1"
}
adb logcat -c
(adb logcat -v time > logcat.txt 2>&1 &)
a install -r "$APK"
a shell appops set $PKG SYSTEM_ALERT_WINDOW allow
a shell pm grant $PKG android.permission.POST_NOTIFICATIONS 2>/dev/null || true
a shell am start -n $PKG/.MainActivity
for i in 1 2 3 4 5 6; do sleep 5; alive || { echo "!!!! emulator lost ${i}x5 s after opening Rosin"; finish 1; }; done
sleep 10
shot 1-app
a shell input keyevent KEYCODE_HOME
sleep 8
shot 2-home
# adb shell splits words again on the phone, so the line goes in its own single quotes.
a shell am start -n $PKG/.MainActivity --es rosin.test_say "'Hey, it is me, Rosin. I am floating over your home screen now, and this is my speech bubble.'"
sleep 4
a shell input keyevent KEYCODE_HOME
sleep 5
shot 3-bubble
sleep 18
shot 4-bubble-gone
# Rosin starts at the right edge, a bit below the middle.
read W H < <(a shell wm size | tail -1 | tr -d '\r' | sed 's/.*: //; s/x/ /')
D=$(a shell wm density | tail -1 | tr -d '\r' | sed 's/.*: //')
S=$(( 128 * D / 160 )); M=$(( 8 * D / 160 ))
X=$(( W - M - S / 2 )); Y=$(( H * 55 / 100 + S / 2 ))
# Close-ups: Rosin should face the middle of the screen (to the left here), then up and to the right after a drag.
shot 4b-rosin-right $X $Y
LX=$(( W * 18 / 100 )); LY=$(( H * 25 / 100 ))
a shell input swipe $X $Y $LX $LY 900
sleep 3
shot 4c-rosin-top-left $LX $LY
a shell input swipe $LX $LY $X $Y 900
sleep 3
echo "screen ${W}x${H} density $D, tapping Rosin at $X,$Y"
a shell input tap $X $Y
sleep 4
shot 5-after-tap
echo "---- resumed activity after tapping Rosin:"
a shell dumpsys activity activities | grep -E "topResumedActivity|mResumedActivity" | head -3
echo "---- Rosin's windows:"
a shell dumpsys window windows | grep -E "Window #" | grep -i "$PKG" | head -10
echo "---- service:"
a shell dumpsys activity services $PKG | grep -E "ServiceRecord|isForeground|foregroundId" | head -5
finish 0
