// Steps a figure through numbered steps. An element with `data-run="n"` is
// step n's label: a button selects it. A shape with `data-step="n m"` lights
// up (class "hot") at steps n and m. The steps play by themselves while the
// figure is on screen and the pointer is not over it, with the class
// "playing" on the figure so CSS can draw each step's timer. A click on a
// label stops the playing for good. Under reduced motion nothing plays.

interface Options {
  count: number;
  ms: number;
  // Show step 1 before anything plays, so a still figure has a step lit.
  showFirst: boolean;
  delay?: number;
}

export function stepThrough(root: HTMLElement, options: Options): void {
  const { count, ms, showFirst, delay = 0 } = options;
  const labels = [...root.querySelectorAll<HTMLElement>("[data-run]")];
  const shapes = [...root.querySelectorAll<SVGElement>("[data-step]")];
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let at = 0;
  let started = false;
  let stopped = still;
  let hovered = false;
  let visible = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  root.style.setProperty("--step-ms", `${String(ms)}ms`);

  const show = (n: number) => {
    at = n;
    const name = String(n);
    root.dataset.active = name;
    for (const label of labels) {
      const current = label.dataset.run === name;
      label.toggleAttribute("data-current", current);
      if (label instanceof HTMLButtonElement)
        label.setAttribute("aria-pressed", String(current));
    }
    for (const shape of shapes) {
      shape.classList.toggle(
        "hot",
        (shape.dataset.step ?? "").split(" ").includes(name),
      );
    }
  };

  // Plays while it should, from the start of the current step.
  const update = () => {
    const run = started && !stopped && !hovered && visible;
    if (run === root.classList.contains("playing")) return;
    clearInterval(timer);
    root.classList.toggle("playing", run);
    if (run) {
      timer = setInterval(() => {
        show((at % count) + 1);
      }, ms);
    }
  };

  for (const label of labels) {
    if (!(label instanceof HTMLButtonElement)) continue;
    label.addEventListener("click", () => {
      stopped = true;
      update();
      show(Number(label.dataset.run));
    });
  }
  root.addEventListener("pointerenter", () => {
    hovered = true;
    update();
  });
  root.addEventListener("pointerleave", () => {
    hovered = false;
    update();
  });
  new IntersectionObserver(
    ([entry]) => {
      visible = entry.isIntersecting;
      update();
    },
    { threshold: 0.5 },
  ).observe(root);

  if (showFirst) show(1);
  if (still) return;
  setTimeout(() => {
    if (!showFirst && !stopped) show(1);
    started = true;
    update();
  }, delay);
}
