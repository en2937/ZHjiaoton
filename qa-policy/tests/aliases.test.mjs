import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {knownPlaces,canonicalQuestion,questionScope,resolveQuestionTrip,DATA_LIMIT_REPLY} from '../knowledge-scope.mjs';
import {departureIntent} from '../../dify-integration-lab/departure-intent.mjs';
import {createLabServer} from '../../dify-integration-lab/server.mjs';
import {studentState} from '../../dify-integration-lab/student.mjs';
import {SharedSimulation} from '../../traffic-sandbox/shared-simulation.mjs';
import {createAdminAi} from '../../admin-access/ai.mjs';
const trip={origin:'1',destination:'2',mode:'electric'};
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r('http://127.0.0.1:'+s.address().port)));
const close=s=>new Promise(r=>{s.close(r);s.closeAllConnections();});
test('用户确认的全部教学楼别名及常见数字写法映射同一地点、同一课堂时刻',()=>{
 for(const alias of knownPlaces[1].aliases){const q=`我想去${alias}上八点钟的课，几点出发比较合适呀？`;assert.equal(questionScope(q).allowed,true,q);const intent=departureIntent(q,trip);assert.equal(intent.kind,'forecast',q);assert.equal(intent.classTime,'08:00',q);assert.equal(intent.trip.destination,'2',q);assert.match(canonicalQuestion(q),/东教学楼/);}
});
test('用户确认的全部宿舍别名和常见宿舍组合写法映射同一出发点',()=>{
 for(const alias of knownPlaces[0].aliases){const q=`我想从${alias}骑车去东六上八点钟的课，麻烦算算啥时候动身呀`;assert.equal(questionScope(q).allowed,true,q);const intent=departureIntent(q,trip);assert.equal(intent.kind,'forecast',q);assert.equal(intent.classTime,'08:00',q);assert.equal(intent.trip.origin,'1',q);assert.equal(intent.trip.destination,'2',q);}
});
test('正常口语不再逐词拦截；截图中的已知地点原句正常解析',()=>{
 for(const q of ['我想去东教上八点钟的课，几点出发','东教就是东教学楼','我想去东教学楼上课，几点出发','帮咱瞧瞧从碧峰去东四哪条路更省心呗','为什么紫云去东一总是拥堵','从紫云去东五骑车大致得花多久呀'])assert.equal(questionScope(q).allowed,true,q);
 assert.equal(departureIntent('我想去东教上八点钟的课，几点出发',trip).classTime,'08:00');
 const missing=departureIntent('我想去东教学楼上课，几点出发',trip);assert.equal(missing.kind,'need_clarification');assert.equal(missing.field,'classTime');assert.notEqual(missing.message,DATA_LIMIT_REPLY);
});
test('同义地点支持双向行程，不把教学楼内部楼号当成上课时刻',()=>{
 assert.deepEqual(resolveQuestionTrip('从东三教学楼回碧峰',trip).trip,{...trip,origin:'2',destination:'1'});
 assert.deepEqual(resolveQuestionTrip('紫云到东2教学楼怎么走',trip).trip,trip);
 assert.equal(departureIntent('从碧峰到东六教学楼，十点钟有课，几点出发',trip).classTime,'10:00');
 for(const q of ['去东七上早八几点出发？','去新东一上早八几点出发？','去北教上八点钟的课，几点出发','从蓝田宿舍去东教上八点的课，几点出发','去西教上早八几点出发'])assert.equal(questionScope(q).allowed,false,q);
});
test('HTTP恢复预测、别名确认与缺时刻澄清；时间补充只在同一行程的当前会话生效',async t=>{
 const runtime=new SharedSimulation({running:false}),seen=[];
 const server=createLabServer(async()=>{throw Error('Should not call school for forecast or alias acknowledgement');},{snapshotProvider:async()=>runtime.packet(),studentProvider:async t=>studentState(t),forecaster:{dispose(){},run:async(_,intent)=>{seen.push(intent);return {status:'no_feasible_departure',reason:'测试已进入独立计算分支'};}}});
 const base=await listen(server);t.after(()=>close(server));
 const send=async(question,extra={})=>{const r=await fetch(base+'/api/student/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question,trip,preference:'time',sessionId:'alias-http-session',...extra})});return {code:r.status,...await r.json()};};
 const prediction=await send('我想去东教上八点钟的课，几点出发');assert.equal(prediction.provider,'sandbox-forecast');assert.equal(seen[0].classTime,'08:00');
 const ack=await send('东教就是东教学楼');assert.equal(ack.status,'info');assert.match(ack.message,/已识别.*东教学楼/);assert.deepEqual(ack.routes,[]);
 const clarify=await send('我想去东教学楼上课，几点出发');assert.equal(clarify.status,'need_clarification');assert.match(clarify.message,/上课时刻/);assert.notEqual(clarify.message,DATA_LIMIT_REPLY);
 const followup=await send('八点钟');assert.equal(followup.provider,'sandbox-forecast');assert.equal(seen.at(-1).classTime,'08:00');
 const other=await send('十点钟',{sessionId:'different-alias-session'});assert.notEqual(other.provider,'sandbox-forecast');
 const rejected=await send('去北教上八点钟的课，几点出发');assert.equal(rejected.message,DATA_LIMIT_REPLY);
});
test('普通路线问答向学校发送统一名称，返回行程也与用户明确的方向一致',async t=>{
 const seen=[];const upstream=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const q=JSON.parse(JSON.parse(raw).query);seen.push(q);const best=[...q.state.routes].sort((a,b)=>a.travelTimeSeconds-b.travelTimeSeconds)[0];res.setHeader('Content-Type','application/json');res.end(JSON.stringify({answer:JSON.stringify({status:'ok',criterion:'time',recommended_route_id:best.id})}));});
 const upstreamBase=await listen(upstream),server=createLabServer(async()=>({apiBase:upstreamBase+'/v1',apiKey:'alias-fixture',allowLoopback:true}),{studentProvider:async t=>studentState(t)}),base=await listen(server);t.after(async()=>{await close(server);await close(upstream);});
 const r=await fetch(base+'/api/student/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:'从东三教学楼回紫云，哪条路更快？',trip,preference:'time',sessionId:'alias-route-session'})});const data=await r.json();assert.equal(data.status,'ok');assert.equal(data.trip.origin,'2');assert.equal(data.trip.destination,'1');assert.match(seen[0].question,/从东教学楼回云峰学园/);assert.match(seen[0].originalQuestion,/东三教学楼回紫云/);assert.equal(seen[0].knowledgePolicy.version,'campus-known-scope-v2');
});
test('管理员收到同一份别名映射；明确缺少控制目标时澄清而不执行',async()=>{
 const runtime=new SharedSimulation({running:false}),seen=[];let controls=0;
 const ai=createAdminAi({getPacket:async()=>runtime.packet(),controlPacket:async()=>{controls++;throw Error('Must not control');},configProvider:async()=>({apiKey:'fixture'}),model:async(_,p)=>{const q=JSON.parse(p.query);seen.push(q);return {answer:JSON.stringify({protocol:q.protocol,status:'need_clarification',intent:'inspect',state_version:q.state.stateVersion,reply:'请提供需要调整的机动车流目标数值。',basis:'',changes:{},suggested_settings:{},evidence:[]})};}});
 const session={};const result=await ai.request(session,{chatId:'alias-admin-chat',requestId:randomUUID(),question:'从碧峰去东一的机动车流调低一点'});assert.match(result.message,/请提供/);assert.equal(controls,0);assert.match(seen[0].question,/从云峰学园去东教学楼/);assert.equal(seen[0].knowledgePolicy.version,'campus-known-scope-v2');
 const ack=await ai.request(session,{chatId:'alias-admin-chat',requestId:randomUUID(),question:'紫云就是宿舍'});assert.match(ack.message,/已识别.*云峰学园/);assert.equal(seen.length,1);
});

test('收到、提到、撤回中的字不当作地点方向词，正常管理分析不误拒',()=>{
 for(const q of ['已收到引导的学生为什么没有绕行？','如何撤回刚才的方案？','从信息触达角度解释为什么绕行很少','之前提到的策略应该如何优化？'])assert.equal(questionScope(q,{audience:'admin'}).allowed,true,q);
});
