---
title: "Cgroups: A Deep Dive into Resource Management in Kubernetes"
date: 2026-10-28
summary: What actually happens on the node when you set CPU and memory requests and limits. Cgroups v2, the kubelet's cgroup tree, QoS classes, CPU throttling and the OOM killer, with the commands to see it all yourself.
tags: [linux, kubernetes, cgroups]
---

Every `resources:` block you write in a Pod spec ends up as a handful of numbers in files under `/sys/fs/cgroup` on a node. Kubernetes doesn't enforce limits itself. The Linux kernel does, through **control groups** (cgroups). Once you know which file each setting becomes, a lot of confusing production behaviour starts to make sense: CPU throttling with low average usage, OOM kills that seem to come from nowhere, and noisy neighbours.

This post walks from the kernel feature up to the kubelet, and ends with the commands I use to inspect it on a real node.

## What a cgroup is

A cgroup is a group of processes that the kernel accounts for and limits together. Each cgroup is a directory in a virtual filesystem. The files inside it are either **controls** you write to (like `memory.max`) or **stats** you read from (like `memory.current`).

Controllers decide what is being managed:

| Controller | What it governs | Files you'll look at |
|---|---|---|
| `cpu` | CPU time, relative weight and hard quota | `cpu.weight`, `cpu.max`, `cpu.stat` |
| `memory` | RAM usage, limits and OOM behaviour | `memory.max`, `memory.current`, `memory.events` |
| `io` | Block device bandwidth and IOPS | `io.max`, `io.stat` |
| `pids` | Number of processes and threads | `pids.max`, `pids.current` |
| `cpuset` | Which CPUs and NUMA nodes may be used | `cpuset.cpus` |

Cgroups are hierarchical. A child can never use more than its parent allows, which is exactly how Kubernetes builds limits at node, QoS class, pod and container level.

## Cgroups v1 vs v2

Cgroups v1 had a separate tree per controller, so a process could sit in one place in the CPU hierarchy and somewhere else in the memory hierarchy. Cgroups v2 has a **single unified tree** mounted at `/sys/fs/cgroup`, a consistent interface across controllers, and features v1 never had, such as pressure stall information (PSI).

Check which one a node is running:

```bash
stat -fc %T /sys/fs/cgroup/
# cgroup2fs  -> cgroups v2
# tmpfs      -> cgroups v1
```

Kubernetes support for cgroups v2 went GA in v1.25, and v1 support is now in maintenance mode. Modern distributions and managed node images default to v2. The rest of this post uses v2 file names.

> [!NOTE]
> The kubelet and the container runtime must agree on a **cgroup driver**. On systemd-based hosts that should be `systemd` for both. A mismatch between the kubelet's `cgroupDriver` and containerd's `SystemdCgroup` setting is a classic cause of unstable nodes.

## The kubelet's cgroup tree

With the systemd driver, the kubelet creates a tree like this:

```text
/sys/fs/cgroup/
└── kubepods.slice/                                   # all pods
    ├── kubepods-pod<uid>.slice/                      # Guaranteed pods sit directly here
    │   └── cri-containerd-<container-id>.scope
    ├── kubepods-burstable.slice/
    │   └── kubepods-burstable-pod<uid>.slice/
    │       └── cri-containerd-<container-id>.scope
    └── kubepods-besteffort.slice/
        └── kubepods-besteffort-pod<uid>.slice/
            └── cri-containerd-<container-id>.scope
```

Each level gets its own settings: the whole `kubepods.slice` is capped at the node's allocatable resources, each pod slice is capped at the sum of its containers' limits, and each container scope carries the container's own values. In the slice names, the dashes in the pod UID are replaced with underscores.

## How requests and limits become cgroup files

### CPU requests become a weight

A CPU request does **not** reserve a core. It sets a relative weight that only matters when the CPU is contended.

The kubelet converts millicores to the old v1 "shares" unit (`requests.cpu` in millicores × 1024 / 1000, so `250m` becomes 256 shares), and the runtime converts that to `cpu.weight` on cgroups v2. The exact shares-to-weight formula depends on the runtime version, so read the file rather than calculating it.

When the node is idle, a container with a small request can use as much spare CPU as it likes. When the node is busy, CPU time is split in proportion to these weights.

### CPU limits become a hard quota

A CPU limit becomes `cpu.max`, written as `<quota> <period>` in microseconds. The default period is 100ms:

| `limits.cpu` | `cpu.max` | Meaning |
|---|---|---|
| `500m` | `50000 100000` | 50ms of CPU time per 100ms period |
| `2` | `200000 100000` | 200ms per period, spread across any cores |
| not set | `max 100000` | no quota |

This is where **throttling** comes from. The quota is counted across all threads, so a multi-threaded process can burn its whole 50ms in the first 10ms of a period on five cores, then sit throttled for the remaining 90ms. Average CPU usage looks low, yet latency spikes. That pattern hits request-serving services with bursty, parallel work especially hard.

### Memory limits become a hard ceiling

`limits.memory` becomes `memory.max`. When the cgroup's usage hits that value and the kernel can't reclaim enough memory (mostly page cache), it invokes the OOM killer **inside that cgroup**, and the container is restarted with `OOMKilled`.

`requests.memory` is used by the scheduler, but by default it is **not** written to any cgroup file. An alpha feature called Memory QoS can map it to `memory.min` and use `memory.high` for throttling before the hard limit, but it is off unless you enable the feature gate.

### PIDs

If the kubelet's `podPidsLimit` is set, it becomes `pids.max` on each pod's cgroup. It is a cheap safeguard against a fork bomb or a thread leak taking down a whole node.

## QoS classes and who dies first

The kubelet puts every pod into one of three QoS classes, based only on its requests and limits:

| QoS class | Rule | `oom_score_adj` |
|---|---|---|
| Guaranteed | Every container has CPU and memory requests equal to its limits | `-997` |
| Burstable | At least one request or limit set, but not Guaranteed | between `2` and `999`, lower for larger memory requests |
| BestEffort | No requests or limits at all | `1000` |

There are two kinds of out-of-memory events, and they behave differently:

1. **Container OOM:** a container hits its own `memory.max`. The kernel kills a process inside that cgroup only. The rest of the node is unaffected.
2. **Node pressure:** the node itself runs low on memory. The kubelet starts **evicting** pods, BestEffort first, then Burstable pods using more than they requested. If memory runs out before the kubelet reacts, the kernel's global OOM killer picks a victim using `oom_score_adj`, which is why BestEffort processes go first and Guaranteed ones go last.

> [!TIP]
> Setting memory requests equal to memory limits is the most effective single change for predictable memory behaviour. It removes overcommit for that pod, so a neighbour's spike can't push the node into a global OOM that takes your pod with it.

## Seeing it on a real node

All of the following is read-only and safe on a production node.

Find a container's cgroup path:

```bash
# from the node
crictl ps --name my-app
crictl inspect <container-id> | jq -r '.info.runtimeSpec.linux.cgroupsPath'

# or from inside the container
cat /proc/self/cgroup
# 0::/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod..._slice/cri-containerd-....scope
```

Read the limits the kernel is actually enforcing:

```bash
cd /sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/<pod-slice>/<container-scope>

cat cpu.weight      # from the CPU request
cat cpu.max         # from the CPU limit
cat memory.max      # from the memory limit
cat pids.max
```

Check for CPU throttling:

```bash
cat cpu.stat
# usage_usec 912345678
# nr_periods 345678
# nr_throttled 12345      <- periods where the quota ran out
# throttled_usec 98765432 <- total time spent throttled
```

The same counters are exposed by cAdvisor, so you can alert on them in Prometheus:

```text
rate(container_cpu_cfs_throttled_periods_total[5m])
  / rate(container_cpu_cfs_periods_total[5m])
```

Check memory pressure and OOM kills:

```bash
cat memory.current     # current usage in bytes
cat memory.events      # look at the max, oom and oom_kill counters
cat memory.pressure    # PSI: share of time tasks were stalled waiting for memory
cat cpu.pressure       # PSI for CPU
```

PSI is one of the most useful things v2 added. `some avg10=12.50` means that over the last 10 seconds, at least one task in the cgroup was stalled 12.5% of the time. That is a much earlier warning than an OOM kill.

## Make the application cgroup-aware

The kernel enforces the limits, but the runtime inside the container still has to size itself to them:

- **JVM:** container support is on by default in JDK 10 and later, and in 8u191 and later. Size the heap with `-XX:MaxRAMPercentage` rather than a fixed `-Xmx` that ignores the limit.
- **Go:** from Go 1.25, `GOMAXPROCS` defaults to the cgroup CPU limit. On older versions it defaults to the number of host cores, which causes heavy throttling. Set it explicitly or use `go.uber.org/automaxprocs`.
- **Node.js:** set `--max-old-space-size` below the memory limit, leaving room for buffers and native memory.

## Practical takeaways

- Treat CPU requests as your guaranteed share and CPU limits as a throttle. Many teams drop CPU limits for latency-sensitive services and rely on accurate requests instead. Measure throttling before and after.
- Always set memory limits, and set memory requests equal to them for anything important.
- Alert on throttling ratio and `oom_kill` counts, not only on average CPU and memory usage.
- When something looks wrong, read the files. `cpu.max`, `memory.max` and `cpu.stat` tell you what the kernel is doing, which is not always what the YAML says.
