---
title: "08 · Priority classes and preemption"
order: 10
summary: "See a high-priority pod remove a low-priority pod to make room for itself."
---

**Goal:** see a high-priority pod remove a low-priority pod to make room for itself.

Lab module: [`modules/08-priority-preemption`](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood/tree/main/modules/08-priority-preemption)

```bash
make 08-priority-preemption
```

The module creates two PriorityClasses, `lab-low` (1000) and `lab-high` (1000000). It measures the worker's free CPU and gives each pod a request just below it, so only one pod fits. `prio-low` is scheduled first; then `prio-high` arrives.

## Example output

From a real run on kind (10 CPUs, so each pod asked for 9800m):

```text
  allocatable 10000m   already requested 100m   free 9900m

  REASON      MESSAGE
  Scheduled   Successfully assigned lab/prio-low to under-the-hood-worker
  Started     Container started
  Preempted   Preempted by pod 2cb1a068-49ce-45ac-bd4b-1e19896e9808 on node under-the-hood-worker
  Killing     Stopping container main

  NAME        PRIORITY   STATUS    NODE
  prio-high   1000000    Running   under-the-hood-worker
  prio-low    1000       Failed    under-the-hood-worker
```

The `100m` already requested is kindnet, the CNI pod that runs on every kind node.

## What you should see

- `prio-low` gets a `Preempted` event with a message like `Preempted by pod <uid> on node under-the-hood-worker`, shows `Failed` and is deleted.
- `prio-high` becomes `Running` on the worker.
- `.spec.priority` on each pod holds the number from its class.

## Internals

- **Priority is a number on the pod.** The `Priority` admission plugin resolves `priorityClassName` and writes the value into `.spec.priority` when the pod is created. Changing the class later doesn't change existing pods.
- **The scheduling queue is ordered by priority.** Pending high-priority pods are tried before low-priority ones.
- **Preemption runs only when a pod can't be scheduled.** The scheduler looks for a node where removing lower-priority pods would make the pod fit, picks the victims that cause the least disruption, sets `.status.nominatedNodeName` on the preemptor, and deletes the victims gracefully.
- **PodDisruptionBudgets are respected on a best-effort basis.** The scheduler prefers victims that don't violate a PDB, but will violate one if there is no other way.
- **`preemptionPolicy: Never`** gives a pod a place near the front of the queue without letting it evict anyone.
- **Priority also feeds node-pressure eviction** (module 07): among pods using more than their requests, lower priority goes first.
- **No cgroup is involved.** Priority is purely a scheduler and kubelet decision. The kernel never sees it.

## Takeaway

Give critical workloads a PriorityClass, and keep the number of classes small. If everything is high priority, nothing is.
