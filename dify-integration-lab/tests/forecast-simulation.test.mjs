import test from 'node:test';
import assert from 'node:assert/strict';
import {Simulation,createOvertakingDemo,roadGeometry} from '../../traffic-sandbox/dist/engine.mjs';
import {ForecastSimulation,FORECAST_FAST_PATH_AVAILABLE} from '../forecast-simulation.mjs';
const compare=(a,b,label)=>assert.deepEqual(structuredClone(b),structuredClone(a),label);
test('经核验的原引擎启用Worker查询优化',()=>assert.equal(FORECAST_FAST_PATH_AVAILABLE,true));
test('混合车型、三种种子、固定/自动信号与引导改变逐tick一致',()=>{
 for(const seed of [1,20261012,4294967295]){
  const options={seed,settings:{demand:50,electric:35,outbound:80,motorDemand:20,northDemand:20,northBypassShare:80,behaviorMode:'grouped',guidanceCoverage:100},departureScenario:{mode:'survey',classTime:'10:00',totalPeople:2000,distributionModel:'questionnaire-batches-v1'}};
  const a=new Simulation(options),b=new ForecastSimulation(options);
  for(let i=0;i<1200;i++){
   if(i===500)for(const sim of [a,b])sim.setSettings({westSignalMode:'fixed',guidanceCoverage:0,northBypassShare:0});
   if(i===900)for(const sim of [a,b])sim.setSettings({westSignalMode:'adaptive',northBypassShare:100});
   a.tick(.1);b.tick(.1);compare(a,b,`seed ${seed}, tick ${i}`);
  }
 }
});
test('超车、变道与车道收窄逐tick一致',()=>{
 const a=createOvertakingDemo(),b=Object.assign(Object.create(ForecastSimulation.prototype),structuredClone(a));
 for(let i=0;i<1500;i++){a.tick(.1);b.tick(.1);compare(a,b,`tick ${i}`);}
});
test('同位置乱序ID、并行车道和跨路段保留原来的前车优先级',()=>{
 const a=new Simulation({settings:{motorDemand:0,northDemand:0}});a.cars=[];a.demo=true;
 for(const [id,p,lane]of [[9,100,0],[3,100,1],[7,100,2],[2,110,1],[5,110,0],[6,120,2],[4,120,1]]){
  const c=a.newCar(1,0,id%2?'electric':'bicycle','1-south');Object.assign(c,{id,edgeIndex:1,p,lane,homeLane:lane});a.cars.push(c);
 }
 const b=Object.assign(Object.create(ForecastSimulation.prototype),structuredClone(a));
 for(let i=0;i<1500;i++){a.tick(.1);b.tick(.1);compare(a,b,`tick ${i}`);}
});
test('所有道路、方向、车型和合法车道的出界判断与原引擎相同',()=>{
 const a=new Simulation();a.cars=[];a.demo=true;
 for(const [edge,road]of Object.entries(roadGeometry))for(const direction of [1,-1])for(const kind of ['electric','bicycle','motor'])for(const lane of kind==='motor'?[0,1]:[0,1,2])for(const fraction of [0,.25,.5,.75,1]){
  const car=a.newCar(direction,0,kind,'1-south');car.route={...car.route,refs:[{edge,direction}]};Object.assign(car,{edgeIndex:0,p:fraction*road.length,lane,homeLane:lane});
  if(fraction===.5)car.laneChange={from:lane===0?1:lane-1,to:lane,startedAt:0,duration:1.8,progress:0};
  a.cars.push(car);
 }
 const b=Object.assign(Object.create(ForecastSimulation.prototype),structuredClone(a));
 for(let i=0;i<3;i++){a.tick(.1);b.tick(.1);compare(a,b,`geometry tick ${i}`);}
});
test('代表车辆的入场/离场跟踪与真实车辆集合一致',()=>{
 const a=new Simulation();a.cars=[];a.demo=true;a.pending={1:[],'-1':[],0:[]};
 const car=a.newCar(1,0,'electric','1-south');a.pending[1].push(car);
 const b=Object.assign(Object.create(ForecastSimulation.prototype),structuredClone(a)),rider=b.pending[1][0];b.watchVehicle(rider);assert.equal(b.hasVehicle(rider),false);
 a.tick(.1);b.tick(.1);compare(a,b);assert.equal(b.hasVehicle(rider),true);
 for(const sim of [a,b]){const c=sim.cars[0];c.edgeIndex=c.route.refs.length-1;c.p=roadGeometry[c.route.refs[c.edgeIndex].edge].length;}
 a.tick(.1);b.tick(.1);compare(a,b);assert.equal(b.hasVehicle(rider),b.cars.includes(rider));assert.equal(b.hasVehicle(rider),false);
});
test('原引擎更新后自动退回原实现，防止优化副本沿用过期规则',async()=>{
 const original=Simulation.prototype.tick;let calls=0;
 try{
  Simulation.prototype.tick=function(dt){calls++;return original.call(this,dt);};
  const changed=await import('../forecast-simulation.mjs?changed-reference-test');
  assert.equal(changed.FORECAST_FAST_PATH_AVAILABLE,false);
  const a=new Simulation(),b=new changed.ForecastSimulation();
  for(let i=0;i<20;i++){a.tick(.1);b.tick(.1);compare(a,b,`fallback tick ${i}`);}
  assert.equal(calls,40);
 }finally{Simulation.prototype.tick=original;}
});
