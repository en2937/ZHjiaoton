import {canonicalQuestion,resolveQuestionTrip,questionScope} from '../qa-policy/knowledge-scope.mjs';
import {departureGoal} from './departure-objectives.mjs';
const digits={零:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
const number=text=>/^\d+$/.test(text)?Number(text):text==='十'?10:text.includes('十')?(digits[text.split('十')[0]]??1)*10+(digits[text.split('十')[1]]??0):digits[text];
export function departureIntent(question,trip){
 const q=canonicalQuestion(question).replace(/\s+/g,'');
 const goal=departureGoal(q),asksTime=/(几点|何时|什么时候|啥时候|几时|多早|提前多久|出发时间|出发时刻|出发安排|多久前)/.test(q);
 if(!(asksTime&&/(出发|动身|走|上课|早八|赶课)/.test(q))&&!(goal==='avoid-congestion'&&/(上课|早八|赶课)/.test(q)))return null;
 if(/步行|走路|徒步/.test(q)||!['electric','bicycle'].includes(trip.mode))return {kind:'missing_data',message:'目前可以推演电动车或自行车出发时间，尚未建立步行模型。'};
 if(!questionScope(question).allowed)return {kind:'missing_data',message:'这处目的地还没有推演路线，目前支持地图中的云峰学园与东教学楼。'};
 const alias=/(早|晚)([一二两三四五六七八九十\d]{1,3})(?:[:：](\d{1,2})|点(?:(半|[零一二两三四五六七八九十\d]{1,3})(?:分)?)?)/.exec(q)||/(早|晚)([一二两三四五六七八九十\d]{1,3})/.exec(q);
 const times=[...q.matchAll(/(早上|早晨|上午|中午|下午|晚上|晚间)?([零一二两三四五六七八九十\d]{1,3})(?:[:：](\d{1,2})|点(?:(半|[零一二两三四五六七八九十\d]{1,3})(?:分)?)?)/g)];
 let hour,minute=0;
 if(alias){hour=number(alias[2]);minute=alias[3]!==undefined?Number(alias[3]):alias[4]==='半'?30:alias[4]?number(alias[4]):0;if(alias[1]==='晚'&&hour<12)hour+=12;}
 else if(times.length){
  const relevant=times.filter(m=>/(上课|开课|到达|前到|课)/.test(q.slice(Math.max(0,m.index-5),m.index+m[0].length+8)));
  const match=relevant.length===1?relevant[0]:times.length===1?times[0]:null;
  if(!match)return {kind:'need_clarification',field:'classTime',message:'请明确上课或希望到达的时刻，例如“早八几点出发最好”。'};
  hour=number(match[2]);minute=match[3]!==undefined?Number(match[3]):match[4]==='半'?30:match[4]?number(match[4]):0;
  if(/下午|晚上|晚间/.test(match[1]||'')&&hour<12)hour+=12;if(match[1]==='中午'&&hour<11)hour+=12;if(/早|上午/.test(match[1]||'')&&hour===12)hour=0;
 }
 if(!Number.isInteger(hour)||hour<0||hour>23||!Number.isInteger(minute)||minute<0||minute>59)return {kind:'need_clarification',field:'classTime',message:'请告诉我上课时刻，例如“早八”或“10:00上课”。'};
 const resolved=resolveQuestionTrip(question,trip);if(resolved.clarification)return {kind:'need_clarification',message:resolved.clarification};const effective=resolved.trip;
 if(effective.origin===effective.destination)return {kind:'need_clarification',message:'请先在行程设置中选择不同的出发地和目的地，再询问上课出发时间。'};
 return {kind:'forecast',classTime:String(hour).padStart(2,'0')+':'+String(minute).padStart(2,'0'),bufferMinutes:5,goal,trip:effective};
}
