"use strict";
const test=require("node:test"), assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const {createChat,chooseImage,preference,requestReply}=require("./chat.cjs");
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
 const s=settings();assert.equal(chooseImage(result,s,false,()=>0.39).id,"small_smile");assert.equal(chooseImage(result,s,false,()=>0.4),null);
 const emotional={...result,emotion:"proud"};
 assert.ok(chooseImage(emotional,s,false,()=>0.79));assert.equal(chooseImage(emotional,s,false,()=>0.8),null);
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
test_("stop teasing persists beyond history expiry and reset",async()=>{
 assert.equal(preference("不要再嘲讽我",false),true);
 let clock=0;const calls=[];const chat=createChat(settings(),host,{now:()=>clock,fetchImpl:async(u,o)=>{calls.push(JSON.parse(o.body));return mock()},random:()=>0});
 await chat.handle(msg("a","<@123> 别调侃我"));clock=4000000;
 await chat.handle(msg("a","<@123> 清空对话"));
 const m=msg("a","<@123> hello");await chat.handle(m);
 assert.ok(JSON.stringify(calls.at(-1)).includes("该用户已要求停止调侃"));assert.ok(!m.replies[0].files);
 await chat.handle(msg("a","<@123> 可以继续斗嘴了"));assert.ok(!calls.at(-1).messages.some(x=>x.content==="该用户已要求停止调侃。认真温和回复，禁止斗嘴和自动配图。"));chat.close();
});
test_("concurrent requests do not race, stop applies in flight",async()=>{
 let resolve;const chat=createChat(settings(),host,{fetchImpl:()=>new Promise(r=>resolve=r),random:()=>0});
 const a=msg("a");const pending=chat.handle(a);await new Promise(r=>setImmediate(r));
 const b=msg("a","<@123> 别调侃我");await chat.handle(b);assert.equal(b.replies.length,1);
 resolve(await mock()());await pending;assert.ok(a.replies[0].content.includes("不逗你"));assert.ok(!a.replies[0].files);chat.close();
});
test_("explicit image, permission fallback, repeated images allowed",async()=>{
 const chat=createChat(settings(),host,{fetchImpl:mock(),random:()=>0.99});
 for(let i=0;i<2;i++){const m=msg("a","<@123> 发第6张表情");await chat.handle(m);assert.ok(m.replies[0].files[0].attachment.endsWith(".gif"));}
 const m=msg("a","<@123> 发第6张表情");m.channel.permissionsFor=()=>({has:()=>false});await chat.handle(m);assert.ok(!m.replies[0].files);chat.close();
});
test_("API sends requested model, JSON, nonthinking; rejects invalid data and hides raw errors",async()=>{
 const s=settings();let req;
 await requestReply(s,[{role:"user",content:"hi"}],{fetchImpl:async(u,o)=>{req=JSON.parse(o.body);return mock()()}});
 assert.equal(req.model,"deepseek-flash");assert.equal(req.thinking.type,"disabled");assert.equal(req.response_format.type,"json_object");
 await assert.rejects(requestReply(s,[],{fetchImpl:mock({text:s.c.provider.apiKey})}),/敏感/);
 await assert.rejects(requestReply(s,[],{fetchImpl:async()=>({ok:false,status:401})}),/HTTP 401/);
 const m=msg();const chat=createChat(s,host,{fetchImpl:async()=>{throw Error("secret "+s.c.provider.apiKey)}});await chat.handle(m);assert.ok(!JSON.stringify(m.replies).includes(s.c.provider.apiKey));chat.close();
});
