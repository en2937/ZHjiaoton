import {Simulation} from '../dist/engine.mjs';
import {writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const scenarios=[
 {name:'默认高峰',seed:20261012,settings:{demand:30,electric:70,motorDemand:6,northDemand:8,outbound:72}},
 {name:'南向偏重高峰',seed:20261013,settings:{demand:50,electric:70,motorDemand:12,northDemand:8,outbound:80}}
];
export function compareBypass(scenario,horizon=600){
 const outcomes={};
 for(const share of [0,60]){
  const sim=new Simulation({seed:scenario.seed,settings:{...scenario.settings,northBypassShare:0,westSignalMode:'adaptive'}});
  sim.setSettings({northBypassShare:share});let eastQueueSeconds=0;
  for(let t=0;t<horizon;t++){sim.step(1);eastQueueSeconds+=sim.metrics().queues[1].total;}
  const m=sim.metrics();outcomes[share]={averageQueue:m.westSignal.averageQueue,averageWait:m.westSignal.averageWait,
   passedA:m.westSignal.passed,remainingQueueA:m.queues[0].total,averageQueueB:eastQueueSeconds/horizon,
   departed:m.exited,pending:m.pending,...m.northBypass};
 }
 return {...scenario,horizonSeconds:horizon,baseline:outcomes[0],diverted:outcomes[60],
  queueReductionPercent:(1-outcomes[60].averageQueue/outcomes[0].averageQueue)*100,
  waitReductionPercent:(1-outcomes[60].averageWait/outcomes[0].averageWait)*100};
}
if(process.argv[1]?.replaceAll('\\','/').endsWith('/bypass-comparison.mjs')){
 const results=[];for(const scenario of scenarios){const result=compareBypass(scenario);console.log(JSON.stringify(result));results.push(result);assert(result.diverted.averageQueue<result.baseline.averageQueue,'北侧绕行应降低A平均排队');}
 await writeFile(new URL('../bypass-comparison.json',import.meta.url),JSON.stringify({source:'synthetic-simulation',results},null,2));
}
