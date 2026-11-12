# Forgejo, WeCom and Codex

This fork adds optional Sources to the original Router → Ticket → DSH Worker design. The Worker can delegate implementation to the official `@deepseek-ai/dsh-subagent-codex` provider and remains responsible for verification, Git identity, PR ownership and reporting. The domain engine and authorization model are unchanged.

## Install into an independent profile

Use the installed DSH Desktop CLI (on macOS, `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`). Do not install the older global version from the upstream deployment example. This integration was exercised with Desktop **0.2.2-rc.1**, official Codex provider **0.2.2-rc.1**, and WeCom SDK **1.0.7**.

For a **new, nonexistent** profile only:

```sh
pnpm install --frozen-lockfile
pnpm build
dsh superagent-dev --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent-dev add "link:$PWD"
dsh plugin --profile superagent-dev add @deepseek-ai/dsh-subagent-codex@0.2.2-rc.1
```

Use [the profile patch example](../examples/forgejo-wecom.cordis.patch.yml), replacing all absolute paths. Configure the profile's model provider as usual. Starting the existing profile must not recreate it. The model used by Router/Worker is independent of the model in the Codex account/configuration.

`approve-for-me` configures the official Codex provider for workspace writes and its automatic approval reviewer. The default `never` mode can inherit a read-only Codex sandbox: the first live test reproduced that failure. Do not claim Codex implementation succeeded if it merely returned text for the Worker to transcribe.

## Private credentials and repository setup

Keep credentials outside the checkout in a mode-0700 directory and mode-0600 JSON files. Settings contain **paths**, not secrets.

Forgejo file:

```json
{"url":"https://forgejo.example:60443","login":"agent-user","token":"YOUR_TOKEN"}
```

WeCom file:

```json
{"botId":"YOUR_BOT_ID","secret":"YOUR_BOT_SECRET"}
```

Create a Forgejo account, grant it write access to the target repository, and create its personal access token with `read:user`, `write:repository`, and `write:issue`. Use HTTPS with a trusted certificate. The repository is configured as `owner/name`; no server deployment or database access is required by the plugin.

Use a dedicated `tea` login/configuration and a wrapper that sets its own `XDG_CONFIG_HOME`, then executes the installed `tea`. Configure that wrapper in the Forgejo Source's `cli` field. Do not point the Worker at an administrator's personal login. The git credential helper validates the requested origin, including the port, before returning credentials. Worker shims are account guardrails, not an OS security sandbox.

In the Superagent panel, set:

- Forgejo Source: repository, credentials file, bot `tea` wrapper, polling interval. Disable the GitHub Source in this profile.
- WeCom Source: credentials file and whether to accept private messages. The optional `chats` list filters delivered group messages.
- Policy: allowed Forgejo usernames and allowed WeCom sender IDs. Obtain the latter from an actual received message, not from a guess about the corporate userid format. Unknown senders are not automatically trusted.
- Executor: maximum parallel Workers and worktree preparation command.

Clone the repository using the bot's credential helper (never embed tokens in remote URLs). A minimal prepare command, with the repository clone's absolute path substituted, is:

```sh
git -C /absolute/base-clone fetch origin && git -C /absolute/base-clone worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" origin/HEAD
```

This runs once per new Ticket directory. Continuations reuse that directory. Existing-PR tasks must inspect and check out the PR's head before editing; this default prepare command starts from the default branch. The plugin does not automatically delete worktrees or merge PRs. Retain worktrees while a Ticket may resume; prune them deliberately after reviewing local changes.

Add to the deployment delivery prompt: use `tea` for Forgejo; use `subagent_codex` with the current Ticket directory for implementation; wait for its completion, inspect the diff and run tests; Worker commits/pushes and creates or updates the PR; report permission failures truthfully. Set the bot's commit identity explicitly. Keep automatic merging disabled unless separately authorized.

## Message and lifecycle behavior

Forgejo polls new Issues, Issue/PR comments, reviews, inline review comments, open PRs, followed PR closures/merges, and commit-status changes. It reads the associated Issue description and conversation for context. It posts replies as the bot with an outbox marker to avoid reposting an already acknowledged message. PRs are bound only if they are the source PR or belong to the Ticket's branch and bot account.

WeCom uses the official SDK's long connection, without a CLI or inbound public HTTP endpoint. It processes delivered text, voice transcription and textual portions of mixed messages. It cannot obtain surrounding group messages or group history. Supplied quoted text is marked as such. Each received message has its own source thread; Router can attach related messages to an existing Ticket instead of treating an entire chat as one task.

Receiving a message does not guarantee a task or a reply. Authorization and assessment still apply. In particular, “联调验证” without a requested outcome was correctly ignored in the live test. Code tasks from an allowed sender can be accepted and acknowledged in the original chat, then receive progress/result replies. PR terminal notices can also be delivered to that chat.

Only one connection should use a given WeCom bot's credentials. The plugin reconnects automatically. Incoming message IDs deduplicate redelivery. Outgoing IDs are persisted after SDK acknowledgement; an ambiguous network failure after server acceptance can still cause a duplicate retry, since the SDK does not expose a server-side idempotency key for this operation.

## Isolation and operations

Use independent profile, plugin checkout, state database, session root and storage root. Different repositories **must not reuse the same state database**: numeric Issue/PR thread IDs and polling cursors belong to one repository. Keep a separate state directory when moving from a test repository to a real project. An independent profile is configuration/data isolation, not a separate OS user; Codex still uses the existing local Codex account unless configured otherwise.

The locally installed `dsh-superagent-dev` manager starts/stops only this profile; it supports the Desktop CLI process layout. The original `superagent` profile can run alongside it on another port. Use the web authentication link printed in the service log to enter the panel.

Known scope limits: no Forgejo Actions log/run-detail adapter (commit statuses are supported); no media download/OCR in WeCom; no unread group-history retrieval; polling currently scans open PRs and subscribed threads, so large repositories should use a longer interval. Secrets are deliberately absent from this document and the example patch.

## Recorded integration verification (2026-11-12)

The bot-owned test repository was `ds-superagent/dsh-superagent-integration` on the deployment's Forgejo instance. A human Issue mention produced a Ticket and PR #2. After selecting `approve-for-me`, Codex directly added a test, executed `node --test sum.test.mjs` (4 passed), and the Worker independently verified and pushed commit `c98b73d` to that PR. A delivered WeCom private message produced a second Ticket and PR #3 (`2bad520`), with the acknowledgement and ready reply acknowledged by the SDK. Closing the test PRs without merging ended their Tickets and delivered the PR #3 closure notice back to WeCom. A generic test greeting was ignored rather than converted into work.

The deployed Forgejo version returns `statuses: null` for commits without CI. This case is normalized to an empty status list and has a regression test. The complete regression run passed 1205 tests; the added null-status regression and the relevant reader/document/model-surface suites then passed as well. Typecheck and bundle build succeeded. No test changes were merged into the target project. Group mentions use the same delivered-message adapter but were not exercised live in this run.
