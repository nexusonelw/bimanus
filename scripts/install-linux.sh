#!/usr/bin/env bash
# Bimanus Linux one-shot installer.
#
# Installs the latest Linux AppImage from GitHub Releases, prompts for remote UI
# port/password, writes a launcher wrapper, and prints the LAN import URL.
#
# Full usage docs:
#   docs/linux-install.md
#   docs/linux-install.zh.md
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/nexusonelw/bimanus/main/scripts/install-linux.sh | bash
#
# Non-interactive:
#   curl -fsSL ... | bash -s -- --port 43174 --token 'my-secret'
#   BIMANUS_REMOTE_UI_PORT=43174 BIMANUS_REMOTE_UI_TOKEN=secret bash install-linux.sh
#
# Options:
#   --port <n>           Remote UI port (default: 43174)
#   --token <s>          Remote UI password/token (default: random)
#   --password <s>       Alias of --token
#   --host <addr>        Bind host (default: 0.0.0.0)
#   --version <tag>      Install a specific release tag (e.g. v0.1.0-beta.30)
#   --repo owner/repo    GitHub repo (default: nexusonelw/bimanus)
#   --install-dir <dir>  AppImage install dir (default: ~/.local/opt/bimanus)
#   --bin-dir <dir>      Launcher dir (default: ~/.local/bin)
#   --no-start           Do not print a start hint that implies launching now
#   --yes / -y           Accept defaults without interactive prompts
#   --help               Show help
#
# Supports Linux x64 and arm64 AppImages from GitHub Releases.
#
# If raw.githubusercontent.com / github.com returns 404 or is blocked, use a mirror:
#   curl -fsSL https://cdn.jsdelivr.net/gh/nexusonelw/bimanus@main/scripts/install-linux.sh | bash -s -- --yes
#   BIMANUS_GITHUB_PROXY=https://ghfast.top/ bash install-linux.sh --yes
#
# Uninstall:
#   curl -fsSL https://raw.githubusercontent.com/nexusonelw/bimanus/main/scripts/uninstall-linux.sh | bash

set -euo pipefail

DEFAULT_REPO="nexusonelw/bimanus"
DEFAULT_PORT="43174"
DEFAULT_HOST="0.0.0.0"
PRODUCT_NAME="Bimanus"
APP_EXECUTABLE_NAME="Bimanus"

REPO="${BIMANUS_REPO:-$DEFAULT_REPO}"
INSTALL_DIR="${BIMANUS_INSTALL_DIR:-${HOME}/.local/opt/bimanus}"
BIN_DIR="${BIMANUS_BIN_DIR:-${HOME}/.local/bin}"
CONFIG_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/${PRODUCT_NAME}"
HOST="${BIMANUS_REMOTE_UI_HOST:-$DEFAULT_HOST}"
PORT="${BIMANUS_REMOTE_UI_PORT:-}"
TOKEN="${BIMANUS_REMOTE_UI_TOKEN:-${BIMANUS_REMOTE_UI_PASSWORD:-}}"
VERSION_TAG="${BIMANUS_VERSION:-}"
ASSUME_YES=0
NO_START=0

bold() { printf '\033[1m%s\033[0m' "$*"; }
info() { printf '  %s\n' "$*"; }
step() { printf '\n▶ %s\n' "$*"; }
die() { printf '\n✖ %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
}

prompt() {
  # When installed via `curl | bash`, stdin is the script. Read from the TTY.
  local message="$1"
  local default="${2:-}"
  local reply=""
  local prompt_text="$message"
  if [[ -n "$default" ]]; then
    prompt_text="$message [$default]"
  fi
  if [[ -r /dev/tty ]]; then
    printf '%s: ' "$prompt_text" > /dev/tty
    IFS= read -r reply < /dev/tty || true
  elif [[ -t 0 ]]; then
    printf '%s: ' "$prompt_text"
    IFS= read -r reply || true
  else
    reply=""
  fi
  if [[ -z "$reply" ]]; then
    printf '%s' "$default"
  else
    printf '%s' "$reply"
  fi
}

random_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 16
    return
  fi
  if [[ -r /dev/urandom ]]; then
    # shellcheck disable=SC2002
    cat /dev/urandom | LC_ALL=C tr -dc 'a-zA-Z0-9' | head -c 32
    printf '\n'
    return
  fi
  printf 'bimanus-%s-%s\n' "$$" "$RANDOM$RANDOM"
}

detect_arch() {
  local machine
  machine="$(uname -m)"
  case "$machine" in
    x86_64|amd64) printf 'x64\n' ;;
    aarch64|arm64) printf 'arm64\n' ;;
    *) die "Unsupported architecture: $machine (need x86_64 or aarch64)" ;;
  esac
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --help|-h)
        usage
        exit 0
        ;;
      --port)
        PORT="${2:-}"; shift 2 || die "--port requires a value"
        ;;
      --port=*)
        PORT="${1#*=}"; shift
        ;;
      --token|--password)
        TOKEN="${2:-}"; shift 2 || die "$1 requires a value"
        ;;
      --token=*|--password=*)
        TOKEN="${1#*=}"; shift
        ;;
      --host)
        HOST="${2:-}"; shift 2 || die "--host requires a value"
        ;;
      --host=*)
        HOST="${1#*=}"; shift
        ;;
      --version)
        VERSION_TAG="${2:-}"; shift 2 || die "--version requires a value"
        ;;
      --version=*)
        VERSION_TAG="${1#*=}"; shift
        ;;
      --repo)
        REPO="${2:-}"; shift 2 || die "--repo requires a value"
        ;;
      --repo=*)
        REPO="${1#*=}"; shift
        ;;
      --install-dir)
        INSTALL_DIR="${2:-}"; shift 2 || die "--install-dir requires a value"
        ;;
      --install-dir=*)
        INSTALL_DIR="${1#*=}"; shift
        ;;
      --bin-dir)
        BIN_DIR="${2:-}"; shift 2 || die "--bin-dir requires a value"
        ;;
      --bin-dir=*)
        BIN_DIR="${1#*=}"; shift
        ;;
      --yes|-y)
        ASSUME_YES=1; shift
        ;;
      --no-start)
        NO_START=1; shift
        ;;
      *)
        die "Unknown argument: $1 (try --help)"
        ;;
    esac
  done
}

# Optional proxy/mirror prefix for GitHub hosts, e.g.:
#   export BIMANUS_GITHUB_PROXY=https://ghfast.top/
# turns https://github.com/... into https://ghfast.top/https://github.com/...
GITHUB_PROXY_PREFIX="${BIMANUS_GITHUB_PROXY:-${GITHUB_PROXY:-}}"

proxied_url() {
  local url="$1"
  if [[ -z "$GITHUB_PROXY_PREFIX" ]]; then
    printf '%s\n' "$url"
    return
  fi
  printf '%s/%s\n' "${GITHUB_PROXY_PREFIX%/}" "$url"
}

curl_fail_hint() {
  local url="$1"
  local code="$2"
  cat >&2 <<EOF

✖ HTTP ${code:-error} while fetching:
  ${url}

Common causes:
  1) Network cannot reach GitHub / raw.githubusercontent.com (404/timeout/blocked)
  2) Temporary CDN cache or mirror lag

Try one of these:
  # A) Fetch install script from jsDelivr instead of raw.githubusercontent.com
  curl -fsSL https://cdn.jsdelivr.net/gh/nexusonelw/bimanus@main/scripts/install-linux.sh | \\
    bash -s -- --yes --port ${PORT:-43174} --token 'your-secret'

  # B) Retry API/asset downloads through a GitHub proxy
  BIMANUS_GITHUB_PROXY=https://ghfast.top/ \\
    bash <(curl -fsSL https://cdn.jsdelivr.net/gh/nexusonelw/bimanus@main/scripts/install-linux.sh) \\
    --yes --port ${PORT:-43174} --token 'your-secret'

  # C) Manual AppImage download from the release page, then:
  #   chmod +x Bimanus-*.AppImage
  #   PI_APP_REMOTE_UI=1 PI_APP_REMOTE_UI_PORT=43174 PI_APP_REMOTE_UI_TOKEN='secret' ./Bimanus-*.AppImage
EOF
}

curl_get() {
  # curl_get <url> [curl args...]
  # Prints response body to stdout. On failure, shows URL + status and exits.
  local url="$1"
  shift || true
  local final_url code tmp
  final_url="$(proxied_url "$url")"
  tmp="$(mktemp)"
  code="$(curl -sS -L --connect-timeout 20 --retry 2 --retry-delay 1 \
    -o "$tmp" -w '%{http_code}' \
    "$@" \
    "$final_url" || true)"
  if [[ "$code" != "200" && "$code" != "000" ]]; then
    # 000 = transport failure; still surface it
    :
  fi
  if [[ ! "$code" =~ ^2[0-9][0-9]$ ]]; then
    rm -f "$tmp"
    curl_fail_hint "$final_url" "$code"
    exit 1
  fi
  cat "$tmp"
  rm -f "$tmp"
}

curl_download() {
  # curl_download <url> <output-path>
  local url="$1"
  local out="$2"
  local final_url code
  final_url="$(proxied_url "$url")"
  info "Downloading: $final_url"
  code="$(curl -L --connect-timeout 20 --retry 2 --retry-delay 1 \
    --progress-bar \
    -o "$out" -w '%{http_code}' \
    "$final_url" || true)"
  if [[ ! "$code" =~ ^2[0-9][0-9]$ ]]; then
    rm -f "$out"
    curl_fail_hint "$final_url" "$code"
    exit 1
  fi
}

github_api() {
  local url="$1"
  if [[ -n "${GITHUB_TOKEN:-${GH_TOKEN:-}}" ]]; then
    curl_get "$url" \
      -H "Accept: application/vnd.github+json" \
      -H "Authorization: Bearer ${GITHUB_TOKEN:-${GH_TOKEN}}" \
      -H "X-GitHub-Api-Version: 2022-11-28"
  else
    curl_get "$url" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      -H "User-Agent: bimanus-install-linux"
  fi
}

# Prefer python3 for robust JSON; fall back to node if present.
json_get() {
  local expression="$1"
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys
data=json.load(sys.stdin)
expr=sys.argv[1]
# very small path evaluator: a.b[0].c
cur=data
for part in expr.replace("]","[").split("["):
    if part=="":
        continue
    if part.endswith("]"):
        part=part[:-1]
    if part.isdigit():
        cur=cur[int(part)]
    else:
        for key in part.split("."):
            if key=="":
                continue
            cur=cur[key]
if cur is None:
    sys.exit(2)
if isinstance(cur,(dict,list)):
    print(json.dumps(cur))
else:
    print(cur)
' "$expression"
    return
  fi
  if command -v node >/dev/null 2>&1; then
    node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(0,"utf8")); const expr=process.argv[1];
const get=(obj, path)=>{ let cur=obj; for (const raw of path.replace(/]/g,".[").split(".")) { if(!raw) continue; const m=raw.match(/^\[(\d+)\]$/); cur = m ? cur[Number(m[1])] : cur[raw]; } return cur; };
const value=get(data, expr); if (value==null) process.exit(2); if (typeof value==="object") process.stdout.write(JSON.stringify(value)); else process.stdout.write(String(value));
' "$expression"
    return
  fi
  die "Need python3 or node to parse GitHub API JSON"
}

resolve_release_json() {
  if [[ -n "$VERSION_TAG" ]]; then
    local tag="$VERSION_TAG"
    [[ "$tag" == v* ]] || tag="v$tag"
    github_api "https://api.github.com/repos/${REPO}/releases/tags/${tag}"
    return
  fi

  # /releases/latest ignores prereleases; Bimanus currently ships beta tags.
  # Take the newest published release (including prerelease).
  local list
  list="$(github_api "https://api.github.com/repos/${REPO}/releases?per_page=20")"
  printf '%s' "$list" | python3 -c 'import json,sys
releases=json.load(sys.stdin)
for release in releases:
    if release.get("draft"):
        continue
    print(json.dumps(release))
    break
else:
    sys.exit(2)
' 2>/dev/null && return

  # node fallback if python path above failed for empty list handling
  printf '%s' "$list" | node -e 'const fs=require("fs"); const releases=JSON.parse(fs.readFileSync(0,"utf8")); const release=releases.find(r=>!r.draft); if(!release) process.exit(2); process.stdout.write(JSON.stringify(release));'
}

find_asset_url() {
  local release_json="$1"
  local arch="$2"
  # Prefer exact arch AppImage, e.g. Bimanus-0.1.0-beta.30-x64.AppImage
  if command -v python3 >/dev/null 2>&1; then
    printf '%s' "$release_json" | python3 -c 'import json,sys,re
release=json.load(sys.stdin)
arch=sys.argv[1]
# electron-builder may emit x64 or x86_64 (and arm64/aarch64).
aliases={
  "x64": ["x64", "x86_64", "amd64"],
  "arm64": ["arm64", "aarch64"],
}
wanted=aliases.get(arch, [arch])
other=aliases["arm64" if arch == "x64" else "x64"]
assets=release.get("assets") or []
candidates=[a for a in assets if str(a.get("name") or "").lower().endswith(".appimage")]
if not candidates:
    sys.exit(2)

def score(asset):
    name=(asset.get("name") or "").lower()
    value=0
    if any(re.search(rf"(?:^|[-_.]){re.escape(token)}(?:[-_.]|\.appimage$)", name) for token in wanted):
        value += 80
    if any(token in name for token in wanted):
        value += 20
    if name.startswith("bimanus-"):
        value += 10
    if any(re.search(rf"(?:^|[-_.]){re.escape(token)}(?:[-_.]|\.appimage$)", name) for token in other) and not any(t in name for t in wanted):
        value -= 100
    return value

best=max(candidates, key=score)
if score(best) < 0:
    sys.exit(2)
print(best.get("browser_download_url") or "")
print(best.get("name") or "")
' "$arch"
    return
  fi

  printf '%s' "$release_json" | node -e 'const fs=require("fs"); const release=JSON.parse(fs.readFileSync(0,"utf8")); const arch=process.argv[1];
const aliases={x64:["x64","x86_64","amd64"], arm64:["arm64","aarch64"]};
const wanted=aliases[arch]||[arch];
const other=aliases[arch==="x64"?"arm64":"x64"];
const assets=(release.assets||[]).filter(a => /\.appimage$/i.test(a.name||""));
if (!assets.length) process.exit(2);
const hasToken=(name, token)=> new RegExp(`(?:^|[-_.])${token}(?:[-_.]|\\.appimage$)`,"i").test(name);
const score=(asset)=>{
  const name=String(asset.name||"").toLowerCase();
  let value=0;
  if (wanted.some(t=>hasToken(name,t))) value+=80;
  if (wanted.some(t=>name.includes(t))) value+=20;
  if (name.startsWith("bimanus-")) value+=10;
  if (other.some(t=>hasToken(name,t)) && !wanted.some(t=>name.includes(t))) value-=100;
  return value;
};
const best=assets.reduce((a,b)=> score(b)>score(a)?b:a);
if (score(best)<0) process.exit(2);
process.stdout.write(`${best.browser_download_url}\n${best.name}`);
' "$arch"
}

detect_lan_ip() {
  local ip=""
  if command -v ip >/dev/null 2>&1; then
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}' || true)"
  fi
  if [[ -z "$ip" ]] && command -v hostname >/dev/null 2>&1; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  fi
  if [[ -z "$ip" ]]; then
    ip="$(ipconfig getifaddr en0 2>/dev/null || true)"
  fi
  if [[ -z "$ip" ]]; then
    ip="127.0.0.1"
  fi
  printf '%s\n' "$ip"
}

write_env_file() {
  local env_file="$1"
  cat > "$env_file" <<EOF
# Generated by Bimanus Linux installer. Sourced by the bimanus launcher.
PI_APP_REMOTE_UI=1
PI_APP_REMOTE_UI_HOST=${HOST}
PI_APP_REMOTE_UI_PORT=${PORT}
PI_APP_REMOTE_UI_TOKEN=${TOKEN}
EOF
  chmod 600 "$env_file"
}

write_launcher() {
  local launcher="$1"
  local appimage_path="$2"
  local env_file="$3"
  cat > "$launcher" <<EOF
#!/usr/bin/env bash
set -euo pipefail
APPIMAGE=${appimage_path@Q}
ENV_FILE=${env_file@Q}
if [[ -f "\$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a
  source "\$ENV_FILE"
  set +a
fi
# Forward CLI args (including --remote-ui-*) to the AppImage binary.
exec "\$APPIMAGE" "\$@"
EOF
  chmod 755 "$launcher"
}

merge_ui_state() {
  local state_file="$1"
  mkdir -p "$(dirname "$state_file")"
  if command -v python3 >/dev/null 2>&1; then
    PORT="$PORT" TOKEN="$TOKEN" STATE_FILE="$state_file" python3 - <<'PY'
import json, os
from pathlib import Path
path = Path(os.environ["STATE_FILE"])
port = int(os.environ["PORT"])
token = os.environ["TOKEN"]
data = {}
if path.exists():
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            data = {}
    except Exception:
        data = {}
data["remoteUiPort"] = port
data["remoteUiToken"] = token
if "version" not in data:
    data["version"] = 16
path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
path.chmod(0o600)
PY
    return
  fi
  if command -v node >/dev/null 2>&1; then
    PORT="$PORT" TOKEN="$TOKEN" STATE_FILE="$state_file" node -e '
const fs=require("fs");
const path=process.env.STATE_FILE;
const port=Number(process.env.PORT);
const token=process.env.TOKEN;
let data={};
if (fs.existsSync(path)) {
  try {
    const parsed=JSON.parse(fs.readFileSync(path,"utf8"));
    if (parsed && typeof parsed==="object" && !Array.isArray(parsed)) data=parsed;
  } catch {}
}
data.remoteUiPort=port;
data.remoteUiToken=token;
if (data.version==null) data.version=16;
fs.writeFileSync(path, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
'
    return
  fi
  info "Warning: could not merge ui-state.json (need python3 or node); launcher env still applies."
}

write_desktop_entry() {
  local desktop_file="$1"
  local launcher="$2"
  local icon_hint="$3"
  mkdir -p "$(dirname "$desktop_file")"
  cat > "$desktop_file" <<EOF
[Desktop Entry]
Name=Bimanus
Comment=Desktop shell for pi coding-agent sessions
Exec=${launcher}
Terminal=false
Type=Application
Categories=Development;
EOF
  if [[ -f "$icon_hint" ]]; then
    printf 'Icon=%s\n' "$icon_hint" >> "$desktop_file"
  fi
}

main() {
  parse_args "$@"

  printf '\n========================================\n'
  printf '  %s\n' "$(bold "Bimanus Linux installer")"
  printf '========================================\n'

  need_cmd curl
  need_cmd uname
  if ! command -v python3 >/dev/null 2>&1 && ! command -v node >/dev/null 2>&1; then
    die "Need python3 or node to parse GitHub release metadata"
  fi

  local arch
  arch="$(detect_arch)"
  info "Architecture: $arch"
  info "GitHub repo:  $REPO"

  if [[ "$ASSUME_YES" -eq 0 ]]; then
    step "Remote UI configuration"
    if [[ -z "$PORT" ]]; then
      PORT="$(prompt "Remote access port" "$DEFAULT_PORT")"
    fi
    if [[ -z "$TOKEN" ]]; then
      local generated
      generated="$(random_token | tr -d '\n')"
      TOKEN="$(prompt "Remote access password/token" "$generated")"
    fi
    if [[ -z "$HOST" ]]; then
      HOST="$(prompt "Bind host" "$DEFAULT_HOST")"
    fi
  else
    PORT="${PORT:-$DEFAULT_PORT}"
    TOKEN="${TOKEN:-$(random_token | tr -d '\n')}"
    HOST="${HOST:-$DEFAULT_HOST}"
  fi

  # Validate port
  if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [[ "$PORT" -lt 1 || "$PORT" -gt 65535 ]]; then
    die "Invalid port: $PORT (expected 1-65535)"
  fi
  if [[ -z "$TOKEN" ]]; then
    die "Remote access token/password cannot be empty"
  fi

  step "Resolving GitHub release"
  local release_json tag_name asset_meta asset_url asset_name
  release_json="$(resolve_release_json)" || die "Unable to resolve a GitHub release for $REPO"
  if command -v python3 >/dev/null 2>&1; then
    tag_name="$(printf '%s' "$release_json" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("tag_name",""))')"
  else
    tag_name="$(printf '%s' "$release_json" | node -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(r.tag_name||"")')"
  fi
  [[ -n "$tag_name" ]] || die "Release metadata missing tag_name"
  info "Release: $tag_name"

  asset_meta="$(find_asset_url "$release_json" "$arch")" || die "No AppImage asset found for arch=$arch in $tag_name. Expected a Linux $arch AppImage on that release."
  asset_url="$(printf '%s\n' "$asset_meta" | sed -n '1p')"
  asset_name="$(printf '%s\n' "$asset_meta" | sed -n '2p')"
  [[ -n "$asset_url" && -n "$asset_name" ]] || die "Failed to parse AppImage asset metadata"
  info "Asset: $asset_name"

  step "Installing to $INSTALL_DIR"
  mkdir -p "$INSTALL_DIR" "$BIN_DIR" "$CONFIG_DIR"
  local appimage_path="${INSTALL_DIR}/${asset_name}"
  local tmp_path="${appimage_path}.partial"
  curl_download "$asset_url" "$tmp_path"
  mv "$tmp_path" "$appimage_path"
  chmod 755 "$appimage_path"

  local env_file="${INSTALL_DIR}/remote-ui.env"
  local launcher="${BIN_DIR}/bimanus"
  local meta_file="${INSTALL_DIR}/.bimanus-install-meta"
  write_env_file "$env_file"
  write_launcher "$launcher" "$appimage_path" "$env_file"
  merge_ui_state "${CONFIG_DIR}/ui-state.json"

  local desktop_file="${XDG_DATA_HOME:-$HOME/.local/share}/applications/bimanus.desktop"
  write_desktop_entry "$desktop_file" "$launcher" ""
  cat > "$meta_file" <<EOF
install_dir=${INSTALL_DIR}
bin_dir=${BIN_DIR}
launcher=${launcher}
desktop_file=${desktop_file}
config_dir=${CONFIG_DIR}
arch=${arch}
release_tag=${tag_name}
asset_name=${asset_name}
installed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

  local lan_ip
  lan_ip="$(detect_lan_ip)"
  local import_url="http://${lan_ip}:${PORT}/?token=${TOKEN}"

  printf '\n========================================\n'
  printf '  %s\n' "$(bold "Installation complete")"
  printf '========================================\n'
  info "AppImage:  $appimage_path"
  info "Launcher:  $launcher"
  info "Config:    $env_file"
  info "UI state:  ${CONFIG_DIR}/ui-state.json"
  info "Desktop:   $desktop_file"
  printf '\n'
  info "$(bold "Remote access")"
  info "Host IP:   $lan_ip"
  info "Port:      $PORT"
  info "Password:  $TOKEN"
  info "Import:    $import_url"
  printf '\n'
  info "Start on this machine:"
  info "  export PATH=\"${BIN_DIR}:\$PATH\"   # add to ~/.bashrc to make permanent"
  info "  bimanus"
  printf '\n'
  info "Override at launch (optional):"
  info "  bimanus --remote-ui-port 43174 --remote-ui-token 'secret'"
  printf '\n'
  info "On another device, open the Import URL above (same LAN / VPN)."
  if [[ "$NO_START" -eq 0 ]]; then
    info "Remote bridge starts automatically because a token is configured."
  fi
  printf '\n'
  info "$(bold "System libraries (required on minimal servers)")"
  info "If launch fails with missing .so (e.g. libatk-1.0.so.0), install GUI runtime deps:"
  info "  # Debian / Ubuntu"
  info "  sudo apt-get update && sudo apt-get install -y \\"
  info "    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \\"
  info "    libgtk-3-0 libgbm1 libasound2t64 || true; sudo apt-get install -y \\"
  info "    libasound2 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \\"
  info "    libxkbcommon0 libpango-1.0-0 libcairo2 libx11-xcb1 libxcb-dri3-0 \\"
  info "    libxshmfence1 libglib2.0-0 fonts-liberation ca-certificates"
  info "  # RHEL / CentOS / Fedora"
  info "  sudo dnf install -y nss atk at-spi2-atk cups-libs libdrm gtk3 mesa-libgbm \\"
  info "    alsa-lib libXcomposite libXdamage libXrandr libxkbcommon pango cairo"
  info "Headless (no display) may also need: sudo apt-get install -y xvfb && xvfb-run -a bimanus"
  printf '\n'
  info "Uninstall later:"
  info "  curl -fsSL https://cdn.jsdelivr.net/gh/nexusonelw/bimanus@main/scripts/uninstall-linux.sh | bash"
  info "  # add --purge to also remove ${CONFIG_DIR}"
  printf '\n'
}

main "$@"
