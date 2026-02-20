import path from 'node:path';

import slugify from 'slugify';

import { NotionGateway, type NotionRecordMeta } from '../notion/gateway';
import { parentPathOf, resolveVirtualPath } from '../utils/path';
import type { DbPlaceholderEntry, DirEntry, FileEntry, FsEntry, GrepMatch } from './types';

const posix = path.posix;

interface MarkdownCacheEntry {
  markdown: string;
  fetchedAt: number;
  lastEditedTime: string | undefined;
}

function shortId(id: string): string {
  return id.replace(/-/g, '').slice(0, 8);
}

function slugFromTitle(title: string): string {
  const slugged = slugify(title, { lower: true, strict: true, trim: true });
  return slugged.length > 0 ? slugged : 'untitled';
}

function uniqueName(baseName: string, usedNames: Set<string>, fallbackId: string): string {
  if (!usedNames.has(baseName)) {
    usedNames.add(baseName);
    return baseName;
  }

  const withId = `${baseName}-${shortId(fallbackId)}`;
  if (!usedNames.has(withId)) {
    usedNames.add(withId);
    return withId;
  }

  let i = 2;
  while (usedNames.has(`${withId}-${i}`)) {
    i += 1;
  }
  const candidate = `${withId}-${i}`;
  usedNames.add(candidate);
  return candidate;
}

export class VirtualFs {
  private readonly entries = new Map<string, FsEntry>();
  private readonly pageDirPathById = new Map<string, string>();
  private readonly cache = new Map<string, MarkdownCacheEntry>();
  private readonly notionPages = new Map<string, NotionRecordMeta>();
  private readonly ttlMs: number;
  private refreshPromise: Promise<void> | null = null;
  private lastRefreshAt = 0;
  private indexedAtLeastOnce = false;

  constructor(
    private readonly notion: NotionGateway,
    cacheTtlSeconds: number,
    private readonly rootPageId?: string
  ) {
    this.ttlMs = cacheTtlSeconds * 1000;
    this.reset();
  }

  private reset(): void {
    this.entries.clear();
    this.pageDirPathById.clear();
    this.notionPages.clear();

    this.entries.set('/', {
      type: 'dir',
      name: '/',
      path: '/',
      parentPath: '/',
      children: new Set(['/pages']),
      meta: {}
    });

    this.entries.set('/pages', {
      type: 'dir',
      name: 'pages',
      path: '/pages',
      parentPath: '/',
      children: new Set(),
      meta: {}
    });
  }

  private ensureParentDir(parentPath: string): DirEntry {
    const entry = this.entries.get(parentPath);
    if (!entry || entry.type !== 'dir') {
      throw new Error(`Parent directory missing for ${parentPath}`);
    }
    return entry;
  }

  private addDir(pathname: string, name: string, parentPath: string, meta: DirEntry['meta']): DirEntry {
    const parent = this.ensureParentDir(parentPath);
    const entry: DirEntry = {
      type: 'dir',
      name,
      path: pathname,
      parentPath,
      children: new Set(),
      meta
    };

    this.entries.set(pathname, entry);
    parent.children.add(pathname);
    return entry;
  }

  private addPageFile(pathname: string, parentPath: string, page: NotionRecordMeta): FileEntry {
    const parent = this.ensureParentDir(parentPath);
    const entry: FileEntry = {
      type: 'file',
      name: 'index.md',
      path: pathname,
      parentPath,
      readonly: false,
      pageId: page.id,
      meta: {
        pageId: page.id,
        owner: page.owner,
        createdTime: page.createdTime,
        lastEditedTime: page.lastEditedTime
      }
    };

    this.entries.set(pathname, entry);
    parent.children.add(pathname);
    return entry;
  }

  private addDbPlaceholder(pathname: string, name: string, parentPath: string, database: NotionRecordMeta): DbPlaceholderEntry {
    const parent = this.ensureParentDir(parentPath);
    const entry: DbPlaceholderEntry = {
      type: 'db',
      name,
      path: pathname,
      parentPath,
      readonly: true,
      databaseId: database.id,
      meta: {
        databaseId: database.id,
        owner: database.owner,
        createdTime: database.createdTime,
        lastEditedTime: database.lastEditedTime
      }
    };

    this.entries.set(pathname, entry);
    parent.children.add(pathname);
    return entry;
  }

  resolve(pathInput: string, cwd: string): string {
    return resolveVirtualPath(pathInput, cwd);
  }

  isIndexed(): boolean {
    return this.indexedAtLeastOnce;
  }

  isRefreshing(): boolean {
    return this.refreshPromise !== null;
  }

  private entryAt(pathInput: string, cwd = '/'): FsEntry | undefined {
    return this.entries.get(this.resolve(pathInput, cwd));
  }

  private ensureDir(pathInput: string, cwd = '/'): DirEntry {
    const entry = this.entryAt(pathInput, cwd);
    if (!entry) {
      throw new Error(`Path does not exist: ${this.resolve(pathInput, cwd)}`);
    }
    if (entry.type !== 'dir') {
      throw new Error(`Not a directory: ${entry.path}`);
    }
    return entry;
  }

  private ensurePageFile(pathInput: string, cwd = '/'): FileEntry {
    const resolved = this.resolve(pathInput, cwd);
    const direct = this.entries.get(resolved);

    if (direct?.type === 'file') {
      return direct;
    }

    if (direct?.type === 'dir') {
      const indexPath = posix.join(direct.path, 'index.md');
      const indexEntry = this.entries.get(indexPath);
      if (indexEntry?.type === 'file') {
        return indexEntry;
      }
    }

    if (direct?.type === 'db') {
      throw new Error(`Read-only database placeholder: ${direct.path}`);
    }

    throw new Error(`File does not exist: ${resolved}`);
  }

  private collectPageFilesRecursively(dirPath: string): FileEntry[] {
    const dir = this.entries.get(dirPath);
    if (!dir || dir.type !== 'dir') {
      return [];
    }

    const files: FileEntry[] = [];
    for (const childPath of dir.children) {
      const child = this.entries.get(childPath);
      if (!child) {
        continue;
      }

      if (child.type === 'file') {
        files.push(child);
      } else if (child.type === 'dir') {
        files.push(...this.collectPageFilesRecursively(child.path));
      }
    }

    return files;
  }

  private findUniquePath(parentPath: string, filename: string): string {
    if (!this.entries.has(posix.join(parentPath, filename))) {
      return posix.join(parentPath, filename);
    }

    let i = 2;
    while (this.entries.has(posix.join(parentPath, `${filename}-${i}`))) {
      i += 1;
    }

    return posix.join(parentPath, `${filename}-${i}`);
  }

  async refresh(force = true): Promise<void> {
    const now = Date.now();
    const refreshIsFresh = this.indexedAtLeastOnce && now - this.lastRefreshAt < this.ttlMs;
    if (!force && refreshIsFresh) {
      return;
    }

    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = (async () => {
      const { pages, databases } = await this.notion.listRecords(this.rootPageId);

      this.reset();
      for (const page of pages) {
        this.notionPages.set(page.id, page);
      }

      const eligiblePages = pages.filter((page) => page.parent?.type !== 'database_id');
      const childrenByParentPage = new Map<string, NotionRecordMeta[]>();
      const roots: NotionRecordMeta[] = [];

      for (const page of eligiblePages) {
        const parent = page.parent;
        if (parent?.type === 'page_id') {
          if (!this.notionPages.has(parent.page_id)) {
            roots.push(page);
            continue;
          }

          const children = childrenByParentPage.get(parent.page_id) ?? [];
          children.push(page);
          childrenByParentPage.set(parent.page_id, children);
        } else {
          roots.push(page);
        }
      }

      const siblingNamesByPath = new Map<string, Set<string>>();

      const buildPageTree = (page: NotionRecordMeta, parentPath: string): void => {
        const used = siblingNamesByPath.get(parentPath) ?? new Set<string>();
        siblingNamesByPath.set(parentPath, used);

        const base = slugFromTitle(page.title);
        const dirName = uniqueName(base, used, page.id);
        const dirPath = posix.join(parentPath, dirName);

        this.addDir(dirPath, dirName, parentPath, {
          pageId: page.id,
          owner: page.owner,
          createdTime: page.createdTime,
          lastEditedTime: page.lastEditedTime
        });
        this.pageDirPathById.set(page.id, dirPath);

        this.addPageFile(posix.join(dirPath, 'index.md'), dirPath, page);

        const children = childrenByParentPage.get(page.id) ?? [];
        children.sort((a, b) => a.title.localeCompare(b.title));
        for (const child of children) {
          buildPageTree(child, dirPath);
        }
      };

      roots.sort((a, b) => a.title.localeCompare(b.title));
      for (const root of roots) {
        buildPageTree(root, '/pages');
      }

      const dbNamesByParent = new Map<string, Set<string>>();
      for (const database of databases) {
        let parentPath = '/pages';
        if (database.parent?.type === 'page_id') {
          const parentDir = this.pageDirPathById.get(database.parent.page_id);
          if (parentDir) {
            parentPath = parentDir;
          }
        }

        const used = dbNamesByParent.get(parentPath) ?? new Set<string>();
        dbNamesByParent.set(parentPath, used);

        const base = `[db:${shortId(database.id)}]`;
        const name = uniqueName(base, used, database.id);
        const dbPath = this.findUniquePath(parentPath, name);
        this.addDbPlaceholder(dbPath, name, parentPath, database);
      }

      this.indexedAtLeastOnce = true;
      this.lastRefreshAt = Date.now();
    })().finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  list(pathInput: string, cwd = '/'): FsEntry[] {
    const directory = this.ensureDir(pathInput, cwd);

    const children = Array.from(directory.children)
      .map((childPath) => this.entries.get(childPath))
      .filter((child): child is FsEntry => Boolean(child));

    return children.sort((a, b) => {
      if (a.type === b.type) {
        return a.name.localeCompare(b.name);
      }
      if (a.type === 'dir') {
        return -1;
      }
      if (b.type === 'dir') {
        return 1;
      }
      return a.name.localeCompare(b.name);
    });
  }

  stat(pathInput: string, cwd = '/'): FsEntry | undefined {
    const resolved = this.resolve(pathInput, cwd);
    return this.entries.get(resolved);
  }

  async readFile(pathInput: string, cwd = '/'): Promise<string> {
    const resolved = this.resolve(pathInput, cwd);
    const entry = this.entries.get(resolved);
    if (entry?.type === 'db') {
      return `# Database Placeholder\n\n[db:${entry.databaseId}]\n\nDatabase mounting is disabled in MVP.`.trim();
    }

    const file = this.ensurePageFile(pathInput, cwd);
    const cached = this.cache.get(file.pageId);
    if (cached && Date.now() - cached.fetchedAt < this.ttlMs) {
      return cached.markdown;
    }

    const markdown = await this.notion.readPageMarkdown(file.pageId);
    this.cache.set(file.pageId, {
      markdown,
      fetchedAt: Date.now(),
      lastEditedTime: file.meta.lastEditedTime
    });

    return markdown;
  }

  async writeFile(pathInput: string, markdown: string, cwd = '/'): Promise<void> {
    const resolved = this.resolve(pathInput, cwd);
    const entry = this.entries.get(resolved);
    if (entry?.type === 'db') {
      throw new Error(`Cannot write to database placeholder: ${entry.path}`);
    }

    const file = this.ensurePageFile(pathInput, cwd);
    const remoteMeta = await this.notion.getPageMeta(file.pageId);
    const expectedLastEditedTime = file.meta.lastEditedTime;
    if (
      expectedLastEditedTime &&
      remoteMeta.lastEditedTime &&
      remoteMeta.lastEditedTime !== expectedLastEditedTime
    ) {
      throw new Error(
        `Conflict detected for ${file.path}. Remote page changed since last sync (remote: ${remoteMeta.lastEditedTime}, local: ${expectedLastEditedTime}). Run refresh and merge manually.`
      );
    }

    await this.notion.replacePageMarkdown(file.pageId, markdown);
    const updatedMeta = await this.notion.getPageMeta(file.pageId);
    file.meta.lastEditedTime = updatedMeta.lastEditedTime;
    file.meta.owner = updatedMeta.owner;

    this.cache.set(file.pageId, {
      markdown,
      fetchedAt: Date.now(),
      lastEditedTime: file.meta.lastEditedTime
    });
  }

  async grep(
    pattern: string,
    targetPath: string,
    cwd: string,
    recursive: boolean,
    ignoreCase: boolean
  ): Promise<GrepMatch[]> {
    const target = this.stat(targetPath, cwd);
    if (!target) {
      throw new Error(`Path does not exist: ${this.resolve(targetPath, cwd)}`);
    }

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, ignoreCase ? 'i' : '');
    } catch {
      regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), ignoreCase ? 'i' : '');
    }

    let files: FileEntry[] = [];
    if (target.type === 'file') {
      files = [target];
    } else if (target.type === 'dir') {
      if (recursive) {
        files = this.collectPageFilesRecursively(target.path);
      } else {
        files = this.list(target.path)
          .filter((entry): entry is FileEntry => entry.type === 'file')
          .sort((a, b) => a.path.localeCompare(b.path));
      }
    }

    const matches: GrepMatch[] = [];
    for (const file of files) {
      const content = await this.readFile(file.path);
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (regex.test(lines[i])) {
          matches.push({
            path: file.path,
            lineNumber: i + 1,
            line: lines[i]
          });
        }
      }
    }

    return matches;
  }

  async touch(pathInput: string, cwd: string): Promise<string> {
    const resolved = this.resolve(pathInput, cwd);

    if (this.entries.has(resolved)) {
      return resolved;
    }

    const parentPath = parentPathOf(resolved);
    const parent = this.entries.get(parentPath);
    if (!parent || parent.type !== 'dir') {
      throw new Error(`Parent directory not found: ${parentPath}`);
    }

    const basename = posix.basename(resolved);
    const title = basename.replace(/\.md$/, '').replace(/[-_]+/g, ' ').trim() || 'Untitled';
    const parentPageId = parent.meta.pageId;

    const createdPage = await this.notion.createPage(title, parentPageId);
    await this.refresh();

    const createdDir = this.pageDirPathById.get(createdPage.id);
    if (createdDir) {
      return posix.join(createdDir, 'index.md');
    }

    return resolved;
  }

  async mkdir(pathInput: string, cwd: string): Promise<string> {
    const resolved = this.resolve(pathInput, cwd);
    if (this.entries.has(resolved)) {
      return resolved;
    }

    const parentPath = parentPathOf(resolved);
    const parent = this.entries.get(parentPath);
    if (!parent || parent.type !== 'dir') {
      throw new Error(`Parent directory not found: ${parentPath}`);
    }

    const basename = posix.basename(resolved);
    const title = basename.replace(/[-_]+/g, ' ').trim() || 'Untitled';
    const parentPageId = parent.meta.pageId;
    const createdPage = await this.notion.createPage(title, parentPageId);
    await this.refresh();

    const createdDir = this.pageDirPathById.get(createdPage.id);
    if (createdDir) {
      return createdDir;
    }

    return resolved;
  }
}
