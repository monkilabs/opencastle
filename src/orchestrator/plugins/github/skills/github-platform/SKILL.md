---
name: github-platform
description: "GitHub pull requests, review threads, failing Actions checks and stacked pull requests, through GitHub's MCP server and the gh CLI. Use when opening, reviewing or updating a pull request, fixing a failed check, or splitting a change into a stack."
---

# GitHub Platform

Branch, commit and pull request conventions: the **git-workflow** skill. Docs: https://docs.github.com/en/pull-requests

## The MCP server

GitHub's own remote server, `https://api.githubcopilot.com/mcp/`. VS Code signs in with OAuth. Every other assistant sends `GITHUB_PERSONAL_ACCESS_TOKEN`, so the server acts as that token's user — call `get_me` first to know whose name every comment will carry. Tool names change between releases: read the tool list the server offers instead of assuming a name.

- **Toolsets.** On by default: `context`, `repos`, `issues`, `pull_requests`, `users`. An `X-MCP-Toolsets` header on the server entry turns on more (`actions` for CI logs), and `X-MCP-Readonly: true` drops every write tool.
- **Token.** Fine-grained and limited to the repositories the agents work in: **Contents**, **Pull requests** and **Issues** read and write, **Metadata** and **Actions** read. A 404 on a repository you know exists is the token: its repository list, or an organization that has not approved it.
- **`gh` covers the rest:** review threads, job logs and stacks, below. It signs in on its own (`gh auth status`).

## Gotchas

- **A review is pending until submitted.** Comments added to a pending review are invisible to everyone else, and a session that ends before the submit leaves them unsent.
- **Why a PR cannot merge:** `gh pr view 42 --json mergeStateStatus`. `BEHIND` needs a rebase onto its base, `DIRTY` has conflicts, `BLOCKED` lacks a required review or check, `UNSTABLE` has a non-required check failing.
- **A person merges**, as git-workflow says. Stop at a reviewed PR with green checks, though both the server and `gh` offer a merge.
- Open a draft while work remains (`gh pr create --draft`) and mark it ready when it is done (`gh pr ready 42`). `Closes #123` in the body closes the issue only when the PR merges into the default branch.
- In a review comment, a ```` ```suggestion ```` block replaces the commented lines when the author applies it. Use it for any fix that fits those lines.
- Search allows 30 requests a minute. Narrow with `repo:` and `is:open` rather than paging.

## Review threads

The REST API returns review comments without saying which are resolved. GraphQL says.

1. List the threads:

   ```sh
   gh api graphql -F owner='{owner}' -F repo='{repo}' -F pr=42 -f query='
     query($owner: String!, $repo: String!, $pr: Int!) {
       repository(owner: $owner, name: $repo) { pullRequest(number: $pr) {
         reviewThreads(first: 100) { nodes { id isResolved isOutdated path line
           comments(first: 20) { nodes { databaseId author { login } body } } } } } } }'
   ```

2. Fix what each unresolved thread asks, then commit and push. An `isOutdated` thread sits on code that has since changed: check that its point still applies.
3. Reply in the thread with what changed: `gh api repos/{owner}/{repo}/pulls/42/comments/<databaseId>/replies -f body='Fixed in <sha>: …'`
4. Resolve it: `gh api graphql -F id=<thread id> -f query='mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }'`

Done when step 1 shows every thread you fixed as resolved. A point you disagree with gets a reply and stays open for the reviewer.

## Failing checks

1. `gh pr checks 42` lists every check on the head commit. `--watch --fail-fast` waits, and stops at the first failure.
2. Read the failure with `gh run view <run-id> --log-failed`, which prints only the failed steps (the run ID is in the check's link). Start at the first error, not the last line.
3. Reproduce it with the command the step ran, fix it, and push. Done when `gh pr checks 42` passes on the new head commit.
4. If your diff cannot explain the failure, run `gh run rerun <run-id> --failed` once. A second failure is real.

Causes no log names:

- A push made with `GITHUB_TOKEN` inside a workflow starts no other workflow, so a bot's commit gets no checks. Push with a GitHub App token or a personal token when it needs them.
- A required check whose workflow is skipped by a `paths` filter never reports, and the PR waits for it forever. Run the job and exit early instead.
- A PR from a fork runs `pull_request` workflows with a read-only token and no secrets. `pull_request_target` has both and runs the base branch's workflow, so checking out the PR's code there runs it with your secrets.
- Set `permissions:` on each workflow rather than inheriting the repository default, which is read and write on older repositories.

## Stacked pull requests

A change too big for one review becomes a stack: a chain of layers, each its own PR on the branch below, with the bottom one on trunk (the default branch). Dependencies point down: shared types and schema at the bottom, the code that uses them above. Each PR is held to trunk's required reviews and checks, so every layer builds and passes CI on its own. With agents, one task per layer.

The `gh stack` extension does the bookkeeping: `gh extension install github/gh-stack`. Name every branch on the command line, because a bare command opens a prompt.

1. `gh stack init feat/search-01-schema`, then commit the first layer.
2. For each next layer, from the top one: `gh stack add feat/search-02-api`, then commit.
3. `gh stack push`, then `gh stack submit --auto`. This opens one draft PR per branch, each based on the one below, linked as a stack. Give each its title and body with `gh pr edit <n> --title "…" --body-file <file>`. Done when `gh stack view --json` lists every branch with its PR.
4. To change a lower layer: `gh stack checkout feat/search-01-schema`, commit, then `gh stack rebase --upstack`, `gh stack push` and `gh stack top`.
5. After a layer merges, `gh stack sync --prune` rebases what remains onto trunk, pushes, and deletes the merged branches.

- Merges go bottom up, and a person does them. Merging a PR merges every layer below it.
- History stays linear. Rebase rather than merging trunk into a layer, and push with `gh stack push`, which uses `--force-with-lease` per branch.
- A stack lives in one repository; it cannot span forks.
- Exit code 3 is a rebase conflict: resolve it, `git add`, then `gh stack rebase --continue`, or `--abort` to restore every branch.
- Exit code 9 means stacks are not enabled for this repository. Open each PR by hand with `gh pr create --draft --base <branch below>`. After a layer is squash-merged, rebase the next one with `git rebase --onto origin/main <merged branch> <next branch>` so the squashed commits are not replayed.
