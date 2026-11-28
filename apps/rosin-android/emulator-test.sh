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
    x, y, r = int(sys.argv[3]), int(sys.argv[4]), im.width // 4
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
# A sharper screen than the emulator's own 320 x 640, so the close-ups of Rosin show detail.
a shell wm size 720x1440; a shell wm density 320
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
# Close-ups: Rosin looks straight ahead, its eye turning toward the middle of the screen, on the right and after a drag.
shot 4b-rosin-right $X $Y
# A liked song playing: the music bar shows under Rosin and the top antennae glow gold.
a shell am start -n $PKG/.MainActivity --es rosin.test_music "'Floating Test Song'"
sleep 4
a shell input keyevent KEYCODE_HOME
sleep 4
shot 4e-music $X $Y
shot 4f-music-whole
echo "---- Rosin's windows with a song on (expect Rosin and the music bar):"
a shell dumpsys window windows | grep -E "Window #.*$PKG" | head -6
# Tapping play/pause on the bar must not stop Rosin (the page answers it; here the test song just stays put).
BY=$(( Y + S / 2 + 30 * D / 160 ))
a shell input tap $X $BY
sleep 2
alive || { echo "!!!! the emulator stopped answering after a tap on the music bar"; finish 1; }
a shell pidof $PKG >/dev/null || { echo "!!!! Rosin stopped after a tap on the music bar"; finish 1; }
sleep 12
shot 4g-music-gone $X $Y
LX=$(( W * 18 / 100 )); LY=$(( H * 25 / 100 ))
a shell input swipe $X $Y $LX $LY 900
sleep 3
shot 4c-rosin-top-left $LX $LY
shot 4d-dragged-left
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
# Close floating Rosin by dropping it on the ✕ that shows at the bottom middle while it's dragged.
a shell input keyevent KEYCODE_HOME
sleep 5
CX=$(( W / 2 )); CY=$(( H - (32 + 72) * D / 160 ))
a shell input swipe $X $Y $CX $CY 1500
sleep 3
shot 6-closed
echo "---- Rosin's windows after dropping it on the close mark (expect none):"
a shell dumpsys window windows | grep -E "Window #" | grep -i "$PKG" | head -10
echo "---- service:"
a shell dumpsys activity services $PKG | grep -E "ServiceRecord|isForeground|foregroundId" | head -5
# A Spotify sign-in that ended in a web browser comes back through rosin://spotify-callback: it should open Rosin.
echo "---- rosin://spotify-callback opens:"
a shell am start -W -a android.intent.action.VIEW -d "'rosin://spotify-callback?state=rosina-emulatortest&error=access_denied'" | grep -E "Status|Activity|Error" | head -4
sleep 3
shot 7-spotify-callback
finish 0
