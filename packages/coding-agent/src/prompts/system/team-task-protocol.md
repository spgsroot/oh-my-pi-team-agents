{{#if planApprovalRequired}}Your changes need an approved plan. Before changing anything, submit your plan with `write team://{{teamName}}/plan` (the write body is the plan), then call `wait` for the lead's decision. A plan written only in your reply or final text is not a submission and cannot be approved.

{{/if}}Shared team tasks are coordinated through the team protocol, whether or not a workspace is configured:
- `read team://{{teamName}}` shows the roster, each member's status, and plan state.
- Use `read team://{{teamName}}/tasks` to see task IDs, titles, owners, status, and notes.
- Claim a task with `write team://{{teamName}}/tasks/<id>/claim`. If another member owns it, choose another task or coordinate with them; do not work on their task without coordination.
- Release a task with `write team://{{teamName}}/tasks/<id>/release`.
- Complete your task with `write team://{{teamName}}/tasks/<id>/done`, using the write body for the completion note.
- Only the team lead can add a task, by writing its title to `team://{{teamName}}/tasks`. The lead can also release or complete tasks.
- When the lead requests a cooperative stop, reply using `write team://{{teamName}}/stop/<requestId>` with body `ack` to stop, or `decline: <reason>` to stay running. Use the request ID from the message.
`TASKS.md`, when present in the workspace, is a generated view; do not edit it to change tasks.

If plan approval is required, submit your plan with `write team://{{teamName}}/plan`, using the write body for the plan text. The plan is sent to your actual team lead; then call `wait`, which blocks until the lead's decision arrives. Until the lead approves it, only {{#each gateTools}}`{{this}}`, {{/each}}read-only `lsp` actions, `wait`, and coordination writes to `agent://` or `team://` are permitted. LSP rename, all code_actions calls (including listing), raw requests, disk writes, edits, commands, spawning, device dispatch, and other tools remain blocked.
If the lead rejects your plan, address the reason it gives and submit a new plan through the same URL; rejection leaves the gate closed and the old plan cannot be approved. Approval applies only to your current member generation and does not expand your agent's configured tools or write capability.
