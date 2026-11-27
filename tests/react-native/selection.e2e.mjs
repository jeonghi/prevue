import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { chromium, digest, projects, treeNodes } from './projects.mjs';

test('a real click on the board locates the TSX that the agent edits and verifies', {timeout:60000},async t=>{
  const suite=await projects(1); t.after(()=>suite.close());
  const [root]=suite.roots, cli=(...args)=>suite.cli(root,args);
  const shown=await cli('show','OrderCard.preview.tsx','--lang','ko');
  const result=shown.cards[0], nodes=await treeNodes(result);
  const button=nodes.find(n=>n.testId==='order-detail');
  assert.ok(button?.source);
  const browser=await chromium.launch();t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  await page.goto(shown.viewer);
  const locator=page.locator('.card[data-i="0"] .cstage img');
  await locator.waitFor({state:'visible'});
  await locator.evaluate(img=>img.decode());
  const rect=await locator.boundingBox(), b=button.bounds;
  const selection=page.waitForResponse(r=>new URL(r.url()).pathname==='/viewer/point' && r.request().method()==='POST');
  await page.mouse.click(rect.x+rect.width*(b.x+b.width/2)/result.width,rect.y+rect.height*(b.y+b.height/2)/result.height);
  assert.ok((await selection).ok());
  const picked=await cli('selection');
  assert.equal(picked.node.testId,'order-detail');
  assert.deepEqual(picked.node.source,button.source);
  if (process.env.PREVUE_DEMO_DIR) {
    await page.locator('.pc-float[data-placed] .rn-node-info').waitFor({state:'visible'});
    await page.screenshot({path:path.join(process.env.PREVUE_DEMO_DIR,'inspector.png')});
  }
  const sourceFile=path.join(root,picked.node.source.file);
  const source=await readFile(sourceFile,'utf8');
  assert.ok(source.split('\n')[picked.node.source.line-1].slice(picked.node.source.column-1).startsWith('<Pressable'));
  const changed=source.replace("minHeight: 43, borderRadius: 9","minHeight: 56, borderRadius: 9");
  assert.notEqual(source,changed);
  await writeFile(sourceFile,changed);
  const saved=await cli('wait',sourceFile,'--after',String(shown.generation));
  const updated=(await treeNodes(saved.cards[0])).find(n=>n.testId==='order-detail');
  assert.ok(updated.bounds.height>button.bounds.height);
  assert.equal(saved.generation,saved.cards[0].imageGeneration);
  assert.notEqual(await digest(result.imagePath),await digest(saved.cards[0].imagePath));
});
