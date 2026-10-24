import { createHash } from 'node:crypto';
import { NotionReviewRequiredError, array, object, string } from './live-notion-client.ts';
import type { NotionBlockSelector, NotionTemplateReplacement } from './live-notion-types.ts';

export interface NotionBlockTree { block: Record<string, unknown>; children: NotionBlockTree[] }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)]));
  return value;
}
export function fingerprint(value: unknown): string { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
export function richText(value: string): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (let index = 0; index < value.length; index += 2000) result.push({type:'text',text:{content:value.slice(index,index+2000)}});
  if (result.length > 100) throw new NotionReviewRequiredError('NOTION_TEXT_TOO_LONG');
  return result;
}
export function blockText(block: Record<string, unknown>): string {
  const type = string(block.type);
  const content = object(block[type]);
  if (type === 'child_page') return string(content.title);
  if (!Array.isArray(content.rich_text)) return '';
  return content.rich_text.map(raw=>{
    const item=object(raw);
    return item.type === 'text' ? string(object(item.text).content) : string(item.plain_text);
  }).join('');
}
/** Persisted text ownership hashes also protect annotations and links from being overwritten. */
export function blockContent(block: Record<string, unknown>): unknown {
  const type=string(block.type);
  const content=object(block[type]);
  return {type,content};
}
export function selectBlock(tree: NotionBlockTree[], selector: NotionBlockSelector): NotionBlockTree | undefined {
  if (!selector.path.length || selector.path.some(index=>!Number.isInteger(index)||index<0)) throw new NotionReviewRequiredError('NOTION_TEMPLATE_SELECTOR_INVALID');
  let items=tree;
  let result:NotionBlockTree|undefined;
  for(const index of selector.path){ result=items[index]; if(!result)return undefined; items=result.children; }
  return result;
}
export function selectorMatches(tree: NotionBlockTree[], selector: NotionBlockSelector): boolean {
  const item=selectBlock(tree,selector);
  return Boolean(item && item.block.type === selector.type && blockText(item.block) === selector.expectedText);
}
/** Exact context positions only; manual blocks and arbitrary $$$ / @@ are never searched globally. */
export function replacementBody(block: Record<string, unknown>, mappings: readonly NotionTemplateReplacement[], context: Readonly<Record<string,string>>): {body:Record<string,unknown>; text:string} {
  const original=blockText(block);
  const ranges:Array<{offset:number;length:number;value:string}>=[];
  for(const mapping of mappings){
    if(mapping.ownership!=='template'||mapping.type!==block.type||mapping.expectedText!==original)throw new NotionReviewRequiredError('NOTION_TEMPLATE_CONTEXT_CHANGED');
    if(!mapping.token||!Number.isInteger(mapping.occurrence)||mapping.occurrence<1||typeof context[mapping.contextKey]!=='string')throw new NotionReviewRequiredError('NOTION_TEMPLATE_MAPPING_INVALID');
    let offset=-mapping.token.length;
    for(let i=0;i<mapping.occurrence;i++){
      offset=original.indexOf(mapping.token,offset+mapping.token.length);
      if(offset<0)throw new NotionReviewRequiredError('NOTION_TEMPLATE_TOKEN_MISSING');
    }
    ranges.push({offset,length:mapping.token.length,value:context[mapping.contextKey]!});
  }
  ranges.sort((a,b)=>a.offset-b.offset);
  for(let i=1;i<ranges.length;i++)if(ranges[i]!.offset<ranges[i-1]!.offset+ranges[i-1]!.length)throw new NotionReviewRequiredError('NOTION_TEMPLATE_MAPPING_OVERLAP');
  let text=original;
  for(const range of [...ranges].reverse())text=text.slice(0,range.offset)+range.value+text.slice(range.offset+range.length);
  if(block.type==='child_page')return {body:{properties:{title:{title:richText(text)}}},text};
  const content=object(block[string(block.type)]);
  const items=array(content.rich_text);
  let offset=0;
  const updated:Record<string,unknown>[]=[];
  for(const raw of items){
    const item=object(raw);
    const itemText=item.type==='text'?string(object(item.text).content):string(item.plain_text);
    const start=offset;const end=offset+itemText.length;offset=end;
    const touching=ranges.filter(range=>range.offset<end&&range.offset+range.length>start);
    if(item.type!=='text'){
      if(touching.length)throw new NotionReviewRequiredError('NOTION_TEMPLATE_NON_TEXT_TOKEN');
      // Preserve supported mentions/equations without response-only fields.
      updated.push(Object.fromEntries(Object.entries(item).filter(([key])=>!['plain_text','href'].includes(key))));continue;
    }
    let value='';let cursor=start;
    for(const range of touching){
      value+=original.slice(cursor,Math.max(cursor,range.offset));
      if(range.offset>=start)value+=range.value;
      cursor=Math.min(end,range.offset+range.length);
    }
    value+=original.slice(cursor,end);
    const inputText=object(item.text);
    for(const chunk of richText(value))updated.push({...chunk,text:{...object(chunk.text),...(inputText.link?{link:structuredClone(inputText.link)}:{})},...(item.annotations?{annotations:structuredClone(item.annotations)}:{})});
  }
  if(updated.length>100)throw new NotionReviewRequiredError('NOTION_TEXT_TOO_LONG');
  return {body:{[string(block.type)]:{rich_text:updated}},text};
}
