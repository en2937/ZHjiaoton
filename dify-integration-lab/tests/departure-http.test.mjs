import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {SharedSimulation} from '../../traffic-sandbox/shared-simulation.mjs';
import {studentStateFromSandbox} from '../../traffic-sandbox/student-data.mjs';
import {createLabServer} from '../server.mjs';
import {createDepartureForecaster} from '../departure-forecast.mjs';
const trip={origin:'1',destination:'2',mode:'electric'};
const body={question:'我想去东教上早八，我几点出发最好？',trip,preference:'time',sessionId:'forecast-http-session'};
async function setup(t,options={}){
 const runtime=new SharedSimulation({running:false,settings:{demand:12,motorDemand:2,northDemand:1},departureScenario:{mode:'survey',classTime:'08:00',totalPeople:72}});runtime.sim.step(90);
 let configReads=0,reads=0;const before=structuredClone(runtime.packet());
 const server=createLabServer(async()=>{configReads++;return {};},{studentProvider:async trip=>studentStateFromSandbox(runtime.packet(),trip),snapshotProvider:async()=>{reads++;return options.packet?options.packet(runtime.packet(),reads):runtime.packet();},...(options.forecaster?{forecaster:options.forecaster}:{})});
 server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{const ended=once(server,'close');server.close();server.closeAllConnections();await ended;});
 const post=async value=>{const res=await fetch(base+'/api/student/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,...value})});return {status:res.status,data:await res.json()};};
 return {runtime,before,post,base,configReads:()=>configReads};
}
test('真实后台Worker返回建议，HTTP主线程可响应，暂停的管理员状态逐字段不变',async t=>{
 const h=await setup(t),pending=h.post({});let responses=0;const timer=setInterval(async()=>{const r=await fetch(h.base+'/api/student/state');if(r.ok)responses++;},75);
 const reply=await pending;clearInterval(timer);assert.equal(reply.status,200);assert.equal(reply.data.provider,'sandbox-forecast');assert.equal(reply.data.status,'ok');assert(responses>2);assert.equal(h.configReads(),0);
 const after=structuredClone(h.runtime.packet());for(const key of ['runId','settingsRevision','initialSeed','running','speed','simulation'])assert.deepEqual(after[key],h.before[key]);
 const cached=await h.post({});assert.equal(cached.data.forecast.cacheHit,true);assert.equal(cached.data.forecast.fingerprint,reply.data.forecast.fingerprint);
});
test('缺少时刻直接澄清、不调用模型；跨站与私有源码仍拒绝',async t=>{
 const h=await setup(t);assert.equal((await h.post({question:'几点出发最好？'})).data.status,'need_clarification');assert.equal(h.configReads(),0);
 const denied=await fetch(h.base+'/api/student/chat',{method:'POST',headers:{Origin:'https://evil.invalid'},body:JSON.stringify(body)});assert.equal(denied.status,403);
 for(const path of ['/departure-forecast.mjs','/departure-forecast-worker.mjs','/.env.local'])assert.equal((await fetch(h.base+path)).status,404);
});
test('推演期间方案变更拒绝旧建议，缺失共享状态明确失败',async t=>{
 const forecaster={run:async()=>({status:'ok',recommendation:{departureTime:'07:50'}}),dispose(){}};
 const h=await setup(t,{forecaster,packet:(p,n)=>({...p,settingsRevision:p.settingsRevision+(n>1?1:0)})});const stale=await h.post({});assert.equal(stale.status,409);assert.equal(stale.data.error,'forecast_stale');
 const bad=await setup(t,{packet:()=>({source:'fixture'})}),missing=await bad.post({});assert.equal(missing.status,503);assert.equal(missing.data.error,'sandbox_unavailable');
});
test('未找到可行时刻只给出原因，不伪造建议或让Dify补数字',async t=>{
 const h=await setup(t,{forecaster:{run:async()=>({status:'no_feasible_departure',reason:'当前条件下未找到可行出发时间。'}),dispose(){}}});const r=await h.post({});assert.equal(r.status,200);assert.equal(r.data.status,'no_feasible_departure');assert.equal(r.data.forecast.recommendation,undefined);assert.equal(h.configReads(),0);
});
test('网页异步请求立即202，短请求轮询真实Worker完成后获得相同建议',async t=>{
 const h=await setup(t),start=await h.post({forecastAsync:true});assert.equal(start.status,202);assert.equal(start.data.status,'forecast_pending');let result=start;
 const deadline=Date.now()+30000;while(result.status===202&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,start.data.retryAfterMs));result=await h.post({forecastAsync:true,forecastJobId:start.data.jobId});}
 assert.equal(result.status,200);assert.equal(result.data.provider,'sandbox-forecast');assert.equal(result.data.status,'ok');assert.equal(h.configReads(),0);
 const stale=await h.post({forecastAsync:true,forecastJobId:'old-job'});assert.equal(stale.status,409);
});
