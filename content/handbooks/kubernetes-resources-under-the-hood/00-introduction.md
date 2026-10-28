---
title: "Introduction"
order: 1
summary: "What the lab is, how to run it on macOS or Windows (WSL2), and how it reads kernel files."
---

Every `resources:` block you write ends up as a few numbers in files under `/sys/fs/cgroup` on a node. This handbook goes through those settings one at a time. For each one, a lab module creates pods on a local [kind](https://kind.sigs.k8s.io/) cluster and **reads the real kernel files**, so you can watch CPU throttling, OOM kills, evictions and QoS decisions happen instead of taking them on trust.

All the code is in the companion repo: [kubernetes-resources-under-the-hood](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood). Each chapter here is one module, and every module ends with automatic checks that print `PASS` or `FAIL`. The example outputs are from real runs on a MacBook with Docker Desktop and kind.

If you want the theory first, read [Cgroups: A Deep Dive into Resource Management in Kubernetes](/blog/cgroups-deep-dive-kubernetes/). This handbook is the hands-on companion to that post.

## What you need

- Docker Desktop with at least **4 CPUs and 6 GB of memory** (Settings → Resources)
- `kind`, `kubectl` and `make`

### macOS

```bash
brew install kind kubectl
git clone https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood.git
cd kubernetes-resources-under-the-hood
make cluster
make 00-setup
```

### Windows (WSL2)

Run everything inside an Ubuntu WSL2 terminal, with Docker Desktop on the WSL2 backend and integration enabled for your distro.

First make sure WSL2 uses cgroups v2. Create or edit `%UserProfile%\.wslconfig`:

```ini
[wsl2]
kernelCommandLine = cgroup_no_v1=all
```

Run `wsl --shutdown` in PowerShell and restart Docker Desktop. Then, in Ubuntu:

```bash
sudo apt-get update && sudo apt-get install -y make
curl -Lo kind https://kind.sigs.k8s.io/dl/latest/kind-linux-amd64 && chmod +x kind && sudo mv kind /usr/local/bin/
curl -LO "https://dl.k8s.io/release/$(curl -Ls https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" && chmod +x kubectl && sudo mv kubectl /usr/local/bin/
git clone https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood.git
cd kubernetes-resources-under-the-hood
make cluster
make 00-setup
```

## Commands

```bash
make help                 # list everything
make <module>             # run one module, e.g. make 04-memory-and-oom
make all                  # run every module in order
KEEP=1 make <module>      # keep the module's pods running so you can explore
make reset                # keep the cluster, remove everything the lab created, undo any kubelet change
make clean                # delete the whole kind cluster
```

Every module cleans up its own pods when it finishes, even if a check fails or you press Ctrl-C. Modules 07 and 11 change the worker's kubelet config and always restore it on exit.

## How the lab reads kernel files

- **From inside a container:** with cgroups v2 each container sees its own cgroup at `/sys/fs/cgroup`, so `kubectl exec <pod> -- cat /sys/fs/cgroup/cpu.max` shows that container's limit.
- **From the node:** a kind node is a Docker container, so `docker exec under-the-hood-worker cat /sys/fs/cgroup/...` reads the pod and QoS slices directly. kind runs the kubelet with `cgroupRoot: /kubelet`, so the pod tree is at `kubelet.slice/kubelet-kubepods.slice` rather than `kubepods.slice`.

> [!NOTE]
> The lab needs a node on cgroups v2. Docker Desktop on current macOS and WSL2 with the setting above both qualify. `make 00-setup` checks this and prints a hint if not.
