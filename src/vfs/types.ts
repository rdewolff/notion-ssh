export interface EntryMeta {
  createdTime?: string;
  lastEditedTime?: string;
  owner?: string;
  pageId?: string;
  databaseId?: string;
}

interface BaseEntry {
  type: 'dir' | 'file' | 'db';
  name: string;
  path: string;
  parentPath: string;
  meta: EntryMeta;
}

export interface DirEntry extends BaseEntry {
  type: 'dir';
  children: Set<string>;
}

export interface FileEntry extends BaseEntry {
  type: 'file';
  readonly: boolean;
  pageId: string;
}

export interface DbPlaceholderEntry extends BaseEntry {
  type: 'db';
  readonly: true;
  databaseId: string;
}

export type FsEntry = DirEntry | FileEntry | DbPlaceholderEntry;

export interface GrepMatch {
  path: string;
  lineNumber: number;
  line: string;
}
