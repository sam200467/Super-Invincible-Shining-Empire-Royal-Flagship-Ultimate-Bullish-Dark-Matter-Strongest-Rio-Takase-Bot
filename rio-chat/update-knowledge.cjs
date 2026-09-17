"use strict";
// Public metadata only. No player records, login cookies or API keys are used.
const fs=require('node:fs'),path=require('node:path');
const root=__dirname,out=path.join(root,'knowledge');
async function main(){
 fs.mkdirSync(out,{recursive:true});
 const fetchedAt=new Date().toISOString();
 const local=JSON.parse(fs.readFileSync(path.join(root,'..','ongeki-song-catalog.json'),'utf8'));
 const charts=[];
 for(const s of local.songs)if(!s.meta.is_deleted)for(const difficulty of ['BAS','ADV','EXP','MAS','LUN']){
   const c=s[difficulty];if(c?.has_chart&&c.level)charts.push({id:s.meta.official_id,title:s.meta.name,artist:s.meta.artist,difficulty,level:c.level,constant:c.const_status==='known'?c.const:null,bpm:s.meta.bpm,version:s.meta.song_release_version});
 }
 const datasets=[['ongeki',{source:'项目 ongeki-song-catalog.json',scope:'音击项目曲库快照；收录/定数以此快照为准，不保证所有地区版本一致',updatedAt:local.meta.last_updated_at,fetchedAt,charts}]];
 for(const [game,api] of [['maimai','maimaidxprober'],['chunithm','chunithmprober']]){
   const source='https://www.diving-fish.com/api/'+api+'/music_data';
   const response=await fetch(source,{signal:AbortSignal.timeout(20000)});
   if(!response.ok)throw Error(game+' HTTP '+response.status);
   const songs=await response.json();if(!Array.isArray(songs)||!songs.length)throw Error('Invalid '+game+' data');
   const charts=[];
   for(const s of songs)for(let i=0;i<s.level.length;i++){
    if(!s.title||!s.level[i])continue;
    charts.push({id:String(s.id),title:s.title,artist:s.basic_info?.artist,difficulty:['BAS','ADV','EXP','MAS',game==='maimai'?'REM':'ULT'][i],level:s.level[i],constant:Number(s.ds?.[i])>0?s.ds[i]:null,type:s.type||null,bpm:s.basic_info?.bpm,version:s.basic_info?.from});
   }
   datasets.push([game,{source,scope:'水鱼查分器曲库；具体当前地区版本未由接口独立标注，不能当作日服/国际服实时收录证明',updatedAt:null,fetchedAt,charts}]);
 }
 for(const [game,data]of datasets){
   const target=path.join(out,game+'.json');fs.writeFileSync(target+'.tmp',JSON.stringify(data));fs.renameSync(target+'.tmp',target);
   console.log(game+': '+data.charts.length+' charts');
 }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
