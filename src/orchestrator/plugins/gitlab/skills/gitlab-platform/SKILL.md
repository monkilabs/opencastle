---
name: gitlab-platform
description: "GitLab merge requests, review threads, failed pipelines and stacked merge requests, through GitLab's MCP server and the glab CLI. Use when opening, reviewing or updating a merge request, fixing a failed pipeline, or splitting a change into a stack."
---

# GitLab Platform

Branch, commit and merge request conventions: the **git-workflow** skill, where a pull request is GitLab's merge request (MR). Docs: https://docs.gitlab.com/user/project/merge_requests/

## The MCP server

GitLab's own server, `https://gitlab.com/api/v4/mcp`, or `https://<your-host>/api/v4/mcp` on a self-managed instance (18.6 or later). It signs in with OAuth: the assistant registers itself and opens a browser the first time. It answers only once MCP access is allowed, by an owner for the top-level group on GitLab.com or by an administrator on a self-managed instance. Tool names change between releases: read the tool list the server offers instead of assuming a name.

- **Toolsets.** On by default: `meta`, `core`, `merge_requests`, `work_items`, `repository`, `ci`. `wikis` and `code_security` are opt-in, through the `X-Gitlab-Enabled-Mcp-Server-Toolsets` header.
- **Identifiers.** A project is its full path (`group/subgroup/project`) or its numeric ID. An MR is `!42` and an issue `#42`. Tools take that **IID** with the project, not the global ID the API also returns.
- **One call, many facets.** `get_merge_request` takes `include` (`diffs`, `pipelines`, `discussions`, `approvals`, `conflicts`), and `get_pipeline` takes `include: ["jobs"]`. Issues, tasks and epics are all work items (`save_work_item`, `get_work_item`); `create_issue` and `get_issue` still answer but are superseded.
- **`glab` covers the rest:** raw API calls, CI linting and stacks, below. It signs in on its own (`glab auth status`).

## Gotchas

- **A line that starts with a quick action runs it.** `/merge`, `/approve`, `/close` or `/assign` at the start of a line in a comment or description executes on save, through the API too. Wrap a command you are only quoting in backticks.
- **Why an MR cannot merge:** `glab api projects/:id/merge_requests/42` and read `detailed_merge_status`: `not_approved`, `discussions_not_resolved`, `ci_must_pass`, `need_rebase`, `conflict` or `draft_status`.
- **A person merges**, as git-workflow says. Stop at an approved MR with a green pipeline, though `accept_merge_request` exists.
- `Draft:` at the start of the title keeps an MR from merging while work remains. `Closes #42` in the description closes the issue only when the MR merges into the default branch.
- **An error on a field can be the tier.** `weight`, `status_id`, `blocks` links and MR dependencies need Premium; `health_status` and vulnerabilities need Ultimate. On Free, leave them out rather than retrying.
- In a review comment, a ```` ```suggestion:-0+0 ```` block replaces the commented line when the author applies it; `-1+2` widens it to one line above and two below.

## Review threads

1. List the discussions: `get_merge_request` with `include: ["discussions"]`, or `glab api projects/:id/merge_requests/42/discussions`. Each discussion has an `id` and its notes, and a resolvable note carries `resolved`.
2. Fix what each unresolved discussion asks, then commit and push.
3. Reply in the discussion with what changed: `save_note` with its ID, or `glab api projects/:id/merge_requests/42/discussions/<id>/notes -f body='Fixed in <sha>: …'`.
4. Resolve it with `save_merge_request_review`, or `glab api -X PUT projects/:id/merge_requests/42/discussions/<id> -F resolved=true`.

Done when step 1 shows every discussion you fixed as resolved. A point you disagree with gets a reply and stays open for the reviewer; a project that requires every thread resolved will not merge until they are.

## Failing pipelines

1. Find the pipeline for the MR's latest commit: `get_merge_request` with `include: ["pipelines"]`, then `get_pipeline` with `include: ["jobs"]` for the failed jobs. In a terminal, `glab ci status` shows the current branch's pipeline.
2. Read the failure with `get_job` and its log, or `glab ci trace <job-id>`. Start at the first error, not the last line.
3. Reproduce it with the command the job ran, fix it, and push. Done when the pipeline for the new head commit passes.
4. If your diff cannot explain the failure, retry the job once (`save_pipeline`, or `glab ci retry <job-id>`). A second failure is real.

Causes no log names:

- Protected variables reach only protected branches and tags, so a job that needs one fails on every MR branch.
- Once jobs run in merge request pipelines, a push to a branch with an open MR starts two pipelines, branch and MR, unless `workflow:rules` picks one:

  ```yaml
  workflow:
    rules:
      - if: $CI_PIPELINE_SOURCE == "merge_request_event"
      - if: $CI_COMMIT_BRANCH && $CI_OPEN_MERGE_REQUESTS
        when: never
      - if: $CI_COMMIT_BRANCH
  ```

- A job cannot mix `rules` with `only` or `except`. `glab ci lint` checks `.gitlab-ci.yml` against the instance before you push.

## Stacked merge requests

A change too big for one review becomes a stack: a chain of layers, each its own MR targeting the branch below, with the bottom one on trunk (the default branch). Dependencies point down: shared types and schema at the bottom, the code that uses them above. Every layer passes its pipeline on its own. With agents, one task per layer. When an MR merges, GitLab retargets up to four MRs that targeted its branch onto its target, and from GitLab 16.9 it rebases them too.

1. Branch each layer from the one below (`feat/search-01-schema`, `feat/search-02-api`, …), commit, and push every branch.
2. Open the MRs bottom up, each on the branch below: `glab mr create --source-branch feat/search-02-api --target-branch feat/search-01-schema --draft --fill`, or `save_merge_request`. On Premium, also list the lower MR under **Merge request dependencies**, so the upper one cannot merge first. Done when every layer has an MR targeting the branch below it.
3. To change a lower layer, add a commit there; an amend rewrites what the layers above are built on. Then, from the top branch, `git rebase --update-refs feat/search-01-schema` replays every layer above and moves their branches. Push them all with `git push --force-with-lease origin <branch> <branch>…`. Done when `git log --oneline --graph` from the top branch is one straight line through every layer.
4. After a layer merges, GitLab retargets the next one. If it was squash-merged on an instance older than 16.9, rebase the next layer yourself: `git rebase --onto origin/main feat/search-01-schema feat/search-02-api`.

- Merges go bottom up, and a person does them. An upper MR merged first lands in the branch below, not in trunk.
- History stays linear. Rebase rather than merging trunk into a layer.
- MRs from forks are not retargeted.
- `glab stack` (GitLab CLI 1.42 or later, experimental) automates the chain. `glab stack create <name>` starts it, `glab stack save -m "<description>"` adds each layer, `glab stack amend` changes the one checked out, and `glab stack sync` pushes every branch and creates or updates the chained MRs.
