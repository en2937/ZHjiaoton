import {MAP,EDGES,ROUTES,APPROACHES,JUNCTIONS,POINTS,MOTOR_ROAD,MIDDLE_ROAD,DICHEN_ROAD,EXITS,BASE_ROUTE_WEIGHTS,NORTH_BYPASS_ROUTES} from './route.mjs';
// Shape-preserving cubic interpolation. Rates are people per simulation minute.
const sameSign=(a,b)=>a*b>0;
export function curveFromReference(bins,totalPeople){
 const peakAt=([start,end])=>{let index=start;for(let i=start+1;i<=end;i++)if(bins[i]>bins[index])index=i;return {minute:index,rate:bins[index]};};
 const referencePeaks=[[34,35],[39,40],[44,45]].map(peakAt);
 const first=referencePeaks[0].minute;
 const anchors=[...bins.slice(0,first+1).map((rate,minute)=>({minute,rate})),...referencePeaks.slice(1).map(p=>({...p})),{minute:60,rate:0}];
 const h=anchors.slice(1).map((p,i)=>p.minute-anchors[i].minute),d=h.map((span,i)=>(anchors[i+1].rate-anchors[i].rate)/span),m=anchors.map(()=>0);
 if(d.length===1)m[0]=d[0];
 else {m[0]=((2*h[0]+h[1])*d[0]-h[0]*d[1])/(h[0]+h[1]);if(!sameSign(m[0],d[0]))m[0]=0;else if(!sameSign(d[0],d[1])&&Math.abs(m[0])>3*Math.abs(d[0]))m[0]=3*d[0];}
 for(let i=1;i<anchors.length-1;i++)if(sameSign(d[i-1],d[i])){const w1=2*h[i]+h[i-1],w2=h[i]+2*h[i-1];m[i]=(w1+w2)/(w1/d[i-1]+w2/d[i]);}
 // End horizontally at zero; the batch ends at the classroom time.
 const segments=h.map((span,i)=>({x:anchors[i].minute,h:span,y0:anchors[i].rate,y1:anchors[i+1].rate,m0:m[i],m1:m[i+1]}));
 const rawArea=segments.reduce((sum,s)=>sum+partialArea(s,1),0);
 // For tiny populations a point category can have zero quota; all-zero curves fall back to a gentle hump.
 if(!(rawArea>0))return curveFromReference(Object.assign(Array(61).fill(0),{35:1,40:1,45:1}),totalPeople);
 const scale=totalPeople/rawArea;
 for(const p of anchors)p.rate*=scale;
 let cumulative=0;
 for(const s of segments){for(const key of ['y0','y1','m0','m1'])s[key]*=scale;s.cumulative=cumulative;cumulative+=partialArea(s,1);}
 const peaks=referencePeaks.map(p=>({minute:p.minute,rate:p.rate*scale}));
 return {model:'smooth-peaks-v1',totalPeople,anchors,segments,peaks,referencePeaks,referenceArea:rawArea,integral:cumulative,peakRate:Math.max(...anchors.map(p=>p.rate))};
}
function coefficients(s){return [s.y0,s.h*s.m0,3*(s.y1-s.y0)-s.h*(2*s.m0+s.m1),2*(s.y0-s.y1)+s.h*(s.m0+s.m1)];}
export function partialArea(s,t){const [a,b,c,d]=coefficients(s);return s.h*(a*t+b*t*t/2+c*t*t*t/3+d*t*t*t*t/4);}
export function rateAt(curve,minute){
 if(minute<0||minute>=60)return 0;
 const s=curve.segments.find(row=>minute<=row.x+row.h)??curve.segments.at(-1),t=(minute-s.x)/s.h,[a,b,c,d]=coefficients(s);
 return Math.max(0,a+t*(b+t*(c+t*d)));
}
export function timeAtMass(curve,mass){
 const target=Math.max(0,Math.min(curve.integral,mass));
 const s=curve.segments.find(row=>row.cumulative+partialArea(row,1)>=target)??curve.segments.at(-1);
 let low=0,high=1;for(let i=0;i<48;i++){const mid=(low+high)/2;if(s.cumulative+partialArea(s,mid)<target)low=mid;else high=mid;}
 return s.x+s.h*(low+high)/2;
}
export function curvePath(curve,{width=290,bottom=57,height=47}={}){
 const max=Math.max(1,curve.peakRate),x=minute=>minute*width/60,y=rate=>bottom-rate/max*height,f=value=>value.toFixed(2);
 let path='M'+f(x(curve.anchors[0].minute))+' '+f(y(curve.anchors[0].rate));
 for(const s of curve.segments)path+=' C'+f(x(s.x+s.h/3))+' '+f(y(s.y0+s.h*s.m0/3))+' '+f(x(s.x+s.h*2/3))+' '+f(y(s.y1-s.h*s.m1/3))+' '+f(x(s.x+s.h))+' '+f(y(s.y1));
 return path;
}

export const GAP=9,MOTOR_GAP=14,WAIT_SPEED=.6;
export const SOURCE1_MOTOR_FACTOR=.25;
export const ROAD_WIDTH={slots:3,slotSpacing:4.8,vehicleWidths:{electric:1,bicycle:1,motor:2},directionOffset:8.4,separationOffset:12,mergeZone:64,neckZone:32};
export const WEST_SIGNAL_POLICY={minGreen:20,maxGreen:60,fixedGreen:30,greenBudget:75,yellow:3,allRed:2,reviewInterval:1,extension:5,maxRed:75,detectorRange:120};
export const gapBetween=(a,b)=>a?.kind==='motor'||b?.kind==='motor'?MOTOR_GAP:GAP;
export const junctions=JUNCTIONS.map(j=>({...j,x:POINTS[j.pointIndex][0],y:POINTS[j.pointIndex][1]}));
export const roadGeometry=Object.fromEntries(Object.entries(EDGES).map(([id,road])=>{
 const cumulative=[0];for(let i=1;i<road.points.length;i++)cumulative.push(cumulative[i-1]+Math.hypot(road.points[i][0]-road.points[i-1][0],road.points[i][1]-road.points[i-1][1]));
 return [id,{...road,cumulative,length:cumulative.at(-1)}];
}));
export function pointOnEdge(edge,progress,direction=1,kind='electric'){
 const road=roadGeometry[edge],s=Math.max(0,Math.min(road.length,direction===1?progress:road.length-progress));
 let i=1;while(i<road.cumulative.length-1&&road.cumulative[i]<s)i++;
 const points=road.directionPoints?.[direction]??(kind==='motor'&&road.motorPoints?road.motorPoints:road.points);
 const a=points[i-1],b=points[i],span=road.cumulative[i]-road.cumulative[i-1],t=(s-road.cumulative[i-1])/span;
 const dist=Math.hypot(b[0]-a[0],b[1]-a[1]),dx=(b[0]-a[0])/dist,dy=(b[1]-a[1])/dist;
 // Offsets taper to the same junction point so turning does not teleport between lanes.
 const blend=Math.max(0,Math.min(1,s/16,(road.length-s)/16));
 const lateral=(road.lateralOffset??(kind==='motor'&&road.motorEast?1.8:4))*blend*direction;
 return {x:a[0]+(b[0]-a[0])*t-dy*lateral,y:a[1]+(b[1]-a[1])*t+dx*lateral,dx:dx*direction,dy:dy*direction};
}
export const currentRef=car=>car.route.refs[car.edgeIndex];
export const laneKeyFor=(ref,kind)=>ref.edge+':'+ref.direction+(EDGES[ref.edge].motorEast?':'+(kind==='motor'?'motor':'cycle'):'');
const groupCache=new WeakMap(),tangentCache=new WeakMap();
export function carriagewayKey(car){
 const ref=currentRef(car),cached=groupCache.get(car);
 if(cached&&cached.edge===ref.edge&&cached.direction===ref.direction&&cached.kind===car.kind)return cached.key;
 const key=laneKeyFor(ref,car.kind);groupCache.set(car,{edge:ref.edge,direction:ref.direction,kind:car.kind,key});return key;
}
function pointTangents(points){
 let tangents=tangentCache.get(points);if(tangents)return tangents;
 const segments=[null];for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i],length=Math.hypot(b[0]-a[0],b[1]-a[1]);segments.push({x:(b[0]-a[0])/length,y:(b[1]-a[1])/length});}
 tangents=points.map((_,i)=>{const a=segments[Math.max(1,i)],b=segments[Math.min(points.length-1,i+1)],length=Math.hypot(a.x+b.x,a.y+b.y);return {x:(a.x+b.x)/length,y:(a.y+b.y)/length};});
 tangentCache.set(points,tangents);return tangents;
}
export const laneKey=car=>carriagewayKey(car)+':lane'+(car.lane??1);
export const slotWidth=car=>ROAD_WIDTH.vehicleWidths[car.kind];
export const slotRange=(car,lane=car.lane??1)=>Array.from({length:slotWidth(car)},(_,i)=>lane+i);
export const slotMask=(car,lane=car.lane??1)=>((1<<slotWidth(car))-1)<<lane;
export function occupiedMask(car){
 const length=roadGeometry[currentRef(car).edge].length;
 if(car.p<ROAD_WIDTH.neckZone||length-car.p<ROAD_WIDTH.neckZone)return 7;
 return slotMask(car)|(car.laneChange?slotMask(car,car.laneChange.from):0);
}
export const occupiedSlots=car=>[0,1,2].filter(slot=>occupiedMask(car)&(1<<slot));
export const sharesSpace=(a,b)=>carriagewayKey(a)===carriagewayKey(b)&&!!(occupiedMask(a)&occupiedMask(b));
export function lanePosition(edge,progress,direction=1,kind='electric',lateral=0){
 const road=roadGeometry[edge],p=pointOnEdge(edge,progress,direction,kind),nx=-p.dy,ny=p.dx;
 const baseBlend=Math.max(0,Math.min(1,progress/16,(road.length-progress)/16));
 const wideBlend=Math.max(0,Math.min(1,progress/32,(road.length-progress)/32));
 const old=(road.lateralOffset??(kind==='motor'&&road.motorEast?1.8:4))*baseBlend;
 const s=Math.max(0,Math.min(road.length,direction===1?progress:road.length-progress));
 let i=1;while(i<road.cumulative.length-1&&road.cumulative[i]<s)i++;
 const points=road.directionPoints?.[direction]??(kind==='motor'&&road.motorPoints?road.motorPoints:road.points);
 const tangents=pointTangents(points),a=tangents[i-1],b=tangents[i],t=(s-road.cumulative[i-1])/(road.cumulative[i]-road.cumulative[i-1]);
 const dx=a.x+(b.x-a.x)*t,dy=a.y+(b.y-a.y)*t,headingLength=Math.hypot(dx,dy);
 const normalX=-dy/headingLength*direction,normalY=dx/headingLength*direction;
 const centre=road.directionPoints||road.roundabout?0:ROAD_WIDTH.directionOffset;
 const outward=road.motorEast?(kind==='motor'?1:-1)*(normalX>=0?1:-1)*ROAD_WIDTH.separationOffset:0;
 const offset=(centre+outward+lateral)*wideBlend;
 return {x:p.x-nx*old+normalX*offset,y:p.y-ny*old+normalY*offset,dx:dx/headingLength*direction,dy:dy/headingLength*direction};
}
export function vehiclePosition(car){
 const r=currentRef(car),change=car.laneChange;
 const t=change?Math.max(0,Math.min(1,change.progress)):1,smooth=t*t*(3-2*t);
 const lane=change?change.from+(car.lane-change.from)*smooth:(car.lane??1);
 const lateral=(lane+(slotWidth(car)-1)/2-1)*ROAD_WIDTH.slotSpacing;
 return lanePosition(r.edge,car.p,r.direction,car.kind,lateral);
}
export const routeLength=route=>route.refs.reduce((n,r)=>n+roadGeometry[r.edge].length,0);
export const totalProgress=car=>car.route.refs.slice(0,car.edgeIndex).reduce((n,r)=>n+roadGeometry[r.edge].length,0)+car.p;
export const approachFor=ref=>APPROACHES.find(a=>a.edge===ref.edge&&a.direction===ref.direction);
export const approachControlDirection=approach=>approach.controlDirection??(approach.origin===1?1:-1);
export const isOutsideMap=(position,margin=6)=>position.x<-margin||position.x>MAP.width+margin||position.y<-margin||position.y>MAP.height+margin;
export const SURVEY_DEPARTURES=Object.freeze({sampleSize:36,question:'你会选择上课前提前多久前往教室',groups:Object.freeze([
 {id:'hour-plus',label:'提前1小时及以上',count:0,minLead:60,maxLead:120},
 {id:'30-60',label:'提前30分钟至1小时',count:9,minLead:30,maxLead:60},
 {id:'25',label:'提前25分钟',count:12,minLead:24,maxLead:26},
 {id:'20',label:'提前20分钟',count:7,minLead:19,maxLead:21},
 {id:'15',label:'提前15分钟',count:6,minLead:14,maxLead:16},
 {id:'10-under',label:'提前10分钟及以下',count:2,minLead:0,maxLead:10}
].map(Object.freeze))});
export const DEPARTURE_DEFAULTS=Object.freeze({mode:'fixed',classTime:'08:00',totalPeople:360,seed:20261014,observationTime:null,distributionModel:'smooth-peaks-v1'});
export function departureConfig(input={}){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['mode','classTime','totalPeople','seed','observationTime','distributionModel'].includes(key)))throw new Error('出发场景参数无效。');
 const config={...DEPARTURE_DEFAULTS,...input};
 if(!['smooth-peaks-v1','questionnaire-batches-v1'].includes(config.distributionModel))throw new Error('出发分布模型无效。');
 if(!['fixed','survey'].includes(config.mode)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(config.classTime)||!Number.isInteger(config.totalPeople)||config.totalPeople<1||config.totalPeople>2000||!Number.isInteger(config.seed)||config.seed<0||config.seed>4294967295)throw new Error('请选择有效模式和上课时间，总人数须为1–2000的整数。');
 config.observationTime=input.observationTime??null;
 if(config.observationTime!==null&&(config.mode!=='survey'||typeof config.observationTime!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(config.observationTime)||observationOffset(config)>3600))throw new Error('观察开始时间须在所选仿真时段内。');
 return config;
}
export const classSeconds=clock=>Number(clock.slice(0,2))*3600+Number(clock.slice(3))*60;
export const observationOffset=config=>config.observationTime===null||config.observationTime===undefined?0:((classSeconds(config.observationTime)-(classSeconds(config.classTime)-3600))%86400+86400)%86400;
export function formatSimulationClock(seconds,withSeconds=true){
 const whole=Math.floor(seconds+1e-7),day=Math.floor(whole/86400),s=((whole%86400)+86400)%86400;
 const text=String(Math.floor(s/3600)).padStart(2,'0')+':'+String(Math.floor(s/60)%60).padStart(2,'0')+(withSeconds?':'+String(s%60).padStart(2,'0'):'');
 return (day===-1?'前一天 ':day===0?'':(day>0?'第'+(day+1)+'天 ':'前'+(-day)+'天 '))+text;
}
export function makeDeparturePlan(input){
 const config=departureConfig(input),n=config.totalPeople,denominator=SURVEY_DEPARTURES.sampleSize;
 const quotas=SURVEY_DEPARTURES.groups.map((group,index)=>({index,people:Math.floor(n*group.count/denominator),remainder:n*group.count%denominator}));
 const left=n-quotas.reduce((sum,q)=>sum+q.people,0);
 [...quotas].sort((a,b)=>b.remainder-a.remainder||a.index-b.index).slice(0,left).forEach(q=>q.people++);
 let seed=config.seed,id=1;const random=()=>{seed=(Math.imul(1664525,seed)+1013904223)>>>0;return (seed+.5)/4294967296;};
 const plan=[],categories=[],plannedByMinute=Array(61).fill(0);
 for(const [index,group]of SURVEY_DEPARTURES.groups.entries()){
  categories.push({id:group.id,label:group.label,sampleCount:group.count,plannedPeople:quotas[index].people});
  for(let i=0;i<quotas[index].people;i++){
   const leadSeconds=(group.minLead+(group.maxLead-group.minLead)*random())*60,time=3600-leadSeconds;
   plan.push({id:id++,category:group.id,time,leadSeconds});plannedByMinute[Math.floor(time/60)]++;
  }
 }
 plan.sort((a,b)=>a.time-b.time||a.id-b.id);
 if(config.mode==='survey'&&config.distributionModel==='smooth-peaks-v1'){
  const curve=curveFromReference(plannedByMinute,n),referenceByMinute=[...plannedByMinute];plannedByMinute.fill(0);
  seed=(config.seed^0x9e3779b9)>>>0;
  for(let i=0;i<plan.length;i++){
   const event=plan[i],sourceCategory=event.category,referenceTime=event.time;
   event.time=timeAtMass(curve,i+random())*60;event.leadSeconds=3600-event.time;event.category='smoothed';event.sourceCategory=sourceCategory;event.referenceTime=referenceTime;
   plannedByMinute[Math.floor(event.time/60)]++;
  }
  return {plan,categories:categories.map(row=>({...row,interpretation:'original-questionnaire-reference'})),plannedByMinute,referenceByMinute,curve,nextIndex:0,entered:0,completed:0};
 }
 return {plan,categories,plannedByMinute,nextIndex:0,entered:0,completed:0};
}


// Survey marginals are raw counts. Cross-question independence and reaction rules are assumptions.
export const BEHAVIOR_MODEL={version:'route-groups-v1',seed:20261014,sampleSize:36,
 knowledge:{known:18,unknown:14,untried:4},willingness:{conditional:32,occasional:2,unwilling:2},
 minimumSavingSeconds:15,trialProbability:{conditional:.8,occasional:.35,unwilling:0},reviewSeconds:5};
const behaviorCache=new WeakMap();
function behaviorRandom(seed){let n=seed>>>0;return ()=>{n=(Math.imul(n,1664525)+1013904223)>>>0;return n/4294967296;};}
function groupAt(counts,ordinal,domain){
 const block=Math.floor((ordinal-1)/36),random=behaviorRandom((BEHAVIOR_MODEL.seed+Math.imul(block+1,2654435761)+domain)>>>0);
 const groups=Object.entries(counts).flatMap(([key,n])=>Array(n).fill(key));
 for(let i=groups.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[groups[i],groups[j]]=[groups[j],groups[i]];}
 return groups[(ordinal-1)%36];
}
export function studentProfile(ordinal){
 const random=behaviorRandom((BEHAVIOR_MODEL.seed+Math.imul(ordinal,2246822519)+907)>>>0);
 return {ordinal,knowledge:groupAt(BEHAVIOR_MODEL.knowledge,ordinal,101),willingness:groupAt(BEHAVIOR_MODEL.willingness,ordinal,503),reachDraw:random(),trialDraw:random(),receivedGuide:false,guidedAt:null};
}
export const isStudent=car=>car.kind!=='motor'&&[1,-1].includes(car.direction);
export const routeCompatible=(car,target)=>target?.exit===car.route.exit&&car.route.refs.slice(0,car.edgeIndex+1).every((ref,i)=>target.refs[i]?.edge===ref.edge&&target.refs[i]?.direction===ref.direction);
const usesBypass=car=>Boolean(car.routingChoice&&NORTH_BYPASS_ROUTES[car.routingChoice.normalRouteId]===car.route.id);

export class Simulation{
 constructor(options={}){
  this.seed=options.seed??20261012;this.settings={demand:30,electric:70,outbound:72,motorDemand:6,northBypassShare:60,northDemand:8,westSignalMode:'adaptive',behaviorMode:'original',guidanceCoverage:0};this.setSettings(options.settings??{});
  this.time=0;this.studentOrdinal=0;this.lastBehaviorReview=-5;this.cars=[];this.nextId=1;this.credit={1:0,'-1':0,0:0};this.motorCredit={1:0,'-1':0,0:0};this.pending={1:[],'-1':[],0:[]};
  this.departureScenario=departureConfig(options.departureScenario);this.clockStartSeconds=this.departureScenario.mode==='survey'?classSeconds(this.departureScenario.classTime)-3600:28200;
  this.surveyDepartures=this.departureScenario.mode==='survey'?makeDeparturePlan(this.departureScenario):null;
  this.completed=0;this.travelSum=0;this.exited=0;this.completedByKind={electric:0,bicycle:0,motor:0};
  this.exitCounts=Object.fromEntries(EXITS.map(e=>[e.id,0]));this.turnCounts=junctions.map(()=>({left:0,straight:0,right:0}));
  this.history=[];this.lastSample=-1;this.passes={1:junctions.map(()=>-100),'-1':junctions.map(()=>-100)};
  this.laneChanges=0;this.overtakes=0;this.demo=false;
  this.bypassStats={eligibleGenerated:0,divertedGenerated:0,safeRouteChanges:0,lastChangedAt:0};
  this.westSignal={stage:'green',phase:1,startedAt:0,greenStartedAt:0,endsAt:this.settings.westSignalMode==='fixed'?30:20,nextReview:0,planned:false,target:-1,
   lastServed:{1:0,'-1':0},switches:0,extensions:0,reason:'迪臣中路南向先放行',detectors:null,history:[{time:0,stage:'green',phase:1}]};
  this.westStats={queueSeconds:0,passed:0,waitSum:0};
  for(const direction of [1,-1]){
   if(!(direction===1&&this.departureScenario.mode==='survey'))for(let i=0;i<22;i++)this.addWarmCar(direction,i/22,'cycle');
   const motorWarmCount=direction===1?1:5;
   if(this.settings.motorDemand>0)for(let i=0;i<motorWarmCount;i++)this.addWarmCar(direction,(i+.5)/motorWarmCount,'motor');
  }
  if(this.settings.northDemand>0){
   for(let i=0;i<12;i++)this.addWarmCar(0,(i+.5)/12,'cycle');
   if(this.settings.motorDemand>0)for(let i=0;i<3;i++)this.addWarmCar(0,(i+.5)/3,'motor');
  }
 }
 clockState(){
  const start=Number.isFinite(this.clockStartSeconds)?this.clockStartSeconds:28200,seconds=start+this.time;
  const config=this.departureScenario??DEPARTURE_DEFAULTS,survey=config.mode==='survey',lesson=survey?classSeconds(config.classTime):null;
  return {startSeconds:start,seconds,label:formatSimulationClock(seconds),dayOffset:Math.floor((seconds+1e-7)/86400),classTime:survey?config.classTime:null,classSeconds:lesson,secondsUntilClass:survey?lesson-seconds:null};
 }
 departureState(){
  const config={...(this.departureScenario??DEPARTURE_DEFAULTS)},state=this.surveyDepartures;
  if(config.mode!=='survey'||!state)return {mode:'fixed',config};
  return {mode:'survey',config,source:'user-survey-q3',sampleSize:36,planned:state.plan.length,departed:state.nextIndex,notYetDeparted:state.plan.length-state.nextIndex,
   entryWaiting:this.pending[1].filter(car=>car.surveyDepartureId!==undefined).length,entered:state.entered,active:this.cars.filter(car=>car.surveyDepartureId!==undefined).length,completed:state.completed,
   categories:state.categories,plannedByMinute:state.plannedByMinute,...(state.curve?{plannedCurve:state.curve}:{})};
 }
 enqueueSurveyDepartures(){
  const state=this.surveyDepartures;if(this.demo||this.departureScenario?.mode!=='survey'||!state)return;
  while(state.nextIndex<state.plan.length&&state.plan[state.nextIndex].time<=this.time+1e-9){
   const event=state.plan[state.nextIndex++],choices=BASE_ROUTE_WEIGHTS[1].filter(([id])=>id==='1-south'||id==='1-ring');
   let draw=this.random()*choices.reduce((sum,[,weight])=>sum+weight,0),normalRouteId=choices.at(-1)[0];
   for(const [id,weight]of choices){draw-=weight;if(draw<0){normalRouteId=id;break;}}
   const routingChoice={normalRouteId,bypassDraw:this.random()},car=this.newCar(1,event.time,'cycle',undefined,routingChoice);
   car.surveyDepartureId=event.id;car.surveyCategory=event.category;this.pending[1].push(car);
  }
 }
 random(){this.seed=(Math.imul(1664525,this.seed)+1013904223)>>>0;return this.seed/4294967296;}
 routeChoice(direction){
  const choices=BASE_ROUTE_WEIGHTS[direction],draw=this.random();let total=0,normalRouteId=choices.at(-1)[0];
  for(const [id,weight]of choices){total+=weight;if(draw<total){normalRouteId=id;break;}}
  return {normalRouteId,bypassDraw:this.random()};
 }
 chooseRoute(direction,choice=this.routeChoice(direction)){
  const bypass=NORTH_BYPASS_ROUTES[choice.normalRouteId];
  return ROUTES[bypass&&choice.bypassDraw<this.settings.northBypassShare/100?bypass:choice.normalRouteId];
 }
 initializeBehavior(){
  this.settings.behaviorMode??='original';this.settings.guidanceCoverage??=0;
  this.studentOrdinal??=0;this.lastBehaviorReview??=-1;
  const cars=[...this.cars,...Object.values(this.pending).flat()].sort((a,b)=>a.id-b.id);
  this.studentOrdinal=Math.max(this.studentOrdinal,...cars.map(c=>c.behavior?.ordinal??0));
  for(const car of cars){car.routeSelectionMode??='original';if(isStudent(car)&&!car.behavior)car.behavior=studentProfile(++this.studentOrdinal);}
 }
 behaviorCosts(fresh=false){
  const previous=behaviorCache.get(this),bucket=Math.floor(this.time/BEHAVIOR_MODEL.reviewSeconds);
  if(!fresh&&previous?.bucket===bucket)return previous.costs;
  const queueWait={};
  for(const c of this.cars??[])if(c.queueJunction>=0&&c.v<WAIT_SPEED){const ref=currentRef(c),key=ref.edge+':'+ref.direction;queueWait[key]=(queueWait[key]??0)+(c.kind==='motor'?1.6:1.2);}
  const costs={};
  for(const [id,route]of Object.entries(ROUTES)){
   let wait=0;
   for(const ref of route.refs){const a=approachFor(ref);if(!a||!this.westSignal)continue;const control=this.control(a.j,approachControlDirection(a));wait+=(queueWait[ref.edge+':'+ref.direction]??0)+(control.open?0:control.remaining);}
   costs[id]={length:routeLength(route),wait};
  }
  if(!fresh)behaviorCache.set(this,{bucket,costs});return costs;
 }
 behaviorDecision(car,costs=this.behaviorCosts()){
  const normalId=car.routingChoice?.normalRouteId,bypassId=NORTH_BYPASS_ROUTES[normalId];
  const base=ROUTES[normalId],alternative=ROUTES[bypassId];
  const no=reason=>({routeId:car.route.id,reason,decidedAt:this.time,savingSeconds:null});
  if(!base||!alternative||base.exit!==alternative.exit)return no('routeNotApplicable');
  // Both alternatives must share the already travelled prefix. Undo respects this boundary.
  if(!routeCompatible(car,base)||!routeCompatible(car,alternative))return no('passedFork');
  const profile=car.behavior;if(!profile)return no('missingProfile');
  if(profile.reachDraw<this.settings.guidanceCoverage/100&&!profile.receivedGuide){profile.receivedGuide=true;profile.guidedAt=this.time;}
  const speed={electric:8.4,bicycle:6.8}[car.kind];
  const saving=(costs[normalId].length-costs[bypassId].length)/speed+costs[normalId].wait-costs[bypassId].wait;
  let reason='selected';
  if(profile.knowledge!=='known'&&!profile.receivedGuide)reason=this.settings.guidanceCoverage>0?'notReached':profile.knowledge==='unknown'?'notAware':'untriedWithoutGuide';
  else if(profile.willingness==='unwilling')reason='unwilling';
  else if(saving<BEHAVIOR_MODEL.minimumSavingSeconds)reason='notEnoughSaving';
  else if(profile.trialDraw>=BEHAVIOR_MODEL.trialProbability[profile.willingness])reason='trialNotTaken';
  else if(car.routingChoice.bypassDraw>=this.settings.northBypassShare/100)reason='strategyNotAssigned';
  return {routeId:reason==='selected'?bypassId:normalId,reason,decidedAt:this.time,savingSeconds:Math.round(saving*100)/100};
 }
 behaviorState(){
  const grouped=this.settings.behaviorMode==='grouped',students=this.cars.filter(isStudent),pending=Object.values(this.pending).flat().filter(isStudent);
  const counts=cars=>({count:cars.length,knowledge:Object.fromEntries(Object.keys(BEHAVIOR_MODEL.knowledge).map(k=>[k,cars.filter(c=>c.behavior?.knowledge===k).length])),willingness:Object.fromEntries(Object.keys(BEHAVIOR_MODEL.willingness).map(k=>[k,cars.filter(c=>c.behavior?.willingness===k).length])),missingProfiles:cars.filter(c=>!c.behavior).length,guided:cars.filter(c=>c.behavior?.receivedGuide).length,bypassSelected:cars.filter(usesBypass).length,bypassInherited:cars.filter(c=>usesBypass(c)&&c.routeSelectionMode!=='grouped').length,selectionModes:Object.fromEntries(['original','grouped','forced','unknown'].map(mode=>[mode,cars.filter(c=>(c.routeSelectionMode??'unknown')===mode).length]))});
  const reasons={notAware:0,untriedWithoutGuide:0,notReached:0,unwilling:0,notEnoughSaving:0,trialNotTaken:0,strategyNotAssigned:0,missingProfile:0,notEvaluated:0};
  const ineligible={routeNotApplicable:0,passedFork:0},eligible=[];
  for(const car of students){
   const id=car.routingChoice?.normalRouteId,alternative=ROUTES[NORTH_BYPASS_ROUTES[id]],base=ROUTES[id];
   if(!base||!alternative||base.exit!==alternative.exit){ineligible.routeNotApplicable++;continue;}
   if(!routeCompatible(car,base)||!routeCompatible(car,alternative)){ineligible.passedFork++;continue;}
   eligible.push(car);if(!usesBypass(car)){const reason=grouped?car.behaviorDecision?.reason:'notEvaluated';reasons[Object.hasOwn(reasons,reason)?reason:'notEvaluated']++;}
  }
  const costs=this.behaviorCosts(true),estimates={};
  // Full assigned trip to the unchanged exit, distinguished from the C-end marked 1/2 journey.
  for(const [id,bypass]of Object.entries(NORTH_BYPASS_ROUTES))for(const kind of ['electric','bicycle']){
   const speed={electric:8.4,bicycle:6.8}[kind];estimates[id+'_'+kind]={normalRoute:id,bypassRoute:bypass,destination:ROUTES[id].exit,normalMapUnits:Math.round(costs[id].length),bypassMapUnits:Math.round(costs[bypass].length),normalSeconds:Math.ceil(costs[id].length/speed+costs[id].wait),bypassSeconds:Math.ceil(costs[bypass].length/speed+costs[bypass].wait),savingSeconds:Math.round(((costs[id].length-costs[bypass].length)/speed+costs[id].wait-costs[bypass].wait)*100)/100};
  }
  return {version:BEHAVIOR_MODEL.version,enabled:grouped,mode:this.settings.behaviorMode,applicablePopulation:'地点1、2出发的学生骑行车辆；机动车及北侧背景车流沿用原规则',sampleSize:36,routeCorrespondence:'user-confirmed-same-north-bypass',weights:{knowledge:{...BEHAVIOR_MODEL.knowledge},willingness:{...BEHAVIOR_MODEL.willingness}},assumptions:{independentGroups:true,seed:BEHAVIOR_MODEL.seed,minimumSavingSeconds:15,trialProbability:{...BEHAVIOR_MODEL.trialProbability},currentTripOnly:true,informationPersistsWithinTrip:true},strategyTarget:this.settings.northBypassShare,guidanceCoverage:this.settings.guidanceCoverage,simulationTime:this.time,
   onMap:{denominator:'当前地图内学生骑行车辆',...counts(students)},entryWaiting:{denominator:'当前入口等待学生骑行车辆（不含地图内车辆）',...counts(pending)},eligible:{denominator:'当前地图内、北侧绕行合法且尚未经过分岔点的学生骑行车辆',...counts(eligible),notBypassing:eligible.filter(c=>!usesBypass(c)).length,reasons},ineligible,decisionWindow:'当前行程内最后一次选择；每5模拟秒或配置变化复核，原因互斥。不可达及已过分岔点单列。',estimates,timeMethod:'current-state-rule-estimate',measuredBenefit:null};
 }
 rerouteForBypassShare(){
  if(!this.cars||this.demo)return;
  behaviorCache.delete(this);let changed=0;
  for(const car of [...this.cars,...Object.values(this.pending).flat()]){
   if(!car.routingChoice)continue;
   let target;
   if(this.settings.behaviorMode==='grouped'&&isStudent(car)){car.behaviorDecision=this.behaviorDecision(car);target=ROUTES[car.behaviorDecision.routeId];}
   else target=this.chooseRoute(car.direction,car.routingChoice);
   const base=ROUTES[car.routingChoice.normalRouteId],alternative=ROUTES[NORTH_BYPASS_ROUTES[car.routingChoice.normalRouteId]];
   if(base&&alternative&&routeCompatible(car,base)&&routeCompatible(car,alternative))car.routeSelectionMode=this.settings.behaviorMode;
   if(target.id===car.route.id)continue;
   // A changed destination or a passed fork is never repaired by teleporting.
   if(target.exit!==car.route.exit||!car.route.refs.slice(0,car.edgeIndex+1).every((ref,i)=>target.refs[i]?.edge===ref.edge&&target.refs[i]?.direction===ref.direction))continue;
   car.route=target;changed++;
  }
  this.bypassStats.safeRouteChanges+=changed;this.bypassStats.lastChangedAt=this.time;
 }
 initializeBypassRouting(share=60){
  delete this.settings.branchShare;this.settings.northBypassShare=0;
  this.bypassStats??={eligibleGenerated:0,divertedGenerated:0,safeRouteChanges:0,lastChangedAt:this.time};
  for(const car of [...this.cars,...Object.values(this.pending).flat()])if(!car.routingChoice){
   const normalRouteId={'1-ring-north':'1-south','1-bypass-east':'1-east','1-bypass-north':'1-north','2-ring-north':'2-west-north'}[car.route.id]||car.route.id;
   car.routingChoice={normalRouteId,bypassDraw:this.random()};
  }
  this.setSettings({northBypassShare:share});
 }
 newCar(direction,requestedAt,forcedKind,routeId,forcedRoutingChoice){
  const kind=forcedKind&&forcedKind!=='cycle'?forcedKind:(this.random()*100<this.settings.electric?'electric':'bicycle');
  const routingChoice=routeId?null:forcedRoutingChoice??this.routeChoice(direction),route=routeId?ROUTES[routeId]:this.chooseRoute(direction,routingChoice);
  const lane=(this.nextId-1)%(4-ROAD_WIDTH.vehicleWidths[kind]);
  const car={id:this.nextId++,direction,kind,route,routingChoice,routeSelectionMode:routeId?'forced':this.settings.behaviorMode,edgeIndex:0,p:0,v:0,maxV:{electric:8.4,bicycle:6.8,motor:11}[kind]*(.92+this.random()*.16),requestedAt,
   lane,homeLane:lane,laneChange:null,lastLaneChange:-100,passTarget:null,overtakes:0,lastOvertake:-100,
   warm:false,state:'moving',queueJunction:-1,waitSeconds:0,totalWait:0,westWait:0,releaseAt:null,lastTurn:null};
  if(isStudent(car)){car.behavior=studentProfile(++this.studentOrdinal);if(this.settings.behaviorMode==='grouped'&&routingChoice){car.behaviorDecision=this.behaviorDecision(car);car.route=ROUTES[car.behaviorDecision.routeId];}}
  if(requestedAt>=0&&NORTH_BYPASS_ROUTES[routingChoice?.normalRouteId]){this.bypassStats.eligibleGenerated++;if(car.route.id!==routingChoice.normalRouteId)this.bypassStats.divertedGenerated++;}
  return car;
 }
 addWarmCar(direction,fraction,kind){
  const c=this.newCar(direction,-1,kind);let p=routeLength(c.route)*(fraction+.01);
  while(c.edgeIndex<c.route.refs.length-1&&p>=roadGeometry[currentRef(c).edge].length){p-=roadGeometry[currentRef(c).edge].length;c.edgeIndex++;}
  c.p=p;c.v=c.maxV;c.warm=true;
  if(isOutsideMap(vehiclePosition(c)))return;
  if(this.cars.some(other=>sharesSpace(other,c)&&Math.abs(other.p-c.p)<gapBetween(c,other)))return;
  this.cars.push(c);
 }
 setSettings(patch){
  const oldBypass=this.settings.northBypassShare,oldMode=this.settings.behaviorMode,oldCoverage=this.settings.guidanceCoverage;
  for(const [k,range]of Object.entries({demand:[4,50],electric:[0,100],outbound:[20,80],motorDemand:[0,20],northBypassShare:[0,100],northDemand:[0,20],guidanceCoverage:[0,100]}))
   if(k in patch&&Number.isFinite(Number(patch[k])))this.settings[k]=Math.max(range[0],Math.min(range[1],Number(patch[k])));
  if(['original','grouped'].includes(patch.behaviorMode))this.settings.behaviorMode=patch.behaviorMode;
  if(['adaptive','fixed'].includes(patch.westSignalMode)){
   if(this.westSignal&&patch.westSignalMode!==this.settings.westSignalMode){
    this.westSignal.planned=false;this.westSignal.nextReview=this.time;
    this.westSignal.reason=patch.westSignalMode==='fixed'?'切换固定配时，保留安全过渡':'切换自动调控，按拥堵重新配时';
   }
   this.settings.westSignalMode=patch.westSignalMode;
  }
  if(this.settings.northBypassShare!==oldBypass||this.settings.behaviorMode!==oldMode||this.settings.guidanceCoverage!==oldCoverage){if(this.cars)this.initializeBehavior();this.rerouteForBypassShare();}
 }
 westDemand(){
  const detected={1:{queued:0,waitingWeight:0,incoming:0,oldestWait:0,blocked:0},'-1':{queued:0,waitingWeight:0,incoming:0,oldestWait:0,blocked:0}};
  for(const car of this.cars){
   const ref=currentRef(car),approach=approachFor(ref);if(!approach||approach.j!==0)continue;
   const distance=roadGeometry[ref.edge].length-9-car.p;if(distance<0)continue;
   if(distance>WEST_SIGNAL_POLICY.detectorRange&&car.queueJunction!==0)continue;
   const direction=approachControlDirection(approach),d=detected[direction],waiting=car.v<WAIT_SPEED;
   if(waiting){d.queued++;d.waitingWeight+=car.kind==='motor'?1.6:1;d.oldestWait=Math.max(d.oldestWait,car.waitSeconds);}
   else if(distance/Math.max(1,car.v)<12)d.incoming++;
   const next=car.route.refs[car.edgeIndex+1],first=next?this.entryLeader(next,car):null;
   if(first&&first.p<gapBetween(car,first))d.blocked++;
  }
  for(const d of Object.values(detected)){
   d.demand=d.queued+d.incoming;
   d.pressure=(d.waitingWeight*2+d.incoming*.55+Math.min(3,d.oldestWait/12))*(d.blocked>=d.demand&&d.demand>0?.45:1);
  }
  return detected;
 }
 signalStage(stage,phase,reason){
  const signal=this.westSignal;if(stage==='yellow'&&signal.stage==='green')signal.lastServed[signal.phase]=this.time;
  signal.stage=stage;signal.phase=phase;signal.startedAt=this.time;signal.reason=reason;
  if(stage==='yellow')signal.target=this.settings.westSignalMode==='fixed'||signal.detectors?.[-phase]?.demand>0?-phase:phase;
  if(stage==='green'){
   signal.greenStartedAt=this.time;signal.lastServed[phase]=this.time;signal.switches++;
   signal.planned=false;signal.endsAt=this.time+(this.settings.westSignalMode==='fixed'?WEST_SIGNAL_POLICY.fixedGreen:WEST_SIGNAL_POLICY.minGreen);
  }else signal.endsAt=this.time+WEST_SIGNAL_POLICY[stage];
  signal.history.push({time:this.time,stage,phase,reason});if(signal.history.length>180)signal.history.shift();
 }
 advanceWestSignal(){
  const signal=this.westSignal,policy=WEST_SIGNAL_POLICY;
  if(signal.stage==='yellow'&&this.time>=signal.endsAt-1e-8){this.signalStage('allRed',signal.phase,'全红过渡，清空路口');return;}
  if(signal.stage==='allRed'&&this.time>=signal.endsAt-1e-8){
   const demand=this.westDemand();signal.detectors=demand;
   const other=-signal.phase;
   const phase=this.settings.westSignalMode==='fixed'?other:demand[other].demand>0?other:demand[signal.phase].demand>0?signal.phase:other;
   this.signalStage('green',phase,this.settings.westSignalMode==='fixed'?'固定配时交替放行':phase===other?'切换至等待方向':'对向无需求，继续疏散');return;
  }
  if(signal.stage!=='green')return;
  if(this.settings.westSignalMode==='fixed'){
   signal.endsAt=signal.greenStartedAt+policy.fixedGreen;
   if(this.time>=signal.endsAt-1e-8)this.signalStage('yellow',signal.phase,'固定绿灯结束，黄灯过渡');
   return;
  }
  if(this.time<signal.nextReview-1e-8)return;
  signal.nextReview=this.time+policy.reviewInterval;
  const demand=this.westDemand();signal.detectors=demand;
  const current=demand[signal.phase],other=demand[-signal.phase],elapsed=this.time-signal.greenStartedAt;
  if(!signal.planned){
   const share=(current.pressure+1)/(current.pressure+other.pressure+2);
   const duration=Math.max(policy.minGreen,Math.min(policy.maxGreen,Math.round(policy.greenBudget*share)));
   signal.endsAt=signal.greenStartedAt+duration;signal.planned=true;
  }
  if(elapsed<policy.minGreen-1e-8){signal.reason='保持最低绿灯时间';return;}
  let reason=null;
  if(other.demand>0){
   if(elapsed>=policy.maxGreen-1e-8)reason='达到本轮绿灯上限，保障对向放行';
   else if(this.time-signal.lastServed[-signal.phase]>=policy.maxRed)reason='对向红灯较久，优先切换';
   else if(current.demand===0)reason='本方向已疏散，切换至有车方向';
   else if(this.time>=signal.endsAt-1e-8&&other.pressure>=current.pressure*.7)reason='本轮配时完成，切换至等待方向';
  }
  if(reason){this.signalStage('yellow',signal.phase,reason+' · 黄灯过渡');return;}
  if(this.time>=signal.endsAt-1e-8){
   const cap=other.demand>0?signal.greenStartedAt+policy.maxGreen:Infinity;
   signal.endsAt=Math.min(cap,Math.max(signal.endsAt,this.time)+policy.extension);
   signal.extensions++;signal.reason=other.demand===0?'对向无近期需求，保留当前绿灯':'本方向仍有排队，延长绿灯';
  }
 }
 control(j,direction){
  if(j===0){
   const s=this.westSignal,own=s.phase===direction,remaining=Math.max(1,Math.ceil(s.endsAt-this.time-1e-8));
   const color=s.stage==='green'&&own?'green':s.stage==='yellow'&&own?'yellow':'red';
   let redRemaining=s.stage==='green'?remaining+5:s.stage==='yellow'?remaining+2:remaining;
   if(s.stage!=='green'&&direction!==s.target){
    const current=s.detectors?.[s.target]?.pressure??0,other=s.detectors?.[-s.target]?.pressure??0;
    const predicted=Math.max(WEST_SIGNAL_POLICY.minGreen,Math.min(WEST_SIGNAL_POLICY.maxGreen,Math.round(WEST_SIGNAL_POLICY.greenBudget*(current+1)/(current+other+2))));
    redRemaining+=(this.settings.westSignalMode==='fixed'?WEST_SIGNAL_POLICY.fixedGreen:predicted)+5;
   }
   return {open:color==='green',color,remaining:color==='red'?redRemaining:remaining,direction,estimated:color==='red',
    waitingForDemand:color==='red'&&this.settings.westSignalMode==='adaptive'&&s.detectors?.[direction]?.demand===0,mode:this.settings.westSignalMode};
  }
  const phase=(this.time+junctions[j].offset+(direction===-1?30:0))%60,open=phase<45;
  return {open,color:open?'green':'red',remaining:Math.ceil(open?45-phase:60-phase),direction};
 }
 isOpen(j,direction){return this.control(j,direction).open;}
 step(dt){if(!(dt>0)||!Number.isFinite(dt))return;while(dt>1e-8){const slice=Math.min(.1,dt);this.tick(slice);dt-=slice;}}
 entryLeader(ref,exclude){
  const key=laneKeyFor(ref,exclude.kind);
  return this.cars.filter(c=>c!==exclude&&carriagewayKey(c)===key).sort((a,b)=>a.p-b.p)[0];
 }
 tryLaneChange(car,group){
  const road=roadGeometry[currentRef(car).edge];
  if(car.laneChange||car.queueJunction>=0||this.time-car.lastLaneChange<4||car.p<64||road.length-car.p<80)return;
  const peers=group.filter(other=>other!==car&&carriagewayKey(other)===carriagewayKey(car));
  const leader=peers.filter(other=>other.p>car.p&&(slotMask(other)&slotMask(car))).sort((a,b)=>a.p-b.p)[0];
  const obstructed=leader&&leader.p-car.p<Math.max(36,car.maxV*3)&&car.maxV>leader.maxV+.6;
  const returning=!car.passTarget&&car.lane!==car.homeLane;
  if(!obstructed&&!returning)return;
  const available=Array.from({length:4-slotWidth(car)},(_,i)=>i).filter(lane=>Math.abs(lane-car.lane)===1&&(!returning||obstructed||Math.abs(lane-car.homeLane)<Math.abs(car.lane-car.homeLane)));
  let chosen=null,best=obstructed?leader.p-car.p+8:0;
  for(const lane of available){
   const target=slotMask(car,lane),reserved=slotMask(car)|target;
   if(peers.some(other=>(occupiedMask(other)&reserved)&&Math.abs(other.p-car.p)<gapBetween(car,other)+3))continue;
   const ahead=peers.filter(other=>other.p>car.p&&(occupiedMask(other)&target)).sort((a,b)=>a.p-b.p)[0];
   const room=ahead?ahead.p-car.p:Infinity;
   if(room<gapBetween(car,ahead)+car.v*1.8)continue;
   if(room>best){chosen=lane;best=room;}
  }
  if(chosen===null)return;
  const from=car.lane;car.lane=chosen;car.lastLaneChange=this.time;
  car.laneChange={from,to:chosen,startedAt:this.time,duration:1.8,progress:0,reason:obstructed?'overtake':'return'};
  if(obstructed)car.passTarget={id:leader.id,key:carriagewayKey(car)};
  this.laneChanges++;
 }
 tick(dt){
  this.time+=dt;
  this.advanceWestSignal();
  for(const c of this.cars)if(c.laneChange){c.laneChange.progress=(this.time-c.laneChange.startedAt)/c.laneChange.duration;if(c.laneChange.progress>=1)c.laneChange=null;}
  if(this.settings.behaviorMode==='grouped'&&this.time-(this.lastBehaviorReview??-1)>=BEHAVIOR_MODEL.reviewSeconds){this.lastBehaviorReview=this.time;this.rerouteForBypassShare();}
  this.enqueueSurveyDepartures();
  if(!this.demo)for(const direction of [1,-1,0]){
   const share=direction===1?this.settings.outbound/100:1-this.settings.outbound/100;
   const motorShare=this.settings.motorDemand/Math.max(1,this.settings.demand+this.settings.motorDemand);
   const cycleDemand=direction===1&&this.departureScenario?.mode==='survey'?0:direction===0?this.settings.northDemand*(1-motorShare):this.settings.demand*share;
   const motorDemand=direction===0?this.settings.northDemand*motorShare:this.settings.motorDemand*share*(direction===1?SOURCE1_MOTOR_FACTOR:1);
   this.credit[direction]+=dt*cycleDemand/60;
   this.motorCredit[direction]+=dt*motorDemand/60;
   while(this.credit[direction]>=1){this.credit[direction]--;this.pending[direction].push(this.newCar(direction,this.time));}
   while(this.motorCredit[direction]>=1){this.motorCredit[direction]--;this.pending[direction].push(this.newCar(direction,this.time,'motor'));}
  }
  // Snapshot groups: a car is moved only once per tick, even after it enters a new edge.
  const groups=new Map();
  for(const c of this.cars){const key=carriagewayKey(c);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(c);}
  for(const lane of groups.values()){
   lane.sort((a,b)=>b.p-a.p||a.id-b.id);
   for(const c of lane){
    const ref=currentRef(c),road=roadGeometry[ref.edge],approach=approachFor(ref);
    const controlDirection=approach?approachControlDirection(approach):null;
    this.tryLaneChange(c,lane);
    let limit=Infinity,obstacleSpeed=0,cause=-1;
    const leader=lane.filter(other=>other!==c&&carriagewayKey(other)===carriagewayKey(c)&&(other.p>c.p||(other.p===c.p&&other.id<c.id))&&(sharesSpace(other,c)||other.p>road.length-ROAD_WIDTH.mergeZone||c.p>road.length-ROAD_WIDTH.mergeZone)).sort((a,b)=>a.p-b.p)[0];
    if(leader){limit=leader.p-gapBetween(c,leader);obstacleSpeed=leader.v;cause=leader.queueJunction;}
    if(approach){
     const stop=road.length-9-.001;
     if(c.p<=stop+.00001&&(!this.isOpen(approach.j,controlDirection)||this.time-this.passes[controlDirection][approach.j]<(c.kind==='motor'?1.6:1.2))&&stop<limit){
      limit=stop;obstacleSpeed=0;cause=approach.j;
     }
    }
    const nextRef=c.route.refs[c.edgeIndex+1],target=nextRef?this.entryLeader(nextRef,c):null;
    if(target&&target.p<gapBetween(c,target)+c.maxV*dt&&road.length+target.p-gapBetween(c,target)<limit){limit=road.length+target.p-gapBetween(c,target);obstacleSpeed=0;cause=approach?.j??target.queueJunction;}
    const space=Math.max(0,limit-c.p),safeSpeed=Math.sqrt(obstacleSpeed**2+2*2.4*space);
    let desired=Math.min(c.maxV,safeSpeed);
    if(nextRef&&approach&&road.length-c.p<20)desired=Math.min(desired,6.2);
    if(c.queueJunction>=0&&c.v<WAIT_SPEED&&space>1&&desired>WAIT_SPEED){
     if(c.releaseAt===null)c.releaseAt=this.time+(c.kind==='motor'?.65:.4);
     if(this.time<c.releaseAt)desired=0;
    }else if(space<=1)c.releaseAt=null;
    const velocity=desired>=c.v?Math.min(desired,c.v+1.8*dt):Math.max(desired,c.v-2.4*dt);
    const next=Math.max(c.p,Math.min(c.p+velocity*dt,limit));
    if(approach&&c.p<road.length-9&&next>=road.length-9)this.passes[controlDirection][approach.j]=this.time;
    c.v=(next-c.p)/dt;
    const reacting=c.releaseAt!==null&&this.time<c.releaseAt;
    c.queueJunction=c.v<WAIT_SPEED?(cause>=0&&space<3?cause:reacting?c.queueJunction:-1):-1;
    c.state=c.queueJunction>=0?'waiting':c.laneChange?'changing':c.passTarget?'overtaking':c.v<c.maxV*.7?'slowing':'moving';
    if(c.queueJunction>=0){c.waitSeconds+=dt;c.totalWait+=dt;if(c.queueJunction===0){c.westWait+=dt;this.westStats.queueSeconds+=dt;}}else c.waitSeconds=0;
    if(c.v>=WAIT_SPEED)c.releaseAt=null;
    c.p=next;
    if(c.passTarget){
     const passed=this.cars.find(other=>other.id===c.passTarget.id);
     if(!passed||carriagewayKey(passed)!==c.passTarget.key)c.passTarget=null;
     else if(!c.laneChange&&c.p>passed.p+gapBetween(c,passed)){c.overtakes++;this.overtakes++;c.lastOvertake=this.time;c.passTarget=null;}
    }
    if(nextRef&&c.p>=road.length){
     if(approach){const turn=c.route.turns.find(t=>t.j===approach.j);if(turn){this.turnCounts[turn.j][turn.movement]++;c.lastTurn={...turn,time:this.time};}if(approach.j===0){this.westStats.passed++;this.westStats.waitSum+=c.westWait;c.westWait=0;}}
     c.p-=road.length;c.edgeIndex++;c.queueJunction=-1;c.waitSeconds=0;c.laneChange=null;c.passTarget=null;
    }
   }
  }
  for(const direction of [1,-1,0])if(this.pending[direction].length){
   const c=this.pending[direction][0],first=this.entryLeader(currentRef(c),c);
   if(!first||first.p>=gapBetween(first,c)){this.pending[direction].shift();if(c.surveyDepartureId!==undefined&&this.surveyDepartures){this.surveyDepartures.entered++;c.enteredAt=this.time;}c.v=first?Math.min(c.maxV,first.v):c.maxV;this.cars.push(c);}
  }
  this.cars=this.cars.filter(c=>{
   if(!isOutsideMap(vehiclePosition(c)))return true;
   if(c.surveyDepartureId!==undefined&&this.surveyDepartures)this.surveyDepartures.completed++;
   this.exited++;this.exitCounts[c.route.exit]++;
   if(!c.warm){this.completed++;this.completedByKind[c.kind]++;this.travelSum+=this.time-c.requestedAt;}
   return false;
  });
  if(Math.floor(this.time/5)>this.lastSample){
   this.lastSample=Math.floor(this.time/5);const m=this.metrics();this.history.push({time:this.time,queue:m.queued,active:m.active});
   if(this.history.length>180)this.history.shift();
  }
 }
 metrics(){
  const queues=junctions.map(()=>({total:0,forward:0,reverse:0,maxWait:0}));let queued=0,electric=0,motor=0;
  for(const c of this.cars){
   if(c.kind==='electric')electric++;if(c.kind==='motor')motor++;
   if(c.queueJunction>=0){queued++;const q=queues[c.queueJunction],approach=approachFor(currentRef(c));q.total++;q[approach&&approachControlDirection(approach)===1?'forward':'reverse']++;q.maxWait=Math.max(q.maxWait,c.waitSeconds);}
  }
  return {time:this.time,active:this.cars.length,queued,electric,motor,bicycle:this.cars.length-electric-motor,completed:this.completed,exited:this.exited,laneChanges:this.laneChanges,overtakes:this.overtakes,
   exitCounts:{...this.exitCounts},turnCounts:this.turnCounts.map(t=>({...t})),completedByKind:{...this.completedByKind},
   northBypass:{share:this.settings.northBypassShare,active:this.cars.filter(c=>c.route.refs.some(ref=>ref.edge==='northConnector')).length,...this.bypassStats},
   averageTravel:this.completed?this.travelSum/this.completed:null,pending:Object.values(this.pending).reduce((sum,cars)=>sum+cars.length,0),
   westSignal:{mode:this.settings.westSignalMode,stage:this.westSignal.stage,phase:this.westSignal.phase,reason:this.westSignal.reason,
    remaining:Math.max(1,Math.ceil(this.westSignal.endsAt-this.time-1e-8)),switches:this.westSignal.switches,extensions:this.westSignal.extensions,
    detectors:this.westSignal.detectors?structuredClone(this.westSignal.detectors):null,
    averageQueue:this.time?this.westStats.queueSeconds/this.time:0,averageWait:this.westStats.passed?this.westStats.waitSum/this.westStats.passed:0,...this.westStats},
   queues:queues.map((q,i)=>({...q,name:junctions[i].name,id:junctions[i].id,forwardControl:this.control(i,1),reverseControl:this.control(i,-1)}))};
 }
 snapshot(){
  return {schemaVersion:16,behavior:this.behaviorState(),source:'synthetic-simulation',clock:this.clockState(),departureScenario:this.departureState(),departureSchedule:this.surveyDepartures?structuredClone(this.surveyDepartures.plan):null,demo:this.demo,settings:{...this.settings},metrics:this.metrics(),westSignal:structuredClone(this.westSignal),
   network:{edges:EDGES,routes:ROUTES,westSignalPolicy:WEST_SIGNAL_POLICY,roadWidth:ROAD_WIDTH,motorRule:MOTOR_ROAD,middleRoadRule:MIDDLE_ROAD,dichenRoadRule:DICHEN_ROAD,exits:EXITS,junctions:junctions.map(({id,name,x,y})=>({id,name,x,y}))},
   vehicles:this.cars.map(c=>({id:c.id,kind:c.kind,origin:c.route.origin,direction:c.direction,routeId:c.route.id,exit:c.route.exit,
    edge:currentRef(c).edge,edgeDirection:currentRef(c).direction,progress:c.p,totalProgress:totalProgress(c),speed:c.v,state:c.state,
    lane:c.lane,occupiedSlots:occupiedSlots(c),slotWidth:slotWidth(c),laneChange:c.laneChange?{...c.laneChange}:null,overtakes:c.overtakes,
    queueJunction:c.queueJunction,waitSeconds:c.waitSeconds,totalWait:c.totalWait,surveyDepartureId:c.surveyDepartureId??null,surveyCategory:c.surveyCategory??null,enteredAt:c.enteredAt??null,...vehiclePosition(c)}))};
 }
}
export function createOvertakingDemo(settings={}){
 const sim=new Simulation({settings});sim.cars=[];sim.demo=true;
 const add=(kind,p,lane,speed)=>{const car=sim.newCar(1,-1,kind,'1-south');car.edgeIndex=1;car.p=p;car.lane=lane;car.homeLane=lane;car.maxV=speed;car.v=speed;car.warm=true;sim.cars.push(car);return car;};
 add('bicycle',123,1,5);add('electric',100,1,10);
 for(let lane=0;lane<3;lane++)add(lane===1?'electric':'bicycle',270,lane,6.8);
 add('motor',385,0,7);add('bicycle',385,2,7);
 return sim;
}
