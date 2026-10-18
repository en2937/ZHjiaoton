import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';

// Exercise the handwritten browser controller, with DOM/network boundaries only
// replaced. Generated motion code is tested by ui-motion's own suite.
const source=(await readFile(new URL('../public/student/app.mjs',import.meta.url),'utf8')).split('// END GENERATED UI MOTION')[1];
class Node {
  constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.style={};this.attributes={};this.value='';this.hidden=false;this.disabled=false;this._text='';this.className='';this.classList={toggle:()=>{}};}
  get textContent(){return this._text+this.children.map(n=>n.textContent).join('');}
  set textContent(v){this._text=v;this.children=[];}
  append(...nodes){for(const n of nodes){n.parent=this;this.children.push(n);}}
  setAttribute(k,v){this.attributes[k]=v;}
  replaceChildren(...nodes){this.children=[];this.append(...nodes);}
  replaceWith(node){if(!this.parent)return;const p=this.parent,i=p.children.indexOf(this);p.children[i]=node;node.parent=p;}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);}
  cloneNode(){const n=new Node(this.tagName);n._text=this._text;return n;}
  focus(){}
  querySelector(){return new Node('svg');}
}
const response=(data,status=200,retryAfter=null)=>({ok:status<400,status,headers:{get:name=>name==='Retry-After'?retryAfter:null},json:async()=>data});
async function setup({configured=true,localRoutingEnabled=true,chat}={}){
  const ids=Object.fromEntries(['origin','destination','question','question-form','welcome','conversation','status','reset-chat','swap-places','cancel-question','send','studentSimulationClock','studentDataSourceNote'].map(id=>[id,new Node()]));
  ids.origin.value='1';ids.destination.value='2';ids.origin.options=[{value:'1',textContent:'宿舍'},{value:'2',textContent:'教学区'}];ids.destination.options=ids.origin.options;
  const listeners={},timers=new Map(),calls=[];let timerId=0,now=0;
  const document={hidden:false,getElementById:id=>ids[id],querySelector:()=>new Node(),querySelectorAll:selector=>selector==='button,select,textarea'?[ids['reset-chat'],ids['cancel-question'],ids.question,ids.send]:[],createElement:tag=>new Node(tag),createElementNS:(_ns,tag)=>new Node(tag),createTextNode:text=>{const n=new Node();n.textContent=text;return n;},addEventListener:(name,fn)=>listeners[name]=fn};
  const context={document,crypto:webcrypto,URLSearchParams,AbortController,AbortSignal,console,Date:class extends Date{static now(){return now;}},Math,uiMotion:{choice:()=>()=>{},reveal(){},reply(){},rotate(){}},setTimeout:(fn,delay)=>{timers.set(++timerId,{fn,delay});return timerId;},clearTimeout:id=>timers.delete(id),setInterval:(fn,delay)=>{timers.set(++timerId,{fn,delay});return timerId;},clearInterval:id=>timers.delete(id),fetch:async(url,opts={})=>{calls.push({url,opts});if(url==='/api/student/options')return response({configured,localRoutingEnabled,places:[],modes:[]});if(url.startsWith('/api/student/state'))return response({runId:1,settings:{}});return chat?chat(url,opts):response({status:'missing_data',provider:'local-routing',message:'本地结果'});}};
  vm.createContext(context);await new vm.Script('(async()=>{'+source+';globalThis.ui={ask,reset,renderReply,refreshLive};})()').runInContext(context);
  const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
  const fire=async delay=>{const item=[...timers].find(([,t])=>t.delay===delay);assert.ok(item,'timer '+delay+' scheduled');timers.delete(item[0]);now+=delay;item[1].fn();await flush();};
  return {ids,document,listeners,timers,calls,ui:context.ui,flush,fire};
}

test('cancel aborts transport, restores question, and ignores a late response',async()=>{
  let resolve;const h=await setup({chat:()=>new Promise(r=>resolve=r)});const request=h.ui.ask('复杂路线问题');await h.flush();
  const call=h.calls.find(c=>c.url==='/api/student/chat');assert.ok(call.opts.signal);assert.equal(h.ids['cancel-question'].hidden,false);assert.equal(h.ids['cancel-question'].disabled,false);assert.equal(h.ids['reset-chat'].disabled,false);
  h.ids['cancel-question'].onclick();assert.equal(call.opts.signal.aborted,true);assert.equal(h.ids.question.value,'复杂路线问题');assert.equal(h.ids.send.disabled,false);assert.ok([...h.timers.values()].every(t=>t.delay>=5000&&t.delay<6000),'cancel clears request timers, retaining only background polling');
  resolve(response({status:'missing_data',provider:'school-dify',message:'迟来的回答'}));await request;assert.doesNotMatch(h.ids.conversation.textContent,/迟来的回答/);
});
test('reset aborts request and late completion cannot pollute the new conversation',async()=>{
  let resolve;const h=await setup({chat:()=>new Promise(r=>resolve=r)});const request=h.ui.ask('旧问题');await h.flush();h.ui.reset();
  assert.equal(h.calls.find(c=>c.url==='/api/student/chat').opts.signal.aborted,true);resolve(response({status:'missing_data',message:'旧回答'}));await request;assert.doesNotMatch(h.ids.conversation.textContent,/旧回答/);assert.equal(h.ids.send.disabled,false);
});
test('browser deadline ends waiting without trusting a transport that ignores abort',async()=>{
  const h=await setup({chat:()=>new Promise(()=>{})});const request=h.ui.ask('慢问题');await h.flush();await h.fire(13000);await request;
  assert.equal(h.ids.question.value,'慢问题');assert.equal(h.ids.send.disabled,false);assert.match(h.ids.status.textContent,/超时|未完成/);assert.equal(h.calls.filter(c=>c.url==='/api/student/chat').length,1);
});
test('AI failure offers local query only on explicit click, without automatic retries',async()=>{
  let count=0;const h=await setup({chat:()=>++count===1?response({error:'ai_busy'},429,'30'):response({status:'missing_data',provider:'local-routing',message:'本地结果'})});await h.ui.ask('复杂问题');
  assert.equal(count,1);assert.equal(h.ids.question.value,'复杂问题');assert.match(h.ids.status.textContent,/30/);
  const walk=n=>[n,...n.children.flatMap(walk)];const fallback=walk(h.ids.conversation).find(n=>n.tagName==='BUTTON'&&n.textContent==='按当前偏好查看本地路线');assert.ok(fallback);await fallback.onclick();
  assert.equal(count,2);assert.equal(JSON.parse(h.calls.filter(c=>c.url==='/api/student/chat')[1].opts.body).question,'按当前偏好推荐路线');
});
test('local result identifies its source and missing AI configuration keeps local service usable',async()=>{
  const h=await setup({configured:false});assert.match(h.ids.status.textContent,/AI/);assert.doesNotMatch(h.ids.status.textContent,/出行服务暂不可用/);
  const reply=h.ui.renderReply({status:'missing_data',provider:'local-routing',message:'本地结果'},{origin:'1',destination:'2',mode:'electric'});assert.match(reply.textContent,/本地路线计算/);await h.ui.ask('哪条路更快？');await h.flush();assert.match(h.ids.conversation.textContent,/本地结果/);assert.ok([...h.timers.values()].every(t=>t.delay>=5000&&t.delay<6000),'success clears deadline and progress timers');
});
test('rate limits and gateway capacity failures remain transport notices without misleading AI fallback',async()=>{
  for(const code of ['rate_limited','gateway_busy','invalid_json','body_too_large']){const h=await setup({chat:()=>response({error:code},429,'15')});await h.ui.ask('测试问题');assert.doesNotMatch(h.ids.conversation.textContent,/AI 暂未完成回答|按当前偏好查看本地路线/,code);assert.match(h.ids.status.textContent,/15/);assert.equal(h.calls.filter(c=>c.url==='/api/student/chat').length,1);}
});
test('disabled local routing never offers a local fallback after an AI failure',async()=>{
  const h=await setup({localRoutingEnabled:false,chat:()=>response({error:'ai_timeout'},504)});await h.ui.ask('复杂问题');assert.doesNotMatch(h.ids.conversation.textContent,/按当前偏好查看本地路线/);assert.equal(h.ids.question.value,'复杂问题');
});
test('visibility pauses polling and resumes immediately with a jittered five second schedule',async()=>{
  const h=await setup();assert.ok([...h.timers.values()].some(t=>t.delay>=5000&&t.delay<=6000));const before=h.calls.length;h.document.hidden=true;h.listeners.visibilitychange();await h.ui.refreshLive();assert.equal(h.calls.length,before);assert.equal(h.timers.size,0);
  h.document.hidden=false;h.listeners.visibilitychange();await h.flush();assert.equal(h.calls.length,before+1);assert.ok([...h.timers.values()].some(t=>t.delay>=5000&&t.delay<=6000));
});
test('slow request status reports bounded waiting after three seconds without invented queue positions',async()=>{
  let resolve;const h=await setup({chat:()=>new Promise(r=>resolve=r)});const request=h.ui.ask('慢问题');await h.flush();await h.fire(3000);assert.match(h.ids.status.textContent,/9\s*秒/);assert.doesNotMatch(h.ids.status.textContent,/第.*位/);h.ids['cancel-question'].onclick();resolve(response({status:'missing_data',message:'late'}));await request;
});
