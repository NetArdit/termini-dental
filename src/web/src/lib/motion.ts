// The public home page's motion: a smooth scroll and a few entrances. It is loaded on its own, after the
// page is already readable, and only for visitors who have not asked their device for less motion. Nothing
// here hides content, before it runs or while it runs: every element is in the page and visible before this
// file arrives, and what is further down the page moves into place without ever being made invisible, so
// that a screen reader, a search engine, a printout or a capture of the whole page finds all of it. A slow
// network, a blocked script or "reduce motion" show the same complete page, only still.

import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";

gsap.registerPlugin(ScrollTrigger);

/**
 * Starts the motion inside `root` and returns what stops it. Marked in the page with:
 *   data-rise   an element (or a group: its children) that comes up as it enters the screen
 *   data-settle the hero photograph, which eases from slightly large to its place
 *   data-drift  a picture that moves a little slower than the page
 */
export function homeMotion(root: HTMLElement): () => void {
  const lenis = new Lenis({ duration: 1.05, smoothWheel: true });
  lenis.on("scroll", ScrollTrigger.update);
  const tick = (time: number) => lenis.raf(time * 1000);
  gsap.ticker.add(tick);
  gsap.ticker.lagSmoothing(0);

  // Links to a place on this page glide there, and the keyboard's focus follows.
  const onClick = (event: MouseEvent) => {
    const link = (event.target as HTMLElement | null)?.closest<HTMLAnchorElement>('a[href^="#"]');
    const target = link ? root.querySelector<HTMLElement>(link.getAttribute("href")!) : null;
    if (!link || !target) return;
    event.preventDefault();
    lenis.scrollTo(target, { offset: -84 });
    target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
  };
  root.addEventListener("click", onClick);

  const ctx = gsap.context(() => {
    const hero = gsap.timeline({ defaults: { ease: "power3.out" } });
    hero
      // The first screen fades as it arrives (opacity only: it stays readable to assistive technology).
      .from("[data-hero] > *", { y: 28, opacity: 0, duration: 0.8, stagger: 0.08 })
      .from("[data-settle]", { scale: 1.06, duration: 1.2, ease: "power2.out" }, 0.1)
      .from("[data-caption]", { y: 16, opacity: 0, duration: 0.6 }, 0.7);

    for (const el of gsap.utils.toArray<HTMLElement>("[data-rise]")) {
      const parts = el.dataset.rise === "group" ? Array.from(el.children) : [el];
      // Position only. Whatever is below the first screen is fully visible from the start and merely
      // settles into place when it is reached.
      gsap.from(parts, { y: 28, duration: 0.7, ease: "power3.out", stagger: 0.07, scrollTrigger: { trigger: el, start: "top 88%", once: true } });
    }
    for (const el of gsap.utils.toArray<HTMLElement>("[data-drift]")) {
      gsap.fromTo(el, { yPercent: -5 }, { yPercent: 5, ease: "none", scrollTrigger: { trigger: el.parentElement, start: "top bottom", end: "bottom top", scrub: true } });
    }
  }, root);

  return () => {
    root.removeEventListener("click", onClick);
    ctx.revert();
    gsap.ticker.remove(tick);
    lenis.destroy();
  };
}
