# Notion SSH Virtual Manager - Project Plan

## 1) Goal
Build a simple SSH-accessible virtual filesystem for Notion so you can:
- `ls` Notion pages/files with metadata (date, owner, size-like info)
- `cat` view content in Markdown
- `grep` search/filter content
- edit with terminal tools (`vim`/`nano` via file editing workflow)

Keep it small, practical, and easy to run.

## 2) Product Definition
### Core user story
"I SSH into a host and interact with my Notion workspace like a lightweight Unix filesystem."

### MVP scope (Phase 1)
- SSH server with virtual shell
- Virtual directories/files backed by Notion pages (all nested page levels, recursive)
- Commands: `pwd`, `ls`, `cd`, `cat`, `grep`, `mkdir` (optional), `touch` (optional), `exit`
- `edit <file>` command that opens `$EDITOR` and syncs back to Notion
- Markdown render of Notion page blocks (read + write)
- Database handling: skip full DB support in MVP; expose placeholders like `[db:<database_id>]`

### Phase 2 (after MVP)
- SFTP subsystem for better `vim`/`scp` compatibility
- Optional SSHFS mount support
- Better permissions and multi-user support

## 3) Proposed Architecture
## Tech stack
- Runtime: Node.js + TypeScript
- SSH layer: `ssh2`
- Notion API: `@notionhq/client`
- Markdown conversion:
  - Notion -> Markdown: `notion-to-md` (or custom serializer)
  - Markdown -> Notion blocks: custom converter for supported block set
- Config/validation: `zod`
- Logging: `pino`

## Components
1. `NotionGateway`
- Wraps Notion API calls (search, page fetch, block children, update blocks)
- Handles pagination + retries + rate-limit backoff

2. `VirtualFS`
- Maps path <-> Notion page IDs
- Stores metadata (owner, created/edited time, type)
- Provides operations: `list`, `readFile`, `writeFile`, `find`

3. `MarkdownEngine`
- Converts Notion block trees to Markdown
- Parses Markdown back into supported Notion blocks
- Keeps unsupported blocks as placeholder comments to avoid silent data loss

4. `SshSession`
- Per-user session context (`cwd`, identity, cache handle)
- Command parser and dispatcher (`ls`, `cat`, `grep`, etc.)

5. `EditorFlow`
- For `edit file.md`: writes content to temp file, launches `$EDITOR`, diffs content, pushes updates to Notion

## Path model
- `/` = workspace root
- `/pages/...` = recursive page tree (all nested page levels)
- Databases are not mounted in MVP; show read-only placeholders such as `[db:<database_id>]`
- Filenames slugified; collisions resolved with suffix (`-<short-id>`)

## 4) Command Behavior
### `ls -la`
- Shows: name, owner, last edited, pseudo-size (char count), type
- `-l` and `-a` partly supported in MVP (document exact supported flags)

### `cat <file>`
- Fetch page blocks -> render Markdown -> print

### `grep "<pattern>" <file|dir>`
- Simple text search on rendered Markdown
- Recursive on directories with `-r`

### Editing
- MVP: `edit <file>` command (safe and deterministic)
- Phase 2: native `vim file.md` over SFTP/SSHFS

## 5) Data Sync Strategy
- Read-through cache per session (TTL: 30-60s)
- Write-through updates on save
- Optimistic conflict check using `last_edited_time`
- If conflict: keep both versions and prompt user

## 6) Security Model
- SSH transport is used for terminal UX; hardening auth can be expanded after MVP
- Notion auth: integration API key via env var (`NOTION_API_KEY`)
- Workspace allowlist: restrict searchable pages if needed
- Secrets only from env/config, never committed

## 7) MVP Delivery Plan
## Milestone 0 - Bootstrap (Day 1)
- Repo scaffold (`src/`, `docs/`, `tests/`)
- TypeScript setup + lint + basic CI
- Config loader (`NOTION_API_KEY`, `SSH_HOST_KEY_PATH`, `PORT`)

## Milestone 1 - Read-only shell (Day 2-3)
- SSH server + session shell
- `pwd`, `ls`, `cd`, `cat`
- Notion page discovery and Markdown rendering

## Milestone 2 - Search + write (Day 4-5)
- `grep -r`
- `edit <file>` flow with `$EDITOR`
- Markdown -> Notion write path for core block types

## Milestone 3 - Hardening (Day 6)
- Rate-limit handling, retries, cache invalidation
- Error UX and logging improvements
- Basic integration tests

## Milestone 4 - Optional mount mode (Phase 2)
- SFTP subsystem
- SSHFS mount docs + compatibility matrix

## 8) Testing Strategy
- Unit tests:
  - path mapping
  - markdown conversion
  - command parser
- Integration tests (mock Notion API):
  - `ls`, `cat`, `grep`, `edit`
- Smoke test (manual):
  - SSH in, browse, edit, verify in Notion UI

## 9) Known Constraints / Risks
- Markdown round-trip is lossy for advanced Notion blocks
- Notion API rate limits can affect large recursive `grep`
- "True Unix semantics" (permissions, inode behavior) are only emulated

Mitigation:
- Explicit unsupported-block markers
- cache + backoff
- clear docs on supported behavior

## 10) Definition of Done (MVP)
- You can SSH in and run `ls`, `cat`, `grep`, `edit` against Notion-backed files
- File metadata displays owner/date reliably
- Edited Markdown persists back to Notion
- Setup from README takes <=10 minutes

## 11) Suggested Initial Repo Layout
```text
notion-ssh/
  docs/
    notion-ssh-virtual-manager-plan.md
  src/
    server.ts
    session/
      shell.ts
      commands/
    notion/
      gateway.ts
      markdown.ts
    vfs/
      index.ts
      path-map.ts
    config/
      env.ts
  tests/
  package.json
  README.md
```

## 12) Locked Decisions
1. Locked: `1A` -> pure SSH shell commands first (`edit` command), then SFTP/SSHFS later.
2. Locked (adjusted): recursive pages at all levels in MVP, databases skipped with placeholders (`[db:<id>]`).
3. Locked: Notion integration uses API key auth via env (`NOTION_API_KEY`).
