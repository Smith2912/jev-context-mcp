# Jev Context MCP

A local [Model Context Protocol](https://modelcontextprotocol.io/) server that uses TypeSafe Jev for bounded routing and evidence judgments. Codex keeps responsibility for source retrieval, permissions, tool execution, tests, and substantive review. Jev selects from registered choices; it does not run arbitrary commands or switch the model of an already running Codex task.

The package offers `triage_log`, `read_log_range`, `select_file_context`, `read_file_context`, `check_file_output`, and `route_task`. Registered workflow mode adds `prepare_work_packet`, `run_workflow_stage`, `get_run_report`, and `decide_computer_step`. The default configuration leaves registered workflow mode disabled.

## Install

Requires a recent Node.js version, Codex CLI for the optional native runner, and a TypeSafe API key for live Jev decisions. Without a key, the local evidence tools and deterministic fallback remain available.

```powershell
npm ci
Copy-Item settings.example.json settings.json
```

Edit the untracked `settings.json` to add only the absolute `allowedRoots` and `contextRoots` you want the server to read. The sample grants no file roots. Set `TYPESAFE_API_KEY` in the MCP process environment using your own secret manager; do not commit a key or put it in `settings.json`. On Windows, `launch.mjs` can optionally read a current-user DPAPI credential file configured locally as `credentialFile`, but that file must stay outside the repository.

Register the MCP server with an absolute path to this checkout:

```powershell
codex mcp add jev-context -- node C:\absolute\path\to\jev-context-mcp\launch.mjs
```

Restart the Codex MCP connection after registration. Run `npm test` to check the local code without making paid Jev calls.

## Using the tools

File tools resolve requested paths inside the configured roots and return bounded, redacted excerpts with source hashes. A changed file requires a new selection before range retrieval. Optional TypeSafe sharing is controlled per call with `shareWithTypeSafe`; leave it false for private material. Redaction is best effort, so inspect the material before authorizing external sharing.

`check_file_output` returns atomic scores, not a code review. `route_task` recommends a supported model, effort, skill references, and workflow profile but cannot change the active Codex task. `decide_computer_step` accepts a fresh text observation and caller-registered routine action IDs; it never supplies selectors, coordinates, typing, commands, or a visual judgment. The caller must perform and verify any selected action.

For advanced native execution, register a task manifest and its SHA-256 in your private `settings.json`, provide local artifact and limiter directories, and enable the workflow scheduler. The native hook accepts only `jev: workflow=<registered-id>`; all other prompts remain in their current task. Review the manifest's source roots, mutable files, tests, permissions, request limits, and review requirements before enabling it. The hook is optional and subject to Codex's own trust controls. The native runner persists separate builder and reviewer Codex tasks and reconciles their usage from completed sessions.

Native execution defaults to a hard spending contract. The current Codex CLI provides no pre-request token/request budget control, so the native CLI refuses those runs before dispatch. An operator may explicitly register `execution.spendingLimitMode: "observed"` in the pinned manifest to accept post-run request/token accounting ceilings. These ceilings detect overruns after usage is incurred; they do not prevent spending. Tool-call event stops and process timeouts remain active. No hard-budget live benchmark should use observed mode.

Native Codex workers receive only a runtime environment allowlist, including `CODEX_HOME`; TypeSafe and unrelated parent secrets are excluded. Native execution uses Codex's saved login rather than inherited API credentials. The separately launched MCP retains its provider credential. This does not isolate workers from secrets explicitly configured in other MCP servers, local files or shared operating-system permissions.

Opt-in skill refresh writes `.local/skill-catalog.json`, which Git ignores. Routing uses that generated local inventory when present and otherwise uses the tracked empty template. Refresh never overwrites the public template. Registered images are checked against canonical project paths again before dispatch; structured edits authorize exact canonical registered files.

## Public-release boundaries

This repository contains source, schemas, an empty skill catalog, examples, and local tests. It omits credentials, personal settings, local skill inventories, private logs, benchmark transcripts, generated candidates, and machine-specific installers. `settings.json`, `.env*`, `*.dpapi`, caches, and run artifacts are ignored. Do not loosen those exclusions when adding your own configuration.

No universal token or billing saving is claimed. Jev provider usage, Codex raw tokens, cached input, and quality gates must be measured separately on matched complete tasks. Jev's typed output is not a correctness guarantee; missing evidence, failed tests, and consequential decisions stay with Codex and deterministic checks.

Licensed under MIT. TypeSafe Jev and Codex are separate services with their own terms and usage accounting.
