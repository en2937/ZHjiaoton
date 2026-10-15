import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('./login-portal.mjs', import.meta.url), 'utf8');
const {portalImageRect, consumeLoginPortal, loadPortalMap, createLoginDeparture} = vm.runInNewContext(source + '\n({portalImageRect,consumeLoginPortal,loadPortalMap,createLoginDeparture});');
const viewport = {width: 1440, height: 900};
const valid = () => ({version: 2, expires: 11000, image: '/assets/Map.png',
  rect: {x: -200,y: -300,width: 1800,height: 1570}, viewport});
function storage(data) {
  let value = typeof data === 'string' ? data : JSON.stringify(data);
  return {getItem: () => value, setItem: (_, data) => {value = data;}, removeItem: () => {value = null;}};
}
test('cover geometry keeps the whole map aspect ratio and centers its crop', () => {
  for (const rect of [{left:-200,top:-150,width:1900,height:1200},{left:-70,top:-150,width:530,height:1150}]) {
    const image = portalImageRect(rect);
    assert.ok(image.width >= rect.width && image.height >= rect.height);
    assert.ok(Math.abs(image.width/image.height - 3875/3379) < 1e-8);
    assert.equal(image.x+image.width/2,rect.left+rect.width/2);
    assert.equal(image.y+image.height/2,rect.top+rect.height/2);
  }
});
test('handoff is consumed once and cannot replay on refresh', () => {
  const store = storage(valid()); assert.ok(consumeLoginPortal(store,1000,viewport));
  assert.equal(consumeLoginPortal(store,1000,viewport),null);
});
test('expired, malformed, external-image and resized handoffs safely fall back', () => {
  for (const change of [{expires:0},{expires:Infinity},{expires:undefined},{image:'https://example.com/map.png'},
    {image:'//example.com/assets/Map.png'},{image:'/assets/Map.png?external=1'},
    {image:'url("data:image/jpeg;base64,YQ==")'},
    {rect:{x:0,y:0,width:-1,height:20}},{rect:{x:0,y:0,width:Infinity,height:20}},
    {viewport:{width:390,height:844}},{version:1}]) {
    assert.equal(consumeLoginPortal(storage({...valid(),...change}),1000,viewport),null);
  }
  assert.equal(consumeLoginPortal(storage('{'),1000,viewport),null);
  assert.equal(consumeLoginPortal({getItem(){throw new Error('blocked');}},1000,viewport),null);
});

function loadingFixture(image) {
  let timeout = null, delay = null;
  const view = {Image: class {constructor() {return image;}},
    setTimeout(fn, ms) {timeout = fn; delay = ms; return 1;}, clearTimeout() {timeout = null;}};
  return {view, expire() {assert.equal(delay,1800); timeout();}, pending() {return timeout !== null;}};
}
test('the original map must be decoded before it can replace the thumbnail', async () => {
  let decoded;
  const image = {naturalWidth:3875,naturalHeight:3379,complete:false,decode:()=>new Promise(resolve=>{decoded=resolve;})};
  const fixture = loadingFixture(image);
  let ready = false;
  const load = loadPortalMap(fixture.view).then(value=>{ready=true;return value;});
  assert.equal(image.src,'/assets/Map.png');
  image.onload(); await Promise.resolve(); assert.equal(ready,false);
  decoded(); assert.equal(await load,image);
  assert.equal(fixture.pending(),false);
  assert.equal(image.onload,null); assert.equal(image.onerror,null);
});
test('an already cached original is also decoded', async () => {
  let decoded = 0;
  const image = {naturalWidth:3875,naturalHeight:3379,complete:true,decode:()=>{decoded++;}};
  const fixture = loadingFixture(image);
  assert.equal(await loadPortalMap(fixture.view),image);
  assert.equal(decoded,1); assert.equal(fixture.pending(),false);
});
test('network, decode and empty-image failures return a normal-login fallback', async () => {
  for (const mode of ['network','decode','empty']) {
    const image = {complete:false,naturalWidth:mode==='empty'?0:3875,naturalHeight:3379,
      decode:()=>Promise.reject(new Error('decode failed'))};
    const fixture = loadingFixture(image), load = loadPortalMap(fixture.view);
    if(mode==='network')image.onerror();else image.onload();
    assert.equal(await load,null); assert.equal(fixture.pending(),false);
  }
});
test('a hung decoder is bounded and cannot revive the portal after timeout', async () => {
  let decoded;
  const image = {complete:true,naturalWidth:3875,naturalHeight:3379,decode:()=>new Promise(resolve=>{decoded=resolve;})};
  const fixture = loadingFixture(image), load = loadPortalMap(fixture.view);
  fixture.expire(); assert.equal(await load,null); decoded();
  await Promise.resolve(); assert.equal(image.onload,null); assert.equal(image.onerror,null);
});
test('failed HD preparation does not hide the form or start the camera', async () => {
  const image = {complete:false}, fixture = loadingFixture(image), store = storage(null);
  const plane = {append(){assert.fail('No thumbnail zoom after an HD failure');}}, shell = {inert:false};
  const root = {querySelector:selector=>selector==='.backdrop-map'?plane:shell,
    createElement:()=>({}),head:{append(){}}};
  const view = {...fixture.view,sessionStorage:store,matchMedia:()=>({matches:false})};
  const leave = createLoginDeparture({gsap:{timeline(){assert.fail('No camera without HD');}},root,view,
    stopPan(){assert.fail('Decorative pan should remain intact');}});
  const pending = leave(); assert.equal(leave(),pending);
  image.onerror(); await pending; assert.equal(shell.inert,false);
});
