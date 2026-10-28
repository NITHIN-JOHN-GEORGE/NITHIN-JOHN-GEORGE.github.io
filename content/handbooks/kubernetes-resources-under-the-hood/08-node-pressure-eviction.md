---
title: "07 · Node-pressure eviction"
order: 9
summary: "Watch the kubelet evict a pod because the node is low on memory, before the kernel OOM killer gets involved."
---

**Goal:** watch the kubelet evict a pod because the *node* is low on memory, before the kernel OOM killer gets involved.

Lab module: [`modules/07-node-pressure-eviction`](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood/tree/main/modules/07-node-pressure-eviction)

```bash
make 07-node-pressure-eviction
```

> [!WARNING]
> **This module changes the worker's kubelet config.** It backs up `/var/lib/kubelet/config.yaml`, raises the `memory.available` eviction threshold so the node is about 600Mi away from pressure, and restarts the kubelet. The original config is restored on exit, including on failure or Ctrl-C.

Three pods run on the worker:

| Pod | QoS | Memory |
|---|---|---|
| `memory-hog` | BestEffort | Grows to 1000 MiB, no requests |
| `calm-burstable` | Burstable | Requests 32Mi, uses a few |
| `calm-guaranteed` | Guaranteed | 32Mi request and limit |

## Example output

From a real run on kind:

```text
  7741Mi  (MemTotal minus the node cgroup's working set)
  "evictionHard":{"imagefs.available":"0%","memory.available":"7141Mi",...}

  status=True  reason=KubeletHasInsufficientMemory

  NAME              READY   STATUS    RESTARTS   AGE
  calm-burstable    1/1     Running   0          17s
  calm-guaranteed   1/1     Running   0          17s
  memory-hog        0/1     Error     0          17s

  The node was low on resource: memory. Threshold quantity: 7141Mi, available: 7191604Ki.
  Container main was using 721996Ki, request is 0, has larger consumption of memory.
```

The hog was evicted at about 700 MiB, once available memory fell to within roughly 50Mi of the threshold. Note `request is 0`: that's why it ranked first.

## What you should see

- The worker's `MemoryPressure` condition turns `True`. A few seconds later the control plane adds a `node.kubernetes.io/memory-pressure:NoSchedule` taint, so it may not appear in the output yet.
- `memory-hog` ends in `Failed` with reason `Evicted` and a message like `The node was low on resource: memory. Threshold quantity: ..., available: ...`.
- Both calm pods keep running.

If the hog isn't evicted on your machine, run with a smaller margin: `MARGIN_MI=400 make 07-node-pressure-eviction`.

## Two different things kill pods for memory

| | Container limit (module 04) | Node pressure (this module) |
|---|---|---|
| Who acts | The kernel, inside one cgroup | The kubelet |
| Trigger | Container hits `memory.max` | Node `memory.available` drops below `evictionHard` |
| Result | `OOMKilled`, container restarts | Pod `Evicted`, phase `Failed`, not restarted on that node |
| Victim | The process that exceeded its limit | Ranked across all pods on the node |

## Internals

- **How `memory.available` is measured:** node capacity minus the *working set* of the node's root cgroup, where working set is `memory.current - inactive_file`. Page cache that can be dropped easily doesn't count. The kubelet checks every 10 seconds by default.
- **Who goes first:** pods whose usage is above their requests, then by priority (module 08), then by how far above requests they are. BestEffort pods have zero requests, so any usage is "above requests".
- **Hard vs soft thresholds:** `evictionHard` acts immediately with no grace period. `evictionSoft` waits for `evictionSoftGracePeriod` and honours the pod's termination grace period.
- **`evictionPressureTransitionPeriod`** (default 5m, set to 10s here) is how long the condition stays `True` after usage recovers. It stops the node from flapping in and out of pressure.
- **The kernel is the last resort.** If memory runs out faster than the kubelet's 10-second loop, the kernel's global OOM killer acts first and uses `oom_score_adj` from module 05.

## Takeaway

Requests are what protect a pod during node pressure. A pod that stays within its memory request is near the bottom of the eviction list.
