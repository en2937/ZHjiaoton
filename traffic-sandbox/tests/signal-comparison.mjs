import {Simulation} from '../dist/engine.mjs';

export const signalScenarios=[
 {name:'默认高峰',seed:20261012,settings:{demand:30,motorDemand:6,northDemand:8,outbound:72,northBypassShare:60}},
 {name:'南向偏重高峰',seed:20261013,settings:{demand:50,motorDemand:12,northDemand:8,outbound:80,northBypassShare:60}},
 {name:'双向接近平衡',seed:20261014,settings:{demand:40,motorDemand:8,northDemand:8,outbound:50,northBypassShare:60}}
];
export function compareSignal(scenario,horizon=600){
 const outcomes={};
 for(const mode of ['fixed','adaptive']){
  const sim=new Simulation({seed:scenario.seed,settings:{...scenario.settings,westSignalMode:mode}});
  for(let t=0;t<horizon;t++)sim.step(1);
  const m=sim.metrics();
  outcomes[mode]={averageQueue:m.westSignal.averageQueue,averageWait:m.westSignal.averageWait,queueSeconds:m.westSignal.queueSeconds,
   passed:m.westSignal.passed,remainingQueue:m.queues[0].total,departed:m.exited,switches:m.westSignal.switches};
 }
 return {scenario:scenario.name,seed:scenario.seed,settings:scenario.settings,horizon,...outcomes,
  queueReductionPercent:outcomes.fixed.averageQueue?(1-outcomes.adaptive.averageQueue/outcomes.fixed.averageQueue)*100:0,
  waitReductionPercent:outcomes.fixed.averageWait?(1-outcomes.adaptive.averageWait/outcomes.fixed.averageWait)*100:0};
}
if(process.argv[1]?.replaceAll('\\','/').endsWith('/signal-comparison.mjs')){
 for(const scenario of signalScenarios)console.log(JSON.stringify(compareSignal(scenario)));
}
