import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AdminAuth} from '../auth.mjs';
import {createAdminServer} from '../server.mjs';
import {createSandboxServer} from '../../traffic-sandbox/server.mjs';
import {SharedSimulation} from '../../traffic-sandbox/shared-simulation.mjs';

const user='test_manager',password='only-used-in-auth-tests';
const listen=async server=>{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});return server.address().port;};
const close=async server=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));};
async function harness(t,{secure=false,now}={}){
 const auth=new AdminAuth({now}),runtime=new SharedSimulation({running:false}),bridgeKey='only-test-bridge';
 const sandbox=createSandboxServer({runtime,clock:false,controlKey:bridgeKey}),sandboxPort=await listen(sandbox);
 const tlsOptions=secure?{key:await readFile(new URL('../private/server-key.pem',import.meta.url)),cert:await readFile(new URL('../private/server-cert.pem',import.meta.url))}:null;
 const server=createAdminServer({auth,bridgeKey,sandboxPort,host:'127.0.0.1',port:0,tlsOptions,allowAddress:()=>true}),port=await listen(server);
 const base=(secure?'https://':'http://')+'127.0.0.1:'+port;
 const ca=secure?await readFile(new URL('../public/campus-admin-ca.pem',import.meta.url)):undefined;
 t.after(async()=>{await close(server);await close(sandbox);});
 function request(url='/',{method='GET',data,cookie='',csrf='',origin=base,headers={}}={}){
  return new Promise((resolve,reject)=>{const req=(secure?https:http).request(base+url,{method,ca,headers:{...(method==='POST'?{'Content-Type':'application/json',Origin:origin}:{}),...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...headers}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{const text=Buffer.concat(chunks).toString();let body;try{body=JSON.parse(text);}catch{}resolve({status:res.statusCode,headers:res.headers,text,body});});});req.on('error',reject);req.end(data===undefined?undefined:JSON.stringify(data));});
 }
 const login=async()=>{const r=await request('/api/admin/login',{method:'POST',data:{username:user,password}});assert.equal(r.status,200);const cookie=r.headers['set-cookie'][0].split(';')[0];const s=await request('/api/admin/session',{cookie});return {cookie,csrf:s.body.csrfToken,rawCookie:r.headers['set-cookie'][0]};};
 return {auth,runtime,sandboxPort,request,login,base};
}

test('首次设置仅保留随机盐和密码哈希，重复设置失败，没有默认账号',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'campus-admin-test-'));t.after(()=>{const target=path.resolve(dir);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('campus-admin-test-'));return rm(target,{recursive:true,force:true});});
 const auth=new AdminAuth({file:path.join(dir,'account.json')});await auth.ready;assert.equal(auth.record,null);
 await assert.rejects(auth.setup('ab','short'),{status:400});await auth.setup(user,password);
 const stored=await readFile(path.join(dir,'account.json'),'utf8');assert.equal(stored.includes(password),false);assert.equal(auth.record.hash.length,128);
 await assert.rejects(auth.setup('another_manager',password),{status:409});
 const reloaded=new AdminAuth({file:path.join(dir,'account.json')});await reloaded.ready;assert.equal(reloaded.record.username,user);
});

test('未登录页面跳转，控制接口及原始沙盘接口均拒绝匿名修改',async t=>{
 const h=await harness(t),initial=h.runtime.packet().stateVersion;
 const root=await h.request('/');assert.equal(root.status,302);assert.equal(root.headers.location,'/login');
 assert.equal((await h.request('/login')).status,200);
 assert.equal((await h.request('/api/control',{method:'POST',data:{action:'reset'}})).status,401);
 const direct=await fetch('http://127.0.0.1:'+h.sandboxPort+'/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"action":"reset"}'});assert.equal(direct.status,401);
 assert.equal(h.runtime.packet().stateVersion,initial);
 for(const p of ['/private/account.json','/private/bridge-key.txt','/server.mjs','/api/admin/anything'])assert.ok([401,404].includes((await h.request(p)).status));
});

test('本机首次设置、正确登录与退出登录形成真实管理闭环',async t=>{
 const h=await harness(t);
 const setup=await h.request('/api/admin/setup',{method:'POST',data:{username:user,password}});assert.equal(setup.status,200);
 const session=await h.login();assert.match(session.rawCookie,/HttpOnly/);assert.match(session.rawCookie,/SameSite=Strict/);
 const html=await h.request('/',session);assert.equal(html.status,200);assert.match(html.text,/id="adminLogout"/);assert.doesNotMatch(html.text,/<input disabled[^>]*id="northBypassShare"/);
 assert.equal((await h.request('/api/control',{method:'POST',...session,data:{action:'settings',settings:{northBypassShare:85}}})).status,200);assert.equal(h.runtime.sim.settings.northBypassShare,85);
 assert.equal((await h.request('/api/admin/logout',{method:'POST',...session,data:{}})).status,200);
 assert.equal((await h.request('/api/control',{method:'POST',...session,data:{action:'reset'}})).status,401);
});

test('跨站登录、控制与伪造 CSRF 被拒绝，用户名与密码错误文案一致',async t=>{
 const h=await harness(t);await h.auth.setup(user,password);
 const badName=await h.request('/api/admin/login',{method:'POST',data:{username:'missing_user',password}}),badPass=await h.request('/api/admin/login',{method:'POST',data:{username:user,password:'incorrect-password'}});
 assert.equal(badName.status,401);assert.equal(badName.body.message,badPass.body.message);
 assert.equal((await h.request('/api/admin/login',{method:'POST',origin:'https://external.invalid',data:{username:user,password}})).status,403);
 const session=await h.login(),before=h.runtime.packet().stateVersion;
 assert.equal((await h.request('/api/control',{method:'POST',cookie:session.cookie,csrf:'forged',data:{action:'reset'}})).status,403);
 assert.equal((await h.request('/api/control',{method:'POST',...session,origin:'https://external.invalid',data:{action:'reset'}})).status,403);
 assert.equal(h.runtime.packet().stateVersion,before);
});

test('会话闲置过期、绝对过期及登录轮换不能沿用旧身份',async t=>{
 let now=1000;const h=await harness(t,{now:()=>now});await h.auth.setup(user,password);
 const first=await h.login(),second=await h.login();assert.notEqual(first.cookie,second.cookie);
 now+=30*60*1000;assert.equal((await h.request('/api/admin/session',second)).status,401);
 const third=await h.login();const active=h.auth.authenticate({headers:{cookie:third.cookie}},'local').session;now+=8*60*60*1000;active.lastUse=now;assert.equal((await h.request('/api/admin/session',third)).status,401);
});

test('失败登录限流且不会把密码回显或暴露内部配置',async t=>{
 const h=await harness(t);await h.auth.setup(user,password);
 for(let i=0;i<5;i++)assert.equal((await h.request('/api/admin/login',{method:'POST',data:{username:user,password:'incorrect-password'}})).status,401);
 const limited=await h.request('/api/admin/login',{method:'POST',data:{username:user,password}});assert.equal(limited.status,429);assert.equal(limited.text.includes(password),false);
});

test('HTTPS 验证证书和主机名，安全 Cookie 与本机会话隔离，远端不能首次设置',async t=>{
 const h=await harness(t,{secure:true});
 const bootstrap=await h.request('/api/admin/status');assert.equal(bootstrap.body.canSetup,false);
 assert.equal((await h.request('/api/admin/setup',{method:'POST',data:{username:user,password}})).status,403);
 await h.auth.setup(user,password);const session=await h.login();assert.match(session.rawCookie,/^__Host-traffic_admin=/);assert.match(session.rawCookie,/; Secure/);
 assert.equal((await h.request('/api/control',{method:'POST',...session,data:{action:'speed',speed:8}})).status,200);
 assert.equal(h.runtime.speed,8);
 const local=await h.auth.login(user,password,'local','local');
 assert.equal((await h.request('/api/admin/session',{cookie:'__Host-traffic_admin='+local.value})).status,401);
});
