document.addEventListener("DOMContentLoaded", () => {
  const floatingContainer = document.querySelector(".floating-elements");
  if (floatingContainer) {
    for (let index = 0; index < 20; index += 1) {
      const element = document.createElement("div");
      const size = Math.random() * 10 + 5;

      element.className = "floating-element";
      element.style.cssText = [
        `width: ${size}px`,
        `height: ${size}px`,
        `left: ${Math.random() * 100}%`,
        `top: ${Math.random() * 100}%`,
        `animation-delay: ${Math.random() * 5}s`,
        `animation-duration: ${Math.random() * 10 + 10}s`,
      ].join(";");
      floatingContainer.append(element);
    }
  }

  const profileImage = document.getElementById("profileImage");
  const hireSection = document.querySelector(".hire-me");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!profileImage || !hireSection) return;

  if (!reduceMotion) hireSection.addEventListener("pointermove", (event) => {
    const bounds = hireSection.getBoundingClientRect();
    const offsetX = (event.clientX - bounds.left - bounds.width / 2) / 20;
    const offsetY = (event.clientY - bounds.top - bounds.height / 2) / 20;
    profileImage.style.transform = `perspective(1000px) rotateY(${offsetX}deg) rotateX(${-offsetY}deg) scale(1.05)`;
  });
  hireSection.addEventListener("pointerleave", () => {
    profileImage.style.transform = "perspective(1000px) rotateY(0) rotateX(0) scale(1)";
  });

  hireSection.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const link = event.target.closest(".contact a, .socials a");
    if (!link) return;

    const bounds = link.getBoundingClientRect();
    const size = Math.max(bounds.width, bounds.height);
    const x = event.detail === 0 ? bounds.width / 2 : event.clientX - bounds.left;
    const y = event.detail === 0 ? bounds.height / 2 : event.clientY - bounds.top;
    const ripple = document.createElement("span");
    ripple.className = "link-ripple";
    ripple.style.width = `${size}px`;
    ripple.style.height = `${size}px`;
    ripple.style.left = `${x - size / 2}px`;
    ripple.style.top = `${y - size / 2}px`;
    ripple.addEventListener("animationend", () => ripple.remove(), { once: true });
    link.append(ripple);
  });
});
