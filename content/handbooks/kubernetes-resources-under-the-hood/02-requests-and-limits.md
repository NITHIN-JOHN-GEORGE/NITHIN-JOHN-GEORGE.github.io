---
title: "01 · Requests and limits become cgroup files"
order: 3
summary: "Prove that resources: is just a way of writing numbers into cgroup files."
---

**Goal:** prove that `resources:` is just a way of writing numbers into cgroup files.

Lab module: [`modules/01-requests-and-limits`](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood/tree/main/modules/01-requests-and-limits)

```bash
make 01-requests-and-limits
```

The pod asks for `250m`/`64Mi` and is limited to `500m`/`128Mi`.

## Example output

| Pod spec | cgroup file | Value | Meaning |
|---|---|---|---|
| `requests.cpu: 250m` | `cpu.weight` | a number > 1 | Relative share of CPU, only used when CPUs are contended |
| `limits.cpu: 500m` | `cpu.max` | `50000 100000` | 50ms of CPU time per 100ms period, across all threads |
| `limits.memory: 128Mi` | `memory.max` | `134217728` | Hard ceiling; above it the kernel OOM-kills inside this cgroup |
| `requests.memory: 64Mi` | `memory.min` | `0` | Not enforced by default. The scheduler uses it to place the pod |

## Internals

- The kubelet converts `requests.cpu` to the old v1 "shares" unit (`millicores × 1024 / 1000`, so `250m` → 256), and the runtime converts shares to `cpu.weight`. The exact formula depends on the runtime version, which is why this lab reads the file rather than computing it.
- `cpu.max` is `<quota> <period>` in microseconds. Quota is counted across **all** threads, which leads straight into module 02.
- The pod slice on the node holds the **sum** of its containers' limits, so a pod can never exceed what its containers declared in total.

Run with `KEEP=1 make 01-requests-and-limits` to leave the pod running and explore it yourself:

```bash
kubectl -n lab exec requests-limits -- ls /sys/fs/cgroup
```
