import Fastify from 'fastify';
import {mkdir,readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const app=Fastify({logger:true});
const PORT=Number(process.env.PORT||8080),DATA=process.env.DATA_DIR||'/data';
const INDEX_URL=process.env.YUZONO_INDEX_URL;
const EXT=process.env.EXTENSION_SERVER_URL||'http://extension-server:8080';
const FLARE=process.env.FLARESOLVERR_URL||'http://flaresolverr:8191';
const TOKEN=process.env.API_TOKEN||'';
await mkdir(path.join(DATA,'extensions'),{recursive:true});
function auth(req,reply){if(!TOKEN)return true;const x=req.headers.authorization?.replace(/^Bearer\s+/i,'');if(x===TOKEN)return true;reply.code(401).send({error:'unauthorized'});return false;}
async function json(url,init={}){const r=await fetch(url,{...init,headers:{accept:'application/json',...(init.headers||{})}});if(!r.ok)throw Error(`HTTP ${r.status}`);return r.json();}
async function index(){const f=path.join(DATA,'yuzono-index.json');try{const s=await stat(f);if(Date.now()-s.mtimeMs<21600000)return JSON.parse(await readFile(f,'utf8'));}catch{}const x=await json(INDEX_URL);await writeFile(f,JSON.stringify(x));return x;}
function sources(i){return(Array.isArray(i)?i:[]).flatMap(e=>(e.sources||[]).map(s=>({...s,extension:{name:e.name,pkg:e.pkg,apk:e.apk,version:e.version,lang:e.lang,nsfw:e.nsfw}})));}
async function ext(pkg){return(Array.isArray(await index())?await index():[]).find(x=>x.pkg===pkg)||null;}
async function apk(e){const k=createHash('sha256').update(e.pkg+':'+e.version+':'+e.apk).digest('hex'),f=path.join(DATA,'extensions',k+'.apk');try{await stat(f);return f;}catch{}for(const u of [`https://raw.githubusercontent.com/yuzono/anime-repo/repo/apk/${encodeURIComponent(e.apk)}`,`https://cdn.jsdelivr.net/gh/yuzono/anime-repo@repo/apk/${encodeURIComponent(e.apk)}`]){try{const r=await fetch(u);if(!r.ok)continue;await writeFile(f,Buffer.from(await r.arrayBuffer()));return f;}catch{}}throw Error('extension APK download failed');}
async function invoke(s,method,extra={}){const e=await ext(s.extension.pkg);if(!e)throw Error('extension not found');const f=await apk(e),data=(await readFile(f)).toString('base64');const r=await fetch(EXT+'/dalvik',{method:'POST',headers:{'content-type':'application/json','cf-proxy-url':FLARE},body:JSON.stringify({data,method,sourceId:String(s.id??''),sourceBaseUrl:s.baseUrl||'',lang:s.lang||e.lang||'',...extra})});const t=await r.text();let x;try{x=JSON.parse(t)}catch{x={raw:t}}if(!r.ok)throw Error(x.error||`extension HTTP ${r.status}`);return x;}
app.get('/health',async()=>{let a='down',b='down';try{a=(await fetch(EXT+'/')).ok?'up':'down'}catch{}try{b=(await fetch(FLARE+'/')).ok?'up':'down'}catch{}return{ok:true,api:'up',extensionServer:a,flareSolverr:b}});
app.get('/extensions',async(req,rep)=>{if(!auth(req,rep))return;return index()});
app.get('/providers',async(req,rep)=>{if(!auth(req,rep))return;return{sources:sources(await index()).map(s=>({id:s.id,name:s.name,lang:s.lang,baseUrl:s.baseUrl,extension:s.extension}))}});
app.get('/source/:id/search',async(req,rep)=>{if(!auth(req,rep))return;const q=String(req.query.q||'').trim();if(!q)return rep.code(400).send({error:'q required'});const s=sources(await index()).find(x=>String(x.id)===String(req.params.id));if(!s)return rep.code(404).send({error:'source not found'});return invoke(s,'getSearchAnime',{page:1,search:q})});
app.get('/source/:id/anime/:url',async(req,rep)=>{if(!auth(req,rep))return;const s=sources(await index()).find(x=>String(x.id)===String(req.params.id));if(!s)return rep.code(404).send({error:'source not found'});return invoke(s,'getDetailsAnime',{animeData:{url:decodeURIComponent(req.params.url)}})});
app.get('/source/:id/episodes/:url',async(req,rep)=>{if(!auth(req,rep))return;const s=sources(await index()).find(x=>String(x.id)===String(req.params.id));if(!s)return rep.code(404).send({error:'source not found'});return invoke(s,'getEpisodeList',{animeData:{url:decodeURIComponent(req.params.url)}})});
async function adapter(env,q){const base=process.env[env];if(!base)return{configured:false,results:[]};const u=new URL(base);for(const[k,v]of Object.entries(q))if(v!=null)u.searchParams.set(k,String(v));return{configured:true,...await json(u.toString())};}
app.get('/subtitles/search',async(req,rep)=>{if(!auth(req,rep))return;return adapter('SUBTITLE_INDEXER_URL',{title:req.query.title,episode:req.query.episode,language:req.query.language||'en'})});
app.get('/nzb/search',async(req,rep)=>{if(!auth(req,rep))return;return adapter('NZB_INDEXER_URL',{title:req.query.title,episode:req.query.episode,year:req.query.year})});
app.get('/resolve/video',async(req,rep)=>rep.code(501).send({error:'provider adapter required'}));
app.listen({port:PORT,host:'0.0.0.0'}).catch(e=>{app.log.error(e);process.exit(1)});
