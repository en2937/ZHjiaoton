const $=id=>document.getElementById(id);
let mode='electric',preference='time',busy=false,lastReply=null,liveReading=false;
const newSessionId=()=>typeof crypto.randomUUID==='function'?crypto.randomUUID():[...crypto.getRandomValues(new Uint8Array(16))].map(value=>value.toString(16).padStart(2,'0')).join('');
let sessionId=newSessionId();
const notices={query:null,service:null,traffic:null,update:null};
const icons=name=>{const s=document.createElementNS('http://www.w3.org/2000/svg','svg'),u=document.createElementNS('http://www.w3.org/2000/svg','use');u.setAttribute('href','#'+name);s.append(u);s.setAttribute('aria-hidden','true');return s;};
const element=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
function timeMetric(seconds){return {value:'约'+(seconds/60).toFixed(1),unit:'分钟'};}
function timeDifference(seconds){const rounded=Math.round(seconds),m=Math.floor(rounded/60),s=rounded%60;return m?(m+'分钟'+(s?s+'秒':'')):s+'秒';}
function distanceMetric(meters){return meters>=1000?{value:'约'+(meters/1000).toFixed(2).replace(/0$/,''),unit:'公里'}:{value:'约'+String(meters),unit:'米'};}
function trip(){return {origin:$('origin').value,destination:$('destination').value,mode};}
function setStatus(message,error=false,key='query'){
  notices[key]=message?{message,error}:null;
  const notice=notices.query||notices.service||notices.traffic||notices.update;
  $('status').textContent=notice?.message||'';$('status').hidden=!notice;$('status').classList.toggle('error',Boolean(notice?.error));
}
function publicError(code){
  const messages={bad_question:'请输入 1–1000 字的问题。',bad_session:'请刷新页面后重试。',bad_trip:'请先选择行程和出行方式。',unknown_trip:'这个行程暂时没有路线数据。',session_busy:'上一条问题还在处理中，请稍等。',session_limit:'服务繁忙，请稍后再试。',sandbox_unavailable:'交通数据暂不可用，请稍后重试。',dify_http_429:'服务繁忙，请稍后再试。',dify_timeout:'回答超时，请重新发送。',invalid_student_reply:'暂时未能生成路线建议，请重试。'};
  return messages[code]||'出行服务暂不可用，请稍后重试。';
}
function setBusy(value){busy=value;document.querySelectorAll('button,select,textarea').forEach(e=>e.disabled=value||e.dataset.available==='false');$('question-form').setAttribute('aria-busy',String(value));}
function scrollConversation(){const node=$('conversation');node.scrollTop=node.scrollHeight;}
function reset(){sessionId=newSessionId();lastReply=null;$('conversation').replaceChildren(welcomeTemplate.cloneNode(true));$('question').value='';$('question').style.height='';bindSuggestions();setStatus('',false,'update');setStatus('');}
const welcomeTemplate=$('welcome').cloneNode(true);
function bindSuggestions(){document.querySelectorAll('[data-question]').forEach(b=>b.onclick=()=>ask(b.dataset.question));}
function metric(label,icon,formatted){const div=element('div'),caption=element('div','metric-label');caption.append(icons(icon),element('span','',label));const value=element('div','metric-value'+(formatted.value.length>4?' long':''),formatted.value);if(formatted.unit)value.append(element('span','metric-unit',formatted.unit));div.append(caption,value);return div;}
function renderReply(data,chosenTrip){
  const article=element('article','assistant-message'),byline=element('div','reply-byline');
  const placeName=id=>[...$('origin').options].find(p=>p.value===id)?.textContent||id;
  byline.append(icons('spark'),element('span','',data.provider==='school-dify'?'AI 出行建议':'行程提示'),element('span','trip-context',placeName(chosenTrip.origin)+' → '+placeName(chosenTrip.destination)+' · '+({electric:'电动车',bicycle:'自行车'}[chosenTrip.mode])));
  article.append(byline,element('p','recommendation',data.message));
  if(data.status==='ok'){
    const cards=element('div','route-cards');
    for(const route of data.routes){const card=element('section','route-card'+(route.id===data.recommendedRouteId?' recommended':'')),heading=element('div','route-title'),badges=element('div','route-badges');heading.append(element('h4','',route.name));
      if(route.id===data.comparison.fastestRouteId)badges.append(element('span','badge','更快'));
      if(route.id===data.comparison.shortestRouteId)badges.append(element('span','badge distance','更近'));
      heading.append(badges);const metrics=element('div','route-metrics');metrics.append(metric('预计用时','clock',timeMetric(route.travelTimeSeconds)),metric('估算距离','route',distanceMetric(route.distanceMeters)));card.append(heading,metrics);cards.append(card);
    }
    article.append(cards);const highlights=element('div','comparison-highlights'),fastest=data.routes.find(r=>r.id===data.comparison.fastestRouteId),shortest=data.routes.find(r=>r.id===data.comparison.shortestRouteId);
    const t=element('span'),d=element('span');t.append(document.createTextNode(fastest.name+' '),element('b','',data.comparison.timeDifferenceSeconds?'比最慢线路快 '+timeDifference(data.comparison.timeDifferenceSeconds):'时间相同'));d.append(document.createTextNode(shortest.name+' '),element('b','',data.comparison.distanceDifferenceMeters?'比最远线路短约 '+data.comparison.distanceDifferenceMeters+' 米':'距离相同'));highlights.append(t,d);article.append(highlights);
    if(data.departureScenario?.mode!=='fixed')article.append(element('p','result-time',data.clock?'沙盘时刻 '+data.clock.label:'查询于 '+new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false})));
  }
  return article;
}
async function ask(value){
  const question=String(value||'').trim();if(busy)return;if(!question){setStatus('写下你想问的问题。');$('question').focus();return;}
  const chosenTrip=trip();$('welcome')?.remove();const user=element('div','user-message');user.append(element('p','',question));$('conversation').append(user);
  const pending=element('div','pending');pending.setAttribute('aria-label','AI 正在比较路线');for(let i=0;i<3;i++)pending.append(element('i'));$('conversation').append(pending);scrollConversation();setBusy(true);setStatus('正在比较路线…');$('question').value='';$('question').style.height='';
  try {
    const response=await fetch('/api/student/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question,trip:chosenTrip,preference,sessionId})});
    const data=await response.json();if(!response.ok)throw Object.assign(new Error(),{publicMessage:publicError(data.error)});
    lastReply=data;pending.replaceWith(renderReply(data,chosenTrip));setStatus('',false,'update');setStatus('',false,'service');setStatus('');
  }catch(e){const message=e.publicMessage||'暂时无法获取建议，请重新发送。';pending.replaceWith(element('p','error-message',message));$('question').value=question;setStatus(message,true);}
  finally{setBusy(false);scrollConversation();void refreshLive();}
}

document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{mode=b.dataset.mode;document.querySelectorAll('[data-mode]').forEach(e=>e.setAttribute('aria-pressed',String(e===b)));void refreshLive();});
document.querySelectorAll('[data-preference]').forEach(b=>b.onclick=()=>{preference=b.dataset.preference;document.querySelectorAll('[data-preference]').forEach(e=>e.setAttribute('aria-pressed',String(e===b)));});
$('swap-places').onclick=()=>{const from=$('origin').value;$('origin').value=$('destination').value;$('destination').value=from;setStatus('');void refreshLive();};
$('origin').onchange=$('destination').onchange=()=>void refreshLive();
$('reset-chat').onclick=reset;
$('question-form').onsubmit=e=>{e.preventDefault();ask($('question').value);};
$('question').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();ask($('question').value);}};
$('question').oninput=()=>{$('question').style.height='auto';$('question').style.height=Math.min(100,$('question').scrollHeight)+'px';};
bindSuggestions();
async function refreshLive(){
 if(liveReading)return;liveReading=true;const chosen=trip();
 try{const response=await fetch('/api/student/state?'+new URLSearchParams(chosen),{signal:AbortSignal.timeout(6000)});const data=await response.json();if(!response.ok)throw new Error();
  if(JSON.stringify(chosen)!==JSON.stringify(trip()))return;
  $('studentSimulationClock').textContent=data.clock?'沙盘 '+data.clock.label+(data.clock.classTime?' · 上课 '+data.clock.classTime:''):'';
  $('studentSimulationClock').hidden=data.departureScenario?.mode!=='survey';
  document.querySelectorAll('.result-time').forEach(node=>node.hidden=data.departureScenario?.mode==='fixed');
  $('studentDataSourceNote').textContent=data.departureScenario?.mode==='survey'?'问卷分布用于骑行模拟，用时与距离为估算。':'基于模拟数据，用时与距离为估算。';
  setStatus('',false,'traffic');
  const changed=lastReply&&(lastReply.runId!==data.runId||JSON.stringify(lastReply.settings)!==JSON.stringify(data.settings));
  setStatus(changed?'交通方案已更新，请重新查询。':'',false,'update');
 }catch{setStatus('交通数据暂不可用，正在重试…',true,'traffic');}
 finally{liveReading=false;}
}
try{const r=await fetch('/api/student/options');if(!r.ok)throw new Error();const options=await r.json();
 for(const id of ['origin','destination'])for(const p of options.places){const option=[...$(id).options].find(o=>o.value===p.id);if(option)option.textContent=p.name;}
 for(const entry of options.modes){const button=document.querySelector('[data-mode="'+entry.id+'"]');if(button){button.dataset.available=String(entry.available!==false);button.disabled=entry.available===false;}}
 if(!options.configured)setStatus('出行服务暂不可用，请稍后重试。',true,'service');
}catch{setStatus('出行服务暂不可用，请稍后重试。',true,'service');}
await refreshLive();setInterval(refreshLive,3000);
