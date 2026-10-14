import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {createSandboxServer} from '../../traffic-sandbox/server.mjs';
import {SharedSimulation} from '../../traffic-sandbox/shared-simulation.mjs';
import {createSharedClient} from '../../traffic-sandbox/dist/shared-client.mjs';
import {journeyRefs,studentStateFromSandbox} from '../../traffic-sandbox/student-data.mjs';
import {roadGeometry,pointOnEdge,vehiclePosition} from '../../traffic-sandbox/dist/engine.mjs';
import {createSandboxClient} from '../sandbox-client.mjs';
import {createLabServer} from '../server.mjs';
async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return 'http://127.0.0.1:'+server.address().port;}
async function stop(server){const end=once(server,'close');server.close();server.closeAllConnections();await end;}
const trip={origin:'1',destination:'2',mode:'electric'};
test('upgrading a live snapshot retains time and vehicle positions while adding the independent control',()=>{
 const old=new SharedSimulation({running:false});old.sim.step(3);
 const packet=JSON.parse(JSON.stringify(old.packet()));delete packet.simulation.settings.northBypassShare;packet.simulation.settings.branchShare=70;delete packet.simulation.bypassStats;
 for(const car of packet.simulation.cars)delete car.routingChoice;
 const positions=packet.simulation.cars.map(c=>vehiclePosition(c)),time=packet.simulation.time;
 const upgraded=new SharedSimulation({initialPacket:packet});
 assert.equal(upgraded.sim.time,time);assert.deepEqual(upgraded.sim.cars.map(c=>vehiclePosition(c)),positions);
 assert.equal(upgraded.sim.settings.northBypassShare,60);assert(!('branchShare' in upgraded.sim.settings));assert.equal(upgraded.running,false);
});
async function setup(t){
 const runtime=new SharedSimulation({running:false}),sandbox=createSandboxServer({runtime,clock:false,controlKey:'test-control-key'}),sandboxBase=await listen(sandbox),calls=[];
 const upstream=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw),input=JSON.parse(body.query);calls.push(input);
  const criterion=input.question.includes('近')?'distance':input.preference,field=criterion==='time'?'travelTimeSeconds':'distanceMeters';
  const best=[...input.state.routes].sort((a,b)=>a[field]-b[field])[0];
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({answer:JSON.stringify({status:'ok',criterion,recommended_route_id:best.id,travelTimeSeconds:99999}),conversation_id:'sandbox-test'}));});
 const upstreamBase=await listen(upstream),studentProvider=createSandboxClient({base:sandboxBase});
 const lab=createLabServer(async()=>({apiBase:upstreamBase+'/v1',apiKey:'only-a-test-key',allowLoopback:true}),{studentProvider}),base=await listen(lab);
 t.after(async()=>{await stop(lab);await stop(upstream);await stop(sandbox);});
 const post=async(body,path='/api/student/chat',url=base)=>{const res=await fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json',...(path==='/api/control'?{'X-Admin-Control-Key':'test-control-key'}:{})},body:JSON.stringify(body)});return {status:res.status,data:await res.json()};};
 const state=async()=>{const res=await fetch(base+'/api/student/state?'+new URLSearchParams(trip));return res.json();};
 const ask=(patch={})=>post({question:'哪条路更快？',trip,preference:'time',sessionId:'shared-test-session',...patch});
 return {runtime,sandbox,sandboxBase,base,studentProvider,calls,post,state,ask};
}
test('两个沙盘视图共享参数、暂停和重置，C端读取同一版本',async t=>{
 const h=await setup(t),seen=[null,null],fetcher=(url,options)=>fetch(h.sandboxBase+url,options);
 const clients=seen.map((_,i)=>createSharedClient({fetcher,controlHeaders:()=>({'X-Admin-Control-Key':'test-control-key'}),onState:p=>seen[i]=p,onError:e=>{throw e;}}));
 await Promise.all(clients.map(c=>c.read()));assert.equal(seen[0].stateVersion,seen[1].stateVersion);
 await clients[0].command({action:'settings',settings:{demand:44,northBypassShare:60,westSignalMode:'fixed'}});await clients[1].read();
 const cState=await h.state();assert.equal(cState.stateVersion,seen[0].stateVersion);assert.equal(cState.settings.demand,44);assert.equal(seen[1].simulation.settings.northBypassShare,60);
 await clients[0].command({action:'play',running:true});h.runtime.advance(.25);const moved=h.runtime.sim.time;assert.ok(Math.abs(moved-1)<1e-8);
 await clients[1].command({action:'play',running:false});h.runtime.advance(.25);assert.equal(h.runtime.sim.time,moved);
 const old=(await h.state()).runId;await clients[0].command({action:'reset'});const reset=await h.state();assert.notEqual(reset.runId,old);assert.equal(reset.simulationTimeSeconds,0);assert.equal(reset.settings.demand,44);
});
test('每轮AI输入为实时沙盘状态，不能用fixture或模型数字替代',async t=>{
 const h=await setup(t),first=await h.ask({fixtureId:'B'});assert.equal(first.status,200);assert.equal(first.data.routes.length,3);
 assert.equal(first.data.source,'traffic-sandbox-live');assert.equal(first.data.routes.find(r=>r.id==='main').distanceMeters,1200);assert.equal(JSON.stringify(first.data).includes('99999'),false);
 h.runtime.sim.step(60);h.runtime.control({action:'settings',settings:{demand:50,westSignalMode:'fixed'}});
 const second=await h.ask();assert.equal(second.status,200);assert.notEqual(first.data.stateVersion,second.data.stateVersion);
 assert.equal(h.calls[1].state.settings.demand,50);assert.equal(h.calls[1].state.settings.westSignalMode,'fixed');assert.equal(h.calls[1].state.metrics.time,h.runtime.sim.time);
 assert.deepEqual(second.data.routes,h.calls[1].state.routes);assert.equal(h.calls[1].state.source,'traffic-sandbox-live');
 const near=await h.ask({question:'哪条路更近？'});assert.equal(near.data.criterion,'distance');assert.equal(near.data.recommendedRouteId,'main');
});
test('真实队列和灯色改变本轮路线估计，绕开A的北侧环岛线不计A等待',async t=>{
 const h=await setup(t),before=await h.state(),car=h.runtime.sim.newCar(1,0,'electric','1-south');car.edgeIndex=1;car.p=roadGeometry.northWest.length-11;car.v=0;car.queueJunction=0;h.runtime.sim.cars.push(car);
 h.runtime.sim.signalStage('green',-1,'测试对向放行');h.runtime.changed();const after=await h.state();
 assert.equal(after.metrics.queues[0].total,1);assert.ok(after.routes[0].travelTimeSeconds>before.routes[0].travelTimeSeconds);
 assert.equal(after.routes.find(r=>r.id==='roundabout-north').junctions.some(j=>j.id==='west'),false);
});
test('步行、未来出发和超车展示缺数据时不调用AI，同地点不产生路线',async t=>{
 const h=await setup(t);assert.equal((await h.ask({trip:{...trip,mode:'walking'}})).data.status,'missing_data');
 assert.equal((await h.ask({question:'十分钟后出发多久到？'})).data.status,'missing_data');
 assert.equal((await h.ask({trip:{...trip,destination:'1'}})).data.status,'same_place');
 h.runtime.control({action:'demo'});assert.equal((await h.ask()).data.status,'missing_data');assert.equal(h.calls.length,0);
});
test('沙盘断开后明确失败，绝不退回人工样例',async t=>{
 const unavailable=http.createServer((req,res)=>{res.writeHead(404);res.end('old static server');}),origin=await listen(unavailable);
 const lab=createLabServer(async()=>({}),{studentProvider:createSandboxClient({base:origin})}),base=await listen(lab);
 t.after(async()=>{await stop(lab);await stop(unavailable);});
 const response=await fetch(base+'/api/student/state');assert.equal(response.status,503);const data=await response.json();assert.equal(data.error,'sandbox_unavailable');assert.equal(data.routes,undefined);
});
test('双向三条旅程连续连接到正确地点，环岛保持单向，按相同比例标定',()=>{
 const runtime=new SharedSimulation({running:false});
 for(const origin of ['1','2'])for(const id of ['main','roundabout','roundabout-north']){
  const refs=journeyRefs(origin,id);
  for(let i=1;i<refs.length;i++){const a=refs[i-1],b=refs[i],end=pointOnEdge(a.edge,roadGeometry[a.edge].length,a.direction),start=pointOnEdge(b.edge,0,b.direction);assert.ok(Math.hypot(end.x-start.x,end.y-start.y)<.01);}
  for(const ref of refs)if(roadGeometry[ref.edge].roundabout)assert.equal(ref.direction,1);
  const end=pointOnEdge(refs.at(-1).edge,roadGeometry[refs.at(-1).edge].length,refs.at(-1).direction);assert.ok(Math.abs(end.x-(origin==='1'?1396:246))<.01);
 }
 for(const mode of ['electric','bicycle']){const state=studentStateFromSandbox(runtime.packet(),{...trip,mode});assert.equal(state.routes[0].distanceMeters,1200);assert.ok(state.routes.every(r=>Number.isFinite(r.travelTimeSeconds)&&r.travelTimeSeconds>0));}
 const electric=studentStateFromSandbox(runtime.packet(),trip),bicycle=studentStateFromSandbox(runtime.packet(),{...trip,mode:'bicycle'});assert.ok(electric.routes[0].travelTimeSeconds<bicycle.routes[0].travelTimeSeconds);
});
test('跨站修改和无效操作被拒绝，八倍速度与展示重置可用',async t=>{
 const h=await setup(t);const denied=await fetch(h.sandboxBase+'/api/control',{method:'POST',headers:{Origin:'https://external.invalid'},body:'{}'});assert.equal(denied.status,403);
 assert.equal((await h.post({action:'speed',speed:8},'/api/control',h.sandboxBase)).status,200);
 assert.equal((await h.post({action:'speed',speed:99},'/api/control',h.sandboxBase)).status,422);
 h.runtime.control({action:'demo'});assert.equal(h.runtime.sim.demo,true);h.runtime.control({action:'reset'});assert.equal(h.runtime.sim.demo,false);
});
