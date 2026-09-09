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
lock_dir="$install_dir/.install-lock"
mkdir "$lock_dir" 2>/dev/null || {
  rmdir -- "$build_dir"
  echo "Another installation is active, or a previous installation left $lock_dir. No helper was replaced." >&2
  exit 1
}
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
  for file in "$build_dir/i-know-it-host" "$build_dir/install-receipt.json" "$build_dir/main.swift" "$build_dir/i-know-it-host.previous" "$build_dir/install-receipt.json.previous" "$build_dir/manifest.json" "$build_dir"/certificate-* "$manifest_temp"; do
    [[ ! -f "$file" ]] || rm -- "$file"
  done
  rmdir -- "$build_dir" 2>/dev/null || true
  rmdir -- "$lock_dir" 2>/dev/null || true
}
trap cleanup EXIT
hash_file() {
  local result
  result="$(/usr/bin/shasum -a "${2-256}" -- "$1")" || return 1
  printf '%s' "${result%% *}"
}
# Read the actual signature; never create or broaden a designated requirement.
requirement_for() {
  local details
  details="$(/usr/bin/codesign --display -r- "$1" 2>&1)" || return 1
  [[ "$details" == *'designated => '* ]] || return 1
  printf '%s' "${details##*designated => }"
}
verify_signed() {
  /usr/bin/codesign --verify --strict "$1" || return 1
  /usr/bin/codesign --verify -R "=identifier \"$host_name\"" "$1" || return 1
  rm -f -- "$build_dir"/certificate-*
  /usr/bin/codesign --display --extract-certificates "$build_dir/certificate-" "$1" 2>/dev/null || return 1
  [[ -f "$build_dir/certificate-0" && "$(hash_file "$build_dir/certificate-0" 1)" == "$2" ]] || return 1
  [[ "$(requirement_for "$1")" == "$3" ]] || return 1
}
previous_identity="$(receipt_value signing_identity)"
previous_requirement="$(receipt_value designated_requirement)"
signing_identity="${IKI_SIGNING_IDENTITY-$previous_identity}"
signing_identity="$(printf '%s' "$signing_identity" | /usr/bin/tr '[:upper:]' '[:lower:]')"
signing_keychain="${IKI_SIGNING_KEYCHAIN-$(receipt_value signing_keychain)}"
if [[ -n "$previous_identity" || -n "$previous_requirement" ]]; then
  [[ "$previous_identity" =~ ^[0-9a-f]{40}$ && -n "$previous_requirement" &&
     "$signing_identity" == "$previous_identity" ]] || {
    echo "The signing identity does not match the installed receipt; leaving the installation untouched." >&2
    exit 1
  }
fi
[[ "$signing_identity" =~ ^[0-9a-f]{40}$ ]] || {
  echo "A stable code-signing identity is required. Set IKI_SIGNING_IDENTITY to its 40-character certificate SHA-1 fingerprint." >&2
  echo "Use security find-identity -v -p codesigning to list available identities. No helper was replaced." >&2
  exit 1
}
# An old or missing receipt must not permit rotation of an already signed host.
if [[ -f "$host_path" && -z "$previous_requirement" ]]; then
  /usr/bin/codesign --display --extract-certificates "$build_dir/certificate-" "$host_path" 2>/dev/null || true
  if [[ -f "$build_dir/certificate-0" ]]; then
    previous_requirement="$(requirement_for "$host_path")"
    verify_signed "$host_path" "$signing_identity" "$previous_requirement" || {
      echo "The existing signed helper does not match the selected identity; leaving it untouched." >&2
      exit 1
    }
  fi
fi
cp "$source_dir/native/main.swift" "$build_dir/main.swift"
source_hash="$(hash_file "$build_dir/main.swift")"
architecture="$(uname -m)"
installed_hash=""
[[ ! -f "$host_path" ]] || installed_hash="$(hash_file "$host_path")"
reuse=false
if [[ -f "$receipt_path" && -f "$host_path" && -x "$host_path" &&
      "$(receipt_value source_sha256)" == "$source_hash" &&
      "$(receipt_value architecture)" == "$architecture" &&
      "$(receipt_value executable_sha256)" == "$installed_hash" &&
      -n "$previous_identity" && -n "$previous_requirement" ]] &&
      verify_signed "$host_path" "$signing_identity" "$previous_requirement"; then
  reuse=true
  chmod 755 "$host_path"
  chmod 600 "$receipt_path"
else
  compiler_path="$(/usr/bin/xcrun --find swiftc)"
  compiler_version="$(/usr/bin/xcrun swiftc --version)"
  compiler_hash="$(hash_file "$compiler_path")"
  compiler_identity="$compiler_path
$compiler_version
$compiler_hash"
  /usr/bin/xcrun swiftc "$build_dir/main.swift" -o "$build_dir/i-know-it-host"
  chmod 755 "$build_dir/i-know-it-host"
  signing_args=(--force --sign "$signing_identity" --identifier "$host_name")
  [[ -z "$signing_keychain" ]] || signing_args+=(--keychain "$signing_keychain")
  /usr/bin/codesign "${signing_args[@]}" "$build_dir/i-know-it-host"
  requirement="$(requirement_for "$build_dir/i-know-it-host")"
  verify_signed "$build_dir/i-know-it-host" "$signing_identity" "$requirement"
  if [[ -n "$previous_requirement" ]]; then
    /usr/bin/codesign --verify --strict -R "=$previous_requirement" "$build_dir/i-know-it-host"
    [[ "$requirement" == "$previous_requirement" ]] || {
      echo "The update changed its default designated requirement; leaving the installation untouched." >&2
      exit 1
    }
  fi
  /usr/bin/plutil -create xml1 "$build_dir/install-receipt.json"
  /usr/bin/plutil -insert format -integer 1 "$build_dir/install-receipt.json"
  /usr/bin/plutil -insert name -string "$host_name" "$build_dir/install-receipt.json"
  /usr/bin/plutil -insert path -string "$host_path" "$build_dir/install-receipt.json"
  /usr/bin/plutil -insert source_sha256 -string "$source_hash" "$build_dir/install-receipt.json"
  /usr/bin/plutil -insert compiler -string "$compiler_identity" "$build_dir/install-receipt.json"
  /usr/bin/plutil -insert architecture -string "$architecture" "$build_dir/install-receipt.json"
  /usr/bin/plutil -insert executable_sha256 -string "$(hash_file "$build_dir/i-know-it-host")" "$build_dir/install-receipt.json"
  /usr/bin/plutil -insert signing_identity -string "$signing_identity" "$build_dir/install-receipt.json"
  /usr/bin/plutil -insert signing_keychain -string "$signing_keychain" "$build_dir/install-receipt.json"
  /usr/bin/plutil -insert designated_requirement -string "$requirement" "$build_dir/install-receipt.json"
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
  echo "Built and verified the signed native executable."
  if [[ -z "$previous_requirement" ]]; then
    echo "This is the initial signed identity. macOS may require Input Monitoring authorization once."
  else
    echo "The update satisfies the previous version's default designated requirement."
  fi
fi
echo "One-time setup: open chrome://extensions, enable Developer mode, and load this folder unpacked:"
echo "$source_dir"
echo "If it is already loaded, reload the extension. Use its switch to enable or disable screenshot context."
echo "Optional region coordinates: click Allow region context in the switch panel and allow macOS Input Monitoring."
echo "No background service or screenshot shortcut was installed."
