const INDENT = '  ';

function richTextToPlain(richText: any[] | undefined): string {
  if (!Array.isArray(richText)) {
    return '';
  }

  return richText.map((chunk) => chunk?.plain_text ?? '').join('');
}

function textContent(content: string): any[] {
  return [
    {
      type: 'text',
      text: {
        content
      }
    }
  ];
}

function calloutIconToPlain(icon: any): string {
  if (!icon || typeof icon !== 'object') {
    return '💬';
  }

  if (icon.type === 'emoji' && typeof icon.emoji === 'string' && icon.emoji.length > 0) {
    return icon.emoji;
  }

  if (icon.type === 'custom_emoji' && icon.custom_emoji?.name) {
    return `:${icon.custom_emoji.name}:`;
  }

  return '💬';
}

function renderListChildren(children: any[] | undefined, depth: number): string[] {
  if (!children || children.length === 0) {
    return [];
  }

  const output: string[] = [];
  for (const child of children) {
    const rendered = renderBlock(child, depth + 1);
    for (const line of rendered) {
      output.push(`${INDENT.repeat(depth)}${line}`);
    }
  }
  return output;
}

function renderBlock(block: any, depth = 0): string[] {
  const type = block.type;
  const children = Array.isArray(block.children) ? block.children : undefined;

  if (type === 'paragraph') {
    const text = richTextToPlain(block.paragraph?.rich_text);
    return text.length === 0 ? [''] : [text];
  }

  if (type === 'heading_1') {
    return [`# ${richTextToPlain(block.heading_1?.rich_text)}`];
  }

  if (type === 'heading_2') {
    return [`## ${richTextToPlain(block.heading_2?.rich_text)}`];
  }

  if (type === 'heading_3') {
    return [`### ${richTextToPlain(block.heading_3?.rich_text)}`];
  }

  if (type === 'bulleted_list_item') {
    const line = `${INDENT.repeat(depth)}- ${richTextToPlain(block.bulleted_list_item?.rich_text)}`;
    return [line, ...renderListChildren(children, depth + 1)];
  }

  if (type === 'numbered_list_item') {
    const line = `${INDENT.repeat(depth)}1. ${richTextToPlain(block.numbered_list_item?.rich_text)}`;
    return [line, ...renderListChildren(children, depth + 1)];
  }

  if (type === 'to_do') {
    const checked = block.to_do?.checked ? 'x' : ' ';
    const text = richTextToPlain(block.to_do?.rich_text);
    const line = `${INDENT.repeat(depth)}- [${checked}] ${text}`;
    return [line, ...renderListChildren(children, depth + 1)];
  }

  if (type === 'quote') {
    return [`> ${richTextToPlain(block.quote?.rich_text)}`];
  }

  if (type === 'callout') {
    const text = richTextToPlain(block.callout?.rich_text);
    const icon = calloutIconToPlain(block.callout?.icon);
    const base = text.length > 0 ? `> ${icon} ${text}` : `> ${icon}`;
    const childLines = (children ?? [])
      .flatMap((child: any) => renderBlock(child, 0))
      .map((line: string) => (line.length > 0 ? `> ${line}` : '>'));

    return [base, ...childLines];
  }

  if (type === 'code') {
    const language = block.code?.language ?? '';
    const body = richTextToPlain(block.code?.rich_text);
    return [`\`\`\`${language}`, body, '```'];
  }

  if (type === 'divider') {
    return ['---'];
  }

  if (type === 'child_database') {
    return [`[db:${block.id}]`];
  }

  if (type === 'child_page') {
    return [`[[${block.child_page?.title ?? 'child-page'}]]`];
  }

  return [`<!-- unsupported:${type} id:${block.id} -->`];
}

export function notionBlocksToMarkdown(blocks: any[]): string {
  const sections: string[] = [];

  for (const block of blocks) {
    const lines = renderBlock(block);
    sections.push(lines.join('\n').trimEnd());
  }

  return sections.filter((section) => section.length > 0).join('\n\n').trimEnd();
}

function isBlockBoundary(line: string): boolean {
  return (
    /^#{1,3}\s+/.test(line) ||
    /^-\s\[( |x|X)\]\s+/.test(line) ||
    /^-\s+/.test(line) ||
    /^\d+\.\s+/.test(line) ||
    /^>\s?/.test(line) ||
    /^```/.test(line) ||
    /^---+$/.test(line)
  );
}

export function markdownToNotionBlocks(markdown: string): any[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: any[] = [];
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trimEnd();
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      i += 1;
      continue;
    }

    const codeStart = trimmed.match(/^```(.*)$/);
    if (codeStart) {
      const language = codeStart[1].trim() || 'plain text';
      i += 1;
      const codeLines: string[] = [];
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) {
        i += 1;
      }

      blocks.push({
        object: 'block',
        type: 'code',
        code: {
          language,
          rich_text: textContent(codeLines.join('\n'))
        }
      });
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const content = heading[2];
      const type = `heading_${level}`;
      blocks.push({
        object: 'block',
        type,
        [type]: {
          rich_text: textContent(content)
        }
      });
      i += 1;
      continue;
    }

    const todo = trimmed.match(/^-\s\[( |x|X)\]\s+(.*)$/);
    if (todo) {
      blocks.push({
        object: 'block',
        type: 'to_do',
        to_do: {
          checked: todo[1].toLowerCase() === 'x',
          rich_text: textContent(todo[2])
        }
      });
      i += 1;
      continue;
    }

    const bullet = trimmed.match(/^-\s+(.*)$/);
    if (bullet) {
      blocks.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: {
          rich_text: textContent(bullet[1])
        }
      });
      i += 1;
      continue;
    }

    const number = trimmed.match(/^\d+\.\s+(.*)$/);
    if (number) {
      blocks.push({
        object: 'block',
        type: 'numbered_list_item',
        numbered_list_item: {
          rich_text: textContent(number[1])
        }
      });
      i += 1;
      continue;
    }

    const quote = trimmed.match(/^>\s?(.*)$/);
    if (quote) {
      const quoteLines = [quote[1]];
      i += 1;
      while (i < lines.length) {
        const next = lines[i].trim();
        const nextQuote = next.match(/^>\s?(.*)$/);
        if (!nextQuote) {
          break;
        }
        quoteLines.push(nextQuote[1]);
        i += 1;
      }

      blocks.push({
        object: 'block',
        type: 'quote',
        quote: {
          rich_text: textContent(quoteLines.join('\n'))
        }
      });
      continue;
    }

    if (/^---+$/.test(trimmed)) {
      blocks.push({
        object: 'block',
        type: 'divider',
        divider: {}
      });
      i += 1;
      continue;
    }

    const paragraphLines = [line];
    i += 1;
    while (i < lines.length) {
      const next = lines[i].trimEnd();
      if (next.trim().length === 0 || isBlockBoundary(next.trim())) {
        break;
      }
      paragraphLines.push(next);
      i += 1;
    }

    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: textContent(paragraphLines.join('\n'))
      }
    });
  }

  return blocks;
}
