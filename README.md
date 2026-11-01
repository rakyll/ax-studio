# AX Studio

A desktop app for [AX](../ax): design tasks, watch them run, and create local
AX clusters. Built with Electron, React and TypeScript for macOS, Windows and Linux.

![Activity](docs/screenshots/overview.png)

- **Activity:** a task board by phase. Drag cards to resume or suspend tasks,
  inspect conditions, follow logs, and open a terminal over `ax ssh`.
- **Network:** a graph of sources, workspaces and tasks.
- **Designer:** build tasks with a form or raw YAML, then apply them.
- **Clusters:** create, inspect and delete local AX clusters on kind.

| | |
|---|---|
| ![Network](docs/screenshots/topology.png) **Network** | ![Designer](docs/screenshots/designer.png) **Designer** |
| ![Clusters](docs/screenshots/clusters.png) **Clusters** | ![Task logs](docs/screenshots/logs.png) **Task logs** |

The app calls the `ax` CLI and `kubectl`. It passes `--context` on every call,
so it never changes your global context.

## Develop

```sh
npm install
npm run dev         # hot-reloading app
npm run typecheck
```

To refresh a screenshot, build (`npm run build`) and run:

```sh
npx electron . --section=clusters --cluster=ax-dev --delay=7000 --screenshot=docs/screenshots/clusters.png
```

Other flags: `--context`, `--atespace`, `--task`, `--logs=expanded`, `--shell=<command>`.

## Package

```sh
npm run dist:mac    # .dmg and .zip
npm run dist:win    # NSIS installer and .zip
npm run dist:linux  # AppImage, .deb, .tar.gz
```

Build each OS on that OS. macOS builds are unsigned; set `mac.identity` in
`electron-builder.yml` to sign. To regenerate the icon on macOS:

```sh
swift scripts/make-icon.swift ~/ax/assets/axel.svg build-resources/icon.icns
```

## Clusters

Creating a cluster runs the AX repo's `hack/setup-e2e-kind.sh`, which needs
`make`, `go` and `docker` or `podman`. The app then merges the `kind-<name>`
context into your kubeconfig and saves a `.ax-studio.bak` backup. Reinstalling
AX deletes existing tasks and workspaces.

With podman and no docker, the app uses a `docker` shim
([docker-shim.sh](src/main/docker-shim.sh)).

## Platform notes

- **macOS/Linux:** the app reads PATH from your login shell.
- **Windows:** cluster setup needs Git for Windows (`bash`), `make` and `go`.
