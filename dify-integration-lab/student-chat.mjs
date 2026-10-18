import {randomUUID} from 'node:crypto';
import {fixture,makeEnvelope} from './fixtures.mjs';
import {studentEnvelope,parseStudentReply,routeComparison,futureQuestion} from './student.mjs';
import {localCriterion,selectRoute} from './route-intent.mjs';
import {AiScheduler,SessionStore,ServiceError,policyDefaults,withSignal} from './request-policy.mjs';
import {DATA_LIMIT_REPLY,questionScope,resolveQuestionTrip,aliasAcknowledgement} from '../qa-policy/knowledge-scope.mjs';
import {departureIntent} from './departure-intent.mjs';
import {forecastMessage} from './departure-objectives.mjs';
import {studentStateFromSandbox} from '../traffic-sandbox/student-data.mjs';

const metadata=(state,trip)=>({stateVersion:state.stateVersion,source:state.source,sourceLabel:state.sourceLabel,trip,mode:state.mode,
  runId:state.runId,simulationTimeSeconds:state.simulationTimeSeconds,settings:state.settings,clock:state.clock,
  departureScenario:state.departureScenario,calibration:state.calibration});
const settingsKey=state=>JSON.stringify(Object.entries(state.settings||{}).sort(([a],[b])=>a.localeCompare(b)));
const sameContext=(a,b)=>['runId','scenarioId','origin','destination','mode'].every(k=>a[k]===b[k])&&settingsKey(a)===settingsKey(b);
const invalid=(code,message,status=400)=>new ServiceError(status,code,message);

export function createStudentChat({studentProvider,snapshotProvider,forecaster,configProvider,callDify,readReply,policy={},onMetric=()=>{}}){
  const options={...policyDefaults,...policy},scheduler=new AiScheduler(options),sessions=new SessionStore(options),contexts=new Set(),pendingDepartures=new Map();
  function prepareStudent(body){
    const key='student:'+body.sessionId;
    for(const [id,pending]of pendingDepartures)if(Date.now()-pending.created>300000)pendingDepartures.delete(id);
    const pending=pendingDepartures.get(key);
    const timeAnswer=/^(?:(?:早上|早晨|上午|中午|下午|晚上|晚间|早|晚)?[零〇一二两三四五六七八九十0-9]{1,3}(?:[:：][0-9]{1,2}|点(?:钟|半|[零一二两三四五六七八九十0-9]{1,3}分?)?)?|早八|早十)(?:的?课|上课)?[。！!]?$/;
    let question=body.question.trim();
    if(pending&&pending.trip===JSON.stringify(body.trip)&&timeAnswer.test(question))question=pending.question+'，'+question+'上课';
    else pendingDepartures.delete(key);
    const reply=(status,message,extra={})=>({reply:{provider:'local-validation',status,message,routes:[],...extra}});
    if(!questionScope(question).allowed)return reply('missing_data',DATA_LIMIT_REPLY);
    const acknowledgement=aliasAcknowledgement(question);
    if(acknowledgement)return reply('info',acknowledgement,{kind:'alias_confirmation'});
    const intent=departureIntent(question,body.trip);
    if(intent&&intent.kind!=='forecast'){
      if(intent.kind==='need_clarification'&&intent.field==='classTime'){
        if(pendingDepartures.size>=100&&!pendingDepartures.has(key))pendingDepartures.delete(pendingDepartures.keys().next().value);
        pendingDepartures.set(key,{question,trip:JSON.stringify(body.trip),created:Date.now()});
      }
      return reply(intent.kind,intent.kind==='need_clarification'?intent.message:DATA_LIMIT_REPLY,{kind:'departure_forecast'});
    }
    if(intent)return {intent};
    const resolved=resolveQuestionTrip(question,body.trip);
    if(resolved.clarification)return reply('need_clarification',resolved.clarification);
    return {body:{...body,question,trip:resolved.trip}};
  }
  async function handle(req,res,readBody,kind='student'){
    const started=Date.now(),requestId=randomUUID(),controller=new AbortController(),signal=controller.signal;
    const timings={stateMs:0,queueMs:0,modelFirstByteMs:null,modelMs:0,totalMs:0};
    let timeout;
    const setDeadline=ms=>{clearTimeout(timeout);timeout=setTimeout(()=>controller.abort(invalid('request_timeout','本次处理已超时，请重新发送。',504)),ms);};
    setDeadline(options.totalTimeoutMs);
    const cancel=()=>{if(!res.writableEnded)controller.abort(invalid('request_cancelled','请求已取消。',499));};
    req.once('aborted',cancel);res.once('close',cancel);contexts.add(controller);
    let session=null,provider='local-validation',result;
    const success=(body,status=200)=>({status,body,headers:{}});
    async function getState(trip){
      const at=Date.now();try{return await withSignal(studentProvider(trip,{fresh:true,signal}),signal);}
      finally{timings.stateMs+=Date.now()-at;}
    }
    async function model(query,user){
      const queuedAt=Date.now();let release;
      try{release=await scheduler.acquire(signal);}finally{timings.queueMs+=Date.now()-queuedAt;}
      const modelController=new AbortController(),modelSignal=AbortSignal.any([signal,modelController.signal]);
      const modelTimer=setTimeout(()=>modelController.abort(invalid('ai_timeout','AI 暂未完成回答，请稍后重试。',504)),options.aiTimeoutMs);
      const at=Date.now();let taskId='',config;
      try{
        config=await withSignal(configProvider(),modelSignal);
        const response=await withSignal(callDify(config,'/chat-messages',{inputs:config.inputs||{},query,response_mode:'streaming',user,auto_generate_name:false},{signal:modelSignal}),modelSignal);
        return await withSignal(readReply(response,{signal:modelSignal,onTask:id=>{taskId=id;},
          onFirstChunk:()=>{if(timings.modelFirstByteMs===null)timings.modelFirstByteMs=Date.now()-at;}}),modelSignal);
      }catch(error){
        const failure=modelSignal.aborted?modelSignal.reason:error;
        scheduler.recordFailure(failure.code);
        if(failure.code==='dify_http_429')failure.retryAfter=Math.ceil(options.cooldownMs/1000);
        // Stopping the transport does not promise that a remote model has stopped.
        if(taskId&&config&&(modelSignal.aborted||failure.code==='incomplete_reply')){
          void callDify(config,'/chat-messages/'+encodeURIComponent(taskId)+'/stop',{user},{signal:AbortSignal.timeout(1000)})
            .then(response=>response.body?.cancel()).catch(()=>{});
        }
        throw failure;
      }finally{timings.modelMs+=Date.now()-at;clearTimeout(modelTimer);modelController.abort();release();}
    }
    try{
      let body=await withSignal(readBody(),signal);const limit=kind==='student'?1000:2000;
      if(!body||typeof body!=='object'||Array.isArray(body))throw invalid('bad_json','请求需要是有效 JSON 对象。');
      if(typeof body.question!=='string'||!body.question.trim()||body.question.length>limit)throw invalid('bad_question',`请输入 1–${limit} 字的问题。`);
      if(!/^[a-zA-Z0-9_-]{8,80}$/.test(body.sessionId||''))throw invalid('bad_session','请刷新页面后重试。');
      if(kind==='student'&&(!body.trip||!['time','distance'].includes(body.preference)))throw invalid('bad_trip','请先选择出发地、目的地和出行方式。');
      session=sessions.begin(kind+':'+body.sessionId);
      if(kind==='lab'){
        const state=fixture(body.fixtureId);if(!state)throw invalid('unknown_state','当前状态缺失或未知，请选择样例 A 或 B。',422);
        if(futureQuestion(body.question))result=success({answer:'人工构造接口样例，非真实路况。状态版本：'+state.stateVersion+'。暂无未来时段推演数据，无法给出未来出发的路线耗时或建议。',stateVersion:state.stateVersion,usedSource:state.sourceLabel,provider:'local-validation',reason:'forecast_unavailable',sentState:state});
        else{
          provider='school-dify';const reply=await model(makeEnvelope(body.question.trim(),state),session.user);
          // The lab is an explanation endpoint; redact with the same configuration source.
          const config=await withSignal(configProvider(),signal);
          result=success({answer:config.apiKey?reply.answer.split(config.apiKey).join('[已隐藏密钥]'):reply.answer,stateVersion:state.stateVersion,
            messageId:reply.messageId,usedSource:state.sourceLabel,provider,sentState:state});
        }
      }else{
        const prepared=prepareStudent(body);
        if(prepared.reply)result=success(prepared.reply);
        else if(prepared.intent){
          provider='sandbox-forecast';
          // A replay is independent of the short AI deadline. Browser calls poll
          // through 202 responses; legacy direct callers may await the worker.
          if(body.forecastAsync!==true)setDeadline(190000);
          const intent=prepared.intent,at=Date.now();
          const packet=await withSignal(snapshotProvider(),signal);timings.stateMs+=Date.now()-at;
          let forecast;
          if(body.forecastAsync===true){
            const job=forecaster.request(packet,intent,body.preference,body.forecastJobId);
            if(job.status==='pending')result=success({status:'forecast_pending',kind:'departure_forecast',jobId:job.jobId,retryAfterMs:job.retryAfterMs},202);
            else forecast=job.result;
          }else forecast=await withSignal(forecaster.run(packet,intent,body.preference),signal);
          if(!result){
            const checkAt=Date.now(),latest=await withSignal(snapshotProvider(),signal);timings.stateMs+=Date.now()-checkAt;
            if(latest.runId!==packet.runId||latest.settingsRevision!==packet.settingsRevision||JSON.stringify(latest.simulation.settings)!==JSON.stringify(packet.simulation.settings))throw invalid('forecast_stale','交通方案已更新，请重新查询出发时间。',409);
            const state=studentStateFromSandbox(packet,intent.trip);
            result=success({provider,kind:'departure_forecast',status:forecast.status,message:forecastMessage(forecast,intent.trip.destination==='2'?'东教学楼':'云峰学园'),routes:[],forecast,trip:intent.trip,source:state.source,runId:packet.runId,stateVersion:packet.stateVersion,settingsRevision:packet.settingsRevision,settings:{...packet.simulation.settings},clock:packet.clock,departureScenario:packet.departureScenario});
          }
        }else{
        body=prepared.body;
        let state=await getState({...body.trip,fixtureId:body.fixtureId||'A'});
        if(!state)throw invalid('unknown_trip','这个行程暂时没有路线数据。',422);
        const limited=()=>{
          if(state.origin===state.destination)return {status:'same_place',message:'出发地和目的地相同，无需比较路线。'};
          if(!state.routes.length)return {status:'missing_data',message:DATA_LIMIT_REPLY};
          if(futureQuestion(body.question))return {status:'missing_data',message:DATA_LIMIT_REPLY};
          return null;
        };
        const unavailable=limited();
        if(unavailable)result=success({...metadata(state,body.trip),provider,...unavailable,routes:[]});
        else{
          let criterion=options.localRoutingEnabled?localCriterion(body.question,body.preference):null,messageId;
          if(criterion)provider='local-routing';
          else{
            provider='school-dify';const reply=await model(studentEnvelope(body.question.trim(),state,body.preference),session.user);
            const decision=parseStudentReply(reply.answer,state);
            if(!decision)throw invalid('invalid_student_reply','AI 这次没给出可核对的路线建议，请重试。',502);
            const latest=await getState({...body.trip,fixtureId:body.fixtureId||'A'});
            if(!latest||!sameContext(state,latest))throw invalid('state_changed','交通方案已更新，请重新查询。',409);
            state=latest;
            if(decision.status!=='ok')result=success({...metadata(state,body.trip),provider,status:decision.status,
              message:DATA_LIMIT_REPLY,routes:[]});
            else if(limited())throw invalid('state_changed','交通数据已变化，请重新查询。',409);
            criterion=decision.criterion;messageId=reply.messageId;
          }
          if(!result){const route=selectRoute(state.routes,criterion);
            result=success({...metadata(state,body.trip),provider,status:'ok',criterion,recommendedRouteId:route.id,
              message:'建议走'+route.name+'，'+(criterion==='distance'?'路程更短。':'用时更少。'),routes:state.routes,comparison:routeComparison(state),messageId});}
        }
        }
      }
    }catch(error){
      const failure=signal.aborted?signal.reason:error;
      result={status:failure.status||500,body:{error:failure.code||'internal_error',message:failure.status?failure.message:'服务暂不可用，请稍后重试。'},
        headers:failure.retryAfter?{'Retry-After':String(failure.retryAfter)}:{}};
    }finally{
      session?.release();clearTimeout(timeout);req.off('aborted',cancel);res.off('close',cancel);contexts.delete(controller);
    }
    timings.totalMs=Date.now()-started;
    result.body={...result.body,requestId,timings,latencyMs:timings.totalMs};result.headers['X-Request-ID']=requestId;
    try{onMetric({requestId,path:kind==='student'?'/api/student/chat':'/api/chat',provider,status:result.status,error:result.body.error||null,...timings,...scheduler.stats()});}catch{/* Telemetry cannot change a user response. */}
    return result;
  }
  return {handle,stats:()=>({...scheduler.stats(),sessions:sessions.size}),close(){scheduler.close();for(const c of contexts)c.abort(invalid('request_cancelled','服务正在停止。',503));}};
}
