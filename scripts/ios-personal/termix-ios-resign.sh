#!/bin/zsh
# termix-ios-resign.sh — keep the self-signed Termix iOS build alive.
#
# Free Apple ID provisioning profiles expire after 7 days. Run periodically
# (launchd, see com.datlt4.termix-resign.plist). Each run:
#   1. fetches the newest unsigned build from the ios-dev GitHub pre-release
#      (only when it changed),
#   2. makes sure a com.datlt4.termix provisioning profile with more than
#      MIN_DAYS left exists, asking Xcode to renew it through the "termix"
#      helper project when needed,
#   3. re-signs and re-installs the app over the existing one (app data is
#      kept) when the build or the profile changed since the last install,
#      or the installed profile is about to expire.
# Usage: termix-ios-resign.sh [--force]

set -u
BUNDLE_ID="com.datlt4.termix"
DEVICE_UDID="00008030-001A754C2E91802E"
MIN_DAYS=3
WORK="$HOME/termix-ios"
IPA="$WORK/termix-ios-unsigned.ipa"
STATE="$WORK/state"
LOG="$WORK/resign.log"
RELEASE_API="https://api.github.com/repos/datlt4/Termix-Mobile/releases/tags/ios-dev"
PROFILES="$HOME/Library/MobileDevice/Provisioning Profiles"
FORCE=0; [[ "${1:-}" == "--force" ]] && FORCE=1

mkdir -p "$WORK" "$STATE"
exec >>"$LOG" 2>&1
echo "=== $(date '+%F %T') start (force=$FORCE)"

# --- device ---------------------------------------------------------------
find_device() {
  xcrun devicectl list devices 2>/dev/null | grep -iE "available|connected" | grep -viE "unavailable" |
    grep -i "iPhone" | grep -oE '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}' | head -1
}
DEVICE_ID=$(find_device)
if [[ -z "$DEVICE_ID" ]]; then
  # Over Wi-Fi a paired iPhone stays "unavailable" until something connects
  # to it; poke each known iPhone once, then look again.
  for id in $(xcrun devicectl list devices 2>/dev/null | grep -i "iPhone" |
      grep -oE '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}'); do
    xcrun devicectl device info details --device "$id" --timeout 30 >/dev/null 2>&1
  done
  DEVICE_ID=$(find_device)
fi
if [[ -z "$DEVICE_ID" ]]; then echo "no iPhone reachable (USB or network); skip"; exit 0; fi
echo "device $DEVICE_ID"

# --- newest unsigned build ------------------------------------------------
ASSET=$(curl -fsS "$RELEASE_API" | /usr/bin/python3 -c '
import json,sys
r=json.load(sys.stdin)
a=[x for x in r.get("assets",[]) if x["name"].endswith(".ipa")][0]
print(a["browser_download_url"], a["updated_at"])' 2>/dev/null)
if [[ -n "$ASSET" ]]; then
  URL=${ASSET% *}; STAMP=${ASSET#* }
  if [[ ! -f "$IPA" || "$(cat "$STATE/ipa_stamp" 2>/dev/null)" != "$STAMP" ]]; then
    echo "downloading build $STAMP"
    curl -fsSL -o "$IPA.tmp" "$URL" && mv "$IPA.tmp" "$IPA" && echo "$STAMP" >"$STATE/ipa_stamp"
  fi
fi
[[ -f "$IPA" ]] || { echo "no unsigned IPA yet; skip"; exit 1; }

# --- provisioning profile -------------------------------------------------
best_profile() {  # prints "<path>|<expiry epoch>" of the longest-lived matching profile
  local best="" bestexp=0 f plist app exp
  for f in "$PROFILES"/*.mobileprovision(N); do
    plist=$(security cms -D -i "$f" 2>/dev/null) || continue
    app=$(echo "$plist" | plutil -extract Entitlements.application-identifier raw -o - - 2>/dev/null)
    [[ "$app" == *".$BUNDLE_ID" ]] || continue
    echo "$plist" | grep -q "$DEVICE_UDID" || continue
    exp=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$(echo "$plist" | plutil -extract ExpirationDate raw -o - -)" +%s 2>/dev/null) || continue
    (( exp > bestexp )) && { best="$f"; bestexp=$exp; }
  done
  [[ -n "$best" ]] && echo "$best|$bestexp"
}
NOW=$(date +%s)
P=$(best_profile)
if [[ -z "$P" || $(( ${P#*|} - NOW )) -lt $(( MIN_DAYS * 86400 )) ]]; then
  HELPER=$(find "$HOME/Desktop" "$HOME/Documents" "$HOME/Downloads" "$HOME/termix-ios" -maxdepth 4 -name "termix.xcodeproj" 2>/dev/null | head -1)
  if [[ -z "$HELPER" ]]; then echo "profile expiring and no termix.xcodeproj helper found"; exit 1; fi
  echo "renewing profile via $HELPER"
  xcodebuild -project "$HELPER" -scheme termix -destination "id=$DEVICE_UDID" \
    -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
    -derivedDataPath "$WORK/helper-build" build >"$WORK/helper-build.log" 2>&1 \
    || echo "helper build failed (see helper-build.log); trying with existing profile"
  P=$(best_profile)
fi
[[ -n "$P" ]] || { echo "no usable provisioning profile"; exit 1; }
PROFILE=${P%|*}; PEXP=${P#*|}
echo "profile $(basename "$PROFILE") valid until $(date -r "$PEXP" '+%F %T')"

# --- install only when something changed or expiry is near ----------------
KEY="$(cat "$STATE/ipa_stamp" 2>/dev/null)|$(basename "$PROFILE")"
if [[ $FORCE -eq 0 && "$(cat "$STATE/installed_key" 2>/dev/null)" == "$KEY" ]]; then
  echo "installed app already uses this build and profile; nothing to do"; exit 0
fi

# --- re-sign ---------------------------------------------------------------
IDENTITY=$(security find-identity -v -p codesigning | grep "Apple Development" | head -1 | awk '{print $2}')
[[ -n "$IDENTITY" ]] || { echo "no Apple Development signing identity"; exit 1; }
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
unzip -q "$IPA" -d "$TMP"
APP=$(echo "$TMP"/Payload/*.app)
security cms -D -i "$PROFILE" >"$TMP/profile.plist"
plutil -extract Entitlements xml1 -o "$TMP/ent.plist" "$TMP/profile.plist"
cp "$PROFILE" "$APP/embedded.mobileprovision"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE_ID" "$APP/Info.plist"
# Nested code first (frameworks, dylibs, extensions), then the app itself.
find "$APP" -depth \( -name "*.framework" -o -name "*.dylib" -o -name "*.appex" \) -print0 |
  while IFS= read -r -d '' item; do
    codesign --force --sign "$IDENTITY" --timestamp=none "$item" || echo "warn: codesign $item"
  done
codesign --force --sign "$IDENTITY" --timestamp=none --entitlements "$TMP/ent.plist" "$APP" || { echo "codesign app failed"; exit 1; }
codesign --verify --deep --strict "$APP" && echo "signature ok"

# --- install over the existing app (keeps its data) -----------------------
if xcrun devicectl device install app --device "$DEVICE_ID" "$APP"; then
  echo "$KEY" >"$STATE/installed_key"
  echo "installed; valid until $(date -r "$PEXP" '+%F %T')"
else
  echo "install failed"; exit 1
fi
