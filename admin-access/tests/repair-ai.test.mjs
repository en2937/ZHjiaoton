import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {SharedSimulation} from '../../traffic-sandbox/shared-simulation.mjs';
import {createAdminAi} from '../ai.mjs';
const clone=x=>JSON.parse(JSON.stringify(x));
function fixture(model){
 const runtime=new SharedSimulation({running:false,departureScenario:{mode:'survey'}});let calls=0;
 const ai=createAdminAi({getPacket:async()=>clone(runtime.packet()),controlPacket:async c=>clone(runtime.control(c)),configProvider:async()=>({apiKey:'test-only'}),maxPerMinute:100,model:async(_,p)=>{calls++;const q=JSON.parse(p.query);const base={protocol:q.protocol,status:'ok',intent:'inspect',state_version:q.state.stateVersion,reply:'分析当前状态。',basis:'本次参考了路线认知、尝试意愿和引导触达；{{behavior.facts.eligible}}。',changes:{},suggested_settings:{},evidence:['behavior.facts.eligible']};return {answer:await model(base,calls,runtime,q)};}});
 return {runtime,calls:()=>calls,send:question=>ai.request({},{chatId:'repair-safety-test',requestId:randomUUID(),question})};
}
test('one format repair preserves control values and executes only the verified result',async()=>{
 const f=fixture((b,n)=>{const answer=JSON.stringify({...b,intent:'set',changes:{guidanceCoverage:60},reply:n===1?'已触达99辆':'调参指令待执行。'});return n===1?'```json\n'+answer+'\n```':answer;});
 const r=await f.send('引导覆盖设为60%');assert.equal(r.kind,'applied');assert.equal(f.calls(),2);assert.equal(f.runtime.sim.settings.guidanceCoverage,60);assert.equal(f.runtime.settingsRevision,1);
});
test('repair cannot silently change a control value or turn an invalid request into an execution',async()=>{
 for(const initialStatus of ['ok','invalid_request']){const f=fixture((b,n)=>JSON.stringify({...b,status:n===1?initialStatus:'ok',intent:'set',changes:initialStatus==='invalid_request'&&n===1?{}:{guidanceCoverage:n===1?60:50},reply:n===1?'不允许99辆':'准备调整。'}));assert.equal((await f.send('引导覆盖设为60%')).kind,'rejected');assert.equal(f.runtime.settingsRevision,0);}
});
test('configuration changes before repair stop both the retry and execution',async()=>{
 const f=fixture((b,n,r)=>{r.control({action:'departureScenario',config:{mode:'fixed'}});return JSON.stringify({...b,reply:'不可信99辆'});});await assert.rejects(f.send('分析路线'),{status:409});assert.equal(f.calls(),1);
});
test('exact current coverage can bind to a labeled fact, while wrong coverage and unlabeled counts stay rejected',async()=>{
 for(const [reply,kind]of [['当前引导覆盖为0%。','info'],['当前引导覆盖为88%。','rejected'],['未获引导0辆。','rejected']]){const f=fixture(b=>'```json\n'+JSON.stringify({...b,reply})+'\n```');const r=await f.send('分析路线');assert.equal(r.kind,kind);assert.equal(f.runtime.settingsRevision,0);if(kind==='info')assert.match(r.message,/引导覆盖设定0%/);}
});
