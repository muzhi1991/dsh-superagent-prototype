# Persistent delegation through Paseo

This optional deployment keeps Router → Ticket → DSH Worker. The Worker does simple queries and coordinates publication; a persistent Paseo agent performs substantive research, planning, debugging, review, environment setup, implementation and local checks/commits. The provider is deployment configuration, initially Codex. Existing bindings retain their provider and conversation.

## Deployment

Create `<stateDir>/paseo.json` (mode 0600) with absolute `cli`, `home`, `workRoot`, the existing Paseo `projectId`, `provider`, explicit `mode`, optional `model`/`thinking`, a deployment-unique `bindingPrefix`, and `env` containing the delegated Git author/committer identity. Use the provider's actual mode IDs; the configured mode is passed explicitly. The daemon must already be running. Agents are launched by the daemon, so its environment is not the Worker's environment; pass only intended non-secret overrides through `env`.

`workRoot` is the existing Superagent work root. Superagent creates Git worktrees; Paseo registers each existing directory with local isolation in the selected Project. It does not create another worktree. An existing workspace at exactly that directory is reused after checking its project. Multiple matches require explicit reconciliation. Each Ticket keeps its own workspace and Agent, even though all belong to one Project.

Point the deployment's Delivery prompt to this document and the installed `scripts/paseo-agent.mjs`; upstream role defaults need no provider-specific changes. The CLI bridge stores bindings in `<stateDir>/paseo-bindings/<ticketId>.json` outside Git. It strips ambient Paseo caller identity, serializes mutations, records launch/send intents before dispatch, and never silently recreates an Agent after an uncertain outcome. Do not hand-edit a binding without checking the actual Paseo directory and history.

## Worker procedure

Use the actual Ticket ID and directory from the execution context (those prompt values are not necessarily shell exports). Set these shell variables explicitly for each command; use a UTF-8 task file rather than shell-interpolated task text:

```sh
node <plugin>/scripts/paseo-agent.mjs ensure --state <stateDir> --ticket <ticketId> \
  --directory <ticketDirectory> --title '<task title>' --prompt-file <task-file>
node <plugin>/scripts/paseo-agent.mjs wait --state <stateDir> --ticket <ticketId> --seconds 1200
node <plugin>/scripts/paseo-agent.mjs send --state <stateDir> --ticket <ticketId> \
  --request <unique-input-or-ci-result-id> --prompt-file <follow-up-file>
node <plugin>/scripts/paseo-agent.mjs status --state <stateDir> --ticket <ticketId>
```

1. `ensure` starts only the first task; on an existing binding it returns the existing Agent without submitting another turn. Choose thinking at creation: medium normally, high for discussing complex solutions or implementing complex requirements. Ordinary `send` calls omit `--thinking` and preserve the existing setting; only pass it to adjust when the work changes to a particularly difficult task. First supply the original task, source context, authorization, constraints and acceptance checks. The bridge prepends role, directory, branch and local-commit/publication boundaries.
2. For every subsequent request, use `send` with a stable input/result ID. Repeated IDs are not sent again; an uncertain dispatch receipt requires reading history, not a new ID to force a retry. Submit only when idle. Include incremental decisions, CI/PR feedback and necessary new context, not a reconstructed entire conversation.
3. Run `wait` as a DSH background shell job and let its completion wake you. No sleep/poll loop. Timeout leaves the Agent running: inspect returned activity and continue bounded waiting when appropriate. `idle` means turn ended, not task passed; `permission`, `error`, `timeout` and unfinished answers are not success. Read full relevant logs with `paseo --home <home> logs <agentId> --json` if the last 30 items omit the needed report.
4. Require a completion report. For code changes check only branch, git status, recent commits and necessary diff statistics against that report; do not rerun tests or review code. Relay research/Wiki results and links without repeating the work or fetching full content. Ask the same Agent only for missing required results, explicit errors or obvious mismatches. The delegated Agent makes small local commits; Worker pushes the assigned branch and dispatches remote CI for the actual SHA. Send logs and results back for analysis/fixes. Worker owns PR/review operations and Ticket reporting. Research/planning/Wiki work delivers the Agent’s reported result without forcing a PR. Explicitly authorized Wiki operations may be delegated; Git/PR publication and source-channel replies remain with Worker.
5. On delegated-Agent failure (quota, authentication, unavailable service or Agent error), stop and report the cause, partial outcome and resumption requirement. Never take over the work or silently switch Agent, model or account.
6. Reuse the binding after follow-ups/restarts. An archived/missing Agent, changed directory or unavailable daemon is a concrete blocker, not permission to create another conversation. Neither Ticket completion nor a CLI timeout deletes the workspace or Agent history.

The user can open the same conversation with `paseo --home <home> agent open <agentId>`. Direct UI messages are not automatically Superagent triggers. During manual takeover, pause/hold the Ticket; before resuming automation, read new activity and recheck scope, branch and commits. Do not send a new turn while the user is working.

## Cancellation

The executor calls the same CLI bridge's `stop` on Ticket stop and plugin shutdown. A stopped Agent retains its history. A stopped DSH waiting process alone cannot cancel an Agent owned by the Paseo daemon. If the daemon cannot be reached, surface that failure and verify the Agent before restarting work. A host crash cannot guarantee remote cancellation; reconcile the persisted binding and current status on recovery.

The official Paseo skill is useful reference, but its `notifyOnFinish` callback applies to Paseo parent Agents, not an external DSH Worker. Use the DSH background-job handoff above. CLI calls are account/prompt conventions, not an OS sandbox or a Git push prohibition enforced by this adapter.
