import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OnboardingForm } from "@/components/onboarding-form";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));

/**
 * The server-rendered HTML is exactly the window a slow phone taps in: the controls exist
 * before any handler does, so the markup itself has to be inert. Rendering it here is the
 * cheapest way to keep that guarantee: effects never run, so what this asserts is what the
 * browser shows before hydration.
 */
describe("onboarding form before hydration", () => {
  const html = renderToStaticMarkup(createElement(OnboardingForm, { locale: "en" }));

  it("renders every control inside a disabled gate", () => {
    expect(html).toContain('<fieldset disabled=""');
    // The gate opens before the first control and closes after the submit button, so
    // presets, city, event kind, anchors and submit are all inside it.
    const gate = html.indexOf('<fieldset disabled=""');
    const presets = html.indexOf('aria-pressed="false"');
    const packButton = html.indexOf('type="submit"');
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(presets).toBeGreaterThan(gate);
    expect(packButton).toBeGreaterThan(gate);
  });

  it("keeps the gate out of the layout, so nothing shifts when it lifts", () => {
    expect(html).toContain('class="contents"');
    expect(html).not.toContain("<fieldset aria-hidden");
  });

  it("does not claim to be hydrated", () => {
    // The signal is set by an effect on the client; the server never sets it.
    expect(html).not.toContain("data-hydrated");
  });
});
