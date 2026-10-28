---
title: "12 · Pressure stall information (PSI)"
order: 14
summary: "Measure how much time a pod loses waiting for CPU, memory and IO, instead of how much it uses."
---

**Goal:** measure how much time a pod loses *waiting* for CPU, memory and IO, instead of how much it uses.

Lab module: [`modules/12-psi`](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood/tree/main/modules/12-psi)

```bash
make 12-psi
```

Two pods run on the worker:

| Pod | What it does | Expected pressure |
|---|---|---|
| `psi-cpu` | 2 × nproc busy loops, no CPU limit | High `cpu.pressure` |
| `psi-memory` | Rereads a 192 MiB file with a 64Mi memory limit, so its page cache is reclaimed constantly | Some `memory.pressure` and `io.pressure` |

The module prints `cpu.pressure`, `memory.pressure` and `io.pressure` from inside each container, and `/proc/pressure/cpu` for the whole node before and during the run. If the kernel doesn't support PSI, the module prints `SKIP`.

## Reading the files

```text
some avg10=97.12 avg60=61.30 avg300=17.80 total=31847213
full avg10=0.00 avg60=0.00 avg300=0.00 total=0
```

- **`some`:** the share of time at least one task in the cgroup was stalled on this resource.
- **`full`:** the share of time *all* non-idle tasks were stalled at once, so the cgroup made no progress at all.
- **`avg10` / `avg60` / `avg300`:** moving averages over 10 s, 60 s and 5 min, as a percentage.
- **`total`:** cumulative stall time in microseconds. Use it to compute your own rates.

## Internals

- **Usage and pressure are different questions.** `cpu.stat` (module 02) says how much CPU a pod got. `cpu.pressure` says how long its threads sat runnable without getting a CPU. A pod at 100% usage with zero pressure is fine; a pod at 30% usage with high pressure is starved.
- **CPU pressure** comes from contention on the run queue: runnable threads waiting for a CPU.
- **Memory pressure** is time spent in direct reclaim, waiting for pages to be freed, or refaulting pages that were evicted too early. It rises well before an OOM kill.
- **IO pressure** is time spent waiting for block IO, which reclaim of dirty pages often triggers.
- **Where it's used:** systemd-oomd and Meta's oomd kill based on memory pressure. Kubernetes has a `KubeletPSI` feature that exposes these numbers through the Summary API and cAdvisor metrics, so you can graph and alert on them.

## Takeaway

When a pod is slow but its CPU and memory graphs look fine, check pressure. PSI tells you whether it's waiting, which utilisation can't.
