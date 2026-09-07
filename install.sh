#!/bin/bash
set -euo pipefail

[[ "$(uname -s)" == Darwin ]] || { echo "This installer requires macOS." >&2; exit 1; }
extension_id="${1:-nfpnjhfbdogjiafeiioapfdnfaboehkh}"
[[ $# -le 1 && "$extension_id" =~ ^[a-p]{32}$ ]] || {
  echo "Usage: ./install.sh [32-character Chrome extension ID]" >&2
  exit 1
}
source_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
install_dir="$HOME/Library/Application Support/I Know It"
host_path="$install_dir/i-know-it-host"
host_name=com.iknowit.bridge
browser_dirs=(
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  "$HOME/Library/Application Support/Google/ChromeForTesting/NativeMessagingHosts"
)
[[ -f "$source_dir/native/main.swift" ]] || { echo "Missing native/main.swift." >&2; exit 1; }
/usr/bin/xcrun --find swiftc >/dev/null
[[ ! -L "$install_dir" && ! -L "$host_path" ]] || { echo "Refusing to replace a symbolic link." >&2; exit 1; }
registered=false
for directory in "${browser_dirs[@]}"; do
  manifest="$directory/$host_name.json"
  [[ ! -L "$directory" && ! -L "$manifest" ]] || { echo "Refusing to replace a symbolic link: $manifest" >&2; exit 1; }
  if [[ -e "$manifest" ]]; then
    [[ "$(/usr/bin/plutil -extract name raw -o - "$manifest" 2>/dev/null || true)" == "$host_name" &&
       "$(/usr/bin/plutil -extract path raw -o - "$manifest" 2>/dev/null || true)" == "$host_path" ]] || {
      echo "A different native host already owns $manifest" >&2
      exit 1
    }
    registered=true
  fi
done
if [[ -e "$host_path" && "$registered" == false ]]; then
  echo "An unregistered file already exists at $host_path; leaving it untouched." >&2
  exit 1
fi

umask 077
mkdir -p "$install_dir"
chmod 700 "$install_dir"
build_dir="$(mktemp -d "$install_dir/.build.XXXXXX")"
manifest_temp=""
cleanup() {
  for file in "$build_dir/i-know-it-host" "$build_dir/manifest.json" "$manifest_temp"; do
    [[ ! -f "$file" ]] || rm -- "$file"
  done
  rmdir -- "$build_dir" 2>/dev/null || true
}
trap cleanup EXIT
/usr/bin/xcrun swiftc "$source_dir/native/main.swift" -o "$build_dir/i-know-it-host"
chmod 755 "$build_dir/i-know-it-host"
/usr/bin/plutil -create xml1 "$build_dir/manifest.json"
/usr/bin/plutil -insert name -string "$host_name" "$build_dir/manifest.json"
/usr/bin/plutil -insert description -string "I Know It! screenshot context bridge" "$build_dir/manifest.json"
/usr/bin/plutil -insert path -string "$host_path" "$build_dir/manifest.json"
/usr/bin/plutil -insert type -string stdio "$build_dir/manifest.json"
/usr/bin/plutil -insert allowed_origins -json "[\"chrome-extension://$extension_id/\"]" "$build_dir/manifest.json"
/usr/bin/plutil -convert json "$build_dir/manifest.json"
for directory in "${browser_dirs[@]}"; do
  mkdir -p "$directory"
  chmod 700 "$directory"
  manifest_temp="$(mktemp "$directory/.i-know-it.XXXXXX")"
  cp "$build_dir/manifest.json" "$manifest_temp"
  chmod 600 "$manifest_temp"
  mv -f -- "$manifest_temp" "$directory/$host_name.json"
  manifest_temp=""
done
mv -f -- "$build_dir/i-know-it-host" "$host_path"

echo "Installed I Know It! for Chrome and Chrome for Testing."
echo "One-time setup: open chrome://extensions, enable Developer mode, and load this folder unpacked:"
echo "$source_dir"
echo "If it is already loaded, reload the extension. Use its switch to enable or disable screenshot context."
echo "No background service or screenshot shortcut was installed."
