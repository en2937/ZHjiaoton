import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {startPublicSite} from '../server.mjs';
import {publicOrigin,deploymentConfig} from '../config.mjs';
import {initializeEnv} from '../init-env.mjs';
import {AdminAuth} from '../../admin-access/auth.mjs';

const origin='https://traffic.example.test',edgeKey='a'.repeat(64),testPassword='test-only-password',apiKey='test-only-api-key';
async function fixture(t,options={}){
  const calls=[];
  const upstream=http.createServer(async(req,res)=>{
    let raw='';for await(const c of req)raw+=c;
    const payload=JSON.parse(raw),env=JSON.parse(payload.messages[1].content);calls.push(env);
    let answer;
    if(env.protocol==='campus-admin-v2')answer={protocol:'campus-admin-v2',status:'ok',intent:'suggest',state_version:env.state.stateVersion,reply:'{{behavior.facts.queues}}。可比较引导覆盖变化。',basis:'本次参考了路线认知、尝试意愿和引导触达；{{behavior.facts.eligible}}。',changes:{},suggested_settings:{guidanceCoverage:40},evidence:['behavior.facts.queues','behavior.facts.eligible']};
    else{const r=[...env.state.routes].sort((a,b)=>a.travelTimeSeconds-b.travelTimeSeconds)[0];answer={status:'ok',criterion:'time',recommended_route_id:r.id};}
    res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'public-test',choices:[{index:0,delta:{content:JSON.stringify(answer)},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
  });
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  t.after(async()=>{upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));});
  const auth=new AdminAuth();await auth.setup('deployment_test',testPassword);
  const site=await startPublicSite({origin,edgeKey,auth,clock:false,studentPolicy:{localRoutingEnabled:false},configProvider:async audience=>({provider:'deepseek',audience,apiBase:'http://127.0.0.1:'+upstream.address().port,apiKey,model:'deepseek-flash',timeoutMs:1000,allowLoopback:true}),...options});
  t.after(()=>site.close());const base='http://127.0.0.1:'+site.port;let cookie='',csrf='';
  async function request(url,{body,headers={},authenticated=false,method=body?'POST':'GET',ip='203.0.113.10'}={}){
    // Node fetch replaces Host; use the same HTTP transport as the reverse proxy.
    return new Promise((resolve,reject)=>{
      const q=http.request(base+url,{method,headers:{Host:new URL(origin).host,'X-Traffic-Edge-Key':edgeKey,'X-Traffic-Proto':'https','X-Traffic-Client-IP':ip,...(body?{'Content-Type':'application/json',Origin:origin}:{}),...(authenticated?{Cookie:cookie,'X-CSRF-Token':csrf}:{}),...headers}},r=>{
        const chunks=[];r.on('data',c=>chunks.push(c));r.on('error',reject);r.on('end',()=>{
          const text=Buffer.concat(chunks).toString('utf8');let data;try{data=JSON.parse(text);}catch{}
          const resultHeaders=new Headers();for(let i=0;i<r.rawHeaders.length;i+=2)resultHeaders.append(r.rawHeaders[i],r.rawHeaders[i+1]);
          resolve({status:r.statusCode,body:data,text,headers:resultHeaders});
        });
      });q.on('error',reject);q.end(body?JSON.stringify(body):undefined);
    });
  }
  async function login(ip){const r=await request('/api/admin/login',{body:{username:'deployment_test',password:testPassword},ip});assert.equal(r.status,200);cookie=r.headers.get('set-cookie').split(';')[0];csrf=(await request('/api/admin/session',{authenticated:true})).body.csrfToken;return r;}
  const ask=(extra={})=>request('/api/student/chat',{body:{question:'请比较目前从云峰去东教的路线用时。',trip:{origin:'1',destination:'2',mode:'electric'},preference:'time',sessionId:randomUUID()},...extra});
  return {site,auth,calls,base,request,login,ask};
}

test('部署配置要求HTTPS和独立代理密钥；初始化私有env不覆盖已有配置',async t=>{
  assert.equal(publicOrigin(origin+'/'),origin);
  for(const value of ['http://traffic.example.test','https://traffic.example.test/path','https://u:p@traffic.example.test','https://traffic.example.test?secret=x'])assert.throws(()=>publicOrigin(value));
  assert.throws(()=>deploymentConfig({PUBLIC_ORIGIN:origin,TRAFFIC_PROXY_KEY:'weak'}));
  const dir=await mkdtemp(path.join(os.tmpdir(),'traffic-deploy-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'.env');
  await initializeEnv(origin,{file});const text=await readFile(file,'utf8');assert.match(text,/TRAFFIC_PROXY_KEY=[a-f0-9]{64}/);assert.match(text,/DEEPSEEK_API_KEY=\n/);await assert.rejects(initializeEnv(origin,{file}),{code:'EEXIST'});
  await assert.rejects(startPublicSite({origin,edgeKey,auth:new AdminAuth()}),/初始化管理员/);
});

test('公网仅信任指定代理；Host、Origin、协议和客户端地址均验证',async t=>{
  const h=await fixture(t);assert.equal((await h.request('/_health')).status,200);
  await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../health.mjs',import.meta.url))],{env:{...process.env,PORT:String(h.site.port),PUBLIC_ORIGIN:origin,TRAFFIC_PROXY_KEY:edgeKey}});
  for(const headers of [{'X-Traffic-Edge-Key':''},{Host:'evil.example.test'},{Origin:'https://evil.example.test'},{'X-Traffic-Proto':'http'},{'X-Traffic-Client-IP':'fake'}])assert.equal((await h.request('/_health',{headers})).status,403);
  assert.equal((await h.request('/api/admin/login',{body:{},headers:{Origin:''}})).status,403);
  assert.equal((await h.request('/api/admin/setup',{body:{username:'attacker',password:testPassword}})).status,403);
  const direct=await fetch('http://127.0.0.1:'+h.site.internalAdminPort+'/api/admin/status',{headers:{Host:new URL(origin).host}});assert.equal(direct.status,403);
});

test('公网登录使用Secure的__Host Cookie；CSRF、方案确认、撤回与师生同源保持',async t=>{
  const h=await fixture(t);assert.equal((await h.request('/api/control',{body:{action:'reset'}})).status,401);
  const logged=await h.login();assert.match(logged.headers.get('set-cookie'),/^__Host-traffic_admin=/);assert.match(logged.headers.get('set-cookie'),/; Secure/);
  const input={chatId:'public-deploy-chat',requestId:randomUUID(),question:'给一个优化方案'};
  assert.equal((await h.request('/api/admin/ai/chat',{body:input,authenticated:true,headers:{'X-CSRF-Token':'wrong'}})).status,403);assert.equal(h.calls.length,0);
  const proposal=await h.request('/api/admin/ai/chat',{body:input,authenticated:true});assert.equal(proposal.body.kind,'proposal');assert.match(proposal.body.message,/本次参考了路线认知、尝试意愿和引导触达/);assert.equal(h.site.runtime.sim.settings.guidanceCoverage,0);
  const apply=await h.request('/api/admin/ai/chat',{authenticated:true,body:{chatId:input.chatId,requestId:randomUUID(),action:'apply'}});assert.equal(apply.body.kind,'applied');assert.equal(h.site.runtime.sim.settings.guidanceCoverage,40);
  const student=await h.ask();assert.equal(student.body.provider,'deepseek');assert.equal(student.body.settings.guidanceCoverage,40);assert.equal(student.body.runId,h.site.runtime.runId);
  const undo=await h.request('/api/admin/ai/chat',{authenticated:true,body:{chatId:input.chatId,requestId:randomUUID(),action:'undo'}});assert.equal(undo.body.kind,'undone');assert.equal(h.site.runtime.sim.settings.guidanceCoverage,0);
});

test('登录限流按可信真实客户端区分，不把所有访客记成反向代理IP',async t=>{
  const h=await fixture(t);
  for(let i=0;i<5;i++)assert.equal((await h.request('/api/admin/login',{body:{username:'deployment_test',password:'wrong'},ip:'203.0.113.11'})).status,401);
  assert.equal((await h.request('/api/admin/login',{body:{username:'deployment_test',password:'wrong'},ip:'203.0.113.11'})).status,429);
  assert.equal((await h.login('203.0.113.12')).status,200);
});

test('私有配置与实验接口不开放，所有页面链接留在公网同源',async t=>{
  const h=await fixture(t);
  for(const url of ['/server-deploy/.env','/ai-provider/private/config.json','/admin-access/private/accounts.json','/server-deploy/server.mjs','/api/check','/api/chat','/api/status','//evil.example.test']){const r=await h.request(url);assert(r.status>=400);assert(!r.text.includes(apiKey));}
  for(const url of ['/student/','/viewer/','/login']){const r=await h.request(url);assert.equal(r.status,200);assert(!/127\.0\.0\.1:(4173|4174|4183)/.test(r.text));assert(!r.text.includes(edgeKey));assert(!r.text.includes(apiKey));}
  const head=await h.request('/student/',{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.text,'');
});

test('每IP提问限额独立，伪造桥接头不能控制，正文大小有上限',async t=>{
  const h=await fixture(t,{chatLimit:1});assert.equal((await h.ask()).status,200);assert.equal((await h.ask()).status,429);assert.equal((await h.ask({ip:'203.0.113.13'})).status,200);
  const r=await h.request('/api/control',{body:{action:'settings',settings:{electric:90}},headers:{'X-Admin-Control-Key':apiKey,'X-Internal-Proxy-Key':edgeKey}});assert.equal(r.status,401);assert.equal(h.site.runtime.sim.settings.electric,70);
  assert.equal((await h.request('/api/student/chat',{ip:'203.0.113.14',body:{question:'x'.repeat(40000)}})).status,413);
});

test('公网共享车流沿用默认小时循环，读取与访客数量不重建模型',async t=>{
  const h=await fixture(t);const runtime=h.site.runtime,id=runtime.runId;assert.equal(runtime.defaultWindowActive(),true);
  for(let i=0;i<5;i++)assert.equal((await h.request('/api/simulation')).body.runId,id);
  runtime.sim.time=3599.9;runtime.advance(.1);assert.notEqual(runtime.runId,id);assert.equal(runtime.loopCount,1);assert(runtime.sim.time<1);
});
