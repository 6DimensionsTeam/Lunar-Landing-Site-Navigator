export function offlineAnalysis({site, entry, year}) {
  const st=entry.stats, fault=entry.seismic;
  return `${site.en} (${site.source === 'data' ? 'DATA-SELECTED' : 'NASA CANDIDATE'}) scores ${(entry.score*100).toFixed(0)}/100 using the shared ranking. ${year == null ? 'Long-term' : year+' annual'} sunlight ${st.sun_visible_pct.toFixed(1)}%, Earth visibility ${st.earth_visible_pct.toFixed(1)}%, simultaneous visibility ${st.both_pct.toFixed(1)}%; longest darkness ${st.longest_dark_h} h. `+
    (entry.fails.length ? 'Requirements not met: '+entry.fails.join('; ')+'. ' : 'Meets the configured screening requirements. ')+
    (fault ? `Nearest mapped lobate scarp: ${fault.distanceKm.toFixed(1)} km (south-polar projection approximation). ` : 'Fault proximity unavailable. ')+
    'Fault proximity is a hazard proxy, not an event catalogue or proof of safety. Magnitude and recurrence are unknown. The Earth-link screening threshold does not guarantee uninterrupted mission-time contact. Source: GRL 2022, doi:10.1029/2022GL098505; Zenodo 6624114; CC-BY 4.0.';
}
export async function analyze(result, messages, { url, model, key } = {}) {
  const fallback = offlineAnalysis(result);
  if (!url || !model || !key || globalThis.navigator?.onLine === false) return fallback;
  try {
    if (new URL(url).protocol !== 'https:') throw Error('HTTPS required');
    const response = await fetch(url, { method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: `Bearer ${key}`,
    }, body: JSON.stringify({ model, max_tokens: 700, messages: [
      { role: 'system', content: 'Explain lunar site data in English. Never invent missing measurements. Scores are preliminary area-based recommendations. Context: ' + fallback },
      ...messages.slice(-16),
    ] }), signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw Error('Request failed');
    const text = (await response.json()).choices?.[0]?.message?.content;
    return typeof text === 'string' && text.trim() ? text : fallback;
  } catch { return 'Online analysis unavailable. Local analysis: ' + fallback; }
}
