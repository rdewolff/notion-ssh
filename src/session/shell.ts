import readline from 'node:readline';

import type { Logger } from 'pino';

import { parseCommandLine } from './parser';
import type { FsEntry } from '../vfs/types';
import { VirtualFs } from '../vfs';

interface EditState {
  path: string;
  buffer: string[];
}

interface ListRenderOptions {
  includeDatabases: boolean;
  includeIndexFile: boolean;
}

const COMMANDS = [
  'help',
  'pwd',
  'ls',
  'tree',
  'cd',
  'cat',
  'grep',
  'touch',
  'mkdir',
  'edit',
  'vim',
  'refresh',
  'exit',
  'quit',
  'logout'
];

function formatTime(value?: string): string {
  if (!value) {
    return '-';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }

  return date.toISOString().replace('T', ' ').slice(0, 16);
}

function modeForEntry(entry: FsEntry): string {
  if (entry.type === 'dir') {
    return 'drwxr-xr-x';
  }
  if (entry.type === 'db') {
    return '-r--r--r--';
  }
  return '-rw-r--r--';
}

function nameForEntry(entry: FsEntry): string {
  if (entry.type === 'dir') {
    return `${entry.name}/`;
  }
  return entry.name;
}

export class ShellSession {
  private cwd = '/pages';
  private editState: EditState | null = null;
  private isClosed = false;
  private lastCachedNoticeAt = 0;
  private readonly rl: readline.Interface;

  constructor(
    private readonly channel: any,
    private readonly vfs: VirtualFs,
    private readonly logger: Logger
  ) {
    this.rl = readline.createInterface({
      input: this.channel,
      output: this.channel,
      terminal: true,
      completer: (line: string) => this.completeLine(line)
    });
  }

  async start(): Promise<void> {
    this.writeLine('Notion SSH Virtual Manager');
    this.writeLine('Type "help" for commands.');
    if (!this.vfs.isIndexed()) {
      this.writeLine('Index warm-up started in background. First data command may take longer.');
    }
    this.writePrompt();

    const start = Date.now();
    void this.vfs
      .refresh(false)
      .then(() => {
        this.logger.info({ durationMs: Date.now() - start }, 'Background Notion index warm-up completed');
      })
      .catch((error) => {
        this.logger.error({ err: error }, 'Failed to refresh virtual filesystem during session start');
        if (!this.channel.destroyed) {
          this.writeLine(`warning: failed to load Notion index: ${(error as Error).message}`);
        }
      });

    this.rl.on('line', (line) => {
      void this.handleLine(line);
    });

    this.rl.on('close', () => {
      this.isClosed = true;
      if (!this.channel.destroyed) {
        this.channel.end();
      }
    });
  }

  async runOneCommand(commandLine: string): Promise<void> {
    await this.dispatch(commandLine);
  }

  private write(text: string): void {
    if (this.isClosed || this.channel.destroyed) {
      return;
    }
    this.channel.write(text);
  }

  private writeLine(text: string): void {
    this.write(`${text}\r\n`);
  }

  private promptLabel(): string {
    if (this.editState) {
      return 'edit> ';
    }
    return `notion:${this.cwd}$ `;
  }

  private writePrompt(): void {
    if (this.isClosed || this.channel.destroyed) {
      return;
    }
    this.rl.setPrompt(this.promptLabel());
    this.rl.prompt();
  }

  private async handleLine(line: string): Promise<void> {
    try {
      if (this.editState) {
        await this.handleEditLine(line);
      } else {
        await this.dispatch(line);
      }
    } catch (error) {
      this.writeLine(`error: ${(error as Error).message}`);
    }

    if (!this.isClosed && !this.channel.destroyed) {
      this.writePrompt();
    }
  }

  private printHelp(): void {
    this.writeLine('Available commands:');
    this.writeLine('  (Tab completion available for commands and paths)');
    this.writeLine('  help                         Show this help');
    this.writeLine('  pwd                          Print current directory');
    this.writeLine('  ls [-l] [-a|--all] [--db] [path] List files/pages');
    this.writeLine('  cd <path>                    Change directory');
    this.writeLine('  cat <file|dir>               Print Markdown content');
    this.writeLine('  grep [-r] [-i] <pat> [path]  Search in Markdown files');
    this.writeLine('  tree [-L depth] [--db] [path] Print directory tree (default depth: 2)');
    this.writeLine('  touch <path>                 Create a new page');
    this.writeLine('  mkdir <path>                 Create a new page directory');
    this.writeLine('  edit <file|dir>              Open mini editor');
    this.writeLine('  vim <file|dir>               Alias to edit');
    this.writeLine('  refresh                      Rebuild Notion index');
    this.writeLine('  exit                         Exit session');
  }

  private printLongLs(entries: FsEntry[]): void {
    for (const entry of entries) {
      const owner = (entry.meta.owner ?? '-').slice(0, 24).padEnd(24, ' ');
      const edited = formatTime(entry.meta.lastEditedTime);
      const sizeHint = entry.type === 'dir' ? entry.children.size : 0;
      this.writeLine(
        `${modeForEntry(entry)}  ${owner}  ${edited}  ${String(sizeHint).padStart(6, ' ')}  ${nameForEntry(entry)}`
      );
    }
  }

  private printShortLs(entries: FsEntry[]): void {
    if (entries.length === 0) {
      this.writeLine('(empty)');
      return;
    }

    for (const entry of entries) {
      const kind = entry.type === 'dir' ? 'd' : entry.type === 'db' ? 'D' : 'f';
      this.writeLine(`${kind} ${nameForEntry(entry)}`);
    }
  }

  private renderHiddenSummary(hiddenDatabases: number, hiddenIndex: number): void {
    const chunks: string[] = [];
    if (hiddenDatabases > 0) {
      chunks.push(`${hiddenDatabases} database placeholders hidden (--db to show)`);
    }
    if (hiddenIndex > 0) {
      chunks.push(`${hiddenIndex} index.md hidden (--all to show)`);
    }
    if (chunks.length > 0) {
      this.writeLine(`(${chunks.join(', ')})`);
    }
  }

  private filterEntries(entries: FsEntry[], options: ListRenderOptions): {
    visible: FsEntry[];
    hiddenDatabases: number;
    hiddenIndex: number;
  } {
    let hiddenDatabases = 0;
    let hiddenIndex = 0;
    const visible: FsEntry[] = [];

    for (const entry of entries) {
      if (!options.includeDatabases && entry.type === 'db') {
        hiddenDatabases += 1;
        continue;
      }
      if (!options.includeIndexFile && entry.type === 'file' && entry.name === 'index.md') {
        hiddenIndex += 1;
        continue;
      }
      visible.push(entry);
    }

    return { visible, hiddenDatabases, hiddenIndex };
  }

  private completeLine(line: string): [string[], string] {
    if (this.editState) {
      return [[], line];
    }

    const endsWithSpace = /\s$/.test(line);
    const trimmed = line.trimStart();
    const parts = trimmed.length > 0 ? trimmed.split(/\s+/) : [];
    if (parts.length === 0) {
      return [COMMANDS.slice(), line];
    }

    const command = parts[0].toLowerCase();
    if (parts.length === 1 && !endsWithSpace) {
      const matches = COMMANDS.filter((candidate) => candidate.startsWith(command));
      return [matches.length > 0 ? matches : COMMANDS.slice(), command];
    }

    const pathCommands = new Set(['ls', 'tree', 'cd', 'cat', 'touch', 'mkdir', 'edit', 'vim']);
    if (!pathCommands.has(command)) {
      return [[], line];
    }

    const token = endsWithSpace ? '' : parts[parts.length - 1];
    if (token.startsWith('-')) {
      return [[], token];
    }

    const tokenDir = token.includes('/') ? token.slice(0, token.lastIndexOf('/')) : '';
    const prefix = token.includes('/') ? token.slice(token.lastIndexOf('/') + 1) : token;
    const lookupPath = token.startsWith('/')
      ? tokenDir || '/'
      : tokenDir.length > 0
        ? tokenDir
        : '.';

    let entries: FsEntry[] = [];
    try {
      entries = this.vfs.list(lookupPath, this.cwd);
    } catch {
      return [[], token];
    }

    const candidates = entries
      .filter((entry) => {
        if (entry.type === 'db') {
          return false;
        }
        if (command === 'cd') {
          return entry.type === 'dir';
        }
        return true;
      })
      .map((entry) => {
        const leaf = entry.type === 'dir' ? `${entry.name}/` : entry.name;
        if (token.startsWith('/')) {
          const baseDir = tokenDir || '/';
          return baseDir === '/' ? `/${leaf}` : `${baseDir}/${leaf}`;
        }
        if (tokenDir.length > 0) {
          return `${tokenDir}/${leaf}`;
        }
        return leaf;
      })
      .filter((candidate) => {
        const normalized = candidate.endsWith('/') ? candidate.slice(0, -1) : candidate;
        const basename = normalized.split('/').pop() ?? '';
        return basename.startsWith(prefix);
      })
      .sort((a, b) => a.localeCompare(b));

    return [candidates, token];
  }

  private expandPathPrefix(pathInput: string, dirOnly: boolean): string {
    const resolved = this.vfs.resolve(pathInput, this.cwd);
    const existing = this.vfs.stat(resolved, this.cwd);
    if (existing) {
      return resolved;
    }

    const slash = resolved.lastIndexOf('/');
    const parentPath = slash > 0 ? resolved.slice(0, slash) : '/';
    const needle = resolved.slice(slash + 1);
    if (needle.length === 0) {
      return resolved;
    }

    const parent = this.vfs.stat(parentPath, this.cwd);
    if (!parent || parent.type !== 'dir') {
      return resolved;
    }

    const matches = this.vfs
      .list(parentPath, this.cwd)
      .filter((entry) => (!dirOnly || entry.type === 'dir') && entry.type !== 'db')
      .filter((entry) => entry.name.startsWith(needle));

    if (matches.length === 1) {
      return matches[0].path;
    }

    if (matches.length > 1) {
      const labels = matches.slice(0, 8).map((entry) => nameForEntry(entry));
      throw new Error(`Ambiguous path "${pathInput}": ${labels.join(', ')}`);
    }

    return resolved;
  }

  private printTree(pathInput: string, cwd: string, maxDepth: number, options: ListRenderOptions): void {
    const root = this.vfs.stat(pathInput, cwd);
    if (!root) {
      throw new Error(`No such path: ${this.vfs.resolve(pathInput, cwd)}`);
    }
    if (root.type !== 'dir') {
      throw new Error(`Not a directory: ${root.path}`);
    }

    const rootLabel = root.path === '/pages' ? 'pages/' : `${root.name}/`;
    this.writeLine(rootLabel);
    let hiddenDatabases = 0;
    let hiddenIndex = 0;

    const walk = (dirPath: string, prefix: string, depthLeft: number): void => {
      if (depthLeft <= 0) {
        return;
      }

      const filtered = this.filterEntries(this.vfs.list(dirPath, cwd), options);
      hiddenDatabases += filtered.hiddenDatabases;
      hiddenIndex += filtered.hiddenIndex;
      const children = filtered.visible;
      if (children.length === 0 && prefix.length === 0) {
        this.writeLine('(empty)');
      }
      for (let i = 0; i < children.length; i += 1) {
        const child = children[i];
        const isLast = i === children.length - 1;
        const branch = isLast ? '`-- ' : '|-- ';
        this.writeLine(`${prefix}${branch}${nameForEntry(child)}`);

        if (child.type === 'dir') {
          const nextPrefix = `${prefix}${isLast ? '    ' : '|   '}`;
          walk(child.path, nextPrefix, depthLeft - 1);
        }
      }
    };

    walk(root.path, '', maxDepth);
    this.renderHiddenSummary(hiddenDatabases, hiddenIndex);
  }

  private async dispatch(commandLine: string): Promise<void> {
    const parsed = parseCommandLine(commandLine);
    const command = parsed.command.toLowerCase();

    if (!command) {
      return;
    }

    if (command === 'help') {
      this.printHelp();
      return;
    }

    if (command === 'pwd') {
      this.writeLine(this.cwd);
      return;
    }

    if (command === 'ls') {
      await this.ensureIndexed();

      let longFormat = false;
      let target = this.cwd;
      let includeDatabases = false;
      let includeIndexFile = false;

      for (const arg of parsed.args) {
        if (arg.startsWith('-')) {
          if (arg.includes('l')) {
            longFormat = true;
          }
          if (arg.includes('a')) {
            includeDatabases = true;
            includeIndexFile = true;
          }
          if (arg === '--db') {
            includeDatabases = true;
          }
          if (arg === '--all') {
            includeDatabases = true;
            includeIndexFile = true;
          }
          continue;
        }
        target = arg;
      }

      const filtered = this.filterEntries(this.vfs.list(target, this.cwd), {
        includeDatabases,
        includeIndexFile
      });
      const entries = filtered.visible;
      if (longFormat) {
        this.printLongLs(entries);
      } else {
        this.printShortLs(entries);
      }
      this.renderHiddenSummary(filtered.hiddenDatabases, filtered.hiddenIndex);
      return;
    }

    if (command === 'cd') {
      await this.ensureIndexed();

      const targetInput = parsed.args[0] ?? '/pages';
      const target = this.expandPathPrefix(targetInput, true);
      const entry = this.vfs.stat(target, this.cwd);
      if (!entry) {
        throw new Error(`No such path: ${this.vfs.resolve(targetInput, this.cwd)}`);
      }
      if (entry.type !== 'dir') {
        throw new Error(`Not a directory: ${entry.path}`);
      }
      this.cwd = entry.path;
      return;
    }

    if (command === 'cat') {
      await this.ensureIndexed();

      const target = parsed.args[0];
      if (!target) {
        throw new Error('Usage: cat <file|dir>');
      }
      const content = await this.vfs.readFile(target, this.cwd);
      if (content.length > 0) {
        this.writeLine(content);
      }
      return;
    }

    if (command === 'grep') {
      await this.ensureIndexed();

      let recursive = false;
      let ignoreCase = false;
      const positional: string[] = [];

      for (const arg of parsed.args) {
        if (arg === '-r') {
          recursive = true;
          continue;
        }
        if (arg === '-i') {
          ignoreCase = true;
          continue;
        }
        positional.push(arg);
      }

      if (positional.length === 0) {
        throw new Error('Usage: grep [-r] [-i] <pattern> [path]');
      }

      const pattern = positional[0];
      const target = positional[1] ?? this.cwd;
      const matches = await this.vfs.grep(pattern, target, this.cwd, recursive, ignoreCase);
      for (const match of matches) {
        this.writeLine(`${match.path}:${match.lineNumber}:${match.line}`);
      }
      if (matches.length === 0) {
        this.writeLine('(no matches)');
      }
      return;
    }

    if (command === 'tree') {
      await this.ensureIndexed();

      let target = this.cwd;
      let depth = 2;
      let includeDatabases = false;
      const args = [...parsed.args];
      for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '-L') {
          const depthValue = args[i + 1];
          if (!depthValue) {
            throw new Error('Usage: tree [-L depth] [path]');
          }
          const parsedDepth = Number(depthValue);
          if (!Number.isInteger(parsedDepth) || parsedDepth <= 0) {
            throw new Error(`Invalid tree depth: ${depthValue}`);
          }
          depth = parsedDepth;
          i += 1;
          continue;
        }
        if (arg === '--db') {
          includeDatabases = true;
          continue;
        }

        target = arg;
      }

      this.printTree(target, this.cwd, depth, {
        includeDatabases,
        includeIndexFile: false
      });
      return;
    }

    if (command === 'touch') {
      await this.ensureIndexed();

      const target = parsed.args[0];
      if (!target) {
        throw new Error('Usage: touch <path>');
      }
      const created = await this.vfs.touch(target, this.cwd);
      this.writeLine(`created ${created}`);
      return;
    }

    if (command === 'mkdir') {
      await this.ensureIndexed();

      const target = parsed.args[0];
      if (!target) {
        throw new Error('Usage: mkdir <path>');
      }
      const created = await this.vfs.mkdir(target, this.cwd);
      this.writeLine(`created ${created}`);
      return;
    }

    if (command === 'refresh') {
      await this.ensureIndexed(true);
      this.writeLine('index refreshed');
      return;
    }

    if (command === 'edit' || command === 'vim') {
      await this.ensureIndexed();

      const target = parsed.args[0];
      if (!target) {
        throw new Error(`Usage: ${command} <file|dir>`);
      }
      await this.enterEditMode(target);
      return;
    }

    if (command === 'exit' || command === 'quit' || command === 'logout') {
      this.isClosed = true;
      this.rl.close();
      return;
    }

    throw new Error(`Unknown command: ${command}`);
  }

  private async ensureIndexed(force = false): Promise<void> {
    if (force) {
      this.writeLine('(syncing Notion index...)');
      const start = Date.now();
      await this.vfs.refresh(true);
      const durationMs = Date.now() - start;
      this.writeLine(`(Notion index ready in ${durationMs}ms)`);
      if (durationMs > 750) {
        this.logger.info({ durationMs, force: true }, 'Notion index sync completed');
      }
      return;
    }

    if (!this.vfs.isIndexed()) {
      this.writeLine('(syncing Notion index...)');
      const start = Date.now();
      await this.vfs.refresh(false);
      const durationMs = Date.now() - start;
      this.writeLine(`(Notion index ready in ${durationMs}ms)`);
      if (durationMs > 750) {
        this.logger.info({ durationMs, force: false }, 'Notion index sync completed');
      }
      return;
    }

    const startedAt = Date.now();
    void this.vfs
      .refresh(false)
      .then(() => {
        const durationMs = Date.now() - startedAt;
        if (durationMs > 750) {
          this.logger.info({ durationMs, force: false }, 'Background Notion index refresh completed');
        }
      })
      .catch((error) => {
        this.logger.warn({ err: error }, 'Background Notion index refresh failed');
      });

    if (this.vfs.isRefreshing()) {
      const now = Date.now();
      if (now - this.lastCachedNoticeAt > 15000) {
        this.writeLine('(using cached index while background refresh runs)');
        this.lastCachedNoticeAt = now;
      }
    }
  }

  private printEditBuffer(): void {
    if (!this.editState) {
      return;
    }

    if (this.editState.buffer.length === 0) {
      this.writeLine('(empty buffer)');
      return;
    }

    for (let i = 0; i < this.editState.buffer.length; i += 1) {
      this.writeLine(`${String(i + 1).padStart(4, ' ')}  ${this.editState.buffer[i]}`);
    }
  }

  private async enterEditMode(target: string): Promise<void> {
    let pathForWrite = target;
    let content = '';
    try {
      content = await this.vfs.readFile(target, this.cwd);
    } catch {
      pathForWrite = await this.vfs.touch(target, this.cwd);
      content = await this.vfs.readFile(pathForWrite, this.cwd);
    }

    const resolved = this.vfs.resolve(pathForWrite, this.cwd);
    this.editState = {
      path: resolved,
      buffer: content.length > 0 ? content.split('\n') : []
    };

    this.writeLine(`-- EDIT MODE: ${resolved} --`);
    this.writeLine('Commands: :wq save+quit, :q! quit, :p print, :clear, :set <n> <text>, :del <n>, :append <text>');
    this.printEditBuffer();
  }

  private async handleEditLine(line: string): Promise<void> {
    if (!this.editState) {
      return;
    }

    const trimmed = line.trim();

    if (trimmed === ':q!') {
      this.editState = null;
      this.writeLine('edit cancelled');
      return;
    }

    if (trimmed === ':wq') {
      const payload = this.editState.buffer.join('\n');
      await this.vfs.writeFile(this.editState.path, payload, this.cwd);
      this.writeLine(`saved ${this.editState.path}`);
      this.editState = null;
      return;
    }

    if (trimmed === ':p') {
      this.printEditBuffer();
      return;
    }

    if (trimmed === ':clear') {
      this.editState.buffer = [];
      this.writeLine('buffer cleared');
      return;
    }

    if (trimmed.startsWith(':set ')) {
      const match = trimmed.match(/^:set\s+(\d+)\s+(.*)$/);
      if (!match) {
        throw new Error('Usage: :set <line> <text>');
      }
      const index = Number(match[1]) - 1;
      if (index < 0 || index >= this.editState.buffer.length) {
        throw new Error(`Line out of range: ${match[1]}`);
      }
      this.editState.buffer[index] = match[2];
      return;
    }

    if (trimmed.startsWith(':del ')) {
      const match = trimmed.match(/^:del\s+(\d+)$/);
      if (!match) {
        throw new Error('Usage: :del <line>');
      }
      const index = Number(match[1]) - 1;
      if (index < 0 || index >= this.editState.buffer.length) {
        throw new Error(`Line out of range: ${match[1]}`);
      }
      this.editState.buffer.splice(index, 1);
      return;
    }

    if (trimmed.startsWith(':append ')) {
      this.editState.buffer.push(trimmed.slice(':append '.length));
      return;
    }

    this.editState.buffer.push(line);
  }
}
