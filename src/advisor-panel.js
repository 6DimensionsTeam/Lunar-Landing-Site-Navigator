import { reviewLanding } from './landing-advisors.js';
import './advisor-panel.css';

export function mountAdvisors() {
  const host = document.getElementById('an-ai');
  const panel = document.createElement('section'); panel.className = 'historical-advisors';
  panel.setAttribute('aria-label', 'Historical landing failure review'); host.after(panel);
  return ({site}) => {
    panel.replaceChildren();
    const title=document.createElement('h3');title.textContent='Historical failure advisors';panel.append(title);
    const intro=document.createElement('p');intro.textContent='Three sourced accident reviews ask whether the same mechanism has been addressed. Not a complete accident catalogue. These advisors do not score, certify safety or change the shared ranking.';panel.append(intro);
    for(const rule of reviewLanding(site)) {
      const details=document.createElement('details'),summary=document.createElement('summary');
      summary.textContent=`${rule.mission} (${rule.year}) · ${rule.status}`;details.append(summary);
      for(const text of [rule.question,'Reported cause: '+rule.evidence,'Scope: '+rule.scope,
        'Dataset fields: '+(rule.fields.join(', ')||'None; engineering data required'),
        ...rule.observations,rule.limit,rule.threshold]) {
        const p=document.createElement('p');p.textContent=text;details.append(p);
      }
      const a=document.createElement('a');a.href=rule.source;a.target='_blank';a.rel='noopener noreferrer';a.textContent='Official investigation / operator statement';details.append(a);panel.append(details);
    }
  };
}
