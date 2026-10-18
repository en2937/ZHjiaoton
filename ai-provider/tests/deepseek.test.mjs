import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {loadProviderConfig,deepSeekBase} from '../config.mjs';
import {loadSystemPrompt,promptFiles} from '../prompts.mjs';
import {callDeepSeek,readDeepSeekReply,checkDeepSeek} from '../deepseek.mjs';
import {AiScheduler} from '../../dify-integration-lab/request-policy.mjs';

const env={},key='test-only-deepseek-key';
const envelope=(protocol='campus-student-v1',version='test-state-A')=>({query:JSON.stringify({protocol,question:'哪条路更快？',state:{stateVersion:version,routes:[]}}),user:'never-send-this-user',conversation_id:'never-send-this-conversation'});
const answer='{"status":"ok","criterion":"time","recommended_route_id":"main"}';
const completion=(content=answer,reason='stop')=>({id:'chat-test',choices:[{index:0,message:{role:'assistant',content},finish_reason:reason}]});
async function fixture(t){
  const calls=[];let behavior='stream';
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    calls.push({path:req.url,auth:req.headers.authorization,body:raw?JSON.parse(raw):null});
    if(behavior==='hang')return;
    if(/^(401|402|429|500)$/.test(behavior)){res.writeHead(Number(behavior));res.end(key);return;}
    if(behavior==='redirect'){res.writeHead(302,{Location:'https://invalid.example/'+key});res.end(key);return;}
    if(req.url.endsWith('/models')){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:[{id:'deepseek-flash'}]}));return;}
    if(behavior==='html'){res.writeHead(200,{'Content-Type':'text/html'});res.end(key);return;}
    if(['json','length','empty','echo-key','bad-json'].includes(behavior)){
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(behavior==='bad-json'?'{':JSON.stringify(completion(behavior==='empty'?'':behavior==='echo-key'?key:answer,behavior==='length'?'length':'stop')));return;
    }
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    if(behavior==='stream-hang'){res.write(':keepalive\n\n');return;}
    const events=[{id:'chat-test',choices:[{index:0,delta:{reasoning_content:'do-not-display-private-reasoning'}}]},
      {id:'chat-test',choices:[{index:0,delta:{content:'中文'+answer.slice(0,15)}}]},
      {id:'chat-test',choices:[{index:0,delta:{content:answer.slice(15)},finish_reason:behavior==='stream-length'?'length':'stop'}]}];
    let data=events.map(x=>'data: '+JSON.stringify(x)+'\r\n\r\n').join('');
    if(behavior!=='truncated')data+='data: [DONE]\r\n\r\n';
    if(behavior==='invalid-stream')data='data: broken\n\n';
    if(behavior==='oversized')data=': '+('x'.repeat(2*1024*1024))+'\n\n';
    const buffer=Buffer.from(data);for(let at=0;at<buffer.length;at+=behavior==='oversized'?65536:7)res.write(buffer.subarray(at,at+(behavior==='oversized'?65536:7)));
    res.end();
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const config={provider:'deepseek',audience:'student',apiBase:'http://127.0.0.1:'+server.address().port,apiKey:key,model:'deepseek-flash',timeoutMs:1000,allowLoopback:true};
  return {calls,config,set:value=>behavior=value,call:async(payload=envelope(),options={})=>readDeepSeekReply(await callDeepSeek(config,payload,options),options)};
}

test('配置默认保留Dify；显式选择DeepSeek且不继承学校密钥，环境变量优先',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'traffic-provider-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'config.json');let legacyCalls=0;
  const legacy=async()=>{legacyCalls++;return {apiBase:'https://school.invalid/v1',apiKey:'school-test-only'};};
  assert.equal((await loadProviderConfig('student',legacy,{env,file})).provider,'dify');
  const deepseek=await loadProviderConfig('student',legacy,{env:{AI_PROVIDER:'deepseek'},file});assert.equal(deepseek.apiKey,'');assert.equal(legacyCalls,1);
  await writeFile(file,JSON.stringify({provider:'deepseek',apiKey:'file-test-only',student:{model:'role-test-model'}}));
  const cfg=await loadProviderConfig('student',legacy,{env:{DEEPSEEK_API_KEY:key},file});assert.equal(cfg.apiKey,key);assert.equal(cfg.model,'role-test-model');
  assert.equal((await loadProviderConfig('admin',legacy,{env:{ADMIN_AI_PROVIDER:'dify'},file})).provider,'dify');
  await assert.rejects(loadProviderConfig('student',legacy,{env:{AI_PROVIDER:'unknown'},file}),{code:'invalid_config'});
  await assert.rejects(loadProviderConfig('student',legacy,{env:{AI_PROVIDER:'deepseek',DEEPSEEK_TIMEOUT_MS:'999999'},file}),{code:'invalid_config'});
  await writeFile(file,'bad');await assert.rejects(loadProviderConfig('admin',legacy,{env,file}),{code:'invalid_config'});
});

test('只允许官方HTTPS地址；测试回环需显式注入，配置文件不能打开回环权限',async t=>{
  assert.equal(deepSeekBase({}),'https://api.deepseek.com');
  for(const apiBase of ['https://api.deepseek.com.evil.test','https://user:pass@api.deepseek.com','https://api.deepseek.com?key=x','http://api.deepseek.com','https://api.deepseek.com/else','http://127.0.0.1:1234'])assert.throws(()=>deepSeekBase({apiBase}),{code:'invalid_config'});
  const h=await fixture(t);h.config.apiKey='';await assert.rejects(h.call(),{code:'not_configured'});assert.equal(h.calls.length,0);
});

test('两端加载原有完整提示词；文件保存后下一轮自动加载，不需要平台发布',async t=>{
  for(const audience of ['student','admin']){const p=await loadSystemPrompt(audience);assert(p.content.includes(await readFile(promptFiles[audience],'utf8')));assert.match(p.content,/current user message/);assert.equal(p.version.length,16);}
  const admin=await loadSystemPrompt('admin');assert.match(admin.content,/路线认知、尝试意愿和引导触达/);assert.match(admin.content,/必须等管理员确认/);
  const dir=await mkdtemp(path.join(os.tmpdir(),'traffic-prompt-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'prompt.txt');
  await writeFile(file,'JSON version A');const a=await loadSystemPrompt('student',{file});await writeFile(file,'JSON version B');const b=await loadSystemPrompt('student',{file});assert.notEqual(a.version,b.version);
  await writeFile(file,'');await assert.rejects(loadSystemPrompt('student',{file}),{code:'invalid_prompt'});
});

test('发送system及本轮user状态，非思考JSON模式；不发送Dify会话或历史身份',async t=>{
  const h=await fixture(t);h.set('json');await h.call();await h.call(envelope('campus-student-v1','test-state-B'));
  for(const call of h.calls){assert.equal(call.path,'/chat/completions');assert.equal(call.auth,'Bearer '+key);assert.equal(call.body.messages.length,2);assert.equal(call.body.messages[0].role,'system');assert.equal(call.body.messages[1].role,'user');assert.equal(call.body.response_format.type,'json_object');assert.equal(call.body.thinking.type,'disabled');assert.equal(call.body.max_tokens,320);assert.equal(call.body.user,undefined);assert.equal(call.body.conversation_id,undefined);assert(!JSON.stringify(call.body).includes('never-send'));}
  assert.equal(JSON.parse(h.calls[1].body.messages[1].content).state.stateVersion,'test-state-B');
  await assert.rejects(h.call(envelope('campus-admin-v2')),{code:'invalid_envelope'});
});

test('中文SSE跨字节、CRLF和reasoning内容正确处理，仅展示最终content',async t=>{
  const h=await fixture(t);let first=0;const reply=await h.call(envelope(),{onFirstChunk:()=>first++});assert.equal(reply.answer,'中文'+answer);assert(!JSON.stringify(reply).includes('private-reasoning'));assert.equal(reply.conversationId,'');assert.equal(reply.provider,'deepseek');assert(first>0);
});

test('截断、空回答、非法JSON、超长、HTML和非正常结束全部拒绝',async t=>{
  const h=await fixture(t);
  for(const [behavior,code]of [['truncated','incomplete_reply'],['stream-length','incomplete_reply'],['length','incomplete_reply'],['empty','empty_reply'],['bad-json','invalid_reply'],['invalid-stream','invalid_stream'],['oversized','reply_too_large'],['html','unexpected_content']]){h.set(behavior);await assert.rejects(h.call(),{code});}
});

test('401、余额不足、限流、跳转与服务错误不回显密钥；成功回答也脱敏',async t=>{
  const h=await fixture(t);
  for(const status of ['401','402','429','500','redirect']){h.set(status);await assert.rejects(h.call(),error=>error.code.startsWith('deepseek_http_')&&!error.message.includes(key));}
  h.set('echo-key');assert.equal((await h.call()).answer,'[已隐藏密钥]');
});

test('无响应与流式挂起有截止时间，主动取消中断HTTP传输',async t=>{
  const h=await fixture(t);h.config.timeoutMs=70;
  for(const behavior of ['hang','stream-hang']){h.set(behavior);const at=performance.now();await assert.rejects(h.call(),{code:'deepseek_timeout'});assert(performance.now()-at<1000);}
  h.config.timeoutMs=1000;h.set('stream-hang');const controller=new AbortController(),pending=h.call(envelope(),{signal:controller.signal});await delay(25);controller.abort();await assert.rejects(pending,{code:'request_cancelled'});
});

test('连通检查仅请求模型列表，不发起付费聊天；429接入既有冷却机制',async t=>{
  const h=await fixture(t);assert.equal((await checkDeepSeek(h.config)).connected,true);assert.equal(h.calls.length,1);assert.equal(h.calls[0].path,'/models');assert.equal(h.calls[0].body,null);
  h.config.model='unknown-test-model';await assert.rejects(checkDeepSeek(h.config),{code:'invalid_model'});
  const scheduler=new AiScheduler();scheduler.recordFailure('deepseek_http_429');await assert.rejects(scheduler.acquire(),{code:'ai_cooldown'});scheduler.close();
});
