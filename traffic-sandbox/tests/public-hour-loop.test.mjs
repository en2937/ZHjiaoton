import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {SharedSimulation} from '../shared-simulation.mjs';
import {createDefaultRuntime,createSandboxServer} from '../server.mjs';
import {createSandboxClient,createSnapshotClient} from '../../dify-integration-lab/sandbox-client.mjs';
import {AdminAuth} from '../../admin-access/auth.mjs';
import {createAdminServer} from '../../admin-access/server.mjs';
const clone=value=>structuredClone(value);
const settings={demand:4,motorDemand:0,northDemand:0,guidanceCoverage:55,northBypassShare:80};
const scene={mode:'survey',classTime:'08:00',observationTime:'07:00',totalPeople:36};
const make=options=>createDefaultRuntime({settings,departureScenario:scene,...options});
test('默认服务从07:00启用问卷仿真与认知分组，只有一份共享车流',()=>{
 const r=createDefaultRuntime(),p=r.packet();
 assert.equal(p.clock.label,'07:00:00');assert.equal(p.departureScenario.config.classTime,'08:00');
 assert.equal(p.departureScenario.config.observationTime,'07:00');assert.equal(p.departureScenario.config.totalPeople,360);
 assert.equal(p.simulation.settings.behaviorMode,'grouped');assert.equal(p.autoReplay.enabled,true);assert.equal(p.autoReplay.cycles,0);
 assert.equal(r.running,true);assert.equal(r.speed,4);
});
test('1/4/8倍越过08:00重建全部车流、队列和历史，保留参数/种子并推进剩余时间',()=>{
 for(const speed of [1,4,8]){
  const r=make({speed,seed:42});r.control({action:'settings',settings:{guidanceCoverage:65,northBypassShare:95}});
  r.sim.time=3599.95;r.sim.completed=999;r.sim.travelSum=999;r.sim.history.push({time:3500,queue:999,active:999});
  r.sim.pending[1].push(r.sim.newCar(1,3500,'electric','1-south'));
  const old=r.sim,run=r.runId,revision=r.settingsRevision,config=clone(old.departureScenario),parameters=clone(old.settings),overflow=.1*speed-(3600-old.time);
  const expected=make({speed,seed:42,settings:parameters,departureScenario:config});expected.sim.step(overflow);
  r.advance(.1);
  assert.notEqual(r.sim,old);assert.notEqual(r.runId,run);assert.equal(r.settingsRevision,revision+1);assert.equal(r.loopCount,1);
  assert.deepEqual(clone(r.sim),clone(expected.sim));assert.deepEqual(r.sim.settings,parameters);assert.deepEqual(r.sim.departureScenario,config);
  assert.equal(r.initialSeed,42);assert.equal(r.speed,speed);assert.equal(r.running,true);assert.equal(r.packet().clock.label,'07:00:00');
 }
});
test('恰好08:00即重新开始，多次循环不继承上轮积压或已完成统计',()=>{
 const r=make({speed:1});const plan=clone(r.sim.surveyDepartures.plan),ids=new Set([r.runId]);
 for(let i=0;i<12;i++){
  r.sim.time=3599.75;r.sim.completed=1000+i;r.sim.pending[1].push(r.sim.newCar(1,0,'electric','1-south'));r.advance(.25);
  assert.equal(r.sim.time,0);assert.equal(r.sim.completed,0);assert.equal(r.sim.pending[1].length,0);
  assert.deepEqual(r.sim.surveyDepartures.plan,plan);assert(!ids.has(r.runId));ids.add(r.runId);
  assert.equal(r.packet().autoReplay.cycles,i+1);
 }
});
test('暂停、无效推进与普通读取不会重启；管理员调参仍参与下一轮',()=>{
 const r=make({running:false});r.sim.time=3599.9;const p=clone(r.packet());
 for(const seconds of [.25,0,-1,NaN])r.advance(seconds);assert.deepEqual(clone(r.packet()),p);
 for(let i=0;i<10;i++)assert.deepEqual(clone(r.packet()),p);
 r.control({action:'settings',settings:{electric:100,guidanceCoverage:75}});r.control({action:'play',running:true});r.advance(.25);
 assert.equal(r.sim.settings.electric,100);assert.equal(r.sim.settings.guidanceCoverage,75);assert.equal(r.sim.settings.behaviorMode,'grouped');assert.equal(r.packet().autoReplay.enabled,true);
});
test('管理员选择其他时段、观察起点、固定需求或演示时不被默认循环覆盖',()=>{
 for(const config of [{mode:'survey',classTime:'10:00',observationTime:'09:00',totalPeople:36},{...scene,observationTime:'07:01'},{mode:'fixed'}]){
  const r=make();r.control({action:'departureScenario',config});r.sim.time=3600.1;const run=r.runId;r.advance(.1);
  assert.equal(r.runId,run);assert(r.sim.time>3600.1);assert.equal(r.packet().autoReplay.enabled,false);assert.equal(r.loopCount,0);
  r.control({action:'departureScenario',config:scene});assert.equal(r.packet().autoReplay.enabled,true);assert.equal(r.sim.time,0);
 }
 const r=make();r.control({action:'demo'});r.sim.time=3600.1;const run=r.runId;r.advance(.1);assert.equal(r.runId,run);assert.equal(r.packet().autoReplay.enabled,false);
});
test('恢复过期默认场景从07:00新开一轮，时段内及管理员其他场景保留原状态',()=>{
 const r=make({speed:8,running:false,seed:91});r.sim.time=5000;r.sim.completed=789;const expired=clone(r.packet());
 const fresh=createDefaultRuntime({initialPacket:expired,preserveRunId:true});assert.equal(fresh.sim.time,0);assert.equal(fresh.running,false);assert.equal(fresh.speed,8);assert.equal(fresh.initialSeed,91);
 assert.notEqual(fresh.runId,expired.runId);assert.deepEqual(fresh.sim.settings,expired.simulation.settings);assert.equal(fresh.loopCount,1);
 const current=clone(fresh.packet()),same=new SharedSimulation({initialPacket:current,preserveRunId:true});assert.equal(same.runId,current.runId);assert.deepEqual(clone(same.sim),current.simulation);assert.equal(same.packet().autoReplay.enabled,true);
 r.control({action:'departureScenario',config:{...scene,classTime:'10:00',observationTime:'09:00'}});r.sim.time=5000;
 const manual=clone(r.packet()),restored=createDefaultRuntime({initialPacket:manual,preserveRunId:true});assert.equal(restored.runId,manual.runId);assert.deepEqual(clone(restored.sim),manual.simulation);assert.equal(restored.packet().autoReplay.enabled,false);
});
async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return 'http://127.0.0.1:'+server.address().port;}
async function close(server){const closed=once(server,'close');server.close();server.closeAllConnections();await closed;}
test('多访客读取不重置，循环后师生状态/预测快照与沙盘同轮次，匿名不能控制',async t=>{
 const server=createSandboxServer({clock:false}),base=await listen(server);t.after(()=>close(server));
 const trip={origin:'1',destination:'2',mode:'electric'},student=createSandboxClient({base,cacheMs:0}),snapshot=createSnapshotClient({base});
 server.runtime.sim.time=3599.9;const before=await snapshot();
 for(let i=0;i<3;i++){assert.equal((await snapshot()).runId,before.runId);assert.equal((await student(trip)).runId,before.runId);}
 assert.equal(server.runtime.packet().revision,before.revision);
 const denied=await fetch(base+'/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"action":"reset"}'});assert.equal(denied.status,401);assert.equal(server.runtime.runId,before.runId);
 server.runtime.advance(.1);const packet=await snapshot(),state=await student(trip);
 assert.notEqual(packet.runId,before.runId);assert.equal(state.runId,packet.runId);assert.deepEqual(state.clock,packet.clock);assert.deepEqual(state.settings,packet.simulation.settings);assert(packet.simulation.time<1);
});
test('真实管理员认证代理可覆盖场景并调参，匿名访客仍只读同一轮次',async t=>{
 const bridgeKey='hour-loop-test-only',runtime=make(),sandbox=createSandboxServer({runtime,clock:false,controlKey:bridgeKey}),base=await listen(sandbox);t.after(()=>close(sandbox));
 const auth=new AdminAuth();await auth.setup('hour_loop_test','only-a-local-test-password');
 const admin=createAdminServer({auth,bridgeKey,sandboxPort:sandbox.address().port,host:'127.0.0.1',port:0}),adminBase=await listen(admin);t.after(()=>close(admin));
 const login=await auth.login('hour_loop_test','only-a-local-test-password','127.0.0.1','local'),cookie=auth.cookie(login.value,'local').split(';')[0];
 const session=await(await fetch(adminBase+'/api/admin/session',{headers:{Cookie:cookie}})).json();
 const control=command=>fetch(adminBase+'/api/control',{method:'POST',headers:{'Content-Type':'application/json',Origin:adminBase,Cookie:cookie,'X-CSRF-Token':session.csrfToken},body:JSON.stringify(command)});
 const denied=await fetch(adminBase+'/api/control',{method:'POST',headers:{'Content-Type':'application/json',Origin:adminBase},body:'{"action":"reset"}'});assert.equal(denied.status,401);
 assert.equal((await control({action:'settings',settings:{northBypassShare:90}})).status,200);assert.equal(runtime.packet().autoReplay.enabled,true);
 const response=await control({action:'departureScenario',config:{...scene,classTime:'10:00',observationTime:'09:00'}});assert.equal(response.status,200);
 const changed=await response.json(),publicPacket=await(await fetch(base+'/api/simulation')).json();assert.equal(publicPacket.runId,changed.runId);assert.equal(publicPacket.autoReplay.enabled,false);assert.equal(publicPacket.clock.label,'09:00:00');assert.equal(publicPacket.simulation.settings.northBypassShare,90);
 runtime.sim.time=3601;const run=runtime.runId;runtime.advance(.1);assert.equal(runtime.runId,run);assert(runtime.sim.time>3601);
});
