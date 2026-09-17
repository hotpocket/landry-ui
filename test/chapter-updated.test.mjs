// Built-player contract: source dates remain links; revision timestamps are local.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
const here = dirname(fileURLToPath(import.meta.url));
const player = join(here, '../audiobook/player');
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_LIB || join(os.homedir(), 'git/gstack/node_modules/playwright'));
const fixture = join(here, 'fixture/out');
if (!existsSync(join(fixture, 'audio/chapter_0001.m4a'))) execFileSync(join(here, 'fixture/gen.sh'));
const chapters = [4, 8, 9, 10].map((n, id) => ({n, id, title: `Chapter ${n}`, filename: 'chapter_0001.m4a', start: id*30, end: (id+1)*30, duration: 30, summary: {filename: 'chapter_0001.summary.m4a', duration: 6}}));
const books = [{slug:'dated', title:'Dated', duration:120, chapters}, {slug:'pending', title:'Pending', duration:30, chapters:[chapters[0]], transcriptUrl:'/pending.json'}];
const chunks = [{index:0,text:'Full text',start:0,end:30}];
const transcripts = {books:[{slug:'dated',chapters:chapters.map((c,i) => ({n:c.n,index:i+1,chunks,summary_chunks:[{...chunks[0],text:'Summary text',end:6}], ...(i < 2 ? {source_date:'2020-10-19',source_url:'https://www.youtube.com/watch?v=original',last_updated:i===0?'2026-09-17T01:14:00Z':'2026-09-17T17:20:00Z'} : i===3 ? {last_updated:'invalid'} : {})}))}]};
// WBT combines legacy unnumbered chapters with newly numbered ones.
delete transcripts.books[0].chapters[0].n;
const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${readFileSync(join(player,'player.css'))}</style><div id="mount"></div><script>${readFileSync(join(player,'player.js'))}</script><script>RepoStoryPlayer.init({container:document.getElementById('mount'),books:${JSON.stringify(books)},transcriptUrl:'data:application/json;base64,${Buffer.from(JSON.stringify(transcripts)).toString('base64')}',audioBaseUrl:'/audio/'});</script>`;
const server = createServer((req,res)=>{
  if(req.url.startsWith('/pending.json')) { res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({books:[]})); return; }
  if(req.url.startsWith('/audio/')) {res.writeHead(200,{'content-type':'audio/mp4'});res.end(readFileSync(join(fixture,req.url.split('?')[0])));return;}
  res.writeHead(200,{'content-type':'text/html'});res.end(html);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser = await chromium.launch();
let pass=0;
try {
 for (const width of [390,900]) {
  const page=await browser.newPage({viewport:{width,height:844},timezoneId:'America/Los_Angeles'});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/#/dated`);
  await page.waitForSelector('.transcript-chunk');
  const source=page.locator('#source-link'), updated=page.locator('#last-updated');
  assert.equal(await source.textContent(),'2020/10/19');
  assert.equal(await source.getAttribute('href'),'https://www.youtube.com/watch?v=original');
  assert.equal(await source.getAttribute('target'),'_blank');pass++;
  assert.match(await updated.textContent(),/Last updated:.*Sep 16, 2026.*6:14 PM PDT/);
  assert.equal(await updated.getAttribute('datetime'),'2026-09-17T01:14:00Z');pass++;
  if (process.env.SCREENSHOT_DIR) await page.screenshot({path:join(process.env.SCREENSHOT_DIR, `transcript-${width}.png`)});
  await page.click('#reading-btn');
  await page.click('#mode-summary');
  assert.match(await updated.textContent(),/6:14 PM PDT/);pass++;
  await page.click('#mini-next-btn');
  await page.waitForFunction(()=>document.querySelector('#last-updated')?.textContent.includes('10:20 AM'));
  assert.equal(await source.textContent(),'2020/10/19');pass++;
  const rect=await updated.boundingBox();assert.ok(rect.x>=0 && rect.x+rect.width<=width);pass++;
  for(const id of ['mini-prev-btn','mini-play-btn','mini-next-btn','ts-inc','follow-btn','reading-btn']){
    const box=await page.locator('#'+id).boundingBox();assert.ok(box && box.x>=0 && box.x+box.width<=width,`${id} fits at ${width}`);
  }pass++;
  await page.click('#mini-next-btn');
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('#last-updated')).display==='none');
  assert.equal(await updated.textContent(),'');assert.equal(await updated.getAttribute('datetime'),null);assert.equal(await source.getAttribute('href'),null);pass++;
  await page.click('#mini-next-btn');assert.equal(await updated.isVisible(),false);pass++;
  // Neither date: the row reserves nothing. Checked as footprint (width plus
  // margins) rather than display, because a wrapper hidden only by :has()
  // keeps its margin on engines without :has() (iOS Safari < 15.4).
  const footprint=await page.evaluate(()=>{const el=document.querySelector('.transcript-dates');const cs=getComputedStyle(el);return el.getBoundingClientRect().width+parseFloat(cs.marginLeft)+parseFloat(cs.marginRight);});
  assert.equal(footprint,0,'empty dates row reserves no space');pass++;
  await page.click('#mini-prev-btn');
  await page.click('#mini-prev-btn');
  await page.click('#mini-prev-btn');
  await page.waitForFunction(()=>document.querySelector('#last-updated')?.textContent.includes('6:14 PM'));
  await page.evaluate(()=>location.hash='#/pending');
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('#last-updated')).display==='none');
  assert.equal(await source.isVisible(),false);pass++;
  assert.deepEqual(errors,[]);pass++;
  await page.close();
 }
 console.log(`${pass} passed, 0 failed`);
} finally {await browser.close();await new Promise(r=>server.close(r));}
