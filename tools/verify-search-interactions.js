const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict');
const root=path.resolve(__dirname,'..');
const client=fs.readFileSync(path.join(root,'script.js'),'utf8');
const worker=fs.readFileSync(path.join(root,'search-worker.js'),'utf8');
async function staleFailure() {
  let rejectOld,calls=0;
  const c={AbortController,DOMException,setTimeout,clearTimeout,searchGeneration:0,PAGE_SIZE:500,
    state:{query:'first',scope:'global',searchResults:null},cancelSearch(){},render(){},canUseStaticFiles:()=>true,
    fastSearch:()=>++calls===1?Promise.reject(Error('first failure')):Promise.resolve({data:[{title:'latest'}],more:false}),
    searchStaticChunks:()=>new Promise((resolve,reject)=>rejectOld=reject),showToast(){}};
  vm.createContext(c);
  vm.runInContext(client.slice(client.indexOf('  async function runSearch('),client.indexOf('  async function loadMore(')),c);
  const old=c.runSearch(1,false);await new Promise(setImmediate);
  c.state.query='latest';await c.runSearch(1,false);rejectOld(Error('late old failure'));await old;
  assert.equal(c.state.searchResults[0].title,'latest');
}
async function cancellationAndTimeout() {
  let phase='blocked',aborted=0,resolve;
  const replies=[];
  const c={self:{},atob,Response,DecompressionStream,Uint8Array,Uint32Array,AbortController,DOMException,setTimeout,clearTimeout,
    AbortSignal:{any:AbortSignal.any.bind(AbortSignal),timeout:()=>AbortSignal.timeout(30)},
    fetch:async(url,{signal})=>{
      if(phase==='blocked') return new Promise((done,reject)=>{
        if(signal.aborted) return reject(signal.reason);
        signal.addEventListener('abort',()=>{aborted++;reject(signal.reason);},{once:true});
      });
      return new Response(fs.readFileSync(path.join(root,'data/fast-search',new URL(url).pathname.split('/').pop())));
    },postMessage:message=>{replies.push(message);resolve?.(message);}};
  vm.runInNewContext(worker,c);
  const message=id=>({id,needles:['0到1拍照'],type:'all',limit:20,base:'https://test.local',version:'test',replacements:[]});
  c.self.onmessage({data:message(1)});phase='ready';
  const second=await new Promise(done=>{resolve=done;c.self.onmessage({data:message(2)});});
  assert.equal(second.id,2);assert(!second.error);assert.equal(aborted,1);
  assert(!replies.some(r=>r.id===1));
  // A fresh worker and stalled network must report TimeoutError instead of waiting forever.
  phase='blocked';vm.runInNewContext(worker,{...c,self:c.self});
  const keepAlive=setTimeout(()=>{},1000);
  const timeout=await new Promise(done=>{resolve=done;c.self.onmessage({data:message(3)});});
  clearTimeout(keepAlive);assert.equal(timeout.errorName,'TimeoutError');
}
function pagination() {
  const records=Array.from({length:5438},(_,id)=>({id}));
  const el=()=>({classList:{toggle(){},add(){}},textContent:'',innerHTML:''});
  const c={state:{searching:false,stack:[],loading:false,directoryPage:1},DIRECTORY_PAGE_SIZE:200,
    elements:{list:el(),empty:el()},visibleRecords:()=>records,currentFolder:()=>null,childrenMap:{},
    emptyStateText:()=>'',getName:r=>String(r.id),isFolderRecord:()=>false,getKey:r=>String(r.id),
    getRecordFullPath:()=>'',getIndexedParentFolderPath:()=>'',getRecordFolderPath:()=>'',
    formatDisplayPath:()=>'',escapeAttribute:String,escapeHtml:String,fileIcon:'',folderIcon:''};
  vm.createContext(c);vm.runInContext(client.slice(client.indexOf('  function renderList()'),client.indexOf('  function render()')),c);
  c.renderList();assert.equal(c.state.renderedRecords.length,200);assert.equal(c.state.renderedRecords[0].id,0);
  c.state.directoryPage=2;c.renderList();assert.equal(c.state.renderedRecords[0].id,200);
  c.state.directoryPage=28;c.renderList();assert.equal(c.state.renderedRecords.length,38);assert.equal(c.state.renderedRecords[37].id,5437);
  assert(c.elements.list.innerHTML.includes('data-action="directory-next" disabled'));
}
(async()=>{await staleFailure();await cancellationAndTimeout();pagination();console.log('PASS: stale failure isolation, request cancellation, timeout, 5438-item pagination.');})().catch(error=>{console.error(error);process.exitCode=1;});
