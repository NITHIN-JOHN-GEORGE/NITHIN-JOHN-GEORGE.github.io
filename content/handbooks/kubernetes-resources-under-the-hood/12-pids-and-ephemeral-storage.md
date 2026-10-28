---
title: "11 · PIDs and ephemeral storage"
order: 13
summary: "See two limits that are easy to forget: how many processes a pod may run, and how much local disk it may use."
---

**Goal:** see two limits that are easy to forget: how many processes a pod may run, and how much local disk it may use.

Lab module: [`modules/11-pids-and-ephemeral-storage`](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood/tree/main/modules/11-pids-and-ephemeral-storage)

```bash
make 11-pids-and-ephemeral-storage
```

> [!WARNING]
> **The PID part changes the worker's kubelet config.** It sets `podPidsLimit: 64`, restarts the kubelet, runs the test and restores the original config straight away (also on failure or Ctrl-C).

## Part 1: PIDs

`pid-hog` tries to start 100 background processes as soon as it starts. The spawner runs in a subshell, so when a fork is refused only the subshell gives up and the pod keeps running.

What you should see:

- The pod's log stops short of `started 100`, with a `can't fork: Resource temporarily unavailable` error.
- On the node, the pod's cgroup has `pids.max` = `64`, `pids.current` at or below 64, and a non-zero `max` count in `pids.events`.

### Internals

- **This one is a real cgroup controller.** The `pids` controller counts tasks (processes and threads) in the cgroup. When a `fork()` or `clone()` would go past `pids.max`, the kernel returns `EAGAIN`.
- **The limit is per pod and set by the kubelet,** not in the pod spec. `podPidsLimit` applies to every pod on the node. The pause container and every thread count too.
- **Why it matters:** PIDs are a node-wide resource. Without a limit, one fork bomb or thread leak can use up the node's PID space and break the kubelet, the runtime and every other pod.
- The kubelet can also reserve PIDs for the system with `systemReserved: {pid: ...}` and evict pods on `pid.available` pressure.

## Part 2: Ephemeral storage

`disk-hog` has `limits.ephemeral-storage: 50Mi` and writes 100 MiB into an `emptyDir`.

What you should see:

- Within a minute or so the pod is `Evicted` with a message like `Pod ephemeral local storage usage exceeds the total limit of containers 50Mi.`

### Internals

- **There is no cgroup for disk space.** The kubelet enforces this limit itself: it periodically measures each container's writable layer, its logs and its `emptyDir` volumes, and evicts the pod when the total goes over.
- **It's a measurement loop, not a hard wall.** The write succeeds; the eviction comes later. A fast writer can briefly use more than its limit.
- **Requests matter for scheduling.** `requests.ephemeral-storage` is compared with the node's allocatable `ephemeral-storage` (module 06), just like CPU and memory.
- **`emptyDir.sizeLimit`** caps a single volume in the same way. `emptyDir: {medium: Memory}` is a tmpfs and counts against the pod's memory instead.

## Takeaway

Set a `podPidsLimit` on every node pool, and give pods that write to local disk an `ephemeral-storage` limit. Both protect the node rather than the pod.
