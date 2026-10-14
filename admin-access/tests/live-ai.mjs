// Real school-Dify test against an isolated simulation. No production controls or account.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createAdminAi,loadAdminAiConfig} from '../ai.mjs';
import {SharedSimulation} from '../../traffic-sandbox/shared-simulation.mjs';
const config=await loadAdminAiConfig();if(!config.apiKey)throw new Error('管理员应用密钥尚未配置。');
const runtime=new SharedSimulation({running:false,settings:{demand:30,northBypassShare:60}});runtime.sim.step(360);
const initial={...runtime.sim.settings},session={},results=[];
const ai=createAdminAi({getPacket:async()=>JSON.parse(JSON.stringify(runtime.packet())),controlPacket:async input=>JSON.parse(JSON.stringify(runtime.control(input))),configProvider:async()=>config,maxPerMinute:100});
async function send(question,action='chat'){
 const before={...runtime.sim.settings},start=Date.now();let result;
 try{result=await ai.request(session,{chatId:'school-live-test',requestId:randomUUID(),question,action});results.push({question,action,before,after:{...runtime.sim.settings},durationMs:Date.now()-start,result});}
 catch(error){results.push({question,action,before,after:{...runtime.sim.settings},durationMs:Date.now()-start,error:{status:error.status,message:error.message}});throw error;}
 await writeFile(new URL('../evidence/ai-live-interface.json',import.meta.url),JSON.stringify({mode:'real-school-dify-isolated-simulation',testedAt:new Date().toISOString(),apiBase:config.apiBase,results},null,2));
 console.log(JSON.stringify({question,kind:result.kind,message:result.message,settings:runtime.sim.settings}));return result;
}
assert.equal((await send('把北侧绕行比例设为80%，A路口切换固定配时。')).kind,'applied');assert.equal(runtime.sim.settings.northBypassShare,80);assert.equal(runtime.sim.settings.westSignalMode,'fixed');
assert.equal((await send('北侧绕行减少10个百分点。')).kind,'applied');assert.equal(runtime.sim.settings.northBypassShare,70);
assert.equal((await send('撤销上次调整')).kind,'undone');assert.equal(runtime.sim.settings.northBypassShare,80);
const revision=runtime.settingsRevision;assert.equal((await send('根据当前状态分析A和B拥堵原因。')).kind,'info');assert.equal(runtime.settingsRevision,revision);
assert.equal((await send('把北侧绕行设为150%')).kind,'rejected');assert.equal(runtime.settingsRevision,revision);
assert.equal((await send('给一个缓解A拥堵的优化方案，先不要执行。')).kind,'proposal');assert.equal(runtime.settingsRevision,revision);
const proposed=await ai.status(session,'school-live-test');
if(proposed.proposal){assert.equal((await send('', 'apply')).kind,'applied');assert.equal((await send('', 'undo')).kind,'undone');}
await send('把北侧绕行比例设为60%，A路口切换自动配时。');assert.deepEqual(runtime.sim.settings,initial);
console.log(JSON.stringify({passed:true,cases:results.length,productionUnchanged:true}));
