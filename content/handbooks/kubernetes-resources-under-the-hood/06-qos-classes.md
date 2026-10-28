---
title: "05 · QoS classes"
order: 7
summary: "See how Kubernetes classifies pods, where each class lives in the cgroup tree, and who the kernel kills first."
---

**Goal:** see how Kubernetes classifies pods, where each class lives in the cgroup tree, and who the kernel kills first.

Lab module: [`modules/05-qos-classes`](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood/tree/main/modules/05-qos-classes)

```bash
make 05-qos-classes
```

## Example output

From a real run on kind (kind adds a `kubelet-` prefix to every slice name):

```text
  pod              qosClass     oom_score_adj  cgroup slice on the node
  qos-guaranteed   Guaranteed   -997           kubelet.slice/kubelet-kubepods.slice/kubelet-kubepods-pod<uid>.slice
  qos-burstable    Burstable    996            kubelet.slice/kubelet-kubepods.slice/kubelet-kubepods-burstable.slice/kubelet-kubepods-burstable-pod<uid>.slice
  qos-besteffort   BestEffort   1000           kubelet.slice/kubelet-kubepods.slice/kubelet-kubepods-besteffort.slice/kubelet-kubepods-besteffort-pod<uid>.slice
```

The Burstable pod scores `996` because its 32Mi memory request is tiny compared with the node's memory. A bigger request would give a lower score.

## How the class is decided

| Class | Rule |
|---|---|
| **Guaranteed** | Every container has CPU **and** memory requests equal to its limits |
| **Burstable** | At least one container has a request or limit, but the pod isn't Guaranteed |
| **BestEffort** | No requests or limits anywhere |

## Internals

- **Cgroup placement:** Guaranteed pods get their own slice directly under `kubepods.slice`. Burstable and BestEffort pods are grouped under per-class slices, which the kubelet can squeeze as a group.
- **`oom_score_adj`:** when the *node* runs out of memory, the kernel's global OOM killer picks a victim by `oom_score`, adjusted by this value. Guaranteed `-997` goes last, BestEffort `1000` goes first, and Burstable is scaled by memory request: the larger the request relative to node memory, the lower the score.
- **Eviction:** before the kernel steps in, the kubelet evicts pods under node pressure, again BestEffort first (module 07).

## Takeaway

For anything important, set memory requests equal to limits. Even if CPU stays Burstable, a large memory request lowers the pod's `oom_score_adj` and protects it from noisy neighbours.
