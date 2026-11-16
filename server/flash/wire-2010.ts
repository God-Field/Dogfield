import { children, field, has, parseXml, serializeXml, type XmlNode } from './xml.ts';

/** 2010 uses bare item IDs for inventory, chain results, mortar and revival. */
export function encode2010Message(source: string): string {
  const root = parseXml(source);
  function visit(node: XmlNode, parent?: XmlNode): void {
    for (const child of node.children) {
      visit(child, node);
    }
    const inventoryItem = parent?.name === 'privatePlayer' && ['item', 'ability'].includes(node.name);
    if (inventoryItem || node.name === 'mortar') {
      node.text = field(node, 'item');
      node.children = [];
    }
    if (node.name === 'piece') {
      if (has(node, 'abilityIndex')) {
        node.children.push({ name: 'isAbility', text: '', attributes: {}, children: [] });
      }
      const item = children(node, 'item')[0];
      if (item && has(node, 'assistantType')) {
        item.attributes.assistantType = field(node, 'assistantType');
      }
      if (parent && ['commandChain', 'DYING'].includes(parent.name)) {
        node.name = 'item';
        node.text = field(node, 'item');
        node.children = [];
      }
    }
  }
  visit(root);
  return serializeXml(root);
}
