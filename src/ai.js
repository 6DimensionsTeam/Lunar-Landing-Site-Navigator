export function offlineAnalysis(result) {
  const { point, zone, score, blockers } = result;
  return `Selected location: ${point.lat.toFixed(3)}° latitude, ${point.lon.toFixed(3)}° longitude. ` +
    (score == null ? 'This location is outside the mapped evaluation coverage; a suitability score is unavailable. ' :
      `The area-based recommendation is ${result.stars}/5 stars (${score}/100). Solar visibility is ${zone.sun.toFixed(1)}%, Earth visibility ${zone.earth.toFixed(1)}%, and mapped slope ${zone.slopeDeg.toFixed(1)}°. `) +
    (zone?.note ? zone.note + ' ' : '') + blockers.join(' ') +
    ' These grid averages do not establish landing safety or mission-time continuity. Ice likelihood is not a confirmed resource deposit.';
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
