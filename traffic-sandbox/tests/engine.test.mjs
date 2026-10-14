import test from 'node:test';
import assert from 'node:assert/strict';
import {MAP,EDGES,ROUTES,EXITS,APPROACHES,NORTH_BYPASS_ROUTES} from '../dist/route.mjs';
import {Simulation,ROAD_WIDTH,WEST_SIGNAL_POLICY,roadGeometry,pointOnEdge,lanePosition,vehiclePosition,currentRef,laneKey,carriagewayKey,sharesSpace,occupiedSlots,slotRange,createOvertakingDemo,routeLength,totalProgress,isOutsideMap,gapBetween} from '../dist/engine.mjs';

function checkRoadGaps(sim){
 const lanes=new Map();for(const c of sim.cars){const k=carriagewayKey(c);if(!lanes.has(k))lanes.set(k,[]);lanes.get(k).push(c);}
 for(const lane of lanes.values())for(let i=0;i<lane.length;i++)for(let j=i+1;j<lane.length;j++)if(sharesSpace(lane[i],lane[j]))assert(Math.abs(lane[i].p-lane[j].p)>=gapBetween(lane[i],lane[j])-1e-6,'occupied-space gap '+laneKey(lane[i])+' '+laneKey(lane[j]));
}
function isolated(){const sim=new Simulation({settings:{demand:4,motorDemand:0,northDemand:0}});sim.cars=[];sim.settings.demand=0;return sim;}
function onWideRoad(sim,kind,p,lane,speed=6){
 const car=sim.newCar(1,0,kind,'1-south');car.edgeIndex=1;car.p=p;car.lane=lane;car.homeLane=lane;car.v=speed;car.maxV=speed;sim.cars.push(car);return car;
}

const constantDemand=(forward=1,reverse=1)=>({
 1:{queued:forward,waitingWeight:forward,incoming:0,oldestWait:0,blocked:0,demand:forward,pressure:forward*2},
 '-1':{queued:reverse,waitingWeight:reverse,incoming:0,oldestWait:0,blocked:0,demand:reverse,pressure:reverse*2}
});
test('A signals never give both directions green and include complete yellow/all-red transitions',()=>{
 const sim=isolated();sim.westDemand=()=>constantDemand();
 for(let i=0;i<3000;i++){sim.step(.1);assert(!(sim.control(0,1).open&&sim.control(0,-1).open));}
 const history=sim.westSignal.history;
 assert(history.length>12);
 for(let i=0;i<history.length-1;i++){
  const event=history[i],next=history[i+1],duration=next.time-event.time;
  if(event.stage==='green'){assert.equal(next.stage,'yellow');assert(duration>=WEST_SIGNAL_POLICY.minGreen-.2&&duration<=WEST_SIGNAL_POLICY.maxGreen+.2);}
  if(event.stage==='yellow'){assert.equal(next.stage,'allRed');assert(Math.abs(duration-WEST_SIGNAL_POLICY.yellow)<.2);}
  if(event.stage==='allRed'){assert.equal(next.stage,'green');assert.notEqual(next.phase,event.phase);assert(Math.abs(duration-WEST_SIGNAL_POLICY.allRed)<.2);}
 }
});
test('an empty green direction yields to an actual queued vehicle after its minimum green',()=>{
 const sim=isolated(),car=sim.newCar(-1,0,'electric','2-west-north');
 car.edgeIndex=car.route.refs.findIndex(ref=>ref.edge==='linkWest');car.p=roadGeometry.linkWest.length-9-.01;car.lane=1;car.v=0;car.queueJunction=0;sim.cars=[car];
 for(let i=0;i<240;i++){sim.step(.1);assert.equal(currentRef(car).edge,'linkWest');}
 assert(!sim.isOpen(0,-1));
 sim.step(8);assert.notEqual(currentRef(car).edge,'linkWest');assert.equal(sim.westStats.passed,1);
 const first=sim.westSignal.history.find(event=>event.stage==='green'&&event.phase===-1);
 assert(first.time>=25-.2&&first.time<=26.2,'minimum green and clearance precede the new green');
});
test('a heavily loaded direction cannot indefinitely starve the lighter direction',()=>{
 const sim=isolated();sim.westDemand=()=>constantDemand(50,1);
 for(let i=0;i<400;i++)sim.step(1);
 const greens=sim.westSignal.history.filter(event=>event.stage==='green'&&event.phase===-1);
 assert(greens.length>=4);
 for(let i=1;i<greens.length;i++){
  const ended=sim.westSignal.history.find(event=>event.stage==='yellow'&&event.phase===-1&&event.time>greens[i-1].time);
  assert(greens[i].time-ended.time<=WEST_SIGNAL_POLICY.maxRed+5+.2);
 }
 assert(sim.westSignal.history.some(event=>event.reason?.includes('上限')));
});
test('changing signal mode preserves the safe current transition and reads or pauses do not advance it',()=>{
 const sim=isolated();sim.westDemand=()=>constantDemand();for(let i=0;i<1000&&sim.westSignal.stage!=='yellow';i++)sim.step(.1);
 assert.equal(sim.westSignal.stage,'yellow');sim.setSettings({westSignalMode:'fixed'});assert.equal(sim.westSignal.stage,'yellow');
 const snapshot=sim.snapshot();sim.metrics();sim.control(0,1);sim.control(0,-1);sim.step(0);
 assert.deepEqual(sim.snapshot(),snapshot);
 sim.step(5);assert.equal(sim.westSignal.stage,'green');assert.equal(sim.westSignal.phase,-1);
 assert.equal(sim.settings.westSignalMode,'fixed');sim.setSettings({westSignalMode:'invalid'});assert.equal(sim.settings.westSignalMode,'fixed');
});

test('width permits three cycles or one motor plus one cycle, while two motors share occupied space',()=>{
 const three=isolated(),cars=[0,1,2].map(lane=>onWideRoad(three,'bicycle',160,lane));
 for(let i=0;i<cars.length;i++)for(let j=i+1;j<cars.length;j++)assert(!sharesSpace(cars[i],cars[j]));
 for(let i=0;i<20;i++){three.step(.1);checkRoadGaps(three);}
 assert(Math.max(...cars.map(c=>c.p))-Math.min(...cars.map(c=>c.p))<1e-6,'three vehicles remain abreast');
 const positions=cars.map(vehiclePosition);
 assert(Math.hypot(positions[0].x-positions[1].x,positions[0].y-positions[1].y)>4);
 const mixed=isolated(),motor=onWideRoad(mixed,'motor',160,0),cycle=onWideRoad(mixed,'electric',160,2);
 assert(!sharesSpace(motor,cycle));
 for(let i=0;i<20;i++){mixed.step(.1);checkRoadGaps(mixed);}
 assert(Math.abs(motor.p-cycle.p)<1e-6);
 const otherMotor={...motor,lane:1};assert(sharesSpace(motor,otherMotor),'two motors cannot fit side by side');
 assert.deepEqual(occupiedSlots(motor),[0,1]);assert.deepEqual(occupiedSlots(cycle),[2]);
});
test('fast traffic changes smoothly, reserves both columns, passes a slower vehicle and returns',()=>{
 const sim=createOvertakingDemo(),fast=sim.cars.find(c=>c.kind==='electric'&&c.p===100),slow=sim.cars.find(c=>c.p===123);
 let changing=false,reserved=false,previous=vehiclePosition(fast);
 for(let i=0;i<300;i++){
  sim.step(.1);checkRoadGaps(sim);
  const position=vehiclePosition(fast);
  assert(Math.hypot(position.x-previous.x,position.y-previous.y)<2,'lane change does not teleport');
  previous=position;
  if(fast.laneChange){changing=true;if(occupiedSlots(fast).length>=2)reserved=true;}
 }
 assert(changing&&reserved);assert(fast.p>slow.p);assert.equal(fast.overtakes,1);assert.equal(sim.overtakes,1);
 assert.equal(fast.lane,fast.homeLane);assert.equal(sim.metrics().laneChanges,2);
 assert.equal(sim.pending[1].length,0,'preset demo creates no new arrivals');
});
test('blocked neighbouring columns and a close rear vehicle prevent unsafe overtaking',()=>{
 const sim=isolated(),slow=onWideRoad(sim,'bicycle',125,1,5),fast=onWideRoad(sim,'electric',100,1,10);
 onWideRoad(sim,'bicycle',101,0,6);onWideRoad(sim,'bicycle',96,2,8);
 sim.step(.1);assert.equal(fast.laneChange,null);assert.equal(fast.lane,1);checkRoadGaps(sim);
 assert(fast.p<slow.p);
});
test('road endpoints stay continuous for all slots and type-specific carriageway rules remain valid',()=>{
 for(const route of Object.values(ROUTES))for(const kind of ['electric','bicycle','motor'])for(let lane=0;lane<=3-ROAD_WIDTH.vehicleWidths[kind];lane++){
  const lateral=(lane+(ROAD_WIDTH.vehicleWidths[kind]-1)/2-1)*ROAD_WIDTH.slotSpacing;
  for(let i=1;i<route.refs.length;i++){
   const a=route.refs[i-1],b=route.refs[i],p=lanePosition(a.edge,roadGeometry[a.edge].length,a.direction,kind,lateral),q=lanePosition(b.edge,0,b.direction,kind,lateral);
   assert(Math.hypot(p.x-q.x,p.y-q.y)<1e-7,route.id+' '+kind+' slot '+lane+' is continuous');
  }
 }
 for(const direction of [1,-1]){
  const road=roadGeometry.middleRoad,p=road.length*.5;
  const cycles=[0,1,2].map(lane=>lanePosition('middleRoad',p,direction,'bicycle',(lane-1)*ROAD_WIDTH.slotSpacing));
  const motors=[0,1].map(lane=>lanePosition('middleRoad',p,direction,'motor',(lane-.5)*ROAD_WIDTH.slotSpacing));
  assert(Math.max(...cycles.map(p=>p.x))<Math.min(...motors.map(p=>p.x)),'types keep western/eastern sides after widening');
 }
});
test('widened slot positions do not jump at internal polyline corners',()=>{
 for(const [edge,road]of Object.entries(roadGeometry))for(const direction of [1,-1])for(const kind of ['bicycle','motor']){
  const lateral=kind==='motor'?-2.4:4.8;
  for(const s of road.cumulative.slice(1,-1)){
   const progress=direction===1?s:road.length-s;
   const a=lanePosition(edge,progress-1e-6,direction,kind,lateral),b=lanePosition(edge,progress+1e-6,direction,kind,lateral);
   assert(Math.hypot(a.x-b.x,a.y-b.y)<1e-4,edge+' corner stays continuous');
  }
 }
});
test('all nineteen paths join continuously for all vehicle types and terminate beyond map boundaries',()=>{
 for(const route of Object.values(ROUTES)){
  assert(routeLength(route)>0);
  for(const kind of ['electric','bicycle','motor']){
   for(let i=1;i<route.refs.length;i++){
    const a=route.refs[i-1],b=route.refs[i],end=pointOnEdge(a.edge,roadGeometry[a.edge].length,a.direction,kind),start=pointOnEdge(b.edge,0,b.direction,kind);
    assert(Math.hypot(end.x-start.x,end.y-start.y)<1e-8,route.id+' '+kind+' joins');
   }
   const last=route.refs.at(-1),p=pointOnEdge(last.edge,roadGeometry[last.edge].length,last.direction,kind);
   assert(isOutsideMap(p),route.id+' has a real boundary exit');
  }
 }
 assert.equal(Object.keys(ROUTES).length,19);
});
test('the new half-roundabout carries both origins on counterclockwise lanes',()=>{
 const outward=ROUTES['1-ring'],inward=ROUTES['2-ring'];
 assert(outward.refs.some(ref=>ref.edge==='ringBottom'&&ref.direction===1));
 assert(!outward.refs.some(ref=>ref.edge==='ringArcEast'||ref.edge==='ringArcWest'));
 assert(inward.refs.some(ref=>ref.edge==='ringArcEast'&&ref.direction===1));
 assert(inward.refs.some(ref=>ref.edge==='ringArcWest'&&ref.direction===1));
 assert(!inward.refs.some(ref=>ref.edge==='ringBottom'));
 const northOut=ROUTES['1-ring-north'],northIn=ROUTES['2-ring-north'];
 assert(northOut.refs.some(ref=>ref.edge==='northConnector'&&ref.direction===1));
 assert(northIn.refs.some(ref=>ref.edge==='northConnector'&&ref.direction===-1));
 for(const route of [northOut,northIn]){
  assert(!route.refs.some(ref=>ref.edge==='northWest'||ref.edge==='linkWest'),'new road bypasses the west junction');
  assert(!route.turns.some(turn=>turn.j===0),'bypass must not count a phantom west-junction turn');
 }
 const south=EDGES.ringBottom.points,north=[...EDGES.ringArcEast.points,...EDGES.ringArcWest.points.slice(1)],loop=[...south,...north.slice(1)];
 const signedArea=loop.reduce((sum,p,i)=>{const q=loop[(i+1)%loop.length];return sum+p[0]*q[1]-q[0]*p[1];},0);
 assert(signedArea<0,'west-to-east southern side and east-to-west northern arc form counterclockwise circulation');
 for(const route of [outward,inward,northOut,northIn])for(const kind of ['electric','bicycle','motor']){
  for(const ref of route.refs.filter(ref=>EDGES[ref.edge].roundabout)){
   assert.equal(ref.direction,1,'all entries obey the counterclockwise ring');
   const road=roadGeometry[ref.edge];for(let p=0;p<=road.length;p+=1){
    const location=pointOnEdge(ref.edge,p,ref.direction,kind);
    assert(location.x>=710&&location.x<=1025&&location.y>=540&&location.y<=710);
   }
  }
 }
});
test('all vehicle types traverse both roundabout options from both origins and leave the map',()=>{
 for(const routeId of ['1-ring','2-ring','1-ring-north','2-ring-north'])for(const kind of ['electric','bicycle','motor']){
  const sim=new Simulation({settings:{motorDemand:0,demand:4,northDemand:0}});sim.cars=[];sim.settings.demand=0;
  const route=ROUTES[routeId],car=sim.newCar(route.origin===1?1:-1,0,kind,routeId);
  car.v=car.maxV;sim.cars.push(car);
  const visited=new Set([currentRef(car).edge]);
  for(let i=0;i<600&&sim.cars.length;i++){
   sim.step(1);
   if(sim.cars.length)visited.add(currentRef(car).edge);
  }
  for(const ref of route.refs)assert(visited.has(ref.edge),routeId+' '+kind+' traverses '+ref.edge);
  assert.equal(sim.cars.length,0,routeId+' '+kind+' exits');
  assert.equal(sim.exitCounts[route.exit],1);
  if(routeId.endsWith('-north'))assert.deepEqual(sim.turnCounts[0],{left:0,straight:0,right:0});
 }
});
test('motor vehicles remain on the east carriageway in both directions along south road',()=>{
 for(const id of ['southEast','exitSouthEast'])for(const direction of [1,-1]){
  const length=roadGeometry[id].length;
  for(let p=0;p<=length;p+=.5){
   const baseline=pointOnEdge(id,p,direction,'bicycle'),motor=pointOnEdge(id,p,direction,'motor');
   assert(motor.x>baseline.x+10,'motor east of cycling roadway');
   assert(motor.x-baseline.x<30,'motor remains in east corridor');
  }
 }
});
test('Dichen Middle Road puts all southbound types on the west road and all northbound types on the east road',()=>{
 const road=roadGeometry.northWest;
 for(let p=0;p<=road.length;p+=.5){
  const south=pointOnEdge('northWest',p,1,'bicycle'),north=pointOnEdge('northWest',road.length-p,-1,'bicycle');
  for(const kind of ['electric','motor']){
   assert.deepEqual(pointOnEdge('northWest',p,1,kind),south,'southbound '+kind+' follows the west road');
   assert.deepEqual(pointOnEdge('northWest',road.length-p,-1,kind),north,'northbound '+kind+' follows the east road');
  }
  if(south.y>=260&&south.y<=750)assert(north.x-south.x>=15,'directions use distinct physical roads');
  if(south.y>=320&&south.y<=330){assert(south.x>=430&&south.x<=434);assert(north.x>=446&&north.x<=450);}
  if(south.y>=695&&south.y<=705){assert(south.x>=492&&south.x<=496);assert(north.x>=510&&north.x<=514);}
 }
});
test('vehicles use both Dichen carriageways through their routes and continue through junctions to exit',()=>{
 for(const routeId of ['1-south','2-west-north','north-west'])for(const kind of ['electric','bicycle','motor']){
  const sim=new Simulation({settings:{demand:4,motorDemand:0,northDemand:0}});sim.settings.demand=0;sim.cars=[];
  const direction=routeId.startsWith('1-')?1:routeId.startsWith('2-')?-1:0;
  const car=sim.newCar(direction,0,kind,routeId);car.v=car.maxV;sim.cars.push(car);
  let observed=false;
  for(let i=0;i<750&&sim.cars.length;i++){
   if(currentRef(car).edge==='northWest'){
    const pos=vehiclePosition(car);
    if(pos.y>=695&&pos.y<=705){
     observed=true;
     assert(direction===1?pos.x>=487&&pos.x<=501:pos.x>=505&&pos.x<=519,routeId+' stays on its widened carriageway');
    }
   }
   sim.step(.5);checkRoadGaps(sim);
  }
  // Continue longer routes while the car is still travelling towards the edge.
  for(let i=0;i<750&&sim.cars.length;i++)sim.step(1);
  assert(observed,routeId+' '+kind+' passes the sampled Dichen section');
  assert.equal(sim.cars.length,0);
  assert.equal(sim.exitCounts[car.route.exit],1);
 }
});
test('middle road follows the actual northern corridor and keeps each type on its side in both directions',()=>{
 const road=roadGeometry.middleRoad;
 for(const direction of [1,-1])for(let p=0;p<=road.length;p+=.5){
  const bicycle=pointOnEdge('middleRoad',p,direction,'bicycle'),electric=pointOnEdge('middleRoad',p,direction,'electric'),motor=pointOnEdge('middleRoad',p,direction,'motor');
  assert.deepEqual(electric,bicycle);
  assert(motor.x>bicycle.x+10,'both directions keep motors east of cycling');
  if(bicycle.y>=200&&bicycle.y<=400){
   assert(bicycle.x>=1063&&bicycle.x<=1077,'cycles stay on the western road instead of crossing water');
   assert(motor.x>=1080&&motor.x<=1091,'motors stay on the eastern road');
  }
 }
 for(const routeId of ['1-north','2-north'])assert(ROUTES[routeId].refs.some(ref=>ref.edge==='middleRoad'&&ref.direction===1));
 for(const routeId of ['north-south','north-west','north-east'])assert(ROUTES[routeId].refs.some(ref=>ref.edge==='middleRoad'&&ref.direction===-1));
});
test('traffic actually traverses middle road in both directions for all types and leaves beyond the boundary',()=>{
 for(const routeId of ['1-north','2-north','north-south','north-west','north-east'])for(const kind of ['electric','bicycle','motor']){
  const sim=new Simulation({settings:{demand:4,motorDemand:0,northDemand:0}});sim.settings.demand=0;sim.cars=[];
  const direction=routeId.startsWith('north-')?0:routeId.startsWith('1-')?1:-1;
  const car=sim.newCar(direction,0,kind,routeId);car.v=car.maxV;sim.cars.push(car);
  let entered=false,reachedJunction=false;
  for(let i=0;i<750&&sim.cars.length;i++){
   if(currentRef(car).edge==='middleRoad'){entered=true;if(car.p>roadGeometry.middleRoad.length-30)reachedJunction=true;}
   sim.step(1);checkRoadGaps(sim);
  }
  assert(entered&&reachedJunction,routeId+' '+kind+' traverses middle road');
  assert.equal(sim.cars.length,0,routeId+' '+kind+' finishes');
  assert.equal(sim.exitCounts[car.route.exit],1);
 }
});
test('north entries queue at the east junction and motor/cycle carriageways have separate leaders',()=>{
 const sim=new Simulation({settings:{demand:4,motorDemand:0,northDemand:0}});sim.settings.demand=0;sim.cars=[];sim.time=32;
 const cycle=sim.newCar(0,0,'bicycle','north-south'),motor=sim.newCar(0,0,'motor','north-south');
 for(const car of [cycle,motor]){car.edgeIndex=1;car.p=roadGeometry.middleRoad.length-28;car.v=car.maxV;}
 assert.notEqual(laneKey(cycle),laneKey(motor));
 sim.cars=[cycle,motor];
 assert.equal(sim.entryLeader(currentRef(cycle),cycle),undefined,'other carriageway does not block cycle entry');
 for(let i=0;i<15;i++)sim.step(1);
 assert(sim.cars.every(c=>currentRef(c).edge==='middleRoad'));
 assert(sim.metrics().queues[1].total===2&&sim.metrics().queues[1].forward===2);
 for(let i=0;i<20;i++){sim.step(1);checkRoadGaps(sim);}
 assert(sim.cars.every(c=>currentRef(c).edge==='southEast'));
 assert.equal(sim.turnCounts[1].straight,2);
});
test('deterministic multi-road simulation keeps gaps, finite positions and increasing journey progress',()=>{
 const a=new Simulation(),b=new Simulation(),previous=new Map();let transitions=0;
 for(let t=0;t<1600;t++){
  a.step(.5);b.step(.5);
  if(t%5===0)checkRoadGaps(a);
  for(const c of a.cars){
   const position=vehiclePosition(c),old=previous.get(c.id),progress=totalProgress(c);
   assert(Number.isFinite(position.x)&&Number.isFinite(position.y)&&Number.isFinite(c.v));
   assert(c.p>=0&&c.p<roadGeometry[currentRef(c).edge].length+1e-6);
   assert(!isOutsideMap(position));
   if(old){assert(progress>=old.progress-1e-7);if(old.edge!==c.edgeIndex)transitions++;}
   previous.set(c.id,{progress,edge:c.edgeIndex});
  }
 }
 assert(transitions>30);assert.deepEqual(a.snapshot(),b.snapshot());assert(a.completed>0);assert(a.metrics().averageTravel>0);
});
test('vehicles turn in all three directions at both junctions and leave through all six exits',()=>{
 const sim=new Simulation();
 for(let t=0;t<1400;t++){sim.step(1);if(t%20===0)checkRoadGaps(sim);}
 const m=sim.metrics();
 for(const counts of m.turnCounts)for(const movement of ['left','straight','right'])assert(counts[movement]>0);
 for(const exit of EXITS)assert(m.exitCounts[exit.id]>0,exit.id+' has departures');
 assert.equal(m.exited,Object.values(m.exitCounts).reduce((n,v)=>n+v,0));
 assert.equal(m.active,m.electric+m.bicycle+m.motor);
 assert(m.completedByKind.motor>0);
 assert.equal(m.exited>=m.completed,true);
 console.log(JSON.stringify({turns:m.turnCounts,exits:m.exitCounts,active:m.active,departed:m.exited}));
});
test('internal road endpoints keep vehicles alive, deletion happens only beyond the source-map border',()=>{
 const sim=new Simulation({settings:{motorDemand:0,demand:4,northDemand:0}});
 sim.cars=[];const c=sim.newCar(1,sim.time,'electric','1-south');
 c.p=roadGeometry.access1.length-.02;c.v=c.maxV;sim.cars=[c];
 sim.step(.1);assert(sim.cars.some(v=>v.id===c.id));assert.equal(currentRef(c).edge,'northWest');assert.equal(sim.exited,0);
 c.edgeIndex=c.route.refs.length-1;
 const road=roadGeometry[currentRef(c).edge];
 // This position is near the image edge but still within it.
 c.p=road.length-60;c.v=c.maxV;
 assert(vehiclePosition(c).y<MAP.height);
 sim.step(.1);assert(sim.cars.some(v=>v.id===c.id));assert.equal(sim.exited,0);
 for(let i=0;i<20;i++)sim.step(1);
 assert(!sim.cars.some(v=>v.id===c.id));assert.equal(sim.exited,1);assert.equal(sim.exitCounts.southEast,1);
});
test('branch queues wait, leave FIFO and keep their planned exit after the junction',()=>{
 const sim=new Simulation({settings:{demand:4,motorDemand:0,northDemand:0}});sim.cars=[];sim.time=45;
 Object.assign(sim.westSignal,{stage:'green',phase:-1,startedAt:35,greenStartedAt:35,endsAt:55,nextReview:45,planned:true});
 const road=roadGeometry.northWest,ids=[],passed=[],seen=new Set();
 for(let i=0;i<6;i++){
  const route=['1-south','1-west','1-west-south'][i%3],c=sim.newCar(1,sim.time,'electric',route);
  c.edgeIndex=1;c.p=road.length-9-18-i*18;c.lane=1;c.homeLane=1;c.maxV=8.4;c.v=c.maxV;sim.cars.push(c);ids.push(c.id);
 }
 let maxQueue=0,maximumWait=0;
 for(let i=0;i<800;i++){
  sim.step(.1);checkRoadGaps(sim);
  const group=sim.cars.filter(c=>ids.includes(c.id));
  if(sim.time<60-1e-6)assert(group.every(c=>currentRef(c).edge==='northWest'&&c.p<road.length-9));
  for(const c of group)if(currentRef(c).edge!=='northWest'&&!seen.has(c.id)){seen.add(c.id);passed.push(c.id);}
  const q=sim.metrics().queues[0];maxQueue=Math.max(maxQueue,q.total);maximumWait=Math.max(maximumWait,q.maxWait);
 }
 assert(maxQueue>=4);assert(maximumWait>7);assert.deepEqual(passed,ids);assert.equal(sim.metrics().queues[0].total,0);
 assert(sim.turnCounts[0].left>0&&sim.turnCounts[0].straight>0&&sim.turnCounts[0].right>0);
});
test('north bypass percentage applies directly to eligible vehicles and preserves exits',()=>{
 const sim=new Simulation({settings:{northBypassShare:0,motorDemand:0,northDemand:0}});
 for(let i=0;i<100;i++)for(const direction of [1,-1])assert(!sim.newCar(direction,0).route.refs.some(ref=>ref.edge==='northConnector'));
 sim.setSettings({northBypassShare:999,motorDemand:999});assert.equal(sim.settings.northBypassShare,100);assert.equal(sim.settings.motorDemand,20);assert(!('branchShare'in sim.settings));
 for(let i=0;i<1000;i++)for(const direction of [1,-1,0]){
  const car=sim.newCar(direction,0),base=ROUTES[car.routingChoice.normalRouteId],eligible=Boolean(NORTH_BYPASS_ROUTES[base.id]);
  assert.equal(car.route.exit,base.exit);
  assert.equal(car.route.refs.some(ref=>ref.edge==='northConnector'),eligible);
  if(eligible)assert(!car.route.refs.some(ref=>APPROACHES.some(a=>a.j===0&&a.edge===ref.edge&&a.direction===ref.direction)));
 }
 sim.setSettings({northBypassShare:70});let eligible=0,diverted=0;
 for(let i=0;i<2000;i++)for(const direction of [1,-1]){const car=sim.newCar(direction,0);if(NORTH_BYPASS_ROUTES[car.routingChoice.normalRouteId]){eligible++;if(car.route.id!==car.routingChoice.normalRouteId)diverted++;}}
 assert(diverted/eligible>.67&&diverted/eligible<.73);
});
test('live diversion changes only routes before their fork and does not move vehicles or change destinations',()=>{
 const sim=new Simulation({settings:{northBypassShare:0}});sim.cars=[];sim.pending={1:[],'-1':[],0:[]};
 const early=sim.newCar(1,0,'motor','1-east'),late=sim.newCar(1,0,'bicycle','1-south'),reverse=sim.newCar(-1,0,'electric','2-ring');
 early.routingChoice={normalRouteId:'1-east',bypassDraw:.2};early.p=70;
 late.routingChoice={normalRouteId:'1-south',bypassDraw:.2};late.edgeIndex=1;late.p=100;
 reverse.routingChoice={normalRouteId:'2-ring',bypassDraw:.2};reverse.edgeIndex=2;reverse.p=5;
 sim.cars.push(early,late,reverse);
 const waiting=sim.newCar(1,0,'electric','1-north');waiting.routingChoice={normalRouteId:'1-north',bypassDraw:.2};sim.pending[1].push(waiting);
 const positions=sim.cars.map(c=>vehiclePosition(c)),exits=sim.cars.map(c=>c.route.exit);
 sim.setSettings({northBypassShare:80});
 assert.equal(early.route.id,'1-bypass-east');assert.equal(late.route.id,'1-south');assert.equal(reverse.route.id,'2-ring-north');assert.equal(waiting.route.id,'1-bypass-north');
 assert.deepEqual(sim.cars.map(c=>vehiclePosition(c)),positions);assert.deepEqual(sim.cars.map(c=>c.route.exit),exits);
 assert.equal(sim.bypassStats.safeRouteChanges,3);
 sim.setSettings({northBypassShare:0});assert.deepEqual(sim.cars.map(c=>vehiclePosition(c)),positions);assert.equal(early.route.id,'1-east');
});
test('snapshot reports per-road state, exits and motor rule; invalid time and reads do not advance waiting',()=>{
 const sim=new Simulation({settings:{motorDemand:0}});
 sim.step(60);assert(!sim.cars.some(c=>c.kind==='motor'));
 sim.setSettings({motorDemand:10});sim.step(60);assert(sim.cars.some(c=>c.kind==='motor'));
 const before=sim.snapshot();sim.step(NaN);sim.step(-1);assert.deepEqual(sim.snapshot(),before);
 assert.equal(before.schemaVersion,16);assert.equal(before.network.motorRule.carriageway,'east');assert.deepEqual(before.network.motorRule.directions,[1,-1]);
 assert.equal(before.network.middleRoadRule.nonMotorCarriageway,'west');assert.equal(before.network.middleRoadRule.motorCarriageway,'east');
 assert.deepEqual(before.network.middleRoadRule.directions,[1,-1]);
 assert.equal(before.network.dichenRoadRule.southboundCarriageway,'west');assert.equal(before.network.dichenRoadRule.northboundCarriageway,'east');
 for(const v of before.vehicles){assert(v.edge in EDGES);assert(v.routeId in ROUTES);assert(Number.isFinite(v.totalProgress));}
 const state=sim.control(0,1);assert(state.remaining>0&&state.remaining<=WEST_SIGNAL_POLICY.maxGreen+10);
});

