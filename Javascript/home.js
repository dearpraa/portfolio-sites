const scrollRevealOption = {
  distance: "50px",
  origin: "bottom",
  duration: 1000,
};

if (window.ScrollReveal) {
  ScrollReveal().reveal(".header__image img", {
    ...scrollRevealOption,
    origin: "right",
  });
  ScrollReveal().reveal(".header__content h1", {
    ...scrollRevealOption,
    delay: 500,
  });
  ScrollReveal().reveal(".header__content h2", {
    ...scrollRevealOption,
    delay: 1000,
  });
  ScrollReveal().reveal(".header__btn", {
    ...scrollRevealOption,
    delay: 1500,
  });

  ScrollReveal().reveal(".about__image img", {
    ...scrollRevealOption,
    origin: "left",
  });
  ScrollReveal().reveal(".about__content .section__header", {
    ...scrollRevealOption,
    delay: 500,
  });
  ScrollReveal().reveal(".about__content p", {
    ...scrollRevealOption,
    delay: 1000,
    interval: 500,
  });
  ScrollReveal().reveal(".about__btn", {
    ...scrollRevealOption,
    delay: 2000,
  });
}
