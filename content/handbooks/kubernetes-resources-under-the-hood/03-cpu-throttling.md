---
title: "02 · CPU throttling"
order: 4
summary: "Watch a CPU limit throttle a container even while the node has idle CPUs."
---

**Goal:** watch a CPU limit throttle a container even while the node has idle CPUs.

Lab module: [`modules/02-cpu-throttling`](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood/tree/main/modules/02-cpu-throttling)

```bash
make 02-cpu-throttling
```

Two pods each run 4 busy loops with the same `100m` request. Only `cpu-limited` has `limits.cpu: 200m`.

## Example output

```text
$ kubectl -n lab exec cpu-limited -- cat /sys/fs/cgroup/cpu.max
20000 100000
$ kubectl -n lab exec cpu-unlimited -- cat /sys/fs/cgroup/cpu.max
max 100000

  pod            periods          throttled      CPU used (millicores)
  cpu-limited    250              ~250           ~200
  cpu-unlimited  -                0              several thousand
```

The limited pod is throttled in almost every 100ms period. The exact numbers depend on how many CPUs Docker has.

## Internals

- `limits.cpu: 200m` becomes `cpu.max = 20000 100000`: 20ms of CPU time per 100ms period.
- The quota is shared by **all threads**. Four busy threads burn through 20ms in about 5ms of wall-clock time, then the whole cgroup is paused for the remaining ~95ms. That pause is a *throttled period*.
- `cpu.stat` counts it: `nr_periods`, `nr_throttled` and `throttled_usec`.
- The unlimited pod's request only sets a weight. With no contention, weight doesn't matter and it takes all the idle CPU it wants.

## Why it matters in production

Throttling hits latency, not average CPU. A service can show 30% average CPU yet still get throttled in most periods, because it uses its quota in short bursts. Alert on the throttling ratio:

```text
rate(container_cpu_cfs_throttled_periods_total[5m]) / rate(container_cpu_cfs_periods_total[5m])
```

Try it: `SAMPLE=30 KEEP=1 make 02-cpu-throttling`, then `kubectl -n lab exec cpu-limited -- cat /sys/fs/cgroup/cpu.stat`.
