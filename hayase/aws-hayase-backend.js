const API='https://CHANGE-ME.example.com';
async function j(u){const r=await fetch(u);if(!r.ok)throw Error(`backend HTTP ${r.status}`);return r.json()}
export default{async test(){return(await fetch(API+'/health')).ok},async single(q){const title=q?.titles?.[0]||'';const episode=q?.episode??1;const x=await j(API+'/nzb/search?'+new URLSearchParams({title,episode}));return(x.results||[]).map(r=>({title:r.title,link:r.url,size:r.size||0,type:'http'}))},async batch(){return[]},async movie(){return[]}};
