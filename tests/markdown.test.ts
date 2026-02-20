import { describe, expect, it } from 'vitest';

import { markdownToNotionBlocks, notionBlocksToMarkdown } from '../src/notion/markdown';

describe('markdown conversion', () => {
  it('converts markdown to notion-like blocks', () => {
    const blocks = markdownToNotionBlocks('# Title\n\n- item\n\nhello');
    expect(blocks.length).toBe(3);
    expect(blocks[0].type).toBe('heading_1');
    expect(blocks[1].type).toBe('bulleted_list_item');
    expect(blocks[2].type).toBe('paragraph');
  });

  it('renders notion-like blocks back to markdown', () => {
    const markdown = notionBlocksToMarkdown([
      {
        id: 'a',
        type: 'heading_2',
        heading_2: { rich_text: [{ plain_text: 'Section' }] }
      },
      {
        id: 'b',
        type: 'paragraph',
        paragraph: { rich_text: [{ plain_text: 'Hello world' }] }
      }
    ]);

    expect(markdown).toContain('## Section');
    expect(markdown).toContain('Hello world');
  });
});
