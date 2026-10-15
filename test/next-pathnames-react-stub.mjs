import React from 'react';

// The hooks run without a renderer here. The host is the server snapshot until a test sets
// globalThis.__w3Mounted, which is the post-mount snapshot in a browser.
export default {
  ...React,
  useSyncExternalStore: (subscribe, getSnapshot, getServerSnapshot) => (globalThis.__w3Mounted ? getSnapshot() : getServerSnapshot()),
};
