import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {createAdminAi,adminState,callAdminDify} from '../ai.mjs';
import {SharedSimulation} from '../../traffic-sandbox/shared-simulation.mjs';
import {createSandboxServer} from '../../traffic-sandbox/server.mjs';
import {createAdminServer} from '../server.mjs';
import {AdminAuth} from '../auth.mjs';

const clone=value=>JSON.parse(JSON.stringify(value));
const decision=(payload,extra={})=>({answer:JSON.stringify({protocol:'campus-admin-v2',basis:'当前未启用认知与意愿分组，本次仍按原选路规则分析',status:'ok',intent:'set',state_version:JSON.parse(payload.query).state.stateVersion,reply:'准备调整。',changes:{northBypassShare:80},suggested_settings:{},evidence:['settings.northBypassShare'],...extra}),conversationId:'test-conversation'});
function fixture(options={}){
 const runtime=new SharedSimulation({running:true}),session={};let calls=0;
 const ai=createAdminAi({getPacket:async()=>clone(runtime.packet()),controlPacket:async input=>clone(runtime.control(input)),configProvider:async()=>({apiKey:'test-only'}),maxPerMinute:100,...options,model:async(config,payload)=>{calls++;return options.model?options.model(payload,runtime):decision(payload);}});
 const send=(question='北侧绕行比例设为80%',extra={})=>ai.request(session,{chatId:'test-chat-001',requestId:randomUUID(),question,...extra});
 return {runtime,session,ai,send,calls:()=>calls};
}
test('明确指令改变共享沙盘，重试同一请求不会重复执行；时间推进不使指令失效',async()=>{
 const f=fixture({model:async(p,r)=>{r.advance(.1);return decision(p);}}),requestId=randomUUID();
 const a=await f.send(undefined,{requestId});assert.equal(a.kind,'applied');assert.equal(a.changes[0].before,60);assert.equal(f.runtime.sim.settings.northBypassShare,80);
 const b=await f.send(undefined,{requestId});assert.deepEqual(b,a);assert.equal(f.calls(),1);assert.equal(f.runtime.settingsRevision,1);
 await assert.rejects(f.send('北侧绕行设为70%',{requestId}),{status:409});
});
test('只读检查与建议保持参数；方案需要单独执行，且可撤销实际调整',async()=>{
 const f=fixture({model:async p=>decision(p,{intent:'suggest',changes:{},suggested_settings:{northBypassShare:80},reply:'建议比较北侧绕行方案。'})});
 const p=await f.send('给一个优化方案');assert.equal(p.kind,'proposal');assert.equal(f.runtime.settingsRevision,0);
 const applied=await f.send('',{action:'apply'});assert.equal(applied.kind,'applied');assert.equal(f.calls(),1);assert.equal((await f.ai.status(f.session,'test-chat-001')).canUndo,true);
 const undo=await f.send('撤销上次调整');assert.equal(undo.kind,'undone');assert.equal(f.runtime.sim.settings.northBypassShare,60);assert.equal(undo.canUndo,false);
});
test('人工调整、ABA变化和重置都会阻断旧指令',async()=>{
 for(const mutate of [r=>r.control({action:'settings',settings:{electric:55}}),r=>{r.control({action:'settings',settings:{northBypassShare:70}});r.control({action:'settings',settings:{northBypassShare:60}});},r=>r.control({action:'reset'})]){
  const f=fixture({model:async(p,r)=>{mutate(r);return decision(p);}});await assert.rejects(f.send(),{status:409});assert.equal(f.runtime.sim.settings.northBypassShare,60);
 }
});
test('控制接口在写入前原子核对基准，防止读取后并发修改',async()=>{
 const runtime=new SharedSimulation({running:false});const before=clone(runtime.packet());runtime.control({action:'settings',settings:{electric:50}});
 assert.throws(()=>runtime.control({action:'settings',settings:{northBypassShare:80},expected:{runId:before.runId,settings:before.simulation.settings,settingsRevision:before.settingsRevision}}),{status:409});assert.equal(runtime.sim.settings.northBypassShare,60);
});
test('旧方案过期、人工调整后方案与撤回失效',async()=>{
 let clock=1000;const f=fixture({now:()=>clock,model:async p=>decision(p,{intent:'suggest',changes:{},suggested_settings:{northBypassShare:80}})});
 await f.send('优化');clock+=300001;assert.equal((await f.send('',{action:'apply'})).kind,'rejected');assert.equal(f.runtime.sim.settings.northBypassShare,60);
 await f.send('优化');f.runtime.control({action:'settings',settings:{demand:20}});assert.equal((await f.send('',{action:'apply'})).kind,'rejected');
 const g=fixture();await g.send();g.runtime.control({action:'settings',settings:{electric:55}});assert.equal((await g.send('',{action:'undo'})).kind,'rejected');assert.equal(g.runtime.sim.settings.northBypassShare,80);
});
test('越界、格式错误、额外变更和伪造证据不触发控制',async()=>{
 for(const extra of [{changes:{northBypassShare:120}},{changes:{northBypassShare:80,electric:70}},{evidence:['metrics.invented']}]){
  const f=fixture({model:async p=>decision(p,extra)});const result=await f.send();assert.equal(result.kind,'rejected');assert.equal(f.runtime.settingsRevision,0);
 }
 const f=fixture({model:async()=>({answer:'非结构化回复'})});assert.equal((await f.send()).kind,'rejected');assert.equal(f.runtime.settingsRevision,0);
});
test('回答过程中注销会话不能执行操作',async()=>{
 let authorized=true;const f=fixture({model:async p=>{authorized=false;return decision(p);}});
 await assert.rejects(f.ai.request(f.session,{chatId:'test-chat-001',requestId:randomUUID(),question:'绕行比例设为80%'},()=>authorized),{status:401});assert.equal(f.runtime.settingsRevision,0);
});
test('每会话并发和频率限制，失败后可以重新提问',async()=>{
 let release;const f=fixture({model:async p=>{await new Promise(resolve=>release=resolve);return decision(p);}});
 const first=f.send();await new Promise(resolve=>setImmediate(resolve));await assert.rejects(f.send(),{status:409});release();await first;
 const g=fixture({maxPerMinute:1});await g.send();await assert.rejects(g.send(),{status:429});
});
test('状态数据由本轮沙盘重建，错误来源与演示场景不能执行',()=>{
 const r=new SharedSimulation({running:false}),state=adminState(clone(r.packet()));assert.deepEqual(state.settings,r.sim.settings);assert.equal(state.metrics.westSignal.averageWait,null);assert.equal(state.metrics.westSignal.detectors,undefined);
 assert.throws(()=>adminState({...clone(r.packet()),source:'live'}),{status:503});r.control({action:'demo'});assert.throws(()=>adminState(clone(r.packet())),{status:422});
});

const listen=async s=>{await new Promise((resolve,reject)=>{s.once('error',reject);s.listen(0,'127.0.0.1',resolve);});return s.address().port;};
const close=async s=>{s.closeAllConnections();await new Promise(resolve=>s.close(resolve));};
test('部署检查点完整保留车辆、时间、队列和参数，仅运行ID改变',()=>{
 const old=new SharedSimulation({running:false,settings:{demand:12,northDemand:5}});old.sim.step(90);old.control({action:'settings',settings:{northBypassShare:80}});old.sim.step(10);
 const packet=clone(old.packet()),restored=new SharedSimulation({initialPacket:packet});assert.deepEqual(clone(restored.sim),packet.simulation);assert.equal(restored.settingsRevision,packet.settingsRevision);assert.notEqual(restored.runId,packet.runId);
});
test('真实HTTP链路：登录/CSRF/同源保护，SSE回答、白名单执行和私有配置隔离',async t=>{
 const runtime=new SharedSimulation({running:false}),key='test-only-bridge',seen=[];
 const upstream=http.createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;const payload=JSON.parse(body);seen.push({payload,authorization:req.headers.authorization});const d=decision(payload);res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({event:'message',answer:d.answer,conversation_id:d.conversationId})+'\n\ndata: '+JSON.stringify({event:'message_end',conversation_id:d.conversationId})+'\n\n');});
 const upstreamPort=await listen(upstream),sandbox=createSandboxServer({runtime,clock:false,controlKey:key}),sandboxPort=await listen(sandbox),auth=new AdminAuth();await auth.setup('ai_test_manager','only-test-password');
 const server=createAdminServer({auth,bridgeKey:key,sandboxPort,port:0,aiConfigProvider:async()=>({apiBase:'http://127.0.0.1:'+upstreamPort+'/v1',apiKey:'test-only-app-key',allowLoopback:true})}),port=await listen(server),base='http://127.0.0.1:'+port;
 t.after(async()=>{await close(server);await close(sandbox);await close(upstream);});
 async function request(path,{method='GET',data,cookie,csrf,origin=base}={}){const res=await fetch(base+path,{method,headers:{...(method==='POST'?{'Content-Type':'application/json',Origin:origin}:{}),...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}: {})},body:data===undefined?undefined:JSON.stringify(data),redirect:'manual'});const text=await res.text();let body;try{body=JSON.parse(text);}catch{}return {status:res.status,body,text,cookie:res.headers.get('set-cookie')?.split(';')[0]};}
 const input={chatId:'http-test-chat',requestId:randomUUID(),question:'北侧绕行设为80%'};
 assert.equal((await request('/api/admin/ai/chat',{method:'POST',data:input})).status,401);assert.equal((await request('/api/admin/ai/status?chatId=http-test-chat')).status,401);
 const login=await request('/api/admin/login',{method:'POST',data:{username:'ai_test_manager',password:'only-test-password'}});assert.equal(login.status,200);const cookie=login.cookie,csrf=(await request('/api/admin/session',{cookie})).body.csrfToken;
 assert.equal((await request('/api/admin/ai/chat',{method:'POST',data:input,cookie,csrf:'wrong'})).status,403);
 assert.equal((await request('/api/admin/ai/chat',{method:'POST',data:input,cookie,csrf,origin:'https://external.invalid'})).status,403);assert.equal(seen.length,0);
 const result=await request('/api/admin/ai/chat',{method:'POST',data:input,cookie,csrf});assert.equal(result.status,200);assert.equal(result.body.kind,'applied');assert.equal(runtime.sim.settings.northBypassShare,80);
 assert.equal(seen[0].authorization,'Bearer test-only-app-key');assert.deepEqual(JSON.parse(seen[0].payload.query).state.settings,{...runtime.sim.settings,northBypassShare:60});assert.equal(JSON.parse(seen[0].payload.query).state.runId,runtime.runId);
 assert.equal((await request('/api/admin/ai/chat',{method:'POST',data:input,cookie,csrf})).body.kind,'applied');assert.equal(seen.length,1);
 const html=await request('/',{cookie});assert.equal(html.status,200);assert.equal((html.text.match(/id="adminAssistant"/g)||[]).length,1);assert.match(html.text,/交通助手/);assert.doesNotMatch(html.text,/test-only-(?:app-key|bridge)/);
 for(const path of ['/private/dify-admin.json','/ai.mjs'])assert.equal((await request(path,{cookie})).status,404);
 for(const path of ['/admin-ai.mjs','/admin-ai.css']){const r=await request(path);assert.equal(r.status,200);assert.doesNotMatch(r.text,/test-only-(?:app-key|bridge)/);}
});
test('上游失败不向前端回显密钥或原始服务错误',async t=>{
 const s=http.createServer((req,res)=>{res.writeHead(500);res.end('internal secret data');});const port=await listen(s);t.after(()=>close(s));
 await assert.rejects(callAdminDify({apiBase:'http://127.0.0.1:'+port,allowLoopback:true,apiKey:'test-secret'},{}),error=>error.status===502&&!error.message.includes('secret'));
});
