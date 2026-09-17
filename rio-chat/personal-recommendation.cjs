"use strict";
// Public song metadata never establishes a player's achievements. Keep this
// gate outside model generation, including retries and plain-text fallback.
function needsPersonalRecords(messages){
 const users=messages.filter(m=>m.role==='user');
 const current=users.at(-1)?.content||'';
 if(/(?:不用|不需要|不看|不按|忽略).{0,8}(?:成绩|成績|记录|紀錄)|普通推荐|普通推薦/.test(current))return false;
 const personal=/(?:没|沒|未|还没|還沒|尚未|已经|已經).{0,5}(?:鸟|鳥|打过|打過|玩过|玩過|达成|達成|清过|清過|通关|通關|SSS|SS|AJ|AP|AB|FC|全连|全連)|(?:根据|根據|按照|按|结合|結合).{0,12}(?:成绩|成績|记录|紀錄)|(?:成绩|成績|记录|紀錄).{0,10}(?:推荐|推薦|选|選|挑)|(?:差点|差點|快要|接近).{0,4}(?:鸟|鳥|SSS|AJ|AP)/i;
 const recommendation=/推荐|推薦|推歌|推几|推幾|来点|來點|来几|來幾|挑|选|選|哪些|哪几|哪幾|有什么|有什麼|找|筛|篩|排除/;
 if(personal.test(current)&&(recommendation.test(current)||/\d{1,2}\+|\d{1,2}级/.test(current)))return true;
 // Carry an unresolved personal filter through short follow-ups, but stop when
 // the user explicitly switches to ordinary recommendations.
 if(/^(?:那|就|都|随便|隨便|换|換|再|红谱|紫谱|\d)|具体歌名/.test(current)&&current.length<100){
  for(let i=users.length-2;i>=Math.max(0,users.length-4);i--){
   const text=users[i].content;
   if(/普通推荐|不用.{0,8}成绩/.test(text))break;
   if(personal.test(text)&&recommendation.test(text))return true;
  }
 }
 return false;
}
const unavailable='这需要读取个人成绩后再筛选。目前聊天推荐只接了公共曲库，还没有接入按个人成绩筛选，不能确认哪些是没鸟过或没打过的。';
async function bindingNotice(getBinding,userId,targets=[],bindHint='请先绑定账号。'){
 if(targets.length>1)return '需要先明确要查谁的个人成绩；公共曲库不能判断对方哪些谱面没鸟过。';
 const target=targets[0]||userId;
 const binding=await getBinding(String(target));
 if(!binding)return target===userId?'你还没有绑定账号，我读取不到你的个人成绩，不能筛选“没鸟过／没打过”的谱面。'+bindHint:'对方还没有绑定账号，无法读取个人成绩，不能替对方筛选没鸟过或没打过的谱面。';
 if(target!==userId&&binding.allowOthers!==true)return '对方没有开放成绩查询，不能读取或推测对方的个人成绩来推荐。';
 return unavailable;
}
module.exports={needsPersonalRecords,bindingNotice,unavailable};
