import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {createLabServer} from '../server.mjs';
import {studentState} from '../student.mjs';

async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return 'http://127.0.0.1:'+server.address().port;}
async function stop(server){const ended=once(server,'close');server.close();server.closeAllConnections();await ended;}
async function setup(t){
  const calls=[];let variant='normal';
  const upstream=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw),payload=JSON.parse(body.query);calls.push(body);
    const criterion=/更近|距离更短/.test(payload.question)?'distance':payload.preference;
    const field=criterion==='distance'?'distanceMeters':'travelTimeSeconds';
    const best=[...payload.state.routes].sort((a,b)=>a[field]-b[field])[0];
    const answer=variant==='missing'?{status:'missing_data'}:{status:'ok',criterion,recommended_route_id:variant==='wrong-route'?'unknown':best.id,travelTimeSeconds:99999,distanceMeters:99999};
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({answer:JSON.stringify(answer),conversation_id:'student-conversation'}));
  });
  const upstreamBase=await listen(upstream),lab=createLabServer(async()=>({apiBase:upstreamBase+'/v1',apiKey:'student-test-key',allowLoopback:true}),{studentProvider:async trip=>studentState(trip)}),base=await listen(lab);
  t.after(async()=>{await stop(lab);await stop(upstream);});
  const post=async body=>{const response=await fetch(base+'/api/student/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,data:await response.json()};};
  return {calls,base,post,setVariant:v=>variant=v};
}
const request=(changes={})=>({question:'哪条路更快？',trip:{origin:'1',destination:'2',mode:'electric'},preference:'time',sessionId:'student-session',...changes});

test('时间距离由本轮数据提供，AI 无法改写卡片数字',async t=>{
  const h=await setup(t),reply=await h.post(request());
  assert.equal(reply.status,200);assert.equal(reply.data.recommendedRouteId,'roundabout');
  assert.deepEqual(reply.data.routes.map(r=>[r.travelTimeSeconds,r.distanceMeters]),[[300,850],[180,1100]]);
  assert.equal(reply.data.comparison.timeDifferenceSeconds,120);assert.equal(reply.data.comparison.distanceDifferenceMeters,250);
  assert.equal(JSON.stringify(reply.data).includes('99999'),false);assert.match(reply.data.sourceLabel,/演示数据/);
});
test('自然语言距离偏好可以覆盖默认省时偏好，同一会话每轮更新状态',async t=>{
  const h=await setup(t);await h.post(request());
  const short=await h.post(request({question:'哪条路更近？'}));assert.equal(short.data.criterion,'distance');assert.equal(short.data.recommendedRouteId,'main');
  const b=await h.post(request({fixtureId:'B'}));assert.equal(b.data.recommendedRouteId,'main');assert.equal(b.data.routes[0].travelTimeSeconds,160);
  assert.equal(h.calls[1].conversation_id,'student-conversation');assert.equal(h.calls[1].user,h.calls[0].user);
  assert.equal(JSON.parse(h.calls[2].query).state.stateVersion,'student-fixture-B-1-2-electric');
});
test('未来数据、同地点和未知行程不触发 Dify 调用',async t=>{
  const h=await setup(t);
  const future=await h.post(request({question:'十分钟后出发多久到？'}));assert.equal(future.data.status,'missing_data');assert.equal(future.data.provider,'local-validation');
  const same=await h.post(request({trip:{origin:'1',destination:'1',mode:'electric'}}));assert.equal(same.data.status,'same_place');assert.deepEqual(same.data.routes,[]);
  assert.equal((await h.post(request({trip:{origin:'1',destination:'9',mode:'electric'}}))).status,422);
  assert.equal(h.calls.length,0);
});
test('不能展示不在当前状态中的 AI 路线建议，缺数据回答不带路线卡',async t=>{
  const h=await setup(t);h.setVariant('wrong-route');const bad=await h.post(request());assert.equal(bad.status,502);assert.equal(bad.data.error,'invalid_student_reply');
  h.setVariant('missing');const missing=await h.post(request({question:'去地点9怎么走？'}));assert.equal(missing.data.status,'missing_data');assert.deepEqual(missing.data.routes,[]);
});
test('师生页面资源可访问，私有密钥和后端源码不可下载',async t=>{
  const h=await setup(t);
  for(const path of ['/student/','/student/app.mjs','/student/style.css','/student/emblem.png']){const res=await fetch(h.base+path);assert.equal(res.status,200);assert.equal((await res.text()).includes('student-test-key'),false);}
  for(const path of ['/student/.env.local','/student.mjs'])assert.equal((await fetch(h.base+path)).status,404);
});
