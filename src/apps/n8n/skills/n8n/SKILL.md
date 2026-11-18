---
name: n8n
description: Use only when the user names n8n, or continues work on an n8n workflow or Agent already in this conversation, and wants something in their connected n8n, such as building, changing, testing, debugging, publishing or explaining it. Otherwise use Nod's own tasks and schedules, even when n8n is connected.
---

# n8n

Work through the connected n8n MCP server. Its tools are named mcp__n8n__<tool>; load the ones you need with tool_search and follow the server's own guide in your context for how to build, validate and test.

- When the user names an existing workflow or Agent, find it and change it instead of building another.
- Keep workflow code in a workspace file such as `n8n/<short-name>.workflow.ts` and pass it to the n8n tools from codemode, so the code never goes into chat.
- Never create or ask for credentials: n8n asks the user for them during setup. For a value only the user can give, leave a placeholder and say so.
- Test with sample data before you report. A pinned step does not run, so check what it would have sent from the data it received, and say a path works only when an execution exercised it.
- A built workflow or Agent is a draft. Publish only when the user asks; after changing a published workflow, publish again or say the change is not live yet.

Show a workflow as a canvas. When the turn's channel is telegram, read [references/telegram.md](references/telegram.md) instead, because Telegram shows a picture, not the canvas. Otherwise, in codemode, write the workflow from get_workflow_details, with the url n8n returned, to `n8n/<short-name>.n8n.json`, then attach that file with share_file. For an n8n Agent, give its link instead.

```js
const workflowId = 'aBc123';
const url = 'https://you.app.n8n.cloud/workflow/aBc123';
const { workflow } = JSON.parse(await tools.mcp__n8n__get_workflow_details({ workflowId }));
await tools.write({
  path: 'n8n/order-alerts.n8n.json',
  content: JSON.stringify({ ...workflow, url }),
});
```

## Gateway tools

The same n8n account also serves the n8n Gateway as a second MCP server (named "n8n Gateway"). Its tools generate images and videos, search and scrape the web, and convert or read PDFs, billed to the instance's Gateway credits. For a one-off request, call these tools directly; do not build a workflow for it. Generated images come back as files: share them with share_file. A video job returns a task ID: poll its status tool until the video URL is ready.

End with one short message: what you built or changed, what you tested and with which data, what you could not test, and what the user still has to do.
