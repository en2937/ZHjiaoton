import {readFile} from 'node:fs/promises';
import {behaviorFacts,validBehaviorAggregate} from './behavior-facts.mjs';
import {randomUUID,createHash} from 'node:crypto';
import vm from 'node:vm';
import {studentStateFromSandbox} from '../traffic-sandbox/student-data.mjs';
import {Simulation} from '../traffic-sandbox/dist/engine.mjs';
import {SETTING_KEYS,validSettings,sameSettings,settingChanges} from '../traffic-sandbox/control-settings.mjs';
import {readReply} from '../dify-integration-lab/server.mjs';

const validatorContext=vm.createContext({});
vm.runInContext(await readFile(new URL('../admin-ai-design/validate-response.js',import.meta.url),'utf8'),validatorContext);
export class AiError extends Error{constructor(status,message,code='ai_unavailable'){super(message);Object.assign(this,{status,code});}}
export async function loadAdminAiConfig(){
 let saved={};try{saved=JSON.parse(await readFile(new URL('./private/dify-admin.json',import.meta.url),'utf8'));}catch(error){if(error.code!=='ENOENT')throw new AiError(503,'交通助手暂未就绪，请稍后重试。');}
 return {apiBase:process.env.DIFY_ADMIN_API_BASE||saved.apiBase||'https://dify-api.zju.edu.cn/v1',apiKey:process.env.DIFY_ADMIN_API_KEY||saved.apiKey||'',timeoutMs:45000};
}
export async function callAdminDify(config,payload){
 if(!config.apiKey)throw new AiError(503,'交通助手暂未连接，请稍后刷新。','not_configured');
 const base=new URL(config.apiBase);
 const permitted=base.protocol==='https:'&&base.hostname==='dify-api.zju.edu.cn'&&base.pathname.replace(/\/$/,'')==='/v1'||config.allowLoopback&&base.protocol==='http:'&&base.hostname==='127.0.0.1';
 if(!permitted||base.username||base.password||base.search||base.hash)throw new AiError(503,'交通助手配置暂不可用，请稍后重试。');
 let response;try{response=await fetch(base.href.replace(/\/$/,'')+'/chat-messages',{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+config.apiKey,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(config.timeoutMs||45000)});}catch{throw new AiError(502,'交通助手连接中断，请稍后重新发送。');}
 if(!response.ok)throw new AiError(response.status===429?429:502,response.status===429?'提问较多，请稍后再试。':'交通助手暂时无法回答，请稍后重试。');
 try{return await readReply(response);}catch{throw new AiError(502,'未能获得完整回答，请稍后重新发送。');}
}
export function adminState(packet,now=Date.now()){
 if(packet?.schemaVersion!==1||packet.source!=='synthetic-simulation'||!packet.simulation||!validSettings(packet.simulation.settings,{complete:true})||!Number.isSafeInteger(packet.settingsRevision))throw new AiError(503,'暂时无法读取沙盘状态，请稍后重试。');
 const sim=Object.assign(Object.create(Simulation.prototype),packet.simulation);
 if(sim.demo)throw new AiError(422,'请先退出演示场景，再使用交通助手。');
 const metrics=JSON.parse(JSON.stringify(sim.metrics(),(_,value)=>typeof value==='number'?Math.round(value*100)/100:value));
 delete metrics.westSignal.detectors;
 if(!metrics.westSignal.passed)metrics.westSignal.averageWait=null;
 const state={source:'synthetic-simulation',stateVersion:packet.stateVersion,runId:packet.runId,settingsRevision:packet.settingsRevision,updatedAt:packet.updatedAt,capturedAt:new Date(now).toISOString(),simulationTime:sim.time,settings:{...sim.settings},metrics,clock:sim.clockState(),departureScenario:sim.departureState(),behavior:packet.behavior?.runId===packet.runId&&packet.behavior?.settingsRevision===packet.settingsRevision&&packet.behavior?.stateVersion===packet.stateVersion&&packet.behavior?.simulationTime===sim.time?structuredClone(packet.behavior):null,routes:Object.fromEntries(['1','2'].flatMap(origin=>['electric','bicycle'].map(mode=>[origin+'_'+mode,studentStateFromSandbox(packet,{origin,destination:origin==='1'?'2':'1',mode}).routes])))};
 if(!validBehaviorAggregate(state.behavior)||state.behavior.enabled!==(state.settings.behaviorMode==='grouped'))state.behavior=null;
 if(state.behavior)state.behavior.facts=behaviorFacts(state);
 state.controlPolicy={allowedKeys:SETTING_KEYS.filter(k=>k!=='behaviorMode'&&(k!=='guidanceCoverage'||state.behavior?.enabled)),readOnly:['behaviorMode','认知权重','意愿权重','试用概率','节省门槛','固定种子'],guidanceRequiresEnabledMode:true};return state;
}
const validId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{8,80}$/.test(value);
const mentioned={guidanceCoverage:/引导(?:覆盖|触达)|信息(?:覆盖|触达)|\bguidanceCoverage\b/i,demand:/骑行(?:车流|流量|需求)|自行车(?:流|需求)|非机动车(?:流|需求)|\bdemand\b/i,motorDemand:/(?<!非)机动车|汽车|\bmotorDemand\b/i,northDemand:/北侧来车|北侧车流|北边来车|\bnorthDemand\b/i,electric:/电动车|电动占比|\belectric\b/i,outbound:/地点\s*1|1\s*侧|宿舍.*来车|\boutbound\b/i,northBypassShare:/绕行|北侧环岛|分流|避开\s*A|\bnorthBypassShare\b/i,westSignalMode:/配时|自动|固定|红绿灯|信号|\bwestSignalMode\b/i};
export function createAdminAi({getPacket,controlPacket,configProvider=loadAdminAiConfig,model=callAdminDify,now=()=>Date.now(),maxPerMinute=8}={}){
 let active=0;
 function chat(session,id){
  if(!validId(id))throw new AiError(400,'请刷新页面后重试。');
  session.aiChats??=new Map();
  for(const [key,value]of session.aiChats)if(!value.busy&&now()-value.lastUse>30*60*1000)session.aiChats.delete(key);
  if(!session.aiChats.has(id)){if(session.aiChats.size>=4)throw new AiError(429,'打开的对话较多，请关闭旧页面后稍后重试。');session.aiChats.set(id,{user:'traffic-admin-'+randomUUID(),conversationId:'',proposal:null,undo:null,busy:false,results:new Map(),lastUse:now()});}
  const current=session.aiChats.get(id);current.lastUse=now();return current;
 }
 function prune(current,state){
  if(current.proposal&&(now()-current.proposal.createdAt>5*60*1000||current.proposal.runId!==state.runId||current.proposal.settingsRevision!==state.settingsRevision||!sameSettings(current.proposal.baseSettings,state.settings)))current.proposal=null;
  if(current.undo&&(current.undo.runId!==state.runId||current.undo.settingsRevision!==state.settingsRevision||!sameSettings(current.undo.afterSettings,state.settings)))current.undo=null;
 }
 function proposalView(proposal){return proposal?{changes:settingChanges(proposal.baseSettings,proposal.settings)}:null;}
 async function status(session,id){const current=chat(session,id),state=adminState(await getPacket(),now());prune(current,state);const config=await configProvider();return {configured:Boolean(config.apiKey),runId:state.runId,settingsRevision:state.settingsRevision,settings:state.settings,proposal:proposalView(current.proposal),canUndo:Boolean(current.undo)};}
 async function request(session,input,authorized=()=>true){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new AiError(400,'请求格式不正确，请重试。');
  if(!validId(input.requestId))throw new AiError(400,'请刷新页面后重试。');
  const action=input.action||'chat';if(!['chat','apply','undo','clear','cancel'].includes(action))throw new AiError(400,'无法识别这项操作。');
  const question=typeof input.question==='string'?input.question.trim():'';
  if(action==='chat'&&(!question||question.length>1000))throw new AiError(400,'请输入1–1000字的问题。');
  const current=chat(session,input.chatId),fingerprint=createHash('sha256').update(JSON.stringify({action,question})).digest('hex');
  const previous=current.results.get(input.requestId);
  if(previous){if(previous.fingerprint!==fingerprint)throw new AiError(409,'这条请求已使用，请重新发送。');return previous.result;}
  if(current.busy)throw new AiError(409,'上一条问题还在处理中，请稍候。');
  if(active>=4)throw new AiError(429,'交通助手正忙，请稍后再试。');
  session.aiRequests=(session.aiRequests||[]).filter(t=>now()-t<60000);
  if(session.aiRequests.length>=maxPerMinute)throw new AiError(429,'提问较多，请稍后再试。');
  session.aiRequests.push(now());current.busy=true;active++;
  try{
   if(!authorized())throw new AiError(401,'登录已过期，请重新登录。','auth_required');
   const state=adminState(await getPacket(),now());prune(current,state);
   const response=(kind,message,extra={})=>({kind,message,source:'synthetic-simulation',queryTime:state.capturedAt,runId:state.runId,settingsRevision:state.settingsRevision,proposal:proposalView(current.proposal),canUndo:Boolean(current.undo),...extra});
   async function apply(patch,{undo=false}={}){
    if(!validSettings(patch))throw new AiError(422,'参数未通过校验，请重新提出要求。');
    const changes=settingChanges(state.settings,patch);
    if(!changes.length)return response('no_change','当前参数已符合要求，无需调整。',{changes:[]});
    if(!authorized())throw new AiError(401,'登录已过期，请重新登录。','auth_required');
    let packet;try{packet=await controlPacket({action:'settings',settings:patch,expected:{runId:state.runId,settings:state.settings,settingsRevision:state.settingsRevision}});}catch(error){
     if(error.status===409)throw new AiError(409,'参数或场景已改变，请基于当前状态重新提出要求。','state_conflict');
     throw new AiError(503,'未能确认执行结果，请核对当前参数后再提出新指令。','control_unknown');
    }
    const actual=adminState(packet,now());
    if(actual.runId!==state.runId||actual.settingsRevision!==state.settingsRevision+1||!Object.entries(patch).every(([key,value])=>actual.settings[key]===value))throw new AiError(503,'未能确认执行结果，请核对当前参数。','control_unknown');
    current.proposal=null;
    current.undo=undo?null:{runId:actual.runId,settingsRevision:actual.settingsRevision,afterSettings:{...actual.settings},before:Object.fromEntries(changes.map(row=>[row.key,row.before]))};
    return response(undo?'undone':'applied',(undo?'已撤回上次调整：':'已调整：')+changes.map(row=>row.label+' '+row.beforeText+' → '+row.afterText).join('；')+'。',{changes,runId:actual.runId,settingsRevision:actual.settingsRevision,settings:actual.settings,canUndo:Boolean(current.undo),proposal:null});
   }
   let result;
   if(action==='clear'){current.proposal=null;current.conversationId='';current.user='traffic-admin-'+randomUUID();result=response('cleared','新对话已开始。');}
   else if(action==='cancel'||action==='chat'&&/^取消(?:刚才|这个|当前|待执行)?的?方案[。！!]?$/u.test(question)){current.proposal=null;result=response('info','方案已取消，当前参数保持不变。');}
   else if(action==='undo'||action==='chat'&&/^(?:撤回|撤销|恢复)上次(?:的)?(?:调整|调参|修改)[。！!]?$/u.test(question)){if(!current.undo)result=response('rejected','当前没有可撤回的调整，或参数已被再次修改。');else result=await apply(current.undo.before,{undo:true});}
   else if(action==='apply'){if(!current.proposal)result=response('rejected','之前的方案已失效，请重新提出优化要求。');else result=await apply(current.proposal.settings);}
   else{
    const envelope={protocol:'campus-admin-v2',question,state,context:{pendingProposal:current.proposal}};
    const config=await configProvider(),deadline=performance.now()+Math.min(config.timeoutMs||45000,45000);
    const payload=query=>({inputs:{},query:JSON.stringify(query),response_mode:'streaming',user:current.user,auto_generate_name:false,...(current.conversationId?{conversation_id:current.conversationId}:{})});
    let reply=await model({...config,timeoutMs:Math.max(1,Math.floor(deadline-performance.now()))},payload(envelope));
    let checked=validatorContext.main({query:JSON.stringify(envelope),model_output:reply.answer}),decision=JSON.parse(checked.output_json);
    // One format-only repair; never change the proposed controls or weaken the same validation.
    if(checked.repairable&&deadline-performance.now()>2500){
     if(!authorized())throw new AiError(401,'登录已过期，请重新登录。','auth_required');
     const repairState=adminState(await getPacket(),now());
     if(repairState.runId!==state.runId||repairState.settingsRevision!==state.settingsRevision||!sameSettings(repairState.settings,state.settings))throw new AiError(409,'参数或场景已改变，请基于当前状态重新提出要求。','state_conflict');
     let original;try{const fenced=/^\s*```(?:json)?\s*(\{[\s\S]*\})\s*```\s*$/i.exec(reply.answer);original=JSON.parse(fenced?fenced[1]:reply.answer);}catch{}
     const formatInstruction='上次回答被后端拦截，参数未执行。只修正格式及事实表述，不改变意图、status或参数值，不把非法请求换成合法目标。严禁写任何裸统计数字或百分比，只用完整behavior.facts短句占位符并在evidence列出路径；不要Markdown。'+(state.behavior?.enabled?'basis写“本次参考了路线认知、尝试意愿和引导触达；{{behavior.facts.eligible}}。”。reply可直接用“{{behavior.facts.primaryReasons}}；{{behavior.facts.queues}}。可比较对应措施，效果需对照验证。”，不要重复自行写人数或覆盖百分比。':'当前分组未启用：basis必须写“当前未启用认知与意愿分组，本次仍按原选路规则分析”。reply只引用{{behavior.facts.queues}}和必要的journey事实，不讨论当前认知、意愿或触达的作用。建议只可谈原绕行策略或信号配时；引导覆盖在此模式禁止调整，不能给任何调整引导覆盖的建议。');
     const repairEnvelope={...envelope,question:question+'\n后端格式校验反馈：'+formatInstruction,context:{...envelope.context,validationRepair:{reason:decision.reply,instruction:formatInstruction,rejectedOutput:reply.answer.slice(0,6000)}}};
     const repaired=await model({...config,timeoutMs:Math.max(1,Math.floor(deadline-performance.now()))},payload(repairEnvelope));
     const repairCheck=validatorContext.main({query:JSON.stringify(repairEnvelope),model_output:repaired.answer}),candidate=JSON.parse(repairCheck.output_json);
     const samePatch=(a,b)=>a&&b&&Object.keys(a).length===Object.keys(b).length&&Object.entries(a).every(([k,v])=>b[k]===v);
     const preserved=candidate.status!=='ok'||original?.status==='ok'&&candidate.intent===original.intent&&samePatch(candidate.changes,original.changes)&&samePatch(candidate.suggested_settings,original.suggested_settings)||!original&&candidate.intent==='inspect'&&!Object.keys(candidate.changes).length&&!Object.keys(candidate.suggested_settings).length;
     if(preserved){reply=repaired;checked=repairCheck;decision=candidate;}
    }
    if(!authorized())throw new AiError(401,'登录已过期，请重新登录。','auth_required');
    const fresh=adminState(await getPacket(),now());
    if(fresh.runId!==state.runId||fresh.settingsRevision!==state.settingsRevision||!sameSettings(fresh.settings,state.settings))throw new AiError(409,'参数或场景已改变，请基于当前状态重新提出要求。','state_conflict');
    current.conversationId=reply.conversationId||'';
    if(decision.status!=='ok')result=response('rejected',decision.intent==='apply_proposal'?'之前的方案已失效或缺失，请重新提出方案。':[decision.basis,decision.reply].filter(Boolean).join(' '));
    else if(decision.intent==='set'&&Object.keys(decision.changes).some(key=>!mentioned[key]?.test(question)))result=response('rejected','这次指令包含未明确要求的参数，请说明具体要调整哪项。');
    else if(['set','apply_proposal'].includes(decision.intent))result=await apply(decision.changes);
    else if(decision.intent==='suggest'){
     if(Object.keys(decision.suggested_settings).some(key=>!['northBypassShare','westSignalMode','guidanceCoverage'].includes(key))){result=response('rejected','优化方案可比较配时、北侧绕行策略和引导覆盖；更换车流场景请明确给出目标参数。');}
     else{
     const changes=settingChanges(state.settings,decision.suggested_settings);
     current.proposal=changes.length?{settings:decision.suggested_settings,baseSettings:state.settings,runId:state.runId,settingsRevision:state.settingsRevision,createdAt:now()}:null;
     result=response('proposal',[decision.basis,decision.reply].filter(Boolean).join(' '),{analysisStateVersion:state.stateVersion,evidence:decision.evidence,behavior:state.behavior});
     }
    }else result=response('info',[decision.basis,decision.reply].filter(Boolean).join(' '),{analysisStateVersion:state.stateVersion,evidence:decision.evidence,behavior:state.behavior});
   }
   current.results.set(input.requestId,{fingerprint,result});while(current.results.size>20)current.results.delete(current.results.keys().next().value);
   return result;
  }finally{current.busy=false;active--;}
 }
 return {status,request};
}

