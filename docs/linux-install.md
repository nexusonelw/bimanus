# Linux Install & Remote Access

This guide covers installing Bimanus on Linux (x64 / arm64), configuring remote access (port + password), launching the app, and uninstalling.

Related scripts:

| Script | Purpose |
|--------|---------|
| [`scripts/install-linux.sh`](../scripts/install-linux.sh) | One-line installer from GitHub Releases |
| [`scripts/uninstall-linux.sh`](../scripts/uninstall-linux.sh) | One-line uninstaller |

## Requirements

- Linux **x64** (`x86_64`) or **arm64** (`aarch64`)
- `curl`
- `python3` **or** `node` (to parse GitHub release metadata)
- A desktop session is recommended (Electron GUI). Pure headless servers may need extra display/GPU setup outside this guide.
- Network access to `https://github.com` / `https://api.github.com`

## Quick install

```bash
curl -fsSL https://raw.githubusercontent.com/nexusonelw/bimanus/main/scripts/install-linux.sh | bash
```

The installer will:

1. Detect CPU architecture (`x64` / `arm64`).
2. Fetch the newest GitHub Release (including prereleases such as `v0.1.0-beta.*`).
3. Download the matching AppImage (`Bimanus-*-x64.AppImage`, `Bimanus-*-x86_64.AppImage`, or `Bimanus-*-arm64.AppImage`).
4. Prompt for remote UI **port** (default `43174`) and **password/token** (default: random).
5. Install files and print a LAN import URL:

   ```text
   http://<lan-ip>:<port>/?token=<password>
   ```

### Non-interactive install

```bash
curl -fsSL https://raw.githubusercontent.com/nexusonelw/bimanus/main/scripts/install-linux.sh | \
  bash -s -- --yes --port 43174 --token 'your-secret'
```

Environment-variable form:

```bash
BIMANUS_REMOTE_UI_PORT=43174 \
BIMANUS_REMOTE_UI_TOKEN='your-secret' \
bash scripts/install-linux.sh --yes
```

### Install options

| Option | Env override | Description |
|--------|--------------|-------------|
| `--port <n>` | `BIMANUS_REMOTE_UI_PORT` | Remote UI port (default `43174`) |
| `--token <s>` / `--password <s>` | `BIMANUS_REMOTE_UI_TOKEN` | Remote access password / bearer token |
| `--host <addr>` | `BIMANUS_REMOTE_UI_HOST` | Bind address (default `0.0.0.0`) |
| `--version <tag>` | `BIMANUS_VERSION` | Install a specific release tag (e.g. `v0.1.0-beta.30`) |
| `--repo owner/repo` | `BIMANUS_REPO` | GitHub repo (default `nexusonelw/bimanus`) |
| `--install-dir <dir>` | `BIMANUS_INSTALL_DIR` | AppImage directory (default `~/.local/opt/bimanus`) |
| `--bin-dir <dir>` | `BIMANUS_BIN_DIR` | Launcher directory (default `~/.local/bin`) |
| `--yes` / `-y` | — | Accept defaults; no interactive prompts |
| `--no-start` | — | Skip launch-oriented completion hints |
| `--help` | — | Show help |

If the GitHub API rate-limits anonymous requests, set `GITHUB_TOKEN` or `GH_TOKEN`.

## What gets installed

| Path | Contents |
|------|----------|
| `~/.local/opt/bimanus/*.AppImage` | Application binary |
| `~/.local/opt/bimanus/remote-ui.env` | Remote UI env (`PI_APP_REMOTE_UI*`) used by the launcher |
| `~/.local/opt/bimanus/.bimanus-install-meta` | Install metadata for the uninstaller |
| `~/.local/bin/bimanus` | Launcher wrapper (`PATH` entry) |
| `~/.local/share/applications/bimanus.desktop` | Desktop entry |
| `~/.config/Bimanus/ui-state.json` | App UI state, including `remoteUiPort` / `remoteUiToken` |

Ensure `~/.local/bin` is on your `PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## Launch

```bash
bimanus
```

Because the installer writes a token into `remote-ui.env` (and `ui-state.json`), the remote UI bridge starts automatically on launch.

### Override remote settings at launch (CLI)

CLI flags override environment variables; env overrides Settings persistence.

```bash
bimanus \
  --remote-ui \
  --remote-ui-host 0.0.0.0 \
  --remote-ui-port 43174 \
  --remote-ui-token 'your-secret'
```

| Flag | Description |
|------|-------------|
| `--remote-ui` / `--no-remote-ui` | Force enable / disable the bridge |
| `--remote-ui-host <addr>` | Bind address |
| `--remote-ui-port <n>` | HTTP/SSE port |
| `--remote-ui-token <s>` / `--remote-ui-password <s>` | Bearer token / password |

### Override via environment variables

```bash
PI_APP_REMOTE_UI=1 \
PI_APP_REMOTE_UI_HOST=0.0.0.0 \
PI_APP_REMOTE_UI_PORT=43174 \
PI_APP_REMOTE_UI_TOKEN='your-secret' \
bimanus
```

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_APP_REMOTE_UI` | — | Set to `1` to force-enable |
| `PI_APP_REMOTE_UI_HOST` | `0.0.0.0` | Bind address for LAN access |
| `PI_APP_REMOTE_UI_PORT` | `43174` | Remote UI port |
| `PI_APP_REMOTE_UI_TOKEN` | — | Bearer token / password |

You can also change port/password later in **Settings → Remote UI**.

## Connect from another device

1. Start Bimanus on the Linux host (`bimanus`).
2. Confirm the host and client are on the same LAN/VPN and the port is allowed by the firewall.
3. Open the import URL printed at install time, or rebuild it:

   ```text
   http://<host-lan-ip>:<port>/?token=<password>
   ```

4. Auth alternatives (same token):
   - Query: `?token=<password>`
   - Header: `Authorization: Bearer <password>`
   - Header: `X-Pi-Remote-Ui-Token: <password>`

Keep the token private. Prefer LAN / VPN / tunnel; do not expose the bridge to the public internet without additional protection.

## Update

Re-run the installer. It downloads the latest (or `--version`) AppImage into the install dir and rewrites the launcher/env.

```bash
curl -fsSL https://raw.githubusercontent.com/nexusonelw/bimanus/main/scripts/install-linux.sh | bash
```

To keep an existing password non-interactively:

```bash
curl -fsSL https://raw.githubusercontent.com/nexusonelw/bimanus/main/scripts/install-linux.sh | \
  bash -s -- --yes --port 43174 --token 'your-existing-secret'
```

## Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/nexusonelw/bimanus/main/scripts/uninstall-linux.sh | bash
```

Remove app data as well (`~/.config/Bimanus`):

```bash
curl -fsSL https://raw.githubusercontent.com/nexusonelw/bimanus/main/scripts/uninstall-linux.sh | \
  bash -s -- --yes --purge
```

### Uninstall options

| Option | Description |
|--------|-------------|
| `--install-dir <dir>` | Override install directory |
| `--bin-dir <dir>` | Override launcher directory |
| `--purge` | Also delete `~/.config/Bimanus` |
| `--yes` / `-y` | No confirmation prompts |
| `--help` | Show help |

The uninstaller reads `~/.local/opt/bimanus/.bimanus-install-meta` when present, so custom install paths from the installer are cleaned up correctly.

## Manual AppImage install (without the script)

1. Download the matching AppImage from [Releases](https://github.com/nexusonelw/bimanus/releases).
2. Make it executable and run:

   ```bash
   chmod +x Bimanus-*-*.AppImage
   PI_APP_REMOTE_UI=1 \
   PI_APP_REMOTE_UI_PORT=43174 \
   PI_APP_REMOTE_UI_TOKEN='your-secret' \
   ./Bimanus-*-*.AppImage
   ```

## Publish notes (maintainers)

`pnpm release` builds and uploads Linux **x64** and **arm64** AppImages via `scripts/release-local.mjs`.

```bash
pnpm release
# skip one arch if needed:
pnpm release --no-linux-arm64
pnpm release --no-linux-x64
```

Local package only:

```bash
pnpm --filter @bimanus/desktop run package:linux        # x64 + arm64
pnpm --filter @bimanus/desktop run package:linux:x64
pnpm --filter @bimanus/desktop run package:linux:arm64
```

## Troubleshooting

| Symptom | What to check |
|---------|----------------|
| `No AppImage asset found for arch=arm64` | That release may predate arm64 packaging. Use a newer release or `--version` pointing at a tag that includes the arm64 AppImage. |
| `bimanus: command not found` | Add `~/.local/bin` to `PATH`, or call the AppImage path directly. |
| Remote page shows Unauthorized | Token mismatch. Check `remote-ui.env`, CLI flags, or Settings → Remote UI. |
| Other device cannot connect | Firewall, wrong LAN IP, host not bound to `0.0.0.0`, or devices not on the same network. |
| GitHub API 403 / rate limit | Export `GITHUB_TOKEN` / `GH_TOKEN` and re-run the installer. |
| App fails to start on a server | Electron needs a graphical stack / GPU libs. Use a desktop environment or provide a virtual display; this is outside the installer scope. |
