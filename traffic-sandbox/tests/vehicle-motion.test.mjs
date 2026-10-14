import test from 'node:test';
import assert from 'node:assert/strict';
import {createVehicleInterpolator} from '../dist/shared-client.mjs';
import {ROUTES} from '../dist/route.mjs';
import {vehiclePosition,roadGeometry} from '../dist/engine.mjs';
const car=(p=50,options={})=>({id:1,kind:'electric',route:ROUTES['1-ring-north'],edgeIndex:1,p,lane:1,laneChange:null,state:'moving',queueJunction:-1,v:20,maxV:20,...options});
const packet=(cars,time=0,options={})=>({instanceId:'server-a',runId:'run-a',running:true,speed:4,simulation:{cars,time},...options});
const close=(a,b,tolerance=1e-7)=>assert.ok(Math.abs(a-b)<tolerance,`${a} != ${b}`);
function pair(a,b){const motion=createVehicleInterpolator();motion.accept(packet([a]),0);motion.accept(packet([b],.6),150);return motion;}
test('confirmed time drives motion without extrapolating or modifying source',()=>{
 const a=car(50),b=car(62),source=JSON.stringify([a,b]),motion=pair(a,b);
 close(motion.carsAt(150)[0].p,50);close(motion.carsAt(425)[0].p,56);close(motion.carsAt(500)[0].p,62);close(motion.carsAt(900)[0].p,62);assert.equal(JSON.stringify([a,b]),source);
});
test('receiving a packet does not restart the displayed trajectory',()=>{
 const motion=pair(car(50),car(62)),before=motion.carsAt(425)[0].p;
 motion.accept(packet([car(74)],1.2),425);close(motion.carsAt(425)[0].p,before);close(motion.carsAt(450)[0].p,58);
});
test('curved routes use road geometry rather than an endpoint diagonal',()=>{
 const edgeIndex=2,corner=roadGeometry[ROUTES['1-ring-north'].refs[edgeIndex].edge].cumulative[2];
 const a=car(corner-16,{edgeIndex}),b=car(corner+16,{edgeIndex}),motion=pair(a,b);
 const actual=vehiclePosition(motion.carsAt(425)[0]),expected=vehiclePosition(car(corner,{edgeIndex}));close(actual.x,expected.x);close(actual.y,expected.y);
 const from=vehiclePosition(a),to=vehiclePosition(b);assert.ok(Math.hypot(actual.x-(from.x+to.x)/2,actual.y-(from.y+to.y)/2)>.05);
});
test('crossing a road boundary stays on both connected segments',()=>{
 const a=car(roadGeometry.northConnector.length-6),b=car(6,{edgeIndex:2}),motion=pair(a,b);
 close(motion.carsAt(387.5)[0].p,a.p+3);assert.equal(motion.carsAt(462.5)[0].edgeIndex,2);close(motion.carsAt(462.5)[0].p,3);
});
test('waiting cars brake to the confirmed stopping position without drift',()=>{
 const stopped=car(60,{state:'waiting',queueJunction:0,v:0}),motion=pair(car(50),stopped);motion.accept(packet([stopped],1.2),300);
 assert.ok(motion.carsAt(425)[0].p<60);close(motion.carsAt(5000)[0].p,60);assert.equal(motion.hasMotion(5001),false);
});
test('lane changes stay continuous and within confirmed lateral bounds',()=>{
 const a=car(50,{lane:2,laneChange:{from:0,progress:.25}}),b=car(58,{lane:2,laneChange:{from:0,progress:.75}}),motion=pair(a,b);
 const middle=motion.carsAt(425)[0];close(middle.lane,1);assert.equal(middle.laneChange,null);
 const expected=vehiclePosition(car(54,{lane:1})),actual=vehiclePosition(middle);close(expected.x,actual.x);close(expected.y,actual.y);
});
test('birth uses first known position without rewinding; exited cars disappear',()=>{
 const motion=createVehicleInterpolator();motion.accept(packet([car(50)]),0);motion.accept(packet([car(10,{id:2})],.6),150);motion.accept(packet([car(20,{id:2})],1.2),300);
 close(motion.carsAt(425)[0].p,10);close(motion.carsAt(500)[0].p,10);assert.ok(motion.carsAt(550)[0].p>10);
 motion.accept(packet([],1.8),600);assert.equal(motion.carsAt(601).length,0);
});
test('pause, reset, server replacement and speed changes clear the old buffer',()=>{
 for(const options of [{running:false},{runId:'new-run'},{instanceId:'server-b'},{speed:8}]){
  const motion=createVehicleInterpolator();motion.accept(packet([car(50)]),0);motion.accept(packet([car(62)],.6,options),150);close(motion.carsAt(151)[0].p,62);assert.equal(motion.hasMotion(151),false);
 }
});
test('disconnect, long gaps, hidden-tab return and reduced motion clear stale animation',()=>{
 const motion=pair(car(50),car(62));motion.reset();assert.equal(motion.hasMotion(151),false);motion.accept(packet([car(70)],1),170);close(motion.carsAt(171)[0].p,70);
 motion.accept(packet([car(90)],2),2000);close(motion.carsAt(2001)[0].p,90);motion.setEnabled(false);motion.accept(packet([car(98)],2.5),2150);close(motion.carsAt(2151)[0].p,98);
});
test('safe reroutes preserve common roads and incompatible changes snap safely',()=>{
 const a=car(50,{edgeIndex:0}),b=car(60,{edgeIndex:0,route:ROUTES['1-bypass-east']}),motion=pair(a,b);close(motion.carsAt(425)[0].p,55);
 motion.accept(packet([car(80,{route:ROUTES['north-south'],edgeIndex:1})],1.2),450);close(motion.carsAt(451)[0].p,80);
});
test('100ms simulation ticks and 150ms polling produce uniform visible speed',()=>{
 const motion=createVehicleInterpolator();let previous=null;
 for(let now=0;now<=4500;now+=10){
  if(now%150===0){const time=Math.floor(now/100)*.4;motion.accept(packet([car(50+8*time,{v:8,maxV:8})],time),now);}
  const p=motion.carsAt(now)[0].p;if(now>=800)close((p-previous)*100,32,1e-6);previous=p;
 }
});
test('poll jitter and duplicate tick times do not pulse playback speed',()=>{
 const motion=createVehicleInterpolator(),arrivals=[0];let time=0;for(let i=0;i<35;i++){time+=[130,170,150,180,120][i%5];arrivals.push(time);}
 let next=0,previous=null;
 for(let now=0;now<=4800;now+=10){
  while(next<arrivals.length&&arrivals[next]<=now){const received=arrivals[next++],simTime=Math.floor(received/100)*.4;motion.accept(packet([car(50+8*simTime,{v:8})],simTime),received);}
  const p=motion.carsAt(now)[0].p;if(now>=900)close((p-previous)*100,32,1e-6);previous=p;
 }
});
test('acceleration and braking match analytic trajectories with shared node velocities',()=>{
 for(const accelerating of [true,false]){
  const motion=createVehicleInterpolator(),position=t=>accelerating?50+t*t:50+8*t-t*t,velocity=t=>accelerating?2*t:8-2*t;
  for(let now=0;now<=3600;now+=10){
   if(now%150===0){const time=Math.floor(now/100)*.1;motion.accept(packet([car(position(time),{v:velocity(time)})],time,{speed:1}),now);}
   const p=motion.carsAt(now)[0].p;if(now>=700)close(p,position((now-350)/1000),1e-6);
  }
 }
 const motion=createVehicleInterpolator();for(let i=0;i<4;i++){const t=i*.15;motion.accept(packet([car(50+t*t,{v:2*t})],t,{speed:1}),i*150);}
 const epsilon=.01,a=motion.carsAt(500-epsilon)[0].p,b=motion.carsAt(500)[0].p,c=motion.carsAt(500+epsilon)[0].p;close((b-a)/epsilon*1000,(c-b)/epsilon*1000,1e-4);
});
test('buffer underrun holds confirmed positions then resumes without a jump',()=>{
 const motion=pair(car(50),car(62));close(motion.carsAt(900)[0].p,62);motion.accept(packet([car(74)],1.2),950);close(motion.carsAt(951)[0].p,62);
 assert.ok(motion.carsAt(1200)[0].p>62);assert.ok(motion.carsAt(5000)[0].p<=74);
});
