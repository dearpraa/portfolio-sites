(() => {
  const app = document.getElementById("admin-app");
  const templateBin = document.getElementById("admin-template-bin");
  const routes = new Set([
    "dashboard", "portfolio", "content", "skills",
    "social", "navigation", "media", "settings",
  ]);
  const socialLocations = [
    ["header", "Header"], ["homepage", "Homepage"], ["about", "About"],
    ["portfolio", "Portfolio"], ["contact", "Contact"], ["footer", "Footer"],
  ];
  let currentUser = "";
  let flashMessage = "";
  let flashIsError = false;
  let draggedRow = null;
  let sharedTemplatesLoaded = false;

  function template(id) {
    const source = templateBin.querySelector(`#${id}`) || document.getElementById(id);
    if (!(source instanceof HTMLTemplateElement)) {
      throw new Error(`Admin template "${id}" is missing.`);
    }
    return source.content.firstElementChild.cloneNode(true);
  }

  async function loadSharedTemplates() {
    if (sharedTemplatesLoaded) return;
    const response = await fetch("/admin/shared.html", { credentials: "same-origin" });
    if (!response.ok) throw new Error(`Could not load shared admin templates (${response.status}).`);
    const source = new DOMParser().parseFromString(await response.text(), "text/html");
    const templates = [...source.querySelectorAll("template")];
    if (!templates.length) throw new Error("The shared admin template file is empty.");
    templateBin.append(...templates.map((item) => document.importNode(item, true)));
    sharedTemplatesLoaded = true;
  }

  async function loadPageTemplates(route) {
    const response = await fetch(`/admin/${route}.html`, { credentials: "same-origin" });
    if (!response.ok) throw new Error(`Could not load the ${route} admin page (${response.status}).`);
    const source = new DOMParser().parseFromString(await response.text(), "text/html");
    const pageTemplates = [...source.querySelectorAll("template")];
    if (!pageTemplates.length) throw new Error(`The ${route} admin page has no HTML templates.`);
    templateBin.querySelectorAll("template[data-page-template]").forEach((item) => item.remove());
    templateBin.append(...pageTemplates.map((pageTemplate) => {
      const imported = document.importNode(pageTemplate, true);
      imported.dataset.pageTemplate = "true";
      return imported;
    }));
  }

  async function api(url, options = {}) {
    const response = await fetch(url, {
      credentials: "same-origin",
      ...options,
      headers: {
        ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
        ...options.headers,
      },
    });
    const responseText = await response.text();
    let body = {};
    if (responseText) {
      try {
        body = JSON.parse(responseText);
      } catch {
        if (response.ok) throw new Error("The server returned an invalid response.");
      }
    }
    if (response.ok && (typeof body !== "object" || body === null)) {
      throw new Error("The server returned an invalid response.");
    }
    if (!response.ok) {
      const errorMessage = typeof body === "object" && body !== null ? body.error : "";
      if (response.status === 401 && !url.includes("/api/auth/session")) {
        currentUser = "";
        message(errorMessage || "Authentication required. Please log in again.", true);
        navigate("login", true);
      }
      throw new Error(errorMessage || `Request failed (${response.status}).`);
    }
    return body;
  }

  function message(text, error = false) {
    flashMessage = text;
    flashIsError = error;
    const existing = document.querySelector(".admin-notice");
    if (existing) {
      existing.textContent = text;
      existing.classList.toggle("error", error);
      existing.setAttribute("role", error ? "alert" : "status");
    } else {
      const host = document.querySelector(".admin-main, .login-card");
      if (host) host.prepend(createNotice(text, error));
    }
  }

  function clearMessage() {
    flashMessage = "";
    flashIsError = false;
  }

  function createNotice(text, error) {
    const notice = template("admin-notice-template");
    notice.classList.toggle("error", error);
    notice.setAttribute("role", error ? "alert" : "status");
    notice.textContent = text;
    return notice;
  }

  function currentRoute() {
    const name = location.pathname.replace(/^\/admin\/?/, "").split("/")[0] || "login";
    return routes.has(name) ? name : "dashboard";
  }

  function navigate(route, preserveMessage = false) {
    document.querySelectorAll(".admin-dialog-backdrop").forEach((backdrop) => backdrop.remove());
    const target = route === "login" ? "/admin/login" : `/admin/${route}`;
    history.pushState({}, "", target);
    if (!preserveMessage) clearMessage();
    render();
  }

  function formValue(form, name) {
    return form.elements.namedItem(name)?.value?.trim() || "";
  }

  function selectedChecks(form, name) {
    return [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((input) => input.value);
  }

  function pill(visible, yes = "Published", no = "Draft") {
    const status = template("admin-pill-template");
    status.classList.toggle("draft", !visible);
    status.textContent = visible ? yes : no;
    return status;
  }

  function layout(route, body, title) {
    const view = template("admin-layout-template");
    view.querySelector("[data-page-title]").textContent = title;
    view.querySelector("[data-current-user]").textContent = currentUser;
    view.querySelector(`[data-route="${route}"]`)?.setAttribute("aria-current", "page");
    view.querySelector("[data-page-content]").replaceChildren(body);
    if (flashMessage) view.querySelector("[data-admin-notice]").append(createNotice(flashMessage, flashIsError));
    app.replaceChildren(view);
  }

  function setActionId(element, id) {
    element.dataset.id = id;
    element.querySelectorAll("[data-action]").forEach((button) => { button.dataset.id = id; });
  }

  function addOptions(select, firstLabel, records, valueKey = "slug", labelKey = "title") {
    select.replaceChildren(new Option(firstLabel, ""));
    records.forEach((record) => {
      select.add(new Option(record[labelKey], record[valueKey]));
    });
  }

  function showDialog(title, body, onSubmit) {
    const backdrop = template("admin-dialog-template");
    const dialog = backdrop.querySelector(".admin-dialog");
    dialog.setAttribute("aria-label", title);
    dialog.querySelector("h2").textContent = title;
    dialog.append(body);
    document.body.appendChild(backdrop);
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop || event.target.closest("[data-close-dialog]")) backdrop.remove();
    });
    const form = backdrop.querySelector("form");
    if (form && onSubmit) {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const submit = form.querySelector('[type="submit"]');
        if (submit) submit.disabled = true;
        try {
          await onSubmit(form);
          backdrop.remove();
        } catch (error) {
          if (submit) submit.disabled = false;
          message(error.message, true);
        }
      });
    }
    return backdrop;
  }
  function setupDragSort(tbody, endpoint, values) {
    if (!tbody) return;
    tbody.addEventListener("dragstart", (event) => {
      const row = event.target.closest("tr[draggable=true]");
      if (!row) return;
      draggedRow = row;
      row.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
    });
    tbody.addEventListener("dragend", async () => {
      if (!draggedRow) return;
      draggedRow.classList.remove("dragging");
      draggedRow = null;
      const rows = [...tbody.querySelectorAll("tr[data-id]")];
      try {
        await Promise.all(rows.map((row, index) => {
          const record = values.find((value) => value.id === row.dataset.id);
          if (!record) return Promise.resolve();
          const payload = { ...record, displayOrder: index };
          return api(`${endpoint}/${encodeURIComponent(record.id)}`, {
            method: "PUT", body: JSON.stringify(payload),
          });
        }));
        message("Display order saved.");
      } catch (error) {
        message(error.message, true);
      }
    });
    tbody.addEventListener("dragover", (event) => {
      event.preventDefault();
      const target = event.target.closest("tr[draggable=true]");
      if (target && draggedRow && target !== draggedRow) {
        const box = target.getBoundingClientRect();
        tbody.insertBefore(draggedRow, event.clientY < box.top + box.height / 2 ? target : target.nextSibling);
      }
    });
  }

  async function findById(endpoint, id) {
    const items = await api(endpoint);
    return items.find((item) => item.id === id);
  }

  async function toggleRecord(endpoint, id, fieldName, successMessage) {
    const record = await findById(endpoint, id);
    if (!record) throw new Error("Record not found.");
    await api(`${endpoint}/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({ ...record, [fieldName]: !record[fieldName] }),
    });
    message(successMessage);
    await render();
  }

  async function deleteRecord(endpoint, id, promptText, successMessage) {
    if (window.confirm(promptText)) {
      await api(`${endpoint}/${encodeURIComponent(id)}`, { method: "DELETE" });
      message(successMessage);
      await render();
    }
  }

  function loginView() {
    app.replaceChildren(template("admin-login-template"));
    if (flashMessage) app.querySelector("[data-login-notice]").append(createNotice(flashMessage, flashIsError));
    document.getElementById("login-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      try {
        const result = await api("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ username: formValue(form, "username"), password: formValue(form, "password") }),
        });
        currentUser = result.username;
        navigate("dashboard");
      } catch (error) {
        message(error.message, true);
      }
    });
  }

  async function dashboard() {
    const stats = await api("/api/admin/dashboard");
    const tiles = [
      ["Total Photos", stats.totalPhotos], ["Published Photos", stats.publishedPhotos],
      ["Draft Photos", stats.draftPhotos], ["Featured Photos", stats.featuredPhotos],
      ["Skills & Expertise", stats.skills ?? 0], ["Social Links", stats.socialLinks],
      ["Navigation Items", stats.navigationItems],
    ];
    const view = template("dashboard-view-template");
    const statsGrid = view.querySelector("[data-stat-grid]");
    tiles.forEach(([label, value]) => {
      const tile = template("admin-stat-template");
      tile.querySelector(".stat-value").textContent = value;
      tile.querySelector(".stat-label").textContent = label;
      statsGrid.append(tile);
    });
    layout("dashboard", view, "Dashboard");
  }

  async function portfolioPage() {
    const items = await api("/api/admin/portfolio");
    const filteredItems = items;
    const categories = [
      { slug: "nature", title: "Nature" }, { slug: "portrait", title: "Portrait" },
      { slug: "street", title: "Street" }, { slug: "landscape", title: "Landscape" },
      { slug: "urban", title: "Urban" }, { slug: "travel", title: "Travel" },
      { slug: "monochrome", title: "Monochrome" }, { slug: "architecture", title: "Architecture" },
    ];
    const view = template("portfolio-view-template");
    const rows = view.querySelector("#photo-rows");

    filteredItems.forEach((item) => {
      const row = template("portfolio-row-template");
      setActionId(row, item.id);
      const image = row.querySelector(".admin-thumb");
      image.src = item.imageUrl;
      image.alt = item.title;
      row.querySelector("[data-photo-title]").textContent = item.title;
      row.querySelector("[data-photo-file]").textContent = item.fileName;
      row.querySelector("[data-photo-category]").textContent = item.category || "—";
      row.querySelector("[data-photo-status]").replaceChildren(
        item.hidden ? pill(false, "Published", "Hidden") : pill(item.published),
      );
      row.querySelector("[data-photo-featured]").textContent = item.featured ? "Featured" : "—";
      row.querySelector("[data-photo-order]").textContent = item.displayOrder;
      row.querySelector('[data-action="toggle-publish"]').textContent = item.published ? "Unpublish" : "Publish";
      row.querySelector('[data-action="toggle-hidden"]').textContent = item.hidden ? "Show" : "Hide";
      row.querySelector('[data-action="toggle-featured"]').textContent = item.featured ? "Unfeature" : "Feature";
      if (item.aiMetadata) {
        const aiBadge = row.querySelector('[data-photo-ai-badge]');
        if (aiBadge) aiBadge.hidden = false;
      }
      const aiBtn = row.querySelector('[data-action="ai-review"]');
      if (aiBtn) {
        aiBtn.addEventListener("click", () => aiAnalysisDialog(item));
      }
      rows.append(row);
    });

    if (!filteredItems.length) {
      const emptyRow = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 8;
      cell.className = "admin-empty";
      cell.textContent = "No portfolio items yet. Add your first photo to get started.";
      emptyRow.append(cell);
      rows.append(emptyRow);
    }

    addOptions(view.querySelector("#photo-category"), "All categories", categories);

    layout("portfolio", view, "Portfolio");

    document.getElementById("photo-search").addEventListener("input", filterPhotoRows);
    ["photo-category", "photo-status", "photo-featured"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("change", filterPhotoRows);
    });
    setupDragSort(document.getElementById("photo-rows"), "/api/admin/portfolio", items);
  }

  function filterPhotoRows() {
    const search = document.getElementById("photo-search")?.value.toLowerCase() || "";
    const category = document.getElementById("photo-category")?.value || "";
    const status = document.getElementById("photo-status")?.value || "";
    const featured = document.getElementById("photo-featured")?.value || "";

    document.querySelectorAll("#photo-rows tr[data-id]").forEach((row) => {
      const text = row.textContent.toLowerCase();
      const cells = row.querySelectorAll("td");
      const isHidden = cells[5].textContent.includes("Hidden");
      const isPublished = cells[5].textContent.includes("Published") && !isHidden;
      const isFeatured = cells[6].textContent.includes("Featured");
      row.hidden = (search && !text.includes(search))
        || (category && !cells[3].textContent.toLowerCase().includes(category))
        || (status === "published" && !isPublished)
        || (status === "draft" && isPublished)
        || (status === "hidden" && !isHidden)
        || (featured === "yes" && !isFeatured)
        || (featured === "no" && isFeatured);
    });
  }

  async function photoDialog(item = null) {
    const categories = [
      { slug: "nature", title: "Nature" }, { slug: "portrait", title: "Portrait" },
      { slug: "street", title: "Street" }, { slug: "landscape", title: "Landscape" },
      { slug: "urban", title: "Urban" }, { slug: "travel", title: "Travel" },
      { slug: "monochrome", title: "Monochrome" }, { slug: "architecture", title: "Architecture" },
    ];
    const form = template("photo-dialog-form-template");
    const preview = form.querySelector("[data-photo-preview]");
    const photoInput = form.querySelector('input[name="photo"]');

    addOptions(
      form.querySelector('select[name="category"]'),
      "No category",
      categories.map((s) => ({ slug: s.slug, title: s.title })),
    );

    const openAiBtn = form.querySelector('[data-action="open-ai-dialog"]');
    const aiBadge = form.querySelector('[data-photo-ai-badge]');
    const aiStatus = form.querySelector('[data-ai-status]');

    if (item?.aiMetadata && aiBadge) {
      aiBadge.hidden = false;
    }

    if (openAiBtn) {
      openAiBtn.addEventListener("click", () => {
        if (!item?.mediaId) {
          aiStatus.textContent = "Save the uploaded photo first before running AI analysis.";
          return;
        }
        aiAnalysisDialog(item);
      });
    }

    if (item) {
      preview.hidden = false;
      preview.src = item.imageUrl;
      preview.alt = item.title;
      photoInput.required = false;
      form.elements.namedItem("title").value = item.title;
      form.elements.namedItem("category").value = item.category || "";
      form.elements.namedItem("location").value = item.location || "";
      form.elements.namedItem("photoDate").value = item.photoDate || "";
      form.elements.namedItem("tags").value = item.tags.join(", ") || "";
      form.elements.namedItem("displayOrder").value = item.displayOrder ?? 0;
      form.elements.namedItem("description").value = item.description || "";
      if (form.elements.namedItem("altText")) {
        form.elements.namedItem("altText").value = item.altText || "";
      }
      form.elements.namedItem("featured").checked = Boolean(item.featured);
      form.elements.namedItem("published").checked = Boolean(item.published);
      form.elements.namedItem("hidden").checked = Boolean(item.hidden);
      form.querySelector("[data-submit-label]").textContent = "Save changes";
    } else {
      preview.hidden = true;
      photoInput.required = true;
      form.elements.namedItem("published").checked = true;
      form.querySelector("[data-submit-label]").textContent = "Upload photo";
    }

    showDialog(item ? "Edit portfolio item" : "Upload photo", form, async (dialogForm) => {
      const data = new FormData();
      for (const key of ["title", "category", "location", "photoDate", "tags", "displayOrder", "description", "altText"]) {
        if (dialogForm.elements.namedItem(key)) {
          data.set(key, formValue(dialogForm, key));
        }
      }
      data.set("featured", dialogForm.elements.namedItem("featured").checked ? "true" : "false");
      data.set("published", dialogForm.elements.namedItem("published").checked ? "true" : "false");
      data.set("hidden", dialogForm.elements.namedItem("hidden").checked ? "true" : "false");
      const photo = dialogForm.elements.namedItem("photo").files[0];
      if (photo) {
        if (photo.size > 12 * 1024 * 1024) throw new Error("Image exceeds the 12 MB limit.");
        data.set("photo", photo);
      }
      await api(item ? `/api/admin/portfolio/${encodeURIComponent(item.id)}` : "/api/admin/portfolio", {
        method: item ? "PUT" : "POST", body: data,
      });
      message(item ? "Portfolio item updated." : "Photo uploaded.");
      await render();
    });
  }

  async function aiAnalysisDialog(item) {
    if (!item?.mediaId) {
      message("Save the photo first before running AI analysis.", true);
      return;
    }
    const form = template("ai-analysis-dialog-template");
    const preview = form.querySelector("[data-ai-preview]");
    const badge = form.querySelector("[data-ai-analyzed-badge]");
    const statusText = form.querySelector("[data-ai-status-text]");
    const reanalyzeBtn = form.querySelector('[data-action="ai-reanalyze"]');

    preview.src = item.imageUrl;
    preview.alt = item.title;

    let aiMeta = null;
    if (item.aiMetadata) {
      try {
        aiMeta = typeof item.aiMetadata === "string" ? JSON.parse(item.aiMetadata) : item.aiMetadata;
      } catch {}
    }

    if (aiMeta) {
      badge.hidden = false;
      statusText.textContent = "Analyzed on " + (aiMeta.analyzedAt ? new Date(aiMeta.analyzedAt).toLocaleString() : "record");
    }

    const fillForm = (data) => {
      form.elements.namedItem("title").value = data.title || item.title || "";
      form.elements.namedItem("description").value = data.description || item.description || "";
      form.elements.namedItem("altText").value = data.altText || item.altText || "";
      form.elements.namedItem("category").value = data.category || item.category || "";
      form.elements.namedItem("location").value = data.location || item.location || "";
      form.elements.namedItem("tags").value = Array.isArray(data.tags) ? data.tags.join(", ") : (data.tags || (item.tags ? item.tags.join(", ") : ""));
      form.elements.namedItem("subject").value = data.subject || aiMeta?.subject || "";
      form.elements.namedItem("scene").value = data.scene || aiMeta?.scene || "";
      form.elements.namedItem("mood").value = data.mood || aiMeta?.mood || "";
      form.elements.namedItem("lighting").value = data.lighting || aiMeta?.lighting || "";
      form.elements.namedItem("composition").value = data.composition || aiMeta?.composition || "";
      form.elements.namedItem("style").value = data.style || aiMeta?.style || "";
    };

    fillForm({});

    const runAnalysis = async () => {
      try {
        reanalyzeBtn.disabled = true;
        statusText.textContent = "Analyzing photo with Gemini AI...";
        const res = await api("/api/admin/ai/analyze-photo", {
          method: "POST",
          body: JSON.stringify({ mediaId: item.mediaId }),
        });
        fillForm(res);
        statusText.textContent = "AI Analysis complete! Edit fields below if needed, then click Save.";
      } catch (err) {
        statusText.textContent = err.message || "AI analysis failed.";
      } finally {
        reanalyzeBtn.disabled = false;
      }
    };

    reanalyzeBtn.addEventListener("click", runAnalysis);

    if (!aiMeta) {
      runAnalysis();
    }

    showDialog("AI Analysis & Review", form, async (dialogForm) => {
      const data = new FormData();
      data.set("title", formValue(dialogForm, "title"));
      data.set("description", formValue(dialogForm, "description"));
      data.set("altText", formValue(dialogForm, "altText"));
      data.set("category", formValue(dialogForm, "category"));
      data.set("location", formValue(dialogForm, "location"));
      data.set("tags", formValue(dialogForm, "tags"));
      data.set("displayOrder", item.displayOrder ?? 0);
      data.set("featured", item.featured ? "true" : "false");
      data.set("published", item.published ? "true" : "false");
      data.set("hidden", item.hidden ? "true" : "false");

      const aiMetadataObj = {
        subject: formValue(dialogForm, "subject"),
        scene: formValue(dialogForm, "scene"),
        mood: formValue(dialogForm, "mood"),
        lighting: formValue(dialogForm, "lighting"),
        composition: formValue(dialogForm, "composition"),
        style: formValue(dialogForm, "style"),
        analyzedAt: new Date().toISOString(),
      };
      data.set("aiMetadata", JSON.stringify(aiMetadataObj));

      await api(`/api/admin/portfolio/${encodeURIComponent(item.id)}`, {
        method: "PUT",
        body: data,
      });
      message("Approved AI metadata saved.");
      await render();
    });
  }

  async function contentPage() {
    const content = await api("/api/admin/content");
    const view = template("content-view-template");
    const form = view.matches("#content-form") ? view : view.querySelector("#content-form");
    if (!form) {
      const notice = document.createElement("div");
      notice.className = "admin-notice error";
      notice.textContent = "Content form element is missing from the template.";
      return layout("content", notice, "Website content");
    }

    for (const [key, value] of Object.entries(content)) {
      const field = form.elements.namedItem(key);
      if (field) field.value = value;
    }

    view.querySelectorAll("[data-content-save]").forEach((button) => {
      button.addEventListener("click", async () => {
        const prefix = button.dataset.contentSave;
        const payload = {};
        for (const element of form.elements) {
          if (element.name && element.name.startsWith(prefix + ".")) {
            payload[element.name] = element.value.trim();
          }
        }
        try {
          button.disabled = true;
          await api("/api/admin/content", { method: "PUT", body: JSON.stringify(payload) });
          message(prefix.charAt(0).toUpperCase() + prefix.slice(1) + " website content saved.");
        } catch (error) {
          message(error.message, true);
        } finally {
          button.disabled = false;
        }
      });
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = {};
      for (const element of form.elements) {
        if (element.name) payload[element.name] = element.value.trim();
      }
      try {
        await api("/api/admin/content", { method: "PUT", body: JSON.stringify(payload) });
        message("All website content saved.");
      } catch (error) {
        message(error.message, true);
      }
    });

    layout("content", view, "Website content");
  }

  function renderSkills(skills, view) {
    const rows = view.querySelector("#skill-rows");
    skills.forEach((skill) => {
      const row = template("skill-row-template");
      setActionId(row, skill.id);
      row.querySelector("[data-skill-icon]").className = skill.icon || "ri-star-line";
      row.querySelector("[data-skill-name]").textContent = skill.name;
      row.querySelector("[data-skill-percent]").textContent = skill.percent + "%";
      row.querySelector("[data-skill-visibility]").replaceChildren(pill(skill.visible, "Visible", "Hidden"));
      row.querySelector("[data-skill-order]").textContent = skill.displayOrder;
      row.querySelector('[data-action="toggle-skill"]').textContent = skill.visible ? "Hide" : "Show";
      rows.append(row);
    });
    if (!skills.length) {
      const empty = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 7;
      cell.className = "admin-empty";
      cell.textContent = "No skills configured.";
      empty.append(cell);
      rows.append(empty);
    }
    setupDragSort(rows, "/api/admin/skills", skills);
  }

  async function skillDialog(skill = null) {
    const form = template("skill-dialog-form-template");
    if (skill) {
      form.elements.namedItem("name").value = skill.name || "";
      form.elements.namedItem("percent").value = skill.percent ?? 80;
      form.elements.namedItem("icon").value = skill.icon || "ri-star-line";
      form.elements.namedItem("displayOrder").value = skill.displayOrder ?? 0;
      form.elements.namedItem("visible").checked = Boolean(skill.visible);
      form.querySelector("[data-submit-label]").textContent = "Save skill";
    }
    showDialog(skill ? "Edit skill" : "Add skill", form, async (dialogForm) => {
      const payload = {
        name: formValue(dialogForm, "name"),
        percent: formValue(dialogForm, "percent"),
        icon: formValue(dialogForm, "icon"),
        displayOrder: formValue(dialogForm, "displayOrder"),
        visible: dialogForm.elements.namedItem("visible").checked,
      };
      const endpoint = skill ? "/api/admin/skills/" + encodeURIComponent(skill.id) : "/api/admin/skills";
      await api(endpoint, { method: skill ? "PUT" : "POST", body: JSON.stringify(payload) });
      message(skill ? "Skill updated." : "Skill added.");
      await render();
    });
  }
  async function skillsPage() {
    const skills = await api("/api/admin/skills");
    const view = template("skills-view-template");
    renderSkills(skills, view);
    layout("skills", view, "Skills & Expertise");
  }

  function renderSkills(skills, view) {
    const rows = view.querySelector("#skill-rows");
    if (!rows) return;
    rows.replaceChildren();
    skills.forEach((skill) => {
      const row = template("skill-row-template");
      setActionId(row, skill.id);
      const iconEl = row.querySelector("[data-skill-icon]");
      if (iconEl) iconEl.className = skill.icon;
      row.querySelector("[data-skill-name]").textContent = skill.name;
      row.querySelector("[data-skill-percent]").textContent = `${skill.percent}%`;
      row.querySelector("[data-skill-visibility]").replaceChildren(pill(skill.visible, "Visible", "Hidden"));
      row.querySelector("[data-skill-order]").textContent = skill.displayOrder;
      row.querySelector('[data-action="toggle-skill"]').textContent = skill.visible ? "Hide" : "Show";
      rows.append(row);
    });
    if (!skills.length) {
      const empty = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 7;
      cell.className = "admin-empty";
      cell.textContent = "No skills found. Use \"+ Add Skill\" above to create one.";
      empty.append(cell);
      rows.append(empty);
    }
    setupDragSort(rows, "/api/admin/skills", skills);
  }

  async function skillDialog(skill = null) {
    const form = template("skill-dialog-form-template");
    if (skill) {
      form.elements.namedItem("name").value = skill.name || "";
      form.elements.namedItem("percent").value = skill.percent ?? 80;
      form.elements.namedItem("icon").value = skill.icon || "ri-star-line";
      form.elements.namedItem("displayOrder").value = skill.displayOrder ?? 0;
      form.elements.namedItem("visible").checked = Boolean(skill.visible);
      form.querySelector("[data-submit-label]").textContent = "Save skill";
    }
    showDialog(skill ? "Edit skill" : "Add skill", form, async (dialogForm) => {
      const payload = {
        name: formValue(dialogForm, "name"),
        percent: parseInt(formValue(dialogForm, "percent"), 10),
        icon: formValue(dialogForm, "icon"),
        displayOrder: parseInt(formValue(dialogForm, "displayOrder") || "0", 10),
        visible: dialogForm.elements.namedItem("visible").checked,
      };
      await api(skill ? `/api/admin/skills/${encodeURIComponent(skill.id)}` : "/api/admin/skills", {
        method: skill ? "PUT" : "POST",
        body: JSON.stringify(payload),
      });
      message(skill ? "Skill updated." : "Skill added.");
      await render();
    });
  }

  async function socialPage() {
    const links = await api("/api/admin/social");
    const view = template("social-view-template");
    const rows = view.querySelector("#social-rows");

    links.forEach((link) => {
      const row = template("social-row-template");
      setActionId(row, link.id);
      row.querySelector("i").className = link.icon;
      row.querySelector("[data-social-name]").textContent = link.displayName;
      row.querySelector("[data-social-platform]").textContent = link.platform;
      const url = row.querySelector("[data-social-url]");
      url.href = link.url;
      url.textContent = link.url;
      row.querySelector("[data-social-locations]").textContent = link.locations.join(", ") || "—";
      row.querySelector("[data-social-visibility]").replaceChildren(pill(link.visible, "Visible", "Hidden"));
      row.querySelector('[data-action="toggle-social"]').textContent = link.visible ? "Hide" : "Show";
      rows.append(row);
    });

    if (!links.length) {
      const emptyRow = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 7;
      cell.className = "admin-empty";
      cell.textContent = "No social links found.";
      emptyRow.append(cell);
      rows.append(emptyRow);
    }

    addOptions(
      view.querySelector("#social-platform"),
      "All platforms",
      [...new Set(links.map((link) => link.platform))].map((platform) => ({ platform, label: platform })),
      "platform",
      "label",
    );

    layout("social", view, "Social links");
    ["social-search", "social-platform", "social-visible", "social-location"].forEach((id) => {
      document.getElementById(id).addEventListener("input", filterSocialRows);
    });
    setupDragSort(document.getElementById("social-rows"), "/api/admin/social", links);
  }

  function filterSocialRows() {
    const search = document.getElementById("social-search").value.toLowerCase();
    const platform = document.getElementById("social-platform").value;
    const visible = document.getElementById("social-visible").value;
    const location = document.getElementById("social-location").value;

    document.querySelectorAll("#social-rows tr[data-id]").forEach((row) => {
      const text = row.textContent.toLowerCase();
      const isVisible = row.querySelector(".status-pill").textContent === "Visible";
      row.hidden = (search && !text.includes(search))
        || (platform && !row.cells[2].textContent.includes(platform))
        || (visible === "yes" && !isVisible) || (visible === "no" && isVisible)
        || (location && !row.cells[4].textContent.includes(location));
    });
  }

  async function socialDialog(link = null) {
    const form = template("social-dialog-form-template");
    if (link) {
      form.elements.namedItem("platform").value = link.platform || "Instagram";
      form.elements.namedItem("displayName").value = link.displayName || "";
      form.elements.namedItem("url").value = link.url || "";
      form.elements.namedItem("icon").value = link.icon || "ri-link";
      form.elements.namedItem("displayOrder").value = link.displayOrder ?? 0;
      form.elements.namedItem("visible").checked = Boolean(link.visible);
      const locationsSet = new Set(link.locations || []);
      form.querySelectorAll('input[name="locations"]').forEach((input) => {
        input.checked = locationsSet.has(input.value);
      });
      form.querySelector("[data-submit-label]").textContent = "Save social link";
    }

    showDialog(link ? "Edit social link" : "Add social link", form, async (dialogForm) => {
      const payload = {
        platform: formValue(dialogForm, "platform"),
        displayName: formValue(dialogForm, "displayName"),
        url: formValue(dialogForm, "url"),
        icon: formValue(dialogForm, "icon"),
        displayOrder: formValue(dialogForm, "displayOrder"),
        visible: dialogForm.elements.namedItem("visible").checked,
        locations: selectedChecks(dialogForm, "locations"),
      };
      await api(link ? `/api/admin/social/${encodeURIComponent(link.id)}` : "/api/admin/social", {
        method: link ? "PUT" : "POST", body: JSON.stringify(payload),
      });
      message(link ? "Social link updated." : "Social link added.");
      await render();
    });
  }

  async function navigationPage() {
    const items = await api("/api/admin/navigation");
    const view = template("navigation-view-template");
    const rows = view.querySelector("#navigation-rows");

    items.forEach((item) => {
      const row = template("navigation-row-template");
      setActionId(row, item.id);
      row.querySelector("[data-navigation-label]").textContent = item.label;
      row.querySelector("[data-navigation-url]").textContent = item.url;
      row.querySelector("[data-navigation-icon]").textContent = item.icon || "—";
      row.querySelector("[data-navigation-visibility]").replaceChildren(pill(item.visible, "Visible", "Hidden"));
      row.querySelector("[data-navigation-order]").textContent = item.displayOrder;
      row.querySelector('[data-action="toggle-navigation"]').textContent = item.visible ? "Hide" : "Show";
      rows.append(row);
    });

    if (!items.length) {
      const emptyRow = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 7;
      cell.className = "admin-empty";
      cell.textContent = "No navigation items found.";
      emptyRow.append(cell);
      rows.append(emptyRow);
    }

    layout("navigation", view, "Navigation");
    setupDragSort(document.getElementById("navigation-rows"), "/api/admin/navigation", items);
  }

  async function navigationDialog(item = null) {
    const form = template("navigation-dialog-form-template");
    if (item) {
      form.elements.namedItem("label").value = item.label || "";
      form.elements.namedItem("url").value = item.url || "";
      form.elements.namedItem("icon").value = item.icon || "";
      form.elements.namedItem("displayOrder").value = item.displayOrder ?? 0;
      form.elements.namedItem("visible").checked = Boolean(item.visible);
      form.querySelector("[data-submit-label]").textContent = "Save item";
    }

    showDialog(item ? "Edit navigation item" : "Add navigation item", form, async (dialogForm) => {
      const payload = {
        label: formValue(dialogForm, "label"),
        url: formValue(dialogForm, "url"),
        icon: formValue(dialogForm, "icon"),
        displayOrder: formValue(dialogForm, "displayOrder"),
        visible: dialogForm.elements.namedItem("visible").checked,
      };
      await api(item ? `/api/admin/navigation/${encodeURIComponent(item.id)}` : "/api/admin/navigation", {
        method: item ? "PUT" : "POST", body: JSON.stringify(payload),
      });
      message(item ? "Navigation updated." : "Navigation item added.");
      await render();
    });
  }

  async function mediaPage() {
    const media = await api("/api/admin/media");
    const view = template("media-view-template");
    const grid = view.querySelector("#media-grid");

    media.forEach((item) => {
      const tile = template("media-tile-template");
      setActionId(tile, item.id);
      tile.dataset.search = `${item.file_name} ${item.usage.map((usage) => usage.title).join(" ")}`.toLowerCase();
      const image = tile.querySelector("img");
      image.src = item.file_url;
      image.alt = item.alt_text;
      tile.querySelector("[data-media-name]").textContent = item.file_name;
      tile.querySelector("[data-media-usage]").textContent = `${item.item_count} portfolio use${item.item_count === 1 ? "" : "s"}`;
      grid.append(tile);
    });

    if (!media.length) {
      const empty = document.createElement("p");
      empty.className = "admin-empty";
      empty.textContent = "No media stored.";
      grid.append(empty);
    }

    layout("media", view, "Media library");
    document.getElementById("media-search").addEventListener("input", (event) => {
      const value = event.target.value.toLowerCase();
      document.querySelectorAll(".media-tile").forEach((tile) => {
        tile.hidden = !tile.dataset.search.includes(value);
      });
    });
  }

  async function mediaEditDialog(media) {
    const form = template("media-edit-form-template");
    form.elements.namedItem("fileName").value = media.file_name || "";
    form.elements.namedItem("altText").value = media.alt_text || "";

    showDialog("Edit media details", form, async (dialogForm) => {
      await api(`/api/admin/media/${encodeURIComponent(media.id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          fileName: formValue(dialogForm, "fileName"),
          altText: formValue(dialogForm, "altText"),
        }),
      });
      message("Media details updated.");
      await render();
    });
  }

  async function mediaReplaceDialog(id) {
    const form = template("media-replace-form-template");
    showDialog("Replace media file", form, async (dialogForm) => {
      const data = new FormData();
      data.set("photo", dialogForm.elements.namedItem("photo").files[0]);
      await api(`/api/admin/media/${encodeURIComponent(id)}`, { method: "PUT", body: data });
      message("Image replaced; all references now use the new file.");
      await render();
    });
  }

  async function settingsPage() {
    layout("settings", template("settings-view-template"), "Settings");
  }

  async function action(event) {
    const target = event.target.closest("[data-action]");
    if (!target) return false;
    const actionName = target.dataset.action;
    const id = target.dataset.id;

    try {
      if (actionName === "logout") {
        await api("/api/auth/logout", { method: "POST", body: "{}" });
        currentUser = "";
        navigate("login");
      } else if (actionName === "add-photo") {
        await photoDialog();
      } else if (actionName === "edit-photo") {
        await photoDialog(await findById("/api/admin/portfolio", id));
      } else if (actionName === "delete-photo") {
        const item = await findById("/api/admin/portfolio", id);
        await deleteRecord(
          "/api/admin/portfolio",
          id,
          `Delete "${item.title}" from the portfolio? Its image is removed only if nothing else uses it.`,
          "Portfolio item deleted.",
        );
      } else if (actionName === "toggle-publish" || actionName === "toggle-featured" || actionName === "toggle-hidden") {
        const item = await findById("/api/admin/portfolio", id);
        const featured = actionName === "toggle-featured" ? !item.featured : item.featured;
        if (actionName === "toggle-publish") {
          item.published = !item.published;
          if (!item.published) item.hidden = false;
        }
        if (actionName === "toggle-featured") item.featured = featured;
        if (actionName === "toggle-hidden") item.hidden = !item.hidden;
        await api(`/api/admin/portfolio/${encodeURIComponent(id)}`, {
          method: "PUT", body: JSON.stringify({ ...item }),
        });
        message(
          actionName === "toggle-publish" ? "Publication status updated." :
          actionName === "toggle-hidden" ? "Visibility updated." : "Featured status updated.",
        );
        await render();
      } else if (actionName === "add-social") {
        await socialDialog();
      } else if (actionName === "edit-social") {
        await socialDialog(await findById("/api/admin/social", id));
      } else if (actionName === "toggle-social") {
        await toggleRecord("/api/admin/social", id, "visible", "Social link visibility updated.");
      } else if (actionName === "delete-social") {
        const link = await findById("/api/admin/social", id);
        await deleteRecord(
          "/api/admin/social",
          id,
          `Delete ${link.displayName}? It will disappear from every selected public location.`,
          "Social link deleted.",
        );
      } else if (actionName === "add-navigation") {
        await navigationDialog();
      } else if (actionName === "edit-navigation") {
        await navigationDialog(await findById("/api/admin/navigation", id));
      } else if (actionName === "toggle-navigation") {
        await toggleRecord("/api/admin/navigation", id, "visible", "Navigation visibility updated.");
      } else if (actionName === "delete-navigation") {
        const item = await findById("/api/admin/navigation", id);
        await deleteRecord(
          "/api/admin/navigation",
          id,
          `Delete navigation item "${item.label}"?`,
          "Navigation item deleted.",
        );
      } else if (actionName === "add-skill") {
        await skillDialog();
      } else if (actionName === "edit-skill") {
        const skill = (await api("/api/admin/skills")).find((s) => s.id === id);
        if (skill) await skillDialog(skill);
      } else if (actionName === "toggle-skill") {
        const skill = (await api("/api/admin/skills")).find((s) => s.id === id);
        if (!skill) throw new Error("Skill not found.");
        await api(`/api/admin/skills/${encodeURIComponent(id)}`, {
          method: "PUT",
          body: JSON.stringify({ ...skill, visible: !skill.visible }),
        });
        message("Skill visibility updated.");
        await render();
      } else if (actionName === "delete-skill") {
        const skill = (await api("/api/admin/skills")).find((s) => s.id === id);
        await deleteRecord(
          "/api/admin/skills",
          id,
          `Delete skill "${skill ? skill.name : id}"?`,
          "Skill deleted.",
        );
      } else if (actionName === "view-usage") {
        const media = (await api("/api/admin/media")).find((entry) => entry.id === id);
        const usage = media.usage.map((entry) => `${entry.title}: ${entry.slug || "unassigned"}${entry.is_published ? " (published)" : " (draft)"}`).join("\n");
        window.alert(usage || "This image is not used by any portfolio item.");
      } else if (actionName === "edit-media") {
        const media = (await api("/api/admin/media")).find((entry) => entry.id === id);
        await mediaEditDialog(media);
      } else if (actionName === "replace-media") {
        await mediaReplaceDialog(id);
      } else if (actionName === "delete-media") {
        const result = await fetch(`/api/admin/media/${encodeURIComponent(id)}`, { credentials: "same-origin" });
        const media = await result.json();
        if (!result.ok && result.status !== 409) throw new Error(media.error || "Could not inspect media.");
        if (media.usage?.length) {
          const usages = [...new Set(media.usage.map((entry) => entry.slug).filter(Boolean))].join(", ");
          const choice = window.prompt(`Image currently used in: ${usages || "portfolio items"}\nType REMOVE to unpublish and remove portfolio assignments, or DELETE to permanently delete the image and portfolio records. Cancel to keep it.`);
          if (choice === "REMOVE") {
            await api(`/api/admin/media/${encodeURIComponent(id)}?mode=remove-from-sections`, { method: "DELETE" });
            message("Image removed from portfolio assignments and affected items unpublished.");
          } else if (choice === "DELETE") {
            await api(`/api/admin/media/${encodeURIComponent(id)}?mode=permanent`, { method: "DELETE" });
            message("Image and its portfolio records permanently deleted.");
          } else return true;
        } else if (window.confirm("Delete this unused image permanently?")) {
          await api(`/api/admin/media/${encodeURIComponent(id)}?mode=permanent`, { method: "DELETE" });
          message("Image deleted.");
        } else return true;
        await render();
      }
    } catch (error) {
      message(error.message, true);
    }
    return true;
  }

  async function render() {
    try {
      await loadSharedTemplates();
      const session = await api("/api/auth/session");
      if (!session.authenticated) {
        currentUser = "";
        if (currentRoute() !== "login") history.replaceState({}, "", "/admin/login");
        await loadPageTemplates("login");
        return loginView();
      }
      currentUser = session.username;
      let route = currentRoute();
      if (route === "login") {
        history.replaceState({}, "", "/admin/dashboard");
        route = "dashboard";
      }
      await loadPageTemplates(route);
      const pages = {
        dashboard,
        portfolio: portfolioPage,
        content: contentPage,
        skills: skillsPage,
        social: socialPage,
        navigation: navigationPage,
        media: mediaPage,
        settings: settingsPage,
      };
      await pages[route]();
    } catch (error) {
      const errorView = template("admin-error-template");
      errorView.querySelector("[data-error-message]").textContent = error.message;
      app.replaceChildren(errorView);
    }
  }

  document.addEventListener("click", async (event) => {
    const routeLink = event.target.closest("[data-route]");
    if (routeLink) {
      event.preventDefault();
      navigate(routeLink.dataset.route);
      return;
    }
    await action(event);
  });

  window.addEventListener("popstate", () => {
    clearMessage();
    render();
  });

  render();
})();
