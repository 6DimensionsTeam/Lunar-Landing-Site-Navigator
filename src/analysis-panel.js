import { evaluateLocation } from './analyze.js';
import { analyze, offlineAnalysis } from './ai.js';
import './analysis.css';

export function mountAnalysis({ renderer, zones, mission, THREE }) {
  const host = document.getElementById('analysis');
  host.innerHTML = `<section class="panel p3-panel" aria-label="Landing location information">
    <h2>Landing reconnaissance <button id="p3-close" type="button">×</button></h2>
    <p>Where would you like to land? Rotate the Moon, then click any surface location.</p>
    <div id="p3-info" aria-live="polite"></div>
    <button id="p3-confirm" class="cta2" disabled>Confirm landing site</button>
    <button id="p3-ai" class="cta2" disabled>AI analysis</button>
    <p id="p3-status" role="status"></p>
    <section id="p3-chat" hidden><h2>Landing analysis assistant</h2>
      <details><summary>Connect a model (optional)</summary>
      <p>HTTPS OpenAI-compatible endpoint. Key stays in page memory. Questions and site data are sent to this endpoint.</p>
      <input id="p3-url" placeholder="https://your-service/v1/chat/completions" aria-label="API endpoint">
      <input id="p3-model" placeholder="Model ID" aria-label="Model ID">
      <input id="p3-key" placeholder="API key" type="password" autocomplete="off" aria-label="API key"></details>
      <div id="p3-messages" role="log" aria-live="polite"></div>
      <form id="p3-form"><input id="p3-question" required maxlength="2000" placeholder="Ask about this location" aria-label="Question"><button id="p3-send">Send</button></form>
    </section></section><div id="p3-marker" hidden aria-hidden="true">＋</div><div id="p3-reward" hidden role="status"></div>`;
  const $ = id => host.querySelector('#p3-' + id);
  let bodyPoint = null;
  let current = null, confirmed = false, history = [], down = null, timer, revision = 0;
  const marker = new THREE.Vector3();
  function row(list, label, value) {
    const div = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = label; dd.textContent = value; div.append(dt, dd); list.append(div);
  }
  function choose(point) {
    revision++; current = evaluateLocation(point, zones, mission.cfg); confirmed = false; history = [];
    $('confirm').disabled = false; $('ai').disabled = true; $('chat').hidden = true;
    $('messages').replaceChildren(); $('status').textContent = '';
    const z = current.zone, list = document.createElement('dl'); list.className = 'rows';
    row(list, 'Latitude / longitude', `${point.lat.toFixed(3)}° / ${point.lon.toFixed(3)}°`);
    row(list, 'Terrain class', z?.name || 'Outside mapped coverage');
    row(list, 'Slope', z ? `${z.slopeDeg.toFixed(1)}°` : 'Unavailable');
    row(list, 'Solar / Earth visibility', z ? `${z.sun.toFixed(1)}% / ${z.earth.toFixed(1)}%` : 'Unavailable');
    row(list, 'Temperature estimate', z?.tmaxK != null ? `${z.tmaxK} K (coarse grid)` : 'Unavailable');
    row(list, 'Distance to shadow', z?.iceDistKm != null ? `${z.iceDistKm.toFixed(1)} km` : 'Unavailable');
    row(list, 'Ice likelihood', z ? (z.iceLikely ? 'Possible, not confirmed' : 'Not established') : 'Unavailable');
    row(list, 'Recommendation', current.stars == null ? '☆☆☆☆☆ · Not rated (missing data)' : '★'.repeat(current.stars) + '☆'.repeat(5-current.stars) + ` · ${current.stars}/5`);
    const note = document.createElement('p'); note.textContent = [z?.note, ...current.blockers,
      'Preliminary area-based recommendation. Grid data do not certify landing safety.'].filter(Boolean).join(' ');
    $('info').replaceChildren(list, note); marker.copy(point.point); bodyPoint=marker.clone().applyQuaternion(window.__lln_globe.sphere.quaternion.clone().invert()); $('marker').hidden = false;
  }
  renderer.domElement.addEventListener('pointerdown', e => { down = { x:e.clientX, y:e.clientY, id:e.pointerId }; });
  renderer.domElement.addEventListener('pointercancel', () => { down = null; });
  renderer.domElement.addEventListener('pointerup', e => {
    const start=down; down=null;
    if (!start || start.id!==e.pointerId || Math.hypot(e.clientX-start.x,e.clientY-start.y)>5 || document.getElementById('select').hidden) return;
    const globe=window.__lln_globe;
    const point=globe.surfaceAt(e.clientX,e.clientY,innerWidth,innerHeight);
    if (point) { host.hidden=false; globe.stopSpin(); choose(point); }
  });
  // Project the body-fixed target each frame so rotation never leaves a stale screen marker.
  function frame() {
    if (bodyPoint && !host.hidden) {
      const globe=window.__lln_globe, p=bodyPoint.clone().applyQuaternion(globe.sphere.quaternion);
      const facing=p.clone().normalize().dot(globe.camera.position.clone().sub(p))>0;
      p.project(globe.camera); $('marker').hidden=!facing || document.getElementById('select').hidden;
      $('marker').style.transform=`translate(${(p.x*.5+.5)*innerWidth}px,${(.5-p.y*.5)*innerHeight}px)`;
    }
    requestAnimationFrame(frame);
  }
  frame();
  $('close').onclick=()=>{host.hidden=true;};
  $('confirm').onclick=()=>{
    if(!current || confirmed)return; confirmed=true; $('confirm').disabled=true; $('ai').disabled=false;
    // Outside mapped coverage, permit exploration without fabricating suitability points.
    const points=current.score ?? 0;
    $('status').textContent=current.score==null?'Location submitted. Suitability unavailable; 0 points awarded.':`Location submitted · ${points} points awarded.`;
    clearTimeout(timer); $('reward').hidden=false; $('reward').textContent=`+${points} POINTS REWARDED`;
    $('reward').getAnimations().forEach(a=>a.cancel()); $('reward').animate([{opacity:0,translate:'0 20px'},{opacity:1,translate:'0 0',offset:.15},{opacity:1,offset:.8},{opacity:0,translate:'0 -25px'}],{duration:2000});
    timer=setTimeout(()=>{$('reward').hidden=true;},2000);
  };
  function message(role,text){const p=document.createElement('p');p.textContent=`${role}: ${text}`;$('messages').append(p);}
  $('ai').onclick=()=>{if(!confirmed)return;$('chat').hidden=false;if(!history.length){message('Assistant',offlineAnalysis(current));history.push({role:'assistant',content:offlineAnalysis(current)});}};
  $('form').onsubmit=async e=>{
    e.preventDefault();if(!confirmed || $('send').disabled)return;
    const question=$('question').value.trim();if(!question)return;
    const rev=revision;history.push({role:'user',content:question});message('You',question);$('question').value='';$('send').disabled=true;
    try{const answer=await analyze(current,history,{url:$('url').value,model:$('model').value,key:$('key').value});if(rev===revision){history.push({role:'assistant',content:answer});message('Assistant',answer);}}
    finally{$('send').disabled=false;}
  };
  // Route the existing entry button to the native globe without replacing the surface renderer.
  document.getElementById('enter').addEventListener('click',e=>{e.stopImmediatePropagation();window.__lln_showGlobe();},true);
}
