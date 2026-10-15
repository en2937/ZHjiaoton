import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const {gsap} = createRequire(import.meta.url)('../admin-access/vendor/gsap/dist/gsap.min.js');
const source = await readFile(new URL('./motion.mjs', import.meta.url), 'utf8');
function setup(reduced = false) {
  const mediaEvents = new Map(), documentEvents = new Map(), windowEvents = new Map();
  const events = map => ({addEventListener: (key, value) => map.set(key, value), removeEventListener: key => map.delete(key)});
  const media = {matches: reduced, ...events(mediaEvents)};
  const document = {hidden: false, ...events(documentEvents)}, window = events(windowEvents);
  const factory = vm.runInNewContext(source + '\ncreateUiMotion;', {document, window, matchMedia: () => media});
  const motion = factory(gsap);
  return {motion, document, window, reduce() {media.matches = true; mediaEvents.get('change')();},
    destroy() {windowEvents.get('pagehide')({persisted: false});}, documentEvents, windowEvents};
}
test('camera interpolates display coordinates and interruption keeps its current position', () => {
  const h = setup(), view = {x: 0, y: 0, scale: 1}, packet = {time: 123, cars: [{p: 42}]};
  let draws = 0;
  const tween = h.motion.camera(view, {x: 100, y: 50, scale: 2}, () => draws++);
  tween.progress(.5);
  assert.equal(view.x, 50); assert.equal(view.y, 25); assert.equal(view.scale, 1.5); assert.ok(draws > 0);
  h.motion.stop(view); assert.equal(gsap.getTweensOf(view).length, 0); assert.equal(view.x, 50);
  assert.deepEqual(packet, {time: 123, cars: [{p: 42}]}); h.destroy();
});
test('reduced motion places the camera and finishes panel closing immediately', () => {
  const h = setup(true), view = {x: 0, y: 0, scale: 1}, panel = {hidden: false};
  assert.equal(h.motion.camera(view, {x: 80, y: 20, scale: 2}, () => {}), null);
  assert.deepEqual(view, {x: 80, y: 20, scale: 2});
  h.motion.hide(panel, () => {panel.hidden = true;}); assert.equal(panel.hidden, true); h.destroy();
});
test('changing preference during a transition completes the final state and its close callback', () => {
  const h = setup(), view = {x: 0, y: 0, scale: 1};
  const panel = {hidden: false, autoAlpha: 1, y: 0, clearProps: ''};
  h.motion.camera(view, {x: 80, y: 20, scale: 2}, () => {});
  h.motion.hide(panel, () => {panel.hidden = true;}); h.reduce();
  assert.equal(view.x, 80); assert.equal(view.scale, 2); assert.equal(panel.hidden, true);
  assert.equal(gsap.getTweensOf(view).length, 0); h.destroy();
});
test('hidden document settles finite effects and non-BFCache navigation removes listeners', () => {
  const h = setup(), view = {x: 0}; h.motion.camera(view, {x: 10}, () => {});
  h.document.hidden = true; h.documentEvents.get('visibilitychange')(); assert.equal(view.x, 10);
  h.destroy(); assert.equal(h.documentEvents.size, 0); assert.equal(h.windowEvents.size, 0);
});
function scrollSetup(reduced = false) {
  const h = setup(reduced);
  h.window.innerHeight = 800;
  h.page = h.document.scrollingElement = {scrollTop:2400,scrollHeight:6000};
  h.element = {getBoundingClientRect:()=>({top:-2000,height:650})};
  return h;
}
test('page travel accelerates and decelerates before focusing the map', () => {
  const h = scrollSetup(); let arrived = 0;
  const tween = h.motion.scrollTo(h.element,()=>arrived++);
  tween.progress(.1); const early = 2400-h.page.scrollTop;
  tween.progress(.5); const halfway = h.page.scrollTop;
  tween.progress(.9); const late = h.page.scrollTop-384;
  assert.equal(halfway,(2400+384)/2);
  assert.ok(early>0 && early<50); assert.ok(late>0 && late<50);
  assert.equal(arrived,0);
  tween.progress(1); assert.equal(h.page.scrollTop,384); assert.equal(arrived,1);
  assert.equal(h.windowEvents.has('wheel'),false); assert.equal(h.windowEvents.has('keydown'),false); h.destroy();
});
test('manual scrolling interrupts travel without running the deferred map zoom', () => {
  for (const action of ['wheel','touchstart','pointerdown','resize','keydown']) {
    const h = scrollSetup(); let arrived = 0;
    const tween = h.motion.scrollTo(h.element,()=>arrived++); tween.progress(.4);
    const stopped = h.page.scrollTop;
    h.windowEvents.get(action)(action==='keydown'?{key:'PageUp'}:{});
    assert.equal(h.page.scrollTop,stopped); assert.equal(arrived,0);
    assert.equal(h.windowEvents.has('wheel'),false); h.destroy();
  }
});
test('repeated observation requests replace the previous destination', () => {
  const h = scrollSetup(); let stale = 0, latest = 0;
  h.motion.scrollTo(h.element,()=>stale++).progress(.3);
  const tween = h.motion.scrollTo(h.element,()=>latest++); tween.progress(1);
  assert.equal(stale,0); assert.equal(latest,1); h.destroy();
});
test('visible maps stay in place and reduced motion positions an offscreen map immediately', () => {
  const h = scrollSetup(); let arrived = 0;
  assert.equal(h.motion.scrollTo({getBoundingClientRect:()=>({top:16,height:650})},()=>arrived++),null);
  assert.equal(h.page.scrollTop,2400); assert.equal(arrived,1); h.destroy();
  const reduced = scrollSetup(true);
  assert.equal(reduced.motion.scrollTo(reduced.element,()=>arrived++),null);
  assert.equal(reduced.page.scrollTop,384); assert.equal(arrived,2); reduced.destroy();
});
test('page exit or a reduced-motion change settles deferred camera work without a stray tween', () => {
  for (const action of ['destroy','reduce']) {
    const h = scrollSetup(), view = {x:0};
    h.motion.scrollTo(h.element,()=>h.motion.camera(view,{x:200},()=>{}));
    h[action](); assert.equal(h.page.scrollTop,384); assert.equal(view.x,200);
    assert.equal(gsap.getTweensOf(view).length,0); assert.equal(h.windowEvents.has('wheel'),false);
    if(action==='reduce')h.destroy();
    assert.equal(h.windowEvents.size,0);
  }
});
test.after(() => gsap.ticker.sleep());
