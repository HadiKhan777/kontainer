# kontainer

[hadikhan777.github.io/portfolio](https://hadikhan777.github.io/portfolio/)

Minimal container runtime from scratch in Node.js — no Docker, no containerd, no external dependencies.

Uses Linux kernel features directly: user namespaces, PID namespaces, mount namespaces, and cgroup v2 resource limits.

## Features

- **Linux namespace isolation** — user, PID, mount, UTS, IPC via `unshare(1)`
- **No root required** — `--map-root-user` maps the calling user to root inside the namespace
- **cgroup v2 resource limits** — memory (`memory.max`) and CPU quota (`cpu.max`)
- **Image format** — tar.gz archives stored in `~/.kontainer/images/`
- **Container lifecycle** — create, run, stop, remove with state persistence
- **Log capture** — stdout/stderr saved per container
- **Built-in base image** — `init-base` builds a working rootfs from host binaries + their shared libraries (resolved via `ldd`)

## Quick start

```bash
# Build the base image (copies sh, bash, coreutils + shared libs from host)
node kontainer.js init-base

# Run a container
node kontainer.js run base sh -c "echo hello && hostname && id"

# With resource limits
node kontainer.js run --memory 128m --cpus 0.5 --name worker base sh -c "cat /etc/os-release"

# Build your own image from a directory
node kontainer.js build ./myapp myapp-image
node kontainer.js run myapp-image node server.js

# Lifecycle
node kontainer.js ps -a          # list all containers
node kontainer.js logs worker    # print container output
node kontainer.js stop worker    # send SIGTERM
node kontainer.js rm worker      # remove stopped container
node kontainer.js inspect worker # full JSON state

# Image management
node kontainer.js images         # list images
node kontainer.js rmi myapp-image
```

## How it works

**Namespace isolation**

Each container is launched with:

```bash
unshare --user --pid --mount --uts --ipc --fork --map-root-user \
  sh -c 'mount -t proc proc /rootfs/proc && exec chroot /rootfs <cmd>'
```

`--user` + `--map-root-user` creates a user namespace where the process appears as root (uid 0) inside but remains the calling user outside — no privileges needed.

**cgroup v2**

After spawning, the container's PID is written to `/sys/fs/cgroup/kontainer-<name>/cgroup.procs`. Limits are set by writing to `memory.max` and `cpu.max` before spawn. Gracefully skipped if cgroups are not writable.

**Image format**

An image is a `.tar.gz` of a directory. `kontainer build <dir> <name>` tars it. `kontainer run` extracts it to `~/.kontainer/rootfs/<container-name>/` as the container's filesystem root.

**State**

Container state (pid, status, config, log path) is JSON in `~/.kontainer/containers/<name>.json`. Status transitions: `running` → `exited` / `stopped`.

## Files

| File | Purpose |
|------|---------|
| `kontainer.js` | CLI entry — all commands |
| `runtime.js` | Process spawning, namespace setup, cgroup management |
| `images.js` | Build, extract, list, remove images |
| `store.js` | Container state and log persistence |
