---
title: "00 · cgroups v2 on a Kubernetes node"
order: 2
summary: "See the cgroup tree the kubelet builds on a node before any of your pods run."
---

**Goal:** see the cgroup tree the kubelet builds on a node before any of your pods run.

Lab module: [`modules/00-setup`](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood/tree/main/modules/00-setup)

```bash
make cluster
make 00-setup
```

## What you will see

| Command | What it shows |
|---|---|
| `stat -fc %T /sys/fs/cgroup/` | `cgroup2fs`: the node uses the unified cgroups v2 hierarchy |
| `cat /sys/fs/cgroup/cgroup.controllers` | The controllers the kernel offers (`cpu`, `memory`, `io`, `pids`, …) |
| kubelet `configz` | `cgroupDriver: systemd`, and in kind `cgroupRoot: /kubelet` |
| `find … '*kubepods.slice'` | Where the kubelet's pod tree lives: `kubelet.slice/kubelet-kubepods.slice` in kind |
| `ls <pod tree>` | The burstable and besteffort slices, and one slice per Guaranteed pod |
| `<pod tree>/memory.max` | The ceiling for all pods on the node, derived from node allocatable |

## Why it matters

Every `resources:` block you write ends up as numbers in files under these directories. The kubelet builds a tree:

```text
kubepods.slice                     node allocatable (all pods)
├── kubepods-pod<uid>.slice        Guaranteed pods sit directly here
├── kubepods-burstable.slice
│   └── kubepods-burstable-pod<uid>.slice
│       └── cri-containerd-<id>.scope   one per container
└── kubepods-besteffort.slice
```

A child cgroup can never use more than its parent allows. That one rule is how Kubernetes enforces limits at node, QoS class, pod and container level.

> **kind vs a real node:** kind starts the kubelet with `cgroupRoot: /kubelet`, so every slice name gets a `kubelet-` prefix (`kubelet.slice/kubelet-kubepods.slice/kubelet-kubepods-burstable.slice/…`). On a normal node the tree starts at `/sys/fs/cgroup/kubepods.slice`. The lab scripts find it either way.

> The kind node is itself a container, so `docker exec under-the-hood-worker …` lets you read the node's real cgroup files from your laptop.
