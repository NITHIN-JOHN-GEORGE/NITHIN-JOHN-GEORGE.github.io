---
title: "06 · Node allocatable and reservations"
order: 8
summary: "See what part of a node the scheduler can hand out to pods, and what happens when a pod asks for more."
---

**Goal:** see what part of a node the scheduler can hand out to pods, and what happens when a pod asks for more.

Lab module: [`modules/06-node-allocatable`](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood/tree/main/modules/06-node-allocatable)

```bash
make 06-node-allocatable
```

The module prints the worker's capacity and allocatable, the kubelet's reservation settings, and the memory ceiling of the whole pod tree. Then it creates a pod that requests 1Gi more memory than the worker's allocatable.

## Example output

From a real run on kind (Docker Desktop with 10 CPUs and about 8 GiB):

```text
  resource           capacity       allocatable
  cpu                10             10
  memory             8126480Ki      8126480Ki
  pods               110            110

  systemReserved
  kubeReserved
  evictionHard             {"imagefs.available":"0%","nodefs.available":"0%","nodefs.inodesFree":"0%"}
  enforceNodeAllocatable   ["pods"]

$ docker exec under-the-hood-worker cat /sys/fs/cgroup/kubelet.slice/kubelet-kubepods.slice/memory.max
  8321515520

  too-big   0/1     Pending
  0/2 nodes are available: 1 Insufficient memory, 1 node(s) had untolerated taint(s). ...
```

kind sets no memory eviction threshold, so allocatable equals capacity here. `8321515520` bytes is exactly `8126480Ki`: with no reservations the pod tree's ceiling is the whole node. The "untolerated taint" is the control-plane node, which doesn't accept ordinary pods.

## What you should see

- On kind, `allocatable` equals `capacity`: kind sets no `systemReserved`, no `kubeReserved` and no memory eviction threshold. On a managed cluster (GKE, EKS) you'll see a gap of several hundred MiB or more.
- The pod stays `Pending` with a `PodScheduled` message such as `0/2 nodes are available: 1 Insufficient memory, ...`.

## The formula

```text
allocatable = capacity - systemReserved - kubeReserved - evictionHard
```

| Setting | Protects |
|---|---|
| `systemReserved` | The OS: systemd, sshd, journald |
| `kubeReserved` | Kubernetes daemons: kubelet and the container runtime |
| `evictionHard` | A safety margin. The kubelet starts evicting pods before the node reaches zero |

## Internals

- **The scheduler only uses requests.** It sums the requests of the pods on a node and compares them with `allocatable`. Real usage plays no part, which is why a node can be "full" while idle, or overloaded while "empty".
- **The pod tree has a cgroup ceiling.** With `enforceNodeAllocatable: [pods]` (the default), the kubelet writes `capacity - systemReserved - kubeReserved` to the `memory.max` of the `kubepods` slice. The eviction threshold is not included in that number; the kubelet enforces it by evicting pods instead (module 07).
- **Reservations only become cgroup limits if you ask.** Adding `system-reserved` or `kube-reserved` to `enforceNodeAllocatable` makes the kubelet cap those slices too. Most clusters don't, because capping the kubelet itself is risky.

## Takeaway

On a real cluster, set `systemReserved` and `kubeReserved`. Without them the scheduler will fill the node right up to the memory the OS and kubelet need.
