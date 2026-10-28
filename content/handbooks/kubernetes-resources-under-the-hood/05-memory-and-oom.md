---
title: "04 · Memory limits and OOM kills"
order: 6
summary: "Trigger a real OOM kill and find the evidence in the kernel's counters."
---

**Goal:** trigger a real OOM kill and find the evidence in the kernel's counters.

Lab module: [`modules/04-memory-and-oom`](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood/tree/main/modules/04-memory-and-oom)

```bash
make 04-memory-and-oom
```

A Python container allocates 10 MiB every 0.3s with `limits.memory: 64Mi`.

## Example output

From a real run:

```text
allocated 40 MiB
allocated 50 MiB
allocated 60 MiB
  reason=OOMKilled  exitCode=137  restarts=1

$ cat .../kubelet-kubepods-burstable-pod<uid>.slice/memory.events
  low 0
  high 0
  max 75
  oom 2
  oom_kill 4
  oom_group_kill 2

$ cat .../memory.max
  67108864
```

`oom_group_kill` appears because, on cgroups v2, the kubelet (since Kubernetes 1.28) enables `memory.oom.group` on the container cgroup: when one process is OOM-killed, the kernel kills the whole container's process group together, so no half-dead process lingers.

## Internals

- `limits.memory` becomes `memory.max`. When usage reaches it, the kernel first tries to reclaim memory (mostly page cache). If it can't, it runs the OOM killer **inside that cgroup only**. The rest of the node is unaffected.
- Exit code `137` = `128 + 9`: SIGKILL. The container gets no chance to clean up.
- The kubelet sees the kill and reports `OOMKilled`, then restarts the container according to `restartPolicy`, with growing back-off (`CrashLoopBackOff`).
- `memory.events` keeps the evidence: `max` (times the limit was hit), `oom` and `oom_kill`. At the pod level it is hierarchical, so it survives container restarts.
- The memory **request** is not enforced. It only influences scheduling and, under node pressure, eviction order (modules 05 and 07).

## Production tips

- Size limits from observed peak usage plus headroom, not from averages.
- Make runtimes container-aware: `-XX:MaxRAMPercentage` for the JVM, `--max-old-space-size` for Node.js.
- Alert on `kube_pod_container_status_last_terminated_reason{reason="OOMKilled"}`.
