import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {createLabServer} from '../server.mjs';

async function listen(server) {server.listen(0,'127.0.0.1');await once(server,'listening');return 'http://127.0.0.1:'+server.address().port;}
async function close(server) {const stopped=once(server,'close');server.close();server.closeAllConnections();await stopped;}
async function harness(t) {
  const calls=[];
  let behavior='normal';
  const upstream=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=raw?JSON.parse(raw):null;
    calls.push({path:req.url,auth:req.headers.authorization,body});
    if(behavior==='unauthorized'){res.writeHead(401,{'Content-Type':'application/json'});res.end('{"message":"secret-test-key"}');return;}
    if(behavior==='redirect'){res.writeHead(302,{Location:'https://example.invalid/login'});res.end();return;}
    if(req.url==='/v1/parameters'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({user_input_form:[]}));return;}
    const envelope=JSON.parse(body.query);
    const answer=envelope.state.stateVersion+'：'+envelope.state.routes.map(r=>r.name+r.travelTimeSeconds+'模拟秒').join('，')+(behavior==='echo-key'?' secret-test-key':'');
    if(behavior==='html'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<html>login</html>');return;}
    if(behavior==='json'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({answer,conversation_id:'conversation-1'}));return;}
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    const events=[{event:'workflow_started'}, {event:'message',answer:answer.slice(0,12),conversation_id:'conversation-1',message_id:'message-1'}, {event:'message',answer:answer.slice(12)}];
    if(behavior!=='truncated')events.push({event:'message_end',conversation_id:'conversation-1',message_id:'message-1'});
    const data=Buffer.from(events.map(e=>'data: '+JSON.stringify(e)+'\r\n\r\n').join(''));
    for(let offset=0;offset<data.length;offset+=7)res.write(data.subarray(offset,offset+7));
    res.end();
  });
  const upstreamBase=await listen(upstream);
  let config={apiBase:upstreamBase+'/v1',apiKey:'secret-test-key',allowLoopback:true,timeoutMs:3000};
  const lab=createLabServer(async()=>config),base=await listen(lab);
  t.after(async()=>{await close(lab);await close(upstream);});
  const post=async(body,path='/api/chat',headers={})=>{
    const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  return {base,calls,post,setBehavior:value=>behavior=value,setConfig:value=>config=value};
}
const message=(fixtureId,sessionId='session-alpha')=>({fixtureId,sessionId,question:'现在主路和环岛怎么选？'});

test('同一会话每轮传新状态但不累积 Dify 历史，中文流式分片完整',async t=>{
  const h=await harness(t),a=await h.post(message('A')),b=await h.post(message('B'));
  assert.equal(a.status,200);assert.equal(b.status,200);
  assert.match(a.data.answer,/fixture-A.*主路300模拟秒.*环岛180模拟秒/);
  assert.match(b.data.answer,/fixture-B.*主路160模拟秒.*环岛260模拟秒/);
  assert.equal(h.calls[0].auth,'Bearer secret-test-key');
  assert.equal(h.calls[0].body.response_mode,'streaming');
  assert.equal(h.calls[0].body.conversation_id,undefined);
  assert.equal(h.calls[1].body.conversation_id,undefined);
  assert.equal(h.calls[0].body.user,h.calls[1].body.user);
  assert.equal(JSON.parse(h.calls[1].body.query).state.stateVersion,'fixture-B');
  assert.equal(b.data.provider,'school-dify');
});
test('不同浏览器会话拥有不同 user，不能串用 conversation_id',async t=>{
  const h=await harness(t);await h.post(message('A'));await h.post(message('B','session-bravo'));
  assert.notEqual(h.calls[0].body.user,h.calls[1].body.user);
  assert.equal(h.calls[1].body.conversation_id,undefined);
});
test('未配置密钥时明确失败，不返回模拟回答',async t=>{
  const h=await harness(t);h.setConfig({apiBase:'https://dify.zju.edu.cn/v1',apiKey:''});
  const reply=await h.post(message('A'));assert.equal(reply.status,503);assert.equal(reply.data.error,'not_configured');assert.equal(h.calls.length,0);
});
test('未知状态、无效问题和跨站请求均在调用 Dify 前被拒绝',async t=>{
  const h=await harness(t);
  assert.equal((await h.post(message('missing'))).status,422);
  assert.equal((await h.post({...message('A'),question:''})).status,400);
  assert.equal((await h.post(message('A'),'/api/chat',{Origin:'https://example.invalid'})).status,403);
  assert.equal(h.calls.length,0);
});
test('状态接口和静态资源不暴露私有密钥或配置',async t=>{
  const h=await harness(t);
  for(const path of ['/api/status','/','.env.local','/.env.local','/server.mjs','/configure.ps1']){
    const res=await fetch(h.base+(path.startsWith('/')?path:'/'+path)),text=await res.text();
    assert.equal(text.includes('secret-test-key'),false);
    if(!['/api/status','/'].includes(path))assert.equal(res.status,404);
  }
  h.setBehavior('echo-key');const reply=await h.post(message('A'));assert.equal(reply.status,200);assert.equal(JSON.stringify(reply.data).includes('secret-test-key'),false);
});
test('Dify 密钥失败、登录跳转和 HTML 响应明确报错',async t=>{
  const h=await harness(t);
  for(const [behavior,code] of [['unauthorized','dify_http_401'],['redirect','dify_redirect'],['html','unexpected_content']]){
    h.setBehavior(behavior);const reply=await h.post(message('A'));
    assert.equal(reply.status,502);assert.equal(reply.data.error,code);assert.equal(JSON.stringify(reply.data).includes('secret-test-key'),false);
  }
});
test('流式回答未完成时不显示成功',async t=>{
  const h=await harness(t);h.setBehavior('truncated');const reply=await h.post(message('A'));assert.equal(reply.status,502);assert.equal(reply.data.error,'incomplete_reply');
});
test('兼容 JSON 回答，且参数检查不触发模型调用',async t=>{
  const h=await harness(t);const check=await h.post({},'/api/check');assert.equal(check.data.connected,true);assert.equal(h.calls[0].path,'/v1/parameters');
  h.setBehavior('json');const reply=await h.post(message('A'));assert.equal(reply.status,200);assert.match(reply.data.answer,/fixture-A/);
});
test('缺少未来推演时后端拒绝把当前数字当作预测，明确标注本地检查',async t=>{
  const h=await harness(t);
  for(const question of ['十分钟后从1到2预计多久？','过10分钟出发好吗？','明天出发走哪条路？']){
    const reply=await h.post({...message('A'),question});
    assert.equal(reply.status,200);assert.equal(reply.data.provider,'local-validation');
    assert.equal(reply.data.reason,'forecast_unavailable');assert.match(reply.data.answer,/暂无未来时段推演数据/);
    assert.equal(reply.data.answer.includes('300'),false);
  }
  assert.equal(h.calls.length,0);
});
