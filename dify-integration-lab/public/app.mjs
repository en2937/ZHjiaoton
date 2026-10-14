const $ = id => document.getElementById(id);
let fixtureId = 'A', state, busy = false;
let sessionId = sessionStorage.getItem('trafficDifyLabSession') || crypto.randomUUID();
sessionStorage.setItem('trafficDifyLabSession', sessionId);
async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || '请求失败');
  return data;
}
async function loadState(id) {
  state = await api('/api/fixtures/' + id); fixtureId = id;
  for (const name of ['A','B']) $('fixture' + name).setAttribute('aria-pressed', String(id === name));
  $('version').textContent = state.stateVersion + ' · 1 → 2 · 电动车';
  $('metrics').replaceChildren();
  for (const [label, value] of [...state.routes.map(route => [route.name, route.travelTimeSeconds + ' 模拟秒']), ['路口等待', state.metrics.queued + ' 辆'], ['分流设定', state.settings.branchShare + '%']]) {
    const row=document.createElement('div');row.className='metric';const text=document.createElement('span'),v=document.createElement('strong');text.textContent=label;v.textContent=value;row.append(text,v);$('metrics').append(row);
  }
  $('state').textContent = JSON.stringify(state, null, 2);
}
async function status() {
  try {const data=await api('/api/status');$('connection').textContent=data.configured?'后端密钥已配置 · 尚需验证实际调用':'后端已启动 · 等待配置 Dify 密钥';$('apiAddress').textContent=data.apiBase;}
  catch(e){$('connection').textContent=e.message;}
}
$('fixtureA').onclick=()=>loadState('A').catch(e=>$('resultStatus').textContent=e.message);
$('fixtureB').onclick=()=>loadState('B').catch(e=>$('resultStatus').textContent=e.message);
$('check').onclick=async()=>{try{$('check').disabled=true;const data=await api('/api/check',{});$('connection').textContent='学校 Dify API 已连接';const required=data.requiredInputs.filter(item=>item.required);$('resultStatus').textContent=required.length?'此应用有必填变量：'+required.map(item=>item.variable).join('、'):'应用无必填输入变量，可发送状态测试。';}catch(e){$('resultStatus').textContent=e.message;}finally{$('check').disabled=false;}};
$('newSession').onclick=()=>{sessionId=crypto.randomUUID();sessionStorage.setItem('trafficDifyLabSession',sessionId);$('answers').replaceChildren();$('resultStatus').textContent='已建立新会话。';};
$('chat').onsubmit=async event=>{
  event.preventDefault();if(busy)return;
  const question=$('question').value.trim(),sentFixture=fixtureId;
  if(!question){$('resultStatus').textContent='请先输入问题。';return;}
  busy=true;for(const id of ['send','newSession','fixtureA','fixtureB'])$(id).disabled=true;
  $('resultStatus').textContent='后端正在调用学校 Dify，请稍候…';
  try {
    const data=await api('/api/chat',{question,fixtureId:sentFixture,sessionId});
    const reply=document.createElement('article');reply.className='reply';const tag=document.createElement('div'),text=document.createElement('div');tag.className='tag';text.className='text';tag.textContent=data.stateVersion+' · '+(data.provider==='school-dify'?'学校 Dify':'后端数据检查')+' · '+(data.latencyMs/1000).toFixed(1)+' 秒';text.textContent=data.answer;reply.append(tag,text);$('answers').prepend(reply);
    $('resultStatus').textContent=data.provider==='school-dify'?'收到实际 Dify 回答，依据 '+data.stateVersion+'。可切换状态后继续提问。':'当前样例缺少未来推演数据，后端已明确提示。';
  }catch(e){$('resultStatus').textContent=e.message;}
  finally{busy=false;for(const id of ['send','newSession','fixtureA','fixtureB'])$(id).disabled=false;}
};
await Promise.all([status(),loadState('A')]);
