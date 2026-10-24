import type { Issue, TemplateBlock, TemplateMapping } from './types.js';

function cloneBlock(block: TemplateBlock): TemplateBlock {
  return { ...block, ...(block.children ? { children: block.children.map(cloneBlock) } : {}) };
}

/** Explicit mappings only: an arbitrary $$$ or @@ never implicitly means a member name. */
export function applyTemplateMappings(blocks: TemplateBlock[], mappings: TemplateMapping[], context: Record<string, string>): { blocks: TemplateBlock[]; issues: Issue[] } {
  const result = blocks.map(cloneBlock);
  const issues: Issue[] = [];
  const lookup = new Map<string, TemplateBlock>();
  const originals = new Map<string, string>();
  const manualIds = new Set<string>();
  const visit = (items: TemplateBlock[], inheritedManual = false): void => {
    for (const block of items) {
      if (lookup.has(block.id)) throw new Error('Template block IDs must be unique.');
      lookup.set(block.id, block);
      originals.set(block.id, block.text);
      const manual = inheritedManual || block.ownership === 'manual';
      if (manual) manualIds.add(block.id);
      if (block.children) visit(block.children, manual);
    }
  };
  visit(result);
  const applied = new Set<string>();
  const replacements = new Map<string, Array<{ offset: number; length: number; value: string }>>();
  for (const mapping of mappings) {
    const block = lookup.get(mapping.blockId);
    if (!block) { issues.push({ code: 'MISSING_TEMPLATE_BLOCK', message: `Mapping block ${mapping.blockId} was not found; validate the real template.` }); continue; }
    if (manualIds.has(block.id)) { issues.push({ code: 'MANUAL_BLOCK_PRESERVED', message: `Manual block ${block.id} was preserved.` }); continue; }
    if (mapping.expectedText !== undefined && originals.get(block.id) !== mapping.expectedText) {
      issues.push({ code: 'TEMPLATE_CONTEXT_MISMATCH', message: `Template context for ${block.id} changed; confirm its mapping.` }); continue;
    }
    const value = context[mapping.contextKey];
    if (typeof value !== 'string') { issues.push({ code: 'MISSING_TEMPLATE_VALUE', message: `Confirm the value for context key ${mapping.contextKey}.` }); continue; }
    const original = originals.get(block.id)!;
    const parts = original.split(mapping.token);
    const count = parts.length - 1;
    if (count === 0) { issues.push({ code: 'MISSING_TEMPLATE_TOKEN', message: `Token was not found in mapped block ${block.id}.` }); continue; }
    const occurrence = mapping.occurrence ?? 1;
    const identity = `${block.id}\u0000${mapping.token}\u0000${occurrence}`;
    if (applied.has(identity)) { issues.push({ code: 'DUPLICATE_TEMPLATE_MAPPING', message: `A token position in ${block.id} has more than one mapping.` }); continue; }
    if ((count > 1 && mapping.occurrence === undefined) || !Number.isInteger(occurrence) || occurrence < 1 || occurrence > count) {
      issues.push({ code: 'AMBIGUOUS_TEMPLATE_TOKEN', message: `Confirm the exact token occurrence in ${block.id}.` }); continue;
    }
    let offset = -mapping.token.length;
    for (let i = 0; i < occurrence; i++) offset = original.indexOf(mapping.token, offset + mapping.token.length);
    const planned = replacements.get(block.id) ?? [];
    planned.push({ offset, length: mapping.token.length, value });
    replacements.set(block.id, planned);
    applied.add(identity);
  }
  for (const [id, planned] of replacements) {
    const block = lookup.get(id)!;
    for (const replacement of planned.sort((a, b) => b.offset - a.offset)) {
      block.text = block.text.slice(0, replacement.offset) + replacement.value + block.text.slice(replacement.offset + replacement.length);
    }
  }
  for (const block of lookup.values()) {
    if (!manualIds.has(block.id) && (/\$\$\$|@@/.test(block.text) || /000\ub2d8\s*\uc131\uc7a5\s*\ud788\uc2a4\ud1a0\ub9ac/.test(block.text))) {
      issues.push({ code: 'UNMAPPED_TEMPLATE_TOKEN', message: `Block ${block.id} still has a placeholder requiring an explicit mapping.` });
    }
  }
  return { blocks: result, issues };
}
