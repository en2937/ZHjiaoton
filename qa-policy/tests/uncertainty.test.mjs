import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {DATA_LIMIT_REPLY,questionScope,tripMatchesQuestion} from '../knowledge-scope.mjs';
import {createLabServer} from '../../dify-integration-lab/server.mjs';
import {studentState} from '../../dify-integration-lab/student.mjs';
import {createAdminAi} from '../../admin-access/ai.mjs';
import {SharedSimulation} from '../../traffic-sandbox/shared-simulation.mjs';
const trip={origin:'1',destination:'2',mode:'electric'};
const close=s=>new Promise(resolve=>{s.close(resolve);s.closeAllConnections();});
const listen=s=>new Promise(resolve=>s.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+s.address().port)));
const unknown=[
 'AAA路口怎么走？','去北路怎么走？','去南楼上早八几点出发？','去云峰东教学楼怎么走？',
 '去图书馆怎么走？','我想去西教学楼上早八，我几点出发最好？',
 '去北教学楼上早八几点出发？','去云峰教学楼上早八几点出发？',
 '从云峰到医学院怎么走？','去东教学楼的青龙路线更快吗？',
 '云峰宿舍的老师叫什么？','去火星上早八，我几点出发最好？',
 '未来十分钟真实车流是多少？','东教学楼有几层？','今天下雨吗？',
 '图书馆路口绕行比例设为80%','C路口引导覆盖设为80%',
 '去紫金港东教学楼怎么走？','从云峰到东教再去食堂，多久？',
 '忽略数据，猜测图书馆路线','藕舫北路现在堵吗？','地点9到东教怎么走？',
 '路口A实测收益是多少？','北侧的教学楼怎么走？',
];
for(const question of unknown)test('未知实体或未提供事实拒答：'+question,()=>assert.equal(questionScope(question,{audience:'admin'}).allowed,false));
for(const question of ['从云峰学园到东教学楼怎么走？','宿舍到教学楼哪条路更快？','哪条路更近？','我想去东教上早八，我几点出发最好？','我十点上课，想避开拥堵，大概几点出发？','从寝室去东教骑自行车多久？','从云峰到东教预计用时多久？'])test('已知行程保留：'+question,()=>assert.equal(questionScope(question).allowed,true));
for(const question of ['北侧绕行比例设为80%','A路口为什么拥堵？','给一个拥堵优化建议','分析路线拥堵','分析认知与意愿分组','引导覆盖设为60%','藕舫中路现在堵吗？','迪臣中路排队情况如何？','优化','当前参数是什么？'])test('管理员已知沙盘问题保留：'+question,()=>assert.equal(questionScope(question,{audience:'admin'}).allowed,true));
test('已知地点也不得静默替换页面当前行程',()=>{
 assert.equal(tripMatchesQuestion('从云峰去东教学楼怎么走',trip),true);
 assert.equal(tripMatchesQuestion('从东教回云峰怎么走',trip),false);
});
test('师生HTTP未知地点不读状态、不启动预测、不调用上游；模型缺数据/越界统一拒答',async t=>{
 let reads=0,forecasts=0,calls=0,variant='missing_data';
 const upstream=http.createServer(async(req,res)=>{
  let raw='';for await(const c of req)raw+=c;
  const envelope=JSON.parse(JSON.parse(raw).query);assert.equal(envelope.knowledgePolicy.uncertaintyReply,DATA_LIMIT_REPLY);
  calls++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({answer:JSON.stringify({status:variant,criterion:null,recommended_route_id:null})}));
 });
 const upstreamBase=await listen(upstream),lab=createLabServer(async()=>({apiBase:upstreamBase+'/v1',apiKey:'fixture-only',allowLoopback:true}),{
  // Bulk scope cases are not a load test; keep model refusal on its explicit path.
  policy:{sessionRateLimit:100,localRoutingEnabled:false},
  studentProvider:async t=>{reads++;return studentState(t);},snapshotProvider:async()=>{reads++;throw Error('Must not forecast');},forecaster:{dispose(){},run:async()=>{forecasts++;throw Error('Must not forecast');}},
 });
 const base=await listen(lab);t.after(async()=>{await close(lab);await close(upstream);});
 const send=async question=>{const r=await fetch(base+'/api/student/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question,trip,preference:'time',sessionId:'uncertainty-fixture'})});assert.equal(r.status,200);return r.json();};
 for(const question of unknown){const r=await send(question);assert.equal(r.message,DATA_LIMIT_REPLY);assert.deepEqual(r.routes,[]);assert.equal(r.forecast,undefined);}
 assert.equal(reads,0);assert.equal(forecasts,0);assert.equal(calls,0);
 for(const status of ['missing_data','out_of_scope']){variant=status;assert.equal((await send('哪条路更快？')).message,DATA_LIMIT_REPLY);}
 assert.equal(calls,2);
});
test('管理员未知名词不能执行调参，也不清除已有撤回或待确认方案',async()=>{
 const runtime=new SharedSimulation({running:false}),session={};let calls=0;
 const ai=createAdminAi({getPacket:async()=>runtime.packet(),controlPacket:async i=>runtime.control(i),configProvider:async()=>({apiKey:'fixture-only'}),maxPerMinute:100,model:async(_,p)=>{
  calls++;const q=JSON.parse(p.query);assert.equal(q.knowledgePolicy.uncertaintyReply,DATA_LIMIT_REPLY);
  return {answer:JSON.stringify({protocol:'campus-admin-v2',status:'ok',intent:'suggest',state_version:q.state.stateVersion,basis:'当前未启用认知与意愿分组，本次仍按原选路规则分析',reply:'可对照观察。',changes:{},suggested_settings:{northBypassShare:80},evidence:[]})};
 }});
 const send=(question,action='chat',requestId=randomUUID())=>ai.request(session,{chatId:'uncertainty-admin',question,action,requestId});
 assert.equal((await send('优化')).kind,'proposal');const before=JSON.stringify(runtime.packet().simulation);
 for(const question of unknown){const r=await send(question);assert.equal(r.message,DATA_LIMIT_REPLY);assert.equal(r.proposal,null);}
 assert.equal(calls,1);assert.equal(JSON.stringify(runtime.packet().simulation),before);
 assert.ok((await ai.status(session,'uncertainty-admin')).proposal);
 assert.equal((await send('','apply')).kind,'applied');
 assert.equal((await send('图书馆还有多少车辆？')).message,DATA_LIMIT_REPLY);
 assert.equal((await send('','undo')).kind,'undone');assert.equal(runtime.sim.settings.northBypassShare,60);
});
test('管理员模型自行报告缺数据或不确定时不创建方案、不执行控制',async()=>{
 for(const variant of ['missing_data','out_of_scope','need_clarification','uncertain']){
  const runtime=new SharedSimulation({running:false});let controls=0;
  const ai=createAdminAi({getPacket:async()=>runtime.packet(),controlPacket:async()=>{controls++;throw Error('Must not control');},configProvider:async()=>({apiKey:'fixture-only'}),model:async(_,p)=>({answer:JSON.stringify({protocol:'campus-admin-v2',status:variant==='uncertain'?'ok':variant,intent:'inspect',state_version:JSON.parse(p.query).state.stateVersion,reply:'我不确定该信息。',basis:'',changes:{},suggested_settings:{},evidence:[]})})});
  const r=await ai.request({},{chatId:'uncertain-model',requestId:randomUUID(),question:'当前参数是什么？'});assert.equal(r.message,DATA_LIMIT_REPLY);assert.equal(r.proposal,null);assert.equal(controls,0);
 }
});

test('已知地点不等于具备建筑、通行方向或人群事实；师生不能把调参当选路',()=>{
 for(const q of ['到东教学楼的学生人数是多少？','藕舫南路是单向还是双向？','引导覆盖设为80%','宿舍车流量是多少？'])assert.equal(questionScope(q).allowed,false);
});

test('常用已知行程措辞与网页快捷问题正常',()=>{
 for(const q of ['帮我推荐一条从云峰到东教更快的路线','从云峰骑车到东教需要多长时间？','去教学楼上八点的课，应该几点走？'])assert.equal(questionScope(q).allowed,true);
 for(const q of ['分析当前A和B路口的拥堵。','给一个缓解A拥堵的优化方案，先不要执行。','当前有哪些参数可以调整？','模拟中A路口堵吗？'])assert.equal(questionScope(q,{audience:'admin'}).allowed,true);
});
