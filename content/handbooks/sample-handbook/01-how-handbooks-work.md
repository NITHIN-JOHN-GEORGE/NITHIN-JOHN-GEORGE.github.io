---
title: How handbooks work
order: 1
summary: Folder layout, chapter ordering and front matter.
---

A handbook is a folder in `content/handbooks/`. Each Markdown file in the folder is a chapter.

## Folder layout

```text
content/handbooks/
  my-handbook/
    _handbook.md        # title, description, status
    01-introduction.md
    02-getting-started.md
```

## Front matter

`_handbook.md` describes the handbook itself:

```yaml
---
title: Platform Engineering Handbook
description: What this handbook covers and who it is for.
status: Draft
---
```

Each chapter needs a `title` and an `order`. The sidebar uses `order` to sort chapters.

## What you get for free

- A sidebar with every chapter in the handbook
- An on-page table of contents built from `##` and `###` headings
- Previous and next links between chapters
- Search across all handbooks and blog posts (press `/`)

> [!NOTE]
> Chapters appear in the sidebar in `order`, then by file name.
