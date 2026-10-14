import test from 'node:test';
import assert from 'node:assert/strict';
import {Simulation} from '../dist/engine.mjs';

function measure(mode){
 const sim=new Simulation({settings:{demand:12,motorDemand:6,northDemand:1,outbound:72},departureScenario:{mode,classTime:'08:00',totalPeople:36}});
 const generated={};const original=sim.newCar;
 sim.newCar=function(direction,time,kind='cycle',...args){const key=direction+':'+(kind==='motor'?'motor':'cycle');generated[key]=(generated[key]??0)+1;return original.call(this,direction,time,kind,...args);};
 sim.step(900);
 return {sim,generated};
}
test('point 1 motor arrivals fall by 75% in both modes while other sources retain their demand',()=>{
 for(const mode of ['fixed','survey']){
  const {sim,generated}=measure(mode),minutes=15;
  const motor1=generated['1:motor']+sim.motorCredit[1];
  assert(Math.abs(motor1-minutes*6*.72*.25)<1e-8);
  assert(Math.abs(generated['-1:motor']+sim.motorCredit[-1]-minutes*6*.28)<1e-8);
  assert(Math.abs(generated['0:motor']+sim.motorCredit[0]-minutes/3)<1e-8);
  assert(Math.abs(generated['-1:cycle']+sim.credit[-1]-minutes*12*.28)<1e-8);
  if(mode==='fixed')assert(Math.abs(generated['1:cycle']+sim.credit[1]-minutes*12*.72)<1e-8);
  else {assert.equal(sim.surveyDepartures.plan.length,36);assert.equal(sim.departureState().planned,36);}
 }
});
test('new scenes reduce only point 1 warm motor vehicles and motor demand zero still disables them',()=>{
 const sim=new Simulation({settings:{motorDemand:6,northDemand:1}});
 const count=direction=>sim.cars.filter(c=>c.kind==='motor'&&c.direction===direction).length;
 assert.equal(count(1),1);assert.equal(count(-1),5);assert.equal(count(0),3);
 const off=new Simulation({settings:{motorDemand:0}});assert.equal(off.cars.filter(c=>c.kind==='motor').length,0);off.step(120);assert.equal(off.cars.filter(c=>c.kind==='motor').length,0);
});
