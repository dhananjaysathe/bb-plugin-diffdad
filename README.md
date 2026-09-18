# bb-plugin-diffdad

A [BB](https://getbb.app) plugin that wraps a running [Diff Dad](https://github.com/nicknisi/diffdad) daemon.

## What you get

- **Diff Dad** sidebar page. Opens on "Needs my review": only the pull requests where you personally are a requested reviewer (GitHub's `user-review-requested:@me`), grouped and sorted the way Diff Dad does, with a repo filter and a refresh button. The "All" tab embeds Diff Dad's own command center.
- **Review PR in Diff Dad** thread panel action. Adds the thread's pull request to the queue and opens its narrated review.
- **`diffdad_review` agent tool** and a skill, so an agent can ask for a PR's verdict, TL;DR and concerns as text.
- **`bb diffdad list [--mine] [--json]`** and **`bb diffdad add <pr>`** from a shell.

## Requirements

- A running daemon: `dad daemon` (or `dad daemon install`). Default URL is `http://localhost:4319`. Change it in the plugin settings or with `bb plugin config diffdad set daemonUrl <url>`.
- `gh` logged in, for the "needs my review" split.

## Install

```sh
bb plugin install git:https://github.com/himynameisjonas/bb-plugin-diffdad.git
```

Or from a checkout: `npm install --include=dev && bb plugin install .`

## Known limits

- Local only. Over BB Connect the embedded page points at the remote device's localhost.
- Diff Dad reviews GitHub pull requests, not unpushed local diffs.
- The "mine" split is computed here by shelling out to `gh`. The right long-term home for it is Diff Dad's own poller.
