import {MAP,LABELS,EXITS,APPROACHES} from './route.mjs';
import {Simulation,ROAD_WIDTH,junctions,vehiclePosition,lanePosition,roadGeometry,laneKey,approachControlDirection,formatSimulationClock,classSeconds,curvePath} from './engine.mjs';
import {createSharedClient,createVehicleInterpolator} from './shared-client.mjs';
const $=id=>document.getElementById(id);
const canvas=$('map'),ctx=canvas.getContext('2d'),stage=$('mapStage');
let sim=new Simulation(),running=false,speed=4,selected=0;
const motionPreference=matchMedia('(prefers-reduced-motion: reduce)');
const vehicleMotion=createVehicleInterpolator({enabled:!motionPreference.matches});
let metrics=sim.metrics(),queueRibbons=[],animationFrame=0,departureDraftKey='',departureChartKey='',lastRunId=null;
const scenarioReadonly=Boolean($('departureMode').disabled);
let departureApplying=false,departureApplyTimer=0;
const PERIOD_CLASS_TIMES=['08:00','10:00','14:00'];
const shared=createSharedClient({onState:packet=>{
 lastRunId=packet.runId;
 sim=Object.assign(Object.create(Simulation.prototype),packet.simulation);running=packet.running;speed=packet.speed;
 vehicleMotion.accept(packet);metrics=sim.metrics();cacheQueues();
 for(const [id,key,valueId,suffix]of [['demand','demand','demandValue',' 辆/分钟'],['electricRatio','electric','electricValue','%'],['motorDemand','motorDemand','motorValue',' 辆/分钟'],['northDemand','northDemand','northValue',' 辆/分钟'],['northBypassShare','northBypassShare','northBypassValue','%'],['guidanceCoverage','guidanceCoverage','guidanceValue','%']]){
  if(document.activeElement!==$(id))$(id).value=sim.settings[key];$(valueId).textContent=sim.settings[key]+suffix;
 }
 document.querySelectorAll('[data-speed]').forEach(el=>{const active=Number(el.dataset.speed)===speed;el.classList.toggle('selected',active);el.setAttribute('aria-pressed',String(active));});
 if(document.activeElement!==$('behaviorMode'))$('behaviorMode').value=sim.settings.behaviorMode??'original';
 $('syncStatus').textContent='';$('syncStatus').hidden=true;updateUI();playUI();requestDraw();
},onError:()=>{vehicleMotion.reset();requestDraw();$('syncStatus').textContent='连接中断，正在重试…';$('syncStatus').hidden=false;$('playState').textContent='连接中断';}});
let w=0,h=0,dpr=1,view={scale:1,x:0,y:0},fitted=false;
const baseLayer=document.createElement('canvas'),labelLayer=document.createElement('canvas');
const baseContext=baseLayer.getContext('2d'),labelContext=labelLayer.getContext('2d');
let staticKey='';
const map=new Image();map.onload=()=>{staticKey='';$('mapError').hidden=true;requestDraw();};map.onerror=()=>{$('mapError').hidden=false;};map.src=MAP.image;
// Cache widened road geometry; animation only transforms it into screen coordinates.
const roadPaint=[];
for(const [edge,road]of Object.entries(roadGeometry)){
 const directions=road.roundabout||road.exit||edge==='access1'||edge==='accessNorth'?[1]:[1,-1];
 for(const direction of directions)for(const kind of road.motorEast?['electric','motor']:['electric']){
  let points=[],previous=null,mode=null;
  for(let i=0;i<=Math.ceil(road.length/8);i++){
   const p=Math.min(road.length,i*8),s=direction===1?p:road.length-p;
   const virtual=road.virtualFrom!==undefined&&s>=road.cumulative[road.virtualFrom];
   const position=lanePosition(edge,p,direction,kind),point=[position.x,position.y];
   if(mode!==null&&virtual!==mode){roadPaint.push({points,virtual:mode});points=[previous];}
   points.push(point);previous=point;mode=virtual;
  }
  roadPaint.push({points,virtual:mode});
 }
}
function fit(){view.scale=Math.min((w-40)/MAP.width,(h-110)/MAP.height);view.x=(w-MAP.width*view.scale)/2;view.y=55+(h-110-MAP.height*view.scale)/2;fitted=true;requestDraw();}
function resize(){const r=stage.getBoundingClientRect();w=r.width;h=r.height;dpr=Math.min(devicePixelRatio||1,2);const width=Math.round(w*dpr),height=Math.round(h*dpr);if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}fit();}
new ResizeObserver(resize).observe(stage);
window.addEventListener('resize',resize);
function worldToScreen(x,y){return {x:x*view.scale+view.x,y:y*view.scale+view.y};}
function line(points,color,width,dash=[],target=ctx){target.setLineDash(dash);target.beginPath();for(let i=0;i<points.length;i++){const p=worldToScreen(...points[i]);i?target.lineTo(p.x,p.y):target.moveTo(p.x,p.y);}target.strokeStyle=color;target.lineWidth=width;target.lineJoin='round';target.lineCap='round';target.stroke();target.setLineDash([]);}
function roundRect(x,y,width,height,radius,fill,target=ctx){target.fillStyle=fill;target.beginPath();target.roundRect(x,y,width,height,radius);target.fill();}
function textAt(text,x,y,size,color,weight=500,target=ctx){target.font=weight+' '+size+'px "Segoe UI","Microsoft YaHei",sans-serif';target.fillStyle=color;target.fillText(text,x,y);}
function trafficLight(approach){
 const direction=approachControlDirection(approach),control=sim.control(0,direction);
 const p=lanePosition(approach.edge,roadGeometry[approach.edge].length-24,approach.direction),s=worldToScreen(p.x,p.y),offset=Math.max(14,22*view.scale);
 const x=s.x+p.dy*offset,y=s.y-p.dx*offset;
 roundRect(x-17,y-7,34,14,4,'#15314b');
 for(const [i,color]of ['red','yellow','green'].entries()){
  ctx.beginPath();ctx.arc(x-11+i*11,y,3.6,0,Math.PI*2);
  ctx.fillStyle=control.color===color?{red:'#f15a54',yellow:'#f3c243',green:'#38cf8b'}[color]:'#435567';ctx.fill();
 }
 textAt(direction===1?'南向':'西向',x-34,y+3,8,'#234c73');
}
function paintStaticBackground(target){
 target.setTransform(dpr,0,0,dpr,0,0);target.fillStyle='#eaf2fb';target.fillRect(0,0,w,h);
 if(map.complete&&map.naturalWidth)target.drawImage(map,view.x,view.y,MAP.width*view.scale,MAP.height*view.scale);
 for(const road of roadPaint){
  if(road.virtual){line(road.points,'#7892b6a0',Math.max(1.1,2*view.scale),[5,5],target);continue;}
  line(road.points,'#bdccdcb0',Math.max(3,ROAD_WIDTH.slots*ROAD_WIDTH.slotSpacing*view.scale),[],target);
  line(road.points,'#f5f9fda0',Math.max(.5,.9*view.scale),[4,5],target);
 }
}
function paintStaticLabels(target){
 target.setTransform(dpr,0,0,dpr,0,0);target.clearRect(0,0,w,h);
 for(const exit of EXITS){
  const p=worldToScreen(exit.x,exit.y);if(p.x<0||p.y<0||p.x>w||p.y>h)continue;
  const lx=Math.min(w-70,Math.max(5,p.x-31)),ly=Math.min(h-24,Math.max(5,p.y-10));
  roundRect(lx,ly,65,20,5,'#f3f8ffeb',target);textAt(exit.name+' ↗',lx+7,ly+14,9,'#53708d',500,target);
 }
 for(const [i,l]of LABELS.entries()){
  const p=worldToScreen(l.x,l.y);target.beginPath();target.arc(p.x,p.y,10,0,Math.PI*2);target.fillStyle='#174f89';target.fill();target.strokeStyle='#f8fbff';target.lineWidth=2;target.stroke();
  target.textAlign='center';textAt(String(i+1),p.x,p.y+4,11,'#fff',650,target);target.textAlign='left';
  const lx=i===0?p.x+17:p.x-113,ly=p.y-31;roundRect(lx,ly,97,36,7,'#ffffffed',target);textAt(l.title,lx+9,ly+14,10,'#204b75',600,target);textAt(l.subtitle,lx+9,ly+28,9,'#68829d',500,target);
 }
}
function ensureStaticLayers(){
 const key=[canvas.width,canvas.height,dpr,w,h,view.scale,view.x,view.y,map.complete&&map.naturalWidth].join('|');
 if(key===staticKey)return;
 for(const layer of [baseLayer,labelLayer])if(layer.width!==canvas.width||layer.height!==canvas.height){layer.width=canvas.width;layer.height=canvas.height;}
 paintStaticBackground(baseContext);paintStaticLabels(labelContext);staticKey=key;
}
function cacheQueues(){
 const groups=new Map();queueRibbons=[];
 for(const car of sim.cars)if(car.queueJunction>=0){
  const key=laneKey(car)+':'+(car.kind==='motor'?'motor':'cycle');
  if(!groups.has(key))groups.set(key,[]);groups.get(key).push(car);
 }
 for(const waiting of groups.values()){
  const tail=Math.min(...waiting.map(c=>c.p)),head=Math.max(...waiting.map(c=>c.p)),ribbon=[];
  for(let p=tail;p<=head+1;p+=4){const position=vehiclePosition({...waiting[0],p});ribbon.push([position.x,position.y]);}
  if(ribbon.length>1)queueRibbons.push(ribbon);
 }
}
function draw(now=performance.now()){
 if(!fitted)return;
 ensureStaticLayers();ctx.setTransform(1,0,0,1,0,0);ctx.drawImage(baseLayer,0,0);ctx.setTransform(dpr,0,0,dpr,0,0);
 const m=metrics;
 for(const ribbon of queueRibbons)line(ribbon,'#e7a04450',Math.max(5,10*view.scale));
 junctions.forEach((j,i)=>{
   const p=worldToScreen(j.x,j.y),radius=Math.max(18,42*view.scale),q=m.queues[i].total;
   ctx.beginPath();ctx.arc(p.x,p.y,radius,0,Math.PI*2);ctx.fillStyle=q>4?'#e1904230':'#e6a55416';ctx.fill();ctx.strokeStyle=selected===i?'#cf8b50':'#d0a87c';ctx.lineWidth=selected===i?1.7:1;ctx.setLineDash([3,3]);ctx.stroke();ctx.setLineDash([]);
   const label=(i===0?'A 西侧路口':'B 东侧路口')+' · 等待 '+q+' 辆';
   ctx.font='10px "Microsoft YaHei",sans-serif';const width=ctx.measureText(label).width+18;
   const lx=Math.min(w-width-10,Math.max(10,p.x-width/2)),ly=p.y-radius-28;
   roundRect(lx,ly,width,22,6,selected===i?'#183b68ef':'#fffffff0');textAt(label,lx+9,ly+15,10,selected===i?'#fff':'#506b87');
 });
 // Each approach keeps its own waiting line and simulation phase.
 for(const a of APPROACHES)for(const kind of ['electric','motor']){
   if(kind==='motor'&&sim.settings.motorDemand===0&&metrics.motor===0)continue;
   const p=lanePosition(a.edge,roadGeometry[a.edge].length-9,a.direction,kind),s=worldToScreen(p.x,p.y);
   const span=Math.max(3.5,4.5*view.scale);
   ctx.beginPath();ctx.moveTo(s.x-p.dy*span,s.y+p.dx*span);ctx.lineTo(s.x+p.dy*span,s.y-p.dx*span);
   const control=sim.control(a.j,approachControlDirection(a));
   ctx.strokeStyle=a.j===0?{red:'#d95b53',yellow:'#e3b13b',green:'#359b71'}[control.color]:control.open?'#4b9975':'#de9440';ctx.lineWidth=2;ctx.stroke();
 }
 for(const c of vehicleMotion.carsAt(now)){
   const p=vehiclePosition(c),s=worldToScreen(p.x,p.y);
   if(s.x<0||s.y<0||s.x>w||s.y>h)continue;
   const radius=Math.max(c.kind==='motor'?.55:.3,(c.kind==='motor'?3.6:2)*view.scale);
   ctx.beginPath();ctx.arc(s.x,s.y,radius,0,Math.PI*2);ctx.fillStyle=c.kind==='motor'?'#cb554e':c.kind==='electric'?'#237fb3':'#8056a2';ctx.fill();
   const changing=c.state==='changing'||Boolean(c.laneChange);
   ctx.strokeStyle=c.state==='waiting'?'#f5b544':changing?'#00aac1':sim.time-c.lastOvertake<2?'#3daf78':'#ffffff';ctx.lineWidth=c.state==='waiting'||changing?1:.5;ctx.stroke();

 }
 for(const a of APPROACHES.filter(a=>a.j===0))trafficLight(a);
 ctx.setTransform(1,0,0,1,0,0);ctx.drawImage(labelLayer,0,0);
}

function formatDuration(s){const seconds=Math.floor(s+1e-7);return String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');}
function updateUI(){
 const m=metrics;$('active').textContent=m.active;$('queued').textContent=m.queued;
 $('vehicleTypes').textContent='电动 '+m.electric+' · 自行车 '+m.bicycle+' · 机动车 '+m.motor;
 $('travel').textContent=m.averageTravel===null?'—':(m.averageTravel/60).toFixed(1)+' 分';
 $('travelHint').textContent=m.averageTravel===null?'暂无完成行程':'已完成 '+m.completed+' 次行程';
 const clock=sim.clockState();$('clock').textContent=formatSimulationClock(clock.seconds,false);$('clock').setAttribute('datetime',formatSimulationClock(clock.seconds).split(' ').at(-1));updateDepartureUI();
 $('elapsed').textContent='运行 '+formatDuration(sim.time);$('westQueue').innerHTML=m.queues[0].total+'<small>辆</small>';$('eastQueue').innerHTML=m.queues[1].total+'<small>辆</small>';
 const q=m.queues[selected];$('junctionName').textContent=q.name;$('junctionStatus').textContent=q.total>10?'排队较多':q.total>0?'正在等待':'通行顺畅';
 $('junctionDetails').textContent='正在等待 '+q.total+' 辆 · 最长已等 '+Math.floor(q.maxWait)+' 秒';
 for(const [id,control,count]of [['forwardPhase',q.forwardControl,q.forward],['reversePhase',q.reverseControl,q.reverse]]){
   const el=$(id);el.classList.toggle('is-open',control.open);el.classList.toggle('is-yellow',control.color==='yellow');el.classList.toggle('is-red',selected===0&&control.color==='red');
   el.querySelector('span').textContent=id==='forwardPhase'?(selected===1?'来自 1 / 北侧':'来自 1'):(selected===0?'来自 2 / 北侧':'来自 2');
   el.querySelector('strong').textContent=control.waitingForDemand?'红灯待机':(selected===0?{red:'红灯约 ',yellow:'黄灯 ',green:'绿灯约 '}[control.color]:control.open?'放行 ':'等候 ')+control.remaining+'s';
   el.querySelector('small').textContent=count+' 辆等待';
 }
 $('completed').textContent=m.exited+' 辆';
 $('trafficBehavior').textContent='变道 '+m.laneChanges+' 次 · 完成超车 '+m.overtakes+' 次';
 const signal=m.westSignal;
 document.querySelectorAll('[data-signal-mode]').forEach(button=>{const active=button.dataset.signalMode===signal.mode;button.classList.toggle('selected',active);button.setAttribute('aria-pressed',String(active));});
 for(const [id,direction,count]of [['westSouthSignal',1,m.queues[0].forward],['westCrossSignal',-1,m.queues[0].reverse]]){
  const control=sim.control(0,direction),row=$(id);row.dataset.color=control.color;
  row.querySelector('strong').textContent=control.waitingForDemand?'红灯待机':{red:'红灯约 ',yellow:'黄灯 ',green:'绿灯约 '}[control.color]+control.remaining+'s';
  row.querySelector('small').textContent=count+' 辆等候';
 }
 $('signalReason').textContent=signal.reason;
 $('signalMetrics').textContent='A 平均排队 '+signal.averageQueue.toFixed(1)+' 辆 · 平均等待 '+signal.averageWait.toFixed(1)+' 秒';
 const behavior=sim.behaviorState(),grouped=behavior.enabled;
 $('guidanceField').hidden=!grouped;$('behaviorStats').hidden=!grouped;
 $('bypassLabel').textContent=grouped?'北侧绕行策略目标':'北侧环岛绕行 A';
 $('bypassExplanation').textContent=grouped?'学生是否绕行还取决于认知、触达、意愿和当前用时；其他车型沿用原规则':'原规则的绕行目标比例';
 const e=behavior.eligible,k=behavior.onMap.knowledge;
 $('behaviorStats').textContent='当前学生 '+behavior.onMap.count+' 辆（初始认知：知道 '+k.known+' / 不知道 '+k.unknown+' / 未尝试 '+k.untried+'） · 分岔前可绕行 '+e.count+' 辆，获引导 '+e.guided+'，选绕行 '+e.bypassSelected;
 $('northBypassStatus').textContent='北侧绕行 '+m.northBypass.active+' 辆 · 安全改道 '+m.northBypass.safeRouteChanges+' 次';
 const turns=m.turnCounts[selected];$('turnDetails').textContent='左转 '+turns.left+' · 直行 '+turns.straight+' · 右转 '+turns.right;$('pending').textContent=m.pending+' 辆';
 const max=Math.max(10,...sim.history.map(v=>v.queue)),points=sim.history.map((v,i)=>[i*290/Math.max(1,sim.history.length-1),60-v.queue/max*50]);
 const path=points.map((p,i)=>(i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1)).join(' ');
 $('chartLine').setAttribute('d',path);$('chartFill').setAttribute('d',points.length?path+' L'+points.at(-1)[0]+' 65 L0 65 Z':'');$('chartMax').textContent=max+' 辆';
}
function updateDepartureUI(){
 const state=sim.departureState(),config=state.config,key=JSON.stringify(config);
 if(key!==departureDraftKey&&!departureApplying&&!departureApplyTimer){
  $('departureMode').value=config.mode;$('departurePeriod').value=PERIOD_CLASS_TIMES.includes(config.classTime)?config.classTime:PERIOD_CLASS_TIMES[0];$('observationTime').value=config.observationTime??formatSimulationClock(classSeconds($('departurePeriod').value)-3600,false);departureDraftKey=key;
  setDepartureDraftMode();
 }
 const survey=state.mode==='survey';$('surveyProgress').hidden=!survey;$('fixedDemandPresets').hidden=survey;
 $('clock').hidden=!survey;$('clockSeparator').hidden=!survey;$('elapsed').hidden=!survey;
 $('departureSceneState').textContent=survey?'当前：仿真模式 · 宿舍→教学区 · '+formatSimulationClock(classSeconds(config.classTime)-3600,false)+'–'+config.classTime:'当前：模拟固定需求';
 $('demandLabel').textContent=survey?'背景骑行基准':'骑行车流';
 $('dataSourceNote').textContent=survey?'问卷分布用于骑行模拟，上课时间与总人数为场景设定。':'数据来自交通仿真，仅供方案比较。';
 if(!survey){departureChartKey='';return;}
 for(const [id,value]of [['surveyPlanned',state.planned],['surveyDeparted',state.departed],['surveyEntryWaiting',state.entryWaiting],['surveyEntered',state.entered]])$(id).textContent=value+' 人';
 if(departureChartKey!==key){
  const bins=state.plannedByMinute,max=Math.max(1,...bins);
  const curve=state.plannedCurve;
  $('departureHistogram').setAttribute('d',curve?curvePath(curve):bins.map((value,i)=>(i?'L':'M')+(i*290/60).toFixed(1)+' '+(57-value/max*47).toFixed(1)).join(' '));
  $('departureCurveLabel').textContent=curve?'计划出发速率':'计划出发（原场景）';
  $('departureWindowStart').textContent=formatSimulationClock(sim.clockState().startSeconds,false);$('departureLesson').textContent=config.classTime+' 上课';$('departurePeak').textContent='峰值 '+(curve?curve.peakRate.toFixed(1):max)+' 人/分钟';departureChartKey=key;
 }
 const x=Math.max(0,Math.min(290,sim.time/3600*290));$('departureCursor').setAttribute('x1',x);$('departureCursor').setAttribute('x2',x);
}
function observationBounds(){const end=$('departurePeriod').value,start=formatSimulationClock(classSeconds(end)-3600,false),input=$('observationTime');input.min=start;input.max=end;if(!input.value||input.value<start||input.value>end)input.value=start;}
function setDepartureDraftMode(){const survey=$('departureMode').value==='survey';$('departureSurveyInputs').hidden=!survey;$('departureMode').disabled=scenarioReadonly||departureApplying;for(const id of ['departurePeriod','observationTime'])$(id).disabled=scenarioReadonly||departureApplying||!survey;observationBounds();}
function scheduleDepartureApply(){
 if(scenarioReadonly||departureApplying)return;
 clearTimeout(departureApplyTimer);departureApplyTimer=setTimeout(()=>{departureApplyTimer=0;void applyDepartureScenario();},350);
}
$('departureMode').onchange=()=>{setDepartureDraftMode();scheduleDepartureApply();};
$('departurePeriod').onchange=()=>{observationBounds();scheduleDepartureApply();};
$('observationTime').onchange=scheduleDepartureApply;
$('departureScenarioForm').onsubmit=event=>{event.preventDefault();scheduleDepartureApply();};
async function applyDepartureScenario(){
 if(scenarioReadonly||departureApplying)return;
 const form=$('departureScenarioForm'),status=$('departureApplyStatus');
 if(!form.checkValidity()){form.reportValidity();return;}
 if(!lastRunId){status.hidden=false;status.textContent='正在读取沙盘，请稍后再选择。';return;}
 const classTime=$('departurePeriod').value;if($('departureMode').value==='survey'&&!PERIOD_CLASS_TIMES.includes(classTime)){status.hidden=false;status.textContent='请选择可用的仿真时段。';return;}
 const prior=sim.departureState().config,config=$('departureMode').value==='fixed'?{mode:'fixed'}:{mode:'survey',classTime,observationTime:$('observationTime').value,totalPeople:prior.totalPeople,seed:prior.seed};
 const unchanged=config.mode===prior.mode&&(config.mode==='fixed'||config.classTime===prior.classTime&&config.observationTime===(prior.observationTime??formatSimulationClock(classSeconds(prior.classTime)-3600,false)));
 if(unchanged)return;
 departureApplying=true;form.setAttribute('aria-busy','true');setDepartureDraftMode();
 $('departureApplyStatus').hidden=false;$('departureApplyStatus').textContent=$('departureMode').value==='survey'?'正在准备观察场景…':'正在启用…';
 try{
  const result=await shared.command({action:'departureScenario',config,expectedRunId:lastRunId});
  status.hidden=Boolean(result);status.textContent=result?'':'未能切换，请核对输入或登录状态。';
 }catch{status.hidden=false;status.textContent='未能切换，请稍后重试。';}
 finally{departureApplying=false;form.setAttribute('aria-busy','false');setDepartureDraftMode();updateDepartureUI();}
}

function playUI(){$('play').innerHTML=running?'Ⅱ <span>暂停</span>':'▶ <span>继续</span>';$('play').setAttribute('aria-label',running?'暂停模拟':'继续模拟');$('playState').textContent=running?'运行中':'已暂停';$('liveDot').style.background=running?'#2583d3':'#93a4b7';}
function reset(){return shared.command({action:'reset'});}
$('play').onclick=()=>shared.command({action:'play',running:!running});
$('reset').onclick=reset;$('fit').onclick=fit;
$('focusWestSignal').onclick=()=>{selectJunction(0);$('focusJunction').onclick();};
document.querySelectorAll('[data-signal-mode]').forEach(button=>button.onclick=()=>shared.command({action:'settings',settings:{westSignalMode:button.dataset.signalMode}}));
$('focusJunction').onclick=()=>{const j=junctions[selected];view.scale=Math.max(.8,Math.min(1.6,Math.min(w/440,h/360)));view.x=w/2-j.x*view.scale;view.y=h/2-j.y*view.scale;requestDraw();};
document.querySelectorAll('[data-speed]').forEach(b=>b.onclick=()=>shared.command({action:'speed',speed:Number(b.dataset.speed)}));
document.querySelectorAll('[data-junction]').forEach(b=>b.onclick=()=>selectJunction(Number(b.dataset.junction)));
function selectJunction(i){selected=i;document.querySelectorAll('[data-junction]').forEach(b=>{b.classList.toggle('selected',Number(b.dataset.junction)===i);b.setAttribute('aria-pressed',String(Number(b.dataset.junction)===i));});updateUI();requestDraw();}
function setPreset(kind){document.querySelectorAll('[data-preset]').forEach(b=>{b.classList.toggle('selected',b.dataset.preset===kind);b.setAttribute('aria-pressed',String(b.dataset.preset===kind));});shared.command({action:'preset',preset:kind});}
document.querySelectorAll('[data-preset]').forEach(b=>b.onclick=()=>setPreset(b.dataset.preset));
$('demand').oninput=e=>{shared.command({action:'settings',settings:{demand:Number(e.target.value)}});document.querySelectorAll('[data-preset]').forEach(b=>{b.classList.remove('selected');b.setAttribute('aria-pressed','false');});};
$('electricRatio').oninput=e=>shared.command({action:'settings',settings:{electric:Number(e.target.value)}});
$('motorDemand').oninput=e=>shared.command({action:'settings',settings:{motorDemand:Number(e.target.value)}});
$('northDemand').oninput=e=>shared.command({action:'settings',settings:{northDemand:Number(e.target.value)}});
$('behaviorMode').onchange=e=>shared.command({action:'settings',settings:{behaviorMode:e.target.value}});
$('guidanceCoverage').oninput=e=>shared.command({action:'settings',settings:{guidanceCoverage:Number(e.target.value)}});
$('northBypassShare').oninput=e=>shared.command({action:'settings',settings:{northBypassShare:Number(e.target.value)}});
function zoom(factor,x=w/2,y=h/2){const scale=Math.max(.18,Math.min(3.5,view.scale*factor)),r=scale/view.scale;view.x=x-(x-view.x)*r;view.y=y-(y-view.y)*r;view.scale=scale;requestDraw();}
$('zoomIn').onclick=()=>zoom(1.25);$('zoomOut').onclick=()=>zoom(.8);
canvas.addEventListener('wheel',e=>{e.preventDefault();const r=canvas.getBoundingClientRect();zoom(Math.exp(-e.deltaY*.001),e.clientX-r.left,e.clientY-r.top);},{passive:false});
let drag=null;
canvas.addEventListener('pointerdown',e=>{drag={x:e.clientX,y:e.clientY,startX:e.clientX,startY:e.clientY};canvas.setPointerCapture(e.pointerId);});
canvas.addEventListener('pointermove',e=>{if(!drag)return;view.x+=e.clientX-drag.x;view.y+=e.clientY-drag.y;drag.x=e.clientX;drag.y=e.clientY;requestDraw();});
canvas.addEventListener('pointerup',e=>{if(drag&&Math.hypot(e.clientX-drag.startX,e.clientY-drag.startY)<5){const r=canvas.getBoundingClientRect();junctions.forEach((j,i)=>{const p=worldToScreen(j.x,j.y);if(Math.hypot(e.clientX-r.left-p.x,e.clientY-r.top-p.y)<45)selectJunction(i);});}drag=null;});
canvas.addEventListener('pointercancel',()=>{drag=null;});
$('export').onclick=()=>{const blob=new Blob([JSON.stringify(sim.snapshot(),null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='traffic-simulation-'+Math.floor(sim.time)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),500);};
function requestDraw(){if(!animationFrame&&!document.hidden)animationFrame=requestAnimationFrame(frame);}
function frame(now){animationFrame=0;if(document.hidden)return;draw(now);if(vehicleMotion.hasMotion(now))animationFrame=requestAnimationFrame(frame);}
document.addEventListener('visibilitychange',()=>{
 vehicleMotion.reset();if(animationFrame)cancelAnimationFrame(animationFrame);animationFrame=0;
 if(!document.hidden){void shared.read();requestDraw();}
});
motionPreference.addEventListener('change',event=>{vehicleMotion.setEnabled(!event.matches);requestDraw();});
document.fonts?.ready.then(()=>{staticKey='';requestDraw();});
updateUI();playUI();shared.start();requestDraw();

