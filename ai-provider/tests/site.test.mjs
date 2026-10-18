import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {startTestSite,IsolatedTestAuth} from '../start-test.mjs';
import {DATA_LIMIT_REPLY} from '../../qa-policy/knowledge-scope.mjs';

async function harness(t,{configured=true}={}){
  const calls=[];let malformed=false,limited=false,mutate=null;
  const upstream=http.createServer(async(req,res)=>{
    let raw='';for await(const c of req)raw+=c;
    const body=raw?JSON.parse(raw):null;calls.push({path:req.url,body});
    if(req.url==='/models'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:[{id:'deepseek-flash'}]}));return;}
    if(limited){res.writeHead(429);res.end('test-only-secret');return;}
    const envelope=JSON.parse(body.messages[1].content),admin=envelope.protocol==='campus-admin-v2';
    if(mutate){mutate();mutate=null;}
    let answer;
    if(admin){
      const active=envelope.state.behavior.enabled,q=envelope.question;
      const intent=/设为/.test(q)?'set':/优化方案/.test(q)?'suggest':'inspect';
      answer=JSON.stringify({protocol:'campus-admin-v2',status:'ok',intent,state_version:envelope.state.stateVersion,
        reply:'{{behavior.facts.queues}}。可比较相应措施，效果需对照验证。',
        basis:active?'本次参考了路线认知、尝试意愿和引导触达；{{behavior.facts.eligible}}。':'当前未启用认知与意愿分组，本次仍按原选路规则分析',
        changes:intent==='set'?{guidanceCoverage:55}:{},suggested_settings:intent==='suggest'?{northBypassShare:80}:{},
        evidence:['behavior.facts.queues',...(active?['behavior.facts.eligible']:[])]});
    }else if(envelope.protocol==='campus-student-v1'){
      const criterion=/近|距离/.test(envelope.question)?'distance':'time',field=criterion==='distance'?'distanceMeters':'travelTimeSeconds';
      const route=[...envelope.state.routes].sort((a,b)=>a[field]-b[field])[0];
      answer=JSON.stringify({status:'ok',criterion,recommended_route_id:route.id});
    }else answer='人工构造接口样例，非真实路况。状态版本：'+envelope.state.stateVersion;
    if(malformed)answer='not-json';
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    res.end('data: '+JSON.stringify({id:'deepseek-site-test',choices:[{index:0,delta:{content:answer},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
  });
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const auth=new IsolatedTestAuth();await auth.setup('isolated_test','test-only-password');
  const site=await startTestSite({port:0,clock:false,auth,studentPolicy:{localRoutingEnabled:false},configProvider:async audience=>({provider:'deepseek',audience,apiBase:'http://127.0.0.1:'+upstream.address().port,apiKey:configured?'test-only-secret':'',model:'deepseek-flash',timeoutMs:1000,allowLoopback:true})});
  t.after(async()=>{await site.close();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));});
  let cookie='',csrf='';
  async function request(path,{body,headers={},authenticated=false}={}){
    const r=await fetch(site.url+path,{method:body?'POST':'GET',redirect:'manual',headers:{...(body?{'Content-Type':'application/json',Origin:site.url}:{}),...(authenticated?{Cookie:cookie,'X-CSRF-Token':csrf}:{}),...headers},body:body?JSON.stringify(body):undefined});
    const text=await r.text();let data;try{data=JSON.parse(text);}catch{}return {status:r.status,data,text,cookie:r.headers.get('set-cookie')?.split(';')[0],headers:r.headers};
  }
  const login=async()=>{const r=await request('/api/admin/login',{body:{username:'isolated_test',password:'test-only-password'}});assert.equal(r.status,200);cookie=r.cookie;csrf=(await request('/api/admin/session',{authenticated:true})).data.csrfToken;return cookie;};
  const ask=(question='当前怎么选路线？',extra={})=>request('/api/student/chat',{body:{question,trip:{origin:'1',destination:'2',mode:'electric'},preference:'time',sessionId:randomUUID(),...extra}});
  const admin=(question,extra={})=>request('/api/admin/ai/chat',{authenticated:true,body:{chatId:'deepseek-site-chat',requestId:randomUUID(),question,...extra}});
  return {site,calls,request,login,ask,admin,setMalformed:x=>malformed=x,setLimited:x=>limited=x,setMutate:x=>mutate=x};
}

test('独立站点师生按时间/距离对比，JSON结构和本轮状态传入DeepSeek',async t=>{
  const h=await harness(t);
  for(const [question,criterion]of [['哪条路更快？','time'],['哪条路距离更短？','distance']]){
    const r=await h.ask(question);assert.equal(r.status,200);assert.equal(r.data.provider,'deepseek');assert.equal(r.data.criterion,criterion);assert.equal(r.data.routes.length,3);assert(r.data.comparison);
    const last=h.calls.at(-1).body;assert.equal(last.messages.length,2);assert.match(last.messages[0].content,/campus-student-v1/);assert.equal(JSON.parse(last.messages[1].content).state.runId,r.data.runId);
  }
  h.site.runtime.control({action:'settings',settings:{northBypassShare:75}});await h.ask();
  assert.equal(JSON.parse(h.calls.at(-1).body.messages[1].content).state.runId,h.site.runtime.runId);
});

test('管理员DeepSeek闭环：登录/CSRF、因素说明、建议待确认、执行和撤回',async t=>{
  const h=await harness(t);
  assert.equal((await h.request('/api/admin/ai/chat',{body:{}})).status,401);
  const cookie=await h.login();assert.match(cookie,/^traffic_admin_deepseek_test=/);assert(!cookie.startsWith('traffic_admin_local='));
  assert.equal((await h.request('/api/admin/ai/chat',{authenticated:true,headers:{'X-CSRF-Token':'wrong'},body:{}})).status,403);assert.equal(h.calls.length,0);
  const inspect=await h.admin('为什么绕行人数少？');assert.equal(inspect.status,200);assert.equal(inspect.data.kind,'info');assert.match(inspect.data.message,/本次参考了路线认知、尝试意愿和引导触达/);
  const before=h.site.runtime.sim.settings.northBypassShare;
  const proposal=await h.admin('给一个优化方案');assert.equal(proposal.status,200);assert.equal(proposal.data.kind,'proposal');assert.equal(h.site.runtime.sim.settings.northBypassShare,before);
  const applied=await h.admin('',{action:'apply'});assert.equal(applied.data.kind,'applied');assert.equal(h.site.runtime.sim.settings.northBypassShare,80);
  const student=await h.ask();assert.equal(student.data.settings.northBypassShare,80);assert.equal(student.data.runId,h.site.runtime.runId);
  const undone=await h.admin('',{action:'undo'});assert.equal(undone.data.kind,'undone');assert.equal(h.site.runtime.sim.settings.northBypassShare,before);
  const set=await h.admin('引导覆盖设为55%');assert.equal(set.data.kind,'applied');assert.equal(h.site.runtime.sim.settings.guidanceCoverage,55);
  assert.match(h.calls.find(x=>JSON.parse(x.body.messages[1].content).protocol==='campus-admin-v2').body.messages[0].content,/必须等管理员确认/);
});

test('未知地点及课堂缺时间由本地处理，DeepSeek错误输出不绕过原校验',async t=>{
  const h=await harness(t);await h.login();
  const unknown=await h.ask('去北教哪条路快？');assert.equal(unknown.status,200);assert.equal(unknown.data.message,DATA_LIMIT_REPLY);
  const missing=await h.ask('我去东教上课几点出发？');assert.equal(missing.data.status,'need_clarification');assert.equal(h.calls.length,0);
  const unknownAdmin=await h.admin('分析北教拥堵');assert.equal(unknownAdmin.data.message,DATA_LIMIT_REPLY);assert.equal(h.calls.length,0);
  h.setMalformed(true);assert.equal((await h.ask()).data.error,'invalid_student_reply');
  const before=h.site.runtime.settingsRevision,r=await h.admin('给一个优化方案');assert.equal(r.data.kind,'rejected');assert.equal(h.site.runtime.settingsRevision,before);
});

test('DeepSeek429进入原冷却机制；版本变化拒绝旧回答且不自动重试',async t=>{
  const h=await harness(t);h.setMutate(()=>h.site.runtime.control({action:'settings',settings:{electric:55}}));
  const changed=await h.ask();assert.equal(changed.status,409);assert.equal(changed.data.error,'state_changed');
  h.setLimited(true);const limited=await h.ask();assert.equal(limited.status,429);assert.equal(limited.data.error,'deepseek_http_429');const n=h.calls.length;
  assert.equal((await h.ask()).data.error,'ai_cooldown');assert.equal(h.calls.length,n);
});

test('测试入口不链接正式端口、Cookie隔离、私有配置和桥接权限不可泄露',async t=>{
  const h=await harness(t);
  for(const url of ['/student/','/login','/viewer/']){const r=await h.request(url);assert.equal(r.status,200);assert(!/127\.0\.0\.1:(4173|4174|4183)/.test(r.text));assert(!r.text.includes('test-only-secret'));}
  await h.login();const fakeFormal=(await h.request('/api/admin/status',{headers:{Cookie:'traffic_admin_local=fake-formal-cookie'}})).data;assert.equal(fakeFormal.authenticated,false);
  for(const url of ['/ai-provider/private/config.json','/private/dify-admin.json','/ai-provider/config.mjs','/.env.local'])assert.equal((await h.request(url)).status,404);
  const controlled=await h.request('/api/control',{body:{action:'settings',settings:{electric:55}},headers:{'X-Admin-Control-Key':'test-only-secret'}});assert.equal(controlled.status,401);
  assert.equal((await h.request('/api/admin/login',{body:{},headers:{Origin:'https://external.invalid'}})).status,403);
  const checked=await h.request('/api/check',{body:{}});assert.equal(checked.data.provider,'deepseek');assert.equal(h.calls.length,1);assert.equal(h.calls[0].path,'/models');
  const status=await h.request('/api/status');assert.equal(status.data.mode,'real-deepseek');assert.equal(status.data.schoolUrl,null);assert(!status.text.includes('test-only-secret'));
});

test('没有密钥时不伪造模型回答，独立测试入口依然能打开',async t=>{
  const h=await harness(t,{configured:false});assert.equal((await h.request('/student/')).status,200);
  assert.equal((await h.ask()).data.error,'not_configured');assert.equal(h.calls.length,0);
  await h.login();assert.equal((await h.admin('分析一下当前拥堵')).data.code,'not_configured');assert.equal(h.calls.length,0);
});
