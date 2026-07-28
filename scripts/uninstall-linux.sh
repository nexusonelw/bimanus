#!/usr/bin/env bash
# Bimanus Linux one-shot uninstaller.
#
# Removes the AppImage install created by scripts/install-linux.sh:
#   - ~/.local/opt/bimanus (or BIMANUS_INSTALL_DIR)
#   - ~/.local/bin/bimanus launcher
#   - ~/.local/share/applications/bimanus.desktop
#
# Full usage docs:
#   docs/linux-install.md
#   docs/linux-install.zh.md
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/nexusonelw/bimanus/main/scripts/uninstall-linux.sh | bash
#
# Options:
#   --install-dir <dir>  App install dir (default: ~/.local/opt/bimanus)
#   --bin-dir <dir>      Launcher dir (default: ~/.local/bin)
#   --purge              Also remove app config/data (~/.config/Bimanus)
#   --keep-config        Keep config even if --purge is set (no-op safety)
#   --yes / -y           Do not prompt for confirmation
#   --help               Show help

set -euo pipefail

PRODUCT_NAME="Bimanus"
INSTALL_DIR="${BIMANUS_INSTALL_DIR:-${HOME}/.local/opt/bimanus}"
BIN_DIR="${BIMANUS_BIN_DIR:-${HOME}/.local/bin}"
CONFIG_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/${PRODUCT_NAME}"
DESKTOP_FILE="${XDG_DATA_HOME:-$HOME/.local/share}/applications/bimanus.desktop"
LAUNCHER="${BIN_DIR}/bimanus"
META_FILE="${INSTALL_DIR}/.bimanus-install-meta"
ASSUME_YES=0
PURGE=0

bold() { printf '\033[1m%s\033[0m' "$*"; }
info() { printf '  %s\n' "$*"; }
step() { printf '\n▶ %s\n' "$*"; }
die() { printf '\n✖ %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
}

prompt_yes_no() {
  local message="$1"
  local default="${2:-n}"
  local reply=""
  local hint="y/N"
  [[ "$default" == "y" ]] && hint="Y/n"
  if [[ -r /dev/tty ]]; then
    printf '%s [%s]: ' "$message" "$hint" > /dev/tty
    IFS= read -r reply < /dev/tty || true
  elif [[ -t 0 ]]; then
    printf '%s [%s]: ' "$message" "$hint"
    IFS= read -r reply || true
  else
    reply="$default"
  fi
  reply="$(printf '%s' "$reply" | tr '[:upper:]' '[:lower:]')"
  if [[ -z "$reply" ]]; then
    reply="$default"
  fi
  [[ "$reply" == "y" || "$reply" == "yes" ]]
}

load_meta() {
  if [[ ! -f "$META_FILE" ]]; then
    return 0
  fi
  # shellcheck disable=SC1090
  # Meta is key=value lines written by install-linux.sh
  while IFS='=' read -r key value; do
    case "$key" in
      install_dir) INSTALL_DIR="$value" ;;
      launcher) LAUNCHER="$value" ;;
      desktop_file) DESKTOP_FILE="$value" ;;
      config_dir) CONFIG_DIR="$value" ;;
      bin_dir) BIN_DIR="$value" ;;
    esac
  done < "$META_FILE"
  META_FILE="${INSTALL_DIR}/.bimanus-install-meta"
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --help|-h)
        usage
        exit 0
        ;;
      --install-dir)
        INSTALL_DIR="${2:-}"; shift 2 || die "--install-dir requires a value"
        ;;
      --install-dir=*)
        INSTALL_DIR="${1#*=}"; shift
        ;;
      --bin-dir)
        BIN_DIR="${2:-}"; shift 2 || die "--bin-dir requires a value"
        LAUNCHER="${BIN_DIR}/bimanus"
        ;;
      --bin-dir=*)
        BIN_DIR="${1#*=}"; shift
        LAUNCHER="${BIN_DIR}/bimanus"
        ;;
      --purge)
        PURGE=1; shift
        ;;
      --keep-config)
        PURGE=0; shift
        ;;
      --yes|-y)
        ASSUME_YES=1; shift
        ;;
      *)
        die "Unknown argument: $1 (try --help)"
        ;;
    esac
  done
}

remove_path() {
  local path="$1"
  if [[ -e "$path" || -L "$path" ]]; then
    rm -rf "$path"
    info "Removed $path"
  else
    info "Skip (missing): $path"
  fi
}

main() {
  parse_args "$@"
  # Prefer install-dir from CLI, then reload meta if present under that dir.
  META_FILE="${INSTALL_DIR}/.bimanus-install-meta"
  load_meta
  LAUNCHER="${LAUNCHER:-${BIN_DIR}/bimanus}"

  printf '\n========================================\n'
  printf '  %s\n' "$(bold "Bimanus Linux uninstaller")"
  printf '========================================\n'
  info "Install dir: $INSTALL_DIR"
  info "Launcher:    $LAUNCHER"
  info "Desktop:     $DESKTOP_FILE"
  info "Config:      $CONFIG_DIR"
  if [[ "$PURGE" -eq 1 ]]; then
    info "Purge data:  yes"
  else
    info "Purge data:  no (pass --purge to remove config)"
  fi

  local found=0
  for path in "$INSTALL_DIR" "$LAUNCHER" "$DESKTOP_FILE"; do
    if [[ -e "$path" || -L "$path" ]]; then
      found=1
      break
    fi
  done
  if [[ "$found" -eq 0 && "$PURGE" -eq 0 ]]; then
    info "Nothing to uninstall at the default locations."
    exit 0
  fi

  if [[ "$ASSUME_YES" -eq 0 ]]; then
    if ! prompt_yes_no "Uninstall Bimanus from this machine?" "n"; then
      info "Cancelled."
      exit 0
    fi
    if [[ "$PURGE" -eq 1 ]]; then
      if ! prompt_yes_no "Also delete app data under $CONFIG_DIR ?" "n"; then
        PURGE=0
        info "Keeping config data."
      fi
    fi
  fi

  step "Stopping running Bimanus processes (best-effort)"
  if command -v pkill >/dev/null 2>&1; then
    pkill -f "${INSTALL_DIR}/.*\\.AppImage" 2>/dev/null || true
    pkill -x "Bimanus" 2>/dev/null || true
    # Do not hard-fail if nothing is running.
    info "Signaled matching processes (if any)."
  else
    info "pkill not available; skip process stop."
  fi

  step "Removing install files"
  remove_path "$LAUNCHER"
  remove_path "$DESKTOP_FILE"
  remove_path "$INSTALL_DIR"

  if [[ "$PURGE" -eq 1 ]]; then
    step "Removing app data"
    remove_path "$CONFIG_DIR"
  else
    info "Kept config data at $CONFIG_DIR"
  fi

  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "${XDG_DATA_HOME:-$HOME/.local/share}/applications" >/dev/null 2>&1 || true
  fi

  printf '\n========================================\n'
  printf '  %s\n' "$(bold "Uninstall complete")"
  printf '========================================\n'
  if [[ "$PURGE" -eq 0 ]]; then
    info "App data preserved. To remove it later:"
    info "  curl -fsSL https://raw.githubusercontent.com/nexusonelw/bimanus/main/scripts/uninstall-linux.sh | bash -s -- --yes --purge"
  fi
  printf '\n'
}

main "$@"
