document.addEventListener("DOMContentLoaded", () => {
  const modal = document.getElementById("hireModal");
  const hireButton = document.getElementById("hireMeBtn");
  const closeButton = modal?.querySelector(".close-modal");
  const contactForm = document.getElementById("contactForm");

  function setModalOpen(open) {
    if (!modal) return;
    modal.style.display = open ? "block" : "none";
    document.body.style.overflow = open ? "hidden" : "";
  }

  hireButton?.addEventListener("click", () => setModalOpen(true));
  closeButton?.addEventListener("click", () => setModalOpen(false));
  modal?.addEventListener("click", (event) => {
    if (event.target === modal) setModalOpen(false);
  });

  contactForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const data = await window.siteDataPromise;
      const recipient = data.content["contact.email"];
      if (!recipient) throw new Error("No contact email is configured for this website.");

      const formData = new FormData(contactForm);
      const subject = `Project inquiry from ${formData.get("name")}`;
      const body = [
        `Name: ${formData.get("name")}`,
        `Email: ${formData.get("email")}`,
        "",
        formData.get("message"),
      ].join("\n");
      window.location.href = `mailto:${recipient}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      setModalOpen(false);
    } catch (error) {
      console.error("Contact form:", error);
      window.alert("Your message could not be prepared. Please use the contact details on the website.");
    }
  });

  const skillsSection = document.querySelector(".skills-container");
  if (!skillsSection || !("IntersectionObserver" in window)) return;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      skillsSection.querySelectorAll(".skill-progress").forEach((bar) => {
        bar.style.width = `${bar.dataset.width}%`;
      });
      observer.unobserve(skillsSection);
    });
  }, { threshold: 0.1 });

  observer.observe(skillsSection);
});
