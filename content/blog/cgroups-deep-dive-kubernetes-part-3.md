---
title: "Cgroups: A Deep Dive into Resource Management in Kubernetes – Part 3: Memory"
date: 2026-10-28
summary: Part 3 of 3. Memory limits and OOM kills, why dashboards miss them, what happens when a node runs short, the memory metrics to watch in production, and resizing a running pod. Plus a cheat sheet and glossary for the series.
tags: [linux, kubernetes, cgroups]
---

> [!NOTE]
> **A three-part series.** [Part 1: Foundations](/blog/cgroups-deep-dive-kubernetes-part-1/) · [Part 2: CPU](/blog/cgroups-deep-dive-kubernetes-part-2/) · **Part 3: Memory** (you're here)

In [Part 1](/blog/cgroups-deep-dive-kubernetes-part-1/) we saw that Kubernetes writes your `resources:` block into cgroup files that the kernel enforces. In [Part 2](/blog/cgroups-deep-dive-kubernetes-part-2/) we saw how CPU limits make a container wait, sometimes badly enough to fail its health checks.

Memory is different. The kernel can't make a program wait for memory it already holds, so when memory runs out, something has to die. This part answers the other promise from the start of the series: why a pod can be OOM-killed while the dashboard says it had room to spare.

> [!TLDR]
> - A memory limit can't make you wait. At the limit the kernel reclaims file cache, then OOM-kills: exit code 137.
> - File cache counts towards memory use but can be dropped; memory a program allocates can't. Watch the **working set**, not `memory.current`.
> - When the whole node runs short, the kubelet evicts first and the kernel kills last. Pods using more than they requested go first.
> - In production, watch the working set against the limit, `oom_kill` counts and memory pressure. `memory.current` includes cache and misleads.

**In this part:**

- **Memory limits**: OOM kills, and why the dashboard said there was room.
- **Node pressure**: what happens when the whole node runs short.
- **In production**: the memory numbers to watch, and the ones that lie.
- **Beyond CPU and memory**: the other limits, and a finale where you resize a running pod.

> [!TIP]
> **The core path.** If you follow one thread through this part, make it this one: `memory.max` (your ceiling in bytes) → **reclaim** (cache dropped first) → **OOM kill** (exit 137) → `memory.events` (the counters that record it) → the **working set** (the number to watch) → **eviction** (when the whole node runs short). The "Going deeper" boxes and the pressure section are optional on a first read.

To follow along, [set up the lab](/blog/cgroups-deep-dive-kubernetes-part-1/#set-up-the-lab-5-minutes) from Part 1 first.

---

## Memory limits

CPU can make you wait. [Memory can't](/blog/cgroups-deep-dive-kubernetes-part-1/#6-why-cpu-limits-slow-you-down-but-memory-limits-kill-you), so it fails in a completely different way.

### 16. Memory limits and the OOM killer

*Question: what happens when a container reaches `memory.max`?*

Kubernetes didn't kill your OOMKilled pod. The Linux kernel did, because of one number in one file: `memory.max`.

**From `limits.memory` to `memory.max`.** Memory is simpler than CPU: no shares, no periods. The kubelet writes your limit straight into `memory.max`, in bytes:

| You write | The container's file | Value | In plain words |
|---|---|---|---|
| `limits.memory: 64Mi` | `memory.max` | `67108864` | 64 × 1024 × 1024 bytes |
| `limits.memory: 128Mi` | `memory.max` | `134217728` | 128 × 1024 × 1024 bytes |
| no memory limit | `memory.max` | `max` | no ceiling |
| `requests.memory: 64Mi` | nothing, by default | `memory.min` stays `0` | used to place the pod and to [pick who gets evicted](#18-when-the-whole-node-runs-short) |

**What happens at the limit.** CPU can make a program wait, but memory can't be handed out later: a program that needs more memory than its box allows can't just pause until some frees up. So when a cgroup reaches `memory.max`:

1. **The kernel reclaims first.** It frees memory it can safely drop, such as [cached file data](#17-not-all-memory-is-equal). The program may slow down while this happens.
2. **If that isn't enough, the OOM killer steps in.** On cgroups v2, since Kubernetes 1.28 the kubelet sets `memory.oom.group = 1` on each container, so the kernel kills **every process in the container together**, not just one. Nothing is left half-alive.

{{oom}}

#### Try it yourself: hit memory.max

`memory-hog` has a `64Mi` limit and a small program that grabs 10 MiB every 0.3 seconds and never lets go.

```bash
kubectl -n lab apply -f labs/16-memory-limits-and-oom/pod.yaml
sleep 20
kubectl -n lab get pod memory-hog
```

<details class="predict"><summary><span class="predict-tag">Predict first</span> The limit is 64 MiB and the program grows by 10 MiB at a time. Will it ever get to report 64 MiB?</summary><div class="predict-answer"><p>No. It dies before reaching the limit, because the program's own runtime lives in the same box and uses memory too.</p></div></details>

```
NAME         READY   STATUS    RESTARTS      AGE
memory-hog   1/1     Running   2 (16s ago)   21s
```

Two restarts in 20 seconds. Look at what it printed before it died, and how it died:

```bash
kubectl -n lab logs memory-hog --previous | tail -3
kubectl -n lab get pod memory-hog -o jsonpath='{.status.containerStatuses[0].lastState.terminated.reason} exit={.status.containerStatuses[0].lastState.terminated.exitCode}{"\n"}'
```

```
allocated 30 MiB
allocated 40 MiB
allocated 50 MiB
OOMKilled exit=137
```

**Exit code 137** means "killed by a signal": 128 plus the signal number, and signal 9 is `SIGKILL`, the one a program can't catch or ignore. It gets no chance to clean up or write a last log line.

The kernel keeps its own tally in the pod's `memory.events`:

```bash
docker exec under-the-hood-worker cat "$(./scripts/pod-cgroup.sh memory-hog)/memory.events"
```

```
low 0
high 0
max 59
oom 2
oom_kill 4
oom_group_kill 2
```

| Line | Meaning |
|---|---|
| `max` | Times usage hit `memory.max` and the kernel had to reclaim: 59 |
| `oom` | Times reclaim wasn't enough: 2, one per restart |
| `oom_kill` | Processes the kernel killed: 4, more than one per OOM, because the whole container goes |
| `oom_group_kill` | Times it killed a whole container at once: 2 |
| `low`, `high` | [Softer limits](#17-not-all-memory-is-equal) Kubernetes doesn't set by default |

**What to take away:** a memory limit is a hard ceiling in bytes. At the limit, the kernel reclaims what it can, and if that's not enough it kills the whole container: exit code 137, no warning. `memory.events` counts every time it happens, even when your dashboard misses it.

---

### 17. Not all memory is equal

*Question: how can a pod be OOM-killed while the dashboard said it had room to spare?*

Because "memory use" on most dashboards mixes **two kinds of memory**, and only one of them can get you killed.

{{mem_kinds}}

| Kind | In `memory.stat` | What it is | Can the kernel take it back? |
|---|---|---|---|
| **Anonymous** | `anon` | Memory a program asked for: variables, heap, buffers | No. Only by killing the program |
| **File cache** | `file` | Copies of file data kept in memory so the next read is fast | Yes. It can drop it and read the file again |

Both count towards `memory.current`, and both count towards `memory.max`. But when the box is full, the kernel drops file cache first. Only when nothing droppable is left does it kill.

#### Try it yourself: fill the box twice

`mem-lab` has a `128Mi` limit. First fill it with **file cache**: the lab's `cache` command writes a 192 MiB file and reads it back.

```bash
kubectl -n lab apply -f labs/17-not-all-memory-is-equal/pod.yaml
kubectl -n lab wait --for=condition=Ready pod/mem-lab
kubectl -n lab exec mem-lab -- cache --mib 192
kubectl -n lab exec mem-lab -- cat /sys/fs/cgroup/memory.current
kubectl -n lab exec mem-lab -- grep -E '^(anon|file|inactive_file) ' /sys/fs/cgroup/memory.stat
```

<details class="predict"><summary><span class="predict-tag">Predict first</span> You just pushed 192 MiB of files through a 128 MiB box. Was it OOM-killed?</summary><div class="predict-answer"><p>No. It was all file cache, which the kernel can drop whenever it needs room.</p></div></details>

```
131428352
anon 667648
file 128032768
inactive_file 128032768
```

The box is full: `memory.current` is **125 MiB**, right at the limit. But **122 MiB is file cache** and **under 1 MiB is anonymous**. The pod's `memory.events` says the kernel hit the limit 1,814 times, and never killed anything:

```bash
docker exec under-the-hood-worker cat "$(./scripts/pod-cgroup.sh mem-lab)/memory.events"
```

```
low 0
high 0
max 1814
oom 0
oom_kill 0
oom_group_kill 0
```

Each time, it dropped some old cache and carried on. The container is "at its limit", and perfectly fine.

Now fill it with memory a program **holds**. The lab's `alloc` command grabs 16 MiB at a time and never lets go:

```bash
kubectl -n lab exec mem-lab -- alloc --mib 16 --every 100ms
kubectl -n lab get pod mem-lab -o jsonpath='restarts={.status.containerStatuses[0].restartCount} reason={.status.containerStatuses[0].lastState.terminated.reason}{"\n"}'
```

```
allocated 16 MiB
allocated 32 MiB
allocated 48 MiB
allocated 64 MiB
allocated 80 MiB
allocated 96 MiB
allocated 112 MiB
command terminated with exit code 137
restarts=1 reason=OOMKilled
```

And `memory.events` now says `oom 1` and `oom_group_kill 1`. There was no cache left to drop, only memory a running program was holding, so the only way to stay under the limit was to kill it.

#### The working set: the number that matters

Because file cache inflates `memory.current`, the kubelet and most dashboards use the **working set** instead:

```
working set = memory.current − inactive_file
```

`inactive_file` is cache that hasn't been touched recently, the first thing the kernel drops. In the cache run: **125.3 − 122.1 = 3.2 MiB**. Same container, same moment: "full" by one number, nearly empty by the other. The working set is behind `kubectl top` and `container_memory_working_set_bytes`, and it's what [eviction](#18-when-the-whole-node-runs-short) looks at.

#### So why did the dashboard say there was room?

Usually one of three reasons, and now you can tell them apart:

1. **A short spike.** Most dashboards sample memory every 15 to 60 seconds, but the kernel reacts as soon as usage reaches `memory.max`. A spike between two samples never shows on the graph.
2. **The wrong denominator.** Many panels show memory as a share of the *request* or of the node, not of the limit.
3. **The wrong kind of memory.** A graph of `memory.current` mixes in reclaimable cache; a graph of the working set doesn't. They can tell very different stories.

`memory.events` doesn't miss anything, so when in doubt, trust it over the graph.

> [!DEEPER]
> **`memory.high` and `memory.min`**
>
> Every cgroup also has a soft limit and a protection setting:
> - `memory.high`: above it, the kernel slows the cgroup down and reclaims hard, but doesn't kill.
> - `memory.min`: memory the kernel protects for this cgroup even when the whole machine is short.
>
> By default Kubernetes sets neither (they read `max` and `0`). The `MemoryQoS` feature can: it's beta and switched on by default since Kubernetes 1.37, but on its own it still writes neither file. You opt in through the kubelet's config. `memoryReservationPolicy: TieredReservation` protects Guaranteed pods' requests with `memory.min` (and Burstable pods' with the softer `memory.low`), and setting `memoryThrottlingFactor` gives Burstable and BestEffort containers a `memory.high` below their limit, so they slow down before they get killed. That's why the lab, on 1.37, still shows `memory.min` as `0`.

**What to take away:** file cache counts towards your limit but can be dropped; memory your program holds can't, and that's what gets OOM-killed. Watch the working set, not `memory.current`.

#### The labs for this stage

| Lab | What you'll do | Time | Check your work |
|---|---|---|---|
| [16](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood/tree/main/labs/16-memory-limits-and-oom) | Trigger an OOM kill and read `memory.events` | 5 min | `make check LAB=16` |
| [17](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood/tree/main/labs/17-not-all-memory-is-equal) | Compare file cache with memory a program holds | 10 min | `make check LAB=17` |

---

## Node pressure

### 18. When the whole node runs short

*Question: who gets removed when a node runs low on memory?*

[Chapter 16](#16-memory-limits-and-the-oom-killer) was one container hitting **its own** limit. This is the other way to run out: the **node** gets low on memory, because many pods use more than they requested. Three things decide what happens: how much of the node is for pods, which pods are most protected, and who gets evicted first.

#### Not all of a node is for pods

A node can't hand all its memory to pods; the operating system and Kubernetes' own programs need some too. What's left is called **allocatable**:

{{allocatable}}

```bash
kubectl get node under-the-hood-worker \
  -o jsonpath='{.status.capacity.memory}{"  capacity\n"}{.status.allocatable.memory}{"  allocatable\n"}'
```

```
8126480Ki  capacity
8126480Ki  allocatable
```

They're equal on kind because it reserves nothing. On GKE or EKS, several hundred MiB or more are held back through three kubelet settings: `systemReserved` (for the OS), `kubeReserved` (for the kubelet and container runtime) and `evictionHard` (a safety margin). The scheduler only ever compares pod **requests** with allocatable, never real usage, and the kubelet writes `capacity − systemReserved − kubeReserved` into the `memory.max` of the box for all pods. That's the `8321515520` from [chapter 11](/blog/cgroups-deep-dive-kubernetes-part-1/#11-where-every-pod-lives-the-cgroup-tree) (exactly 8,126,480 Ki).

#### QoS classes: who is most protected

Kubernetes sorts every pod into one of three Quality of Service classes, worked out from its requests and limits:

| Class | How you get it |
|---|---|
| **Guaranteed** | Every container has requests **equal** to limits, for both CPU and memory |
| **Burstable** | Some requests or limits, but not Guaranteed |
| **BestEffort** | Nothing set at all |

The class shows up in two places. In the tree, each class gets [its own box](/blog/cgroups-deep-dive-kubernetes-part-1/#11-where-every-pod-lives-the-cgroup-tree). And on every process, as a number the kernel reads when the *whole machine* is out of memory:

{{qos}}

```bash
kubectl -n lab apply -f labs/11-the-cgroup-tree/pods.yaml
kubectl -n lab wait --for=condition=Ready pod/qos-guaranteed pod/qos-burstable pod/qos-besteffort
for p in qos-guaranteed qos-burstable qos-besteffort; do
  echo "$p $(kubectl -n lab exec $p -- cat /proc/1/oom_score_adj)"
done
```

```
qos-guaranteed -997
qos-burstable 996
qos-besteffort 1000
```

Remember `/proc` from [chapter 3](/blog/cgroups-deep-dive-kubernetes-part-1/#3-proc-what-every-process-is-doing-right-now): inside a container the main process is PID 1, so `/proc/1/oom_score_adj` belongs to the container's main program. It's a number from −1000 to 1000. When the machine runs out of memory, the kernel scores every process (mostly by how much memory it uses), adds this number, and kills the highest. Burstable values vary with the memory request (a bigger request gives a lower number).

#### Eviction: the kubelet steps in first

The kernel's machine-wide OOM killer is the last resort. Before it gets there, the kubelet watches the node's free memory, roughly every 10 seconds:

```
memory.available = node capacity − working set of the whole node
```

If `memory.available` drops below `evictionHard` (100Mi by default), the kubelet marks the node with `MemoryPressure` and **evicts** a pod: stops it, marks it `Failed`, and doesn't restart it on this node.

{{eviction}}

#### Try it yourself: watch an eviction

To see it without waiting for a real shortage, the lab has a cluster **profile** that tells the kubelet to treat the node as low on memory once less than 75% of it is available. Nothing is edited on a live node: the setting is part of the cluster from the start. Then a BestEffort memory hog runs next to two small, well-behaved pods:

```bash
make clean && make cluster PROFILE=pressure
kubectl -n lab apply -f labs/18-node-pressure-eviction/pods.yaml
# wait a minute, then:
kubectl -n lab get pods
kubectl -n lab get pod memory-hog -o jsonpath='{.status.reason}: {.status.message}'
```

<details class="predict"><summary><span class="predict-tag">Predict first</span> A BestEffort memory hog and two well-behaved pods share a node that runs low on memory. Who goes?</summary><div class="predict-answer"><p>The hog. It uses far more than it requested (nothing), so it's first in line for eviction.</p></div></details>

```
NAME              READY   STATUS    RESTARTS   AGE
calm-burstable    1/1     Running   0          40s
calm-guaranteed   1/1     Running   0          40s
memory-hog        0/1     Error     0          41s
Evicted: The node was low on resource: memory. Threshold quantity: 6094860Ki, available: 6090788Ki. Container main was using 1506200Ki, request is 0, has larger consumption of memory.
```

The hog was using about 1.4 GiB against a request of 0, so it went first; the calm pods kept running. Roughly, the kubelet ranks pods by (1) whether their memory use is above their request, (2) their priority, and (3) how far above their request they are. Treat this as intuition; the [Kubernetes docs](https://kubernetes.io/docs/concepts/scheduling-eviction/node-pressure-eviction/) have the full rules.

**What to take away:** when the whole node runs short, the kubelet evicts first and the kernel kills last. Pods using more than they requested, especially BestEffort ones, go first.

---

### Killed: your limit or the node?

*Question: my pod died because of memory. Was it its own limit, or the node?*

A pod can lose a fight over memory in three ways. They look alike from far away, but each one needs a different fix:

| What you see | Who did it | Why | Fix it on |
|---|---|---|---|
| `OOMKilled`, exit 137, the container restarts | the kernel | the container hit **its own** `memory.max` | the pod: its limit, or its memory use |
| `Evicted`, the pod stops and isn't restarted on that node | the kubelet | the **node** ran low, and this pod used the most beyond its request | the pod's request, and the node's headroom |
| a process killed, though the container was under its limit | the kernel, node-wide | the node ran out faster than the kubelet could evict | requests and limits across the node, and its reserves |

**How to tell them apart:** look at the pod status first (`Evicted` means the kubelet), then at the container's `memory.events`:

- **`oom` and `oom_kill` both went up:** the container hit its own limit (case 1). `oom` only counts times its own limit was reached.
- **`oom_kill` went up but `oom` didn't:** something else killed it, which is the node-wide OOM killer (case 3). The node's kernel log will say "Out of memory".

**What to take away:** OOMKilled means the pod hit its own limit; Evicted means the node ran short; a kill without its own `oom` count means the node ran out before the kubelet could act.

#### The labs for this stage

| Lab | What you'll do | Time | Check your work |
|---|---|---|---|
| [18](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood/tree/main/labs/18-node-pressure-eviction) | Watch the kubelet evict a pod (needs `make cluster PROFILE=pressure`) | 10 min | `make check LAB=18` |

---

## In production

### 19. Seeing memory in production

*Question: which memory numbers should I watch, and which ones lie?*

Like CPU in [Part 2](/blog/cgroups-deep-dive-kubernetes-part-2/#watching-cpu-in-production), every memory file has a Prometheus metric, exported by cAdvisor in the kubelet:

| Kernel file | What it tells you | Prometheus metric |
|---|---|---|
| `memory.current` | All memory, including cache | `container_memory_usage_bytes` |
| `memory.current` − `inactive_file` | The working set | `container_memory_working_set_bytes` |
| `memory.stat` → `anon` | Memory programs allocated | `container_memory_rss` |
| `memory.stat` → `file` | File cache | `container_memory_cache` |
| `memory.max` | The memory limit | `container_spec_memory_limit_bytes` |
| `memory.events` → `oom_kill` | OOM kills | `container_oom_events_total` |

From [chapter 17](#17-not-all-memory-is-equal): `container_memory_usage_bytes` includes cache the kernel can drop, so it looks scary when nothing is wrong. Compare the **working set** with the limit; that's the number the kubelet uses for eviction, and the one that gets close to the limit before an OOM kill.

#### Memory pressure

[Part 2](/blog/cgroups-deep-dive-kubernetes-part-2/#pressure-how-long-tasks-wait) introduced pressure: not how *busy* something is, but how long things *waited*. For memory, waiting means stalling while the kernel reclaims memory to make room.

#### Try it yourself: read memory pressure

The lab's `psi-memory` pod rereads a 192 MiB file inside a 64Mi limit, so the kernel keeps throwing its cache away and reading it back. (It starts from the same file as Part 2's `psi-cpu`.)

```bash
kubectl -n lab apply -f labs/19-metrics-and-psi/pods.yaml
kubectl -n lab wait --for=condition=Ready pod/psi-memory
sleep 30
kubectl -n lab exec psi-memory -- cat /sys/fs/cgroup/memory.pressure
```

```
some avg10=6.35 avg60=2.42 avg300=0.59 total=1967529
full avg10=6.35 avg60=2.42 avg300=0.59 total=1967529
```

`some` and `full` are the same because the pod has one busy process: whenever it waited, *everything* in the pod waited. About 6% of the last 10 seconds was lost to reclaim, and it hasn't been OOM-killed, because file cache can always be dropped. Memory that a program allocates can't, so for a leaking process, rising `memory.pressure` is often the earliest warning you'll get before an OOM kill.

**What to take away:** watch the working set against the limit, `oom_kill` counts and `memory.pressure`. `memory.current` and the usage metric include cache, and will mislead you.

#### The labs for this stage

| Lab | What you'll do | Time | Check your work |
|---|---|---|---|
| [19](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood/tree/main/labs/19-metrics-and-psi) | Read the metrics and the pressure files | 10 min | `make check LAB=19` |

---

## Beyond CPU and memory

### 20. The other limits, briefly

*Question: is it only CPU and memory?*

CPU and memory get all the attention, but a few more limits are worth knowing:

| Limit | Controller and file | Set by | What happens |
|---|---|---|---|
| Number of processes | `pids` → `pids.max` | the kubelet's `podPidsLimit` | New processes are refused ("can't fork") |
| Which CPU cores | `cpuset` → `cpuset.cpus` | CPU manager `static` policy, for Guaranteed pods with whole CPUs | The pod gets cores to itself |
| Huge pages | `hugetlb` → `hugetlb.*.max` | `limits.hugepages-2Mi` and friends | Allocations past the limit fail |
| Disk speed | `io` → `io.max`, `io.weight` | not set by Kubernetes | — |
| Disk *space* | **none** | `limits.ephemeral-storage` | The kubelet measures it and evicts the pod |

The PID limit matters more than it looks: every process and thread needs a PID, and a node only has so many. One runaway pod spawning processes (a *fork bomb*) can use them all, and then nothing on the node can start, not even the kubelet. And the last row is a common surprise: there is **no cgroup for disk space**. The kubelet adds up what each pod has written (logs, its writable layer and `emptyDir` volumes) and evicts it when it goes over.

#### Try it yourself: hit the process limit

This needs the cluster profile that sets the kubelet's `podPidsLimit` to 64: `make clean && make cluster PROFILE=pids`. `pid-hog` keeps starting new processes:

```bash
kubectl -n lab apply -f labs/20-pids-and-disk/pod-pids.yaml
kubectl -n lab wait --for=condition=Ready pod/pid-hog
sleep 3
docker exec under-the-hood-worker cat "$(./scripts/pod-cgroup.sh pid-hog)/pids.max"
docker exec under-the-hood-worker cat "$(./scripts/pod-cgroup.sh pid-hog)/pids.current"
kubectl -n lab logs pid-hog | tail -2
```

<details class="predict"><summary><span class="predict-tag">Predict first</span> The pod tries to start more processes than its limit allows. Is it killed, like a pod over its memory limit?</summary><div class="predict-answer"><p>No. The kernel just refuses the new process ("can't fork"). Nothing is killed, and the pod keeps running.</p></div></details>

```
64
63
/usr/local/bin/forkmany: line 0: can't fork: Resource temporarily unavailable
forkmany: spawner finished
```

`pids.max` is 64 on the pod's cgroup, `pids.current` sits right at it, and the log shows the forks the kernel refused. The pod is still `Running`.

Disk space is different. `disk-hog` has a `50Mi` `ephemeral-storage` limit and writes 100 MiB into an `emptyDir`. There's no file to read; after a minute or so the kubelet evicts it:

```bash
kubectl -n lab apply -f labs/20-pids-and-disk/pod-disk.yaml
# wait a minute or two, then:
kubectl -n lab get pod disk-hog -o jsonpath='{.status.reason}: {.status.message}{"\n"}'
```

```
Evicted: Pod ephemeral local storage usage exceeds the total limit of containers 50Mi.
```

**What to take away:** the number of processes is capped by a cgroup, and going over it is refused, not killed. Disk space has no cgroup: the kubelet measures it and evicts.

---

### 21. Finale: resize a running pod

*Question: if limits are just numbers in files, can we change them on a live pod?*

Here's the proof that ties the whole series together. Since Kubernetes 1.33, where in-place resize became beta and on by default (it's been stable since 1.35), you can change a running pod's CPU and memory **in place**, with no restart. Remember [chapter 8](/blog/cgroups-deep-dive-kubernetes-part-1/#8-build-a-cgroup-by-hand), where you changed `cpu.max` with `echo` while a process was running? That's all this is.

{{resize}}

#### Try it yourself: resize a live pod

`resize-demo` starts with 200m CPU and 64Mi memory. Read its files, ask Kubernetes for 500m and 128Mi, then read them again:

```bash
kubectl -n lab apply -f labs/21-in-place-resize/pod.yaml       # 200m CPU, 64Mi memory
kubectl -n lab wait --for=condition=Ready pod/resize-demo
kubectl -n lab exec resize-demo -- cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max

kubectl -n lab patch pod resize-demo --subresource resize --patch \
  '{"spec":{"containers":[{"name":"main","resources":{"requests":{"cpu":"500m","memory":"128Mi"},"limits":{"cpu":"500m","memory":"128Mi"}}}]}}'
sleep 5

kubectl -n lab exec resize-demo -- cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max
kubectl -n lab get pod resize-demo -o jsonpath='restarts={.status.containerStatuses[0].restartCount}{"\n"}'
```

<details class="predict"><summary><span class="predict-tag">Predict first</span> You changed the pod's CPU and memory. Did the container restart?</summary><div class="predict-answer"><p>No: <code>restarts=0</code>. Nothing needed restarting, because the limits are just numbers in files.</p></div></details>

```
20000 100000        ← before: 200m
67108864            ← before: 64 MiB
50000 100000        ← after: 500m
134217728           ← after: 128 MiB
restarts=0
```

The kubelet asked the runtime to rewrite the files of the live container. Same container, same process, new numbers. This was my favourite moment building the lab, because it's the clearest proof that `resources:` really is just a few numbers in a few files.

**What to take away:** resize rewrites the cgroup files of a live container. No restart, because there's nothing to restart: it's just a file. It's what you did with `echo` when you [built a cgroup by hand](/blog/cgroups-deep-dive-kubernetes-part-1/#8-build-a-cgroup-by-hand).

#### The labs for this stage

| Lab | What you'll do | Time | Check your work |
|---|---|---|---|
| [20](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood/tree/main/labs/20-pids-and-disk) | Hit the process limit (needs `make cluster PROFILE=pids`) | 10 min | `make check LAB=20` |
| [21](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood/tree/main/labs/21-in-place-resize) | Resize a running pod | 5 min | `make check LAB=21` |

---

## Wrap-up

### Put it to the test

Reading about throttling and knowing it when you see it are different skills. The lab has four small incidents that play like a short on-call shift. Each one sets the scene, shows you what the dashboard shows, and hands you a ticket that sounds like a real page, with a few places to look. Then it leaves the digging to you. It pauses between steps, so take your time.

| # | The ticket | Where the answer is |
|:-:|---|---|
| 1 | "Checkout is slow, but the CPU graph is under its limit" | [Chapters 14 and 15](/blog/cgroups-deep-dive-kubernetes-part-2/#14-cpu-limits-become-a-budget-throttling) |
| 2 | "OOMKilled, but the dashboard never went above half" | Chapters 16 and 17 |
| 3 | "Pending for ages, the node's memory is almost empty" | [Chapter 9](/blog/cgroups-deep-dive-kubernetes-part-1/#9-the-four-checkpoints) and 18 |
| 4 | "The controller waits for CPU, but it's never throttled" | [Waiting for CPU: your limit or contention?](/blog/cgroups-deep-dive-kubernetes-part-2/#waiting-for-cpu-your-limit-or-contention) |

```bash
make incident-1                       # the scene, what the dashboard shows, then the ticket
make hint-1                           # stuck? one clue at a time; run it again for the next
make answer-1 CAUSE=<your answer>     # the evidence, why it happened, and the fix, applied live
```

Try to solve each one with only `kubectl`, `cat` and the files from this series before reaching for a clue.

### Make your app cgroup-aware

The kernel enforces the box, but the program inside should know how big the box is:

- **Java:** container support is on by default in JDK 10+ and 8u191+. Size the heap with `-XX:MaxRAMPercentage` rather than a fixed `-Xmx`.
- **Go:** from Go 1.25, `GOMAXPROCS` follows the container's CPU limit (rounded up, so 2.5 CPUs gives 3) and is re-checked if the limit changes. It ignores the CPU request, so with no limit it still uses every host core. On older versions, use `go.uber.org/automaxprocs`, or set `GOMAXPROCS` yourself.
- **Node.js:** set `--max-old-space-size` below the memory limit, leaving room for buffers.

### Cheat sheet

| Setting | Who acts on it | How |
|---|---|---|
| `requests.cpu` | Scheduler, then kernel | Fits pods on nodes; becomes `cpu.weight` (via CPU shares) |
| `limits.cpu` | Kernel | `cpu.max`: a quota per 100 ms period; running out means throttling |
| `requests.memory` | Scheduler, kubelet | Placement; ranking during eviction. No kernel protection by default |
| `limits.memory` | Kernel | `memory.max`: reclaim first, OOM kill if that isn't enough |
| QoS class | Kubelet, kernel | Which box in the tree; `oom_score_adj`; eviction order |
| `podPidsLimit` | Kernel | `pids.max` |
| `limits.ephemeral-storage` | Kubelet | Measures disk use and evicts. Not a cgroup |

Three Kubernetes features often mentioned alongside these don't touch cgroups at all, so I've left them out of this series: **ResourceQuota** (a namespace's total budget), **LimitRange** (default and maximum requests per container) and **PriorityClass** (who gets scheduled, and who's evicted, first). They're checked by [the API server and the scheduler](/blog/cgroups-deep-dive-kubernetes-part-1/#9-the-four-checkpoints). The lab has a hands-on extra for each: `labs/E1-resourcequota`, `labs/E2-limitrange` and `labs/E3-priority-and-preemption`.

### Takeaways

- **Kubernetes decides; the kernel enforces.** When something behaves strangely, ask which checkpoint did it, then read that layer's files.
- **Requests** place your pod, share CPU when it's contended, and decide eviction order. Make them honest.
- **CPU limits** throttle, even on an idle node, and all your threads spend the same budget. Throttling can trigger **liveness restarts** and **readiness drop-outs** that spread load to other pods. Many teams drop CPU limits for latency-sensitive services and rely on good requests instead. Measure throttling before and after.
- **Memory limits** end in OOM kills once reclaim runs out. Setting them is a good default, because one leaky container otherwise puts the whole node at risk. For important workloads, memory requests equal to limits give the most predictable behaviour, at the cost of reserving memory you may not always use.
- **Watch the right numbers:** the throttling ratio, the working set, `oom_kill` counts, and pressure. Average CPU and `memory.current` will mislead you.

If you made it through all three parts, thanks for reading. Clone the [lab](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood), work through the labs, and watch it all happen. And if something doesn't behave the way I described on your machine, open an issue or ping me on LinkedIn; I'd genuinely like to know.

### Glossary

| Term | In one line |
|---|---|
| process | A running copy of a program, with its own PID |
| thread | A stream of work inside a process; what actually runs on a CPU core |
| kernel | The core of the OS that controls the hardware and hands out CPU and memory |
| virtual filesystem | A folder like `/proc` or `/sys` whose files the kernel creates on the spot |
| cgroup | A group of processes the kernel measures and limits together, shown as a folder under `/sys/fs/cgroup` |
| controller | The part of the kernel that handles one resource for cgroups: `cpu`, `memory`, `pids`, `io` |
| `cgroup.procs` | The file listing a cgroup's processes. Writing a PID into it moves that process in |
| namespace (Linux) | A private view of part of the system, such as processes, network or cgroup paths |
| scheduler (CPU) | The part of the kernel that picks which thread runs next. CFS until Linux 6.6, EEVDF since |
| weight | A cgroup's relative share of CPU when groups compete (`cpu.weight`) |
| CPU shares | The cgroups v1 unit Kubernetes still uses internally for requests: 1 CPU = 1024 shares |
| quota | How much CPU time a cgroup may use per period (the first number in `cpu.max`) |
| period | The length of each CPU budget window, 100 ms by default (the second number in `cpu.max`) |
| throttling | Runnable work waiting because its cgroup used up its CPU quota for the current period |
| reclaim | The kernel freeing memory it can safely drop, such as old file cache |
| working set | Memory in use minus inactive file cache: what a container really needs |
| OOM kill | The kernel ending a process because memory ran out and reclaim couldn't free enough |
| eviction | The kubelet stopping a whole pod because the node is short of memory, disk or PIDs |
| allocatable | A node's resources minus what's reserved for the system: what pods can request |
| QoS class | Guaranteed, Burstable or BestEffort, worked out from a pod's requests and limits |
| pressure (PSI) | Time spent waiting for CPU, memory or IO, from the `*.pressure` files |

### Lab command reference

| Command | What it does |
|---|---|
| `make check-setup` | Is Docker ready, is the cluster healthy, is anything left over from earlier labs? |
| `make cluster` | Create the cluster (`PROFILE=pressure` for chapter 18, `PROFILE=pids` for chapter 20) |
| `make check LAB=14` | Read-only PASS/FAIL on what you built in a lab |
| `make test LAB=14` | Run a lab's steps for you, end to end |
| `./scripts/watch.sh <pod>` | A live, once-a-second view of a pod's cgroup files |
| `./scripts/pod-cgroup.sh <pod>` | Where a pod's cgroup folder is on the node |
| `make reset` | Remove everything the labs created, keep the cluster |
| `make clean` | Delete the whole cluster |

Each chapter's lab lives in `labs/`, numbered like the chapters. Nothing is deleted behind your back: pods stay until you delete them or run `make reset`.

### Sources and further reading

- [Linux kernel docs: Control Group v2](https://docs.kernel.org/admin-guide/cgroup-v2.html), the reference for every file in this series
- [Linux kernel docs: CFS bandwidth control](https://docs.kernel.org/scheduler/sched-bwc.html), how quota, period, slices and burst work
- [Linux kernel docs: EEVDF scheduler](https://docs.kernel.org/scheduler/sched-eevdf.html)
- [Linux kernel docs: Pressure stall information](https://docs.kernel.org/accounting/psi.html)
- [Kubernetes docs: Resource management for pods and containers](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)
- [Kubernetes docs: Node-pressure eviction](https://kubernetes.io/docs/concepts/scheduling-eviction/node-pressure-eviction/)
- [Kubernetes docs: Resize CPU and memory resources assigned to containers](https://kubernetes.io/docs/tasks/configure-pod-container/resize-container-resources/)
- [Kubernetes blog: New conversion from cgroup v1 CPU shares to v2 CPU weight](https://kubernetes.io/blog/2026/01/30/new-cgroup-v1-to-v2-cpu-conversion-formula/)
- [iximiuz Labs: Controlling process resources with Linux control groups](https://labs.iximiuz.com/tutorials/controlling-process-resources-with-cgroups), a great companion to [chapter 8](/blog/cgroups-deep-dive-kubernetes-part-1/#8-build-a-cgroup-by-hand)
