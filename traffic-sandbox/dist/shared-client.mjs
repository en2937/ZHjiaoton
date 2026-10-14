import {roadGeometry} from './engine.mjs';

// Play confirmed snapshots on the simulation clock. Packet arrival never retimes a vehicle.
export function createVehicleInterpolator({enabled=true,maxGapMs=1000,bufferMs=350}={}){
 let latest=null,cars=[],samples=[],playhead=0,lastPaintAt=0,warmAt=0,receivedAt=0,snapNext=true,starved=false;
 const routeLengths=new WeakMap();
 function lengths(route){
  let result=routeLengths.get(route);
  if(!result){result=[0];for(const ref of route.refs)result.push(result.at(-1)+roadGeometry[ref.edge].length);routeLengths.set(route,result);}
  return result;
 }
 function lane(car){
  const change=car.laneChange;if(!change)return car.lane??1;
  const t=Math.max(0,Math.min(1,change.progress));return change.from+(car.lane-change.from)*t*t*(3-2*t);
 }
 function fitsRoute(car,route){
  return car.route.refs.slice(0,car.edgeIndex+1).every((ref,i)=>{
   const other=route.refs[i];return other&&ref.edge===other.edge&&ref.direction===other.direction;
  });
 }
 function compatible(a,b){return a.kind===b.kind&&a.edgeIndex<=b.edgeIndex&&fitsRoute(a,b.route);}
 function progress(car,route){return lengths(route)[car.edgeIndex]+car.p;}
 function value(car,route,lateral){return lateral?lane(car):progress(car,route);}
 function tangent(index,id,route,lateral){
  const sample=samples[index],car=sample.byId.get(id),centre=value(car,route,lateral),slopes=[];
  for(const neighborIndex of [index-1,index+1]){
   const neighbor=samples[neighborIndex],other=neighbor?.byId.get(id);
   if(!other||other.kind!==car.kind||!fitsRoute(other,route))continue;
   const delta=neighbor.time-sample.time;if(delta===0)continue;
   const slope=(value(other,route,lateral)-centre)/delta;
   if(!lateral&&slope<0)continue;slopes.push(slope);
  }
  if(!slopes.length)return 0;
  // Shared node tangents give continuous velocity and keep curves within both samples.
  if(slopes.some(slope=>Math.abs(slope)<1e-9)||slopes.length===2&&slopes[0]*slopes[1]<=0)return 0;
  const estimated=slopes.length===1?slopes[0]:2*slopes[0]*slopes[1]/(slopes[0]+slopes[1]);
  const desired=lateral?estimated:Number.isFinite(car.v)?Math.max(0,car.v):estimated;
  return Math.sign(desired)*Math.min(Math.abs(desired),2*Math.min(...slopes.map(Math.abs)));
 }
 function curve(a,b,va,vb,u,dt){
  const u2=u*u,u3=u2*u;
  return a+(b-a)*(3*u2-2*u3)+dt*(va*(u3-2*u2+u)+vb*(u3-u2));
 }
 function advanceClock(now){
  if(now<=warmAt||samples.length<2)return playhead;
  const elapsed=Math.max(0,now-Math.max(lastPaintAt,warmAt));lastPaintAt=Math.max(lastPaintAt,now);
  playhead=Math.min(samples.at(-1).time,playhead+elapsed*latest.speed/1000);
  starved=playhead>=samples.at(-1).time-1e-9;
  return playhead;
 }
 function carsAt(now){
  if(!enabled||!latest?.running||samples.length<2)return cars;
  const time=advanceClock(now);let index=0;
  while(index<samples.length-2&&samples[index+1].time<=time)index++;
  const left=samples[index],right=samples[index+1],dt=right.time-left.time;
  const u=Math.max(0,Math.min(1,(time-left.time)/dt));
  return cars.map(current=>{
   const from=left.byId.get(current.id),to=right.byId.get(current.id);
   if(!from||!to){
    // Spawn once at its first confirmed position; never rewind a newly visible vehicle.
    for(const sample of samples){const first=sample.byId.get(current.id);if(first)return first;}
    return current;
   }
   if(!compatible(from,to)||!fitsRoute(to,current.route))return current;
   const route=to.route,a=progress(from,route),b=progress(to,route);if(b<a)return current;
   const v0=tangent(index,current.id,route,false),v1=tangent(index+1,current.id,route,false);
   const distance=Math.max(a,Math.min(b,curve(a,b,v0,v1,u,dt))),cumulative=lengths(route);
   let edgeIndex=from.edgeIndex;
   while(edgeIndex<route.refs.length-1&&distance>=cumulative[edgeIndex+1])edgeIndex++;
   const fromLane=lane(from),toLane=lane(to),lateral=curve(fromLane,toLane,tangent(index,current.id,route,true),tangent(index+1,current.id,route,true),u,dt);
   return {...(u<1?from:to),route,edgeIndex,p:distance-cumulative[edgeIndex],lane:Math.max(Math.min(fromLane,toLane),Math.min(Math.max(fromLane,toLane),lateral)),laneChange:null};
  });
 }
 return {
  accept(packet,now=performance.now()){
   const snap=snapNext||!enabled||!latest||!packet.running||packet.running!==latest.running||packet.speed!==latest.speed||
    packet.instanceId!==latest.instanceId||packet.runId!==latest.runId||now-receivedAt>maxGapMs||
    packet.simulation.time<latest.simulation.time;
   const sample={time:packet.simulation.time,byId:new Map(packet.simulation.cars.map(car=>[car.id,car]))};
   if(snap){samples=[sample];playhead=sample.time;warmAt=now+bufferMs;lastPaintAt=warmAt;starved=false;}
   else{
    if(starved&&sample.time>samples.at(-1).time){warmAt=now+bufferMs/2;lastPaintAt=warmAt;starved=false;}
    if(sample.time===samples.at(-1).time)samples[samples.length-1]=sample;else samples.push(sample);
    if(samples.length>12)samples.shift();
   }
   latest=packet;cars=packet.simulation.cars;receivedAt=now;snapNext=false;
  },
  carsAt,
  hasMotion:now=>enabled&&Boolean(latest?.running)&&samples.length>1&&playhead<samples.at(-1).time-1e-9,
  reset(){samples=[];snapNext=true;starved=false;},
  setEnabled(value){enabled=Boolean(value);samples=[];snapNext=true;starved=false;}
 };
}

export function createSharedClient({fetcher=fetch,onState=()=>{},onError=()=>{},intervalMs=150,controlHeaders}={}){
 let last=null,stopped=false,polling=false,queue=Promise.resolve();
 async function json(response){const data=await response.json();if(!response.ok){if(data.authRequired&&globalThis.location)globalThis.location.assign(data.loginUrl||'/login');throw new Error(data.message||'操作暂不可用');}return data;}
 async function headers(){if(controlHeaders)return controlHeaders();const session=await json(await fetcher('/api/admin/session',{signal:AbortSignal.timeout(4000)}));return {'X-CSRF-Token':session.csrfToken};}
 function accept(packet){
  if(packet?.schemaVersion!==1||!packet.simulation)throw new Error('共享沙盘状态无法读取');
  if(last&&last.instanceId===packet.instanceId&&packet.revision<last.revision)return;
  last=packet;onState(packet);
 }
 async function read(){if(polling||stopped)return;polling=true;
  try{const response=await fetcher('/api/simulation',{signal:AbortSignal.timeout(4000)});accept(await json(response));}
  catch(error){onError(error);}finally{polling=false;}
 }
 function command(body){queue=queue.then(async()=>{
  const authHeaders=await headers();
  const response=await fetcher('/api/control',{method:'POST',headers:{'Content-Type':'application/json',...authHeaders},body:JSON.stringify(body),signal:AbortSignal.timeout(['departureScenario','reset'].includes(body.action)?60000:4000)});
  const data=await json(response);accept(data);return data;
 }).catch(error=>{onError(error);return null;});return queue;}
 let timer;
 return {command,read,start(){stopped=false;void read();timer=setInterval(read,intervalMs);},stop(){stopped=true;clearInterval(timer);}};
}
