#!/bin/bash
set -euo pipefail

[[ "$(uname -s)" == Darwin ]] || { echo "This uninstaller requires macOS." >&2; exit 1; }
[[ $# == 0 ]] || { echo "Usage: ./uninstall.sh" >&2; exit 1; }
install_dir="$HOME/Library/Application Support/I Know It"
host_path="$install_dir/i-know-it-host"
receipt_path="$install_dir/install-receipt.json"
host_name=com.iknowit.bridge
removed=false
for directory in \
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Google/ChromeForTesting/NativeMessagingHosts"; do
  manifest="$directory/$host_name.json"
  [[ -e "$manifest" || -L "$manifest" ]] || continue
  if [[ ! -L "$directory" && ! -L "$manifest" &&
        "$(/usr/bin/plutil -extract name raw -o - "$manifest" 2>/dev/null || true)" == "$host_name" &&
        "$(/usr/bin/plutil -extract path raw -o - "$manifest" 2>/dev/null || true)" == "$host_path" ]]; then
    rm -- "$manifest"
    removed=true
  else
    echo "Leaving an unrecognized registration untouched: $manifest" >&2
  fi
done
if [[ "$removed" == true && ! -L "$install_dir" && ! -L "$host_path" && -f "$host_path" ]]; then
  rm -- "$host_path"
elif [[ -e "$host_path" || -L "$host_path" ]]; then
  echo "Leaving an unrecognized host file untouched: $host_path" >&2
fi
if [[ ! -L "$install_dir" && ! -L "$receipt_path" && -f "$receipt_path" &&
      "$(/usr/bin/plutil -extract format raw -o - "$receipt_path" 2>/dev/null || true)" == 1 &&
      "$(/usr/bin/plutil -extract name raw -o - "$receipt_path" 2>/dev/null || true)" == "$host_name" &&
      "$(/usr/bin/plutil -extract path raw -o - "$receipt_path" 2>/dev/null || true)" == "$host_path" ]]; then
  rm -- "$receipt_path"
elif [[ -e "$receipt_path" || -L "$receipt_path" ]]; then
  echo "Leaving an unrecognized installation receipt untouched: $receipt_path" >&2
fi
echo "Matching I Know It! registrations were removed. Saved screenshots and context files were retained."
echo "Disable or remove the extension in chrome://extensions to close any existing connection."
