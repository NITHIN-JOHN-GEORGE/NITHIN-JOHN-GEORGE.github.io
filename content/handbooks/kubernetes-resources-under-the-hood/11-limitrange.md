---
title: "10 · LimitRange"
order: 12
summary: "Give containers default requests and limits, and reject values outside an allowed range."
---

**Goal:** give containers default requests and limits, and reject values outside an allowed range.

Lab module: [`modules/10-limitrange`](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood/tree/main/modules/10-limitrange)

```bash
make 10-limitrange
```

The module creates namespace `lab-limits` with this LimitRange:

```yaml
- type: Container
  defaultRequest: {cpu: 100m, memory: 64Mi}
  default:        {cpu: 200m, memory: 128Mi}
  max:            {memory: 256Mi}
  min:            {memory: 32Mi}
```

## Example output

From a real run on kind:

```text
$ kubectl -n lab-limits get pod lr-defaults -o jsonpath='{.spec.containers[0].resources}'
  {"limits":{"cpu":"200m","memory":"128Mi"},"requests":{"cpu":"100m","memory":"64Mi"}}

  kubernetes.io/limit-ranger: LimitRanger plugin set: cpu, memory request for container main; cpu, memory limit for container main

  cpu.max     20000 100000
  memory.max  134217728

  pods "lr-too-big" is forbidden: maximum memory usage per Container is 256Mi, but limit is 512Mi
```

## What you should see

- `lr-defaults` is created **without** a `resources` section, but its spec comes back with requests `100m`/`64Mi` and limits `200m`/`128Mi`.
- An annotation `kubernetes.io/limit-ranger: LimitRanger plugin set: cpu, memory request ...; cpu, memory limit ...` records what was filled in.
- Inside the container, `cpu.max` is `20000 100000` and `memory.max` is `134217728`, exactly as if you had written the values yourself.
- `lr-too-big` (512Mi limit) is rejected with `maximum memory usage per Container is 256Mi, but limit is 512Mi`.

The namespace is deleted on exit (`KEEP=1` keeps it).

## Internals

- **Mutating, then validating.** The `LimitRanger` admission plugin first fills in missing values (`default`, `defaultRequest`), then checks `min`, `max` and `maxLimitRequestRatio`. Both happen in the API server before the pod is stored.
- **Defaults are written into the stored pod.** The kubelet and runtime don't know a LimitRange exists. They see an ordinary spec, which is why the cgroup files match.
- **Only new pods are affected.** Changing a LimitRange doesn't touch running pods.
- **If only a limit is set,** the API server's defaulting copies it into the request before LimitRanger runs, so the request equals the limit, not `defaultRequest`.
- **Types:** `Container` (per container), `Pod` (sum over containers, `min`/`max` only) and `PersistentVolumeClaim` (storage size).
- **Pairs with ResourceQuota.** A quota on `requests.cpu` rejects pods that don't set one (module 09); a LimitRange default makes them pass.

## Takeaway

Put a LimitRange in every shared namespace so that no container runs without requests, and so a typo like `memory: 512Gi` is rejected.
