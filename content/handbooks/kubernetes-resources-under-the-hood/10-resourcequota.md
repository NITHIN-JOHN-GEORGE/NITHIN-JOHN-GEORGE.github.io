---
title: "09 · ResourceQuota"
order: 11
summary: "Cap the total resources a namespace can request, and see the API server refuse pods that would go over."
---

**Goal:** cap the total resources a namespace can request, and see the API server refuse pods that would go over.

Lab module: [`modules/09-resourcequota`](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood/tree/main/modules/09-resourcequota)

```bash
make 09-resourcequota
```

The module creates namespace `lab-quota` with this quota:

```yaml
hard:
  requests.cpu: 500m
  requests.memory: 256Mi
  limits.memory: 512Mi
  pods: "3"
```

Then it tries three pods.

| Pod | Requests | Result |
|---|---|---|
| `q-no-requests` | none | Rejected: `must specify limits.memory ..., requests.cpu ..., requests.memory ...` |
| `q-small` | 200m / 100Mi | Created |
| `q-big` | 400m / 100Mi | Rejected: `exceeded quota: compute, requested: requests.cpu=400m, used: requests.cpu=200m, limited: requests.cpu=500m` |

The namespace is deleted on exit (`KEEP=1` keeps it).

## Example output

From a real run on kind:

```text
$ kubectl apply -f pod-no-requests.yaml
  pods "q-no-requests" is forbidden: failed quota: compute: must specify limits.memory for: main; requests.cpu for: main; requests.memory for: main
$ kubectl apply -f pod-small.yaml
  pod/q-small created
$ kubectl apply -f pod-big.yaml
  pods "q-big" is forbidden: exceeded quota: compute, requested: requests.cpu=400m, used: requests.cpu=200m, limited: requests.cpu=500m

  Resource         Used   Hard
  limits.memory    128Mi  512Mi
  pods             1      3
  requests.cpu     200m   500m
  requests.memory  100Mi  256Mi
```

## Internals

- **Enforced at admission, not at runtime.** The `ResourceQuota` admission plugin in the API server checks every create and update. A rejected pod never exists, so there's no event on it and nothing for the scheduler to see. With a Deployment, you find the error in the ReplicaSet's events (`FailedCreate`).
- **It counts declared numbers, not usage.** Quota adds up requests and limits from pod specs. A pod using 10x its request still counts as its request.
- **A quota on a resource makes it mandatory.** Once `requests.cpu` is in the quota, pods without a CPU request are rejected. A LimitRange (module 10) can fill in defaults so this doesn't break existing manifests.
- **Two controllers keep it accurate.** Admission adds usage when a pod is created; the quota controller recalculates `.status.used` periodically, which picks up deleted and finished pods.
- **Object counts too.** Quotas can also cap `pods`, `services`, `persistentvolumeclaims`, `count/deployments.apps` and more, and can be scoped to a priority class or QoS class with `scopeSelector`.
- **No cgroup is involved.** Nothing changes on the node.

## Takeaway

Quotas are how a shared cluster divides capacity between teams. They only work if requests are honest, so pair them with sensible defaults (module 10).
