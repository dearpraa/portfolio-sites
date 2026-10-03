document.addEventListener("DOMContentLoaded", async () => {
  const gallery = document.getElementById("gallery");
  const loadMoreBtn = document.getElementById("load-more");
  const filters = document.querySelector("[data-gallery-filters]");
  const modal = document.getElementById("photo-modal");
  const modalImg = document.getElementById("modal-image");
  const modalCaption = document.getElementById("modal-caption");
  const closeModal = document.querySelector(".close-modal");

  let photos = [];
  let filter = "all";
  let loadedCount = 0;
  const batchSize = 6;

  function visiblePhotos() {
    return filter === "all" ? photos : photos.filter((photo) => photo.sections.includes(filter));
  }

  function appendPhoto(photo) {
    const category = photo.category || photo.sections.find((section) => !["homepage", "portfolio", "gallery", "featured", "about", "contact"].includes(section)) || "";
    const item = document.createElement("div");
    item.className = `gallery-item${category ? ` ${category}` : ""}`;
    item.dataset.category = category;

    const image = document.createElement("img");
    image.src = photo.imageUrl;
    image.alt = photo.description || photo.title;
    image.loading = "lazy";

    const overlay = document.createElement("div");
    overlay.className = "photo-overlay";
    const description = document.createElement("p");
    description.textContent = photo.description || photo.title;
    const categoryLabel = document.createElement("span");
    categoryLabel.className = "photo-category";
    categoryLabel.textContent = category;
    overlay.append(description, categoryLabel);
    item.append(image, overlay);
    gallery.append(item);
  }

  function renderBatch(reset = false) {
    if (reset) {
      gallery.replaceChildren();
      loadedCount = 0;
    }
    const items = visiblePhotos();
    const end = Math.min(loadedCount + batchSize, items.length);
    items.slice(loadedCount, end).forEach(appendPhoto);
    loadedCount = end;
    loadMoreBtn.hidden = loadedCount >= items.length;
    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "gallery-empty";
      empty.textContent = "No published photos in this section yet.";
      gallery.append(empty);
    }
  }

  try {
    const data = await window.siteDataPromise;
    photos = [...new Map([...(data.photos.portfolio || []), ...(data.photos.gallery || [])]
      .map((photo) => [photo.id, photo])).values()];
    filters.addEventListener("click", (event) => {
      const button = event.target.closest("[data-filter]");
      if (!button) return;
      filters.querySelectorAll(".filter-btn").forEach((filterButton) => filterButton.classList.remove("active"));
      button.classList.add("active");
      filter = button.dataset.filter;
      renderBatch(true);
    });
    gallery.addEventListener("click", (event) => {
      const image = event.target.closest("img");
      if (!image || !modal || !modalImg || !modalCaption) return;
      modalImg.src = image.src;
      modalImg.alt = image.alt;
      modalCaption.textContent = image.alt;
      modal.style.display = "block";
      document.body.style.overflow = "hidden";
    });
    loadMoreBtn.addEventListener("click", () => renderBatch());
    const hideModal = () => {
      modal.style.display = "none";
      modalImg.removeAttribute("src");
      document.body.style.overflow = "";
    };
    closeModal?.addEventListener("click", hideModal);
    modal?.addEventListener("click", (event) => { if (event.target === modal) hideModal(); });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape" && modal?.style.display === "block") hideModal(); });
    renderBatch(true);
  } catch (error) {
    console.error("Portfolio gallery:", error);
    const notice = document.createElement("p");
    notice.className = "gallery-empty";
    notice.setAttribute("role", "alert");
    notice.textContent = "The portfolio is temporarily unavailable.";
    gallery.replaceChildren(notice);
    loadMoreBtn.hidden = true;
  }
});
