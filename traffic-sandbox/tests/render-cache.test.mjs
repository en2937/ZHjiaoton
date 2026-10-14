import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import vm from 'node:vm';
import * as engine from '../dist/engine.mjs';
import * as routes from '../dist/route.mjs';
import {createVehicleInterpolator} from '../dist/shared-client.mjs';

// Execute the real app in a DOM/canvas test double. Counts are CPU drawing calls, not GPU/FPS measurements.
async function harness(source){
 let now=0,metricsCalls=0,options=null,box={width:900,height:720},nextId=0;
 const frames=new Map(),elements=new Map(),layers=[],events=new Map();
 function element(id){
  if(elements.has(id))return elements.get(id);
  const children=new Map(),listeners=new Map();
  const item={id,width:0,height:0,style:{},dataset:{},hidden:false,classList:{toggle(){},remove(){}},setAttribute(){},
   getBoundingClientRect:()=>({...box,left:0,top:0}),addEventListener:(name,fn)=>listeners.set(name,fn),listeners,
   querySelector:name=>{if(!children.has(name))children.set(name,element(id+'-'+name));return children.get(name);},
   setPointerCapture(){},click(){}};
  elements.set(id,item);return item;
 }
 function makeCanvas(id){
  const item=element(id),counts={map:0,bitmap:0,lines:0,text:0};
  const context={setTransform(){},fillRect(){},clearRect(){},setLineDash(){},beginPath(){},moveTo(){},lineTo(){counts.lines++;},
   stroke(){},fill(){},arc(){},roundRect(){},measureText:text=>({width:text.length*6}),fillText(){counts.text++;},
   drawImage:image=>{if(image instanceof Image)counts.map++;else counts.bitmap++;}};
  item.getContext=()=>context;item.counts=counts;layers.push(item);return item;
 }
 class Image{complete=true;naturalWidth=1687;naturalHeight=1472;}
 class Simulation extends engine.Simulation{metrics(){metricsCalls++;return super.metrics();}}
 const document={getElementById:id=>element(id),createElement:name=>name==='canvas'?makeCanvas('layer-'+layers.length):element(name),
  querySelectorAll:()=>[],addEventListener:(name,fn)=>events.set(name,fn),hidden:false,activeElement:null};
 makeCanvas('map');
 const context=vm.createContext({document,window:{addEventListener(){}},Image,devicePixelRatio:1,
  ResizeObserver:class{observe(){}},matchMedia:()=>({matches:false,addEventListener(){}}),
  requestAnimationFrame:fn=>{frames.set(++nextId,fn);return nextId;},cancelAnimationFrame:id=>frames.delete(id),
  performance:{now:()=>now},console,setTimeout(){},Blob,URL});
 const shared={createVehicleInterpolator,createSharedClient:input=>{options=input;return{start(){},read(){},command(){}};}};
 const sources={'./route.mjs':routes,'./engine.mjs':{...engine,Simulation},'./shared-client.mjs':shared};
 const module=new vm.SourceTextModule(source+'\nexport const rendererTest={draw,resize,selectJunction,getMap:()=>map};',{context});
 await module.link(name=>{
  const values=sources[name],keys=Object.keys(values);
  return new vm.SyntheticModule(keys,function(){for(const key of keys)this.setExport(key,values[key]);},{context});
 });await module.evaluate();
 const api=module.namespace.rendererTest;api.resize();
 return {api,layers,elements,document,events,context,frames,
  feed:(packet,time)=>{now=time;options.onState(packet);},setBox:value=>{box=value;},
  metrics:()=>metricsCalls,pump(time){now=time;const scheduled=[...frames.values()];frames.clear();for(const fn of scheduled)fn(now);}};
}
const current=await readFile(new URL('../dist/app.mjs',import.meta.url),'utf8');
const sim=new engine.Simulation({settings:{demand:30,motorDemand:6}});sim.step(180);
const packet=()=>({instanceId:'one',runId:'one',revision:1,running:true,speed:4,simulation:structuredClone(sim)});

test('fixed view reuses static maps/labels and cached metrics across 180 frames',async()=>{
 const view=await harness(current);view.feed(packet(),0);view.pump(0);
 const mapCount=view.layers.reduce((n,layer)=>n+layer.counts.map,0),metricCount=view.metrics();
 for(let i=1;i<=180;i++)view.api.draw(i*1000/60);
 assert.equal(mapCount,1);assert.equal(view.layers.reduce((n,l)=>n+l.counts.map,0),mapCount);assert.equal(view.metrics(),metricCount);
 assert.ok(view.layers[0].counts.bitmap>=360);
});
test('zoom/pan requests coalesce; camera, size, DPR and image changes rebuild static layers',async()=>{
 const view=await harness(current);view.feed(packet(),0);view.pump(0);
 const maps=()=>view.layers.reduce((n,l)=>n+l.counts.map,0);
 for(let i=0;i<8;i++)view.elements.get('zoomIn').onclick();assert.equal(view.frames.size,1);view.pump(16);assert.equal(maps(),2);
 const canvas=view.elements.get('map');canvas.listeners.get('pointerdown')({clientX:10,clientY:10,pointerId:1});
 for(let i=1;i<9;i++)canvas.listeners.get('pointermove')({clientX:10+i,clientY:10+i});
 assert.equal(view.frames.size,1);view.pump(32);assert.equal(maps(),3);
 view.api.selectJunction(1);view.pump(48);assert.equal(maps(),3);
 view.setBox({width:1000,height:740});view.api.resize();view.pump(64);assert.equal(maps(),4);
 view.context.devicePixelRatio=2;view.api.resize();view.pump(80);assert.equal(maps(),5);
 assert.equal(canvas.width,2000);assert.equal(view.layers[1].width,2000);
 view.api.getMap().onload();view.pump(96);assert.equal(maps(),6);
});
test('paused and hidden tabs stop continuous paints; new state still updates',async()=>{
 const view=await harness(current);view.feed(packet(),0);view.pump(0);assert.equal(view.frames.size,0);
 sim.step(.6);view.feed(packet(),150);view.pump(166);assert.ok(view.frames.size>0);
 const paused={...packet(),running:false};view.feed(paused,180);view.pump(181);assert.equal(view.frames.size,0);
 view.document.hidden=true;view.events.get('visibilitychange')();assert.equal(view.frames.size,0);
 view.document.hidden=false;view.events.get('visibilitychange')();view.pump(190);assert.equal(view.frames.size,0);
});
if(process.env.RENDER_BASELINE_FILE){
 test('record old/new drawing work for the same 180-frame view',async()=>{
  const baseline=await readFile(process.env.RENDER_BASELINE_FILE,'utf8'),before=await harness(baseline),after=await harness(current);
  for(const view of [before,after]){
   view.feed(packet(),0);for(const layer of view.layers)for(const key of Object.keys(layer.counts))layer.counts[key]=0;
   for(let i=0;i<180;i++)view.api.draw(i*1000/60);
  }
  const counts=view=>({mapResamples:view.layers.reduce((n,l)=>n+l.counts.map,0),pathSegments:view.layers.reduce((n,l)=>n+l.counts.lines,0),metricsCalls:view.metrics()});
  const result={frames:180,vehicles:sim.cars.length,before:counts(before),after:counts(after),method:'Real app in a canvas test double, same simulation state; not FPS/GPU timing.'};
  assert.equal(result.before.mapResamples,180);assert.equal(result.after.mapResamples,1);
  assert.ok(result.after.pathSegments<result.before.pathSegments*.1);
  if(process.env.RENDER_REPORT_FILE)await writeFile(process.env.RENDER_REPORT_FILE,JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
 });
}
