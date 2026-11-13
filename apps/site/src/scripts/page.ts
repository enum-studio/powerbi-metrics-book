// The landing page's behaviours: Copy buttons on code blocks; the tabs, which
// follow the WAI-ARIA tabs pattern (arrow keys move along the tabs, the
// selected tab is the only one in the tab order); and figures that reveal
// themselves when they scroll into view.

for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-copy]",
)) {
  button.addEventListener("click", () => {
    const code = button.parentElement?.querySelector("code");
    if (!code) return;
    const copy = code.cloneNode(true) as HTMLElement;
    for (const prompt of copy.querySelectorAll(".prompt")) prompt.remove();
    void navigator.clipboard.writeText(copy.textContent).then(
      () => {
        button.textContent = "Copied";
      },
      () => {
        button.textContent = "Select and copy";
      },
    );
    setTimeout(() => {
      button.textContent = "Copy";
    }, 2000);
  });
}

const STEPS = new Map([
  ["ArrowRight", 1],
  ["ArrowLeft", -1],
]);

for (const list of document.querySelectorAll<HTMLElement>('[role="tablist"]')) {
  const tabs = [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const select = (chosen: HTMLButtonElement) => {
    for (const tab of tabs) {
      const selected = tab === chosen;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      const panel = document.getElementById(
        tab.getAttribute("aria-controls") ?? "",
      );
      if (panel) panel.hidden = !selected;
    }
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => {
      select(tab);
    });
    tab.addEventListener("keydown", (event) => {
      const step = STEPS.get(event.key);
      if (step === undefined) return;
      const next = tabs[(index + step + tabs.length) % tabs.length];
      select(next);
      next.focus();
    });
  });
}

// A figure with data-reveal starts "pending" and turns "seen" once it is on
// screen, so its CSS can animate it in. Without the script, it never hides.
const reveal = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.replace("pending", "seen");
      reveal.unobserve(entry.target);
    }
  },
  { threshold: 0.35 },
);
for (const figure of document.querySelectorAll("[data-reveal]")) {
  figure.classList.add("pending");
  reveal.observe(figure);
}
