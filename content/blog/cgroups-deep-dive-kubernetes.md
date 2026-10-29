---
title: "Cgroups: A Deep Dive into Resource Management in Kubernetes"
date: 2026-10-28
summary: What actually happens when you set CPU and memory requests and limits. I explain it from zero with hand-drawn sketches, plus a small lab so you can watch every step happen on your own laptop.
tags: [linux, kubernetes, cgroups]
---

You're setting up a new deployment. You open an older service's manifest, copy its `resources:` block, nudge the numbers, and ship it.

Most of the time, that's fine. Then one day a pod gets `OOMKilled` while your Grafana dashboard swears it never went above 50% memory. Or a service idles along at 30% CPU while its latency graph climbs, and nobody on the incident call can explain why.

Here's what changed how I look at all of this: Kubernetes decides and configures, but it isn't what holds your process to a CPU or memory limit. The scheduler places the pod, the kubelet writes your numbers into a few small files on the node, and the Linux kernel enforces them, through a feature called control groups, or *cgroups*.

Once you open those files and see what the kernel is doing, the weird production behaviour stops being a mystery. So let's go all the way down, from the YAML you write to the files the kernel reads, with hand-drawn sketches and real commands you can run on your own laptop to watch it happen.

## From YAML to a file on the node

Here's the block everyone writes:

```yaml
resources:
  requests: { cpu: 250m, memory: 64Mi }
  limits:   { cpu: 500m, memory: 128Mi }
```

Your app now can't use more than half a CPU or 128 MiB of memory. Those lines end up as numbers in files under `/sys/fs/cgroup`. The rest of this post is about which number goes into which file, and what the kernel does with it.

> [!TIP]
> You don't need a cloud account for any of this. The lab is [kubernetes-resources-under-the-hood](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood): Docker Desktop, kind and `make`. Every output in this post is copied from a real run on my MacBook.

## The big picture first

Before we open any files, here's the mental model I keep coming back to. Your YAML passes four checkpoints before it touches a process, and everything in this post lives on one of them.

<figure class="sketch "><svg viewBox="0 0 760 440" role="img" aria-label="Four layers handle Kubernetes resource settings"><title>Four layers handle Kubernetes resource settings</title><defs><clipPath id="cbp1"><rect x="30" y="30" width="230" height="70"/></clipPath><clipPath id="cbp2"><rect x="30" y="125" width="230" height="70"/></clipPath><clipPath id="cbp3"><rect x="30" y="220" width="230" height="70"/></clipPath><clipPath id="cbp4"><rect x="30" y="315" width="230" height="70"/></clipPath></defs><path class="h b" clip-path="url(#cbp1)" d="M-30.9 102.0Q-0.5 65.3 30.2 27.2M-22.3 101.0Q9.3 64.9 39.8 28.5M-13.5 101.2Q18.6 66.3 45.9 28.1M-5.7 101.9Q23.6 63.8 56.0 28.0M3.1 103.2Q34.2 65.0 65.7 28.8M12.0 102.6Q42.7 64.3 73.7 28.8M21.1 103.0Q54.0 65.6 82.6 29.2M30.1 101.0Q59.9 64.2 91.1 29.1M39.1 102.7Q69.2 63.7 100.2 28.1M49.4 101.1Q78.8 63.9 109.7 27.3M58.5 101.3Q89.7 66.0 118.2 28.9M66.3 102.7Q96.6 63.7 127.3 27.5M75.3 101.7Q104.3 63.8 135.8 29.1M83.2 103.0Q115.0 64.9 145.6 27.4M93.4 102.9Q123.9 65.3 153.5 27.8M101.1 101.4Q130.1 63.6 162.2 28.2M108.5 102.1Q138.8 63.8 170.9 28.3M117.2 101.9Q149.1 65.6 177.5 27.2M127.4 103.2Q156.7 65.0 187.7 28.5M136.6 102.5Q164.5 63.7 197.6 26.9M146.1 101.0Q175.5 64.8 205.9 28.6M155.7 101.6Q186.0 65.9 216.0 29.0M164.6 102.3Q194.9 65.1 225.0 28.2M174.6 102.5Q203.0 64.4 234.2 28.6M183.4 100.9Q213.4 64.5 243.9 28.0M192.3 101.4Q222.3 65.6 251.0 27.5M201.0 101.9Q229.9 64.7 262.4 27.6M211.0 102.9Q239.4 64.6 270.5 28.2M219.4 102.5Q247.9 64.4 280.5 27.5M226.7 102.3Q257.0 64.6 287.8 27.6M235.5 102.9Q268.4 65.8 296.4 28.5M244.9 101.9Q275.9 64.1 305.5 28.8M254.1 102.3Q283.2 64.2 315.5 28.7"/><path class="s b" d="M29.0 28.4Q144.6 30.9 259.9 30.7M30.6 30.1Q144.7 28.2 260.4 30.8"/><path class="s b" d="M258.7 31.4Q260.9 65.5 260.7 98.8M259.6 30.2Q260.4 65.5 261.2 100.9"/><path class="s b" d="M259.1 100.7Q145.0 97.9 31.0 100.5M261.5 101.5Q144.6 99.4 30.1 100.9"/><path class="s b" d="M29.5 98.7Q29.7 65.5 29.8 30.2M31.0 98.6Q31.3 64.4 31.0 29.0"/><text x="145" y="63" text-anchor="middle" class="big">API server</text><text x="145" y="87" text-anchor="middle" class="m" style="font-size:18px">validates and defaults</text><text x="285" y="72" text-anchor="start" style="font-size:20px">ResourceQuota · LimitRange · PriorityClass</text><path class="h a" clip-path="url(#cbp2)" d="M-31.7 197.0Q-0.6 159.3 30.5 123.8M-22.5 196.3Q10.3 161.5 39.4 122.5M-11.9 196.5Q18.8 160.7 48.6 123.8M-2.2 197.2Q27.7 159.7 57.9 123.1M6.8 196.8Q37.1 160.7 68.4 123.2M15.6 198.1Q46.4 160.5 77.6 122.4M25.7 196.9Q54.0 159.4 85.1 122.3M32.8 196.3Q65.3 161.3 94.2 123.4M43.2 196.1Q72.7 159.3 103.5 122.4M50.8 197.1Q81.5 160.0 111.0 122.3M60.5 197.9Q91.1 160.7 120.5 123.6M70.9 196.3Q101.3 160.8 131.9 123.9M77.2 197.8Q108.0 159.1 138.8 123.7M85.7 197.4Q116.7 159.3 148.2 124.1M95.1 196.3Q125.3 160.0 154.5 122.1M101.9 196.2Q133.3 160.2 162.8 123.8M113.8 196.9Q144.0 160.6 174.2 122.6M120.5 197.5Q152.0 160.1 183.3 122.2M129.7 197.0Q161.6 160.3 190.2 123.9M139.9 197.2Q171.5 160.6 201.0 124.2M150.4 197.8Q179.8 159.6 210.4 124.0M159.3 197.5Q190.8 160.7 219.3 122.6M168.7 196.4Q197.3 158.9 230.4 123.4M176.9 198.2Q208.1 160.4 238.3 123.5M187.2 196.4Q218.0 161.3 247.3 121.9M196.0 197.1Q224.7 159.5 255.9 124.1M203.1 197.2Q236.2 161.5 265.6 121.9M214.0 197.3Q243.4 158.9 273.8 124.1M222.4 197.4Q253.5 159.9 283.9 122.5M231.2 196.2Q261.7 159.3 293.8 122.7M243.2 196.0Q272.8 161.1 303.9 122.8M252.1 197.5Q282.6 161.2 311.8 124.1"/><path class="s a" d="M29.9 124.1Q144.5 125.7 258.6 125.1M29.9 124.2Q144.9 123.3 260.3 124.7"/><path class="s a" d="M261.4 125.7Q258.7 160.6 259.2 193.8M259.5 124.3Q258.5 160.2 260.6 195.2"/><path class="s a" d="M259.0 194.2Q145.2 194.9 31.5 196.3M259.3 194.8Q144.4 192.5 30.4 193.7"/><path class="s a" d="M30.6 195.2Q29.7 159.5 30.4 124.6M30.8 196.1Q29.5 159.8 28.6 123.8"/><text x="145" y="158" text-anchor="middle" class="big">Scheduler</text><text x="145" y="182" text-anchor="middle" class="m" style="font-size:18px">places pods using requests</text><text x="285" y="167" text-anchor="start" style="font-size:20px">requests vs allocatable · preemption</text><path class="h y" clip-path="url(#cbp3)" d="M-31.5 291.8Q0.6 256.0 29.4 218.7M-22.0 292.6Q9.2 255.2 39.7 217.8M-14.4 292.2Q16.2 253.6 47.4 218.4M-4.4 291.0Q26.1 255.4 55.6 218.5M5.2 291.7Q34.1 254.3 64.5 218.5M13.6 292.7Q45.8 256.4 74.1 217.6M22.2 291.7Q54.6 255.8 83.1 217.7M31.4 292.8Q60.9 254.5 92.3 217.2M40.9 292.1Q72.2 255.5 101.9 219.1M50.8 291.0Q81.1 255.8 110.0 218.6M60.5 292.4Q89.3 253.6 120.2 217.3M69.1 293.1Q100.2 255.0 130.7 218.0M78.3 292.8Q109.8 255.9 139.8 218.8M88.5 292.1Q119.9 256.3 149.5 218.7M98.2 291.7Q126.9 255.0 157.1 217.3M105.4 291.1Q136.1 254.1 167.1 218.7M115.2 290.9Q143.3 254.0 174.1 217.2M122.0 291.2Q152.5 254.4 183.0 217.2M132.1 291.4Q162.1 254.8 193.9 219.0M140.2 290.9Q171.9 255.1 202.8 218.7M150.8 292.4Q180.1 254.9 209.8 216.8M158.8 291.2Q188.9 254.9 218.6 217.6M168.3 291.4Q198.6 256.0 228.0 217.2M177.4 291.0Q205.9 254.1 236.9 218.5M185.0 292.9Q215.2 255.4 245.2 218.7M192.9 292.1Q224.9 256.3 254.6 217.2M202.8 291.9Q233.0 254.1 264.7 217.7M213.8 292.8Q241.8 254.0 273.9 216.8M221.3 290.8Q252.2 255.6 283.5 218.7M230.0 291.5Q260.4 255.2 290.3 217.7M238.8 293.1Q268.6 254.6 300.2 218.5M246.9 292.4Q278.9 255.5 309.2 217.2M256.0 291.2Q288.2 255.4 316.6 217.8"/><path class="s y" d="M30.5 220.9Q144.9 222.2 261.0 219.6M29.7 220.6Q144.9 218.5 261.5 220.9"/><path class="s y" d="M259.5 219.5Q259.4 254.4 260.5 288.7M261.0 220.4Q260.6 255.4 258.9 290.9"/><path class="s y" d="M260.0 288.9Q145.1 287.7 30.7 291.6M259.0 291.4Q145.3 290.3 30.4 289.0"/><path class="s y" d="M30.6 289.5Q27.7 255.1 31.4 219.6M28.8 291.3Q29.3 255.6 30.1 220.2"/><text x="145" y="253" text-anchor="middle" class="big">Kubelet</text><text x="145" y="277" text-anchor="middle" class="m" style="font-size:18px">prepares the pod, may evict</text><text x="285" y="262" text-anchor="start" style="font-size:20px">writes cgroups · eviction · PID and disk limits</text><path class="h r" clip-path="url(#cbp4)" d="M-29.7 387.8Q-0.5 350.5 30.2 312.1M-21.0 387.8Q9.0 349.2 38.9 313.1M-12.0 387.4Q15.7 349.3 47.3 313.4M-4.7 386.3Q26.6 350.0 57.2 312.1M4.6 387.2Q35.5 350.2 65.6 313.3M13.5 386.9Q43.9 350.9 73.9 313.3M23.8 387.8Q54.1 350.6 84.4 312.8M31.6 386.8Q62.5 350.2 93.3 312.6M39.9 387.6Q71.1 350.8 100.0 313.2M47.5 385.9Q77.0 349.1 109.1 313.1M55.2 388.0Q86.0 349.3 118.2 313.4M66.6 387.2Q96.5 349.5 127.8 312.0M74.4 386.4Q104.9 349.5 135.9 312.6M83.3 387.2Q115.6 350.9 143.5 311.9M94.6 386.9Q123.3 349.9 153.6 312.5M103.0 386.9Q134.6 351.3 163.4 313.9M114.2 385.9Q143.0 349.0 173.2 313.5M121.1 387.5Q153.9 351.2 183.9 312.9M129.4 386.2Q159.5 349.5 190.3 313.4M139.9 386.3Q169.9 350.1 200.1 314.0M150.2 386.9Q178.9 349.1 209.9 313.1M157.8 386.0Q187.6 350.0 217.4 313.6M166.6 388.2Q195.4 349.2 225.3 312.9M174.3 387.1Q205.6 349.7 236.3 312.7M185.3 387.4Q215.7 350.7 245.3 314.1M192.1 386.9Q223.7 350.8 254.3 313.7M202.5 387.0Q232.0 349.1 262.1 313.2M210.9 385.8Q242.8 349.9 272.6 312.8M221.6 387.2Q250.7 349.0 281.6 313.7M228.7 387.3Q258.3 348.7 290.1 312.4M237.7 386.2Q267.8 348.7 299.6 313.8M247.2 388.1Q276.9 348.8 307.6 313.0M258.0 385.9Q288.9 351.1 317.6 313.9"/><path class="s r" d="M28.6 313.5Q144.7 314.4 261.6 315.8M30.2 314.2Q144.7 315.9 259.9 316.4"/><path class="s r" d="M260.4 313.5Q260.4 350.6 259.7 385.5M261.2 315.3Q261.9 350.2 261.2 384.9"/><path class="s r" d="M260.9 384.1Q145.4 385.4 29.5 384.0M259.1 384.9Q144.6 384.4 29.4 384.8"/><path class="s r" d="M29.1 384.6Q32.6 350.5 28.6 315.6M29.0 384.2Q29.1 349.4 29.7 316.4"/><text x="145" y="348" text-anchor="middle" class="big">Linux kernel</text><text x="145" y="372" text-anchor="middle" class="m" style="font-size:18px">enforces cgroup limits</text><text x="285" y="357" text-anchor="start" style="font-size:20px">cpu.max · cpu.weight · memory.max · OOM · PSI</text><path class="s" d="M143.9 103.4Q144.1 111.8 144.6 122.9M144.4 101.6Q144.9 111.4 143.7 123.2"/><path class="s" d="M144.3 121.8Q142.4 117.2 139.8 111.4M144.7 121.9Q141.9 117.1 140.3 111.5"/><path class="s" d="M145.3 121.4Q147.7 117.4 149.3 111.7M145.6 121.6Q147.8 117.2 149.5 111.8"/><path class="s" d="M145.4 197.2Q145.2 206.4 146.0 218.5M144.1 197.6Q145.8 207.5 145.5 218.5"/><path class="s" d="M144.3 216.9Q143.2 211.7 140.0 206.4M144.6 216.5Q142.2 212.2 140.1 207.1"/><path class="s" d="M144.3 216.7Q146.8 211.5 149.7 206.5M145.3 216.2Q147.7 212.2 149.6 206.9"/><path class="s" d="M145.0 292.3Q146.1 301.4 144.9 311.4M146.3 292.2Q145.1 301.8 144.2 312.5"/><path class="s" d="M145.7 311.8Q141.9 307.5 140.3 302.8M144.9 311.9Q143.3 306.8 139.9 302.6"/><path class="s" d="M144.3 311.4Q148.2 307.7 149.8 301.8M144.5 311.6Q147.4 306.7 150.1 301.7"/><text x="380" y="425" text-anchor="middle" class="m" style="font-size:18px">your YAML enters at the top; each layer makes its own decisions</text></svg><figcaption>Four checkpoints, four jobs. Kubernetes decides and configures; the kernel enforces CPU and memory limits.</figcaption></figure>

Let's follow one pod through all four, from the moment you run `kubectl apply`:

1. **API server.** Before the pod is even saved, admission checks run. Does the namespace have a ResourceQuota, and would this pod go over it? Does a LimitRange need to fill in missing requests or limits? Which PriorityClass does it belong to? If any check fails, you get an error and the pod never exists.
2. **Scheduler.** The pod is saved but has no node yet. The scheduler looks for a node whose *allocatable* resources can still fit the pod's *requests*. It doesn't look at real usage at all. If nothing fits, the pod stays `Pending`, or a lower-priority pod gets pushed out to make room.
3. **Kubelet.** The kubelet on the chosen node creates a cgroup for the pod and one for each container, writes your numbers into their files, and starts the containers inside them. After that it keeps watching the node: if memory or disk runs low, it evicts pods.
4. **Kernel.** From here on, every CPU tick and every memory allocation of your process is checked against those files. The kernel is what throttles CPU and OOM-kills processes. (The kubelet can also stop a whole pod, by evicting it.)

Every lesson below sits on one of these layers. When something goes wrong in production, asking "which layer did this?" is usually the fastest way to the answer.

## Set up the lab (5 minutes)

You need Docker Desktop (give it at least 4 CPUs and 6 GB of memory), plus `kind` and `kubectl`.

```bash
brew install kind kubectl          # on Windows, use WSL2: see the repo README
git clone https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood.git
cd kubernetes-resources-under-the-hood
make cluster                       # a 2-node cluster inside Docker
```

On Windows, run the same commands inside an Ubuntu terminal on WSL2. The [repo README](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood#setup) has the one extra setting needed to make sure WSL2 uses cgroups v2.

### What `make cluster` gives you

[kind](https://kind.sigs.k8s.io/) ("Kubernetes in Docker") runs each Kubernetes node as a Docker container on your laptop. `make cluster` creates a cluster called `under-the-hood` with two nodes:

- **`under-the-hood-control-plane`** runs the API server, the scheduler and the other control-plane parts.
- **`under-the-hood-worker`** is where every lab pod runs. Each manifest pins its pods there with a `nodeSelector`, so the lab always knows which node to inspect.

Because a kind node is just a Docker container, it has its own real cgroup tree and a real kubelet, the same pieces you'd find on a GKE or EKS node.

### How the lab is laid out

The repo has one folder per lesson under `modules/`. Each folder holds:

- **The manifests:** plain YAML pods (plus a quota, LimitRange or PriorityClass where needed). Open them; they're short.
- **A `README.md`:** a step-by-step walkthrough. You type each command yourself, and every step shows what you should see and what it means.
- **`run.sh`:** the same steps as one script, which `make` runs and then checks the results with `PASS`/`FAIL` lines.

There's also `scripts/pod-cgroup.sh`, a small helper that prints where a pod's cgroup folder is on the node, so you don't have to dig through the tree by hand.

### Two ways to use it

**By hand (recommended the first time).** Every lesson below has a *Try it yourself* section with the exact commands, run from the repo folder, and the output I got. Type them in order and read the explanation after each one. That's where the learning is.

**With `make` (to check or repeat).** Each lesson's commands are bundled into one target:

| Command | What it does |
|---|---|
| `make <module>` | Run one lesson's steps and check the results, e.g. `make 04-memory-and-oom` |
| `KEEP=1 make <module>` | Same, but leave the pods running so you can poke around |
| `make all` | Run every lesson in order |
| `make reset` | Remove everything the lab created, keep the cluster |
| `make clean` | Delete the whole cluster |

Every `make` run cleans up its own pods afterwards, even if a check fails or you press Ctrl-C.

## The Linux you need for this post

You don't need to know the kernel to follow along, just five ideas. Everything else gets explained when it shows up.

**1. The kernel is the boss.** The Linux kernel is the core of the operating system. Every program asks it for CPU time and memory, and it decides who gets what. Kubernetes runs *on top of* it, so when a process is held to a CPU or memory limit, it's the kernel doing the holding.

**2. Every running program is a process with a number.** Each process gets an ID, its *PID*. Inside a container, the first program to start sees itself as PID 1.

**3. Some folders aren't really folders.** `/proc` and `/sys` look like normal folders full of files, but nothing in them is stored on disk. They're windows into the kernel. Reading a file there asks the kernel a question ("how much memory has this group used?") and the answer is generated on the spot. Writing to one changes a live setting. `/sys/fs/cgroup` is the part of `/sys` that holds cgroups, and it's where most of this post happens.

**4. The units are small.** Kernel files rarely use friendly units:

| You'll see | Means | Example |
|---|---|---|
| `usec` / microseconds | millionths of a second | `100000` = 100 ms = 0.1 s |
| bytes | raw bytes | `134217728` = 128 MiB |
| `Ki`, `Mi`, `Gi` | ×1024, ×1024², ×1024³ bytes | `128Mi` = 128 × 1,048,576 bytes |
| millicores (`m`) | thousandths of one CPU | `250m` = a quarter of a CPU |

**5. Two ways to look inside.** You'll use two commands all the time:

- `kubectl exec <pod> -- <command>` runs a command *inside a container*. With cgroups v2, a container sees only its own cgroup at `/sys/fs/cgroup`, so `kubectl exec <pod> -- cat /sys/fs/cgroup/cpu.max` shows exactly that container's CPU limit.
- `docker exec under-the-hood-worker <command>` runs a command *on the node*, because a kind node is just a Docker container. From there you can see the whole tree, including the folders for pods and QoS classes that a container can't see. On a real cluster this is the same as SSH-ing into the node.

Every command in this post is typed in a terminal on **your own machine**, from the lab's folder. `kubectl exec` carries it into a pod, and `docker exec` carries it onto the node.

## Containers in one minute

There's one more idea that ties everything together: what a container actually is. You don't need the full story, just this:

**A container is a group of ordinary Linux processes with two things wrapped around them.**

<figure class="sketch "><svg viewBox="0 0 760 300" role="img" aria-label="A container is processes plus namespaces and cgroups"><title>A container is processes plus namespaces and cgroups</title><defs><clipPath id="cct1"><rect x="40" y="70" width="190" height="100"/></clipPath><clipPath id="cct2"><rect x="250" y="70" width="190" height="100"/></clipPath><clipPath id="cct3"><rect x="510" y="90" width="220" height="110"/></clipPath></defs><path class="s b" d="M21.2 40.2Q239.7 39.1 460.5 40.1M20.8 40.5Q240.3 39.6 461.0 39.8"/><path class="s b" d="M459.1 40.4Q461.2 155.2 460.3 268.8M461.0 39.2Q458.2 155.4 460.6 270.7"/><path class="s b" d="M461.2 270.5Q240.2 271.3 21.3 268.7M459.1 271.1Q240.1 270.9 21.0 269.4"/><path class="s b" d="M20.5 270.0Q18.6 154.9 19.7 38.7M19.8 270.7Q18.3 155.3 20.1 41.1"/><text x="36" y="30" text-anchor="start" style="font-size:20px">a container = ordinary Linux processes, set up by the runtime</text><path class="s" d="M81.1 210.4Q95.8 207.5 103.7 207.1Q111.5 206.7 119.2 207.4Q127.0 208.1 134.8 209.3Q142.6 210.5 148.4 213.3Q154.1 216.1 157.4 219.6Q160.8 223.2 160.7 226.9Q160.6 230.7 160.0 234.4Q159.5 238.2 154.8 241.2Q150.1 244.3 145.1 247.3Q140.1 250.4 132.4 251.8Q124.7 253.3 116.6 253.8Q108.4 254.4 100.4 253.6Q92.3 252.8 85.3 250.8Q78.4 248.9 72.2 246.4Q66.0 243.8 62.2 240.4Q58.5 236.9 58.7 233.1Q59.0 229.3 60.1 225.6Q61.3 221.9 64.7 218.5Q68.2 215.1 74.3 212.5Q80.3 209.9 87.9 208.5"/><path class="s" d="M58.9 237.7Q58.8 229.7 60.4 226.0Q61.9 222.2 65.2 218.6Q68.5 215.0 75.3 212.6Q82.0 210.2 89.3 208.2Q96.6 206.1 105.2 206.2Q113.8 206.4 122.3 206.8Q130.9 207.2 137.6 209.7Q144.3 212.2 150.4 215.0Q156.4 217.8 159.2 221.6Q162.0 225.4 162.2 229.4Q162.4 233.3 159.0 236.9Q155.6 240.5 150.7 243.6Q145.7 246.7 138.9 248.8Q132.0 250.9 124.2 252.1Q116.4 253.3 108.0 253.5Q99.6 253.8 92.1 252.0Q84.7 250.1 78.1 247.8Q71.5 245.5 66.6 242.3Q61.7 239.2 60.5 235.3Q59.4 231.5 59.9 227.7"/><text x="110" y="236" text-anchor="middle" style="font-size:18px">app</text><path class="s" d="M257.2 254.1Q241.1 253.0 232.8 252.4Q224.6 251.9 218.4 249.3Q212.2 246.7 207.4 243.7Q202.5 240.6 200.4 236.9Q198.3 233.3 198.6 229.5Q198.8 225.8 200.7 222.0Q202.7 218.3 207.8 215.3Q213.0 212.2 219.9 210.1Q226.8 207.9 235.0 207.5Q243.2 207.0 251.2 206.6Q259.2 206.2 267.3 207.2Q275.3 208.2 281.6 210.7Q287.9 213.2 292.4 216.4Q296.8 219.5 299.5 223.1Q302.1 226.7 301.0 230.4Q300.0 234.1 298.3 237.8Q296.6 241.5 291.6 244.6Q286.7 247.7 279.3 249.3Q272.0 251.0 264.5 252.4Q257.1 253.8 248.9 253.8"/><path class="s" d="M218.6 249.5Q205.9 244.0 202.3 240.4Q198.6 236.8 198.7 232.8Q198.8 228.8 200.8 225.1Q202.8 221.4 206.1 217.8Q209.3 214.1 216.2 211.7Q223.0 209.3 230.8 207.6Q238.7 206.0 247.3 205.8Q256.0 205.5 263.9 207.1Q271.8 208.6 279.0 210.6Q286.3 212.6 290.9 215.8Q295.5 219.1 299.0 222.7Q302.5 226.3 302.2 230.3Q301.9 234.2 298.3 237.8Q294.8 241.3 290.0 244.5Q285.2 247.7 278.1 249.9Q271.1 252.1 262.8 252.8Q254.5 253.5 246.3 253.1Q238.0 252.8 230.1 251.5Q222.2 250.2 216.5 247.4Q210.8 244.6 206.0 241.5"/><text x="250" y="236" text-anchor="middle" style="font-size:18px">worker</text><path class="h a" clip-path="url(#cct1)" d="M-46.1 172.5Q-1.9 120.7 40.5 66.9M-36.7 171.2Q6.4 119.1 51.4 67.3M-25.6 170.9Q17.5 120.2 62.0 67.5M-17.4 172.1Q27.9 120.5 70.5 68.5M-7.4 172.0Q37.2 119.9 80.9 68.7M3.8 171.0Q47.6 119.5 91.8 69.2M13.4 171.7Q58.5 120.9 101.0 68.9M23.3 173.0Q65.8 119.5 110.2 68.8M33.6 173.0Q78.3 121.4 121.1 69.1M41.9 173.0Q87.5 120.7 129.6 68.1M53.5 171.5Q96.6 120.1 140.9 69.0M62.2 172.4Q107.6 120.8 149.4 67.4M74.9 171.5Q116.1 119.8 160.4 68.1M85.2 171.8Q126.3 118.5 172.2 67.9M94.2 171.2Q136.3 118.7 181.2 67.0M105.8 172.5Q149.8 121.3 191.9 67.9M114.2 172.8Q158.8 121.3 201.8 69.1M124.2 171.8Q166.8 118.9 210.7 66.9M135.5 172.9Q178.0 120.7 221.6 67.7M145.5 172.0Q188.0 120.1 231.5 68.4M153.5 172.0Q197.1 119.0 240.0 68.1M162.8 172.7Q207.4 121.1 251.0 69.1M171.6 172.0Q217.3 121.1 258.7 68.1M184.8 171.7Q228.0 120.3 271.6 67.1M193.1 172.1Q238.2 120.8 279.5 67.3M202.3 171.6Q245.8 119.9 289.0 68.6M211.6 172.9Q253.9 118.8 299.7 68.8M222.0 171.4Q265.0 119.0 308.8 67.6"/><path class="s a" d="M40.8 70.5Q135.5 70.1 230.3 71.4M38.7 69.8Q135.0 70.1 229.7 68.8"/><path class="s a" d="M229.2 69.7Q227.1 119.9 231.1 171.5M229.3 69.7Q230.8 120.5 229.8 171.1"/><path class="s a" d="M230.6 170.4Q135.5 170.6 38.5 169.4M229.9 170.1Q134.9 167.7 39.9 169.7"/><path class="s a" d="M39.8 170.9Q42.5 119.9 39.2 69.9M38.6 170.5Q40.8 119.5 41.0 70.5"/><text x="135" y="108" text-anchor="middle" class="big" style="font-size:23px">namespaces</text><text x="135" y="138" text-anchor="middle" style="font-size:17px">what the processes see</text><path class="h r" clip-path="url(#cct2)" d="M163.0 171.6Q206.4 120.2 249.4 67.7M172.4 171.8Q214.8 118.5 260.2 68.5M182.8 173.2Q224.7 119.0 269.4 67.8M192.9 172.3Q234.9 118.7 279.9 67.2M202.1 172.7Q248.2 121.3 289.1 69.2M213.1 173.0Q253.9 118.4 298.4 68.9M221.6 171.4Q265.7 121.2 308.5 66.8M230.8 171.6Q274.3 120.4 317.1 66.9M242.1 172.3Q285.4 120.7 328.4 68.9M252.8 173.1Q296.4 120.6 339.4 68.0M260.9 172.6Q303.6 119.1 348.9 67.5M272.2 173.1Q315.6 120.9 358.2 68.3M283.3 171.8Q325.4 119.8 368.2 68.0M293.5 172.8Q337.5 121.1 379.8 67.5M302.8 171.4Q344.9 120.1 389.0 68.6M310.9 173.2Q355.4 120.5 398.6 67.4M322.6 171.7Q366.6 121.0 409.4 68.6M333.5 172.0Q375.6 119.4 420.1 68.2M343.1 172.6Q385.9 119.8 429.7 68.1M352.7 172.5Q396.3 119.9 439.6 67.8M361.7 171.0Q405.1 118.6 450.6 69.0M372.8 171.1Q417.4 121.2 460.0 67.1M382.4 172.1Q424.6 119.5 468.5 67.2M391.9 171.4Q435.8 120.7 478.3 67.7M403.6 172.6Q446.9 120.7 488.2 67.0M411.8 171.3Q455.9 120.9 498.0 68.9M420.7 172.4Q465.4 121.0 508.4 67.8M429.8 171.6Q474.0 119.4 518.0 68.0M439.7 173.1Q484.7 121.3 527.1 67.6"/><path class="s r" d="M251.0 68.8Q344.6 72.0 440.7 70.6M249.5 70.1Q345.3 68.5 439.7 69.2"/><path class="s r" d="M438.8 68.5Q441.9 120.6 440.1 169.2M439.4 69.7Q437.9 119.4 439.8 169.7"/><path class="s r" d="M439.1 171.0Q345.6 170.5 249.0 169.1M440.9 169.0Q345.2 171.0 251.4 169.0"/><path class="s r" d="M249.6 169.1Q252.0 119.5 249.9 70.9M249.3 171.4Q251.9 119.4 250.8 70.8"/><text x="345" y="108" text-anchor="middle" class="big" style="font-size:23px">cgroups</text><text x="345" y="138" text-anchor="middle" style="font-size:17px">how much they may use</text><path class="h y" clip-path="url(#cct3)" d="M414.6 201.1Q460.9 144.2 510.9 88.2M426.0 202.0Q474.1 145.8 521.1 88.5M435.2 201.9Q484.0 145.4 531.1 88.3M447.8 202.2Q494.1 144.5 543.5 87.4M457.3 202.2Q503.4 144.3 551.6 87.0M467.0 201.7Q515.9 145.9 563.2 88.0M478.0 201.3Q524.2 145.1 572.3 88.5M486.4 202.5Q534.4 144.6 583.3 87.0M497.5 201.3Q544.2 143.6 593.8 86.8M507.8 202.7Q556.6 146.1 603.5 87.8M516.5 201.5Q565.5 146.1 612.4 89.2M526.3 202.6Q574.8 144.8 623.0 88.9M537.6 201.3Q584.9 144.6 634.0 88.9M546.7 201.0Q594.5 143.9 643.1 86.9M555.9 201.5Q606.2 145.8 652.2 89.1M566.6 203.1Q615.5 146.3 663.1 88.3M576.4 201.8Q623.0 144.2 671.8 89.1M585.5 202.5Q635.9 145.8 681.3 88.4M596.5 202.5Q643.8 145.2 690.7 88.0M605.8 200.9Q652.8 144.5 701.0 88.0M614.7 201.2Q664.1 145.5 712.1 87.9M625.6 202.1Q672.6 144.2 722.1 88.7M635.7 201.6Q684.8 146.0 731.9 88.1M645.3 203.1Q693.7 145.3 743.2 88.4M656.7 202.5Q704.1 145.4 750.3 89.1M665.5 202.8Q712.8 144.2 762.4 88.8M675.3 200.9Q723.5 144.5 772.2 87.1M685.9 201.5Q733.2 144.4 780.7 87.9M695.9 201.6Q745.3 146.3 792.7 88.3M707.1 201.4Q753.5 144.5 802.1 88.7M716.5 201.8Q762.7 143.9 811.4 87.1M724.5 201.0Q773.3 145.0 820.4 88.2"/><path class="s y" d="M510.3 89.1Q619.8 87.9 729.1 90.8M510.4 89.6Q620.3 90.2 729.9 89.1"/><path class="s y" d="M729.6 89.2Q728.8 145.0 730.0 199.4M731.1 88.6Q730.5 145.4 730.9 199.6"/><path class="s y" d="M729.7 199.4Q619.9 202.4 510.1 200.2M728.6 200.7Q620.5 198.5 510.0 200.3"/><path class="s y" d="M509.2 201.5Q511.5 144.4 511.4 89.9M511.2 200.0Q508.4 144.8 509.3 88.6"/><text x="620" y="130" text-anchor="middle" class="big" style="font-size:22px">container runtime</text><text x="620" y="158" text-anchor="middle" class="m" style="font-size:17px">containerd, CRI-O</text><text x="620" y="182" text-anchor="middle" style="font-size:17px">creates and starts them</text><path class="s" d="M505.8 146.1Q484.8 145.6 465.5 144.8M505.1 145.4Q484.4 144.4 464.3 146.2"/><path class="s" d="M465.0 144.2Q469.8 142.0 475.0 139.7M465.3 144.4Q470.4 143.4 474.9 140.1"/><path class="s" d="M465.8 145.2Q469.6 148.6 475.2 150.1M465.7 145.7Q469.8 148.3 474.4 150.2"/><text x="620" y="240" text-anchor="middle" class="m" style="font-size:17px">the kubelet tells the runtime</text><text x="620" y="262" text-anchor="middle" class="m" style="font-size:17px">what to create</text><path class="s" d="M620.8 223.4Q621.1 214.8 619.6 204.1M618.8 223.6Q618.7 215.0 620.4 205.9"/><path class="s" d="M619.8 204.8Q622.5 210.0 625.4 214.3M619.9 204.5Q622.0 210.2 625.5 214.9"/><path class="s" d="M620.7 204.7Q618.3 210.4 614.6 214.9M620.0 205.0Q616.5 209.9 615.4 215.3"/></svg><figcaption>Namespaces decide what a container's processes can see. Cgroups decide how much they can use.</figcaption></figure>

- **Namespaces** control what the processes can *see*. A process in its own namespaces sees its own list of processes (which is why the main one is PID 1), its own network, its own files. It's a private view of a shared machine.
- **Cgroups** control how much they can *use*: CPU, memory, number of processes. That's the subject of this post.
- **The container runtime** (containerd on this lab's nodes, or CRI-O) creates the processes and sets both up. The kubelet tells it what to create, including the requests and limits from your pod spec.

So the full journey is: the scheduler places the pod using its requests; on the node, the kubelet asks the runtime to start the containers inside cgroups carrying your numbers; and the kernel applies those controls from then on.

### Why `/sys/fs/cgroup` looks different inside a container

There's one namespace worth knowing by name, because you'll bump into it straight away: the **cgroup namespace**. It changes the cgroup *paths* a process sees, so that a container's own cgroup appears as the top of the tree.

<figure class="sketch "><svg viewBox="0 0 760 290" role="img" aria-label="A cgroup namespace shortens the paths a process sees"><title>A cgroup namespace shortens the paths a process sees</title><text x="20" y="34" text-anchor="start" style="font-size:21px">the same container cgroup, seen from two places</text><path class="s b" d="M19.9 55.4Q380.2 52.9 740.7 54.9M19.7 55.8Q379.5 54.9 740.1 55.6"/><path class="s b" d="M740.8 54.7Q739.9 105.3 739.0 155.0M740.0 55.2Q740.3 105.1 739.7 153.9"/><path class="s b" d="M739.5 155.9Q380.4 157.0 20.1 154.0M740.4 154.0Q380.1 154.0 20.3 155.7"/><path class="s b" d="M20.5 154.2Q21.4 105.0 20.8 55.7M19.2 155.3Q18.4 104.9 21.1 55.1"/><text x="36" y="82" text-anchor="start" class="m" style="font-size:17px">on the node (docker exec under-the-hood-worker …)</text><text x="36" y="110" text-anchor="start" class="code">/sys/fs/cgroup/kubelet.slice/kubelet-kubepods.slice/</text><text x="36" y="134" text-anchor="start" class="code">   …-burstable.slice/…-pod&lt;uid&gt;.slice/cri-containerd-&lt;id&gt;.scope/cpu.max</text><path class="s a" d="M21.1 190.5Q380.0 188.8 738.9 191.1M19.0 190.4Q379.6 190.0 739.2 190.7"/><path class="s a" d="M738.9 188.8Q741.5 227.4 741.0 266.1M741.0 190.9Q741.7 228.0 739.6 265.5"/><path class="s a" d="M740.8 265.9Q380.4 265.2 19.7 265.5M739.8 265.4Q379.7 267.0 20.2 264.4"/><path class="s a" d="M19.6 264.2Q20.7 227.3 19.2 190.8M21.1 264.3Q21.2 227.7 19.3 189.3"/><text x="36" y="216" text-anchor="start" class="m" style="font-size:17px">inside the container (kubectl exec &lt;pod&gt; …)</text><text x="36" y="244" text-anchor="start" class="code">/sys/fs/cgroup/cpu.max</text><path class="s" d="M599.9 156.6Q601.0 171.6 598.5 186.1M601.2 159.4Q599.7 172.5 600.3 185.2"/><path class="s" d="M599.2 186.3Q597.0 181.2 594.6 176.3M599.8 185.7Q596.9 181.1 594.8 175.5"/><path class="s" d="M599.3 185.6Q602.7 180.9 605.1 175.7M599.4 185.6Q602.4 181.3 605.2 176.1"/><text x="612" y="178" text-anchor="start" style="font-size:17px">same file</text></svg><figcaption>A cgroup namespace changes the paths a process sees; it doesn't set the resource limit.</figcaption></figure>

That's why `kubectl exec <pod> -- cat /sys/fs/cgroup/cpu.max` works without a long path. It's the same file the node sees deep inside its tree. The namespace only changes the view; the limits come from the cgroup itself.

## Lesson 1: A cgroup is just a folder

Imagine a box. You put some processes in it, and the box has dials on the side: *how much CPU*, *how much memory*, *how many processes*. The kernel keeps every process inside the box within those dial settings.

That box is a **cgroup** (control group), and on Linux it really is a folder under `/sys/fs/cgroup`. The dials are files in that folder. Write `50000 100000` into `cpu.max` and the kernel starts limiting CPU for everything in that folder. No restart, no API call: just a file.

<figure class="sketch "><svg viewBox="0 0 760 300" role="img" aria-label="A cgroup holds processes and has files that act as dials"><title>A cgroup holds processes and has files that act as dials</title><path class="s a" d="M40.3 40.4Q205.1 38.5 368.6 38.4M41.6 39.9Q204.7 41.4 371.1 39.9"/><path class="s a" d="M371.2 40.1Q368.8 150.2 370.8 260.5M369.4 38.5Q372.6 150.1 371.2 259.9"/><path class="s a" d="M371.3 259.7Q205.5 259.2 41.0 259.8M368.8 259.1Q205.5 257.3 41.5 259.8"/><path class="s a" d="M39.6 259.5Q40.4 150.0 40.3 40.3M41.1 261.6Q42.3 150.5 40.5 38.9"/><text x="55" y="30" text-anchor="start" style="font-size:22px">a cgroup (just a folder!)</text><path class="s" d="M151.6 89.3Q161.7 95.7 164.2 99.6Q166.7 103.5 167.7 107.6Q168.6 111.7 166.2 115.5Q163.7 119.4 160.8 123.2Q157.8 127.0 151.8 129.5Q145.8 132.1 138.8 133.4Q131.7 134.8 124.4 135.0Q117.0 135.2 109.4 135.0Q101.8 134.8 95.1 132.7Q88.3 130.7 84.5 127.1Q80.6 123.5 76.6 120.0Q72.5 116.6 72.5 112.5Q72.4 108.3 74.4 104.5Q76.5 100.6 80.0 97.1Q83.6 93.6 88.7 90.6Q93.8 87.6 100.8 85.9Q107.8 84.2 115.4 84.5Q123.0 84.9 130.4 85.3Q137.9 85.6 143.8 88.1Q149.7 90.6 155.4 93.3"/><path class="s" d="M96.0 133.3Q83.2 128.1 79.6 124.2Q76.0 120.4 73.2 116.3Q70.5 112.2 72.3 108.0Q74.0 103.8 77.4 100.1Q80.8 96.4 85.3 93.0Q89.8 89.5 97.0 87.9Q104.2 86.4 111.6 85.5Q119.1 84.6 126.7 85.0Q134.4 85.4 141.5 87.1Q148.6 88.9 153.5 92.2Q158.4 95.4 161.5 99.2Q164.6 102.9 166.9 107.0Q169.2 111.1 166.7 115.2Q164.2 119.3 161.1 123.2Q158.0 127.2 151.9 130.0Q145.7 132.8 138.1 134.0Q130.4 135.1 122.7 135.5Q115.0 135.8 107.4 134.7Q99.9 133.6 93.3 131.3Q86.6 129.1 81.9 125.6"/><text x="120" y="116" text-anchor="middle" style="font-size:19px">nginx</text><path class="s" d="M214.9 110.5Q221.7 103.0 227.8 100.6Q234.0 98.1 240.9 96.6Q247.8 95.0 255.3 94.3Q262.7 93.6 269.9 94.9Q277.1 96.2 283.5 98.2Q289.9 100.1 295.8 102.8Q301.7 105.5 304.1 109.4Q306.5 113.4 307.3 117.4Q308.1 121.5 305.6 125.3Q303.2 129.1 300.1 132.7Q297.0 136.3 291.5 139.2Q286.1 142.0 279.0 143.1Q271.8 144.3 264.5 145.2Q257.3 146.2 249.9 145.3Q242.5 144.5 236.5 142.0Q230.6 139.5 224.9 136.9Q219.3 134.2 216.5 130.4Q213.7 126.6 212.6 122.6Q211.5 118.5 213.6 114.6Q215.7 110.7 219.0 107.0"/><path class="s" d="M256.4 94.9Q271.5 95.6 279.0 96.8Q286.5 97.9 292.7 100.6Q298.9 103.4 301.7 107.4Q304.4 111.4 306.1 115.5Q307.8 119.6 306.9 123.8Q306.0 128.0 302.0 131.7Q298.1 135.3 292.6 138.2Q287.1 141.2 280.0 142.9Q273.0 144.7 265.4 145.2Q257.7 145.7 250.0 145.0Q242.3 144.4 235.9 142.0Q229.5 139.6 224.3 136.4Q219.2 133.3 215.7 129.5Q212.2 125.7 213.0 121.4Q213.9 117.2 215.1 113.1Q216.3 108.9 220.5 105.3Q224.8 101.7 231.5 99.5Q238.1 97.2 245.5 96.0Q252.8 94.8 260.7 94.3Q268.5 93.8 275.5 95.7"/><text x="260" y="126" text-anchor="middle" style="font-size:19px">worker</text><path class="s" d="M188.3 223.9Q173.9 226.3 166.5 225.4Q159.2 224.6 152.2 223.2Q145.3 221.9 139.6 219.3Q134.0 216.7 129.3 213.5Q124.6 210.2 123.5 206.1Q122.4 202.1 122.3 197.9Q122.2 193.8 126.1 190.3Q130.0 186.8 134.6 183.6Q139.1 180.5 145.3 178.1Q151.4 175.7 158.7 174.6Q166.1 173.4 173.6 174.1Q181.1 174.8 187.8 176.5Q194.5 178.2 200.0 180.9Q205.5 183.5 210.0 186.8Q214.4 190.0 215.6 194.0Q216.8 198.0 217.3 202.1Q217.7 206.2 214.8 210.0Q211.9 213.9 206.2 216.6Q200.5 219.3 194.3 221.5Q188.1 223.6 181.0 225.1"/><path class="s" d="M139.1 179.4Q153.5 175.9 161.1 175.3Q168.7 174.7 176.3 175.1Q183.9 175.5 191.3 177.0Q198.7 178.5 203.6 181.8Q208.5 185.2 212.0 188.9Q215.5 192.6 216.6 196.8Q217.7 200.9 216.2 205.0Q214.6 209.2 210.7 212.8Q206.8 216.4 201.4 219.6Q196.1 222.7 188.3 223.7Q180.6 224.7 173.0 224.8Q165.5 225.0 157.5 224.7Q149.6 224.4 143.0 222.0Q136.4 219.5 131.3 216.1Q126.3 212.7 124.6 208.5Q122.9 204.3 122.0 200.0Q121.1 195.7 123.7 191.6Q126.3 187.5 132.0 184.5Q137.7 181.5 143.7 178.7Q149.7 176.0 157.3 174.7"/><text x="170" y="206" text-anchor="middle" style="font-size:19px">worker</text><text x="205" y="250" text-anchor="middle" class="m" style="font-size:17px">processes live inside</text><path class="s" d="M369.5 69.1Q400.0 70.4 428.6 70.3M371.3 70.6Q400.4 68.5 431.4 71.3"/><path class="s b" d="M468.2 58.1Q470.3 63.9 471.3 66.9Q472.3 69.9 471.5 72.9Q470.6 75.9 469.3 78.7Q468.0 81.5 466.0 83.9Q464.0 86.3 461.1 87.7Q458.3 89.0 455.2 89.5Q452.1 89.9 448.9 89.8Q445.7 89.6 443.0 88.0Q440.2 86.4 438.1 84.0Q436.1 81.7 434.7 78.9Q433.3 76.2 432.4 73.1Q431.5 70.1 432.2 67.0Q433.0 63.9 434.2 61.0Q435.4 58.1 437.9 56.1Q440.3 54.0 443.1 52.7Q445.9 51.4 448.9 50.7Q451.9 50.0 455.1 50.2Q458.2 50.5 460.8 52.3Q463.4 54.1 465.9 56.0Q468.5 57.9 470.0 60.7"/><path class="s b" d="M459.0 50.8Q464.1 54.9 466.6 57.0Q469.0 59.1 470.5 62.1Q471.9 65.1 471.6 68.4Q471.3 71.7 470.7 74.8Q470.0 77.9 468.3 80.6Q466.5 83.3 464.1 85.4Q461.7 87.5 458.6 88.6Q455.5 89.6 452.3 89.7Q449.0 89.7 445.9 88.9Q442.7 88.1 440.4 85.8Q438.1 83.4 436.3 80.9Q434.5 78.3 433.6 75.3Q432.7 72.2 432.8 69.1Q433.0 65.9 434.2 63.0Q435.3 60.1 437.0 57.2Q438.6 54.3 441.5 52.6Q444.4 51.0 447.7 50.8Q451.0 50.6 454.2 50.7Q457.4 50.7 460.3 52.2Q463.2 53.7 465.5 55.9"/><path class="s b" d="M451.8 69.6Q456.9 63.9 461.8 57.5M451.5 69.6Q457.2 64.0 461.8 58.1"/><text x="485" y="68" text-anchor="start" class="code">cpu.max</text><text x="485" y="90" text-anchor="start" class="m" style="font-size:18px">how much CPU</text><path class="s" d="M370.4 139.8Q399.8 141.6 429.6 140.0M369.9 139.2Q399.9 141.1 430.1 140.6"/><path class="s b" d="M469.9 148.6Q466.4 153.8 464.0 155.9Q461.7 158.1 458.7 159.2Q455.7 160.3 452.5 160.0Q449.3 159.6 446.2 159.1Q443.1 158.5 440.5 156.6Q437.9 154.7 436.3 152.0Q434.7 149.3 433.5 146.4Q432.4 143.5 432.5 140.5Q432.7 137.4 433.1 134.2Q433.6 131.1 435.5 128.6Q437.4 126.0 439.8 124.0Q442.3 121.9 445.3 120.9Q448.4 119.9 451.6 119.9Q454.7 120.0 457.8 120.8Q460.8 121.7 463.4 123.6Q465.9 125.5 467.5 128.1Q469.1 130.8 470.5 133.6Q471.8 136.4 471.5 139.5Q471.1 142.6 470.3 145.5Q469.6 148.5 468.1 151.3"/><path class="s b" d="M470.7 145.3Q468.0 151.1 466.1 153.8Q464.2 156.5 461.1 157.5Q458.0 158.6 454.9 159.0Q451.7 159.3 448.4 159.3Q445.1 159.3 442.5 157.3Q439.9 155.3 437.4 153.2Q434.8 151.2 433.6 148.1Q432.4 145.0 432.0 141.7Q431.6 138.4 432.3 135.2Q433.0 131.9 435.0 129.2Q437.0 126.6 439.5 124.4Q442.0 122.2 445.2 121.6Q448.4 121.0 451.6 120.4Q454.8 119.8 457.9 121.0Q461.0 122.1 463.7 123.9Q466.5 125.8 468.0 128.6Q469.5 131.5 470.9 134.5Q472.2 137.5 472.2 140.8Q472.2 144.2 470.5 147.0Q468.7 149.8 466.8 152.4"/><path class="s b" d="M451.6 139.7Q457.3 134.0 462.1 128.3M451.8 139.9Q456.8 133.8 461.5 128.0"/><text x="485" y="138" text-anchor="start" class="code">memory.max</text><text x="485" y="160" text-anchor="start" class="m" style="font-size:18px">how much RAM</text><path class="s" d="M368.9 210.6Q399.9 212.4 430.8 210.6M371.3 208.9Q400.0 210.3 428.7 210.8"/><path class="s b" d="M469.3 199.9Q471.5 205.8 471.8 208.9Q472.2 212.1 471.0 215.0Q469.9 217.9 468.3 220.5Q466.7 223.1 464.3 225.0Q461.8 226.9 459.0 228.3Q456.2 229.7 453.1 229.7Q450.0 229.6 447.0 228.8Q444.1 228.0 441.3 226.5Q438.5 225.1 436.3 222.7Q434.2 220.4 433.4 217.3Q432.7 214.2 432.3 211.1Q431.8 207.9 432.8 205.0Q433.8 202.0 435.3 199.2Q436.7 196.3 439.3 194.5Q441.9 192.6 444.9 191.7Q447.8 190.8 450.9 190.6Q454.0 190.5 456.9 191.4Q459.8 192.3 462.6 193.7Q465.3 195.1 467.2 197.6Q469.1 200.0 470.1 203.0"/><path class="s b" d="M439.4 225.2Q434.6 220.7 433.8 217.5Q433.0 214.3 432.2 211.1Q431.4 207.9 432.6 204.8Q433.8 201.7 435.6 198.9Q437.3 196.2 440.0 194.3Q442.6 192.4 445.7 191.1Q448.7 189.8 452.0 189.8Q455.4 189.8 458.4 191.1Q461.5 192.3 464.0 194.3Q466.6 196.4 468.5 199.0Q470.5 201.6 471.4 204.8Q472.4 208.0 471.9 211.2Q471.3 214.5 470.3 217.6Q469.3 220.7 467.2 223.3Q465.1 225.9 462.1 227.3Q459.1 228.7 455.9 229.1Q452.7 229.6 449.5 229.2Q446.4 228.8 443.3 227.7Q440.2 226.6 437.9 224.2Q435.6 221.9 433.9 219.0"/><path class="s b" d="M451.7 209.6Q457.4 204.3 462.2 198.4M451.8 209.9Q457.5 204.7 462.3 197.5"/><text x="485" y="208" text-anchor="start" class="code">pids.max</text><text x="485" y="230" text-anchor="start" class="m" style="font-size:18px">how many processes</text></svg><figcaption>A cgroup is a folder. Processes go in, and the files in it are dials the kernel obeys.</figcaption></figure>

**Try it yourself.** First, check which cgroup version the node uses:

```bash
docker exec under-the-hood-worker stat -fc %T /sys/fs/cgroup/
```

```output
cgroup2fs
```

`stat -fc %T` prints the *type* of filesystem at that path. `cgroup2fs` means cgroups **v2**, the modern layout where everything lives in one tree. (`tmpfs` would mean the older v1 layout, which current Kubernetes is moving away from.)

Next, see which dials this kernel offers:

```bash
docker exec under-the-hood-worker cat /sys/fs/cgroup/cgroup.controllers
```

You'll get a list like `cpuset cpu io memory hugetlb pids rdma misc`. Each word is a **controller**, the part of the kernel that measures and limits one kind of resource:

| Controller | Controls | Lessons |
|---|---|---|
| `cpu` | CPU time | 4, 5 |
| `memory` | RAM, and what happens when it runs out | 6 |
| `pids` | Number of processes | 12 |
| `io` | Disk reads and writes | 13 |

Finally, ask the kubelet how it uses cgroups:

```bash
kubectl get --raw /api/v1/nodes/under-the-hood-worker/proxy/configz | grep -o '"cgroup[A-Za-z]*":"[^"]*"'
```

```output
"cgroupDriver":"systemd"
"cgroupRoot":"/kubelet"
```

`cgroupDriver: systemd` means the kubelet doesn't create the folders itself. It asks **systemd**, the program that manages services on most Linux machines. That's why the folder names end in `.slice` (a group of groups) and `.scope` (a group of processes, such as a container). `cgroupRoot: /kubelet` is a kind detail: it puts the kubelet's tree under `/kubelet`, so every name gets a `kubelet-` prefix.

*Shortcut: `make 00-setup` runs these checks in one go.*

> [!KEY]
> A cgroup is a folder of processes, and the files in it are limits the kernel enforces.

## Lesson 2: Kubernetes nests cgroups in a tree

The kubelet doesn't make one box per container and stop there. It nests them: a box for all pods, inside it a box per QoS class (lesson 7), inside that a box per pod, and inside that a box per container.

<figure class="sketch "><svg viewBox="0 0 760 420" role="img" aria-label="The kubelet nests cgroups in a tree"><title>The kubelet nests cgroups in a tree</title><path class="s" d="M31.1 30.6Q195.2 30.8 361.0 28.9M31.0 29.1Q195.4 30.0 359.9 29.4"/><path class="s" d="M359.3 29.5Q359.9 57.0 361.0 85.6M360.3 29.1Q361.6 57.2 358.8 85.9"/><path class="s" d="M360.9 84.5Q194.7 86.6 31.1 85.1M360.5 86.1Q194.7 84.7 30.9 84.5"/><path class="s" d="M29.0 84.5Q29.1 57.2 30.2 28.8M30.8 85.0Q30.5 57.3 29.6 30.0"/><text x="42" y="54" text-anchor="start" style="font-size:20px">node</text><text x="42" y="75" text-anchor="start" class="code">/sys/fs/cgroup</text><path class="s b" d="M58.9 105.6Q224.6 106.2 390.8 103.8M58.8 103.9Q224.9 106.2 389.2 106.1"/><path class="s b" d="M391.1 104.6Q391.4 132.9 389.7 160.1M390.7 105.9Q388.6 132.7 388.9 161.1"/><path class="s b" d="M391.0 159.6Q224.8 161.7 61.0 160.1M389.0 159.2Q224.8 160.4 60.5 161.2"/><path class="s b" d="M60.1 159.8Q58.3 133.0 59.4 105.2M58.9 161.0Q61.2 132.4 58.9 105.0"/><text x="72" y="129" text-anchor="start" style="font-size:20px">all pods</text><text x="72" y="150" text-anchor="start" class="code">kubepods.slice</text><text x="408" y="139" text-anchor="start" class="m" style="font-size:17px">memory.max ≈ allocatable</text><path class="s m2" d="M44.5 85.2Q43.2 108.6 44.3 131.5M43.8 84.9Q44.0 108.7 44.6 132.4"/><path class="s m2" d="M44.7 131.9Q50.9 133.2 57.3 131.7M45.5 132.4Q50.8 131.7 58.0 131.5"/><path class="s m2" d="M58.6 131.8Q54.7 134.8 51.3 135.9M57.8 132.3Q54.3 133.5 50.4 135.5"/><path class="s m2" d="M58.7 132.2Q54.8 129.6 50.9 127.7M57.9 132.5Q54.3 130.3 51.0 129.0"/><path class="s a" d="M90.8 179.6Q255.1 179.6 420.8 180.9M90.0 180.1Q255.5 181.2 419.2 180.8"/><path class="s a" d="M420.5 180.6Q418.3 207.7 419.2 235.7M420.3 180.7Q419.8 207.4 420.3 235.5"/><path class="s a" d="M420.4 234.3Q254.7 236.8 90.4 235.3M418.9 234.1Q255.0 236.5 89.6 234.2"/><path class="s a" d="M89.7 235.3Q88.4 207.5 90.2 179.4M89.5 234.8Q91.1 207.4 89.1 180.8"/><text x="102" y="204" text-anchor="start" style="font-size:20px">QoS class</text><text x="102" y="225" text-anchor="start" class="code">kubepods-burstable.slice</text><path class="s m2" d="M73.5 160.1Q74.0 183.6 73.8 207.1M74.4 160.2Q73.3 183.5 73.8 206.6"/><path class="s m2" d="M75.5 207.3Q81.1 207.8 87.5 208.3M74.4 205.9Q80.5 205.8 88.4 208.3"/><path class="s m2" d="M87.7 207.8Q84.5 208.8 80.6 211.2M88.8 207.0Q84.0 207.7 80.7 210.2"/><path class="s m2" d="M88.0 206.4Q84.9 204.1 81.0 203.4M87.2 207.1Q84.4 205.9 80.4 204.2"/><path class="s y" d="M119.2 256.2Q284.8 255.9 449.5 255.3M120.6 254.1Q285.1 255.0 450.6 254.5"/><path class="s y" d="M450.1 254.9Q449.7 282.3 449.7 310.6M449.9 256.0Q449.2 282.3 450.9 310.1"/><path class="s y" d="M450.2 310.5Q285.3 311.8 120.3 310.0M450.8 309.3Q284.9 308.3 119.5 310.8"/><path class="s y" d="M119.8 309.5Q118.7 282.7 120.7 256.0M120.0 309.6Q118.6 282.5 119.2 255.2"/><text x="132" y="279" text-anchor="start" style="font-size:20px">one pod</text><text x="132" y="300" text-anchor="start" class="code">…-burstable-pod&lt;uid&gt;.slice</text><text x="468" y="289" text-anchor="start" class="m" style="font-size:17px">cpu.max, memory.max</text><path class="s m2" d="M104.4 235.4Q103.2 258.4 104.2 281.4M104.2 234.5Q103.8 258.7 104.4 281.7"/><path class="s m2" d="M102.8 281.3Q111.6 282.6 119.3 280.9M104.4 280.5Q110.9 281.8 116.7 281.6"/><path class="s m2" d="M118.4 282.6Q114.5 284.7 110.2 285.4M118.7 281.8Q114.6 284.1 110.1 285.8"/><path class="s m2" d="M118.7 282.1Q114.1 281.0 111.0 278.1M118.0 281.4Q114.3 280.3 110.4 278.3"/><path class="s r" d="M150.4 329.0Q314.7 331.1 480.4 329.0M150.9 330.0Q315.1 328.3 479.6 330.7"/><path class="s r" d="M479.2 331.1Q482.0 357.1 480.4 384.3M480.8 329.1Q481.9 357.7 480.3 384.7"/><path class="s r" d="M479.6 384.7Q314.8 386.1 149.1 385.8M480.8 385.0Q315.3 384.4 150.2 385.2"/><path class="s r" d="M148.9 384.3Q150.8 357.1 148.9 330.9M149.9 385.9Q150.2 357.0 150.3 329.8"/><text x="162" y="354" text-anchor="start" style="font-size:20px">one container</text><text x="162" y="375" text-anchor="start" class="code">cri-containerd-&lt;id&gt;.scope</text><text x="498" y="364" text-anchor="start" class="m" style="font-size:17px">cpu.max, memory.max, cpu.weight</text><path class="s m2" d="M133.6 309.8Q133.9 333.3 133.9 357.5M133.6 309.7Q134.5 333.4 133.7 357.0"/><path class="s m2" d="M135.4 357.6Q141.5 355.6 148.6 356.9M133.3 357.6Q140.5 358.4 148.7 355.9"/><path class="s m2" d="M147.3 356.8Q144.4 359.2 141.6 360.3M148.4 357.3Q144.6 359.0 140.3 360.1"/><path class="s m2" d="M147.9 357.8Q144.9 355.0 140.0 352.8M148.1 357.8Q144.6 354.4 140.8 353.3"/></svg><figcaption>A child is also subject to any limits set on its parents. In this example, the limits sit on the pod and the container.</figcaption></figure>

Nesting is the clever part. **Anything in a box is also subject to the limits set on the boxes around it.** So a container can't go past its pod's limit, and all pods together can't go past the ceiling the kubelet sets for them. (Not every box sets a limit; a QoS box, for example, usually doesn't.)

**Try it yourself.** List the box that holds every pod on the node:

```bash
docker exec under-the-hood-worker ls /sys/fs/cgroup/kubelet.slice/kubelet-kubepods.slice/
```

Among the files you'll see two folders, `kubelet-kubepods-burstable.slice` and `kubelet-kubepods-besteffort.slice`. Once pods are running, the full tree looks like this:

```text
/sys/fs/cgroup/kubelet.slice/kubelet-kubepods.slice/                  ← all pods
  ├── kubelet-kubepods-burstable.slice/                               ← one QoS class
  │     └── kubelet-kubepods-burstable-pod<uid>.slice/                ← one pod
  │           └── cri-containerd-<id>.scope/                          ← one container
  └── kubelet-kubepods-besteffort.slice/
```

On a normal GKE or EKS node it's the same tree, starting at `/sys/fs/cgroup/kubepods.slice` without the `kubelet-` prefix.

Now read the ceiling for the whole box:

```bash
docker exec under-the-hood-worker cat /sys/fs/cgroup/kubelet.slice/kubelet-kubepods.slice/memory.max
```

```output
8321515520
```

`memory.max` is the most memory, in bytes, that everything inside this box may use together: about 7.75 GiB here, roughly all the memory Docker gave the node. Lesson 8 explains how the kubelet picks this number.

> [!KEY]
> Cgroups nest, and a child is also subject to the limits set on its parents.

## Lesson 3: Requests and limits become numbers in files

Now the magic trick. Here's where each line of your YAML goes:

<figure class="sketch "><svg viewBox="0 0 760 340" role="img" aria-label="Requests and limits turn into cgroup files"><title>Requests and limits turn into cgroup files</title><path class="s" d="M18.6 30.1Q149.6 29.3 279.6 28.6M18.6 28.7Q149.4 30.0 279.8 31.0"/><path class="s" d="M281.4 30.2Q281.6 160.2 279.7 291.5M278.9 28.8Q282.8 159.7 279.4 291.0"/><path class="s" d="M279.6 290.2Q150.1 291.8 18.6 288.6M279.4 290.3Q150.2 291.4 19.9 289.4"/><path class="s" d="M20.2 290.1Q21.8 159.7 21.2 30.7M19.7 290.8Q19.5 159.5 18.9 30.0"/><text x="35" y="22" text-anchor="start" style="font-size:21px">pod.yaml</text><text x="40" y="70" text-anchor="start" class="code">resources:</text><text x="40" y="100" text-anchor="start" class="code">&#160;&#160;requests:</text><text x="40" y="130" text-anchor="start" class="code">&#160;&#160;&#160;&#160;cpu:&#160;250m</text><text x="40" y="160" text-anchor="start" class="code">&#160;&#160;&#160;&#160;memory:&#160;64Mi</text><text x="40" y="195" text-anchor="start" class="code">&#160;&#160;limits:</text><text x="40" y="225" text-anchor="start" class="code">&#160;&#160;&#160;&#160;cpu:&#160;500m</text><text x="40" y="255" text-anchor="start" class="code">&#160;&#160;&#160;&#160;memory:&#160;128Mi</text><path class="s a" d="M200.2 126.2Q302.1 93.1 404.4 65.6M201.1 126.4Q302.7 95.4 404.9 65.5"/><path class="s a" d="M405.8 65.5Q401.8 69.6 396.5 72.2M404.5 64.4Q400.3 68.4 396.1 72.8"/><path class="s a" d="M405.6 64.3Q399.3 64.9 394.1 63.3M404.6 64.9Q399.9 63.4 393.9 63.8"/><path class="s a" d="M414.4 37.4Q574.7 39.4 735.0 38.2M414.7 38.2Q574.5 37.0 736.1 38.5"/><path class="s a" d="M733.9 39.0Q735.1 69.2 735.7 100.9M734.0 38.3Q733.8 68.9 733.9 99.0"/><path class="s a" d="M733.9 98.8Q574.7 101.0 414.2 99.0M735.3 99.2Q574.5 100.9 414.4 99.6"/><path class="s a" d="M416.2 99.9Q414.1 69.3 415.0 37.0M415.8 99.2Q413.3 68.8 413.9 39.1"/><text x="430" y="64" text-anchor="start" class="code">cpu.weight = 35</text><text x="430" y="90" text-anchor="start" class="m" style="font-size:18px">a share of CPU when groups compete</text><path class="s r" d="M198.5 220.1Q302.1 187.7 406.5 156.2M198.9 220.9Q302.5 188.3 405.1 155.9"/><path class="s r" d="M405.8 155.6Q401.1 159.3 397.5 163.1M404.8 154.2Q400.4 158.4 396.2 162.2"/><path class="s r" d="M404.9 155.7Q399.6 155.1 394.9 154.2M404.5 154.5Q399.3 154.4 394.3 154.1"/><path class="s r" d="M415.7 127.0Q575.0 129.5 735.4 129.0M414.2 128.7Q575.2 129.1 734.6 128.7"/><path class="s r" d="M736.1 128.5Q733.1 158.9 734.2 189.1M734.2 128.8Q736.7 159.3 736.2 190.4"/><path class="s r" d="M733.8 191.1Q575.0 190.2 415.4 190.1M735.8 189.3Q574.9 188.7 414.4 189.5"/><path class="s r" d="M414.8 189.1Q414.1 158.8 416.0 127.6M414.8 191.0Q414.9 159.4 415.0 128.1"/><text x="430" y="154" text-anchor="start" class="code">cpu.max = 50000 100000</text><text x="430" y="180" text-anchor="start" class="m" style="font-size:18px">50 ms of CPU per 100 ms period</text><path class="s r" d="M199.0 248.4Q301.9 247.5 406.0 244.0M199.4 250.1Q302.8 247.4 405.2 245.9"/><path class="s r" d="M404.6 245.4Q400.6 248.2 395.2 250.1M405.2 245.0Q400.1 246.9 395.2 250.3"/><path class="s r" d="M405.7 245.3Q400.0 242.8 395.6 241.2M405.5 244.4Q399.8 243.5 394.4 240.4"/><path class="s r" d="M415.4 218.7Q574.8 215.9 736.0 217.2M415.9 219.1Q575.2 218.5 734.3 219.1"/><path class="s r" d="M735.8 217.2Q735.4 249.5 734.8 280.0M735.5 216.8Q735.3 248.8 735.1 279.9"/><path class="s r" d="M735.0 279.0Q574.8 282.0 416.2 280.7M733.9 280.7Q574.6 278.0 414.4 279.1"/><path class="s r" d="M414.4 279.2Q415.1 249.3 416.0 218.2M415.5 279.8Q415.4 248.6 414.0 219.1"/><text x="430" y="244" text-anchor="start" class="code">memory.max = 134217728</text><text x="430" y="270" text-anchor="start" class="m" style="font-size:18px">128 MiB hard limit</text><path class="s m2" d="M215.6 159.3Q218.8 163.2 223.3 166.3"/><path class="s m2" d="M227.7 170.3Q232.2 174.0 235.8 176.8"/><path class="s m2" d="M240.7 181.4Q245.4 183.9 248.5 188.5"/><path class="s m2" d="M254.0 191.8Q258.4 195.2 261.5 198.2"/><path class="s m2" d="M267.2 204.2Q270.8 206.9 274.3 210.4"/><path class="s m2" d="M280.2 214.4Q284.3 217.6 288.3 221.5"/><path class="s m2" d="M293.6 225.1Q297.7 228.3 300.9 230.9"/><path class="s m2" d="M306.1 235.5Q310.6 238.8 313.5 243.0"/><path class="s m2" d="M319.2 246.6Q323.0 250.7 327.2 252.8"/><path class="s m2" d="M333.4 257.9Q336.4 261.2 339.9 265.0"/><path class="s m2" d="M345.5 268.7Q349.8 271.2 353.4 274.6"/><path class="s m2" d="M358.1 279.4Q362.3 282.6 365.7 285.2"/><path class="s m2" d="M371.9 290.8Q375.8 293.3 379.8 297.2"/><path class="s m2" d="M385.7 300.7Q388.1 305.1 393.0 307.9"/><path class="s m2" d="M398.2 312.5Q402.4 314.5 405.5 317.4"/><text x="415" y="312" text-anchor="start" style="font-size:18px">memory request → scheduler input</text><text x="415" y="334" text-anchor="start" class="m" style="font-size:16px">no memory protection in this lab's default setup</text></svg><figcaption>The kubelet turns three of the four numbers into cgroup files. The memory request is used by the scheduler and the kubelet instead.</figcaption></figure>

**Try it yourself.** Create a pod with exactly the YAML from the top of this post:

```bash
kubectl create namespace lab            # skip if it already exists
kubectl -n lab apply -f modules/01-requests-and-limits/pod.yaml
kubectl -n lab wait --for=condition=Ready pod/requests-limits
```

**1. The CPU limit.**

```bash
kubectl -n lab exec requests-limits -- cat /sys/fs/cgroup/cpu.max
```

```output
50000 100000
```

`cpu.max` holds two numbers, both in microseconds. The second is the **period**: the kernel hands out CPU time in windows of 100 ms (the default). The first is the **quota**: how much CPU time the container may use in each window. So this reads "50 ms in every 100 ms", which is half a CPU: your `limits.cpu: 500m`.

**2. The memory limit.**

```bash
kubectl -n lab exec requests-limits -- cat /sys/fs/cgroup/memory.max
```

```output
134217728
```

`memory.max` is the hard memory ceiling, in bytes. 134,217,728 is exactly 128 × 1024 × 1024: your `limits.memory: 128Mi`.

**3. The CPU request.**

```bash
kubectl -n lab exec requests-limits -- cat /sys/fs/cgroup/cpu.weight
```

```output
35
```

`cpu.weight` is a number from 1 to 10,000 that says how big a *share* of CPU this group gets when CPUs are busy. It's how your `requests.cpu: 250m` shows up at runtime. Lesson 5 shows it in action.

**4. The memory request.**

```bash
kubectl -n lab exec requests-limits -- cat /sys/fs/cgroup/memory.min
```

```output
0
```

`memory.min` is memory the kernel would protect for this group even when the machine is short. In this lab's configuration it's `0`: the `64Mi` request isn't turned into memory protection.

| You wrote | File | Value | In plain words |
|---|---|---|---|
| `limits.cpu: 500m` | `cpu.max` | `50000 100000` | At most 50 ms of CPU every 100 ms |
| `limits.memory: 128Mi` | `memory.max` | `134217728` | 128 MiB, then the process is killed |
| `requests.cpu: 250m` | `cpu.weight` | `35` | A share of CPU, only used when CPUs are busy |
| `requests.memory: 64Mi` | `memory.min` | `0` | No protection here. The scheduler and the kubelet use it instead |

That last row surprises almost everyone I show this to. By default, Kubernetes uses the memory request to pick a node and, later, to decide who to evict first when the node runs short (lesson 9), but it doesn't ask the kernel to protect that memory. Clusters that turn on the `MemoryQoS` feature (still alpha) map requests to `memory.min` and add a soft limit in `memory.high`, so check your own nodes rather than assuming.

The pod has its own folder on the node too, holding the same limits (a pod's limit is the sum of its containers'). The lab includes a small helper that finds it, so you don't have to dig through the tree:

```bash
POD_DIR=$(./scripts/pod-cgroup.sh requests-limits)
docker exec under-the-hood-worker cat "$POD_DIR/cpu.max" "$POD_DIR/memory.max"
```

*Shortcut: `make 01-requests-and-limits` runs all of this and checks every value.*

> [!KEY]
> `requests.cpu` → `cpu.weight`, `limits.cpu` → `cpu.max`, `limits.memory` → `memory.max`. By default, the memory request is used for scheduling and eviction, not kernel protection.

## Lesson 4: A CPU limit is a budget, and you can run out

Think of `cpu.max` like a mobile data plan that renews every 100 milliseconds. With `limits.cpu: 200m`, you get 20 ms of CPU time per 100 ms window. Use it up early, and you wait until the next window, even if the machine has nine idle CPUs.

<figure class="sketch anim"><svg viewBox="0 0 760 330" role="img" aria-label="Four threads share one CPU quota per period"><title>Four threads share one CPU quota per period</title><defs><clipPath id="cth1"><rect x="120" y="75" width="14.5" height="30"/></clipPath><clipPath id="cth2"><rect x="134.5" y="75" width="275.5" height="30"/></clipPath><clipPath id="cth3"><rect x="120" y="117" width="14.5" height="30"/></clipPath><clipPath id="cth4"><rect x="134.5" y="117" width="275.5" height="30"/></clipPath><clipPath id="cth5"><rect x="120" y="159" width="14.5" height="30"/></clipPath><clipPath id="cth6"><rect x="134.5" y="159" width="275.5" height="30"/></clipPath><clipPath id="cth7"><rect x="120" y="201" width="14.5" height="30"/></clipPath><clipPath id="cth8"><rect x="134.5" y="201" width="275.5" height="30"/></clipPath><clipPath id="cth9"><rect x="430" y="75" width="14.5" height="30"/></clipPath><clipPath id="cth10"><rect x="444.5" y="75" width="275.5" height="30"/></clipPath><clipPath id="cth11"><rect x="430" y="117" width="14.5" height="30"/></clipPath><clipPath id="cth12"><rect x="444.5" y="117" width="275.5" height="30"/></clipPath><clipPath id="cth13"><rect x="430" y="159" width="14.5" height="30"/></clipPath><clipPath id="cth14"><rect x="444.5" y="159" width="275.5" height="30"/></clipPath><clipPath id="cth15"><rect x="430" y="201" width="14.5" height="30"/></clipPath><clipPath id="cth16"><rect x="444.5" y="201" width="275.5" height="30"/></clipPath></defs><text x="20" y="30" text-anchor="start" style="font-size:21px">limits.cpu: 200m → cpu.max = 20000 100000: 20 ms of CPU time per period</text><text x="265.0" y="62" text-anchor="middle" class="m" style="font-size:17px">period 1: 100 ms (the default)</text><path class="h g" clip-path="url(#cth1)" d="M94.8 105.8Q106.7 89.6 120.0 74.0M97.8 107.5Q111.4 89.7 124.0 73.5M103.4 107.2Q114.3 89.4 129.1 72.7M108.4 106.8Q119.6 89.3 133.0 72.4M113.2 107.9Q125.0 89.2 137.3 72.7M116.4 107.2Q128.9 89.3 142.5 73.2M123.2 105.8Q134.8 88.9 148.2 73.0M127.9 107.2Q141.6 90.0 154.2 73.3"/><path class="s g" d="M118.9 74.3Q127.3 74.0 136.1 76.6M119.2 75.4Q127.5 74.6 133.0 74.6"/><path class="s g" d="M133.2 74.5Q134.1 90.4 135.7 105.3M134.7 73.5Q134.5 90.6 135.5 104.5"/><path class="s g" d="M133.9 103.7Q126.9 105.1 120.4 103.7M135.5 105.0Q126.6 104.6 120.7 104.2"/><path class="s g" d="M121.5 104.7Q120.7 89.7 119.6 76.2M121.1 104.2Q119.8 89.6 118.6 76.5"/><path class="h r" clip-path="url(#cth2)" d="M108.7 105.8Q120.9 89.7 133.4 72.3M118.3 107.1Q133.0 90.1 144.4 72.0M130.8 107.6Q143.5 90.4 156.1 73.9M140.6 106.0Q154.6 90.9 165.6 73.1M150.3 105.8Q164.0 90.6 176.3 72.9M163.2 107.1Q174.5 89.7 189.3 71.9M174.2 108.0Q188.3 90.9 199.1 73.3M184.2 107.5Q197.9 89.8 211.2 73.0M197.4 106.4Q208.3 88.9 223.3 73.6M208.0 107.4Q221.4 90.9 233.6 72.0M217.7 106.9Q231.1 89.8 244.3 71.9M230.7 107.2Q242.5 89.2 256.9 74.2M242.0 106.3Q253.0 88.9 266.7 72.1M252.1 106.9Q266.3 90.9 277.7 72.7M262.1 106.9Q274.8 89.4 290.0 71.9M273.9 107.3Q286.5 90.4 298.4 71.9M284.3 108.0Q296.3 90.0 310.7 73.9M294.8 107.3Q309.4 90.9 321.5 72.6M307.0 107.3Q319.5 89.6 333.3 72.9M317.6 106.3Q330.0 89.5 344.0 73.4M328.0 107.6Q341.0 90.2 354.7 73.6M338.3 106.9Q351.2 89.6 365.1 72.6M349.3 107.1Q362.5 90.2 374.9 71.8M360.7 107.8Q373.0 88.6 388.9 73.4M372.9 106.7Q386.6 90.5 398.0 72.6M383.4 105.8Q395.4 89.6 409.7 71.8M394.8 106.5Q408.5 91.2 419.4 72.9M405.2 107.2Q417.6 89.6 431.7 74.0"/><path class="s r" d="M133.2 73.8Q272.6 73.6 409.1 75.1M135.1 74.8Q271.9 76.7 411.1 76.6"/><path class="s r" d="M408.6 76.0Q408.9 90.0 409.7 104.9M411.3 76.5Q410.2 90.1 408.7 104.5"/><path class="s r" d="M409.0 105.1Q272.6 103.6 135.9 105.1M408.6 106.1Q272.9 103.7 134.8 104.0"/><path class="s r" d="M133.9 103.5Q135.3 89.5 134.2 75.9M133.5 103.9Q134.9 89.4 134.7 74.0"/><text x="110" y="96" text-anchor="end" style="font-size:18px">thread 1</text><path class="h g" clip-path="url(#cth3)" d="M94.7 149.7Q107.5 132.5 121.0 114.2M98.6 148.2Q113.0 132.8 125.6 115.3M103.1 150.1Q117.3 132.8 128.6 113.8M108.1 148.3Q119.0 130.8 132.2 114.9M111.8 150.0Q123.7 131.3 137.3 115.3M116.7 148.3Q130.5 132.5 141.1 113.8M122.3 148.0Q135.4 132.5 148.4 115.5M128.6 148.7Q139.5 131.0 154.2 116.0M133.6 148.6Q145.9 131.6 158.4 114.5"/><path class="s g" d="M121.2 118.0Q127.6 116.6 135.1 116.1M121.5 116.7Q127.2 115.8 136.0 116.0"/><path class="s g" d="M134.3 115.5Q134.4 132.2 134.3 146.6M136.0 115.9Q133.7 132.6 133.0 146.3"/><path class="s g" d="M133.5 147.4Q126.8 148.4 119.6 146.3M134.6 147.5Q126.8 146.3 118.9 147.8"/><path class="s g" d="M120.5 146.9Q120.9 132.0 120.8 117.5M119.9 147.3Q119.6 132.3 120.4 116.9"/><path class="h r" clip-path="url(#cth4)" d="M109.0 148.0Q120.2 131.3 134.4 115.2M119.6 150.1Q131.6 131.4 145.8 113.8M130.5 149.6Q143.3 132.9 155.3 113.8M142.4 148.7Q154.8 132.0 168.5 114.2M154.7 148.6Q167.2 132.4 180.3 116.0M166.4 148.0Q178.3 131.6 191.6 114.9M178.1 149.9Q189.8 131.6 203.6 114.0M188.4 147.9Q202.8 132.8 215.5 114.2M199.8 148.4Q212.9 133.2 224.8 114.3M210.5 148.8Q225.1 133.1 237.0 114.4M221.5 148.2Q234.3 132.9 245.9 115.2M230.9 149.1Q244.3 132.3 258.0 114.1M240.9 148.0Q255.7 133.1 267.6 114.9M253.7 149.3Q264.8 131.7 278.1 115.2M262.1 149.8Q275.0 130.8 288.1 114.4M272.2 150.0Q287.6 132.6 298.4 115.5M284.1 149.4Q297.9 132.1 309.9 114.9M295.5 149.4Q308.2 131.8 320.0 115.7M308.0 148.5Q320.7 132.9 332.2 114.6M316.7 147.8Q328.8 130.9 343.0 115.8M329.1 149.3Q340.3 130.7 354.5 114.8M339.3 148.3Q352.9 131.1 365.3 115.8M351.4 149.1Q363.7 132.0 376.2 115.6M361.6 149.5Q372.8 131.3 388.1 116.0M372.6 148.6Q384.3 131.2 397.2 114.3M381.9 149.5Q396.3 132.6 408.3 115.0M392.1 148.9Q407.2 133.1 418.8 114.8M403.4 149.8Q416.9 131.8 429.3 114.4"/><path class="s r" d="M135.9 118.5Q272.0 114.9 409.1 117.5M133.4 115.6Q272.3 118.5 408.5 115.6"/><path class="s r" d="M411.4 118.6Q409.4 131.4 409.7 146.6M409.0 117.7Q409.0 132.3 409.8 145.6"/><path class="s r" d="M409.3 148.3Q271.9 149.0 134.2 146.1M409.7 145.7Q271.7 148.9 134.6 146.5"/><path class="s r" d="M133.5 147.8Q132.9 131.6 134.3 116.5M135.9 147.7Q135.0 132.2 134.0 118.5"/><text x="110" y="138" text-anchor="end" style="font-size:18px">thread 2</text><path class="h g" clip-path="url(#cth5)" d="M93.6 190.6Q105.2 172.5 119.7 157.3M99.7 190.7Q111.8 174.4 124.4 158.2M104.1 190.5Q118.1 174.7 130.3 158.1M109.2 190.2Q122.0 174.1 134.1 157.6M115.0 191.2Q127.0 173.3 141.9 157.4M119.1 190.1Q133.6 174.6 145.1 155.8M126.0 191.4Q140.0 175.3 151.4 158.1M130.9 191.8Q141.6 173.4 157.0 156.3"/><path class="s g" d="M119.4 159.5Q127.7 157.8 134.9 157.4M120.0 157.5Q126.8 157.6 135.5 158.9"/><path class="s g" d="M133.2 160.2Q133.8 174.4 133.7 189.0M135.2 157.6Q134.5 174.1 134.6 189.0"/><path class="s g" d="M133.2 187.5Q126.7 189.0 118.6 190.5M134.8 188.1Q127.5 189.3 120.3 189.8"/><path class="s g" d="M118.4 187.6Q120.6 174.3 119.2 158.8M120.1 188.4Q120.2 173.6 118.7 158.3"/><path class="h r" clip-path="url(#cth6)" d="M108.0 191.5Q119.6 173.3 133.9 157.6M120.8 190.1Q131.9 173.3 146.8 157.6M131.3 191.9Q144.1 174.1 155.6 156.9M141.3 191.0Q153.3 173.3 168.8 157.9M153.3 190.2Q165.9 172.9 180.4 157.2M163.7 191.5Q177.5 174.1 190.0 155.8M176.2 191.3Q188.6 173.3 201.9 156.3M187.1 191.7Q202.2 174.5 215.4 156.6M198.4 191.5Q211.9 173.4 225.9 156.8M211.7 191.3Q225.1 175.0 237.4 157.1M221.4 191.4Q236.0 174.6 248.7 156.8M231.4 191.9Q246.0 174.6 258.9 157.7M243.7 190.2Q254.9 173.0 267.8 157.7M251.9 191.5Q266.4 173.9 280.0 157.7M264.2 191.8Q275.7 173.2 290.4 158.0M273.7 190.0Q287.5 173.9 302.2 156.0M287.6 191.4Q299.2 173.6 311.9 157.8M297.5 190.6Q311.4 175.1 324.7 158.2M308.0 192.0Q321.7 174.2 334.4 158.2M318.5 191.2Q334.3 174.7 345.9 156.6M330.4 190.8Q342.3 173.4 357.3 156.8M341.2 191.4Q355.7 174.5 368.8 158.1M354.6 191.4Q368.0 175.0 378.5 157.8M364.9 191.3Q378.7 174.9 391.7 156.7M376.5 190.9Q390.0 175.3 401.0 157.0M387.4 191.3Q398.5 173.4 413.1 157.1M395.9 191.3Q408.6 173.7 422.1 155.9M406.9 190.9Q421.1 175.1 433.4 158.0"/><path class="s r" d="M132.9 159.1Q272.1 160.2 408.6 158.3M134.2 160.3Q272.1 158.4 410.2 159.5"/><path class="s r" d="M410.6 160.0Q408.6 174.6 410.3 190.6M408.7 158.8Q409.6 174.2 411.4 187.9"/><path class="s r" d="M411.1 188.4Q272.0 189.6 134.7 187.5M411.2 190.2Q272.1 190.5 134.5 188.2"/><path class="s r" d="M135.0 189.4Q136.0 174.4 134.2 159.2M133.9 189.8Q134.3 174.5 133.2 157.7"/><text x="110" y="180" text-anchor="end" style="font-size:18px">thread 3</text><path class="h g" clip-path="url(#cth7)" d="M93.7 234.0Q105.8 215.2 118.9 199.9M98.6 231.9Q110.8 215.5 124.7 197.9M101.6 231.9Q115.1 215.7 128.6 198.4M109.3 232.4Q122.5 217.2 134.4 198.1M112.9 232.8Q127.0 216.9 140.3 199.7M118.4 233.9Q130.6 215.3 144.1 198.1M121.6 232.9Q135.1 215.0 148.2 199.9M127.2 234.1Q138.9 215.1 152.9 199.9M131.7 232.0Q144.7 216.3 158.6 198.7"/><path class="s g" d="M120.9 201.8Q126.7 199.9 134.1 200.2M118.8 199.6Q127.2 200.9 133.2 201.9"/><path class="s g" d="M134.3 200.3Q133.4 216.2 134.4 230.7M133.8 201.7Q134.0 215.9 135.9 232.5"/><path class="s g" d="M134.4 231.6Q127.6 230.2 119.1 232.6M135.7 230.6Q127.6 232.1 120.0 229.5"/><path class="s g" d="M119.5 230.6Q121.3 215.5 119.9 200.4M119.9 230.8Q119.3 216.3 119.6 202.4"/><path class="h r" clip-path="url(#cth8)" d="M109.1 232.8Q122.4 216.2 135.0 198.9M118.9 232.4Q132.0 215.8 143.5 197.9M130.0 233.0Q141.4 215.3 155.6 200.0M140.8 232.2Q154.2 217.1 165.7 199.1M151.6 233.7Q165.1 216.9 176.6 197.9M162.0 233.7Q175.5 216.2 188.4 199.3M172.0 233.7Q185.5 216.5 197.2 199.9M182.3 233.8Q196.5 216.3 207.9 198.2M195.2 233.1Q206.8 215.2 219.2 198.4M204.4 234.1Q216.7 214.8 231.4 198.7M216.6 233.9Q228.0 215.3 243.0 198.7M225.6 233.5Q238.5 215.2 253.5 197.9M237.5 232.0Q251.9 216.4 263.2 199.2M250.1 232.3Q262.3 216.1 275.2 200.0M259.7 232.6Q272.5 215.7 285.1 199.8M270.9 233.0Q284.7 217.2 298.1 199.1M282.3 233.1Q296.3 217.0 308.9 199.3M293.6 233.0Q306.2 215.8 318.9 198.3M303.7 232.2Q315.8 216.1 328.7 200.0M312.6 233.8Q327.9 217.3 339.4 198.9M325.0 233.7Q336.6 215.4 350.8 199.4M335.6 234.0Q347.3 215.1 361.1 199.1M345.8 234.0Q359.7 216.6 371.8 200.1M357.2 232.6Q371.3 216.4 384.0 199.9M367.2 233.9Q380.7 215.8 393.9 199.7M378.0 232.5Q392.1 217.0 403.3 199.7M389.4 232.1Q401.4 215.1 415.6 199.2M400.5 234.0Q413.7 216.3 427.6 199.9"/><path class="s r" d="M134.1 201.6Q272.5 202.7 410.0 200.7M134.7 202.4Q271.7 199.6 409.0 202.2"/><path class="s r" d="M409.9 201.3Q409.4 216.0 410.9 232.2M411.2 200.4Q412.1 216.4 409.4 232.1"/><path class="s r" d="M409.3 229.9Q272.1 229.1 133.4 230.4M410.1 230.3Q272.4 232.9 133.6 230.9"/><path class="s r" d="M135.2 231.8Q133.3 215.6 133.2 199.9M134.4 229.5Q133.6 216.5 134.0 201.5"/><text x="110" y="222" text-anchor="end" style="font-size:18px">thread 4</text><text x="575.0" y="62" text-anchor="middle" class="m" style="font-size:17px">period 2: 100 ms (the default)</text><path class="h g" clip-path="url(#cth9)" d="M403.1 106.4Q418.0 91.3 430.5 73.2M409.6 108.1Q420.7 88.9 435.2 73.3M413.4 108.0Q424.7 89.0 438.9 73.5M419.5 107.1Q430.6 89.0 445.4 74.1M423.1 107.1Q436.4 90.2 449.9 73.0M429.2 107.0Q441.8 89.7 455.3 72.9M433.7 106.0Q447.7 90.7 459.2 73.6M438.1 107.5Q451.3 90.0 464.8 72.8M443.2 105.8Q456.2 90.2 469.4 73.0"/><path class="s g" d="M429.5 73.5Q437.7 74.2 445.6 75.5M430.4 75.0Q437.9 76.0 445.4 74.7"/><path class="s g" d="M443.1 74.9Q443.7 90.5 445.5 104.1M444.5 76.6Q445.4 89.5 443.8 105.7"/><path class="s g" d="M446.0 103.8Q437.1 105.0 430.2 104.5M444.4 104.8Q437.0 106.4 431.5 103.5"/><path class="s g" d="M429.4 104.4Q430.8 90.6 430.7 74.9M430.2 106.2Q428.1 90.5 431.0 74.4"/><path class="h r" clip-path="url(#cth10)" d="M417.8 106.7Q431.1 89.8 443.9 72.6M430.8 108.1Q442.2 90.0 456.5 73.9M439.9 108.0Q453.9 90.5 466.7 73.5M451.5 108.2Q464.1 90.4 477.0 73.1M460.5 106.6Q473.6 89.3 487.2 74.0M472.3 106.4Q485.4 89.4 498.7 72.2M483.9 106.7Q496.5 89.2 510.9 74.1M495.3 106.7Q508.4 90.9 520.1 72.6M505.8 105.8Q519.3 90.1 532.4 73.9M517.2 107.0Q528.3 89.2 543.5 73.8M527.2 107.1Q539.1 89.7 553.1 74.0M539.8 106.4Q550.7 89.2 565.9 73.3M548.3 106.3Q561.4 89.8 573.6 71.9M560.6 107.7Q573.4 89.4 587.6 72.4M571.9 106.3Q586.1 90.2 597.7 73.3M585.5 107.1Q597.6 90.3 610.7 73.4M596.9 107.8Q609.8 90.4 621.3 74.0M607.2 107.4Q620.7 89.9 633.2 73.1M618.9 107.3Q631.2 90.2 645.5 73.4M630.6 107.0Q643.2 90.5 654.8 72.7M641.2 107.1Q654.7 90.9 666.4 71.9M650.7 106.4Q664.8 90.6 676.7 72.4M663.8 107.8Q675.4 89.0 689.7 72.4M673.6 106.5Q686.6 90.3 698.0 73.7M684.5 107.8Q696.0 89.3 709.4 74.1M694.8 107.1Q707.0 89.3 721.3 73.2M705.1 106.0Q717.8 89.3 732.4 71.9M716.6 106.3Q730.2 90.2 743.1 72.1"/><path class="s r" d="M445.9 75.2Q582.7 77.5 718.7 75.7M445.6 74.1Q581.7 76.8 719.3 74.3"/><path class="s r" d="M719.4 74.9Q718.2 89.6 720.0 106.4M718.6 74.3Q721.2 90.0 721.5 106.5"/><path class="s r" d="M721.0 105.8Q582.8 104.3 445.9 104.1M720.3 104.8Q582.8 105.0 445.7 106.2"/><path class="s r" d="M445.5 104.2Q443.9 89.8 444.8 76.5M443.2 103.4Q443.5 89.6 443.8 74.0"/><path class="h g" clip-path="url(#cth11)" d="M402.8 147.9Q417.4 132.5 430.4 115.6M408.5 149.6Q422.0 132.1 435.7 114.8M414.9 148.0Q425.5 130.5 440.7 115.2M418.7 149.5Q431.3 131.3 444.5 114.2M423.4 150.0Q436.7 131.2 450.6 114.1M428.9 148.0Q443.2 132.9 455.4 114.7M434.7 149.8Q448.7 132.9 459.9 115.6M437.3 150.1Q450.4 131.5 464.6 115.8M442.9 148.7Q457.4 133.1 469.8 114.1"/><path class="s g" d="M429.3 116.2Q437.2 116.2 445.5 118.0M431.3 116.9Q437.7 118.5 443.4 116.4"/><path class="s g" d="M444.3 118.6Q444.5 131.4 443.1 146.6M444.7 117.7Q445.3 132.4 443.3 146.9"/><path class="s g" d="M444.3 147.9Q436.8 146.8 431.5 147.7M443.0 146.0Q437.3 145.6 431.1 148.0"/><path class="s g" d="M428.7 146.0Q430.2 132.1 430.3 117.2M431.2 147.8Q431.1 132.5 428.8 117.0"/><path class="h r" clip-path="url(#cth12)" d="M418.1 150.0Q429.9 131.2 445.1 115.2M429.0 148.6Q441.9 131.9 455.0 114.7M438.9 149.5Q452.2 132.1 465.6 114.2M450.2 149.4Q463.7 132.3 478.1 114.4M463.0 149.1Q476.3 132.7 488.3 115.3M472.5 148.2Q487.0 132.7 498.6 114.2M482.1 149.1Q495.9 131.9 509.3 114.7M495.9 150.0Q509.1 133.2 521.8 114.6M506.7 149.3Q520.2 132.5 533.7 114.0M518.4 149.3Q532.3 133.3 544.2 115.4M527.8 148.1Q540.2 130.5 553.8 115.2M539.3 148.3Q552.7 131.4 566.6 115.6M552.1 148.6Q563.9 131.2 577.5 114.4M564.2 148.0Q575.2 130.8 590.6 115.2M576.3 148.2Q588.7 132.2 600.6 114.7M586.2 148.1Q600.9 133.1 611.3 114.5M595.8 149.7Q610.5 132.5 623.1 115.5M606.2 149.4Q619.9 131.9 633.4 114.5M618.4 148.9Q631.9 133.3 642.9 114.5M631.0 148.1Q643.8 133.2 657.0 115.3M639.5 149.8Q652.6 131.2 665.5 115.7M651.6 148.9Q665.8 132.8 676.9 115.1M662.5 148.2Q676.5 132.7 689.3 115.0M674.1 149.8Q685.9 131.8 699.3 113.9M685.4 150.0Q698.0 132.7 709.9 113.8M695.2 149.7Q707.1 131.6 721.6 115.4M703.9 149.2Q717.7 131.8 731.5 115.2M716.3 148.5Q730.3 133.0 742.8 116.0"/><path class="s r" d="M443.9 116.5Q582.0 114.9 721.2 118.0M443.1 115.9Q582.3 115.3 720.3 116.5"/><path class="s r" d="M720.1 117.5Q718.8 132.5 718.5 147.2M720.9 116.4Q720.3 131.8 719.7 147.8"/><path class="s r" d="M718.5 147.2Q582.1 147.0 442.9 147.6M720.4 148.2Q581.8 148.5 445.5 145.8"/><path class="s r" d="M444.3 147.5Q443.7 132.5 444.0 117.7M445.3 146.8Q442.7 132.1 443.5 117.2"/><path class="h g" clip-path="url(#cth13)" d="M404.7 191.6Q418.4 175.2 430.8 157.4M408.2 190.2Q423.4 174.9 434.8 158.2M413.8 190.0Q428.3 174.2 441.2 156.8M419.6 189.8Q432.1 174.6 443.7 157.0M422.3 191.5Q436.4 173.7 448.3 158.1M429.5 190.1Q442.8 174.5 455.2 156.1M432.5 190.6Q447.6 175.5 459.4 156.5M438.0 190.7Q452.4 174.5 465.2 157.0M442.1 189.8Q457.2 174.6 470.3 157.5"/><path class="s g" d="M430.0 160.4Q437.7 157.8 444.5 157.5M429.0 158.3Q437.1 159.1 445.2 157.7"/><path class="s g" d="M443.9 158.6Q446.5 173.9 444.8 187.5M445.9 160.4Q444.9 174.0 444.2 188.5"/><path class="s g" d="M446.0 189.4Q437.3 190.7 428.6 189.6M444.9 189.5Q437.1 190.3 429.8 189.2"/><path class="s g" d="M429.5 189.6Q431.3 173.6 428.5 158.6M429.9 190.1Q430.0 173.8 428.8 159.3"/><path class="h r" clip-path="url(#cth14)" d="M417.5 189.9Q429.7 173.3 443.9 158.0M428.0 191.6Q442.5 174.5 455.0 156.8M438.0 190.4Q450.6 173.2 464.9 157.4M450.3 190.3Q461.2 173.2 474.8 156.7M460.1 190.7Q472.7 173.0 487.1 157.6M472.5 192.1Q483.7 173.4 498.7 157.7M481.4 191.7Q493.9 172.9 508.5 156.2M494.6 191.6Q507.3 174.0 519.2 157.2M504.5 190.6Q517.1 174.2 529.4 157.3M516.4 191.2Q529.4 174.7 540.7 156.6M526.1 191.2Q539.7 174.1 551.3 157.7M535.9 190.5Q549.8 174.7 562.9 156.9M549.0 191.6Q560.1 172.9 574.0 156.4M557.9 191.1Q570.5 173.5 584.1 157.4M568.8 191.7Q584.2 175.3 595.0 156.9M581.2 190.8Q593.5 174.3 606.0 156.5M589.1 191.9Q602.4 173.1 615.5 156.3M600.6 190.7Q615.4 174.5 626.5 157.7M611.1 191.5Q624.2 173.8 638.6 157.5M622.9 190.0Q636.7 174.1 648.0 157.5M634.5 192.2Q645.2 172.4 659.2 157.3M644.7 192.0Q659.5 174.7 672.0 157.7M658.2 189.9Q670.3 173.4 683.4 155.9M668.9 191.2Q682.6 174.7 693.7 156.1M677.7 190.4Q691.1 173.7 705.0 156.5M691.2 190.2Q703.1 173.7 715.8 157.0M701.8 190.2Q713.9 173.3 727.4 157.8M712.8 191.7Q726.0 174.5 739.1 156.0"/><path class="s r" d="M445.8 157.9Q582.6 160.6 720.0 158.5M445.1 157.6Q582.4 161.2 719.0 158.6"/><path class="s r" d="M719.3 159.0Q719.6 173.9 720.8 188.0M718.5 157.9Q719.5 173.9 721.1 190.4"/><path class="s r" d="M719.0 188.5Q582.5 190.5 445.5 188.4M721.4 189.5Q582.4 191.0 444.7 190.1"/><path class="s r" d="M443.1 189.9Q445.8 174.2 446.1 160.0M445.6 190.0Q442.6 174.2 443.3 158.8"/><path class="h g" clip-path="url(#cth15)" d="M403.8 233.1Q415.8 215.1 429.9 197.9M409.1 232.5Q422.0 216.9 433.8 199.7M413.2 232.9Q425.5 215.3 440.3 198.5M419.8 233.3Q433.3 216.2 446.3 198.8M424.2 233.2Q438.0 215.6 451.6 198.9M431.0 233.7Q444.6 216.6 455.3 199.8M434.4 234.1Q449.4 217.1 461.9 197.9M440.4 232.4Q455.6 216.9 467.9 198.1"/><path class="s g" d="M430.6 201.2Q437.4 201.7 445.6 200.1M431.4 202.1Q437.5 201.5 443.3 199.5"/><path class="s g" d="M444.0 201.6Q446.2 215.7 443.6 230.9M443.9 202.4Q445.5 216.5 443.9 230.6"/><path class="s g" d="M443.6 232.1Q437.4 232.0 428.9 230.5M443.1 230.6Q437.7 231.7 429.9 229.4"/><path class="s g" d="M429.3 231.8Q431.9 215.5 428.8 202.0M428.5 229.9Q430.3 216.6 428.6 200.6"/><path class="h r" clip-path="url(#cth16)" d="M417.7 233.9Q430.2 214.9 443.5 198.2M427.7 232.3Q443.0 216.7 453.8 198.8M438.9 232.2Q450.8 215.5 464.5 198.1M449.1 233.9Q463.4 216.4 476.3 200.0M462.5 232.4Q475.3 216.6 488.5 200.1M472.8 233.2Q485.8 215.6 498.4 199.6M484.3 234.0Q497.1 216.1 509.1 199.3M494.9 233.5Q508.8 216.8 519.9 198.3M504.9 232.2Q517.8 215.1 531.2 199.5M518.0 233.7Q530.3 216.5 543.0 198.5M527.2 233.0Q540.1 215.5 554.8 199.4M538.9 232.9Q552.6 215.8 567.0 198.9M550.7 232.5Q563.4 215.7 576.6 200.1M560.0 233.1Q574.6 217.5 587.6 199.5M571.4 233.3Q582.8 214.6 596.7 198.8M582.5 231.9Q595.9 216.3 609.0 199.5M595.0 234.0Q606.5 215.6 619.2 199.7M606.6 233.1Q619.1 216.0 632.8 198.1M617.7 233.7Q629.9 215.4 644.5 198.1M629.3 232.1Q642.6 216.1 654.8 200.0M640.2 233.2Q653.0 215.2 666.8 198.6M650.4 232.4Q664.1 215.9 675.9 198.4M663.2 232.3Q675.1 215.5 689.4 198.3M672.6 232.9Q684.5 215.7 697.8 198.0M684.6 232.4Q696.0 215.5 710.1 199.6M694.2 232.9Q707.5 216.3 721.3 198.0M704.0 233.1Q716.2 214.9 730.6 198.5M714.0 233.3Q728.0 216.2 739.7 199.2"/><path class="s r" d="M445.8 200.2Q582.6 202.2 718.6 200.5M444.2 201.2Q581.8 202.7 719.8 200.9"/><path class="s r" d="M719.3 200.1Q719.6 215.7 719.2 231.9M719.7 202.5Q720.8 216.4 718.9 230.8"/><path class="s r" d="M721.6 230.4Q581.7 230.9 446.1 231.7M718.4 230.2Q582.1 228.6 443.3 230.9"/><path class="s r" d="M445.3 231.2Q445.5 215.9 444.4 200.6M445.1 230.0Q444.0 215.6 443.1 202.5"/><g class="anim-playhead"><path class="s b" d="M119.6 70.4Q120.7 160.1 120.3 250.2M120.1 70.3Q119.9 159.8 120.2 250.2"/><path class="f b" d="M113 65 L127 65 L120 75 Z"/></g><text x="128" y="275" text-anchor="start" style="font-size:18px">4 threads × ~5 ms = the 20 ms quota, used up after ~5 ms of wall time</text><text x="128" y="300" text-anchor="start" class="r" style="font-size:18px">runnable work in the group is throttled until the next period starts</text></svg><figcaption>The quota is shared by every thread in the group. Spend it early and the group waits for the next period, even on an idle node.</figcaption></figure>

Here's the trap, and it's the one I see most often: the budget is shared by **all threads**. Four busy threads running on four CPUs burn through 20 ms in about 5 ms of real time. After that, any work in the group that's ready to run has to wait until the next period starts, about 95 ms later in this example. Your dashboard says "20% CPU", but every request that lands in one of those gaps is slow. This is called **throttling**.

**Try it yourself.** Start two pods. Both run four loops that each want a whole CPU. `cpu-limited` has `limits.cpu: 200m`; `cpu-unlimited` has no CPU limit.

```bash
kubectl -n lab apply -f modules/02-cpu-throttling/pods.yaml
kubectl -n lab wait --for=condition=Ready pod/cpu-limited pod/cpu-unlimited
kubectl -n lab exec cpu-limited   -- cat /sys/fs/cgroup/cpu.max
kubectl -n lab exec cpu-unlimited -- cat /sys/fs/cgroup/cpu.max
```

```output
20000 100000
max 100000
```

`max` means "no quota". Now look at the kernel's own accounting. `cpu.stat` keeps running totals; read it, wait 10 seconds, and read it again:

```bash
kubectl -n lab exec cpu-limited -- cat /sys/fs/cgroup/cpu.stat
sleep 10
kubectl -n lab exec cpu-limited -- cat /sys/fs/cgroup/cpu.stat
```

| Line in `cpu.stat` | Meaning |
|---|---|
| `usage_usec` | Total CPU time used, in microseconds |
| `nr_periods` | How many 100 ms windows have passed while the group had work to do |
| `nr_throttled` | In how many of those windows it ran out of quota and had to wait |
| `throttled_usec` | Total time spent throttled, waiting for the next window |

Between your two reads, `nr_periods` and `nr_throttled` both go up by about 100. That's throttled in almost every window. Do the same for `cpu-unlimited` and `nr_throttled` stays at `0`. Same loops, same node, no limit, so it just uses the idle CPUs.

Over a longer sample, the shortcut turns these numbers into CPU used:

```text
  pod            periods   throttled   CPU used (millicores)
  cpu-limited    250       249         200
  cpu-unlimited  -         0           several thousand
```

In production, alert on the share of throttled windows, not on average CPU. cAdvisor, built into the kubelet, exports these same counters to Prometheus:

```text
rate(container_cpu_cfs_throttled_periods_total[5m]) / rate(container_cpu_cfs_periods_total[5m])
```

*Shortcut: `make 02-cpu-throttling`.*

> [!KEY]
> A CPU limit never kills. It makes you **wait**, even on an idle node.

### Should you even set CPU limits?

This is one of the longest-running debates in Kubernetes, and after building this lab I understand why.

**The case against.** A CPU limit throttles you even when the node is idle, like the lab showed. And if your requests are honest, you're already protected when CPUs are busy: `cpu.weight` makes sure everyone gets their share. So a lot of teams set good CPU requests and simply drop CPU limits for latency-sensitive services. Spare CPU gets used instead of wasted, and those throttled gaps disappear.

**The case for.** Limits still earn their place when:

- you run untrusted or multi-tenant workloads and need hard isolation between them;
- you want predictable performance. Without a limit, a service is fast on a quiet node and slower on a busy one, which makes load tests misleading;
- you need the Guaranteed QoS class, for example for exclusive CPU cores with the static CPU manager, since Guaranteed requires limits equal to requests;
- it's a batch job you deliberately want capped.

**What I do.** Always set memory limits. For CPU, set honest requests everywhere, drop limits on latency-sensitive services, and keep them where isolation or predictability matters more than raw speed. Either way, watch the throttling ratio before and after the change. One catch: runtimes like Go and the JVM size their thread pools from the CPU limit, so without one they see every core on the host. Set `GOMAXPROCS` or `-XX:ActiveProcessorCount` explicitly to match your request.

If you want both sides argued in depth, [learnk8s on CPU requests and limits](https://itnext.io/cpu-limits-and-requests-in-kubernetes-fa9d55948b7c) and [Why you should keep using CPU limits](https://dnastacio.medium.com/why-you-should-keep-using-cpu-limits-on-kubernetes-60c4e50dfc61) are good reads.


## Lesson 5: A CPU request is your slice of the pizza

A request does not reserve a core. When the node is quiet, it does nothing: anyone can use spare CPU. It only matters when everyone is hungry at once, and then the kernel cuts the pizza in proportion to each group's `cpu.weight`.

<figure class="sketch anim"><svg viewBox="0 0 760 250" role="img" aria-label="CPU requests influence how contended CPU is shared"><title>CPU requests influence how contended CPU is shared</title><defs><clipPath id="cwt1"><rect x="180" y="65" width="62" height="40"/></clipPath><clipPath id="cwt2"><rect x="180" y="135" width="508" height="40"/></clipPath></defs><text x="20" y="32" text-anchor="start" style="font-size:22px">A request influences your CPU share when groups compete</text><text x="20" y="90" text-anchor="start" style="font-size:20px">request 100m</text><text x="20" y="160" text-anchor="start" style="font-size:20px">request 800m</text><g class="anim-grow"><path class="h a" clip-path="url(#cwt1)" d="M146.1 106.2Q162.1 84.6 179.4 62.2M150.0 106.5Q168.4 85.6 185.3 63.8M157.8 107.7Q172.6 83.5 192.4 63.8M164.2 107.0Q182.4 85.8 198.8 63.2M168.3 107.8Q186.2 84.5 204.7 64.2M176.1 106.9Q193.4 84.8 209.6 62.3M181.4 106.1Q198.3 84.5 216.4 62.4M187.5 108.1Q203.5 83.9 221.6 63.5M194.8 107.3Q209.7 84.2 228.0 62.8M201.6 106.7Q219.6 85.6 236.0 62.1M208.0 107.2Q225.6 85.0 242.7 62.7M214.6 106.1Q230.9 84.3 248.3 62.0M220.3 106.6Q238.0 84.7 254.2 61.8M227.7 106.0Q243.5 83.9 262.1 62.7M235.2 107.0Q249.8 83.8 268.8 63.4M240.3 106.4Q255.7 84.3 274.9 63.8"/><path class="s a" d="M179.3 64.1Q210.8 65.1 241.5 63.5M180.3 63.4Q210.5 64.9 242.9 64.0"/><path class="s a" d="M241.3 64.8Q242.1 84.8 240.8 106.2M241.4 64.6Q243.8 84.6 240.5 103.8"/><path class="s a" d="M243.6 103.5Q210.9 106.1 180.1 103.8M242.1 103.8Q210.8 104.1 178.4 104.2"/><path class="s a" d="M179.6 104.5Q180.9 85.0 181.0 64.1M180.1 106.3Q181.0 85.6 179.8 65.2"/></g><g class="anim-grow d2"><path class="h b" clip-path="url(#cwt2)" d="M144.3 176.1Q163.3 155.7 180.1 133.7M150.3 175.9Q168.5 154.3 184.9 133.5M157.3 176.8Q174.9 156.0 191.6 133.8M162.5 178.2Q179.9 154.1 197.6 132.4M168.9 176.6Q186.3 154.4 205.3 132.4M176.8 177.0Q194.6 156.3 210.4 132.9M183.0 176.3Q200.2 155.0 218.0 131.9M189.2 177.9Q205.7 154.3 224.4 133.1M196.2 178.1Q213.1 154.5 230.0 133.9M201.6 178.0Q219.7 155.4 235.8 133.0M207.7 177.6Q224.5 153.9 242.2 132.3M213.5 176.0Q230.9 155.9 248.7 134.0M220.0 177.2Q238.1 156.0 253.8 132.1M226.3 177.0Q243.3 155.4 261.5 133.9M231.6 178.0Q250.1 155.8 266.4 134.1M237.2 176.0Q255.8 155.6 272.2 132.8M243.9 177.2Q262.8 155.6 279.5 132.0M250.6 176.3Q265.7 154.0 285.3 132.5M254.0 176.0Q273.3 155.8 289.4 132.3M259.6 177.2Q276.4 153.4 295.9 133.4M265.8 175.9Q284.9 155.8 301.7 133.0M272.5 176.8Q290.6 155.9 306.9 132.5M279.4 176.0Q296.8 154.9 314.0 132.2M284.9 176.5Q304.1 156.4 319.4 132.9M291.3 176.4Q308.9 155.4 325.2 132.7M296.5 177.8Q313.9 155.5 330.4 132.8M300.2 178.0Q317.0 153.6 334.7 132.7M307.7 177.3Q325.3 155.8 343.4 133.7M314.5 177.3Q332.0 155.7 348.2 131.8M320.5 176.8Q337.2 154.4 355.9 133.2M327.1 177.5Q344.6 155.7 361.8 133.9M332.4 177.0Q349.8 154.9 368.3 131.9M337.5 177.7Q356.3 155.9 372.9 133.2M343.5 176.8Q360.8 155.0 377.1 133.5M350.2 176.1Q367.5 155.4 385.2 132.0M356.3 177.0Q373.8 155.6 389.9 133.7M363.5 177.9Q378.7 154.3 397.2 131.9M370.3 176.2Q385.9 154.3 404.6 133.5M375.3 177.4Q391.6 155.3 409.0 133.2M378.6 177.1Q396.6 155.1 413.7 133.2M385.7 177.4Q400.9 154.1 420.8 132.1M390.4 177.1Q408.5 155.0 426.5 133.5M396.4 177.3Q413.5 154.0 431.4 132.5M402.5 177.4Q420.9 155.5 438.6 132.4M409.6 177.7Q426.6 154.7 444.6 131.8M416.0 177.5Q433.7 154.9 450.3 132.1M421.9 176.7Q439.7 155.2 457.9 133.4M429.6 177.5Q446.1 154.6 464.4 133.5M437.5 177.6Q453.7 154.5 472.2 133.9M441.8 177.2Q461.2 156.1 478.0 132.5M449.6 176.7Q466.2 154.5 483.1 132.5M455.3 177.3Q473.8 154.9 490.4 132.1M461.4 176.2Q480.0 155.8 496.9 133.7M468.2 178.1Q487.1 156.0 502.8 132.2M476.4 177.0Q493.9 155.4 509.6 132.0M483.5 177.8Q498.3 153.8 518.1 133.3M488.7 176.0Q505.4 156.0 522.9 132.4M492.9 176.0Q511.2 155.7 527.4 133.4M498.8 176.6Q516.1 153.7 533.5 132.0M504.9 177.4Q522.6 154.8 541.7 132.9M510.9 176.5Q528.6 154.7 546.9 133.0M517.6 177.3Q533.4 154.0 551.9 132.7M522.0 176.3Q540.1 155.2 558.7 134.0M528.7 177.8Q547.7 156.1 564.1 133.0M535.5 176.9Q552.2 154.6 570.1 132.3M540.7 176.6Q560.0 155.7 576.8 132.4M545.9 177.4Q563.0 154.2 582.4 132.4M552.3 176.9Q569.3 154.8 586.6 132.8M556.1 177.8Q573.5 154.2 590.8 132.8M563.6 176.6Q579.3 154.7 597.4 132.8M568.4 176.9Q584.9 154.7 602.0 133.9M574.1 176.9Q590.9 154.4 609.5 133.6M580.0 177.9Q597.0 155.0 614.5 132.8M585.5 176.0Q601.7 154.9 619.4 132.8M591.8 178.1Q610.7 155.6 626.5 133.4M598.2 177.6Q614.4 155.3 631.4 133.9M603.4 176.4Q619.9 154.0 639.3 132.3M608.8 176.1Q625.9 154.3 645.7 134.0M616.2 176.9Q632.6 154.7 651.2 132.0M622.5 177.9Q640.7 155.9 656.6 132.1M625.9 178.1Q644.7 155.4 661.2 133.3M632.8 176.0Q649.9 154.7 667.2 131.9M641.1 176.9Q656.9 154.4 674.2 132.0M645.3 177.3Q664.4 155.9 681.5 134.1M651.4 177.0Q670.0 156.1 685.8 132.7M656.7 176.9Q674.7 154.6 693.4 133.8M664.0 176.6Q680.2 155.2 696.6 133.1M668.6 176.3Q686.8 155.0 703.9 133.6M676.1 177.2Q691.8 155.1 710.2 132.6M680.7 177.4Q696.4 154.3 715.9 132.8M686.2 177.7Q703.1 154.6 721.9 131.9"/><path class="s b" d="M179.8 135.5Q434.3 134.5 687.3 135.5M181.2 135.0Q433.9 132.9 688.5 135.5"/><path class="s b" d="M686.8 136.2Q687.4 154.8 688.9 175.5M688.1 134.9Q686.9 154.6 688.5 176.2"/><path class="s b" d="M689.2 175.2Q433.8 175.8 180.3 176.3M686.7 175.2Q433.4 173.5 180.0 176.5"/><path class="s b" d="M179.9 174.9Q178.5 155.6 179.8 134.3M180.0 176.6Q178.4 154.6 181.5 134.4"/></g><text x="255" y="92" text-anchor="start" class="m" style="font-size:18px">≈ 1 part</text><text x="700" y="210" text-anchor="end" class="m" style="font-size:18px">≈ 8 parts</text><text x="20" y="238" text-anchor="start" class="m" style="font-size:16px">observed in one lab run on a 10-CPU node: 8.2x · results vary with what else is competing</text></svg><figcaption>A CPU request isn't a reserved core. It's your slice of the pizza when everyone is hungry.</figcaption></figure>

**Try it yourself.** Start two greedy pods with no CPU limits. Each runs one busy loop per CPU on the node, so together they want twice what exists. `weight-low` requests `100m`, `weight-high` requests `800m`. The manifest has a placeholder for the number of loops, so fill it in with the node's CPU count first:

```bash
THREADS=$(docker exec under-the-hood-worker nproc)
sed "s/__THREADS__/$THREADS/g" modules/03-cpu-weight/pods.yaml | kubectl -n lab apply -f -
kubectl -n lab wait --for=condition=Ready pod/weight-low pod/weight-high
kubectl -n lab exec weight-low  -- cat /sys/fs/cgroup/cpu.weight
kubectl -n lab exec weight-high -- cat /sys/fs/cgroup/cpu.weight
```

```output
17
84
```

The weights aren't a neat 1:8. The kubelet converts millicores to an older unit called "shares", and newer container runtimes convert shares to `cpu.weight` with a curved formula. So read the file; don't try to calculate it.

To see who actually wins, compare `usage_usec` (total CPU time in microseconds) for both pods over 10 seconds:

```bash
for p in weight-low weight-high; do kubectl -n lab exec $p -- grep usage_usec /sys/fs/cgroup/cpu.stat; done
sleep 10
for p in weight-low weight-high; do kubectl -n lab exec $p -- grep usage_usec /sys/fs/cgroup/cpu.stat; done
```

Subtract the first number from the second for each pod and divide by 10,000 to get millicores. On my 10-CPU setup:

```text
  CPU split high/low    8.2x
  request ratio         8.0x  (800m / 100m)
```

In this run, the bigger request got about 8 times more CPU, close to the ratio of the requests. Treat that as one observation, not a guarantee: the real split depends on the whole cgroup tree and on everything else competing for the CPUs at the time. The request-to-weight conversion also varies between container runtime versions.

*Shortcut: `make 03-cpu-weight`.*

> [!KEY]
> A CPU request influences your share of CPU when groups compete. When CPUs are idle, it does nothing.

## Lesson 6: Memory can't be throttled, so it's killed

CPU is easy to share: make someone wait a few milliseconds and they carry on. Memory is different. If a program needs more memory and its box is full, waiting doesn't free any. The kernel first tries to reclaim memory it can safely drop, such as cached file data. When there's nothing left to reclaim, it calls the **OOM killer** (out of memory), which kills a process in the box.

<figure class="sketch anim"><svg viewBox="0 0 760 330" role="img" aria-label="Reaching the memory limit leads to reclaim, then possibly an OOM kill"><title>Reaching the memory limit leads to reclaim, then possibly an OOM kill</title><defs><clipPath id="com1"><rect x="62" y="70" width="156" height="220"/></clipPath></defs><g class="anim-fill"><path class="h b" clip-path="url(#com1)" d="M-129.7 292.6Q-33.3 180.5 62.5 68.4M-124.6 292.0Q-29.9 179.1 66.8 68.8M-116.4 292.9Q-21.3 179.3 73.3 68.5M-110.1 292.3Q-14.3 181.2 79.8 67.0M-103.4 292.8Q-8.1 179.6 88.1 66.8M-97.3 291.7Q-3.8 178.7 93.5 68.9M-93.2 291.4Q3.3 180.2 99.0 67.3M-86.3 293.0Q9.1 179.8 104.1 67.6M-79.3 291.6Q15.7 179.7 111.3 67.5M-72.5 293.0Q22.5 180.2 116.5 68.2M-67.0 291.7Q28.3 180.2 123.3 67.4M-61.9 292.7Q32.3 179.4 130.3 68.7M-56.0 292.4Q39.6 181.3 134.2 67.0M-52.2 291.2Q44.1 180.4 139.1 68.5M-45.7 291.9Q49.6 179.8 146.7 68.6M-41.4 292.6Q54.5 179.4 151.2 67.8M-33.3 292.3Q61.7 180.0 157.5 69.2M-26.9 292.1Q68.0 179.6 163.6 68.2M-20.5 292.1Q75.8 180.6 170.6 66.8M-14.4 291.3Q82.3 181.2 175.7 68.0M-8.3 293.2Q85.6 179.2 181.7 69.0M-2.6 292.4Q92.3 179.1 190.1 68.7M4.0 291.4Q98.3 178.6 194.8 68.1M11.2 291.6Q107.5 180.7 202.4 68.8M15.2 292.1Q111.7 180.4 206.2 68.0M20.7 291.3Q115.5 179.2 212.1 67.3M28.0 292.1Q124.3 180.5 219.1 68.1M34.8 291.6Q129.3 178.8 226.6 68.9M42.1 292.7Q137.1 179.5 232.7 67.6M47.5 291.4Q144.7 180.4 238.6 66.8M53.1 291.2Q148.9 180.4 245.6 67.0M59.6 291.5Q155.3 181.1 251.1 69.0M66.0 292.4Q159.3 179.4 257.0 68.7M70.4 291.4Q165.7 179.6 260.8 67.8M77.5 290.9Q171.9 178.8 269.0 68.0M84.3 292.6Q177.9 179.8 273.8 67.3M89.2 291.7Q186.1 180.7 280.1 67.3M95.2 292.4Q192.2 180.7 285.7 68.9M102.7 292.5Q196.6 179.3 292.5 69.1M108.5 293.1Q205.4 180.9 300.0 69.1M113.5 290.9Q208.4 178.5 304.5 67.9M118.9 291.7Q214.4 179.3 310.0 68.2M126.9 292.5Q220.1 178.9 316.6 68.3M132.4 291.9Q229.9 180.7 323.5 68.6M137.7 292.0Q235.2 181.5 329.0 67.7M143.9 292.6Q241.4 181.0 335.3 67.3M152.7 291.1Q246.2 178.6 341.8 67.9M155.9 291.0Q253.0 180.2 347.2 67.9M164.5 292.9Q259.4 180.1 354.1 68.4M169.8 292.6Q266.5 181.2 359.7 67.6M173.8 291.5Q269.5 179.2 365.6 67.0M181.0 292.6Q276.0 179.7 371.8 67.4M188.0 292.8Q282.1 180.0 378.8 67.9M193.8 291.3Q288.1 179.0 384.8 68.8M198.9 291.4Q294.4 178.8 391.7 68.8M204.6 292.3Q300.1 179.3 398.2 67.6M212.6 292.2Q308.6 180.5 403.6 68.2"/><path class="s b" d="M60.5 68.8Q140.5 69.9 218.0 70.7M61.6 70.5Q139.4 71.5 217.7 69.3"/><path class="s b" d="M219.4 69.4Q219.8 180.1 217.9 291.5M217.8 68.7Q216.7 180.3 216.7 290.0"/><path class="s b" d="M217.2 289.8Q139.7 291.3 62.0 288.4M218.0 289.1Q139.7 288.0 60.5 288.8"/><path class="s b" d="M61.1 289.0Q59.5 179.8 63.1 70.2M60.5 290.8Q61.9 180.5 62.5 69.7"/></g><path class="s" d="M51.1 48.6Q55.9 172.6 58.7 295.4M48.5 51.0Q56.2 172.3 59.0 294.5"/><path class="s" d="M231.4 49.4Q224.3 172.9 219.1 294.9M230.7 49.1Q223.5 172.6 220.2 294.8"/><path class="s" d="M60.4 295.7Q139.8 297.0 220.9 295.8M60.7 294.4Q140.6 292.5 218.7 294.6"/><path class="s r" d="M30.5 99.8Q34.8 99.4 40.0 100.2"/><path class="s r" d="M47.6 100.7Q51.8 99.5 57.2 100.5"/><path class="s r" d="M64.6 99.5Q69.2 100.0 74.0 99.3"/><path class="s r" d="M81.1 99.7Q86.0 100.3 90.4 99.7"/><path class="s r" d="M98.5 99.6Q102.9 101.0 107.9 100.5"/><path class="s r" d="M115.3 99.2Q120.2 98.8 125.2 99.3"/><path class="s r" d="M131.8 99.6Q137.1 99.6 141.8 99.7"/><path class="s r" d="M149.4 100.5Q153.8 99.3 158.8 100.7"/><path class="s r" d="M166.4 100.7Q171.2 99.8 176.2 100.6"/><path class="s r" d="M183.1 99.3Q188.0 99.5 192.6 100.2"/><path class="s r" d="M200.1 99.4Q205.1 99.8 209.9 100.7"/><path class="s r" d="M216.8 99.5Q221.7 99.7 227.0 100.7"/><path class="s r" d="M233.9 99.6Q238.8 99.8 244.7 100.6"/><text x="140" y="88" text-anchor="middle" class="r" style="font-size:19px">memory.max</text><path class="s" d="M300.3 30.1Q515.4 31.6 730.1 30.1M300.5 29.2Q514.7 28.5 730.9 30.4"/><path class="s" d="M729.3 30.7Q731.1 69.6 729.7 111.0M731.2 29.9Q729.5 70.4 730.5 110.4"/><path class="s" d="M730.5 108.8Q515.2 111.5 299.8 109.3M729.6 110.8Q514.5 107.9 299.3 110.4"/><path class="s" d="M300.6 109.1Q301.2 69.9 299.4 30.9M300.1 111.0Q298.7 69.7 299.1 30.0"/><text x="316" y="58" text-anchor="start" class="big" style="font-size:22px">1. allocate</text><text x="316" y="82" text-anchor="start" style="font-size:17px">the app asks for more memory</text><path class="s y" d="M299.5 125.1Q514.6 126.5 731.1 126.0M301.1 124.4Q514.7 124.4 729.5 124.7"/><path class="s y" d="M729.8 125.1Q728.1 164.7 729.3 205.7M730.9 126.1Q731.2 164.9 729.9 204.8"/><path class="s y" d="M728.9 204.4Q515.1 205.0 300.2 204.6M731.1 204.4Q515.0 206.7 299.3 205.4"/><path class="s y" d="M299.6 206.1Q301.0 165.0 301.1 124.4M301.1 204.6Q301.4 164.8 301.1 125.2"/><text x="316" y="153" text-anchor="start" class="big" style="font-size:22px">2. reclaim</text><text x="316" y="177" text-anchor="start" style="font-size:17px">at the limit, the kernel frees what it can,</text><text x="316" y="197" text-anchor="start" class="m" style="font-size:16px">such as cached file data</text><path class="s r" d="M299.6 219.8Q515.4 220.7 729.6 219.4M298.9 220.8Q515.2 219.3 730.4 221.0"/><path class="s r" d="M730.5 220.2Q729.6 260.3 730.2 299.7M730.0 219.2Q730.4 259.9 731.0 301.0"/><path class="s r" d="M730.3 300.6Q514.6 300.3 299.8 300.7M728.9 298.8Q514.8 300.7 300.9 299.1"/><path class="s r" d="M300.1 298.9Q298.6 259.8 298.9 220.0M300.7 300.6Q301.4 259.7 300.0 220.5"/><text x="316" y="248" text-anchor="start" class="big" style="font-size:22px">3. OOM kill</text><text x="316" y="272" text-anchor="start" style="font-size:17px">only if reclaim can't free enough:</text><text x="316" y="292" text-anchor="start" class="m" style="font-size:16px">the OOM killer ends a process</text><path class="s" d="M514.3 112.2Q515.1 117.3 515.8 124.0M514.2 110.8Q514.2 117.8 514.8 124.6"/><path class="s" d="M515.2 122.5Q512.5 118.3 510.5 113.4M515.3 123.7Q511.9 118.0 509.4 113.0"/><path class="s" d="M514.5 122.8Q518.3 118.5 519.1 112.9M514.6 123.0Q517.8 118.6 519.9 113.1"/><path class="s" d="M515.3 208.5Q514.5 212.9 516.1 219.2M514.0 206.2Q514.1 212.4 515.0 218.8"/><path class="s" d="M515.1 217.5Q512.3 212.9 510.8 207.8M514.5 217.3Q512.0 213.4 510.3 208.8"/><path class="s" d="M515.2 218.4Q516.9 213.1 519.0 208.7M514.4 217.6Q518.4 213.8 520.5 207.7"/><g class="anim-kill"><text x="140" y="30" text-anchor="middle" class="big r">OOMKilled · exit 137</text></g></svg><figcaption>Memory can't be throttled like CPU. At the limit the kernel reclaims first; the OOM kill comes only if that isn't enough.</figcaption></figure>

**Try it yourself.** `memory-hog` has a 64Mi limit and runs a small Python script that grabs 10 MiB every 0.3 seconds and never lets go:

```bash
kubectl -n lab apply -f modules/04-memory-and-oom/pod.yaml
kubectl -n lab get pod memory-hog -w
```

Within seconds the status flips to `OOMKilled`, Kubernetes restarts it, and it happens again. Press Ctrl-C, then look at what it printed before it died:

```bash
kubectl -n lab logs memory-hog --previous | tail -3
```

```output
allocated 40 MiB
allocated 50 MiB
allocated 60 MiB
```

It never reached 70, or even 64. The Python interpreter itself lives in the same box and uses memory too.

Kubernetes records the death as `reason: OOMKilled`, `exitCode: 137`. **Exit code 137** means "killed by a signal": 128 plus the signal number, and signal 9 is `SIGKILL`, the one a program can't catch or ignore. It gets no chance to clean up or log anything.

The kernel keeps its own tally in `memory.events`. Read it from the pod's folder on the node:

```bash
POD_DIR=$(./scripts/pod-cgroup.sh memory-hog)
docker exec under-the-hood-worker cat "$POD_DIR/memory.events"
```

```output
low 0
high 0
max 75
oom 2
oom_kill 4
oom_group_kill 2
```

| Line | Meaning |
|---|---|
| `max` | Times usage hit `memory.max` and the kernel had to try to free memory |
| `oom` | Times freeing memory failed, so something had to be killed |
| `oom_kill` | Processes the kernel killed |
| `oom_group_kill` | Times it killed a whole container's processes together (the kubelet turns this on so nothing is left half-alive) |
| `low`, `high` | Softer limits Kubernetes doesn't set by default |

This also explains how a pod can get OOM-killed while the dashboard shows 50%. Most dashboards sample memory every 15 to 60 seconds, but the kernel reacts as soon as usage reaches `memory.max`, so a short spike between two samples never shows up on the graph. Check what your panel divides by, too: many show memory as a share of the *request* or of the node, not of the limit. `memory.events` doesn't miss anything, so trust it over the graph.

*Shortcut: `make 04-memory-and-oom`.*

> [!KEY]
> At `memory.max` the kernel reclaims what it can first. If that isn't enough, it OOM-kills a process in the cgroup: `OOMKilled`, exit code 137.

## Lesson 7: QoS classes and who goes first

Kubernetes sorts every pod into one of three **Quality of Service** classes. You never pick one yourself; it's worked out from your requests and limits:

| Class | How you get it |
|---|---|
| Guaranteed | Every container has requests **equal** to limits, for both CPU and memory |
| Burstable | Some requests or limits, but not Guaranteed |
| BestEffort | Nothing set at all |

QoS affects how protected a pod is when the **whole node** runs short of memory, not just one container: both in the kernel's choice of what to kill and in the kubelet's eviction order (lesson 9). For the kernel, Kubernetes gives every process a score up front:

<figure class="sketch "><svg viewBox="0 0 760 270" role="img" aria-label="QoS classes affect OOM protection"><title>QoS classes affect OOM protection</title><defs><clipPath id="cqo1"><rect x="25" y="40" width="210" height="150"/></clipPath><clipPath id="cqo2"><rect x="275" y="40" width="210" height="150"/></clipPath><clipPath id="cqo3"><rect x="525" y="40" width="210" height="150"/></clipPath></defs><path class="s" d="M40.0 229.7Q380.4 230.9 721.6 229.3M39.4 229.3Q379.7 227.9 718.7 229.4"/><path class="s" d="M719.3 229.5Q715.3 232.6 710.2 234.6M719.4 230.4Q715.0 231.8 710.5 234.6"/><path class="s" d="M720.5 230.5Q715.1 227.5 710.8 224.8M719.8 229.4Q715.2 227.7 710.3 224.6"/><text x="40" y="258" text-anchor="start" class="r" style="font-size:20px">least protected</text><text x="720" y="258" text-anchor="end" class="g" style="font-size:20px">most protected</text><path class="h r" clip-path="url(#cqo1)" d="M-105.4 191.1Q-40.1 115.5 25.0 38.0M-94.3 190.9Q-26.9 116.4 36.4 37.1M-81.5 192.6Q-17.1 114.2 49.1 37.5M-68.3 191.0Q-5.3 114.1 60.5 38.0M-57.6 191.2Q7.1 113.6 73.3 37.9M-46.4 192.4Q20.6 115.5 85.4 36.8M-33.4 192.2Q32.5 115.8 97.9 37.3M-22.3 191.3Q42.6 114.1 108.9 38.6M-9.4 192.5Q54.4 114.3 121.2 38.3M2.0 190.9Q66.6 114.4 133.3 37.2M13.4 191.9Q80.5 116.4 144.1 37.6M24.8 192.4Q91.1 115.3 156.2 37.8M37.0 191.7Q101.4 114.5 166.7 37.5M50.2 192.1Q115.1 114.4 180.7 38.0M62.8 191.4Q127.5 115.4 193.5 38.8M73.9 191.0Q138.0 114.2 204.3 38.1M85.6 191.6Q151.3 114.8 217.6 37.3M97.2 191.3Q162.8 114.8 227.5 37.1M110.2 190.9Q175.7 114.9 239.9 37.5M121.7 191.2Q187.6 115.4 251.3 38.3M133.2 193.1Q198.7 115.2 263.8 38.8M145.4 193.1Q210.2 114.7 275.9 36.9M158.1 193.0Q221.4 114.9 288.4 37.4M167.2 192.4Q232.6 113.5 299.7 38.1M178.9 193.2Q243.5 114.0 309.2 37.2M192.6 192.0Q256.1 113.6 322.1 38.3M203.7 191.5Q270.4 115.9 334.1 37.6M215.6 191.3Q279.7 115.5 345.6 37.2M227.3 191.4Q291.3 114.3 355.9 38.0"/><path class="s r" d="M25.1 39.5Q130.0 40.2 234.0 40.1M23.4 41.5Q130.1 40.3 235.6 41.1"/><path class="s r" d="M236.5 41.3Q233.2 114.6 233.6 190.4M235.5 39.8Q234.4 115.1 234.2 191.2"/><path class="s r" d="M236.3 189.6Q129.7 189.5 25.2 188.7M236.4 188.9Q130.4 192.5 25.6 189.7"/><path class="s r" d="M23.7 189.5Q24.0 114.5 23.9 39.7M24.9 188.9Q25.7 115.5 25.2 38.5"/><text x="130" y="80" text-anchor="middle" class="big">BestEffort</text><text x="130" y="115" text-anchor="middle" style="font-size:19px">no requests, no limits</text><text x="130" y="160" text-anchor="middle" class="code">oom_score_adj 1000</text><path class="h y" clip-path="url(#cqo2)" d="M144.5 193.0Q209.9 115.4 274.1 37.5M157.3 193.1Q221.4 115.5 287.1 38.7M169.0 192.4Q232.4 114.0 297.6 37.5M179.2 191.8Q244.6 115.0 309.8 38.7M189.8 191.5Q256.7 115.9 322.0 39.1M203.3 192.0Q266.9 114.5 332.4 39.0M213.5 192.0Q281.1 116.0 344.9 38.3M228.2 192.8Q292.0 115.0 357.0 38.8M240.2 191.4Q304.2 114.8 369.9 38.4M251.9 191.6Q317.1 115.7 380.7 39.1M263.9 193.1Q326.8 113.6 392.6 38.4M275.4 192.2Q339.8 113.6 406.7 37.5M288.8 192.7Q353.3 115.1 418.3 38.7M298.9 192.8Q364.8 114.9 430.1 37.7M312.9 192.9Q378.4 115.8 442.5 38.7M325.8 192.6Q390.8 115.2 455.1 37.1M337.4 192.8Q403.9 116.0 469.7 38.1M349.8 192.4Q416.2 115.3 480.9 36.8M362.2 192.3Q428.3 115.0 493.8 37.8M374.3 191.3Q441.0 115.5 505.3 38.1M387.6 193.2Q453.1 114.9 517.4 37.2M398.8 191.9Q464.4 114.2 530.7 38.2M410.7 192.9Q477.4 115.6 541.7 38.4M423.3 191.6Q487.7 114.3 554.5 38.7M434.3 192.8Q500.5 116.5 564.9 37.8M446.1 192.0Q511.5 114.8 577.3 37.2M457.2 191.0Q521.4 113.9 588.9 36.9M469.9 191.0Q534.2 114.2 599.6 37.0M481.3 192.8Q546.2 113.6 613.3 37.1"/><path class="s y" d="M275.2 40.2Q379.8 41.6 484.3 40.1M275.0 38.4Q379.5 41.9 484.3 39.0"/><path class="s y" d="M484.7 41.0Q484.4 115.2 486.0 190.6M484.1 40.3Q486.9 115.4 486.3 189.4"/><path class="s y" d="M484.5 189.1Q379.8 190.3 276.4 189.6M484.1 189.7Q379.9 187.3 276.6 189.8"/><path class="s y" d="M275.3 188.9Q272.9 114.9 274.4 38.8M273.8 188.8Q274.1 115.4 273.8 39.7"/><text x="380" y="80" text-anchor="middle" class="big">Burstable</text><text x="380" y="115" text-anchor="middle" style="font-size:19px">some requests or limits</text><text x="380" y="160" text-anchor="middle" class="code">2 … 999</text><path class="h g" clip-path="url(#cqo3)" d="M395.6 191.5Q461.5 116.0 524.7 37.4M407.1 192.3Q471.4 114.6 536.6 37.6M419.1 192.9Q483.8 114.4 549.7 37.5M429.5 192.3Q495.0 114.9 560.2 38.1M442.5 192.2Q507.7 114.9 573.9 37.6M454.3 192.8Q520.5 115.0 584.6 37.1M465.6 192.3Q532.2 116.3 596.6 37.5M478.6 191.8Q544.3 115.6 607.0 38.1M489.5 191.0Q555.7 115.3 619.8 38.1M503.7 191.2Q567.6 114.5 632.7 38.3M512.7 192.0Q580.0 116.4 645.1 38.3M525.2 192.3Q591.3 115.7 655.3 38.1M538.2 192.4Q601.5 114.0 666.8 37.9M549.2 191.5Q615.0 115.3 679.0 38.0M561.6 192.9Q626.1 115.1 690.5 38.1M573.9 193.0Q639.8 115.8 703.0 37.5M585.3 192.1Q649.7 113.9 716.1 37.2M599.2 191.8Q663.7 114.6 729.1 38.1M610.0 191.0Q677.7 116.1 740.8 38.7M621.9 191.8Q687.0 113.7 754.2 37.6M634.0 191.4Q699.6 114.9 764.7 37.8M645.6 192.8Q711.5 114.6 777.2 37.3M658.4 191.7Q722.7 114.1 787.9 38.8M668.8 191.5Q735.3 115.3 800.8 38.6M682.5 193.0Q746.9 115.6 812.4 38.4M693.8 191.5Q758.3 114.1 823.9 37.8M707.5 191.6Q773.3 116.3 838.3 38.1M717.6 191.8Q782.8 115.0 848.2 37.1M729.8 192.9Q794.7 116.0 858.2 38.0"/><path class="s g" d="M524.6 38.8Q629.7 38.0 734.8 40.6M525.9 40.6Q630.2 38.9 734.9 39.5"/><path class="s g" d="M735.0 40.7Q735.7 114.4 734.8 190.0M736.2 40.8Q732.5 114.9 733.9 189.7"/><path class="s g" d="M736.0 188.5Q629.7 190.0 525.3 188.4M733.7 188.6Q629.4 190.2 525.7 188.6"/><path class="s g" d="M524.1 189.7Q523.7 115.1 525.7 40.2M524.3 189.0Q526.5 114.6 526.0 40.3"/><text x="630" y="80" text-anchor="middle" class="big">Guaranteed</text><text x="630" y="115" text-anchor="middle" style="font-size:19px">requests = limits</text><text x="630" y="160" text-anchor="middle" class="code">-997</text><text x="380" y="20" text-anchor="middle" class="m" style="font-size:16px">example values from this lab</text></svg><figcaption>QoS affects OOM protection and eviction behaviour. Burstable scores vary with the memory request.</figcaption></figure>

**Try it yourself.** Start three sleeping pods, one per class, and compare:

```bash
kubectl -n lab apply -f modules/05-qos-classes/pods.yaml
kubectl -n lab wait --for=condition=Ready pod -l module=05
for p in qos-guaranteed qos-burstable qos-besteffort; do
  echo "$p $(kubectl -n lab get pod $p -o jsonpath='{.status.qosClass}') $(kubectl -n lab exec $p -- cat /proc/1/oom_score_adj)"
done
```

```output
qos-guaranteed Guaranteed -997
qos-burstable Burstable 996
qos-besteffort BestEffort 1000
```

**What `/proc/1/oom_score_adj` is:** `/proc` has a folder per running process, named after its PID. Inside a container, the main process is PID 1, so `/proc/1/` is the container's main program. `oom_score_adj` is a number from -1000 to 1000 that nudges the kernel's choice: when the machine runs out of memory, the kernel scores every process (mostly by how much memory it uses), adds this number, and kills the highest. So BestEffort is least protected and Guaranteed most. These are the values from this lab; Burstable values change from pod to pod. The Burstable pod got 996 because its memory request is tiny compared with the node; a bigger request means a lower number.

Each class also lives in its own place in the tree. `./scripts/pod-cgroup.sh qos-burstable` shows the Burstable pod inside `kubelet-kubepods-burstable.slice`, while the Guaranteed pod gets a folder directly under the box for all pods.

*Shortcut: `make 05-qos-classes`.*

> [!KEY]
> QoS affects OOM protection and eviction. BestEffort is the least protected, Guaranteed the most.

## Lesson 8: Not all of a node is for pods

A node with 8 GiB of memory can't hand all 8 GiB to pods; the operating system and Kubernetes' own programs need some too. The part left for pods is called **allocatable**:

<figure class="sketch "><svg viewBox="0 0 760 220" role="img" aria-label="Node capacity split into reservations and allocatable"><title>Node capacity split into reservations and allocatable</title><defs><clipPath id="cal1"><rect x="20" y="60" width="125" height="70"/></clipPath><clipPath id="cal2"><rect x="145" y="60" width="125" height="70"/></clipPath><clipPath id="cal3"><rect x="270" y="60" width="125" height="70"/></clipPath><clipPath id="cal4"><rect x="395" y="60" width="345" height="70"/></clipPath></defs><text x="20" y="32" text-anchor="start" style="font-size:22px">One node's memory (capacity)</text><path class="h m" clip-path="url(#cal1)" d="M-41.8 132.2Q-8.7 96.4 19.8 58.1M-32.7 130.9Q-3.1 94.0 27.3 58.5M-24.8 132.7Q6.9 94.9 37.3 58.4M-14.8 132.2Q17.2 96.4 46.7 57.6M-6.5 132.3Q24.2 95.0 53.8 57.2M1.3 130.9Q33.4 95.4 62.6 58.2M11.5 132.7Q41.8 94.4 72.9 57.4M19.5 132.1Q51.6 96.0 82.0 58.2M29.9 130.9Q60.0 93.8 91.7 58.4M41.2 132.6Q71.8 95.8 100.5 59.1M48.0 133.0Q77.9 94.2 110.7 57.3M57.7 131.4Q87.2 95.1 117.6 59.0M66.8 132.5Q96.2 94.9 126.5 58.5M75.3 132.7Q106.1 95.1 136.5 58.1M85.3 132.8Q114.6 93.9 145.4 59.1M93.5 131.9Q124.0 94.9 154.1 58.5M102.2 131.3Q131.7 94.4 162.6 57.2M110.2 132.5Q140.0 95.0 171.2 58.1M120.2 132.9Q149.5 94.1 180.1 58.7M128.3 131.5Q159.2 95.1 190.6 57.6M137.5 131.4Q167.9 94.8 197.7 57.0"/><path class="s m2" d="M18.8 59.9Q83.0 58.8 143.8 60.2M21.1 59.2Q83.0 59.4 146.5 60.4"/><path class="s m2" d="M144.6 58.9Q147.6 94.7 146.1 128.7M144.3 58.7Q143.7 95.2 146.3 130.5"/><path class="s m2" d="M144.0 128.5Q83.1 132.2 20.4 128.8M145.2 130.9Q82.5 129.1 21.0 130.3"/><path class="s m2" d="M18.7 131.1Q20.2 94.5 19.1 59.8M21.1 129.8Q19.3 95.0 19.6 60.5"/><text x="82.5" y="160" text-anchor="middle" style="font-size:18px">systemReserved</text><path class="h m" clip-path="url(#cal2)" d="M85.1 133.2Q115.7 95.4 146.2 57.1M92.7 132.5Q124.5 95.2 154.4 58.1M101.2 132.8Q131.1 94.6 162.4 57.8M109.0 132.8Q139.9 94.5 170.9 59.1M119.9 133.2Q149.6 95.4 180.1 57.8M126.0 130.9Q158.4 95.7 187.6 59.1M135.7 132.2Q167.7 95.3 196.3 58.2M145.5 131.1Q175.7 94.7 206.7 57.5M154.0 131.6Q186.0 95.6 216.8 57.4M162.8 133.1Q193.8 95.3 223.0 58.7M173.6 132.4Q203.8 96.2 232.4 59.0M181.4 132.7Q212.0 93.6 243.8 59.1M192.9 132.4Q221.9 95.1 253.4 57.3M200.4 131.3Q231.9 95.9 261.0 58.4M210.1 132.2Q240.8 96.5 270.5 58.7M218.9 132.0Q248.4 94.0 280.5 57.8M228.7 132.8Q257.4 94.1 288.6 58.7M239.2 132.3Q267.0 94.2 298.7 58.0M248.7 132.7Q278.2 95.1 309.3 57.4M257.8 131.1Q288.4 96.2 317.7 57.7M264.3 131.4Q296.1 95.3 325.8 58.9"/><path class="s m2" d="M143.5 60.3Q207.6 57.9 271.6 60.9M145.4 60.8Q207.1 61.3 269.8 58.6"/><path class="s m2" d="M269.9 60.9Q267.6 95.3 269.5 128.7M269.7 60.5Q270.3 95.4 269.6 130.7"/><path class="s m2" d="M268.5 131.1Q208.0 132.2 145.9 130.6M270.4 131.5Q207.8 132.4 146.4 130.4"/><path class="s m2" d="M145.1 130.1Q146.6 94.7 146.4 60.4M144.7 130.8Q145.7 95.6 145.3 59.7"/><text x="207.5" y="160" text-anchor="middle" style="font-size:18px">kubeReserved</text><path class="h r" clip-path="url(#cal3)" d="M208.8 131.5Q238.8 94.1 269.0 58.0M218.7 131.5Q249.8 96.2 277.8 58.3M225.7 131.0Q258.1 96.6 287.5 58.5M236.0 133.2Q267.0 96.2 294.8 58.6M244.5 132.8Q275.3 95.6 304.1 57.7M252.0 131.1Q283.9 95.3 313.6 58.9M261.8 132.6Q291.1 93.9 322.4 58.6M271.5 131.5Q302.6 96.2 331.8 58.7M280.6 132.3Q311.9 95.9 340.2 57.9M289.3 132.9Q321.9 96.0 351.1 57.3M299.2 132.2Q329.6 95.5 359.5 58.7M306.3 132.7Q336.7 95.2 366.4 57.3M316.2 131.2Q344.1 94.2 376.9 57.3M322.8 131.2Q354.4 95.0 383.9 59.0M330.6 131.7Q362.1 95.3 393.3 56.9M339.7 132.9Q370.6 94.7 401.0 58.7M348.3 131.1Q377.9 93.6 408.8 58.8M356.9 130.9Q388.4 95.3 419.2 56.8M366.8 131.6Q398.1 94.8 428.0 56.9M377.3 132.8Q408.3 96.3 438.1 58.0M384.2 133.1Q416.3 95.9 445.8 57.5M393.2 132.9Q423.6 94.7 454.9 58.2"/><path class="s r" d="M270.0 59.1Q332.1 61.5 394.8 58.8M269.3 59.6Q332.6 57.3 393.7 61.0"/><path class="s r" d="M394.0 60.7Q392.5 95.4 393.6 130.8M394.5 61.2Q392.6 94.6 395.9 128.9"/><path class="s r" d="M396.5 128.9Q332.8 128.5 270.7 128.5M394.1 129.5Q332.5 131.2 269.9 131.3"/><path class="s r" d="M269.0 131.0Q270.5 95.3 270.8 61.0M269.9 130.5Q269.8 94.5 271.4 61.3"/><text x="332.5" y="160" text-anchor="middle" style="font-size:18px">evictionHard</text><path class="h a" clip-path="url(#cal4)" d="M335.3 132.4Q364.3 94.9 394.6 58.9M340.5 131.3Q370.8 95.5 400.2 56.9M347.8 131.3Q378.8 95.4 408.6 57.6M354.5 133.1Q385.1 95.3 414.3 57.5M360.1 132.5Q390.7 94.9 421.6 58.2M367.6 132.7Q398.3 95.4 429.0 57.8M376.3 131.0Q404.9 93.9 437.3 57.0M383.6 132.5Q412.8 95.2 443.0 59.0M390.1 132.6Q420.8 95.6 450.9 57.2M397.0 131.1Q426.1 94.2 456.9 56.8M405.0 132.6Q434.2 95.7 465.4 58.5M410.2 132.2Q439.4 94.0 470.4 58.6M417.2 132.0Q445.8 94.2 477.8 58.9M423.5 132.9Q454.1 94.3 485.0 57.6M431.8 132.4Q462.7 95.4 493.0 58.0M438.5 132.3Q470.0 95.6 499.6 59.2M446.1 131.4Q477.5 95.6 506.4 57.9M453.3 132.1Q483.4 95.2 514.0 58.9M460.4 132.4Q491.5 95.3 521.3 57.0M466.8 131.9Q495.7 93.8 527.2 57.4M474.6 130.9Q503.5 94.5 533.6 57.9M482.2 132.8Q512.4 95.8 543.4 56.9M487.1 133.1Q519.3 96.1 549.3 57.8M496.5 131.2Q526.3 94.8 556.2 57.0M501.4 130.8Q531.2 94.5 562.6 57.5M509.3 133.1Q538.7 94.7 568.5 58.4M514.9 131.9Q545.2 94.2 575.2 57.4M523.0 132.8Q554.5 96.1 583.8 58.9M529.9 132.7Q561.5 95.8 592.0 57.1M536.1 131.5Q566.2 93.8 597.8 59.0M544.2 131.4Q575.5 95.5 604.1 57.5M552.9 130.9Q581.4 93.6 613.2 58.5M560.2 132.8Q589.0 93.7 621.0 58.9M565.7 132.9Q596.7 95.4 626.4 58.1M571.8 133.2Q601.6 93.8 633.5 57.2M578.6 133.1Q609.7 94.7 640.3 58.1M586.5 131.2Q617.4 95.9 647.0 59.2M594.0 132.6Q625.9 96.1 655.2 57.7M601.2 131.5Q632.2 95.3 663.0 57.3M609.6 130.9Q639.4 95.0 669.3 57.1M616.5 131.2Q646.4 94.4 677.2 58.8M623.6 132.4Q654.0 95.0 685.7 58.9M630.1 132.0Q659.3 93.8 690.8 57.6M637.2 131.1Q667.4 94.2 698.9 56.8M644.7 132.7Q675.9 95.6 705.4 58.3M651.0 132.0Q681.4 94.3 712.6 57.3M658.2 132.7Q686.6 93.5 718.8 58.3M663.9 131.5Q694.1 94.2 726.0 58.5M671.8 131.2Q701.0 94.8 731.6 59.0M677.3 131.9Q707.1 94.3 737.2 58.3M683.7 131.6Q714.6 94.9 744.2 58.3M690.5 132.2Q720.2 94.0 751.4 58.0M697.9 132.4Q730.0 95.9 758.5 57.4M704.8 131.5Q735.8 95.4 766.7 57.9M712.3 132.5Q742.8 93.8 774.8 57.1M720.4 130.8Q748.9 93.8 780.7 58.7M726.3 132.8Q757.1 96.0 787.6 58.7M734.4 132.0Q763.1 94.1 794.6 57.9M739.9 132.9Q771.6 96.1 800.6 58.1"/><path class="s a" d="M394.5 58.9Q567.9 58.4 740.0 59.3M396.3 60.8Q567.9 57.8 739.7 61.3"/><path class="s a" d="M740.6 58.7Q740.9 95.0 738.6 131.4M741.5 61.1Q742.6 95.0 739.9 130.1"/><path class="s a" d="M741.6 130.1Q567.2 128.4 396.0 130.1M741.5 131.0Q567.0 131.8 394.3 129.8"/><path class="s a" d="M395.1 128.9Q397.3 94.8 395.2 58.6M395.8 130.0Q394.6 94.4 393.9 59.7"/><text x="567.5" y="160" text-anchor="middle" style="font-size:18px">allocatable: what pods can request</text><text x="145" y="195" text-anchor="middle" class="m" style="font-size:16px">for the OS · for kubelet + runtime · safety margin</text></svg><figcaption>The scheduler only hands out the last part. kind reserves nothing, so there it is the whole node.</figcaption></figure>

**Try it yourself.** Compare the two numbers:

```bash
kubectl get node under-the-hood-worker -o jsonpath='{.status.capacity.memory}{"  capacity\n"}{.status.allocatable.memory}{"  allocatable\n"}'
```

```output
8126480Ki  capacity
8126480Ki  allocatable
```

They're equal because kind reserves nothing. On GKE or EKS you'd see several hundred MiB or more held back through three kubelet settings: `systemReserved` (for the OS), `kubeReserved` (for the kubelet and container runtime) and `evictionHard` (a safety margin, lesson 9).

The scheduler only compares **requests** with allocatable. It never looks at what's actually in use. Ask for 1 GiB more than the node has, and the pod waits forever:

```bash
ALLOC_KI=$(kubectl get node under-the-hood-worker -o jsonpath='{.status.allocatable.memory}' | tr -d 'Ki')
sed "s/__MEM__/$(( ALLOC_KI / 1024 + 1024 ))Mi/" modules/06-node-allocatable/pod.yaml | kubectl -n lab apply -f -
kubectl -n lab get pod too-big -o jsonpath='{.status.phase}: {.status.conditions[0].message}{"\n"}'
```

```output
Pending: 0/2 nodes are available: 1 Insufficient memory, 1 node(s) had untolerated taint(s). ...
```

The worker doesn't have enough allocatable memory for the *request*, and the control-plane node has a taint that keeps ordinary pods off it.

*Shortcut: `make 06-node-allocatable`.*

> [!KEY]
> The scheduler compares requests with allocatable, never with real usage.

## Lesson 9: The kubelet evicts before the kernel kills

Lesson 6 was one container hitting its own limit. What if the **node** runs low, because lots of pods use more than they asked for? The kubelet checks the node's free memory every 10 seconds or so:

```text
memory.available = node capacity - working set
working set      = memory in use - memory the kernel could easily drop (inactive file cache)
```

If `memory.available` falls below `evictionHard` (100Mi by default), the kubelet marks the node with `MemoryPressure` and **evicts** a pod: it stops it, marks it `Failed`, and doesn't restart it on this node.

<figure class="sketch "><svg viewBox="0 0 760 250" role="img" aria-label="How node-pressure eviction works"><title>How node-pressure eviction works</title><defs><clipPath id="cev1"><rect x="20" y="50" width="220" height="150"/></clipPath><clipPath id="cev2"><rect x="270" y="50" width="220" height="150"/></clipPath><clipPath id="cev3"><rect x="520" y="50" width="220" height="150"/></clipPath></defs><path class="h y" clip-path="url(#cev1)" d="M-110.9 202.0Q-45.2 125.5 19.6 47.8M-97.8 203.2Q-33.5 123.8 32.5 48.3M-85.8 201.8Q-19.8 125.3 45.5 48.2M-74.9 201.8Q-8.7 125.4 56.9 48.0M-62.0 202.3Q4.3 125.8 69.3 47.0M-49.2 201.0Q15.6 124.3 81.3 47.8M-37.0 202.9Q29.0 125.1 94.3 49.1M-22.9 200.9Q42.2 125.9 107.4 49.0M-11.9 202.5Q51.8 124.6 118.2 47.5M-1.7 200.8Q64.2 125.7 127.8 47.9M8.8 201.1Q73.2 123.8 139.3 46.9M23.2 201.4Q88.2 126.0 152.3 48.9M34.3 202.4Q100.6 125.4 165.9 46.9M46.8 201.8Q111.4 124.3 176.5 48.0M58.8 201.9Q124.8 125.1 190.0 49.2M70.2 201.4Q137.7 126.0 202.3 47.2M83.5 200.9Q148.5 124.9 213.7 49.1M94.7 201.1Q159.4 124.3 226.0 48.2M106.3 201.7Q171.3 124.4 238.7 47.3M118.7 201.5Q184.3 125.2 249.7 48.6M132.7 202.7Q197.7 126.0 262.5 47.3M142.4 202.4Q207.7 124.7 273.7 47.5M154.5 201.7Q220.3 126.1 284.7 47.7M167.8 202.7Q231.1 123.9 296.4 46.8M177.5 201.3Q245.0 126.3 308.5 48.1M191.0 201.6Q254.7 123.7 320.4 48.9M202.4 201.4Q267.5 125.3 332.6 47.9M213.3 201.1Q279.7 126.1 343.4 48.6M224.9 201.0Q291.4 125.4 357.0 47.1M239.1 201.6Q302.5 124.8 367.7 47.9"/><path class="s y" d="M18.9 48.4Q129.4 52.4 241.6 50.6M20.3 50.5Q130.3 51.4 239.4 48.7"/><path class="s y" d="M240.5 48.7Q239.1 125.3 240.5 198.7M240.1 51.2Q237.5 124.7 240.5 198.8"/><path class="s y" d="M239.6 201.0Q129.6 198.6 19.1 199.4M239.6 199.0Q129.7 200.8 19.2 198.8"/><path class="s y" d="M19.8 200.3Q20.7 124.7 21.5 51.5M19.1 199.0Q18.6 125.4 20.0 49.3"/><text x="130" y="90" text-anchor="middle" class="big" style="font-size:23px">node crosses</text><text x="130" y="116" text-anchor="middle" class="big" style="font-size:23px">the threshold</text><text x="130" y="154" text-anchor="middle" style="font-size:17px">memory.available</text><text x="130" y="176" text-anchor="middle" style="font-size:17px">< evictionHard</text><path class="h b" clip-path="url(#cev2)" d="M139.7 200.9Q204.2 124.6 269.8 47.3M151.8 202.8Q216.2 124.0 281.7 49.0M164.0 202.6Q230.3 125.6 295.1 47.4M177.5 203.0Q239.7 123.9 306.3 47.6M188.3 203.1Q254.0 124.7 318.5 48.4M200.6 203.2Q266.0 125.4 330.3 47.6M213.0 202.5Q277.4 124.3 342.8 48.0M224.2 200.8Q289.1 123.7 356.0 46.9M238.7 200.9Q302.4 124.4 367.5 49.2M249.0 201.7Q313.1 124.5 378.7 47.6M259.8 203.1Q326.5 125.5 390.2 48.5M273.4 203.1Q337.8 124.9 404.2 47.9M285.4 201.6Q350.0 125.2 414.6 48.5M295.1 200.9Q361.7 126.1 427.5 48.4M309.1 202.7Q372.7 124.0 439.1 49.2M320.1 201.8Q386.9 125.8 452.3 48.8M332.7 201.8Q397.4 124.7 462.4 48.8M344.2 203.0Q408.7 123.9 474.9 46.8M357.6 202.6Q422.7 125.7 487.0 48.7M369.4 202.6Q435.4 126.4 500.2 47.2M380.4 202.1Q445.2 123.5 511.9 46.9M393.7 201.7Q460.3 126.0 524.2 48.6M406.1 201.8Q471.2 124.9 536.2 46.9M419.0 200.9Q484.4 125.3 549.0 47.4M430.7 201.1Q496.5 125.6 561.3 48.2M443.7 202.2Q509.3 126.2 573.8 47.6M454.3 201.0Q519.3 124.4 585.5 46.8M466.8 202.9Q530.6 124.1 596.6 47.0M478.7 202.2Q544.0 124.9 609.1 47.3"/><path class="s b" d="M269.2 49.7Q380.2 50.9 489.3 50.7M269.2 49.6Q380.0 47.2 490.3 50.8"/><path class="s b" d="M488.5 49.0Q489.1 125.2 491.3 198.4M490.3 51.4Q490.9 124.9 489.0 200.5"/><path class="s b" d="M489.6 200.5Q379.6 202.0 269.6 198.7M489.2 200.6Q380.3 198.5 269.5 200.4"/><path class="s b" d="M268.5 199.2Q268.1 125.5 269.2 51.5M269.8 199.2Q270.2 124.9 270.0 49.1"/><text x="380" y="90" text-anchor="middle" class="big" style="font-size:23px">kubelet ranks</text><text x="380" y="116" text-anchor="middle" class="big" style="font-size:23px">the pods</text><text x="380" y="154" text-anchor="middle" style="font-size:17px">priority, and usage</text><text x="380" y="176" text-anchor="middle" style="font-size:17px">vs memory request</text><path class="h r" clip-path="url(#cev3)" d="M388.9 202.8Q455.2 125.3 519.8 48.0M401.0 202.2Q466.5 124.9 532.7 48.4M414.5 202.8Q479.6 125.1 543.2 47.3M424.9 201.0Q492.4 126.0 557.0 48.2M437.5 202.5Q501.9 124.4 566.5 46.9M450.9 201.8Q516.5 126.1 579.6 48.6M462.4 201.4Q526.0 124.5 592.4 49.2M474.4 201.9Q538.6 125.0 603.9 49.0M486.6 203.0Q550.5 124.3 615.3 48.8M497.7 202.5Q563.7 126.2 628.8 48.6M509.0 200.8Q574.3 124.1 641.5 47.1M522.9 201.1Q589.2 125.8 652.6 47.0M533.7 202.4Q597.7 123.5 664.5 49.2M544.3 203.0Q608.7 124.2 675.3 48.0M555.6 201.5Q623.2 125.9 687.1 48.2M570.6 202.7Q634.6 125.3 700.7 49.0M581.7 201.3Q647.6 125.7 711.5 46.9M595.0 202.3Q659.4 125.4 725.3 46.9M605.3 202.0Q669.9 123.8 735.5 47.8M618.6 203.2Q682.3 124.2 748.4 49.0M631.4 202.8Q696.8 125.9 762.1 48.5M641.4 202.0Q707.1 124.8 772.6 48.4M654.4 201.9Q719.8 125.1 785.3 47.4M667.6 202.9Q731.9 125.4 796.7 46.8M677.4 202.1Q741.7 123.9 808.5 48.0M688.8 202.1Q755.0 125.3 819.0 48.3M699.5 202.1Q766.0 125.6 830.3 48.1M711.2 201.5Q776.1 123.7 842.5 46.8M722.8 202.1Q789.2 125.3 854.9 48.0M735.7 202.0Q800.6 125.5 864.6 49.2"/><path class="s r" d="M520.8 51.6Q630.3 50.2 739.8 50.1M520.2 51.0Q630.4 47.3 739.2 50.4"/><path class="s r" d="M741.5 48.6Q741.5 124.7 740.9 201.2M740.2 48.9Q737.4 125.0 739.5 198.4"/><path class="s r" d="M741.1 200.9Q629.4 198.8 519.0 199.2M739.3 199.0Q629.9 200.2 519.2 200.5"/><path class="s r" d="M520.2 201.4Q519.3 124.9 519.4 50.3M519.6 200.6Q520.6 124.9 518.6 51.3"/><text x="630" y="90" text-anchor="middle" class="big" style="font-size:23px">a pod is</text><text x="630" y="116" text-anchor="middle" class="big" style="font-size:23px">evicted</text><text x="630" y="154" text-anchor="middle" style="font-size:17px">Failed · Evicted</text><text x="630" y="176" text-anchor="middle" style="font-size:17px">not restarted here</text><path class="s" d="M243.5 126.0Q255.6 126.6 267.0 125.7M244.9 123.8Q254.8 126.2 265.5 125.5"/><path class="s" d="M266.0 125.2Q261.5 128.4 256.1 129.9M265.9 124.7Q261.2 127.3 255.7 129.2"/><path class="s" d="M266.0 125.5Q261.4 121.5 255.5 120.0M266.8 124.7Q260.9 122.5 256.1 119.5"/><path class="s" d="M494.2 125.2Q505.6 125.3 517.0 125.3M494.7 124.3Q504.9 124.9 515.7 123.6"/><path class="s" d="M516.0 124.5Q510.9 126.6 506.2 129.8M515.9 124.4Q511.2 127.9 505.8 130.3"/><path class="s" d="M516.4 125.1Q510.9 123.2 506.5 120.4M516.1 124.4Q511.0 122.7 505.3 120.7"/><text x="380" y="235" text-anchor="middle" class="m" style="font-size:17px">BestEffort pods, and pods well above their request, are often at greatest risk</text></svg><figcaption>Before the kernel's OOM killer has to act on the whole node, the kubelet steps in and asks one pod to leave.</figcaption></figure>

**Try it yourself.** Your laptop isn't short on memory, so this module temporarily edits the kubelet's config file on the node (`/var/lib/kubelet/config.yaml`) to make "low memory" start only about 600 MiB away, and restarts the kubelet with `systemctl restart kubelet`. Let `make` do that part, because it always puts the original back:

```bash
KEEP=1 make 07-node-pressure-eviction
```

It starts a BestEffort `memory-hog` that grows to 1000 MiB, next to two small, well-behaved pods. `KEEP=1` leaves them in place so you can look:

```bash
kubectl -n lab get pods -l module=07
kubectl -n lab get pod memory-hog -o jsonpath='{.status.reason}: {.status.message}{"\n"}'
```

```output
NAME              READY   STATUS    RESTARTS   AGE
calm-burstable    1/1     Running   0          17s
calm-guaranteed   1/1     Running   0          17s
memory-hog        0/1     Error     0          17s

Evicted: The node was low on resource: memory. Threshold quantity: 7141Mi, available: 7191604Ki.
Container main was using 721996Ki, request is 0, has larger consumption of memory.
```

`request is 0` explains most of it. Roughly, the kubelet ranks pods by:

1. whether their memory use is above their request;
2. their priority (lesson 10);
3. how far above their request they are.

The hog was using about 700 MiB against a request of 0, so it came first. The calm pods were using less than they'd asked for. Treat this as a useful intuition rather than a precise formula; the [Kubernetes docs on node-pressure eviction](https://kubernetes.io/docs/concepts/scheduling-eviction/node-pressure-eviction/) have the full rules.

Notice the difference from lesson 6. A container using more than its request but less than its limit is fine as far as the kernel is concerned. It only becomes a target when the node runs short, and then it gets **Evicted** (and recreated elsewhere by its Deployment, if it has one), not OOMKilled.

| | OOM kill (lesson 6) | Eviction (this lesson) |
|---|---|---|
| Who does it | The kernel | The kubelet |
| Trigger | One container hits its own `memory.max` | The whole node gets low on memory |
| What you see | `OOMKilled`, exit code 137, container restarts | `Evicted`, pod `Failed`, not restarted here |
| Who is chosen | A process in the cgroup over its limit | Ranked by usage vs request, and priority |

> [!KEY]
> Pods using more memory than they requested, especially low-priority and BestEffort pods, are at the greatest risk of eviction.

## Lesson 10: Priority lets important pods jump the queue

A **PriorityClass** is just a name with a number. Pods refer to it by name (`priorityClassName: lab-high`), and a bigger number means more important. If an important pod can't find room, the scheduler is allowed to remove less important ones to make space. This is **preemption**.

**Try it yourself.** Create two classes:

```bash
kubectl apply -f modules/08-priority-preemption/priorityclasses.yaml
kubectl get priorityclass
```

```output
NAME                      VALUE
lab-high                  1000000
lab-low                   1000
system-cluster-critical   2000000000
system-node-critical      2000001000
```

The two `system-` classes come with every cluster, for Kubernetes' own critical pods. Next, fill the node with a low-priority pod that *requests* almost all its free CPU (it only sleeps; the scheduler only cares about the request). Check what's free with `kubectl describe node under-the-hood-worker`, under "Allocated resources", then:

```bash
CPU=9800m     # allocatable - already requested - 100m; 9800m on my 10-CPU node
sed "s/__CPU__/$CPU/" modules/08-priority-preemption/pod-low.yaml  | kubectl -n lab apply -f -
kubectl -n lab wait --for=condition=Ready pod/prio-low
sed "s/__CPU__/$CPU/" modules/08-priority-preemption/pod-high.yaml | kubectl -n lab apply -f -
sleep 10
kubectl -n lab get events --field-selector involvedObject.name=prio-low
```

```output
REASON      MESSAGE
Preempted   Preempted by pod 2cb1a068-... on node under-the-hood-worker
Killing     Stopping container main
```

`prio-high` didn't fit, so the scheduler removed `prio-low` to make room. No cgroup is involved at all; it's purely a scheduler decision. Keep the number of priority classes small. If everything is "critical", nothing is.

*Shortcut: `make 08-priority-preemption` works out the free CPU for you.*

> [!KEY]
> A higher-priority pod can push lower-priority pods off a full node.

## Lesson 11: ResourceQuota and LimitRange guard the front door

These two work at the API server, the very first checkpoint, before a pod even exists. Neither touches a cgroup.

- A **ResourceQuota** is a team budget: "this namespace may request 500m CPU in total".
- A **LimitRange** is a set of house rules: "every container gets these defaults, and nothing above 256Mi".

**Try it yourself: the budget.**

```bash
kubectl apply -f modules/09-resourcequota/quota.yaml               # 500m CPU, 256Mi memory, 3 pods
kubectl apply -f modules/09-resourcequota/pod-no-requests.yaml     # no requests at all
kubectl apply -f modules/09-resourcequota/pod-small.yaml           # 200m CPU
kubectl apply -f modules/09-resourcequota/pod-big.yaml             # 400m CPU
```

```output
... failed quota: compute: must specify limits.memory for: main; requests.cpu for: main; requests.memory for: main
pod/q-small created
... exceeded quota: compute, requested: requests.cpu=400m, used: requests.cpu=200m, limited: requests.cpu=500m
```

Once a quota counts something, every pod must declare it, or Kubernetes couldn't tell how much of the budget it uses. And 200m used plus 400m more would be 600m, over budget. `kubectl -n lab-quota describe quota compute` shows the running total.

**Try it yourself: the house rules.**

```bash
kubectl apply -f modules/10-limitrange/limitrange.yaml
kubectl apply -f modules/10-limitrange/pod-no-resources.yaml       # no resources: section
kubectl -n lab-limits wait --for=condition=Ready pod/lr-defaults
kubectl -n lab-limits get pod lr-defaults -o jsonpath='{.spec.containers[0].resources}{"\n"}'
kubectl -n lab-limits exec lr-defaults -- cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max
```

```output
{"limits":{"cpu":"200m","memory":"128Mi"},"requests":{"cpu":"100m","memory":"64Mi"}}
20000 100000
134217728
```

The LimitRange filled in the missing numbers *before the pod was saved*, and they became `cpu.max` and `memory.max` exactly like hand-written ones. A pod asking for more than the 256Mi maximum is refused: `maximum memory usage per Container is 256Mi, but limit is 512Mi`.

The two work well together: a quota demands that every pod has requests, and a LimitRange quietly provides them.

*Shortcut: `make 09-resourcequota` and `make 10-limitrange`.*

> [!KEY]
> Quotas and LimitRanges are checked when a pod is created, not while it runs.

## Lesson 12: Limits people forget, PIDs and disk

**Processes.** Every process and thread needs a PID, and a machine only has so many. A buggy program that keeps starting processes (a *fork bomb*) can use them all, and then nothing on the node can start, not even the kubelet. The cgroup **`pids`** controller caps the count. The kubelet setting `podPidsLimit` becomes `pids.max` on every pod's folder.

**Disk.** Containers write to the node's disk all the time: logs, temporary files, `emptyDir` volumes. One runaway log file can fill the disk; the node reports `DiskPressure`, and the kubelet starts evicting pods, including ones that did nothing wrong. `limits.ephemeral-storage` caps how much one pod may write.

**Try it yourself.** Setting `podPidsLimit` means editing the kubelet's config and restarting it, so let `make` do that and put it back afterwards:

```bash
KEEP=1 make 11-pids-and-ephemeral-storage
kubectl -n lab logs pid-hog | tail -3
POD_DIR=$(./scripts/pod-cgroup.sh pid-hog)
docker exec under-the-hood-worker cat "$POD_DIR/pids.max" "$POD_DIR/pids.current"
```

`pid-hog` tried to start 100 background processes, but its log stops short with `can't fork: Resource temporarily unavailable`. *Fork* is how a Linux process starts another one, and the kernel refused because the group was at its cap.

| File | Meaning |
|---|---|
| `pids.max` | The cap: `64` |
| `pids.current` | Processes and threads in the group right now. It never goes past `pids.max` |
| `pids.events` | `max N`: how many new processes were refused because of the cap |

For disk, the same command started `disk-hog`, which has a 50Mi limit and writes 100 MiB into an `emptyDir`:

```bash
kubectl -n lab get pod disk-hog -o jsonpath='{.status.reason}: {.status.message}{"\n"}'
```

The message mentions `ephemeral local storage` usage exceeding the limit. There's **no cgroup file for disk space**: the kubelet regularly adds up what each pod has written and evicts it when the total goes over. Because it's a periodic check, the write succeeds and the eviction comes a little later, up to a minute.

> [!KEY]
> Limit PIDs and disk too. Both protect the whole node, not just your pod.

## Lesson 13: Pressure tells you how long you waited

Usage tells you how *busy* something is. **Pressure** (PSI, short for *pressure stall information*) tells you how long things *waited*. Think of a shop with one till: "the till was busy all day" sounds the same whether one customer was served or fifty queued out of the door. Pressure measures the queue.

<figure class="sketch "><svg viewBox="0 0 760 240" role="img" aria-label="Pressure stall information measures waiting time"><title>Pressure stall information measures waiting time</title><defs><clipPath id="cps1"><rect x="560" y="60" width="150" height="110"/></clipPath></defs><path class="h b" clip-path="url(#cps1)" d="M464.8 171.1Q510.4 113.7 559.1 57.4M473.0 172.1Q520.9 114.3 569.4 57.8M483.7 171.3Q530.0 114.4 579.1 57.7M493.9 173.1Q540.5 114.4 590.2 57.7M502.8 172.9Q551.5 115.4 598.2 57.3M511.1 170.9Q560.0 115.7 607.0 57.6M521.7 173.2Q569.2 115.8 616.9 57.5M528.0 171.3Q577.2 115.5 625.6 58.2M538.7 173.2Q584.9 114.4 633.2 57.9M547.0 171.0Q595.9 114.9 644.7 57.1M556.3 172.0Q603.9 114.9 652.6 57.5M564.1 171.1Q613.3 114.8 661.2 58.5M576.2 171.6Q623.4 115.9 669.5 57.7M584.5 170.9Q630.0 113.8 679.5 57.3M591.9 172.5Q640.5 115.5 687.6 58.9M601.3 171.9Q648.9 115.0 695.5 57.1M610.5 171.2Q659.3 115.8 706.8 57.1M619.0 172.5Q665.8 113.9 714.9 57.4M629.0 172.9Q677.6 115.1 723.8 57.3M638.1 171.3Q685.7 115.0 733.3 57.6M647.2 172.3Q695.4 114.3 743.3 58.0M657.6 171.5Q704.5 114.0 753.2 56.8M666.6 172.2Q713.3 114.5 761.0 58.7M673.7 171.0Q722.6 115.3 769.9 57.3M682.9 172.9Q731.2 115.3 778.0 57.7M693.0 171.4Q739.9 115.0 788.3 56.9M702.8 170.9Q750.3 115.9 797.1 58.0"/><path class="s b" d="M558.5 59.7Q634.4 57.9 710.1 59.8M559.8 59.9Q634.4 58.6 709.9 60.6"/><path class="s b" d="M709.5 58.9Q708.4 115.3 708.7 171.1M709.4 59.6Q712.4 115.5 709.7 171.4"/><path class="s b" d="M710.7 169.8Q635.4 168.5 559.7 171.0M711.3 169.8Q635.5 169.1 560.2 170.9"/><path class="s b" d="M561.2 171.2Q559.3 115.1 558.8 59.6M559.7 169.4Q558.4 115.6 559.3 59.8"/><text x="635" y="122" text-anchor="middle" class="big">1 CPU</text><path class="s y" d="M42.7 89.1Q53.3 86.2 58.8 86.0Q64.3 85.8 69.6 87.0Q74.9 88.3 80.1 90.3Q85.2 92.4 88.0 96.6Q90.7 100.8 93.4 105.0Q96.0 109.2 95.4 113.9Q94.8 118.5 94.0 123.2Q93.3 127.9 89.6 131.5Q85.9 135.1 81.9 138.4Q77.8 141.7 72.3 143.0Q66.9 144.3 61.3 144.1Q55.8 143.9 50.5 142.7Q45.2 141.4 40.1 139.4Q34.9 137.4 31.7 133.5Q28.4 129.6 26.6 125.2Q24.7 120.7 24.7 116.1Q24.6 111.4 25.8 106.8Q26.9 102.2 30.3 98.4Q33.7 94.6 38.4 92.1Q43.1 89.6 48.1 87.5"/><path class="s y" d="M45.7 143.3Q36.0 137.5 32.1 133.8Q28.1 130.1 26.9 125.4Q25.6 120.6 24.7 115.7Q23.8 110.9 25.7 106.2Q27.5 101.5 30.8 97.4Q34.0 93.2 38.9 90.3Q43.7 87.3 49.5 86.2Q55.4 85.1 61.2 85.3Q67.1 85.4 72.7 87.0Q78.4 88.6 82.5 92.1Q86.6 95.6 90.0 99.5Q93.4 103.5 95.0 108.2Q96.6 113.0 95.8 117.9Q95.0 122.8 92.5 127.2Q90.1 131.7 86.3 135.5Q82.5 139.4 77.3 141.8Q72.0 144.3 66.1 144.4Q60.1 144.5 54.5 143.5Q48.9 142.6 43.5 140.8Q38.0 139.1 34.5 135.2"/><text x="60" y="121" text-anchor="middle" style="font-size:17px">waiting</text><path class="s y" d="M185.3 109.2Q185.8 118.6 184.6 123.3Q183.4 127.9 180.2 131.9Q177.1 135.9 172.1 138.3Q167.1 140.6 162.0 142.4Q156.9 144.3 151.3 144.2Q145.8 144.1 140.3 143.1Q134.9 142.1 130.5 139.3Q126.1 136.4 121.9 133.2Q117.7 130.0 116.4 125.4Q115.0 120.7 114.8 116.1Q114.5 111.4 115.5 106.7Q116.4 102.0 119.7 98.1Q123.0 94.1 127.9 91.6Q132.7 89.1 137.9 87.3Q143.1 85.6 148.7 85.2Q154.4 84.9 159.6 86.6Q164.8 88.4 169.4 91.0Q173.9 93.6 178.1 96.8Q182.2 100.0 183.4 104.7Q184.5 109.4 185.4 114.0"/><path class="s y" d="M147.2 84.9Q158.8 86.2 164.4 87.7Q170.1 89.2 174.5 92.6Q178.8 96.0 180.9 100.6Q182.9 105.2 184.9 109.9Q187.0 114.5 185.8 119.4Q184.6 124.3 181.5 128.5Q178.5 132.6 174.3 135.9Q170.0 139.1 164.8 141.1Q159.6 143.0 153.9 144.3Q148.2 145.6 142.4 144.6Q136.5 143.6 131.8 140.6Q127.0 137.7 123.4 133.9Q119.9 130.1 117.9 125.7Q115.9 121.2 115.2 116.5Q114.4 111.7 116.1 107.1Q117.9 102.5 121.3 98.7Q124.8 94.9 129.2 91.8Q133.6 88.8 139.0 86.7Q144.4 84.7 150.2 85.5Q156.0 86.3 161.6 87.6"/><text x="150" y="121" text-anchor="middle" style="font-size:17px">waiting</text><path class="s y" d="M205.0 112.4Q207.9 103.6 210.8 99.8Q213.7 95.9 217.8 92.9Q221.9 89.9 226.8 87.4Q231.7 84.8 237.4 84.6Q243.2 84.4 248.8 85.7Q254.3 87.0 259.3 89.4Q264.3 91.7 267.4 95.7Q270.5 99.8 272.5 104.1Q274.5 108.4 275.6 113.0Q276.8 117.7 275.1 122.3Q273.4 126.8 270.7 131.1Q268.0 135.3 263.1 137.9Q258.3 140.5 253.2 142.3Q248.0 144.1 242.4 144.7Q236.8 145.3 231.2 144.3Q225.5 143.3 221.2 140.2Q216.9 137.1 213.3 133.6Q209.6 130.2 207.9 125.8Q206.1 121.5 205.1 116.9Q204.0 112.4 204.9 107.6"/><path class="s y" d="M208.0 102.9Q213.3 94.2 218.1 91.3Q222.8 88.3 228.5 87.3Q234.2 86.2 240.1 85.4Q245.9 84.5 251.5 86.4Q257.0 88.2 261.6 91.3Q266.2 94.4 269.3 98.5Q272.4 102.6 273.7 107.3Q275.0 112.0 275.0 116.8Q275.0 121.6 272.7 126.1Q270.4 130.5 266.5 134.1Q262.6 137.6 257.8 140.5Q253.1 143.3 247.3 144.3Q241.5 145.3 235.5 145.0Q229.5 144.7 224.1 142.5Q218.6 140.3 214.8 136.5Q211.0 132.7 208.1 128.4Q205.1 124.1 204.7 119.2Q204.3 114.3 205.3 109.6Q206.3 104.8 209.1 100.5Q211.8 96.1 215.9 92.5"/><text x="240" y="121" text-anchor="middle" style="font-size:17px">waiting</text><path class="s y" d="M364.7 122.8Q359.8 131.2 356.5 135.0Q353.1 138.8 348.2 141.4Q343.2 143.9 337.5 144.4Q331.8 144.9 326.4 144.0Q320.9 143.1 315.6 141.7Q310.2 140.3 306.0 137.1Q301.8 134.0 298.9 129.9Q295.9 125.8 294.6 121.2Q293.4 116.5 294.3 111.9Q295.3 107.2 297.5 102.9Q299.7 98.6 303.4 94.9Q307.0 91.2 312.3 89.6Q317.6 87.9 322.9 86.7Q328.2 85.6 333.9 85.6Q339.5 85.7 344.9 87.3Q350.3 89.0 354.6 92.3Q358.9 95.6 361.0 100.0Q363.1 104.5 365.1 108.9Q367.1 113.4 365.7 118.1Q364.2 122.7 362.1 127.0"/><path class="s y" d="M349.7 140.4Q338.7 143.9 332.9 144.6Q327.1 145.3 321.2 144.4Q315.3 143.4 310.9 140.1Q306.5 136.7 302.4 133.3Q298.2 129.8 296.3 125.2Q294.4 120.5 294.6 115.7Q294.9 110.8 296.9 106.3Q298.9 101.9 301.5 97.4Q304.0 92.9 309.1 90.2Q314.2 87.6 319.9 86.3Q325.6 85.0 331.4 85.7Q337.1 86.4 343.0 87.4Q348.8 88.4 352.9 92.0Q357.1 95.5 360.2 99.7Q363.3 103.8 364.7 108.5Q366.1 113.2 365.3 118.1Q364.6 122.9 362.7 127.6Q360.8 132.4 356.2 135.6Q351.7 138.8 346.6 141.3Q341.5 143.8 335.7 144.7"/><text x="330" y="121" text-anchor="middle" style="font-size:17px">waiting</text><path class="s g" d="M452.0 102.9Q455.4 111.7 455.9 116.5Q456.4 121.3 453.9 125.6Q451.5 130.0 447.8 133.5Q444.0 137.0 439.6 140.0Q435.2 143.1 429.5 143.5Q423.9 144.0 418.4 143.9Q412.8 143.9 407.8 142.1Q402.7 140.3 397.9 137.9Q393.1 135.4 390.1 131.4Q387.2 127.3 386.0 122.8Q384.7 118.3 384.8 113.6Q384.9 109.0 387.1 104.7Q389.3 100.4 392.3 96.5Q395.4 92.5 400.1 89.8Q404.9 87.2 410.5 86.3Q416.1 85.4 421.8 85.1Q427.5 84.9 432.4 87.3Q437.3 89.8 442.0 92.2Q446.7 94.7 449.4 98.8Q452.0 102.9 453.4 107.4"/><path class="s g" d="M387.3 104.6Q393.1 96.4 397.3 93.3Q401.6 90.1 406.8 88.1Q412.0 86.0 417.8 85.2Q423.7 84.5 429.2 86.3Q434.7 88.1 439.3 90.9Q444.0 93.7 448.2 97.2Q452.4 100.6 454.3 105.3Q456.3 110.0 456.5 115.0Q456.8 120.0 453.8 124.4Q450.8 128.7 447.4 132.5Q444.1 136.4 439.5 139.3Q434.8 142.2 429.3 144.0Q423.7 145.9 417.8 145.1Q411.9 144.3 406.2 142.8Q400.6 141.2 396.7 137.5Q392.8 133.8 389.6 129.7Q386.4 125.7 385.0 120.9Q383.6 116.1 384.9 111.4Q386.2 106.6 388.4 102.1Q390.6 97.6 394.5 93.9"/><text x="420" y="121" text-anchor="middle" style="font-size:17px">running</text><path class="s" d="M463.6 115.3Q506.3 117.0 549.2 114.1M462.3 116.2Q506.5 112.8 550.6 114.7"/><path class="s" d="M549.7 115.5Q544.7 117.0 540.4 120.0M549.3 114.8Q545.1 117.5 540.8 120.3"/><path class="s" d="M549.5 114.8Q544.8 113.3 540.2 109.7M550.3 114.8Q545.2 112.0 539.8 110.8"/><text x="20" y="40" text-anchor="start" style="font-size:21px">cpu.pressure counts the time threads spend in this queue</text><text x="20" y="205" text-anchor="start" class="m" style="font-size:19px">some = at least one thread waiting · full = nobody making progress</text></svg><figcaption>PSI measures the queue, not the work. Usage says how busy you are; pressure says how much you wait.</figcaption></figure>

Every cgroup has three pressure files, `cpu.pressure`, `memory.pressure` and `io.pressure`, and the whole node has the same in `/proc/pressure/`. Each looks like this:

```text
some avg10=75.19 avg60=24.03 avg300=5.60 total=17362896
full avg10=0.15 avg60=0.07 avg300=0.01 total=209848
```

| Part | Meaning |
|---|---|
| `some` | Share of time *at least one* task was stuck waiting |
| `full` | Share of time *every* task was stuck at once: no progress at all |
| `avg10`, `avg60`, `avg300` | Averages over 10 seconds, 1 minute and 5 minutes, as percentages |
| `total` | Total waiting time since the start, in microseconds |

**Try it yourself.** `psi-cpu` runs twice as many busy loops as the node has CPUs, so its threads always outnumber the CPUs:

```bash
THREADS=$(( $(docker exec under-the-hood-worker nproc) * 2 ))
sed "s/__THREADS__/$THREADS/g" modules/12-psi/pods.yaml | kubectl -n lab apply -f -
kubectl -n lab wait --for=condition=Ready pod/psi-cpu pod/psi-memory
sleep 20
kubectl -n lab exec psi-cpu -- cat /sys/fs/cgroup/cpu.pressure
```

That's where the numbers above came from: over the last 10 seconds, at least one of the pod's threads was waiting for a CPU 75% of the time. The second pod, `psi-memory`, keeps rereading a file bigger than its memory limit, so its `memory.pressure` and `io.pressure` show time spent waiting for the kernel to free memory and for the disk.

When a pod is slow but its CPU and memory graphs look fine, check pressure. Rising `memory.pressure` is often the earliest warning you'll get before an OOM kill.

*Shortcut: `make 12-psi`.*

> [!KEY]
> Pressure measures waiting, which usage graphs can't show.

## Lesson 14: Change limits without a restart

Since Kubernetes 1.33, you can change a running pod's CPU and memory **in place**. The kubelet asks the container runtime to rewrite the cgroup files of the live container, and the program inside never notices.

<figure class="sketch anim"><svg viewBox="0 0 760 250" role="img" aria-label="In-place resize turns the cgroup dial on a running pod"><title>In-place resize turns the cgroup dial on a running pod</title><path class="s b" d="M127.6 59.3Q150.7 49.9 163.5 49.8Q176.2 49.7 188.2 54.2Q200.2 58.7 209.6 67.2Q218.9 75.8 226.2 86.1Q233.4 96.4 236.1 108.6Q238.7 120.9 238.7 133.4Q238.6 145.8 233.2 157.0Q227.8 168.2 221.3 178.9Q214.8 189.6 204.2 196.4Q193.5 203.2 181.3 205.8Q169.1 208.3 156.7 208.0Q144.3 207.8 132.2 204.3Q120.1 200.9 110.7 192.4Q101.3 183.9 93.1 174.2Q84.9 164.4 81.4 151.9Q77.9 139.5 78.8 126.7Q79.7 113.8 86.0 102.8Q92.3 91.9 99.9 82.4Q107.5 72.9 117.3 65.6Q127.2 58.3 139.0 54.8"/><path class="s b" d="M137.0 51.5Q163.3 49.7 176.2 52.2Q189.1 54.6 200.3 61.4Q211.5 68.2 218.7 78.9Q226.0 89.6 232.1 101.0Q238.2 112.3 238.1 125.2Q238.0 138.2 235.1 150.7Q232.3 163.2 224.2 173.2Q216.1 183.1 207.0 192.3Q197.8 201.5 185.4 206.4Q173.1 211.3 160.1 208.9Q147.1 206.5 134.5 203.7Q121.9 200.8 112.6 191.8Q103.4 182.7 95.6 172.6Q87.8 162.5 85.0 150.0Q82.3 137.5 81.2 124.4Q80.1 111.3 85.6 99.2Q91.0 87.1 99.4 76.8Q107.8 66.5 120.1 61.5Q132.3 56.6 144.8 52.7Q157.2 48.8 170.3 50.6"/><g class="anim-knob"><path class="s r" d="M159.3 130.7Q160.6 96.2 159.9 61.1M160.2 128.4Q160.0 95.9 160.5 60.7"/></g><ellipse class="f r" cx="160" cy="130" rx="8" ry="8"/><path class="s" d="M155.3 123.6Q157.6 122.7 158.8 122.2Q160.0 121.7 161.2 122.2Q162.4 122.6 163.5 123.1Q164.6 123.7 165.5 124.5Q166.5 125.3 167.0 126.4Q167.5 127.5 167.7 128.8Q168.0 130.0 167.8 131.2Q167.6 132.4 167.1 133.6Q166.5 134.7 165.6 135.6Q164.7 136.5 163.6 137.0Q162.5 137.5 161.2 137.7Q160.0 137.8 158.8 137.8Q157.5 137.7 156.4 137.1Q155.3 136.5 154.4 135.6Q153.5 134.7 152.9 133.7Q152.2 132.6 152.2 131.3Q152.3 130.0 152.4 128.8Q152.5 127.6 153.0 126.4Q153.5 125.3 154.5 124.5Q155.4 123.7 156.4 123.0"/><path class="s" d="M153.6 134.6Q152.5 132.3 152.1 131.0Q151.7 129.7 152.2 128.5Q152.7 127.3 153.2 126.0Q153.7 124.8 154.7 124.0Q155.7 123.1 156.9 122.6Q158.1 122.0 159.4 122.0Q160.8 121.9 162.0 122.4Q163.2 122.8 164.4 123.4Q165.5 124.1 166.4 125.1Q167.2 126.1 167.4 127.4Q167.6 128.7 167.9 130.0Q168.1 131.3 167.6 132.5Q167.2 133.8 166.3 134.7Q165.4 135.7 164.4 136.6Q163.5 137.5 162.1 137.7Q160.8 137.8 159.6 137.7Q158.3 137.5 157.1 137.1Q155.9 136.7 154.9 135.9Q153.9 135.1 153.3 134.0Q152.8 132.8 152.4 131.6"/><text x="85" y="60" text-anchor="middle" class="m" style="font-size:18px">200m</text><text x="250" y="140" text-anchor="middle" class="m" style="font-size:18px">500m</text><text x="160" y="235" text-anchor="middle" class="code">cpu.max: 20000 → 50000</text><text x="320" y="80" text-anchor="start" class="code">kubectl patch pod … --subresource resize</text><text x="320" y="125" text-anchor="start" style="font-size:20px">the kubelet turns the dial on the live container</text><text x="320" y="160" text-anchor="start" class="g" style="font-size:20px">restartCount stays 0, same container ID</text><text x="320" y="195" text-anchor="start" class="m" style="font-size:18px">(Kubernetes 1.33 and newer)</text></svg><figcaption>In-place resize: change the numbers while the process keeps running.</figcaption></figure>

**Try it yourself.**

```bash
kubectl -n lab apply -f modules/13-in-place-resize/pod.yaml       # 200m CPU, 64Mi memory
kubectl -n lab wait --for=condition=Ready pod/resize-demo
kubectl -n lab exec resize-demo -- cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max

kubectl -n lab patch pod resize-demo --subresource resize --patch \
  '{"spec":{"containers":[{"name":"main","resources":{"requests":{"cpu":"500m","memory":"128Mi"},"limits":{"cpu":"500m","memory":"128Mi"}}}]}}'

kubectl -n lab exec resize-demo -- cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max
kubectl -n lab get pod resize-demo -o jsonpath='restarts={.status.containerStatuses[0].restartCount}{"\n"}'
```

```output
20000 100000        ← before: 200m
67108864            ← before: 64 MiB
50000 100000        ← after: 500m
134217728           ← after: 128 MiB
restarts=0
```

`--subresource resize` is the separate "door" Kubernetes added for changing a running pod's resources. Same container, same process, new numbers. This was my favourite moment building the lab: it's the clearest proof that `resources:` really is just a few numbers in a few files.

*Shortcut: `make 13-in-place-resize` (needs Kubernetes 1.33 or newer).*

> [!KEY]
> Resize rewrites the cgroup files of a live container. No restart.

## Cheat sheet

| Setting | Who enforces it | How |
|---|---|---|
| `requests.cpu` | Scheduler, then kernel | Fits pods on nodes; becomes `cpu.weight` |
| `limits.cpu` | Kernel | `cpu.max` quota per 100ms, causes throttling |
| `requests.memory` | Scheduler, kubelet | Placement; ranking during eviction |
| `limits.memory` | Kernel | `memory.max`: reclaim, then OOM kill if that isn't enough |
| QoS class | Kernel, kubelet | `oom_score_adj` and eviction order |
| PriorityClass | Scheduler, kubelet | Preemption and eviction order |
| ResourceQuota, LimitRange | API server | Rejects or fills in pod specs |
| `podPidsLimit` | Kernel | `pids.max` |
| `ephemeral-storage` | Kubelet | Measures disk use and evicts |

## Make your app cgroup-aware

The kernel enforces the box, but the program inside should know how big the box is:

- **Java:** container support is on by default in JDK 10+ and 8u191+. Size the heap with `-XX:MaxRAMPercentage` rather than a fixed `-Xmx`.
- **Go:** from Go 1.25, `GOMAXPROCS` follows the cgroup CPU limit. On older versions, use `go.uber.org/automaxprocs`, or it will run one thread per host core and get throttled.
- **Node.js:** set `--max-old-space-size` below the memory limit, leaving room for buffers.

## Glossary

| Term | In one line |
|---|---|
| cgroup | A group of processes the kernel measures and limits together, shown as a folder under `/sys/fs/cgroup` |
| controller | The part of the kernel that handles one resource for cgroups: `cpu`, `memory`, `pids`, `io` |
| quota | How much CPU time a cgroup may use per period (the first number in `cpu.max`) |
| period | The length of each CPU accounting window, 100 ms by default (the second number in `cpu.max`) |
| throttling | Runnable work waiting because its cgroup used up its CPU quota for the current period |
| weight | A cgroup's relative share of CPU when groups compete (`cpu.weight`) |
| OOM kill | The kernel ending a process because memory ran out and reclaim couldn't free enough |
| eviction | The kubelet stopping a whole pod because the node is short of memory, disk or PIDs |
| pressure | Time spent waiting for CPU, memory or IO, from the `*.pressure` files |
| namespace (Linux) | A private view of part of the system, such as processes, network or cgroup paths |

## Takeaways

- **Requests** are for the scheduler, for sharing CPU fairly when it's busy, and for eviction order. Make them honest.
- **CPU limits** throttle, even on an idle node. Many teams drop them for latency-sensitive services and rely on good requests instead. Measure throttling before and after.
- **Memory limits** end in OOM kills. Setting them is a good default, because one leaky container otherwise puts the whole node at risk. For important workloads, setting memory requests equal to limits gives the most predictable behaviour, at the cost of reserving memory you may not always use. Weigh that against your workload and your nodes.
- When something looks wrong, **read the files**: `cpu.max`, `memory.max`, `cpu.stat`, `memory.events` and the pressure files tell you what the kernel is really doing.

If you made it this far, thanks for reading. Clone the [lab](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood), run `make all`, and watch it all happen. And if something doesn't behave the way I described on your machine, open an issue or ping me on LinkedIn; I'd genuinely like to know.
