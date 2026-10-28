---
title: How this site works
date: 2026-10-28
summary: A sample post that shows how to publish here. Delete it when you publish your first real one.
tags: [meta]
draft: false
sample: true
---

This is a **sample post**. Every file in `content/blog/` becomes a post, and every file in `content/handbooks/` becomes part of a handbook.

## Publishing a post

1. Create `content/blog/my-post.md`.
2. Add front matter at the top: `title`, `date`, `summary` and `tags`.
3. Write the post in Markdown, commit and push. GitHub Actions builds and deploys the site.

```bash
git add content/blog/my-post.md
git commit -m "post: my first post"
git push
```

> [!TIP]
> Set `draft: true` in the front matter to keep a post out of the build while you work on it.

## Linking to a post published elsewhere

Add `external: https://...` to the front matter and leave the body empty. The post then appears in the list and links out, which is how the older Medium posts are shown.
