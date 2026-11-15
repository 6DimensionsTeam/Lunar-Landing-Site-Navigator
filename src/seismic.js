import catalogue from './data/quakes.json';
// Same south-polar stereographic projection as geo.js; distances are planar approximations.
function project(lat, lon) {
  const r = 2 * 1737.4 * Math.tan((90 - Math.abs(lat)) * Math.PI / 360);
  return [r * Math.sin(lon * Math.PI / 180), r * Math.cos(lon * Math.PI / 180)];
}
export function nearestFault(site, scarps = catalogue.scarps) {
  const p = project(site.lat, site.lon);
  let nearest = null;
  for (const fault of scarps) {
    const a = project(...fault.start), b = project(...fault.end);
    const dx=b[0]-a[0], dy=b[1]-a[1], length=dx*dx+dy*dy;
    const t=length ? Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/length)) : 0;
    const distanceKm=Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy);
    if (!nearest || distanceKm<nearest.distanceKm) nearest={id:fault.id,distanceKm};
  }
  return nearest;
}
export function mountFaultLayer(THREE, globe) {
  const group=new THREE.Group(); group.visible=false;
  // Child geometry follows the globe rotation and is depth-occluded by its surface.
  globe.sphere.add(group);
  const material=new THREE.LineBasicMaterial({color:0xf1aa67,depthTest:true});
  const radius=globe.sphere.geometry.parameters.radius*1.002;
  for(const f of catalogue.scarps){
    const points=[];
    const start=new THREE.Vector3(),end=new THREE.Vector3();
    function direction(pair,out){const lat=pair[0]*Math.PI/180,lon=pair[1]*Math.PI/180;return out.set(-Math.cos(lat)*Math.cos(lon),Math.sin(lat),Math.cos(lat)*Math.sin(lon));}
    direction(f.start,start);direction(f.end,end);
    for(let i=0;i<=32;i++)points.push(start.clone().lerp(end,i/32).normalize().multiplyScalar(radius));
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points),material));
  }
  const control=document.createElement('div');control.className='fault-control';
  const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';
  label.append(input,document.createTextNode(' Fault proximity layer'));control.append(label);
  const credit=document.createElement('p');credit.textContent='Mapped lobate scarps · hazard proxy, not moonquake events. GRL 2022 · doi:10.1029/2022GL098505 · Zenodo 6624114 · CC-BY 4.0. No south-polar event catalogue; magnitude and recurrence are unknown.';control.append(credit);
  document.getElementById('select').append(control);input.onchange=()=>{group.visible=input.checked;};
}
