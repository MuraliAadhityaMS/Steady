const ICONS = ["↗", "▣", "◇", "◎", "✦"];
const COLORS = ["emerald", "indigo", "amber", "rose", "teal", "sky", "violet", "pink"];
const FREQUENCIES = ["Daily", "5× per week", "3× per week", "Weekdays", "Custom days", "Flexible weekly target"];
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SUPABASE_CONFIG = window.STEADY_SUPABASE || window.HABIT_TRACKER_SUPABASE || {};
const SUPABASE_TABLE = "habit_tracker_states";

const elements = {
  summary: document.querySelector("#summary-grid"), habits: document.querySelector("#habit-list"),
  range: document.querySelector("#range-select"), historyView: document.querySelector("#history-view"),
  todayView: document.querySelector("#today-view"), todayList: document.querySelector("#today-list"),
  todayDate: document.querySelector("#today-date"), todayProgress: document.querySelector("#today-progress"),
  dialog: document.querySelector("#habit-dialog"), form: document.querySelector("#habit-form"),
  name: document.querySelector("#habit-name"), frequency: document.querySelector("#habit-frequency"),
  customDaysField: document.querySelector("#custom-days-field"), weeklyTargetField: document.querySelector("#weekly-target-field"),
  weeklyTarget: document.querySelector("#weekly-target"), dialogEyebrow: document.querySelector("#habit-dialog-eyebrow"),
  dialogTitle: document.querySelector("#habit-dialog-title"), submitButton: document.querySelector("#habit-submit-button"),
  detailsDialog: document.querySelector("#details-dialog"), detailsTitle: document.querySelector("#details-title"),
  detailsStats: document.querySelector("#details-stats"), noteForm: document.querySelector("#note-form"),
  noteDate: document.querySelector("#note-date"), noteText: document.querySelector("#note-text"), notesList: document.querySelector("#notes-list"),
  addNotePanel: document.querySelector("#add-note-panel"), viewNotesPanel: document.querySelector("#view-notes-panel"),
  archiveButton: document.querySelector("#archived-button"), archiveDialog: document.querySelector("#archive-dialog"),
  archiveList: document.querySelector("#archive-list"), importInput: document.querySelector("#import-input"),
  dataStatus: document.querySelector("#data-file-status"),
  authForm: document.querySelector("#auth-form"), authEmail: document.querySelector("#auth-email"),
  authPassword: document.querySelector("#auth-password"), authSubmit: document.querySelector("#auth-submit"),
  authMessage: document.querySelector("#auth-message"), authSetup: document.querySelector("#auth-setup"),
  signInTab: document.querySelector("#sign-in-tab"), signUpTab: document.querySelector("#sign-up-tab"),
  accountEmail: document.querySelector("#account-email"), signOutButton: document.querySelector("#sign-out-button"),
  toast: document.querySelector("#toast"), toastMessage: document.querySelector("#toast-message"), toastUndo: document.querySelector("#toast-undo"),
};

let state = defaultState();
let editingHabitId = null;
let detailsHabitId = null;
let undoAction = null;
let toastTimer;
let saveQueue = Promise.resolve();
let supabaseClient = null;
let currentUser = null;
let authMode = "sign-in";
let sessionQueue = Promise.resolve();

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function atNoon(date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12); }
function addDays(date, amount) { const copy = atNoon(date); copy.setDate(copy.getDate() + amount); return copy; }
function mondayOf(date) { const copy = atNoon(date); return addDays(copy, -((copy.getDay() + 6) % 7)); }
function cloneState(value = state) { return JSON.parse(JSON.stringify(value)); }
function calculatePercent(completed, scheduled) { return scheduled ? Math.min(100, Math.round((completed / scheduled) * 100)) : 0; }

function defaultState() {
  return {
    version: 3, range: 52, theme: "light", view: "today", archived: [],
    habits: [],
  };
}

function normalizeEntries(raw, pattern, transform) {
  const result = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    Object.entries(raw).forEach(([key, value]) => { if (pattern.test(key)) { const next = transform(value); if (next) result[key] = next; } });
  }
  return result;
}

function normalizeHabit(raw, index = 0) {
  return {
    id: typeof raw?.id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(raw.id) ? raw.id : crypto.randomUUID(),
    name: typeof raw?.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 42) : `Habit ${index + 1}`,
    frequency: FREQUENCIES.includes(raw?.frequency) ? raw.frequency : "Daily",
    color: COLORS.includes(raw?.color) ? raw.color : COLORS[index % COLORS.length],
    icon: typeof raw?.icon === "string" && raw.icon ? raw.icon.slice(0, 2) : ICONS[index % ICONS.length],
    scheduleDays: Array.isArray(raw?.scheduleDays) ? [...new Set(raw.scheduleDays.map(Number).filter((day) => day >= 0 && day <= 6))] : [1, 3, 5],
    weeklyTarget: Math.min(7, Math.max(1, Number(raw?.weeklyTarget) || 3)),
    completions: normalizeEntries(raw?.completions, /^\d{4}-\d{2}-\d{2}$/, (value) => value ? 1 : null),
    notes: normalizeEntries(raw?.notes, /^\d{4}-\d{2}-\d{2}$/, (value) => typeof value === "string" ? value.trim().slice(0, 280) : null),
    ...(raw?.archivedAt ? { archivedAt: raw.archivedAt } : {}),
  };
}

function normalizeState(raw) {
  if (!raw || !Array.isArray(raw.habits)) throw new Error("Backup does not contain a habits list.");
  return {
    version: 3, range: [12, 26, 52].includes(Number(raw.range)) ? Number(raw.range) : 52, theme: raw.theme === "dark" ? "dark" : "light",
    view: "today", habits: raw.habits.map(normalizeHabit),
    archived: Array.isArray(raw.archived) ? raw.archived.map(normalizeHabit) : [],
  };
}

function hasSupabaseConfig() {
  return typeof SUPABASE_CONFIG.url === "string" && /^https:\/\/.+\.supabase\.co$/.test(SUPABASE_CONFIG.url)
    && typeof SUPABASE_CONFIG.publishableKey === "string" && SUPABASE_CONFIG.publishableKey.length > 20
    && !SUPABASE_CONFIG.url.includes("YOUR_") && !SUPABASE_CONFIG.publishableKey.includes("YOUR_");
}

async function loadStateFromCloud() {
  if (!supabaseClient || !currentUser) throw new Error("Sign in before loading data.");
  elements.dataStatus.textContent = "Secure cloud data: loading…";
  const { data, error } = await supabaseClient.from(SUPABASE_TABLE).select("state").eq("user_id", currentUser.id).maybeSingle();
  if (error) throw error;
  if (data?.state) {
    state = normalizeState(data.state);
  } else {
    state = defaultState();
    const { error: createError } = await supabaseClient.from(SUPABASE_TABLE).upsert({ user_id: currentUser.id, state }, { onConflict: "user_id" });
    if (createError) throw createError;
  }
  elements.dataStatus.textContent = "Secure cloud data: synchronized";
}

function saveState() {
  if (!supabaseClient || !currentUser) {
    showToast("Sign in before saving changes");
    return Promise.resolve();
  }
  const snapshot = cloneState();
  const userId = currentUser.id;
  elements.dataStatus.textContent = "Secure cloud data: saving…";
  saveQueue = saveQueue.then(async () => {
    const { error } = await supabaseClient.from(SUPABASE_TABLE).upsert({ user_id: userId, state: snapshot, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    if (error) throw error;
    elements.dataStatus.textContent = `Secure cloud data: saved ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }).catch((error) => {
    console.error("Could not save cloud data", error);
    elements.dataStatus.textContent = "Secure cloud data: save failed";
    showToast("Could not synchronize changes with Supabase");
  });
  return saveQueue;
}

function scheduledForDate(habit, date) {
  const day = date.getDay();
  if (habit.frequency === "5× per week" || habit.frequency === "Weekdays") return day >= 1 && day <= 5;
  if (habit.frequency === "3× per week") return day === 1 || day === 3 || day === 5;
  if (habit.frequency === "Custom days") return habit.scheduleDays.includes(day);
  return true;
}

function weekCompletionCount(habit, date) {
  const monday = mondayOf(date);
  let count = 0;
  for (let day = 0; day < 7; day += 1) if (habit.completions[dateKey(addDays(monday, day))]) count += 1;
  return count;
}

function flexiblePerformance(habit, days) {
  const today = atNoon(new Date());
  const start = addDays(today, -(days - 1));
  const weeks = new Map();
  for (let i = 0; i < days; i += 1) {
    const date = addDays(start, i);
    const weekKey = dateKey(mondayOf(date));
    if (!weeks.has(weekKey)) weeks.set(weekKey, { available: 0, completed: 0 });
    const week = weeks.get(weekKey);
    week.available += 1;
    if (habit.completions[dateKey(date)]) week.completed += 1;
  }
  return [...weeks.values()].reduce((total, week) => {
    const target = Math.min(habit.weeklyTarget, week.available);
    total.scheduled += target;
    total.completed += Math.min(target, week.completed);
    return total;
  }, { completed: 0, scheduled: 0 });
}

function performanceInRange(habit, days) {
  if (habit.frequency === "Flexible weekly target") return flexiblePerformance(habit, days);
  const today = atNoon(new Date());
  let completed = 0; let scheduled = 0;
  for (let i = 0; i < days; i += 1) {
    const date = addDays(today, -i);
    if (!scheduledForDate(habit, date)) continue;
    scheduled += 1;
    if (habit.completions[dateKey(date)]) completed += 1;
  }
  return { completed, scheduled };
}

function completionRate(habit, days = Number(state.range) * 7) {
  const result = performanceInRange(habit, days);
  return calculatePercent(result.completed, result.scheduled);
}

function previousScheduledDate(habit, date) {
  let cursor = addDays(date, -1);
  for (let attempts = 0; attempts < 14; attempts += 1) { if (scheduledForDate(habit, cursor)) return cursor; cursor = addDays(cursor, -1); }
  return cursor;
}

function flexibleStreaks(habit) {
  const currentMonday = mondayOf(new Date());
  let current = 0; let best = 0; let run = 0;
  for (let weeksAgo = 259; weeksAgo >= 0; weeksAgo -= 1) {
    const week = addDays(currentMonday, -weeksAgo * 7);
    const met = weekCompletionCount(habit, week) >= habit.weeklyTarget;
    run = met ? run + 1 : 0;
    best = Math.max(best, run);
  }
  let cursor = currentMonday;
  if (weekCompletionCount(habit, cursor) < habit.weeklyTarget) cursor = addDays(cursor, -7);
  for (let attempts = 0; attempts < 260 && weekCompletionCount(habit, cursor) >= habit.weeklyTarget; attempts += 1) {
    current += 1; cursor = addDays(cursor, -7);
  }
  return { current, best, unit: "week" };
}

function streaks(habit) {
  if (habit.frequency === "Flexible weekly target") return flexibleStreaks(habit);
  const today = atNoon(new Date());
  const keys = Object.keys(habit.completions).filter((key) => habit.completions[key]).sort();
  const earliest = keys.length ? new Date(`${keys[0]}T12:00:00`) : today;
  let cursor = earliest < addDays(today, -1825) ? addDays(today, -1825) : earliest;
  let run = 0; let best = 0;
  while (cursor <= today) {
    if (scheduledForDate(habit, cursor)) {
      run = habit.completions[dateKey(cursor)] ? run + 1 : 0;
      best = Math.max(best, run);
    }
    cursor = addDays(cursor, 1);
  }
  let current = 0; cursor = today;
  if (!scheduledForDate(habit, cursor) || !habit.completions[dateKey(cursor)]) cursor = previousScheduledDate(habit, cursor);
  for (let attempts = 0; attempts < 1825 && habit.completions[dateKey(cursor)]; attempts += 1) {
    current += 1; cursor = previousScheduledDate(habit, cursor);
  }
  return { current, best, unit: "scheduled day" };
}

function graphDates(weeks) {
  const start = addDays(mondayOf(new Date()), -(weeks - 1) * 7);
  return Array.from({ length: weeks }, (_, week) => Array.from({ length: 7 }, (_, day) => addDays(start, week * 7 + day)));
}

function frequencyDescription(habit) {
  if (habit.frequency === "Custom days") return habit.scheduleDays.slice().sort().map((day) => DAY_LABELS[day]).join(", ") || "No days selected";
  if (habit.frequency === "Flexible weekly target") return `${habit.weeklyTarget}× on any days each week`;
  return habit.frequency;
}

function renderSummary() {
  const weekly = state.habits.reduce((total, habit) => {
    const result = performanceInRange(habit, 7); total.completed += result.completed; total.scheduled += result.scheduled; return total;
  }, { completed: 0, scheduled: 0 });
  const allStreaks = state.habits.map(streaks);
  const bestEntry = state.habits.reduce((best, habit, index) => allStreaks[index].best > best.value ? { value: allStreaks[index].best, name: habit.name } : best, { value: 0, name: "No habit yet" });
  const today = atNoon(new Date());
  const todaysHabits = state.habits.filter((habit) => scheduledForDate(habit, today));
  const doneToday = todaysHabits.filter((habit) => habit.frequency === "Flexible weekly target" ? weekCompletionCount(habit, today) >= habit.weeklyTarget : habit.completions[dateKey(today)]).length;
  const cards = [
    { icon: "✓", label: "Finished today", value: `${doneToday}/${todaysHabits.length}` },
    { icon: "↗", label: "7 day completion", value: `${calculatePercent(weekly.completed, weekly.scheduled)}%` },
    { icon: "♢", label: "Best streak", value: `${bestEntry.value}`, detail: bestEntry.name },
    { icon: "◉", label: "Current streak", value: `${Math.max(0, ...allStreaks.map((value) => value.current))}` },
  ];
  elements.summary.innerHTML = cards.map((card) => `<article class="summary-card card"><div class="summary-icon" aria-hidden="true">${card.icon}</div><div><p class="summary-label">${card.label}</p><p class="summary-value">${card.value}</p>${card.detail ? `<p class="summary-detail">${escapeHtml(card.detail)}</p>` : ""}</div></article>`).join("");
}

function monthLabels(weeks) {
  return weeks.map((week, index) => {
    const date = week[0]; const previous = index ? weeks[index - 1][0] : null;
    return `<div class="month-label">${index === 0 || date.getMonth() !== previous.getMonth() ? `<span>${date.toLocaleDateString(undefined, { month: "short" })}</span>` : ""}</div>`;
  }).join("");
}

function renderHabit(habit, index) {
  const weeks = graphDates(Number(state.range)); const today = atNoon(new Date()); const stats = streaks(habit);
  const columns = weeks.map((week) => `<div class="week-column">${week.map((date) => {
    const key = dateKey(date); const future = date > today; const complete = Boolean(habit.completions[key]); const scheduled = scheduledForDate(habit, date);
    const pretty = date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: date.getFullYear() !== today.getFullYear() ? "numeric" : undefined });
    const status = complete ? "Completed" : scheduled ? "Not completed" : "Rest day"; const note = habit.notes[key] ? ` · ${habit.notes[key]}` : "";
    return `<button class="day-cell${scheduled ? "" : " rest-day"}" type="button" data-habit="${habit.id}" data-date="${key}" data-level="${complete ? 1 : 0}" data-tooltip="${escapeHtml(habit.name)} · ${pretty} · ${status}${escapeHtml(note)}" aria-label="${escapeHtml(habit.name)}, ${pretty}, ${status}${escapeHtml(note)}" ${future ? "disabled" : ""}></button>`;
  }).join("")}</div>`).join("");

  return `<article class="habit-card card theme-${habit.color} range-${state.range}-card">
    <header class="habit-header"><div class="habit-identity"><div class="habit-icon" aria-hidden="true">${escapeHtml(habit.icon)}</div><button class="habit-name-button" type="button" data-details-habit="${habit.id}"><span class="habit-name">${escapeHtml(habit.name)}</span><span class="habit-frequency">${escapeHtml(frequencyDescription(habit))}</span></button></div>
    <div class="habit-actions"><div class="habit-stats"><div class="habit-stat"><strong>${stats.current}</strong><span>${stats.unit} streak</span></div><div class="habit-stat"><strong>${completionRate(habit)}%</strong><span>completion</span></div></div>
    <details class="habit-menu"><summary class="icon-button" aria-label="Manage ${escapeHtml(habit.name)}">•••</summary><div class="menu-popover"><button type="button" data-action="add-note" data-habit="${habit.id}">Add note</button><button type="button" data-action="view-notes" data-habit="${habit.id}">View Notes</button><button type="button" data-action="edit" data-habit="${habit.id}">Edit</button><button type="button" data-action="export-png" data-habit="${habit.id}">Export grid as PNG</button><button type="button" data-action="move-up" data-habit="${habit.id}" ${index === 0 ? "disabled" : ""}>Move up</button><button type="button" data-action="move-down" data-habit="${habit.id}" ${index === state.habits.length - 1 ? "disabled" : ""}>Move down</button><button type="button" data-action="archive" data-habit="${habit.id}">Archive</button></div></details></div></header>
    <div class="graph-scroll" aria-label="${escapeHtml(habit.name)} contribution history"><div class="graph range-${state.range}" style="--weeks: ${weeks.length}"><div class="month-row">${monthLabels(weeks)}</div><div class="graph-body"><div class="weekday-labels" aria-hidden="true"><span>Mon</span><span></span><span>Wed</span><span></span><span>Fri</span><span></span><span>Sun</span></div><div class="week-columns">${columns}</div></div></div></div>
  </article>`;
}

function renderHabits() {
  elements.habits.innerHTML = state.habits.length ? state.habits.map(renderHabit).join("") : `<div class="empty-state card"><h2>No active habits</h2><p>Add a new habit or restore one from the archive.</p><button class="button button-primary" type="button" data-open-dialog>New habit</button></div>`;
  elements.archiveButton.hidden = !state.archived.length;
  elements.archiveButton.textContent = `Archived habits (${state.archived.length})`;
}

function renderTodayMenu(habit) {
  return `<details class="habit-menu today-habit-menu"><summary class="icon-button" aria-label="Manage ${escapeHtml(habit.name)}">•••</summary><div class="menu-popover"><button type="button" data-action="add-note" data-habit="${habit.id}">Add note</button><button type="button" data-action="view-notes" data-habit="${habit.id}">View Notes</button><button type="button" data-action="edit" data-habit="${habit.id}">Edit</button><button type="button" data-action="archive" data-habit="${habit.id}">Archive</button></div></details>`;
}

function renderToday() {
  const today = atNoon(new Date()); const key = dateKey(today);
  elements.todayDate.textContent = today.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const due = state.habits.filter((habit) => scheduledForDate(habit, today));
  let completedCount = 0;
  elements.todayList.innerHTML = due.map((habit) => {
    const flexible = habit.frequency === "Flexible weekly target"; const weekCount = flexible ? weekCompletionCount(habit, today) : 0;
    const complete = flexible ? weekCount >= habit.weeklyTarget : Boolean(habit.completions[key]); if (complete) completedCount += 1;
    const detail = flexible ? `${weekCount}/${habit.weeklyTarget} completed this week` : frequencyDescription(habit);
    return `<article class="today-card theme-${habit.color}"><div class="today-card-main"><div class="today-card-top"><div class="habit-icon" aria-hidden="true">${escapeHtml(habit.icon)}</div>${renderTodayMenu(habit)}</div><div><strong>${escapeHtml(habit.name)}</strong><p>${escapeHtml(detail)}</p></div></div><button class="today-toggle${complete ? " completed" : ""}" type="button" data-today-toggle="${habit.id}" ${flexible && complete && !habit.completions[key] ? "disabled" : ""}>${complete ? flexible ? "Goal met" : "Completed" : "Mark done"}</button></article>`;
  }).join("") || `<p class="today-empty">${state.habits.length ? "Nothing is scheduled today. Enjoy the space." : "No habits yet. Select New habit to create your first practice."}</p>`;
  elements.todayProgress.innerHTML = `<strong>${completedCount}/${due.length}</strong><span>completed</span>`;
}

function renderArchive() {
  elements.archiveList.innerHTML = state.archived.length ? state.archived.map((habit) => `<div class="archive-row"><div><strong>${escapeHtml(habit.name)}</strong><span>${escapeHtml(frequencyDescription(habit))}</span></div><div class="archive-actions"><button type="button" data-archive-action="restore" data-habit="${habit.id}">Restore</button><button class="danger-action" type="button" data-archive-action="delete" data-habit="${habit.id}">Delete</button></div></div>`).join("") : `<p class="archive-empty">There are no archived habits.</p>`;
}

function renderDetails() {
  const habit = state.habits.find((item) => item.id === detailsHabitId); if (!habit) return;
  const stats = streaks(habit); const last30 = performanceInRange(habit, 30);
  elements.detailsTitle.textContent = habit.name;
  elements.detailsStats.innerHTML = `<div class="detail-stat"><span>30-day completion</span><strong>${calculatePercent(last30.completed, last30.scheduled)}%</strong></div><div class="detail-stat"><span>Current streak</span><strong>${stats.current} ${stats.unit}${stats.current === 1 ? "" : "s"}</strong></div><div class="detail-stat"><span>Best streak</span><strong>${stats.best} ${stats.unit}${stats.best === 1 ? "" : "s"}</strong></div>`;
  const notes = Object.entries(habit.notes).filter(([, note]) => note).sort(([a], [b]) => b.localeCompare(a)).slice(0, 8);
  elements.notesList.innerHTML = notes.length ? notes.map(([date, note]) => `<div class="note-row"><time datetime="${date}">${new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time><p>${escapeHtml(note)}</p><button type="button" data-delete-note="${date}">Delete</button></div>`).join("") : `<p class="notes-empty">No notes yet.</p>`;
}

function setView(view, persist = true) {
  state.view = view === "today" ? "today" : "history"; if (persist) saveState();
  elements.historyView.hidden = state.view !== "history"; elements.todayView.hidden = state.view !== "today";
  document.querySelectorAll("[data-view]").forEach((button) => { const active = button.dataset.view === state.view; button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active)); });
  if (state.view === "today") renderToday();
}

function render() {
  document.documentElement.dataset.theme = state.theme; const dark = state.theme === "dark";
  document.querySelector("#theme-toggle").setAttribute("aria-label", `Switch to ${dark ? "light" : "dark"} theme`); document.querySelector(".theme-icon").textContent = dark ? "☀" : "☾";
  elements.range.value = String(state.range); renderSummary(); renderHabits(); renderToday(); setView(state.view, false);
  if (elements.archiveDialog.open) renderArchive(); if (elements.detailsDialog.open) renderDetails();
}

function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }

function showToast(message, options = {}) {
  clearTimeout(toastTimer); undoAction = options.undo || null;
  const openDialogs = [...document.querySelectorAll("dialog[open]")];
  (openDialogs.at(-1) || document.body).append(elements.toast);
  elements.toastMessage.textContent = message; elements.toastUndo.hidden = !undoAction; elements.toast.classList.add("visible");
  toastTimer = setTimeout(() => { elements.toast.classList.remove("visible"); undoAction = null; document.body.append(elements.toast); }, undoAction ? 6000 : 2400);
}

function updateScheduleFields() {
  elements.customDaysField.hidden = elements.frequency.value !== "Custom days";
  elements.weeklyTargetField.hidden = elements.frequency.value !== "Flexible weekly target";
}

function openHabitDialog(habit = null) {
  elements.form.reset(); editingHabitId = habit?.id || null;
  elements.dialogEyebrow.textContent = habit ? "Adjust your practice" : "Create a practice"; elements.dialogTitle.textContent = habit ? "Edit habit" : "New habit"; elements.submitButton.textContent = habit ? "Save changes" : "Create habit";
  if (habit) {
    elements.name.value = habit.name; elements.frequency.value = habit.frequency; elements.weeklyTarget.value = habit.weeklyTarget;
    elements.form.querySelector(`input[name="color"][value="${habit.color}"]`).checked = true;
    elements.form.querySelectorAll('input[name="scheduleDay"]').forEach((input) => { input.checked = habit.scheduleDays.includes(Number(input.value)); });
  }
  updateScheduleFields(); elements.dialog.showModal(); requestAnimationFrame(() => elements.name.focus());
}

function openDetails(id, section = "add") {
  detailsHabitId = id; const habit = state.habits.find((item) => item.id === id); if (!habit) return;
  elements.noteDate.max = dateKey(new Date()); elements.noteDate.value = dateKey(new Date()); elements.noteText.value = habit.notes[elements.noteDate.value] || "";
  setDetailsSection(section); renderDetails(); elements.detailsDialog.showModal();
}

function setDetailsSection(section) {
  const showNotes = section === "view";
  elements.addNotePanel.hidden = showNotes; elements.viewNotesPanel.hidden = !showNotes;
  document.querySelectorAll("[data-details-section]").forEach((button) => { const active = button.dataset.detailsSection === section; button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active)); });
}

function moveHabit(id, direction) {
  const index = state.habits.findIndex((habit) => habit.id === id); const target = index + direction; if (index < 0 || target < 0 || target >= state.habits.length) return;
  [state.habits[index], state.habits[target]] = [state.habits[target], state.habits[index]]; saveState(); render();
  showToast("Habit order updated", { undo: () => moveHabit(id, -direction) });
}

function handleHabitAction(action, id) {
  const index = state.habits.findIndex((habit) => habit.id === id); if (index < 0) return; const habit = state.habits[index];
  if (action === "add-note") return openDetails(id, "add"); if (action === "view-notes") return openDetails(id, "view"); if (action === "edit") return openHabitDialog(habit); if (action === "export-png") { exportHabitPng(habit).catch((error) => { console.error("Could not export habit PNG", error); showToast("Could not export the habit PNG"); }); return; } if (action === "move-up") return moveHabit(id, -1); if (action === "move-down") return moveHabit(id, 1);
  if (action === "archive") {
    state.habits.splice(index, 1); state.archived.push({ ...habit, archivedAt: new Date().toISOString() }); saveState(); render();
    showToast(`${habit.name} archived`, { undo: () => { const archivedIndex = state.archived.findIndex((item) => item.id === id); if (archivedIndex >= 0) state.archived.splice(archivedIndex, 1); delete habit.archivedAt; state.habits.splice(index, 0, habit); saveState(); render(); showToast("Archive undone"); } }); return;
  }
  if (action === "delete" && window.confirm(`Delete “${habit.name}” and its history? You can undo for six seconds.`)) {
    state.habits.splice(index, 1); saveState(); render();
    showToast(`${habit.name} deleted`, { undo: () => { state.habits.splice(index, 0, habit); saveState(); render(); showToast("Delete undone"); } });
  }
}

function toggleCheckIn(habitId, key) {
  const habit = state.habits.find((item) => item.id === habitId); if (!habit) return;
  const previous = habit.completions[key] || 0; if (previous) delete habit.completions[key]; else habit.completions[key] = 1; saveState(); render();
  showToast(previous ? "Check-in removed" : "Habit completed", { undo: () => { const target = state.habits.find((item) => item.id === habitId); if (!target) return; if (previous) target.completions[key] = previous; else delete target.completions[key]; saveState(); render(); showToast("Check-in restored"); } });
}

function exportBackup(filenamePrefix = "steady-v2-6-backup") {
  const blob = new Blob([JSON.stringify({ ...state, exportedAt: new Date().toISOString() }, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const link = document.createElement("a");
  link.href = url; link.download = `${filenamePrefix}-${dateKey(new Date())}.json`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 0);
}

const PNG_EXPORT_SCALE = 2;
const PNG_CELL_SIZE = 12;
const PNG_CELL_GAP = 4;
const PNG_CARD_HEIGHT = 266;
const PNG_CARD_GAP = 18;
const PNG_MAX_LOGICAL_HEIGHT = 5600;
const PNG_BASE_PALETTES = {
  light: { background: "#fafaf9", surface: "#ffffff", text: "#18181b", muted: "#71717a", border: "#e7e5e4" },
  dark: { background: "#141416", surface: "#1b1b1f", text: "#f4f4f5", muted: "#9c9ca5", border: "#303036" },
};
const PNG_HABIT_PALETTES = {
  light: {
    emerald: ["#f0fdf4", "#bbf7d0", "#15803d", "#e2e8e4", "#f5f8f6", "#22c55e"], indigo: ["#eef2ff", "#c7d2fe", "#4338ca", "#e5e7f2", "#f7f7fb", "#6366f1"],
    amber: ["#fffbeb", "#fde68a", "#b45309", "#eee8dc", "#faf8f3", "#f59e0b"], rose: ["#fff1f2", "#fecdd3", "#be123c", "#eee5e7", "#fbf7f8", "#f43f5e"],
    teal: ["#f0fdfa", "#99f6e4", "#0f766e", "#dcebea", "#f5f9f8", "#14b8a6"], sky: ["#f0f9ff", "#bae6fd", "#0369a1", "#dce9ef", "#f5f8fa", "#0ea5e9"],
    violet: ["#f5f3ff", "#ddd6fe", "#6d28d9", "#e7e3ef", "#f8f7fb", "#8b5cf6"], pink: ["#fdf2f8", "#fbcfe8", "#be185d", "#eee2e8", "#faf7f9", "#ec4899"],
  },
  dark: {
    emerald: ["#0c2718", "#14532d", "#6ee7a0", "#29322d", "#1b201d", "#3f7657"], indigo: ["#171737", "#3730a3", "#b7c1ff", "#2d2e38", "#1c1c23", "#59628f"],
    amber: ["#2c1c08", "#78350f", "#fcd35d", "#353029", "#201c18", "#8a6a34"], rose: ["#32121a", "#881337", "#fda4af", "#372d30", "#211b1d", "#87505d"],
    teal: ["#122a29", "#285e59", "#8bd4cc", "#303a39", "#222827", "#477b76"], sky: ["#132631", "#29566d", "#9ac9df", "#30383d", "#222629", "#4e7187"],
    violet: ["#211a33", "#51417c", "#c4b5e8", "#36313f", "#25222a", "#6c5a8f"], pink: ["#301923", "#71344e", "#e7adc4", "#3b3035", "#282226", "#86556c"],
  },
};

function roundedRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath(); context.moveTo(x + r, y); context.arcTo(x + width, y, x + width, y + height, r); context.arcTo(x + width, y + height, x, y + height, r); context.arcTo(x, y + height, x, y, r); context.arcTo(x, y, x + width, y, r); context.closePath();
}

function createPngCanvas(width, height) {
  const canvas = document.createElement("canvas"); canvas.width = width * PNG_EXPORT_SCALE; canvas.height = height * PNG_EXPORT_SCALE;
  const context = canvas.getContext("2d"); context.scale(PNG_EXPORT_SCALE, PNG_EXPORT_SCALE); context.textBaseline = "alphabetic";
  return { canvas, context };
}

function habitPngPalette(habit) {
  const theme = state.theme === "dark" ? "dark" : "light"; const values = PNG_HABIT_PALETTES[theme][habit.color] || PNG_HABIT_PALETTES[theme].emerald;
  return { soft: values[0], accentBorder: values[1], strong: values[2], cellBorder: values[3], empty: values[4], filled: values[5] };
}

function mixPngHex(first, second, amount) {
  const parse = (value) => [1, 3, 5].map((index) => Number.parseInt(value.slice(index, index + 2), 16)); const a = parse(first); const b = parse(second);
  return `#${a.map((channel, index) => Math.round(channel + (b[index] - channel) * amount).toString(16).padStart(2, "0")).join("")}`;
}

function drawPngText(context, value, x, y, options = {}) {
  context.fillStyle = options.color || "#18181b"; context.font = `${options.weight || 400} ${options.size || 12}px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  context.textAlign = options.align || "left"; context.fillText(String(value), x, y);
}

function drawHabitPngCard(context, habit, x, y, width) {
  const base = PNG_BASE_PALETTES[state.theme === "dark" ? "dark" : "light"]; const accent = habitPngPalette(habit); const dark = state.theme === "dark";
  context.fillStyle = dark ? mixPngHex(base.surface, accent.soft, 0.16) : base.surface; roundedRect(context, x, y, width, PNG_CARD_HEIGHT, 14); context.fill(); context.strokeStyle = base.border; context.lineWidth = 1; context.stroke();
  context.fillStyle = accent.soft; roundedRect(context, x + 24, y + 20, 42, 42, 10); context.fill(); context.strokeStyle = accent.accentBorder; context.stroke();
  drawPngText(context, habit.icon, x + 45, y + 48, { size: 17, weight: 700, color: accent.strong, align: "center" });
  drawPngText(context, habit.name, x + 80, y + 37, { size: 16, weight: 700, color: base.text });
  drawPngText(context, frequencyDescription(habit), x + 80, y + 56, { size: 11, color: base.muted });
  const stats = streaks(habit); drawPngText(context, `${stats.current}`, x + width - 140, y + 35, { size: 17, weight: 700, color: accent.strong, align: "right" });
  drawPngText(context, `${stats.unit} streak`, x + width - 140, y + 53, { size: 10, color: base.muted, align: "right" });
  drawPngText(context, `${completionRate(habit)}%`, x + width - 24, y + 35, { size: 17, weight: 700, color: accent.strong, align: "right" });
  drawPngText(context, "completion", x + width - 24, y + 53, { size: 10, color: base.muted, align: "right" });

  const weeks = graphDates(Number(state.range)); const graphWidth = weeks.length * (PNG_CELL_SIZE + PNG_CELL_GAP) - PNG_CELL_GAP; const graphX = x + width - 24 - graphWidth; const labelX = graphX - 42; const monthY = y + 96; const gridY = y + 112; const today = atNoon(new Date());
  weeks.forEach((week, weekIndex) => {
    const date = week[0]; const previous = weekIndex ? weeks[weekIndex - 1][0] : null;
    if (weekIndex === 0 || date.getMonth() !== previous.getMonth()) drawPngText(context, date.toLocaleDateString(undefined, { month: "short" }), graphX + weekIndex * (PNG_CELL_SIZE + PNG_CELL_GAP), monthY, { size: 10, color: base.muted });
  });
  [[0, "Mon"], [2, "Wed"], [4, "Fri"], [6, "Sun"]].forEach(([row, label]) => drawPngText(context, label, labelX, gridY + row * (PNG_CELL_SIZE + PNG_CELL_GAP) + 10, { size: 9, color: base.muted }));
  weeks.forEach((week, weekIndex) => week.forEach((date, rowIndex) => {
    const future = date > today; const complete = Boolean(habit.completions[dateKey(date)]); const cellX = graphX + weekIndex * (PNG_CELL_SIZE + PNG_CELL_GAP); const cellY = gridY + rowIndex * (PNG_CELL_SIZE + PNG_CELL_GAP);
    context.save(); context.globalAlpha = future ? 0.42 : 1; context.fillStyle = complete ? accent.filled : accent.empty; roundedRect(context, cellX, cellY, PNG_CELL_SIZE, PNG_CELL_SIZE, 3); context.fill();
    if (!complete) { context.strokeStyle = accent.cellBorder; context.lineWidth = 1; context.stroke(); } context.restore();
  }));
  const firstDate = weeks[0][0]; const lastDate = weeks.at(-1)[6];
  drawPngText(context, `${firstDate.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} – ${lastDate.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`, x + 24, y + PNG_CARD_HEIGHT - 18, { size: 10, color: base.muted });
}

function pngLayoutWidth() { return state.range === 12 ? 520 : state.range === 26 ? 720 : 980; }

function renderHabitPng(habit) {
  const width = pngLayoutWidth(); const height = PNG_CARD_HEIGHT + 48; const { canvas, context } = createPngCanvas(width, height); const base = PNG_BASE_PALETTES[state.theme === "dark" ? "dark" : "light"];
  context.fillStyle = base.background; context.fillRect(0, 0, width, height); drawHabitPngCard(context, habit, 24, 24, width - 48); return canvas;
}

function renderAllHabitPngChunks() {
  if (!state.habits.length) return [];
  const width = pngLayoutWidth(); const headerHeight = 108; const bottom = 32; const habitsPerImage = Math.max(1, Math.floor((PNG_MAX_LOGICAL_HEIGHT - headerHeight - bottom + PNG_CARD_GAP) / (PNG_CARD_HEIGHT + PNG_CARD_GAP))); const chunks = [];
  for (let start = 0; start < state.habits.length; start += habitsPerImage) {
    const habits = state.habits.slice(start, start + habitsPerImage); const height = headerHeight + habits.length * PNG_CARD_HEIGHT + Math.max(0, habits.length - 1) * PNG_CARD_GAP + bottom; const { canvas, context } = createPngCanvas(width, height); const base = PNG_BASE_PALETTES[state.theme === "dark" ? "dark" : "light"];
    context.fillStyle = base.background; context.fillRect(0, 0, width, height); drawPngText(context, "Steady", 24, 43, { size: 27, weight: 750, color: base.text });
    drawPngText(context, `${state.range}-week history · ${state.habits.length} active habit${state.habits.length === 1 ? "" : "s"} · Exported ${new Date().toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}`, 24, 69, { size: 12, color: base.muted });
    if (state.habits.length > habitsPerImage) drawPngText(context, `Part ${chunks.length + 1} of ${Math.ceil(state.habits.length / habitsPerImage)}`, width - 24, 43, { size: 11, weight: 700, color: base.muted, align: "right" });
    habits.forEach((habit, index) => drawHabitPngCard(context, habit, 24, headerHeight + index * (PNG_CARD_HEIGHT + PNG_CARD_GAP), width - 48)); chunks.push(canvas);
  }
  return chunks;
}

function slugifyFilename(value) { return String(value).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "habit"; }

function downloadPng(canvas, filename) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => {
    if (!blob) return reject(new Error("The browser could not create the PNG.")); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); resolve({ filename, width: canvas.width, height: canvas.height, size: blob.size });
  }, "image/png"));
}

async function exportHabitPng(habit) {
  const filename = `habit-${slugifyFilename(habit.name)}-${state.range}-weeks-${dateKey(new Date())}.png`; const result = await downloadPng(renderHabitPng(habit), filename); showToast(`${habit.name} grid exported`); return result;
}

async function exportAllHabitPngs() {
  const canvases = renderAllHabitPngChunks(); if (!canvases.length) return showToast("Add a habit before exporting grids"); const date = dateKey(new Date()); const results = [];
  for (let index = 0; index < canvases.length; index += 1) { const suffix = canvases.length > 1 ? `-part-${index + 1}` : ""; results.push(await downloadPng(canvases[index], `steady-all-${state.range}-weeks-${date}${suffix}.png`)); }
  showToast(canvases.length > 1 ? `${canvases.length} PNG files exported` : "All habit grids exported"); return results;
}

async function importBackup(file) {
  if (!file) return; if (file.size > 2_000_000) throw new Error("Backup is too large.");
  const imported = normalizeState(JSON.parse(await file.text())); const previous = cloneState();
  exportBackup("steady-v2-6-pre-import"); state = imported; saveState(); render();
  showToast("Backup imported; previous data was exported", { undo: () => { state = previous; saveState(); render(); showToast("Import undone"); } });
}

function runSelfTests() {
  const checks = []; const test = (name, condition) => checks.push({ name, passed: Boolean(condition) });
  const monday = new Date(2026, 7, 3, 12); const sunday = new Date(2026, 7, 9, 12);
  test("Daily includes Sunday", scheduledForDate({ frequency: "Daily" }, sunday));
  test("Weekdays include Monday", scheduledForDate({ frequency: "Weekdays" }, monday));
  test("Weekdays exclude Sunday", !scheduledForDate({ frequency: "Weekdays" }, sunday));
  test("Three-per-week excludes Tuesday", !scheduledForDate({ frequency: "3× per week" }, addDays(monday, 1)));
  test("Custom schedule uses selected days", scheduledForDate({ frequency: "Custom days", scheduleDays: [1, 4] }, monday) && !scheduledForDate({ frequency: "Custom days", scheduleDays: [4] }, monday));
  test("Percentage rounds normally", calculatePercent(2, 3) === 67);
  test("Percentage cannot exceed 100", calculatePercent(9, 3) === 100);
  test("New accounts start without sample habits", defaultState().habits.length === 0);
  test("Twelve-week history range is retained", normalizeState({ habits: [], range: 12 }).range === 12);
  const failed = checks.filter((check) => !check.passed); console.table(checks);
  showToast(failed.length ? `${failed.length} of ${checks.length} checks failed` : `All ${checks.length} calculation checks passed`);
  return checks;
}

function setAuthMessage(message = "", isError = false) {
  elements.authMessage.textContent = message;
  elements.authMessage.classList.toggle("error", isError);
}

function setAuthMode(mode) {
  authMode = mode;
  const signingUp = mode === "sign-up";
  elements.signInTab.classList.toggle("active", !signingUp);
  elements.signUpTab.classList.toggle("active", signingUp);
  elements.signInTab.setAttribute("aria-selected", String(!signingUp));
  elements.signUpTab.setAttribute("aria-selected", String(signingUp));
  elements.authPassword.autocomplete = signingUp ? "new-password" : "current-password";
  elements.authSubmit.textContent = signingUp ? "Create account" : "Sign in";
  setAuthMessage();
}

async function applySession(session) {
  const user = session?.user || null;
  if (!user) {
    currentUser = null;
    state = defaultState();
    elements.accountEmail.textContent = "";
    document.body.dataset.authState = "signed-out";
    return;
  }
  if (currentUser?.id === user.id && document.body.dataset.authState === "signed-in") return;
  currentUser = user;
  document.body.dataset.authState = "loading";
  try {
    await loadStateFromCloud();
    elements.accountEmail.textContent = user.email || "Signed in";
    document.body.dataset.authState = "signed-in";
    render();
  } catch (error) {
    console.error("Could not initialize Supabase data", error);
    elements.dataStatus.textContent = "Secure cloud data: unavailable";
    setAuthMessage(`Signed in, but data could not load: ${error.message}`, true);
    document.body.dataset.authState = "signed-out";
  }
}

function queueSession(session) {
  sessionQueue = sessionQueue.then(() => applySession(session));
  return sessionQueue;
}

async function initializeSupabase() {
  if (!hasSupabaseConfig() || !window.supabase?.createClient) {
    elements.authForm.hidden = true;
    elements.authSetup.hidden = false;
    document.body.dataset.authState = "signed-out";
    return;
  }
  supabaseClient = window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.publishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  supabaseClient.auth.onAuthStateChange((_event, session) => {
    window.setTimeout(() => queueSession(session), 0);
  });
  const { data, error } = await supabaseClient.auth.getSession();
  if (error) {
    setAuthMessage(error.message, true);
    document.body.dataset.authState = "signed-out";
    return;
  }
  await queueSession(data.session);
}

document.querySelector("#new-habit-button").addEventListener("click", () => openHabitDialog());
document.querySelector("#theme-toggle").addEventListener("click", () => { state.theme = state.theme === "dark" ? "light" : "dark"; saveState(); render(); });
document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view, true)));
document.querySelectorAll("[data-details-section]").forEach((button) => button.addEventListener("click", () => setDetailsSection(button.dataset.detailsSection)));
elements.frequency.addEventListener("change", updateScheduleFields);
document.querySelector("#close-dialog").addEventListener("click", () => elements.dialog.close()); document.querySelector("#cancel-dialog").addEventListener("click", () => elements.dialog.close());
document.querySelector("#close-archive-dialog").addEventListener("click", () => elements.archiveDialog.close()); document.querySelector("#close-details-dialog").addEventListener("click", () => elements.detailsDialog.close());
[elements.dialog, elements.archiveDialog, elements.detailsDialog].forEach((dialog) => {
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener("close", () => { if (dialog.contains(elements.toast)) document.body.append(elements.toast); });
});

elements.form.addEventListener("submit", (event) => {
  event.preventDefault(); const formData = new FormData(elements.form); const name = String(formData.get("name") || "").trim(); if (!name) return;
  const frequency = String(formData.get("frequency")); const scheduleDays = formData.getAll("scheduleDay").map(Number);
  if (frequency === "Custom days" && !scheduleDays.length) return showToast("Select at least one scheduled day");
  const previous = cloneState(); const existing = state.habits.find((habit) => habit.id === editingHabitId);
  if (existing) { existing.name = name; existing.frequency = frequency; existing.color = String(formData.get("color")); existing.scheduleDays = scheduleDays; existing.weeklyTarget = Math.min(7, Math.max(1, Number(formData.get("weeklyTarget")) || 3)); }
  else state.habits.push({ id: crypto.randomUUID(), name, frequency, color: String(formData.get("color")), icon: ICONS[state.habits.length % ICONS.length], scheduleDays, weeklyTarget: Math.min(7, Math.max(1, Number(formData.get("weeklyTarget")) || 3)), completions: {}, notes: {} });
  editingHabitId = null; saveState(); render(); elements.dialog.close();
  showToast(existing ? "Habit updated" : `${name} added`, { undo: () => { state = previous; saveState(); render(); showToast("Change undone"); } });
});

elements.range.addEventListener("change", (event) => { state.range = Number(event.target.value); saveState(); renderSummary(); renderHabits(); });
elements.habits.addEventListener("click", (event) => {
  const open = event.target.closest("[data-open-dialog]"); if (open) return openHabitDialog();
  const details = event.target.closest("[data-details-habit]"); if (details) return openDetails(details.dataset.detailsHabit);
  const action = event.target.closest("[data-action]"); if (action) { action.closest("details")?.removeAttribute("open"); return handleHabitAction(action.dataset.action, action.dataset.habit); }
  const cell = event.target.closest(".day-cell:not(:disabled)"); if (cell) toggleCheckIn(cell.dataset.habit, cell.dataset.date);
});
elements.todayList.addEventListener("click", (event) => {
  const action = event.target.closest("[data-action]");
  if (action) { action.closest("details")?.removeAttribute("open"); return handleHabitAction(action.dataset.action, action.dataset.habit); }
  const button = event.target.closest("[data-today-toggle]");
  if (button) toggleCheckIn(button.dataset.todayToggle, dateKey(new Date()));
});
elements.toastUndo.addEventListener("click", () => { if (!undoAction) return; const action = undoAction; undoAction = null; action(); });

elements.archiveButton.addEventListener("click", () => { renderArchive(); elements.archiveDialog.showModal(); });
elements.archiveList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-archive-action]"); if (!button) return; const index = state.archived.findIndex((habit) => habit.id === button.dataset.habit); if (index < 0) return; const habit = state.archived[index];
  if (button.dataset.archiveAction === "restore") { state.archived.splice(index, 1); delete habit.archivedAt; state.habits.push(habit); saveState(); render(); renderArchive(); showToast(`${habit.name} restored`, { undo: () => handleHabitAction("archive", habit.id) }); }
  else if (window.confirm(`Delete archived habit “${habit.name}”? You can undo for six seconds.`)) { state.archived.splice(index, 1); saveState(); render(); renderArchive(); showToast(`${habit.name} deleted`, { undo: () => { state.archived.splice(index, 0, habit); saveState(); render(); renderArchive(); showToast("Delete undone"); } }); }
});

elements.noteDate.addEventListener("change", () => { const habit = state.habits.find((item) => item.id === detailsHabitId); elements.noteText.value = habit?.notes[elements.noteDate.value] || ""; });
elements.noteForm.addEventListener("submit", (event) => {
  event.preventDefault(); const habit = state.habits.find((item) => item.id === detailsHabitId); if (!habit) return; const key = elements.noteDate.value; const previous = habit.notes[key] || ""; const next = elements.noteText.value.trim();
  if (next) habit.notes[key] = next; else delete habit.notes[key]; saveState(); render(); renderDetails();
  showToast(next ? "Note saved" : "Note removed", { undo: () => { if (previous) habit.notes[key] = previous; else delete habit.notes[key]; saveState(); render(); renderDetails(); showToast("Note change undone"); } });
});
elements.notesList.addEventListener("click", (event) => { const button = event.target.closest("[data-delete-note]"); if (!button) return; elements.noteDate.value = button.dataset.deleteNote; elements.noteText.value = ""; elements.noteForm.requestSubmit(); });

document.querySelector("#export-button").addEventListener("click", () => { exportBackup(); showToast("Backup exported"); });
document.querySelector("#import-button").addEventListener("click", () => elements.importInput.click());
document.querySelector("#export-all-png-button").addEventListener("click", () => { exportAllHabitPngs().catch((error) => { console.error("Could not export all habit PNGs", error); showToast("Could not export the habit grids"); }); });
elements.importInput.addEventListener("change", async () => { try { await importBackup(elements.importInput.files[0]); } catch (error) { showToast(error instanceof SyntaxError ? "That file is not valid JSON" : error.message || "Could not import backup"); } finally { elements.importInput.value = ""; } });
document.querySelector("#self-test-button").addEventListener("click", runSelfTests);
document.querySelector("#reset-button").addEventListener("click", () => { if (!window.confirm("Clear every active and archived habit, completion, and note from this account?")) return; const previous = cloneState(); state = defaultState(); saveState(); render(); showToast("All account data cleared", { undo: () => { state = previous; saveState(); render(); showToast("Clear undone"); } }); });

elements.signInTab.addEventListener("click", () => setAuthMode("sign-in"));
elements.signUpTab.addEventListener("click", () => setAuthMode("sign-up"));
elements.authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!supabaseClient) return;
  const email = elements.authEmail.value.trim();
  const password = elements.authPassword.value;
  elements.authSubmit.disabled = true;
  setAuthMessage(authMode === "sign-up" ? "Creating your private account…" : "Signing in…");
  try {
    if (authMode === "sign-up") {
      const { data, error } = await supabaseClient.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: `${window.location.origin}${window.location.pathname}` },
      });
      if (error) throw error;
      if (data.session) await queueSession(data.session);
      else setAuthMessage("Check your email to confirm the account, then return here to sign in.");
    } else {
      const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
      if (error) throw error;
      await queueSession(data.session);
    }
  } catch (error) {
    setAuthMessage(error.message || "Authentication failed.", true);
  } finally {
    elements.authSubmit.disabled = false;
  }
});

elements.signOutButton.addEventListener("click", async () => {
  elements.signOutButton.disabled = true;
  try {
    await saveQueue;
    const { error } = await supabaseClient.auth.signOut();
    if (error) throw error;
    await queueSession(null);
    setAuthMode("sign-in");
    elements.authPassword.value = "";
  } catch (error) {
    showToast(error.message || "Could not sign out");
  } finally {
    elements.signOutButton.disabled = false;
  }
});

async function initialize() {
  setAuthMode("sign-in");
  await initializeSupabase();
}

initialize();
