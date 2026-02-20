import readline from 'node:readline';

import type { Logger } from 'pino';

import { parseCommandLine } from './parser';
import type { FsEntry } from '../vfs/types';
import { VirtualFs } from '../vfs';

interface EditState {
  path: string;
  buffer: string[];
}

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
  private readonly rl: readline.Interface;

  constructor(
    private readonly channel: any,
    private readonly vfs: VirtualFs,
    private readonly logger: Logger
  ) {
    this.rl = readline.createInterface({
      input: this.channel,
      output: this.channel,
      terminal: true
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
    this.writeLine('  help                         Show this help');
    this.writeLine('  pwd                          Print current directory');
    this.writeLine('  ls [-l] [path]               List files/pages');
    this.writeLine('  cd <path>                    Change directory');
    this.writeLine('  cat <file|dir>               Print Markdown content');
    this.writeLine('  grep [-r] [-i] <pat> [path]  Search in Markdown files');
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
    const names = entries.map(nameForEntry);
    this.writeLine(names.join('  '));
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

      for (const arg of parsed.args) {
        if (arg.startsWith('-')) {
          if (arg.includes('l')) {
            longFormat = true;
          }
          continue;
        }
        target = arg;
      }

      const entries = this.vfs.list(target, this.cwd);
      if (longFormat) {
        this.printLongLs(entries);
      } else {
        this.printShortLs(entries);
      }
      return;
    }

    if (command === 'cd') {
      await this.ensureIndexed();

      const target = parsed.args[0] ?? '/pages';
      const entry = this.vfs.stat(target, this.cwd);
      if (!entry) {
        throw new Error(`No such path: ${this.vfs.resolve(target, this.cwd)}`);
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
    const needsNotice = !this.vfs.isIndexed() || this.vfs.isRefreshing() || force;
    if (needsNotice) {
      this.writeLine('(syncing Notion index...)');
    }

    const start = Date.now();
    await this.vfs.refresh(force);
    const durationMs = Date.now() - start;

    if (needsNotice) {
      this.writeLine(`(Notion index ready in ${durationMs}ms)`);
    }

    if (durationMs > 750) {
      this.logger.info({ durationMs, force }, 'Notion index sync completed');
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
