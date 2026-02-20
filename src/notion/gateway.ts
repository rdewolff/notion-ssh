import { APIErrorCode, Client, isNotionClientError } from '@notionhq/client';

import { notionBlocksToMarkdown, markdownToNotionBlocks } from './markdown';

export interface NotionRecordMeta {
  id: string;
  object: 'page' | 'data_source';
  title: string;
  parent: any;
  createdTime: string;
  lastEditedTime: string;
  owner: string;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function shortId(id: string): string {
  return id.replace(/-/g, '').slice(0, 8);
}

function titleFromPage(page: any): string {
  const properties = page?.properties;
  if (!properties || typeof properties !== 'object') {
    return `untitled-${shortId(page.id)}`;
  }

  for (const property of Object.values(properties) as any[]) {
    if (property?.type === 'title') {
      const text = (property.title ?? []).map((item: any) => item.plain_text ?? '').join('');
      if (text.trim().length > 0) {
        return text;
      }
    }
  }

  return `untitled-${shortId(page.id)}`;
}

function titleFromDataSource(dataSource: any): string {
  const titleText = (dataSource?.title ?? []).map((item: any) => item.plain_text ?? '').join('');
  if (titleText.trim().length > 0) {
    return titleText;
  }

  const directName = dataSource?.name;
  if (typeof directName === 'string' && directName.trim().length > 0) {
    return directName;
  }

  const text = (dataSource?.description ?? []).map((item: any) => item.plain_text ?? '').join('');
  if (text.trim().length > 0) {
    return text;
  }
  return `database-${shortId(dataSource.id)}`;
}

function ownerFromRecord(record: any): string {
  const owner = record?.last_edited_by;
  if (!owner) {
    return '-';
  }

  if (owner.type === 'person') {
    return owner.person?.email ?? owner.name ?? owner.id;
  }

  return owner.name ?? owner.id ?? '-';
}

function toRecordMeta(record: any): NotionRecordMeta {
  return {
    id: record.id,
    object: record.object,
    title: record.object === 'page' ? titleFromPage(record) : titleFromDataSource(record),
    parent: record.parent,
    createdTime: record.created_time,
    lastEditedTime: record.last_edited_time,
    owner: ownerFromRecord(record)
  };
}

export class NotionGateway {
  private readonly client: Client;

  constructor(apiKey: string) {
    this.client = new Client({ auth: apiKey });
  }

  private async withRetry<T>(opName: string, operation: () => Promise<T>): Promise<T> {
    const maxAttempts = 5;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (!isNotionClientError(error)) {
          throw error;
        }

        const retryable =
          error.code === APIErrorCode.RateLimited ||
          error.code === APIErrorCode.ServiceUnavailable ||
          error.code === APIErrorCode.ConflictError;

        if (!retryable || attempt >= maxAttempts) {
          throw error;
        }

        const waitMs = 250 * 2 ** (attempt - 1);
        console.warn(`[notion] retrying ${opName} after ${waitMs}ms (${error.code})`);
        await wait(waitMs);
      }
    }

    throw new Error(`Notion operation failed: ${opName}`);
  }

  private async searchAll(objectType: 'page' | 'data_source'): Promise<any[]> {
    const results: any[] = [];
    let cursor: string | undefined;

    do {
      const response: any = await this.withRetry(`search:${objectType}`, async () => {
        return this.client.search({
          page_size: 100,
          start_cursor: cursor,
          filter: {
            property: 'object',
            value: objectType
          }
        });
      });

      results.push(...response.results);
      cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
    } while (cursor);

    return results;
  }

  private filterByRoot(records: NotionRecordMeta[], rootPageId: string | undefined): NotionRecordMeta[] {
    if (!rootPageId) {
      return records;
    }

    const normalizedRoot = rootPageId.replace(/-/g, '');
    const included = new Set<string>([normalizedRoot]);
    const items = records.map((item) => ({
      ...item,
      idNoDash: item.id.replace(/-/g, ''),
      parentPageNoDash:
        item.parent?.type === 'page_id' && typeof item.parent.page_id === 'string'
          ? item.parent.page_id.replace(/-/g, '')
          : undefined
    }));

    let changed = true;
    while (changed) {
      changed = false;
      for (const item of items) {
        if (included.has(item.idNoDash)) {
          continue;
        }
        if (item.parentPageNoDash && included.has(item.parentPageNoDash)) {
          included.add(item.idNoDash);
          changed = true;
        }
      }
    }

    return items.filter((item) => included.has(item.idNoDash));
  }

  async listRecords(rootPageId?: string): Promise<{ pages: NotionRecordMeta[]; databases: NotionRecordMeta[] }> {
    const [rawPages, rawDatabases] = await Promise.all([this.searchAll('page'), this.searchAll('data_source')]);

    const pages = this.filterByRoot(rawPages.map(toRecordMeta), rootPageId);
    const databases = this.filterByRoot(rawDatabases.map(toRecordMeta), rootPageId);

    return { pages, databases };
  }

  private async listBlockChildren(blockId: string): Promise<any[]> {
    const results: any[] = [];
    let cursor: string | undefined;

    do {
      const response: any = await this.withRetry('blocks.children.list', async () => {
        return this.client.blocks.children.list({
          block_id: blockId,
          page_size: 100,
          start_cursor: cursor
        });
      });

      results.push(...response.results);
      cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
    } while (cursor);

    return results;
  }

  private async listBlockTree(blockId: string): Promise<any[]> {
    const children = await this.listBlockChildren(blockId);

    for (const child of children) {
      if (child.has_children) {
        child.children = await this.listBlockTree(child.id);
      }
    }

    return children;
  }

  async readPageMarkdown(pageId: string): Promise<string> {
    const blocks = await this.listBlockTree(pageId);
    return notionBlocksToMarkdown(blocks);
  }

  async replacePageMarkdown(pageId: string, markdown: string): Promise<void> {
    const existing = await this.listBlockChildren(pageId);

    for (const block of existing) {
      await this.withRetry('blocks.update.archive', async () => {
        await this.client.blocks.update({
          block_id: block.id,
          archived: true
        });
      });
    }

    const blocks = markdownToNotionBlocks(markdown);
    const batchSize = 100;
    for (let i = 0; i < blocks.length; i += batchSize) {
      const batch = blocks.slice(i, i + batchSize);
      await this.withRetry('blocks.children.append', async () => {
        await this.client.blocks.children.append({
          block_id: pageId,
          children: batch
        });
      });
    }
  }

  async createPage(title: string, parentPageId?: string): Promise<NotionRecordMeta> {
    const parent = parentPageId
      ? {
          type: 'page_id' as const,
          page_id: parentPageId
        }
      : {
          type: 'workspace' as const,
          workspace: true as const
        };

    const response: any = await this.withRetry('pages.create', async () => {
      return this.client.pages.create({
        parent,
        properties: {
          title: {
            title: [
              {
                type: 'text',
                text: {
                  content: title
                }
              }
            ]
          }
        }
      });
    });

    return toRecordMeta(response);
  }
}
