---
name: diffdad
description: Get a narrated Diff Dad review (verdict, TL;DR, concerns) of a GitHub pull request, including this thread's own PR.
---

Use the `diffdad_review` tool with a PR URL or `owner/repo#123`. Omit the argument to review the PR attached to this thread. The first call may return no verdict because narration runs lazily; wait about a minute and call again.

From a shell: `bb diffdad list` shows the queue, `bb diffdad add <pr>` adds one.
