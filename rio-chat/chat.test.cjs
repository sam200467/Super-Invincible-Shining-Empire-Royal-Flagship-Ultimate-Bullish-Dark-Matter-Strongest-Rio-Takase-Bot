"use strict";
const test=require("node:test"), assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const {createChat,chooseImage,failureReason,discomfort,requestReply,normalizeAction}=require("./chat.cjs");
// persona.md, examples.json and expressions.json are deployment content and are not
// shipped with this repository. Without them the suite cannot run, so skip it on a
// fresh clone rather than failing the build.
const missing=["persona.md","examples.json","expressions.json"].filter(f=>!fs.existsSync(path.join(__dirname,f)));
const skipReason=missing.length?"requires local "+missing.join(", "):false;
const test_=(name,fn)=>test(name,{skip:skipReason},fn);
function settings(){
 const c=JSON.parse(fs.readFileSync(path.join(__dirname,"config.example.json")));
 c.enabled=true;c.expressions.enabled=true;c.provider.apiKey="test-only-not-a-real-key";c.limits.userCooldownSeconds=0;
 const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,"expressions.json")));
 for(const e of manifest.entries)e.absoluteFile=path.join(__dirname,e.file);
 return {c,manifest,persona:fs.readFileSync(path.join(__dirname,"persona.md"),"utf8"),examples:JSON.parse(fs.readFileSync(path.join(__dirname,"examples.json"))).examples};
}
const result={text:"哼哼，找我就对了！今天想聊什么？尽管说吧！",emotion:"neutral",scene:"ordinary",expressionIds:["small_smile"]};
function mock(body=result){return async()=>({ok:true,json:async()=>({choices:[{finish_reason:"stop",message:{content:JSON.stringify(body)}}]})});}
let id=0;
function msg(user="u",text="<@123> 你好",channel="c"){
 const replies=[];return {id:String(++id),content:text,guildId:"g",channelId:channel,author:{id:user,bot:false},client:{user:{id:"123"}},channel:{sendTyping:async()=>{},permissionsFor:()=>({has:()=>true})},replies,reply:async x=>{replies.push(x);return x;}};
}
const host={guildId:"g",channelIds:["c","d"],proxyUrl:""};
test_("probabilities have no image cooldown or dedup",()=>{
 const s=settings();const p=s.manifest.selectionPolicy;
 assert.equal(chooseImage(result,s,false,()=>p.ordinaryProbability-0.01).id,"small_smile");
 assert.equal(chooseImage(result,s,false,()=>p.ordinaryProbability),null);
 const emotional={...result,emotion:"proud"};
 assert.ok(chooseImage(emotional,s,false,()=>p.clearEmotionProbability-0.01));
 assert.equal(chooseImage(emotional,s,false,()=>p.clearEmotionProbability),null);
 assert.ok(chooseImage({...result,scene:"explanation",expressionIds:["scarf_calm"]},s,false,()=>0.01));assert.equal(chooseImage(result,s,true,()=>0),null);
 assert.equal(chooseImage({...result,scene:"distress"},s,false,()=>0),null);
 assert.equal(chooseImage({...result,expressionIds:["../../secret","music_taunt"]},s,false,()=>0),null);
});
test_("message authorization, direct mention and dedup",async()=>{
 let calls=0;const chat=createChat(settings(),host,{fetchImpl:async(...a)=>{calls++;return mock()(...a)},random:()=>0});
 for(const m of [msg("u","hello"),msg("u","<@123> hello","wrong")])await chat.handle(m);
 const bot=msg();bot.author.bot=true;await chat.handle(bot);
 const dm=msg();dm.guildId=null;await chat.handle(dm);
 assert.equal(calls,0);
 const m=msg();await chat.handle(m);await chat.handle(m);assert.equal(calls,1);assert.equal(m.replies.length,1);
 assert.deepEqual(m.replies[0].allowedMentions,{parse:[],repliedUser:false});chat.close();
});
test_("history isolated by channel/user and bounded",async()=>{
 const calls=[];const s=settings();s.c.conversation.maxTurns=1;
 const chat=createChat(s,host,{fetchImpl:async(url,options)=>{calls.push(JSON.parse(options.body));return mock()()},random:()=>1});
 await chat.handle(msg("a","<@123> first-a"));
 await chat.handle(msg("b","<@123> first-b"));
 assert.ok(!JSON.stringify(calls[1]).includes("first-a"));
 await chat.handle(msg("a","<@123> other-channel","d"));assert.ok(!JSON.stringify(calls[2]).includes("first-a"));
 await chat.handle(msg("a","<@123> second-a"));assert.ok(JSON.stringify(calls[3]).includes("first-a"));
 await chat.handle(msg("a","<@123> third-a"));assert.ok(!JSON.stringify(calls[4]).includes("first-a"));
 await chat.handle(msg("a","<@123> 清空对话"));
 await chat.handle(msg("a","<@123> after-reset"));assert.ok(!JSON.stringify(calls[5]).includes("third-a"));chat.close();
});
test_("discomfort gets one-turn comfort without persistent serious mode",async()=>{
 assert.equal(discomfort("你刚才说话有点过分了"),true);
 assert.equal(discomfort("今天打什么歌"),false);
 const calls=[];const comfort={...result,text:"对不起嘛，我刚才得意过头了……给你顺顺毛，别生气啦。",scene:"distress"};
 const chat=createChat(settings(),host,{fetchImpl:async(u,o)=>{const body=JSON.parse(o.body);calls.push(body);return mock(calls.length===1?comfort:result)()},random:()=>1});
 const upset=msg("a","<@123> 你刚才说话有点过分了");await chat.handle(upset);
 assert.ok(upset.replies[0].content.includes("对不起"));
 assert.equal(calls[0].messages.filter(x=>x.role==="system").length,2);
 await chat.handle(msg("a","<@123> 那推荐一首歌吧"));
 assert.equal(calls[1].messages.filter(x=>x.role==="system").length,1);
 chat.close();
});
test_("model cannot switch an ordinary user into serious mode",async()=>{
 const s=settings(),calls=[];
 const mistaken={...result,text:"这是正常回复",stopTeasing:true};
 const chat=createChat(s,host,{fetchImpl:async(u,o)=>{calls.push(JSON.parse(o.body));return mock(mistaken)()},random:()=>1});
 const first=msg("a","<@123> 今天打什么歌");await chat.handle(first);
 assert.equal(first.replies[0].content,"这是正常回复");
 assert.ok(!first.replies[0].content.includes("不逗你了"));
 await chat.handle(msg("a","<@123> 那再推荐一首"));
 assert.ok(!calls.at(-1).messages.some(x=>x.content==="该用户已要求停止调侃。认真温和回复，禁止斗嘴和自动配图。"));
 chat.close();
});
test_("concurrent requests do not race",async()=>{
 let resolve;const chat=createChat(settings(),host,{fetchImpl:()=>new Promise(r=>resolve=r),random:()=>0});
 const a=msg("a");const pending=chat.handle(a);await new Promise(r=>setImmediate(r));
 const b=msg("a","<@123> 再问一句");await chat.handle(b);assert.equal(b.replies.length,1);assert.ok(b.replies[0].content.includes("上一条"));
 resolve(await mock()());await pending;assert.ok(a.replies[0].content.includes("哼哼"));chat.close();
});
test_("explicit image, permission fallback, repeated images allowed",async()=>{
 const chat=createChat(settings(),host,{fetchImpl:mock(),random:()=>0.99});
 for(let i=0;i<2;i++){const m=msg("a","<@123> 发第6张表情");await chat.handle(m);assert.ok(m.replies[0].files[0].attachment.endsWith(".gif"));}
 const m=msg("a","<@123> 发第6张表情");m.channel.permissionsFor=()=>({has:()=>false});await chat.handle(m);assert.ok(!m.replies[0].files);chat.close();
 let qqReply;const qq=createChat(settings(),host,{fetchImpl:mock(),random:()=>0.99,adapter:{
   accepts:()=>true,extractText:x=>x.content,typing:async()=>{},send:async(_m,text,file)=>{qqReply={text,file};}
 }});
 await qq.handle({id:"qq-image-1",content:"发第6张表情",guildId:"qq",channelId:"996",author:{id:"u",bot:false}});
 assert.ok(qqReply.file.absoluteFile.endsWith(".gif"));qq.close();
});
test_("API sends requested model, JSON, nonthinking; rejects invalid data and hides raw errors",async()=>{
 const s=settings();let req;
 await requestReply(s,[{role:"user",content:"hi"}],{fetchImpl:async(u,o)=>{req=JSON.parse(o.body);return mock()()}});
 assert.equal(req.model,"deepseek-flash");assert.equal(req.thinking.type,"disabled");assert.equal(req.response_format.type,"json_object");
 // 不发送 max_tokens，交给服务端默认上限；长度由 limits.maxReplyChars 兜底。
 assert.ok(!("max_tokens" in req)&&!JSON.stringify(req).includes("maxTokens"));
 await assert.rejects(requestReply(s,[],{fetchImpl:mock({text:s.c.provider.apiKey})}),/敏感/);
 await assert.rejects(requestReply(s,[],{fetchImpl:async()=>({ok:false,status:401})}),/HTTP 401/);
 const m=msg();const chat=createChat(s,host,{fetchImpl:async()=>{throw Error("secret "+s.c.provider.apiKey)}});await chat.handle(m);assert.ok(!JSON.stringify(m.replies).includes(s.c.provider.apiKey));chat.close();
});
test_("failure log names the cause and never prints the key",async()=>{
 const s=settings(),logs=[];
 const run=async error=>{const chat=createChat(s,host,{log:t=>logs.push(t),fetchImpl:async()=>{throw error}});await chat.handle(msg());chat.close();return logs.at(-1)};
 const network=Error("fetch failed");network.cause={code:"ECONNREFUSED"};assert.ok((await run(network)).includes("ECONNREFUSED"));
 const aborted=Error("This operation was aborted");aborted.name="AbortError";assert.ok((await run(aborted)).includes("请求超时"));
 const http=Error("DeepSeek HTTP 402：Insufficient Balance");assert.ok((await run(http)).includes("HTTP 402：Insufficient Balance"));
 assert.ok((await run(Error("boom "+s.c.provider.apiKey))).includes("***"));
 assert.ok(!logs.some(t=>t.includes(s.c.provider.apiKey)));
 assert.equal(failureReason(Error("DeepSeek返回格式无效：\"\""),undefined),"DeepSeek返回格式无效：\"\"");
});
test_("prefill prevents blank replies, a blank retries once then degrades",async()=>{
 const s=settings();const requests=[];
 const blank={ok:true,json:async()=>({choices:[{finish_reason:"stop",message:{content:" ".repeat(43)}}]})};
 const chat=createChat(s,host,{fetchImpl:async(u,o)=>{requests.push(JSON.parse(o.body));return requests.length===1?blank:await mock()()}});
 const m=msg("a","<@123> 你很擅长音击吗");await chat.handle(m);
 assert.equal(requests.length,2);
 assert.deepEqual(requests[0].messages.at(-1),{role:"assistant",content:"{"});
 assert.ok(m.replies[0].content.includes("哼哼"));
 let blanks=0;const chat2=createChat(s,host,{log:()=>{},fetchImpl:async()=>{blanks++;return blank}});
 const m2=msg("b","<@123> 再问一次");await chat2.handle(m2);
 assert.equal(blanks,3); // JSON 两次 + 纯文本降级一次，都空白才报错
 assert.equal(m2.replies.length,1);assert.ok(m2.replies[0].content.includes("没能顺利完成"));
 chat.close();chat2.close();
});
test_("two blank JSON replies degrade to a plain-text answer",async()=>{
 const s=settings();const bodies=[],logs=[];
 const blank={ok:true,json:async()=>({choices:[{finish_reason:"stop",message:{content:" ".repeat(43)}}]})};
 const chat=createChat(s,host,{log:t=>logs.push(t),random:()=>0,fetchImpl:async(u,o)=>{
   bodies.push(JSON.parse(o.body));
   return bodies.length<=2?blank:{ok:true,json:async()=>({choices:[{finish_reason:"stop",message:{content:"那次是我状态不好，下次一定赢回来。"}}]})};
 }});
 const m=msg("a","<@123> 你到底行不行");await chat.handle(m);
 assert.equal(bodies.length,3);
 assert.ok(!("response_format" in bodies[2])&&!bodies[2].messages.some(x=>x.role==="assistant"));
 assert.equal(m.replies[0].content,"那次是我状态不好，下次一定赢回来。");
 assert.ok(!m.replies[0].files);
 assert.ok(logs.some(t=>t.includes("已降级为纯文本")));
 chat.close();
});
test_("reply parses when the prefilled brace is not echoed back",async()=>{
 const s=settings();
 const r=await requestReply(s,[{role:"user",content:"hi"}],{fetchImpl:async()=>({ok:true,json:async()=>({choices:[{finish_reason:"stop",message:{content:JSON.stringify(result).slice(1)}}]})})});
 assert.equal(r.text,result.text);
});
// ── 工具调用（查分统一进来之后新增的那条契约）──────────────────────────
const specs=[{name:"song",label:"单曲成绩图",argHint:"曲名或 Song ID"},{name:"calculate",label:"Rating",argHint:"定数 技术分"}];
const withAction={text:"哼哼，这就去翻你的成绩——",emotion:"proud",scene:"ordinary",expressionIds:[],action:{name:"song",query:"id870"}};
test_("host actions reach the model prompt and the executor",async()=>{
 const s=settings();let body,seen;
 const chat=createChat(s,host,{adapter:{actions:specs,actionTarget:true,runAction:async(a,m,r)=>{seen={a,r};return {handled:true}}},
   fetchImpl:async(u,o)=>{body=JSON.parse(o.body);return mock(withAction)()}});
 const m=msg("a","<@123> 帮我查一下 id870 的成绩");await chat.handle(m);
 assert.match(body.messages[0].content,/单曲成绩图/);           // 清单进了提示词
 assert.match(body.messages[0].content,/target/);               // 开了查别人就说明 target 怎么用
 assert.deepEqual(seen.a,{name:"song",query:"id870"});
 assert.equal(seen.r.text,"哼哼，这就去翻你的成绩——");           // 执行器拿得到模型那句话
 assert.equal(m.replies.length,0);                              // 宿主说发了，聊天模块就不再发
 chat.close();
});
test_("target is passed through but only as a plain handle",async()=>{
 const s=settings();let seen;
 const chat=createChat(s,host,{adapter:{actions:specs,actionTarget:true,runAction:async(a)=>{seen=a;return {handled:true}}},
   fetchImpl:mock({...withAction,action:{name:"song",query:"id870",target:"10086"}})});
 await chat.handle(msg("a","<@123> 帮我查一下他的成绩"));
 assert.deepEqual(seen,{name:"song",query:"id870",target:"10086"});
 chat.close();
 // 没开 actionTarget 时不提 target；编号里的怪字符也会被收敛掉
 const chat2=createChat(s,host,{adapter:{actions:specs,runAction:async(a)=>{seen=a;return {handled:true}}},
   fetchImpl:mock({...withAction,action:{name:"song",query:"id870",target:"../etc/passwd"}})});
 await chat2.handle(msg("b","<@123> 帮我查一下他的成绩"));
 assert.equal(seen.target,"etcpasswd");
 assert.equal(normalizeAction({name:"song",target:""},specs).target,undefined);
 chat2.close();
});
test_("without an executor the tool list stays out of the prompt",async()=>{
 const s=settings();let body;
 const chat=createChat(s,host,{adapter:{actions:specs},fetchImpl:async(u,o)=>{body=JSON.parse(o.body);return mock(withAction)()}});
 const m=msg("a","<@123> 帮我查一下 id870 的成绩");await chat.handle(m);
 assert.ok(!body.messages[0].content.includes("工具调用"));
 assert.equal(m.replies[0].content,"哼哼，这就去翻你的成绩——");    // 退化成普通聊天
 chat.close();
});
test_("a model-written tool name outside the list is dropped",async()=>{
 const s=settings();let called=0;
 const chat=createChat(s,host,{adapter:{actions:specs,runAction:async()=>{called++;return {handled:true}}},
   fetchImpl:mock({...withAction,action:{name:"rm -rf",query:"x"}})});
 const m=msg("b","<@123> 帮我查一下 id870 的成绩");await chat.handle(m);
 assert.equal(called,0,"清单外的工具名不该进执行器");
 assert.equal(m.replies[0].content,"哼哼，这就去翻你的成绩——");   // 退化成普通聊天
 chat.close();
});
test_("handled:false hands the reply back to the chat module",async()=>{
 const s=settings();let called=0;
 const chat=createChat(s,host,{adapter:{actions:specs,runAction:async()=>{called++;return {handled:false,text:"宿主想说这句"}}},
   fetchImpl:mock(withAction)});
 const m=msg("c","<@123> 帮我查一下 id870 的成绩");await chat.handle(m);
 assert.equal(called,1);
 assert.equal(m.replies[0].content,"宿主想说这句");
 chat.close();
});
test_("group context from the adapter becomes a leading system note",async()=>{
 const s=settings();let body;
 const chat=createChat(s,host,{adapter:{context:()=>["19:40 小明：今天状态真差","19:41 梨绪：SAM2004 的 B50 分表（图片）"]},
   fetchImpl:async(u,o)=>{body=JSON.parse(o.body);return mock()()}});
 await chat.handle(msg("a","<@123> 这个人是不是有点弱啊"));
 const systems=body.messages.filter(m=>m.role==="system");
 assert.equal(systems.length,2);                       // 人设 + 群上下文
 assert.match(systems[1].content,/今天状态真差/);
 assert.match(systems[1].content,/不要逐条回应/);
 assert.equal(body.messages.some(m=>m.content&&m.content.includes("这个人是不是有点弱啊")&&m.role==="system"),false);
 chat.close();
 // 没有 context 钩子时不插这条
 const chat2=createChat(s,host,{fetchImpl:async(u,o)=>{body=JSON.parse(o.body);return mock()()}});
 await chat2.handle(msg("b","<@123> 你好"));
 assert.equal(body.messages.filter(m=>m.role==="system").length,1);
 chat2.close();
});
test_("a tool call with no text of its own is still a valid reply",async()=>{
 const s=settings();
 const r=await requestReply(s,[{role:"user",content:"hi"}],{actions:specs,
   fetchImpl:mock({emotion:"neutral",scene:"ordinary",expressionIds:[],action:{name:"song",query:"id870"}})});
 assert.equal(r.text,"");            // 不判成「回复为空」——说明文字由程序补
 assert.deepEqual(r.action,{name:"song",query:"id870"});
 await assert.rejects(requestReply(s,[{role:"user",content:"hi"}],{actions:specs,fetchImpl:mock({text:"   "})}),/回复为空/);
});
