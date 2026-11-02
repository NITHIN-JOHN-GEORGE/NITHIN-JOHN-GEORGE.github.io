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

To follow along, [set up the lab](/blog/cgroups-deep-dive-kubernetes-part-1/#set-up-the-lab-5-minutes) from Part 1 first.

---

## Memory limits

CPU can make you wait. Memory can't ([chapter 6](/blog/cgroups-deep-dive-kubernetes-part-1/#6-why-cpu-limits-slow-you-down-but-memory-limits-kill-you)), so it fails in a completely different way.

### 16. Memory limits and the OOM killer

*Question: what happens when a container reaches `memory.max`?*

Kubernetes didn't kill your OOMKilled pod. The Linux kernel did, because of one number in one file: `memory.max`.

If a program needs more memory and its box is full, waiting doesn't help.

<figure class="sketch anim"><svg viewBox="0 0 760 330" role="img" aria-label="Reaching the memory limit leads to reclaim, then possibly an OOM kill"><title>Reaching the memory limit leads to reclaim, then possibly an OOM kill</title><defs><clipPath id="com1"><rect x="62" y="70" width="156" height="220"/></clipPath></defs><g class="anim-fill"><path class="h b" clip-path="url(#com1)" d="M-129.7 292.6Q-33.3 180.5 62.5 68.4M-124.6 292.0Q-29.9 179.1 66.8 68.8M-116.4 292.9Q-21.3 179.3 73.3 68.5M-110.1 292.3Q-14.3 181.2 79.8 67.0M-103.4 292.8Q-8.1 179.6 88.1 66.8M-97.3 291.7Q-3.8 178.7 93.5 68.9M-93.2 291.4Q3.3 180.2 99.0 67.3M-86.3 293.0Q9.1 179.8 104.1 67.6M-79.3 291.6Q15.7 179.7 111.3 67.5M-72.5 293.0Q22.5 180.2 116.5 68.2M-67.0 291.7Q28.3 180.2 123.3 67.4M-61.9 292.7Q32.3 179.4 130.3 68.7M-56.0 292.4Q39.6 181.3 134.2 67.0M-52.2 291.2Q44.1 180.4 139.1 68.5M-45.7 291.9Q49.6 179.8 146.7 68.6M-41.4 292.6Q54.5 179.4 151.2 67.8M-33.3 292.3Q61.7 180.0 157.5 69.2M-26.9 292.1Q68.0 179.6 163.6 68.2M-20.5 292.1Q75.8 180.6 170.6 66.8M-14.4 291.3Q82.3 181.2 175.7 68.0M-8.3 293.2Q85.6 179.2 181.7 69.0M-2.6 292.4Q92.3 179.1 190.1 68.7M4.0 291.4Q98.3 178.6 194.8 68.1M11.2 291.6Q107.5 180.7 202.4 68.8M15.2 292.1Q111.7 180.4 206.2 68.0M20.7 291.3Q115.5 179.2 212.1 67.3M28.0 292.1Q124.3 180.5 219.1 68.1M34.8 291.6Q129.3 178.8 226.6 68.9M42.1 292.7Q137.1 179.5 232.7 67.6M47.5 291.4Q144.7 180.4 238.6 66.8M53.1 291.2Q148.9 180.4 245.6 67.0M59.6 291.5Q155.3 181.1 251.1 69.0M66.0 292.4Q159.3 179.4 257.0 68.7M70.4 291.4Q165.7 179.6 260.8 67.8M77.5 290.9Q171.9 178.8 269.0 68.0M84.3 292.6Q177.9 179.8 273.8 67.3M89.2 291.7Q186.1 180.7 280.1 67.3M95.2 292.4Q192.2 180.7 285.7 68.9M102.7 292.5Q196.6 179.3 292.5 69.1M108.5 293.1Q205.4 180.9 300.0 69.1M113.5 290.9Q208.4 178.5 304.5 67.9M118.9 291.7Q214.4 179.3 310.0 68.2M126.9 292.5Q220.1 178.9 316.6 68.3M132.4 291.9Q229.9 180.7 323.5 68.6M137.7 292.0Q235.2 181.5 329.0 67.7M143.9 292.6Q241.4 181.0 335.3 67.3M152.7 291.1Q246.2 178.6 341.8 67.9M155.9 291.0Q253.0 180.2 347.2 67.9M164.5 292.9Q259.4 180.1 354.1 68.4M169.8 292.6Q266.5 181.2 359.7 67.6M173.8 291.5Q269.5 179.2 365.6 67.0M181.0 292.6Q276.0 179.7 371.8 67.4M188.0 292.8Q282.1 180.0 378.8 67.9M193.8 291.3Q288.1 179.0 384.8 68.8M198.9 291.4Q294.4 178.8 391.7 68.8M204.6 292.3Q300.1 179.3 398.2 67.6M212.6 292.2Q308.6 180.5 403.6 68.2"/><path class="s b" d="M60.5 68.8Q140.5 69.9 218.0 70.7M61.6 70.5Q139.4 71.5 217.7 69.3"/><path class="s b" d="M219.4 69.4Q219.8 180.1 217.9 291.5M217.8 68.7Q216.7 180.3 216.7 290.0"/><path class="s b" d="M217.2 289.8Q139.7 291.3 62.0 288.4M218.0 289.1Q139.7 288.0 60.5 288.8"/><path class="s b" d="M61.1 289.0Q59.5 179.8 63.1 70.2M60.5 290.8Q61.9 180.5 62.5 69.7"/></g><path class="s" d="M51.1 48.6Q55.9 172.6 58.7 295.4M48.5 51.0Q56.2 172.3 59.0 294.5"/><path class="s" d="M231.4 49.4Q224.3 172.9 219.1 294.9M230.7 49.1Q223.5 172.6 220.2 294.8"/><path class="s" d="M60.4 295.7Q139.8 297.0 220.9 295.8M60.7 294.4Q140.6 292.5 218.7 294.6"/><path class="s r" d="M30.5 99.8Q34.8 99.4 40.0 100.2"/><path class="s r" d="M47.6 100.7Q51.8 99.5 57.2 100.5"/><path class="s r" d="M64.6 99.5Q69.2 100.0 74.0 99.3"/><path class="s r" d="M81.1 99.7Q86.0 100.3 90.4 99.7"/><path class="s r" d="M98.5 99.6Q102.9 101.0 107.9 100.5"/><path class="s r" d="M115.3 99.2Q120.2 98.8 125.2 99.3"/><path class="s r" d="M131.8 99.6Q137.1 99.6 141.8 99.7"/><path class="s r" d="M149.4 100.5Q153.8 99.3 158.8 100.7"/><path class="s r" d="M166.4 100.7Q171.2 99.8 176.2 100.6"/><path class="s r" d="M183.1 99.3Q188.0 99.5 192.6 100.2"/><path class="s r" d="M200.1 99.4Q205.1 99.8 209.9 100.7"/><path class="s r" d="M216.8 99.5Q221.7 99.7 227.0 100.7"/><path class="s r" d="M233.9 99.6Q238.8 99.8 244.7 100.6"/><text x="140" y="88" text-anchor="middle" class="r" style="font-size:19px">memory.max</text><path class="s" d="M300.3 30.1Q515.4 31.6 730.1 30.1M300.5 29.2Q514.7 28.5 730.9 30.4"/><path class="s" d="M729.3 30.7Q731.1 69.6 729.7 111.0M731.2 29.9Q729.5 70.4 730.5 110.4"/><path class="s" d="M730.5 108.8Q515.2 111.5 299.8 109.3M729.6 110.8Q514.5 107.9 299.3 110.4"/><path class="s" d="M300.6 109.1Q301.2 69.9 299.4 30.9M300.1 111.0Q298.7 69.7 299.1 30.0"/><text x="316" y="58" text-anchor="start" class="big" style="font-size:22px">1. allocate</text><text x="316" y="82" text-anchor="start" style="font-size:17px">the app asks for more memory</text><path class="s y" d="M299.5 125.1Q514.6 126.5 731.1 126.0M301.1 124.4Q514.7 124.4 729.5 124.7"/><path class="s y" d="M729.8 125.1Q728.1 164.7 729.3 205.7M730.9 126.1Q731.2 164.9 729.9 204.8"/><path class="s y" d="M728.9 204.4Q515.1 205.0 300.2 204.6M731.1 204.4Q515.0 206.7 299.3 205.4"/><path class="s y" d="M299.6 206.1Q301.0 165.0 301.1 124.4M301.1 204.6Q301.4 164.8 301.1 125.2"/><text x="316" y="153" text-anchor="start" class="big" style="font-size:22px">2. reclaim</text><text x="316" y="177" text-anchor="start" style="font-size:17px">at the limit, the kernel frees what it can,</text><text x="316" y="197" text-anchor="start" class="m" style="font-size:16px">such as cached file data</text><path class="s r" d="M299.6 219.8Q515.4 220.7 729.6 219.4M298.9 220.8Q515.2 219.3 730.4 221.0"/><path class="s r" d="M730.5 220.2Q729.6 260.3 730.2 299.7M730.0 219.2Q730.4 259.9 731.0 301.0"/><path class="s r" d="M730.3 300.6Q514.6 300.3 299.8 300.7M728.9 298.8Q514.8 300.7 300.9 299.1"/><path class="s r" d="M300.1 298.9Q298.6 259.8 298.9 220.0M300.7 300.6Q301.4 259.7 300.0 220.5"/><text x="316" y="248" text-anchor="start" class="big" style="font-size:22px">3. OOM kill</text><text x="316" y="272" text-anchor="start" style="font-size:17px">only if reclaim can't free enough:</text><text x="316" y="292" text-anchor="start" class="m" style="font-size:16px">the OOM killer ends a process</text><path class="s" d="M514.3 112.2Q515.1 117.3 515.8 124.0M514.2 110.8Q514.2 117.8 514.8 124.6"/><path class="s" d="M515.2 122.5Q512.5 118.3 510.5 113.4M515.3 123.7Q511.9 118.0 509.4 113.0"/><path class="s" d="M514.5 122.8Q518.3 118.5 519.1 112.9M514.6 123.0Q517.8 118.6 519.9 113.1"/><path class="s" d="M515.3 208.5Q514.5 212.9 516.1 219.2M514.0 206.2Q514.1 212.4 515.0 218.8"/><path class="s" d="M515.1 217.5Q512.3 212.9 510.8 207.8M514.5 217.3Q512.0 213.4 510.3 208.8"/><path class="s" d="M515.2 218.4Q516.9 213.1 519.0 208.7M514.4 217.6Q518.4 213.8 520.5 207.7"/><g class="anim-kill"><text x="140" y="30" text-anchor="middle" class="big r">OOMKilled · exit 137</text></g></svg><figcaption>Memory can't be throttled like CPU. At the limit the kernel reclaims first; the OOM kill comes only if that isn't enough.</figcaption></figure>

When a cgroup reaches `memory.max`, the kernel first tries to **reclaim**: it frees memory it can safely drop, such as cached file data. Only if that isn't enough does it call the **OOM killer**, which picks a process inside the cgroup and ends it.

**Try it yourself.** `memory-hog` has a 64Mi limit and runs a small Python script that grabs 10 MiB every 0.3 seconds and never lets go:

```bash
kubectl -n lab apply -f labs/16-memory-limits-and-oom/pod.yaml
kubectl -n lab get pod memory-hog -w
```

Within seconds the status flips to `OOMKilled`, Kubernetes restarts it, and it happens again. Press Ctrl-C and look at what it printed before it died:

```bash
kubectl -n lab logs memory-hog --previous | tail -3
```

```
allocated 40 MiB
allocated 50 MiB
allocated 60 MiB
```

It never reached 64. The Python interpreter itself lives in the same box and uses memory too.

Kubernetes records the death as `reason: OOMKilled`, `exitCode: 137`. **Exit code 137** means "killed by a signal": 128 plus the signal number, and signal 9 is `SIGKILL`, the one a program can't catch or ignore. It gets no chance to clean up or write a last log line.

The kernel keeps its own tally in the pod's `memory.events`:

```bash
POD_DIR=$(./scripts/pod-cgroup.sh memory-hog)
docker exec under-the-hood-worker cat "$POD_DIR/memory.events"
```

```
low 0
high 0
max 75
oom 2
oom_kill 4
oom_group_kill 2
```

| Line | Meaning |
|---|---|
| `max` | Times usage hit `memory.max` and the kernel had to reclaim |
| `oom` | Times reclaim wasn't enough |
| `oom_kill` | Processes the kernel killed |
| `oom_group_kill` | Times it killed a whole container at once |
| `low`, `high` | Softer limits Kubernetes doesn't set by default (chapter 17) |

`oom_group_kill` shows up because, on cgroups v2, the kubelet sets `memory.oom.group = 1` on each container by default (since Kubernetes 1.28): if one process has to die, the whole container goes, so nothing is left half-alive.


*Lab:* [16-memory-limits-and-oom](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood/tree/main/labs/16-memory-limits-and-oom). Check what you built with `make check LAB=16`.

> [!KEY]
> At `memory.max` the kernel reclaims what it can first. If that isn't enough, it OOM-kills: exit code 137, no warning.


---

### 17. Not all memory is equal

*Question: how can a pod be OOM-killed while the dashboard said it had room to spare?*

This answers the promise from the start of the series. The key is that a cgroup's memory comes in two kinds.

<figure class="sketch "><svg viewBox="0 0 760 300" role="img" aria-label="Anonymous memory and file cache"><title>Anonymous memory and file cache</title><defs><clipPath id="cmk1"><rect x="70" y="170" width="280" height="80"/></clipPath><clipPath id="cmk2"><rect x="70" y="80" width="280" height="85"/></clipPath></defs><path class="s" d="M61.5 41.0Q210.2 38.5 361.6 39.2M58.5 40.6Q209.4 38.1 359.6 41.0"/><path class="s" d="M359.5 38.5Q358.5 149.6 360.5 259.0M361.4 41.5Q362.3 149.9 360.5 259.2"/><path class="s" d="M360.0 259.4Q209.7 262.1 58.5 259.5M359.3 259.7Q209.4 260.2 60.0 260.2"/><path class="s" d="M59.4 259.1Q61.5 149.5 60.2 39.9M60.4 260.4Q58.6 150.3 60.6 41.1"/><path class="s r" d="M40.3 70.0Q44.8 68.9 50.0 69.7"/><path class="s r" d="M57.0 69.9Q62.2 69.7 66.4 70.2"/><path class="s r" d="M73.9 70.6Q79.1 69.2 83.7 70.1"/><path class="s r" d="M91.0 70.7Q96.0 69.8 100.9 69.9"/><path class="s r" d="M107.7 69.2Q113.0 70.5 117.9 69.3"/><path class="s r" d="M125.7 70.3Q130.1 69.5 135.1 69.8"/><path class="s r" d="M142.1 70.2Q146.9 69.7 151.7 70.4"/><path class="s r" d="M158.2 69.6Q163.9 70.3 168.7 70.3"/><path class="s r" d="M175.9 70.0Q181.3 69.2 186.4 69.6"/><path class="s r" d="M193.1 70.6Q198.2 69.4 202.8 69.9"/><path class="s r" d="M209.3 69.3Q214.8 70.2 220.7 69.9"/><path class="s r" d="M226.9 69.2Q232.2 69.0 236.4 70.0"/><path class="s r" d="M244.2 70.3Q248.8 70.6 254.7 70.0"/><path class="s r" d="M260.4 69.6Q265.7 69.0 271.2 70.4"/><path class="s r" d="M278.6 69.2Q283.0 70.5 287.6 70.8"/><path class="s r" d="M295.2 70.2Q300.2 69.3 304.9 70.5"/><path class="s r" d="M312.4 70.2Q316.9 69.1 322.3 69.7"/><path class="s r" d="M328.6 69.7Q334.0 70.4 338.7 69.5"/><path class="s r" d="M346.6 70.0Q351.0 70.3 356.5 70.4"/><path class="s r" d="M363.7 70.5Q367.9 69.8 373.7 70.1"/><text x="390" y="76" text-anchor="start" class="r" style="font-size:18px">memory.max</text><path class="h r" clip-path="url(#cmk1)" d="M0.6 252.6Q35.2 210.2 70.8 169.0M7.2 250.8Q41.8 210.1 77.4 168.1M14.4 252.4Q48.2 209.4 83.1 167.3M20.3 252.6Q54.2 209.7 90.2 168.2M27.6 251.5Q63.5 210.7 98.0 167.9M35.3 252.2Q69.3 210.0 103.6 167.2M42.5 251.9Q78.5 210.5 111.8 167.7M48.9 252.7Q84.3 209.7 120.1 168.4M57.5 253.0Q91.4 209.8 124.8 167.4M62.8 252.1Q99.2 211.3 131.8 166.9M70.3 250.9Q105.5 210.5 140.0 169.0M77.0 251.4Q112.4 210.3 146.6 168.7M83.7 250.8Q117.8 208.4 154.8 167.3M91.1 251.1Q127.4 210.6 162.7 168.9M98.9 252.4Q133.7 209.3 170.4 169.0M107.6 251.0Q142.2 209.2 176.2 167.0M113.9 251.7Q149.9 210.3 183.0 167.2M122.3 252.7Q158.1 210.3 192.6 167.3M128.0 252.8Q163.8 210.4 197.9 167.7M135.9 251.1Q172.0 210.4 206.6 168.5M142.0 251.9Q178.4 210.5 213.1 168.1M149.9 251.9Q184.2 210.6 217.9 167.8M158.4 251.5Q193.5 211.3 227.7 169.0M164.3 252.8Q199.0 208.9 233.6 168.3M171.5 253.2Q207.9 211.6 240.0 168.2M178.2 253.0Q213.0 210.5 247.9 168.3M185.6 251.8Q218.6 209.4 254.5 167.6M192.5 252.9Q227.1 209.6 261.6 166.9M199.5 251.5Q234.1 209.7 268.7 168.0M206.0 252.6Q241.5 210.0 275.0 167.1M213.5 253.0Q248.1 209.7 282.1 167.7M220.3 251.3Q256.1 210.9 289.7 167.0M225.4 252.6Q260.2 208.9 295.6 167.1M233.7 252.6Q269.2 211.6 303.3 167.8M240.4 252.8Q275.7 210.8 309.6 167.5M245.9 253.2Q282.1 210.2 316.4 167.1M254.6 252.3Q287.8 209.5 323.8 167.0M262.8 251.2Q295.6 209.1 331.6 167.3M269.8 251.7Q302.5 209.6 337.9 168.6M276.4 252.7Q312.0 210.9 346.8 168.3M283.7 251.9Q317.6 209.7 352.3 168.0M289.5 252.7Q322.8 208.9 358.6 168.4M295.8 252.1Q332.5 211.2 364.8 168.4M303.1 252.8Q339.2 210.9 373.1 167.9M311.8 251.3Q346.5 210.3 379.1 168.7M317.4 253.0Q351.8 209.0 387.6 166.8M325.5 252.1Q359.6 209.2 396.3 168.2M334.2 251.8Q368.2 209.4 403.1 168.8M339.0 253.0Q374.7 210.2 408.8 168.1M347.3 251.2Q379.6 208.7 415.0 167.9"/><path class="s r" d="M70.9 169.4Q209.4 168.5 350.9 170.5M68.6 169.6Q209.6 172.4 350.9 169.9"/><path class="s r" d="M350.2 169.3Q348.0 209.5 348.5 250.6M351.0 170.3Q348.2 210.5 350.1 250.1"/><path class="s r" d="M350.7 249.0Q210.4 247.9 71.4 250.9M350.5 250.7Q210.5 247.9 70.5 250.7"/><path class="s r" d="M68.5 250.6Q71.8 210.3 70.4 171.3M69.1 250.3Q69.8 210.6 70.8 171.6"/><text x="210" y="205" text-anchor="middle" class="big">anon</text><text x="210" y="232" text-anchor="middle" style="font-size:17px">what programs asked for</text><path class="h b" clip-path="url(#cmk2)" d="M-4.8 168.0Q32.9 122.4 69.0 78.9M7.7 166.5Q46.1 122.1 82.1 78.0M20.5 167.1Q59.1 122.9 95.4 77.6M32.4 166.1Q69.9 122.3 107.7 77.6M45.5 167.2Q82.3 122.3 120.9 77.0M57.8 166.6Q96.4 123.6 132.1 78.4M69.7 166.9Q105.9 121.8 144.1 78.7M81.9 167.1Q119.4 123.4 156.5 78.0M93.8 167.1Q130.5 122.6 166.7 77.8M103.9 167.2Q141.7 122.5 178.8 78.5M116.0 167.3Q153.0 121.9 189.7 77.1M130.3 168.2Q166.6 122.8 202.4 78.0M139.9 166.6Q177.3 122.3 215.8 79.0M153.6 167.8Q190.5 122.8 228.3 77.1M165.5 166.4Q201.8 123.0 237.6 77.3M176.9 166.3Q213.3 123.0 250.6 78.7M186.8 167.6Q224.1 122.2 261.4 78.2M199.3 166.1Q237.7 123.7 272.8 77.1M212.2 168.0Q249.2 122.5 285.9 77.8M223.1 166.9Q259.3 121.9 296.6 77.5M235.9 167.2Q270.9 121.4 310.4 78.4M247.9 167.8Q284.9 123.0 322.5 78.8M258.9 167.7Q297.4 123.1 333.5 77.1M273.0 166.8Q309.3 122.4 344.9 76.9M284.1 166.9Q320.6 122.2 357.0 78.3M296.1 167.3Q332.6 123.7 369.5 79.1M305.8 167.5Q342.0 121.7 379.7 76.9M318.9 167.7Q355.2 122.3 392.2 78.0M330.1 167.9Q366.4 122.7 402.7 78.2M339.7 167.5Q377.3 122.0 414.2 78.1"/><path class="s b" d="M69.6 80.5Q209.7 80.5 349.3 80.7M70.6 81.3Q210.2 80.5 351.6 80.6"/><path class="s b" d="M350.0 79.4Q352.9 122.9 349.7 165.7M349.4 81.2Q348.4 123.0 348.5 164.2"/><path class="s b" d="M349.2 165.7Q210.3 162.5 71.2 164.9M348.8 164.4Q209.7 164.3 70.7 163.7"/><path class="s b" d="M70.2 165.2Q69.9 122.6 71.2 80.7M69.6 165.5Q71.4 122.8 71.3 80.0"/><text x="210" y="115" text-anchor="middle" class="big">file cache</text><text x="210" y="142" text-anchor="middle" style="font-size:17px">copies of files, for speed</text><text x="395" y="125" text-anchor="start" class="b" style="font-size:19px">← can be dropped and reread</text><text x="395" y="150" text-anchor="start" class="m" style="font-size:17px">    (reclaim). Nobody dies.</text><text x="395" y="215" text-anchor="start" class="r" style="font-size:19px">← can't be dropped. Too much</text><text x="395" y="240" text-anchor="start" class="m" style="font-size:17px">    of this = OOM kill.</text><text x="380" y="290" text-anchor="middle" class="m" style="font-size:16px">both count in memory.current · the working set leaves out inactive file cache</text></svg><figcaption>Two containers can both show 120 MiB in use. Only the one full of anon memory is in danger.</figcaption></figure>

| Kind | In `memory.stat` | What it is | Can the kernel take it back? |
|---|---|---|---|
| **Anonymous** | `anon` | Memory a program asked for: variables, heap, buffers | No. Only by killing the program (or swapping) |
| **File cache** | `file` | Copies of file data kept in memory so the next read is fast | Yes. It can drop it and reread from disk |

Both count towards `memory.current` and towards `memory.max`. But only one of them can get you killed.

**Try it yourself.** `mem-lab` has a 128Mi limit. First, read 192 MiB of files through it. The lab's `cache` command writes the file in 16 MiB steps, then reads it back twice:

```bash
kubectl -n lab apply -f labs/17-not-all-memory-is-equal/pod.yaml
kubectl -n lab wait --for=condition=Ready pod/mem-lab
kubectl -n lab exec mem-lab -- cache --mib 192
kubectl -n lab exec mem-lab -- cat /sys/fs/cgroup/memory.current
kubectl -n lab exec mem-lab -- grep -E '^(anon|file|inactive_file) ' /sys/fs/cgroup/memory.stat
```

<details class="predict"><summary><span class="predict-tag">Predict first</span> The container has a 128Mi limit and you just read 192 MiB of files through it. Was it OOM-killed?</summary><div class="predict-answer"><p>No. It was all file cache, which the kernel can drop whenever it needs room.</p></div></details>

On my run, `memory.current` read **125 MiB**, almost exactly the limit, of which **122 MiB was `file`** and **under 1 MiB was `anon`**. The pod's `memory.events` showed `max 1814` (the limit was hit over and over) and `oom_kill 0`. Every time, the kernel dropped some old file cache and carried on. The container is "at its limit", and perfectly fine.

Now allocate memory that can't be dropped. The lab's `alloc` command grabs memory in steps and never lets go:

```bash
kubectl -n lab exec mem-lab -- alloc --mib 16 --every 100ms
kubectl -n lab get pod mem-lab
```

This time it ends with exit code 137 and a container restart, and `memory.events` moves to `oom 1`, `oom_group_kill 1`. There was no cache left to drop, only memory a running program was holding, so the only way to stay under the limit was to kill it.

#### The working set: the number that matters

Because file cache inflates `memory.current`, the kubelet and most dashboards use the **working set** instead:

```
working set = memory.current − inactive_file
```

`inactive_file` is file cache that hasn't been touched recently, the first thing the kernel drops. The working set leaves it out, so it's a much better guess at what the container really needs. In the run above: `memory.current` **125 MiB**, working set **1 MiB**. Same container, same moment, two completely different stories. It's the number behind `kubectl top` and the metric `container_memory_working_set_bytes`.

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


*Lab:* [17-not-all-memory-is-equal](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood/tree/main/labs/17-not-all-memory-is-equal). Check what you built with `make check LAB=17`.

> [!KEY]
> File cache is counted but can be dropped. Memory a program allocates can't, and that's what gets OOM-killed. Watch the working set, not `memory.current`.


---

## Node pressure

### 18. When the whole node runs short

*Question: who gets removed when a node runs low on memory?*

The other way to run out is for the whole node to get low on memory, because many pods use more than they requested. Three mechanisms decide what happens then.

#### Not all of a node is for pods

A node can't hand all its memory to pods; the operating system and Kubernetes' own programs need some too. What's left is called **allocatable**:

<figure class="sketch "><svg viewBox="0 0 760 220" role="img" aria-label="Node capacity split into reservations and allocatable"><title>Node capacity split into reservations and allocatable</title><defs><clipPath id="cal1"><rect x="20" y="60" width="125" height="70"/></clipPath><clipPath id="cal2"><rect x="145" y="60" width="125" height="70"/></clipPath><clipPath id="cal3"><rect x="270" y="60" width="125" height="70"/></clipPath><clipPath id="cal4"><rect x="395" y="60" width="345" height="70"/></clipPath></defs><text x="20" y="32" text-anchor="start" style="font-size:22px">One node's memory (capacity)</text><path class="h m" clip-path="url(#cal1)" d="M-41.8 132.2Q-8.7 96.4 19.8 58.1M-32.7 130.9Q-3.1 94.0 27.3 58.5M-24.8 132.7Q6.9 94.9 37.3 58.4M-14.8 132.2Q17.2 96.4 46.7 57.6M-6.5 132.3Q24.2 95.0 53.8 57.2M1.3 130.9Q33.4 95.4 62.6 58.2M11.5 132.7Q41.8 94.4 72.9 57.4M19.5 132.1Q51.6 96.0 82.0 58.2M29.9 130.9Q60.0 93.8 91.7 58.4M41.2 132.6Q71.8 95.8 100.5 59.1M48.0 133.0Q77.9 94.2 110.7 57.3M57.7 131.4Q87.2 95.1 117.6 59.0M66.8 132.5Q96.2 94.9 126.5 58.5M75.3 132.7Q106.1 95.1 136.5 58.1M85.3 132.8Q114.6 93.9 145.4 59.1M93.5 131.9Q124.0 94.9 154.1 58.5M102.2 131.3Q131.7 94.4 162.6 57.2M110.2 132.5Q140.0 95.0 171.2 58.1M120.2 132.9Q149.5 94.1 180.1 58.7M128.3 131.5Q159.2 95.1 190.6 57.6M137.5 131.4Q167.9 94.8 197.7 57.0"/><path class="s m2" d="M18.8 59.9Q83.0 58.8 143.8 60.2M21.1 59.2Q83.0 59.4 146.5 60.4"/><path class="s m2" d="M144.6 58.9Q147.6 94.7 146.1 128.7M144.3 58.7Q143.7 95.2 146.3 130.5"/><path class="s m2" d="M144.0 128.5Q83.1 132.2 20.4 128.8M145.2 130.9Q82.5 129.1 21.0 130.3"/><path class="s m2" d="M18.7 131.1Q20.2 94.5 19.1 59.8M21.1 129.8Q19.3 95.0 19.6 60.5"/><text x="82.5" y="160" text-anchor="middle" style="font-size:18px">systemReserved</text><path class="h m" clip-path="url(#cal2)" d="M85.1 133.2Q115.7 95.4 146.2 57.1M92.7 132.5Q124.5 95.2 154.4 58.1M101.2 132.8Q131.1 94.6 162.4 57.8M109.0 132.8Q139.9 94.5 170.9 59.1M119.9 133.2Q149.6 95.4 180.1 57.8M126.0 130.9Q158.4 95.7 187.6 59.1M135.7 132.2Q167.7 95.3 196.3 58.2M145.5 131.1Q175.7 94.7 206.7 57.5M154.0 131.6Q186.0 95.6 216.8 57.4M162.8 133.1Q193.8 95.3 223.0 58.7M173.6 132.4Q203.8 96.2 232.4 59.0M181.4 132.7Q212.0 93.6 243.8 59.1M192.9 132.4Q221.9 95.1 253.4 57.3M200.4 131.3Q231.9 95.9 261.0 58.4M210.1 132.2Q240.8 96.5 270.5 58.7M218.9 132.0Q248.4 94.0 280.5 57.8M228.7 132.8Q257.4 94.1 288.6 58.7M239.2 132.3Q267.0 94.2 298.7 58.0M248.7 132.7Q278.2 95.1 309.3 57.4M257.8 131.1Q288.4 96.2 317.7 57.7M264.3 131.4Q296.1 95.3 325.8 58.9"/><path class="s m2" d="M143.5 60.3Q207.6 57.9 271.6 60.9M145.4 60.8Q207.1 61.3 269.8 58.6"/><path class="s m2" d="M269.9 60.9Q267.6 95.3 269.5 128.7M269.7 60.5Q270.3 95.4 269.6 130.7"/><path class="s m2" d="M268.5 131.1Q208.0 132.2 145.9 130.6M270.4 131.5Q207.8 132.4 146.4 130.4"/><path class="s m2" d="M145.1 130.1Q146.6 94.7 146.4 60.4M144.7 130.8Q145.7 95.6 145.3 59.7"/><text x="207.5" y="160" text-anchor="middle" style="font-size:18px">kubeReserved</text><path class="h r" clip-path="url(#cal3)" d="M208.8 131.5Q238.8 94.1 269.0 58.0M218.7 131.5Q249.8 96.2 277.8 58.3M225.7 131.0Q258.1 96.6 287.5 58.5M236.0 133.2Q267.0 96.2 294.8 58.6M244.5 132.8Q275.3 95.6 304.1 57.7M252.0 131.1Q283.9 95.3 313.6 58.9M261.8 132.6Q291.1 93.9 322.4 58.6M271.5 131.5Q302.6 96.2 331.8 58.7M280.6 132.3Q311.9 95.9 340.2 57.9M289.3 132.9Q321.9 96.0 351.1 57.3M299.2 132.2Q329.6 95.5 359.5 58.7M306.3 132.7Q336.7 95.2 366.4 57.3M316.2 131.2Q344.1 94.2 376.9 57.3M322.8 131.2Q354.4 95.0 383.9 59.0M330.6 131.7Q362.1 95.3 393.3 56.9M339.7 132.9Q370.6 94.7 401.0 58.7M348.3 131.1Q377.9 93.6 408.8 58.8M356.9 130.9Q388.4 95.3 419.2 56.8M366.8 131.6Q398.1 94.8 428.0 56.9M377.3 132.8Q408.3 96.3 438.1 58.0M384.2 133.1Q416.3 95.9 445.8 57.5M393.2 132.9Q423.6 94.7 454.9 58.2"/><path class="s r" d="M270.0 59.1Q332.1 61.5 394.8 58.8M269.3 59.6Q332.6 57.3 393.7 61.0"/><path class="s r" d="M394.0 60.7Q392.5 95.4 393.6 130.8M394.5 61.2Q392.6 94.6 395.9 128.9"/><path class="s r" d="M396.5 128.9Q332.8 128.5 270.7 128.5M394.1 129.5Q332.5 131.2 269.9 131.3"/><path class="s r" d="M269.0 131.0Q270.5 95.3 270.8 61.0M269.9 130.5Q269.8 94.5 271.4 61.3"/><text x="332.5" y="160" text-anchor="middle" style="font-size:18px">evictionHard</text><path class="h a" clip-path="url(#cal4)" d="M335.3 132.4Q364.3 94.9 394.6 58.9M340.5 131.3Q370.8 95.5 400.2 56.9M347.8 131.3Q378.8 95.4 408.6 57.6M354.5 133.1Q385.1 95.3 414.3 57.5M360.1 132.5Q390.7 94.9 421.6 58.2M367.6 132.7Q398.3 95.4 429.0 57.8M376.3 131.0Q404.9 93.9 437.3 57.0M383.6 132.5Q412.8 95.2 443.0 59.0M390.1 132.6Q420.8 95.6 450.9 57.2M397.0 131.1Q426.1 94.2 456.9 56.8M405.0 132.6Q434.2 95.7 465.4 58.5M410.2 132.2Q439.4 94.0 470.4 58.6M417.2 132.0Q445.8 94.2 477.8 58.9M423.5 132.9Q454.1 94.3 485.0 57.6M431.8 132.4Q462.7 95.4 493.0 58.0M438.5 132.3Q470.0 95.6 499.6 59.2M446.1 131.4Q477.5 95.6 506.4 57.9M453.3 132.1Q483.4 95.2 514.0 58.9M460.4 132.4Q491.5 95.3 521.3 57.0M466.8 131.9Q495.7 93.8 527.2 57.4M474.6 130.9Q503.5 94.5 533.6 57.9M482.2 132.8Q512.4 95.8 543.4 56.9M487.1 133.1Q519.3 96.1 549.3 57.8M496.5 131.2Q526.3 94.8 556.2 57.0M501.4 130.8Q531.2 94.5 562.6 57.5M509.3 133.1Q538.7 94.7 568.5 58.4M514.9 131.9Q545.2 94.2 575.2 57.4M523.0 132.8Q554.5 96.1 583.8 58.9M529.9 132.7Q561.5 95.8 592.0 57.1M536.1 131.5Q566.2 93.8 597.8 59.0M544.2 131.4Q575.5 95.5 604.1 57.5M552.9 130.9Q581.4 93.6 613.2 58.5M560.2 132.8Q589.0 93.7 621.0 58.9M565.7 132.9Q596.7 95.4 626.4 58.1M571.8 133.2Q601.6 93.8 633.5 57.2M578.6 133.1Q609.7 94.7 640.3 58.1M586.5 131.2Q617.4 95.9 647.0 59.2M594.0 132.6Q625.9 96.1 655.2 57.7M601.2 131.5Q632.2 95.3 663.0 57.3M609.6 130.9Q639.4 95.0 669.3 57.1M616.5 131.2Q646.4 94.4 677.2 58.8M623.6 132.4Q654.0 95.0 685.7 58.9M630.1 132.0Q659.3 93.8 690.8 57.6M637.2 131.1Q667.4 94.2 698.9 56.8M644.7 132.7Q675.9 95.6 705.4 58.3M651.0 132.0Q681.4 94.3 712.6 57.3M658.2 132.7Q686.6 93.5 718.8 58.3M663.9 131.5Q694.1 94.2 726.0 58.5M671.8 131.2Q701.0 94.8 731.6 59.0M677.3 131.9Q707.1 94.3 737.2 58.3M683.7 131.6Q714.6 94.9 744.2 58.3M690.5 132.2Q720.2 94.0 751.4 58.0M697.9 132.4Q730.0 95.9 758.5 57.4M704.8 131.5Q735.8 95.4 766.7 57.9M712.3 132.5Q742.8 93.8 774.8 57.1M720.4 130.8Q748.9 93.8 780.7 58.7M726.3 132.8Q757.1 96.0 787.6 58.7M734.4 132.0Q763.1 94.1 794.6 57.9M739.9 132.9Q771.6 96.1 800.6 58.1"/><path class="s a" d="M394.5 58.9Q567.9 58.4 740.0 59.3M396.3 60.8Q567.9 57.8 739.7 61.3"/><path class="s a" d="M740.6 58.7Q740.9 95.0 738.6 131.4M741.5 61.1Q742.6 95.0 739.9 130.1"/><path class="s a" d="M741.6 130.1Q567.2 128.4 396.0 130.1M741.5 131.0Q567.0 131.8 394.3 129.8"/><path class="s a" d="M395.1 128.9Q397.3 94.8 395.2 58.6M395.8 130.0Q394.6 94.4 393.9 59.7"/><text x="567.5" y="160" text-anchor="middle" style="font-size:18px">allocatable: what pods can request</text><text x="145" y="195" text-anchor="middle" class="m" style="font-size:16px">for the OS · for kubelet + runtime · safety margin</text></svg><figcaption>The scheduler only hands out the last part. kind reserves nothing, so there it is the whole node.</figcaption></figure>

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

The class shows up in two places. In the tree, each class gets its own box ([chapter 11](/blog/cgroups-deep-dive-kubernetes-part-1/#11-where-every-pod-lives-the-cgroup-tree)). And on every process, as a number the kernel reads when the *whole machine* is out of memory:

<figure class="sketch "><svg viewBox="0 0 760 270" role="img" aria-label="QoS classes affect OOM protection"><title>QoS classes affect OOM protection</title><defs><clipPath id="cqo1"><rect x="25" y="40" width="210" height="150"/></clipPath><clipPath id="cqo2"><rect x="275" y="40" width="210" height="150"/></clipPath><clipPath id="cqo3"><rect x="525" y="40" width="210" height="150"/></clipPath></defs><path class="s" d="M40.0 229.7Q380.4 230.9 721.6 229.3M39.4 229.3Q379.7 227.9 718.7 229.4"/><path class="s" d="M719.3 229.5Q715.3 232.6 710.2 234.6M719.4 230.4Q715.0 231.8 710.5 234.6"/><path class="s" d="M720.5 230.5Q715.1 227.5 710.8 224.8M719.8 229.4Q715.2 227.7 710.3 224.6"/><text x="40" y="258" text-anchor="start" class="r" style="font-size:20px">least protected</text><text x="720" y="258" text-anchor="end" class="g" style="font-size:20px">most protected</text><path class="h r" clip-path="url(#cqo1)" d="M-105.4 191.1Q-40.1 115.5 25.0 38.0M-94.3 190.9Q-26.9 116.4 36.4 37.1M-81.5 192.6Q-17.1 114.2 49.1 37.5M-68.3 191.0Q-5.3 114.1 60.5 38.0M-57.6 191.2Q7.1 113.6 73.3 37.9M-46.4 192.4Q20.6 115.5 85.4 36.8M-33.4 192.2Q32.5 115.8 97.9 37.3M-22.3 191.3Q42.6 114.1 108.9 38.6M-9.4 192.5Q54.4 114.3 121.2 38.3M2.0 190.9Q66.6 114.4 133.3 37.2M13.4 191.9Q80.5 116.4 144.1 37.6M24.8 192.4Q91.1 115.3 156.2 37.8M37.0 191.7Q101.4 114.5 166.7 37.5M50.2 192.1Q115.1 114.4 180.7 38.0M62.8 191.4Q127.5 115.4 193.5 38.8M73.9 191.0Q138.0 114.2 204.3 38.1M85.6 191.6Q151.3 114.8 217.6 37.3M97.2 191.3Q162.8 114.8 227.5 37.1M110.2 190.9Q175.7 114.9 239.9 37.5M121.7 191.2Q187.6 115.4 251.3 38.3M133.2 193.1Q198.7 115.2 263.8 38.8M145.4 193.1Q210.2 114.7 275.9 36.9M158.1 193.0Q221.4 114.9 288.4 37.4M167.2 192.4Q232.6 113.5 299.7 38.1M178.9 193.2Q243.5 114.0 309.2 37.2M192.6 192.0Q256.1 113.6 322.1 38.3M203.7 191.5Q270.4 115.9 334.1 37.6M215.6 191.3Q279.7 115.5 345.6 37.2M227.3 191.4Q291.3 114.3 355.9 38.0"/><path class="s r" d="M25.1 39.5Q130.0 40.2 234.0 40.1M23.4 41.5Q130.1 40.3 235.6 41.1"/><path class="s r" d="M236.5 41.3Q233.2 114.6 233.6 190.4M235.5 39.8Q234.4 115.1 234.2 191.2"/><path class="s r" d="M236.3 189.6Q129.7 189.5 25.2 188.7M236.4 188.9Q130.4 192.5 25.6 189.7"/><path class="s r" d="M23.7 189.5Q24.0 114.5 23.9 39.7M24.9 188.9Q25.7 115.5 25.2 38.5"/><text x="130" y="80" text-anchor="middle" class="big">BestEffort</text><text x="130" y="115" text-anchor="middle" style="font-size:19px">no requests, no limits</text><text x="130" y="160" text-anchor="middle" class="code">oom_score_adj 1000</text><path class="h y" clip-path="url(#cqo2)" d="M144.5 193.0Q209.9 115.4 274.1 37.5M157.3 193.1Q221.4 115.5 287.1 38.7M169.0 192.4Q232.4 114.0 297.6 37.5M179.2 191.8Q244.6 115.0 309.8 38.7M189.8 191.5Q256.7 115.9 322.0 39.1M203.3 192.0Q266.9 114.5 332.4 39.0M213.5 192.0Q281.1 116.0 344.9 38.3M228.2 192.8Q292.0 115.0 357.0 38.8M240.2 191.4Q304.2 114.8 369.9 38.4M251.9 191.6Q317.1 115.7 380.7 39.1M263.9 193.1Q326.8 113.6 392.6 38.4M275.4 192.2Q339.8 113.6 406.7 37.5M288.8 192.7Q353.3 115.1 418.3 38.7M298.9 192.8Q364.8 114.9 430.1 37.7M312.9 192.9Q378.4 115.8 442.5 38.7M325.8 192.6Q390.8 115.2 455.1 37.1M337.4 192.8Q403.9 116.0 469.7 38.1M349.8 192.4Q416.2 115.3 480.9 36.8M362.2 192.3Q428.3 115.0 493.8 37.8M374.3 191.3Q441.0 115.5 505.3 38.1M387.6 193.2Q453.1 114.9 517.4 37.2M398.8 191.9Q464.4 114.2 530.7 38.2M410.7 192.9Q477.4 115.6 541.7 38.4M423.3 191.6Q487.7 114.3 554.5 38.7M434.3 192.8Q500.5 116.5 564.9 37.8M446.1 192.0Q511.5 114.8 577.3 37.2M457.2 191.0Q521.4 113.9 588.9 36.9M469.9 191.0Q534.2 114.2 599.6 37.0M481.3 192.8Q546.2 113.6 613.3 37.1"/><path class="s y" d="M275.2 40.2Q379.8 41.6 484.3 40.1M275.0 38.4Q379.5 41.9 484.3 39.0"/><path class="s y" d="M484.7 41.0Q484.4 115.2 486.0 190.6M484.1 40.3Q486.9 115.4 486.3 189.4"/><path class="s y" d="M484.5 189.1Q379.8 190.3 276.4 189.6M484.1 189.7Q379.9 187.3 276.6 189.8"/><path class="s y" d="M275.3 188.9Q272.9 114.9 274.4 38.8M273.8 188.8Q274.1 115.4 273.8 39.7"/><text x="380" y="80" text-anchor="middle" class="big">Burstable</text><text x="380" y="115" text-anchor="middle" style="font-size:19px">some requests or limits</text><text x="380" y="160" text-anchor="middle" class="code">2 … 999</text><path class="h g" clip-path="url(#cqo3)" d="M395.6 191.5Q461.5 116.0 524.7 37.4M407.1 192.3Q471.4 114.6 536.6 37.6M419.1 192.9Q483.8 114.4 549.7 37.5M429.5 192.3Q495.0 114.9 560.2 38.1M442.5 192.2Q507.7 114.9 573.9 37.6M454.3 192.8Q520.5 115.0 584.6 37.1M465.6 192.3Q532.2 116.3 596.6 37.5M478.6 191.8Q544.3 115.6 607.0 38.1M489.5 191.0Q555.7 115.3 619.8 38.1M503.7 191.2Q567.6 114.5 632.7 38.3M512.7 192.0Q580.0 116.4 645.1 38.3M525.2 192.3Q591.3 115.7 655.3 38.1M538.2 192.4Q601.5 114.0 666.8 37.9M549.2 191.5Q615.0 115.3 679.0 38.0M561.6 192.9Q626.1 115.1 690.5 38.1M573.9 193.0Q639.8 115.8 703.0 37.5M585.3 192.1Q649.7 113.9 716.1 37.2M599.2 191.8Q663.7 114.6 729.1 38.1M610.0 191.0Q677.7 116.1 740.8 38.7M621.9 191.8Q687.0 113.7 754.2 37.6M634.0 191.4Q699.6 114.9 764.7 37.8M645.6 192.8Q711.5 114.6 777.2 37.3M658.4 191.7Q722.7 114.1 787.9 38.8M668.8 191.5Q735.3 115.3 800.8 38.6M682.5 193.0Q746.9 115.6 812.4 38.4M693.8 191.5Q758.3 114.1 823.9 37.8M707.5 191.6Q773.3 116.3 838.3 38.1M717.6 191.8Q782.8 115.0 848.2 37.1M729.8 192.9Q794.7 116.0 858.2 38.0"/><path class="s g" d="M524.6 38.8Q629.7 38.0 734.8 40.6M525.9 40.6Q630.2 38.9 734.9 39.5"/><path class="s g" d="M735.0 40.7Q735.7 114.4 734.8 190.0M736.2 40.8Q732.5 114.9 733.9 189.7"/><path class="s g" d="M736.0 188.5Q629.7 190.0 525.3 188.4M733.7 188.6Q629.4 190.2 525.7 188.6"/><path class="s g" d="M524.1 189.7Q523.7 115.1 525.7 40.2M524.3 189.0Q526.5 114.6 526.0 40.3"/><text x="630" y="80" text-anchor="middle" class="big">Guaranteed</text><text x="630" y="115" text-anchor="middle" style="font-size:19px">requests = limits</text><text x="630" y="160" text-anchor="middle" class="code">-997</text><text x="380" y="20" text-anchor="middle" class="m" style="font-size:16px">example values from this lab</text></svg><figcaption>QoS affects OOM protection and eviction behaviour. Burstable scores vary with the memory request.</figcaption></figure>

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

<figure class="sketch "><svg viewBox="0 0 760 250" role="img" aria-label="How node-pressure eviction works"><title>How node-pressure eviction works</title><defs><clipPath id="cev1"><rect x="20" y="50" width="220" height="150"/></clipPath><clipPath id="cev2"><rect x="270" y="50" width="220" height="150"/></clipPath><clipPath id="cev3"><rect x="520" y="50" width="220" height="150"/></clipPath></defs><path class="h y" clip-path="url(#cev1)" d="M-110.9 202.0Q-45.2 125.5 19.6 47.8M-97.8 203.2Q-33.5 123.8 32.5 48.3M-85.8 201.8Q-19.8 125.3 45.5 48.2M-74.9 201.8Q-8.7 125.4 56.9 48.0M-62.0 202.3Q4.3 125.8 69.3 47.0M-49.2 201.0Q15.6 124.3 81.3 47.8M-37.0 202.9Q29.0 125.1 94.3 49.1M-22.9 200.9Q42.2 125.9 107.4 49.0M-11.9 202.5Q51.8 124.6 118.2 47.5M-1.7 200.8Q64.2 125.7 127.8 47.9M8.8 201.1Q73.2 123.8 139.3 46.9M23.2 201.4Q88.2 126.0 152.3 48.9M34.3 202.4Q100.6 125.4 165.9 46.9M46.8 201.8Q111.4 124.3 176.5 48.0M58.8 201.9Q124.8 125.1 190.0 49.2M70.2 201.4Q137.7 126.0 202.3 47.2M83.5 200.9Q148.5 124.9 213.7 49.1M94.7 201.1Q159.4 124.3 226.0 48.2M106.3 201.7Q171.3 124.4 238.7 47.3M118.7 201.5Q184.3 125.2 249.7 48.6M132.7 202.7Q197.7 126.0 262.5 47.3M142.4 202.4Q207.7 124.7 273.7 47.5M154.5 201.7Q220.3 126.1 284.7 47.7M167.8 202.7Q231.1 123.9 296.4 46.8M177.5 201.3Q245.0 126.3 308.5 48.1M191.0 201.6Q254.7 123.7 320.4 48.9M202.4 201.4Q267.5 125.3 332.6 47.9M213.3 201.1Q279.7 126.1 343.4 48.6M224.9 201.0Q291.4 125.4 357.0 47.1M239.1 201.6Q302.5 124.8 367.7 47.9"/><path class="s y" d="M18.9 48.4Q129.4 52.4 241.6 50.6M20.3 50.5Q130.3 51.4 239.4 48.7"/><path class="s y" d="M240.5 48.7Q239.1 125.3 240.5 198.7M240.1 51.2Q237.5 124.7 240.5 198.8"/><path class="s y" d="M239.6 201.0Q129.6 198.6 19.1 199.4M239.6 199.0Q129.7 200.8 19.2 198.8"/><path class="s y" d="M19.8 200.3Q20.7 124.7 21.5 51.5M19.1 199.0Q18.6 125.4 20.0 49.3"/><text x="130" y="90" text-anchor="middle" class="big" style="font-size:23px">node crosses</text><text x="130" y="116" text-anchor="middle" class="big" style="font-size:23px">the threshold</text><text x="130" y="154" text-anchor="middle" style="font-size:17px">memory.available</text><text x="130" y="176" text-anchor="middle" style="font-size:17px">< evictionHard</text><path class="h b" clip-path="url(#cev2)" d="M139.7 200.9Q204.2 124.6 269.8 47.3M151.8 202.8Q216.2 124.0 281.7 49.0M164.0 202.6Q230.3 125.6 295.1 47.4M177.5 203.0Q239.7 123.9 306.3 47.6M188.3 203.1Q254.0 124.7 318.5 48.4M200.6 203.2Q266.0 125.4 330.3 47.6M213.0 202.5Q277.4 124.3 342.8 48.0M224.2 200.8Q289.1 123.7 356.0 46.9M238.7 200.9Q302.4 124.4 367.5 49.2M249.0 201.7Q313.1 124.5 378.7 47.6M259.8 203.1Q326.5 125.5 390.2 48.5M273.4 203.1Q337.8 124.9 404.2 47.9M285.4 201.6Q350.0 125.2 414.6 48.5M295.1 200.9Q361.7 126.1 427.5 48.4M309.1 202.7Q372.7 124.0 439.1 49.2M320.1 201.8Q386.9 125.8 452.3 48.8M332.7 201.8Q397.4 124.7 462.4 48.8M344.2 203.0Q408.7 123.9 474.9 46.8M357.6 202.6Q422.7 125.7 487.0 48.7M369.4 202.6Q435.4 126.4 500.2 47.2M380.4 202.1Q445.2 123.5 511.9 46.9M393.7 201.7Q460.3 126.0 524.2 48.6M406.1 201.8Q471.2 124.9 536.2 46.9M419.0 200.9Q484.4 125.3 549.0 47.4M430.7 201.1Q496.5 125.6 561.3 48.2M443.7 202.2Q509.3 126.2 573.8 47.6M454.3 201.0Q519.3 124.4 585.5 46.8M466.8 202.9Q530.6 124.1 596.6 47.0M478.7 202.2Q544.0 124.9 609.1 47.3"/><path class="s b" d="M269.2 49.7Q380.2 50.9 489.3 50.7M269.2 49.6Q380.0 47.2 490.3 50.8"/><path class="s b" d="M488.5 49.0Q489.1 125.2 491.3 198.4M490.3 51.4Q490.9 124.9 489.0 200.5"/><path class="s b" d="M489.6 200.5Q379.6 202.0 269.6 198.7M489.2 200.6Q380.3 198.5 269.5 200.4"/><path class="s b" d="M268.5 199.2Q268.1 125.5 269.2 51.5M269.8 199.2Q270.2 124.9 270.0 49.1"/><text x="380" y="90" text-anchor="middle" class="big" style="font-size:23px">kubelet ranks</text><text x="380" y="116" text-anchor="middle" class="big" style="font-size:23px">the pods</text><text x="380" y="154" text-anchor="middle" style="font-size:17px">priority, and usage</text><text x="380" y="176" text-anchor="middle" style="font-size:17px">vs memory request</text><path class="h r" clip-path="url(#cev3)" d="M388.9 202.8Q455.2 125.3 519.8 48.0M401.0 202.2Q466.5 124.9 532.7 48.4M414.5 202.8Q479.6 125.1 543.2 47.3M424.9 201.0Q492.4 126.0 557.0 48.2M437.5 202.5Q501.9 124.4 566.5 46.9M450.9 201.8Q516.5 126.1 579.6 48.6M462.4 201.4Q526.0 124.5 592.4 49.2M474.4 201.9Q538.6 125.0 603.9 49.0M486.6 203.0Q550.5 124.3 615.3 48.8M497.7 202.5Q563.7 126.2 628.8 48.6M509.0 200.8Q574.3 124.1 641.5 47.1M522.9 201.1Q589.2 125.8 652.6 47.0M533.7 202.4Q597.7 123.5 664.5 49.2M544.3 203.0Q608.7 124.2 675.3 48.0M555.6 201.5Q623.2 125.9 687.1 48.2M570.6 202.7Q634.6 125.3 700.7 49.0M581.7 201.3Q647.6 125.7 711.5 46.9M595.0 202.3Q659.4 125.4 725.3 46.9M605.3 202.0Q669.9 123.8 735.5 47.8M618.6 203.2Q682.3 124.2 748.4 49.0M631.4 202.8Q696.8 125.9 762.1 48.5M641.4 202.0Q707.1 124.8 772.6 48.4M654.4 201.9Q719.8 125.1 785.3 47.4M667.6 202.9Q731.9 125.4 796.7 46.8M677.4 202.1Q741.7 123.9 808.5 48.0M688.8 202.1Q755.0 125.3 819.0 48.3M699.5 202.1Q766.0 125.6 830.3 48.1M711.2 201.5Q776.1 123.7 842.5 46.8M722.8 202.1Q789.2 125.3 854.9 48.0M735.7 202.0Q800.6 125.5 864.6 49.2"/><path class="s r" d="M520.8 51.6Q630.3 50.2 739.8 50.1M520.2 51.0Q630.4 47.3 739.2 50.4"/><path class="s r" d="M741.5 48.6Q741.5 124.7 740.9 201.2M740.2 48.9Q737.4 125.0 739.5 198.4"/><path class="s r" d="M741.1 200.9Q629.4 198.8 519.0 199.2M739.3 199.0Q629.9 200.2 519.2 200.5"/><path class="s r" d="M520.2 201.4Q519.3 124.9 519.4 50.3M519.6 200.6Q520.6 124.9 518.6 51.3"/><text x="630" y="90" text-anchor="middle" class="big" style="font-size:23px">a pod is</text><text x="630" y="116" text-anchor="middle" class="big" style="font-size:23px">evicted</text><text x="630" y="154" text-anchor="middle" style="font-size:17px">Failed · Evicted</text><text x="630" y="176" text-anchor="middle" style="font-size:17px">not restarted here</text><path class="s" d="M243.5 126.0Q255.6 126.6 267.0 125.7M244.9 123.8Q254.8 126.2 265.5 125.5"/><path class="s" d="M266.0 125.2Q261.5 128.4 256.1 129.9M265.9 124.7Q261.2 127.3 255.7 129.2"/><path class="s" d="M266.0 125.5Q261.4 121.5 255.5 120.0M266.8 124.7Q260.9 122.5 256.1 119.5"/><path class="s" d="M494.2 125.2Q505.6 125.3 517.0 125.3M494.7 124.3Q504.9 124.9 515.7 123.6"/><path class="s" d="M516.0 124.5Q510.9 126.6 506.2 129.8M515.9 124.4Q511.2 127.9 505.8 130.3"/><path class="s" d="M516.4 125.1Q510.9 123.2 506.5 120.4M516.1 124.4Q511.0 122.7 505.3 120.7"/><text x="380" y="235" text-anchor="middle" class="m" style="font-size:17px">BestEffort pods, and pods well above their request, are often at greatest risk</text></svg><figcaption>Before the kernel's OOM killer has to act on the whole node, the kubelet steps in and asks one pod to leave.</figcaption></figure>

To see it without waiting for a real shortage, the lab has a cluster **profile** that tells the kubelet to treat the node as low on memory once less than 75% of it is available. Nothing is edited on a live node: the setting is part of the cluster from the start. Then a BestEffort memory hog runs next to two small, well-behaved pods:

```bash
make clean && make cluster PROFILE=pressure
kubectl -n lab apply -f labs/18-node-pressure-eviction/pods.yaml
# wait a minute, then:
kubectl -n lab get pod memory-hog -o jsonpath='{.status.reason}: {.status.message}'
```

```
Evicted: The node was low on resource: memory. …
Container main was using 721996Ki, request is 0, has larger consumption of memory.
```

The two calm pods kept running. Roughly, the kubelet ranks pods by (1) whether their memory use is above their request, (2) their priority, and (3) how far above their request they are. The hog was using about 700 MiB against a request of 0, so it came first. Treat this as intuition; the [Kubernetes docs](https://kubernetes.io/docs/concepts/scheduling-eviction/node-pressure-eviction/) have the full rules.

| | OOM kill (chapters 16 and 17) | Eviction (here) |
|---|---|---|
| **Who does it** | The kernel | The kubelet |
| **Trigger** | One cgroup hits its own `memory.max` | The whole node gets low on memory |
| **What you see** | `OOMKilled`, exit code 137, container restarts | `Evicted`, pod `Failed`, not restarted here |
| **Who is chosen** | A process in the cgroup over its limit | Ranked by usage vs request, and priority |

*Lab:* [18-node-pressure-eviction](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood/tree/main/labs/18-node-pressure-eviction) (needs `make cluster PROFILE=pressure`). Check what you built with `make check LAB=18`.

> [!KEY]
> When the whole node runs short, the kubelet evicts first and the kernel kills last. Pods using more than they requested, especially BestEffort ones, are at the greatest risk.

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

[Part 2](/blog/cgroups-deep-dive-kubernetes-part-2/#pressure-how-long-tasks-wait) introduced pressure: not how *busy* something is, but how long things *waited*. For memory, waiting means stalling while the kernel reclaims memory to make room. The lab's `psi-memory` pod rereads a 192 MiB file inside a 64Mi limit, so the kernel keeps throwing its cache away and reading it back:

```bash
kubectl -n lab exec psi-memory -- cat /sys/fs/cgroup/memory.pressure
```

```
some avg10=6.35 avg60=2.42 avg300=0.59 total=1967529
full avg10=6.35 avg60=2.42 avg300=0.59 total=1967529
```

`some` and `full` are the same because the pod has one busy process: whenever it waited, *everything* in the pod waited. About 6% of the last 10 seconds was lost to reclaim, and it hasn't been OOM-killed, because file cache can always be dropped. Memory that a program allocates can't, so for a leaking process, rising `memory.pressure` is often the earliest warning you'll get before an OOM kill.

*Lab:* [19-metrics-and-psi](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood/tree/main/labs/19-metrics-and-psi). Check what you built with `make check LAB=19`.

> [!KEY]
> Watch the working set against the limit, `oom_kill` counts and `memory.pressure`. `memory.current` and the usage metric include cache, and will mislead you.

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


*Lab:* [20-pids-and-disk](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood/tree/main/labs/20-pids-and-disk) (needs `make cluster PROFILE=pids`). Check what you built with `make check LAB=20`.

> [!KEY]
> PIDs are capped by a cgroup. Disk space isn't: the kubelet measures it and evicts.

---

### 21. Finale: resize a running pod

*Question: if limits are just numbers in files, can we change them on a live pod?*

Here's the proof that ties the whole series together. Since Kubernetes 1.33, where in-place resize became beta and on by default (it's been stable since 1.35), you can change a running pod's CPU and memory **in place**, with no restart. Remember [chapter 8](/blog/cgroups-deep-dive-kubernetes-part-1/#8-build-a-cgroup-by-hand), where you changed `cpu.max` with `echo` while a process was running? That's all this is.

<figure class="sketch anim"><svg viewBox="0 0 760 250" role="img" aria-label="In-place resize turns the cgroup dial on a running pod"><title>In-place resize turns the cgroup dial on a running pod</title><path class="s b" d="M127.6 59.3Q150.7 49.9 163.5 49.8Q176.2 49.7 188.2 54.2Q200.2 58.7 209.6 67.2Q218.9 75.8 226.2 86.1Q233.4 96.4 236.1 108.6Q238.7 120.9 238.7 133.4Q238.6 145.8 233.2 157.0Q227.8 168.2 221.3 178.9Q214.8 189.6 204.2 196.4Q193.5 203.2 181.3 205.8Q169.1 208.3 156.7 208.0Q144.3 207.8 132.2 204.3Q120.1 200.9 110.7 192.4Q101.3 183.9 93.1 174.2Q84.9 164.4 81.4 151.9Q77.9 139.5 78.8 126.7Q79.7 113.8 86.0 102.8Q92.3 91.9 99.9 82.4Q107.5 72.9 117.3 65.6Q127.2 58.3 139.0 54.8"/><path class="s b" d="M137.0 51.5Q163.3 49.7 176.2 52.2Q189.1 54.6 200.3 61.4Q211.5 68.2 218.7 78.9Q226.0 89.6 232.1 101.0Q238.2 112.3 238.1 125.2Q238.0 138.2 235.1 150.7Q232.3 163.2 224.2 173.2Q216.1 183.1 207.0 192.3Q197.8 201.5 185.4 206.4Q173.1 211.3 160.1 208.9Q147.1 206.5 134.5 203.7Q121.9 200.8 112.6 191.8Q103.4 182.7 95.6 172.6Q87.8 162.5 85.0 150.0Q82.3 137.5 81.2 124.4Q80.1 111.3 85.6 99.2Q91.0 87.1 99.4 76.8Q107.8 66.5 120.1 61.5Q132.3 56.6 144.8 52.7Q157.2 48.8 170.3 50.6"/><g class="anim-knob"><path class="s r" d="M159.3 130.7Q160.6 96.2 159.9 61.1M160.2 128.4Q160.0 95.9 160.5 60.7"/></g><ellipse class="f r" cx="160" cy="130" rx="8" ry="8"/><path class="s" d="M155.3 123.6Q157.6 122.7 158.8 122.2Q160.0 121.7 161.2 122.2Q162.4 122.6 163.5 123.1Q164.6 123.7 165.5 124.5Q166.5 125.3 167.0 126.4Q167.5 127.5 167.7 128.8Q168.0 130.0 167.8 131.2Q167.6 132.4 167.1 133.6Q166.5 134.7 165.6 135.6Q164.7 136.5 163.6 137.0Q162.5 137.5 161.2 137.7Q160.0 137.8 158.8 137.8Q157.5 137.7 156.4 137.1Q155.3 136.5 154.4 135.6Q153.5 134.7 152.9 133.7Q152.2 132.6 152.2 131.3Q152.3 130.0 152.4 128.8Q152.5 127.6 153.0 126.4Q153.5 125.3 154.5 124.5Q155.4 123.7 156.4 123.0"/><path class="s" d="M153.6 134.6Q152.5 132.3 152.1 131.0Q151.7 129.7 152.2 128.5Q152.7 127.3 153.2 126.0Q153.7 124.8 154.7 124.0Q155.7 123.1 156.9 122.6Q158.1 122.0 159.4 122.0Q160.8 121.9 162.0 122.4Q163.2 122.8 164.4 123.4Q165.5 124.1 166.4 125.1Q167.2 126.1 167.4 127.4Q167.6 128.7 167.9 130.0Q168.1 131.3 167.6 132.5Q167.2 133.8 166.3 134.7Q165.4 135.7 164.4 136.6Q163.5 137.5 162.1 137.7Q160.8 137.8 159.6 137.7Q158.3 137.5 157.1 137.1Q155.9 136.7 154.9 135.9Q153.9 135.1 153.3 134.0Q152.8 132.8 152.4 131.6"/><text x="85" y="60" text-anchor="middle" class="m" style="font-size:18px">200m</text><text x="250" y="140" text-anchor="middle" class="m" style="font-size:18px">500m</text><text x="160" y="235" text-anchor="middle" class="code">cpu.max: 20000 → 50000</text><text x="320" y="80" text-anchor="start" class="code">kubectl patch pod … --subresource resize</text><text x="320" y="125" text-anchor="start" style="font-size:20px">the kubelet turns the dial on the live container</text><text x="320" y="160" text-anchor="start" class="g" style="font-size:20px">restartCount stays 0, same container ID</text><text x="320" y="195" text-anchor="start" class="m" style="font-size:18px">(Kubernetes 1.33 and newer)</text></svg><figcaption>In-place resize: change the numbers while the process keeps running.</figcaption></figure>

**Try it yourself.**

```bash
kubectl -n lab apply -f labs/21-in-place-resize/pod.yaml       # 200m CPU, 64Mi memory
kubectl -n lab wait --for=condition=Ready pod/resize-demo
kubectl -n lab exec resize-demo -- cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max

kubectl -n lab patch pod resize-demo --subresource resize --patch \
  '{"spec":{"containers":[{"name":"main","resources":{"requests":{"cpu":"500m","memory":"128Mi"},"limits":{"cpu":"500m","memory":"128Mi"}}}]}}'

kubectl -n lab exec resize-demo -- cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max
kubectl -n lab get pod resize-demo -o jsonpath='restarts={.status.containerStatuses[0].restartCount}{"\n"}'
```

```
20000 100000        ← before: 200m
67108864            ← before: 64 MiB
50000 100000        ← after: 500m
134217728           ← after: 128 MiB
restarts=0
```

The kubelet asked the runtime to rewrite the files of the live container. Same container, same process, new numbers. This was my favourite moment building the lab, because it's the clearest proof that `resources:` really is just a few numbers in a few files.


*Lab:* [21-in-place-resize](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood/tree/main/labs/21-in-place-resize). Check what you built with `make check LAB=21`.

> [!KEY]
> Resize rewrites the cgroup files of a live container. No restart, because there's nothing to restart: it's just a file.

---

## Wrap-up

### Put it to the test

Reading about throttling and knowing it when you see it are different skills. The lab has three small incidents that play like a short on-call shift. Each one sets the scene, shows you what the dashboard shows, and hands you a ticket that sounds like a real page, with a few places to look. Then it leaves the digging to you. It pauses between steps, so take your time.

| # | The ticket | Where the answer is |
|:-:|---|---|
| 1 | "Checkout is slow, but the CPU graph is under its limit" | [Chapters 14 and 15](/blog/cgroups-deep-dive-kubernetes-part-2/#14-cpu-limits-become-a-budget-throttling) |
| 2 | "OOMKilled, but the dashboard never went above half" | Chapters 16 and 17 |
| 3 | "Pending for ages, the node's memory is almost empty" | [Chapter 9](/blog/cgroups-deep-dive-kubernetes-part-1/#9-the-four-checkpoints) and 18 |

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

Three Kubernetes features often mentioned alongside these don't touch cgroups at all, so I've left them out of this series: **ResourceQuota** (a namespace's total budget), **LimitRange** (default and maximum requests per container) and **PriorityClass** (who gets scheduled, and who's evicted, first). They're checked by the API server and the scheduler ([chapter 9](/blog/cgroups-deep-dive-kubernetes-part-1/#9-the-four-checkpoints)). The lab has a hands-on extra for each: `labs/E1-resourcequota`, `labs/E2-limitrange` and `labs/E3-priority-and-preemption`.

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
