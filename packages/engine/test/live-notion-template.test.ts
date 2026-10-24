import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blockContent, blockText, fingerprint, replacementBody, richText, selectBlock, selectorMatches,
  type NotionBlockTree,
} from '../src/live-notion-template.ts';
import type { NotionTemplateReplacement } from '../src/live-notion-types.ts';

function paragraph(text:string,id='synthetic-block'):Record<string,unknown>{
  return {id,type:'paragraph',paragraph:{rich_text:richText(text)}};
}
function node(block:Record<string,unknown>,children:NotionBlockTree[]=[]):NotionBlockTree{return {block,children};}
function mapping(expectedText:string,token:string,contextKey:string,occurrence=1,type='paragraph'):NotionTemplateReplacement{
  return {path:[0],type,expectedText,ownership:'template',token,contextKey,occurrence};
}
function outputItems(body:Record<string,unknown>,type='paragraph'):Array<Record<string,unknown>>{
  return (body[type] as {rich_text:Array<Record<string,unknown>>}).rich_text;
}
function textContents(items:Array<Record<string,unknown>>):string{
  return items.map(item=>item.type==='text'?(item.text as {content:string}).content:'').join('');
}

test('template selector requires the configured exact location, type and expected text',()=>{
  const tree=[node(paragraph('same token $$$','manual')),node(paragraph('container'),[
    node(paragraph('Expected $$$','target')),
  ])];
  const selector={path:[1,0],type:'paragraph',expectedText:'Expected $$$'};
  assert.equal(selectBlock(tree,selector)?.block.id,'target');
  assert.equal(selectorMatches(tree,selector),true);
  assert.equal(selectorMatches(tree,{...selector,path:[0]}),false);
  assert.equal(selectorMatches(tree,{...selector,type:'heading_1'}),false);
  assert.equal(selectorMatches(tree,{...selector,expectedText:'Expected @@'}),false);
  assert.equal(selectBlock(tree,{...selector,path:[1,4]}),undefined);
  for(const path of [[],[-1],[0.5],[Number.NaN]]){
    assert.throws(()=>selectBlock(tree,{...selector,path}),/NOTION_TEMPLATE_SELECTOR_INVALID/);
  }
});

test('ownership fingerprints are canonical and include rich-text formatting and links',()=>{
  const plain={type:'paragraph',content:{rich_text:[{type:'text',text:{content:'synthetic'},annotations:{bold:true}}]}};
  const reordered={content:{rich_text:[{annotations:{bold:true},text:{content:'synthetic'},type:'text'}]},type:'paragraph'};
  assert.equal(fingerprint(plain),fingerprint(reordered));
  assert.notEqual(fingerprint(plain),fingerprint({type:'paragraph',content:{rich_text:[{type:'text',text:{content:'synthetic'},annotations:{bold:false}}]}}));
  assert.notEqual(fingerprint(plain),fingerprint({type:'paragraph',content:{rich_text:[{type:'text',text:{content:'synthetic',link:{url:'https://example.invalid/reference'}},annotations:{bold:true}}]}}));
  const a=paragraph('synthetic','a');const b=paragraph('synthetic','b');
  assert.equal(fingerprint(blockContent(a)),fingerprint(blockContent(b)));
});

test('replacement changes only explicitly mapped token occurrences without scanning other blocks',()=>{
  const original='Member $$$ / untouched @@ / $$$';
  const target=paragraph(original);
  const manual=paragraph('Manual $$$ and @@','manual');
  const before=structuredClone(manual);
  const result=replacementBody(target,[mapping(original,'$$$','member',1)],{member:'Synthetic Member'});
  assert.equal(result.text,'Member Synthetic Member / untouched @@ / $$$');
  assert.equal(textContents(outputItems(result.body)),result.text);
  assert.deepEqual(manual,before);
  assert.equal(blockText(target),original);
});

test('each repeated @@ occurrence gets its own configured semantic context',()=>{
  const original='@@ consults on @@ at @@';
  const result=replacementBody(paragraph(original),[
    mapping(original,'@@','member',1),mapping(original,'@@','weekday',2),mapping(original,'@@','time',3),
  ],{member:'Synthetic Member',weekday:'Tuesday',time:'14:30'});
  assert.equal(result.text,'Synthetic Member consults on Tuesday at 14:30');
  assert.equal(textContents(outputItems(result.body)),result.text);
});

test('replacement offsets use the original text even when inserted values contain another token',()=>{
  const original='$$$ / @@';
  const result=replacementBody(paragraph(original),[
    mapping(original,'@@','second'),mapping(original,'$$$','first'),
  ],{first:'Synthetic @@ Member',second:'Tuesday'});
  assert.equal(result.text,'Synthetic @@ Member / Tuesday');
});

test('template replacement rejects changed content, block type and non-template ownership',()=>{
  const original='Synthetic $$$';const configured=mapping(original,'$$$','member');
  assert.throws(()=>replacementBody(paragraph('Edited $$$'),[configured],{member:'Member'}),/NOTION_TEMPLATE_CONTEXT_CHANGED/);
  assert.throws(()=>replacementBody(paragraph(original),[{...configured,type:'heading_1'}],{member:'Member'}),/NOTION_TEMPLATE_CONTEXT_CHANGED/);
  assert.throws(()=>replacementBody(paragraph(original),[{...configured,ownership:'manual'} as unknown as NotionTemplateReplacement],{member:'Member'}),/NOTION_TEMPLATE_CONTEXT_CHANGED/);
});

test('missing tokens, missing contexts and invalid occurrence numbers fail closed',()=>{
  const original='Synthetic $$$ and $$$';const block=paragraph(original);
  assert.throws(()=>replacementBody(block,[mapping(original,'@@','member')],{member:'Member'}),/NOTION_TEMPLATE_TOKEN_MISSING/);
  assert.throws(()=>replacementBody(block,[mapping(original,'$$$','member',3)],{member:'Member'}),/NOTION_TEMPLATE_TOKEN_MISSING/);
  assert.throws(()=>replacementBody(block,[mapping(original,'$$$','missing')],{}),/NOTION_TEMPLATE_MAPPING_INVALID/);
  for(const occurrence of [0,-1,1.5,Number.NaN]){
    assert.throws(()=>replacementBody(block,[mapping(original,'$$$','member',occurrence)],{member:'Member'}),/NOTION_TEMPLATE_MAPPING_INVALID/);
  }
  assert.throws(()=>replacementBody(block,[mapping(original,'','member')],{member:'Member'}),/NOTION_TEMPLATE_MAPPING_INVALID/);
});

test('duplicate or overlapping token mappings are rejected before producing an update',()=>{
  const original='Synthetic $$$';const first=mapping(original,'$$$','member');
  assert.throws(()=>replacementBody(paragraph(original),[first,first],{member:'Member'}),/NOTION_TEMPLATE_MAPPING_OVERLAP/);
  assert.throws(()=>replacementBody(paragraph(original),[first,mapping(original,'$$','other')],{member:'Member',other:'Other'}),/NOTION_TEMPLATE_MAPPING_OVERLAP/);
});

test('rich-text token replacement preserves node annotations and links and removes response fields',()=>{
  const block={id:'synthetic-format',type:'paragraph',paragraph:{rich_text:[
    {type:'text',text:{content:'Hello $$$',link:{url:'https://example.invalid/member'}},annotations:{bold:true,color:'blue'},plain_text:'Hello $$$',href:'https://example.invalid/member'},
    {type:'text',text:{content:' unchanged',link:null},annotations:{italic:true},plain_text:' unchanged',href:null},
  ]}};
  const before=structuredClone(block);
  const result=replacementBody(block,[mapping('Hello $$$ unchanged','$$$','member')],{member:'Synthetic Member'});
  const items=outputItems(result.body);
  assert.equal(textContents(items),'Hello Synthetic Member unchanged');
  assert.deepEqual(items[0]!.annotations,{bold:true,color:'blue'});
  assert.deepEqual((items[0]!.text as {link:unknown}).link,{url:'https://example.invalid/member'});
  assert.deepEqual(items[1]!.annotations,{italic:true});
  for(const item of items){assert.ok(!('plain_text' in item));assert.ok(!('href' in item));}
  assert.deepEqual(block,before);
});

test('a token split between rich-text nodes is replaced once with surrounding formatting retained',()=>{
  const block={id:'synthetic-split',type:'paragraph',paragraph:{rich_text:[
    {type:'text',text:{content:'Hi $',link:{url:'https://example.invalid/member'}},annotations:{bold:true}},
    {type:'text',text:{content:'$$',link:null},annotations:{italic:true}},
    {type:'text',text:{content:' suffix',link:null},annotations:{underline:true}},
  ]}};
  const result=replacementBody(block,[mapping('Hi $$$ suffix','$$$','member')],{member:'Synthetic'});
  const items=outputItems(result.body);
  assert.equal(result.text,'Hi Synthetic suffix');
  assert.equal(textContents(items),result.text);
  assert.deepEqual(items[0]!.annotations,{bold:true});
  assert.deepEqual((items[0]!.text as {link:unknown}).link,{url:'https://example.invalid/member'});
  assert.deepEqual(items.at(-1)!.annotations,{underline:true});
});

test('non-text mentions remain intact unless a configured token touches them',()=>{
  const mention={type:'mention',mention:{type:'page',page:{id:'synthetic-reference'}},annotations:{bold:false},plain_text:'Reference',href:'https://example.invalid/reference'};
  const block={id:'synthetic-mention',type:'paragraph',paragraph:{rich_text:[
    {type:'text',text:{content:'$$$ / '}},mention,
  ]}};
  const result=replacementBody(block,[mapping('$$$ / Reference','$$$','member')],{member:'Synthetic'});
  const preserved=outputItems(result.body).find(item=>item.type==='mention');
  assert.deepEqual(preserved,{type:'mention',mention:{type:'page',page:{id:'synthetic-reference'}},annotations:{bold:false}});
  assert.throws(()=>replacementBody(block,[mapping('$$$ / Reference','Reference','member')],{member:'Synthetic'}),/NOTION_TEMPLATE_NON_TEXT_TOKEN/);
  const crossing={type:'paragraph',paragraph:{rich_text:[{type:'text',text:{content:'$'}},{...mention,plain_text:'$$'}]}};
  assert.throws(()=>replacementBody(crossing,[mapping('$$$','$$$','member')],{member:'Synthetic'}),/NOTION_TEMPLATE_NON_TEXT_TOKEN/);
});

test('child-page rename uses pages-compatible properties.title rather than a child_page block patch',()=>{
  const original='$$$ training log';
  const block={id:'synthetic-child-page',type:'child_page',child_page:{title:original}};
  const result=replacementBody(block,[mapping(original,'$$$','member',1,'child_page')],{member:'Synthetic Member'});
  assert.equal(result.text,'Synthetic Member training log');
  assert.deepEqual(result.body,{properties:{title:{title:[{type:'text',text:{content:'Synthetic Member training log'}}]}}});
  assert.ok(!('child_page' in result.body));
  assert.equal(block.child_page.title,original);
});
