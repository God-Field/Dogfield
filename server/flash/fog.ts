import { children, field, parseXml, serializeXml } from './xml.ts';

/** Anonymous commanders are required by Inning.setXML, not just a UI overlay. */
export function concealFogMessage(xml: string, viewer: string): string {
  const node = parseXml(xml);
  if (node.name === 'START_INNING') {
    const attacker = children(node, 'attacker')[0];
    if (attacker && field(attacker, 'name') !== viewer) {
      node.children = node.children.filter((child) => child !== attacker);
    }
  }
  if (node.name === 'COMMAND') {
    const commander = children(node, 'commander')[0];
    const target = children(node, 'target')[0];
    const commanderName = commander ? field(commander, 'name') : '';
    const targetName = target ? field(target, 'name') : '';
    if (commanderName && commanderName !== viewer) {
      node.children = node.children.filter((child) => child !== commander && child.name !== 'power');
    }
    if (targetName && targetName !== viewer && target) {
      target.children = commanderName === targetName
        ? [{ name: 'isSelf', attributes: {}, children: [], text: '' }]
        : [];
    }
  }
  return serializeXml(node);
}
