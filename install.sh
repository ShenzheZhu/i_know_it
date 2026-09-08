#!/bin/bash
set -euo pipefail

[[ "$(uname -s)" == Darwin ]] || { echo "This installer requires macOS." >&2; exit 1; }
extension_id="${1-nfpnjhfbdogjiafeiioapfdnfaboehkh}"
[[ $# -le 1 && "$extension_id" =~ ^[a-p]{32}$ ]] || {
  echo "Usage: ./install.sh [32-character Chrome extension ID]" >&2
  exit 1
}
source_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
install_dir="$HOME/Library/Application Support/I Know It"
host_path="$install_dir/i-know-it-host"
receipt_path="$install_dir/install-receipt.json"
host_name=com.iknowit.bridge
browser_dirs=(
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  "$HOME/Library/Application Support/Google/ChromeForTesting/NativeMessagingHosts"
)
[[ -f "$source_dir/native/main.swift" ]] || { echo "Missing native/main.swift." >&2; exit 1; }
compiler_path="$(/usr/bin/xcrun --find swiftc)"
[[ ! -L "$install_dir" && ! -L "$host_path" && ! -L "$receipt_path" ]] || { echo "Refusing to replace a symbolic link." >&2; exit 1; }
[[ ! -e "$host_path" || -f "$host_path" ]] || { echo "Refusing to replace a non-file: $host_path" >&2; exit 1; }
receipt_value() { /usr/bin/plutil -extract "$1" raw -o - "$receipt_path" 2>/dev/null || true; }
if [[ -e "$receipt_path" ]]; then
  [[ -f "$receipt_path" && "$(receipt_value format)" == 1 &&
     "$(receipt_value name)" == "$host_name" && "$(receipt_value path)" == "$host_path" ]] || {
    echo "An unrecognized installation receipt already exists at $receipt_path; leaving it untouched." >&2
    exit 1
  }
fi
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
replace_started=false
replace_complete=false
cleanup() {
  if [[ "$replace_started" == true && "$replace_complete" == false ]]; then
    for name in i-know-it-host install-receipt.json; do
      if [[ -f "$build_dir/$name.previous" ]]; then
        mv -f -- "$build_dir/$name.previous" "$install_dir/$name"
      else
        rm -f -- "$install_dir/$name"
      fi
    done
  fi
  for file in "$build_dir/i-know-it-host" "$build_dir/install-receipt.json" "$build_dir/main.swift" "$build_dir/i-know-it-host.previous" "$build_dir/install-receipt.json.previous" "$build_dir/manifest.json" "$manifest_temp"; do
    [[ ! -f "$file" ]] || rm -- "$file"
  done
  rmdir -- "$build_dir" 2>/dev/null || true
}
trap cleanup EXIT
hash_file() {
  local result
  result="$(/usr/bin/shasum -a 256 -- "$1")" || return 1
  printf '%s' "${result%% *}"
}
cp "$source_dir/native/main.swift" "$build_dir/main.swift"
source_hash="$(hash_file "$build_dir/main.swift")"
compiler_version="$(/usr/bin/xcrun swiftc --version)"
compiler_hash="$(hash_file "$compiler_path")"
compiler_identity="$compiler_path
$compiler_version
$compiler_hash"
architecture="$(uname -m)"
installed_hash=""
[[ ! -f "$host_path" ]] || installed_hash="$(hash_file "$host_path")"
reuse=false
if [[ -f "$receipt_path" && -f "$host_path" && -x "$host_path" &&
      "$(receipt_value source_sha256)" == "$source_hash" &&
      "$(receipt_value compiler)" == "$compiler_identity" &&
      "$(receipt_value architecture)" == "$architecture" &&
      "$(receipt_value executable_sha256)" == "$installed_hash" ]]; then
  reuse=true
  chmod 755 "$host_path"
  chmod 600 "$receipt_path"
else
  /usr/bin/xcrun swiftc "$build_dir/main.swift" -o "$build_dir/i-know-it-host"
  chmod 755 "$build_dir/i-know-it-host"
  /usr/bin/plutil -create xml1 "$build_dir/install-receipt.json"
  /usr/bin/plutil -insert format -integer 1 "$build_dir/install-receipt.json"
  /usr/bin/plutil -insert name -string "$host_name" "$build_dir/install-receipt.json"
  /usr/bin/plutil -insert path -string "$host_path" "$build_dir/install-receipt.json"
  /usr/bin/plutil -insert source_sha256 -string "$source_hash" "$build_dir/install-receipt.json"
  /usr/bin/plutil -insert compiler -string "$compiler_identity" "$build_dir/install-receipt.json"
  /usr/bin/plutil -insert architecture -string "$architecture" "$build_dir/install-receipt.json"
  /usr/bin/plutil -insert executable_sha256 -string "$(hash_file "$build_dir/i-know-it-host")" "$build_dir/install-receipt.json"
  /usr/bin/plutil -convert json "$build_dir/install-receipt.json"
fi
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
if [[ "$reuse" == false ]]; then
  for name in i-know-it-host install-receipt.json; do
    [[ ! -f "$install_dir/$name" ]] || cp -p "$install_dir/$name" "$build_dir/$name.previous"
  done
  replace_started=true
  mv -f -- "$build_dir/i-know-it-host" "$host_path"
  mv -f -- "$build_dir/install-receipt.json" "$receipt_path"
  replace_complete=true
fi

echo "Installed I Know It! for Chrome and Chrome for Testing."
if [[ "$reuse" == true ]]; then
  echo "Reused the unchanged native executable; its bytes and modification time were preserved."
else
  echo "Built the native executable. macOS may require Input Monitoring permission again."
fi
echo "One-time setup: open chrome://extensions, enable Developer mode, and load this folder unpacked:"
echo "$source_dir"
echo "If it is already loaded, reload the extension. Use its switch to enable or disable screenshot context."
echo "Optional region coordinates: click Allow region context in the switch panel and allow macOS Input Monitoring."
echo "No background service or screenshot shortcut was installed."
