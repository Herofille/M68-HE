// Fires every 16ms (~60fps) regardless of tab visibility.
// Web Workers are never throttled by Chrome's background tab policy.
setInterval(() => postMessage(1), 16);
