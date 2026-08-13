/**
 * Browser-driven regression tests for the long-form NLE timeline tools.
 *
 * Covers slip, slide, rate stretch, type, plain trim, ripple and rolling by
 * driving real pointer drags in headless Chromium and asserting against the
 * sequence state the server persisted.
 *
 * Usage:  node scripts/nle-e2e/timeline-tools.test.mjs
 * Needs:  a running dashboard (PORT below) and `npm i playwright` + browser.
 *
 * It builds its own throwaway project (hardlinking an existing long-form
 * source, so no disk cost) and deletes it on exit. Real projects are never
 * written to.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.NLE_BASE || 'http://127.0.0.1:3199';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLIPS = path.join(REPO, 'viral_clips');
const CLIP = 'longform_nletest_1900000000.mp4';
const TEST_JSON = path.join(CLIPS, CLIP.replace(/\.mp4$/, '.json'));
const TEST_MP4 = path.join(CLIPS, CLIP);

/** Pick any existing long-form project to borrow a source video + metadata from. */
function findSourceProject() {
  if (process.env.NLE_SOURCE) return path.join(CLIPS, process.env.NLE_SOURCE);
  const candidate = fs.readdirSync(CLIPS)
    .filter((f) => f.endsWith('.json') && f.startsWith('longform_') && !f.startsWith('longform_nletest_'))
    .map((f) => path.join(CLIPS, f))
    .find((f) => fs.existsSync(f.replace(/\.json$/, '.mp4')));
  if (!candidate) throw new Error('No long-form project found in viral_clips to seed from');
  return candidate;
}

const SOURCE_JSON = findSourceProject();

/** Reset the throwaway project to three adjacent clips on the v1 video track. */
function reseed() {
  const project = JSON.parse(fs.readFileSync(SOURCE_JSON, 'utf8'));
  const sequence = project.creative.sequence.sequences[0];
  const video = sequence.tracks.find((t) => t.id === 'v1');
  video.clips = [
    { id: 'clipA', name: 'A', sourceType: 'program', sourceStart: 10, sourceEnd: 20, timelineStart: 0,  timelineEnd: 10 },
    { id: 'clipB', name: 'B', sourceType: 'program', sourceStart: 40, sourceEnd: 50, timelineStart: 10, timelineEnd: 20 },
    { id: 'clipC', name: 'C', sourceType: 'program', sourceStart: 80, sourceEnd: 90, timelineStart: 20, timelineEnd: 30 },
  ];
  project.creative.sequence.enabled = true;
  fs.writeFileSync(TEST_JSON, JSON.stringify(project));
}

function setup() {
  if (!fs.existsSync(TEST_MP4)) fs.linkSync(SOURCE_JSON.replace(/\.json$/, '.mp4'), TEST_MP4);
  reseed();
}
function teardown() {
  for (const f of [TEST_MP4, TEST_JSON]) if (fs.existsSync(f)) fs.unlinkSync(f);
}
process.on('exit', teardown);
setup();

async function state() {
  const d = await (await fetch(`${BASE}/api/longform/${CLIP}/project`)).json();
  const t = d.creative.sequence.sequences[0].tracks.find(x=>x.id==='v1');
  return Object.fromEntries(t.clips.map(c=>[c.id,{ts:+c.timelineStart.toFixed(2),te:+c.timelineEnd.toFixed(2),
    ss:+c.sourceStart.toFixed(2),se:+c.sourceEnd.toFixed(2),rate:+c.speed.rate.toFixed(3)}]));
}
async function titleCount() {
  const d = await (await fetch(`${BASE}/api/longform/${CLIP}/project`)).json();
  return d.creative.titles.length;
}

let pass=0, fail=0;
const check = (name, cond, detail) => { if (cond) { console.log(`  PASS ${name}`); pass++; }
  else { console.log(`  FAIL ${name} :: ${detail}`); fail++; } };

async function run(toolLabel, action) {
  reseed();
  const b = await chromium.launch();
  const p = await b.newPage({ viewport:{width:1600,height:950} });
  const errs=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
  await p.goto(`${BASE}/longform-editor/${CLIP}`, {waitUntil:'networkidle', timeout:45000});
  await p.waitForTimeout(2800);
  if (toolLabel) { await p.getByRole('button',{name:toolLabel,exact:true}).click(); await p.waitForTimeout(250); }
  await action(p);
  await p.waitForTimeout(1700);
  await b.close();
  return errs;
}
const dragEl = async (p, sel, dx) => {
  const box = await p.locator(sel).boundingBox();
  const cx=box.x+box.width/2, cy=box.y+box.height/2;
  await p.mouse.move(cx,cy); await p.mouse.down();
  for (let i=1;i<=10;i++) await p.mouse.move(cx+dx*i/10, cy);
  await p.mouse.up();
};

console.log('\n== SLIP: source window moves, timeline position and neighbours fixed');
let e = await run('Slip tool', p => dragEl(p,'[data-sequence-clip="clipB"]', 60));
let s = await state();
check('clipB timeline unchanged', s.clipB.ts===10 && s.clipB.te===20, JSON.stringify(s.clipB));
check('clipB source shifted',    s.clipB.ss!==40, JSON.stringify(s.clipB));
check('clipB duration kept',     Math.abs((s.clipB.se-s.clipB.ss)-10)<0.05, JSON.stringify(s.clipB));
check('neighbours untouched',    s.clipA.ts===0 && s.clipC.te===30, JSON.stringify([s.clipA,s.clipC]));
check('no console errors',       e.length===0, e[0]);

console.log('\n== SLIDE: clip moves, neighbours absorb, sequence length fixed');
e = await run('Slide tool', p => dragEl(p,'[data-sequence-clip="clipB"]', 40));
s = await state();
check('clipB moved later',       s.clipB.ts>10, JSON.stringify(s.clipB));
check('clipB duration kept',     Math.abs((s.clipB.te-s.clipB.ts)-10)<0.05, JSON.stringify(s.clipB));
check('clipB source untouched',  s.clipB.ss===40 && s.clipB.se===50, JSON.stringify(s.clipB));
check('prev extends to meet it', Math.abs(s.clipA.te-s.clipB.ts)<0.05, JSON.stringify([s.clipA,s.clipB]));
check('next starts at its end',  Math.abs(s.clipC.ts-s.clipB.te)<0.05, JSON.stringify([s.clipB,s.clipC]));
check('sequence length fixed',   s.clipC.te===30, JSON.stringify(s.clipC));
check('no console errors',       e.length===0, e[0]);

console.log('\n== RATE STRETCH: timeline duration changes, speed compensates');
e = await run('Rate stretch tool', async p => {
  await p.locator('[data-sequence-clip="clipB"]').click();   // select to expose trim handles
  await p.waitForTimeout(400);
  const h = await p.locator('[data-clip-trim="end"]').boundingBox();
  const x = h.x+h.width/2, y = h.y+h.height/2;
  await p.mouse.move(x,y); await p.mouse.down();
  for (let i=1;i<=10;i++) await p.mouse.move(x+40*i/10, y);
  await p.mouse.up();
});
s = await state();
check('clipB got longer',        s.clipB.te>20, JSON.stringify(s.clipB));
check('source range unchanged',  s.clipB.ss===40 && s.clipB.se===50, JSON.stringify(s.clipB));
check('rate compensates',        Math.abs(s.clipB.rate - 10/(s.clipB.te-s.clipB.ts))<0.02, JSON.stringify(s.clipB));
check('rate is slower than 1x',  s.clipB.rate<1, JSON.stringify(s.clipB));
check('no console errors',       e.length===0, e[0]);

console.log('\n== TYPE: clicking the timeline creates a title there');
const before = await titleCount();
e = await run('Type tool', async p => {
  const lane = p.locator('[data-timeline-track-lane]').first();
  const box = await lane.boundingBox();
  await p.mouse.click(box.x + box.width*0.4, box.y + box.height/2);
});
const after = await titleCount();
check('title created', after===before+1, `${before} -> ${after}`);
check('no console errors', e.length===0, e[0]);


const dragHandle = (edge, dx) => async p => {
  await p.locator('[data-sequence-clip="clipB"]').click();
  await p.waitForTimeout(400);
  const h = await p.locator(`[data-clip-trim="${edge}"]`).boundingBox();
  const x = h.x+h.width/2, y = h.y+h.height/2;
  await p.mouse.move(x,y); await p.mouse.down();
  for (let i=1;i<=10;i++) await p.mouse.move(x+dx*i/10, y);
  await p.mouse.up();
};

console.log('\n== PLAIN TRIM (Selection): drag survives leaving the 6px handle');
e = await run('Selection tool', dragHandle('end', 45));
s = await state();
check('clipB end moved',        s.clipB.te>21, JSON.stringify(s.clipB));
check('source end followed',    s.clipB.se>50, JSON.stringify(s.clipB));
check('neighbours untouched',   s.clipA.te===10 && s.clipC.ts===20, JSON.stringify([s.clipA,s.clipC]));
check('no console errors',      e.length===0, e[0]);

console.log('\n== RIPPLE: trimming end pushes following clips by the same delta');
e = await run('Ripple edit tool', dragHandle('end', 45));
s = await state();
const rippleDelta = +(s.clipB.te - 20).toFixed(2);
check('clipB end moved',        rippleDelta>1, JSON.stringify(s.clipB));
check('clipC pushed by delta',  Math.abs((s.clipC.ts-20)-rippleDelta)<0.1, `delta=${rippleDelta} clipC=${JSON.stringify(s.clipC)}`);
check('clipC duration kept',    Math.abs((s.clipC.te-s.clipC.ts)-10)<0.05, JSON.stringify(s.clipC));
check('no console errors',      e.length===0, e[0]);

console.log('\n== ROLLING: the shared edit point moves, total length fixed');
e = await run('Rolling edit tool', dragHandle('end', 45));
s = await state();
check('edit point moved',       s.clipB.te>21, JSON.stringify(s.clipB));
check('clipC start follows',    Math.abs(s.clipC.ts-s.clipB.te)<0.05, JSON.stringify([s.clipB,s.clipC]));
check('sequence length fixed',  s.clipC.te===30, JSON.stringify(s.clipC));
check('no console errors',      e.length===0, e[0]);

console.log(`\n==== ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
