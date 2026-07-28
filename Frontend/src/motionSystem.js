import { useCallback, useEffect, useRef, useState } from "react";
import { animate } from "motion";

export const MOTION = Object.freeze({
  duration: {
    micro: 0.18,
    component: 0.34,
    section: 0.56,
    hero: 0.78,
    flight: 0.56,
  },
  ease: {
    enter: [0.22, 1, 0.36, 1],
    exit: [0.4, 0, 1, 1],
  },
  spring: {
    badge: { type: "spring", stiffness: 450, damping: 26, mass: 0.7 },
  },
});

export const sectionVariants = {
  hidden: { opacity: 0, y: 22 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: MOTION.duration.section,
      ease: MOTION.ease.enter,
      staggerChildren: 0.07,
    },
  },
};

export const sectionChildVariants = {
  hidden: { opacity: 0, y: 12 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.46, ease: MOTION.ease.enter },
  },
};

export const reducedSectionVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.14 } },
};

export const menuItemVariants = {
  hidden: { opacity: 0, y: 10 },
  visible: { opacity: 1, y: 0 },
  exit: { opacity: 0, transition: { duration: 0.14, ease: MOTION.ease.exit } },
};

export function useAmbientVisibility(ref) {
  const [intersecting, setIntersecting] = useState(true);
  const [documentVisible, setDocumentVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState === "visible",
  );

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver(
      ([entry]) => setIntersecting(entry.isIntersecting),
      { threshold: 0.08 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);

  useEffect(() => {
    const onVisibility = () => setDocumentVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  return intersecting && documentVisible;
}

export function useCartFlight({ targetRef, reducedMotion, onArrive }) {
  const activeFlights = useRef(new Set());

  useEffect(() => () => {
    activeFlights.current.forEach(({ controls, node }) => {
      controls.stop();
      node.remove();
    });
    activeFlights.current.clear();
  }, []);

  return useCallback(({ sourceElement, image, emoji }) => {
    const target = targetRef.current;
    const source = sourceElement?.querySelector?.("[data-dish-visual]") || sourceElement;

    if (reducedMotion || !source || !target) {
      onArrive?.();
      return;
    }

    const sourceRect = source.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    if (!sourceRect.width || !sourceRect.height || !targetRect.width || !targetRect.height) {
      onArrive?.();
      return;
    }

    const size = Math.min(72, Math.max(48, Math.min(sourceRect.width, sourceRect.height) * 0.34));
    const startX = sourceRect.left + sourceRect.width / 2 - size / 2;
    const startY = sourceRect.top + sourceRect.height / 2 - size / 2;
    const deltaX = targetRect.left + targetRect.width / 2 - (startX + size / 2);
    const deltaY = targetRect.top + targetRect.height / 2 - (startY + size / 2);
    const arcLift = Math.min(120, Math.max(64, Math.abs(deltaX) * 0.12));

    const clone = document.createElement("div");
    clone.setAttribute("aria-hidden", "true");
    clone.dataset.cartFlight = "true";
    Object.assign(clone.style, {
      position: "fixed",
      left: `${startX}px`,
      top: `${startY}px`,
      width: `${size}px`,
      height: `${size}px`,
      zIndex: "100",
      borderRadius: "50%",
      overflow: "hidden",
      pointerEvents: "none",
      display: "grid",
      placeItems: "center",
      background: "#742427",
      color: "#fff",
      border: "2px solid rgba(255,255,255,.72)",
      boxShadow: "0 12px 28px rgba(26,16,17,.28)",
      fontSize: `${Math.round(size * 0.48)}px`,
      willChange: "transform, opacity",
    });

    if (image) {
      const img = document.createElement("img");
      img.src = image;
      img.alt = "";
      Object.assign(img.style, { width: "100%", height: "100%", objectFit: "cover" });
      clone.appendChild(img);
    } else {
      clone.textContent = emoji || "";
    }

    document.body.appendChild(clone);
    const flight = {
      node: clone,
      controls: animate(
        clone,
        {
          x: [0, deltaX * 0.55, deltaX],
          y: [0, deltaY * 0.45 - arcLift, deltaY],
          scale: [1, 0.72, 0.25],
          opacity: [1, 0.96, 0],
        },
        {
          duration: MOTION.duration.flight,
          ease: MOTION.ease.enter,
          times: [0, 0.56, 1],
        },
      ),
    };
    activeFlights.current.add(flight);
    flight.controls.finished
      .then(() => onArrive?.())
      .catch(() => {})
      .finally(() => {
        flight.node.remove();
        activeFlights.current.delete(flight);
      });
  }, [onArrive, reducedMotion, targetRef]);
}
