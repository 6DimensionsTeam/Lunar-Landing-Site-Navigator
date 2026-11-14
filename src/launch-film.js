/** Play archival launch footage without coupling media state to mission data. */
export function createLaunchFilm({ video, onProgress, onComplete, onError, documentTarget = document }) {
  let active = false, destroyed = false, generation = 0, attemptId = 0;
  let pendingAttempt = 0, resumeOnVisible = false;
  const listeners = [];
  const listen = (target, name, fn) => {
    target.addEventListener(name, fn);
    listeners.push(() => target.removeEventListener(name, fn));
  };
  const metadata = (finished = false) => {
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const currentTime = Math.max(0, Number.isFinite(video.currentTime) ? video.currentTime : 0);
    return {
      progress: finished ? 1 : duration ? Math.min(1, currentTime / duration) : 0,
      currentTime: finished && duration ? duration : currentTime,
      duration,
    };
  };
  const publish = () => {
    if (active && !destroyed && !documentTarget.hidden) onProgress?.(metadata());
  };
  async function attemptPlayback(token) {
    const attempt = ++attemptId;
    pendingAttempt = attempt;
    try {
      await video.play();
      // A pending play may settle after a visibility change or cancellation.
      if (!active || destroyed || documentTarget.hidden) video.pause();
    } catch (error) {
      if (active && !destroyed && token === generation && attempt === attemptId && !documentTarget.hidden) onError?.(error);
    } finally {
      if (pendingAttempt === attempt) pendingAttempt = 0;
    }
  }
  function cancel() {
    active = false;
    generation++;
    attemptId++;
    pendingAttempt = 0;
    resumeOnVisible = false;
    video.pause();
  }
  function finish() {
    if (!active || destroyed) return;
    cancel();
    onProgress?.(metadata(true));
    onComplete?.();
  }
  async function play() {
    if (destroyed) return;
    cancel();
    const token = generation;
    active = true;
    try {
      video.currentTime = 0;
    } catch (error) {
      onError?.(error);
      return;
    }
    publish();
    if (documentTarget.hidden) { resumeOnVisible = true; return; }
    await attemptPlayback(token);
  }
  function visibilityChange() {
    if (!active || destroyed) return;
    if (documentTarget.hidden) {
      resumeOnVisible = !video.paused || pendingAttempt !== 0;
      attemptId++;
      pendingAttempt = 0;
      video.pause();
    } else if (resumeOnVisible) {
      resumeOnVisible = false;
      void attemptPlayback(generation);
    }
  }
  listen(video, 'timeupdate', publish);
  listen(video, 'loadedmetadata', publish);
  listen(video, 'durationchange', publish);
  listen(video, 'ended', finish);
  listen(video, 'error', () => {
    if (active && !destroyed) onError?.(new Error(video.error?.message || 'The launch footage could not be played.'));
  });
  listen(documentTarget, 'visibilitychange', visibilityChange);
  return {
    play,
    skip: finish,
    cancel,
    destroy() {
      if (destroyed) return;
      cancel();
      destroyed = true;
      listeners.splice(0).forEach(remove => remove());
    },
  };
}
