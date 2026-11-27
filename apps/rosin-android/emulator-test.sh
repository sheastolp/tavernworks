#!/usr/bin/env bash
# Run by .github/workflows/rosin-apps.yml on an Android emulator: installs the APK, opens Rosin, leaves the
# app so Rosin floats over the home screen, shows a test line in the speech bubble, taps Rosin, and prints
# small screenshots into the log (between ROSIN-SHOT lines, base64 JPEG) plus any crash.
set -u
APK=$(ls apk/*.apk | head -1)
PKG=dev.tavernworks.rosin
shot() {
  adb exec-out screencap -p > "shot-$1.png"
  if command -v convert >/dev/null; then convert "shot-$1.png" -resize 360x -quality 60 "shot-$1.jpg"
  else ffmpeg -loglevel error -y -i "shot-$1.png" -vf scale=360:-1 -q:v 8 "shot-$1.jpg"; fi
  echo "ROSIN-SHOT-BEGIN $1"; base64 -w 0 "shot-$1.jpg"; echo; echo "ROSIN-SHOT-END $1"
}
adb install -r "$APK"
adb shell appops set $PKG SYSTEM_ALERT_WINDOW allow
adb shell pm grant $PKG android.permission.POST_NOTIFICATIONS || true
adb logcat -c
adb shell am start -n $PKG/.MainActivity
sleep 35
shot 1-app
adb shell input keyevent KEYCODE_HOME
sleep 8
shot 2-home
adb shell am start -n $PKG/.MainActivity --es rosin.test_say "Hey, it's me. Rosin. I'm floating over your home screen now, and this is my speech bubble."
sleep 4
adb shell input keyevent KEYCODE_HOME
sleep 5
shot 3-bubble
sleep 18
shot 4-bubble-gone
# Tap Rosin where it starts: right edge, a bit below the middle.
read W H < <(adb shell wm size | tail -1 | sed 's/.*: //; s/x/ /')
D=$(adb shell wm density | tail -1 | sed 's/.*: //')
S=$(( 118 * D / 160 )); M=$(( 8 * D / 160 ))
X=$(( W - M - S / 2 )); Y=$(( H * 55 / 100 + S / 2 ))
echo "screen ${W}x${H} density $D, tapping Rosin at $X,$Y"
adb shell input tap $X $Y
sleep 4
shot 5-after-tap
echo "---- resumed activity after tapping Rosin:"
adb shell dumpsys activity activities | grep -E "topResumedActivity|mResumedActivity" | head -3
echo "---- Rosin's windows:"
adb shell dumpsys window windows | grep -E "Window #|mOwnerUid|ty=" | grep -B1 -A1 -i "$PKG" | head -20
echo "---- service:"
adb shell dumpsys activity services $PKG | grep -E "ServiceRecord|isForeground|foregroundId" | head -5
echo "---- crashes and Rosin log lines:"
adb logcat -d | grep -E "AndroidRuntime|FATAL|$PKG|Rosin|chromium.*Console" | tail -60
