---
title: Writing a chapter
order: 2
summary: Markdown features available in chapters.
---

Chapters are plain Markdown. These are the building blocks.

## Code blocks

Fenced blocks get a language label and a copy button.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: my-service
spec:
  strategy:
    canary:
      steps:
        - setWeight: 10
        - pause: { duration: 5m }
```

## Callouts

> [!WARNING]
> Callouts use the `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]` and `[!WARNING]` markers.

## Tables

| Signal | Example metric | Typical use |
|---|---|---|
| Latency | p99 request duration | Canary analysis |
| Errors | 5xx ratio | Automatic rollback |
| Saturation | CPU throttling | Autoscaling |

## Lists

1. Write the chapter
2. Commit and push
3. Check the deployed page
