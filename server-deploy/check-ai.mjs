import {loadProviderConfig} from '../ai-provider/config.mjs';
import {checkDeepSeek} from '../ai-provider/deepseek.mjs';
try{
  const config=await loadProviderConfig('student',()=>({}),{env:{...process.env,AI_PROVIDER:'deepseek',STUDENT_AI_PROVIDER:'deepseek'}});
  console.log(JSON.stringify(await checkDeepSeek(config)));
}catch(error){console.error(JSON.stringify({connected:false,code:error.code||'configuration_error',message:error.code?error.message:'请检查DeepSeek私有配置。'}));process.exitCode=1;}
