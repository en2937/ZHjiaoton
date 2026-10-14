export const SETTING_RANGES={demand:[4,50],motorDemand:[0,20],northDemand:[0,20],electric:[0,100],outbound:[20,80],northBypassShare:[0,100],guidanceCoverage:[0,100]};
export const SETTING_KEYS=[...Object.keys(SETTING_RANGES),'westSignalMode','behaviorMode'];
export const SETTING_NAMES={demand:'骑行车流',motorDemand:'机动车流',northDemand:'北侧来车',electric:'电动车占比',outbound:'地点1来车占比',northBypassShare:'北侧环岛绕行 A',westSignalMode:'A 路口配时',guidanceCoverage:'引导覆盖',behaviorMode:'选路模式'};
export function validSettings(value,{complete=false}={}){
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 if(complete&&Object.keys(value).length!==SETTING_KEYS.length)return false;
 return Object.entries(value).every(([key,v])=>key==='behaviorMode'?['original','grouped'].includes(v):key==='westSignalMode'?['adaptive','fixed'].includes(v):Object.hasOwn(SETTING_RANGES,key)&&typeof v==='number'&&Number.isFinite(v)&&v>=SETTING_RANGES[key][0]&&v<=SETTING_RANGES[key][1]);
}
export const sameSettings=(a,b)=>validSettings(a,{complete:true})&&validSettings(b,{complete:true})&&SETTING_KEYS.every(key=>a[key]===b[key]);
export const settingValue=(key,value)=>key==='behaviorMode'?(value==='grouped'?'认知与意愿分组':'原选路规则'):key==='westSignalMode'?(value==='adaptive'?'自动调控':'固定配时'):value+(['electric','outbound','northBypassShare','guidanceCoverage'].includes(key)?'%':' 辆/分钟');
export function settingChanges(before,patch){return Object.entries(patch).filter(([key,value])=>value!==before[key]).map(([key,after])=>({key,label:SETTING_NAMES[key],before:before[key],after,beforeText:settingValue(key,before[key]),afterText:settingValue(key,after)}));}
