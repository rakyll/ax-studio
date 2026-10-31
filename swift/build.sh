#!/bin/zsh
# Builds "AX Studio.app" into ./build. Requires only the Xcode Command Line Tools.
#
#   ./build.sh            # build
#   ./build.sh --install  # build and copy to /Applications
#   ./build.sh --run      # build and launch
set -euo pipefail
cd "$(dirname "$0")"

APP="build/AX Studio.app"
AX_REPO="${AX_REPO:-$HOME/ax}"

echo "==> Compiling (release)"
swift build -c release
BIN="$(swift build -c release --show-bin-path)/AXStudio"

echo "==> Assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/AXStudio"
cp Resources/Info.plist "$APP/Contents/Info.plist"

# App icon: the AX axolotl on a rounded tile.
if [[ ! -f Resources/AppIcon.icns ]]; then
  echo "==> Rendering app icon"
  swift scripts/make-icon.swift "$AX_REPO/assets/axel.svg" Resources/AppIcon.icns
fi
cp Resources/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
echo "==> Built $APP"

case "${1:-}" in
  --install)
    rm -rf "/Applications/AX Studio.app"
    cp -R "$APP" /Applications/
    echo "==> Installed to /Applications/AX Studio.app"
    ;;
  --run)
    open "$APP"
    ;;
esac
