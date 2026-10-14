const $=id=>document.getElementById(id),panel=$('adminAssistant'),log=$('adminAiLog'),question=$('adminAiQuestion');
function identifier(){if(globalThis.crypto?.randomUUID)return crypto.randomUUID();const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');}
const chatId=identifier();let busy=false,configured=false,composing=false,lastState=null,timer=null,proposalButtons=[],statusBusy=false,statusEpoch=0,statusError=false;
const parameterLabels={demand:'骑行车流',motorDemand:'机动车流',northDemand:'北侧来车',electric:'电动车占比',outbound:'地点1来车占比',northBypassShare:'北侧绕行策略',guidanceCoverage:'引导覆盖',westSignalMode:'A 路口配时',adaptive:'自动调控',fixed:'固定配时'};
const readableReply=text=>text.replace(/\b(demand|motorDemand|northDemand|electric|outbound|northBypassShare|guidanceCoverage|westSignalMode|adaptive|fixed)\b/g,key=>parameterLabels[key]);
function setupPanelMovement(){
 const header=panel.querySelector('.ai-heading'),toolbar=panel.querySelector('.ai-toolbar');
 const storageKey='traffic-admin-assistant-position';let position=null,drag=null,frame=0,pending=null;
 try{const saved=JSON.parse(sessionStorage.getItem(storageKey));if(saved&&Number.isFinite(saved.x)&&Number.isFinite(saved.y))position=saved;}catch{}
 header.tabIndex=0;header.title='拖动标题栏移动窗口，方向键微调，Home 归位';
 header.setAttribute('aria-label','交通助手窗口标题栏，方向键移动，Home归位');
 const toggle=document.createElement('button');toggle.type='button';toggle.textContent='窗口位置';toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-controls','adminAiPosition');toolbar.append(toggle);
 const options=document.createElement('div');options.id='adminAiPosition';options.className='ai-position-options';options.hidden=true;options.setAttribute('role','group');options.setAttribute('aria-label','移动交通助手窗口');toolbar.after(options);
 function bounds(){const rect=panel.getBoundingClientRect(),width=document.documentElement.clientWidth,height=innerHeight;return {minX:12,minY:12,maxX:Math.max(12,width-rect.width-12),maxY:Math.max(12,height-rect.height-12)};}
 function paint(x,y,limits=bounds()){
  position={x:Math.max(limits.minX,Math.min(limits.maxX,x)),y:Math.max(limits.minY,Math.min(limits.maxY,y))};
  panel.classList.add('is-positioned');panel.style.left=position.x+'px';panel.style.top=position.y+'px';
 }
 function save(){try{if(position)sessionStorage.setItem(storageKey,JSON.stringify(position));else sessionStorage.removeItem(storageKey);}catch{}}
 function fit(){if(!panel.hidden&&position){paint(position.x,position.y);save();}}
 function finish(){if(!drag)return;if(frame){cancelAnimationFrame(frame);frame=0;}if(pending){paint(pending.x,pending.y,drag.limits);pending=null;}drag=null;panel.classList.remove('is-dragging');save();}
 function reset(){finish();position=null;panel.classList.remove('is-positioned');panel.style.removeProperty('left');panel.style.removeProperty('top');save();}
 function move(dx,dy){const rect=panel.getBoundingClientRect();paint(rect.left+dx,rect.top+dy);save();}
 for(const [label,dx,dy]of [['左移',-32,0],['上移',0,-32],['下移',0,32],['右移',32,0],['归位',0,0]]){
  const button=document.createElement('button');button.type='button';button.textContent=label;button.onclick=()=>label==='归位'?reset():move(dx,dy);options.append(button);
 }
 toggle.onclick=()=>{options.hidden=!options.hidden;toggle.setAttribute('aria-expanded',String(!options.hidden));};
 header.addEventListener('pointerdown',event=>{
  if(!event.isPrimary||event.button!==0||event.target.closest('button,a,input,textarea,select'))return;
  const rect=panel.getBoundingClientRect();drag={id:event.pointerId,x:event.clientX,y:event.clientY,left:rect.left,top:rect.top,limits:bounds()};
  header.setPointerCapture(event.pointerId);header.focus({preventScroll:true});event.preventDefault();
 });
 header.addEventListener('pointermove',event=>{
  if(!drag||event.pointerId!==drag.id)return;const dx=event.clientX-drag.x,dy=event.clientY-drag.y;
  if(!panel.classList.contains('is-dragging')&&Math.hypot(dx,dy)<3)return;
  panel.classList.add('is-dragging');pending={x:drag.left+dx,y:drag.top+dy};
  if(!frame)frame=requestAnimationFrame(()=>{frame=0;if(drag&&pending){paint(pending.x,pending.y,drag.limits);pending=null;}});
 });
 const release=event=>{if(!drag||event.pointerId!==drag.id)return;finish();if(header.hasPointerCapture(event.pointerId))header.releasePointerCapture(event.pointerId);};
 header.addEventListener('pointerup',release);header.addEventListener('pointercancel',release);header.addEventListener('lostpointercapture',finish);
 header.addEventListener('keydown',event=>{
  if(event.target!==header)return;const delta=event.shiftKey?48:16,directions={ArrowLeft:[-delta,0],ArrowRight:[delta,0],ArrowUp:[0,-delta],ArrowDown:[0,delta]};
  if(directions[event.key]){event.preventDefault();move(...directions[event.key]);}else if(event.key==='Home'){event.preventDefault();reset();}
 });
 addEventListener('resize',()=>{finish();fit();});
 return {fit,finish};
}
const movement=setupPanelMovement();
function error(message=''){const e=$('adminAiError');e.textContent=message;e.hidden=!message;}
function controls(){
 $('adminAiSend').disabled=busy||!configured;question.disabled=busy;
 $('adminAiClear').disabled=busy;$('adminAiUndo').disabled=busy||!lastState?.canUndo;
 document.querySelectorAll('[data-ai-question]').forEach(button=>button.disabled=busy||!configured);
 for(const button of proposalButtons)button.disabled=busy||!lastState?.proposal;
 $('adminAiForm').setAttribute('aria-busy',String(busy));$('adminAiSend').textContent=busy?'处理中…':'发送';
}
async function json(response){let data;try{data=await response.json();}catch{throw new Error('未能读取完整结果，请查看当前参数后重试。');}if(response.status===401){location.assign('/login');throw new Error('登录已过期，请重新登录。');}if(!response.ok)throw new Error(data.message||'暂时无法完成操作，请稍后重试。');return data;}
function message(text,{user=false,pending=false}={}){
 const article=document.createElement('article');article.className='ai-message'+(user?' is-user':'')+(pending?' is-pending':'');
 const label=document.createElement('span');label.className='ai-message-label';label.textContent=user?'管理员':'交通助手';
 const body=document.createElement('div');body.className='ai-message-body';body.textContent=text;article.append(label,body);log.append(article);
 while(log.querySelectorAll('article').length>30)log.querySelector('article').remove();log.scrollTop=log.scrollHeight;return {article,body};
}
function showChanges(body,changes){if(!changes?.length)return;const list=document.createElement('div');list.className='ai-change-list';for(const row of changes){const line=document.createElement('div');line.textContent=row.label+'：'+row.beforeText+' → '+row.afterText;list.append(line);}body.append(list);}
function invalidateButtons(){for(const b of proposalButtons)b.disabled=true;proposalButtons=[];}
async function status(){
 if(statusBusy||busy)return;statusBusy=true;const epoch=statusEpoch;
 try{const data=await json(await fetch('/api/admin/ai/status?chatId='+encodeURIComponent(chatId),{signal:AbortSignal.timeout(6000)}));
  if(epoch!==statusEpoch)return;if(statusError){error();statusError=false;}
  if(lastState&&(data.runId!==lastState.runId||data.settingsRevision!==lastState.settingsRevision)&&!busy){invalidateButtons();if(log.querySelector('article'))error('参数或场景已更新，可重新询问当前状态。');}
  lastState=data;configured=data.configured;if(!configured)error('交通助手暂未连接，请稍后刷新。');controls();
 }catch(e){if(epoch!==statusEpoch)return;configured=false;statusError=true;error(e.message||'暂时无法连接交通助手，请稍后重试。');controls();}
 finally{statusBusy=false;}
}
async function send(action='chat',text=question.value.trim()){
 if(busy||action==='chat'&&!text)return;
 if(action==='chat'&&text.length>1000){error('问题不能超过1000字。');question.focus();return;}
 const captions={apply:'执行刚才的优化方案。',undo:'撤回上次调整。',clear:'新对话',cancel:'取消当前方案。'};
 busy=true;statusEpoch++;error();controls();
 if(action!=='clear')message(action==='chat'?text:captions[action],{user:true});
 const pending=message('正在读取当前状态…',{pending:true});
 try{
  const session=await json(await fetch('/api/admin/session',{signal:AbortSignal.timeout(4000)}));pending.body.textContent=action==='chat'?'正在分析当前状态…':'正在处理…';
  const data=await json(await fetch('/api/admin/ai/chat',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:JSON.stringify({action,question:action==='chat'?text:'',chatId,requestId:identifier()}),signal:AbortSignal.timeout(55000)}));
  pending.article.classList.remove('is-pending');pending.body.textContent=readableReply(data.message);
  invalidateButtons();lastState={...(lastState||{}),runId:data.runId,settingsRevision:data.settingsRevision,proposal:data.proposal,canUndo:data.canUndo};
  if(action==='clear'){log.replaceChildren();message(data.message);}
  else{
   if(data.changes?.length)showChanges(pending.body,data.changes);
   if(data.proposal?.changes?.length){showChanges(pending.body,data.proposal.changes);const actions=document.createElement('div');actions.className='ai-proposal-actions';for(const [label,kind]of [['执行方案','apply'],['取消方案','cancel']]){const button=document.createElement('button');button.type='button';button.textContent=label;button.onclick=()=>send(kind);actions.append(button);proposalButtons.push(button);}pending.body.append(actions);}
   const time=document.createElement('span');time.className='ai-snapshot';time.textContent=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(data.queryTime));pending.article.append(time);
  }
  if(action==='chat')question.value='';log.scrollTop=log.scrollHeight;
 }catch(e){pending.article.remove();error(e.message||'未能取得执行结果，请查看当前参数后重试。');}
 finally{busy=false;controls();question.focus();void status();}
}
function open(){panel.hidden=false;movement.fit();$('adminAiOpen').setAttribute('aria-expanded','true');void status();clearInterval(timer);timer=setInterval(status,3000);question.focus();}
function close(){movement.finish();panel.hidden=true;$('adminAiOpen').setAttribute('aria-expanded','false');clearInterval(timer);timer=null;$('adminAiOpen').focus();}
$('adminAiOpen').onclick=()=>panel.hidden?open():close();$('adminAiClose').onclick=close;
$('adminAiForm').onsubmit=e=>{e.preventDefault();void send();};$('adminAiUndo').onclick=()=>send('undo');$('adminAiClear').onclick=()=>send('clear');
question.addEventListener('compositionstart',()=>composing=true);question.addEventListener('compositionend',()=>composing=false);
question.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&!composing){e.preventDefault();void send();}});
panel.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();close();}});
document.querySelectorAll('[data-ai-question]').forEach(button=>button.onclick=()=>send('chat',button.dataset.aiQuestion));
controls();
