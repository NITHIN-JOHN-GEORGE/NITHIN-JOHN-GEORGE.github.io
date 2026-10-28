---
title: "13 · In-place pod resize"
order: 15
summary: "Change a running pod's CPU and memory without restarting it, and watch the cgroup files change underneath."
---

**Goal:** change a running pod's CPU and memory without restarting it, and watch the cgroup files change underneath.

Lab module: [`modules/13-in-place-resize`](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood/tree/main/modules/13-in-place-resize)

```bash
make 13-in-place-resize
```

Needs Kubernetes 1.33 or newer (the feature is on by default from 1.33) and kubectl 1.32 or newer. On older clusters the module prints `SKIP`.

`resize-demo` starts as a Guaranteed pod with `200m`/`64Mi`. The module resizes it to `500m`/`128Mi`:

```bash
kubectl -n lab patch pod resize-demo --subresource resize --patch \
  '{"spec":{"containers":[{"name":"main","resources":{"requests":{"cpu":"500m","memory":"128Mi"},"limits":{"cpu":"500m","memory":"128Mi"}}}]}}'
```

## Example output

From a real run on kind (Kubernetes 1.37):

```text
$ cgroup files before (200m / 64Mi)
  container  cpu.max 20000 100000   memory.max 67108864   cpu.weight 29
  pod        cpu.max 20000 100000   memory.max 67108864
$ kubectl -n lab patch pod resize-demo --subresource resize --patch '...'
  pod/resize-demo patched
$ cgroup files after (500m / 128Mi)
  container  cpu.max 50000 100000   memory.max 134217728  cpu.weight 59
  pod        cpu.max 50000 100000   memory.max 134217728

  spec    limits {"cpu":"500m","memory":"128Mi"}
  status  limits {"cpu":"500m","memory":"128Mi"}
  restartCount 0
```

## What you should see

| File | Before | After |
|---|---|---|
| `cpu.max` | `20000 100000` | `50000 100000` |
| `memory.max` | `67108864` | `134217728` |
| `cpu.weight` | lower | higher (the request went up too) |

- `restartCount` stays `0` and the container ID doesn't change.
- `.spec` shows what you asked for; `.status.containerStatuses[].resources` shows what the kubelet has applied.

## Internals

- **A separate subresource.** Resizes go through `pods/resize`, so RBAC can allow resizing without allowing other pod edits. Before 1.33, the pod's resources were immutable.
- **The kubelet does the work.** It checks the new values fit the node's allocatable, then calls the runtime's `UpdateContainerResources`, which rewrites `cpu.max`, `cpu.weight` and `memory.max` of the running container and the pod slice.
- **If it doesn't fit,** the pod gets a `PodResizePending` condition (reason `Deferred` or `Infeasible`) and keeps its old resources. While the change is being applied, there's a `PodResizeInProgress` condition.
- **`resizePolicy`** decides per resource whether a change needs a container restart. `NotRequired` (the default) updates the cgroup live. `RestartContainer` suits apps that read their memory size only at startup, such as a JVM with a fixed heap.
- **QoS class can't change.** A Guaranteed pod must stay Guaranteed, which is why this demo raises requests and limits together.
- **Shrinking memory is careful.** The kubelet won't lower `memory.max` below current usage, so a decrease can stay in progress until the app frees memory.

## Takeaway

Vertical scaling no longer means a restart. This is what lets the Vertical Pod Autoscaler's `InPlaceOrRecreate` mode adjust pods without evicting them.
