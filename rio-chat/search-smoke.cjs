"use strict";
const {loadSettings,requestReply}=require('./chat.cjs');
const {runWeb}=require('./search.cjs');
(async()=>{
 const s=loadSettings(__dirname);
 if(!s?.search?.apiKey)throw Error('请先完成本地 Kimi 搜索设置，并确保聊天已启用。');
 const data=await runWeb(s.search,{query:'オンゲキ BATTLE NO.1 EXPERT 手元',kind:'video'});
 if(data.error)throw Error(data.error);
 console.log(JSON.stringify({phase:'search',sources:data.sources.map(({title,url,kind})=>({title,url,kind}))},null,2));
 const r=await requestReply(s,[{role:'user',content:'请联网找音击 BATTLE NO.1 EXPERT 红谱的手元视频，给我真实视频标题和链接就好，不用看视频。'}]);
 console.log(JSON.stringify({phase:'chat',text:r.text,attempts:r.attempts},null,2));
})().catch(()=>{console.error('搜索验证未通过：检查本地 Key、API 余额或网络。未输出密钥及原始异常。');process.exitCode=1;});
