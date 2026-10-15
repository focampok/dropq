"use client";

import { useEffect, useState } from "react";

/**
 * Whether React has hydrated and can run a handler yet.
 *
 * The onboarding form and the language toggle are rendered on the server, so on a slow
 * connection they are visible — and tappable — for seconds before their handlers exist.
 * A tap in that window is worse than a no-op on the submit button: the browser performs a
 * native GET submit and the visitor lands on `/?` with nothing selected. Every client
 * control therefore starts disabled and is released by this flag, which flips in an effect
 * and never during render, so the server and the first client render agree.
 */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  // Set the document flag only once the enabled controls are already in the DOM, so a
  // test that waits for the flag is never looking at a button that is still disabled.
  useEffect(() => {
    if (!hydrated) return;
    document.documentElement.dataset.hydrated = "true";
  }, [hydrated]);
  return hydrated;
}

/** Pages whose controls do not gate themselves still have to report readiness (/pack). */
export function HydrationSignal() {
  useHydrated();
  return null;
}
