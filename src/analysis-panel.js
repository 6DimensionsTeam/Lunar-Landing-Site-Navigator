import { analyze, offlineAnalysis } from './ai.js';
import { mountFaultLayer } from './seismic.js';
import './analysis.css';

// Enrich the existing assessment panel; never replace the analysis screen or mission entry.
export function mountAnalysis({ THREE }) {
  mountFaultLayer(THREE, window.__lln_globe);
  const paragraph=document.getElementById('an-ai');
  const box=document.createElement('section');box.className='p3-chat';
  box.innerHTML='<details><summary>AI conversation (optional)</summary><p>Offline assessment is always available. Online questions and site context are sent to your HTTPS endpoint; keys stay in page memory.</p><input data-field="url" aria-label="API endpoint" placeholder="HTTPS OpenAI-compatible endpoint"><input data-field="model" aria-label="Model ID" placeholder="Model ID"><input data-field="key" aria-label="API key" type="password" placeholder="API key" autocomplete="off"><div role="log" aria-live="polite"></div><form><input data-field="question" aria-label="Question" placeholder="Ask about this site" required maxlength="2000"><button>Send</button></form></details>';
  paragraph.after(box);
  const field=name=>box.querySelector(`[data-field="${name}"]`),log=box.querySelector('[role="log"]');
  let current=null,history=[],revision=0,busy=false;
  box.querySelector('form').onsubmit=async e=>{
    e.preventDefault();if(!current||busy)return;const q=field('question').value.trim();if(!q)return;
    const rev=revision;history.push({role:'user',content:q});const p=document.createElement('p');p.textContent='You: '+q;log.append(p);field('question').value='';busy=true;box.querySelector('button').disabled=true;
    try{const answer=await analyze(current,history,{url:field('url').value,model:field('model').value,key:field('key').value});if(rev===revision){const p=document.createElement('p');p.textContent='Assistant: '+answer;log.append(p);history.push({role:'assistant',content:answer});}}
    finally{busy=false;box.querySelector('button').disabled=false;}
  };
  return sel=>{
    current=sel;history=[];revision++;log.replaceChildren();paragraph.textContent=offlineAnalysis(sel);
    const source=document.createElement('p');source.className='p3-source';source.textContent=sel.site.source==='data'?'DATA-SELECTED · Algorithm-selected region':'NASA CANDIDATE · Published candidate region';paragraph.before(source);
    paragraph.parentElement.querySelectorAll('.p3-source').forEach((p,i,all)=>{if(i<all.length-1)p.remove();});
    for(const blocker of sel.entry.fails){const p=document.createElement('p');p.className='p3-blocker';p.textContent=blocker;document.getElementById('an-reqs').append(p);}
  };
}
