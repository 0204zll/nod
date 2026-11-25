import { parse } from 'parse5';

type Node = { nodeName: string; value?: string; childNodes?: Node[] };

export function pageText(html: string) {
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeName === 'style' || node.nodeName === 'script') return;
    if (node.nodeName === '#text') parts.push(node.value ?? '');
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(parse(html) as Node);
  return parts.join(' ');
}
