---
title: "Cgroups: A Deep Dive into Resource Management in Kubernetes"
date: 2026-10-28
summary: What actually happens when you set CPU and memory requests and limits. I explain it from zero with hand-drawn sketches, plus a small lab so you can watch every step happen on your own laptop.
tags: [linux, kubernetes, cgroups]
---

On a day when nothing had shipped and traffic was flat, one of our backend services quietly started restarting itself. A few times a day, at no time we could predict, its health probes would time out. Failed liveness probes got the pods restarted, and failed readiness probes pulled them out of rotation. The services calling it saw timeouts and p99 latency spikes.

We went through the usual suspects, and every one came back clean:

* **CPU** was below 80% of the pod's request. Nowhere near saturated.
* **Memory** was flat. No OOM kills.
* **Deploys:** nothing had shipped around the time it started.
* **Traffic and log volume** looked the same as before.

Only one metric was out of place: `container_cpu_cfs_throttled_periods_total` was spiking. When the team computed the throttle ratio, some pods were being throttled in about **40% of their CPU scheduling periods**, while their CPU charts showed plenty of headroom.

Raising the pod's CPU limit from 5 to 8 cores brought throttling to almost zero. The restarts stopped and tail latency dropped sharply. No code changed.

So how can a pod be throttled on CPU while barely using its CPU? The answer is in **cgroups** and the Linux scheduler, the machinery underneath every container.

That's what this post is about. We'll start from zero, and by the end you'll be able to:

* find the exact files on a node that hold your pod's CPU and memory limits, and read them;
* explain how a pod using a fraction of its CPU can still be frozen for most of every 100 ms, and how that turns into restarts and lost capacity;
* explain why a pod can be OOM-killed while the dashboard says it had room to spare;
* set requests and limits deliberately, not out of habit.

> [!TLDR]
> - A cgroup is a folder in `/sys/fs/cgroup`. Its files are limits the kernel enforces.
> - Your `resources:` block becomes numbers in those files: requests become `cpu.weight`, limits become `cpu.max` and `memory.max`.
> - A CPU limit is a budget per 100 ms, shared by all your threads. Spend it early and the whole container waits. That's throttling, and it can happen at low average CPU.
> - A memory limit can't make you wait. At the limit the kernel reclaims cache, then OOM-kills.
> - Watch the throttle ratio, the working set and `oom_kill` counts, not average CPU and `memory.current`.

## How to read this post

The post is in six parts, and each one builds on the last:

| Part | What you'll learn |
|---|---|
| **1. Foundations** | How a Linux machine runs programs, and where the kernel keeps its settings |
| **2. cgroups by hand** | Building a cgroup yourself with `mkdir` and `echo` |
| **3. From YAML to kernel** | How Kubernetes writes those same files for every pod |
| **4. CPU** | Requests, limits, throttling, and the outage explained |
| **5. Memory** | Limits, OOM kills, and what happens when a node runs short |
| **6. In production** | The metrics to watch, the other limits, and resizing a live pod |

Every chapter starts with a question, explains it with a sketch, lets you try it, and ends with **one line to remember**. Boxes marked **Going deeper** hold the extra detail. Skip them on a first read; nothing later depends on them.

> [!TIP]
> You don't need a cloud account for any of this. The lab is [kubernetes-resources-under-the-hood](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood): Docker Desktop, kind and `make`. Every output in this post comes from running the lab on my MacBook; where yours might differ, I say so. The lab is optional, and you can read straight through.

---

## Part 1: Foundations

Before we touch Kubernetes, we need to understand the machine it runs on. Everything in this post, from CPU throttling to OOM kills to that outage, comes from a few simple ideas about how Linux works. If you already know them, skim ahead. If you don't, this is the part that makes the rest easy.

> [!NOTE]
> **On a Mac or Windows?** The folders in this part (`/proc`, `/sys`) only exist on Linux. Start a small Linux container and follow along inside it:
>
> ```bash
> docker run --rm -it --cpus=0.5 --memory=128m ubuntu bash
> ```
>
> Keep that `--cpus=0.5 --memory=128m` in mind. We'll find those exact numbers in a file before Part 1 ends.

---

### 1. What happens when you run a program?

A **program** is just a file on disk, for example `/usr/bin/python3`. It doesn't do anything until you run it.

When you run it, Linux loads it into memory and starts it. That running copy is a **process**. Run the same program twice and you get two processes. Each one gets a number, its **PID** (process ID), so the system can tell them apart.

A process can do several things at once by splitting its work into **threads**. A web server might have one thread per request, a few for background jobs and one for garbage collection. Threads are what actually run on the CPU.

That leads to the most important fact about CPUs:

> **One CPU core can run only one thread at any moment.**

A laptop with 8 cores can run 8 threads at the same instant. Yet your machine has thousands of threads, and they all seem to be running. That's because something switches between them very quickly, giving each a few milliseconds, then the next, then the next, thousands of times a second.

That "something" is the **kernel**.

#### So what is the kernel?

The kernel is the core of the operating system: the one program that controls the hardware. Your programs never touch the CPU or memory directly. They **ask the kernel**:

- *"I'd like to run."* The kernel's **scheduler** decides when, and on which core.
- *"I need 50 MB of memory."* The kernel decides whether to give it.

Since every request goes through the kernel, the kernel is the one place where limits can be enforced. When a container is "limited to half a CPU", nobody is watching it from outside. The kernel's scheduler simply stops giving it turns once it has used its share.

<figure class="sketch "><svg viewBox="0 0 760 270" role="img" aria-label="Threads take turns on a CPU core"><title>Threads take turns on a CPU core</title><defs><clipPath id="ccq1"><rect x="480" y="80" width="230" height="100"/></clipPath></defs><text x="20" y="32" text-anchor="start" style="font-size:20px">four threads want to run, but one core runs one thread at a time</text><path class="s y" d="M63.4 153.5Q52.5 147.9 46.8 145.2Q41.0 142.4 38.8 138.4Q36.6 134.4 36.2 130.2Q35.9 126.0 39.3 122.3Q42.8 118.6 47.1 115.4Q51.5 112.2 57.5 109.9Q63.5 107.7 70.4 106.3Q77.2 104.9 84.5 105.0Q91.9 105.1 99.3 105.8Q106.7 106.4 112.5 109.0Q118.3 111.6 123.4 114.7Q128.5 117.7 130.9 121.7Q133.2 125.6 132.6 129.7Q132.0 133.8 129.5 137.6Q127.0 141.3 122.9 144.7Q118.9 148.0 112.7 150.2Q106.4 152.3 99.7 154.1Q93.0 155.9 85.5 155.5Q78.1 155.2 71.1 153.9Q64.1 152.7 57.3 150.9"/><path class="s y" d="M39.4 140.4Q35.5 131.9 36.8 127.6Q38.0 123.3 41.8 119.6Q45.6 115.9 50.9 113.0Q56.3 110.0 62.9 107.9Q69.5 105.9 77.1 104.7Q84.6 103.6 92.4 104.4Q100.1 105.3 106.8 107.4Q113.5 109.5 118.4 112.7Q123.3 115.9 127.0 119.5Q130.8 123.1 131.7 127.3Q132.6 131.4 130.4 135.4Q128.2 139.4 124.5 143.0Q120.8 146.6 115.0 149.3Q109.1 152.0 102.0 153.7Q94.9 155.3 87.1 155.5Q79.3 155.8 71.8 154.7Q64.2 153.6 57.5 151.3Q50.7 149.1 46.8 145.4Q42.9 141.7 40.9 137.7Q38.9 133.7 38.6 129.5"/><text x="85" y="136" text-anchor="middle" style="font-size:17px">thread B</text><path class="s y" d="M215.3 155.5Q200.2 155.8 193.1 154.7Q185.9 153.5 179.9 151.2Q174.0 148.9 168.4 146.1Q162.8 143.3 160.3 139.5Q157.7 135.6 157.3 131.5Q156.8 127.4 158.6 123.4Q160.4 119.4 164.4 115.8Q168.3 112.3 174.9 110.3Q181.6 108.3 188.3 106.7Q195.0 105.1 202.4 104.7Q209.8 104.2 217.2 105.0Q224.6 105.9 230.8 108.2Q237.0 110.6 241.7 113.7Q246.5 116.9 248.9 120.7Q251.3 124.5 251.6 128.5Q251.9 132.5 251.0 136.6Q250.1 140.7 246.1 144.3Q242.0 147.9 235.6 150.2Q229.2 152.5 222.2 153.9Q215.2 155.3 207.8 155.3"/><path class="s y" d="M167.1 114.9Q177.3 108.5 184.5 107.0Q191.8 105.4 199.4 104.8Q207.1 104.1 214.9 104.6Q222.8 105.1 229.1 107.7Q235.4 110.3 240.7 113.4Q246.1 116.4 248.7 120.4Q251.2 124.4 252.0 128.6Q252.7 132.8 251.2 137.0Q249.7 141.2 244.7 144.5Q239.8 147.9 233.9 150.8Q228.1 153.8 220.3 154.6Q212.5 155.5 204.7 155.5Q196.9 155.5 189.4 154.3Q181.9 153.1 175.9 150.4Q169.8 147.7 165.2 144.2Q160.7 140.8 159.3 136.6Q157.9 132.4 158.9 128.3Q159.9 124.2 162.2 120.3Q164.5 116.3 170.0 113.4Q175.5 110.5 182.0 108.3"/><text x="205" y="136" text-anchor="middle" style="font-size:17px">thread C</text><path class="s y" d="M285.2 114.8Q295.4 108.6 302.3 106.8Q309.3 105.1 316.8 104.5Q324.3 103.9 331.6 104.7Q339.0 105.4 345.8 107.1Q352.6 108.8 357.7 111.7Q362.8 114.6 366.0 118.2Q369.2 121.8 371.1 125.7Q373.1 129.6 372.2 133.7Q371.3 137.7 367.5 141.2Q363.7 144.8 359.0 148.0Q354.3 151.2 347.4 152.9Q340.6 154.7 333.1 155.2Q325.7 155.7 318.1 155.6Q310.5 155.5 304.4 153.0Q298.3 150.6 292.8 147.9Q287.2 145.3 283.7 141.8Q280.1 138.3 278.3 134.3Q276.4 130.4 278.2 126.4Q279.9 122.5 282.2 118.5Q284.4 114.5 290.7 112.2"/><path class="s y" d="M279.5 138.1Q276.2 129.7 278.3 125.6Q280.5 121.5 284.3 117.9Q288.1 114.3 293.2 111.1Q298.3 107.9 305.5 106.1Q312.8 104.3 320.7 104.1Q328.6 103.9 336.4 104.7Q344.3 105.4 350.5 108.1Q356.7 110.7 361.6 114.0Q366.6 117.2 369.4 121.1Q372.1 125.1 371.7 129.3Q371.3 133.5 370.1 137.7Q368.9 141.9 363.3 144.9Q357.7 147.9 351.6 150.3Q345.4 152.7 338.3 154.6Q331.3 156.5 323.4 156.0Q315.5 155.4 308.5 153.7Q301.5 151.9 294.7 149.7Q287.9 147.6 284.7 143.6Q281.6 139.7 279.4 135.7Q277.3 131.7 278.7 127.6"/><text x="325" y="136" text-anchor="middle" style="font-size:17px">thread D</text><text x="205" y="185" text-anchor="middle" class="m" style="font-size:17px">waiting in line</text><path class="s a" d="M398.8 130.8Q435.0 128.5 470.5 130.6M398.6 131.2Q435.0 131.6 468.7 129.3"/><path class="s a" d="M470.1 129.7Q465.0 132.2 460.7 134.0M470.5 130.2Q465.6 132.7 460.3 135.0"/><path class="s a" d="M469.7 130.4Q465.2 127.4 460.5 125.4M470.1 130.5Q465.1 127.3 459.7 124.9"/><path class="h b" clip-path="url(#ccq1)" d="M393.1 181.0Q435.7 129.8 480.9 78.1M402.8 183.1Q446.8 130.4 490.4 79.1M412.0 182.6Q455.3 130.2 499.6 79.0M420.6 180.8Q463.8 130.2 508.2 78.1M429.8 182.4Q472.3 129.4 515.8 77.3M437.7 182.6Q480.3 129.7 525.0 78.2M447.0 181.5Q491.5 130.7 534.8 77.9M456.7 182.2Q499.4 130.0 542.4 77.2M465.9 181.9Q510.6 130.5 552.6 77.7M474.3 182.7Q518.4 129.7 562.9 78.4M484.9 183.0Q527.5 129.8 569.6 77.4M492.2 182.1Q537.3 131.3 578.6 76.9M501.7 180.9Q545.6 130.5 588.7 79.0M510.4 181.4Q554.5 130.3 597.4 78.7M519.1 180.8Q561.9 128.4 607.6 77.3M528.5 181.1Q573.5 130.6 617.5 78.9M538.3 182.4Q581.8 129.3 627.2 79.0M549.0 181.0Q592.3 129.2 635.0 77.0M557.3 181.7Q602.0 130.3 643.8 77.2M567.7 182.7Q612.1 130.3 655.4 77.3M575.4 182.8Q619.9 130.4 662.7 77.7M585.3 181.1Q630.1 130.4 673.4 78.5M593.4 181.9Q638.5 130.5 681.8 78.1M603.3 181.9Q646.3 130.6 688.7 77.8M613.8 181.5Q657.6 131.3 700.5 79.0M621.7 182.8Q665.1 128.9 708.4 78.3M630.9 183.2Q676.0 131.6 716.8 78.2M639.6 183.0Q683.1 130.5 726.7 78.3M649.0 181.8Q690.7 129.4 735.3 77.6M657.9 182.9Q701.2 129.6 744.4 76.9M666.9 181.5Q710.2 129.7 753.5 78.0M675.4 182.6Q719.6 130.0 761.8 77.1M684.9 183.0Q728.2 129.7 770.9 77.7M693.7 181.3Q738.2 130.9 780.5 77.0M700.8 182.6Q744.3 128.9 788.4 77.1"/><path class="s b" d="M480.2 80.8Q594.4 83.0 710.3 79.7M480.7 80.3Q595.3 79.1 711.0 79.8"/><path class="s b" d="M710.7 80.3Q710.8 130.1 708.6 181.6M708.9 78.4Q709.8 130.4 711.2 180.1"/><path class="s b" d="M711.3 178.5Q594.9 178.9 479.6 180.8M709.1 179.4Q594.6 178.9 479.0 178.7"/><path class="s b" d="M479.1 180.8Q482.3 129.9 480.2 81.2M480.9 181.5Q480.1 130.2 480.5 80.0"/><text x="595" y="118" text-anchor="middle" class="big" style="font-size:22px">CPU core</text><text x="595" y="152" text-anchor="middle" style="font-size:18px">running: thread A</text><text x="595" y="215" text-anchor="middle" class="a" style="font-size:17px">the kernel's scheduler hands out turns</text><text x="595" y="240" text-anchor="middle" class="a" style="font-size:17px">of a few milliseconds each</text></svg><figcaption>A core runs one thread at a time. The scheduler switches between them so fast that they all seem to run at once.</figcaption></figure>

> [!KEY]
> Programs run as processes, processes run as threads, and the kernel decides which thread gets each CPU core and how much memory everyone gets.

*Next question: if the kernel holds all these decisions, how do we see them?*

---

### 2. Everything in Linux is a file

This is the idea that makes the rest of the post possible.

On Linux, almost everything is shown to you **as a file**, even things that aren't files. You read it with `cat` and change it with `echo`, the same tools you'd use for a text file.

**Real files** are on disk:

```bash
cat /etc/hostname          # a normal text file
```

**Devices** are files too. Your disk is `/dev/sda`, your terminal is `/dev/tty`, and there's a special file that throws away anything you write to it:

```bash
echo "gone" > /dev/null    # writing to a "file" that's really a black hole
```

**And the kernel itself is files.** Linux has special folders that aren't stored on disk at all. When you read a file inside them, the kernel **creates the answer at that moment**. When you write to one, the kernel **changes a live setting**.

Here's the proof:

```bash
ls -l /proc/meminfo
```

```
-r--r--r-- 1 root root 0 Oct 30 11:06 /proc/meminfo
```

The size is **0 bytes**. Now read it:

```bash
head -3 /proc/meminfo
```

```
MemTotal:        8126480 kB
MemFree:         3512900 kB
MemAvailable:    6465152 kB
```

A file with zero bytes just showed you the machine's memory. Nothing was stored. The kernel worked the numbers out when you asked. Run it again and they'll be slightly different.

These special folders are called **virtual filesystems**. Two of them matter for this post: `/proc` and `/sys`.

<figure class="sketch "><svg viewBox="0 0 760 260" role="img" aria-label="Reading a kernel file asks the kernel a question"><title>Reading a kernel file asks the kernel a question</title><defs><clipPath id="cck1"><rect x="20" y="80" width="220" height="70"/></clipPath><clipPath id="cck2"><rect x="585" y="70" width="160" height="90"/></clipPath></defs><path class="h a" clip-path="url(#cck1)" d="M-40.9 152.2Q-11.1 114.5 20.0 78.0M-32.6 151.6Q-2.4 114.3 29.2 78.1M-22.3 152.9Q10.3 115.9 40.1 77.9M-11.7 152.7Q21.0 115.7 49.3 77.5M-1.6 151.0Q29.1 115.3 59.6 77.0M9.7 152.0Q38.0 114.1 70.4 77.4M19.5 150.9Q49.2 114.6 81.2 77.0M30.6 152.8Q59.5 114.3 90.6 77.5M40.0 151.0Q69.0 114.4 101.3 79.0M48.3 151.1Q79.6 114.8 110.8 77.3M60.0 152.3Q91.0 115.9 120.9 78.3M68.5 152.8Q100.7 115.9 131.1 79.2M78.2 152.2Q108.7 114.3 138.7 77.5M87.6 152.0Q118.1 114.1 148.9 78.3M97.5 152.7Q127.1 114.8 158.7 78.0M107.6 151.8Q137.7 114.5 167.4 77.3M117.9 152.7Q147.1 114.4 178.3 76.8M128.6 151.7Q159.0 115.5 189.7 78.5M137.6 151.7Q168.1 115.4 198.6 78.2M147.1 151.0Q179.0 115.7 208.5 78.0M158.4 151.1Q188.2 115.3 217.6 78.9M167.9 152.3Q197.9 113.8 228.7 78.9M178.1 152.4Q206.9 113.9 237.5 77.2M186.2 151.8Q218.2 115.8 246.7 78.5M197.2 151.6Q227.1 114.7 257.3 79.0M205.8 152.8Q237.6 115.7 267.1 77.9M215.9 150.9Q246.1 115.4 275.1 77.5M225.1 152.4Q256.0 114.8 286.7 79.0M234.9 151.5Q266.3 115.3 297.3 78.1"/><path class="s a" d="M18.5 80.2Q129.9 81.9 240.4 81.5M18.5 79.2Q129.7 79.7 240.4 81.5"/><path class="s a" d="M238.9 78.5Q241.1 115.4 239.3 150.8M240.8 80.3Q240.4 114.7 241.6 150.8"/><path class="s a" d="M238.7 148.7Q129.7 149.3 20.4 151.5M241.0 151.5Q129.7 150.0 21.4 148.8"/><path class="s a" d="M18.5 149.1Q19.1 115.6 20.1 79.5M21.3 149.6Q21.4 115.0 19.6 81.0"/><text x="130" y="112" text-anchor="middle" class="code">cat /proc/meminfo</text><text x="130" y="136" text-anchor="middle" class="m" style="font-size:16px">you ask</text><path class="s" d="M244.3 114.5Q287.0 117.4 329.5 114.1M244.4 114.4Q287.5 116.4 331.5 113.5"/><path class="s" d="M330.5 115.6Q324.7 117.1 320.2 120.5M329.4 115.0Q325.1 117.2 320.6 120.3"/><path class="s" d="M330.0 114.6Q325.2 112.6 319.6 110.0M330.3 115.0Q325.1 112.2 320.2 109.9"/><path class="s" d="M334.6 50.6Q429.6 49.5 525.5 50.3M335.1 49.8Q430.2 48.7 525.3 49.1"/><path class="s" d="M524.0 50.1Q523.2 115.2 525.3 180.3M526.0 49.8Q524.2 115.0 525.7 179.0"/><path class="s" d="M525.8 180.0Q429.6 180.3 335.0 180.4M525.4 180.5Q430.2 180.1 334.3 180.5"/><path class="s" d="M334.4 179.6Q335.1 115.3 334.1 49.5M335.5 180.0Q333.6 115.3 335.8 49.7"/><text x="430" y="80" text-anchor="middle" class="code">/proc/meminfo</text><text x="430" y="110" text-anchor="middle" class="r" style="font-size:18px">size: 0 bytes</text><text x="430" y="140" text-anchor="middle" class="m" style="font-size:16px">nothing stored here</text><path class="s" d="M529.0 116.5Q553.4 114.6 580.3 113.5M526.5 116.5Q554.2 117.3 578.7 114.2"/><path class="s" d="M580.0 114.9Q575.2 118.1 570.7 119.3M579.4 115.4Q574.9 117.5 570.7 119.9"/><path class="s" d="M580.8 115.7Q575.6 111.9 569.7 110.7M579.7 115.3Q574.6 113.4 570.9 109.7"/><path class="h b" clip-path="url(#cck2)" d="M507.8 162.7Q544.7 113.8 584.2 67.2M516.4 161.0Q555.7 115.8 593.1 68.4M525.8 162.8Q563.7 114.5 604.1 67.8M534.4 161.5Q570.9 113.6 612.3 67.3M542.4 162.8Q581.5 114.3 620.4 67.8M551.6 162.0Q591.2 114.7 631.2 69.2M562.0 160.8Q601.3 115.8 638.7 67.6M568.5 161.4Q607.0 114.1 647.1 69.0M577.9 161.8Q615.6 114.7 654.8 68.4M584.4 160.9Q624.4 114.5 663.5 67.9M594.1 161.2Q631.5 114.4 672.9 67.1M603.7 162.7Q642.4 115.1 682.4 68.3M614.0 160.9Q653.8 115.8 691.5 68.5M620.7 162.1Q660.4 114.4 699.7 67.7M631.4 161.3Q669.8 115.1 708.0 68.6M640.6 161.6Q679.0 115.4 717.6 67.9M647.7 162.1Q688.6 115.6 726.4 68.3M657.9 161.5Q697.1 115.3 737.3 68.5M667.7 161.1Q706.3 115.0 745.1 69.0M675.5 163.0Q714.1 114.0 755.4 67.2M685.1 161.3Q723.7 114.9 764.2 67.2M695.1 162.9Q734.1 116.2 772.0 67.2M702.4 162.3Q742.4 115.1 780.7 67.9M712.2 162.1Q751.6 115.6 790.2 68.9M720.6 161.7Q757.9 114.7 796.5 69.2M727.0 161.4Q767.5 115.5 806.7 68.2M737.4 163.0Q775.3 114.0 814.9 68.8"/><path class="s b" d="M583.7 70.9Q665.1 68.2 746.2 69.6M585.0 69.4Q665.4 69.4 745.6 69.4"/><path class="s b" d="M746.6 68.5Q744.6 114.7 743.9 160.6M743.7 69.2Q745.3 115.0 743.6 159.8"/><path class="s b" d="M744.6 158.5Q665.2 158.9 585.3 159.2M746.0 158.7Q664.4 159.7 586.2 158.9"/><path class="s b" d="M583.6 161.6Q586.9 115.0 586.1 69.0M583.7 161.2Q585.5 115.3 585.7 70.9"/><text x="665" y="108" text-anchor="middle" class="big" style="font-size:20px">the kernel</text><text x="665" y="136" text-anchor="middle" style="font-size:17px">works it out</text><text x="380" y="225" text-anchor="middle" class="g" style="font-size:19px">nothing on disk; the answer is made when you ask</text></svg><figcaption>Files in /proc and /sys aren't stored anywhere. Reading one asks the kernel; writing one changes a live setting.</figcaption></figure>

> [!KEY]
> On Linux, the kernel shows its information and its settings as files. Read a file to ask it something, write a file to change something.

*Next question: what's inside those two folders?*

---

### 3. `/proc`: what every process is doing right now

`/proc` is the kernel's live report on **processes**. Every running process gets its own folder, named after its PID:

```bash
ls /proc
```

```
1   8   9   buddyinfo   bus   cgroups   cmdline   config.gz   ...
```

The numbers are processes. Look inside one. `/proc/self` is a shortcut that always means "the process reading this", so you don't need to know your own PID:

```bash
cat /proc/self/comm                  # its name
grep Threads /proc/self/status       # how many threads it has
grep VmRSS  /proc/self/status        # how much memory it's using
```

```
cat
Threads:        1
VmRSS:          1544 kB
```

| File | What the kernel tells you |
|---|---|
| `/proc/<pid>/comm` | The process's name |
| `/proc/<pid>/status` | Its state, thread count, memory use |
| `/proc/<pid>/task/` | One folder per **thread** |
| `/proc/<pid>/cgroup` | **Which cgroup it belongs to** (remember this one) |
| `/proc/cpuinfo` | The machine's CPUs |
| `/proc/meminfo` | The machine's memory |

Tools like `ps`, `top` and `free` don't have secret access. They read these files and format them nicely.

Try the one that matters most for this post:

```bash
cat /proc/self/cgroup
```

```
0::/
```

Every process belongs to a **cgroup**, and this file says which one. Inside our container it's simply `/`. We'll see why in chapter 7. For now, note that the kernel tracks it for every process.

> [!KEY]
> `/proc` is a live report on every process, one folder per PID, and it includes which cgroup each process lives in.

*Next question: `/proc` tells us what's happening. Where are the settings?*

---

### 4. `/sys`: the kernel's settings panel

If `/proc` is mainly about **processes**, `/sys` is about **the kernel's own components and settings**: CPUs, disks, network cards, and the systems that manage them.

Its files are kept very simple: **usually one value per file.** That makes them easy to read and easy to change.

```bash
ls /sys
```

```
block  bus  class  dev  devices  firmware  fs  kernel  module
```

Some examples:

```bash
ls /sys/class/net                         # your network interfaces
cat /sys/class/net/eth0/address           # one interface's MAC address
cat /sys/devices/system/cpu/online        # which CPUs are online: 0-9 on my machine
```

For this post we only need one folder in `/sys`: **`/sys/fs`**, where the kernel keeps settings related to filesystems. Inside it is the folder this whole post is about:

```bash
ls /sys/fs
```

```
9p  bpf  btrfs  cgroup  erofs  ext4  f2fs  fuse  nfs  pstore  virtiofs  xfs
```

#### `/sys/fs/cgroup`: where resource limits live

`/sys/fs/cgroup` is the kernel's **resource control panel**. Every limit on CPU, memory or number of processes, for every container on the machine, is a file somewhere under this folder.

You can check what kind of filesystem it is:

```bash
mount | grep cgroup
```

```
cgroup on /sys/fs/cgroup type cgroup2 (ro,nosuid,nodev,noexec,relatime)
```

`type cgroup2` means **cgroups version 2**, the current version and the only one this post uses. (Older systems used version 1, which spread the same settings across several folders. If you see `tmpfs` here instead, you're on v1.)

<figure class="sketch "><svg viewBox="0 0 760 330" role="img" aria-label="Where /proc and /sys sit, and where cgroups live"><title>Where /proc and /sys sit, and where cgroups live</title><defs><clipPath id="cft1"><rect x="110" y="95" width="180" height="60"/></clipPath><clipPath id="cft2"><rect x="470" y="95" width="180" height="60"/></clipPath><clipPath id="cft3"><rect x="380" y="236" width="160" height="40"/></clipPath></defs><text x="380" y="40" text-anchor="middle" class="big" style="font-size:26px">/</text><path class="s" d="M379.2 50.6Q290.2 71.3 198.9 89.5M379.4 49.7Q290.9 71.5 201.0 89.6"/><path class="s" d="M381.3 48.5Q469.5 71.3 561.3 89.5M378.6 48.7Q469.7 70.7 558.8 89.0"/><path class="h y" clip-path="url(#cft1)" d="M57.8 156.2Q83.0 124.6 108.9 93.4M68.0 156.5Q94.0 125.8 120.1 94.2M76.3 157.0Q102.4 125.9 127.0 93.4M85.7 156.1Q111.2 125.1 138.4 91.8M93.9 156.7Q121.2 125.5 146.1 93.6M103.8 155.9Q130.7 125.6 155.5 93.1M112.6 156.3Q139.9 126.2 165.6 92.5M120.6 156.4Q147.7 126.0 172.4 93.2M129.9 157.5Q157.5 125.2 181.9 93.9M138.9 156.5Q164.6 125.0 191.7 94.0M148.4 157.1Q172.6 124.6 200.7 92.7M155.9 156.9Q183.6 125.7 209.2 93.4M166.8 157.3Q191.2 123.9 219.6 92.7M174.5 157.9Q200.1 123.9 226.5 94.2M182.7 156.8Q210.4 125.3 235.5 92.0M193.3 157.7Q218.5 124.2 246.2 92.9M202.2 156.3Q228.5 125.2 253.4 92.7M209.3 155.9Q237.6 125.7 263.6 93.9M219.2 156.3Q244.0 124.9 271.8 93.5M228.0 157.3Q251.8 124.4 279.9 92.6M235.2 157.9Q261.5 124.9 288.5 93.2M244.1 157.9Q269.3 123.9 296.8 93.8M252.1 156.3Q278.8 125.5 303.6 92.3M259.9 156.1Q286.3 124.7 313.3 93.3M269.0 157.9Q295.8 124.5 321.6 92.6M278.3 157.4Q303.8 125.0 330.5 94.1M287.0 157.9Q314.4 125.9 340.2 93.2"/><path class="s y" d="M110.1 94.2Q200.2 94.1 291.5 96.3M110.4 96.3Q199.5 94.2 290.6 93.9"/><path class="s y" d="M288.9 94.5Q289.0 125.6 290.8 154.4M288.7 94.3Q290.4 125.3 289.2 155.7"/><path class="s y" d="M290.3 155.3Q200.0 153.6 110.3 155.5M288.8 156.5Q200.2 153.4 109.8 153.8"/><path class="s y" d="M110.3 155.4Q109.0 124.7 110.5 94.1M110.9 156.1Q110.8 124.4 108.9 94.6"/><text x="200" y="122" text-anchor="middle" class="code">/proc</text><text x="200" y="145" text-anchor="middle" class="m" style="font-size:15px">processes: what's happening</text><path class="h b" clip-path="url(#cft2)" d="M417.1 157.0Q442.6 124.2 469.1 92.9M427.7 158.0Q452.9 124.5 478.6 93.8M435.2 156.7Q460.6 124.4 487.8 92.4M446.5 156.2Q470.8 124.2 497.9 93.7M453.0 157.9Q480.9 125.9 505.5 92.6M462.5 156.2Q487.4 123.6 516.0 92.0M470.7 157.2Q496.4 124.5 523.6 94.1M479.7 156.7Q505.4 124.2 533.3 93.6M489.3 156.4Q513.9 123.6 540.5 92.2M496.8 157.9Q523.1 125.1 550.1 93.6M507.4 157.7Q533.3 125.7 559.6 92.7M515.4 156.6Q543.1 125.8 567.3 93.0M524.4 157.2Q549.2 124.3 576.7 92.8M531.2 156.4Q558.7 125.8 584.3 93.0M540.0 158.0Q567.0 124.5 593.5 92.2M549.8 157.8Q577.4 125.5 602.3 94.0M558.6 156.5Q584.6 124.7 611.7 93.6M568.3 157.2Q593.2 124.4 621.7 94.0M577.8 156.9Q601.9 123.6 628.4 94.1M585.7 157.3Q611.5 124.0 637.4 92.3M593.9 157.1Q621.0 126.0 645.5 92.4M603.3 157.0Q630.2 125.1 654.7 93.0M612.7 157.6Q639.1 126.2 664.3 92.9M622.6 157.6Q647.0 124.9 673.2 93.9M629.5 158.0Q656.9 125.0 682.5 93.6M638.9 157.7Q665.8 124.8 691.6 92.3M647.3 157.9Q673.8 124.8 699.2 94.2"/><path class="s b" d="M470.5 96.6Q559.8 94.1 649.3 96.6M468.5 96.4Q560.4 94.2 648.9 93.6"/><path class="s b" d="M651.4 96.0Q650.6 124.8 649.1 154.7M649.7 96.4Q648.7 125.6 648.6 154.9"/><path class="s b" d="M648.9 156.3Q559.9 156.4 470.5 154.8M651.0 153.5Q560.0 155.2 470.9 155.9"/><path class="s b" d="M468.4 156.2Q469.4 125.0 470.9 93.7M470.3 153.4Q471.3 125.4 470.7 95.4"/><text x="560" y="122" text-anchor="middle" class="code">/sys</text><text x="560" y="145" text-anchor="middle" class="m" style="font-size:15px">kernel: settings</text><path class="s" d="M529.4 158.0Q500.2 170.4 469.4 183.6M531.5 158.2Q499.8 170.1 471.5 183.5"/><text x="460" y="202" text-anchor="middle" class="code">fs</text><path class="s" d="M460.6 210.4Q459.9 221.2 459.5 230.6M459.0 211.1Q459.1 220.9 460.5 233.1"/><path class="h a" clip-path="url(#cft3)" d="M344.1 277.1Q361.5 254.9 380.2 234.2M355.1 278.1Q373.6 257.2 389.3 234.8M365.3 277.1Q381.1 256.0 398.7 233.9M374.4 277.7Q390.4 255.5 407.5 234.6M382.4 278.1Q401.4 257.4 417.9 233.1M391.6 278.6Q410.5 257.5 426.3 235.0M399.8 278.4Q416.3 254.5 435.3 234.3M410.5 278.8Q426.0 255.9 444.1 233.8M419.5 277.2Q437.2 256.6 453.1 235.2M427.0 278.7Q443.8 255.1 460.7 233.1M436.0 277.7Q453.3 256.0 471.3 232.9M445.3 277.9Q461.8 254.7 479.8 232.9M454.7 279.1Q472.3 255.3 491.2 233.1M463.9 278.4Q482.3 256.7 499.7 234.5M471.9 277.6Q488.7 255.4 507.7 233.6M482.7 278.7Q500.0 256.2 517.9 233.2M491.2 279.2Q507.9 256.4 525.3 234.2M500.8 277.3Q519.0 257.2 534.6 233.4M508.3 278.0Q526.6 255.8 544.0 234.1M517.6 277.9Q534.0 255.5 551.3 234.8M525.7 277.6Q543.7 255.6 560.6 234.9M537.5 279.1Q555.0 256.6 571.0 234.3"/><path class="s a" d="M378.9 234.9Q460.1 236.4 540.8 235.3M379.3 237.2Q460.2 236.9 541.2 237.3"/><path class="s a" d="M540.1 237.0Q538.8 255.8 539.1 276.2M538.5 237.5Q540.8 256.5 540.7 275.6"/><path class="s a" d="M539.2 275.7Q459.5 275.4 379.3 276.8M541.5 276.2Q459.4 274.0 379.6 276.4"/><path class="s a" d="M381.5 275.5Q381.2 256.4 381.4 235.2M380.7 274.9Q378.9 255.7 378.6 234.7"/><text x="460" y="262" text-anchor="middle" class="code">cgroup</text><path class="s" d="M541.8 256.0Q560.4 247.6 579.4 239.8M542.0 256.4Q561.0 248.5 580.7 239.4"/><path class="s r" d="M593.1 231.7Q595.5 233.1 596.4 234.2Q597.3 235.2 598.0 236.4Q598.7 237.6 599.0 239.0Q599.3 240.4 598.7 241.8Q598.2 243.1 597.6 244.4Q597.0 245.6 595.9 246.5Q594.8 247.3 593.6 248.0Q592.4 248.7 591.0 249.0Q589.6 249.2 588.2 248.9Q586.8 248.5 585.5 247.9Q584.2 247.2 583.4 246.0Q582.5 244.9 582.0 243.6Q581.4 242.4 581.3 241.0Q581.1 239.6 581.4 238.2Q581.7 236.9 582.4 235.6Q583.0 234.4 584.1 233.5Q585.1 232.5 586.4 232.1Q587.7 231.6 589.1 231.2Q590.4 230.8 591.8 231.3Q593.1 231.8 594.5 232.3"/><path class="s r" d="M585.3 247.7Q583.3 245.7 582.4 244.5Q581.6 243.3 581.3 241.8Q580.9 240.4 581.1 238.9Q581.2 237.5 581.9 236.1Q582.6 234.8 583.6 233.8Q584.6 232.7 585.9 232.1Q587.3 231.4 588.7 231.1Q590.2 230.8 591.6 231.2Q593.0 231.6 594.3 232.3Q595.5 233.1 596.6 234.1Q597.7 235.1 598.2 236.4Q598.7 237.8 598.9 239.3Q599.1 240.7 598.6 242.1Q598.1 243.5 597.3 244.7Q596.5 245.9 595.4 246.8Q594.3 247.7 593.0 248.3Q591.6 248.9 590.2 248.8Q588.7 248.7 587.3 248.3Q585.9 248.0 584.7 247.2Q583.4 246.5 582.5 245.2"/><text x="604" y="245" text-anchor="start" class="code" style="font-size:15px">cpu.max</text><path class="s" d="M541.3 256.4Q560.9 262.3 579.4 270.2M541.5 256.5Q561.3 262.9 579.8 269.7"/><path class="s r" d="M581.3 268.6Q581.9 265.8 582.8 264.8Q583.8 263.8 584.9 263.0Q586.1 262.2 587.3 261.6Q588.6 260.9 590.0 261.0Q591.5 261.0 592.8 261.5Q594.2 261.9 595.4 262.7Q596.6 263.5 597.4 264.7Q598.2 265.8 598.7 267.2Q599.2 268.6 599.0 270.0Q598.9 271.4 598.6 272.8Q598.3 274.2 597.4 275.4Q596.4 276.5 595.2 277.2Q594.0 278.0 592.7 278.4Q591.4 278.9 589.9 279.0Q588.5 279.1 587.2 278.6Q585.8 278.1 584.6 277.3Q583.4 276.5 582.7 275.3Q582.1 274.0 581.5 272.7Q581.0 271.4 581.1 270.0Q581.2 268.6 581.5 267.2"/><path class="s r" d="M587.5 278.6Q584.7 277.6 583.8 276.5Q582.9 275.3 582.2 274.0Q581.6 272.7 581.3 271.3Q581.1 269.9 581.4 268.5Q581.8 267.1 582.3 265.7Q582.9 264.4 584.0 263.4Q585.1 262.4 586.4 261.7Q587.7 261.0 589.2 261.1Q590.7 261.2 592.1 261.6Q593.5 261.9 594.6 262.7Q595.8 263.5 596.8 264.6Q597.8 265.6 598.4 267.0Q599.0 268.3 598.9 269.8Q598.7 271.2 598.4 272.7Q598.0 274.1 597.2 275.2Q596.3 276.4 595.2 277.4Q594.0 278.4 592.6 278.8Q591.1 279.2 589.7 278.9Q588.2 278.6 586.8 278.2Q585.4 277.8 584.4 276.7"/><text x="604" y="275" text-anchor="start" class="code" style="font-size:15px">cpu.weight</text><path class="s" d="M541.7 256.6Q560.2 278.8 580.3 299.8M542.8 255.3Q561.5 277.4 580.1 299.4"/><path class="s r" d="M581.4 303.4Q580.8 300.5 581.2 299.2Q581.5 297.8 581.9 296.4Q582.3 295.1 583.3 294.0Q584.3 293.0 585.4 292.2Q586.6 291.4 588.0 291.1Q589.5 290.9 590.9 291.1Q592.3 291.3 593.6 291.8Q594.9 292.3 596.0 293.2Q597.2 294.1 597.7 295.4Q598.3 296.7 598.8 298.1Q599.2 299.5 599.1 300.9Q598.9 302.3 598.2 303.6Q597.5 304.8 596.7 306.0Q595.9 307.2 594.6 307.9Q593.4 308.6 592.0 308.9Q590.5 309.1 589.1 308.9Q587.7 308.7 586.4 308.2Q585.1 307.7 584.0 306.8Q582.9 305.8 582.4 304.5Q581.9 303.2 581.4 301.9"/><path class="s r" d="M592.7 308.5Q589.8 309.0 588.4 308.8Q586.9 308.6 585.6 307.8Q584.4 307.1 583.3 306.0Q582.2 305.0 581.7 303.6Q581.2 302.2 581.2 300.7Q581.3 299.3 581.6 297.9Q581.9 296.5 582.6 295.2Q583.3 293.9 584.4 292.9Q585.5 291.9 587.0 291.7Q588.4 291.4 589.9 291.2Q591.3 290.9 592.7 291.4Q594.1 291.9 595.2 292.9Q596.2 293.9 597.2 295.0Q598.1 296.1 598.5 297.5Q598.8 299.0 598.8 300.4Q598.7 301.8 598.3 303.3Q597.9 304.7 596.8 305.7Q595.7 306.6 594.5 307.3Q593.2 308.1 591.9 308.6Q590.5 309.0 589.0 308.9"/><text x="604" y="305" text-anchor="start" class="code" style="font-size:15px">memory.max</text><text x="200" y="200" text-anchor="middle" class="code">/proc/&lt;pid&gt;/cgroup:</text><text x="200" y="222" text-anchor="middle" class="m" style="font-size:15px">which cgroup a process is in</text><path class="s" d="M199.3 159.3Q200.5 170.1 198.9 184.5M198.8 159.5Q199.9 170.5 198.5 184.2"/></svg><figcaption>/proc reports on processes. /sys holds the kernel's settings, and /sys/fs/cgroup is where the resource dials are.</figcaption></figure>

> [!KEY]
> `/sys` holds the kernel's settings, one value per file, and `/sys/fs/cgroup` is the part that controls how much CPU and memory each group of processes may use.

*Next question: what do those files actually say?*

---

### 5. Your first look at `cpu.max` and `cpu.weight`

Now open the panel. Inside our container:

```bash
ls /sys/fs/cgroup
```

```
cgroup.procs   cpu.max   cpu.stat   cpu.weight
memory.current   memory.max   memory.events   pids.max   ...
```

Each file is either a **dial** (a setting you can change) or a **gauge** (a reading the kernel keeps updated). The names follow one pattern: `controller.setting`. Everything starting with `cpu.` is about CPU, and everything starting with `memory.` is about memory.

Let's read the dials. Remember the container was started with `--cpus=0.5 --memory=128m`:

```bash
cat /sys/fs/cgroup/cpu.max
```

```
50000 100000
```

```bash
cat /sys/fs/cgroup/memory.max
```

```
134217728
```

**There are your Docker flags, written as kernel settings.**

**`cpu.max` = `50000 100000`.** Two numbers, both in **microseconds** (millionths of a second):

- `100000` µs = **100 ms**. This is the *period*: the kernel counts CPU use in 100 ms windows.
- `50000` µs = **50 ms**. This is the *quota*: how much CPU time the group may use in each window.

So: *"at most 50 ms of CPU in every 100 ms"*, which is half a CPU. That's `--cpus=0.5`. If there were no limit, the file would read `max 100000`.

**`memory.max` = `134217728`.** This is in **bytes**: 128 × 1024 × 1024 = 134,217,728. That's `--memory=128m`. The group may never hold more than this.

Now the other CPU file:

```bash
cat /sys/fs/cgroup/cpu.weight
```

```
100
```

**`cpu.weight`** isn't a limit. It's a **share**. When several groups want the CPU at the same time, the kernel divides it in proportion to their weights. A group with weight 200 gets about twice as much as one with weight 100. When nobody else wants the CPU, the weight does nothing. `100` is the default.

These two CPU files are the most important pair in the post:

| File | What it is | When it matters | What happens |
|---|---|---|---|
| `cpu.weight` | Your **share** when CPUs are busy | Only when groups compete | You get a bigger or smaller slice |
| `cpu.max` | Your **hard budget** per 100 ms | **Always**, even on an idle machine | Use it up and you **wait** until the next 100 ms |

Next to them are the **gauges**, files the kernel keeps updating so you can see what's happening:

```bash
cat /sys/fs/cgroup/memory.current     # memory in use right now, in bytes
cat /sys/fs/cgroup/cpu.stat           # CPU used, and how often the budget ran out
```

Finally, how does the kernel know which processes these limits apply to? There's a file for that too:

```bash
cat /sys/fs/cgroup/cgroup.procs
```

```
1
…
```

Those are the PIDs in this group: `1` is your shell, and the other is the `cat` you just ran (its number will differ on your machine). **The limits apply to every process listed here, and every thread in them, all together.** Keep that in mind, because it's the key to the outage.

> [!NOTE]
> **One file, two directions.** `cat` reads a setting. `echo` changes it, and the kernel applies the new value immediately, with no restart. Docker mounts this folder read-only inside a container (that's the `ro` in the `mount` output), so in Part 2 we'll do the writing on a lab node instead.

#### What units do these files use?

Kernel files use raw units. Keep this table nearby:

| You'll see | It means | Example |
|---|---|---|
| microseconds (`usec`) | millionths of a second | `100000` = 100 ms |
| bytes | raw bytes | `134217728` = 128 MiB |
| `Ki`, `Mi`, `Gi` (in YAML) | ×1024, ×1024², ×1024³ | `128Mi` = 134,217,728 bytes |
| millicores (`m`, in YAML) | thousandths of a CPU | `500m` = half a CPU = `50000 100000` |

> [!KEY]
> `cpu.max` is a hard CPU budget per 100 ms, `cpu.weight` is a share when CPUs are busy, `memory.max` is a byte ceiling, and `cgroup.procs` lists who they apply to.

*Next question: why does a CPU limit only make you wait, while a memory limit can kill you?*

---

### 6. Why CPU limits slow you down but memory limits kill you

The kernel can make CPU "wait" but kills for memory because the two resources behave differently.

**CPU is time.** If a group has used its budget, the kernel can tell it to wait. Its threads pause and then continue in the next window. Nothing is lost; it just takes longer. This waiting is called **throttling**.

**Memory is space.** Once a program holds memory, the kernel can't make it "wait" for less. The data is already there. If the group is full and asks for more, the kernel first tries to free memory that can safely be dropped (such as cached copies of files). If that isn't enough, the only option left is to **kill a process** to free its memory. This is an **OOM kill** (*out of memory*).

<figure class="sketch "><svg viewBox="0 0 760 300" role="img" aria-label="CPU is compressible, memory is not"><title>CPU is compressible, memory is not</title><defs><clipPath id="ccp1"><rect x="270" y="90" width="90" height="80"/></clipPath><clipPath id="ccp2"><rect x="432" y="100" width="46" height="60"/></clipPath><clipPath id="ccp3"><rect x="488" y="100" width="46" height="60"/></clipPath><clipPath id="ccp4"><rect x="544" y="100" width="46" height="60"/></clipPath><clipPath id="ccp5"><rect x="600" y="100" width="46" height="60"/></clipPath><clipPath id="ccp6"><rect x="656" y="100" width="46" height="60"/></clipPath></defs><text x="190" y="34" text-anchor="middle" class="big" style="font-size:23px">CPU: can be made to wait</text><text x="570" y="34" text-anchor="middle" class="big" style="font-size:23px">memory: can't be taken back</text><path class="s m2" d="M379.5 50.0Q380.7 164.9 379.7 278.5M379.2 51.5Q379.8 164.5 379.9 280.1"/><path class="h a" clip-path="url(#ccp1)" d="M199.8 172.1Q236.8 131.1 269.7 89.1M207.7 172.6Q242.1 129.8 276.4 88.8M216.1 172.1Q249.6 128.7 285.3 88.4M225.7 172.7Q261.5 130.8 294.9 88.4M232.1 172.1Q268.0 130.7 301.1 87.5M241.5 172.3Q275.5 129.7 310.1 88.0M251.3 172.1Q286.4 131.1 320.4 87.0M257.5 173.0Q293.4 131.0 326.1 87.4M266.5 172.7Q301.0 130.0 335.1 86.9M273.9 171.2Q308.3 130.1 344.0 87.1M280.2 170.8Q316.2 130.6 349.4 87.0M287.8 172.7Q320.9 128.9 358.1 88.1M296.9 171.6Q328.8 129.1 366.3 88.9M302.3 172.1Q336.5 128.5 372.3 89.0M312.6 171.0Q346.6 130.2 381.0 88.1M321.2 172.0Q354.7 129.6 389.0 89.1M327.4 172.2Q362.5 130.2 397.8 87.0M335.6 172.7Q371.8 130.3 404.9 86.9M343.5 172.5Q378.0 129.7 413.9 89.1M350.7 171.0Q385.6 130.2 421.0 88.9M359.4 171.8Q394.3 130.5 429.2 89.0"/><path class="s a" d="M269.4 91.5Q315.6 87.9 360.1 89.6M270.8 89.6Q315.6 88.5 359.5 91.2"/><path class="s a" d="M359.1 89.1Q358.0 129.7 361.1 171.0M359.4 90.6Q357.6 130.4 358.9 169.9"/><path class="s a" d="M360.4 171.2Q315.5 172.4 269.3 169.4M361.5 170.0Q314.9 167.8 270.0 169.4"/><path class="s a" d="M271.1 171.3Q267.7 130.5 270.3 90.3M270.6 169.6Q270.6 130.1 268.5 90.4"/><text x="315" y="136" text-anchor="middle" class="big" style="font-size:22px">CPU</text><path class="s y" d="M69.7 151.2Q62.8 153.7 59.1 153.4Q55.4 153.1 52.0 151.8Q48.5 150.5 45.4 148.4Q42.2 146.4 40.6 143.0Q39.0 139.7 37.9 136.2Q36.8 132.7 37.0 129.1Q37.2 125.4 38.2 121.9Q39.2 118.3 41.5 115.4Q43.9 112.5 46.8 110.2Q49.8 107.8 53.5 106.9Q57.2 105.9 61.0 106.0Q64.8 106.1 68.3 107.6Q71.8 109.1 74.4 111.6Q77.1 114.2 79.7 117.0Q82.2 119.8 83.0 123.5Q83.7 127.2 83.9 131.0Q84.2 134.8 82.3 138.1Q80.4 141.4 78.4 144.6Q76.4 147.8 73.4 150.1Q70.3 152.4 66.6 153.1"/><path class="s y" d="M37.2 139.2Q36.2 131.3 36.5 127.5Q36.9 123.6 38.6 120.1Q40.2 116.6 42.7 113.4Q45.1 110.3 48.8 108.9Q52.5 107.5 56.3 106.5Q60.2 105.4 63.9 106.7Q67.6 107.9 71.3 109.3Q74.9 110.8 77.5 113.8Q80.0 116.8 81.7 120.3Q83.5 123.8 83.4 127.7Q83.3 131.6 82.7 135.4Q82.1 139.2 80.4 142.8Q78.6 146.4 75.2 148.5Q71.8 150.6 68.2 151.7Q64.5 152.8 60.6 153.4Q56.8 154.0 53.2 152.4Q49.7 150.9 46.5 148.8Q43.4 146.6 40.8 143.7Q38.3 140.7 37.2 136.9Q36.2 133.2 36.1 129.2"/><path class="s y" d="M122.0 106.4Q129.4 107.7 132.8 109.5Q136.2 111.3 138.0 114.6Q139.9 118.0 141.8 121.2Q143.7 124.5 143.8 128.2Q143.9 132.0 142.8 135.6Q141.7 139.2 140.0 142.5Q138.3 145.8 135.1 147.8Q132.0 149.8 128.8 151.9Q125.6 154.0 121.8 154.0Q118.0 154.1 114.3 153.2Q110.6 152.3 107.4 150.3Q104.2 148.2 101.6 145.4Q99.0 142.7 98.1 139.0Q97.3 135.3 97.0 131.7Q96.8 128.0 97.3 124.3Q97.7 120.6 100.0 117.6Q102.2 114.6 104.7 111.8Q107.3 108.9 111.0 108.1Q114.7 107.3 118.4 106.7Q122.0 106.1 125.7 106.8"/><path class="s y" d="M140.7 140.9Q136.4 147.3 133.2 149.4Q129.9 151.6 126.3 153.1Q122.6 154.6 118.7 153.9Q114.8 153.1 111.1 151.9Q107.4 150.7 104.4 148.1Q101.4 145.6 99.6 142.1Q97.9 138.6 97.3 134.8Q96.7 131.0 97.0 127.2Q97.3 123.4 99.1 120.0Q101.0 116.7 103.2 113.5Q105.5 110.2 109.2 109.0Q112.9 107.7 116.7 107.0Q120.5 106.3 124.5 106.5Q128.4 106.7 131.9 108.7Q135.3 110.8 137.9 113.8Q140.6 116.8 142.1 120.5Q143.6 124.1 144.1 128.1Q144.7 132.0 143.3 135.8Q141.9 139.5 139.9 142.8Q137.8 146.2 134.9 148.8"/><path class="s y" d="M169.8 108.5Q176.9 106.2 180.7 106.3Q184.4 106.5 188.0 107.8Q191.5 109.0 194.6 111.2Q197.7 113.3 199.9 116.5Q202.0 119.6 202.5 123.3Q203.0 127.1 203.7 130.8Q204.4 134.6 202.4 137.9Q200.4 141.2 198.7 144.6Q197.0 148.0 193.8 150.2Q190.5 152.3 186.8 153.0Q183.0 153.7 179.3 153.7Q175.5 153.7 172.2 152.1Q168.8 150.5 165.8 148.4Q162.7 146.3 160.3 143.3Q157.9 140.4 157.4 136.7Q156.9 133.0 156.3 129.2Q155.6 125.4 157.1 121.8Q158.6 118.3 160.8 115.1Q163.1 112.0 166.3 110.0Q169.6 108.0 173.3 107.1"/><path class="s y" d="M200.6 117.6Q203.8 124.8 203.5 128.7Q203.2 132.6 202.8 136.6Q202.4 140.5 199.6 143.4Q196.9 146.3 193.8 148.5Q190.7 150.6 187.1 152.2Q183.6 153.7 179.6 154.0Q175.7 154.3 172.0 152.8Q168.3 151.3 165.1 148.9Q162.0 146.5 160.3 142.9Q158.7 139.4 157.2 135.8Q155.7 132.1 155.9 128.2Q156.0 124.2 158.0 120.7Q160.0 117.3 162.4 114.2Q164.8 111.1 168.2 109.0Q171.5 106.9 175.5 106.9Q179.4 106.8 183.2 107.1Q187.1 107.3 190.4 109.2Q193.8 111.0 196.5 113.7Q199.2 116.4 201.4 119.7Q203.7 123.0 203.5 126.9"/><path class="s g" d="M263.6 124.6Q264.4 132.1 263.5 135.9Q262.6 139.6 260.2 142.5Q257.9 145.5 255.2 148.2Q252.5 150.8 248.9 152.0Q245.4 153.3 241.7 153.5Q237.9 153.8 234.3 152.9Q230.7 152.0 227.3 150.2Q224.0 148.4 221.4 145.6Q218.8 142.8 218.1 139.0Q217.4 135.2 216.7 131.6Q216.0 127.9 216.8 124.2Q217.6 120.5 219.8 117.4Q221.9 114.3 224.9 112.0Q227.8 109.8 231.3 108.6Q234.8 107.3 238.4 107.1Q242.0 106.9 245.6 107.6Q249.2 108.4 252.4 110.2Q255.6 112.0 258.1 114.8Q260.6 117.6 261.9 121.1Q263.1 124.7 263.9 128.4"/><path class="s g" d="M256.7 111.6Q261.1 118.2 262.3 121.9Q263.5 125.7 263.9 129.6Q264.3 133.5 263.2 137.4Q262.1 141.3 259.2 144.0Q256.3 146.7 253.3 149.1Q250.3 151.6 246.6 152.4Q242.8 153.1 239.0 153.0Q235.2 152.9 231.6 151.6Q228.0 150.3 225.0 147.9Q221.9 145.6 219.6 142.4Q217.3 139.2 216.8 135.3Q216.4 131.3 216.9 127.6Q217.5 123.8 218.8 120.1Q220.1 116.5 223.0 114.0Q226.0 111.5 229.2 109.3Q232.4 107.2 236.3 106.6Q240.1 105.9 244.0 106.7Q247.8 107.4 251.5 108.9Q255.2 110.4 257.5 113.7Q259.8 116.9 261.8 120.3"/><text x="150" y="82" text-anchor="middle" class="m" style="font-size:16px">threads waiting their turn</text><text x="160" y="200" text-anchor="middle" style="font-size:18px">too many? the rest just wait</text><text x="190" y="228" text-anchor="middle" class="m" style="font-size:17px">slower, but nobody dies</text><text x="190" y="262" text-anchor="middle" class="r" style="font-size:19px">→ throttling</text><path class="s b" d="M421.0 90.1Q570.1 90.7 721.3 88.7M421.0 90.1Q569.4 88.7 720.4 88.5"/><path class="s b" d="M719.9 88.7Q719.1 130.5 719.3 170.6M721.2 89.4Q719.2 129.8 720.7 168.6"/><path class="s b" d="M719.5 168.7Q570.0 168.2 421.1 171.4M719.0 168.5Q569.5 170.5 420.2 170.6"/><path class="s b" d="M419.1 168.4Q422.2 129.5 419.8 90.7M420.8 170.8Q419.9 130.3 419.6 90.5"/><path class="h b" clip-path="url(#ccp2)" d="M379.0 160.9Q407.2 131.5 431.4 98.6M385.2 162.9Q413.0 131.0 439.3 98.2M394.1 160.9Q420.5 130.2 446.7 98.2M400.1 163.0Q427.2 130.1 452.7 98.0M408.4 163.0Q435.0 130.1 460.7 97.2M415.3 161.7Q442.8 130.7 467.2 99.0M421.7 161.9Q448.9 131.0 473.5 98.9M430.5 162.4Q455.8 130.4 481.9 97.2M435.9 162.5Q461.5 129.5 487.4 99.1M443.2 161.2Q469.0 130.8 495.8 99.0M451.1 163.1Q475.6 129.4 501.9 99.0M458.6 162.8Q484.0 130.5 509.7 98.7M466.1 163.0Q491.7 130.3 516.4 98.3M473.2 162.4Q499.7 130.3 524.6 98.1"/><path class="s b" d="M432.0 100.5Q454.7 99.4 478.3 99.4M431.7 99.8Q455.3 100.1 478.3 99.4"/><path class="s b" d="M477.6 99.1Q478.9 130.2 478.9 159.4M477.2 100.2Q478.5 129.9 478.8 160.8"/><path class="s b" d="M478.5 159.5Q454.7 160.3 433.0 159.4M477.0 160.5Q455.0 159.3 432.2 159.2"/><path class="s b" d="M432.5 159.2Q432.1 130.3 432.3 100.8M431.6 159.7Q430.8 130.4 431.2 100.4"/><path class="h b" clip-path="url(#ccp3)" d="M435.9 161.6Q462.0 130.0 488.2 99.2M444.0 162.7Q470.8 131.4 495.0 98.2M449.1 161.8Q475.3 129.9 502.9 98.3M458.2 162.8Q483.6 130.5 508.7 98.6M463.6 162.6Q489.8 130.6 515.0 97.3M470.0 162.6Q497.3 130.9 523.0 97.7M476.3 162.5Q502.7 130.4 528.0 97.0M483.2 162.5Q509.8 130.4 536.6 99.0M491.2 161.2Q517.0 129.7 542.7 97.4M496.8 161.5Q523.3 128.9 550.2 98.6M506.3 162.6Q531.3 130.3 557.7 97.2M510.7 162.1Q538.5 130.0 564.1 98.8M517.7 161.6Q543.5 129.6 570.5 98.4M525.3 163.1Q551.9 130.5 578.0 97.4M534.0 162.5Q557.4 129.0 585.1 98.5"/><path class="s b" d="M488.9 99.4Q511.0 99.6 533.6 100.3M489.0 100.5Q511.0 100.8 533.2 99.4"/><path class="s b" d="M534.8 100.3Q535.6 129.7 534.1 160.2M533.9 99.2Q534.9 129.7 533.4 160.5"/><path class="s b" d="M534.9 159.3Q511.3 159.7 488.4 160.7M534.9 160.6Q510.8 159.8 487.6 159.4"/><path class="s b" d="M488.4 159.4Q489.3 129.8 487.0 100.3M487.4 160.2Q487.4 130.2 487.4 100.2"/><path class="h b" clip-path="url(#ccp4)" d="M491.4 163.2Q518.6 130.5 544.1 99.0M499.6 162.7Q525.1 129.1 551.1 98.3M505.8 161.8Q530.6 129.9 557.7 97.2M512.2 162.8Q538.6 130.0 563.7 97.8M520.7 161.4Q547.3 130.6 571.1 98.1M526.7 161.4Q552.2 129.4 577.3 96.9M532.0 162.2Q557.8 129.6 584.0 96.9M539.8 161.8Q566.4 130.0 593.0 99.0M546.1 161.0Q571.7 129.3 599.3 97.2M555.0 162.0Q579.5 129.0 607.3 97.9M559.9 161.1Q588.3 131.1 612.7 97.5M566.1 161.6Q594.1 130.8 618.7 98.1M574.7 162.4Q601.1 130.7 626.4 98.1M581.7 161.6Q607.9 130.2 633.4 98.8M586.5 162.2Q613.3 130.2 640.6 96.9"/><path class="s b" d="M543.8 100.0Q566.9 101.6 589.1 99.4M543.0 100.1Q566.6 99.0 589.6 99.6"/><path class="s b" d="M590.5 100.0Q589.8 130.2 590.2 160.3M590.0 99.8Q591.1 130.1 589.8 159.8"/><path class="s b" d="M589.2 160.2Q567.0 161.6 544.7 160.7M589.4 160.1Q566.7 161.1 544.4 159.4"/><path class="s b" d="M544.9 160.6Q545.1 130.1 544.9 99.5M544.5 159.3Q545.1 129.6 544.5 100.5"/><path class="h b" clip-path="url(#ccp5)" d="M548.4 163.1Q574.2 130.0 601.1 97.4M554.1 161.4Q581.9 130.6 607.0 97.5M560.1 162.9Q587.1 129.7 612.0 96.9M568.3 161.7Q594.6 130.5 620.3 97.2M575.6 162.5Q601.4 129.9 628.2 98.7M581.5 162.3Q607.9 130.1 632.9 97.3M588.1 161.5Q614.8 130.3 640.7 98.4M595.1 163.1Q622.1 131.0 647.6 96.9M601.6 163.2Q627.6 129.3 655.8 97.1M609.8 161.7Q635.0 130.2 660.4 98.2M616.8 160.9Q642.7 130.3 669.3 96.9M623.7 162.5Q651.3 130.2 677.7 97.3M631.9 162.6Q656.6 129.2 682.7 98.8M637.3 161.2Q662.9 128.9 689.6 98.9M644.3 161.8Q672.4 130.6 697.5 97.6"/><path class="s b" d="M599.8 99.3Q622.9 101.3 646.8 99.1M599.4 101.0Q623.2 99.1 646.6 99.2"/><path class="s b" d="M645.0 99.3Q645.4 130.2 646.3 159.3M645.3 100.6Q647.0 129.6 645.1 161.0"/><path class="s b" d="M646.3 159.1Q623.2 160.8 600.9 159.5M646.8 159.4Q623.4 160.4 599.1 159.6"/><path class="s b" d="M599.1 160.5Q600.1 130.3 600.3 99.5M599.3 160.2Q601.4 130.2 600.1 100.6"/><path class="h b" clip-path="url(#ccp6)" d="M604.5 160.9Q628.9 129.3 655.6 97.8M610.3 162.2Q635.4 129.8 663.1 97.7M616.6 162.2Q641.8 129.4 668.6 96.9M624.0 163.1Q649.8 128.5 676.6 99.1M632.9 160.9Q658.6 130.3 683.4 98.8M637.6 162.0Q666.3 131.2 690.7 98.4M646.0 161.4Q670.6 129.1 698.4 99.1M654.1 162.0Q678.6 129.0 706.3 99.0M659.6 161.5Q687.9 130.4 712.6 97.1M668.0 161.7Q693.1 129.5 719.3 99.1M675.6 161.2Q702.5 131.0 728.1 98.3M682.5 161.6Q709.3 130.8 733.9 98.4M690.1 162.8Q715.7 130.0 740.9 97.7M696.7 161.0Q723.7 130.3 749.6 98.7"/><path class="s b" d="M655.9 99.4Q679.1 99.1 701.7 99.8M656.0 99.1Q679.2 99.1 701.6 99.4"/><path class="s b" d="M701.7 99.2Q703.6 129.9 701.4 159.5M702.7 99.8Q702.4 130.2 702.9 159.1"/><path class="s b" d="M702.6 160.1Q678.9 161.4 655.7 159.3M701.3 159.4Q679.1 161.1 655.1 160.4"/><path class="s b" d="M655.3 159.1Q657.6 130.0 655.7 99.5M655.3 160.6Q656.0 130.2 655.9 101.0"/><path class="s r" d="M751.6 140.4Q748.0 141.6 746.1 141.6Q744.3 141.7 742.5 141.3Q740.7 140.9 738.9 140.2Q737.2 139.5 736.1 137.9Q735.1 136.3 734.3 134.6Q733.4 133.0 733.4 131.1Q733.4 129.3 733.6 127.4Q733.8 125.6 734.9 124.0Q735.9 122.5 737.2 121.1Q738.4 119.6 740.2 119.1Q742.0 118.6 743.9 118.2Q745.7 117.8 747.5 118.4Q749.3 119.0 751.0 119.8Q752.7 120.7 753.8 122.2Q754.9 123.7 755.7 125.4Q756.5 127.0 756.6 128.9Q756.6 130.7 756.4 132.5Q756.1 134.4 755.3 136.1Q754.5 137.8 753.0 139.0Q751.5 140.2 749.7 140.8"/><path class="s r" d="M755.3 123.6Q756.6 127.3 756.7 129.2Q756.7 131.1 756.4 133.1Q756.2 135.0 754.9 136.5Q753.7 138.0 752.2 139.4Q750.8 140.8 748.9 141.4Q747.0 141.9 745.1 141.9Q743.1 141.8 741.3 141.1Q739.5 140.5 737.8 139.4Q736.2 138.3 735.2 136.7Q734.2 135.0 733.8 133.1Q733.4 131.2 733.4 129.3Q733.5 127.4 734.1 125.5Q734.6 123.7 736.0 122.3Q737.4 120.9 739.1 120.0Q740.8 119.2 742.7 118.7Q744.5 118.2 746.4 118.5Q748.3 118.7 750.2 119.3Q752.1 119.9 753.3 121.5Q754.5 123.0 755.6 124.7Q756.7 126.3 756.9 128.3"/><text x="570" y="82" text-anchor="middle" class="m" style="font-size:16px">memory already in use</text><text x="745" y="160" text-anchor="middle" class="r" style="font-size:16px">more?</text><text x="570" y="200" text-anchor="middle" style="font-size:18px">full? something has to go</text><text x="570" y="228" text-anchor="middle" class="m" style="font-size:17px">the only way to free it is to remove it</text><text x="570" y="262" text-anchor="middle" class="r" style="font-size:19px">→ OOM kill or eviction</text></svg><figcaption>Almost everything in this post follows from this one difference.</figcaption></figure>

That's why:

- a CPU limit that's too low makes your app **slow**,
- a memory limit that's too low makes your app **crash**.

Almost everything in the rest of this post follows from this difference.

> [!KEY]
> CPU can be delayed, so limits cause waiting (throttling). Memory can't be, so limits end in OOM kills.

*Next question: where do containers fit into all of this?*

---

### 7. So what is a container?

Now we can answer this properly. **The Linux kernel has no such thing as a "container".** No container object exists anywhere in the kernel. A container is just ordinary processes that have been given two things:

| | Answers | Example |
|---|---|---|
| **Namespaces** | What can these processes **see**? | Their own process list (so the main one is PID 1), their own network, their own hostname |
| **cgroups** | How much can these processes **use**? | `cpu.max`, `memory.max`, `pids.max` |

A **container runtime** (Docker, containerd, CRI-O) sets both up and starts your process inside them. In Kubernetes, the kubelet tells the runtime what to create, including the numbers from your `resources:` block.

<figure class="sketch "><svg viewBox="0 0 760 300" role="img" aria-label="A container is processes plus namespaces and cgroups"><title>A container is processes plus namespaces and cgroups</title><defs><clipPath id="cct1"><rect x="40" y="70" width="190" height="100"/></clipPath><clipPath id="cct2"><rect x="250" y="70" width="190" height="100"/></clipPath><clipPath id="cct3"><rect x="510" y="90" width="220" height="110"/></clipPath></defs><path class="s b" d="M21.2 40.2Q239.7 39.1 460.5 40.1M20.8 40.5Q240.3 39.6 461.0 39.8"/><path class="s b" d="M459.1 40.4Q461.2 155.2 460.3 268.8M461.0 39.2Q458.2 155.4 460.6 270.7"/><path class="s b" d="M461.2 270.5Q240.2 271.3 21.3 268.7M459.1 271.1Q240.1 270.9 21.0 269.4"/><path class="s b" d="M20.5 270.0Q18.6 154.9 19.7 38.7M19.8 270.7Q18.3 155.3 20.1 41.1"/><text x="36" y="30" text-anchor="start" style="font-size:20px">a container = ordinary Linux processes, set up by the runtime</text><path class="s" d="M81.1 210.4Q95.8 207.5 103.7 207.1Q111.5 206.7 119.2 207.4Q127.0 208.1 134.8 209.3Q142.6 210.5 148.4 213.3Q154.1 216.1 157.4 219.6Q160.8 223.2 160.7 226.9Q160.6 230.7 160.0 234.4Q159.5 238.2 154.8 241.2Q150.1 244.3 145.1 247.3Q140.1 250.4 132.4 251.8Q124.7 253.3 116.6 253.8Q108.4 254.4 100.4 253.6Q92.3 252.8 85.3 250.8Q78.4 248.9 72.2 246.4Q66.0 243.8 62.2 240.4Q58.5 236.9 58.7 233.1Q59.0 229.3 60.1 225.6Q61.3 221.9 64.7 218.5Q68.2 215.1 74.3 212.5Q80.3 209.9 87.9 208.5"/><path class="s" d="M58.9 237.7Q58.8 229.7 60.4 226.0Q61.9 222.2 65.2 218.6Q68.5 215.0 75.3 212.6Q82.0 210.2 89.3 208.2Q96.6 206.1 105.2 206.2Q113.8 206.4 122.3 206.8Q130.9 207.2 137.6 209.7Q144.3 212.2 150.4 215.0Q156.4 217.8 159.2 221.6Q162.0 225.4 162.2 229.4Q162.4 233.3 159.0 236.9Q155.6 240.5 150.7 243.6Q145.7 246.7 138.9 248.8Q132.0 250.9 124.2 252.1Q116.4 253.3 108.0 253.5Q99.6 253.8 92.1 252.0Q84.7 250.1 78.1 247.8Q71.5 245.5 66.6 242.3Q61.7 239.2 60.5 235.3Q59.4 231.5 59.9 227.7"/><text x="110" y="236" text-anchor="middle" style="font-size:18px">app</text><path class="s" d="M257.2 254.1Q241.1 253.0 232.8 252.4Q224.6 251.9 218.4 249.3Q212.2 246.7 207.4 243.7Q202.5 240.6 200.4 236.9Q198.3 233.3 198.6 229.5Q198.8 225.8 200.7 222.0Q202.7 218.3 207.8 215.3Q213.0 212.2 219.9 210.1Q226.8 207.9 235.0 207.5Q243.2 207.0 251.2 206.6Q259.2 206.2 267.3 207.2Q275.3 208.2 281.6 210.7Q287.9 213.2 292.4 216.4Q296.8 219.5 299.5 223.1Q302.1 226.7 301.0 230.4Q300.0 234.1 298.3 237.8Q296.6 241.5 291.6 244.6Q286.7 247.7 279.3 249.3Q272.0 251.0 264.5 252.4Q257.1 253.8 248.9 253.8"/><path class="s" d="M218.6 249.5Q205.9 244.0 202.3 240.4Q198.6 236.8 198.7 232.8Q198.8 228.8 200.8 225.1Q202.8 221.4 206.1 217.8Q209.3 214.1 216.2 211.7Q223.0 209.3 230.8 207.6Q238.7 206.0 247.3 205.8Q256.0 205.5 263.9 207.1Q271.8 208.6 279.0 210.6Q286.3 212.6 290.9 215.8Q295.5 219.1 299.0 222.7Q302.5 226.3 302.2 230.3Q301.9 234.2 298.3 237.8Q294.8 241.3 290.0 244.5Q285.2 247.7 278.1 249.9Q271.1 252.1 262.8 252.8Q254.5 253.5 246.3 253.1Q238.0 252.8 230.1 251.5Q222.2 250.2 216.5 247.4Q210.8 244.6 206.0 241.5"/><text x="250" y="236" text-anchor="middle" style="font-size:18px">worker</text><path class="h a" clip-path="url(#cct1)" d="M-46.1 172.5Q-1.9 120.7 40.5 66.9M-36.7 171.2Q6.4 119.1 51.4 67.3M-25.6 170.9Q17.5 120.2 62.0 67.5M-17.4 172.1Q27.9 120.5 70.5 68.5M-7.4 172.0Q37.2 119.9 80.9 68.7M3.8 171.0Q47.6 119.5 91.8 69.2M13.4 171.7Q58.5 120.9 101.0 68.9M23.3 173.0Q65.8 119.5 110.2 68.8M33.6 173.0Q78.3 121.4 121.1 69.1M41.9 173.0Q87.5 120.7 129.6 68.1M53.5 171.5Q96.6 120.1 140.9 69.0M62.2 172.4Q107.6 120.8 149.4 67.4M74.9 171.5Q116.1 119.8 160.4 68.1M85.2 171.8Q126.3 118.5 172.2 67.9M94.2 171.2Q136.3 118.7 181.2 67.0M105.8 172.5Q149.8 121.3 191.9 67.9M114.2 172.8Q158.8 121.3 201.8 69.1M124.2 171.8Q166.8 118.9 210.7 66.9M135.5 172.9Q178.0 120.7 221.6 67.7M145.5 172.0Q188.0 120.1 231.5 68.4M153.5 172.0Q197.1 119.0 240.0 68.1M162.8 172.7Q207.4 121.1 251.0 69.1M171.6 172.0Q217.3 121.1 258.7 68.1M184.8 171.7Q228.0 120.3 271.6 67.1M193.1 172.1Q238.2 120.8 279.5 67.3M202.3 171.6Q245.8 119.9 289.0 68.6M211.6 172.9Q253.9 118.8 299.7 68.8M222.0 171.4Q265.0 119.0 308.8 67.6"/><path class="s a" d="M40.8 70.5Q135.5 70.1 230.3 71.4M38.7 69.8Q135.0 70.1 229.7 68.8"/><path class="s a" d="M229.2 69.7Q227.1 119.9 231.1 171.5M229.3 69.7Q230.8 120.5 229.8 171.1"/><path class="s a" d="M230.6 170.4Q135.5 170.6 38.5 169.4M229.9 170.1Q134.9 167.7 39.9 169.7"/><path class="s a" d="M39.8 170.9Q42.5 119.9 39.2 69.9M38.6 170.5Q40.8 119.5 41.0 70.5"/><text x="135" y="108" text-anchor="middle" class="big" style="font-size:23px">namespaces</text><text x="135" y="138" text-anchor="middle" style="font-size:17px">what the processes see</text><path class="h r" clip-path="url(#cct2)" d="M163.0 171.6Q206.4 120.2 249.4 67.7M172.4 171.8Q214.8 118.5 260.2 68.5M182.8 173.2Q224.7 119.0 269.4 67.8M192.9 172.3Q234.9 118.7 279.9 67.2M202.1 172.7Q248.2 121.3 289.1 69.2M213.1 173.0Q253.9 118.4 298.4 68.9M221.6 171.4Q265.7 121.2 308.5 66.8M230.8 171.6Q274.3 120.4 317.1 66.9M242.1 172.3Q285.4 120.7 328.4 68.9M252.8 173.1Q296.4 120.6 339.4 68.0M260.9 172.6Q303.6 119.1 348.9 67.5M272.2 173.1Q315.6 120.9 358.2 68.3M283.3 171.8Q325.4 119.8 368.2 68.0M293.5 172.8Q337.5 121.1 379.8 67.5M302.8 171.4Q344.9 120.1 389.0 68.6M310.9 173.2Q355.4 120.5 398.6 67.4M322.6 171.7Q366.6 121.0 409.4 68.6M333.5 172.0Q375.6 119.4 420.1 68.2M343.1 172.6Q385.9 119.8 429.7 68.1M352.7 172.5Q396.3 119.9 439.6 67.8M361.7 171.0Q405.1 118.6 450.6 69.0M372.8 171.1Q417.4 121.2 460.0 67.1M382.4 172.1Q424.6 119.5 468.5 67.2M391.9 171.4Q435.8 120.7 478.3 67.7M403.6 172.6Q446.9 120.7 488.2 67.0M411.8 171.3Q455.9 120.9 498.0 68.9M420.7 172.4Q465.4 121.0 508.4 67.8M429.8 171.6Q474.0 119.4 518.0 68.0M439.7 173.1Q484.7 121.3 527.1 67.6"/><path class="s r" d="M251.0 68.8Q344.6 72.0 440.7 70.6M249.5 70.1Q345.3 68.5 439.7 69.2"/><path class="s r" d="M438.8 68.5Q441.9 120.6 440.1 169.2M439.4 69.7Q437.9 119.4 439.8 169.7"/><path class="s r" d="M439.1 171.0Q345.6 170.5 249.0 169.1M440.9 169.0Q345.2 171.0 251.4 169.0"/><path class="s r" d="M249.6 169.1Q252.0 119.5 249.9 70.9M249.3 171.4Q251.9 119.4 250.8 70.8"/><text x="345" y="108" text-anchor="middle" class="big" style="font-size:23px">cgroups</text><text x="345" y="138" text-anchor="middle" style="font-size:17px">how much they may use</text><path class="h y" clip-path="url(#cct3)" d="M414.6 201.1Q460.9 144.2 510.9 88.2M426.0 202.0Q474.1 145.8 521.1 88.5M435.2 201.9Q484.0 145.4 531.1 88.3M447.8 202.2Q494.1 144.5 543.5 87.4M457.3 202.2Q503.4 144.3 551.6 87.0M467.0 201.7Q515.9 145.9 563.2 88.0M478.0 201.3Q524.2 145.1 572.3 88.5M486.4 202.5Q534.4 144.6 583.3 87.0M497.5 201.3Q544.2 143.6 593.8 86.8M507.8 202.7Q556.6 146.1 603.5 87.8M516.5 201.5Q565.5 146.1 612.4 89.2M526.3 202.6Q574.8 144.8 623.0 88.9M537.6 201.3Q584.9 144.6 634.0 88.9M546.7 201.0Q594.5 143.9 643.1 86.9M555.9 201.5Q606.2 145.8 652.2 89.1M566.6 203.1Q615.5 146.3 663.1 88.3M576.4 201.8Q623.0 144.2 671.8 89.1M585.5 202.5Q635.9 145.8 681.3 88.4M596.5 202.5Q643.8 145.2 690.7 88.0M605.8 200.9Q652.8 144.5 701.0 88.0M614.7 201.2Q664.1 145.5 712.1 87.9M625.6 202.1Q672.6 144.2 722.1 88.7M635.7 201.6Q684.8 146.0 731.9 88.1M645.3 203.1Q693.7 145.3 743.2 88.4M656.7 202.5Q704.1 145.4 750.3 89.1M665.5 202.8Q712.8 144.2 762.4 88.8M675.3 200.9Q723.5 144.5 772.2 87.1M685.9 201.5Q733.2 144.4 780.7 87.9M695.9 201.6Q745.3 146.3 792.7 88.3M707.1 201.4Q753.5 144.5 802.1 88.7M716.5 201.8Q762.7 143.9 811.4 87.1M724.5 201.0Q773.3 145.0 820.4 88.2"/><path class="s y" d="M510.3 89.1Q619.8 87.9 729.1 90.8M510.4 89.6Q620.3 90.2 729.9 89.1"/><path class="s y" d="M729.6 89.2Q728.8 145.0 730.0 199.4M731.1 88.6Q730.5 145.4 730.9 199.6"/><path class="s y" d="M729.7 199.4Q619.9 202.4 510.1 200.2M728.6 200.7Q620.5 198.5 510.0 200.3"/><path class="s y" d="M509.2 201.5Q511.5 144.4 511.4 89.9M511.2 200.0Q508.4 144.8 509.3 88.6"/><text x="620" y="130" text-anchor="middle" class="big" style="font-size:22px">container runtime</text><text x="620" y="158" text-anchor="middle" class="m" style="font-size:17px">containerd, CRI-O</text><text x="620" y="182" text-anchor="middle" style="font-size:17px">creates and starts them</text><path class="s" d="M505.8 146.1Q484.8 145.6 465.5 144.8M505.1 145.4Q484.4 144.4 464.3 146.2"/><path class="s" d="M465.0 144.2Q469.8 142.0 475.0 139.7M465.3 144.4Q470.4 143.4 474.9 140.1"/><path class="s" d="M465.8 145.2Q469.6 148.6 475.2 150.1M465.7 145.7Q469.8 148.3 474.4 150.2"/><text x="620" y="240" text-anchor="middle" class="m" style="font-size:17px">the kubelet tells the runtime</text><text x="620" y="262" text-anchor="middle" class="m" style="font-size:17px">what to create</text><path class="s" d="M620.8 223.4Q621.1 214.8 619.6 204.1M618.8 223.6Q618.7 215.0 620.4 205.9"/><path class="s" d="M619.8 204.8Q622.5 210.0 625.4 214.3M619.9 204.5Q622.0 210.2 625.5 214.9"/><path class="s" d="M620.7 204.7Q618.3 210.4 614.6 214.9M620.0 205.0Q616.5 209.9 615.4 215.3"/></svg><figcaption>Namespaces decide what a container's processes can see. Cgroups decide how much they can use.</figcaption></figure>

#### Why `/sys/fs/cgroup` looked so small

Earlier, `cat /proc/self/cgroup` printed `0::/`, as if we were at the top of the tree, and `ls /sys/fs/cgroup` showed only one group's files. That's a namespace at work: the **cgroup namespace**.

On the host machine, our container's cgroup is a folder deep in the tree, something like:

```
/sys/fs/cgroup/system.slice/docker-3f9a…e1.scope/cpu.max
```

The cgroup namespace makes that folder **look like the top** from inside the container. So `/sys/fs/cgroup/cpu.max` inside the container and that long path on the host are **the same file**. The namespace only changes the view. The limit is the same.

<figure class="sketch "><svg viewBox="0 0 760 290" role="img" aria-label="A cgroup namespace shortens the paths a process sees"><title>A cgroup namespace shortens the paths a process sees</title><text x="20" y="34" text-anchor="start" style="font-size:21px">the same container cgroup, seen from two places</text><path class="s b" d="M19.9 55.4Q380.2 52.9 740.7 54.9M19.7 55.8Q379.5 54.9 740.1 55.6"/><path class="s b" d="M740.8 54.7Q739.9 105.3 739.0 155.0M740.0 55.2Q740.3 105.1 739.7 153.9"/><path class="s b" d="M739.5 155.9Q380.4 157.0 20.1 154.0M740.4 154.0Q380.1 154.0 20.3 155.7"/><path class="s b" d="M20.5 154.2Q21.4 105.0 20.8 55.7M19.2 155.3Q18.4 104.9 21.1 55.1"/><text x="36" y="82" text-anchor="start" class="m" style="font-size:17px">on the node (docker exec under-the-hood-worker …)</text><text x="36" y="110" text-anchor="start" class="code">/sys/fs/cgroup/kubelet.slice/kubelet-kubepods.slice/</text><text x="36" y="134" text-anchor="start" class="code">   …-burstable.slice/…-pod&lt;uid&gt;.slice/cri-containerd-&lt;id&gt;.scope/cpu.max</text><path class="s a" d="M21.1 190.5Q380.0 188.8 738.9 191.1M19.0 190.4Q379.6 190.0 739.2 190.7"/><path class="s a" d="M738.9 188.8Q741.5 227.4 741.0 266.1M741.0 190.9Q741.7 228.0 739.6 265.5"/><path class="s a" d="M740.8 265.9Q380.4 265.2 19.7 265.5M739.8 265.4Q379.7 267.0 20.2 264.4"/><path class="s a" d="M19.6 264.2Q20.7 227.3 19.2 190.8M21.1 264.3Q21.2 227.7 19.3 189.3"/><text x="36" y="216" text-anchor="start" class="m" style="font-size:17px">inside the container (kubectl exec &lt;pod&gt; …)</text><text x="36" y="244" text-anchor="start" class="code">/sys/fs/cgroup/cpu.max</text><path class="s" d="M599.9 156.6Q601.0 171.6 598.5 186.1M601.2 159.4Q599.7 172.5 600.3 185.2"/><path class="s" d="M599.2 186.3Q597.0 181.2 594.6 176.3M599.8 185.7Q596.9 181.1 594.8 175.5"/><path class="s" d="M599.3 185.6Q602.7 180.9 605.1 175.7M599.4 185.6Q602.4 181.3 605.2 176.1"/><text x="612" y="178" text-anchor="start" style="font-size:17px">same file</text></svg><figcaption>A cgroup namespace changes the paths a process sees; it doesn't set the resource limit.</figcaption></figure>

> [!KEY]
> A container is ordinary processes with namespaces (what they see) and cgroups (what they get). Inside one, `/sys/fs/cgroup` shows only its own cgroup.

#### Where we are

You now know enough to follow everything else:

- Programs run as **threads**, and the **kernel** hands out CPU and memory.
- Linux shows the kernel's settings as **files**: `/proc` for processes, `/sys` for settings.
- **`/sys/fs/cgroup`** holds the limits: `cpu.max`, `cpu.weight`, `memory.max`, and `cgroup.procs` for who they apply to.
- **CPU** limits cause waiting. **Memory** limits cause kills.
- A **container** is processes inside namespaces and cgroups.

So far we've only *read* these files. In Part 2 we write them.

---

## Part 2: cgroups by hand

> [!NOTE]
> **Why do cgroups exist?** Picture one machine running dozens of services from different teams, all sharing one kernel. Without a fence, one memory leak or runaway loop starves everyone else: the *noisy neighbour* problem. Engineers at Google hit this early and in 2006 started work on "process containers", renamed **control groups** and merged into Linux 2.6.24 in 2008. The cleaner **cgroups v2** became stable in Linux 4.5 (2016), and Kubernetes made it generally available in 1.25.

### Set up the lab (5 minutes)

You need Docker Desktop (give it at least 4 CPUs and 6 GB of memory), plus `kind` and `kubectl`.

```bash
brew install kind kubectl          # on Windows, use WSL2: see the repo README
git clone https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood
cd kubernetes-resources-under-the-hood
make cluster                       # a 2-node cluster inside Docker
```

On Windows, run the same commands inside an Ubuntu terminal on WSL2. The [repo README](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood) has the one extra setting WSL2 needs for cgroups v2.

**What you get.** [kind](https://kind.sigs.k8s.io/) ("Kubernetes in Docker") runs each Kubernetes node as a Docker container. `make cluster` creates a cluster called `under-the-hood` with two nodes:

- `under-the-hood-control-plane` runs the API server, the scheduler and the other control-plane parts.
- `under-the-hood-worker` is where every lab pod runs.

Because a kind node is just a Docker container, it has its own real cgroup tree and a real kubelet, the same pieces you'd find on a GKE or EKS node.

**Two ways to look inside.** You'll use these two commands all the time:

- `kubectl exec <pod> -- <command>` runs a command **inside a container**. It sees only its own cgroup (chapter 7), so `kubectl exec <pod> -- cat /sys/fs/cgroup/cpu.max` shows exactly that container's CPU limit.
- `docker exec under-the-hood-worker <command>` runs a command **on the node**. From there you see the whole tree, including the folders for pods and QoS classes. On a real cluster this is the same as SSH-ing into the node.

Every chapter has a **Try it yourself** section with the exact commands and my output, and a **Shortcut** `make` target that runs the same steps and checks the results. The targets are named after the lab's modules, so their numbers don't match this post's chapters. The full list is at the end of the post.

---

### 8. Build a cgroup by hand

*Question: if cgroups are just files, can we make one ourselves?*

Yes. If you can make a cgroup with `mkdir` and `echo`, you'll recognise everything Kubernetes does later.

Think of a cgroup as a **box with dials** on the side: *how much CPU*, *how much memory*, *how many processes*. You put processes in the box, and the kernel keeps them within the dial settings.

<figure class="sketch "><svg viewBox="0 0 760 300" role="img" aria-label="A cgroup holds processes and has files that act as dials"><title>A cgroup holds processes and has files that act as dials</title><path class="s a" d="M40.3 40.4Q205.1 38.5 368.6 38.4M41.6 39.9Q204.7 41.4 371.1 39.9"/><path class="s a" d="M371.2 40.1Q368.8 150.2 370.8 260.5M369.4 38.5Q372.6 150.1 371.2 259.9"/><path class="s a" d="M371.3 259.7Q205.5 259.2 41.0 259.8M368.8 259.1Q205.5 257.3 41.5 259.8"/><path class="s a" d="M39.6 259.5Q40.4 150.0 40.3 40.3M41.1 261.6Q42.3 150.5 40.5 38.9"/><text x="55" y="30" text-anchor="start" style="font-size:22px">a cgroup (just a folder!)</text><path class="s" d="M151.6 89.3Q161.7 95.7 164.2 99.6Q166.7 103.5 167.7 107.6Q168.6 111.7 166.2 115.5Q163.7 119.4 160.8 123.2Q157.8 127.0 151.8 129.5Q145.8 132.1 138.8 133.4Q131.7 134.8 124.4 135.0Q117.0 135.2 109.4 135.0Q101.8 134.8 95.1 132.7Q88.3 130.7 84.5 127.1Q80.6 123.5 76.6 120.0Q72.5 116.6 72.5 112.5Q72.4 108.3 74.4 104.5Q76.5 100.6 80.0 97.1Q83.6 93.6 88.7 90.6Q93.8 87.6 100.8 85.9Q107.8 84.2 115.4 84.5Q123.0 84.9 130.4 85.3Q137.9 85.6 143.8 88.1Q149.7 90.6 155.4 93.3"/><path class="s" d="M96.0 133.3Q83.2 128.1 79.6 124.2Q76.0 120.4 73.2 116.3Q70.5 112.2 72.3 108.0Q74.0 103.8 77.4 100.1Q80.8 96.4 85.3 93.0Q89.8 89.5 97.0 87.9Q104.2 86.4 111.6 85.5Q119.1 84.6 126.7 85.0Q134.4 85.4 141.5 87.1Q148.6 88.9 153.5 92.2Q158.4 95.4 161.5 99.2Q164.6 102.9 166.9 107.0Q169.2 111.1 166.7 115.2Q164.2 119.3 161.1 123.2Q158.0 127.2 151.9 130.0Q145.7 132.8 138.1 134.0Q130.4 135.1 122.7 135.5Q115.0 135.8 107.4 134.7Q99.9 133.6 93.3 131.3Q86.6 129.1 81.9 125.6"/><text x="120" y="116" text-anchor="middle" style="font-size:19px">nginx</text><path class="s" d="M214.9 110.5Q221.7 103.0 227.8 100.6Q234.0 98.1 240.9 96.6Q247.8 95.0 255.3 94.3Q262.7 93.6 269.9 94.9Q277.1 96.2 283.5 98.2Q289.9 100.1 295.8 102.8Q301.7 105.5 304.1 109.4Q306.5 113.4 307.3 117.4Q308.1 121.5 305.6 125.3Q303.2 129.1 300.1 132.7Q297.0 136.3 291.5 139.2Q286.1 142.0 279.0 143.1Q271.8 144.3 264.5 145.2Q257.3 146.2 249.9 145.3Q242.5 144.5 236.5 142.0Q230.6 139.5 224.9 136.9Q219.3 134.2 216.5 130.4Q213.7 126.6 212.6 122.6Q211.5 118.5 213.6 114.6Q215.7 110.7 219.0 107.0"/><path class="s" d="M256.4 94.9Q271.5 95.6 279.0 96.8Q286.5 97.9 292.7 100.6Q298.9 103.4 301.7 107.4Q304.4 111.4 306.1 115.5Q307.8 119.6 306.9 123.8Q306.0 128.0 302.0 131.7Q298.1 135.3 292.6 138.2Q287.1 141.2 280.0 142.9Q273.0 144.7 265.4 145.2Q257.7 145.7 250.0 145.0Q242.3 144.4 235.9 142.0Q229.5 139.6 224.3 136.4Q219.2 133.3 215.7 129.5Q212.2 125.7 213.0 121.4Q213.9 117.2 215.1 113.1Q216.3 108.9 220.5 105.3Q224.8 101.7 231.5 99.5Q238.1 97.2 245.5 96.0Q252.8 94.8 260.7 94.3Q268.5 93.8 275.5 95.7"/><text x="260" y="126" text-anchor="middle" style="font-size:19px">worker</text><path class="s" d="M188.3 223.9Q173.9 226.3 166.5 225.4Q159.2 224.6 152.2 223.2Q145.3 221.9 139.6 219.3Q134.0 216.7 129.3 213.5Q124.6 210.2 123.5 206.1Q122.4 202.1 122.3 197.9Q122.2 193.8 126.1 190.3Q130.0 186.8 134.6 183.6Q139.1 180.5 145.3 178.1Q151.4 175.7 158.7 174.6Q166.1 173.4 173.6 174.1Q181.1 174.8 187.8 176.5Q194.5 178.2 200.0 180.9Q205.5 183.5 210.0 186.8Q214.4 190.0 215.6 194.0Q216.8 198.0 217.3 202.1Q217.7 206.2 214.8 210.0Q211.9 213.9 206.2 216.6Q200.5 219.3 194.3 221.5Q188.1 223.6 181.0 225.1"/><path class="s" d="M139.1 179.4Q153.5 175.9 161.1 175.3Q168.7 174.7 176.3 175.1Q183.9 175.5 191.3 177.0Q198.7 178.5 203.6 181.8Q208.5 185.2 212.0 188.9Q215.5 192.6 216.6 196.8Q217.7 200.9 216.2 205.0Q214.6 209.2 210.7 212.8Q206.8 216.4 201.4 219.6Q196.1 222.7 188.3 223.7Q180.6 224.7 173.0 224.8Q165.5 225.0 157.5 224.7Q149.6 224.4 143.0 222.0Q136.4 219.5 131.3 216.1Q126.3 212.7 124.6 208.5Q122.9 204.3 122.0 200.0Q121.1 195.7 123.7 191.6Q126.3 187.5 132.0 184.5Q137.7 181.5 143.7 178.7Q149.7 176.0 157.3 174.7"/><text x="170" y="206" text-anchor="middle" style="font-size:19px">worker</text><text x="205" y="250" text-anchor="middle" class="m" style="font-size:17px">processes live inside</text><path class="s" d="M369.5 69.1Q400.0 70.4 428.6 70.3M371.3 70.6Q400.4 68.5 431.4 71.3"/><path class="s b" d="M468.2 58.1Q470.3 63.9 471.3 66.9Q472.3 69.9 471.5 72.9Q470.6 75.9 469.3 78.7Q468.0 81.5 466.0 83.9Q464.0 86.3 461.1 87.7Q458.3 89.0 455.2 89.5Q452.1 89.9 448.9 89.8Q445.7 89.6 443.0 88.0Q440.2 86.4 438.1 84.0Q436.1 81.7 434.7 78.9Q433.3 76.2 432.4 73.1Q431.5 70.1 432.2 67.0Q433.0 63.9 434.2 61.0Q435.4 58.1 437.9 56.1Q440.3 54.0 443.1 52.7Q445.9 51.4 448.9 50.7Q451.9 50.0 455.1 50.2Q458.2 50.5 460.8 52.3Q463.4 54.1 465.9 56.0Q468.5 57.9 470.0 60.7"/><path class="s b" d="M459.0 50.8Q464.1 54.9 466.6 57.0Q469.0 59.1 470.5 62.1Q471.9 65.1 471.6 68.4Q471.3 71.7 470.7 74.8Q470.0 77.9 468.3 80.6Q466.5 83.3 464.1 85.4Q461.7 87.5 458.6 88.6Q455.5 89.6 452.3 89.7Q449.0 89.7 445.9 88.9Q442.7 88.1 440.4 85.8Q438.1 83.4 436.3 80.9Q434.5 78.3 433.6 75.3Q432.7 72.2 432.8 69.1Q433.0 65.9 434.2 63.0Q435.3 60.1 437.0 57.2Q438.6 54.3 441.5 52.6Q444.4 51.0 447.7 50.8Q451.0 50.6 454.2 50.7Q457.4 50.7 460.3 52.2Q463.2 53.7 465.5 55.9"/><path class="s b" d="M451.8 69.6Q456.9 63.9 461.8 57.5M451.5 69.6Q457.2 64.0 461.8 58.1"/><text x="485" y="68" text-anchor="start" class="code">cpu.max</text><text x="485" y="90" text-anchor="start" class="m" style="font-size:18px">how much CPU</text><path class="s" d="M370.4 139.8Q399.8 141.6 429.6 140.0M369.9 139.2Q399.9 141.1 430.1 140.6"/><path class="s b" d="M469.9 148.6Q466.4 153.8 464.0 155.9Q461.7 158.1 458.7 159.2Q455.7 160.3 452.5 160.0Q449.3 159.6 446.2 159.1Q443.1 158.5 440.5 156.6Q437.9 154.7 436.3 152.0Q434.7 149.3 433.5 146.4Q432.4 143.5 432.5 140.5Q432.7 137.4 433.1 134.2Q433.6 131.1 435.5 128.6Q437.4 126.0 439.8 124.0Q442.3 121.9 445.3 120.9Q448.4 119.9 451.6 119.9Q454.7 120.0 457.8 120.8Q460.8 121.7 463.4 123.6Q465.9 125.5 467.5 128.1Q469.1 130.8 470.5 133.6Q471.8 136.4 471.5 139.5Q471.1 142.6 470.3 145.5Q469.6 148.5 468.1 151.3"/><path class="s b" d="M470.7 145.3Q468.0 151.1 466.1 153.8Q464.2 156.5 461.1 157.5Q458.0 158.6 454.9 159.0Q451.7 159.3 448.4 159.3Q445.1 159.3 442.5 157.3Q439.9 155.3 437.4 153.2Q434.8 151.2 433.6 148.1Q432.4 145.0 432.0 141.7Q431.6 138.4 432.3 135.2Q433.0 131.9 435.0 129.2Q437.0 126.6 439.5 124.4Q442.0 122.2 445.2 121.6Q448.4 121.0 451.6 120.4Q454.8 119.8 457.9 121.0Q461.0 122.1 463.7 123.9Q466.5 125.8 468.0 128.6Q469.5 131.5 470.9 134.5Q472.2 137.5 472.2 140.8Q472.2 144.2 470.5 147.0Q468.7 149.8 466.8 152.4"/><path class="s b" d="M451.6 139.7Q457.3 134.0 462.1 128.3M451.8 139.9Q456.8 133.8 461.5 128.0"/><text x="485" y="138" text-anchor="start" class="code">memory.max</text><text x="485" y="160" text-anchor="start" class="m" style="font-size:18px">how much RAM</text><path class="s" d="M368.9 210.6Q399.9 212.4 430.8 210.6M371.3 208.9Q400.0 210.3 428.7 210.8"/><path class="s b" d="M469.3 199.9Q471.5 205.8 471.8 208.9Q472.2 212.1 471.0 215.0Q469.9 217.9 468.3 220.5Q466.7 223.1 464.3 225.0Q461.8 226.9 459.0 228.3Q456.2 229.7 453.1 229.7Q450.0 229.6 447.0 228.8Q444.1 228.0 441.3 226.5Q438.5 225.1 436.3 222.7Q434.2 220.4 433.4 217.3Q432.7 214.2 432.3 211.1Q431.8 207.9 432.8 205.0Q433.8 202.0 435.3 199.2Q436.7 196.3 439.3 194.5Q441.9 192.6 444.9 191.7Q447.8 190.8 450.9 190.6Q454.0 190.5 456.9 191.4Q459.8 192.3 462.6 193.7Q465.3 195.1 467.2 197.6Q469.1 200.0 470.1 203.0"/><path class="s b" d="M439.4 225.2Q434.6 220.7 433.8 217.5Q433.0 214.3 432.2 211.1Q431.4 207.9 432.6 204.8Q433.8 201.7 435.6 198.9Q437.3 196.2 440.0 194.3Q442.6 192.4 445.7 191.1Q448.7 189.8 452.0 189.8Q455.4 189.8 458.4 191.1Q461.5 192.3 464.0 194.3Q466.6 196.4 468.5 199.0Q470.5 201.6 471.4 204.8Q472.4 208.0 471.9 211.2Q471.3 214.5 470.3 217.6Q469.3 220.7 467.2 223.3Q465.1 225.9 462.1 227.3Q459.1 228.7 455.9 229.1Q452.7 229.6 449.5 229.2Q446.4 228.8 443.3 227.7Q440.2 226.6 437.9 224.2Q435.6 221.9 433.9 219.0"/><path class="s b" d="M451.7 209.6Q457.4 204.3 462.2 198.4M451.8 209.9Q457.5 204.7 462.3 197.5"/><text x="485" y="208" text-anchor="start" class="code">pids.max</text><text x="485" y="230" text-anchor="start" class="m" style="font-size:18px">how many processes</text></svg><figcaption>A cgroup is a folder. Processes go in, and the files in it are dials the kernel obeys.</figcaption></figure>

**Try it yourself.** We'll use the worker node as a plain Linux machine, with no pods involved. Four steps are the whole idea:

<figure class="sketch "><svg viewBox="0 0 760 250" role="img" aria-label="Building a cgroup by hand in four steps"><title>Building a cgroup by hand in four steps</title><defs><clipPath id="cbh1"><rect x="15" y="40" width="170" height="150"/></clipPath><clipPath id="cbh2"><rect x="202" y="40" width="170" height="150"/></clipPath><clipPath id="cbh3"><rect x="389" y="40" width="170" height="150"/></clipPath><clipPath id="cbh4"><rect x="576" y="40" width="170" height="150"/></clipPath></defs><path class="h a" clip-path="url(#cbh1)" d="M-114.9 193.0Q-49.5 115.2 15.0 38.6M-101.7 192.6Q-37.1 115.6 26.9 38.6M-92.5 192.0Q-26.9 114.4 39.1 37.6M-80.3 192.4Q-13.1 116.0 50.9 37.9M-67.0 191.4Q-1.5 115.6 62.2 39.1M-55.6 190.9Q7.4 114.3 74.0 37.8M-43.7 191.3Q19.6 114.0 85.8 38.3M-33.1 191.3Q32.8 115.4 97.6 38.6M-20.1 191.3Q44.0 114.4 109.8 37.4M-8.9 191.3Q55.8 114.4 122.3 38.1M2.2 191.0Q67.1 114.0 133.7 37.4M13.9 192.5Q80.4 115.4 144.3 38.3M26.6 192.8Q94.0 116.1 158.8 37.6M39.2 191.8Q103.8 115.4 169.0 38.0M51.6 190.9Q116.6 115.1 180.7 38.1M60.9 191.7Q127.2 115.1 192.5 36.9M75.4 192.4Q141.2 116.2 205.4 37.9M87.0 190.8Q151.1 114.9 217.7 39.2M99.2 191.8Q164.6 116.2 228.3 37.1M109.9 191.8Q175.1 114.6 239.8 38.4M122.9 192.8Q187.3 114.6 254.0 37.9M135.0 191.7Q200.4 115.2 265.7 38.0M146.3 192.9Q211.5 115.2 276.3 37.8M157.4 192.1Q224.9 116.3 288.5 37.7M169.0 191.9Q235.7 115.4 301.2 37.7M180.8 190.8Q246.5 114.5 311.1 38.4"/><path class="s a" d="M16.1 38.5Q99.7 39.5 183.8 39.2M14.7 40.6Q100.0 38.8 185.0 41.4"/><path class="s a" d="M184.6 38.5Q185.8 114.5 185.0 190.4M184.4 41.4Q186.5 115.2 183.6 189.5"/><path class="s a" d="M184.0 189.5Q100.6 187.5 14.7 189.5M183.5 191.1Q99.8 190.8 14.6 191.5"/><path class="s a" d="M16.1 188.8Q17.6 115.0 14.5 38.8M14.1 191.3Q13.2 114.8 16.0 40.4"/><text x="100" y="85" text-anchor="middle" class="big">1. mkdir</text><text x="100" y="115" text-anchor="middle" style="font-size:19px">make the box</text><text x="100" y="165" text-anchor="middle" class="code">mkdir lab-cpu</text><path class="s" d="M187.4 116.3Q193.5 114.0 201.4 114.2M187.0 115.3Q194.4 114.5 199.6 113.8"/><path class="s" d="M200.5 115.4Q195.2 116.5 190.5 119.1M201.6 115.3Q196.1 117.0 191.7 119.9"/><path class="s" d="M200.9 115.5Q196.6 111.7 190.4 110.2M201.5 114.8Q195.8 113.5 191.0 110.3"/><path class="h b" clip-path="url(#cbh2)" d="M71.6 191.1Q136.9 114.8 202.0 37.1M83.8 193.0Q148.8 115.4 213.8 38.0M95.5 191.3Q161.3 115.6 227.1 37.6M107.8 191.1Q173.8 115.1 238.3 39.1M118.6 192.6Q184.9 114.8 250.2 38.2M131.0 191.8Q198.0 116.2 262.3 39.0M144.9 192.7Q210.3 116.0 273.7 38.6M156.7 190.9Q223.3 115.2 288.0 38.3M170.8 191.1Q234.0 114.5 300.1 39.2M182.6 191.8Q246.6 115.5 311.1 37.7M193.1 191.6Q260.3 115.9 323.9 38.8M205.0 191.2Q271.5 115.3 337.2 37.9M217.9 192.1Q281.1 114.1 347.4 38.8M229.2 192.9Q294.8 116.2 360.6 37.1M240.3 192.2Q304.4 114.6 371.6 37.5M251.5 192.3Q317.0 114.9 384.0 38.8M262.8 192.4Q329.6 115.5 394.4 37.4M274.8 193.1Q339.6 113.9 404.9 37.7M287.4 191.3Q350.7 114.0 417.6 38.0M299.4 191.1Q365.4 116.2 428.8 37.9M313.0 193.0Q377.8 114.9 443.2 37.7M323.6 192.9Q389.1 114.6 455.0 38.0M334.0 192.6Q400.6 115.8 465.2 36.9M346.4 191.0Q413.4 116.2 478.4 38.6M358.1 191.7Q425.1 116.4 488.1 37.8M370.4 193.0Q434.6 113.9 502.4 38.7"/><path class="s b" d="M203.5 40.9Q287.6 37.8 370.6 40.5M202.6 39.8Q286.5 37.9 373.2 40.2"/><path class="s b" d="M372.5 41.0Q373.4 115.5 371.5 190.0M370.8 39.0Q372.7 114.7 371.8 191.1"/><path class="s b" d="M373.1 190.9Q287.2 189.4 201.5 190.5M372.7 188.5Q286.5 189.7 202.1 190.3"/><path class="s b" d="M202.0 191.4Q203.8 114.7 202.9 39.6M202.8 189.5Q203.1 115.0 202.0 40.7"/><text x="287" y="85" text-anchor="middle" class="big">2. echo</text><text x="287" y="115" text-anchor="middle" style="font-size:19px">set a dial</text><text x="287" y="165" text-anchor="middle" class="code">… > cpu.max</text><path class="s" d="M373.5 116.0Q381.6 114.6 389.0 114.4M373.9 116.4Q381.4 114.4 387.3 115.0"/><path class="s" d="M388.5 114.4Q383.6 118.2 378.1 119.5M388.7 115.5Q382.9 116.9 378.7 120.4"/><path class="s" d="M387.4 115.2Q383.2 112.6 378.4 110.8M387.5 115.0Q383.2 111.9 377.4 110.3"/><path class="h y" clip-path="url(#cbh3)" d="M257.7 192.7Q325.1 116.2 389.1 38.0M269.4 190.9Q336.0 115.2 400.1 37.0M281.9 191.3Q348.1 115.6 413.3 37.2M293.2 191.9Q359.1 115.1 424.0 38.4M306.5 192.2Q371.7 115.9 436.9 39.1M318.3 192.2Q383.9 115.0 449.4 37.0M330.1 192.7Q393.5 113.8 459.0 38.4M341.2 192.2Q407.9 116.0 471.9 37.8M352.7 191.6Q417.5 113.9 484.0 39.1M366.7 191.4Q431.1 114.2 495.5 38.5M377.8 193.1Q442.5 114.2 508.5 37.7M389.9 191.8Q454.7 114.5 519.2 38.0M401.1 191.6Q466.4 115.2 531.1 38.4M414.0 192.0Q478.0 115.5 543.9 37.1M426.0 191.1Q492.4 116.1 556.7 36.9M438.5 192.3Q504.0 115.5 567.8 38.7M448.3 191.5Q514.0 115.7 580.0 38.7M459.3 190.8Q523.6 114.4 590.5 38.1M472.6 192.4Q536.7 114.1 602.1 39.0M483.8 191.6Q550.8 115.9 616.1 38.9M497.9 191.1Q563.8 115.9 628.5 37.1M510.3 191.5Q575.4 115.1 641.3 39.1M521.2 191.4Q587.4 115.9 651.2 39.0M534.1 192.8Q599.3 115.7 662.6 37.4M545.4 192.7Q611.4 115.5 676.3 37.9M559.4 192.7Q624.6 115.6 688.0 38.9"/><path class="s y" d="M388.7 40.4Q473.7 38.4 559.7 40.5M389.8 40.2Q473.5 40.8 559.9 40.1"/><path class="s y" d="M557.6 41.4Q558.0 115.6 558.6 191.5M558.8 39.1Q557.1 115.0 559.5 188.7"/><path class="s y" d="M558.8 188.4Q474.1 192.6 387.5 190.8M559.9 189.6Q473.4 192.5 388.9 190.7"/><path class="s y" d="M390.1 189.8Q388.8 115.1 388.6 39.2M388.0 188.7Q391.3 114.9 387.9 40.3"/><text x="474" y="85" text-anchor="middle" class="big">3. join</text><text x="474" y="115" text-anchor="middle" style="font-size:19px">put a process in</text><text x="474" y="165" text-anchor="middle" class="code">PID > cgroup.procs</text><path class="s" d="M560.8 116.5Q567.8 113.7 574.4 115.4M559.5 116.6Q568.0 115.2 574.3 114.3"/><path class="s" d="M575.3 114.3Q569.9 117.4 564.3 119.3M574.8 115.7Q569.7 117.4 565.4 119.7"/><path class="s" d="M574.3 115.3Q570.0 112.7 565.4 110.3M574.7 115.4Q569.9 112.5 565.3 110.4"/><path class="h r" clip-path="url(#cbh4)" d="M445.4 193.0Q509.1 113.5 575.5 39.1M458.2 193.1Q522.8 115.6 588.7 37.5M469.8 191.9Q533.5 114.7 599.5 37.4M481.7 192.6Q546.6 114.8 611.0 38.8M494.0 191.5Q557.8 114.4 624.5 38.8M504.7 191.8Q568.5 113.6 634.5 37.6M517.8 190.9Q582.3 115.1 647.6 37.5M529.1 192.5Q593.5 114.4 659.3 36.9M540.3 191.9Q605.3 115.2 670.0 37.6M551.7 192.8Q616.5 113.7 683.3 37.7M565.5 191.3Q630.1 114.0 695.9 37.7M577.6 192.1Q644.2 115.9 708.6 37.8M591.9 191.9Q655.6 115.1 722.7 38.7M604.2 192.1Q669.5 115.7 734.1 37.2M617.0 192.3Q682.2 116.7 746.7 37.0M628.2 191.7Q694.8 116.1 759.5 38.2M641.4 192.2Q706.1 114.8 772.4 37.6M653.2 192.6Q716.8 114.4 783.9 37.4M663.6 191.8Q730.5 115.4 795.1 39.1M677.2 192.0Q740.9 114.3 805.9 38.4M688.4 192.5Q753.8 115.0 817.8 37.3M700.1 191.2Q766.1 115.0 831.9 38.3M713.3 191.1Q778.8 115.9 844.3 37.4M726.4 191.5Q792.2 116.3 855.6 39.1M738.0 192.4Q802.0 114.9 867.3 37.8"/><path class="s r" d="M576.6 40.9Q661.4 42.6 747.0 41.2M574.8 40.7Q660.9 39.6 746.5 41.6"/><path class="s r" d="M746.2 39.7Q744.9 115.3 744.4 190.7M744.6 40.5Q748.0 114.6 745.2 191.3"/><path class="s r" d="M745.1 191.4Q661.6 191.2 576.3 189.5M744.7 191.2Q661.2 190.4 574.8 189.7"/><path class="s r" d="M576.6 189.3Q573.8 115.3 577.5 41.1M577.5 191.5Q578.2 114.4 574.5 39.1"/><text x="661" y="85" text-anchor="middle" class="big">4. cat</text><text x="661" y="115" text-anchor="middle" style="font-size:19px">watch it</text><text x="661" y="165" text-anchor="middle" class="code">cat cpu.stat</text><text x="380" y="230" text-anchor="middle" class="m" style="font-size:17px">every tool that manages resources, the kubelet included, comes down to these four steps</text></svg><figcaption>Make a folder, write a number, move a process in, read the result. That's the whole interface.</figcaption></figure>

**Step 1: make the box.**

```bash
docker exec under-the-hood-worker mkdir /sys/fs/cgroup/lab-cpu
docker exec under-the-hood-worker ls /sys/fs/cgroup/lab-cpu
```

You get a folder already full of files: `cpu.max`, `cpu.stat`, `memory.max`, `cgroup.procs` and more. You never create these yourself; the kernel adds them the moment the folder exists.

**Step 2: set a dial.** Allow 20 ms of CPU in every 100 ms, a fifth of one CPU:

```bash
docker exec under-the-hood-worker sh -c 'echo "20000 100000" > /sys/fs/cgroup/lab-cpu/cpu.max'
```

**Step 3: put a process in.** Start a shell that moves itself into the box (`$$` is the shell's own PID), then spins forever:

```bash
docker exec -d under-the-hood-worker sh -c \
  'echo $$ > /sys/fs/cgroup/lab-cpu/cgroup.procs; while :; do :; done'
```

**Writing a PID into `cgroup.procs` is how a process joins a cgroup.** There's no other way, and it's exactly what a container runtime does for every container it starts.

<details class="predict"><summary><span class="predict-tag">Predict first</span> The loop wants a whole CPU, and the box allows a fifth. Does the kernel slow it down or kill it?</summary><div class="predict-answer"><p>It slows it down. CPU is time, so the kernel makes the loop wait (chapter 6). Nothing is killed.</p></div></details>

**Step 4: watch the kernel enforce it.** `cpu.stat` keeps running totals. Read it, wait five seconds, read it again:

```bash
docker exec under-the-hood-worker grep -E 'usage_usec|nr_throttled' /sys/fs/cgroup/lab-cpu/cpu.stat
sleep 5
docker exec under-the-hood-worker grep -E 'usage_usec|nr_throttled' /sys/fs/cgroup/lab-cpu/cpu.stat
```

`usage_usec` (CPU time used, in microseconds) goes up by about 1,000,000: one second of CPU in five seconds, so 20%. `nr_throttled` goes up by about 50: the loop hit its limit in every 100 ms window. On my machine: **203m of CPU and 51 throttled periods in 5 seconds**. It wants a whole CPU; the kernel gives it a fifth.

Now change the dial while it runs:

```bash
docker exec under-the-hood-worker sh -c 'echo "50000 100000" > /sys/fs/cgroup/lab-cpu/cpu.max'
```

Read `cpu.stat` again and usage now climbs by about 2,500,000 every five seconds: half a CPU (I measured 512m). No restart, no API call. The kernel just reads the new number.

<details class="predict"><summary><span class="predict-tag">Predict first</span> Same idea for memory: a 50 MiB box and a program that keeps growing. Will the kernel just slow it down too?</summary><div class="predict-answer"><p>No. Memory is space, not time. Once reclaim can't free enough, the kernel kills the process (chapter 6).</p></div></details>

**And memory?** Make a second box with a 50 MiB limit, and run a shell that keeps doubling a string, so its memory doubles every step:

```bash
docker exec under-the-hood-worker sh -c 'mkdir /sys/fs/cgroup/lab-mem && echo 50M > /sys/fs/cgroup/lab-mem/memory.max'
docker exec under-the-hood-worker sh -c 'echo 0 > /sys/fs/cgroup/lab-mem/memory.swap.max' 2>/dev/null
docker exec under-the-hood-worker sh -c 'echo $$ > /sys/fs/cgroup/lab-mem/cgroup.procs; a=x; while :; do a=$a$a; done'
echo "exit code: $?"
docker exec under-the-hood-worker grep oom_kill /sys/fs/cgroup/lab-mem/memory.events
```

(The `memory.swap.max` line stops the kernel from dodging the limit by moving memory to disk.) In about a second, the shell is gone with exit code 137, and `memory.events` reads `max 35`, `oom 1`, `oom_kill 1`: the limit was hit 35 times, reclaim failed once, and the kernel killed the process. That's an OOM kill, with no Kubernetes anywhere.

Clean up with `kill` and `rmdir` (a cgroup is removed like an empty folder):

```bash
docker exec under-the-hood-worker sh -c 'kill -9 $(cat /sys/fs/cgroup/lab-cpu/cgroup.procs); sleep 1; rmdir /sys/fs/cgroup/lab-cpu /sys/fs/cgroup/lab-mem'
```

*Shortcut:* `make 01-cgroups-by-hand` runs all of this and checks every result.

> [!KEY]
> A cgroup is a folder. Its files are dials the kernel enforces, and a process joins it by writing its PID into `cgroup.procs`.

*Next question: Kubernetes does these same four steps for every pod. How does your YAML get there?*

---

## Part 3: From YAML to kernel

### 9. The four checkpoints

*Question: what happens to your `resources:` block between `kubectl apply` and a running process?*

Your YAML passes four checkpoints before it touches a process, and every chapter from here on sits on one of them.

<figure class="sketch "><svg viewBox="0 0 760 440" role="img" aria-label="Four layers handle Kubernetes resource settings"><title>Four layers handle Kubernetes resource settings</title><defs><clipPath id="cbp1"><rect x="30" y="30" width="230" height="70"/></clipPath><clipPath id="cbp2"><rect x="30" y="125" width="230" height="70"/></clipPath><clipPath id="cbp3"><rect x="30" y="220" width="230" height="70"/></clipPath><clipPath id="cbp4"><rect x="30" y="315" width="230" height="70"/></clipPath></defs><path class="h b" clip-path="url(#cbp1)" d="M-30.9 102.0Q-0.5 65.3 30.2 27.2M-22.3 101.0Q9.3 64.9 39.8 28.5M-13.5 101.2Q18.6 66.3 45.9 28.1M-5.7 101.9Q23.6 63.8 56.0 28.0M3.1 103.2Q34.2 65.0 65.7 28.8M12.0 102.6Q42.7 64.3 73.7 28.8M21.1 103.0Q54.0 65.6 82.6 29.2M30.1 101.0Q59.9 64.2 91.1 29.1M39.1 102.7Q69.2 63.7 100.2 28.1M49.4 101.1Q78.8 63.9 109.7 27.3M58.5 101.3Q89.7 66.0 118.2 28.9M66.3 102.7Q96.6 63.7 127.3 27.5M75.3 101.7Q104.3 63.8 135.8 29.1M83.2 103.0Q115.0 64.9 145.6 27.4M93.4 102.9Q123.9 65.3 153.5 27.8M101.1 101.4Q130.1 63.6 162.2 28.2M108.5 102.1Q138.8 63.8 170.9 28.3M117.2 101.9Q149.1 65.6 177.5 27.2M127.4 103.2Q156.7 65.0 187.7 28.5M136.6 102.5Q164.5 63.7 197.6 26.9M146.1 101.0Q175.5 64.8 205.9 28.6M155.7 101.6Q186.0 65.9 216.0 29.0M164.6 102.3Q194.9 65.1 225.0 28.2M174.6 102.5Q203.0 64.4 234.2 28.6M183.4 100.9Q213.4 64.5 243.9 28.0M192.3 101.4Q222.3 65.6 251.0 27.5M201.0 101.9Q229.9 64.7 262.4 27.6M211.0 102.9Q239.4 64.6 270.5 28.2M219.4 102.5Q247.9 64.4 280.5 27.5M226.7 102.3Q257.0 64.6 287.8 27.6M235.5 102.9Q268.4 65.8 296.4 28.5M244.9 101.9Q275.9 64.1 305.5 28.8M254.1 102.3Q283.2 64.2 315.5 28.7"/><path class="s b" d="M29.0 28.4Q144.6 30.9 259.9 30.7M30.6 30.1Q144.7 28.2 260.4 30.8"/><path class="s b" d="M258.7 31.4Q260.9 65.5 260.7 98.8M259.6 30.2Q260.4 65.5 261.2 100.9"/><path class="s b" d="M259.1 100.7Q145.0 97.9 31.0 100.5M261.5 101.5Q144.6 99.4 30.1 100.9"/><path class="s b" d="M29.5 98.7Q29.7 65.5 29.8 30.2M31.0 98.6Q31.3 64.4 31.0 29.0"/><text x="145" y="63" text-anchor="middle" class="big">API server</text><text x="145" y="87" text-anchor="middle" class="m" style="font-size:18px">validates and defaults</text><text x="285" y="72" text-anchor="start" style="font-size:20px">ResourceQuota · LimitRange · PriorityClass</text><path class="h a" clip-path="url(#cbp2)" d="M-31.7 197.0Q-0.6 159.3 30.5 123.8M-22.5 196.3Q10.3 161.5 39.4 122.5M-11.9 196.5Q18.8 160.7 48.6 123.8M-2.2 197.2Q27.7 159.7 57.9 123.1M6.8 196.8Q37.1 160.7 68.4 123.2M15.6 198.1Q46.4 160.5 77.6 122.4M25.7 196.9Q54.0 159.4 85.1 122.3M32.8 196.3Q65.3 161.3 94.2 123.4M43.2 196.1Q72.7 159.3 103.5 122.4M50.8 197.1Q81.5 160.0 111.0 122.3M60.5 197.9Q91.1 160.7 120.5 123.6M70.9 196.3Q101.3 160.8 131.9 123.9M77.2 197.8Q108.0 159.1 138.8 123.7M85.7 197.4Q116.7 159.3 148.2 124.1M95.1 196.3Q125.3 160.0 154.5 122.1M101.9 196.2Q133.3 160.2 162.8 123.8M113.8 196.9Q144.0 160.6 174.2 122.6M120.5 197.5Q152.0 160.1 183.3 122.2M129.7 197.0Q161.6 160.3 190.2 123.9M139.9 197.2Q171.5 160.6 201.0 124.2M150.4 197.8Q179.8 159.6 210.4 124.0M159.3 197.5Q190.8 160.7 219.3 122.6M168.7 196.4Q197.3 158.9 230.4 123.4M176.9 198.2Q208.1 160.4 238.3 123.5M187.2 196.4Q218.0 161.3 247.3 121.9M196.0 197.1Q224.7 159.5 255.9 124.1M203.1 197.2Q236.2 161.5 265.6 121.9M214.0 197.3Q243.4 158.9 273.8 124.1M222.4 197.4Q253.5 159.9 283.9 122.5M231.2 196.2Q261.7 159.3 293.8 122.7M243.2 196.0Q272.8 161.1 303.9 122.8M252.1 197.5Q282.6 161.2 311.8 124.1"/><path class="s a" d="M29.9 124.1Q144.5 125.7 258.6 125.1M29.9 124.2Q144.9 123.3 260.3 124.7"/><path class="s a" d="M261.4 125.7Q258.7 160.6 259.2 193.8M259.5 124.3Q258.5 160.2 260.6 195.2"/><path class="s a" d="M259.0 194.2Q145.2 194.9 31.5 196.3M259.3 194.8Q144.4 192.5 30.4 193.7"/><path class="s a" d="M30.6 195.2Q29.7 159.5 30.4 124.6M30.8 196.1Q29.5 159.8 28.6 123.8"/><text x="145" y="158" text-anchor="middle" class="big">Scheduler</text><text x="145" y="182" text-anchor="middle" class="m" style="font-size:18px">places pods using requests</text><text x="285" y="167" text-anchor="start" style="font-size:20px">requests vs allocatable · preemption</text><path class="h y" clip-path="url(#cbp3)" d="M-31.5 291.8Q0.6 256.0 29.4 218.7M-22.0 292.6Q9.2 255.2 39.7 217.8M-14.4 292.2Q16.2 253.6 47.4 218.4M-4.4 291.0Q26.1 255.4 55.6 218.5M5.2 291.7Q34.1 254.3 64.5 218.5M13.6 292.7Q45.8 256.4 74.1 217.6M22.2 291.7Q54.6 255.8 83.1 217.7M31.4 292.8Q60.9 254.5 92.3 217.2M40.9 292.1Q72.2 255.5 101.9 219.1M50.8 291.0Q81.1 255.8 110.0 218.6M60.5 292.4Q89.3 253.6 120.2 217.3M69.1 293.1Q100.2 255.0 130.7 218.0M78.3 292.8Q109.8 255.9 139.8 218.8M88.5 292.1Q119.9 256.3 149.5 218.7M98.2 291.7Q126.9 255.0 157.1 217.3M105.4 291.1Q136.1 254.1 167.1 218.7M115.2 290.9Q143.3 254.0 174.1 217.2M122.0 291.2Q152.5 254.4 183.0 217.2M132.1 291.4Q162.1 254.8 193.9 219.0M140.2 290.9Q171.9 255.1 202.8 218.7M150.8 292.4Q180.1 254.9 209.8 216.8M158.8 291.2Q188.9 254.9 218.6 217.6M168.3 291.4Q198.6 256.0 228.0 217.2M177.4 291.0Q205.9 254.1 236.9 218.5M185.0 292.9Q215.2 255.4 245.2 218.7M192.9 292.1Q224.9 256.3 254.6 217.2M202.8 291.9Q233.0 254.1 264.7 217.7M213.8 292.8Q241.8 254.0 273.9 216.8M221.3 290.8Q252.2 255.6 283.5 218.7M230.0 291.5Q260.4 255.2 290.3 217.7M238.8 293.1Q268.6 254.6 300.2 218.5M246.9 292.4Q278.9 255.5 309.2 217.2M256.0 291.2Q288.2 255.4 316.6 217.8"/><path class="s y" d="M30.5 220.9Q144.9 222.2 261.0 219.6M29.7 220.6Q144.9 218.5 261.5 220.9"/><path class="s y" d="M259.5 219.5Q259.4 254.4 260.5 288.7M261.0 220.4Q260.6 255.4 258.9 290.9"/><path class="s y" d="M260.0 288.9Q145.1 287.7 30.7 291.6M259.0 291.4Q145.3 290.3 30.4 289.0"/><path class="s y" d="M30.6 289.5Q27.7 255.1 31.4 219.6M28.8 291.3Q29.3 255.6 30.1 220.2"/><text x="145" y="253" text-anchor="middle" class="big">Kubelet</text><text x="145" y="277" text-anchor="middle" class="m" style="font-size:18px">prepares the pod, may evict</text><text x="285" y="262" text-anchor="start" style="font-size:20px">writes cgroups · eviction · PID and disk limits</text><path class="h r" clip-path="url(#cbp4)" d="M-29.7 387.8Q-0.5 350.5 30.2 312.1M-21.0 387.8Q9.0 349.2 38.9 313.1M-12.0 387.4Q15.7 349.3 47.3 313.4M-4.7 386.3Q26.6 350.0 57.2 312.1M4.6 387.2Q35.5 350.2 65.6 313.3M13.5 386.9Q43.9 350.9 73.9 313.3M23.8 387.8Q54.1 350.6 84.4 312.8M31.6 386.8Q62.5 350.2 93.3 312.6M39.9 387.6Q71.1 350.8 100.0 313.2M47.5 385.9Q77.0 349.1 109.1 313.1M55.2 388.0Q86.0 349.3 118.2 313.4M66.6 387.2Q96.5 349.5 127.8 312.0M74.4 386.4Q104.9 349.5 135.9 312.6M83.3 387.2Q115.6 350.9 143.5 311.9M94.6 386.9Q123.3 349.9 153.6 312.5M103.0 386.9Q134.6 351.3 163.4 313.9M114.2 385.9Q143.0 349.0 173.2 313.5M121.1 387.5Q153.9 351.2 183.9 312.9M129.4 386.2Q159.5 349.5 190.3 313.4M139.9 386.3Q169.9 350.1 200.1 314.0M150.2 386.9Q178.9 349.1 209.9 313.1M157.8 386.0Q187.6 350.0 217.4 313.6M166.6 388.2Q195.4 349.2 225.3 312.9M174.3 387.1Q205.6 349.7 236.3 312.7M185.3 387.4Q215.7 350.7 245.3 314.1M192.1 386.9Q223.7 350.8 254.3 313.7M202.5 387.0Q232.0 349.1 262.1 313.2M210.9 385.8Q242.8 349.9 272.6 312.8M221.6 387.2Q250.7 349.0 281.6 313.7M228.7 387.3Q258.3 348.7 290.1 312.4M237.7 386.2Q267.8 348.7 299.6 313.8M247.2 388.1Q276.9 348.8 307.6 313.0M258.0 385.9Q288.9 351.1 317.6 313.9"/><path class="s r" d="M28.6 313.5Q144.7 314.4 261.6 315.8M30.2 314.2Q144.7 315.9 259.9 316.4"/><path class="s r" d="M260.4 313.5Q260.4 350.6 259.7 385.5M261.2 315.3Q261.9 350.2 261.2 384.9"/><path class="s r" d="M260.9 384.1Q145.4 385.4 29.5 384.0M259.1 384.9Q144.6 384.4 29.4 384.8"/><path class="s r" d="M29.1 384.6Q32.6 350.5 28.6 315.6M29.0 384.2Q29.1 349.4 29.7 316.4"/><text x="145" y="348" text-anchor="middle" class="big">Linux kernel</text><text x="145" y="372" text-anchor="middle" class="m" style="font-size:18px">enforces cgroup limits</text><text x="285" y="357" text-anchor="start" style="font-size:20px">cpu.max · cpu.weight · memory.max · OOM · PSI</text><path class="s" d="M143.9 103.4Q144.1 111.8 144.6 122.9M144.4 101.6Q144.9 111.4 143.7 123.2"/><path class="s" d="M144.3 121.8Q142.4 117.2 139.8 111.4M144.7 121.9Q141.9 117.1 140.3 111.5"/><path class="s" d="M145.3 121.4Q147.7 117.4 149.3 111.7M145.6 121.6Q147.8 117.2 149.5 111.8"/><path class="s" d="M145.4 197.2Q145.2 206.4 146.0 218.5M144.1 197.6Q145.8 207.5 145.5 218.5"/><path class="s" d="M144.3 216.9Q143.2 211.7 140.0 206.4M144.6 216.5Q142.2 212.2 140.1 207.1"/><path class="s" d="M144.3 216.7Q146.8 211.5 149.7 206.5M145.3 216.2Q147.7 212.2 149.6 206.9"/><path class="s" d="M145.0 292.3Q146.1 301.4 144.9 311.4M146.3 292.2Q145.1 301.8 144.2 312.5"/><path class="s" d="M145.7 311.8Q141.9 307.5 140.3 302.8M144.9 311.9Q143.3 306.8 139.9 302.6"/><path class="s" d="M144.3 311.4Q148.2 307.7 149.8 301.8M144.5 311.6Q147.4 306.7 150.1 301.7"/><text x="380" y="425" text-anchor="middle" class="m" style="font-size:18px">your YAML enters at the top; each layer makes its own decisions</text></svg><figcaption>Four checkpoints, four jobs. Kubernetes decides and configures; the kernel enforces CPU and memory limits.</figcaption></figure>

1. **API server.** Before the pod is even saved, admission checks run. Does the namespace have a ResourceQuota, and would this pod go over it? Does a LimitRange need to fill in missing requests or limits? Which PriorityClass does it belong to? If any check fails, you get an error and the pod never exists.
2. **Scheduler.** The pod is saved but has no node yet. The scheduler looks for a node with enough **allocatable** resources (what's left for pods after the system takes its share; chapter 18) to fit the pod's **requests**. It doesn't look at real usage at all. If nothing fits, the pod stays `Pending`, or a lower-priority pod gets pushed out to make room.
3. **Kubelet.** The kubelet on the chosen node creates a cgroup for the pod and one for each container, writes your numbers into their files, and starts the containers inside them. After that it keeps watching the node: if memory or disk runs low, it evicts pods.
4. **Kernel.** From here on, every CPU turn and every memory allocation of your process is checked against those files. The kernel is what throttles CPU and OOM-kills processes.

When something goes wrong in production, asking **"which checkpoint did this?"** is usually the fastest way to the answer.

> [!KEY]
> Kubernetes decides and configures; the kernel enforces.

*Next question: let's follow one pod through the last two checkpoints.*

---

### 10. Follow one pod down to the kernel

*Question: where exactly do `250m`, `500m` and `128Mi` end up?*

We'll use one pod for the rest of Part 3:

```yaml
resources:
  requests:
    cpu: 250m
    memory: 64Mi
  limits:
    cpu: 500m
    memory: 128Mi
```

<figure class="sketch "><svg viewBox="0 0 760 330" role="img" aria-label="One pod's resources at every layer"><title>One pod's resources at every layer</title><defs><clipPath id="cpj1"><rect x="20" y="77" width="215" height="46"/></clipPath><clipPath id="cpj2"><rect x="20" y="139" width="215" height="46"/></clipPath><clipPath id="cpj3"><rect x="20" y="201" width="215" height="46"/></clipPath><clipPath id="cpj4"><rect x="20" y="263" width="215" height="46"/></clipPath></defs><path class="s" d="M18.5 16.1Q128.1 14.2 235.7 15.6M21.0 15.1Q127.9 12.3 235.8 15.7"/><path class="s" d="M236.3 16.3Q235.8 38.6 233.7 61.5M235.8 15.2Q233.4 37.4 236.5 60.2"/><path class="s" d="M235.5 59.7Q127.6 63.5 19.5 59.8M235.1 60.1Q127.9 61.4 20.1 62.6"/><path class="s" d="M21.2 59.6Q19.4 38.2 20.4 15.3M21.1 60.2Q20.4 38.2 18.9 13.9"/><text x="127" y="45" text-anchor="middle" class="big" style="font-size:20px">pod.yaml</text><text x="255" y="45" text-anchor="start" style="font-size:17px">requests 250m · limits 500m / 128Mi</text><path class="s" d="M127.1 62.8Q126.5 69.0 127.4 75.1M125.5 64.3Q127.3 68.8 126.5 74.7"/><path class="s" d="M126.3 75.1Q123.8 70.7 121.5 65.0M127.1 74.8Q124.0 70.7 122.6 65.6"/><path class="s" d="M127.7 74.5Q128.4 69.7 132.4 64.7M126.7 75.3Q129.8 70.4 131.6 64.7"/><path class="h b" clip-path="url(#cpj1)" d="M-21.1 125.8Q0.9 101.6 19.4 74.6M-11.7 124.4Q9.5 100.5 27.9 74.1M-1.8 124.2Q18.0 98.9 39.7 75.3M9.9 125.3Q29.0 99.3 49.9 75.2M18.6 124.3Q39.2 100.0 57.9 74.8M29.4 126.1Q48.5 99.5 70.3 75.6M38.4 125.9Q59.9 100.5 78.9 73.8M49.9 124.7Q68.5 98.9 88.7 75.9M59.2 124.9Q80.2 100.7 97.7 74.4M68.3 126.0Q87.5 99.6 109.3 74.1M80.0 124.7Q98.3 99.1 119.9 76.0M87.7 125.4Q109.0 100.6 127.3 75.1M99.2 125.0Q118.1 98.9 139.1 74.9M109.7 123.9Q131.6 101.2 150.9 75.0M120.4 125.6Q140.5 100.4 159.0 73.8M131.3 123.8Q152.4 101.2 170.8 74.8M140.4 124.2Q161.7 100.8 181.0 75.4M151.7 125.7Q171.9 99.6 191.9 74.9M163.3 125.9Q183.9 100.7 201.9 76.1M172.3 124.3Q191.7 99.2 212.8 75.3M182.3 124.8Q201.5 99.5 223.1 75.7M193.4 125.9Q212.9 100.0 233.5 74.3M202.7 124.5Q222.2 98.5 243.5 74.3M212.6 125.8Q232.7 100.1 251.6 74.5M222.5 124.9Q241.9 99.1 262.5 75.9M232.7 125.4Q252.9 100.1 273.3 75.9"/><path class="s b" d="M19.9 77.0Q127.2 79.4 235.9 78.5M19.7 77.2Q127.6 78.0 234.6 78.3"/><path class="s b" d="M234.9 75.9Q235.9 99.6 234.7 121.5M236.4 76.7Q234.9 99.4 235.2 122.0"/><path class="s b" d="M233.6 122.2Q127.5 125.4 18.7 122.2M233.6 123.0Q126.9 124.9 21.5 123.0"/><path class="s b" d="M19.2 123.8Q22.0 99.6 19.7 76.8M21.4 121.9Q22.5 100.6 19.3 76.3"/><text x="127" y="107" text-anchor="middle" class="big" style="font-size:20px">kubelet</text><text x="255" y="107" text-anchor="start" style="font-size:17px">turns it into an OCI runtime spec</text><path class="s" d="M125.9 124.7Q127.3 131.3 127.0 136.7M126.8 123.9Q126.9 130.6 128.1 138.1"/><path class="s" d="M127.1 136.8Q123.4 132.3 121.7 126.6M127.6 136.6Q124.0 132.3 122.8 127.0"/><path class="s" d="M126.9 137.3Q129.5 132.2 131.2 126.7M127.7 136.9Q128.7 131.9 132.4 127.1"/><path class="h a" clip-path="url(#cpj2)" d="M-19.1 186.9Q0.9 162.5 19.2 136.8M-9.3 186.3Q9.5 162.0 30.8 137.7M-1.0 186.0Q19.0 160.9 39.5 136.5M10.7 186.3Q31.1 162.4 50.1 136.9M20.0 186.1Q40.4 162.4 59.9 138.1M29.0 187.5Q50.1 162.7 68.3 137.5M38.3 186.7Q56.9 161.1 79.4 137.0M49.7 188.0Q70.3 163.2 90.0 136.4M58.6 187.6Q78.6 161.3 100.1 137.6M70.5 187.2Q89.9 162.5 109.9 137.4M81.1 186.1Q100.4 162.0 119.3 137.3M89.4 187.9Q112.0 163.0 129.4 137.2M100.0 187.2Q119.8 161.4 140.7 136.9M112.2 187.4Q132.4 162.5 151.4 136.4M121.0 188.1Q140.6 161.2 161.5 135.9M132.8 187.3Q151.9 162.0 171.5 136.7M142.2 186.3Q162.1 162.5 181.5 136.4M152.8 187.3Q173.1 163.2 191.9 136.6M162.2 187.0Q180.3 161.2 201.5 137.5M171.1 187.9Q190.6 162.4 211.1 138.0M180.2 187.4Q201.7 163.4 219.2 137.4M189.6 187.1Q211.1 162.4 229.6 137.1M198.5 187.0Q221.1 163.5 238.8 136.5M208.5 186.5Q229.3 162.2 249.8 137.7M218.5 186.9Q239.3 162.4 259.2 137.1M231.5 187.3Q250.4 162.1 269.4 137.8"/><path class="s a" d="M19.1 140.4Q127.8 137.8 234.2 139.9M19.1 137.8Q127.1 141.1 235.7 137.4"/><path class="s a" d="M234.3 139.6Q233.9 162.3 235.4 185.4M235.9 139.5Q233.9 161.9 233.4 184.3"/><path class="s a" d="M234.5 185.5Q127.1 186.5 20.2 186.3M233.6 184.6Q127.4 182.2 19.4 184.4"/><path class="s a" d="M21.5 185.7Q19.7 162.1 19.9 140.5M21.3 185.8Q19.6 162.5 21.0 139.3"/><text x="127" y="169" text-anchor="middle" class="big" style="font-size:20px">containerd + runc</text><text x="255" y="169" text-anchor="start" style="font-size:17px">shares 256 · quota 50000/100000 · limit 128Mi</text><path class="s" d="M126.0 185.5Q126.6 192.4 125.4 198.3M126.4 187.6Q126.0 192.6 128.1 198.5"/><path class="s" d="M126.3 199.2Q124.9 193.7 122.3 189.1M126.4 199.0Q125.1 194.1 122.6 189.1"/><path class="s" d="M127.1 198.8Q129.2 193.9 132.4 189.8M126.7 199.3Q129.0 194.0 132.3 188.9"/><path class="h y" clip-path="url(#cpj3)" d="M-20.3 248.6Q0.2 223.6 20.9 199.3M-9.6 249.6Q11.2 224.7 30.9 199.8M0.7 248.6Q19.2 224.0 39.4 199.7M10.1 248.3Q29.3 223.5 49.7 199.9M18.3 249.3Q38.7 223.6 58.7 198.9M30.0 249.4Q49.1 224.8 68.6 199.9M39.3 248.3Q59.9 223.4 80.4 198.9M49.8 249.3Q69.7 223.6 89.2 197.9M61.5 248.9Q80.3 223.0 101.4 198.5M71.0 247.9Q89.8 222.6 111.0 198.9M82.7 250.0Q101.9 224.0 122.4 199.9M92.8 249.7Q112.4 224.6 132.1 198.3M102.9 249.7Q120.5 223.3 143.0 199.8M111.3 248.0Q132.6 224.3 151.8 197.8M124.4 249.3Q143.8 224.6 164.4 199.5M133.1 249.7Q153.6 224.2 172.2 199.9M142.3 250.0Q162.8 222.9 183.4 199.2M153.9 249.8Q175.0 224.5 194.4 199.9M164.3 250.1Q183.4 223.4 204.3 199.7M173.8 249.7Q192.1 223.3 214.0 198.4M181.1 250.1Q201.8 223.4 222.2 198.3M193.8 248.6Q213.1 224.2 233.9 198.9M203.8 250.1Q224.2 224.4 243.4 199.3M214.5 247.9Q232.8 223.8 253.5 198.5M222.5 249.6Q242.7 223.2 263.8 198.7M233.0 248.6Q252.7 223.6 274.1 200.2"/><path class="s y" d="M21.2 202.6Q127.7 198.9 234.3 200.9M21.1 201.2Q127.3 200.7 234.6 200.3"/><path class="s y" d="M235.3 200.3Q234.6 223.9 236.5 247.4M236.1 202.4Q235.8 224.5 235.4 248.5"/><path class="s y" d="M233.7 247.1Q127.4 249.8 19.0 247.9M235.2 247.9Q127.2 248.1 18.9 248.0"/><path class="s y" d="M20.1 246.7Q19.3 223.6 18.8 202.1M18.9 246.8Q17.9 224.6 19.3 201.4"/><text x="127" y="231" text-anchor="middle" class="big" style="font-size:20px">systemd</text><text x="255" y="231" text-anchor="start" style="font-size:17px">scope: CPUWeight 35 · CPUQuota 500ms · MemoryMax</text><path class="s" d="M127.0 249.2Q128.5 255.4 127.2 259.8M127.2 249.6Q126.2 254.7 126.1 260.0"/><path class="s" d="M126.8 260.7Q124.1 256.4 122.6 251.6M127.6 261.5Q125.5 255.8 122.3 250.9"/><path class="s" d="M126.5 260.4Q129.0 255.9 131.2 250.3M126.3 260.3Q129.5 255.9 131.9 251.9"/><path class="h r" clip-path="url(#cpj4)" d="M-20.8 311.6Q0.1 286.1 20.4 261.3M-9.0 311.8Q9.4 284.5 30.7 260.6M1.5 310.1Q20.8 286.2 40.9 261.9M11.7 311.9Q31.3 286.7 51.2 260.1M21.4 309.9Q42.6 287.2 61.0 260.9M30.8 310.4Q49.8 285.7 70.0 259.8M40.6 310.5Q60.5 286.1 80.8 262.2M50.0 311.2Q69.0 285.0 90.1 261.3M61.2 310.5Q81.2 287.0 100.1 261.0M71.4 310.7Q91.3 286.6 110.5 262.1M81.0 311.7Q100.0 285.2 122.3 262.0M93.5 311.3Q111.2 285.4 132.7 261.7M102.5 311.2Q122.9 286.3 141.6 261.2M111.3 311.0Q132.1 286.3 153.0 261.8M122.3 312.1Q141.1 285.6 160.5 259.9M131.8 311.3Q152.1 285.9 170.4 260.2M139.7 311.2Q161.5 287.2 180.4 260.9M149.6 312.2Q169.7 286.0 191.0 261.0M160.9 311.1Q180.2 285.5 199.8 260.4M170.5 309.8Q192.2 286.7 210.8 261.9M181.9 311.9Q200.4 285.1 220.6 261.7M192.8 310.7Q211.3 285.0 231.8 260.4M202.7 310.4Q221.9 285.9 242.0 260.5M210.6 311.5Q231.3 286.3 252.4 261.9M222.2 311.5Q241.7 285.9 263.1 260.0M233.2 311.6Q253.0 286.8 272.5 260.3"/><path class="s r" d="M20.9 264.1Q127.8 263.3 235.7 264.1M21.0 264.2Q128.0 263.0 234.1 263.8"/><path class="s r" d="M234.6 264.1Q233.0 286.4 234.4 310.4M233.6 264.1Q234.6 285.7 235.8 308.9"/><path class="s r" d="M233.9 310.5Q127.6 308.3 20.6 310.4M236.1 308.4Q128.0 308.4 20.4 308.3"/><path class="s r" d="M18.4 310.2Q18.8 285.6 20.2 263.5M21.2 307.4Q18.8 286.3 20.0 262.0"/><text x="127" y="293" text-anchor="middle" class="big" style="font-size:20px">kernel</text><text x="255" y="293" text-anchor="start" style="font-size:17px">cpu.weight 35 · cpu.max 50000 100000 · memory.max</text></svg><figcaption>The same three numbers travel down five layers. Only the last one enforces them.</figcaption></figure>

**Try it yourself.** Create the pod and grab its container ID, which we'll use at every layer:

```bash
kubectl create namespace lab
kubectl -n lab apply -f modules/02-follow-the-pod/pod.yaml
kubectl -n lab wait --for=condition=Ready pod/follow-me
CID=$(kubectl -n lab get pod follow-me -o jsonpath='{.status.containerStatuses[0].containerID}' | sed 's#containerd://##')
```

**Layer 1, the runtime: what the kubelet asked for.** The kubelet doesn't create cgroups itself. It hands the container runtime (containerd) a description of the container in a standard format, the **OCI runtime spec**. `crictl` talks to the runtime directly:

```bash
docker exec under-the-hood-worker crictl inspect $CID \
  | grep -E '"cgroupsPath"|"shares"|"quota"|"period"|"limit"'
```

```
"cgroupsPath": "kubelet-kubepods-burstable-pod97ea3d5e_c357_….slice:cri-containerd:…",
"period": 100000,
"quota": 50000,
"shares": 256
"limit": 134217728,
```

That's your whole `resources:` block, translated. `quota`/`period` is the 500m CPU limit, `limit` is 128 MiB in bytes, and `cgroupsPath` says where the container's cgroup goes: inside its pod's folder. `shares: 256` is the 250m request in an older unit called *CPU shares* (chapter 13 explains it).

**Layer 2, systemd: the unit that owns the cgroup.** On nodes that use the systemd cgroup driver (most do, including this one), the low-level runtime, runc, asks systemd to create the cgroup as a *scope*, systemd's name for a group of processes started by someone else:

```bash
docker exec under-the-hood-worker systemctl show cri-containerd-$CID.scope \
  -p CPUWeight -p CPUQuotaPerSecUSec -p MemoryMax
```

```
CPUWeight=35
CPUQuotaPerSecUSec=500ms
MemoryMax=134217728
```

Same numbers, systemd's words: "500 ms of CPU per second" is our 500m limit.

**Layer 3, the kernel: the files.**

```bash
CDIR="$(./scripts/pod-cgroup.sh follow-me)/cri-containerd-$CID.scope"
docker exec under-the-hood-worker cat $CDIR/cpu.weight $CDIR/cpu.max $CDIR/memory.max
```

```
35
50000 100000
134217728
```

The lab's `requests-limits` pod has the same YAML. Read its files from inside, plus one more, `memory.min`:

```bash
kubectl -n lab apply -f modules/03-requests-and-limits/pod.yaml
kubectl -n lab wait --for=condition=Ready pod/requests-limits
kubectl -n lab exec requests-limits -- cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max /sys/fs/cgroup/cpu.weight /sys/fs/cgroup/memory.min
```

```
50000 100000
134217728
35
0
```

The same kind of files you wrote by hand in chapter 8. Here's the map to keep:

| You wrote | File | Value | In plain words |
|---|---|---|---|
| `limits.cpu: 500m` | `cpu.max` | `50000 100000` | At most 50 ms of CPU in every 100 ms |
| `limits.memory: 128Mi` | `memory.max` | `134217728` | 128 MiB; reclaim, then OOM kill |
| `requests.cpu: 250m` | `cpu.weight` | `35` | A share of CPU, only used when groups compete |
| `requests.memory: 64Mi` | `memory.min` | `0` | **No kernel protection.** Used for scheduling and eviction instead |

That last row surprises almost everyone I show this to. By default, Kubernetes uses the memory request to pick a node and, later, to decide who to evict first when the node runs short (chapter 18), but it doesn't ask the kernel to protect that memory. Clusters that turn on the `MemoryQoS` feature (still alpha) map requests to `memory.min`; chapter 17 covers it.

<figure class="sketch "><svg viewBox="0 0 760 340" role="img" aria-label="Requests and limits turn into cgroup files"><title>Requests and limits turn into cgroup files</title><path class="s" d="M18.6 30.1Q149.6 29.3 279.6 28.6M18.6 28.7Q149.4 30.0 279.8 31.0"/><path class="s" d="M281.4 30.2Q281.6 160.2 279.7 291.5M278.9 28.8Q282.8 159.7 279.4 291.0"/><path class="s" d="M279.6 290.2Q150.1 291.8 18.6 288.6M279.4 290.3Q150.2 291.4 19.9 289.4"/><path class="s" d="M20.2 290.1Q21.8 159.7 21.2 30.7M19.7 290.8Q19.5 159.5 18.9 30.0"/><text x="35" y="22" text-anchor="start" style="font-size:21px">pod.yaml</text><text x="40" y="70" text-anchor="start" class="code">resources:</text><text x="40" y="100" text-anchor="start" class="code">&#160;&#160;requests:</text><text x="40" y="130" text-anchor="start" class="code">&#160;&#160;&#160;&#160;cpu:&#160;250m</text><text x="40" y="160" text-anchor="start" class="code">&#160;&#160;&#160;&#160;memory:&#160;64Mi</text><text x="40" y="195" text-anchor="start" class="code">&#160;&#160;limits:</text><text x="40" y="225" text-anchor="start" class="code">&#160;&#160;&#160;&#160;cpu:&#160;500m</text><text x="40" y="255" text-anchor="start" class="code">&#160;&#160;&#160;&#160;memory:&#160;128Mi</text><path class="s a" d="M200.2 126.2Q302.1 93.1 404.4 65.6M201.1 126.4Q302.7 95.4 404.9 65.5"/><path class="s a" d="M405.8 65.5Q401.8 69.6 396.5 72.2M404.5 64.4Q400.3 68.4 396.1 72.8"/><path class="s a" d="M405.6 64.3Q399.3 64.9 394.1 63.3M404.6 64.9Q399.9 63.4 393.9 63.8"/><path class="s a" d="M414.4 37.4Q574.7 39.4 735.0 38.2M414.7 38.2Q574.5 37.0 736.1 38.5"/><path class="s a" d="M733.9 39.0Q735.1 69.2 735.7 100.9M734.0 38.3Q733.8 68.9 733.9 99.0"/><path class="s a" d="M733.9 98.8Q574.7 101.0 414.2 99.0M735.3 99.2Q574.5 100.9 414.4 99.6"/><path class="s a" d="M416.2 99.9Q414.1 69.3 415.0 37.0M415.8 99.2Q413.3 68.8 413.9 39.1"/><text x="430" y="64" text-anchor="start" class="code">cpu.weight = 35</text><text x="430" y="90" text-anchor="start" class="m" style="font-size:18px">a share of CPU when groups compete</text><path class="s r" d="M198.5 220.1Q302.1 187.7 406.5 156.2M198.9 220.9Q302.5 188.3 405.1 155.9"/><path class="s r" d="M405.8 155.6Q401.1 159.3 397.5 163.1M404.8 154.2Q400.4 158.4 396.2 162.2"/><path class="s r" d="M404.9 155.7Q399.6 155.1 394.9 154.2M404.5 154.5Q399.3 154.4 394.3 154.1"/><path class="s r" d="M415.7 127.0Q575.0 129.5 735.4 129.0M414.2 128.7Q575.2 129.1 734.6 128.7"/><path class="s r" d="M736.1 128.5Q733.1 158.9 734.2 189.1M734.2 128.8Q736.7 159.3 736.2 190.4"/><path class="s r" d="M733.8 191.1Q575.0 190.2 415.4 190.1M735.8 189.3Q574.9 188.7 414.4 189.5"/><path class="s r" d="M414.8 189.1Q414.1 158.8 416.0 127.6M414.8 191.0Q414.9 159.4 415.0 128.1"/><text x="430" y="154" text-anchor="start" class="code">cpu.max = 50000 100000</text><text x="430" y="180" text-anchor="start" class="m" style="font-size:18px">50 ms of CPU per 100 ms period</text><path class="s r" d="M199.0 248.4Q301.9 247.5 406.0 244.0M199.4 250.1Q302.8 247.4 405.2 245.9"/><path class="s r" d="M404.6 245.4Q400.6 248.2 395.2 250.1M405.2 245.0Q400.1 246.9 395.2 250.3"/><path class="s r" d="M405.7 245.3Q400.0 242.8 395.6 241.2M405.5 244.4Q399.8 243.5 394.4 240.4"/><path class="s r" d="M415.4 218.7Q574.8 215.9 736.0 217.2M415.9 219.1Q575.2 218.5 734.3 219.1"/><path class="s r" d="M735.8 217.2Q735.4 249.5 734.8 280.0M735.5 216.8Q735.3 248.8 735.1 279.9"/><path class="s r" d="M735.0 279.0Q574.8 282.0 416.2 280.7M733.9 280.7Q574.6 278.0 414.4 279.1"/><path class="s r" d="M414.4 279.2Q415.1 249.3 416.0 218.2M415.5 279.8Q415.4 248.6 414.0 219.1"/><text x="430" y="244" text-anchor="start" class="code">memory.max = 134217728</text><text x="430" y="270" text-anchor="start" class="m" style="font-size:18px">128 MiB hard limit</text><path class="s m2" d="M215.6 159.3Q218.8 163.2 223.3 166.3"/><path class="s m2" d="M227.7 170.3Q232.2 174.0 235.8 176.8"/><path class="s m2" d="M240.7 181.4Q245.4 183.9 248.5 188.5"/><path class="s m2" d="M254.0 191.8Q258.4 195.2 261.5 198.2"/><path class="s m2" d="M267.2 204.2Q270.8 206.9 274.3 210.4"/><path class="s m2" d="M280.2 214.4Q284.3 217.6 288.3 221.5"/><path class="s m2" d="M293.6 225.1Q297.7 228.3 300.9 230.9"/><path class="s m2" d="M306.1 235.5Q310.6 238.8 313.5 243.0"/><path class="s m2" d="M319.2 246.6Q323.0 250.7 327.2 252.8"/><path class="s m2" d="M333.4 257.9Q336.4 261.2 339.9 265.0"/><path class="s m2" d="M345.5 268.7Q349.8 271.2 353.4 274.6"/><path class="s m2" d="M358.1 279.4Q362.3 282.6 365.7 285.2"/><path class="s m2" d="M371.9 290.8Q375.8 293.3 379.8 297.2"/><path class="s m2" d="M385.7 300.7Q388.1 305.1 393.0 307.9"/><path class="s m2" d="M398.2 312.5Q402.4 314.5 405.5 317.4"/><text x="415" y="312" text-anchor="start" style="font-size:18px">memory request → scheduler input</text><text x="415" y="334" text-anchor="start" class="m" style="font-size:16px">no memory protection in this lab's default setup</text></svg><figcaption>The kubelet turns three of the four numbers into cgroup files. The memory request is used by the scheduler and the kubelet instead.</figcaption></figure>

**One process, two points of view.** Find the container's process on the node, then look at it from inside the pod:

```bash
HPID=$(docker exec under-the-hood-worker head -n1 $CDIR/cgroup.procs)
docker exec under-the-hood-worker cat /proc/$HPID/comm /proc/$HPID/cgroup
kubectl -n lab exec follow-me -- cat /proc/1/comm /proc/self/cgroup
```

```
sleep
0::/kubelet.slice/kubelet-kubepods.slice/kubelet-kubepods-burstable.slice/…/cri-containerd-….scope
sleep
0::/
```

It's the same `sleep`. On the node it has an ordinary PID and a long cgroup path. Inside the pod, the PID namespace makes it PID 1 and the cgroup namespace makes its cgroup look like `/` (chapter 7).

*Shortcut:* `make 02-follow-the-pod` and `make 03-requests-and-limits`.

> [!KEY]
> `requests.cpu` → `cpu.weight`, `limits.cpu` → `cpu.max`, `limits.memory` → `memory.max`. The memory request is for scheduling and eviction, not kernel protection.

*Next question: that path was long. What are all those folders?*

---

### 11. Where every pod lives: the cgroup tree

*Question: why is a container's cgroup buried so deep?*

The kubelet doesn't put containers just anywhere. It builds a tree: one box for all pods, a box per **QoS class** (a label Kubernetes gives each pod, Guaranteed, Burstable or BestEffort, based on its requests and limits; chapter 18), a box per pod, and a box per container.

<figure class="sketch "><svg viewBox="0 0 760 420" role="img" aria-label="The kubelet nests cgroups in a tree"><title>The kubelet nests cgroups in a tree</title><path class="s" d="M31.1 30.6Q195.2 30.8 361.0 28.9M31.0 29.1Q195.4 30.0 359.9 29.4"/><path class="s" d="M359.3 29.5Q359.9 57.0 361.0 85.6M360.3 29.1Q361.6 57.2 358.8 85.9"/><path class="s" d="M360.9 84.5Q194.7 86.6 31.1 85.1M360.5 86.1Q194.7 84.7 30.9 84.5"/><path class="s" d="M29.0 84.5Q29.1 57.2 30.2 28.8M30.8 85.0Q30.5 57.3 29.6 30.0"/><text x="42" y="54" text-anchor="start" style="font-size:20px">node</text><text x="42" y="75" text-anchor="start" class="code">/sys/fs/cgroup</text><path class="s b" d="M58.9 105.6Q224.6 106.2 390.8 103.8M58.8 103.9Q224.9 106.2 389.2 106.1"/><path class="s b" d="M391.1 104.6Q391.4 132.9 389.7 160.1M390.7 105.9Q388.6 132.7 388.9 161.1"/><path class="s b" d="M391.0 159.6Q224.8 161.7 61.0 160.1M389.0 159.2Q224.8 160.4 60.5 161.2"/><path class="s b" d="M60.1 159.8Q58.3 133.0 59.4 105.2M58.9 161.0Q61.2 132.4 58.9 105.0"/><text x="72" y="129" text-anchor="start" style="font-size:20px">all pods</text><text x="72" y="150" text-anchor="start" class="code">kubepods.slice</text><text x="408" y="139" text-anchor="start" class="m" style="font-size:17px">memory.max ≈ allocatable</text><path class="s m2" d="M44.5 85.2Q43.2 108.6 44.3 131.5M43.8 84.9Q44.0 108.7 44.6 132.4"/><path class="s m2" d="M44.7 131.9Q50.9 133.2 57.3 131.7M45.5 132.4Q50.8 131.7 58.0 131.5"/><path class="s m2" d="M58.6 131.8Q54.7 134.8 51.3 135.9M57.8 132.3Q54.3 133.5 50.4 135.5"/><path class="s m2" d="M58.7 132.2Q54.8 129.6 50.9 127.7M57.9 132.5Q54.3 130.3 51.0 129.0"/><path class="s a" d="M90.8 179.6Q255.1 179.6 420.8 180.9M90.0 180.1Q255.5 181.2 419.2 180.8"/><path class="s a" d="M420.5 180.6Q418.3 207.7 419.2 235.7M420.3 180.7Q419.8 207.4 420.3 235.5"/><path class="s a" d="M420.4 234.3Q254.7 236.8 90.4 235.3M418.9 234.1Q255.0 236.5 89.6 234.2"/><path class="s a" d="M89.7 235.3Q88.4 207.5 90.2 179.4M89.5 234.8Q91.1 207.4 89.1 180.8"/><text x="102" y="204" text-anchor="start" style="font-size:20px">QoS class</text><text x="102" y="225" text-anchor="start" class="code">kubepods-burstable.slice</text><path class="s m2" d="M73.5 160.1Q74.0 183.6 73.8 207.1M74.4 160.2Q73.3 183.5 73.8 206.6"/><path class="s m2" d="M75.5 207.3Q81.1 207.8 87.5 208.3M74.4 205.9Q80.5 205.8 88.4 208.3"/><path class="s m2" d="M87.7 207.8Q84.5 208.8 80.6 211.2M88.8 207.0Q84.0 207.7 80.7 210.2"/><path class="s m2" d="M88.0 206.4Q84.9 204.1 81.0 203.4M87.2 207.1Q84.4 205.9 80.4 204.2"/><path class="s y" d="M119.2 256.2Q284.8 255.9 449.5 255.3M120.6 254.1Q285.1 255.0 450.6 254.5"/><path class="s y" d="M450.1 254.9Q449.7 282.3 449.7 310.6M449.9 256.0Q449.2 282.3 450.9 310.1"/><path class="s y" d="M450.2 310.5Q285.3 311.8 120.3 310.0M450.8 309.3Q284.9 308.3 119.5 310.8"/><path class="s y" d="M119.8 309.5Q118.7 282.7 120.7 256.0M120.0 309.6Q118.6 282.5 119.2 255.2"/><text x="132" y="279" text-anchor="start" style="font-size:20px">one pod</text><text x="132" y="300" text-anchor="start" class="code">…-burstable-pod&lt;uid&gt;.slice</text><text x="468" y="289" text-anchor="start" class="m" style="font-size:17px">cpu.max, memory.max</text><path class="s m2" d="M104.4 235.4Q103.2 258.4 104.2 281.4M104.2 234.5Q103.8 258.7 104.4 281.7"/><path class="s m2" d="M102.8 281.3Q111.6 282.6 119.3 280.9M104.4 280.5Q110.9 281.8 116.7 281.6"/><path class="s m2" d="M118.4 282.6Q114.5 284.7 110.2 285.4M118.7 281.8Q114.6 284.1 110.1 285.8"/><path class="s m2" d="M118.7 282.1Q114.1 281.0 111.0 278.1M118.0 281.4Q114.3 280.3 110.4 278.3"/><path class="s r" d="M150.4 329.0Q314.7 331.1 480.4 329.0M150.9 330.0Q315.1 328.3 479.6 330.7"/><path class="s r" d="M479.2 331.1Q482.0 357.1 480.4 384.3M480.8 329.1Q481.9 357.7 480.3 384.7"/><path class="s r" d="M479.6 384.7Q314.8 386.1 149.1 385.8M480.8 385.0Q315.3 384.4 150.2 385.2"/><path class="s r" d="M148.9 384.3Q150.8 357.1 148.9 330.9M149.9 385.9Q150.2 357.0 150.3 329.8"/><text x="162" y="354" text-anchor="start" style="font-size:20px">one container</text><text x="162" y="375" text-anchor="start" class="code">cri-containerd-&lt;id&gt;.scope</text><text x="498" y="364" text-anchor="start" class="m" style="font-size:17px">cpu.max, memory.max, cpu.weight</text><path class="s m2" d="M133.6 309.8Q133.9 333.3 133.9 357.5M133.6 309.7Q134.5 333.4 133.7 357.0"/><path class="s m2" d="M135.4 357.6Q141.5 355.6 148.6 356.9M133.3 357.6Q140.5 358.4 148.7 355.9"/><path class="s m2" d="M147.3 356.8Q144.4 359.2 141.6 360.3M148.4 357.3Q144.6 359.0 140.3 360.1"/><path class="s m2" d="M147.9 357.8Q144.9 355.0 140.0 352.8M148.1 357.8Q144.6 354.4 140.8 353.3"/></svg><figcaption>A child is also subject to any limits set on its parents. In this example, the limits sit on the pod and the container.</figcaption></figure>

Nesting matters because **anything in a box is also subject to the limits on the boxes around it.** A container can't go past its pod's limit, and all pods together can't go past the ceiling on the top box. (Not every box sets a limit; the QoS boxes usually don't.)

**Try it yourself.** List the box that holds every pod on the worker:

```bash
docker exec under-the-hood-worker ls /sys/fs/cgroup/kubelet.slice/kubelet-kubepods.slice/
docker exec under-the-hood-worker cat /sys/fs/cgroup/kubelet.slice/kubelet-kubepods.slice/memory.max
```

You'll see `kubelet-kubepods-burstable.slice` and `kubelet-kubepods-besteffort.slice` among the files, and a `memory.max` of `8321515520` on my machine: about 7.75 GiB, the most that all pods together may use. Chapter 18 explains where that number comes from.

On GKE, EKS and most other clusters, the tree is the same but starts at `/sys/fs/cgroup/kubepods.slice`, without the `kubelet-` prefix (that's a kind detail).

*Shortcut:* `make 00-setup` prints this tree and checks the node is on cgroups v2.

> [!KEY]
> cgroups nest, and a child is also subject to the limits set on its parents.

*Next question: we know where `cpu.weight` and `cpu.max` live. What does the kernel actually do with them?*

---

## Part 4: CPU

### 12. How Linux shares a CPU

*Question: when more threads want to run than there are cores, who goes next?*

This is the part most posts skip, and it's what makes CPU requests and limits make sense.

A core runs one thread at a time (chapter 1). Every thread that's ready to run waits in a queue, and the kernel's scheduler keeps picking the next one. The rule it uses is simple to state: **keep a running tally of how much CPU each thread has had, and give the next turn to whoever has had the least.**

<figure class="sketch "><svg viewBox="0 0 760 300" role="img" aria-label="How the kernel shares CPU fairly"><title>How the kernel shares CPU fairly</title><defs><clipPath id="cfs1"><rect x="60" y="60" width="210" height="32"/></clipPath><clipPath id="cfs2"><rect x="60" y="110" width="130" height="32"/></clipPath><clipPath id="cfs3"><rect x="60" y="160" width="60" height="32"/></clipPath><clipPath id="cfs4"><rect x="60" y="210" width="170" height="32"/></clipPath></defs><text x="20" y="32" text-anchor="start" style="font-size:20px">the kernel's tally of CPU each thread has had (virtual runtime)</text><text x="50" y="85" text-anchor="end" style="font-size:18px">thread A</text><path class="h y" clip-path="url(#cfs1)" d="M31.8 93.6Q46.1 76.3 60.5 58.0M40.2 94.9Q53.4 75.5 68.2 58.3M47.1 93.5Q60.9 76.1 76.5 57.6M55.8 94.5Q71.0 76.4 83.8 57.8M63.5 94.8Q76.2 74.5 92.8 57.8M71.3 94.3Q84.0 75.4 97.7 58.0M77.9 94.4Q92.1 75.7 107.0 58.3M86.4 95.0Q101.8 76.8 113.7 58.6M96.4 94.5Q110.5 76.8 124.1 57.2M104.6 94.2Q118.1 76.3 131.4 58.0M110.4 95.0Q124.0 75.3 140.2 58.2M117.6 94.0Q132.3 76.1 145.3 57.5M126.6 94.5Q140.1 76.0 153.8 57.0M134.1 93.3Q145.9 75.0 160.0 58.3M142.0 94.7Q153.7 74.9 170.0 58.1M150.9 94.4Q163.7 75.6 178.2 59.1M157.6 95.1Q171.9 76.0 186.0 57.1M167.1 93.0Q181.2 76.4 194.6 57.7M175.4 93.9Q188.4 75.7 201.9 58.2M183.8 92.9Q195.8 74.7 211.8 58.1M190.4 93.7Q205.0 76.0 219.3 58.3M197.7 94.0Q213.4 76.5 225.9 58.8M206.3 95.0Q220.9 75.9 233.8 56.9M214.3 95.1Q227.3 75.3 242.0 59.1M224.6 93.9Q237.9 75.7 251.0 59.0M230.6 94.3Q243.6 75.3 258.2 58.8M239.7 93.9Q254.1 76.1 269.3 59.1M249.5 94.2Q262.0 76.4 275.6 57.1M255.6 92.8Q271.3 76.8 283.6 57.5M263.9 93.3Q276.6 75.7 291.6 57.2"/><path class="s y" d="M61.3 60.5Q164.7 58.0 268.8 60.3M59.2 61.0Q165.6 61.4 270.6 61.3"/><path class="s y" d="M269.1 59.2Q271.4 76.0 268.7 93.3M269.2 59.5Q271.3 75.7 271.1 90.6"/><path class="s y" d="M270.4 93.2Q164.8 92.5 60.4 93.1M268.6 92.1Q165.4 89.4 59.0 91.6"/><path class="s y" d="M60.9 91.1Q60.1 76.3 60.2 59.9M60.7 91.6Q60.1 76.3 58.7 60.3"/><text x="50" y="135" text-anchor="end" style="font-size:18px">thread B</text><path class="h y" clip-path="url(#cfs2)" d="M31.2 143.9Q45.2 125.0 61.1 108.3M38.7 145.1Q54.7 127.2 68.5 108.8M47.6 143.4Q61.2 126.3 76.2 107.8M56.7 143.9Q71.4 126.7 84.9 107.7M62.1 144.0Q76.5 125.0 92.2 107.3M71.3 143.0Q87.2 126.9 98.7 107.3M79.8 144.7Q94.3 126.0 107.9 108.0M88.0 143.0Q101.0 125.3 116.8 107.6M95.9 142.8Q109.0 125.7 125.3 107.8M104.3 144.4Q117.7 126.8 131.8 107.6M111.3 144.1Q127.3 126.6 140.5 108.7M122.1 143.3Q134.7 125.6 148.1 107.3M129.7 143.2Q143.4 125.0 159.0 107.0M137.2 144.9Q151.8 126.3 164.3 108.1M144.3 142.8Q158.5 125.9 171.8 108.6M151.8 145.1Q164.9 125.3 180.4 107.0M159.5 144.3Q174.9 126.7 188.2 108.9M167.4 142.8Q181.5 126.0 194.5 109.1M176.0 143.5Q190.0 126.6 203.8 106.8M183.9 144.8Q198.0 127.1 210.9 107.3"/><path class="s y" d="M59.0 110.4Q124.7 109.6 189.9 109.9M60.6 111.0Q125.0 110.6 189.2 110.0"/><path class="s y" d="M188.5 108.7Q189.5 126.4 191.0 141.7M190.8 109.7Q190.8 125.6 191.0 141.9"/><path class="s y" d="M188.7 142.0Q124.4 139.9 59.2 141.7M190.1 140.7Q124.7 139.9 60.1 141.4"/><path class="s y" d="M61.4 140.7Q62.1 126.0 58.5 109.7M61.0 141.7Q61.8 126.6 60.9 110.8"/><text x="50" y="185" text-anchor="end" style="font-size:18px">thread C</text><path class="h g" clip-path="url(#cfs3)" d="M31.4 192.9Q46.4 176.2 59.3 158.7M39.4 193.1Q53.6 175.3 68.8 157.4M48.5 193.0Q61.5 176.5 74.8 158.8M55.3 193.8Q69.1 175.5 83.5 158.6M64.9 193.5Q77.0 175.0 91.7 157.4M72.5 193.4Q84.8 175.1 98.9 158.5M81.4 193.9Q93.8 175.8 108.9 158.2M90.2 193.5Q104.1 176.9 116.4 158.8M97.0 193.0Q110.5 176.7 123.7 157.0M105.7 194.0Q119.5 176.7 132.7 158.4M113.6 194.7Q128.4 176.8 141.3 157.6"/><path class="s g" d="M58.6 161.2Q89.6 160.6 119.2 159.4M58.6 159.9Q89.9 161.9 120.2 160.1"/><path class="s g" d="M118.8 160.8Q119.9 175.4 119.7 193.3M120.7 161.2Q119.2 176.2 118.7 191.8"/><path class="s g" d="M121.0 190.7Q90.3 193.7 61.1 190.8M118.7 193.1Q89.7 193.7 61.5 192.5"/><path class="s g" d="M59.9 192.1Q59.9 175.7 60.8 159.6M58.7 191.9Q60.1 176.3 59.5 159.2"/><text x="50" y="235" text-anchor="end" style="font-size:18px">thread D</text><path class="h y" clip-path="url(#cfs4)" d="M31.4 243.5Q45.9 226.1 59.3 208.4M38.6 244.8Q54.3 226.4 67.6 207.8M47.3 244.2Q61.0 226.8 74.3 208.8M55.7 244.4Q68.3 225.8 83.2 207.3M62.8 244.2Q77.4 226.5 92.5 209.1M70.6 243.0Q87.1 226.9 100.3 206.8M78.4 243.5Q92.7 225.5 107.6 207.3M88.0 243.6Q100.4 225.2 114.3 209.1M93.4 245.1Q108.9 226.2 123.3 207.2M103.5 244.0Q116.9 226.4 131.1 208.3M110.4 245.1Q124.3 225.0 139.6 207.0M118.4 244.7Q134.9 227.5 147.3 207.0M126.2 245.2Q141.5 226.9 155.2 208.0M135.0 244.0Q149.8 227.1 162.4 207.4M141.8 243.8Q155.8 225.5 170.7 207.5M151.5 245.2Q165.8 227.0 177.2 207.5M159.8 243.0Q173.0 226.1 187.9 207.1M167.2 243.4Q181.6 226.1 194.9 207.3M175.2 243.2Q188.8 226.4 202.5 208.0M183.1 244.2Q196.4 226.4 209.5 209.0M189.9 242.9Q202.3 225.0 217.5 206.8M197.6 243.2Q211.7 226.4 225.3 207.2M205.9 244.3Q219.3 226.1 234.1 209.2M211.9 243.8Q226.3 225.7 240.3 207.2M220.9 244.2Q234.3 226.0 250.1 208.7M228.0 244.7Q241.5 225.6 257.3 206.9"/><path class="s y" d="M60.5 210.6Q144.5 210.5 229.1 211.0M59.4 209.0Q144.7 211.9 230.7 209.3"/><path class="s y" d="M228.7 210.7Q229.7 225.7 231.4 243.1M230.4 210.1Q228.7 226.1 231.4 242.5"/><path class="s y" d="M229.3 241.7Q144.5 243.5 60.4 242.3M229.0 241.1Q145.4 241.2 58.7 241.1"/><path class="s y" d="M60.8 241.1Q58.5 226.1 60.8 211.0M60.8 243.4Q59.5 226.1 59.3 209.4"/><text x="160" y="183" text-anchor="start" class="g" style="font-size:19px">← had the least: runs next</text><path class="s b" d="M468.9 68.9Q605.5 68.8 738.8 69.6M469.4 70.3Q605.6 72.7 740.2 68.8"/><path class="s b" d="M740.5 70.9Q739.5 154.8 739.4 239.2M741.5 69.1Q740.4 155.2 739.2 238.6"/><path class="s b" d="M740.1 240.6Q604.9 240.5 471.5 238.7M739.6 239.2Q604.9 238.5 470.4 241.3"/><path class="s b" d="M469.9 238.4Q467.3 155.5 470.1 71.4M470.6 240.1Q470.1 154.5 470.6 68.5"/><text x="605" y="100" text-anchor="middle" class="big" style="font-size:20px">weight changes the speed</text><text x="605" y="135" text-anchor="middle" style="font-size:18px">weight 100: 10 ms run = +10</text><text x="605" y="165" text-anchor="middle" style="font-size:18px">weight 200: 10 ms run = +5</text><text x="605" y="200" text-anchor="middle" class="m" style="font-size:16px">heavier threads fill up slower,</text><text x="605" y="222" text-anchor="middle" class="m" style="font-size:16px">so they win more turns</text><text x="20" y="285" text-anchor="start" class="m" style="font-size:16px">cgroups are scheduled the same way: each cgroup competes with its siblings using cpu.weight</text></svg><figcaption>Whoever has had the least CPU goes next. Weight decides how fast your tally fills up.</figcaption></figure>

That tally is called **virtual runtime**, and the word *virtual* is where weights come in. A thread with a higher weight has its tally grow more slowly. Run it for 10 ms with double the weight, and its tally only goes up by 5. So it keeps coming out as "had the least" more often, and ends up with roughly twice the CPU. Weight doesn't reserve anything; it just changes how fast your tally fills up.

cgroups plug straight into this. A cgroup is scheduled like one big thread with its own weight (`cpu.weight`), competing with its sibling cgroups. Whatever time the cgroup wins is then shared out among the threads inside it, the same way. That's how a pod's request turns into a share of the node's CPU.

There are two separate mechanisms, and they map neatly onto requests and limits:

| Mechanism | File | Comes from | When it matters |
|---|---|---|---|
| **Weight** (sharing) | `cpu.weight` | `requests.cpu` | Only when cgroups compete for the same CPUs |
| **Bandwidth** (capping) | `cpu.max` | `limits.cpu` | Always, even on an idle node |

Chapter 13 is about the first, chapter 14 about the second.

> [!DEEPER]
> **CFS or EEVDF?**
>
> For years this scheduler was called **CFS**, the Completely Fair Scheduler, and most articles still use that name. Since Linux 6.6 (2023) it has been replaced by **EEVDF** ("earliest eligible virtual deadline first"), which keeps the same weighted fairness but adds deadlines so short, latency-sensitive tasks get their turn sooner. For everything in this post nothing changes: `cpu.weight`, `cpu.max` and throttling work the same way under both. The old name lives on in places like the metric `container_cpu_cfs_throttled_periods_total`.

> [!KEY]
> The kernel gives the next turn to whoever has had the least CPU, and weight makes your tally fill up more slowly.

---

### 13. CPU requests become weights

*Question: what does a CPU request actually get you?*

A request does **not** reserve a core. When the node is quiet it does nothing at all: anyone can use spare CPU. It only matters when everyone is hungry at once, and then the kernel cuts the pizza in proportion to each group's `cpu.weight`.

<figure class="sketch anim"><svg viewBox="0 0 760 250" role="img" aria-label="CPU requests influence how contended CPU is shared"><title>CPU requests influence how contended CPU is shared</title><defs><clipPath id="cwt1"><rect x="180" y="65" width="62" height="40"/></clipPath><clipPath id="cwt2"><rect x="180" y="135" width="508" height="40"/></clipPath></defs><text x="20" y="32" text-anchor="start" style="font-size:22px">A request influences your CPU share when groups compete</text><text x="20" y="90" text-anchor="start" style="font-size:20px">request 100m</text><text x="20" y="160" text-anchor="start" style="font-size:20px">request 800m</text><g class="anim-grow"><path class="h a" clip-path="url(#cwt1)" d="M146.1 106.2Q162.1 84.6 179.4 62.2M150.0 106.5Q168.4 85.6 185.3 63.8M157.8 107.7Q172.6 83.5 192.4 63.8M164.2 107.0Q182.4 85.8 198.8 63.2M168.3 107.8Q186.2 84.5 204.7 64.2M176.1 106.9Q193.4 84.8 209.6 62.3M181.4 106.1Q198.3 84.5 216.4 62.4M187.5 108.1Q203.5 83.9 221.6 63.5M194.8 107.3Q209.7 84.2 228.0 62.8M201.6 106.7Q219.6 85.6 236.0 62.1M208.0 107.2Q225.6 85.0 242.7 62.7M214.6 106.1Q230.9 84.3 248.3 62.0M220.3 106.6Q238.0 84.7 254.2 61.8M227.7 106.0Q243.5 83.9 262.1 62.7M235.2 107.0Q249.8 83.8 268.8 63.4M240.3 106.4Q255.7 84.3 274.9 63.8"/><path class="s a" d="M179.3 64.1Q210.8 65.1 241.5 63.5M180.3 63.4Q210.5 64.9 242.9 64.0"/><path class="s a" d="M241.3 64.8Q242.1 84.8 240.8 106.2M241.4 64.6Q243.8 84.6 240.5 103.8"/><path class="s a" d="M243.6 103.5Q210.9 106.1 180.1 103.8M242.1 103.8Q210.8 104.1 178.4 104.2"/><path class="s a" d="M179.6 104.5Q180.9 85.0 181.0 64.1M180.1 106.3Q181.0 85.6 179.8 65.2"/></g><g class="anim-grow d2"><path class="h b" clip-path="url(#cwt2)" d="M144.3 176.1Q163.3 155.7 180.1 133.7M150.3 175.9Q168.5 154.3 184.9 133.5M157.3 176.8Q174.9 156.0 191.6 133.8M162.5 178.2Q179.9 154.1 197.6 132.4M168.9 176.6Q186.3 154.4 205.3 132.4M176.8 177.0Q194.6 156.3 210.4 132.9M183.0 176.3Q200.2 155.0 218.0 131.9M189.2 177.9Q205.7 154.3 224.4 133.1M196.2 178.1Q213.1 154.5 230.0 133.9M201.6 178.0Q219.7 155.4 235.8 133.0M207.7 177.6Q224.5 153.9 242.2 132.3M213.5 176.0Q230.9 155.9 248.7 134.0M220.0 177.2Q238.1 156.0 253.8 132.1M226.3 177.0Q243.3 155.4 261.5 133.9M231.6 178.0Q250.1 155.8 266.4 134.1M237.2 176.0Q255.8 155.6 272.2 132.8M243.9 177.2Q262.8 155.6 279.5 132.0M250.6 176.3Q265.7 154.0 285.3 132.5M254.0 176.0Q273.3 155.8 289.4 132.3M259.6 177.2Q276.4 153.4 295.9 133.4M265.8 175.9Q284.9 155.8 301.7 133.0M272.5 176.8Q290.6 155.9 306.9 132.5M279.4 176.0Q296.8 154.9 314.0 132.2M284.9 176.5Q304.1 156.4 319.4 132.9M291.3 176.4Q308.9 155.4 325.2 132.7M296.5 177.8Q313.9 155.5 330.4 132.8M300.2 178.0Q317.0 153.6 334.7 132.7M307.7 177.3Q325.3 155.8 343.4 133.7M314.5 177.3Q332.0 155.7 348.2 131.8M320.5 176.8Q337.2 154.4 355.9 133.2M327.1 177.5Q344.6 155.7 361.8 133.9M332.4 177.0Q349.8 154.9 368.3 131.9M337.5 177.7Q356.3 155.9 372.9 133.2M343.5 176.8Q360.8 155.0 377.1 133.5M350.2 176.1Q367.5 155.4 385.2 132.0M356.3 177.0Q373.8 155.6 389.9 133.7M363.5 177.9Q378.7 154.3 397.2 131.9M370.3 176.2Q385.9 154.3 404.6 133.5M375.3 177.4Q391.6 155.3 409.0 133.2M378.6 177.1Q396.6 155.1 413.7 133.2M385.7 177.4Q400.9 154.1 420.8 132.1M390.4 177.1Q408.5 155.0 426.5 133.5M396.4 177.3Q413.5 154.0 431.4 132.5M402.5 177.4Q420.9 155.5 438.6 132.4M409.6 177.7Q426.6 154.7 444.6 131.8M416.0 177.5Q433.7 154.9 450.3 132.1M421.9 176.7Q439.7 155.2 457.9 133.4M429.6 177.5Q446.1 154.6 464.4 133.5M437.5 177.6Q453.7 154.5 472.2 133.9M441.8 177.2Q461.2 156.1 478.0 132.5M449.6 176.7Q466.2 154.5 483.1 132.5M455.3 177.3Q473.8 154.9 490.4 132.1M461.4 176.2Q480.0 155.8 496.9 133.7M468.2 178.1Q487.1 156.0 502.8 132.2M476.4 177.0Q493.9 155.4 509.6 132.0M483.5 177.8Q498.3 153.8 518.1 133.3M488.7 176.0Q505.4 156.0 522.9 132.4M492.9 176.0Q511.2 155.7 527.4 133.4M498.8 176.6Q516.1 153.7 533.5 132.0M504.9 177.4Q522.6 154.8 541.7 132.9M510.9 176.5Q528.6 154.7 546.9 133.0M517.6 177.3Q533.4 154.0 551.9 132.7M522.0 176.3Q540.1 155.2 558.7 134.0M528.7 177.8Q547.7 156.1 564.1 133.0M535.5 176.9Q552.2 154.6 570.1 132.3M540.7 176.6Q560.0 155.7 576.8 132.4M545.9 177.4Q563.0 154.2 582.4 132.4M552.3 176.9Q569.3 154.8 586.6 132.8M556.1 177.8Q573.5 154.2 590.8 132.8M563.6 176.6Q579.3 154.7 597.4 132.8M568.4 176.9Q584.9 154.7 602.0 133.9M574.1 176.9Q590.9 154.4 609.5 133.6M580.0 177.9Q597.0 155.0 614.5 132.8M585.5 176.0Q601.7 154.9 619.4 132.8M591.8 178.1Q610.7 155.6 626.5 133.4M598.2 177.6Q614.4 155.3 631.4 133.9M603.4 176.4Q619.9 154.0 639.3 132.3M608.8 176.1Q625.9 154.3 645.7 134.0M616.2 176.9Q632.6 154.7 651.2 132.0M622.5 177.9Q640.7 155.9 656.6 132.1M625.9 178.1Q644.7 155.4 661.2 133.3M632.8 176.0Q649.9 154.7 667.2 131.9M641.1 176.9Q656.9 154.4 674.2 132.0M645.3 177.3Q664.4 155.9 681.5 134.1M651.4 177.0Q670.0 156.1 685.8 132.7M656.7 176.9Q674.7 154.6 693.4 133.8M664.0 176.6Q680.2 155.2 696.6 133.1M668.6 176.3Q686.8 155.0 703.9 133.6M676.1 177.2Q691.8 155.1 710.2 132.6M680.7 177.4Q696.4 154.3 715.9 132.8M686.2 177.7Q703.1 154.6 721.9 131.9"/><path class="s b" d="M179.8 135.5Q434.3 134.5 687.3 135.5M181.2 135.0Q433.9 132.9 688.5 135.5"/><path class="s b" d="M686.8 136.2Q687.4 154.8 688.9 175.5M688.1 134.9Q686.9 154.6 688.5 176.2"/><path class="s b" d="M689.2 175.2Q433.8 175.8 180.3 176.3M686.7 175.2Q433.4 173.5 180.0 176.5"/><path class="s b" d="M179.9 174.9Q178.5 155.6 179.8 134.3M180.0 176.6Q178.4 154.6 181.5 134.4"/></g><text x="255" y="92" text-anchor="start" class="m" style="font-size:18px">≈ 1 part</text><text x="700" y="210" text-anchor="end" class="m" style="font-size:18px">≈ 8 parts</text><text x="20" y="238" text-anchor="start" class="m" style="font-size:16px">observed in one lab run on a 10-CPU node: 8.2x · results vary with what else is competing</text></svg><figcaption>A CPU request isn't a reserved core. It's your slice of the pizza when everyone is hungry.</figcaption></figure>

**Try it yourself.** Start two greedy pods with no CPU limits. Each runs one busy loop per CPU on the node, so together they want twice what exists. `weight-low` requests `100m`, `weight-high` requests `800m`:

```bash
THREADS=$(docker exec under-the-hood-worker nproc)
sed "s/__THREADS__/$THREADS/g" modules/04-cpu-weight/pods.yaml | kubectl -n lab apply -f -
kubectl -n lab wait --for=condition=Ready pod/weight-low pod/weight-high
kubectl -n lab exec weight-low  -- cat /sys/fs/cgroup/cpu.weight
kubectl -n lab exec weight-high -- cat /sys/fs/cgroup/cpu.weight
```

```
17
84
```

<details class="predict"><summary><span class="predict-tag">Predict first</span> Both pods want every CPU on the node. One requests <code>100m</code>, the other <code>800m</code>. How will the CPU be split?</summary><div class="predict-answer"><p>Neither pod is capped, so neither gets "its request". They split the node by weight, and the bigger request takes most of the CPU. Measure it below.</p></div></details>

To see who actually wins, compare `usage_usec` for both pods over 10 seconds:

```bash
for p in weight-low weight-high; do kubectl -n lab exec $p -- grep usage_usec /sys/fs/cgroup/cpu.stat; done
sleep 10
for p in weight-low weight-high; do kubectl -n lab exec $p -- grep usage_usec /sys/fs/cgroup/cpu.stat; done
```

Subtract the first number from the second for each pod and divide by 10,000 to get millicores. On my 10-CPU setup the bigger request got between **8.0 and 8.8 times** more CPU across runs (8966m vs 1013m in the latest). That's close to the 8× ratio of the requests, but not to 84 ÷ 17, which is only about 4.9. The next box explains why. Either way, treat it as a measurement, not a guarantee: the real split also depends on whatever else is competing on the node.

> [!DEEPER]
> **Where do 17 and 84 come from?**
>
> Your request goes through two conversions:
>
> 1. The kubelet turns millicores into **CPU shares**, the unit from cgroups v1: `shares = millicores × 1024 / 1000`. So 100m is 102 shares, 250m is 256, 800m is 819. (That's the `shares: 256` from chapter 10.)
> 2. The runtime (runc or crun) turns shares into a cgroup v2 **weight**.
>
> Step 2 changed recently. Older runtimes used a straight line, `weight = 1 + (shares − 2) × 9999 / 262142`, which you'll still find in many blog posts. It had a real problem: a pod requesting a whole CPU got a weight of only 39, while ordinary system services get the default of 100, so Kubernetes workloads lost out whenever the node was busy. Newer runtimes (runc 1.3.2+, crun 1.23+) use a curve instead, chosen so that one CPU lands at about 100.
>
> | Request | Shares | Old formula | New formula | Measured in the lab |
> |---|---|---|---|---|
> | 100m | 102 | 4 | **17** | 17 |
> | 250m | 256 | 10 | **35** | 35 |
> | 800m | 819 | 32 | **84** | 84 |
> | 2 | 2048 | 79 | **174** | – |
>
> If your numbers match the "old" column, your node's runtime is older. Either way, what decides the split is the *ratio* between the groups that are competing.

> [!DEEPER]
> **Why 8× and not 84 ÷ 17?**
>
> Remember the tree from chapter 11: each container sits inside its pod's cgroup. Each pod here has one busy container, so the competition actually happens one level up, between the two **pod** cgroups. Their `cpu.weight` is set by the kubelet itself, not the runtime, and on this node it still uses the old straight-line formula:
>
> ```bash
> for p in weight-low weight-high; do
>   echo "$p pod cgroup: $(docker exec under-the-hood-worker cat $(./scripts/pod-cgroup.sh $p)/cpu.weight)"
> done
> ```
>
> ```
> weight-low pod cgroup: 4
> weight-high pod cgroup: 32
> ```
>
> 4 and 32 are exactly the "old formula" column above, and 32 ÷ 4 = 8. The containers' own weights, 17 and 84, only decide how CPU is shared between containers *inside the same pod*. So when you want to know how pods split a busy node, read the pod cgroup's `cpu.weight`, not the container's.

*Shortcut:* `make 04-cpu-weight` measures the split and prints both formulas next to your node's real values.

> [!KEY]
> A CPU request is your share of CPU when groups compete. When CPUs are idle, it does nothing.

*Next question: if requests only share, what do limits do?*

---

### 14. CPU limits become a budget: throttling

*Question: what happens when a container hits its CPU limit?*

A limit is a different mechanism altogether: not a share, but a hard budget. Think of `cpu.max` as a **wallet that's refilled every 100 milliseconds**. With `limits.cpu: 200m`, the wallet gets 20 ms of CPU time per 100 ms *period*. Spend it early, and you wait until the next refill, even if the machine has nine idle CPUs.

<figure class="sketch anim"><svg viewBox="0 0 760 330" role="img" aria-label="Four threads share one CPU quota per period"><title>Four threads share one CPU quota per period</title><defs><clipPath id="cth1"><rect x="120" y="75" width="14.5" height="30"/></clipPath><clipPath id="cth2"><rect x="134.5" y="75" width="275.5" height="30"/></clipPath><clipPath id="cth3"><rect x="120" y="117" width="14.5" height="30"/></clipPath><clipPath id="cth4"><rect x="134.5" y="117" width="275.5" height="30"/></clipPath><clipPath id="cth5"><rect x="120" y="159" width="14.5" height="30"/></clipPath><clipPath id="cth6"><rect x="134.5" y="159" width="275.5" height="30"/></clipPath><clipPath id="cth7"><rect x="120" y="201" width="14.5" height="30"/></clipPath><clipPath id="cth8"><rect x="134.5" y="201" width="275.5" height="30"/></clipPath><clipPath id="cth9"><rect x="430" y="75" width="14.5" height="30"/></clipPath><clipPath id="cth10"><rect x="444.5" y="75" width="275.5" height="30"/></clipPath><clipPath id="cth11"><rect x="430" y="117" width="14.5" height="30"/></clipPath><clipPath id="cth12"><rect x="444.5" y="117" width="275.5" height="30"/></clipPath><clipPath id="cth13"><rect x="430" y="159" width="14.5" height="30"/></clipPath><clipPath id="cth14"><rect x="444.5" y="159" width="275.5" height="30"/></clipPath><clipPath id="cth15"><rect x="430" y="201" width="14.5" height="30"/></clipPath><clipPath id="cth16"><rect x="444.5" y="201" width="275.5" height="30"/></clipPath></defs><text x="20" y="30" text-anchor="start" style="font-size:21px">limits.cpu: 200m → cpu.max = 20000 100000: 20 ms of CPU time per period</text><text x="265.0" y="62" text-anchor="middle" class="m" style="font-size:17px">period 1: 100 ms (the default)</text><path class="h g" clip-path="url(#cth1)" d="M94.8 105.8Q106.7 89.6 120.0 74.0M97.8 107.5Q111.4 89.7 124.0 73.5M103.4 107.2Q114.3 89.4 129.1 72.7M108.4 106.8Q119.6 89.3 133.0 72.4M113.2 107.9Q125.0 89.2 137.3 72.7M116.4 107.2Q128.9 89.3 142.5 73.2M123.2 105.8Q134.8 88.9 148.2 73.0M127.9 107.2Q141.6 90.0 154.2 73.3"/><path class="s g" d="M118.9 74.3Q127.3 74.0 136.1 76.6M119.2 75.4Q127.5 74.6 133.0 74.6"/><path class="s g" d="M133.2 74.5Q134.1 90.4 135.7 105.3M134.7 73.5Q134.5 90.6 135.5 104.5"/><path class="s g" d="M133.9 103.7Q126.9 105.1 120.4 103.7M135.5 105.0Q126.6 104.6 120.7 104.2"/><path class="s g" d="M121.5 104.7Q120.7 89.7 119.6 76.2M121.1 104.2Q119.8 89.6 118.6 76.5"/><path class="h r" clip-path="url(#cth2)" d="M108.7 105.8Q120.9 89.7 133.4 72.3M118.3 107.1Q133.0 90.1 144.4 72.0M130.8 107.6Q143.5 90.4 156.1 73.9M140.6 106.0Q154.6 90.9 165.6 73.1M150.3 105.8Q164.0 90.6 176.3 72.9M163.2 107.1Q174.5 89.7 189.3 71.9M174.2 108.0Q188.3 90.9 199.1 73.3M184.2 107.5Q197.9 89.8 211.2 73.0M197.4 106.4Q208.3 88.9 223.3 73.6M208.0 107.4Q221.4 90.9 233.6 72.0M217.7 106.9Q231.1 89.8 244.3 71.9M230.7 107.2Q242.5 89.2 256.9 74.2M242.0 106.3Q253.0 88.9 266.7 72.1M252.1 106.9Q266.3 90.9 277.7 72.7M262.1 106.9Q274.8 89.4 290.0 71.9M273.9 107.3Q286.5 90.4 298.4 71.9M284.3 108.0Q296.3 90.0 310.7 73.9M294.8 107.3Q309.4 90.9 321.5 72.6M307.0 107.3Q319.5 89.6 333.3 72.9M317.6 106.3Q330.0 89.5 344.0 73.4M328.0 107.6Q341.0 90.2 354.7 73.6M338.3 106.9Q351.2 89.6 365.1 72.6M349.3 107.1Q362.5 90.2 374.9 71.8M360.7 107.8Q373.0 88.6 388.9 73.4M372.9 106.7Q386.6 90.5 398.0 72.6M383.4 105.8Q395.4 89.6 409.7 71.8M394.8 106.5Q408.5 91.2 419.4 72.9M405.2 107.2Q417.6 89.6 431.7 74.0"/><path class="s r" d="M133.2 73.8Q272.6 73.6 409.1 75.1M135.1 74.8Q271.9 76.7 411.1 76.6"/><path class="s r" d="M408.6 76.0Q408.9 90.0 409.7 104.9M411.3 76.5Q410.2 90.1 408.7 104.5"/><path class="s r" d="M409.0 105.1Q272.6 103.6 135.9 105.1M408.6 106.1Q272.9 103.7 134.8 104.0"/><path class="s r" d="M133.9 103.5Q135.3 89.5 134.2 75.9M133.5 103.9Q134.9 89.4 134.7 74.0"/><text x="110" y="96" text-anchor="end" style="font-size:18px">thread 1</text><path class="h g" clip-path="url(#cth3)" d="M94.7 149.7Q107.5 132.5 121.0 114.2M98.6 148.2Q113.0 132.8 125.6 115.3M103.1 150.1Q117.3 132.8 128.6 113.8M108.1 148.3Q119.0 130.8 132.2 114.9M111.8 150.0Q123.7 131.3 137.3 115.3M116.7 148.3Q130.5 132.5 141.1 113.8M122.3 148.0Q135.4 132.5 148.4 115.5M128.6 148.7Q139.5 131.0 154.2 116.0M133.6 148.6Q145.9 131.6 158.4 114.5"/><path class="s g" d="M121.2 118.0Q127.6 116.6 135.1 116.1M121.5 116.7Q127.2 115.8 136.0 116.0"/><path class="s g" d="M134.3 115.5Q134.4 132.2 134.3 146.6M136.0 115.9Q133.7 132.6 133.0 146.3"/><path class="s g" d="M133.5 147.4Q126.8 148.4 119.6 146.3M134.6 147.5Q126.8 146.3 118.9 147.8"/><path class="s g" d="M120.5 146.9Q120.9 132.0 120.8 117.5M119.9 147.3Q119.6 132.3 120.4 116.9"/><path class="h r" clip-path="url(#cth4)" d="M109.0 148.0Q120.2 131.3 134.4 115.2M119.6 150.1Q131.6 131.4 145.8 113.8M130.5 149.6Q143.3 132.9 155.3 113.8M142.4 148.7Q154.8 132.0 168.5 114.2M154.7 148.6Q167.2 132.4 180.3 116.0M166.4 148.0Q178.3 131.6 191.6 114.9M178.1 149.9Q189.8 131.6 203.6 114.0M188.4 147.9Q202.8 132.8 215.5 114.2M199.8 148.4Q212.9 133.2 224.8 114.3M210.5 148.8Q225.1 133.1 237.0 114.4M221.5 148.2Q234.3 132.9 245.9 115.2M230.9 149.1Q244.3 132.3 258.0 114.1M240.9 148.0Q255.7 133.1 267.6 114.9M253.7 149.3Q264.8 131.7 278.1 115.2M262.1 149.8Q275.0 130.8 288.1 114.4M272.2 150.0Q287.6 132.6 298.4 115.5M284.1 149.4Q297.9 132.1 309.9 114.9M295.5 149.4Q308.2 131.8 320.0 115.7M308.0 148.5Q320.7 132.9 332.2 114.6M316.7 147.8Q328.8 130.9 343.0 115.8M329.1 149.3Q340.3 130.7 354.5 114.8M339.3 148.3Q352.9 131.1 365.3 115.8M351.4 149.1Q363.7 132.0 376.2 115.6M361.6 149.5Q372.8 131.3 388.1 116.0M372.6 148.6Q384.3 131.2 397.2 114.3M381.9 149.5Q396.3 132.6 408.3 115.0M392.1 148.9Q407.2 133.1 418.8 114.8M403.4 149.8Q416.9 131.8 429.3 114.4"/><path class="s r" d="M135.9 118.5Q272.0 114.9 409.1 117.5M133.4 115.6Q272.3 118.5 408.5 115.6"/><path class="s r" d="M411.4 118.6Q409.4 131.4 409.7 146.6M409.0 117.7Q409.0 132.3 409.8 145.6"/><path class="s r" d="M409.3 148.3Q271.9 149.0 134.2 146.1M409.7 145.7Q271.7 148.9 134.6 146.5"/><path class="s r" d="M133.5 147.8Q132.9 131.6 134.3 116.5M135.9 147.7Q135.0 132.2 134.0 118.5"/><text x="110" y="138" text-anchor="end" style="font-size:18px">thread 2</text><path class="h g" clip-path="url(#cth5)" d="M93.6 190.6Q105.2 172.5 119.7 157.3M99.7 190.7Q111.8 174.4 124.4 158.2M104.1 190.5Q118.1 174.7 130.3 158.1M109.2 190.2Q122.0 174.1 134.1 157.6M115.0 191.2Q127.0 173.3 141.9 157.4M119.1 190.1Q133.6 174.6 145.1 155.8M126.0 191.4Q140.0 175.3 151.4 158.1M130.9 191.8Q141.6 173.4 157.0 156.3"/><path class="s g" d="M119.4 159.5Q127.7 157.8 134.9 157.4M120.0 157.5Q126.8 157.6 135.5 158.9"/><path class="s g" d="M133.2 160.2Q133.8 174.4 133.7 189.0M135.2 157.6Q134.5 174.1 134.6 189.0"/><path class="s g" d="M133.2 187.5Q126.7 189.0 118.6 190.5M134.8 188.1Q127.5 189.3 120.3 189.8"/><path class="s g" d="M118.4 187.6Q120.6 174.3 119.2 158.8M120.1 188.4Q120.2 173.6 118.7 158.3"/><path class="h r" clip-path="url(#cth6)" d="M108.0 191.5Q119.6 173.3 133.9 157.6M120.8 190.1Q131.9 173.3 146.8 157.6M131.3 191.9Q144.1 174.1 155.6 156.9M141.3 191.0Q153.3 173.3 168.8 157.9M153.3 190.2Q165.9 172.9 180.4 157.2M163.7 191.5Q177.5 174.1 190.0 155.8M176.2 191.3Q188.6 173.3 201.9 156.3M187.1 191.7Q202.2 174.5 215.4 156.6M198.4 191.5Q211.9 173.4 225.9 156.8M211.7 191.3Q225.1 175.0 237.4 157.1M221.4 191.4Q236.0 174.6 248.7 156.8M231.4 191.9Q246.0 174.6 258.9 157.7M243.7 190.2Q254.9 173.0 267.8 157.7M251.9 191.5Q266.4 173.9 280.0 157.7M264.2 191.8Q275.7 173.2 290.4 158.0M273.7 190.0Q287.5 173.9 302.2 156.0M287.6 191.4Q299.2 173.6 311.9 157.8M297.5 190.6Q311.4 175.1 324.7 158.2M308.0 192.0Q321.7 174.2 334.4 158.2M318.5 191.2Q334.3 174.7 345.9 156.6M330.4 190.8Q342.3 173.4 357.3 156.8M341.2 191.4Q355.7 174.5 368.8 158.1M354.6 191.4Q368.0 175.0 378.5 157.8M364.9 191.3Q378.7 174.9 391.7 156.7M376.5 190.9Q390.0 175.3 401.0 157.0M387.4 191.3Q398.5 173.4 413.1 157.1M395.9 191.3Q408.6 173.7 422.1 155.9M406.9 190.9Q421.1 175.1 433.4 158.0"/><path class="s r" d="M132.9 159.1Q272.1 160.2 408.6 158.3M134.2 160.3Q272.1 158.4 410.2 159.5"/><path class="s r" d="M410.6 160.0Q408.6 174.6 410.3 190.6M408.7 158.8Q409.6 174.2 411.4 187.9"/><path class="s r" d="M411.1 188.4Q272.0 189.6 134.7 187.5M411.2 190.2Q272.1 190.5 134.5 188.2"/><path class="s r" d="M135.0 189.4Q136.0 174.4 134.2 159.2M133.9 189.8Q134.3 174.5 133.2 157.7"/><text x="110" y="180" text-anchor="end" style="font-size:18px">thread 3</text><path class="h g" clip-path="url(#cth7)" d="M93.7 234.0Q105.8 215.2 118.9 199.9M98.6 231.9Q110.8 215.5 124.7 197.9M101.6 231.9Q115.1 215.7 128.6 198.4M109.3 232.4Q122.5 217.2 134.4 198.1M112.9 232.8Q127.0 216.9 140.3 199.7M118.4 233.9Q130.6 215.3 144.1 198.1M121.6 232.9Q135.1 215.0 148.2 199.9M127.2 234.1Q138.9 215.1 152.9 199.9M131.7 232.0Q144.7 216.3 158.6 198.7"/><path class="s g" d="M120.9 201.8Q126.7 199.9 134.1 200.2M118.8 199.6Q127.2 200.9 133.2 201.9"/><path class="s g" d="M134.3 200.3Q133.4 216.2 134.4 230.7M133.8 201.7Q134.0 215.9 135.9 232.5"/><path class="s g" d="M134.4 231.6Q127.6 230.2 119.1 232.6M135.7 230.6Q127.6 232.1 120.0 229.5"/><path class="s g" d="M119.5 230.6Q121.3 215.5 119.9 200.4M119.9 230.8Q119.3 216.3 119.6 202.4"/><path class="h r" clip-path="url(#cth8)" d="M109.1 232.8Q122.4 216.2 135.0 198.9M118.9 232.4Q132.0 215.8 143.5 197.9M130.0 233.0Q141.4 215.3 155.6 200.0M140.8 232.2Q154.2 217.1 165.7 199.1M151.6 233.7Q165.1 216.9 176.6 197.9M162.0 233.7Q175.5 216.2 188.4 199.3M172.0 233.7Q185.5 216.5 197.2 199.9M182.3 233.8Q196.5 216.3 207.9 198.2M195.2 233.1Q206.8 215.2 219.2 198.4M204.4 234.1Q216.7 214.8 231.4 198.7M216.6 233.9Q228.0 215.3 243.0 198.7M225.6 233.5Q238.5 215.2 253.5 197.9M237.5 232.0Q251.9 216.4 263.2 199.2M250.1 232.3Q262.3 216.1 275.2 200.0M259.7 232.6Q272.5 215.7 285.1 199.8M270.9 233.0Q284.7 217.2 298.1 199.1M282.3 233.1Q296.3 217.0 308.9 199.3M293.6 233.0Q306.2 215.8 318.9 198.3M303.7 232.2Q315.8 216.1 328.7 200.0M312.6 233.8Q327.9 217.3 339.4 198.9M325.0 233.7Q336.6 215.4 350.8 199.4M335.6 234.0Q347.3 215.1 361.1 199.1M345.8 234.0Q359.7 216.6 371.8 200.1M357.2 232.6Q371.3 216.4 384.0 199.9M367.2 233.9Q380.7 215.8 393.9 199.7M378.0 232.5Q392.1 217.0 403.3 199.7M389.4 232.1Q401.4 215.1 415.6 199.2M400.5 234.0Q413.7 216.3 427.6 199.9"/><path class="s r" d="M134.1 201.6Q272.5 202.7 410.0 200.7M134.7 202.4Q271.7 199.6 409.0 202.2"/><path class="s r" d="M409.9 201.3Q409.4 216.0 410.9 232.2M411.2 200.4Q412.1 216.4 409.4 232.1"/><path class="s r" d="M409.3 229.9Q272.1 229.1 133.4 230.4M410.1 230.3Q272.4 232.9 133.6 230.9"/><path class="s r" d="M135.2 231.8Q133.3 215.6 133.2 199.9M134.4 229.5Q133.6 216.5 134.0 201.5"/><text x="110" y="222" text-anchor="end" style="font-size:18px">thread 4</text><text x="575.0" y="62" text-anchor="middle" class="m" style="font-size:17px">period 2: 100 ms (the default)</text><path class="h g" clip-path="url(#cth9)" d="M403.1 106.4Q418.0 91.3 430.5 73.2M409.6 108.1Q420.7 88.9 435.2 73.3M413.4 108.0Q424.7 89.0 438.9 73.5M419.5 107.1Q430.6 89.0 445.4 74.1M423.1 107.1Q436.4 90.2 449.9 73.0M429.2 107.0Q441.8 89.7 455.3 72.9M433.7 106.0Q447.7 90.7 459.2 73.6M438.1 107.5Q451.3 90.0 464.8 72.8M443.2 105.8Q456.2 90.2 469.4 73.0"/><path class="s g" d="M429.5 73.5Q437.7 74.2 445.6 75.5M430.4 75.0Q437.9 76.0 445.4 74.7"/><path class="s g" d="M443.1 74.9Q443.7 90.5 445.5 104.1M444.5 76.6Q445.4 89.5 443.8 105.7"/><path class="s g" d="M446.0 103.8Q437.1 105.0 430.2 104.5M444.4 104.8Q437.0 106.4 431.5 103.5"/><path class="s g" d="M429.4 104.4Q430.8 90.6 430.7 74.9M430.2 106.2Q428.1 90.5 431.0 74.4"/><path class="h r" clip-path="url(#cth10)" d="M417.8 106.7Q431.1 89.8 443.9 72.6M430.8 108.1Q442.2 90.0 456.5 73.9M439.9 108.0Q453.9 90.5 466.7 73.5M451.5 108.2Q464.1 90.4 477.0 73.1M460.5 106.6Q473.6 89.3 487.2 74.0M472.3 106.4Q485.4 89.4 498.7 72.2M483.9 106.7Q496.5 89.2 510.9 74.1M495.3 106.7Q508.4 90.9 520.1 72.6M505.8 105.8Q519.3 90.1 532.4 73.9M517.2 107.0Q528.3 89.2 543.5 73.8M527.2 107.1Q539.1 89.7 553.1 74.0M539.8 106.4Q550.7 89.2 565.9 73.3M548.3 106.3Q561.4 89.8 573.6 71.9M560.6 107.7Q573.4 89.4 587.6 72.4M571.9 106.3Q586.1 90.2 597.7 73.3M585.5 107.1Q597.6 90.3 610.7 73.4M596.9 107.8Q609.8 90.4 621.3 74.0M607.2 107.4Q620.7 89.9 633.2 73.1M618.9 107.3Q631.2 90.2 645.5 73.4M630.6 107.0Q643.2 90.5 654.8 72.7M641.2 107.1Q654.7 90.9 666.4 71.9M650.7 106.4Q664.8 90.6 676.7 72.4M663.8 107.8Q675.4 89.0 689.7 72.4M673.6 106.5Q686.6 90.3 698.0 73.7M684.5 107.8Q696.0 89.3 709.4 74.1M694.8 107.1Q707.0 89.3 721.3 73.2M705.1 106.0Q717.8 89.3 732.4 71.9M716.6 106.3Q730.2 90.2 743.1 72.1"/><path class="s r" d="M445.9 75.2Q582.7 77.5 718.7 75.7M445.6 74.1Q581.7 76.8 719.3 74.3"/><path class="s r" d="M719.4 74.9Q718.2 89.6 720.0 106.4M718.6 74.3Q721.2 90.0 721.5 106.5"/><path class="s r" d="M721.0 105.8Q582.8 104.3 445.9 104.1M720.3 104.8Q582.8 105.0 445.7 106.2"/><path class="s r" d="M445.5 104.2Q443.9 89.8 444.8 76.5M443.2 103.4Q443.5 89.6 443.8 74.0"/><path class="h g" clip-path="url(#cth11)" d="M402.8 147.9Q417.4 132.5 430.4 115.6M408.5 149.6Q422.0 132.1 435.7 114.8M414.9 148.0Q425.5 130.5 440.7 115.2M418.7 149.5Q431.3 131.3 444.5 114.2M423.4 150.0Q436.7 131.2 450.6 114.1M428.9 148.0Q443.2 132.9 455.4 114.7M434.7 149.8Q448.7 132.9 459.9 115.6M437.3 150.1Q450.4 131.5 464.6 115.8M442.9 148.7Q457.4 133.1 469.8 114.1"/><path class="s g" d="M429.3 116.2Q437.2 116.2 445.5 118.0M431.3 116.9Q437.7 118.5 443.4 116.4"/><path class="s g" d="M444.3 118.6Q444.5 131.4 443.1 146.6M444.7 117.7Q445.3 132.4 443.3 146.9"/><path class="s g" d="M444.3 147.9Q436.8 146.8 431.5 147.7M443.0 146.0Q437.3 145.6 431.1 148.0"/><path class="s g" d="M428.7 146.0Q430.2 132.1 430.3 117.2M431.2 147.8Q431.1 132.5 428.8 117.0"/><path class="h r" clip-path="url(#cth12)" d="M418.1 150.0Q429.9 131.2 445.1 115.2M429.0 148.6Q441.9 131.9 455.0 114.7M438.9 149.5Q452.2 132.1 465.6 114.2M450.2 149.4Q463.7 132.3 478.1 114.4M463.0 149.1Q476.3 132.7 488.3 115.3M472.5 148.2Q487.0 132.7 498.6 114.2M482.1 149.1Q495.9 131.9 509.3 114.7M495.9 150.0Q509.1 133.2 521.8 114.6M506.7 149.3Q520.2 132.5 533.7 114.0M518.4 149.3Q532.3 133.3 544.2 115.4M527.8 148.1Q540.2 130.5 553.8 115.2M539.3 148.3Q552.7 131.4 566.6 115.6M552.1 148.6Q563.9 131.2 577.5 114.4M564.2 148.0Q575.2 130.8 590.6 115.2M576.3 148.2Q588.7 132.2 600.6 114.7M586.2 148.1Q600.9 133.1 611.3 114.5M595.8 149.7Q610.5 132.5 623.1 115.5M606.2 149.4Q619.9 131.9 633.4 114.5M618.4 148.9Q631.9 133.3 642.9 114.5M631.0 148.1Q643.8 133.2 657.0 115.3M639.5 149.8Q652.6 131.2 665.5 115.7M651.6 148.9Q665.8 132.8 676.9 115.1M662.5 148.2Q676.5 132.7 689.3 115.0M674.1 149.8Q685.9 131.8 699.3 113.9M685.4 150.0Q698.0 132.7 709.9 113.8M695.2 149.7Q707.1 131.6 721.6 115.4M703.9 149.2Q717.7 131.8 731.5 115.2M716.3 148.5Q730.3 133.0 742.8 116.0"/><path class="s r" d="M443.9 116.5Q582.0 114.9 721.2 118.0M443.1 115.9Q582.3 115.3 720.3 116.5"/><path class="s r" d="M720.1 117.5Q718.8 132.5 718.5 147.2M720.9 116.4Q720.3 131.8 719.7 147.8"/><path class="s r" d="M718.5 147.2Q582.1 147.0 442.9 147.6M720.4 148.2Q581.8 148.5 445.5 145.8"/><path class="s r" d="M444.3 147.5Q443.7 132.5 444.0 117.7M445.3 146.8Q442.7 132.1 443.5 117.2"/><path class="h g" clip-path="url(#cth13)" d="M404.7 191.6Q418.4 175.2 430.8 157.4M408.2 190.2Q423.4 174.9 434.8 158.2M413.8 190.0Q428.3 174.2 441.2 156.8M419.6 189.8Q432.1 174.6 443.7 157.0M422.3 191.5Q436.4 173.7 448.3 158.1M429.5 190.1Q442.8 174.5 455.2 156.1M432.5 190.6Q447.6 175.5 459.4 156.5M438.0 190.7Q452.4 174.5 465.2 157.0M442.1 189.8Q457.2 174.6 470.3 157.5"/><path class="s g" d="M430.0 160.4Q437.7 157.8 444.5 157.5M429.0 158.3Q437.1 159.1 445.2 157.7"/><path class="s g" d="M443.9 158.6Q446.5 173.9 444.8 187.5M445.9 160.4Q444.9 174.0 444.2 188.5"/><path class="s g" d="M446.0 189.4Q437.3 190.7 428.6 189.6M444.9 189.5Q437.1 190.3 429.8 189.2"/><path class="s g" d="M429.5 189.6Q431.3 173.6 428.5 158.6M429.9 190.1Q430.0 173.8 428.8 159.3"/><path class="h r" clip-path="url(#cth14)" d="M417.5 189.9Q429.7 173.3 443.9 158.0M428.0 191.6Q442.5 174.5 455.0 156.8M438.0 190.4Q450.6 173.2 464.9 157.4M450.3 190.3Q461.2 173.2 474.8 156.7M460.1 190.7Q472.7 173.0 487.1 157.6M472.5 192.1Q483.7 173.4 498.7 157.7M481.4 191.7Q493.9 172.9 508.5 156.2M494.6 191.6Q507.3 174.0 519.2 157.2M504.5 190.6Q517.1 174.2 529.4 157.3M516.4 191.2Q529.4 174.7 540.7 156.6M526.1 191.2Q539.7 174.1 551.3 157.7M535.9 190.5Q549.8 174.7 562.9 156.9M549.0 191.6Q560.1 172.9 574.0 156.4M557.9 191.1Q570.5 173.5 584.1 157.4M568.8 191.7Q584.2 175.3 595.0 156.9M581.2 190.8Q593.5 174.3 606.0 156.5M589.1 191.9Q602.4 173.1 615.5 156.3M600.6 190.7Q615.4 174.5 626.5 157.7M611.1 191.5Q624.2 173.8 638.6 157.5M622.9 190.0Q636.7 174.1 648.0 157.5M634.5 192.2Q645.2 172.4 659.2 157.3M644.7 192.0Q659.5 174.7 672.0 157.7M658.2 189.9Q670.3 173.4 683.4 155.9M668.9 191.2Q682.6 174.7 693.7 156.1M677.7 190.4Q691.1 173.7 705.0 156.5M691.2 190.2Q703.1 173.7 715.8 157.0M701.8 190.2Q713.9 173.3 727.4 157.8M712.8 191.7Q726.0 174.5 739.1 156.0"/><path class="s r" d="M445.8 157.9Q582.6 160.6 720.0 158.5M445.1 157.6Q582.4 161.2 719.0 158.6"/><path class="s r" d="M719.3 159.0Q719.6 173.9 720.8 188.0M718.5 157.9Q719.5 173.9 721.1 190.4"/><path class="s r" d="M719.0 188.5Q582.5 190.5 445.5 188.4M721.4 189.5Q582.4 191.0 444.7 190.1"/><path class="s r" d="M443.1 189.9Q445.8 174.2 446.1 160.0M445.6 190.0Q442.6 174.2 443.3 158.8"/><path class="h g" clip-path="url(#cth15)" d="M403.8 233.1Q415.8 215.1 429.9 197.9M409.1 232.5Q422.0 216.9 433.8 199.7M413.2 232.9Q425.5 215.3 440.3 198.5M419.8 233.3Q433.3 216.2 446.3 198.8M424.2 233.2Q438.0 215.6 451.6 198.9M431.0 233.7Q444.6 216.6 455.3 199.8M434.4 234.1Q449.4 217.1 461.9 197.9M440.4 232.4Q455.6 216.9 467.9 198.1"/><path class="s g" d="M430.6 201.2Q437.4 201.7 445.6 200.1M431.4 202.1Q437.5 201.5 443.3 199.5"/><path class="s g" d="M444.0 201.6Q446.2 215.7 443.6 230.9M443.9 202.4Q445.5 216.5 443.9 230.6"/><path class="s g" d="M443.6 232.1Q437.4 232.0 428.9 230.5M443.1 230.6Q437.7 231.7 429.9 229.4"/><path class="s g" d="M429.3 231.8Q431.9 215.5 428.8 202.0M428.5 229.9Q430.3 216.6 428.6 200.6"/><path class="h r" clip-path="url(#cth16)" d="M417.7 233.9Q430.2 214.9 443.5 198.2M427.7 232.3Q443.0 216.7 453.8 198.8M438.9 232.2Q450.8 215.5 464.5 198.1M449.1 233.9Q463.4 216.4 476.3 200.0M462.5 232.4Q475.3 216.6 488.5 200.1M472.8 233.2Q485.8 215.6 498.4 199.6M484.3 234.0Q497.1 216.1 509.1 199.3M494.9 233.5Q508.8 216.8 519.9 198.3M504.9 232.2Q517.8 215.1 531.2 199.5M518.0 233.7Q530.3 216.5 543.0 198.5M527.2 233.0Q540.1 215.5 554.8 199.4M538.9 232.9Q552.6 215.8 567.0 198.9M550.7 232.5Q563.4 215.7 576.6 200.1M560.0 233.1Q574.6 217.5 587.6 199.5M571.4 233.3Q582.8 214.6 596.7 198.8M582.5 231.9Q595.9 216.3 609.0 199.5M595.0 234.0Q606.5 215.6 619.2 199.7M606.6 233.1Q619.1 216.0 632.8 198.1M617.7 233.7Q629.9 215.4 644.5 198.1M629.3 232.1Q642.6 216.1 654.8 200.0M640.2 233.2Q653.0 215.2 666.8 198.6M650.4 232.4Q664.1 215.9 675.9 198.4M663.2 232.3Q675.1 215.5 689.4 198.3M672.6 232.9Q684.5 215.7 697.8 198.0M684.6 232.4Q696.0 215.5 710.1 199.6M694.2 232.9Q707.5 216.3 721.3 198.0M704.0 233.1Q716.2 214.9 730.6 198.5M714.0 233.3Q728.0 216.2 739.7 199.2"/><path class="s r" d="M445.8 200.2Q582.6 202.2 718.6 200.5M444.2 201.2Q581.8 202.7 719.8 200.9"/><path class="s r" d="M719.3 200.1Q719.6 215.7 719.2 231.9M719.7 202.5Q720.8 216.4 718.9 230.8"/><path class="s r" d="M721.6 230.4Q581.7 230.9 446.1 231.7M718.4 230.2Q582.1 228.6 443.3 230.9"/><path class="s r" d="M445.3 231.2Q445.5 215.9 444.4 200.6M445.1 230.0Q444.0 215.6 443.1 202.5"/><g class="anim-playhead"><path class="s b" d="M119.6 70.4Q120.7 160.1 120.3 250.2M120.1 70.3Q119.9 159.8 120.2 250.2"/><path class="f b" d="M113 65 L127 65 L120 75 Z"/></g><text x="128" y="275" text-anchor="start" style="font-size:18px">4 threads × ~5 ms = the 20 ms quota, used up after ~5 ms of wall time</text><text x="128" y="300" text-anchor="start" class="r" style="font-size:18px">runnable work in the group is throttled until the next period starts</text></svg><figcaption>The quota is shared by every thread in the group. Spend it early and the group waits for the next period, even on an idle node.</figcaption></figure>

Here's the trap, and it's the one I see most often: **the wallet is shared by all threads in the cgroup.** Four busy threads running on four CPUs spend 20 ms in about 5 ms of real time. After that, every thread in the group that's ready to run has to wait until the next period, about 95 ms later in this example. Your dashboard says "20% CPU", but every request that lands in one of those gaps is slow. That waiting is **throttling**.

#### How the kernel hands out the budget

<figure class="sketch "><svg viewBox="0 0 760 320" role="img" aria-label="CPU quota is handed out in slices per CPU"><title>CPU quota is handed out in slices per CPU</title><defs><clipPath id="cqs1"><rect x="270" y="30" width="220" height="80"/></clipPath><clipPath id="cqs2"><rect x="40" y="180" width="150" height="60"/></clipPath><clipPath id="cqs3"><rect x="220" y="180" width="150" height="60"/></clipPath><clipPath id="cqs4"><rect x="400" y="180" width="150" height="60"/></clipPath><clipPath id="cqs5"><rect x="580" y="180" width="150" height="60"/></clipPath></defs><path class="h y" clip-path="url(#cqs1)" d="M200.3 113.1Q234.2 69.4 269.8 28.3M209.2 111.9Q243.7 69.0 278.9 27.0M219.3 113.0Q253.8 69.3 289.0 27.2M227.9 112.7Q261.1 70.1 297.1 29.2M236.7 110.8Q269.3 68.8 306.4 27.6M244.6 111.9Q279.5 70.4 313.3 26.9M253.9 112.5Q288.4 69.9 324.4 27.8M262.6 113.2Q297.8 70.9 333.3 28.8M271.1 111.5Q305.8 69.7 340.9 28.5M280.9 112.7Q316.5 70.6 349.1 28.4M289.8 112.1Q323.0 69.4 360.0 28.2M297.8 112.6Q332.7 70.6 366.0 28.5M307.0 111.6Q339.9 69.4 376.6 28.4M315.6 112.2Q351.4 70.4 385.2 27.6M324.3 111.0Q359.4 69.0 395.7 26.9M334.6 111.9Q369.1 71.0 403.8 28.8M342.5 110.9Q379.0 71.1 413.3 27.6M350.8 112.9Q386.4 69.7 420.9 27.0M361.9 110.9Q394.6 69.8 429.2 28.4M368.9 112.3Q403.3 69.7 439.1 27.6M377.3 110.8Q413.2 70.5 447.2 27.6M387.3 112.9Q421.8 70.4 456.9 27.4M397.3 112.5Q432.1 70.3 465.9 29.0M406.9 111.9Q440.6 69.7 476.0 28.3M415.2 112.8Q447.9 69.1 485.2 28.4M423.5 112.5Q459.2 70.6 494.2 29.0M432.9 112.1Q467.1 68.8 502.0 26.9M444.0 111.2Q478.8 71.1 512.0 28.0M452.6 111.5Q487.1 70.4 521.4 28.5M461.3 111.5Q494.8 69.5 530.8 28.2M470.9 112.7Q504.3 68.8 539.1 27.3M479.7 110.9Q515.1 70.7 550.1 27.1M489.9 110.8Q522.9 69.2 558.3 28.4"/><path class="s y" d="M268.7 28.8Q379.4 30.8 490.6 31.3M268.6 31.1Q379.5 30.9 489.3 30.4"/><path class="s y" d="M490.2 30.1Q491.9 70.0 489.0 109.5M491.2 29.2Q490.6 69.5 488.7 109.0"/><path class="s y" d="M491.0 109.3Q379.7 111.1 269.3 111.0M489.3 110.5Q380.0 108.5 270.5 108.6"/><path class="s y" d="M271.3 110.3Q270.6 70.2 269.8 31.2M271.3 110.5Q268.7 70.1 271.1 30.6"/><text x="380" y="62" text-anchor="middle" class="big" style="font-size:21px">the cgroup's wallet</text><text x="380" y="92" text-anchor="middle" style="font-size:18px">20 ms per 100 ms period</text><path class="h b" clip-path="url(#cqs2)" d="M-12.3 242.7Q15.0 211.1 40.2 177.7M-1.9 242.4Q22.5 209.0 50.4 177.2M8.5 243.0Q32.5 208.8 59.2 177.1M18.0 241.1Q44.5 211.3 70.8 176.9M26.9 241.9Q52.2 209.6 80.1 179.0M37.5 242.8Q63.8 210.8 88.5 178.4M44.7 243.1Q71.4 209.7 97.9 177.0M55.7 241.0Q82.8 210.2 110.2 177.6M66.0 240.9Q92.9 209.9 119.7 178.9M76.9 241.5Q101.5 208.9 127.4 177.5M84.3 241.6Q112.0 210.4 137.3 177.4M95.7 242.2Q122.2 209.8 147.9 178.8M106.1 242.7Q131.5 209.4 158.3 177.7M117.3 241.8Q142.3 209.6 168.7 177.2M127.2 242.2Q151.9 208.5 180.4 177.1M139.6 242.5Q164.8 210.1 191.4 178.3M148.2 242.5Q174.6 210.0 200.9 178.6M159.4 241.5Q185.4 209.9 210.7 179.1M169.1 240.9Q195.4 210.6 220.9 178.9M179.9 242.2Q204.5 209.7 230.8 178.3M189.9 242.1Q215.3 210.4 240.6 178.6"/><path class="s b" d="M39.1 181.6Q115.4 180.6 191.4 179.4M39.6 181.0Q115.6 181.4 191.0 178.6"/><path class="s b" d="M191.2 179.7Q192.4 210.0 191.1 239.2M188.9 180.5Q190.3 209.9 188.8 241.5"/><path class="s b" d="M189.1 238.9Q115.2 238.4 38.6 240.9M188.7 239.3Q115.5 239.7 41.4 241.6"/><path class="s b" d="M39.8 239.5Q40.9 210.0 38.4 180.7M39.6 240.8Q38.9 210.3 40.5 180.0"/><text x="115" y="217" text-anchor="middle" class="big" style="font-size:21px">CPU 0</text><path class="s a" d="M319.7 111.9Q216.2 141.4 115.5 174.4M320.2 110.5Q218.0 146.2 114.6 176.1"/><path class="s a" d="M115.7 175.5Q118.0 171.1 123.8 168.7M115.6 176.6Q119.2 172.7 123.5 168.1"/><path class="s a" d="M115.6 176.5Q120.2 176.5 126.4 178.2M115.8 176.5Q120.7 176.5 125.2 178.2"/><path class="h b" clip-path="url(#cqs3)" d="M166.7 241.1Q194.2 210.2 219.2 176.8M176.8 241.4Q205.3 211.7 230.5 177.8M187.6 242.7Q212.9 209.3 239.2 179.0M196.4 242.0Q223.5 210.6 250.4 178.9M206.2 241.1Q232.5 209.3 258.9 177.4M217.7 241.6Q242.5 209.3 270.4 178.9M228.7 242.4Q255.1 210.7 279.3 178.4M237.4 241.9Q263.8 209.6 289.5 178.5M248.4 242.5Q275.3 210.8 300.6 178.7M257.9 242.3Q283.5 209.9 308.9 178.6M267.9 241.7Q294.0 210.8 318.3 177.1M277.3 240.8Q304.0 210.1 328.7 179.0M286.6 242.0Q312.9 209.9 338.9 177.1M296.8 241.2Q323.3 210.4 349.2 177.6M306.7 242.1Q331.4 209.1 356.9 177.7M316.3 240.8Q340.6 209.7 368.6 178.7M327.0 243.2Q352.0 209.9 379.1 178.2M336.4 242.3Q361.4 209.2 389.5 179.2M347.7 241.9Q373.2 209.6 398.4 177.3M358.2 243.2Q383.3 210.0 409.2 178.7M368.5 242.2Q393.6 210.3 420.1 178.7"/><path class="s b" d="M219.1 181.0Q294.9 181.9 371.5 179.5M220.0 179.6Q294.6 182.0 370.7 180.4"/><path class="s b" d="M370.2 178.7Q371.9 210.3 369.8 239.8M369.7 179.4Q371.3 210.5 369.0 241.4"/><path class="s b" d="M368.4 241.6Q294.5 240.4 219.4 239.9M369.2 241.6Q294.4 242.9 221.5 240.2"/><path class="s b" d="M218.9 240.7Q218.8 209.6 221.1 179.6M220.5 238.9Q218.5 210.0 220.4 179.1"/><text x="295" y="217" text-anchor="middle" class="big" style="font-size:21px">CPU 1</text><path class="s a" d="M359.7 112.1Q327.1 144.1 294.0 176.3M360.1 113.5Q328.9 145.2 296.2 176.9"/><path class="s a" d="M295.6 176.3Q296.8 171.0 298.5 166.3M295.0 176.3Q295.9 170.8 298.1 166.3"/><path class="s a" d="M295.1 175.9Q300.0 173.6 305.8 172.6M294.5 175.2Q300.5 175.2 306.1 173.2"/><path class="h b" clip-path="url(#cqs4)" d="M347.7 241.5Q373.7 209.5 400.4 178.5M356.1 241.7Q384.1 211.2 409.7 177.8M367.4 242.5Q393.4 210.3 419.0 177.4M378.2 241.8Q403.1 209.4 430.2 179.1M387.7 242.3Q414.2 209.9 440.9 177.2M397.7 241.6Q425.6 211.3 451.0 178.2M409.3 242.4Q434.2 210.4 459.8 176.8M417.9 243.0Q445.1 210.7 471.4 177.3M430.7 241.2Q454.7 209.0 480.9 178.0M440.9 241.7Q466.9 211.0 492.0 178.0M451.0 241.9Q477.6 210.4 503.0 177.8M460.4 241.7Q487.1 209.8 512.5 178.2M471.8 243.0Q498.0 211.2 522.4 177.4M481.2 241.9Q506.2 209.4 532.7 179.0M489.0 242.6Q515.9 209.3 541.7 177.1M501.2 242.6Q524.5 209.2 552.7 178.5M511.5 241.0Q536.3 209.0 563.2 179.2M521.5 242.8Q548.7 211.0 573.2 179.0M533.0 241.5Q557.4 209.3 583.8 177.6M542.6 243.0Q569.0 210.4 595.7 177.9"/><path class="s b" d="M401.2 179.9Q475.2 180.0 549.6 180.8M399.2 178.9Q474.7 180.5 549.6 180.2"/><path class="s b" d="M548.9 179.0Q551.2 210.4 550.5 240.2M548.4 180.8Q548.0 210.5 551.4 240.5"/><path class="s b" d="M548.6 239.6Q475.6 240.4 400.6 241.0M550.8 239.6Q474.8 238.6 400.0 239.9"/><path class="s b" d="M399.8 240.2Q399.2 210.1 401.0 179.0M399.2 239.6Q398.7 210.2 400.7 180.0"/><text x="475" y="217" text-anchor="middle" class="big" style="font-size:21px">CPU 2</text><path class="s a" d="M399.3 110.7Q438.1 142.7 475.7 176.8M400.2 111.3Q437.4 143.6 474.3 174.7"/><path class="s a" d="M475.4 175.4Q470.1 173.5 465.0 172.8M474.7 176.5Q470.0 174.4 464.1 172.7"/><path class="s a" d="M475.1 175.3Q473.5 170.6 471.0 165.8M474.4 176.6Q472.4 171.0 470.0 165.5"/><path class="h b" clip-path="url(#cqs5)" d="M528.0 241.1Q553.5 209.0 579.7 177.6M538.2 242.4Q564.4 210.5 589.7 178.3M547.9 241.1Q573.3 210.1 600.3 178.9M557.0 242.3Q584.9 210.7 609.5 178.9M568.8 241.0Q593.9 210.2 618.9 178.1M578.0 242.2Q605.0 211.3 629.2 179.2M588.1 242.9Q615.6 211.1 641.9 176.9M598.1 240.8Q624.9 210.2 650.8 178.8M608.1 241.1Q633.0 209.2 659.1 177.3M619.6 242.1Q644.5 209.8 670.0 178.4M629.2 242.4Q655.7 211.2 680.4 176.9M637.8 242.4Q663.3 208.4 689.7 178.2M647.7 243.0Q674.8 210.8 700.4 178.8M659.3 243.2Q685.2 210.6 710.1 177.0M668.0 241.3Q693.5 209.1 720.7 177.5M677.4 242.6Q705.1 210.7 731.1 179.0M689.2 241.8Q716.1 211.6 740.9 177.5M699.8 242.6Q725.2 209.4 751.2 176.8M710.0 241.7Q736.2 209.8 761.1 176.9M720.3 242.6Q746.8 210.2 773.3 178.6"/><path class="s b" d="M581.2 178.7Q654.4 181.6 728.7 179.3M579.3 181.3Q654.8 179.1 728.9 181.6"/><path class="s b" d="M729.5 181.2Q731.4 210.3 729.7 239.6M728.7 178.9Q731.4 210.0 731.3 238.9"/><path class="s b" d="M730.8 241.4Q654.6 237.3 578.7 238.8M728.9 239.0Q655.4 237.2 579.2 240.5"/><path class="s b" d="M579.0 241.0Q580.8 210.1 579.1 181.1M579.8 238.5Q580.7 209.8 578.6 179.6"/><text x="655" y="217" text-anchor="middle" class="big" style="font-size:21px">CPU 3</text><path class="s a" d="M440.9 111.1Q546.9 144.2 653.9 176.1M439.0 112.6Q547.8 145.1 653.5 174.9"/><path class="s a" d="M655.2 175.7Q649.8 177.2 644.1 177.3M654.8 176.6Q649.5 176.5 644.6 177.6"/><path class="s a" d="M655.7 175.8Q650.3 173.4 647.4 168.8M655.5 176.5Q651.3 171.8 647.1 169.2"/><text x="380" y="272" text-anchor="middle" class="a" style="font-size:17px">each CPU takes a 5 ms slice, spends it, comes back for more</text><text x="380" y="300" text-anchor="middle" class="r" style="font-size:17px">4 busy CPUs empty a 20 ms wallet in ~5 ms. Then the cgroup waits for the next period.</text></svg><figcaption>More threads on more CPUs drain the same wallet faster. That's why multi-threaded apps get throttled early.</figcaption></figure>

- At the start of each period, the cgroup's wallet is filled with its quota (20 ms here).
- Each CPU that's running one of the cgroup's threads takes a small slice out of the wallet (5 ms by default) and spends it, then comes back for more.
- When the wallet is empty, every CPU running that cgroup's threads stops running them, until a timer refills the wallet at the next period.

That's why the number of threads matters so much: four CPUs drain the wallet four times as fast as one.

#### See it for yourself

<div class="sim" id="thr-sim" aria-label="CPU throttling simulator">
<div class="sim-head"><span class="sim-badge">interactive</span> CPU limit simulator: one container, two 100 ms periods</div>
<div class="sim-controls">
<label><span>Busy threads</span><input type="range" id="sim-threads" min="1" max="8" step="1" value="4"><output id="sim-threads-v">4</output></label>
<label><span>CPU limit</span><input type="range" id="sim-limit" min="100" max="4000" step="100" value="200"><output id="sim-limit-v">200m</output></label>
<label><span>Work per request</span><input type="range" id="sim-work" min="5" max="100" step="5" value="30"><output id="sim-work-v">30 ms</output></label>
</div>
<svg id="sim-svg" viewBox="0 0 720 300" role="img" aria-label="Timeline of each thread running and throttled"></svg>
<div class="sim-out" id="sim-out"></div>
<p class="sim-note">Simplified: every thread always wants a CPU, the node has enough cores, and quota is spent evenly. The real kernel hands it out in 5 ms slices per CPU, so exact timings differ a little.</p>
</div>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var svg = $('sim-svg'), NS = 'http://www.w3.org/2000/svg';
  function el(tag, attrs, text) { var e = document.createElementNS(NS, tag); for (var k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; svg.appendChild(e); return e; }
  function draw() {
    var n = +$('sim-threads').value, lim = +$('sim-limit').value, work = +$('sim-work').value;
    $('sim-threads-v').textContent = n; $('sim-limit-v').textContent = lim + 'm'; $('sim-work-v').textContent = work + ' ms';
    var quota = lim / 10;                 /* ms of CPU per 100 ms period */
    var run = Math.min(100, quota / n);    /* wall-clock ms each thread runs per period */
    var throttled = run < 100;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var x0 = 90, W = 300, gap = 20, laneH = Math.min(26, Math.floor(200 / n)), top = 40;
    for (var p = 0; p < 2; p++) {
      var px = x0 + p * (W + gap);
      el('text', { x: px + W / 2, y: 22, 'text-anchor': 'middle', 'class': 'sim-t sim-m' }, 'period ' + (p + 1) + ' (100 ms)');
      for (var t = 0; t < n; t++) {
        var y = top + t * (laneH + 4);
        el('rect', { x: px, y: y, width: W * run / 100, height: laneH, 'class': 'sim-run', rx: 3 });
        if (throttled) el('rect', { x: px + W * run / 100, y: y, width: W * (100 - run) / 100, height: laneH, 'class': 'sim-thr', rx: 3 });
        if (p === 0) el('text', { x: x0 - 10, y: y + laneH * 0.7, 'text-anchor': 'end', 'class': 'sim-t' }, 'thread ' + (t + 1));
      }
    }
    var ly = top + n * (laneH + 4) + 26;
    el('rect', { x: x0, y: ly - 12, width: 14, height: 14, 'class': 'sim-run', rx: 2 }); el('text', { x: x0 + 20, y: ly, 'class': 'sim-t' }, 'running');
    el('rect', { x: x0 + 110, y: ly - 12, width: 14, height: 14, 'class': 'sim-thr', rx: 2 }); el('text', { x: x0 + 130, y: ly, 'class': 'sim-t' }, 'throttled (ready, but waiting)');
    svg.setAttribute('viewBox', '0 0 720 ' + (ly + 14));
    /* latency of one request that needs `work` ms of CPU on one thread */
    var wall, left = work, k = 0;
    if (!throttled) { wall = work; } else { while (left > run) { left -= run; k++; } wall = k * 100 + left; }
    var used = Math.min(n * 100, quota);
    var out = '<b>Quota:</b> ' + quota + ' ms of CPU per 100 ms period. ';
    if (throttled) {
      out += '<b>' + n + ' thread' + (n > 1 ? 's' : '') + '</b> use it up after <b>' + (+run.toFixed(1)) + ' ms</b> of wall time, then wait <b>' + (+(100 - run).toFixed(1)) + ' ms</b> for the next period. ';
      out += 'Average CPU looks like <b>' + Math.round(used * 10) + 'm</b>, yet the container is throttled in <b>every</b> period. ';
      out += 'A request needing ' + work + ' ms of CPU takes about <b class="sim-bad">' + Math.round(wall) + ' ms</b> to finish.';
    } else {
      out += 'Enough for ' + n + ' busy thread' + (n > 1 ? 's' : '') + ': <b class="sim-good">no throttling</b>. A request needing ' + work + ' ms of CPU takes about <b class="sim-good">' + work + ' ms</b>.';
    }
    $('sim-out').innerHTML = out;
  }
  ['sim-threads', 'sim-limit', 'sim-work'].forEach(function (id) { $(id).addEventListener('input', draw); });
  draw();
})();
</script>

**Try it yourself.** Two pods, both running four busy loops. `cpu-limited` has `limits.cpu: 200m`; `cpu-unlimited` has no limit:

```bash
kubectl -n lab apply -f modules/05-cpu-throttling/pods.yaml
kubectl -n lab wait --for=condition=Ready pod/cpu-limited pod/cpu-unlimited
kubectl -n lab exec cpu-limited -- cat /sys/fs/cgroup/cpu.stat
sleep 10
kubectl -n lab exec cpu-limited -- cat /sys/fs/cgroup/cpu.stat
```

<details class="predict"><summary><span class="predict-tag">Predict first</span> <code>cpu-limited</code> runs 4 busy loops on a 200m limit. Out of the next 100 periods, in how many will it be throttled?</summary><div class="predict-answer"><p>Nearly all 100. Four threads empty a 20 ms wallet in about 5 ms, every single period.</p></div></details>

| Line in `cpu.stat` | Meaning |
|---|---|
| `usage_usec` | Total CPU time used, in microseconds |
| `nr_periods` | How many 100 ms periods have passed while the group had work to do |
| `nr_throttled` | In how many of those it ran out of quota and had to wait |
| `throttled_usec` | Total time spent throttled |

Between the two reads, `nr_periods` and `nr_throttled` both go up by about 100: throttled in almost every period. The unlimited pod's `nr_throttled` stays at `0`. Over a longer sample:

```
pod             periods   throttled   CPU used (millicores)
cpu-limited     250       249         200
cpu-unlimited   -         0           several thousand
```

To watch throttling as it happens, keep the pods and open a second terminal:

```bash
KEEP=1 make 05-cpu-throttling     # terminal 1
make watch POD=cpu-limited        # terminal 2
```

Every second it prints the limit from `cpu.max`, the CPU used and the throttled periods from `cpu.stat`, and memory and pressure, with the file each number came from.

> [!DEEPER]
> **Two details that matter in production**
>
> - **`nr_periods` only counts busy periods.** It goes up only when the cgroup had work to do. So "40% throttled" means 40% of the periods when the service was actually doing something, not 40% of the day.
> - **`cpu.max.burst`.** Since Linux 5.14, a cgroup can carry unused quota forward and spend it in a burst later, up to the amount in `cpu.max.burst`. It suits apps that are idle most of the time and spiky occasionally. Kubernetes has no field for it today, but it's worth knowing the kernel has it.

*Shortcut:* `make 05-cpu-throttling`.

> [!KEY]
> A CPU limit never kills. It makes you wait, even on an idle node, and every thread in the container spends the same budget.

*Next question: we now have everything we need to explain the outage.*

---

### 15. The outage, explained

*Question: how did a pod at "80% of request" end up restarting?*

Back to the outage from the intro, one symptom at a time.

#### Why the CPU graph looked healthy

Three things hid the problem:

- **We compared usage with the wrong number.** "Below 80% of request" measures against `cpu.weight`, which never throttles anything. Throttling only comes from `cpu.max`, the limit.
- **Averages hide bursts.** A one-minute CPU graph averages 600 periods. Throttling happens inside a single 100 ms period: a burst of threads empties the wallet in a few milliseconds, then everything waits. A pod can be quiet most of the time and still hit the wall whenever a burst arrives.
- **"40% throttled" was 40% of busy periods** (chapter 14), so it was even worse than it looked during traffic.

A quick worked example with request = 2 cores and limit = 5 cores. Suppose that in 25% of periods a burst spends the full 500 ms wallet, and in the rest the pod is fairly quiet at about 40 ms:

```
average = 0.25 × 5 cores + 0.75 × 0.4 cores = 1.55 cores
        → about 78% of a 2-core request: the dashboard says "fine"
        → but throttled in 25% of periods
```

#### Why throttling broke the health probes

The kubelet runs three kinds of probes. All three are answered by threads inside the container, so all three freeze when the cgroup is throttled. What the kubelet does after a failure is different for each:

| Probe | Question it asks | When it fails |
|---|---|---|
| **Liveness** | "Is this process stuck?" | The kubelet **kills and restarts** the container |
| **Readiness** | "Can this pod take traffic right now?" | The pod is **removed from the Service's endpoints**. No restart |
| **Startup** | "Has the app finished booting?" | The container is restarted. Liveness and readiness wait until it passes |

A probe is an HTTP request with a deadline (`timeoutSeconds`, 1 second by default). A single freeze of a few tens of milliseconds won't break that, but the effects stack up:

1. **CPU time stretches into much more real time.** If the container's threads can only run for the first 25 ms of each 100 ms period, a request that needs 100 ms of CPU takes about 400 ms to finish.
2. **Queues fill up.** Slow requests hold on to worker threads, and new requests, including the probe, wait behind them.
3. **The probe misses its deadline** `failureThreshold` times in a row (3 by default).

**Liveness failure: the restart loop.** The container is killed and restarted. Warming up (loading caches, opening connection pools, compiling code) is often the most parallel work a service ever does, so a fresh container throttles hardest of all.

<figure class="sketch "><svg viewBox="0 0 760 300" role="img" aria-label="Throttling turns liveness failures into a restart loop"><title>Throttling turns liveness failures into a restart loop</title><defs><clipPath id="cpl1"><rect x="30" y="40" width="200" height="60"/></clipPath><clipPath id="cpl2"><rect x="290" y="40" width="200" height="60"/></clipPath><clipPath id="cpl3"><rect x="550" y="40" width="200" height="60"/></clipPath><clipPath id="cpl4"><rect x="550" y="200" width="200" height="60"/></clipPath><clipPath id="cpl5"><rect x="290" y="200" width="200" height="60"/></clipPath><clipPath id="cpl6"><rect x="30" y="200" width="200" height="60"/></clipPath></defs><path class="h y" clip-path="url(#cpl1)" d="M-22.4 100.9Q4.3 69.6 30.4 37.3M-13.0 102.7Q14.1 70.4 39.6 38.3M-1.1 100.8Q23.5 69.0 51.0 37.6M8.3 103.1Q34.0 69.1 60.8 37.6M18.0 103.0Q45.4 71.1 69.1 37.7M28.4 102.1Q55.2 70.5 80.5 39.1M38.3 102.2Q63.2 69.1 89.2 37.4M48.0 103.1Q74.4 69.4 101.3 37.4M58.8 102.3Q84.7 69.0 111.7 37.0M67.0 101.4Q94.1 69.9 120.7 38.1M78.8 101.0Q103.8 69.0 130.8 37.6M89.2 103.1Q115.0 70.4 140.8 38.0M97.8 102.9Q123.2 68.9 151.1 37.4M109.6 102.1Q136.2 71.2 162.1 38.9M119.2 102.1Q143.4 69.5 171.8 37.6M129.0 101.7Q153.8 69.6 181.0 38.5M139.2 102.5Q165.7 71.5 190.0 37.5M148.2 103.0Q175.0 69.5 201.4 37.2M159.3 102.9Q184.0 69.5 212.1 37.6M167.6 101.3Q196.0 71.4 220.1 37.8M179.4 103.2Q205.7 70.9 231.6 37.3M187.0 102.4Q212.4 69.2 239.0 38.8M197.0 103.0Q223.9 70.2 250.1 38.9M207.7 102.4Q234.7 70.8 258.7 38.5M216.9 102.7Q244.0 71.0 268.7 38.4M226.1 101.5Q251.1 69.1 279.2 38.7"/><path class="s y" d="M28.7 41.4Q130.3 39.0 229.8 41.1M28.7 40.9Q130.0 37.8 230.0 41.0"/><path class="s y" d="M231.1 41.5Q229.6 70.6 228.7 98.7M230.0 41.1Q229.2 69.7 228.7 101.4"/><path class="s y" d="M230.3 99.3Q130.6 100.8 30.3 99.7M231.2 100.2Q129.4 99.3 30.6 99.9"/><path class="s y" d="M29.1 100.8Q28.8 69.5 29.8 40.0M30.7 99.1Q30.9 69.9 30.8 38.7"/><text x="130" y="76" text-anchor="middle" style="font-size:17px">burst of threads</text><path class="h r" clip-path="url(#cpl2)" d="M238.4 102.8Q262.9 68.9 290.0 37.1M247.8 102.7Q273.0 69.8 299.6 38.6M256.8 101.9Q281.9 69.7 308.6 38.3M265.8 101.6Q291.5 69.9 316.5 38.5M274.8 102.2Q300.8 69.2 328.1 38.6M286.3 101.7Q312.7 70.6 337.8 38.7M294.9 102.3Q322.3 69.8 348.9 38.8M304.8 103.0Q330.9 70.2 357.6 38.6M316.5 101.7Q341.7 70.4 368.7 37.6M325.1 101.7Q353.5 71.3 377.4 39.2M336.0 101.0Q363.3 69.8 389.6 38.0M348.2 102.2Q372.4 69.5 399.3 38.0M358.3 101.7Q383.5 69.9 409.8 38.0M368.1 101.6Q394.3 69.8 420.2 39.0M378.5 101.9Q405.2 70.7 430.8 36.9M388.3 102.0Q413.2 69.7 439.9 38.4M398.3 100.8Q424.3 70.0 450.5 39.1M408.5 103.2Q434.4 70.1 459.7 38.1M417.5 101.5Q444.9 71.1 470.0 38.4M430.2 103.2Q455.5 70.6 481.9 37.6M438.8 102.0Q464.0 69.3 492.2 38.5M449.6 101.6Q474.7 69.0 500.7 37.5M458.7 102.1Q486.7 70.9 512.6 38.6M470.4 101.4Q496.2 70.4 522.9 38.4M481.6 101.0Q507.3 70.6 533.0 37.1"/><path class="s r" d="M290.6 39.9Q390.2 41.4 489.3 39.6M291.4 41.2Q389.7 40.3 488.5 39.4"/><path class="s r" d="M488.9 39.6Q489.3 69.9 488.7 100.8M488.9 41.4Q488.3 70.5 491.5 100.2"/><path class="s r" d="M489.5 101.4Q389.5 100.6 291.0 99.0M489.8 98.8Q389.6 99.7 290.8 99.1"/><path class="s r" d="M288.9 101.0Q290.9 69.8 289.3 41.3M289.1 100.1Q291.1 69.5 290.4 39.7"/><text x="390" y="76" text-anchor="middle" style="font-size:17px">wallet empty</text><path class="h r" clip-path="url(#cpl3)" d="M498.7 102.5Q523.3 70.0 551.0 38.2M508.2 100.9Q533.3 69.7 559.5 38.1M517.9 102.6Q543.5 69.7 568.3 38.1M526.9 101.2Q553.3 69.9 580.3 38.8M538.6 100.8Q563.1 69.0 589.5 38.1M547.5 102.4Q573.6 70.5 599.5 37.8M557.9 102.4Q583.5 69.1 611.2 39.2M567.5 102.7Q593.7 69.9 620.3 39.2M577.1 101.0Q604.5 70.3 630.5 39.0M587.8 102.5Q615.9 71.1 641.4 38.5M598.7 101.4Q625.5 69.8 650.7 37.6M609.2 102.1Q637.0 71.1 661.1 37.8M620.0 101.5Q645.6 69.6 672.5 37.0M630.7 100.9Q658.5 71.0 683.6 38.6M639.2 101.2Q666.6 70.3 692.0 37.1M651.3 101.9Q677.4 70.7 702.6 37.0M660.4 102.0Q686.2 69.4 713.5 38.9M671.0 101.8Q698.4 71.2 724.5 37.1M680.9 102.8Q708.0 70.9 733.3 38.0M690.1 100.8Q716.5 69.4 742.7 37.3M700.4 101.9Q726.0 69.3 753.0 37.7M711.3 100.9Q737.5 70.5 762.3 38.5M720.6 101.4Q746.9 69.9 772.9 38.0M730.3 102.2Q756.3 68.8 784.4 39.1M741.9 102.8Q767.0 69.3 793.7 37.1"/><path class="s r" d="M548.7 41.5Q649.5 37.9 748.7 40.8M549.1 41.2Q649.7 37.9 750.4 39.2"/><path class="s r" d="M749.8 39.4Q749.8 70.2 748.7 99.1M751.3 38.5Q751.0 69.9 750.9 99.9"/><path class="s r" d="M751.3 101.0Q650.2 99.0 551.6 98.8M750.1 100.6Q650.0 100.0 548.6 100.4"/><path class="s r" d="M549.3 101.4Q548.5 70.3 550.6 41.3M549.1 100.0Q550.0 69.7 551.0 39.7"/><text x="650" y="76" text-anchor="middle" style="font-size:17px">whole cgroup waits</text><path class="h a" clip-path="url(#cpl4)" d="M497.4 262.1Q523.7 229.8 549.2 198.9M506.3 262.5Q532.0 228.8 560.3 198.8M516.4 260.9Q542.6 230.3 569.4 197.2M525.8 261.7Q551.2 229.3 577.3 198.8M536.5 262.4Q564.0 230.5 589.2 197.9M545.5 261.3Q571.4 229.1 599.3 197.8M555.5 262.5Q584.3 230.5 608.8 199.0M565.4 263.2Q592.4 230.9 618.2 199.2M575.7 261.4Q603.0 230.6 629.2 197.6M585.3 261.1Q613.1 231.1 638.4 196.9M596.4 261.6Q621.7 229.4 649.1 198.0M605.2 261.4Q632.7 230.7 657.5 198.0M615.5 262.0Q640.0 229.2 668.1 198.4M624.4 262.9Q650.0 228.4 678.4 198.4M636.5 262.7Q660.0 229.0 687.6 198.6M646.1 261.9Q671.0 229.0 699.4 197.2M656.3 261.0Q682.7 230.3 707.9 199.0M666.5 261.4Q691.3 229.5 719.3 198.4M676.2 263.1Q701.4 229.3 727.0 198.7M685.0 263.1Q711.4 229.7 738.5 197.1M695.1 262.9Q720.3 230.4 747.1 199.1M705.3 262.2Q729.6 229.2 756.9 198.5M714.0 261.4Q740.0 230.5 766.6 197.9M724.2 261.3Q750.2 229.9 775.4 198.8M734.9 262.6Q760.9 230.3 787.6 199.2M745.1 263.1Q771.6 229.9 798.8 198.8"/><path class="s a" d="M548.6 200.7Q649.5 201.0 751.2 201.3M550.7 200.5Q650.2 199.5 750.0 199.8"/><path class="s a" d="M751.1 200.9Q750.9 230.4 748.6 259.9M751.2 199.6Q748.4 230.0 751.5 259.5"/><path class="s a" d="M750.2 260.7Q650.2 260.7 550.8 258.8M750.0 259.3Q649.6 256.9 550.9 258.7"/><path class="s a" d="M548.5 259.4Q549.9 230.4 551.5 201.2M549.0 259.2Q551.3 229.8 549.9 200.1"/><text x="650" y="236" text-anchor="middle" style="font-size:17px">probe times out</text><path class="h b" clip-path="url(#cpl5)" d="M238.3 262.9Q262.7 229.7 289.0 197.2M247.3 262.2Q272.6 229.4 298.6 198.1M257.1 262.9Q282.3 229.5 308.2 198.6M268.8 261.2Q295.5 231.4 320.6 197.2M276.2 263.0Q303.0 230.1 329.3 196.9M288.3 261.2Q314.4 230.3 339.8 197.6M296.2 262.5Q323.5 230.5 349.8 198.0M307.6 260.9Q334.2 231.3 358.9 198.1M316.2 263.2Q343.0 229.9 369.4 198.0M325.9 262.3Q353.4 231.3 378.6 198.0M335.2 263.0Q361.3 229.9 387.8 197.1M345.4 262.7Q371.1 230.2 396.5 199.0M354.7 262.5Q382.3 231.2 407.9 197.0M366.6 262.2Q391.5 229.2 417.2 197.8M375.9 261.2Q401.8 230.7 427.9 199.2M385.5 262.3Q410.1 229.5 435.8 198.1M394.1 261.0Q421.2 230.1 447.5 198.4M405.2 262.4Q433.4 230.7 459.0 198.8M417.1 261.5Q441.6 229.7 467.2 197.0M426.3 263.2Q451.7 230.2 478.6 198.5M436.0 261.4Q462.7 231.2 486.7 197.4M443.9 263.1Q471.3 230.2 497.2 199.1M454.9 260.9Q480.9 230.3 505.8 196.9M464.0 261.4Q490.3 231.3 515.3 197.5M473.6 261.5Q499.5 229.7 524.0 198.5M482.8 261.7Q510.9 231.3 535.7 198.4"/><path class="s b" d="M290.8 198.5Q389.7 199.2 491.0 199.6M289.6 201.3Q390.0 199.2 489.2 200.1"/><path class="s b" d="M491.6 200.8Q489.7 229.8 489.8 259.5M489.6 198.8Q488.9 229.6 490.5 259.6"/><path class="s b" d="M490.1 259.0Q389.7 257.2 289.9 261.1M491.2 258.6Q390.1 261.2 289.7 260.9"/><path class="s b" d="M288.6 259.7Q291.6 230.0 290.6 201.4M291.0 258.8Q289.7 230.5 291.2 201.5"/><text x="390" y="236" text-anchor="middle" style="font-size:17px">container restarted</text><path class="h y" clip-path="url(#cpl6)" d="M-21.6 261.1Q3.1 229.4 30.3 197.4M-13.1 262.5Q15.3 231.0 40.9 198.2M-2.5 261.0Q22.7 229.2 49.8 196.8M6.1 261.7Q33.6 231.1 59.2 198.4M16.6 260.9Q41.4 230.5 67.6 198.3M25.6 261.2Q53.1 230.4 78.3 198.2M36.8 261.7Q63.8 230.8 89.2 197.7M47.4 261.5Q73.8 229.6 100.7 198.3M56.2 262.1Q83.9 230.2 110.5 198.4M67.0 261.2Q93.8 230.3 120.7 196.9M77.8 261.1Q103.3 229.8 129.4 197.0M87.1 262.4Q113.3 230.6 139.4 197.0M97.2 261.8Q124.1 230.5 150.0 199.2M107.5 262.0Q133.5 228.4 160.2 198.2M119.9 261.5Q146.7 231.2 171.1 196.9M128.8 262.9Q155.1 229.9 181.5 197.0M140.9 261.7Q166.4 229.9 192.5 197.4M150.4 260.9Q177.8 231.0 202.2 198.3M162.6 262.5Q188.4 230.2 215.1 197.4M172.5 262.9Q199.2 230.6 224.9 198.9M183.2 263.1Q207.7 229.2 235.3 197.1M193.7 262.6Q218.6 229.5 244.3 198.9M202.3 262.3Q229.0 230.1 256.1 198.6M211.7 262.1Q239.1 230.8 265.5 198.6M222.4 260.8Q247.7 228.5 274.8 197.4"/><path class="s y" d="M31.3 199.5Q130.1 201.1 228.8 199.6M29.4 198.6Q130.4 200.0 229.8 198.7"/><path class="s y" d="M231.0 199.2Q230.1 229.9 229.9 259.6M231.0 199.9Q228.7 230.5 230.7 258.9"/><path class="s y" d="M228.6 259.3Q130.5 260.4 29.9 260.5M228.8 261.1Q130.3 263.1 31.1 261.3"/><path class="s y" d="M30.4 259.3Q30.2 230.3 29.5 201.0M28.4 261.0Q28.7 230.5 31.1 199.2"/><text x="130" y="236" text-anchor="middle" style="font-size:17px">warmup: biggest burst</text><path class="s" d="M232.1 68.7Q258.6 68.4 286.4 68.7M232.1 70.0Q259.6 68.9 284.7 71.0"/><path class="s" d="M286.0 69.6Q281.2 73.6 275.7 74.7M286.1 70.4Q281.0 72.8 275.5 74.1"/><path class="s" d="M286.5 70.6Q280.5 68.9 276.5 64.8M285.7 69.4Q280.7 68.4 276.7 65.4"/><path class="s" d="M490.8 70.1Q519.0 70.9 546.7 70.5M491.8 70.9Q518.5 69.3 547.5 68.9"/><path class="s" d="M546.3 69.6Q541.0 73.0 535.7 74.4M545.3 69.7Q540.6 71.2 536.4 74.8"/><path class="s" d="M545.4 69.5Q541.0 68.3 535.6 64.6M546.3 69.3Q541.0 68.0 536.5 65.7"/><path class="s" d="M650.4 103.4Q651.1 149.2 651.3 196.1M649.4 102.0Q650.7 148.7 648.9 195.4"/><path class="s" d="M649.6 196.5Q648.6 190.3 644.4 185.8M649.9 196.5Q647.1 191.4 645.9 185.6"/><path class="s" d="M650.3 195.9Q652.3 190.9 654.1 186.4M649.9 196.2Q651.6 190.4 655.0 186.7"/><path class="s" d="M547.1 230.5Q520.7 231.3 495.1 228.6M547.0 231.5Q521.3 232.5 495.4 229.1"/><path class="s" d="M494.3 229.3Q498.5 227.1 504.0 225.7M494.2 230.8Q498.6 227.2 503.6 224.5"/><path class="s" d="M493.6 230.5Q498.9 231.7 504.0 235.0M493.4 230.8Q499.0 232.5 503.9 235.3"/><path class="s" d="M288.6 229.4Q260.4 230.1 235.2 231.5M288.8 230.0Q261.4 229.2 235.5 231.2"/><path class="s" d="M234.1 230.2Q239.3 229.0 243.3 225.6M234.0 230.5Q239.2 227.7 244.3 225.2"/><path class="s" d="M233.9 229.4Q239.2 232.1 244.7 234.0M234.2 230.7Q238.4 233.5 243.4 235.4"/><path class="s" d="M130.9 197.9Q128.9 150.8 128.6 103.2M128.7 199.5Q130.2 151.2 129.6 104.8"/><path class="s" d="M130.8 103.4Q131.9 109.5 134.1 113.4M130.8 104.3Q132.2 109.4 134.7 113.3"/><path class="s" d="M130.2 103.7Q127.3 108.5 126.0 114.5M130.3 103.3Q127.7 109.1 125.5 113.9"/><text x="638" y="155" text-anchor="end" class="m" style="font-size:15px">slow requests, full queues</text><text x="380" y="290" text-anchor="middle" class="r" style="font-size:17px">liveness failures: each restart starts the next, bigger burst</text></svg><figcaption>A throttled container can't answer its liveness probe. The restart's warmup burst throttles it again.</figcaption></figure>

**Readiness failure: the quiet cascade.** Nothing restarts, so it's harder to spot. The pod drops out of the Service, its traffic moves to the other pods, their bursts get bigger, they drain their wallets faster and start failing readiness too. Callers see timeouts and 503s.

<figure class="sketch "><svg viewBox="0 0 760 300" role="img" aria-label="Readiness failures spread load and throttling to other pods"><title>Readiness failures spread load and throttling to other pods</title><defs><clipPath id="crc1"><rect x="30" y="40" width="210" height="60"/></clipPath><clipPath id="crc2"><rect x="290" y="40" width="210" height="60"/></clipPath><clipPath id="crc3"><rect x="550" y="40" width="210" height="60"/></clipPath><clipPath id="crc4"><rect x="420" y="200" width="210" height="60"/></clipPath><clipPath id="crc5"><rect x="100" y="200" width="210" height="60"/></clipPath></defs><path class="h r" clip-path="url(#crc1)" d="M-23.0 102.8Q2.8 69.5 29.2 37.8M-10.5 101.9Q14.3 69.1 39.6 37.1M-2.4 101.8Q25.5 71.1 49.7 38.8M8.2 101.3Q36.1 71.6 60.2 37.6M20.4 102.1Q45.3 69.8 71.9 37.8M29.6 103.2Q56.6 70.3 83.3 38.1M40.3 102.7Q66.4 69.7 93.7 37.7M50.6 100.9Q77.2 70.5 101.7 37.5M60.4 101.3Q87.4 71.3 113.0 38.5M70.4 101.5Q96.1 68.5 124.2 38.8M80.8 102.8Q105.5 68.7 132.1 38.6M92.7 102.9Q116.1 69.5 144.4 37.7M99.7 102.7Q126.2 69.6 152.4 37.3M109.9 100.8Q138.5 71.4 162.8 37.8M119.8 101.6Q147.3 69.7 174.2 38.9M129.4 102.1Q155.9 69.5 182.9 38.3M140.9 102.5Q166.6 69.9 193.7 39.0M151.2 100.9Q176.0 69.1 202.3 37.6M159.7 101.3Q187.2 70.2 212.2 37.1M171.7 101.4Q198.3 70.1 223.9 37.2M182.6 102.8Q208.7 69.9 234.6 38.5M192.0 101.4Q219.9 70.5 245.3 38.7M202.4 102.6Q226.9 69.4 254.9 37.8M211.7 101.3Q238.8 70.4 263.8 38.3M221.2 102.2Q248.0 70.0 273.3 39.1M232.2 102.9Q258.7 70.9 284.3 39.0"/><path class="s r" d="M30.8 41.2Q134.4 39.8 240.2 41.2M30.0 41.0Q135.4 37.8 240.2 39.0"/><path class="s r" d="M241.1 39.6Q239.6 69.9 239.5 99.5M239.7 40.6Q241.4 69.8 240.6 99.4"/><path class="s r" d="M239.9 99.3Q134.8 100.2 28.5 100.8M239.0 99.5Q135.2 99.7 30.4 100.4"/><path class="s r" d="M28.9 99.0Q31.9 70.1 31.6 41.1M29.8 101.0Q29.5 69.9 29.0 39.2"/><text x="135" y="76" text-anchor="middle" style="font-size:17px">pod A throttled</text><path class="h a" clip-path="url(#crc2)" d="M237.6 101.9Q264.7 70.5 291.0 38.6M247.7 101.1Q274.3 70.7 299.6 37.2M255.8 101.6Q281.6 68.8 310.0 37.2M266.8 101.9Q291.5 69.4 317.6 38.4M274.4 101.8Q301.0 70.3 327.3 37.7M285.0 102.9Q311.7 70.7 338.2 38.7M293.8 102.6Q321.9 70.6 346.2 37.1M306.5 102.4Q332.4 70.3 358.7 38.0M314.0 102.2Q340.4 69.7 366.2 37.7M323.7 100.8Q352.0 71.5 377.5 38.6M334.6 101.5Q362.3 70.6 387.4 38.3M346.7 101.1Q370.9 69.1 398.5 36.9M356.0 101.4Q382.1 70.3 409.4 37.3M366.0 101.5Q393.6 70.1 419.1 36.9M378.3 103.0Q403.5 70.0 428.4 38.1M387.6 101.2Q412.0 70.3 438.8 38.2M397.1 101.9Q424.7 71.2 450.5 38.7M406.0 101.1Q431.8 70.1 457.8 39.0M417.2 102.3Q441.8 68.5 469.4 38.8M427.6 102.5Q454.6 70.5 480.6 37.4M436.9 101.5Q462.5 69.1 488.9 38.0M446.3 101.1Q473.5 70.4 499.7 38.4M456.6 101.7Q483.2 70.0 508.0 37.9M466.0 103.0Q492.2 70.1 517.2 38.2M477.6 102.7Q502.4 69.3 528.1 39.0M486.4 102.7Q514.5 71.2 540.2 39.1M498.5 101.1Q524.2 69.6 550.3 38.0"/><path class="s a" d="M288.9 38.8Q394.4 41.9 501.3 40.0M289.1 39.5Q395.2 40.6 499.4 39.6"/><path class="s a" d="M501.0 41.0Q499.5 70.3 498.4 98.8M500.4 39.7Q501.9 70.6 500.9 101.3"/><path class="s a" d="M500.0 98.5Q395.2 97.5 291.4 100.9M499.8 99.1Q394.4 98.5 289.3 100.5"/><path class="s a" d="M288.5 98.9Q288.4 69.6 290.1 40.1M289.8 100.3Q290.4 70.3 289.5 41.1"/><text x="395" y="76" text-anchor="middle" style="font-size:17px">readiness fails</text><path class="h b" clip-path="url(#crc3)" d="M498.3 102.4Q522.4 68.8 549.9 37.1M508.0 100.8Q532.9 69.2 558.7 38.5M517.3 103.2Q545.1 70.8 571.4 37.2M527.9 101.4Q556.3 70.8 580.8 38.5M539.9 101.5Q564.7 69.3 591.6 38.8M549.9 100.9Q575.8 69.3 601.3 38.1M561.7 102.6Q586.3 69.3 613.2 36.9M569.0 101.9Q595.1 69.1 623.0 38.9M578.6 101.6Q604.2 69.7 630.8 38.0M589.4 102.2Q614.7 68.5 641.6 36.8M599.3 101.3Q626.6 69.9 652.6 38.9M610.1 101.6Q637.3 70.0 663.9 38.5M620.2 101.1Q645.3 68.8 673.5 37.9M632.3 101.0Q658.6 70.9 684.5 39.1M642.6 102.9Q667.3 69.9 694.8 39.1M650.4 101.3Q676.6 69.5 704.0 38.6M660.3 102.3Q686.7 69.6 713.9 38.3M669.7 101.9Q694.7 69.2 722.2 37.1M680.5 101.7Q704.9 69.1 730.9 37.4M690.0 102.9Q714.6 69.3 742.9 37.5M701.6 102.8Q726.3 69.8 751.6 37.3M709.8 102.0Q735.4 68.6 763.6 38.4M720.5 102.7Q745.5 69.3 772.6 38.4M729.0 103.1Q756.0 70.0 783.3 37.8M739.7 102.0Q765.3 68.7 791.8 38.9M751.2 101.3Q775.7 68.8 802.0 38.4"/><path class="s b" d="M548.5 39.9Q654.8 41.2 760.5 40.0M551.4 40.4Q655.2 41.1 759.6 41.3"/><path class="s b" d="M760.1 41.3Q757.8 70.0 760.7 98.8M759.3 40.6Q759.9 70.2 759.2 101.6"/><path class="s b" d="M759.1 99.8Q654.8 98.7 550.9 99.4M758.9 98.4Q655.5 99.4 550.1 101.4"/><path class="s b" d="M549.6 99.1Q552.1 69.9 549.4 38.5M550.1 99.3Q550.5 70.2 551.5 40.2"/><text x="655" y="76" text-anchor="middle" style="font-size:17px">A removed from Service</text><path class="h y" clip-path="url(#crc4)" d="M368.3 262.2Q394.9 230.5 419.3 198.8M376.9 261.1Q404.2 229.7 430.0 198.9M388.7 261.1Q413.7 229.1 441.8 197.9M399.2 261.1Q425.2 230.5 451.6 197.2M408.0 263.0Q434.9 230.2 460.4 199.1M418.8 261.0Q444.1 230.0 469.5 198.0M428.3 263.2Q455.3 230.2 480.1 197.7M439.4 261.1Q465.3 230.8 491.2 198.9M448.6 260.8Q473.6 229.6 500.0 197.6M457.7 263.2Q482.4 229.0 509.7 198.8M467.1 261.2Q493.2 229.6 519.3 198.6M478.1 261.3Q503.5 229.9 530.6 197.6M486.5 262.1Q511.6 228.3 539.7 197.9M495.7 261.2Q523.3 230.3 549.2 198.3M506.1 261.4Q531.3 229.4 558.4 197.9M516.6 262.7Q543.0 230.7 567.9 199.2M524.9 262.4Q550.1 229.5 577.2 198.6M535.4 263.0Q561.3 229.0 587.4 198.9M547.3 261.9Q573.2 230.9 597.3 198.0M557.5 262.8Q582.7 229.9 609.9 197.7M568.2 262.1Q593.3 229.3 620.7 197.9M578.6 261.6Q604.4 230.6 629.2 197.9M587.0 262.5Q613.1 229.9 640.2 198.3M597.2 261.6Q624.1 230.6 649.5 197.4M606.9 261.8Q633.4 228.9 660.0 197.9M616.6 261.8Q641.5 228.9 668.5 199.1M626.1 262.9Q654.3 231.1 679.3 198.5"/><path class="s y" d="M419.4 199.2Q524.5 198.7 629.7 198.6M420.4 198.5Q525.1 197.7 628.7 198.8"/><path class="s y" d="M629.2 200.6Q632.8 230.1 631.0 259.9M629.0 198.8Q630.8 229.9 631.2 261.2"/><path class="s y" d="M630.5 259.8Q524.6 259.0 420.0 258.4M630.0 260.0Q524.6 258.5 420.5 259.4"/><path class="s y" d="M418.8 260.0Q420.5 230.2 419.1 198.7M420.3 259.8Q418.9 229.6 420.3 200.8"/><text x="525" y="236" text-anchor="middle" style="font-size:17px">B and C get A's traffic</text><path class="h r" clip-path="url(#crc5)" d="M47.9 262.4Q75.2 231.0 99.3 197.1M59.6 261.1Q84.0 229.4 111.4 197.8M67.7 261.7Q94.5 229.2 120.7 198.2M78.8 262.4Q103.0 229.0 129.5 197.2M88.3 262.6Q113.3 230.0 139.0 197.6M98.7 261.5Q124.7 230.3 151.1 198.1M107.5 261.6Q134.8 229.9 159.5 197.2M119.7 261.4Q143.5 229.5 171.2 196.8M130.1 262.5Q154.8 229.7 182.2 197.0M138.3 262.7Q165.6 230.6 190.1 197.9M147.7 262.0Q173.4 229.5 200.4 197.0M156.6 262.7Q181.8 229.1 209.7 197.1M167.2 262.8Q192.5 229.9 219.5 198.3M177.6 262.7Q203.4 229.2 229.9 197.9M187.4 261.7Q212.7 230.1 238.8 198.9M197.4 262.6Q222.8 229.8 249.3 197.7M206.6 263.0Q231.4 229.9 258.1 197.5M217.8 261.5Q242.1 229.5 267.8 199.2M225.3 261.3Q254.0 230.8 279.5 198.3M236.5 263.0Q260.9 229.9 286.8 198.8M244.7 262.1Q272.7 230.3 296.9 197.3M256.6 262.9Q282.7 230.8 307.6 198.5M266.5 261.4Q291.4 229.1 318.4 197.4M277.7 262.6Q303.3 229.8 328.6 197.9M286.9 262.2Q313.2 230.0 340.0 196.9M297.6 263.1Q322.1 228.8 349.7 197.4M306.5 261.5Q331.7 229.1 359.4 198.4"/><path class="s r" d="M98.7 198.7Q205.2 199.6 311.0 198.6M100.4 200.6Q205.1 197.9 310.1 200.9"/><path class="s r" d="M310.2 198.7Q310.1 229.8 310.6 261.4M310.1 200.9Q310.2 229.7 310.0 260.2"/><path class="s r" d="M308.8 260.9Q205.0 256.9 100.3 259.3M309.0 259.9Q204.4 261.8 100.8 259.4"/><path class="s r" d="M101.5 259.6Q99.8 229.8 99.6 200.8M101.4 258.7Q100.6 230.5 99.4 200.9"/><text x="205" y="236" text-anchor="middle" style="font-size:17px">B and C throttled</text><path class="s" d="M243.0 69.3Q263.6 68.9 285.2 71.1M240.8 68.9Q264.5 71.4 286.4 70.1"/><path class="s" d="M286.3 69.3Q280.3 71.3 276.9 75.6M286.6 69.7Q281.4 72.8 276.2 74.1"/><path class="s" d="M286.3 69.9Q280.6 68.3 276.2 65.4M285.8 69.9Q281.2 67.0 275.5 65.6"/><path class="s" d="M502.8 69.2Q523.9 70.8 545.6 68.8M501.8 70.4Q523.4 70.9 546.6 71.0"/><path class="s" d="M546.6 69.8Q541.8 73.2 536.6 75.0M545.4 69.2Q540.8 71.4 535.9 74.0"/><path class="s" d="M545.8 70.3Q541.2 67.2 536.8 65.5M546.5 69.7Q540.7 67.7 535.6 65.9"/><path class="s" d="M655.7 101.2Q607.4 148.8 561.0 194.7M655.3 103.0Q607.4 148.5 560.5 197.1"/><path class="s" d="M559.7 196.7Q562.7 191.2 564.2 185.4M559.6 196.0Q561.4 190.6 564.1 185.0"/><path class="s" d="M560.8 195.8Q565.0 193.2 570.6 192.6M559.7 196.0Q565.0 193.4 570.3 192.9"/><path class="s" d="M419.0 229.3Q365.5 227.8 312.5 231.4M417.5 229.8Q366.0 231.0 313.0 229.8"/><path class="s" d="M313.9 230.5Q318.2 226.6 324.5 225.1M314.7 230.6Q318.7 226.9 324.0 225.4"/><path class="s" d="M313.2 230.5Q318.2 233.2 324.4 234.4M314.4 230.0Q318.9 233.0 323.6 234.1"/><path class="s" d="M218.8 199.2Q275.6 152.5 329.8 105.2M221.0 196.9Q273.5 149.5 329.2 103.6"/><path class="s" d="M330.6 104.8Q327.1 108.8 325.8 114.7M329.6 103.4Q328.2 109.1 324.9 114.5"/><path class="s" d="M329.7 104.2Q324.9 106.5 318.9 106.3M329.9 104.1Q324.7 106.2 319.9 106.1"/><text x="380" y="290" text-anchor="middle" class="r" style="font-size:17px">readiness failures: no restarts, so it's harder to spot</text></svg><figcaption>Pulling a throttled pod out of the Service pushes its traffic onto the others, which then throttle too.</figcaption></figure>

#### Why raising the limit fixed it

Going from 5 cores to 8 grew the wallet from 500 ms to 800 ms per period. Normal bursts now finished before it ran dry, so `nr_throttled` stopped climbing. We still saw a little throttling during warmup, which fits: warmup runs more threads in parallel than even 8 cores of budget covers.

#### Why it started "out of nowhere"

Throttling depends on **how many threads want to run at once**, and that can change without anyone changing code:

- **Bigger nodes.** A container can see every core on the host. Modern runtimes (JDK 10+, Go 1.25+) size their thread pools from the CPU limit, but custom pools, native libraries and older runtimes often count host cores. Move to bigger nodes and the same service starts more threads against the same wallet.
- **Burstier traffic** at the same daily volume: synchronized retries, fan-out from callers, cron-driven clients.

We never confirmed the exact trigger, which is common, and it's why the throttling ratio belongs on a dashboard before you need it.

#### What I check now

The throttle ratio, per pod:

```promql
sum by (pod) (rate(container_cpu_cfs_throttled_periods_total[5m]))
/
sum by (pod) (rate(container_cpu_cfs_periods_total[5m]))
```

How many seconds per second a pod spends frozen:

```promql
rate(container_cpu_cfs_throttled_seconds_total[5m])
```

And, when the image has `ps`, how many threads want a CPU right now (`R` means running or waiting to run):

```bash
kubectl exec <pod> -- sh -c 'for i in $(seq 20); do ps -eLo stat | grep -c ^R; sleep 0.2; done'
```

If that number regularly goes above your CPU limit in cores, the wallet is being drained. The lasting fix is to size thread pools and workers to the limit (or the request, if you drop the limit); raising the limit, like we did, buys time.

And for the probes:

- **Keep liveness cheap and local** ("is the process responsive?", not "are my dependencies up?"), and give it a more generous `timeoutSeconds` and `failureThreshold` than readiness, so a short throttling episode doesn't kill the pod.
- **Use a `startupProbe` for slow warmups**, so liveness can't kill a pod that's only slow because it's throttled while booting.
- **Watch for readiness churn** (pods flipping between ready and not ready) next to the throttle ratio. Churn with no restarts is the quiet version of this outage.

*Try a small version of this outage yourself:* `make incident-1`.

#### Should you even set CPU limits?

This is one of the longest-running debates in Kubernetes, and after building this lab I understand why.

**The case against.** A CPU limit throttles you even when the node is idle, as the lab showed. And if your requests are honest, you're already protected when CPUs are busy: `cpu.weight` makes sure everyone gets their share. So a lot of teams set good CPU requests and simply drop CPU limits for latency-sensitive services. Spare CPU gets used instead of wasted, and those throttled gaps disappear.

**The case for.** Limits still earn their place when:

- you run untrusted or multi-tenant workloads and need hard isolation between them;
- you want predictable performance. Without a limit, a service is fast on a quiet node and slower on a busy one, which makes load tests misleading;
- you need the Guaranteed QoS class, for example for exclusive CPU cores with the static CPU manager, since Guaranteed requires limits equal to requests;
- it's a batch job you deliberately want capped.

**What I do.** Always set memory limits. For CPU, set honest requests everywhere, drop limits on latency-sensitive services, and keep them where isolation or predictability matters more than raw speed. Either way, watch the throttling ratio before and after the change. One catch: runtimes like Go and the JVM size their thread pools from the CPU limit, so without one they see every core on the host. Set `GOMAXPROCS` or `-XX:ActiveProcessorCount` explicitly to match your request.

If you want both sides argued in depth, [learnk8s on CPU requests and limits](https://itnext.io/cpu-limits-and-requests-in-kubernetes-fa9d55948b7c) and [Why you should keep using CPU limits](https://dnastacio.medium.com/why-you-should-keep-using-cpu-limits-on-kubernetes-60c4e50dfc61) are good reads.

> [!KEY]
> Throttling hides behind averages, freezes your probes along with everything else, and comes from concurrency, not usage. Watch the ratio.

---

## Part 5: Memory

CPU can make you wait. Memory can't (chapter 6), so it fails in a completely different way.

### 16. Memory limits and the OOM killer

*Question: what happens when a container reaches `memory.max`?*

If a program needs more memory and its box is full, waiting doesn't help.

<figure class="sketch anim"><svg viewBox="0 0 760 330" role="img" aria-label="Reaching the memory limit leads to reclaim, then possibly an OOM kill"><title>Reaching the memory limit leads to reclaim, then possibly an OOM kill</title><defs><clipPath id="com1"><rect x="62" y="70" width="156" height="220"/></clipPath></defs><g class="anim-fill"><path class="h b" clip-path="url(#com1)" d="M-129.7 292.6Q-33.3 180.5 62.5 68.4M-124.6 292.0Q-29.9 179.1 66.8 68.8M-116.4 292.9Q-21.3 179.3 73.3 68.5M-110.1 292.3Q-14.3 181.2 79.8 67.0M-103.4 292.8Q-8.1 179.6 88.1 66.8M-97.3 291.7Q-3.8 178.7 93.5 68.9M-93.2 291.4Q3.3 180.2 99.0 67.3M-86.3 293.0Q9.1 179.8 104.1 67.6M-79.3 291.6Q15.7 179.7 111.3 67.5M-72.5 293.0Q22.5 180.2 116.5 68.2M-67.0 291.7Q28.3 180.2 123.3 67.4M-61.9 292.7Q32.3 179.4 130.3 68.7M-56.0 292.4Q39.6 181.3 134.2 67.0M-52.2 291.2Q44.1 180.4 139.1 68.5M-45.7 291.9Q49.6 179.8 146.7 68.6M-41.4 292.6Q54.5 179.4 151.2 67.8M-33.3 292.3Q61.7 180.0 157.5 69.2M-26.9 292.1Q68.0 179.6 163.6 68.2M-20.5 292.1Q75.8 180.6 170.6 66.8M-14.4 291.3Q82.3 181.2 175.7 68.0M-8.3 293.2Q85.6 179.2 181.7 69.0M-2.6 292.4Q92.3 179.1 190.1 68.7M4.0 291.4Q98.3 178.6 194.8 68.1M11.2 291.6Q107.5 180.7 202.4 68.8M15.2 292.1Q111.7 180.4 206.2 68.0M20.7 291.3Q115.5 179.2 212.1 67.3M28.0 292.1Q124.3 180.5 219.1 68.1M34.8 291.6Q129.3 178.8 226.6 68.9M42.1 292.7Q137.1 179.5 232.7 67.6M47.5 291.4Q144.7 180.4 238.6 66.8M53.1 291.2Q148.9 180.4 245.6 67.0M59.6 291.5Q155.3 181.1 251.1 69.0M66.0 292.4Q159.3 179.4 257.0 68.7M70.4 291.4Q165.7 179.6 260.8 67.8M77.5 290.9Q171.9 178.8 269.0 68.0M84.3 292.6Q177.9 179.8 273.8 67.3M89.2 291.7Q186.1 180.7 280.1 67.3M95.2 292.4Q192.2 180.7 285.7 68.9M102.7 292.5Q196.6 179.3 292.5 69.1M108.5 293.1Q205.4 180.9 300.0 69.1M113.5 290.9Q208.4 178.5 304.5 67.9M118.9 291.7Q214.4 179.3 310.0 68.2M126.9 292.5Q220.1 178.9 316.6 68.3M132.4 291.9Q229.9 180.7 323.5 68.6M137.7 292.0Q235.2 181.5 329.0 67.7M143.9 292.6Q241.4 181.0 335.3 67.3M152.7 291.1Q246.2 178.6 341.8 67.9M155.9 291.0Q253.0 180.2 347.2 67.9M164.5 292.9Q259.4 180.1 354.1 68.4M169.8 292.6Q266.5 181.2 359.7 67.6M173.8 291.5Q269.5 179.2 365.6 67.0M181.0 292.6Q276.0 179.7 371.8 67.4M188.0 292.8Q282.1 180.0 378.8 67.9M193.8 291.3Q288.1 179.0 384.8 68.8M198.9 291.4Q294.4 178.8 391.7 68.8M204.6 292.3Q300.1 179.3 398.2 67.6M212.6 292.2Q308.6 180.5 403.6 68.2"/><path class="s b" d="M60.5 68.8Q140.5 69.9 218.0 70.7M61.6 70.5Q139.4 71.5 217.7 69.3"/><path class="s b" d="M219.4 69.4Q219.8 180.1 217.9 291.5M217.8 68.7Q216.7 180.3 216.7 290.0"/><path class="s b" d="M217.2 289.8Q139.7 291.3 62.0 288.4M218.0 289.1Q139.7 288.0 60.5 288.8"/><path class="s b" d="M61.1 289.0Q59.5 179.8 63.1 70.2M60.5 290.8Q61.9 180.5 62.5 69.7"/></g><path class="s" d="M51.1 48.6Q55.9 172.6 58.7 295.4M48.5 51.0Q56.2 172.3 59.0 294.5"/><path class="s" d="M231.4 49.4Q224.3 172.9 219.1 294.9M230.7 49.1Q223.5 172.6 220.2 294.8"/><path class="s" d="M60.4 295.7Q139.8 297.0 220.9 295.8M60.7 294.4Q140.6 292.5 218.7 294.6"/><path class="s r" d="M30.5 99.8Q34.8 99.4 40.0 100.2"/><path class="s r" d="M47.6 100.7Q51.8 99.5 57.2 100.5"/><path class="s r" d="M64.6 99.5Q69.2 100.0 74.0 99.3"/><path class="s r" d="M81.1 99.7Q86.0 100.3 90.4 99.7"/><path class="s r" d="M98.5 99.6Q102.9 101.0 107.9 100.5"/><path class="s r" d="M115.3 99.2Q120.2 98.8 125.2 99.3"/><path class="s r" d="M131.8 99.6Q137.1 99.6 141.8 99.7"/><path class="s r" d="M149.4 100.5Q153.8 99.3 158.8 100.7"/><path class="s r" d="M166.4 100.7Q171.2 99.8 176.2 100.6"/><path class="s r" d="M183.1 99.3Q188.0 99.5 192.6 100.2"/><path class="s r" d="M200.1 99.4Q205.1 99.8 209.9 100.7"/><path class="s r" d="M216.8 99.5Q221.7 99.7 227.0 100.7"/><path class="s r" d="M233.9 99.6Q238.8 99.8 244.7 100.6"/><text x="140" y="88" text-anchor="middle" class="r" style="font-size:19px">memory.max</text><path class="s" d="M300.3 30.1Q515.4 31.6 730.1 30.1M300.5 29.2Q514.7 28.5 730.9 30.4"/><path class="s" d="M729.3 30.7Q731.1 69.6 729.7 111.0M731.2 29.9Q729.5 70.4 730.5 110.4"/><path class="s" d="M730.5 108.8Q515.2 111.5 299.8 109.3M729.6 110.8Q514.5 107.9 299.3 110.4"/><path class="s" d="M300.6 109.1Q301.2 69.9 299.4 30.9M300.1 111.0Q298.7 69.7 299.1 30.0"/><text x="316" y="58" text-anchor="start" class="big" style="font-size:22px">1. allocate</text><text x="316" y="82" text-anchor="start" style="font-size:17px">the app asks for more memory</text><path class="s y" d="M299.5 125.1Q514.6 126.5 731.1 126.0M301.1 124.4Q514.7 124.4 729.5 124.7"/><path class="s y" d="M729.8 125.1Q728.1 164.7 729.3 205.7M730.9 126.1Q731.2 164.9 729.9 204.8"/><path class="s y" d="M728.9 204.4Q515.1 205.0 300.2 204.6M731.1 204.4Q515.0 206.7 299.3 205.4"/><path class="s y" d="M299.6 206.1Q301.0 165.0 301.1 124.4M301.1 204.6Q301.4 164.8 301.1 125.2"/><text x="316" y="153" text-anchor="start" class="big" style="font-size:22px">2. reclaim</text><text x="316" y="177" text-anchor="start" style="font-size:17px">at the limit, the kernel frees what it can,</text><text x="316" y="197" text-anchor="start" class="m" style="font-size:16px">such as cached file data</text><path class="s r" d="M299.6 219.8Q515.4 220.7 729.6 219.4M298.9 220.8Q515.2 219.3 730.4 221.0"/><path class="s r" d="M730.5 220.2Q729.6 260.3 730.2 299.7M730.0 219.2Q730.4 259.9 731.0 301.0"/><path class="s r" d="M730.3 300.6Q514.6 300.3 299.8 300.7M728.9 298.8Q514.8 300.7 300.9 299.1"/><path class="s r" d="M300.1 298.9Q298.6 259.8 298.9 220.0M300.7 300.6Q301.4 259.7 300.0 220.5"/><text x="316" y="248" text-anchor="start" class="big" style="font-size:22px">3. OOM kill</text><text x="316" y="272" text-anchor="start" style="font-size:17px">only if reclaim can't free enough:</text><text x="316" y="292" text-anchor="start" class="m" style="font-size:16px">the OOM killer ends a process</text><path class="s" d="M514.3 112.2Q515.1 117.3 515.8 124.0M514.2 110.8Q514.2 117.8 514.8 124.6"/><path class="s" d="M515.2 122.5Q512.5 118.3 510.5 113.4M515.3 123.7Q511.9 118.0 509.4 113.0"/><path class="s" d="M514.5 122.8Q518.3 118.5 519.1 112.9M514.6 123.0Q517.8 118.6 519.9 113.1"/><path class="s" d="M515.3 208.5Q514.5 212.9 516.1 219.2M514.0 206.2Q514.1 212.4 515.0 218.8"/><path class="s" d="M515.1 217.5Q512.3 212.9 510.8 207.8M514.5 217.3Q512.0 213.4 510.3 208.8"/><path class="s" d="M515.2 218.4Q516.9 213.1 519.0 208.7M514.4 217.6Q518.4 213.8 520.5 207.7"/><g class="anim-kill"><text x="140" y="30" text-anchor="middle" class="big r">OOMKilled · exit 137</text></g></svg><figcaption>Memory can't be throttled like CPU. At the limit the kernel reclaims first; the OOM kill comes only if that isn't enough.</figcaption></figure>

When a cgroup reaches `memory.max`, the kernel first tries to **reclaim**: it frees memory it can safely drop, such as cached file data. Only if that isn't enough does it call the **OOM killer**, which picks a process inside the cgroup and ends it.

**Try it yourself.** `memory-hog` has a 64Mi limit and runs a small Python script that grabs 10 MiB every 0.3 seconds and never lets go:

```bash
kubectl -n lab apply -f modules/06-memory-and-oom/pod.yaml
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

*Shortcut:* `make 06-memory-and-oom`.

> [!KEY]
> At `memory.max` the kernel reclaims what it can first. If that isn't enough, it OOM-kills: exit code 137, no warning.

*Next question: if the kernel reclaims "what it can", what can it actually reclaim?*

---

### 17. Not all memory is equal

*Question: how can a pod be OOM-killed while the dashboard said it had room to spare?*

This answers the third promise from the intro. The key is that a cgroup's memory comes in two kinds.

<figure class="sketch "><svg viewBox="0 0 760 300" role="img" aria-label="Anonymous memory and file cache"><title>Anonymous memory and file cache</title><defs><clipPath id="cmk1"><rect x="70" y="170" width="280" height="80"/></clipPath><clipPath id="cmk2"><rect x="70" y="80" width="280" height="85"/></clipPath></defs><path class="s" d="M61.5 41.0Q210.2 38.5 361.6 39.2M58.5 40.6Q209.4 38.1 359.6 41.0"/><path class="s" d="M359.5 38.5Q358.5 149.6 360.5 259.0M361.4 41.5Q362.3 149.9 360.5 259.2"/><path class="s" d="M360.0 259.4Q209.7 262.1 58.5 259.5M359.3 259.7Q209.4 260.2 60.0 260.2"/><path class="s" d="M59.4 259.1Q61.5 149.5 60.2 39.9M60.4 260.4Q58.6 150.3 60.6 41.1"/><path class="s r" d="M40.3 70.0Q44.8 68.9 50.0 69.7"/><path class="s r" d="M57.0 69.9Q62.2 69.7 66.4 70.2"/><path class="s r" d="M73.9 70.6Q79.1 69.2 83.7 70.1"/><path class="s r" d="M91.0 70.7Q96.0 69.8 100.9 69.9"/><path class="s r" d="M107.7 69.2Q113.0 70.5 117.9 69.3"/><path class="s r" d="M125.7 70.3Q130.1 69.5 135.1 69.8"/><path class="s r" d="M142.1 70.2Q146.9 69.7 151.7 70.4"/><path class="s r" d="M158.2 69.6Q163.9 70.3 168.7 70.3"/><path class="s r" d="M175.9 70.0Q181.3 69.2 186.4 69.6"/><path class="s r" d="M193.1 70.6Q198.2 69.4 202.8 69.9"/><path class="s r" d="M209.3 69.3Q214.8 70.2 220.7 69.9"/><path class="s r" d="M226.9 69.2Q232.2 69.0 236.4 70.0"/><path class="s r" d="M244.2 70.3Q248.8 70.6 254.7 70.0"/><path class="s r" d="M260.4 69.6Q265.7 69.0 271.2 70.4"/><path class="s r" d="M278.6 69.2Q283.0 70.5 287.6 70.8"/><path class="s r" d="M295.2 70.2Q300.2 69.3 304.9 70.5"/><path class="s r" d="M312.4 70.2Q316.9 69.1 322.3 69.7"/><path class="s r" d="M328.6 69.7Q334.0 70.4 338.7 69.5"/><path class="s r" d="M346.6 70.0Q351.0 70.3 356.5 70.4"/><path class="s r" d="M363.7 70.5Q367.9 69.8 373.7 70.1"/><text x="390" y="76" text-anchor="start" class="r" style="font-size:18px">memory.max</text><path class="h r" clip-path="url(#cmk1)" d="M0.6 252.6Q35.2 210.2 70.8 169.0M7.2 250.8Q41.8 210.1 77.4 168.1M14.4 252.4Q48.2 209.4 83.1 167.3M20.3 252.6Q54.2 209.7 90.2 168.2M27.6 251.5Q63.5 210.7 98.0 167.9M35.3 252.2Q69.3 210.0 103.6 167.2M42.5 251.9Q78.5 210.5 111.8 167.7M48.9 252.7Q84.3 209.7 120.1 168.4M57.5 253.0Q91.4 209.8 124.8 167.4M62.8 252.1Q99.2 211.3 131.8 166.9M70.3 250.9Q105.5 210.5 140.0 169.0M77.0 251.4Q112.4 210.3 146.6 168.7M83.7 250.8Q117.8 208.4 154.8 167.3M91.1 251.1Q127.4 210.6 162.7 168.9M98.9 252.4Q133.7 209.3 170.4 169.0M107.6 251.0Q142.2 209.2 176.2 167.0M113.9 251.7Q149.9 210.3 183.0 167.2M122.3 252.7Q158.1 210.3 192.6 167.3M128.0 252.8Q163.8 210.4 197.9 167.7M135.9 251.1Q172.0 210.4 206.6 168.5M142.0 251.9Q178.4 210.5 213.1 168.1M149.9 251.9Q184.2 210.6 217.9 167.8M158.4 251.5Q193.5 211.3 227.7 169.0M164.3 252.8Q199.0 208.9 233.6 168.3M171.5 253.2Q207.9 211.6 240.0 168.2M178.2 253.0Q213.0 210.5 247.9 168.3M185.6 251.8Q218.6 209.4 254.5 167.6M192.5 252.9Q227.1 209.6 261.6 166.9M199.5 251.5Q234.1 209.7 268.7 168.0M206.0 252.6Q241.5 210.0 275.0 167.1M213.5 253.0Q248.1 209.7 282.1 167.7M220.3 251.3Q256.1 210.9 289.7 167.0M225.4 252.6Q260.2 208.9 295.6 167.1M233.7 252.6Q269.2 211.6 303.3 167.8M240.4 252.8Q275.7 210.8 309.6 167.5M245.9 253.2Q282.1 210.2 316.4 167.1M254.6 252.3Q287.8 209.5 323.8 167.0M262.8 251.2Q295.6 209.1 331.6 167.3M269.8 251.7Q302.5 209.6 337.9 168.6M276.4 252.7Q312.0 210.9 346.8 168.3M283.7 251.9Q317.6 209.7 352.3 168.0M289.5 252.7Q322.8 208.9 358.6 168.4M295.8 252.1Q332.5 211.2 364.8 168.4M303.1 252.8Q339.2 210.9 373.1 167.9M311.8 251.3Q346.5 210.3 379.1 168.7M317.4 253.0Q351.8 209.0 387.6 166.8M325.5 252.1Q359.6 209.2 396.3 168.2M334.2 251.8Q368.2 209.4 403.1 168.8M339.0 253.0Q374.7 210.2 408.8 168.1M347.3 251.2Q379.6 208.7 415.0 167.9"/><path class="s r" d="M70.9 169.4Q209.4 168.5 350.9 170.5M68.6 169.6Q209.6 172.4 350.9 169.9"/><path class="s r" d="M350.2 169.3Q348.0 209.5 348.5 250.6M351.0 170.3Q348.2 210.5 350.1 250.1"/><path class="s r" d="M350.7 249.0Q210.4 247.9 71.4 250.9M350.5 250.7Q210.5 247.9 70.5 250.7"/><path class="s r" d="M68.5 250.6Q71.8 210.3 70.4 171.3M69.1 250.3Q69.8 210.6 70.8 171.6"/><text x="210" y="205" text-anchor="middle" class="big">anon</text><text x="210" y="232" text-anchor="middle" style="font-size:17px">what programs asked for</text><path class="h b" clip-path="url(#cmk2)" d="M-4.8 168.0Q32.9 122.4 69.0 78.9M7.7 166.5Q46.1 122.1 82.1 78.0M20.5 167.1Q59.1 122.9 95.4 77.6M32.4 166.1Q69.9 122.3 107.7 77.6M45.5 167.2Q82.3 122.3 120.9 77.0M57.8 166.6Q96.4 123.6 132.1 78.4M69.7 166.9Q105.9 121.8 144.1 78.7M81.9 167.1Q119.4 123.4 156.5 78.0M93.8 167.1Q130.5 122.6 166.7 77.8M103.9 167.2Q141.7 122.5 178.8 78.5M116.0 167.3Q153.0 121.9 189.7 77.1M130.3 168.2Q166.6 122.8 202.4 78.0M139.9 166.6Q177.3 122.3 215.8 79.0M153.6 167.8Q190.5 122.8 228.3 77.1M165.5 166.4Q201.8 123.0 237.6 77.3M176.9 166.3Q213.3 123.0 250.6 78.7M186.8 167.6Q224.1 122.2 261.4 78.2M199.3 166.1Q237.7 123.7 272.8 77.1M212.2 168.0Q249.2 122.5 285.9 77.8M223.1 166.9Q259.3 121.9 296.6 77.5M235.9 167.2Q270.9 121.4 310.4 78.4M247.9 167.8Q284.9 123.0 322.5 78.8M258.9 167.7Q297.4 123.1 333.5 77.1M273.0 166.8Q309.3 122.4 344.9 76.9M284.1 166.9Q320.6 122.2 357.0 78.3M296.1 167.3Q332.6 123.7 369.5 79.1M305.8 167.5Q342.0 121.7 379.7 76.9M318.9 167.7Q355.2 122.3 392.2 78.0M330.1 167.9Q366.4 122.7 402.7 78.2M339.7 167.5Q377.3 122.0 414.2 78.1"/><path class="s b" d="M69.6 80.5Q209.7 80.5 349.3 80.7M70.6 81.3Q210.2 80.5 351.6 80.6"/><path class="s b" d="M350.0 79.4Q352.9 122.9 349.7 165.7M349.4 81.2Q348.4 123.0 348.5 164.2"/><path class="s b" d="M349.2 165.7Q210.3 162.5 71.2 164.9M348.8 164.4Q209.7 164.3 70.7 163.7"/><path class="s b" d="M70.2 165.2Q69.9 122.6 71.2 80.7M69.6 165.5Q71.4 122.8 71.3 80.0"/><text x="210" y="115" text-anchor="middle" class="big">file cache</text><text x="210" y="142" text-anchor="middle" style="font-size:17px">copies of files, for speed</text><text x="395" y="125" text-anchor="start" class="b" style="font-size:19px">← can be dropped and reread</text><text x="395" y="150" text-anchor="start" class="m" style="font-size:17px">    (reclaim). Nobody dies.</text><text x="395" y="215" text-anchor="start" class="r" style="font-size:19px">← can't be dropped. Too much</text><text x="395" y="240" text-anchor="start" class="m" style="font-size:17px">    of this = OOM kill.</text><text x="380" y="290" text-anchor="middle" class="m" style="font-size:16px">both count in memory.current · the working set leaves out inactive file cache</text></svg><figcaption>Two containers can both show 120 MiB in use. Only the one full of anon memory is in danger.</figcaption></figure>

| Kind | In `memory.stat` | What it is | Can the kernel take it back? |
|---|---|---|---|
| **Anonymous** | `anon` | Memory a program asked for: variables, heap, buffers | No. Only by killing the program (or swapping) |
| **File cache** | `file` | Copies of file data kept in memory so the next read is fast | Yes. It can drop it and reread from disk |

Both count towards `memory.current` and towards `memory.max`. But only one of them can get you killed.

**Try it yourself.** `mem-lab` has a 128Mi limit. First, read 192 MiB of files through it (written in 16 MiB steps, then read back twice):

```bash
kubectl -n lab apply -f modules/07-memory-deep-dive/pod.yaml
kubectl -n lab wait --for=condition=Ready pod/mem-lab
kubectl -n lab exec mem-lab -- sh -c 'i=0; while [ $i -lt 12 ]; do dd if=/dev/zero of=/tmp/f bs=1M count=16 seek=$((i*16)) conv=notrunc,fsync 2>/dev/null; i=$((i+1)); done; cat /tmp/f > /dev/null; cat /tmp/f > /dev/null'
kubectl -n lab exec mem-lab -- cat /sys/fs/cgroup/memory.current
kubectl -n lab exec mem-lab -- grep -E '^(anon|file|inactive_file) ' /sys/fs/cgroup/memory.stat
```

<details class="predict"><summary><span class="predict-tag">Predict first</span> The container has a 128Mi limit and you just read 192 MiB of files through it. Was it OOM-killed?</summary><div class="predict-answer"><p>No. It was all file cache, which the kernel can drop whenever it needs room.</p></div></details>

On my run, `memory.current` read **125 MiB**, almost exactly the limit, of which **123 MiB was `file`** and **0 was `anon`**. `memory.events` showed `max 1810` (the limit was hit over and over) and `oom_kill 0`. Every time, the kernel dropped some old file cache and carried on. The container is "at its limit", and perfectly fine.

Now allocate memory that can't be dropped, with the string-doubling shell from chapter 8:

```bash
kubectl -n lab exec mem-lab -- sh -c 'a=x; while :; do a=$a$a; done'
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
> By default Kubernetes sets neither (they read `max` and `0`). The `MemoryQoS` feature, still alpha, sets `memory.min` from the request and `memory.high` a little below the limit, so pods slow down before they get killed.

*Shortcut:* `make 07-memory-deep-dive` runs both experiments and checks each result. With `KEEP=1` and `make watch POD=mem-lab` in a second terminal, you can watch `file` fill up and `anon` stay at zero.

> [!KEY]
> File cache is counted but can be dropped. Memory a program allocates can't, and that's what gets OOM-killed. Watch the working set, not `memory.current`.

*Next question: so far each container hit its own limit. What if the whole node runs out?*

---

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

They're equal on kind because it reserves nothing. On GKE or EKS, several hundred MiB or more are held back through three kubelet settings: `systemReserved` (for the OS), `kubeReserved` (for the kubelet and container runtime) and `evictionHard` (a safety margin). The scheduler only ever compares pod **requests** with allocatable, never real usage, and the kubelet writes `capacity − systemReserved − kubeReserved` into the `memory.max` of the box for all pods. That's the `8321515520` from chapter 11 (exactly 8,126,480 Ki).

*Shortcut:* `make 09-node-allocatable` also shows a pod stuck `Pending` because it asked for more than the node has.

#### QoS classes: who is most protected

Kubernetes sorts every pod into one of three Quality of Service classes, worked out from its requests and limits:

| Class | How you get it |
|---|---|
| **Guaranteed** | Every container has requests **equal** to limits, for both CPU and memory |
| **Burstable** | Some requests or limits, but not Guaranteed |
| **BestEffort** | Nothing set at all |

The class shows up in two places. In the tree, each class gets its own box (chapter 11). And on every process, as a number the kernel reads when the *whole machine* is out of memory:

<figure class="sketch "><svg viewBox="0 0 760 270" role="img" aria-label="QoS classes affect OOM protection"><title>QoS classes affect OOM protection</title><defs><clipPath id="cqo1"><rect x="25" y="40" width="210" height="150"/></clipPath><clipPath id="cqo2"><rect x="275" y="40" width="210" height="150"/></clipPath><clipPath id="cqo3"><rect x="525" y="40" width="210" height="150"/></clipPath></defs><path class="s" d="M40.0 229.7Q380.4 230.9 721.6 229.3M39.4 229.3Q379.7 227.9 718.7 229.4"/><path class="s" d="M719.3 229.5Q715.3 232.6 710.2 234.6M719.4 230.4Q715.0 231.8 710.5 234.6"/><path class="s" d="M720.5 230.5Q715.1 227.5 710.8 224.8M719.8 229.4Q715.2 227.7 710.3 224.6"/><text x="40" y="258" text-anchor="start" class="r" style="font-size:20px">least protected</text><text x="720" y="258" text-anchor="end" class="g" style="font-size:20px">most protected</text><path class="h r" clip-path="url(#cqo1)" d="M-105.4 191.1Q-40.1 115.5 25.0 38.0M-94.3 190.9Q-26.9 116.4 36.4 37.1M-81.5 192.6Q-17.1 114.2 49.1 37.5M-68.3 191.0Q-5.3 114.1 60.5 38.0M-57.6 191.2Q7.1 113.6 73.3 37.9M-46.4 192.4Q20.6 115.5 85.4 36.8M-33.4 192.2Q32.5 115.8 97.9 37.3M-22.3 191.3Q42.6 114.1 108.9 38.6M-9.4 192.5Q54.4 114.3 121.2 38.3M2.0 190.9Q66.6 114.4 133.3 37.2M13.4 191.9Q80.5 116.4 144.1 37.6M24.8 192.4Q91.1 115.3 156.2 37.8M37.0 191.7Q101.4 114.5 166.7 37.5M50.2 192.1Q115.1 114.4 180.7 38.0M62.8 191.4Q127.5 115.4 193.5 38.8M73.9 191.0Q138.0 114.2 204.3 38.1M85.6 191.6Q151.3 114.8 217.6 37.3M97.2 191.3Q162.8 114.8 227.5 37.1M110.2 190.9Q175.7 114.9 239.9 37.5M121.7 191.2Q187.6 115.4 251.3 38.3M133.2 193.1Q198.7 115.2 263.8 38.8M145.4 193.1Q210.2 114.7 275.9 36.9M158.1 193.0Q221.4 114.9 288.4 37.4M167.2 192.4Q232.6 113.5 299.7 38.1M178.9 193.2Q243.5 114.0 309.2 37.2M192.6 192.0Q256.1 113.6 322.1 38.3M203.7 191.5Q270.4 115.9 334.1 37.6M215.6 191.3Q279.7 115.5 345.6 37.2M227.3 191.4Q291.3 114.3 355.9 38.0"/><path class="s r" d="M25.1 39.5Q130.0 40.2 234.0 40.1M23.4 41.5Q130.1 40.3 235.6 41.1"/><path class="s r" d="M236.5 41.3Q233.2 114.6 233.6 190.4M235.5 39.8Q234.4 115.1 234.2 191.2"/><path class="s r" d="M236.3 189.6Q129.7 189.5 25.2 188.7M236.4 188.9Q130.4 192.5 25.6 189.7"/><path class="s r" d="M23.7 189.5Q24.0 114.5 23.9 39.7M24.9 188.9Q25.7 115.5 25.2 38.5"/><text x="130" y="80" text-anchor="middle" class="big">BestEffort</text><text x="130" y="115" text-anchor="middle" style="font-size:19px">no requests, no limits</text><text x="130" y="160" text-anchor="middle" class="code">oom_score_adj 1000</text><path class="h y" clip-path="url(#cqo2)" d="M144.5 193.0Q209.9 115.4 274.1 37.5M157.3 193.1Q221.4 115.5 287.1 38.7M169.0 192.4Q232.4 114.0 297.6 37.5M179.2 191.8Q244.6 115.0 309.8 38.7M189.8 191.5Q256.7 115.9 322.0 39.1M203.3 192.0Q266.9 114.5 332.4 39.0M213.5 192.0Q281.1 116.0 344.9 38.3M228.2 192.8Q292.0 115.0 357.0 38.8M240.2 191.4Q304.2 114.8 369.9 38.4M251.9 191.6Q317.1 115.7 380.7 39.1M263.9 193.1Q326.8 113.6 392.6 38.4M275.4 192.2Q339.8 113.6 406.7 37.5M288.8 192.7Q353.3 115.1 418.3 38.7M298.9 192.8Q364.8 114.9 430.1 37.7M312.9 192.9Q378.4 115.8 442.5 38.7M325.8 192.6Q390.8 115.2 455.1 37.1M337.4 192.8Q403.9 116.0 469.7 38.1M349.8 192.4Q416.2 115.3 480.9 36.8M362.2 192.3Q428.3 115.0 493.8 37.8M374.3 191.3Q441.0 115.5 505.3 38.1M387.6 193.2Q453.1 114.9 517.4 37.2M398.8 191.9Q464.4 114.2 530.7 38.2M410.7 192.9Q477.4 115.6 541.7 38.4M423.3 191.6Q487.7 114.3 554.5 38.7M434.3 192.8Q500.5 116.5 564.9 37.8M446.1 192.0Q511.5 114.8 577.3 37.2M457.2 191.0Q521.4 113.9 588.9 36.9M469.9 191.0Q534.2 114.2 599.6 37.0M481.3 192.8Q546.2 113.6 613.3 37.1"/><path class="s y" d="M275.2 40.2Q379.8 41.6 484.3 40.1M275.0 38.4Q379.5 41.9 484.3 39.0"/><path class="s y" d="M484.7 41.0Q484.4 115.2 486.0 190.6M484.1 40.3Q486.9 115.4 486.3 189.4"/><path class="s y" d="M484.5 189.1Q379.8 190.3 276.4 189.6M484.1 189.7Q379.9 187.3 276.6 189.8"/><path class="s y" d="M275.3 188.9Q272.9 114.9 274.4 38.8M273.8 188.8Q274.1 115.4 273.8 39.7"/><text x="380" y="80" text-anchor="middle" class="big">Burstable</text><text x="380" y="115" text-anchor="middle" style="font-size:19px">some requests or limits</text><text x="380" y="160" text-anchor="middle" class="code">2 … 999</text><path class="h g" clip-path="url(#cqo3)" d="M395.6 191.5Q461.5 116.0 524.7 37.4M407.1 192.3Q471.4 114.6 536.6 37.6M419.1 192.9Q483.8 114.4 549.7 37.5M429.5 192.3Q495.0 114.9 560.2 38.1M442.5 192.2Q507.7 114.9 573.9 37.6M454.3 192.8Q520.5 115.0 584.6 37.1M465.6 192.3Q532.2 116.3 596.6 37.5M478.6 191.8Q544.3 115.6 607.0 38.1M489.5 191.0Q555.7 115.3 619.8 38.1M503.7 191.2Q567.6 114.5 632.7 38.3M512.7 192.0Q580.0 116.4 645.1 38.3M525.2 192.3Q591.3 115.7 655.3 38.1M538.2 192.4Q601.5 114.0 666.8 37.9M549.2 191.5Q615.0 115.3 679.0 38.0M561.6 192.9Q626.1 115.1 690.5 38.1M573.9 193.0Q639.8 115.8 703.0 37.5M585.3 192.1Q649.7 113.9 716.1 37.2M599.2 191.8Q663.7 114.6 729.1 38.1M610.0 191.0Q677.7 116.1 740.8 38.7M621.9 191.8Q687.0 113.7 754.2 37.6M634.0 191.4Q699.6 114.9 764.7 37.8M645.6 192.8Q711.5 114.6 777.2 37.3M658.4 191.7Q722.7 114.1 787.9 38.8M668.8 191.5Q735.3 115.3 800.8 38.6M682.5 193.0Q746.9 115.6 812.4 38.4M693.8 191.5Q758.3 114.1 823.9 37.8M707.5 191.6Q773.3 116.3 838.3 38.1M717.6 191.8Q782.8 115.0 848.2 37.1M729.8 192.9Q794.7 116.0 858.2 38.0"/><path class="s g" d="M524.6 38.8Q629.7 38.0 734.8 40.6M525.9 40.6Q630.2 38.9 734.9 39.5"/><path class="s g" d="M735.0 40.7Q735.7 114.4 734.8 190.0M736.2 40.8Q732.5 114.9 733.9 189.7"/><path class="s g" d="M736.0 188.5Q629.7 190.0 525.3 188.4M733.7 188.6Q629.4 190.2 525.7 188.6"/><path class="s g" d="M524.1 189.7Q523.7 115.1 525.7 40.2M524.3 189.0Q526.5 114.6 526.0 40.3"/><text x="630" y="80" text-anchor="middle" class="big">Guaranteed</text><text x="630" y="115" text-anchor="middle" style="font-size:19px">requests = limits</text><text x="630" y="160" text-anchor="middle" class="code">-997</text><text x="380" y="20" text-anchor="middle" class="m" style="font-size:16px">example values from this lab</text></svg><figcaption>QoS affects OOM protection and eviction behaviour. Burstable scores vary with the memory request.</figcaption></figure>

```bash
kubectl -n lab apply -f modules/08-qos-classes/pods.yaml
kubectl -n lab wait --for=condition=Ready pod -l module=08
for p in qos-guaranteed qos-burstable qos-besteffort; do
  echo "$p $(kubectl -n lab exec $p -- cat /proc/1/oom_score_adj)"
done
```

```
qos-guaranteed -997
qos-burstable 996
qos-besteffort 1000
```

Remember `/proc` from chapter 3: inside a container the main process is PID 1, so `/proc/1/oom_score_adj` belongs to the container's main program. It's a number from −1000 to 1000. When the machine runs out of memory, the kernel scores every process (mostly by how much memory it uses), adds this number, and kills the highest. Burstable values vary with the memory request (a bigger request gives a lower number).

*Shortcut:* `make 08-qos-classes`.

#### Eviction: the kubelet steps in first

The kernel's machine-wide OOM killer is the last resort. Before it gets there, the kubelet watches the node's free memory, roughly every 10 seconds:

```
memory.available = node capacity − working set of the whole node
```

If `memory.available` drops below `evictionHard` (100Mi by default), the kubelet marks the node with `MemoryPressure` and **evicts** a pod: stops it, marks it `Failed`, and doesn't restart it on this node.

<figure class="sketch "><svg viewBox="0 0 760 250" role="img" aria-label="How node-pressure eviction works"><title>How node-pressure eviction works</title><defs><clipPath id="cev1"><rect x="20" y="50" width="220" height="150"/></clipPath><clipPath id="cev2"><rect x="270" y="50" width="220" height="150"/></clipPath><clipPath id="cev3"><rect x="520" y="50" width="220" height="150"/></clipPath></defs><path class="h y" clip-path="url(#cev1)" d="M-110.9 202.0Q-45.2 125.5 19.6 47.8M-97.8 203.2Q-33.5 123.8 32.5 48.3M-85.8 201.8Q-19.8 125.3 45.5 48.2M-74.9 201.8Q-8.7 125.4 56.9 48.0M-62.0 202.3Q4.3 125.8 69.3 47.0M-49.2 201.0Q15.6 124.3 81.3 47.8M-37.0 202.9Q29.0 125.1 94.3 49.1M-22.9 200.9Q42.2 125.9 107.4 49.0M-11.9 202.5Q51.8 124.6 118.2 47.5M-1.7 200.8Q64.2 125.7 127.8 47.9M8.8 201.1Q73.2 123.8 139.3 46.9M23.2 201.4Q88.2 126.0 152.3 48.9M34.3 202.4Q100.6 125.4 165.9 46.9M46.8 201.8Q111.4 124.3 176.5 48.0M58.8 201.9Q124.8 125.1 190.0 49.2M70.2 201.4Q137.7 126.0 202.3 47.2M83.5 200.9Q148.5 124.9 213.7 49.1M94.7 201.1Q159.4 124.3 226.0 48.2M106.3 201.7Q171.3 124.4 238.7 47.3M118.7 201.5Q184.3 125.2 249.7 48.6M132.7 202.7Q197.7 126.0 262.5 47.3M142.4 202.4Q207.7 124.7 273.7 47.5M154.5 201.7Q220.3 126.1 284.7 47.7M167.8 202.7Q231.1 123.9 296.4 46.8M177.5 201.3Q245.0 126.3 308.5 48.1M191.0 201.6Q254.7 123.7 320.4 48.9M202.4 201.4Q267.5 125.3 332.6 47.9M213.3 201.1Q279.7 126.1 343.4 48.6M224.9 201.0Q291.4 125.4 357.0 47.1M239.1 201.6Q302.5 124.8 367.7 47.9"/><path class="s y" d="M18.9 48.4Q129.4 52.4 241.6 50.6M20.3 50.5Q130.3 51.4 239.4 48.7"/><path class="s y" d="M240.5 48.7Q239.1 125.3 240.5 198.7M240.1 51.2Q237.5 124.7 240.5 198.8"/><path class="s y" d="M239.6 201.0Q129.6 198.6 19.1 199.4M239.6 199.0Q129.7 200.8 19.2 198.8"/><path class="s y" d="M19.8 200.3Q20.7 124.7 21.5 51.5M19.1 199.0Q18.6 125.4 20.0 49.3"/><text x="130" y="90" text-anchor="middle" class="big" style="font-size:23px">node crosses</text><text x="130" y="116" text-anchor="middle" class="big" style="font-size:23px">the threshold</text><text x="130" y="154" text-anchor="middle" style="font-size:17px">memory.available</text><text x="130" y="176" text-anchor="middle" style="font-size:17px">< evictionHard</text><path class="h b" clip-path="url(#cev2)" d="M139.7 200.9Q204.2 124.6 269.8 47.3M151.8 202.8Q216.2 124.0 281.7 49.0M164.0 202.6Q230.3 125.6 295.1 47.4M177.5 203.0Q239.7 123.9 306.3 47.6M188.3 203.1Q254.0 124.7 318.5 48.4M200.6 203.2Q266.0 125.4 330.3 47.6M213.0 202.5Q277.4 124.3 342.8 48.0M224.2 200.8Q289.1 123.7 356.0 46.9M238.7 200.9Q302.4 124.4 367.5 49.2M249.0 201.7Q313.1 124.5 378.7 47.6M259.8 203.1Q326.5 125.5 390.2 48.5M273.4 203.1Q337.8 124.9 404.2 47.9M285.4 201.6Q350.0 125.2 414.6 48.5M295.1 200.9Q361.7 126.1 427.5 48.4M309.1 202.7Q372.7 124.0 439.1 49.2M320.1 201.8Q386.9 125.8 452.3 48.8M332.7 201.8Q397.4 124.7 462.4 48.8M344.2 203.0Q408.7 123.9 474.9 46.8M357.6 202.6Q422.7 125.7 487.0 48.7M369.4 202.6Q435.4 126.4 500.2 47.2M380.4 202.1Q445.2 123.5 511.9 46.9M393.7 201.7Q460.3 126.0 524.2 48.6M406.1 201.8Q471.2 124.9 536.2 46.9M419.0 200.9Q484.4 125.3 549.0 47.4M430.7 201.1Q496.5 125.6 561.3 48.2M443.7 202.2Q509.3 126.2 573.8 47.6M454.3 201.0Q519.3 124.4 585.5 46.8M466.8 202.9Q530.6 124.1 596.6 47.0M478.7 202.2Q544.0 124.9 609.1 47.3"/><path class="s b" d="M269.2 49.7Q380.2 50.9 489.3 50.7M269.2 49.6Q380.0 47.2 490.3 50.8"/><path class="s b" d="M488.5 49.0Q489.1 125.2 491.3 198.4M490.3 51.4Q490.9 124.9 489.0 200.5"/><path class="s b" d="M489.6 200.5Q379.6 202.0 269.6 198.7M489.2 200.6Q380.3 198.5 269.5 200.4"/><path class="s b" d="M268.5 199.2Q268.1 125.5 269.2 51.5M269.8 199.2Q270.2 124.9 270.0 49.1"/><text x="380" y="90" text-anchor="middle" class="big" style="font-size:23px">kubelet ranks</text><text x="380" y="116" text-anchor="middle" class="big" style="font-size:23px">the pods</text><text x="380" y="154" text-anchor="middle" style="font-size:17px">priority, and usage</text><text x="380" y="176" text-anchor="middle" style="font-size:17px">vs memory request</text><path class="h r" clip-path="url(#cev3)" d="M388.9 202.8Q455.2 125.3 519.8 48.0M401.0 202.2Q466.5 124.9 532.7 48.4M414.5 202.8Q479.6 125.1 543.2 47.3M424.9 201.0Q492.4 126.0 557.0 48.2M437.5 202.5Q501.9 124.4 566.5 46.9M450.9 201.8Q516.5 126.1 579.6 48.6M462.4 201.4Q526.0 124.5 592.4 49.2M474.4 201.9Q538.6 125.0 603.9 49.0M486.6 203.0Q550.5 124.3 615.3 48.8M497.7 202.5Q563.7 126.2 628.8 48.6M509.0 200.8Q574.3 124.1 641.5 47.1M522.9 201.1Q589.2 125.8 652.6 47.0M533.7 202.4Q597.7 123.5 664.5 49.2M544.3 203.0Q608.7 124.2 675.3 48.0M555.6 201.5Q623.2 125.9 687.1 48.2M570.6 202.7Q634.6 125.3 700.7 49.0M581.7 201.3Q647.6 125.7 711.5 46.9M595.0 202.3Q659.4 125.4 725.3 46.9M605.3 202.0Q669.9 123.8 735.5 47.8M618.6 203.2Q682.3 124.2 748.4 49.0M631.4 202.8Q696.8 125.9 762.1 48.5M641.4 202.0Q707.1 124.8 772.6 48.4M654.4 201.9Q719.8 125.1 785.3 47.4M667.6 202.9Q731.9 125.4 796.7 46.8M677.4 202.1Q741.7 123.9 808.5 48.0M688.8 202.1Q755.0 125.3 819.0 48.3M699.5 202.1Q766.0 125.6 830.3 48.1M711.2 201.5Q776.1 123.7 842.5 46.8M722.8 202.1Q789.2 125.3 854.9 48.0M735.7 202.0Q800.6 125.5 864.6 49.2"/><path class="s r" d="M520.8 51.6Q630.3 50.2 739.8 50.1M520.2 51.0Q630.4 47.3 739.2 50.4"/><path class="s r" d="M741.5 48.6Q741.5 124.7 740.9 201.2M740.2 48.9Q737.4 125.0 739.5 198.4"/><path class="s r" d="M741.1 200.9Q629.4 198.8 519.0 199.2M739.3 199.0Q629.9 200.2 519.2 200.5"/><path class="s r" d="M520.2 201.4Q519.3 124.9 519.4 50.3M519.6 200.6Q520.6 124.9 518.6 51.3"/><text x="630" y="90" text-anchor="middle" class="big" style="font-size:23px">a pod is</text><text x="630" y="116" text-anchor="middle" class="big" style="font-size:23px">evicted</text><text x="630" y="154" text-anchor="middle" style="font-size:17px">Failed · Evicted</text><text x="630" y="176" text-anchor="middle" style="font-size:17px">not restarted here</text><path class="s" d="M243.5 126.0Q255.6 126.6 267.0 125.7M244.9 123.8Q254.8 126.2 265.5 125.5"/><path class="s" d="M266.0 125.2Q261.5 128.4 256.1 129.9M265.9 124.7Q261.2 127.3 255.7 129.2"/><path class="s" d="M266.0 125.5Q261.4 121.5 255.5 120.0M266.8 124.7Q260.9 122.5 256.1 119.5"/><path class="s" d="M494.2 125.2Q505.6 125.3 517.0 125.3M494.7 124.3Q504.9 124.9 515.7 123.6"/><path class="s" d="M516.0 124.5Q510.9 126.6 506.2 129.8M515.9 124.4Q511.2 127.9 505.8 130.3"/><path class="s" d="M516.4 125.1Q510.9 123.2 506.5 120.4M516.1 124.4Q511.0 122.7 505.3 120.7"/><text x="380" y="235" text-anchor="middle" class="m" style="font-size:17px">BestEffort pods, and pods well above their request, are often at greatest risk</text></svg><figcaption>Before the kernel's OOM killer has to act on the whole node, the kubelet steps in and asks one pod to leave.</figcaption></figure>

The lab makes this happen by temporarily raising the threshold so the node is only about 600 MiB from "low memory", then running a BestEffort memory hog next to two small, well-behaved pods. Let `make` do it, because it edits the kubelet's config and always puts it back:

```bash
KEEP=1 make 10-node-pressure-eviction
kubectl -n lab get pod memory-hog -o jsonpath='{.status.reason}: {.status.message}'
```

```
Evicted: The node was low on resource: memory. Threshold quantity: 7141Mi, available: 7191604Ki.
Container main was using 721996Ki, request is 0, has larger consumption of memory.
```

The two calm pods kept running. Roughly, the kubelet ranks pods by (1) whether their memory use is above their request, (2) their priority, and (3) how far above their request they are. The hog was using about 700 MiB against a request of 0, so it came first. Treat this as intuition; the [Kubernetes docs](https://kubernetes.io/docs/concepts/scheduling-eviction/node-pressure-eviction/) have the full rules.

| | OOM kill (chapters 16 and 17) | Eviction (here) |
|---|---|---|
| **Who does it** | The kernel | The kubelet |
| **Trigger** | One cgroup hits its own `memory.max` | The whole node gets low on memory |
| **What you see** | `OOMKilled`, exit code 137, container restarts | `Evicted`, pod `Failed`, not restarted here |
| **Who is chosen** | A process in the cgroup over its limit | Ranked by usage vs request, and priority |

> [!KEY]
> When the whole node runs short, the kubelet evicts first and the kernel kills last. Pods using more than they requested, especially BestEffort ones, are at the greatest risk.

---

## Part 6: In production

### 19. Seeing it in production

*Question: I can't `cat` files on production nodes all day. What do I watch instead?*

The good news: every file in this post already has a metric. cAdvisor, built into the kubelet, reads the cgroup files and exports them to Prometheus:

| Kernel file | What it tells you | Prometheus metric |
|---|---|---|
| `cpu.stat` → `usage_usec` | CPU time used | `container_cpu_usage_seconds_total` |
| `cpu.stat` → `nr_periods` | Periods with work to do | `container_cpu_cfs_periods_total` |
| `cpu.stat` → `nr_throttled` | Periods throttled | `container_cpu_cfs_throttled_periods_total` |
| `cpu.stat` → `throttled_usec` | Time spent throttled | `container_cpu_cfs_throttled_seconds_total` |
| `memory.current` | All memory, including cache | `container_memory_usage_bytes` |
| `memory.current` − `inactive_file` | The working set | `container_memory_working_set_bytes` |
| `memory.stat` → `anon` | Memory programs allocated | `container_memory_rss` |
| `memory.stat` → `file` | File cache | `container_memory_cache` |
| `memory.max` | The memory limit | `container_spec_memory_limit_bytes` |
| `memory.events` → `oom_kill` | OOM kills | `container_oom_events_total` |

#### Pressure: how long things waited

There's one more family of files, and it answers a question usage can't. Usage tells you how *busy* something is. **Pressure** (PSI, short for *pressure stall information*) tells you how long things *waited*. Think of a shop with one till: "busy all day" sounds the same whether one customer was served or fifty queued out of the door. Pressure measures the queue.

<figure class="sketch "><svg viewBox="0 0 760 240" role="img" aria-label="Pressure stall information measures waiting time"><title>Pressure stall information measures waiting time</title><defs><clipPath id="cps1"><rect x="560" y="60" width="150" height="110"/></clipPath></defs><path class="h b" clip-path="url(#cps1)" d="M464.8 171.1Q510.4 113.7 559.1 57.4M473.0 172.1Q520.9 114.3 569.4 57.8M483.7 171.3Q530.0 114.4 579.1 57.7M493.9 173.1Q540.5 114.4 590.2 57.7M502.8 172.9Q551.5 115.4 598.2 57.3M511.1 170.9Q560.0 115.7 607.0 57.6M521.7 173.2Q569.2 115.8 616.9 57.5M528.0 171.3Q577.2 115.5 625.6 58.2M538.7 173.2Q584.9 114.4 633.2 57.9M547.0 171.0Q595.9 114.9 644.7 57.1M556.3 172.0Q603.9 114.9 652.6 57.5M564.1 171.1Q613.3 114.8 661.2 58.5M576.2 171.6Q623.4 115.9 669.5 57.7M584.5 170.9Q630.0 113.8 679.5 57.3M591.9 172.5Q640.5 115.5 687.6 58.9M601.3 171.9Q648.9 115.0 695.5 57.1M610.5 171.2Q659.3 115.8 706.8 57.1M619.0 172.5Q665.8 113.9 714.9 57.4M629.0 172.9Q677.6 115.1 723.8 57.3M638.1 171.3Q685.7 115.0 733.3 57.6M647.2 172.3Q695.4 114.3 743.3 58.0M657.6 171.5Q704.5 114.0 753.2 56.8M666.6 172.2Q713.3 114.5 761.0 58.7M673.7 171.0Q722.6 115.3 769.9 57.3M682.9 172.9Q731.2 115.3 778.0 57.7M693.0 171.4Q739.9 115.0 788.3 56.9M702.8 170.9Q750.3 115.9 797.1 58.0"/><path class="s b" d="M558.5 59.7Q634.4 57.9 710.1 59.8M559.8 59.9Q634.4 58.6 709.9 60.6"/><path class="s b" d="M709.5 58.9Q708.4 115.3 708.7 171.1M709.4 59.6Q712.4 115.5 709.7 171.4"/><path class="s b" d="M710.7 169.8Q635.4 168.5 559.7 171.0M711.3 169.8Q635.5 169.1 560.2 170.9"/><path class="s b" d="M561.2 171.2Q559.3 115.1 558.8 59.6M559.7 169.4Q558.4 115.6 559.3 59.8"/><text x="635" y="122" text-anchor="middle" class="big">1 CPU</text><path class="s y" d="M42.7 89.1Q53.3 86.2 58.8 86.0Q64.3 85.8 69.6 87.0Q74.9 88.3 80.1 90.3Q85.2 92.4 88.0 96.6Q90.7 100.8 93.4 105.0Q96.0 109.2 95.4 113.9Q94.8 118.5 94.0 123.2Q93.3 127.9 89.6 131.5Q85.9 135.1 81.9 138.4Q77.8 141.7 72.3 143.0Q66.9 144.3 61.3 144.1Q55.8 143.9 50.5 142.7Q45.2 141.4 40.1 139.4Q34.9 137.4 31.7 133.5Q28.4 129.6 26.6 125.2Q24.7 120.7 24.7 116.1Q24.6 111.4 25.8 106.8Q26.9 102.2 30.3 98.4Q33.7 94.6 38.4 92.1Q43.1 89.6 48.1 87.5"/><path class="s y" d="M45.7 143.3Q36.0 137.5 32.1 133.8Q28.1 130.1 26.9 125.4Q25.6 120.6 24.7 115.7Q23.8 110.9 25.7 106.2Q27.5 101.5 30.8 97.4Q34.0 93.2 38.9 90.3Q43.7 87.3 49.5 86.2Q55.4 85.1 61.2 85.3Q67.1 85.4 72.7 87.0Q78.4 88.6 82.5 92.1Q86.6 95.6 90.0 99.5Q93.4 103.5 95.0 108.2Q96.6 113.0 95.8 117.9Q95.0 122.8 92.5 127.2Q90.1 131.7 86.3 135.5Q82.5 139.4 77.3 141.8Q72.0 144.3 66.1 144.4Q60.1 144.5 54.5 143.5Q48.9 142.6 43.5 140.8Q38.0 139.1 34.5 135.2"/><text x="60" y="121" text-anchor="middle" style="font-size:17px">waiting</text><path class="s y" d="M185.3 109.2Q185.8 118.6 184.6 123.3Q183.4 127.9 180.2 131.9Q177.1 135.9 172.1 138.3Q167.1 140.6 162.0 142.4Q156.9 144.3 151.3 144.2Q145.8 144.1 140.3 143.1Q134.9 142.1 130.5 139.3Q126.1 136.4 121.9 133.2Q117.7 130.0 116.4 125.4Q115.0 120.7 114.8 116.1Q114.5 111.4 115.5 106.7Q116.4 102.0 119.7 98.1Q123.0 94.1 127.9 91.6Q132.7 89.1 137.9 87.3Q143.1 85.6 148.7 85.2Q154.4 84.9 159.6 86.6Q164.8 88.4 169.4 91.0Q173.9 93.6 178.1 96.8Q182.2 100.0 183.4 104.7Q184.5 109.4 185.4 114.0"/><path class="s y" d="M147.2 84.9Q158.8 86.2 164.4 87.7Q170.1 89.2 174.5 92.6Q178.8 96.0 180.9 100.6Q182.9 105.2 184.9 109.9Q187.0 114.5 185.8 119.4Q184.6 124.3 181.5 128.5Q178.5 132.6 174.3 135.9Q170.0 139.1 164.8 141.1Q159.6 143.0 153.9 144.3Q148.2 145.6 142.4 144.6Q136.5 143.6 131.8 140.6Q127.0 137.7 123.4 133.9Q119.9 130.1 117.9 125.7Q115.9 121.2 115.2 116.5Q114.4 111.7 116.1 107.1Q117.9 102.5 121.3 98.7Q124.8 94.9 129.2 91.8Q133.6 88.8 139.0 86.7Q144.4 84.7 150.2 85.5Q156.0 86.3 161.6 87.6"/><text x="150" y="121" text-anchor="middle" style="font-size:17px">waiting</text><path class="s y" d="M205.0 112.4Q207.9 103.6 210.8 99.8Q213.7 95.9 217.8 92.9Q221.9 89.9 226.8 87.4Q231.7 84.8 237.4 84.6Q243.2 84.4 248.8 85.7Q254.3 87.0 259.3 89.4Q264.3 91.7 267.4 95.7Q270.5 99.8 272.5 104.1Q274.5 108.4 275.6 113.0Q276.8 117.7 275.1 122.3Q273.4 126.8 270.7 131.1Q268.0 135.3 263.1 137.9Q258.3 140.5 253.2 142.3Q248.0 144.1 242.4 144.7Q236.8 145.3 231.2 144.3Q225.5 143.3 221.2 140.2Q216.9 137.1 213.3 133.6Q209.6 130.2 207.9 125.8Q206.1 121.5 205.1 116.9Q204.0 112.4 204.9 107.6"/><path class="s y" d="M208.0 102.9Q213.3 94.2 218.1 91.3Q222.8 88.3 228.5 87.3Q234.2 86.2 240.1 85.4Q245.9 84.5 251.5 86.4Q257.0 88.2 261.6 91.3Q266.2 94.4 269.3 98.5Q272.4 102.6 273.7 107.3Q275.0 112.0 275.0 116.8Q275.0 121.6 272.7 126.1Q270.4 130.5 266.5 134.1Q262.6 137.6 257.8 140.5Q253.1 143.3 247.3 144.3Q241.5 145.3 235.5 145.0Q229.5 144.7 224.1 142.5Q218.6 140.3 214.8 136.5Q211.0 132.7 208.1 128.4Q205.1 124.1 204.7 119.2Q204.3 114.3 205.3 109.6Q206.3 104.8 209.1 100.5Q211.8 96.1 215.9 92.5"/><text x="240" y="121" text-anchor="middle" style="font-size:17px">waiting</text><path class="s y" d="M364.7 122.8Q359.8 131.2 356.5 135.0Q353.1 138.8 348.2 141.4Q343.2 143.9 337.5 144.4Q331.8 144.9 326.4 144.0Q320.9 143.1 315.6 141.7Q310.2 140.3 306.0 137.1Q301.8 134.0 298.9 129.9Q295.9 125.8 294.6 121.2Q293.4 116.5 294.3 111.9Q295.3 107.2 297.5 102.9Q299.7 98.6 303.4 94.9Q307.0 91.2 312.3 89.6Q317.6 87.9 322.9 86.7Q328.2 85.6 333.9 85.6Q339.5 85.7 344.9 87.3Q350.3 89.0 354.6 92.3Q358.9 95.6 361.0 100.0Q363.1 104.5 365.1 108.9Q367.1 113.4 365.7 118.1Q364.2 122.7 362.1 127.0"/><path class="s y" d="M349.7 140.4Q338.7 143.9 332.9 144.6Q327.1 145.3 321.2 144.4Q315.3 143.4 310.9 140.1Q306.5 136.7 302.4 133.3Q298.2 129.8 296.3 125.2Q294.4 120.5 294.6 115.7Q294.9 110.8 296.9 106.3Q298.9 101.9 301.5 97.4Q304.0 92.9 309.1 90.2Q314.2 87.6 319.9 86.3Q325.6 85.0 331.4 85.7Q337.1 86.4 343.0 87.4Q348.8 88.4 352.9 92.0Q357.1 95.5 360.2 99.7Q363.3 103.8 364.7 108.5Q366.1 113.2 365.3 118.1Q364.6 122.9 362.7 127.6Q360.8 132.4 356.2 135.6Q351.7 138.8 346.6 141.3Q341.5 143.8 335.7 144.7"/><text x="330" y="121" text-anchor="middle" style="font-size:17px">waiting</text><path class="s g" d="M452.0 102.9Q455.4 111.7 455.9 116.5Q456.4 121.3 453.9 125.6Q451.5 130.0 447.8 133.5Q444.0 137.0 439.6 140.0Q435.2 143.1 429.5 143.5Q423.9 144.0 418.4 143.9Q412.8 143.9 407.8 142.1Q402.7 140.3 397.9 137.9Q393.1 135.4 390.1 131.4Q387.2 127.3 386.0 122.8Q384.7 118.3 384.8 113.6Q384.9 109.0 387.1 104.7Q389.3 100.4 392.3 96.5Q395.4 92.5 400.1 89.8Q404.9 87.2 410.5 86.3Q416.1 85.4 421.8 85.1Q427.5 84.9 432.4 87.3Q437.3 89.8 442.0 92.2Q446.7 94.7 449.4 98.8Q452.0 102.9 453.4 107.4"/><path class="s g" d="M387.3 104.6Q393.1 96.4 397.3 93.3Q401.6 90.1 406.8 88.1Q412.0 86.0 417.8 85.2Q423.7 84.5 429.2 86.3Q434.7 88.1 439.3 90.9Q444.0 93.7 448.2 97.2Q452.4 100.6 454.3 105.3Q456.3 110.0 456.5 115.0Q456.8 120.0 453.8 124.4Q450.8 128.7 447.4 132.5Q444.1 136.4 439.5 139.3Q434.8 142.2 429.3 144.0Q423.7 145.9 417.8 145.1Q411.9 144.3 406.2 142.8Q400.6 141.2 396.7 137.5Q392.8 133.8 389.6 129.7Q386.4 125.7 385.0 120.9Q383.6 116.1 384.9 111.4Q386.2 106.6 388.4 102.1Q390.6 97.6 394.5 93.9"/><text x="420" y="121" text-anchor="middle" style="font-size:17px">running</text><path class="s" d="M463.6 115.3Q506.3 117.0 549.2 114.1M462.3 116.2Q506.5 112.8 550.6 114.7"/><path class="s" d="M549.7 115.5Q544.7 117.0 540.4 120.0M549.3 114.8Q545.1 117.5 540.8 120.3"/><path class="s" d="M549.5 114.8Q544.8 113.3 540.2 109.7M550.3 114.8Q545.2 112.0 539.8 110.8"/><text x="20" y="40" text-anchor="start" style="font-size:21px">cpu.pressure counts the time threads spend in this queue</text><text x="20" y="205" text-anchor="start" class="m" style="font-size:19px">some = at least one thread waiting · full = nobody making progress</text></svg><figcaption>PSI measures the queue, not the work. Usage says how busy you are; pressure says how much you wait.</figcaption></figure>

Every cgroup has `cpu.pressure`, `memory.pressure` and `io.pressure`, and the node has the same in `/proc/pressure/`:

```bash
THREADS=$(( $(docker exec under-the-hood-worker nproc) * 2 ))
sed "s/__THREADS__/$THREADS/g" modules/11-psi/pods.yaml | kubectl -n lab apply -f -
kubectl -n lab wait --for=condition=Ready pod/psi-cpu pod/psi-memory
sleep 20
kubectl -n lab exec psi-cpu -- cat /sys/fs/cgroup/cpu.pressure
```

```
some avg10=75.19 avg60=24.03 avg300=5.60 total=17362896
full avg10=0.15 avg60=0.07 avg300=0.01 total=209848
```

| Part | Meaning |
|---|---|
| `some` | Share of time *at least one* task was stuck waiting |
| `full` | Share of time *every* task was stuck at once: no progress at all |
| `avg10`, `avg60`, `avg300` | Averages over 10 seconds, 1 minute and 5 minutes, in percent |
| `total` | Total waiting time, in microseconds |

`psi-cpu` runs twice as many busy threads as the node has CPUs, so over the last 10 seconds at least one of its threads was waiting for a CPU 75% of the time. When a pod is slow but its CPU and memory graphs look fine, check pressure. Rising `memory.pressure` is often the earliest warning you'll get before an OOM kill. Newer Kubernetes versions can export these numbers too (the `KubeletPSI` feature).

*Shortcut:* `make 11-psi`.

> [!KEY]
> Every cgroup file has a metric. Watch the throttling ratio, the working set and OOM events, and use pressure when graphs look fine but users don't.

---

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

*Shortcut:* `make 12-pids-and-ephemeral-storage` shows both: refused forks, and a pod evicted for writing too much.

> [!KEY]
> PIDs are capped by a cgroup. Disk space isn't: the kubelet measures it and evicts.

---

### 21. Finale: resize a running pod

*Question: if limits are just numbers in files, can we change them on a live pod?*

Here's the proof that ties the whole post together. Since Kubernetes 1.33 (where in-place resize is on by default), you can change a running pod's CPU and memory **in place**, with no restart. Remember chapter 8, where you changed `cpu.max` with `echo` while a process was running? That's all this is.

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

```
20000 100000        ← before: 200m
67108864            ← before: 64 MiB
50000 100000        ← after: 500m
134217728           ← after: 128 MiB
restarts=0
```

The kubelet asked the runtime to rewrite the files of the live container. Same container, same process, new numbers. This was my favourite moment building the lab, because it's the clearest proof that `resources:` really is just a few numbers in a few files.

*Shortcut:* `make 13-in-place-resize`.

> [!KEY]
> Resize rewrites the cgroup files of a live container. No restart, because there's nothing to restart: it's just a file.

---

## Wrap-up

### Put it to the test

Reading about throttling and knowing it when you see it are different skills. The lab has three small incidents: each breaks something, prints a ticket that sounds like a real page, and leaves the digging to you.

| # | The ticket | Where the answer is |
|:-:|---|---|
| 1 | "Checkout is slow, but the CPU graph is under its limit" | Chapters 14 and 15 |
| 2 | "OOMKilled, but the dashboard never went above half" | Chapters 16 and 17 |
| 3 | "Pending for ages, the node's memory is almost empty" | Chapters 10 and 18 |

```bash
make incident-1                       # start it and read the ticket
make hint-1                           # if you're stuck
make answer-1 CAUSE=<your answer>     # checks you, explains, and shows the fix
```

Try to solve each one with only `kubectl`, `cat` and the files from this post before reaching for the hint.

### Make your app cgroup-aware

The kernel enforces the box, but the program inside should know how big the box is:

- **Java:** container support is on by default in JDK 10+ and 8u191+. Size the heap with `-XX:MaxRAMPercentage` rather than a fixed `-Xmx`.
- **Go:** from Go 1.25, `GOMAXPROCS` follows the cgroup CPU limit. On older versions, use `go.uber.org/automaxprocs`, or Go will run one thread per host core and get throttled.
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

Three Kubernetes features often mentioned alongside these don't touch cgroups at all, so I've left them out of this post: **ResourceQuota** (a namespace's total budget), **LimitRange** (default and maximum requests per container) and **PriorityClass** (who gets scheduled, and who's evicted, first). They're checked by the API server and the scheduler (chapter 9). The lab has a hands-on module for each: `make 14-resourcequota`, `make 15-limitrange` and `make 16-priority-preemption`.

### Takeaways

- **Kubernetes decides; the kernel enforces.** When something behaves strangely, ask which checkpoint did it, then read that layer's files.
- **Requests** place your pod, share CPU when it's contended, and decide eviction order. Make them honest.
- **CPU limits** throttle, even on an idle node, and all your threads spend the same budget. Throttling can trigger **liveness restarts** and **readiness drop-outs** that spread load to other pods. Many teams drop CPU limits for latency-sensitive services and rely on good requests instead. Measure throttling before and after.
- **Memory limits** end in OOM kills once reclaim runs out. Setting them is a good default, because one leaky container otherwise puts the whole node at risk. For important workloads, memory requests equal to limits give the most predictable behaviour, at the cost of reserving memory you may not always use.
- **Watch the right numbers:** the throttling ratio, the working set, `oom_kill` counts, and pressure. Average CPU and `memory.current` will mislead you.

If you made it this far, thanks for reading. Clone the [lab](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood), run `make all`, and watch it all happen. And if something doesn't behave the way I described on your machine, open an issue or ping me on LinkedIn; I'd genuinely like to know.

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
| `make <module>` | Run one lab module's steps and check the results, e.g. `make 01-cgroups-by-hand` |
| `KEEP=1 make <module>` | Same, but leave the pods running so you can poke around |
| `make all` | Run every module in order |
| `make watch POD=<pod>` | A live, once-a-second view of a pod's cgroup files |
| `make reset` | Remove everything the lab created, keep the cluster |
| `make clean` | Delete the whole cluster |

Every `make` run cleans up its own pods afterwards, even if a check fails or you press Ctrl-C. `scripts/pod-cgroup.sh` prints where a pod's cgroup folder is on the node, so you don't have to dig through the tree by hand.

### Sources and further reading

- [Linux kernel docs: Control Group v2](https://docs.kernel.org/admin-guide/cgroup-v2.html), the reference for every file in this post
- [Linux kernel docs: CFS bandwidth control](https://docs.kernel.org/scheduler/sched-bwc.html), how quota, period, slices and burst work
- [Linux kernel docs: EEVDF scheduler](https://docs.kernel.org/scheduler/sched-eevdf.html)
- [Linux kernel docs: Pressure stall information](https://docs.kernel.org/accounting/psi.html)
- [Kubernetes docs: Resource management for pods and containers](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)
- [Kubernetes docs: Node-pressure eviction](https://kubernetes.io/docs/concepts/scheduling-eviction/node-pressure-eviction/)
- [Kubernetes docs: Resize CPU and memory resources assigned to containers](https://kubernetes.io/docs/tasks/configure-pod-container/resize-container-resources/)
- [Kubernetes blog: New conversion from cgroup v1 CPU shares to v2 CPU weight](https://kubernetes.io/blog/2026/01/30/new-cgroup-v1-to-v2-cpu-conversion-formula/)
- [iximiuz Labs: Controlling process resources with Linux control groups](https://labs.iximiuz.com/tutorials/controlling-process-resources-with-cgroups), a great companion to chapter 8
