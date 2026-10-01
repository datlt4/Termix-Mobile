# Self-signed iOS build (free Apple ID)

The Mac (macOS 13, Xcode 15.2) cannot build React Native 0.81, so the device
build is made unsigned by `.github/workflows/ios-personal.yml` (push to
`ios-build`, or run it manually) and published to the `ios-dev` pre-release.
`termix-ios-resign.sh` re-signs it with the free Apple ID in Xcode and
installs it over the existing app, so app data is kept.

Free provisioning profiles last 7 days. The LaunchAgent runs the script every
6 hours and at login. It renews the profile through the `termix` helper project
(`~/Desktop/termix`, bundle id `com.datlt4.termix`, Personal Team) once fewer
than 3 days are left, and it picks up new `ios-dev` builds automatically.

Setup on the Mac:

    mkdir -p ~/termix-ios
    cp termix-ios-resign.sh ~/termix-ios/ && chmod +x ~/termix-ios/termix-ios-resign.sh
    cp com.datlt4.termix-resign.plist ~/Library/LaunchAgents/
    launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.datlt4.termix-resign.plist

Requirements: logged in on the Mac (codesign uses the login keychain), and the
iPhone paired with Xcode and reachable over USB or Wi-Fi. Log:
`~/termix-ios/resign.log`. Force a re-sign: `termix-ios-resign.sh --force`.
