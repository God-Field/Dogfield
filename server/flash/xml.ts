/** The Flash socket protocol is a small, entity-escaped subset of XML. */
const maximumXmlCodePoint = 0x10ffff;
const firstSurrogateCodePoint = 0xd800;
const lastSurrogateCodePoint = 0xdfff;
const maximumXmlDocumentLength = 65536;
const maximumXmlNestingDepth = 16;

export interface XmlNode {
  name: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  text: string;
}

export function escapeXml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character]!);
}

function decodeEntities(value: string): string {
  if (/&(?!(?:#x[\da-fA-F]+|#\d+|amp|lt|gt|quot|apos);)/.test(value)) {
    throw new Error('Unknown XML entity');
  }
  return value.replace(/&(#x[\da-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_match, entity: string) => {
    if (entity.startsWith('#')) {
      const numeric = entity[1] === 'x'
        ? Number.parseInt(entity.slice(2), 16)
        : Number(entity.slice(1));
      if (numeric === 0 || numeric > maximumXmlCodePoint
        || (numeric >= firstSurrogateCodePoint && numeric <= lastSurrogateCodePoint)) {
        throw new Error('Invalid XML entity');
      }
      return String.fromCodePoint(numeric);
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity]!;
  });
}

export function parseXml(source: string): XmlNode {
  if (source.length > maximumXmlDocumentLength || /<!|<\?/.test(source)) {
    throw new Error('Unsupported XML');
  }
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  const tokens = source.match(/<[^>]*>|[^<]+/g) ?? [];
  if (tokens.join('') !== source) {
    throw new Error('Malformed XML');
  }
  for (const token of tokens) {
    if (!token.startsWith('<')) {
      if (stack.length === 0) {
        if (token.trim()) {
          throw new Error('Text outside XML root');
        }
      } else {
        stack.at(-1)!.text += decodeEntities(token);
      }
      continue;
    }
    if (token.startsWith('</')) {
      const closed = stack.pop();
      if (!closed || token !== `</${closed.name}>`) {
        throw new Error('Mismatched XML tag');
      }
      continue;
    }
    const match = /^<([A-Za-z_][\w.-]*)([\s\S]*?)(\/?)>$/.exec(token);
    if (!match || stack.length > maximumXmlNestingDepth) {
      throw new Error('Malformed XML element');
    }
    const attributes: Record<string, string> = Object.create(null);
    let remaining = match[2]!;
    while (remaining.trim()) {
      const attribute = /^\s+([A-Za-z_][\w.-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/.exec(remaining);
      if (!attribute || attribute[1]! in attributes) {
        throw new Error('Malformed XML attribute');
      }
      attributes[attribute[1]!] = decodeEntities(attribute[2] ?? attribute[3]!);
      remaining = remaining.slice(attribute[0].length);
    }
    const node = { name: match[1]!, attributes, children: [], text: '' };
    if (stack.length) {
      stack.at(-1)!.children.push(node);
    } else {
      if (root) {
        throw new Error('Multiple XML roots');
      }
      root = node;
    }
    if (!match[3]) {
      stack.push(node);
    }
  }
  if (!root || stack.length) {
    throw new Error('Incomplete XML');
  }
  return root;
}

export function children(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child) => child.name === name);
}

export function field(node: XmlNode, name: string): string {
  const matches = children(node, name);
  if (matches.length > 1) {
    throw new Error(`Duplicate field: ${name}`);
  }
  return matches[0]?.text ?? '';
}

export function has(node: XmlNode, name: string): boolean {
  return children(node, name).length > 0;
}

export function tag(name: string, value?: unknown, attributes: Record<string, string> = {}): string {
  const attributeText = Object.entries(attributes)
    .map(([key, attribute]) => ` ${key}="${escapeXml(attribute)}"`).join('');
  return value === undefined
    ? `<${name}${attributeText}/>`
    : `<${name}${attributeText}>${escapeXml(value)}</${name}>`;
}

export function element(name: string, content = ''): string {
  return `<${name}>${content}</${name}>`;
}

export function serializeXml(node: XmlNode): string {
  const attributes = Object.entries(node.attributes)
    .map(([key, value]) => ` ${key}="${escapeXml(value)}"`).join('');
  return `<${node.name}${attributes}>${escapeXml(node.text)}${node.children.map(serializeXml).join('')}</${node.name}>`;
}
