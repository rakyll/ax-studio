# AX Studio

A cross-platform desktop app for [AX](../ax): design tasks, watch them run, and
deploy the control plane to Kubernetes. Built with Electron + React + TypeScript
and packaged as a native app for macOS, Windows and Linux.

| Section | What it does |
|---|---|
| **Overview** | Stat tiles, phase distribution, tasks-over-time chart, resources, activity feed. |
| **Task Board** | Kanban by phase. Drag a card to Running/Suspended to resume/suspend; inspector, shell, delete. |
| **Topology** | Sources → workspaces → tasks → models graph; running edges animate. |
| **Designer** | Form + live composition diagram + generated YAML (or raw edit). Templates, open/save, apply. |
| **Deploy** | Kubernetes pipeline: Agent Substrate → Build & push images → AX → Verify, with a live console. |

The app shells out to the `ax` CLI (and `kubectl`, `make`, `go`, `podman`/`docker`
for deploys). It passes `--context` on every call and gives deploy steps a
temporary single-context `KUBECONFIG`, so it never changes your global ax or
kubectl context.

## Develop

```sh
npm install
npm run dev         # hot-reloading app
npm run typecheck
```

`npx electron . --section=deploy` opens the built app (`npm run build`) on a
given section.

## Package

```sh
npm run dist:mac    # dist/AX Studio-<v>-<arch>.dmg and -mac.zip
npm run dist:win    # NSIS installer + zip
npm run dist:linux  # AppImage, .deb, tar.gz
```

Build each OS on that OS (or in CI). macOS builds are unsigned
(`mac.identity: null` in `electron-builder.yml`); set an identity to sign and notarize.

The icon is the AX axolotl (`~/ax/assets/axel.svg`). To regenerate it on macOS:

```sh
swift scripts/make-icon.swift ~/ax/assets/axel.svg build-resources/icon.icns   # also writes icon.png
```

## Deploy pipeline

| Step | Runs |
|---|---|
| Agent Substrate | `kubectl get nodes` and `kubectl get svc api -n ate-system` |
| Build & push images | Cross-compiles `ax-server` and `ax-task-runner` for every selected arch (**amd64 + arm64 by default**), builds a multi-arch manifest per image and pushes it, writing `bin/<image>.digest`. podman uses `build --manifest` + `manifest push --all`; docker uses `buildx --platform … --push`. |
| AX | `make deploy-postgres`, then `make deploy-server` pinned to the pushed digests, then waits for the rollout |
| Verify | `ax --context <ctx> get tasks` |

Steps run in the AX repo (Settings → repo path) with `/bin/sh`.

## Portability notes

- **PATH:** GUI apps don't inherit your terminal's PATH, so on macOS and Linux the app reads it
  from your login shell (`$SHELL -ilc`) at startup.
- **Windows:** deploy steps need a POSIX shell. Install Git for Windows; the app uses its
  `bash`, plus `make` and `go`. "Open shell" uses Windows Terminal if present,
  otherwise `cmd`.
- **Linux:** "Open shell" tries `x-terminal-emulator`, gnome-terminal, konsole,
  xfce4-terminal, kitty, alacritty, then xterm.

The original SwiftUI prototype lives in [`swift/`](swift/).
