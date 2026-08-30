(() => {
  "use strict";

  const CHILD_IDS = ["xiaoyue", "xiaoyi"];
  const CHILD_FALLBACKS = {
    xiaoyue: "黄小越",
    xiaoyi: "黄小翊",
  };
  const WEEKDAYS = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"];
  const STATUS_LABELS = {
    not_started: "未开始",
    in_progress: "进行中",
    completed: "已完成",
  };
  const RELATED_FALLBACKS = {
    xiaoyue: "黄小越",
    xiaoyi: "黄小翊",
    family: "全家",
  };
  const DEFAULT_TIME_ZONE = "Asia/Shanghai";

  const state = {
    board: null,
    childFilter: "all",
    activeView: "today",
    timeZone: DEFAULT_TIME_ZONE,
    loading: false,
    statusTimer: null,
  };

  const elements = {
    title: document.querySelector("#board-title"),
    lastUpdated: document.querySelector("#last-updated"),
    refreshButton: document.querySelector("#refresh-button"),
    refreshLabel: document.querySelector("#refresh-button span"),
    appStatus: document.querySelector("#app-status"),
    pageShell: document.querySelector("#main-content"),
    tabs: Array.from(document.querySelectorAll("[role='tab'][data-view]")),
    panels: Array.from(document.querySelectorAll("[role='tabpanel'][data-panel]")),
    filterButtons: Array.from(document.querySelectorAll("[data-child-filter]")),
    todayMonth: document.querySelector("#today-month"),
    todayDate: document.querySelector("#today-date"),
    todayWeekday: document.querySelector("#today-weekday"),
    todaySummary: document.querySelector("#today-summary"),
    todaySchedules: document.querySelector("#today-schedules"),
    overdueTasks: document.querySelector("#overdue-tasks"),
    overdueCount: document.querySelector("#overdue-count"),
    todayDueTasks: document.querySelector("#today-due-tasks"),
    todayDueCount: document.querySelector("#today-due-count"),
    upcomingTasks: document.querySelector("#upcoming-tasks"),
    upcomingCount: document.querySelector("#upcoming-count"),
    weekSchedule: document.querySelector("#week-schedule"),
    tasksList: document.querySelector("#tasks-list"),
  };

  function createElement(tagName, className, text) {
    const node = document.createElement(tagName);
    if (className) {
      node.className = className;
    }
    if (text !== undefined && text !== null) {
      node.textContent = String(text);
    }
    return node;
  }

  function safeText(value, fallback = "") {
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
  }

  function setStatus(message, type = "") {
    window.clearTimeout(state.statusTimer);
    state.statusTimer = null;
    elements.appStatus.className = "app-status";

    if (!message) {
      elements.appStatus.textContent = "";
      elements.appStatus.hidden = true;
      return;
    }

    elements.appStatus.textContent = message;
    if (type) {
      elements.appStatus.classList.add(`app-status--${type}`);
    }
    elements.appStatus.hidden = false;
  }

  function announceTemporary(message) {
    setStatus(message, "success");
    state.statusTimer = window.setTimeout(() => setStatus(""), 3500);
  }

  function resolveTimeZone(value) {
    const candidate = safeText(value, DEFAULT_TIME_ZONE);
    try {
      new Intl.DateTimeFormat("zh-CN", { timeZone: candidate }).format(new Date());
      return candidate;
    } catch {
      return DEFAULT_TIME_ZONE;
    }
  }

  function getZonedNow() {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: state.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const dateKey = `${values.year}-${values.month}-${values.day}`;
    const weekdayNumber = new Date(`${dateKey}T00:00:00Z`).getUTCDay() || 7;

    return {
      date: now,
      dateKey,
      year: Number(values.year),
      month: Number(values.month),
      day: Number(values.day),
      weekdayNumber,
      minutes: (Number(values.hour) % 24) * 60 + Number(values.minute),
    };
  }

  function minutesFromTime(value) {
    const match = /^(\d{2}):(\d{2})$/.exec(String(value));
    if (!match) {
      return Number.POSITIVE_INFINITY;
    }
    return Number(match[1]) * 60 + Number(match[2]);
  }

  function formatDateKey(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
    if (!match) {
      return safeText(value, "未注明");
    }

    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "UTC",
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "short",
    }).format(date);
  }

  function formatTimestamp(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "未注明";
    }
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: state.timeZone,
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(date);
  }

  function getChildName(childId) {
    const child = state.board?.children.find((item) => item && item.id === childId);
    return safeText(child?.name, CHILD_FALLBACKS[childId] || RELATED_FALLBACKS[childId] || "未知成员");
  }

  function getRelatedName(relatedTo) {
    if (relatedTo === "family") {
      return "全家";
    }
    return getChildName(relatedTo);
  }

  function normaliseBoard(data) {
    if (!data || typeof data !== "object") {
      throw new Error("日程数据不是有效对象");
    }
    if (!data.meta || typeof data.meta !== "object") {
      throw new Error("日程数据缺少 meta");
    }
    if (!Array.isArray(data.children) || !Array.isArray(data.schedule) || !Array.isArray(data.tasks)) {
      throw new Error("日程数据缺少 children、schedule 或 tasks 列表");
    }

    return {
      meta: data.meta,
      children: data.children,
      schedule: data.schedule,
      tasks: data.tasks,
    };
  }

  function compareSchedule(left, right) {
    return String(left.startTime).localeCompare(String(right.startTime), "en") ||
      String(left.endTime).localeCompare(String(right.endTime), "en") ||
      String(left.title).localeCompare(String(right.title), "zh-CN");
  }

  function compareOpenTasks(left, right) {
    return String(left.dueDate).localeCompare(String(right.dueDate), "en") ||
      String(left.title).localeCompare(String(right.title), "zh-CN");
  }

  function compareCompletedTasks(left, right) {
    return String(right.dueDate).localeCompare(String(left.dueDate), "en") ||
      String(left.title).localeCompare(String(right.title), "zh-CN");
  }

  function updateDateHeader() {
    const now = getZonedNow();
    elements.todayMonth.textContent = `${now.year}年${now.month}月`;
    elements.todayDate.textContent = String(now.day).padStart(2, "0");
    elements.todayWeekday.textContent = WEEKDAYS[now.weekdayNumber - 1];
  }

  function makeEmpty(message, compact = false) {
    return createElement("div", compact ? "empty-state--compact" : "empty-state", message);
  }

  function makeError(message, compact = false) {
    return createElement("div", compact ? "empty-state--compact" : "error-state", message);
  }

  function appendCourseDetails(container, course, prefix) {
    const location = safeText(course.location);
    const note = safeText(course.note);

    if (location) {
      container.append(createElement("p", `${prefix}__meta`, `地点：${location}`));
    }
    if (note) {
      container.append(createElement("p", `${prefix}__note`, `备注：${note}`));
    }
  }

  function renderChildToday(childId, courses, nowMinutes) {
    const card = createElement("article", `child-card child-card--${childId}`);
    const header = createElement("header", "child-card__header");
    const name = createElement("h4", "child-card__name");
    name.append(createElement("span", "child-card__marker"), document.createTextNode(getChildName(childId)));
    header.append(name, createElement("span", "child-card__count", `${courses.length} 节课`));

    const current = courses.find((course) => {
      const start = minutesFromTime(course.startTime);
      const end = minutesFromTime(course.endTime);
      return start <= nowMinutes && nowMinutes < end;
    });
    const next = current ? null : courses.find((course) => minutesFromTime(course.startTime) > nowMinutes);
    const focus = createElement("div", "lesson-focus");
    let focusLabel = "今日状态";
    let focusValue = "今天没有安排课程";

    if (current) {
      focus.classList.add("lesson-focus--current");
      focusLabel = "正在上课";
      focusValue = `${current.startTime}–${current.endTime} · ${safeText(current.title, "未命名课程")}`;
    } else if (next) {
      focus.classList.add("lesson-focus--next");
      focusLabel = "下一节";
      focusValue = `${next.startTime}–${next.endTime} · ${safeText(next.title, "未命名课程")}`;
    } else if (courses.length > 0) {
      focus.classList.add("lesson-focus--done");
      focusLabel = "今日状态";
      focusValue = "今天的课程已经结束";
    } else {
      focus.classList.add("lesson-focus--empty");
    }
    focus.append(
      createElement("span", "lesson-focus__label", focusLabel),
      createElement("span", "lesson-focus__value", focusValue),
    );

    card.append(header, focus);

    if (courses.length === 0) {
      card.append(makeEmpty("今天没有安排课程。", true));
      return card;
    }

    const list = createElement("ol", "course-list");
    courses.forEach((course) => {
      const item = createElement("li", "course-row");
      if (course === current) {
        item.classList.add("course-row--current");
      } else if (course === next) {
        item.classList.add("course-row--next");
      }
      item.append(createElement("time", "course-row__time", `${course.startTime}–${course.endTime}`));
      const body = createElement("div", "course-row__body");
      body.append(createElement("h5", "course-row__title", safeText(course.title, "未命名课程")));
      appendCourseDetails(body, course, "course-row");
      item.append(body);
      list.append(item);
    });
    card.append(list);
    return card;
  }

  function renderTodaySchedules() {
    const now = getZonedNow();
    const todaysCourses = state.board.schedule
      .filter((course) => course && Number(course.weekday) === now.weekdayNumber)
      .sort(compareSchedule);

    elements.todaySchedules.replaceChildren(
      ...CHILD_IDS.map((childId) => renderChildToday(
        childId,
        todaysCourses.filter((course) => course.childId === childId),
        now.minutes,
      )),
    );

    const openDueTasks = state.board.tasks.filter((task) => task && task.status !== "completed" && String(task.dueDate) <= now.dateKey);
    if (todaysCourses.length === 0 && openDueTasks.length === 0) {
      elements.todaySummary.textContent = "今天没有课程，也没有已到期的待办事项。";
    } else {
      elements.todaySummary.textContent = `今天共有 ${todaysCourses.length} 节课，${openDueTasks.length} 项已到或超过截止日期的事项。`;
    }
  }

  function updateCount(element, count) {
    element.textContent = String(count);
    element.setAttribute("aria-label", `${count} 项`);
  }

  function renderCompactTasks(container, tasks, emptyMessage, options = {}) {
    if (tasks.length === 0) {
      container.replaceChildren(makeEmpty(emptyMessage, true));
      return;
    }

    const shownTasks = Number.isInteger(options.limit) ? tasks.slice(0, options.limit) : tasks;
    const rows = shownTasks.map((task) => {
      const row = createElement("article", "compact-task");
      const title = createElement("p", "compact-task__title", safeText(task.title, "未命名事项"));
      if (options.overdue) {
        title.append(document.createTextNode(" "), createElement("span", "overdue-flag", "已超期"));
      }
      const meta = createElement("p", "compact-task__meta");
      meta.append(
        createElement("span", "", getRelatedName(task.relatedTo)),
        createElement("span", "", formatDateKey(task.dueDate)),
        createElement("span", "", STATUS_LABELS[task.status] || "状态未知"),
      );
      row.append(title, meta);
      return row;
    });

    if (shownTasks.length < tasks.length) {
      rows.push(createElement("p", "loading-row", `另有 ${tasks.length - shownTasks.length} 项，可在“近期事项”中查看。`));
    }
    container.replaceChildren(...rows);
  }

  function renderDeadlineSummary() {
    const now = getZonedNow();
    const openTasks = state.board.tasks
      .filter((task) => task && task.status !== "completed")
      .sort(compareOpenTasks);
    const overdue = openTasks.filter((task) => String(task.dueDate) < now.dateKey);
    const dueToday = openTasks.filter((task) => String(task.dueDate) === now.dateKey);
    const upcoming = openTasks.filter((task) => String(task.dueDate) > now.dateKey);

    updateCount(elements.overdueCount, overdue.length);
    updateCount(elements.todayDueCount, dueToday.length);
    updateCount(elements.upcomingCount, upcoming.length);
    renderCompactTasks(elements.overdueTasks, overdue, "没有已超期事项。", { overdue: true });
    renderCompactTasks(elements.todayDueTasks, dueToday, "今天没有截止事项。");
    renderCompactTasks(elements.upcomingTasks, upcoming, "目前没有即将截止的事项。", { limit: 3 });
  }

  function renderToday() {
    updateDateHeader();
    renderTodaySchedules();
    renderDeadlineSummary();
  }

  function renderWeekCourse(course) {
    const childId = CHILD_IDS.includes(course.childId) ? course.childId : "";
    const card = createElement("article", `week-course${childId ? ` week-course--${childId}` : ""}`);
    card.append(
      createElement("time", "week-course__time", `${course.startTime}–${course.endTime}`),
      createElement("h4", "week-course__title", safeText(course.title, "未命名课程")),
      createElement("span", "week-course__person", getChildName(course.childId)),
    );
    appendCourseDetails(card, course, "week-course");
    return card;
  }

  function renderWeek() {
    const todayWeekday = getZonedNow().weekdayNumber;
    const schedule = state.board.schedule
      .filter((course) => course && (state.childFilter === "all" || course.childId === state.childFilter))
      .sort(compareSchedule);

    const dayColumns = WEEKDAYS.map((weekdayName, index) => {
      const weekdayNumber = index + 1;
      const column = createElement("section", "day-column");
      if (weekdayNumber === todayWeekday) {
        column.classList.add("day-column--today");
      }
      const heading = createElement("header", "day-column__heading");
      heading.append(createElement("h3", "", weekdayName));
      if (weekdayNumber === todayWeekday) {
        heading.append(createElement("span", "", "今天"));
      }
      const courses = schedule.filter((course) => Number(course.weekday) === weekdayNumber);
      const courseList = createElement("div", "day-column__courses");
      if (courses.length === 0) {
        courseList.append(createElement("p", "week-day-empty", "当天没有课程。"));
      } else {
        courseList.append(...courses.map(renderWeekCourse));
      }
      column.append(heading, courseList);
      return column;
    });

    elements.weekSchedule.replaceChildren(...dayColumns);
  }

  function makeFact(label, valueNodeOrText) {
    const fact = createElement("div", "fact");
    fact.append(createElement("span", "fact__label", label));
    if (valueNodeOrText instanceof Node) {
      fact.append(valueNodeOrText);
    } else {
      fact.append(createElement("span", "fact__value", valueNodeOrText));
    }
    return fact;
  }

  function renderTaskCard(task, todayKey) {
    const completed = task.status === "completed";
    const overdue = !completed && String(task.dueDate) < todayKey;
    const card = createElement("article", "task-card");
    if (completed) {
      card.classList.add("task-card--completed");
    }
    if (overdue) {
      card.classList.add("task-card--overdue");
    }

    const main = createElement("div", "task-card__main");
    const titleRow = createElement("div", "task-card__title-row");
    titleRow.append(createElement("h3", "task-card__title", safeText(task.title, "未命名事项")));
    if (overdue) {
      titleRow.append(createElement("span", "overdue-flag", "已超期"));
    }
    main.append(titleRow, createElement("p", "task-card__note", safeText(task.note, "暂无备注")));

    const facts = createElement("div", "task-card__facts");
    const relatedKey = ["xiaoyue", "xiaoyi", "family"].includes(task.relatedTo) ? task.relatedTo : "family";
    const related = createElement("span", `related-chip related-chip--${relatedKey}`, getRelatedName(task.relatedTo));
    const statusKey = Object.hasOwn(STATUS_LABELS, task.status) ? task.status.replaceAll("_", "-") : "not-started";
    const status = createElement("span", `status-chip status-chip--${statusKey}`, STATUS_LABELS[task.status] || "状态未知");
    facts.append(
      makeFact("与谁有关", related),
      makeFact("截止日期", formatDateKey(task.dueDate)),
      makeFact("当前状态", status),
    );

    card.append(main, facts);
    return card;
  }

  function renderTasks() {
    const todayKey = getZonedNow().dateKey;
    const openTasks = state.board.tasks
      .filter((task) => task && task.status !== "completed")
      .sort(compareOpenTasks);
    const completedTasks = state.board.tasks
      .filter((task) => task && task.status === "completed")
      .sort(compareCompletedTasks);
    const tasks = [...openTasks, ...completedTasks];

    if (tasks.length === 0) {
      elements.tasksList.replaceChildren(makeEmpty("目前没有近期事项。"));
      return;
    }
    elements.tasksList.replaceChildren(...tasks.map((task) => renderTaskCard(task, todayKey)));
  }

  function renderMeta() {
    const title = safeText(state.board.meta.title, "黄家日程板");
    const lastUpdatedValue = safeText(state.board.meta.lastUpdated);
    elements.title.textContent = title;
    document.title = title;
    elements.lastUpdated.textContent = formatTimestamp(lastUpdatedValue);
    if (lastUpdatedValue) {
      elements.lastUpdated.setAttribute("datetime", lastUpdatedValue);
    } else {
      elements.lastUpdated.removeAttribute("datetime");
    }
  }

  function renderAll() {
    renderMeta();
    renderToday();
    renderWeek();
    renderTasks();
  }

  function renderLoadError() {
    elements.lastUpdated.textContent = "未能读取";
    elements.lastUpdated.removeAttribute("datetime");
    elements.todaySummary.textContent = "日程数据暂时无法显示。";
    elements.todaySchedules.replaceChildren(makeError("未能读取课程数据，请稍后点击“刷新”重试。"));
    updateCount(elements.overdueCount, 0);
    updateCount(elements.todayDueCount, 0);
    updateCount(elements.upcomingCount, 0);
    elements.overdueTasks.replaceChildren(makeError("数据未能读取。", true));
    elements.todayDueTasks.replaceChildren(makeError("数据未能读取。", true));
    elements.upcomingTasks.replaceChildren(makeError("数据未能读取。", true));
    elements.weekSchedule.replaceChildren(makeError("未能读取本周课表，请稍后刷新。"));
    elements.tasksList.replaceChildren(makeError("未能读取近期事项，请稍后刷新。"));
  }

  async function loadBoard({ fromRefresh = false } = {}) {
    if (state.loading) {
      return;
    }

    state.loading = true;
    elements.refreshButton.disabled = true;
    elements.refreshButton.setAttribute("aria-busy", "true");
    elements.refreshLabel.textContent = "刷新中…";
    elements.pageShell.setAttribute("aria-busy", "true");
    setStatus(fromRefresh ? "正在重新读取日程数据…" : "正在读取日程数据…");

    try {
      const response = await fetch(`./data/board.json?t=${Date.now()}`, {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`读取日程数据失败（HTTP ${response.status}）`);
      }

      const board = normaliseBoard(await response.json());
      state.board = board;
      state.timeZone = resolveTimeZone(board.meta.timezone);
      renderAll();
      if (fromRefresh) {
        announceTemporary("日程已刷新。见到的内容就是当前数据文件中的内容。");
      } else {
        setStatus("");
      }
    } catch (error) {
      console.error("Family Board data load failed:", error);
      if (!state.board) {
        renderLoadError();
      }
      setStatus("未能读取日程数据。请检查网络后点击“刷新”重试。", "error");
    } finally {
      state.loading = false;
      elements.refreshButton.disabled = false;
      elements.refreshButton.removeAttribute("aria-busy");
      elements.refreshLabel.textContent = "刷新";
      elements.pageShell.removeAttribute("aria-busy");
    }
  }

  function activateView(viewName) {
    if (!elements.tabs.some((tab) => tab.dataset.view === viewName)) {
      return;
    }
    state.activeView = viewName;
    elements.tabs.forEach((tab) => {
      const selected = tab.dataset.view === viewName;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    elements.panels.forEach((panel) => {
      panel.hidden = panel.dataset.panel !== viewName;
    });
  }

  function bindTabs() {
    elements.tabs.forEach((tab, index) => {
      tab.addEventListener("click", () => activateView(tab.dataset.view));
      tab.addEventListener("keydown", (event) => {
        let nextIndex = null;
        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
          nextIndex = (index + 1) % elements.tabs.length;
        } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
          nextIndex = (index - 1 + elements.tabs.length) % elements.tabs.length;
        } else if (event.key === "Home") {
          nextIndex = 0;
        } else if (event.key === "End") {
          nextIndex = elements.tabs.length - 1;
        }

        if (nextIndex !== null) {
          event.preventDefault();
          const nextTab = elements.tabs[nextIndex];
          activateView(nextTab.dataset.view);
          nextTab.focus();
        }
      });
    });
  }

  function bindFilters() {
    elements.filterButtons.forEach((button) => {
      button.addEventListener("click", () => {
        state.childFilter = button.dataset.childFilter;
        elements.filterButtons.forEach((candidate) => {
          candidate.setAttribute("aria-pressed", String(candidate === button));
        });
        if (state.board) {
          renderWeek();
        }
      });
    });
  }

  function init() {
    bindTabs();
    bindFilters();
    elements.refreshButton.addEventListener("click", () => loadBoard({ fromRefresh: true }));
    updateDateHeader();
    loadBoard();

    window.setInterval(() => {
      updateDateHeader();
      if (state.board) {
        renderToday();
        renderWeek();
        renderTasks();
      }
    }, 60_000);
  }

  init();
})();
