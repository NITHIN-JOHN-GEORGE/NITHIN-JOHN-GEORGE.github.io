# Personal site and engineering handbooks

A zero-dependency static site: Markdown in, a finished site out. Needs only Node 18+.

```bash
node build.mjs        # builds to dist/
node serve.mjs        # preview at http://localhost:8080
```

## Add a blog post

Create `content/blog/my-post.md`:

```markdown
---
title: My post
date: 2026-11-01
summary: One sentence for the list and for search.
tags: [kubernetes, argocd]
---

Write in Markdown here.
```

- `draft: true` keeps a post out of the build.
- `external: https://...` (with no body) lists a post published elsewhere, such as Medium, and links out to it.

## Add a handbook

```text
content/handbooks/my-handbook/
  _handbook.md          # title, description, status (for example Draft)
  01-introduction.md    # each chapter needs title and order
  02-getting-started.md
```

Chapters get a sidebar, an on-page table of contents, previous/next links and search. Markdown supports fenced code (with a copy button), tables, lists, images and callouts (`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`).

## Edit the home page

Name, intro, highlights, tech stack and experience are in `content/site.json`. Stack items are `[name, simple-icons-slug]`. Leave the slug empty for a text-only chip.

## Deploy

Push to `master` (or `main`). In the repo, go to Settings > Pages and set Source to **GitHub Actions**. `.github/workflows/deploy.yml` builds and publishes the site on every push to `master` or `main`. `build-check.yml` builds every pull request and other branches, so a broken post is caught before it ships.

Samples to delete once you have real content: `content/blog/welcome-to-this-site.md` and `content/handbooks/sample-handbook/`.
