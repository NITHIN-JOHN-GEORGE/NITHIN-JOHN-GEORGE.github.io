---
title: "03 · CPU weight under contention"
order: 5
summary: "See what a CPU request actually does at runtime."
---

**Goal:** see what a CPU *request* actually does at runtime.

Lab module: [`modules/03-cpu-weight`](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood/tree/main/modules/03-cpu-weight)

```bash
make 03-cpu-weight
```

Two pods, no CPU limits, each running one busy loop per CPU on the node, so the node is fully contended. `weight-low` requests `100m`, `weight-high` requests `800m`.

## Example output

From a 10-CPU Docker Desktop VM:

```text
  cpu.weight 17   cpu.max max 100000      # weight-low,  request 100m
  cpu.weight 84   cpu.max max 100000      # weight-high, request 800m

  CPU split high/low           8.2x
  request ratio                8.0x  (800m / 100m)
  cpu.weight ratio             4.9x  (84 / 17)
```

## Internals

- A CPU request is **not** a reservation. It becomes `cpu.weight`, a relative share.
- With idle CPUs, weight does nothing: any pod can use spare CPU (module 02's unlimited pod).
- Under contention the kernel's scheduler divides CPU time between the competing cgroups by weight, so the bigger request wins a bigger share.
- **Surprise from a real run:** `cpu.weight` is not proportional to the request. `100m` became `17` and `800m` became `84` (4.9x), because newer container runtimes convert the old CPU "shares" value to `cpu.weight` with a non-linear formula. The measured CPU split still came out close to the request ratio. Read the files on your own cluster rather than assuming a formula.
- The scheduler also uses requests to decide where a pod fits. Setting requests too low causes noisy neighbours; too high wastes capacity.

## Takeaway

Requests protect you when the node is busy; limits throttle you even when it isn't. Many teams set accurate CPU requests and drop CPU limits for latency-sensitive services.
