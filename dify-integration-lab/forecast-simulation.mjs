import {createHash} from 'node:crypto';
import {Simulation,carriagewayKey,laneKeyFor,roadGeometry,currentRef,slotMask,slotWidth,occupiedMask,gapBetween,approachFor,approachControlDirection,BEHAVIOR_MODEL,SOURCE1_MOTOR_FACTOR,ROAD_WIDTH,WAIT_SPEED,isOutsideMap,vehiclePosition,lanePosition,pointOnEdge} from '../traffic-sandbox/dist/engine.mjs';
import {MAP} from '../traffic-sandbox/dist/route.mjs';
// Numerical Worker only: retain the original 0.1 s steps, update order and rules.
// A changed reference implementation uses the original engine until revalidated.
const fingerprint=fn=>createHash('sha256').update(fn.toString().replaceAll('\r\n','\n')).digest('hex');
export const FORECAST_FAST_PATH_AVAILABLE=[[Simulation.prototype.tick,'bf7bfce779b176ccebe1813715c66c2c48fbbe79755075c3654b1bb2520cad9e'],[Simulation.prototype.tryLaneChange,'baa8875f12d5a117f9baefbf5f2e22bc2059c5b4de9913be92473134ef8bc77a'],[vehiclePosition,'e2e66f6ca5a378ff30cb7c36499d5eedd3877d0da5297dca9f6219709cce5651'],[lanePosition,'8be6a50de6b23d45d8eec21138fbf9da5a67c628707d14925cbec9eb26b717df'],[pointOnEdge,'b59350fe1013e76e0ac0864157d10d91dfb0d6cfaf1f4d421c54d13d12ee2039'],[isOutsideMap,'1fab44bf876a2fbfd7921b59635a3e1ad108bf62cc65adfe934d4f9ca908cb5b']].every(([fn,expected])=>fingerprint(fn)===expected);
const indexes=new WeakMap();
const watchers=new WeakMap();
// A conservative envelope covers both offsets in pointOnEdge/lanePosition,
// direction separation, all legal lanes and the entire lane-change interpolation.
// Boundary roads still use the exact reference coordinate calculation.
const interiorEdges=new Set(Object.entries(roadGeometry).filter(([,road])=>{
 const radius=2*Math.max(4,Math.abs(road.lateralOffset??0))+Math.abs(ROAD_WIDTH.directionOffset)+Math.abs(ROAD_WIDTH.separationOffset)+Math.abs(ROAD_WIDTH.slotSpacing)*(ROAD_WIDTH.slots+Math.max(...Object.values(ROAD_WIDTH.vehicleWidths)))/2;
 const points=[...road.points,...(road.motorPoints??[]),...Object.values(road.directionPoints??{}).flat()];
 return points.every(([x,y])=>x-radius>=-6&&x+radius<=MAP.width+6&&y-radius>=-6&&y+radius<=MAP.height+6);
}).map(([edge])=>edge));
function isInsideMap(car){
 const lane=car.lane??1,from=car.laneChange?.from??lane,width=slotWidth(car);
 if(lane>=0&&lane+width<=ROAD_WIDTH.slots&&from>=0&&from+width<=ROAD_WIDTH.slots&&interiorEdges.has(currentRef(car).edge))return true;
 return !isOutsideMap(vehiclePosition(car));
}
function nearer(a,b,index){return !b||a.p<b.p||(a.p===b.p&&index.order.get(a)<index.order.get(b));}
function buildIndex(sim){
 const index={buckets:new Map(),keys:new Map(),order:new Map(),minima:new Map(),byId:new Map()};
 for(let i=0;i<sim.cars.length;i++)updateIndex(index,sim.cars[i],i);
 return index;
}
function updateIndex(index,car,order){
 const old=index.keys.get(car),key=carriagewayKey(car);
 if(order!==undefined){index.order.set(car,order);if(!index.byId.has(car.id))index.byId.set(car.id,car);}
 const minimum=index.minima.get(old);
 if(minimum?.car===car&&(old!==key||minimum.p!==car.p))index.minima.delete(old);
 if(old!==key){
  if(old!==undefined)index.buckets.get(old).delete(car);
  if(!index.buckets.has(key))index.buckets.set(key,new Set());
  index.buckets.get(key).add(car);index.keys.set(car,key);
 }
 const current=index.minima.get(key);
 if(current&&nearer(car,current.car,index))index.minima.set(key,{car,p:car.p});
}
function nearestMatching(cars,predicate){let first;for(const car of cars)if(predicate(car)&&(!first||car.p<first.p))first=car;return first;}
function closest(a,b){return !b||a.car.p<b.car.p||(a.car.p===b.car.p&&a.rank<b.rank);}
function strictRawLeader(car,ahead,fallback){
 if(!ahead)return fallback();
 let first;const mask=slotMask(car);
 for(let slot=0;slot<3;slot++){const candidate=ahead.rawSlots[slot];if((mask&(1<<slot))&&candidate&&closest(candidate,first))first=candidate;}
 // Lane changes use strictly greater positions, whereas movement also accepts
 // equal positions with smaller ids. Preserve that distinction for ties.
 return first&&first.car.p<=car.p?fallback():first?.car;
}
function indexedLeader(car,road,ahead){
 if(car.p>road.length-ROAD_WIDTH.mergeZone)return ahead.any?.car;
 let first=ahead.merge;const mask=occupiedMask(car);
 for(let slot=0;slot<3;slot++){const candidate=ahead.slots[slot];if((mask&(1<<slot))&&candidate&&closest(candidate,first))first=candidate;}
 return first?.car;
}
function rememberAhead(car,road,ahead){
 // In the original descending position/id order, only already-moved cars can
 // lead the next car. Their positions no longer change during this tick.
 const candidate={car,rank:ahead.sequence++},mask=occupiedMask(car),raw=slotMask(car);
 if(closest(candidate,ahead.any))ahead.any=candidate;
 if(car.p>road.length-ROAD_WIDTH.mergeZone&&closest(candidate,ahead.merge))ahead.merge=candidate;
 for(let slot=0;slot<3;slot++){
  if((mask&(1<<slot))&&closest(candidate,ahead.slots[slot]))ahead.slots[slot]=candidate;
  if((raw&(1<<slot))&&closest(candidate,ahead.rawSlots[slot]))ahead.rawSlots[slot]=candidate;
 }
}
export class ForecastSimulation extends Simulation{
 watchVehicle(car){watchers.set(this,{car,active:this.cars.includes(car)});}
 hasVehicle(car){const watch=watchers.get(this);return FORECAST_FAST_PATH_AVAILABLE&&watch?.car===car?watch.active:this.cars.includes(car);}
 entryLeader(ref,exclude){
  const index=indexes.get(this);if(!index)return super.entryLeader(ref,exclude);
  const key=laneKeyFor(ref,exclude.kind),cached=index.minima.get(key);
  if(cached&&cached.car!==exclude)return cached.car;
  let first;
  for(const car of index.buckets.get(key)??[])if(car!==exclude&&nearer(car,first,index))first=car;
  if(first&&(!cached||cached.car!==exclude))index.minima.set(key,{car:first,p:first.p});
  return first;
 }
 tryLaneChange(car,group){
  if(!FORECAST_FAST_PATH_AVAILABLE)return super.tryLaneChange(car,group);
  const road=roadGeometry[currentRef(car).edge];
  if(car.laneChange||car.queueJunction>=0||this.time-car.lastLaneChange<4||car.p<64||road.length-car.p<80)return;
  const index=indexes.get(this),keys=index?.keys,key=keys?.get(car)??carriagewayKey(car);
  let peers;const getPeers=()=>peers??=(group.filter(other=>other!==car&&(keys?.get(other)??carriagewayKey(other))===key));
  const leader=strictRawLeader(car,index?.ahead,()=>nearestMatching(getPeers(),other=>other.p>car.p&&(slotMask(other)&slotMask(car))));
  const obstructed=leader&&leader.p-car.p<Math.max(36,car.maxV*3)&&car.maxV>leader.maxV+.6;
  const returning=!car.passTarget&&car.lane!==car.homeLane;
  if(!obstructed&&!returning)return;
  getPeers();
  const available=Array.from({length:4-slotWidth(car)},(_,i)=>i).filter(lane=>Math.abs(lane-car.lane)===1&&(!returning||obstructed||Math.abs(lane-car.homeLane)<Math.abs(car.lane-car.homeLane)));
  let chosen=null,best=obstructed?leader.p-car.p+8:0;
  for(const lane of available){
   const target=slotMask(car,lane),reserved=slotMask(car)|target;
   if(peers.some(other=>(occupiedMask(other)&reserved)&&Math.abs(other.p-car.p)<gapBetween(car,other)+3))continue;
   const ahead=nearestMatching(peers,other=>other.p>car.p&&(occupiedMask(other)&target));
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
  if(!FORECAST_FAST_PATH_AVAILABLE)return super.tick(dt);
  const index=buildIndex(this),watch=watchers.get(this);indexes.set(this,index);
  try{
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
   const ahead={slots:[null,null,null],rawSlots:[null,null,null],any:null,merge:null,sequence:0};index.ahead=ahead;
   lane.sort((a,b)=>b.p-a.p||a.id-b.id);
   for(const c of lane){
    const ref=currentRef(c),road=roadGeometry[ref.edge],approach=approachFor(ref);
    const controlDirection=approach?approachControlDirection(approach):null;
    this.tryLaneChange(c,lane);
    let limit=Infinity,obstacleSpeed=0,cause=-1;
    const leader=indexedLeader(c,road,ahead);
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
     const passed=index.byId.get(c.passTarget.id);
     if(!passed||carriagewayKey(passed)!==c.passTarget.key)c.passTarget=null;
     else if(!c.laneChange&&c.p>passed.p+gapBetween(c,passed)){c.overtakes++;this.overtakes++;c.lastOvertake=this.time;c.passTarget=null;}
    }
    if(nextRef&&c.p>=road.length){
     if(approach){const turn=c.route.turns.find(t=>t.j===approach.j);if(turn){this.turnCounts[turn.j][turn.movement]++;c.lastTurn={...turn,time:this.time};}if(approach.j===0){this.westStats.passed++;this.westStats.waitSum+=c.westWait;c.westWait=0;}}
     c.p-=road.length;c.edgeIndex++;c.queueJunction=-1;c.waitSeconds=0;c.laneChange=null;c.passTarget=null;
    }
    updateIndex(index,c);
    if(index.keys.get(c)===laneKeyFor(ref,c.kind))rememberAhead(c,road,ahead);
   }
  }
  for(const direction of [1,-1,0])if(this.pending[direction].length){
   const c=this.pending[direction][0],first=this.entryLeader(currentRef(c),c);
   if(!first||first.p>=gapBetween(first,c)){this.pending[direction].shift();if(c.surveyDepartureId!==undefined&&this.surveyDepartures){this.surveyDepartures.entered++;c.enteredAt=this.time;}c.v=first?Math.min(c.maxV,first.v):c.maxV;this.cars.push(c);if(watch?.car===c)watch.active=true;updateIndex(index,c,this.cars.length-1);}
  }
  this.cars=this.cars.filter(c=>{
   if(isInsideMap(c))return true;
   if(watch?.car===c)watch.active=false;
   if(c.surveyDepartureId!==undefined&&this.surveyDepartures)this.surveyDepartures.completed++;
   this.exited++;this.exitCounts[c.route.exit]++;
   if(!c.warm){this.completed++;this.completedByKind[c.kind]++;this.travelSum+=this.time-c.requestedAt;}
   return false;
  });
  if(Math.floor(this.time/5)>this.lastSample){
   this.lastSample=Math.floor(this.time/5);const m=this.metrics();this.history.push({time:this.time,queue:m.queued,active:m.active});
   if(this.history.length>180)this.history.shift();
  }
  }finally{indexes.delete(this);}
 }
}
