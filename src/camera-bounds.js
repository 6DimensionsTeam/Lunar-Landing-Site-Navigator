// Bounds for the interactive terrain camera only. No render loop is created here.
import { Vector2, Vector3, MathUtils } from 'three';
import { mapToScene, sceneToMap } from './geo.js';

export function installCameraBounds({ camera, controls, tiles, radiusKm, heightAt, isActive }) {
  if (!camera?.isPerspectiveCamera || !controls?.target || typeof heightAt !== 'function' || typeof isActive !== 'function' || !(radiusKm > 0)) {
    throw new TypeError('A perspective camera, controls, terrain sampler and active-mode predicate are required.');
  }
  const extent = tile => tile.half_extent_m / 1000;
  const resolution = tile => (tile.res_m ?? tile.half_extent_m * 2 / tile.size) / 1000;
  for (const name of ['hero', 'inner', 'outer']) {
    const tile = tiles?.[name];
    if (!tile || !(extent(tile) > 0) || !(resolution(tile) > 0) || !Number.isFinite(tile.min_m) || !Number.isFinite(tile.max_m)) {
      throw new TypeError(`Valid ${name} terrain metadata is required.`);
    }
  }
  // Leave interpolation cells at data edges. The distant skirt is never a navigation domain.
  const heroHalf = extent(tiles.hero) - resolution(tiles.hero) * 2;
  const innerHalf = extent(tiles.inner) - resolution(tiles.inner) * 2;
  const outerHalf = extent(tiles.outer) - resolution(tiles.outer) * 8;
  const minGround = Math.min(tiles.hero.min_m, tiles.inner.min_m, tiles.outer.min_m) / 1000;
  const maxGround = Math.max(tiles.hero.max_m, tiles.inner.max_m, tiles.outer.max_m) / 1000;
  const finestCell = Math.min(resolution(tiles.hero), resolution(tiles.inner), resolution(tiles.outer));
  const floorKm = .0005, surfaceRadius = radiusKm + minGround;
  const outerAngle = 2 * Math.atan(outerHalf / (2 * radiusKm));
  const originalUpdate = controls.update;
  const originalLimits = { min: controls.minDistance, max: controls.maxDistance };
  const cameraMap = new Vector2(), targetMap = new Vector2(), sampleMap = new Vector2();
  const offset = new Vector3(), previousTarget = new Vector3(), correction = new Vector3(), samplePoint = new Vector3();
  const cachedPosition = new Vector3(), cachedTarget = new Vector3();
  let cached = false, enforcing = false, disposed = false, lastMin, lastMax;
  let updateDepth = 0, flushing = false, ownedActive = false;
  let userMin = controls.minDistance, userMax = controls.maxDistance;
  let cachedFov, cachedAspect, cachedNear, cachedZoom, snapshot = null;
  const stats = { checks: 0, evaluations: 0, corrections: 0, heightSamples: 0 };
  const sample = point => { stats.heightSamples++; return heightAt(point); };
  const finite = vector => Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);
  // OrbitControls' spherical round trip introduces tiny coordinate noise even at rest.
  // Keep the cached pose fixed until real movement accumulates beyond a tenth of a micrometre.
  const samePosition = (a, b) => a.distanceToSquared(b) <= 1e-20;
  const clamp = MathUtils.clamp;
  const externalPose = () => cached && (!samePosition(camera.position, cachedPosition) || !samePosition(controls.target, cachedTarget));

  function runOriginal(receiver, args) {
    updateDepth++;
    try { return originalUpdate.apply(receiver, args); }
    finally { updateDepth--; }
  }
  function flushMomentum() {
    if (flushing) return;
    flushing = true;
    const position = camera.position.clone(), target = controls.target.clone(), quaternion = camera.quaternion.clone(), zoom = camera.zoom;
    const damping = controls.enableDamping, autoRotate = controls.autoRotate;
    const dispatch = Object.getOwnPropertyDescriptor(controls, 'dispatchEvent');
    try {
      // A public, non-damped update consumes pending pan/rotation/dolly input.
      // Its temporary pose must not reach another change listener or the renderer.
      controls.enableDamping = false; controls.autoRotate = false; controls.dispatchEvent = () => {};
      runOriginal(controls, []);
    } finally {
      controls.enableDamping = damping; controls.autoRotate = autoRotate;
      if (dispatch) Object.defineProperty(controls, 'dispatchEvent', dispatch); else delete controls.dispatchEvent;
      camera.position.copy(position); controls.target.copy(target); camera.quaternion.copy(quaternion);
      if (camera.zoom !== zoom) { camera.zoom = zoom; camera.updateProjectionMatrix(); }
      camera.updateMatrixWorld(); flushing = false;
    }
  }

  function enforce() {
    if (disposed || enforcing || !controls.enabled || !isActive()) return false;
    stats.checks++;
    if (!finite(camera.position) || !finite(controls.target)) return false;
    if (cached && samePosition(camera.position, cachedPosition) && samePosition(controls.target, cachedTarget) &&
        camera.fov === cachedFov && camera.aspect === cachedAspect && camera.near === cachedNear && camera.zoom === cachedZoom &&
        controls.minDistance === lastMin && controls.maxDistance === lastMax) return false;
    enforcing = true; stats.evaluations++;
    ownedActive = true;
    const beforePosition = camera.position.clone(), beforeTarget = controls.target.clone();
    try {
      if (controls.minDistance !== lastMin) userMin = controls.minDistance;
      if (controls.maxDistance !== lastMax) userMax = controls.maxDistance;
      const tanY = Math.tan(MathUtils.degToRad(camera.getEffectiveFOV()) / 2), tanX = tanY * camera.aspect;
      const footprintGain = Math.max(1, Math.hypot(tanX, tanY));
      // This sphere contains the complete near plane, even at a grazing view angle.
      const nearRadius = camera.near * Math.sqrt(1 + tanX * tanX + tanY * tanY);
      // Reserve enough measured ground beyond the camera for a horizon even above
      // the highest terrain. The outer tile permits exploration beyond inner data;
      // its finite edge is not itself a safe place to put the camera.
      const horizonReserve = Math.acos(clamp(surfaceRadius / (radiusKm + maxGround + nearRadius + floorKm), -1, 1));
      const navigationRadius = 2 * radiusKm * Math.tan(Math.max(0, outerAngle - horizonReserve) / 2);
      // Use the same near-plane reserve for camera, target and zoom. Otherwise an
      // outward-facing minimum-distance orbit can be clipped shorter at this edge.
      const safeMapRadius = Math.max(0, navigationRadius - nearRadius);
      const minDistance = Math.max(Number.isFinite(userMin) ? userMin : 0, nearRadius + floorKm);
      const centreMax = Math.max(minDistance, Math.min(userMax, safeMapRadius / footprintGain));
      const tileFor = footprint => footprint < heroHalf * .92 ? 'hero' : footprint < innerHalf * .92 ? 'inner' : 'outer';
      const zoomLimit = (tile, edge, radial) => Math.max(minDistance, Math.min(userMax,
        (safeMapRadius - radial) / footprintGain,
        ((tile === 'hero' ? heroHalf : tile === 'inner' ? innerHalf : outerHalf) - edge) / footprintGain));
      const panChanged = !cached || !controls.target.equals(cachedTarget);
      let selectedTile = 'inner', maxDistance = centreMax, clearance = 0, horizonLimit = Infinity;
      // A terrain lift and an edge pan constrain one another. Ordinary movement exits
      // after one pass; extreme damped pans need extra refinement at the corner.
      for (let pass = 0; pass < 12; pass++) {
        const targetH = sceneToMap(radiusKm, controls.target, targetMap).h;
        let distance = offset.copy(camera.position).sub(controls.target).length();
        if (distance < 1e-10) offset.set(0, 1, 0);
        else offset.divideScalar(distance);
        distance = clamp(distance, minDistance, centreMax);
        // Preserve the orbit offset when panning hits a boundary. Zooming at an edge stops in place.
        const reserve = (panChanged || pass > 0 ? distance : minDistance) * footprintGain;
        const panRadius = Math.max(0, safeMapRadius - reserve);
        previousTarget.copy(controls.target);
        if (targetMap.length() > panRadius) targetMap.setLength(panRadius);
        const targetFloor = sample(targetMap);
        mapToScene(radiusKm, targetMap, clamp(targetH, targetFloor, maxGround), controls.target);
        correction.copy(controls.target).sub(previousTarget); camera.position.add(correction);
        const targetEdge = Math.max(Math.abs(targetMap.x), Math.abs(targetMap.y));
        // Promote through all measured tiles before the footprint reaches an edge.
        selectedTile = tileFor(targetEdge + distance * footprintGain);
        maxDistance = zoomLimit(selectedTile, targetEdge, targetMap.length());
        distance = Math.min(distance, maxDistance);
        camera.position.copy(controls.target).addScaledVector(offset, distance);

        let cameraH = sceneToMap(radiusKm, camera.position, cameraMap).h;
        if (cameraMap.length() > safeMapRadius) cameraMap.setLength(safeMapRadius);
        // Bound the possible ground horizon by measured outer coverage, independently of azimuth.
        // The lower terrain envelope is conservative compared with a flat tangent-plane footprint.
        const availableAngle = Math.max(0, outerAngle - 2 * Math.atan(cameraMap.length() / (2 * radiusKm)));
        horizonLimit = surfaceRadius / Math.cos(Math.min(availableAngle, Math.PI / 3)) - radiusKm;
        const floor = sample(cameraMap) + nearRadius + floorKm;
        cameraH = Math.max(floor, Math.min(cameraH, horizonLimit));
        mapToScene(radiusKm, cameraMap, cameraH, camera.position);
        camera.lookAt(controls.target); camera.updateMatrixWorld();

        // Sample the near plane at half-cell spacing, so adjacent terrain can also lift the camera.
        const columns = Math.min(32, Math.max(2, Math.ceil(4 * camera.near * tanX / finestCell)));
        const rows = Math.min(32, Math.max(2, Math.ceil(4 * camera.near * tanY / finestCell)));
        let deficit = 0;
        for (let row = 0; row <= rows; row++) for (let column = 0; column <= columns; column++) {
          samplePoint.set((column / columns * 2 - 1) * camera.near * tanX,
            (row / rows * 2 - 1) * camera.near * tanY, -camera.near).applyQuaternion(camera.quaternion).add(camera.position);
          const pointH = sceneToMap(radiusKm, samplePoint, sampleMap).h;
          deficit = Math.max(deficit, sample(sampleMap) + floorKm - pointH);
        }
        if (deficit > 1e-9) {
          cameraH += deficit + floorKm; mapToScene(radiusKm, cameraMap, cameraH, camera.position);
          camera.lookAt(controls.target); camera.updateMatrixWorld();
        }
        clearance = sceneToMap(radiusKm, camera.position, cameraMap).h - sample(cameraMap);
        const actualDistance = camera.position.distanceTo(controls.target);
        if (deficit <= 1e-9 && actualDistance >= minDistance - 1e-9 && actualDistance <= maxDistance + 1e-9 && cameraH <= horizonLimit + 1e-9) break;
      }
      // Refresh the available zoom radius after a terrain-driven lift or pan correction.
      sceneToMap(radiusKm, controls.target, targetMap);
      const finalEdge = Math.max(Math.abs(targetMap.x), Math.abs(targetMap.y));
      const finalDistance = camera.position.distanceTo(controls.target);
      selectedTile = tileFor(finalEdge + finalDistance * footprintGain);
      maxDistance = zoomLimit(selectedTile, finalEdge, targetMap.length());
      controls.minDistance = lastMin = minDistance; controls.maxDistance = lastMax = maxDistance;
      const changed = !samePosition(camera.position, beforePosition) || !samePosition(controls.target, beforeTarget);
      if (changed) { stats.corrections++; flushMomentum(); }
      cachedPosition.copy(camera.position); cachedTarget.copy(controls.target);
      cachedFov = camera.fov; cachedAspect = camera.aspect; cachedNear = camera.near; cachedZoom = camera.zoom; cached = true;
      snapshot = { tile: selectedTile, heroHalfKm: heroHalf, innerHalfKm: innerHalf, outerHalfKm: outerHalf,
        navigationRadiusKm: navigationRadius,
        minDistanceKm: minDistance, maxDistanceKm: maxDistance, distanceKm: finalDistance, clearanceKm: clearance,
        nearRadiusKm: nearRadius, footprintGain, horizonLimitKm: horizonLimit,
        cameraMapKm: cameraMap.toArray(), targetMapKm: targetMap.toArray() };
      return changed;
    } finally { enforcing = false; }
  }
  function boundedUpdate(...args) {
    if (!controls.enabled || !isActive()) {
      // Leaving explore may skip control updates throughout an entire rig flight.
      // Clear only input owned by that previous interaction, never clamp the new mode.
      if (ownedActive) { flushMomentum(); ownedActive = false; }
      return runOriginal(this, args);
    }
    // Programmatic pose handoffs take precedence over an old gesture's damping.
    // Normal OrbitControls input changes the pose inside runOriginal, not before it.
    if (externalPose()) flushMomentum();
    ownedActive = true;
    const before = enforce(), result = runOriginal(this, args), after = enforce();
    return result || before || after;
  }
  const onChange = () => {
    if (!updateDepth && controls.enabled && isActive() && externalPose()) flushMomentum();
    enforce();
  };
  controls.update = boundedUpdate; controls.addEventListener('change', onChange);
  return {
    enforce,
    getSnapshot: () => snapshot ? { ...snapshot, cameraMapKm: [...snapshot.cameraMapKm], targetMapKm: [...snapshot.targetMapKm], stats: { ...stats } } : { stats: { ...stats } },
    dispose() {
      if (disposed) return; disposed = true; controls.removeEventListener('change', onChange);
      if (controls.update === boundedUpdate) controls.update = originalUpdate;
      if (controls.minDistance === lastMin) controls.minDistance = originalLimits.min;
      if (controls.maxDistance === lastMax) controls.maxDistance = originalLimits.max;
    }
  };
}
