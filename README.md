# notion-ssh

SSH virtual manager for Notion pages as Markdown files.

## What it does
- Exposes your Notion pages as a virtual tree under `/pages`
- Supports nested pages recursively
- Skips databases in MVP and shows placeholders like `[db:abcd1234]`
- Lets you run shell-like commands over SSH:
  - `ls`, `cd`, `pwd`, `cat`, `grep`, `touch`, `mkdir`, `edit` (`vim` alias), `refresh`

## Quick start
1. Install dependencies:
   ```bash
   npm install
   ```
2. Create env file:
   ```bash
   cp .env.example .env
   ```
3. Fill in `.env` with your Notion integration key:
   - `NOTION_API_KEY`
4. Start server in dev mode:
   ```bash
   npm run dev
   ```
5. SSH in from another terminal:
   ```bash
   ssh -p 2222 notion@127.0.0.1
   ```

Default dev password is `notion` unless changed in `.env`.

## Environment
See `.env.example` for the full list.

Required:
- `NOTION_API_KEY`

Useful options:
- `NOTION_ROOT_PAGE_ID`: limit scope to one page tree
- `SSH_PORT`: default `2222`
- `SSH_USERNAME` / `SSH_PASSWORD`: default `notion` / `notion`
- `SSH_ALLOW_ANY_PASSWORD`: set `true` for local testing only

## Command notes
- `cat <dir>` resolves to `<dir>/index.md`
- `vim <path>` is an alias to the built-in mini editor (not full-screen Vim)
- `grep -r <pattern> [path]` searches recursively
- `touch <name>` creates a new Notion page
- Shell prompt appears immediately; if the Notion index is cold, the first data command may show a sync message and take longer.

## Build and test
```bash
npm run build
npm test
```

## Security
This MVP is intentionally simple. For production use, harden SSH auth, isolate networking, and add role-based access controls.
