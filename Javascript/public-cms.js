(() => {
  const pageData = fetch("/api/public/site")
    .then((response) => {
      if (!response.ok) throw new Error(`Website content could not be loaded (${response.status}).`);
      return response.json();
    });
  window.siteDataPromise = pageData;

  function setText(content, key, selector) {
    const element = document.querySelector(selector);
    if (element && typeof content[key] === "string") element.textContent = content[key];
  }

  function setDbImage(role, photo) {
    const container = document.querySelector(`[data-db-image="${role}"]`);
    if (!container) return;
    const image = container.querySelector("img");
    if (!photo || !image) {
      container.hidden = true;
      return;
    }
    image.src = photo.imageUrl;
    image.alt = photo.altText || photo.description || photo.title || "";
    container.hidden = false;
  }

  function setSkills(skills) {
    const grid = document.querySelector("[data-db-skills]");
    if (!grid) return;
    grid.replaceChildren();
    const section = grid.closest(".skills-container");
    if (!Array.isArray(skills) || skills.length === 0) {
      if (section) section.hidden = true;
      return;
    }
    if (section) section.hidden = false;
    skills.forEach((skill) => {
      const item = document.createElement("div");
      item.className = "skill-item";
      const icon = document.createElement("div");
      icon.className = "skill-icon";
      const iconElement = document.createElement("i");
      iconElement.className = skill.icon || "ri-star-line";
      iconElement.setAttribute("aria-hidden", "true");
      icon.append(iconElement);
      const info = document.createElement("div");
      info.className = "skill-info";
      const name = document.createElement("div");
      name.className = "skill-name";
      const label = document.createElement("span");
      label.textContent = skill.name;
      const percent = document.createElement("span");
      percent.className = "skill-percent";
      percent.textContent = `${skill.percent}%`;
      name.append(label, percent);
      const bar = document.createElement("div");
      bar.className = "skill-bar";
      const progress = document.createElement("div");
      progress.className = "skill-progress";
      progress.dataset.width = String(skill.percent);
      progress.style.width = `${skill.percent}%`;
      bar.append(progress);
      info.append(name, bar);
      item.append(icon, info);
      grid.append(item);
    });
  }

  function makeSocialLink(link) {
    const anchor = document.createElement("a");
    anchor.href = link.url;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.setAttribute("aria-label", link.displayName);
    anchor.title = link.displayName;
    const icon = document.createElement("i");
    icon.className = link.icon;
    icon.setAttribute("aria-hidden", "true");
    anchor.append(icon);
    return anchor;
  }

  function makePhoto(photo) {
    const image = document.createElement("img");
    image.src = photo.imageUrl;
    image.alt = photo.description || photo.title;
    image.loading = "lazy";
    image.dataset.photoTitle = photo.title;
    return image;
  }

  function setHomePhotos(photos) {
    const gallery = document.querySelector("[data-home-photos]");
    if (!gallery) return;
    gallery.replaceChildren();
    const columns = [document.createElement("div"), document.createElement("div"), document.createElement("div")];
    photos.forEach((photo, index) => columns[index % columns.length].append(makePhoto(photo)));
    columns.forEach((column) => gallery.append(column));
  }

  function setPhotoLocations(photoLocations) {
    document.querySelectorAll("[data-photo-location]").forEach((container) => {
      const location = container.dataset.photoLocation;
      const locationPhotos = photoLocations[location] || [];
      container.replaceChildren();
      container.hidden = locationPhotos.length === 0;
      if (!locationPhotos.length) return;

      const heading = document.createElement("h2");
      heading.className = "section__header";
      heading.textContent = location === "featured" ? "Featured photographs" : "Photographs";
      const grid = document.createElement("div");
      grid.className = "cms-photo-grid";
      locationPhotos.forEach((photo) => {
        const figure = document.createElement("figure");
        figure.className = "cms-photo-card";
        figure.append(makePhoto(photo));
        const caption = document.createElement("figcaption");
        caption.textContent = photo.title;
        figure.append(caption);
        grid.append(figure);
      });
      container.append(heading, grid);
    });
  }

  function setGalleryFilters(sections) {
    const filters = document.querySelector("[data-gallery-filters]");
    if (!filters) return;
    const all = document.createElement("button");
    all.className = "filter-btn active";
    all.dataset.filter = "all";
    all.textContent = "All";
    filters.replaceChildren(all);
    sections.filter((section) => !section.system && section.visible).forEach((section) => {
      const button = document.createElement("button");
      button.className = "filter-btn";
      button.dataset.filter = section.slug;
      button.textContent = section.title;
      filters.append(button);
    });
  }

  function render(data) {
    const { content, navigation, socialLinks, photos, sections, skills } = data;
    const nav = document.querySelector(".nav__links");
    if (nav) {
      nav.replaceChildren();
      navigation.forEach((item) => {
        const li = document.createElement("li");
        const anchor = document.createElement("a");
        anchor.href = item.url;
        anchor.textContent = item.label;
        if (item.icon) {
          const icon = document.createElement("i");
          icon.className = item.icon;
          icon.setAttribute("aria-hidden", "true");
          anchor.prepend(icon);
        }
        const current = location.pathname.toLowerCase();
        if ((current === "/" && item.url === "home.html")
          || current.endsWith(item.url.toLowerCase())
          || (current === "/about" && item.url === "about.html")
          || (current === "/portfolio" && item.url === "photography.html")
          || (current === "/contact" && item.url === "hire.html")) {
          anchor.setAttribute("aria-current", "page");
        }
        li.append(anchor);
        nav.append(li);
      });
    }

    document.querySelectorAll("[data-social-location]").forEach((container) => {
      const locationName = container.dataset.socialLocation;
      container.replaceChildren(...socialLinks
        .filter((link) => link.locations.includes(locationName))
        .map(makeSocialLink));
      container.hidden = container.childElementCount === 0;
    });

    document.querySelectorAll("[data-content]").forEach((el) => {
      const key = el.getAttribute("data-content");
      if (key && typeof content[key] === "string") {
        el.textContent = content[key];
      }
    });

    setText(content, "home.heroTitle", ".header__content h1");
    setText(content, "home.heroSubtitle", ".header__content h2");
    setText(content, "home.ctaText", ".header__btn .btn");
    setText(content, "home.introduction", "[data-content='home.introduction']");
    setText(content, "home.portfolioTitle", "[data-content='home.portfolioTitle']");
    setText(content, "home.portfolioDescription", "[data-content='home.portfolioDescription']");
    setText(content, "about.title", ".about-content h1");
    setText(content, "about.description", "[data-content='about.description']");
    setText(content, "about.biography", "[data-content='about.biography']");
    setText(content, "about.skillsTitle", "[data-content='about.skillsTitle']");
    setText(content, "about.skillsDescription", "[data-content='about.skillsDescription']");
    setText(content, "portfolio.title", ".portfolio-header h1");
    setText(content, "portfolio.description", ".portfolio-header p");
    setText(content, "contact.title", ".hire-me > h1");
    setText(content, "contact.description", ".hire-me > p");
    setText(content, "contact.closingTitle", ".end-section h2");
    setText(content, "contact.closingDescription", ".end-section p");
    setText(content, "footer.contactTitle", "[data-content='footer.contactTitle']");
    setText(content, "footer.introduction", "[data-content='footer.introduction']");
    setText(content, "footer.officeTitle", "[data-content='footer.officeTitle']");
    setText(content, "footer.socialTitle", "[data-content='footer.socialTitle']");
    setText(content, "footer.copyright", ".footer__bar");
    setText(content, "contact.location", "[data-content='contact.location']");

    const email = document.getElementById("emailBtn");
    if (email && content["contact.email"]) email.href = `mailto:${content["contact.email"]}`;
    const phone = document.getElementById("callBtn");
    if (phone && content["contact.phone"]) phone.href = `tel:${content["contact.phone"].replace(/[^\d+]/g, "")}`;
    const homePortfolio = photos.homepage || [];
    setHomePhotos(homePortfolio);
    setPhotoLocations(photos);
    setGalleryFilters(sections);
  }

  function setMobileNavigationOpen(open) {
    const nav = document.querySelector(".nav__links");
    const button = document.querySelector(".nav__menu__btn");
    const icon = button?.querySelector("i");
    if (!nav || !button || !icon) return;

    nav.classList.toggle("open", open);
    button.setAttribute("aria-expanded", String(open));
    button.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
    icon.className = open ? "ri-close-line" : "ri-menu-3-line";
  }

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const menuButton = target.closest(".nav__menu__btn");
    if (menuButton) {
      setMobileNavigationOpen(!document.querySelector(".nav__links")?.classList.contains("open"));
      return;
    }
    if (target.closest(".nav__links a") || !target.closest(".site-header")) {
      setMobileNavigationOpen(false);
    }
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth > 768) setMobileNavigationOpen(false);
  });

  const header = document.querySelector(".site-header");
  const updateHeaderOnScroll = () => header?.classList.toggle("scrolled", window.scrollY > 50);
  window.addEventListener("scroll", updateHeaderOnScroll, { passive: true });
  updateHeaderOnScroll();

  pageData.then(render).catch((error) => {
    console.error("Photography CMS:", error);
    const main = document.querySelector("main");
    if (main) {
      const notice = document.createElement("p");
      notice.className = "cms-load-error";
      notice.setAttribute("role", "alert");
      notice.textContent = "Website content is temporarily unavailable. Please try again shortly.";
      main.prepend(notice);
    }
  });
})();
