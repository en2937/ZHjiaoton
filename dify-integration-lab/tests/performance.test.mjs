import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {createLabServer} from '../server.mjs';
import {studentState} from '../student.mjs';

const listen=async s=>{s.listen(0,'127.0.0.1');await once(s,'listening');return 'http://127.0.0.1:'+s.address().port;};
const close=async s=>{const end=once(s,'close');s.close();s.closeAllConnections();await end;};
async function setup(t,{policy={},stateProvider,behavior='normal',configured=true}={}){
  const calls=[],metrics=[];let variant=behavior,active=0,maxActive=0;
  const upstream=http.createServer(async(req,res)=>{
    let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);calls.push({path:req.url,body});
    if(req.url.endsWith('/stop')){res.end('{}');return;}
    active++;maxActive=Math.max(maxActive,active);res.once('close',()=>active--);
    if(['429-open','html-open','redirect-open'].includes(variant)){
      res.writeHead(variant==='429-open'?429:variant==='redirect-open'?302:200,{'Content-Type':'text/html',Location:'/other'});res.write('{');return;
    }
    if(variant==='429'){res.writeHead(429);res.end('{}');return;}
    if(variant==='no-headers')return;
    if(variant==='stream-hang'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify({event:'message',task_id:'task-only-test',answer:'{',conversation_id:'ignored'})+'\n\n');return;}
    if(variant==='slow')await delay(100);
    if(res.destroyed)return;
    const payload=JSON.parse(body.query),criterion='time',field='travelTimeSeconds';
    const route=[...payload.state.routes].sort((a,b)=>a[field]-b[field])[0];
    const answer=variant==='invalid'?'broken':JSON.stringify({status:'ok',criterion,recommended_route_id:route.id});
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({answer,conversation_id:'never-reuse'}));
  });
  const url=await listen(upstream);
  const lab=createLabServer(async()=>({apiBase:url+'/v1',apiKey:configured?'test-key':'',allowLoopback:true}),{
    studentProvider:stateProvider||((trip)=>Promise.resolve({...studentState(trip),runId:'test-run',settings:{demand:30}})),
    policy,onMetric:m=>metrics.push(m)}),base=await listen(lab);
  t.after(async()=>{await close(lab);await close(upstream);});
  let seq=0;
  const post=async(patch={},options={})=>{
    const started=performance.now(),res=await fetch(base+'/api/student/chat',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({question:'哪条路更快？',trip:{origin:'1',destination:'2',mode:'electric'},preference:'time',sessionId:'test-session-'+seq++,...patch}),...options});
    return {status:res.status,data:await res.json(),retry:res.headers.get('retry-after'),elapsed:performance.now()-started};
  };
  return {calls,metrics,post,lab,setVariant:x=>variant=x,getMaxActive:()=>maxActive,getActive:()=>active,base};
}

test('本地快答不需要学校配置，30人突发全部完成且模型调用为零',async t=>{
  const h=await setup(t,{configured:false});const results=await Promise.all(Array.from({length:30},()=>h.post()));
  assert(results.every(r=>r.status===200&&r.data.provider==='local-routing'));
  assert(results.every(r=>r.data.requestId&&r.data.timings.totalMs>=0));assert.equal(h.calls.length,0);
  const p95=results.map(r=>r.elapsed).sort((a,b)=>a-b)[Math.ceil(results.length*.95)-1];
  assert(p95<=1000,`P95=${p95}`);t.diagnostic('30 local requests P95='+p95.toFixed(1)+'ms');
});

test('非法AI结果不能成功，未配置AI时复杂问题明确失败，本地开关可回退',async t=>{
  const h=await setup(t,{behavior:'invalid',policy:{localRoutingEnabled:false}});
  assert.equal((await h.post()).data.error,'invalid_student_reply');
  const unconfigured=await setup(t,{configured:false});
  assert.equal((await unconfigured.post({question:'分析当前拥堵影响'})).data.error,'not_configured');
  assert.equal((await unconfigured.post()).data.provider,'local-routing');
});

test('复杂问题独立调用、精简上下文，回答按最新队列重新计算',async t=>{
  let reads=0;
  const h=await setup(t,{stateProvider:async trip=>{
    const state={...studentState(trip),runId:'run',settings:{demand:30}};
    if(++reads%2===0){state.routes[0].travelTimeSeconds=1;state.stateVersion+='-new';}return state;
  }});
  for(let i=0;i<2;i++){const r=await h.post({question:'请根据当前路况比较时间，说明适合赶课的路线',sessionId:'same-session'});assert.equal(r.status,200);assert.equal(r.data.recommendedRouteId,'main');}
  assert.equal(h.calls.length,2);
  for(const {body}of h.calls){assert.equal(body.conversation_id,undefined);const envelope=JSON.parse(body.query);assert.equal(envelope.state.metrics,undefined);assert.equal(envelope.state.settings,undefined);}
});

test('场景或配置改变时不展示旧AI建议',async t=>{
  let reads=0;const h=await setup(t,{stateProvider:async trip=>({...studentState(trip),runId:++reads===1?'before':'after',settings:{}})});
  const r=await h.post({question:'比较当前拥堵对我这趟行程的影响'});assert.equal(r.status,409);assert.equal(r.data.error,'state_changed');
});

test('无首包、流式挂起均超时结束，取得task_id后尽力停止',async t=>{
  const h=await setup(t,{policy:{aiTimeoutMs:40,totalTimeoutMs:180},behavior:'no-headers'});
  const first=await h.post({question:'请考虑当前排队情况帮我比较'});assert.equal(first.data.error,'ai_timeout');assert(first.elapsed<680);
  h.setVariant('stream-hang');const second=await h.post({question:'请考虑当前排队情况帮我比较'});assert.equal(second.data.error,'ai_timeout');
  await delay(40);assert(h.calls.some(c=>c.path==='/v1/chat-messages/task-only-test/stop'));
});

test('429进入冷却，快答继续可用且不自动重试',async t=>{
  const h=await setup(t,{behavior:'429'});
  const first=await h.post({question:'请分析当前路线的排队情况'});assert.equal(first.data.error,'dify_http_429');assert(first.retry);
  const second=await h.post({question:'再比较当前路线的排队情况'});assert.equal(second.data.error,'ai_cooldown');assert.equal(h.calls.length,1);
  assert.equal((await h.post()).data.provider,'local-routing');
});

test('混合30人负载隔离快答、并发模型最多2、排队按时结束',async t=>{
  const h=await setup(t,{behavior:'slow',policy:{queueTimeoutMs:30,totalTimeoutMs:300,aiTimeoutMs:150}});
  const complex=Array.from({length:6},()=>h.post({question:'请分析当前排队情况'}));
  const simple=await Promise.all(Array.from({length:24},()=>h.post()));
  const results=await Promise.all(complex);
  assert(simple.every(r=>r.status===200&&r.data.provider==='local-routing'&&r.elapsed<1000));
  assert(h.getMaxActive()<=2);assert(results.every(r=>r.elapsed<800));
  assert(results.some(r=>r.data.error==='ai_queue_timeout'));assert.equal(h.calls.length,2);
});

test('断开取消释放模型名额，同一会话可重新提问',async t=>{
  const h=await setup(t,{behavior:'stream-hang',policy:{aiConcurrency:1,aiTimeoutMs:2000}});
  const abort=new AbortController(),pending=h.post({question:'请分析当前排队情况',sessionId:'cancel-me'},{signal:abort.signal});
  while(!h.calls.length)await delay(5);
  abort.abort();await assert.rejects(pending);await delay(25);
  h.setVariant('normal');const next=await h.post({question:'请分析当前排队情况',sessionId:'cancel-me'});assert.equal(next.status,200);
});

test('总截止时间涵盖取数，指标不包含问题或密钥',async t=>{
  const h=await setup(t,{policy:{totalTimeoutMs:30},stateProvider:()=>new Promise(()=>{})});
  const r=await h.post();assert.equal(r.data.error,'request_timeout');assert(r.elapsed<530);
  assert(h.metrics.length);assert(!JSON.stringify(h.metrics).includes('test-key'));assert(!JSON.stringify(h.metrics).includes('哪条路'));
});

test('上游错误头后不结束响应时，仍及时取消传输而非只释放计数',async t=>{
  for(const behavior of ['429-open','html-open','redirect-open']){
    const h=await setup(t,{behavior});
    const result=await h.post({question:'请分析当前排队情况'});assert.equal(result.status,502);
    await delay(50);assert.equal(h.getActive(),0,behavior+' retained an upstream connection');
  }
});
