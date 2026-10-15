import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createAdminAi,adminState} from '../ai.mjs';
import {SharedSimulation} from '../../traffic-sandbox/shared-simulation.mjs';
const clone=x=>JSON.parse(JSON.stringify(x));
function fixture(){
 const runtime=new SharedSimulation({running:false,departureScenario:{mode:'survey'},settings:{guidanceCoverage:0}}),session={};let output={};
 const ai=createAdminAi({getPacket:async()=>clone(runtime.packet()),controlPacket:async c=>clone(runtime.control(c)),configProvider:async()=>({apiKey:'test-only'}),maxPerMinute:100,model:async(_,payload)=>{
  const q=JSON.parse(payload.query),s=q.state;
  assert.equal(q.protocol,'campus-admin-v2');assert.equal(s.behavior.runId,s.runId);assert.equal(s.behavior.simulationTime,s.simulationTime);assert.equal(s.routes['1_electric'].length,3);
  return {answer:JSON.stringify({protocol:q.protocol,status:'ok',intent:'inspect',state_version:s.stateVersion,reply:'当前数据是规则估算，尚无尝试后的实测收益。',basis:s.behavior.enabled?'本次参考了路线认知、尝试意愿和引导触达；分岔前可绕行学生{{behavior.facts.eligible}}辆。':'当前未启用认知与意愿分组，本次仍按原选路规则分析',changes:{},suggested_settings:{},evidence:s.behavior.enabled?['behavior.facts.eligible']:[],...output})};
 }});
 return {runtime,ai,session,set:o=>output=o,send:(question='分析路线拥堵',action='chat')=>ai.request(session,{chatId:'behavior-ai-test',requestId:randomUUID(),question,action})};
}
test('AI receives the owner aggregate and backend renders referenced counts; off mode is explicit',async()=>{
 const f=fixture();let a=await f.send();assert.equal(a.kind,'info');assert.match(a.message,/路线认知、尝试意愿和引导触达/);assert.match(a.message,new RegExp('学生车辆'+f.runtime.packet().behavior.eligible.count+'辆'));assert.equal(a.behavior.eligible.count,f.runtime.packet().behavior.eligible.count);
 f.runtime.control({action:'departureScenario',config:{mode:'fixed'}});a=await f.send();assert.match(a.message,/当前未启用认知与意愿分组，本次仍按原选路规则分析/);
});
test('unsupported attributes, invented fields/numbers and missing factors cannot produce valid replies or controls',async()=>{
 for(const output of [{changes:{behaviorMode:'grouped'},intent:'set'},{changes:{knowledge:50},intent:'set'},{changes:{guidanceCoverage:101},intent:'set'},{evidence:['behavior.eligible.fake']},{reply:'已引导99辆'},{basis:'本次参考问卷。'}]){const f=fixture();f.set(output);assert.equal((await f.send('引导覆盖设为50%')).kind,'rejected');assert.equal(f.runtime.settingsRevision,0);}
});
test('coverage proposals confirm once, return real receipts and undo only the supported setting',async()=>{
 const f=fixture();f.set({intent:'suggest',suggested_settings:{guidanceCoverage:80}});const p=await f.send('给一个拥堵优化建议');assert.equal(p.kind,'proposal');assert.equal(f.runtime.sim.settings.guidanceCoverage,0);
 const profiles=clone(f.runtime.sim.cars.map(c=>c.behavior));const a=await f.send('', 'apply');assert.equal(a.kind,'applied');assert.equal(a.settings.guidanceCoverage,80);assert.equal(a.canUndo,true);
 const u=await f.send('', 'undo');assert.equal(u.kind,'undone');assert.equal(u.settings.guidanceCoverage,0);assert.deepEqual(f.runtime.sim.cars.map(c=>c.behavior?.knowledge),profiles.map(c=>c?.knowledge));assert.deepEqual(f.runtime.sim.cars.map(c=>c.behavior?.willingness),profiles.map(c=>c?.willingness));
});
test('mode/coverage edits invalidate pending proposals even if values later return to their old settings',async()=>{
 for(const edit of [{action:'departureScenario',config:{mode:'fixed'}},{action:'settings',settings:{guidanceCoverage:20}}]){const f=fixture();f.set({intent:'suggest',suggested_settings:{guidanceCoverage:80}});await f.send('优化');f.runtime.control(edit);assert.equal((await f.send('', 'apply')).kind,'rejected');}
});
test('missing or mismatched behavior is explicitly absent and does not silently invent groups',()=>{
 const r=new SharedSimulation(),p=clone(r.packet());delete p.behavior;assert.equal(adminState(p).behavior,null);p.behavior={...r.packet().behavior,runId:'wrong'};assert.equal(adminState(p).behavior,null);
});
test('labeled facts retain the meaning of guided counts, willingness and signed route savings',()=>{
 const r=new SharedSimulation({running:false,departureScenario:{mode:'survey'},settings:{guidanceCoverage:0}}),s=adminState(clone(r.packet()));
 assert.match(s.behavior.facts.eligible,new RegExp('已获引导'+s.behavior.eligible.guided+'辆'));
 assert.match(s.behavior.facts.willingness,/愿意尝试且更快后倾向继续/);
 for(const key of ['1_electric','2_bicycle']){const routes=s.routes[key],main=routes.find(r=>r.id==='main'),north=routes.find(r=>r.id==='roundabout-north'),saving=main.travelTimeSeconds-north.travelTimeSeconds;assert.ok(s.behavior.facts['journey_'+key].includes((saving>=0?'节省':'多用')+Math.abs(saving)+'秒'));}
 const p=clone(r.packet());delete p.behavior.eligible.knowledge.known;assert.equal(adminState(p).behavior,null);
});

