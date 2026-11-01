---
title: "Cgroups: A Deep Dive into Resource Management in Kubernetes – Part 1: Foundations"
date: 2026-10-28
summary: Part 1 of 3. The Linux you need to understand Kubernetes resources: processes and threads, /proc and /sys, building a cgroup by hand, and following one pod's YAML down to the kernel's files.
tags: [linux, kubernetes, cgroups]
slug: cgroups-deep-dive-kubernetes-part-1
aliases: [cgroups-deep-dive-kubernetes]
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

That's what this three-part series is about. We'll start from zero, and by the end you'll be able to:

* find the exact files on a node that hold your pod's CPU and memory limits, and read them;
* explain how a pod using a fraction of its CPU can still be frozen for most of every 100 ms, and how that turns into restarts and lost capacity;
* explain why a pod can be OOM-killed while the dashboard says it had room to spare;
* set requests and limits deliberately, not out of habit;
* resize a running pod's CPU and memory without restarting it, and know exactly why that works.

## How to read this series

The series is in three parts, and each one builds on the last:

| Part | Chapters | What you'll learn |
|---|---|---|
| **1. Foundations** (this part) | 1–11 | How Linux runs programs and keeps its settings in files, building a cgroup by hand, and how Kubernetes writes those same files for every pod |
| **[2. CPU](/blog/cgroups-deep-dive-kubernetes-part-2/)** | 12–15 | How Linux shares a CPU, requests and limits, throttling, the outage explained, and watching CPU in production |
| **[3. Memory](/blog/cgroups-deep-dive-kubernetes-part-3/)** | 16–21 | Memory limits and OOM kills, a node running short, watching memory in production, other limits, and resizing a live pod |

Every chapter starts with a question, explains it with a sketch, lets you try it, and ends with **one line to remember**.

---

## The machine

Before we touch Kubernetes, we need to understand the machine it runs on. Everything in this series, from CPU throttling to OOM kills to that outage, comes from a few simple ideas about how Linux works. If you already know them, skim ahead. If you don't, this is the part that makes the rest easy.

> [!NOTE]
> **On a Mac or Windows?** The folders in this part (`/proc`, `/sys`) only exist on Linux. Start a small Linux container and follow along inside it:
>
> ```bash
> docker run --rm -it --cpus=0.5 --memory=128m ubuntu bash
> ```
>
> Keep that `--cpus=0.5 --memory=128m` in mind. We'll find those exact numbers in a file in chapter 5.

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

*Lab:* [01-processes-and-threads](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood/tree/main/labs/01-processes-and-threads). Check what you built with `make check LAB=01`.

> [!KEY]
> Programs run as processes, processes run as threads, and the kernel decides which thread gets each CPU core and how much memory everyone gets.


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

These special folders are called **virtual filesystems**. Two of them matter for this series: `/proc` and `/sys`.

<figure class="sketch "><svg viewBox="0 0 760 260" role="img" aria-label="Reading a kernel file asks the kernel a question"><title>Reading a kernel file asks the kernel a question</title><defs><clipPath id="cck1"><rect x="20" y="80" width="220" height="70"/></clipPath><clipPath id="cck2"><rect x="585" y="70" width="160" height="90"/></clipPath></defs><path class="h a" clip-path="url(#cck1)" d="M-40.9 152.2Q-11.1 114.5 20.0 78.0M-32.6 151.6Q-2.4 114.3 29.2 78.1M-22.3 152.9Q10.3 115.9 40.1 77.9M-11.7 152.7Q21.0 115.7 49.3 77.5M-1.6 151.0Q29.1 115.3 59.6 77.0M9.7 152.0Q38.0 114.1 70.4 77.4M19.5 150.9Q49.2 114.6 81.2 77.0M30.6 152.8Q59.5 114.3 90.6 77.5M40.0 151.0Q69.0 114.4 101.3 79.0M48.3 151.1Q79.6 114.8 110.8 77.3M60.0 152.3Q91.0 115.9 120.9 78.3M68.5 152.8Q100.7 115.9 131.1 79.2M78.2 152.2Q108.7 114.3 138.7 77.5M87.6 152.0Q118.1 114.1 148.9 78.3M97.5 152.7Q127.1 114.8 158.7 78.0M107.6 151.8Q137.7 114.5 167.4 77.3M117.9 152.7Q147.1 114.4 178.3 76.8M128.6 151.7Q159.0 115.5 189.7 78.5M137.6 151.7Q168.1 115.4 198.6 78.2M147.1 151.0Q179.0 115.7 208.5 78.0M158.4 151.1Q188.2 115.3 217.6 78.9M167.9 152.3Q197.9 113.8 228.7 78.9M178.1 152.4Q206.9 113.9 237.5 77.2M186.2 151.8Q218.2 115.8 246.7 78.5M197.2 151.6Q227.1 114.7 257.3 79.0M205.8 152.8Q237.6 115.7 267.1 77.9M215.9 150.9Q246.1 115.4 275.1 77.5M225.1 152.4Q256.0 114.8 286.7 79.0M234.9 151.5Q266.3 115.3 297.3 78.1"/><path class="s a" d="M18.5 80.2Q129.9 81.9 240.4 81.5M18.5 79.2Q129.7 79.7 240.4 81.5"/><path class="s a" d="M238.9 78.5Q241.1 115.4 239.3 150.8M240.8 80.3Q240.4 114.7 241.6 150.8"/><path class="s a" d="M238.7 148.7Q129.7 149.3 20.4 151.5M241.0 151.5Q129.7 150.0 21.4 148.8"/><path class="s a" d="M18.5 149.1Q19.1 115.6 20.1 79.5M21.3 149.6Q21.4 115.0 19.6 81.0"/><text x="130" y="112" text-anchor="middle" class="code">cat /proc/meminfo</text><text x="130" y="136" text-anchor="middle" class="m" style="font-size:16px">you ask</text><path class="s" d="M244.3 114.5Q287.0 117.4 329.5 114.1M244.4 114.4Q287.5 116.4 331.5 113.5"/><path class="s" d="M330.5 115.6Q324.7 117.1 320.2 120.5M329.4 115.0Q325.1 117.2 320.6 120.3"/><path class="s" d="M330.0 114.6Q325.2 112.6 319.6 110.0M330.3 115.0Q325.1 112.2 320.2 109.9"/><path class="s" d="M334.6 50.6Q429.6 49.5 525.5 50.3M335.1 49.8Q430.2 48.7 525.3 49.1"/><path class="s" d="M524.0 50.1Q523.2 115.2 525.3 180.3M526.0 49.8Q524.2 115.0 525.7 179.0"/><path class="s" d="M525.8 180.0Q429.6 180.3 335.0 180.4M525.4 180.5Q430.2 180.1 334.3 180.5"/><path class="s" d="M334.4 179.6Q335.1 115.3 334.1 49.5M335.5 180.0Q333.6 115.3 335.8 49.7"/><text x="430" y="80" text-anchor="middle" class="code">/proc/meminfo</text><text x="430" y="110" text-anchor="middle" class="r" style="font-size:18px">size: 0 bytes</text><text x="430" y="140" text-anchor="middle" class="m" style="font-size:16px">nothing stored here</text><path class="s" d="M529.0 116.5Q553.4 114.6 580.3 113.5M526.5 116.5Q554.2 117.3 578.7 114.2"/><path class="s" d="M580.0 114.9Q575.2 118.1 570.7 119.3M579.4 115.4Q574.9 117.5 570.7 119.9"/><path class="s" d="M580.8 115.7Q575.6 111.9 569.7 110.7M579.7 115.3Q574.6 113.4 570.9 109.7"/><path class="h b" clip-path="url(#cck2)" d="M507.8 162.7Q544.7 113.8 584.2 67.2M516.4 161.0Q555.7 115.8 593.1 68.4M525.8 162.8Q563.7 114.5 604.1 67.8M534.4 161.5Q570.9 113.6 612.3 67.3M542.4 162.8Q581.5 114.3 620.4 67.8M551.6 162.0Q591.2 114.7 631.2 69.2M562.0 160.8Q601.3 115.8 638.7 67.6M568.5 161.4Q607.0 114.1 647.1 69.0M577.9 161.8Q615.6 114.7 654.8 68.4M584.4 160.9Q624.4 114.5 663.5 67.9M594.1 161.2Q631.5 114.4 672.9 67.1M603.7 162.7Q642.4 115.1 682.4 68.3M614.0 160.9Q653.8 115.8 691.5 68.5M620.7 162.1Q660.4 114.4 699.7 67.7M631.4 161.3Q669.8 115.1 708.0 68.6M640.6 161.6Q679.0 115.4 717.6 67.9M647.7 162.1Q688.6 115.6 726.4 68.3M657.9 161.5Q697.1 115.3 737.3 68.5M667.7 161.1Q706.3 115.0 745.1 69.0M675.5 163.0Q714.1 114.0 755.4 67.2M685.1 161.3Q723.7 114.9 764.2 67.2M695.1 162.9Q734.1 116.2 772.0 67.2M702.4 162.3Q742.4 115.1 780.7 67.9M712.2 162.1Q751.6 115.6 790.2 68.9M720.6 161.7Q757.9 114.7 796.5 69.2M727.0 161.4Q767.5 115.5 806.7 68.2M737.4 163.0Q775.3 114.0 814.9 68.8"/><path class="s b" d="M583.7 70.9Q665.1 68.2 746.2 69.6M585.0 69.4Q665.4 69.4 745.6 69.4"/><path class="s b" d="M746.6 68.5Q744.6 114.7 743.9 160.6M743.7 69.2Q745.3 115.0 743.6 159.8"/><path class="s b" d="M744.6 158.5Q665.2 158.9 585.3 159.2M746.0 158.7Q664.4 159.7 586.2 158.9"/><path class="s b" d="M583.6 161.6Q586.9 115.0 586.1 69.0M583.7 161.2Q585.5 115.3 585.7 70.9"/><text x="665" y="108" text-anchor="middle" class="big" style="font-size:20px">the kernel</text><text x="665" y="136" text-anchor="middle" style="font-size:17px">works it out</text><text x="380" y="225" text-anchor="middle" class="g" style="font-size:19px">nothing on disk; the answer is made when you ask</text></svg><figcaption>Files in /proc and /sys aren't stored anywhere. Reading one asks the kernel; writing one changes a live setting.</figcaption></figure>

*Lab:* [02-everything-is-a-file](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood/tree/main/labs/02-everything-is-a-file). Check what you built with `make check LAB=02`.

> [!KEY]
> On Linux, the kernel shows its information and its settings as files. Read a file to ask it something, write a file to change something.


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

Try the one that matters most for this series:

```bash
cat /proc/self/cgroup
```

```
0::/
```

Every process belongs to a **cgroup**, and this file says which one. Inside our container it's simply `/`. We'll see why in chapter 7. For now, note that the kernel tracks it for every process.

*Lab:* [03-proc](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood/tree/main/labs/03-proc). Check what you built with `make check LAB=03`.

> [!KEY]
> `/proc` is a live report on every process, one folder per PID, and it includes which cgroup each process lives in.


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

For this series we only need one folder in `/sys`: **`/sys/fs`**, where the kernel keeps settings related to filesystems. Inside it is the folder this whole series is about:

```bash
ls /sys/fs
```

```
9p  bpf  btrfs  cgroup  erofs  ext4  f2fs  fuse  nfs  pstore  virtiofs  xfs
```

#### `/sys/fs/cgroup`: where resource limits live

`/sys/fs/cgroup` is the kernel's **resource control panel**. Every limit on CPU, memory or number of processes, for every container on the machine, is a file somewhere under this folder.

**cgroup** is short for **control group**: a group of processes that the kernel limits and keeps count of together. Each cgroup is a folder under `/sys/fs/cgroup`. The files in it are its limits and counters, and every process listed in it shares them. Folders can hold folders, so cgroups nest into a tree.

> [!NOTE]
> **Why do cgroups exist?** Picture one machine running dozens of services from different teams, all sharing one kernel. Without a fence, one memory leak or runaway loop starves everyone else: the *noisy neighbour* problem. Engineers at Google hit this early and in 2006 started work on "process containers", renamed **control groups** and merged into Linux 2.6.24 in 2008. The cleaner **cgroups v2** became stable in Linux 4.5 (2016), and Kubernetes made it generally available in 1.25.


You can check what kind of filesystem it is:

```bash
mount | grep cgroup
```

```
cgroup on /sys/fs/cgroup type cgroup2 (ro,nosuid,nodev,noexec,relatime)
```

`type cgroup2` means **cgroups version 2**, the current version and the only one this series uses. You'll still meet version 1 on older nodes and in older articles, so here's how the two differ:

| | cgroups v1 | cgroups v2 |
|---|---|---|
| Layout | A separate tree per resource: `/sys/fs/cgroup/cpu/`, `/sys/fs/cgroup/memory/`, … | One tree. Each group's folder holds its CPU, memory and other files together |
| A process belongs to | One group per tree, so possibly a different group for CPU than for memory | Exactly one group |
| CPU limit | `cpu.cfs_quota_us` and `cpu.cfs_period_us` | `cpu.max` |
| CPU share | `cpu.shares` (default 1024) | `cpu.weight` (default 100) |
| Memory limit | `memory.limit_in_bytes` | `memory.max` |
| Memory protection | Only a soft limit | `memory.min` and `memory.low` |
| Pressure (PSI) per group | No | Yes |
| In Kubernetes | Maintenance mode since 1.31. Since 1.35 the kubelet won't start on it unless you opt back in | Stable since 1.25, and the default |
| How to tell | `mount` shows `tmpfs` on `/sys/fs/cgroup` | `mount` shows `cgroup2` |

The ideas are the same in both; mostly the file names changed. So when an older article mentions `cpu.shares` or `cpu.cfs_quota_us`, read them as `cpu.weight` and `cpu.max`.

<figure class="sketch "><svg viewBox="0 0 760 330" role="img" aria-label="Where /proc and /sys sit, and where cgroups live"><title>Where /proc and /sys sit, and where cgroups live</title><defs><clipPath id="cft1"><rect x="110" y="95" width="180" height="60"/></clipPath><clipPath id="cft2"><rect x="470" y="95" width="180" height="60"/></clipPath><clipPath id="cft3"><rect x="380" y="236" width="160" height="40"/></clipPath></defs><text x="380" y="40" text-anchor="middle" class="big" style="font-size:26px">/</text><path class="s" d="M379.2 50.6Q290.2 71.3 198.9 89.5M379.4 49.7Q290.9 71.5 201.0 89.6"/><path class="s" d="M381.3 48.5Q469.5 71.3 561.3 89.5M378.6 48.7Q469.7 70.7 558.8 89.0"/><path class="h y" clip-path="url(#cft1)" d="M57.8 156.2Q83.0 124.6 108.9 93.4M68.0 156.5Q94.0 125.8 120.1 94.2M76.3 157.0Q102.4 125.9 127.0 93.4M85.7 156.1Q111.2 125.1 138.4 91.8M93.9 156.7Q121.2 125.5 146.1 93.6M103.8 155.9Q130.7 125.6 155.5 93.1M112.6 156.3Q139.9 126.2 165.6 92.5M120.6 156.4Q147.7 126.0 172.4 93.2M129.9 157.5Q157.5 125.2 181.9 93.9M138.9 156.5Q164.6 125.0 191.7 94.0M148.4 157.1Q172.6 124.6 200.7 92.7M155.9 156.9Q183.6 125.7 209.2 93.4M166.8 157.3Q191.2 123.9 219.6 92.7M174.5 157.9Q200.1 123.9 226.5 94.2M182.7 156.8Q210.4 125.3 235.5 92.0M193.3 157.7Q218.5 124.2 246.2 92.9M202.2 156.3Q228.5 125.2 253.4 92.7M209.3 155.9Q237.6 125.7 263.6 93.9M219.2 156.3Q244.0 124.9 271.8 93.5M228.0 157.3Q251.8 124.4 279.9 92.6M235.2 157.9Q261.5 124.9 288.5 93.2M244.1 157.9Q269.3 123.9 296.8 93.8M252.1 156.3Q278.8 125.5 303.6 92.3M259.9 156.1Q286.3 124.7 313.3 93.3M269.0 157.9Q295.8 124.5 321.6 92.6M278.3 157.4Q303.8 125.0 330.5 94.1M287.0 157.9Q314.4 125.9 340.2 93.2"/><path class="s y" d="M110.1 94.2Q200.2 94.1 291.5 96.3M110.4 96.3Q199.5 94.2 290.6 93.9"/><path class="s y" d="M288.9 94.5Q289.0 125.6 290.8 154.4M288.7 94.3Q290.4 125.3 289.2 155.7"/><path class="s y" d="M290.3 155.3Q200.0 153.6 110.3 155.5M288.8 156.5Q200.2 153.4 109.8 153.8"/><path class="s y" d="M110.3 155.4Q109.0 124.7 110.5 94.1M110.9 156.1Q110.8 124.4 108.9 94.6"/><text x="200" y="122" text-anchor="middle" class="code">/proc</text><text x="200" y="145" text-anchor="middle" class="m" style="font-size:15px">processes: what's happening</text><path class="h b" clip-path="url(#cft2)" d="M417.1 157.0Q442.6 124.2 469.1 92.9M427.7 158.0Q452.9 124.5 478.6 93.8M435.2 156.7Q460.6 124.4 487.8 92.4M446.5 156.2Q470.8 124.2 497.9 93.7M453.0 157.9Q480.9 125.9 505.5 92.6M462.5 156.2Q487.4 123.6 516.0 92.0M470.7 157.2Q496.4 124.5 523.6 94.1M479.7 156.7Q505.4 124.2 533.3 93.6M489.3 156.4Q513.9 123.6 540.5 92.2M496.8 157.9Q523.1 125.1 550.1 93.6M507.4 157.7Q533.3 125.7 559.6 92.7M515.4 156.6Q543.1 125.8 567.3 93.0M524.4 157.2Q549.2 124.3 576.7 92.8M531.2 156.4Q558.7 125.8 584.3 93.0M540.0 158.0Q567.0 124.5 593.5 92.2M549.8 157.8Q577.4 125.5 602.3 94.0M558.6 156.5Q584.6 124.7 611.7 93.6M568.3 157.2Q593.2 124.4 621.7 94.0M577.8 156.9Q601.9 123.6 628.4 94.1M585.7 157.3Q611.5 124.0 637.4 92.3M593.9 157.1Q621.0 126.0 645.5 92.4M603.3 157.0Q630.2 125.1 654.7 93.0M612.7 157.6Q639.1 126.2 664.3 92.9M622.6 157.6Q647.0 124.9 673.2 93.9M629.5 158.0Q656.9 125.0 682.5 93.6M638.9 157.7Q665.8 124.8 691.6 92.3M647.3 157.9Q673.8 124.8 699.2 94.2"/><path class="s b" d="M470.5 96.6Q559.8 94.1 649.3 96.6M468.5 96.4Q560.4 94.2 648.9 93.6"/><path class="s b" d="M651.4 96.0Q650.6 124.8 649.1 154.7M649.7 96.4Q648.7 125.6 648.6 154.9"/><path class="s b" d="M648.9 156.3Q559.9 156.4 470.5 154.8M651.0 153.5Q560.0 155.2 470.9 155.9"/><path class="s b" d="M468.4 156.2Q469.4 125.0 470.9 93.7M470.3 153.4Q471.3 125.4 470.7 95.4"/><text x="560" y="122" text-anchor="middle" class="code">/sys</text><text x="560" y="145" text-anchor="middle" class="m" style="font-size:15px">kernel: settings</text><path class="s" d="M529.4 158.0Q500.2 170.4 469.4 183.6M531.5 158.2Q499.8 170.1 471.5 183.5"/><text x="460" y="202" text-anchor="middle" class="code">fs</text><path class="s" d="M460.6 210.4Q459.9 221.2 459.5 230.6M459.0 211.1Q459.1 220.9 460.5 233.1"/><path class="h a" clip-path="url(#cft3)" d="M344.1 277.1Q361.5 254.9 380.2 234.2M355.1 278.1Q373.6 257.2 389.3 234.8M365.3 277.1Q381.1 256.0 398.7 233.9M374.4 277.7Q390.4 255.5 407.5 234.6M382.4 278.1Q401.4 257.4 417.9 233.1M391.6 278.6Q410.5 257.5 426.3 235.0M399.8 278.4Q416.3 254.5 435.3 234.3M410.5 278.8Q426.0 255.9 444.1 233.8M419.5 277.2Q437.2 256.6 453.1 235.2M427.0 278.7Q443.8 255.1 460.7 233.1M436.0 277.7Q453.3 256.0 471.3 232.9M445.3 277.9Q461.8 254.7 479.8 232.9M454.7 279.1Q472.3 255.3 491.2 233.1M463.9 278.4Q482.3 256.7 499.7 234.5M471.9 277.6Q488.7 255.4 507.7 233.6M482.7 278.7Q500.0 256.2 517.9 233.2M491.2 279.2Q507.9 256.4 525.3 234.2M500.8 277.3Q519.0 257.2 534.6 233.4M508.3 278.0Q526.6 255.8 544.0 234.1M517.6 277.9Q534.0 255.5 551.3 234.8M525.7 277.6Q543.7 255.6 560.6 234.9M537.5 279.1Q555.0 256.6 571.0 234.3"/><path class="s a" d="M378.9 234.9Q460.1 236.4 540.8 235.3M379.3 237.2Q460.2 236.9 541.2 237.3"/><path class="s a" d="M540.1 237.0Q538.8 255.8 539.1 276.2M538.5 237.5Q540.8 256.5 540.7 275.6"/><path class="s a" d="M539.2 275.7Q459.5 275.4 379.3 276.8M541.5 276.2Q459.4 274.0 379.6 276.4"/><path class="s a" d="M381.5 275.5Q381.2 256.4 381.4 235.2M380.7 274.9Q378.9 255.7 378.6 234.7"/><text x="460" y="262" text-anchor="middle" class="code">cgroup</text><path class="s" d="M541.8 256.0Q560.4 247.6 579.4 239.8M542.0 256.4Q561.0 248.5 580.7 239.4"/><path class="s r" d="M593.1 231.7Q595.5 233.1 596.4 234.2Q597.3 235.2 598.0 236.4Q598.7 237.6 599.0 239.0Q599.3 240.4 598.7 241.8Q598.2 243.1 597.6 244.4Q597.0 245.6 595.9 246.5Q594.8 247.3 593.6 248.0Q592.4 248.7 591.0 249.0Q589.6 249.2 588.2 248.9Q586.8 248.5 585.5 247.9Q584.2 247.2 583.4 246.0Q582.5 244.9 582.0 243.6Q581.4 242.4 581.3 241.0Q581.1 239.6 581.4 238.2Q581.7 236.9 582.4 235.6Q583.0 234.4 584.1 233.5Q585.1 232.5 586.4 232.1Q587.7 231.6 589.1 231.2Q590.4 230.8 591.8 231.3Q593.1 231.8 594.5 232.3"/><path class="s r" d="M585.3 247.7Q583.3 245.7 582.4 244.5Q581.6 243.3 581.3 241.8Q580.9 240.4 581.1 238.9Q581.2 237.5 581.9 236.1Q582.6 234.8 583.6 233.8Q584.6 232.7 585.9 232.1Q587.3 231.4 588.7 231.1Q590.2 230.8 591.6 231.2Q593.0 231.6 594.3 232.3Q595.5 233.1 596.6 234.1Q597.7 235.1 598.2 236.4Q598.7 237.8 598.9 239.3Q599.1 240.7 598.6 242.1Q598.1 243.5 597.3 244.7Q596.5 245.9 595.4 246.8Q594.3 247.7 593.0 248.3Q591.6 248.9 590.2 248.8Q588.7 248.7 587.3 248.3Q585.9 248.0 584.7 247.2Q583.4 246.5 582.5 245.2"/><text x="604" y="245" text-anchor="start" class="code" style="font-size:15px">cpu.max</text><path class="s" d="M541.3 256.4Q560.9 262.3 579.4 270.2M541.5 256.5Q561.3 262.9 579.8 269.7"/><path class="s r" d="M581.3 268.6Q581.9 265.8 582.8 264.8Q583.8 263.8 584.9 263.0Q586.1 262.2 587.3 261.6Q588.6 260.9 590.0 261.0Q591.5 261.0 592.8 261.5Q594.2 261.9 595.4 262.7Q596.6 263.5 597.4 264.7Q598.2 265.8 598.7 267.2Q599.2 268.6 599.0 270.0Q598.9 271.4 598.6 272.8Q598.3 274.2 597.4 275.4Q596.4 276.5 595.2 277.2Q594.0 278.0 592.7 278.4Q591.4 278.9 589.9 279.0Q588.5 279.1 587.2 278.6Q585.8 278.1 584.6 277.3Q583.4 276.5 582.7 275.3Q582.1 274.0 581.5 272.7Q581.0 271.4 581.1 270.0Q581.2 268.6 581.5 267.2"/><path class="s r" d="M587.5 278.6Q584.7 277.6 583.8 276.5Q582.9 275.3 582.2 274.0Q581.6 272.7 581.3 271.3Q581.1 269.9 581.4 268.5Q581.8 267.1 582.3 265.7Q582.9 264.4 584.0 263.4Q585.1 262.4 586.4 261.7Q587.7 261.0 589.2 261.1Q590.7 261.2 592.1 261.6Q593.5 261.9 594.6 262.7Q595.8 263.5 596.8 264.6Q597.8 265.6 598.4 267.0Q599.0 268.3 598.9 269.8Q598.7 271.2 598.4 272.7Q598.0 274.1 597.2 275.2Q596.3 276.4 595.2 277.4Q594.0 278.4 592.6 278.8Q591.1 279.2 589.7 278.9Q588.2 278.6 586.8 278.2Q585.4 277.8 584.4 276.7"/><text x="604" y="275" text-anchor="start" class="code" style="font-size:15px">cpu.weight</text><path class="s" d="M541.7 256.6Q560.2 278.8 580.3 299.8M542.8 255.3Q561.5 277.4 580.1 299.4"/><path class="s r" d="M581.4 303.4Q580.8 300.5 581.2 299.2Q581.5 297.8 581.9 296.4Q582.3 295.1 583.3 294.0Q584.3 293.0 585.4 292.2Q586.6 291.4 588.0 291.1Q589.5 290.9 590.9 291.1Q592.3 291.3 593.6 291.8Q594.9 292.3 596.0 293.2Q597.2 294.1 597.7 295.4Q598.3 296.7 598.8 298.1Q599.2 299.5 599.1 300.9Q598.9 302.3 598.2 303.6Q597.5 304.8 596.7 306.0Q595.9 307.2 594.6 307.9Q593.4 308.6 592.0 308.9Q590.5 309.1 589.1 308.9Q587.7 308.7 586.4 308.2Q585.1 307.7 584.0 306.8Q582.9 305.8 582.4 304.5Q581.9 303.2 581.4 301.9"/><path class="s r" d="M592.7 308.5Q589.8 309.0 588.4 308.8Q586.9 308.6 585.6 307.8Q584.4 307.1 583.3 306.0Q582.2 305.0 581.7 303.6Q581.2 302.2 581.2 300.7Q581.3 299.3 581.6 297.9Q581.9 296.5 582.6 295.2Q583.3 293.9 584.4 292.9Q585.5 291.9 587.0 291.7Q588.4 291.4 589.9 291.2Q591.3 290.9 592.7 291.4Q594.1 291.9 595.2 292.9Q596.2 293.9 597.2 295.0Q598.1 296.1 598.5 297.5Q598.8 299.0 598.8 300.4Q598.7 301.8 598.3 303.3Q597.9 304.7 596.8 305.7Q595.7 306.6 594.5 307.3Q593.2 308.1 591.9 308.6Q590.5 309.0 589.0 308.9"/><text x="604" y="305" text-anchor="start" class="code" style="font-size:15px">memory.max</text><text x="200" y="200" text-anchor="middle" class="code">/proc/&lt;pid&gt;/cgroup:</text><text x="200" y="222" text-anchor="middle" class="m" style="font-size:15px">which cgroup a process is in</text><path class="s" d="M199.3 159.3Q200.5 170.1 198.9 184.5M198.8 159.5Q199.9 170.5 198.5 184.2"/></svg><figcaption>/proc reports on processes. /sys holds the kernel's settings, and /sys/fs/cgroup is where the resource dials are.</figcaption></figure>

Two folders, two jobs. It's easy to mix them up, so here they are side by side:

| | `/proc` | `/sys/fs/cgroup` |
|---|---|---|
| About | One **process** at a time | **Groups** of processes |
| Mostly | **Reports**: what each process is doing | **Controls**: what each group may use, plus a few gauges |
| Example | `/proc/1/status`: one process's memory use | `memory.max`: one group's memory limit |
| Can you change it? | Mostly read-only | Yes: write a file and the limit changes |
| The link between them | `/proc/<pid>/cgroup` says which group a process is in | `cgroup.procs` lists which processes are in a group |

When you want to know **what a process is doing**, look in `/proc`. When you want to know **what it's allowed to do**, look in `/sys/fs/cgroup`.

*Lab:* [04-sys-and-sys-fs-cgroup](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood/tree/main/labs/04-sys-and-sys-fs-cgroup). Check what you built with `make check LAB=04`.

> [!KEY]
> `/sys` holds the kernel's settings, one value per file, and `/sys/fs/cgroup` is the part that controls how much CPU and memory each group of processes may use.


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

Kernel files always use raw units like these. Keep this table nearby; the last two rows are the units you'll write in Kubernetes YAML:

| You'll see | It means | Example |
|---|---|---|
| microseconds (`usec`) | millionths of a second | `100000` = 100 ms |
| bytes | raw bytes | `134217728` = 128 MiB |
| `Ki`, `Mi`, `Gi` (in YAML) | ×1024, ×1024², ×1024³ | `128Mi` = 134,217,728 bytes |
| millicores (`m`, in YAML) | thousandths of a CPU | `500m` = half a CPU = `50000 100000` |

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
> **One file, two directions.** `cat` reads a setting. `echo` changes it, and the kernel applies the new value immediately, with no restart. Docker mounts this folder read-only inside a container (that's the `ro` in the `mount` output), so in the next section we'll do the writing on a lab node instead.

*Lab:* [05-cpu-max-and-cpu-weight](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood/tree/main/labs/05-cpu-max-and-cpu-weight). Check what you built with `make check LAB=05`.

> [!KEY]
> `cpu.max` is a hard CPU budget per 100 ms, `cpu.weight` is a share when CPUs are busy, `memory.max` is a byte ceiling, and `cgroup.procs` lists who they apply to.


---

### 6. Why CPU limits slow you down but memory limits kill you

The kernel can make CPU "wait" but kills for memory because the two resources behave differently.

**CPU is time.** If a group has used its budget, the kernel can tell it to wait. Its threads pause and then continue in the next window. Nothing is lost; it just takes longer. This waiting is called **throttling**.

**Memory is space.** Once a program holds memory, the kernel can't make it "wait" for less. The data is already there. If the group is full and asks for more, the kernel first tries to free memory that can safely be dropped (such as cached copies of files). If that isn't enough, the only option left is to **kill a process** to free its memory. This is an **OOM kill** (*out of memory*).

<figure class="sketch "><svg viewBox="0 0 760 300" role="img" aria-label="CPU is compressible, memory is not"><title>CPU is compressible, memory is not</title><defs><clipPath id="ccp1"><rect x="270" y="90" width="90" height="80"/></clipPath><clipPath id="ccp2"><rect x="432" y="100" width="46" height="60"/></clipPath><clipPath id="ccp3"><rect x="488" y="100" width="46" height="60"/></clipPath><clipPath id="ccp4"><rect x="544" y="100" width="46" height="60"/></clipPath><clipPath id="ccp5"><rect x="600" y="100" width="46" height="60"/></clipPath><clipPath id="ccp6"><rect x="656" y="100" width="46" height="60"/></clipPath></defs><text x="190" y="34" text-anchor="middle" class="big" style="font-size:23px">CPU: can be made to wait</text><text x="570" y="34" text-anchor="middle" class="big" style="font-size:23px">memory: can't be taken back</text><path class="s m2" d="M379.5 50.0Q380.7 164.9 379.7 278.5M379.2 51.5Q379.8 164.5 379.9 280.1"/><path class="h a" clip-path="url(#ccp1)" d="M199.8 172.1Q236.8 131.1 269.7 89.1M207.7 172.6Q242.1 129.8 276.4 88.8M216.1 172.1Q249.6 128.7 285.3 88.4M225.7 172.7Q261.5 130.8 294.9 88.4M232.1 172.1Q268.0 130.7 301.1 87.5M241.5 172.3Q275.5 129.7 310.1 88.0M251.3 172.1Q286.4 131.1 320.4 87.0M257.5 173.0Q293.4 131.0 326.1 87.4M266.5 172.7Q301.0 130.0 335.1 86.9M273.9 171.2Q308.3 130.1 344.0 87.1M280.2 170.8Q316.2 130.6 349.4 87.0M287.8 172.7Q320.9 128.9 358.1 88.1M296.9 171.6Q328.8 129.1 366.3 88.9M302.3 172.1Q336.5 128.5 372.3 89.0M312.6 171.0Q346.6 130.2 381.0 88.1M321.2 172.0Q354.7 129.6 389.0 89.1M327.4 172.2Q362.5 130.2 397.8 87.0M335.6 172.7Q371.8 130.3 404.9 86.9M343.5 172.5Q378.0 129.7 413.9 89.1M350.7 171.0Q385.6 130.2 421.0 88.9M359.4 171.8Q394.3 130.5 429.2 89.0"/><path class="s a" d="M269.4 91.5Q315.6 87.9 360.1 89.6M270.8 89.6Q315.6 88.5 359.5 91.2"/><path class="s a" d="M359.1 89.1Q358.0 129.7 361.1 171.0M359.4 90.6Q357.6 130.4 358.9 169.9"/><path class="s a" d="M360.4 171.2Q315.5 172.4 269.3 169.4M361.5 170.0Q314.9 167.8 270.0 169.4"/><path class="s a" d="M271.1 171.3Q267.7 130.5 270.3 90.3M270.6 169.6Q270.6 130.1 268.5 90.4"/><text x="315" y="136" text-anchor="middle" class="big" style="font-size:22px">CPU</text><path class="s y" d="M69.7 151.2Q62.8 153.7 59.1 153.4Q55.4 153.1 52.0 151.8Q48.5 150.5 45.4 148.4Q42.2 146.4 40.6 143.0Q39.0 139.7 37.9 136.2Q36.8 132.7 37.0 129.1Q37.2 125.4 38.2 121.9Q39.2 118.3 41.5 115.4Q43.9 112.5 46.8 110.2Q49.8 107.8 53.5 106.9Q57.2 105.9 61.0 106.0Q64.8 106.1 68.3 107.6Q71.8 109.1 74.4 111.6Q77.1 114.2 79.7 117.0Q82.2 119.8 83.0 123.5Q83.7 127.2 83.9 131.0Q84.2 134.8 82.3 138.1Q80.4 141.4 78.4 144.6Q76.4 147.8 73.4 150.1Q70.3 152.4 66.6 153.1"/><path class="s y" d="M37.2 139.2Q36.2 131.3 36.5 127.5Q36.9 123.6 38.6 120.1Q40.2 116.6 42.7 113.4Q45.1 110.3 48.8 108.9Q52.5 107.5 56.3 106.5Q60.2 105.4 63.9 106.7Q67.6 107.9 71.3 109.3Q74.9 110.8 77.5 113.8Q80.0 116.8 81.7 120.3Q83.5 123.8 83.4 127.7Q83.3 131.6 82.7 135.4Q82.1 139.2 80.4 142.8Q78.6 146.4 75.2 148.5Q71.8 150.6 68.2 151.7Q64.5 152.8 60.6 153.4Q56.8 154.0 53.2 152.4Q49.7 150.9 46.5 148.8Q43.4 146.6 40.8 143.7Q38.3 140.7 37.2 136.9Q36.2 133.2 36.1 129.2"/><path class="s y" d="M122.0 106.4Q129.4 107.7 132.8 109.5Q136.2 111.3 138.0 114.6Q139.9 118.0 141.8 121.2Q143.7 124.5 143.8 128.2Q143.9 132.0 142.8 135.6Q141.7 139.2 140.0 142.5Q138.3 145.8 135.1 147.8Q132.0 149.8 128.8 151.9Q125.6 154.0 121.8 154.0Q118.0 154.1 114.3 153.2Q110.6 152.3 107.4 150.3Q104.2 148.2 101.6 145.4Q99.0 142.7 98.1 139.0Q97.3 135.3 97.0 131.7Q96.8 128.0 97.3 124.3Q97.7 120.6 100.0 117.6Q102.2 114.6 104.7 111.8Q107.3 108.9 111.0 108.1Q114.7 107.3 118.4 106.7Q122.0 106.1 125.7 106.8"/><path class="s y" d="M140.7 140.9Q136.4 147.3 133.2 149.4Q129.9 151.6 126.3 153.1Q122.6 154.6 118.7 153.9Q114.8 153.1 111.1 151.9Q107.4 150.7 104.4 148.1Q101.4 145.6 99.6 142.1Q97.9 138.6 97.3 134.8Q96.7 131.0 97.0 127.2Q97.3 123.4 99.1 120.0Q101.0 116.7 103.2 113.5Q105.5 110.2 109.2 109.0Q112.9 107.7 116.7 107.0Q120.5 106.3 124.5 106.5Q128.4 106.7 131.9 108.7Q135.3 110.8 137.9 113.8Q140.6 116.8 142.1 120.5Q143.6 124.1 144.1 128.1Q144.7 132.0 143.3 135.8Q141.9 139.5 139.9 142.8Q137.8 146.2 134.9 148.8"/><path class="s y" d="M169.8 108.5Q176.9 106.2 180.7 106.3Q184.4 106.5 188.0 107.8Q191.5 109.0 194.6 111.2Q197.7 113.3 199.9 116.5Q202.0 119.6 202.5 123.3Q203.0 127.1 203.7 130.8Q204.4 134.6 202.4 137.9Q200.4 141.2 198.7 144.6Q197.0 148.0 193.8 150.2Q190.5 152.3 186.8 153.0Q183.0 153.7 179.3 153.7Q175.5 153.7 172.2 152.1Q168.8 150.5 165.8 148.4Q162.7 146.3 160.3 143.3Q157.9 140.4 157.4 136.7Q156.9 133.0 156.3 129.2Q155.6 125.4 157.1 121.8Q158.6 118.3 160.8 115.1Q163.1 112.0 166.3 110.0Q169.6 108.0 173.3 107.1"/><path class="s y" d="M200.6 117.6Q203.8 124.8 203.5 128.7Q203.2 132.6 202.8 136.6Q202.4 140.5 199.6 143.4Q196.9 146.3 193.8 148.5Q190.7 150.6 187.1 152.2Q183.6 153.7 179.6 154.0Q175.7 154.3 172.0 152.8Q168.3 151.3 165.1 148.9Q162.0 146.5 160.3 142.9Q158.7 139.4 157.2 135.8Q155.7 132.1 155.9 128.2Q156.0 124.2 158.0 120.7Q160.0 117.3 162.4 114.2Q164.8 111.1 168.2 109.0Q171.5 106.9 175.5 106.9Q179.4 106.8 183.2 107.1Q187.1 107.3 190.4 109.2Q193.8 111.0 196.5 113.7Q199.2 116.4 201.4 119.7Q203.7 123.0 203.5 126.9"/><path class="s g" d="M263.6 124.6Q264.4 132.1 263.5 135.9Q262.6 139.6 260.2 142.5Q257.9 145.5 255.2 148.2Q252.5 150.8 248.9 152.0Q245.4 153.3 241.7 153.5Q237.9 153.8 234.3 152.9Q230.7 152.0 227.3 150.2Q224.0 148.4 221.4 145.6Q218.8 142.8 218.1 139.0Q217.4 135.2 216.7 131.6Q216.0 127.9 216.8 124.2Q217.6 120.5 219.8 117.4Q221.9 114.3 224.9 112.0Q227.8 109.8 231.3 108.6Q234.8 107.3 238.4 107.1Q242.0 106.9 245.6 107.6Q249.2 108.4 252.4 110.2Q255.6 112.0 258.1 114.8Q260.6 117.6 261.9 121.1Q263.1 124.7 263.9 128.4"/><path class="s g" d="M256.7 111.6Q261.1 118.2 262.3 121.9Q263.5 125.7 263.9 129.6Q264.3 133.5 263.2 137.4Q262.1 141.3 259.2 144.0Q256.3 146.7 253.3 149.1Q250.3 151.6 246.6 152.4Q242.8 153.1 239.0 153.0Q235.2 152.9 231.6 151.6Q228.0 150.3 225.0 147.9Q221.9 145.6 219.6 142.4Q217.3 139.2 216.8 135.3Q216.4 131.3 216.9 127.6Q217.5 123.8 218.8 120.1Q220.1 116.5 223.0 114.0Q226.0 111.5 229.2 109.3Q232.4 107.2 236.3 106.6Q240.1 105.9 244.0 106.7Q247.8 107.4 251.5 108.9Q255.2 110.4 257.5 113.7Q259.8 116.9 261.8 120.3"/><text x="150" y="82" text-anchor="middle" class="m" style="font-size:16px">threads waiting their turn</text><text x="160" y="200" text-anchor="middle" style="font-size:18px">too many? the rest just wait</text><text x="190" y="228" text-anchor="middle" class="m" style="font-size:17px">slower, but nobody dies</text><text x="190" y="262" text-anchor="middle" class="r" style="font-size:19px">→ throttling</text><path class="s b" d="M421.0 90.1Q570.1 90.7 721.3 88.7M421.0 90.1Q569.4 88.7 720.4 88.5"/><path class="s b" d="M719.9 88.7Q719.1 130.5 719.3 170.6M721.2 89.4Q719.2 129.8 720.7 168.6"/><path class="s b" d="M719.5 168.7Q570.0 168.2 421.1 171.4M719.0 168.5Q569.5 170.5 420.2 170.6"/><path class="s b" d="M419.1 168.4Q422.2 129.5 419.8 90.7M420.8 170.8Q419.9 130.3 419.6 90.5"/><path class="h b" clip-path="url(#ccp2)" d="M379.0 160.9Q407.2 131.5 431.4 98.6M385.2 162.9Q413.0 131.0 439.3 98.2M394.1 160.9Q420.5 130.2 446.7 98.2M400.1 163.0Q427.2 130.1 452.7 98.0M408.4 163.0Q435.0 130.1 460.7 97.2M415.3 161.7Q442.8 130.7 467.2 99.0M421.7 161.9Q448.9 131.0 473.5 98.9M430.5 162.4Q455.8 130.4 481.9 97.2M435.9 162.5Q461.5 129.5 487.4 99.1M443.2 161.2Q469.0 130.8 495.8 99.0M451.1 163.1Q475.6 129.4 501.9 99.0M458.6 162.8Q484.0 130.5 509.7 98.7M466.1 163.0Q491.7 130.3 516.4 98.3M473.2 162.4Q499.7 130.3 524.6 98.1"/><path class="s b" d="M432.0 100.5Q454.7 99.4 478.3 99.4M431.7 99.8Q455.3 100.1 478.3 99.4"/><path class="s b" d="M477.6 99.1Q478.9 130.2 478.9 159.4M477.2 100.2Q478.5 129.9 478.8 160.8"/><path class="s b" d="M478.5 159.5Q454.7 160.3 433.0 159.4M477.0 160.5Q455.0 159.3 432.2 159.2"/><path class="s b" d="M432.5 159.2Q432.1 130.3 432.3 100.8M431.6 159.7Q430.8 130.4 431.2 100.4"/><path class="h b" clip-path="url(#ccp3)" d="M435.9 161.6Q462.0 130.0 488.2 99.2M444.0 162.7Q470.8 131.4 495.0 98.2M449.1 161.8Q475.3 129.9 502.9 98.3M458.2 162.8Q483.6 130.5 508.7 98.6M463.6 162.6Q489.8 130.6 515.0 97.3M470.0 162.6Q497.3 130.9 523.0 97.7M476.3 162.5Q502.7 130.4 528.0 97.0M483.2 162.5Q509.8 130.4 536.6 99.0M491.2 161.2Q517.0 129.7 542.7 97.4M496.8 161.5Q523.3 128.9 550.2 98.6M506.3 162.6Q531.3 130.3 557.7 97.2M510.7 162.1Q538.5 130.0 564.1 98.8M517.7 161.6Q543.5 129.6 570.5 98.4M525.3 163.1Q551.9 130.5 578.0 97.4M534.0 162.5Q557.4 129.0 585.1 98.5"/><path class="s b" d="M488.9 99.4Q511.0 99.6 533.6 100.3M489.0 100.5Q511.0 100.8 533.2 99.4"/><path class="s b" d="M534.8 100.3Q535.6 129.7 534.1 160.2M533.9 99.2Q534.9 129.7 533.4 160.5"/><path class="s b" d="M534.9 159.3Q511.3 159.7 488.4 160.7M534.9 160.6Q510.8 159.8 487.6 159.4"/><path class="s b" d="M488.4 159.4Q489.3 129.8 487.0 100.3M487.4 160.2Q487.4 130.2 487.4 100.2"/><path class="h b" clip-path="url(#ccp4)" d="M491.4 163.2Q518.6 130.5 544.1 99.0M499.6 162.7Q525.1 129.1 551.1 98.3M505.8 161.8Q530.6 129.9 557.7 97.2M512.2 162.8Q538.6 130.0 563.7 97.8M520.7 161.4Q547.3 130.6 571.1 98.1M526.7 161.4Q552.2 129.4 577.3 96.9M532.0 162.2Q557.8 129.6 584.0 96.9M539.8 161.8Q566.4 130.0 593.0 99.0M546.1 161.0Q571.7 129.3 599.3 97.2M555.0 162.0Q579.5 129.0 607.3 97.9M559.9 161.1Q588.3 131.1 612.7 97.5M566.1 161.6Q594.1 130.8 618.7 98.1M574.7 162.4Q601.1 130.7 626.4 98.1M581.7 161.6Q607.9 130.2 633.4 98.8M586.5 162.2Q613.3 130.2 640.6 96.9"/><path class="s b" d="M543.8 100.0Q566.9 101.6 589.1 99.4M543.0 100.1Q566.6 99.0 589.6 99.6"/><path class="s b" d="M590.5 100.0Q589.8 130.2 590.2 160.3M590.0 99.8Q591.1 130.1 589.8 159.8"/><path class="s b" d="M589.2 160.2Q567.0 161.6 544.7 160.7M589.4 160.1Q566.7 161.1 544.4 159.4"/><path class="s b" d="M544.9 160.6Q545.1 130.1 544.9 99.5M544.5 159.3Q545.1 129.6 544.5 100.5"/><path class="h b" clip-path="url(#ccp5)" d="M548.4 163.1Q574.2 130.0 601.1 97.4M554.1 161.4Q581.9 130.6 607.0 97.5M560.1 162.9Q587.1 129.7 612.0 96.9M568.3 161.7Q594.6 130.5 620.3 97.2M575.6 162.5Q601.4 129.9 628.2 98.7M581.5 162.3Q607.9 130.1 632.9 97.3M588.1 161.5Q614.8 130.3 640.7 98.4M595.1 163.1Q622.1 131.0 647.6 96.9M601.6 163.2Q627.6 129.3 655.8 97.1M609.8 161.7Q635.0 130.2 660.4 98.2M616.8 160.9Q642.7 130.3 669.3 96.9M623.7 162.5Q651.3 130.2 677.7 97.3M631.9 162.6Q656.6 129.2 682.7 98.8M637.3 161.2Q662.9 128.9 689.6 98.9M644.3 161.8Q672.4 130.6 697.5 97.6"/><path class="s b" d="M599.8 99.3Q622.9 101.3 646.8 99.1M599.4 101.0Q623.2 99.1 646.6 99.2"/><path class="s b" d="M645.0 99.3Q645.4 130.2 646.3 159.3M645.3 100.6Q647.0 129.6 645.1 161.0"/><path class="s b" d="M646.3 159.1Q623.2 160.8 600.9 159.5M646.8 159.4Q623.4 160.4 599.1 159.6"/><path class="s b" d="M599.1 160.5Q600.1 130.3 600.3 99.5M599.3 160.2Q601.4 130.2 600.1 100.6"/><path class="h b" clip-path="url(#ccp6)" d="M604.5 160.9Q628.9 129.3 655.6 97.8M610.3 162.2Q635.4 129.8 663.1 97.7M616.6 162.2Q641.8 129.4 668.6 96.9M624.0 163.1Q649.8 128.5 676.6 99.1M632.9 160.9Q658.6 130.3 683.4 98.8M637.6 162.0Q666.3 131.2 690.7 98.4M646.0 161.4Q670.6 129.1 698.4 99.1M654.1 162.0Q678.6 129.0 706.3 99.0M659.6 161.5Q687.9 130.4 712.6 97.1M668.0 161.7Q693.1 129.5 719.3 99.1M675.6 161.2Q702.5 131.0 728.1 98.3M682.5 161.6Q709.3 130.8 733.9 98.4M690.1 162.8Q715.7 130.0 740.9 97.7M696.7 161.0Q723.7 130.3 749.6 98.7"/><path class="s b" d="M655.9 99.4Q679.1 99.1 701.7 99.8M656.0 99.1Q679.2 99.1 701.6 99.4"/><path class="s b" d="M701.7 99.2Q703.6 129.9 701.4 159.5M702.7 99.8Q702.4 130.2 702.9 159.1"/><path class="s b" d="M702.6 160.1Q678.9 161.4 655.7 159.3M701.3 159.4Q679.1 161.1 655.1 160.4"/><path class="s b" d="M655.3 159.1Q657.6 130.0 655.7 99.5M655.3 160.6Q656.0 130.2 655.9 101.0"/><path class="s r" d="M751.6 140.4Q748.0 141.6 746.1 141.6Q744.3 141.7 742.5 141.3Q740.7 140.9 738.9 140.2Q737.2 139.5 736.1 137.9Q735.1 136.3 734.3 134.6Q733.4 133.0 733.4 131.1Q733.4 129.3 733.6 127.4Q733.8 125.6 734.9 124.0Q735.9 122.5 737.2 121.1Q738.4 119.6 740.2 119.1Q742.0 118.6 743.9 118.2Q745.7 117.8 747.5 118.4Q749.3 119.0 751.0 119.8Q752.7 120.7 753.8 122.2Q754.9 123.7 755.7 125.4Q756.5 127.0 756.6 128.9Q756.6 130.7 756.4 132.5Q756.1 134.4 755.3 136.1Q754.5 137.8 753.0 139.0Q751.5 140.2 749.7 140.8"/><path class="s r" d="M755.3 123.6Q756.6 127.3 756.7 129.2Q756.7 131.1 756.4 133.1Q756.2 135.0 754.9 136.5Q753.7 138.0 752.2 139.4Q750.8 140.8 748.9 141.4Q747.0 141.9 745.1 141.9Q743.1 141.8 741.3 141.1Q739.5 140.5 737.8 139.4Q736.2 138.3 735.2 136.7Q734.2 135.0 733.8 133.1Q733.4 131.2 733.4 129.3Q733.5 127.4 734.1 125.5Q734.6 123.7 736.0 122.3Q737.4 120.9 739.1 120.0Q740.8 119.2 742.7 118.7Q744.5 118.2 746.4 118.5Q748.3 118.7 750.2 119.3Q752.1 119.9 753.3 121.5Q754.5 123.0 755.6 124.7Q756.7 126.3 756.9 128.3"/><text x="570" y="82" text-anchor="middle" class="m" style="font-size:16px">memory already in use</text><text x="745" y="160" text-anchor="middle" class="r" style="font-size:16px">more?</text><text x="570" y="200" text-anchor="middle" style="font-size:18px">full? something has to go</text><text x="570" y="228" text-anchor="middle" class="m" style="font-size:17px">the only way to free it is to remove it</text><text x="570" y="262" text-anchor="middle" class="r" style="font-size:19px">→ OOM kill or eviction</text></svg><figcaption>Almost everything in this post follows from this one difference.</figcaption></figure>

That's why:

- a CPU limit that's too low makes your app **slow**,
- a memory limit that's too low makes your app **crash**.

Almost everything in the rest of this series follows from this difference.

*Lab:* [06-cpu-waits-memory-kills](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood/tree/main/labs/06-cpu-waits-memory-kills). Check what you built with `make check LAB=06`.

> [!KEY]
> CPU can be delayed, so limits cause waiting (throttling). Memory can't be, so limits end in OOM kills.


---

### 7. So what is a container?

Now we can answer this properly. **The Linux kernel has no such thing as a "container".** No container object exists anywhere in the kernel. A container is an ordinary process with a few kernel features wrapped around it:

<figure class="sketch "><svg viewBox="0 0 760 330" role="img" aria-label="A container is a process plus namespaces, cgroups, a root filesystem and a few locks"><title>A container is a process plus namespaces, cgroups, a root filesystem and a few locks</title><defs><clipPath id="ccr1"><rect x="158" y="62" width="128" height="112"/></clipPath><clipPath id="ccr2"><rect x="316" y="62" width="128" height="112"/></clipPath><clipPath id="ccr3"><rect x="474" y="62" width="128" height="112"/></clipPath><clipPath id="ccr4"><rect x="632" y="62" width="128" height="112"/></clipPath></defs><text x="380" y="34" text-anchor="middle" class="big" style="font-size:30px">a container is…</text><path class="s" d="M1.3 62.8Q64.1 60.8 129.3 61.4M-1.2 62.5Q63.5 60.4 127.7 62.8"/><path class="s" d="M127.6 60.8Q126.8 117.7 128.4 173.2M129.2 63.2Q129.9 117.9 128.4 173.3"/><path class="s" d="M128.0 173.5Q63.7 175.7 -1.3 173.6M127.5 173.8Q63.6 174.2 -0.0 174.2"/><path class="s" d="M-0.5 173.3Q1.2 117.6 0.2 61.9M0.3 174.3Q-1.2 118.3 0.5 62.9"/><text x="64.0" y="96" text-anchor="middle" class="big" style="font-size:21px">a process</text><text x="64.0" y="128" text-anchor="middle" style="font-size:17px">ordinary, on the</text><text x="64.0" y="150" text-anchor="middle" style="font-size:17px">host's kernel</text><path class="s m" d="M135.2 118.0Q142.9 117.1 151.0 117.8M135.0 118.0Q143.2 117.7 150.6 118.1"/><path class="s m" d="M143.0 110.4Q143.6 117.9 142.8 126.0M143.0 110.6Q143.3 118.2 142.9 125.9"/><path class="h a" clip-path="url(#ccr1)" d="M60.1 174.8Q109.7 118.5 157.8 59.0M71.6 176.1Q120.3 118.6 168.1 59.9M81.3 176.6Q129.3 117.1 179.1 59.5M93.8 175.4Q140.5 116.6 191.9 59.1M103.5 176.6Q153.1 117.7 202.4 60.2M115.2 176.8Q164.4 117.7 212.4 59.0M127.2 175.9Q176.1 118.3 224.1 59.1M139.3 176.4Q187.8 118.7 237.4 60.0M148.4 176.4Q196.6 116.5 246.8 60.6M159.5 177.2Q208.6 117.1 256.6 60.8M172.1 174.9Q220.4 118.3 268.1 60.7M183.0 176.2Q232.0 118.2 280.8 59.4M193.3 175.0Q241.2 117.8 291.6 60.1M205.0 177.1Q254.2 118.4 303.0 61.1M216.2 176.6Q264.7 118.2 314.2 61.0M226.8 174.8Q275.3 118.2 324.8 60.1M238.0 176.4Q285.7 117.4 334.5 59.3M247.9 176.6Q295.8 117.7 345.6 60.2M259.2 175.5Q309.0 118.7 357.4 59.9M270.9 176.2Q318.8 118.0 367.0 59.2M282.1 175.9Q332.0 118.5 379.2 59.7"/><path class="s a" d="M157.2 62.8Q221.6 61.8 286.9 62.4M157.1 63.2Q222.0 61.6 287.1 60.8"/><path class="s a" d="M287.1 63.2Q286.8 118.4 285.8 174.1M286.1 63.0Q286.8 118.1 287.1 174.1"/><path class="s a" d="M285.9 174.4Q222.1 176.3 158.0 173.9M286.8 174.6Q221.7 174.3 156.8 173.3"/><path class="s a" d="M158.6 173.2Q155.8 117.5 158.4 62.9M157.0 175.3Q156.3 117.6 159.0 63.2"/><text x="222.0" y="96" text-anchor="middle" class="big" style="font-size:21px">namespaces</text><text x="222.0" y="128" text-anchor="middle" style="font-size:17px">what it can</text><text x="222.0" y="150" text-anchor="middle" style="font-size:17px">see</text><path class="s m" d="M292.5 118.2Q301.0 117.4 309.4 118.5M292.6 118.0Q300.9 118.8 308.5 117.5"/><path class="s m" d="M301.1 109.6Q301.7 118.1 300.7 125.8M301.3 110.2Q301.6 118.2 300.5 126.0"/><path class="h r" clip-path="url(#ccr2)" d="M218.3 176.3Q268.5 118.4 315.2 60.2M229.3 176.2Q278.1 118.7 327.3 60.4M238.6 176.8Q287.2 117.3 336.4 59.2M249.2 176.3Q298.4 117.9 345.8 60.6M262.0 177.0Q309.1 117.8 359.0 60.5M273.8 175.4Q321.3 117.8 370.7 58.9M282.7 177.1Q332.8 119.0 381.8 61.1M293.7 176.2Q344.4 119.3 393.1 60.6M306.8 175.2Q356.4 119.1 402.9 60.5M318.3 175.9Q366.0 117.6 414.6 59.3M328.2 175.7Q378.1 118.5 426.9 60.1M339.7 175.9Q387.7 117.5 438.2 60.2M350.1 176.1Q399.4 118.2 448.1 59.1M361.7 176.7Q411.4 119.0 459.9 60.4M371.7 175.1Q420.6 116.8 471.0 59.4M383.5 177.1Q432.5 118.3 479.3 61.1M393.9 176.6Q443.7 118.5 491.5 60.6M405.1 176.1Q455.0 118.6 503.3 60.2M416.2 175.1Q465.6 118.8 511.7 60.9M427.6 174.9Q475.5 117.9 523.7 60.6M437.6 175.3Q485.5 116.9 534.4 60.9"/><path class="s r" d="M316.1 63.0Q379.7 61.8 444.1 61.8M316.4 62.0Q380.3 63.1 444.0 61.3"/><path class="s r" d="M443.6 62.0Q445.6 118.0 443.2 172.9M444.8 61.5Q444.9 118.0 444.5 173.4"/><path class="s r" d="M443.7 174.2Q380.2 171.9 315.1 174.4M444.4 173.2Q380.3 172.0 316.8 173.7"/><path class="s r" d="M316.9 173.3Q315.7 118.2 317.1 61.3M315.1 172.7Q314.4 118.4 315.5 60.8"/><text x="380.0" y="96" text-anchor="middle" class="big" style="font-size:21px">cgroups</text><text x="380.0" y="128" text-anchor="middle" style="font-size:17px">how much it</text><text x="380.0" y="150" text-anchor="middle" style="font-size:17px">can use</text><path class="s m" d="M451.1 117.8Q458.9 118.5 466.5 117.4M451.1 118.5Q459.0 118.1 466.9 118.4"/><path class="s m" d="M459.0 110.4Q459.8 118.0 458.5 126.1M459.5 109.8Q459.0 117.9 459.1 125.7"/><path class="h g" clip-path="url(#ccr3)" d="M377.8 175.2Q424.1 116.7 473.3 59.9M388.1 175.5Q434.9 117.1 485.4 60.4M398.9 176.7Q447.0 116.8 496.5 61.1M409.6 176.5Q458.2 116.7 508.8 59.2M422.5 176.9Q472.2 118.8 520.6 59.6M434.7 176.9Q482.1 117.5 530.5 60.4M445.5 176.5Q494.7 118.7 541.6 60.4M457.7 175.4Q506.5 118.8 554.2 60.6M467.7 177.0Q517.2 117.9 565.0 60.9M479.2 175.5Q529.3 117.6 577.1 60.0M491.0 176.1Q541.3 118.4 589.3 59.6M501.9 175.1Q551.1 117.8 600.7 59.6M514.0 176.2Q562.5 117.8 612.9 59.0M525.3 175.6Q575.7 119.1 623.0 60.4M536.2 175.9Q584.1 117.3 634.0 60.7M547.5 176.1Q596.7 118.9 645.5 60.0M558.3 176.1Q606.8 118.1 654.6 59.8M567.4 176.2Q616.9 118.0 665.8 60.5M578.5 176.3Q627.3 117.4 675.7 59.1M591.8 177.2Q639.9 118.3 687.4 60.0M600.4 175.6Q649.6 117.8 699.7 61.0"/><path class="s g" d="M474.3 62.9Q538.2 62.3 603.2 61.1M474.7 63.0Q538.1 60.4 601.3 61.0"/><path class="s g" d="M602.2 62.1Q602.7 118.2 603.3 173.2M601.2 63.3Q600.5 117.9 603.1 173.2"/><path class="s g" d="M602.5 175.0Q538.0 173.1 473.1 174.7M601.0 173.9Q537.6 174.7 474.2 174.4"/><path class="s g" d="M474.1 173.8Q473.5 118.4 472.8 61.2M473.9 173.8Q475.9 118.1 473.4 63.0"/><text x="538.0" y="96" text-anchor="middle" class="big" style="font-size:21px">the image</text><text x="538.0" y="128" text-anchor="middle" style="font-size:17px">its own root</text><text x="538.0" y="150" text-anchor="middle" style="font-size:17px">filesystem</text><path class="s m" d="M609.1 118.1Q616.8 117.1 625.4 118.2M609.1 118.1Q617.1 118.0 625.4 118.4"/><path class="s m" d="M617.5 110.0Q616.2 118.1 616.8 126.4M617.2 109.8Q616.6 118.2 616.4 126.5"/><path class="h y" clip-path="url(#ccr4)" d="M534.0 175.9Q582.7 117.4 632.4 59.6M545.3 177.0Q594.5 118.0 642.3 60.5M557.3 174.9Q607.4 118.8 655.8 60.8M568.6 176.1Q617.8 118.1 665.7 59.1M579.3 175.8Q629.8 118.7 677.9 60.9M590.7 175.9Q641.2 119.0 688.5 58.9M601.1 176.0Q651.2 118.6 698.7 60.9M613.3 176.4Q661.6 118.6 708.9 60.4M625.3 176.8Q674.8 118.8 721.9 59.6M636.4 175.6Q685.0 118.9 733.6 58.9M645.2 176.5Q696.1 118.8 744.1 59.9M656.9 176.5Q705.9 117.1 753.7 59.9M669.2 176.5Q717.2 118.2 766.3 60.2M679.8 176.3Q728.3 118.1 776.9 60.5M689.5 175.5Q738.6 118.0 787.3 60.1M702.5 175.5Q751.7 118.7 798.9 59.9M711.1 176.2Q760.7 117.3 810.3 60.8M722.1 176.6Q771.4 118.8 819.4 59.5M732.5 176.4Q781.9 118.8 828.9 60.0M744.6 176.4Q791.5 116.9 841.0 60.5M753.9 175.8Q803.6 117.3 852.3 59.1"/><path class="s y" d="M633.0 60.7Q696.4 62.4 760.6 62.4M632.7 61.7Q696.3 60.6 760.3 61.2"/><path class="s y" d="M759.4 61.0Q762.1 118.0 758.9 173.7M760.5 61.7Q761.4 118.0 761.1 173.9"/><path class="s y" d="M760.8 173.3Q696.1 173.9 631.5 174.0M760.7 173.6Q696.5 172.5 631.3 175.0"/><path class="s y" d="M631.8 173.0Q633.3 117.6 631.8 63.0M632.9 173.4Q630.5 117.8 631.8 61.2"/><text x="696.0" y="96" text-anchor="middle" class="big" style="font-size:21px">a few locks</text><text x="696.0" y="128" text-anchor="middle" style="font-size:17px">capabilities,</text><text x="696.0" y="150" text-anchor="middle" style="font-size:17px">seccomp</text><path class="s m" d="M51.0 250.8Q379.8 251.6 709.3 250.4M49.6 250.1Q380.3 251.5 709.9 250.6"/><path class="s b" d="M52.3 243.6Q54.4 244.4 55.1 245.2Q55.9 246.0 56.3 247.0Q56.8 248.0 56.9 249.1Q57.1 250.2 56.8 251.3Q56.4 252.3 56.0 253.3Q55.5 254.3 54.7 255.0Q53.9 255.8 52.9 256.2Q52.0 256.7 50.9 256.8Q49.8 257.0 48.7 256.7Q47.7 256.5 46.6 256.1Q45.6 255.7 44.9 254.8Q44.3 253.9 43.7 253.0Q43.1 252.0 43.1 250.9Q43.1 249.8 43.2 248.7Q43.4 247.6 43.9 246.7Q44.4 245.7 45.3 245.0Q46.1 244.3 47.1 243.8Q48.1 243.4 49.1 243.1Q50.2 242.9 51.3 243.1Q52.4 243.4 53.3 243.9"/><path class="s b" d="M50.8 257.1Q48.5 256.9 47.4 256.5Q46.3 256.1 45.5 255.3Q44.7 254.5 44.1 253.5Q43.6 252.5 43.3 251.4Q43.1 250.3 43.3 249.2Q43.5 248.1 43.9 247.0Q44.3 246.0 45.1 245.2Q45.9 244.5 46.9 243.8Q47.9 243.2 49.0 243.2Q50.1 243.2 51.3 243.3Q52.4 243.4 53.4 243.9Q54.4 244.4 55.2 245.3Q55.9 246.2 56.3 247.3Q56.6 248.4 56.7 249.5Q56.9 250.6 56.6 251.7Q56.3 252.8 55.7 253.7Q55.0 254.6 54.3 255.5Q53.5 256.3 52.4 256.7Q51.3 257.1 50.1 257.1Q49.0 257.0 47.9 256.7"/><text x="50" y="232" text-anchor="middle" class="big" style="font-size:21px">1979</text><text x="50" y="282" text-anchor="middle" class="m" style="font-size:18px">chroot</text><path class="s b" d="M208.6 247.0Q209.8 245.3 210.7 244.6Q211.6 244.0 212.6 243.5Q213.6 242.9 214.7 243.1Q215.8 243.2 216.9 243.4Q217.9 243.6 218.9 244.1Q219.9 244.7 220.6 245.6Q221.3 246.4 221.6 247.5Q221.8 248.6 221.9 249.7Q222.0 250.8 221.7 251.9Q221.3 252.9 220.7 253.8Q220.0 254.6 219.3 255.4Q218.5 256.2 217.5 256.6Q216.4 257.0 215.3 257.0Q214.2 257.0 213.1 256.8Q212.0 256.5 211.1 255.8Q210.3 255.1 209.6 254.3Q209.0 253.4 208.5 252.4Q208.0 251.4 208.1 250.3Q208.2 249.2 208.4 248.1Q208.5 247.0 209.1 246.1"/><path class="s b" d="M211.6 255.9Q209.6 254.8 209.1 253.7Q208.5 252.7 208.2 251.6Q208.0 250.5 208.0 249.3Q208.1 248.2 208.6 247.1Q209.1 246.1 209.9 245.3Q210.8 244.5 211.7 243.9Q212.7 243.3 213.8 243.2Q215.0 243.2 216.1 243.2Q217.3 243.2 218.3 243.7Q219.3 244.3 220.0 245.3Q220.6 246.2 221.1 247.2Q221.7 248.2 221.9 249.3Q222.1 250.4 221.8 251.5Q221.5 252.6 221.0 253.7Q220.4 254.7 219.5 255.3Q218.5 256.0 217.4 256.3Q216.4 256.7 215.3 256.8Q214.2 256.8 213.1 256.5Q212.0 256.3 211.1 255.6Q210.2 254.9 209.5 254.0"/><text x="215" y="232" text-anchor="middle" class="big" style="font-size:21px">2000</text><text x="215" y="282" text-anchor="middle" class="m" style="font-size:18px">FreeBSD jails</text><path class="s b" d="M372.9 251.0Q373.1 248.8 373.5 247.8Q373.9 246.8 374.5 245.9Q375.1 245.0 376.0 244.2Q376.8 243.5 377.9 243.3Q379.0 243.0 380.1 243.2Q381.2 243.3 382.2 243.6Q383.3 243.8 384.2 244.4Q385.1 245.0 385.6 246.0Q386.1 247.0 386.4 248.0Q386.7 249.0 386.9 250.1Q387.1 251.2 386.5 252.2Q386.0 253.2 385.5 254.1Q384.9 255.1 384.0 255.6Q383.0 256.2 382.0 256.5Q381.0 256.8 379.9 256.9Q378.8 256.9 377.8 256.5Q376.8 256.1 375.9 255.4Q375.1 254.7 374.4 253.9Q373.7 253.1 373.5 252.0Q373.3 251.0 373.2 249.9"/><path class="s b" d="M386.7 248.8Q387.2 251.1 386.7 252.1Q386.2 253.2 385.5 254.2Q384.9 255.1 383.9 255.7Q382.9 256.2 381.9 256.6Q380.8 257.0 379.7 256.9Q378.5 256.9 377.5 256.4Q376.5 255.9 375.5 255.3Q374.5 254.7 374.0 253.6Q373.5 252.6 373.2 251.5Q372.8 250.4 373.0 249.2Q373.2 248.1 373.6 247.0Q374.0 245.9 374.9 245.2Q375.8 244.4 376.8 243.8Q377.8 243.1 378.9 243.0Q380.1 242.9 381.2 243.1Q382.4 243.2 383.3 243.9Q384.2 244.6 385.1 245.4Q386.0 246.1 386.5 247.1Q387.0 248.2 387.0 249.4Q387.1 250.5 386.8 251.7"/><text x="380" y="232" text-anchor="middle" class="big" style="font-size:21px">2002</text><text x="380" y="282" text-anchor="middle" class="m" style="font-size:18px">first Linux namespace</text><path class="s b" d="M538.5 252.1Q537.9 250.0 538.2 248.9Q538.5 247.9 538.9 246.9Q539.4 245.9 540.2 245.2Q541.0 244.5 541.9 243.9Q542.9 243.4 543.9 243.3Q545.0 243.2 546.1 243.4Q547.1 243.6 548.1 244.0Q549.0 244.5 549.9 245.1Q550.8 245.8 551.3 246.8Q551.7 247.8 551.9 248.9Q552.2 250.0 552.0 251.1Q551.9 252.2 551.4 253.2Q550.8 254.3 550.0 255.0Q549.2 255.7 548.2 256.3Q547.2 256.9 546.1 257.0Q545.0 257.2 543.9 256.8Q542.9 256.5 541.8 256.1Q540.8 255.8 540.0 255.0Q539.2 254.2 538.9 253.1Q538.5 252.1 538.2 251.0"/><path class="s b" d="M542.8 256.5Q540.9 255.4 540.1 254.6Q539.4 253.8 538.8 252.8Q538.3 251.8 538.0 250.7Q537.8 249.6 538.1 248.5Q538.4 247.3 539.1 246.4Q539.7 245.5 540.6 244.7Q541.4 243.9 542.5 243.6Q543.6 243.3 544.7 243.2Q545.8 243.2 547.0 243.3Q548.1 243.5 549.0 244.2Q549.9 244.9 550.5 245.9Q551.1 246.9 551.5 248.0Q552.0 249.0 551.9 250.1Q551.9 251.3 551.5 252.4Q551.2 253.5 550.4 254.3Q549.5 255.0 548.6 255.7Q547.7 256.3 546.6 256.6Q545.6 256.9 544.4 256.7Q543.3 256.6 542.3 256.2Q541.2 255.9 540.4 255.1"/><text x="545" y="232" text-anchor="middle" class="big" style="font-size:21px">2008</text><text x="545" y="282" text-anchor="middle" class="m" style="font-size:18px">cgroups in Linux</text><path class="s b" d="M705.1 244.7Q707.1 243.7 708.2 243.4Q709.2 243.2 710.3 243.1Q711.4 243.0 712.5 243.4Q713.5 243.8 714.3 244.5Q715.2 245.3 715.7 246.2Q716.3 247.1 716.7 248.2Q717.1 249.2 716.9 250.3Q716.7 251.4 716.4 252.4Q716.0 253.4 715.4 254.3Q714.7 255.2 713.8 255.8Q712.9 256.3 711.8 256.6Q710.8 256.9 709.7 256.8Q708.6 256.7 707.5 256.5Q706.5 256.2 705.6 255.5Q704.8 254.8 704.2 253.8Q703.5 252.9 703.2 251.9Q702.8 250.8 703.1 249.7Q703.3 248.6 703.6 247.6Q703.9 246.6 704.6 245.7Q705.3 244.9 706.3 244.3"/><path class="s b" d="M705.7 255.4Q704.2 253.8 703.8 252.7Q703.4 251.7 703.1 250.6Q702.9 249.5 703.1 248.3Q703.4 247.2 704.0 246.2Q704.7 245.3 705.6 244.6Q706.5 243.9 707.6 243.5Q708.7 243.1 709.8 243.1Q711.0 243.1 712.1 243.4Q713.2 243.6 714.2 244.3Q715.1 244.9 715.7 246.0Q716.2 247.0 716.5 248.1Q716.9 249.1 716.9 250.3Q716.9 251.4 716.5 252.5Q716.2 253.6 715.4 254.5Q714.7 255.3 713.7 256.0Q712.8 256.7 711.6 256.9Q710.4 257.0 709.3 256.9Q708.2 256.7 707.2 256.2Q706.2 255.7 705.4 254.9Q704.6 254.2 703.9 253.2"/><text x="710" y="232" text-anchor="middle" class="big" style="font-size:21px">2013</text><text x="710" y="282" text-anchor="middle" class="m" style="font-size:18px">Docker</text></svg><figcaption>Nothing here is new, and none of it is called "container" in the kernel. Docker made it easy to put the pieces together.</figcaption></figure>

| Piece | What it gives the process |
|---|---|
| **A process** | Your app itself. It runs on the same kernel as everything else on the machine. Unlike a virtual machine, there's no second kernel |
| **Namespaces** | What it can **see**: its own process list (so the main one is PID 1), its own network, its own hostname |
| **cgroups** | How much it can **use**: `cpu.max`, `memory.max`, `pids.max` |
| **The image** | Its own root filesystem. The image's layers are stacked into one folder (with *overlayfs*), and the process's `/` is switched to it, so it never sees the host's disk |
| **A few locks** | Limits on what it may **do**, even as root. *Capabilities* split root's powers into about 40 pieces, and Docker keeps only 14 of them by default. *Seccomp* blocks system calls the app shouldn't need. Docker turns it on by default; Kubernetes only does when you set `seccompProfile: RuntimeDefault` |

None of these pieces is new. `chroot`, which gives a process a different `/`, dates from Unix in 1979. FreeBSD's *jails* put a fence around a group of processes in 2000. Linux got its first namespace, for mounts, in 2002, and cgroups in 2008, built at Google under the name "process containers". What Docker added in 2013 was packaging: an image format and one command that puts all five together.

That job, putting the pieces together and starting your process, belongs to the **container runtime** (containerd, CRI-O, or Docker's own stack). In Kubernetes, the kubelet tells the runtime what to create, including the numbers from your `resources:` block. [Chapter 10](#10-follow-one-pod-down-to-the-kernel) follows those numbers all the way to the files.

This series is about one of the five pieces: **cgroups**. Namespaces show up only where they change what you see, as in the next section.

#### Why `/sys/fs/cgroup` looked so small

Earlier, `cat /proc/self/cgroup` printed `0::/`, as if we were at the top of the tree, and `ls /sys/fs/cgroup` showed only one group's files. That's a namespace at work: the **cgroup namespace**.

On the host machine, our container's cgroup is a folder deep in the tree, something like:

```
/sys/fs/cgroup/system.slice/docker-3f9a…e1.scope/cpu.max
```

The cgroup namespace makes that folder **look like the top** from inside the container. So `/sys/fs/cgroup/cpu.max` inside the container and that long path on the host are **the same file**. The namespace only changes the view. The limit is the same.

<figure class="sketch "><svg viewBox="0 0 760 290" role="img" aria-label="A cgroup namespace shortens the paths a process sees"><title>A cgroup namespace shortens the paths a process sees</title><text x="20" y="34" text-anchor="start" style="font-size:21px">the same container cgroup, seen from two places</text><path class="s b" d="M19.9 55.4Q380.2 52.9 740.7 54.9M19.7 55.8Q379.5 54.9 740.1 55.6"/><path class="s b" d="M740.8 54.7Q739.9 105.3 739.0 155.0M740.0 55.2Q740.3 105.1 739.7 153.9"/><path class="s b" d="M739.5 155.9Q380.4 157.0 20.1 154.0M740.4 154.0Q380.1 154.0 20.3 155.7"/><path class="s b" d="M20.5 154.2Q21.4 105.0 20.8 55.7M19.2 155.3Q18.4 104.9 21.1 55.1"/><text x="36" y="82" text-anchor="start" class="m" style="font-size:17px">on the node (docker exec under-the-hood-worker …)</text><text x="36" y="110" text-anchor="start" class="code">/sys/fs/cgroup/kubelet.slice/kubelet-kubepods.slice/</text><text x="36" y="134" text-anchor="start" class="code">   …-burstable.slice/…-pod&lt;uid&gt;.slice/cri-containerd-&lt;id&gt;.scope/cpu.max</text><path class="s a" d="M21.1 190.5Q380.0 188.8 738.9 191.1M19.0 190.4Q379.6 190.0 739.2 190.7"/><path class="s a" d="M738.9 188.8Q741.5 227.4 741.0 266.1M741.0 190.9Q741.7 228.0 739.6 265.5"/><path class="s a" d="M740.8 265.9Q380.4 265.2 19.7 265.5M739.8 265.4Q379.7 267.0 20.2 264.4"/><path class="s a" d="M19.6 264.2Q20.7 227.3 19.2 190.8M21.1 264.3Q21.2 227.7 19.3 189.3"/><text x="36" y="216" text-anchor="start" class="m" style="font-size:17px">inside the container (kubectl exec &lt;pod&gt; …)</text><text x="36" y="244" text-anchor="start" class="code">/sys/fs/cgroup/cpu.max</text><path class="s" d="M599.9 156.6Q601.0 171.6 598.5 186.1M601.2 159.4Q599.7 172.5 600.3 185.2"/><path class="s" d="M599.2 186.3Q597.0 181.2 594.6 176.3M599.8 185.7Q596.9 181.1 594.8 175.5"/><path class="s" d="M599.3 185.6Q602.7 180.9 605.1 175.7M599.4 185.6Q602.4 181.3 605.2 176.1"/><text x="612" y="178" text-anchor="start" style="font-size:17px">same file</text></svg><figcaption>A cgroup namespace changes the paths a process sees; it doesn't set the resource limit.</figcaption></figure>

*Lab:* [07-what-is-a-container](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood/tree/main/labs/07-what-is-a-container). Check what you built with `make check LAB=07`.

> [!KEY]
> A container is ordinary processes with namespaces (what they see) and cgroups (what they get). Inside one, `/sys/fs/cgroup` shows only its own cgroup.

#### Where we are

You now know enough to follow everything else:

- Programs run as **threads**, and the **kernel** hands out CPU and memory.
- Linux shows the kernel's settings as **files**: `/proc` for processes, `/sys` for settings.
- **`/sys/fs/cgroup`** holds the limits: `cpu.max`, `cpu.weight`, `memory.max`, and `cgroup.procs` for who they apply to.
- **CPU** limits cause waiting. **Memory** limits cause kills.
- A **container** is processes inside namespaces and cgroups.

So far we've only *read* these files. In the next section we write them.

---

## Hands on

### Set up the lab (5 minutes)

You need Docker Desktop (give it at least 4 CPUs and 6 GB of memory), plus `kind` and `kubectl`.

```bash
brew install kind kubectl          # on Windows, use WSL2: see the repo README
git clone https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood
cd kubernetes-resources-under-the-hood
make check-setup                   # is everything ready? every ✗ comes with its fix
make cluster                       # a 2-node cluster inside Docker, plus the lab's own small image
```

The labs for chapters 1 to 7 need only Docker, so you can start those before creating the cluster. `make cluster` also builds `lab-tools`, a small image with readable commands the labs use: `burn --threads 4` for busy loops, `alloc` for memory that's never freed, `cache` for file cache, and `serve` and `load`, a tiny web service and a load generator.

On Windows, run the same commands inside an Ubuntu terminal on WSL2. The [repo README](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood) has the one extra setting WSL2 needs for cgroups v2.

**What you get.** [kind](https://kind.sigs.k8s.io/) ("Kubernetes in Docker") runs each Kubernetes node as a Docker container. `make cluster` creates a cluster called `under-the-hood` with two nodes:

- `under-the-hood-control-plane` runs the API server, the scheduler and the other control-plane parts.
- `under-the-hood-worker` is where every lab pod runs.

Because a kind node is just a Docker container, it has its own real cgroup tree and a real kubelet, the same pieces you'd find on a GKE or EKS node.

**Two ways to look inside.** You'll use these two commands all the time:

- `kubectl exec <pod> -- <command>` runs a command **inside a container**. It sees only its own cgroup (chapter 7), so `kubectl exec <pod> -- cat /sys/fs/cgroup/cpu.max` shows exactly that container's CPU limit.
- `docker exec under-the-hood-worker <command>` runs a command **on the node**. From there you see the whole tree, including the folders for pods and QoS classes. On a real cluster this is the same as SSH-ing into the node.

Every chapter has a **Try it yourself** section with the exact commands and my output, and a **Lab** link to the matching folder in the repo, numbered like the chapters. Each lab's README walks through the same steps, and `make check LAB=<number>` tells you whether what you built behaves as described. (Chapters 1 to 7 are labs 01 to 07, which need only Docker.)

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

```
cgroup.controllers
cgroup.events
…
cpu.max
cpu.stat
cpu.weight
…
memory.max
…
pids.max
…
```

A folder already full of files, 85 of them on my machine (trimmed above). You never create these yourself; the kernel adds them the moment the folder exists.

**Step 2: set a dial.** Allow 20 ms of CPU in every 100 ms, a fifth of one CPU:

```bash
docker exec under-the-hood-worker sh -c 'echo "20000 100000" > /sys/fs/cgroup/lab-cpu/cpu.max'
```

**Step 3: put a process in.** Start a shell that moves itself into the box (`$$` is the shell's own PID), then spins forever:

```bash
docker exec -d under-the-hood-worker sh -c \
  'echo $$ > /sys/fs/cgroup/lab-cpu/cgroup.procs; while :; do :; done'
docker exec under-the-hood-worker cat /sys/fs/cgroup/lab-cpu/cgroup.procs
```

```
1074
```

That's the shell's PID on the node (yours will differ), now inside the box.

**Writing a PID into `cgroup.procs` is how a process joins a cgroup.** There's no other way, and it's exactly what a container runtime does for every container it starts.

<details class="predict"><summary><span class="predict-tag">Predict first</span> The loop wants a whole CPU, and the box allows a fifth. Does the kernel slow it down or kill it?</summary><div class="predict-answer"><p>It slows it down. CPU is time, so the kernel makes the loop wait (chapter 6). Nothing is killed.</p></div></details>

**Step 4: watch the kernel enforce it.** `cpu.stat` keeps running totals. Read it, wait five seconds, read it again:

```bash
docker exec under-the-hood-worker grep -E 'usage_usec|nr_throttled' /sys/fs/cgroup/lab-cpu/cpu.stat
sleep 5
docker exec under-the-hood-worker grep -E 'usage_usec|nr_throttled' /sys/fs/cgroup/lab-cpu/cpu.stat
```

```
usage_usec 240916
nr_throttled 11
usage_usec 1243692
nr_throttled 62
```

`usage_usec` (CPU time used, in microseconds) went up by 1,002,776: one second of CPU in five seconds, so 20%. `nr_throttled` went up by 51: the loop hit its limit in every 100 ms window. It wants a whole CPU; the kernel gives it a fifth.

Now change the dial while it runs:

```bash
docker exec under-the-hood-worker sh -c 'echo "50000 100000" > /sys/fs/cgroup/lab-cpu/cpu.max'
sleep 5
docker exec under-the-hood-worker grep usage_usec /sys/fs/cgroup/lab-cpu/cpu.stat
```

```
usage_usec 3810766
```

That's 2,567,074 more in about five seconds: half a CPU. No restart, no API call. The kernel just reads the new number.

Hold on to that. In [chapter 21](/blog/cgroups-deep-dive-kubernetes-part-3/#21-finale-resize-a-running-pod) you'll do the same thing to a running Kubernetes pod with one `kubectl` command, and its container won't restart either, for exactly this reason.

<details class="predict"><summary><span class="predict-tag">Predict first</span> Same idea for memory: a 50 MiB box and a program that keeps growing. Will the kernel just slow it down too?</summary><div class="predict-answer"><p>No. Memory is space, not time. Once reclaim can't free enough, the kernel kills the process (chapter 6).</p></div></details>

**And memory?** Make a second box with a 50 MiB limit, and run a shell that keeps doubling a string, so its memory doubles every step:

```bash
docker exec under-the-hood-worker sh -c 'mkdir /sys/fs/cgroup/lab-mem && echo 50M > /sys/fs/cgroup/lab-mem/memory.max'
docker exec under-the-hood-worker sh -c 'echo 0 > /sys/fs/cgroup/lab-mem/memory.swap.max' 2>/dev/null
docker exec under-the-hood-worker sh -c 'echo $$ > /sys/fs/cgroup/lab-mem/cgroup.procs; a=x; while :; do a=$a$a; done'
echo "exit code: $?"
docker exec under-the-hood-worker cat /sys/fs/cgroup/lab-mem/memory.events
```

```
exit code: 137
low 0
high 0
max 35
oom 1
oom_kill 1
oom_group_kill 0
```

(The `memory.swap.max` line stops the kernel from dodging the limit by moving memory to disk.) In about a second the shell is gone, with exit code 137. `memory.events` tells the story: the limit was hit 35 times (`max`), reclaim couldn't free enough once (`oom`), and the kernel killed the process (`oom_kill`). That's an OOM kill, with no Kubernetes anywhere.

Clean up with `kill` and `rmdir` (a cgroup is removed like an empty folder):

```bash
docker exec under-the-hood-worker sh -c 'kill -9 $(cat /sys/fs/cgroup/lab-cpu/cgroup.procs); sleep 1; rmdir /sys/fs/cgroup/lab-cpu /sys/fs/cgroup/lab-mem'
```


*Lab:* [08-build-a-cgroup-by-hand](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood/tree/main/labs/08-build-a-cgroup-by-hand). Check what you built with `make check LAB=08`.

> [!KEY]
> A cgroup is a folder. Its files are dials the kernel enforces, and a process joins it by writing its PID into `cgroup.procs`.


---

## From YAML to kernel

In chapter 8 you made a cgroup with `mkdir`, set its limits with `echo`, and moved a process in by writing its PID to `cgroup.procs`. Kubernetes does exactly that for every container on every node, and nobody types a command. Your YAML just has to get past four checkpoints first.

Kubernetes never touches your running process. It never slows your app down and never kills it. It decides and translates: it takes your YAML, passes your numbers down a short chain of programs, and writes them into files on the node, the same files you just wrote by hand. Everything after that, the throttling and the OOM kills, is the Linux kernel reading those files.

### 9. The journey of your YAML

<a id="9-the-four-checkpoints"></a>

*Question: what happens to your `resources:` block between `kubectl apply` and a running process?*

Between `kubectl apply` and your app running, your pod passes four checkpoints. Each one reads a different part of your YAML, makes one decision and, when the answer is no, fails in its own recognisable way:

<figure class="sketch "><svg viewBox="0 0 760 530" role="img" aria-label="Four checkpoints: what each reads, what it does, and how it says no"><title>Four checkpoints: what each reads, what it does, and how it says no</title><defs><clipPath id="ckp1"><rect x="12" y="74" width="164" height="52"/></clipPath><clipPath id="ckp2"><rect x="196" y="74" width="164" height="52"/></clipPath><clipPath id="ckp3"><rect x="400" y="74" width="164" height="52"/></clipPath><clipPath id="ckp4"><rect x="584" y="74" width="164" height="52"/></clipPath></defs><path class="s m" d="M9.8 57.4Q15.0 59.0 19.8 57.5"/><path class="s m" d="M27.1 57.4Q31.8 56.8 37.2 57.8"/><path class="s m" d="M44.2 58.4Q49.1 59.1 54.7 58.8"/><path class="s m" d="M60.5 58.4Q65.9 57.1 71.7 57.3"/><path class="s m" d="M77.3 58.6Q83.3 57.0 87.7 57.2"/><path class="s m" d="M94.7 58.5Q99.8 58.1 105.7 58.7"/><path class="s m" d="M112.1 58.2Q117.3 58.1 122.3 58.7"/><path class="s m" d="M129.2 58.0Q134.3 57.6 138.7 58.7"/><path class="s m" d="M146.2 57.9Q150.7 58.1 155.2 57.9"/><path class="s m" d="M162.7 58.8Q168.3 58.9 173.3 58.1"/><path class="s m" d="M179.3 58.3Q185.1 56.8 189.3 58.8"/><path class="s m" d="M196.6 58.7Q201.7 57.2 206.9 57.7"/><path class="s m" d="M213.3 58.3Q218.9 57.8 224.0 57.2"/><path class="s m" d="M230.7 58.7Q236.0 59.2 240.8 57.2"/><path class="s m" d="M247.7 58.8Q253.1 59.2 257.3 57.7"/><path class="s m" d="M265.0 58.0Q270.0 57.4 275.2 57.5"/><path class="s m" d="M282.4 58.4Q286.8 59.1 291.4 57.9"/><path class="s m" d="M299.3 58.0Q303.9 57.8 308.8 58.3"/><path class="s m" d="M316.4 57.6Q321.0 57.8 325.2 57.7"/><path class="s m" d="M333.0 57.5Q337.7 57.7 343.1 57.5"/><path class="s m" d="M349.6 58.6Q354.8 58.5 360.6 57.3"/><path class="s m" d="M394.7 57.5Q398.8 59.3 404.3 57.4"/><path class="s m" d="M410.8 57.6Q415.9 59.3 420.4 57.5"/><path class="s m" d="M428.4 58.8Q432.8 58.9 437.9 57.7"/><path class="s m" d="M445.2 57.8Q449.9 58.5 455.8 57.8"/><path class="s m" d="M461.4 58.5Q466.8 58.3 472.4 58.5"/><path class="s m" d="M479.8 57.4Q483.7 58.9 489.0 58.1"/><path class="s m" d="M496.1 58.6Q501.2 58.7 506.2 57.9"/><path class="s m" d="M512.8 58.2Q518.1 57.9 522.2 57.3"/><path class="s m" d="M530.5 58.1Q534.7 58.3 540.7 57.9"/><path class="s m" d="M547.2 57.6Q552.0 57.1 556.5 57.3"/><path class="s m" d="M563.8 57.5Q569.3 56.9 574.6 58.0"/><path class="s m" d="M581.4 58.4Q585.9 57.6 590.7 57.9"/><path class="s m" d="M597.3 57.8Q603.3 57.4 608.5 57.2"/><path class="s m" d="M615.5 57.7Q620.0 57.7 624.7 57.3"/><path class="s m" d="M631.4 57.3Q636.9 58.2 642.4 58.2"/><path class="s m" d="M649.4 58.0Q653.8 58.2 659.7 57.6"/><path class="s m" d="M666.8 58.8Q670.7 58.9 676.4 57.9"/><path class="s m" d="M682.6 58.6Q687.9 58.0 693.5 58.6"/><path class="s m" d="M699.2 57.8Q704.9 58.2 709.5 57.9"/><path class="s m" d="M716.4 57.5Q721.7 57.6 726.2 57.6"/><path class="s m" d="M734.7 57.8Q738.7 57.7 744.5 58.7"/><text x="188" y="46" text-anchor="middle" class="m" style="font-size:19px">control plane</text><text x="572" y="46" text-anchor="middle" class="m" style="font-size:19px">your node</text><path class="s m" d="M380.7 29.6Q380.3 33.1 379.4 36.5"/><path class="s m" d="M380.8 44.2Q381.3 46.7 379.6 50.7"/><path class="s m" d="M380.8 57.5Q380.3 61.3 380.1 64.1"/><path class="s m" d="M380.2 72.3Q380.0 74.8 379.6 77.9"/><path class="s m" d="M379.3 86.5Q378.6 89.3 379.3 91.4"/><path class="s m" d="M379.4 100.6Q380.8 103.2 379.5 106.4"/><path class="s m" d="M380.0 114.3Q380.8 117.3 379.2 120.0"/><path class="s m" d="M380.5 128.2Q379.2 131.0 379.5 134.4"/><path class="s m" d="M380.0 141.5Q380.1 145.0 380.4 148.7"/><path class="s m" d="M379.4 155.9Q380.8 159.1 380.3 162.6"/><path class="s m" d="M380.1 169.8Q379.0 172.7 380.1 176.2"/><path class="s m" d="M380.5 183.6Q379.0 187.2 380.4 190.6"/><path class="s m" d="M379.3 197.4Q380.2 201.2 380.7 203.9"/><path class="s m" d="M380.0 211.7Q380.1 215.3 380.2 218.7"/><path class="s m" d="M379.9 226.4Q379.2 228.7 380.4 231.9"/><path class="s m" d="M380.1 239.5Q380.9 243.3 379.5 246.2"/><path class="s m" d="M379.5 254.2Q379.0 256.8 380.6 260.3"/><path class="s m" d="M379.4 268.4Q380.6 271.0 379.3 274.0"/><path class="s m" d="M380.3 281.5Q381.1 285.3 380.5 287.9"/><path class="s m" d="M380.6 295.8Q379.0 299.1 379.9 301.7"/><path class="s m" d="M380.6 309.9Q380.3 313.1 380.8 316.6"/><path class="s m" d="M379.6 324.2Q381.3 326.9 379.5 330.1"/><path class="s m" d="M380.1 338.7Q378.8 341.0 380.0 344.7"/><path class="s m" d="M380.5 352.4Q379.5 355.2 380.5 357.7"/><path class="s m" d="M380.6 366.6Q379.3 369.2 379.3 371.9"/><path class="s m" d="M380.2 379.8Q379.7 382.7 379.4 386.0"/><path class="s m" d="M380.0 394.1Q380.2 397.2 380.0 400.6"/><path class="s m" d="M380.7 407.4Q380.9 411.0 379.9 414.6"/><path class="s m" d="M380.6 422.7Q380.3 425.1 380.8 428.7"/><path class="s m" d="M379.4 436.5Q378.9 437.9 380.0 440.2"/><path class="h b" clip-path="url(#ckp1)" d="M-33.0 128.1Q-10.7 99.7 12.6 70.8M-22.4 128.6Q0.1 99.3 22.4 72.0M-12.1 129.0Q9.5 99.6 33.0 71.1M-1.2 128.5Q19.7 99.8 42.4 73.0M6.9 127.2Q28.8 98.5 52.8 71.2M16.9 128.8Q38.4 99.4 63.1 72.9M27.6 129.1Q47.8 99.5 71.6 72.3M37.8 129.1Q59.0 99.5 82.6 72.1M46.3 126.9Q68.4 99.1 91.4 71.8M58.5 128.3Q80.7 99.9 102.5 73.1M67.4 127.9Q90.4 100.7 111.8 71.6M76.5 127.9Q99.9 99.3 121.8 71.0M88.2 129.2Q110.2 99.6 134.3 72.6M99.4 128.0Q120.6 100.3 144.2 72.7M110.4 126.9Q132.0 100.4 154.2 71.8M119.8 129.1Q143.7 101.4 164.2 71.1M130.9 127.6Q154.1 100.5 174.8 71.1M138.4 128.7Q162.9 101.2 184.2 72.6M148.8 128.6Q171.8 99.8 194.3 72.5M159.7 128.5Q182.8 99.8 204.6 72.6M170.4 129.1Q192.9 101.4 215.5 72.9"/><path class="s b" d="M11.5 73.8Q93.7 75.4 177.0 75.1M12.9 74.5Q94.2 74.8 175.6 73.8"/><path class="s b" d="M175.2 73.7Q177.6 100.0 175.3 126.8M177.0 73.0Q175.4 99.8 175.4 126.5"/><path class="s b" d="M175.6 126.6Q94.2 123.9 11.3 126.6M176.4 126.7Q94.3 126.1 11.2 125.2"/><path class="s b" d="M11.1 124.9Q10.1 100.0 11.9 73.7M10.9 125.8Q13.9 100.2 10.8 73.0"/><text x="94.0" y="108" text-anchor="middle" class="big" style="font-size:22px">1. API server</text><text x="94.0" y="158" text-anchor="middle" class="m" style="font-size:16px">reads</text><text x="94.0" y="182" text-anchor="middle" style="font-size:19px">the whole pod</text><text x="94.0" y="218" text-anchor="middle" class="m" style="font-size:16px">its job</text><text x="94.0" y="242" text-anchor="middle" style="font-size:17px">checks the namespace's</text><text x="94.0" y="264" text-anchor="middle" style="font-size:17px">quota, and its min and</text><text x="94.0" y="286" text-anchor="middle" style="font-size:17px">max for containers</text><path class="s r" d="M19.2 339.1Q94.3 338.5 167.0 339.7M20.0 340.0Q94.0 339.5 167.9 339.7"/><path class="s r" d="M168.5 340.7Q169.2 383.9 167.9 428.1M168.9 340.5Q167.6 384.1 168.7 427.5"/><path class="s r" d="M168.5 428.1Q94.3 427.5 20.9 427.3M167.5 428.9Q93.8 427.1 20.4 427.6"/><path class="s r" d="M19.8 428.3Q19.6 384.1 20.3 340.7M20.5 427.9Q20.2 384.2 20.7 339.5"/><text x="94.0" y="362" text-anchor="middle" class="m" style="font-size:16px">when it says no</text><text x="94.0" y="390" text-anchor="middle" class="big r" style="font-size:20px">error:</text><text x="94.0" y="414" text-anchor="middle" class="big r" style="font-size:20px">never created</text><path class="s" d="M177.8 99.7Q185.9 99.3 192.3 100.7M178.4 100.8Q185.1 100.7 192.7 99.9"/><path class="s" d="M192.4 100.1Q187.3 102.8 181.5 104.7M192.2 99.4Q186.9 103.0 181.4 105.2"/><path class="s" d="M192.7 100.0Q186.5 98.0 182.9 95.9M191.8 99.5Q187.3 97.8 182.8 95.8"/><path class="h a" clip-path="url(#ckp2)" d="M151.2 127.7Q174.0 100.6 196.3 71.9M159.7 128.7Q181.1 99.3 205.5 72.6M170.1 129.1Q191.9 99.2 216.5 71.9M179.8 128.9Q204.1 100.4 225.2 73.2M191.4 127.6Q213.0 99.5 236.6 73.1M200.2 127.3Q224.9 100.7 246.3 72.3M209.6 129.0Q232.8 100.1 256.0 72.8M220.7 128.1Q244.1 100.1 266.6 73.1M230.9 127.0Q255.2 100.4 277.5 72.5M240.8 127.0Q264.7 100.6 285.2 71.5M251.8 129.1Q272.9 99.5 297.7 72.1M262.6 127.8Q283.0 99.4 305.7 71.6M270.7 127.1Q293.3 99.2 318.1 73.0M281.2 128.4Q303.4 99.7 327.0 71.9M290.6 128.1Q313.4 98.7 337.0 72.3M301.0 128.4Q324.3 99.9 345.7 72.6M310.2 129.0Q334.1 100.7 356.9 72.3M320.8 127.9Q342.9 100.3 365.2 72.6M329.9 126.9Q352.1 98.8 376.2 73.2M340.6 127.1Q362.3 98.9 386.9 72.7M349.3 127.4Q372.5 99.8 396.0 72.2"/><path class="s a" d="M197.1 73.7Q277.8 74.6 360.1 73.6M196.4 75.1Q277.7 72.0 359.9 74.8"/><path class="s a" d="M360.1 75.0Q360.9 100.1 359.7 125.0M361.1 73.5Q360.0 99.7 359.2 126.5"/><path class="s a" d="M360.4 125.9Q278.1 124.6 195.9 126.4M359.7 125.8Q278.0 126.3 195.4 126.1"/><path class="s a" d="M195.5 125.8Q197.4 99.7 196.4 73.5M195.5 125.9Q195.9 100.3 195.1 75.2"/><text x="278.0" y="108" text-anchor="middle" class="big" style="font-size:22px">2. Scheduler</text><text x="278.0" y="158" text-anchor="middle" class="m" style="font-size:16px">reads</text><text x="278.0" y="182" text-anchor="middle" style="font-size:19px">requests</text><text x="278.0" y="218" text-anchor="middle" class="m" style="font-size:16px">its job</text><text x="278.0" y="242" text-anchor="middle" style="font-size:17px">finds a node with</text><text x="278.0" y="264" text-anchor="middle" style="font-size:17px">room for requests</text><path class="s r" d="M204.3 339.4Q278.0 338.4 352.0 340.0M203.8 339.9Q278.1 341.2 351.3 340.5"/><path class="s r" d="M351.7 340.9Q351.7 384.0 352.4 427.8M352.4 340.1Q352.9 384.1 352.6 428.7"/><path class="s r" d="M351.5 428.7Q278.3 428.4 203.3 428.6M352.2 428.4Q278.3 427.7 203.7 427.9"/><path class="s r" d="M203.2 427.8Q204.0 383.6 204.9 341.0M204.5 428.8Q205.9 384.2 204.8 339.2"/><text x="278.0" y="362" text-anchor="middle" class="m" style="font-size:16px">when it says no</text><text x="278.0" y="390" text-anchor="middle" class="big r" style="font-size:20px">Pending</text><path class="s" d="M362.0 99.2Q379.0 100.9 396.0 101.5M364.6 100.3Q379.7 99.0 396.8 99.6"/><path class="s" d="M396.7 100.3Q391.0 102.8 385.6 104.8M395.6 100.3Q390.9 102.4 386.0 105.5"/><path class="s" d="M395.2 99.3Q390.9 98.5 385.8 95.9M396.1 100.8Q390.6 99.0 386.6 96.0"/><path class="h y" clip-path="url(#ckp3)" d="M354.6 127.1Q378.3 101.0 400.4 71.6M364.0 129.2Q388.0 100.4 410.4 72.0M375.7 127.2Q398.2 100.2 419.4 70.9M385.4 128.1Q408.8 100.7 429.3 71.3M394.6 127.4Q416.2 99.6 438.3 72.1M402.6 127.7Q425.9 100.3 449.4 72.7M414.7 127.1Q436.0 99.6 460.3 72.0M425.9 127.1Q448.7 101.2 469.3 73.0M436.5 127.5Q459.8 101.5 481.3 71.7M445.5 127.3Q466.1 99.1 490.1 72.6M455.2 129.2Q477.0 99.1 500.1 71.0M464.3 127.7Q488.4 100.9 509.8 72.1M472.7 129.2Q495.3 99.7 519.0 72.5M485.0 127.6Q505.7 99.6 528.8 72.5M492.6 129.1Q514.6 99.3 539.4 71.0M501.6 129.0Q526.1 100.4 549.1 72.0M513.5 128.5Q535.4 100.7 557.1 71.2M522.8 127.5Q546.2 100.5 567.7 71.9M534.2 128.9Q554.5 98.9 577.6 72.5M542.7 128.6Q565.0 99.5 587.0 72.7M551.0 128.2Q574.9 100.8 595.9 71.0M562.4 127.9Q586.0 100.8 606.7 72.2"/><path class="s y" d="M400.5 75.2Q481.9 73.4 564.5 74.5M401.1 75.1Q481.8 72.1 563.7 73.9"/><path class="s y" d="M563.3 74.4Q563.8 99.8 565.1 126.6M564.2 74.3Q562.8 99.6 563.6 126.4"/><path class="s y" d="M563.8 125.9Q482.1 124.1 399.0 126.1M564.8 126.2Q481.7 125.4 399.3 126.4"/><path class="s y" d="M399.2 125.2Q398.5 99.6 400.2 73.1M399.4 126.5Q400.1 100.4 400.3 73.2"/><text x="482.0" y="108" text-anchor="middle" class="big" style="font-size:22px">3. Kubelet</text><text x="482.0" y="158" text-anchor="middle" class="m" style="font-size:16px">reads</text><text x="482.0" y="182" text-anchor="middle" style="font-size:19px">requests, limits</text><text x="482.0" y="218" text-anchor="middle" class="m" style="font-size:16px">its job</text><text x="482.0" y="242" text-anchor="middle" style="font-size:17px">makes the pod's cgroup,</text><text x="482.0" y="264" text-anchor="middle" style="font-size:17px">has the container runtime</text><text x="482.0" y="286" text-anchor="middle" style="font-size:17px">start each container, then</text><text x="482.0" y="308" text-anchor="middle" style="font-size:17px">watches node memory</text><path class="s r" d="M407.2 339.1Q481.6 339.2 556.4 341.0M408.9 339.1Q482.0 341.3 556.4 340.7"/><path class="s r" d="M555.8 340.8Q556.8 384.2 555.2 428.1M556.3 339.2Q555.7 384.3 555.2 427.4"/><path class="s r" d="M555.3 428.3Q482.0 428.6 408.4 428.6M556.1 427.8Q481.6 426.3 408.9 428.7"/><path class="s r" d="M407.1 428.5Q407.8 384.0 408.1 340.9M408.8 428.6Q409.1 383.6 408.4 340.5"/><text x="482.0" y="362" text-anchor="middle" class="m" style="font-size:16px">when it says no</text><text x="482.0" y="390" text-anchor="middle" class="big r" style="font-size:20px">Evicted</text><path class="s" d="M568.6 98.8Q573.9 100.8 581.1 98.4M565.6 101.2Q573.5 100.0 580.5 100.6"/><path class="s" d="M579.4 100.6Q575.1 102.1 570.2 105.1M580.7 99.6Q574.8 102.4 570.8 104.2"/><path class="s" d="M580.4 100.1Q574.7 98.2 570.6 94.7M579.6 100.0Q574.7 97.9 570.1 94.6"/><path class="h r" clip-path="url(#ckp4)" d="M538.5 127.0Q562.3 100.1 583.4 72.7M548.1 128.8Q571.5 101.0 592.1 72.3M558.8 128.6Q580.4 99.1 603.0 73.0M569.3 128.8Q591.7 101.0 614.0 73.2M579.7 127.2Q600.0 99.2 623.5 72.6M588.2 126.8Q612.2 100.9 632.3 71.2M596.7 128.7Q619.6 99.3 643.1 72.1M606.5 128.6Q629.3 99.1 652.5 72.8M618.6 128.3Q640.4 99.9 663.7 72.3M628.8 127.6Q652.2 100.5 673.8 72.6M639.8 127.9Q659.3 98.8 683.6 72.4M650.0 127.4Q670.4 98.9 693.7 73.0M658.7 127.6Q679.9 99.2 704.2 71.8M667.7 126.8Q691.2 100.9 712.8 72.5M678.8 128.8Q702.1 100.4 723.8 71.0M687.0 127.1Q711.4 100.5 733.7 72.6M697.9 128.2Q722.0 101.1 742.8 72.5M708.1 128.6Q730.2 99.6 752.7 70.9M718.9 127.2Q739.9 99.3 764.1 71.7M728.2 128.1Q752.3 100.3 775.1 72.3M739.6 126.9Q762.3 100.6 785.2 72.8"/><path class="s r" d="M584.5 74.9Q665.9 74.7 748.1 74.9M583.9 74.9Q666.0 74.9 747.9 73.7"/><path class="s r" d="M748.9 74.1Q749.7 99.6 748.7 125.6M748.0 74.7Q749.6 99.8 748.6 126.1"/><path class="s r" d="M748.0 125.5Q665.7 124.6 584.2 125.7M748.4 125.8Q666.3 126.4 584.6 126.9"/><path class="s r" d="M583.8 126.8Q584.7 99.7 583.2 73.1M583.8 125.4Q585.1 100.2 584.9 74.2"/><text x="666.0" y="108" text-anchor="middle" class="big" style="font-size:22px">4. Kernel</text><text x="666.0" y="158" text-anchor="middle" class="m" style="font-size:16px">reads</text><text x="666.0" y="182" text-anchor="middle" style="font-size:19px">cgroup files</text><text x="666.0" y="218" text-anchor="middle" class="m" style="font-size:16px">its job</text><text x="666.0" y="242" text-anchor="middle" style="font-size:17px">enforces the limits,</text><text x="666.0" y="264" text-anchor="middle" style="font-size:17px">every moment</text><path class="s r" d="M591.3 340.3Q666.4 340.9 739.3 340.4M592.2 340.7Q665.8 340.6 739.7 339.3"/><path class="s r" d="M739.9 340.1Q740.8 384.2 740.5 428.9M739.7 340.6Q741.8 384.1 740.9 428.3"/><path class="s r" d="M739.9 428.5Q665.9 428.6 591.5 428.9M740.0 427.9Q665.6 429.4 592.6 428.3"/><path class="s r" d="M592.6 427.7Q590.9 383.9 592.0 339.6M592.6 428.7Q591.7 384.3 591.1 339.2"/><text x="666.0" y="362" text-anchor="middle" class="m" style="font-size:16px">when it says no</text><text x="666.0" y="390" text-anchor="middle" class="big r" style="font-size:20px">throttled,</text><text x="666.0" y="414" text-anchor="middle" class="big r" style="font-size:20px">OOMKilled</text><text x="380" y="478" text-anchor="middle" style="font-size:19px">your YAML moves left to right, and any checkpoint can stop it</text><text x="380" y="506" text-anchor="middle" class="m" style="font-size:17px">the first three decide and configure. only the kernel enforces, every moment your app runs</text></svg><figcaption>Four checkpoints, four ways to say no. How a pod fails tells you which one stopped it.</figcaption></figure>

Notice the split. Checkpoints 1 to 3 are **deciders**: they judge your pod against the state of the cluster and decide whether it's created, where it runs, and whether it gets to stay. None of them limits your app while it runs. Checkpoint 4 is the only **enforcer**: the kernel decides nothing about your pod, but it applies the numbers in its files to every slice of CPU time and every memory allocation, instantly.

Let's watch each one say no.

#### Checkpoint 1, the API server: is this allowed here?

Before the pod is even saved, the API server checks it against the namespace's rules. Here the namespace has a quota of 100m CPU for requests, and the pod asks for 250m:

```bash
kubectl apply -f labs/09-four-checkpoints/quota.yaml
kubectl apply -f labs/09-four-checkpoints/pod-over-quota.yaml
```

```
Error from server (Forbidden): error when creating "labs/09-four-checkpoints/pod-over-quota.yaml": pods "over-quota" is forbidden: exceeded quota: tiny, requested: requests.cpu=250m, used: requests.cpu=0, limited: requests.cpu=100m
```

Turned away at the door. The pod was never created, so there's nothing to `describe`: this error is all you get.

#### Checkpoint 2, the scheduler: which node has room?

The pod is saved but has no node yet. The scheduler looks for a node whose **allocatable** resources (what's left for pods after the system takes its share; [chapter 18](/blog/cgroups-deep-dive-kubernetes-part-3/#18-when-the-whole-node-runs-short)) can fit the pod's **requests**. It never looks at real usage. This pod requests 1000 CPUs:

```bash
kubectl -n lab apply -f labs/09-four-checkpoints/pod-too-big.yaml
kubectl -n lab get pod too-big
kubectl -n lab get events --field-selector involvedObject.name=too-big -o custom-columns=REASON:.reason,MESSAGE:.message
```

```
NAME      READY   STATUS    RESTARTS   AGE
too-big   0/1     Pending   0          3s
REASON             MESSAGE
FailedScheduling   0/2 nodes are available: 1 Insufficient cpu, 1 node(s) had untolerated taint(s). preemption: 0/2 nodes are available: 2 Preemption is not helpful for scheduling.
```

This time the pod exists, but it waits, and its events say why. (The second node is the control plane, which doesn't take ordinary pods.)

#### Checkpoint 3, the kubelet: build the boxes, and keep the node healthy

Once a node is chosen, its kubelet creates the pod's cgroup and asks the container runtime to start each container with your numbers; [chapter 10](#10-follow-one-pod-down-to-the-kernel) follows them all the way down. Then the kubelet keeps watching the node. If memory runs short, it **evicts** pods to protect the rest, starting with those using the most beyond their memory request. Here's how that looks in [chapter 18](/blog/cgroups-deep-dive-kubernetes-part-3/#18-when-the-whole-node-runs-short)'s lab, where a pod with no memory request kept growing:

```
Evicted: The node was low on resource: memory. Threshold quantity: 6094860Ki, available: 6090788Ki. Container main was using 1506200Ki, request is 0, has larger consumption of memory.
```

#### Checkpoint 4, the kernel: over the limit, right now?

The first three checkpoints act once, or every few seconds. The kernel checks every slice of CPU time and every memory allocation, the whole time your app runs. A container that wants more CPU than its limit is **throttled**: made to wait. One that needs more memory than its limit is **OOM-killed**. Here's the pod's last state in [chapter 16](/blog/cgroups-deep-dive-kubernetes-part-3/#16-memory-limits-and-the-oom-killer)'s lab:

```
OOMKilled exit=137
```

Kubernetes only reports that. The kernel did it.

#### Which checkpoint did this?

Notice that the four checkpoints don't read the same things. Requests are read early, to place the pod and later to pick who to evict. Limits pass straight through to the kernel:

<figure class="sketch "><svg viewBox="0 0 760 290" role="img" aria-label="Which checkpoint reads requests and limits"><title>Which checkpoint reads requests and limits</title><text x="330" y="32" text-anchor="middle" class="big" style="font-size:22px">scheduler</text><text x="330" y="54" text-anchor="middle" class="m" style="font-size:16px">to place the pod</text><text x="480" y="32" text-anchor="middle" class="big" style="font-size:22px">kubelet</text><text x="480" y="54" text-anchor="middle" class="m" style="font-size:16px">to pick who to evict</text><text x="640" y="32" text-anchor="middle" class="big" style="font-size:22px">kernel</text><text x="640" y="54" text-anchor="middle" class="m" style="font-size:16px">as a cgroup file</text><text x="30" y="106" text-anchor="start" class="code">requests.cpu</text><path class="s m" d="M20.0 126.4Q380.0 126.6 739.6 126.0"/><path class="s g" d="M317.3 99.0Q322.6 103.9 327.2 110.1M318.8 99.6Q323.3 104.3 325.9 109.0"/><path class="s g" d="M327.3 110.0Q336.8 100.0 342.9 88.8M325.4 109.6Q336.4 99.3 344.1 88.3"/><text x="480" y="107" text-anchor="middle" class="m" style="font-size:22px">–</text><path class="s g" d="M571.3 98.8Q574.7 104.6 577.8 111.4M569.6 100.1Q573.8 104.7 580.1 110.5"/><path class="s g" d="M579.4 109.8Q586.9 98.6 596.2 89.6M579.2 109.3Q587.3 99.4 597.4 88.0"/><text x="604" y="106" text-anchor="start" class="code">cpu.weight</text><text x="30" y="158" text-anchor="start" class="code">requests.memory</text><path class="s m" d="M20.1 177.7Q379.9 177.5 740.4 177.7"/><path class="s g" d="M317.6 151.3Q322.2 157.9 327.9 162.7M318.3 152.8Q321.5 157.6 327.1 160.5"/><path class="s g" d="M327.6 163.2Q335.9 151.3 344.0 140.9M326.5 163.5Q336.0 151.7 342.6 139.1"/><path class="s g" d="M466.9 151.2Q473.7 155.9 475.7 162.5M469.1 152.0Q473.1 156.4 476.6 162.1"/><path class="s g" d="M478.0 160.8Q484.5 150.4 494.0 140.0M476.9 161.8Q485.1 151.7 493.2 140.8"/><text x="640" y="159" text-anchor="middle" class="m" style="font-size:22px">–</text><text x="30" y="210" text-anchor="start" class="code">limits.cpu</text><path class="s m" d="M19.6 229.8Q379.9 230.3 739.5 230.0"/><text x="330" y="211" text-anchor="middle" class="m" style="font-size:22px">–</text><text x="480" y="211" text-anchor="middle" class="m" style="font-size:22px">–</text><path class="s g" d="M568.5 202.4Q575.4 208.1 577.5 214.6M568.8 203.8Q574.5 209.1 579.4 215.2"/><path class="s g" d="M579.8 214.9Q586.3 202.0 595.8 191.8M580.5 212.5Q589.1 203.4 597.1 190.5"/><text x="604" y="210" text-anchor="start" class="code">cpu.max</text><text x="30" y="262" text-anchor="start" class="code">limits.memory</text><path class="s m" d="M20.5 282.2Q380.2 282.4 740.0 282.3"/><text x="330" y="263" text-anchor="middle" class="m" style="font-size:22px">–</text><text x="480" y="263" text-anchor="middle" class="m" style="font-size:22px">–</text><path class="s g" d="M569.7 257.5Q575.4 260.9 579.7 266.2M571.0 255.2Q574.7 260.8 577.9 265.1"/><path class="s g" d="M579.0 266.8Q587.2 255.2 594.8 244.2M577.6 264.8Q587.8 255.2 595.7 244.5"/><text x="604" y="262" text-anchor="start" class="code">memory.max</text></svg><figcaption>Limits only ever reach the kernel. The memory request never does: it's for placing pods and picking who to evict.</figcaption></figure>

So when a pod misbehaves, the most useful first question is **"which checkpoint did this?"**, and the symptom usually tells you:

| You see | Checkpoint | Look at |
|---|---|---|
| `Error from server (Forbidden): … exceeded quota` | API server | `kubectl describe quota`, `kubectl describe limitrange` |
| `Pending`, with `FailedScheduling … Insufficient cpu` | Scheduler | the pod's events, and the nodes' allocatable resources |
| `Evicted: The node was low on resource: memory` | Kubelet | `kubectl describe node`, and the pod's memory request ([chapter 18](/blog/cgroups-deep-dive-kubernetes-part-3/#18-when-the-whole-node-runs-short)) |
| `OOMKilled`, exit code 137 | Kernel | `memory.events` in the pod's cgroup ([chapter 16](/blog/cgroups-deep-dive-kubernetes-part-3/#16-memory-limits-and-the-oom-killer)) |
| Slow responses, a high throttle count | Kernel | `cpu.stat` in the pod's cgroup ([chapter 14](/blog/cgroups-deep-dive-kubernetes-part-2/#14-cpu-limits-become-a-budget-throttling)) |

> [!DEEPER]
> **The rules at the door.** Three Kubernetes objects act at checkpoints 1 and 2, and none of them touches a cgroup. A **ResourceQuota** is a namespace's total budget, like the one above. A **LimitRange** sets default and maximum requests and limits per container, and fills them in if you leave `resources:` out. A **PriorityClass** says which pods matter more: if a high-priority pod doesn't fit, the scheduler can **preempt** (evict) lower-priority pods to make room. The lab has a hands-on extra for each: `labs/E1-resourcequota`, `labs/E2-limitrange` and `labs/E3-priority-and-preemption`.

*Lab:* [09-four-checkpoints](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood/tree/main/labs/09-four-checkpoints). Check what you built with `make check LAB=09`.

> [!KEY]
> Kubernetes decides and configures; the kernel enforces. How a pod fails tells you which checkpoint stopped it.


---

### 10. Follow one pod down to the kernel

*Question: where exactly do `250m`, `500m` and `128Mi` end up?*

We'll use one pod for the rest of this section:

```yaml
resources:
  requests:
    cpu: 250m
    memory: 64Mi
  limits:
    cpu: 500m
    memory: 128Mi
```

<figure class="sketch "><svg viewBox="0 0 760 330" role="img" aria-label="One pod's resources at every layer"><title>One pod's resources at every layer</title><defs><clipPath id="cpj1"><rect x="20" y="77" width="215" height="46"/></clipPath><clipPath id="cpj2"><rect x="20" y="139" width="215" height="46"/></clipPath><clipPath id="cpj3"><rect x="20" y="201" width="215" height="46"/></clipPath><clipPath id="cpj4"><rect x="20" y="263" width="215" height="46"/></clipPath></defs><path class="s" d="M18.5 16.1Q128.1 14.2 235.7 15.6M21.0 15.1Q127.9 12.3 235.8 15.7"/><path class="s" d="M236.3 16.3Q235.8 38.6 233.7 61.5M235.8 15.2Q233.4 37.4 236.5 60.2"/><path class="s" d="M235.5 59.7Q127.6 63.5 19.5 59.8M235.1 60.1Q127.9 61.4 20.1 62.6"/><path class="s" d="M21.2 59.6Q19.4 38.2 20.4 15.3M21.1 60.2Q20.4 38.2 18.9 13.9"/><text x="127" y="45" text-anchor="middle" class="big" style="font-size:20px">pod.yaml</text><text x="255" y="45" text-anchor="start" style="font-size:17px">requests 250m / 64Mi · limits 500m / 128Mi</text><path class="s" d="M127.1 62.8Q126.5 69.0 127.4 75.1M125.5 64.3Q127.3 68.8 126.5 74.7"/><path class="s" d="M126.3 75.1Q123.8 70.7 121.5 65.0M127.1 74.8Q124.0 70.7 122.6 65.6"/><path class="s" d="M127.7 74.5Q128.4 69.7 132.4 64.7M126.7 75.3Q129.8 70.4 131.6 64.7"/><path class="h b" clip-path="url(#cpj1)" d="M-21.1 125.8Q0.9 101.6 19.4 74.6M-11.7 124.4Q9.5 100.5 27.9 74.1M-1.8 124.2Q18.0 98.9 39.7 75.3M9.9 125.3Q29.0 99.3 49.9 75.2M18.6 124.3Q39.2 100.0 57.9 74.8M29.4 126.1Q48.5 99.5 70.3 75.6M38.4 125.9Q59.9 100.5 78.9 73.8M49.9 124.7Q68.5 98.9 88.7 75.9M59.2 124.9Q80.2 100.7 97.7 74.4M68.3 126.0Q87.5 99.6 109.3 74.1M80.0 124.7Q98.3 99.1 119.9 76.0M87.7 125.4Q109.0 100.6 127.3 75.1M99.2 125.0Q118.1 98.9 139.1 74.9M109.7 123.9Q131.6 101.2 150.9 75.0M120.4 125.6Q140.5 100.4 159.0 73.8M131.3 123.8Q152.4 101.2 170.8 74.8M140.4 124.2Q161.7 100.8 181.0 75.4M151.7 125.7Q171.9 99.6 191.9 74.9M163.3 125.9Q183.9 100.7 201.9 76.1M172.3 124.3Q191.7 99.2 212.8 75.3M182.3 124.8Q201.5 99.5 223.1 75.7M193.4 125.9Q212.9 100.0 233.5 74.3M202.7 124.5Q222.2 98.5 243.5 74.3M212.6 125.8Q232.7 100.1 251.6 74.5M222.5 124.9Q241.9 99.1 262.5 75.9M232.7 125.4Q252.9 100.1 273.3 75.9"/><path class="s b" d="M19.9 77.0Q127.2 79.4 235.9 78.5M19.7 77.2Q127.6 78.0 234.6 78.3"/><path class="s b" d="M234.9 75.9Q235.9 99.6 234.7 121.5M236.4 76.7Q234.9 99.4 235.2 122.0"/><path class="s b" d="M233.6 122.2Q127.5 125.4 18.7 122.2M233.6 123.0Q126.9 124.9 21.5 123.0"/><path class="s b" d="M19.2 123.8Q22.0 99.6 19.7 76.8M21.4 121.9Q22.5 100.6 19.3 76.3"/><text x="127" y="107" text-anchor="middle" class="big" style="font-size:20px">kubelet</text><text x="255" y="107" text-anchor="start" style="font-size:17px">sends your numbers to containerd (over the CRI)</text><path class="s" d="M125.9 124.7Q127.3 131.3 127.0 136.7M126.8 123.9Q126.9 130.6 128.1 138.1"/><path class="s" d="M127.1 136.8Q123.4 132.3 121.7 126.6M127.6 136.6Q124.0 132.3 122.8 127.0"/><path class="s" d="M126.9 137.3Q129.5 132.2 131.2 126.7M127.7 136.9Q128.7 131.9 132.4 127.1"/><path class="h a" clip-path="url(#cpj2)" d="M-19.1 186.9Q0.9 162.5 19.2 136.8M-9.3 186.3Q9.5 162.0 30.8 137.7M-1.0 186.0Q19.0 160.9 39.5 136.5M10.7 186.3Q31.1 162.4 50.1 136.9M20.0 186.1Q40.4 162.4 59.9 138.1M29.0 187.5Q50.1 162.7 68.3 137.5M38.3 186.7Q56.9 161.1 79.4 137.0M49.7 188.0Q70.3 163.2 90.0 136.4M58.6 187.6Q78.6 161.3 100.1 137.6M70.5 187.2Q89.9 162.5 109.9 137.4M81.1 186.1Q100.4 162.0 119.3 137.3M89.4 187.9Q112.0 163.0 129.4 137.2M100.0 187.2Q119.8 161.4 140.7 136.9M112.2 187.4Q132.4 162.5 151.4 136.4M121.0 188.1Q140.6 161.2 161.5 135.9M132.8 187.3Q151.9 162.0 171.5 136.7M142.2 186.3Q162.1 162.5 181.5 136.4M152.8 187.3Q173.1 163.2 191.9 136.6M162.2 187.0Q180.3 161.2 201.5 137.5M171.1 187.9Q190.6 162.4 211.1 138.0M180.2 187.4Q201.7 163.4 219.2 137.4M189.6 187.1Q211.1 162.4 229.6 137.1M198.5 187.0Q221.1 163.5 238.8 136.5M208.5 186.5Q229.3 162.2 249.8 137.7M218.5 186.9Q239.3 162.4 259.2 137.1M231.5 187.3Q250.4 162.1 269.4 137.8"/><path class="s a" d="M19.1 140.4Q127.8 137.8 234.2 139.9M19.1 137.8Q127.1 141.1 235.7 137.4"/><path class="s a" d="M234.3 139.6Q233.9 162.3 235.4 185.4M235.9 139.5Q233.9 161.9 233.4 184.3"/><path class="s a" d="M234.5 185.5Q127.1 186.5 20.2 186.3M233.6 184.6Q127.4 182.2 19.4 184.4"/><path class="s a" d="M21.5 185.7Q19.7 162.1 19.9 140.5M21.3 185.8Q19.6 162.5 21.0 139.3"/><text x="127" y="169" text-anchor="middle" class="big" style="font-size:20px">containerd</text><text x="255" y="169" text-anchor="start" style="font-size:17px">writes them into config.json (the OCI spec)</text><path class="s" d="M126.0 185.5Q126.6 192.4 125.4 198.3M126.4 187.6Q126.0 192.6 128.1 198.5"/><path class="s" d="M126.3 199.2Q124.9 193.7 122.3 189.1M126.4 199.0Q125.1 194.1 122.6 189.1"/><path class="s" d="M127.1 198.8Q129.2 193.9 132.4 189.8M126.7 199.3Q129.0 194.0 132.3 188.9"/><path class="h y" clip-path="url(#cpj3)" d="M-20.3 248.6Q0.2 223.6 20.9 199.3M-9.6 249.6Q11.2 224.7 30.9 199.8M0.7 248.6Q19.2 224.0 39.4 199.7M10.1 248.3Q29.3 223.5 49.7 199.9M18.3 249.3Q38.7 223.6 58.7 198.9M30.0 249.4Q49.1 224.8 68.6 199.9M39.3 248.3Q59.9 223.4 80.4 198.9M49.8 249.3Q69.7 223.6 89.2 197.9M61.5 248.9Q80.3 223.0 101.4 198.5M71.0 247.9Q89.8 222.6 111.0 198.9M82.7 250.0Q101.9 224.0 122.4 199.9M92.8 249.7Q112.4 224.6 132.1 198.3M102.9 249.7Q120.5 223.3 143.0 199.8M111.3 248.0Q132.6 224.3 151.8 197.8M124.4 249.3Q143.8 224.6 164.4 199.5M133.1 249.7Q153.6 224.2 172.2 199.9M142.3 250.0Q162.8 222.9 183.4 199.2M153.9 249.8Q175.0 224.5 194.4 199.9M164.3 250.1Q183.4 223.4 204.3 199.7M173.8 249.7Q192.1 223.3 214.0 198.4M181.1 250.1Q201.8 223.4 222.2 198.3M193.8 248.6Q213.1 224.2 233.9 198.9M203.8 250.1Q224.2 224.4 243.4 199.3M214.5 247.9Q232.8 223.8 253.5 198.5M222.5 249.6Q242.7 223.2 263.8 198.7M233.0 248.6Q252.7 223.6 274.1 200.2"/><path class="s y" d="M21.2 202.6Q127.7 198.9 234.3 200.9M21.1 201.2Q127.3 200.7 234.6 200.3"/><path class="s y" d="M235.3 200.3Q234.6 223.9 236.5 247.4M236.1 202.4Q235.8 224.5 235.4 248.5"/><path class="s y" d="M233.7 247.1Q127.4 249.8 19.0 247.9M235.2 247.9Q127.2 248.1 18.9 248.0"/><path class="s y" d="M20.1 246.7Q19.3 223.6 18.8 202.1M18.9 246.8Q17.9 224.6 19.3 201.4"/><text x="127" y="231" text-anchor="middle" class="big" style="font-size:20px">runc</text><text x="255" y="231" text-anchor="start" style="font-size:17px">reads config.json, writes the cgroup files, starts your app</text><path class="s" d="M127.0 249.2Q128.5 255.4 127.2 259.8M127.2 249.6Q126.2 254.7 126.1 260.0"/><path class="s" d="M126.8 260.7Q124.1 256.4 122.6 251.6M127.6 261.5Q125.5 255.8 122.3 250.9"/><path class="s" d="M126.5 260.4Q129.0 255.9 131.2 250.3M126.3 260.3Q129.5 255.9 131.9 251.9"/><path class="h r" clip-path="url(#cpj4)" d="M-20.8 311.6Q0.1 286.1 20.4 261.3M-9.0 311.8Q9.4 284.5 30.7 260.6M1.5 310.1Q20.8 286.2 40.9 261.9M11.7 311.9Q31.3 286.7 51.2 260.1M21.4 309.9Q42.6 287.2 61.0 260.9M30.8 310.4Q49.8 285.7 70.0 259.8M40.6 310.5Q60.5 286.1 80.8 262.2M50.0 311.2Q69.0 285.0 90.1 261.3M61.2 310.5Q81.2 287.0 100.1 261.0M71.4 310.7Q91.3 286.6 110.5 262.1M81.0 311.7Q100.0 285.2 122.3 262.0M93.5 311.3Q111.2 285.4 132.7 261.7M102.5 311.2Q122.9 286.3 141.6 261.2M111.3 311.0Q132.1 286.3 153.0 261.8M122.3 312.1Q141.1 285.6 160.5 259.9M131.8 311.3Q152.1 285.9 170.4 260.2M139.7 311.2Q161.5 287.2 180.4 260.9M149.6 312.2Q169.7 286.0 191.0 261.0M160.9 311.1Q180.2 285.5 199.8 260.4M170.5 309.8Q192.2 286.7 210.8 261.9M181.9 311.9Q200.4 285.1 220.6 261.7M192.8 310.7Q211.3 285.0 231.8 260.4M202.7 310.4Q221.9 285.9 242.0 260.5M210.6 311.5Q231.3 286.3 252.4 261.9M222.2 311.5Q241.7 285.9 263.1 260.0M233.2 311.6Q253.0 286.8 272.5 260.3"/><path class="s r" d="M20.9 264.1Q127.8 263.3 235.7 264.1M21.0 264.2Q128.0 263.0 234.1 263.8"/><path class="s r" d="M234.6 264.1Q233.0 286.4 234.4 310.4M233.6 264.1Q234.6 285.7 235.8 308.9"/><path class="s r" d="M233.9 310.5Q127.6 308.3 20.6 310.4M236.1 308.4Q128.0 308.4 20.4 308.3"/><path class="s r" d="M18.4 310.2Q18.8 285.6 20.2 263.5M21.2 307.4Q18.8 286.3 20.0 262.0"/><text x="127" y="293" text-anchor="middle" class="big" style="font-size:20px">kernel</text><text x="255" y="293" text-anchor="start" style="font-size:17px">cpu.weight 35 · cpu.max 50000 100000 · memory.max</text></svg><figcaption>Your numbers are handed down four times. Only the kernel enforces them.</figcaption></figure>

#### Who writes the files

Kubernetes never writes your container's cgroup files itself. Your numbers are passed down a short chain, like a relay race, and each runner does one job before handing over:

1. **The kubelet** takes the `resources:` block from your pod and hands it to containerd. They talk over the **CRI** (Container Runtime Interface), the standard way Kubernetes talks to any container runtime.
2. **containerd** writes those numbers, with everything else about the container, into one JSON file, `config.json`, under `linux.resources`. Its format is set by the Open Container Initiative, so it's called the **OCI runtime spec**, and any OCI runtime can read it.
3. **runc** reads `config.json`, asks systemd to create the container's cgroup, writes your numbers into its files (`cpu.max`, `cpu.weight`, `memory.max`), starts your app inside it, and exits. A small helper, `containerd-shim`, stays behind as your app's parent.

The kubelet does create one cgroup itself: the pod's folder, which holds all of the pod's containers ([chapter 11](#11-where-every-pod-lives-the-cgroup-tree)).

`config.json` describes the whole container: the command to run, the image's root filesystem, the namespaces, the capabilities. For this series only one part matters, `linux.resources`. Here's what it holds for our pod, and where runc puts each number:

<figure class="sketch "><svg viewBox="0 0 760 400" role="img" aria-label="Fields in config.json map to cgroup files"><title>Fields in config.json map to cgroup files</title><text x="20" y="28" text-anchor="start" style="font-size:20px">config.json  (the OCI runtime spec runc reads)</text><path class="s b" d="M14.7 41.2Q199.8 42.8 385.9 42.1M14.0 42.8Q199.7 42.5 385.0 43.0"/><path class="s b" d="M386.7 41.3Q387.4 192.0 385.6 341.1M385.3 41.1Q385.0 191.7 385.3 342.1"/><path class="s b" d="M386.7 343.1Q200.2 341.8 14.5 342.5M385.1 342.6Q199.6 340.7 14.1 341.1"/><path class="s b" d="M13.2 343.0Q14.0 192.0 13.0 42.8M14.1 341.4Q15.9 192.4 13.9 42.5"/><text x="30" y="66.0" text-anchor="start" class="code">"linux": {</text><text x="30" y="86.5" text-anchor="start" class="code">  "cgroupsPath": "…pod&lt;uid&gt;.slice:</text><text x="30" y="107.0" text-anchor="start" class="code">                  cri-containerd:&lt;id&gt;",</text><text x="30" y="127.5" text-anchor="start" class="code">  "resources": {</text><text x="30" y="148.0" text-anchor="start" class="code">    "cpu": {</text><text x="30" y="168.5" text-anchor="start" class="code">      "shares": 256,</text><text x="30" y="189.0" text-anchor="start" class="code">      "quota":  50000,</text><text x="30" y="209.5" text-anchor="start" class="code">      "period": 100000</text><text x="30" y="230.0" text-anchor="start" class="code">    },</text><text x="30" y="250.5" text-anchor="start" class="code">    "memory": {</text><text x="30" y="271.0" text-anchor="start" class="code">      "limit": 134217728</text><text x="30" y="291.5" text-anchor="start" class="code">    }</text><text x="30" y="312.0" text-anchor="start" class="code">  }</text><text x="30" y="332.5" text-anchor="start" class="code">}</text><text x="560" y="28" text-anchor="middle" style="font-size:20px">the files runc writes</text><path class="s y" d="M439.0 60.0Q589.9 61.3 739.0 59.7M440.9 60.4Q589.7 62.1 739.0 59.9"/><path class="s y" d="M739.1 60.8Q739.0 88.8 740.9 118.9M740.0 60.6Q739.2 88.6 740.6 117.0"/><path class="s y" d="M739.1 117.8Q589.6 120.1 439.9 118.8M739.1 117.3Q589.8 119.5 439.0 119.0"/><path class="s y" d="M441.1 118.5Q439.1 88.9 440.2 60.0M440.3 117.5Q439.5 88.7 439.5 59.9"/><text x="456" y="84" text-anchor="start" class="code">…/cri-containerd-&lt;id&gt;.scope/</text><text x="456" y="107" text-anchor="start" class="m" style="font-size:17px">a new folder (the cgroup)</text><path class="s m" d="M386.5 80.9Q412.3 83.7 434.7 90.2M386.9 83.4Q412.2 85.9 435.6 88.9"/><path class="s m" d="M435.5 89.5Q430.9 90.9 425.4 91.9M435.7 89.7Q430.7 90.0 425.9 93.1"/><path class="s m" d="M436.4 89.4Q432.1 85.4 426.9 82.8M436.4 89.1Q431.5 86.0 427.2 82.5"/><path class="s a" d="M439.7 140.6Q590.2 138.2 739.0 140.9M439.0 138.9Q590.1 140.5 740.5 140.2"/><path class="s a" d="M739.3 141.0Q739.8 168.8 739.0 198.0M740.4 139.1Q740.0 168.6 739.9 198.3"/><path class="s a" d="M739.2 197.8Q589.6 197.0 441.1 198.8M740.6 197.0Q589.6 199.1 440.6 198.7"/><path class="s a" d="M440.7 198.1Q441.5 169.1 440.4 139.1M440.5 197.3Q440.6 168.9 440.0 140.1"/><text x="456" y="164" text-anchor="start" class="code">cpu.weight</text><text x="456" y="187" text-anchor="start" class="big" style="font-size:20px">35</text><path class="s m" d="M387.0 164.2Q411.7 167.5 437.4 168.6M388.6 163.1Q412.0 166.7 436.4 170.6"/><path class="s m" d="M436.2 168.5Q431.1 171.2 425.7 173.2M435.5 169.3Q431.0 171.3 426.2 172.8"/><path class="s m" d="M436.7 169.0Q431.1 166.1 426.9 162.9M435.9 169.0Q430.6 166.7 426.8 163.5"/><path class="s r" d="M440.7 220.1Q590.3 221.5 739.9 220.9M439.8 220.6Q589.9 221.7 739.0 220.2"/><path class="s r" d="M740.4 218.9Q738.4 249.3 739.1 277.6M740.8 219.7Q738.5 249.1 739.2 277.9"/><path class="s r" d="M739.5 277.7Q589.7 276.6 439.1 278.9M739.8 277.0Q590.3 278.6 440.2 278.0"/><path class="s r" d="M439.0 279.0Q439.5 249.1 440.0 220.2M440.5 278.0Q439.3 248.6 439.5 220.1"/><text x="456" y="244" text-anchor="start" class="code">cpu.max</text><text x="456" y="267" text-anchor="start" class="big" style="font-size:20px">50000 100000</text><path class="s m" d="M388.3 196.2Q410.7 223.2 434.5 249.5M389.1 195.9Q412.0 221.8 435.3 250.4"/><path class="s m" d="M435.5 249.2Q430.5 247.6 426.2 244.7M435.8 248.9Q430.7 247.4 425.8 244.6"/><path class="s m" d="M436.5 249.7Q433.6 243.8 433.4 238.1M436.5 248.3Q434.6 243.6 433.7 238.5"/><path class="s r" d="M439.8 299.1Q590.1 301.3 739.4 300.5M440.6 299.6Q589.8 301.7 739.4 300.6"/><path class="s r" d="M740.0 301.0Q741.2 329.1 740.0 357.8M738.9 299.7Q741.4 328.6 740.7 357.5"/><path class="s r" d="M741.0 358.8Q589.6 357.9 439.1 359.0M741.0 357.3Q589.7 358.0 440.6 359.0"/><path class="s r" d="M439.2 358.4Q441.7 329.4 441.0 300.0M439.8 358.5Q438.1 328.9 439.3 298.9"/><text x="456" y="324" text-anchor="start" class="code">memory.max</text><text x="456" y="347" text-anchor="start" class="big" style="font-size:20px">134217728</text><path class="s m" d="M388.6 266.7Q412.0 298.0 436.5 329.9M387.6 267.0Q414.2 296.0 434.8 330.3"/><path class="s m" d="M435.5 329.1Q431.7 326.1 426.8 324.1M435.2 329.0Q431.0 326.2 425.4 323.7"/><path class="s m" d="M436.3 329.0Q433.8 323.6 434.2 318.7M436.4 328.9Q435.5 323.5 433.6 318.1"/><text x="380" y="385" text-anchor="middle" class="m" style="font-size:17px">shares 256 → cpu.weight 35: runc converts the old unit (chapter 13)</text></svg><figcaption>One JSON file in, a handful of kernel files out. That's all runc does with your numbers.</figcaption></figure>

The whole trip, in one table:

| You wrote | In `config.json` | The kernel file gets | In plain words |
|---|---|---|---|
| `limits.cpu: 500m` | `quota 50000`, `period 100000` | `cpu.max` = `50000 100000` | At most 50 ms of CPU in every 100 ms |
| `limits.memory: 128Mi` | `limit 134217728` | `memory.max` = `134217728` | 128 MiB, then reclaim, then OOM kill |
| `requests.cpu: 250m` | `shares 256` | `cpu.weight` = `35` | A share of CPU, only when groups compete |
| `requests.memory: 64Mi` | *not there* | `memory.min` = `0` | **No kernel protection** |

That last row surprises almost everyone I show this to. The memory request never even reaches `config.json`. By default, Kubernetes uses it to pick a node and, later, to decide who to evict first when the node runs short ([chapter 18](/blog/cgroups-deep-dive-kubernetes-part-3/#18-when-the-whole-node-runs-short)), but it doesn't ask the kernel to protect that memory. Since Kubernetes 1.37 the `MemoryQoS` feature can change that, but only if you opt in; [chapter 17](/blog/cgroups-deep-dive-kubernetes-part-3/#17-not-all-memory-is-equal) covers it.

**Try it yourself.** Now check every step on a real pod. Create it and grab its container ID:

```bash
kubectl create namespace lab
kubectl -n lab apply -f labs/10-follow-one-pod-down/pod.yaml
kubectl -n lab wait --for=condition=Ready pod/follow-me
CID=$(kubectl -n lab get pod follow-me -o jsonpath='{.status.containerStatuses[0].containerID}' | sed 's#containerd://##')
```

**Step 1, the spec runc got.** `crictl` talks to containerd directly and prints the spec it handed to runc:

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

The same numbers as the sketch. `cgroupsPath` says where the container's cgroup goes: inside its pod's folder. `shares: 256` is the 250m request in an older unit called *CPU shares* ([chapter 13](/blog/cgroups-deep-dive-kubernetes-part-2/#13-cpu-requests-become-weights) explains it).

**Step 2, systemd.** One detail the sketch skips: on nodes that use the systemd cgroup driver (most do, including this one), runc doesn't make the folder itself. It asks systemd to create it as a *scope*, systemd's name for a group of processes started by someone else:

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

**Step 3, the kernel's files.**

```bash
CDIR="$(./scripts/pod-cgroup.sh follow-me)/cri-containerd-$CID.scope"
docker exec under-the-hood-worker cat $CDIR/cpu.weight $CDIR/cpu.max $CDIR/memory.max
```

```
35
50000 100000
134217728
```

Now read the same files from inside the container, plus one more, `memory.min`:

```bash
kubectl -n lab exec follow-me -- cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max /sys/fs/cgroup/cpu.weight /sys/fs/cgroup/memory.min
```

```
50000 100000
134217728
35
0
```

Every number from the table, in the same kind of files you wrote by hand in chapter 8.

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


*Lab:* [10-follow-one-pod-down](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood/tree/main/labs/10-follow-one-pod-down). Check what you built with `make check LAB=10`.

> [!KEY]
> `requests.cpu` → `cpu.weight`, `limits.cpu` → `cpu.max`, `limits.memory` → `memory.max`. The memory request is for scheduling and eviction, not kernel protection.


---

### 11. Where every pod lives: the cgroup tree

*Question: why is a container's cgroup buried so deep?*

Containers don't land just anywhere. The kubelet builds a tree, and the runtime adds each container's box at the bottom: one box for all pods, a box per **QoS class** (a label Kubernetes gives each pod, Guaranteed, Burstable or BestEffort, based on its requests and limits; [chapter 18](/blog/cgroups-deep-dive-kubernetes-part-3/#18-when-the-whole-node-runs-short)), a box per pod, and a box per container.

<figure class="sketch "><svg viewBox="0 0 760 420" role="img" aria-label="The kubelet nests cgroups in a tree"><title>The kubelet nests cgroups in a tree</title><path class="s" d="M31.1 30.6Q195.2 30.8 361.0 28.9M31.0 29.1Q195.4 30.0 359.9 29.4"/><path class="s" d="M359.3 29.5Q359.9 57.0 361.0 85.6M360.3 29.1Q361.6 57.2 358.8 85.9"/><path class="s" d="M360.9 84.5Q194.7 86.6 31.1 85.1M360.5 86.1Q194.7 84.7 30.9 84.5"/><path class="s" d="M29.0 84.5Q29.1 57.2 30.2 28.8M30.8 85.0Q30.5 57.3 29.6 30.0"/><text x="42" y="54" text-anchor="start" style="font-size:20px">node</text><text x="42" y="75" text-anchor="start" class="code">/sys/fs/cgroup</text><path class="s b" d="M58.9 105.6Q224.6 106.2 390.8 103.8M58.8 103.9Q224.9 106.2 389.2 106.1"/><path class="s b" d="M391.1 104.6Q391.4 132.9 389.7 160.1M390.7 105.9Q388.6 132.7 388.9 161.1"/><path class="s b" d="M391.0 159.6Q224.8 161.7 61.0 160.1M389.0 159.2Q224.8 160.4 60.5 161.2"/><path class="s b" d="M60.1 159.8Q58.3 133.0 59.4 105.2M58.9 161.0Q61.2 132.4 58.9 105.0"/><text x="72" y="129" text-anchor="start" style="font-size:20px">all pods</text><text x="72" y="150" text-anchor="start" class="code">kubepods.slice</text><text x="408" y="139" text-anchor="start" class="m" style="font-size:17px">memory.max ≈ allocatable</text><path class="s m2" d="M44.5 85.2Q43.2 108.6 44.3 131.5M43.8 84.9Q44.0 108.7 44.6 132.4"/><path class="s m2" d="M44.7 131.9Q50.9 133.2 57.3 131.7M45.5 132.4Q50.8 131.7 58.0 131.5"/><path class="s m2" d="M58.6 131.8Q54.7 134.8 51.3 135.9M57.8 132.3Q54.3 133.5 50.4 135.5"/><path class="s m2" d="M58.7 132.2Q54.8 129.6 50.9 127.7M57.9 132.5Q54.3 130.3 51.0 129.0"/><path class="s a" d="M90.8 179.6Q255.1 179.6 420.8 180.9M90.0 180.1Q255.5 181.2 419.2 180.8"/><path class="s a" d="M420.5 180.6Q418.3 207.7 419.2 235.7M420.3 180.7Q419.8 207.4 420.3 235.5"/><path class="s a" d="M420.4 234.3Q254.7 236.8 90.4 235.3M418.9 234.1Q255.0 236.5 89.6 234.2"/><path class="s a" d="M89.7 235.3Q88.4 207.5 90.2 179.4M89.5 234.8Q91.1 207.4 89.1 180.8"/><text x="102" y="204" text-anchor="start" style="font-size:20px">QoS class</text><text x="102" y="225" text-anchor="start" class="code">kubepods-burstable.slice</text><path class="s m2" d="M73.5 160.1Q74.0 183.6 73.8 207.1M74.4 160.2Q73.3 183.5 73.8 206.6"/><path class="s m2" d="M75.5 207.3Q81.1 207.8 87.5 208.3M74.4 205.9Q80.5 205.8 88.4 208.3"/><path class="s m2" d="M87.7 207.8Q84.5 208.8 80.6 211.2M88.8 207.0Q84.0 207.7 80.7 210.2"/><path class="s m2" d="M88.0 206.4Q84.9 204.1 81.0 203.4M87.2 207.1Q84.4 205.9 80.4 204.2"/><path class="s y" d="M119.2 256.2Q284.8 255.9 449.5 255.3M120.6 254.1Q285.1 255.0 450.6 254.5"/><path class="s y" d="M450.1 254.9Q449.7 282.3 449.7 310.6M449.9 256.0Q449.2 282.3 450.9 310.1"/><path class="s y" d="M450.2 310.5Q285.3 311.8 120.3 310.0M450.8 309.3Q284.9 308.3 119.5 310.8"/><path class="s y" d="M119.8 309.5Q118.7 282.7 120.7 256.0M120.0 309.6Q118.6 282.5 119.2 255.2"/><text x="132" y="279" text-anchor="start" style="font-size:20px">one pod</text><text x="132" y="300" text-anchor="start" class="code">…-burstable-pod&lt;uid&gt;.slice</text><text x="468" y="289" text-anchor="start" class="m" style="font-size:17px">cpu.max, memory.max</text><path class="s m2" d="M104.4 235.4Q103.2 258.4 104.2 281.4M104.2 234.5Q103.8 258.7 104.4 281.7"/><path class="s m2" d="M102.8 281.3Q111.6 282.6 119.3 280.9M104.4 280.5Q110.9 281.8 116.7 281.6"/><path class="s m2" d="M118.4 282.6Q114.5 284.7 110.2 285.4M118.7 281.8Q114.6 284.1 110.1 285.8"/><path class="s m2" d="M118.7 282.1Q114.1 281.0 111.0 278.1M118.0 281.4Q114.3 280.3 110.4 278.3"/><path class="s r" d="M150.4 329.0Q314.7 331.1 480.4 329.0M150.9 330.0Q315.1 328.3 479.6 330.7"/><path class="s r" d="M479.2 331.1Q482.0 357.1 480.4 384.3M480.8 329.1Q481.9 357.7 480.3 384.7"/><path class="s r" d="M479.6 384.7Q314.8 386.1 149.1 385.8M480.8 385.0Q315.3 384.4 150.2 385.2"/><path class="s r" d="M148.9 384.3Q150.8 357.1 148.9 330.9M149.9 385.9Q150.2 357.0 150.3 329.8"/><text x="162" y="354" text-anchor="start" style="font-size:20px">one container</text><text x="162" y="375" text-anchor="start" class="code">cri-containerd-&lt;id&gt;.scope</text><text x="498" y="364" text-anchor="start" class="m" style="font-size:17px">cpu.max, memory.max, cpu.weight</text><path class="s m2" d="M133.6 309.8Q133.9 333.3 133.9 357.5M133.6 309.7Q134.5 333.4 133.7 357.0"/><path class="s m2" d="M135.4 357.6Q141.5 355.6 148.6 356.9M133.3 357.6Q140.5 358.4 148.7 355.9"/><path class="s m2" d="M147.3 356.8Q144.4 359.2 141.6 360.3M148.4 357.3Q144.6 359.0 140.3 360.1"/><path class="s m2" d="M147.9 357.8Q144.9 355.0 140.0 352.8M148.1 357.8Q144.6 354.4 140.8 353.3"/></svg><figcaption>A child is also subject to any limits set on its parents. In this example, the limits sit on the pod and the container.</figcaption></figure>

Nesting matters because **anything in a box is also subject to the limits on the boxes around it.** A container can't go past its pod's limit, and all pods together can't go past the ceiling on the top box. (Not every box sets a limit; the QoS boxes usually don't.)

**Try it yourself.** List the box that holds every pod on the worker:

```bash
docker exec under-the-hood-worker ls /sys/fs/cgroup/kubelet.slice/kubelet-kubepods.slice/
docker exec under-the-hood-worker cat /sys/fs/cgroup/kubelet.slice/kubelet-kubepods.slice/memory.max
```

You'll see `kubelet-kubepods-burstable.slice` and `kubelet-kubepods-besteffort.slice` among the files, and a `memory.max` of `8321515520` on my machine: about 7.75 GiB, the most that all pods together may use. [Chapter 18](/blog/cgroups-deep-dive-kubernetes-part-3/#18-when-the-whole-node-runs-short) explains where that number comes from.

On GKE, EKS and most other clusters, the tree is the same but starts at `/sys/fs/cgroup/kubepods.slice`, without the `kubelet-` prefix (that's a kind detail).

This tree is also why a container's cgroup path is so long. Here's the `follow-me` pod from chapter 10, with each folder on its own line:

```
/sys/fs/cgroup/
  kubelet.slice/                                      kind's root for Kubernetes (kind only)
    kubelet-kubepods.slice/                           all pods
      kubelet-kubepods-burstable.slice/               the QoS class
        kubelet-kubepods-burstable-pod<uid>.slice/    the pod
          cri-containerd-<id>.scope/                  the container
            cpu.max                                   50000 100000
```

From inside the container, all of that is hidden. The cgroup namespace (chapter 7) makes the container's own folder look like the top, so the very same file is simply `/sys/fs/cgroup/cpu.max`, with the same `50000 100000` inside.


*Lab:* [11-the-cgroup-tree](https://github.com/NITHIN-JOHN-GEORGE/kubernetes-resources-under-the-hood/tree/main/labs/11-the-cgroup-tree), which also shows the QoS `oom_score_adj` values from [chapter 18](/blog/cgroups-deep-dive-kubernetes-part-3/#18-when-the-whole-node-runs-short). Check what you built with `make check LAB=11`.

> [!KEY]
> cgroups nest, and a child is also subject to the limits set on its parents.

---

## What's next

You can now read the files that hold every number in a `resources:` block: `cpu.max`, `cpu.weight` and `memory.max`, written by the kubelet into a tree of cgroups, one box per pod. You've even built one yourself.

But we haven't answered the question from the start: how does a pod get throttled on CPU it isn't even using? That's **[Part 2: CPU](/blog/cgroups-deep-dive-kubernetes-part-2/)**: how the kernel shares a CPU, what requests and limits really do, and the outage, explained step by step.
