const MAX_POINTS = 60;
const WARNING_THRESHOLD = 70;
const DANGER_THRESHOLD = 85;
const ALERT_COOLDOWN_MS = 30000;
const DEFAULT_ALERT_THRESHOLD = 85;
const MAX_PROCESS_ROWS = 5;
const ALERT_SETTINGS_STORAGE_KEY = "system-pulse.alert-settings";
const ALERT_HISTORY_STORAGE_KEY = "system-pulse.alert-history";
const MAX_ALERT_HISTORY_ITEMS = 30;
const DEFAULT_HISTORY_MINUTES = 30;
const MAX_HISTORY_RANGE_MINUTES = 24 * 60;
const HISTORY_SUMMARY_REFRESH_MS = 30000;

const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const cpuCard = document.getElementById("cpu-card");
const memoryCard = document.getElementById("memory-card");
const cpuValue = document.getElementById("cpu-value");
const memoryValue = document.getElementById("memory-value");
const memoryFootprint = document.getElementById("memory-footprint");
const lastUpdate = document.getElementById("last-update");
const cpuMeter = document.getElementById("cpu-meter");
const memoryMeter = document.getElementById("memory-meter");
const cpuProcessBody = document.getElementById("cpu-process-body");
const memoryProcessBody = document.getElementById("memory-process-body");
const cpuThresholdInput = document.getElementById("cpu-alert-threshold");
const memoryThresholdInput = document.getElementById("memory-alert-threshold");
const soundToggle = document.getElementById("sound-enabled");
const browserNotifyToggle = document.getElementById("browser-notify-enabled");
const enableNotificationButton = document.getElementById("enable-notification");
const alertLog = document.getElementById("alert-log");
const historyRange = document.getElementById("history-range");
const refreshHistoryButton = document.getElementById("refresh-history");
const exportHistoryLink = document.getElementById("export-history");
const historySummary = document.getElementById("history-summary");
const alertHistoryList = document.getElementById("alert-history-list");

const labels = [];
const cpuSeries = [];
const memorySeries = [];

const alertConfig = {
  cpuThreshold: DEFAULT_ALERT_THRESHOLD,
  memoryThreshold: DEFAULT_ALERT_THRESHOLD,
  soundEnabled: true,
  browserNotifyEnabled: false,
};

const alertState = {
  cpuTriggered: false,
  memoryTriggered: false,
  lastCpuAlertAt: 0,
  lastMemoryAlertAt: 0,
};

const alertHistory = [];

const cpuChart = echarts.init(document.getElementById("cpu-chart"));
const memoryChart = echarts.init(document.getElementById("memory-chart"));

function toFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampPercent(value) {
  return Math.max(0, Math.min(toFiniteNumber(value), 100));
}

function parseThreshold(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(parsed, 100));
}

function parseMinutesRange(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(parsed, MAX_HISTORY_RANGE_MINUTES));
}

function readAlertConfigFromStorage() {
  try {
    const raw = window.localStorage.getItem(ALERT_SETTINGS_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);
    const canEnableBrowserNotify =
      Boolean(parsed.browserNotifyEnabled) &&
      "Notification" in window &&
      Notification.permission === "granted";

    return {
      cpuThreshold: parseThreshold(parsed.cpuThreshold, DEFAULT_ALERT_THRESHOLD),
      memoryThreshold: parseThreshold(parsed.memoryThreshold, DEFAULT_ALERT_THRESHOLD),
      soundEnabled: parsed.soundEnabled !== false,
      browserNotifyEnabled: canEnableBrowserNotify,
    };
  } catch {
    return null;
  }
}

function persistAlertConfig() {
  try {
    window.localStorage.setItem(
      ALERT_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        cpuThreshold: alertConfig.cpuThreshold,
        memoryThreshold: alertConfig.memoryThreshold,
        soundEnabled: alertConfig.soundEnabled,
        browserNotifyEnabled: alertConfig.browserNotifyEnabled,
      }),
    );
  } catch {
    return;
  }
}

function readAlertHistoryFromStorage() {
  try {
    const raw = window.localStorage.getItem(ALERT_HISTORY_STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter(
        (item) =>
          item &&
          typeof item.message === "string" &&
          typeof item.metricName === "string" &&
          Number.isFinite(Number(item.value)) &&
          Number.isFinite(Number(item.threshold)),
      )
      .slice(0, MAX_ALERT_HISTORY_ITEMS);
  } catch {
    return [];
  }
}

function persistAlertHistory() {
  try {
    window.localStorage.setItem(ALERT_HISTORY_STORAGE_KEY, JSON.stringify(alertHistory));
  } catch {
    return;
  }
}

function renderAlertHistory() {
  alertHistoryList.textContent = "";

  if (alertHistory.length === 0) {
    const placeholder = document.createElement("li");
    placeholder.className = "is-placeholder";
    placeholder.textContent = "暂无告警记录。";
    alertHistoryList.append(placeholder);
    return;
  }

  alertHistory.forEach((item) => {
    const row = document.createElement("li");
    row.textContent = item.message;
    alertHistoryList.append(row);
  });
}

function addAlertHistory(metricName, currentValue, threshold) {
  const now = new Date();
  const normalizedValue = toFiniteNumber(currentValue);
  const normalizedThreshold = toFiniteNumber(threshold);
  const message = `${now.toLocaleTimeString()} | ${metricName} 达到 ${normalizedValue.toFixed(1)}%（阈值 ${normalizedThreshold.toFixed(1)}%）`;

  alertHistory.unshift({
    ts: now.getTime(),
    metricName,
    value: normalizedValue,
    threshold: normalizedThreshold,
    message,
  });

  if (alertHistory.length > MAX_ALERT_HISTORY_ITEMS) {
    alertHistory.length = MAX_ALERT_HISTORY_ITEMS;
  }

  persistAlertHistory();
  renderAlertHistory();
  return message;
}

function updateHistoryExportLink(minutes) {
  exportHistoryLink.href = `/api/history/export?minutes=${minutes}`;
}

function formatTimeLabel(unixSeconds) {
  const value = toFiniteNumber(unixSeconds);
  if (!value) {
    return "--:--:--";
  }
  return new Date(value * 1000).toLocaleTimeString();
}

function summarizeHistoryStats(payload, minutes) {
  const sampleCount = toFiniteNumber(payload.sample_count, 0);
  if (sampleCount <= 0) {
    return `最近 ${minutes} 分钟暂无历史样本。`;
  }

  const cpuAvg = toFiniteNumber(payload.cpu_avg);
  const cpuMax = toFiniteNumber(payload.cpu_max);
  const memAvg = toFiniteNumber(payload.mem_avg);
  const memMax = toFiniteNumber(payload.mem_max);
  const earliest = formatTimeLabel(payload.earliest_ts);
  const latest = formatTimeLabel(payload.latest_ts);

  return `最近 ${minutes} 分钟样本 ${sampleCount} 条（${earliest} - ${latest}）；CPU 均值 ${cpuAvg.toFixed(1)}% / 峰值 ${cpuMax.toFixed(1)}%；内存均值 ${memAvg.toFixed(1)}% / 峰值 ${memMax.toFixed(1)}%。`;
}

async function loadHistorySummary(minutes) {
  updateHistoryExportLink(minutes);
  historySummary.textContent = "正在加载历史统计...";

  try {
    const response = await fetch(`/api/history/stats?minutes=${minutes}`);
    if (!response.ok) {
      historySummary.textContent = "历史统计加载失败，请稍后重试。";
      return;
    }

    const payload = await response.json();
    historySummary.textContent = summarizeHistoryStats(payload, minutes);
  } catch {
    historySummary.textContent = "历史统计加载失败，请稍后重试。";
  }
}

function initializeHistoryControls() {
  const savedAlertHistory = readAlertHistoryFromStorage();
  alertHistory.splice(0, alertHistory.length, ...savedAlertHistory);
  renderAlertHistory();

  let currentMinutes = parseMinutesRange(historyRange.value, DEFAULT_HISTORY_MINUTES);
  historyRange.value = String(currentMinutes);
  updateHistoryExportLink(currentMinutes);

  historyRange.addEventListener("change", () => {
    currentMinutes = parseMinutesRange(historyRange.value, DEFAULT_HISTORY_MINUTES);
    historyRange.value = String(currentMinutes);
    loadHistorySummary(currentMinutes);
  });

  refreshHistoryButton.addEventListener("click", () => {
    currentMinutes = parseMinutesRange(historyRange.value, DEFAULT_HISTORY_MINUTES);
    historyRange.value = String(currentMinutes);
    loadHistorySummary(currentMinutes);
  });

  window.setInterval(() => {
    if (document.visibilityState === "visible") {
      loadHistorySummary(currentMinutes);
    }
  }, HISTORY_SUMMARY_REFRESH_MS);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      loadHistorySummary(currentMinutes);
    }
  });

  loadHistorySummary(currentMinutes);
}

function getLineChartOption(seriesName, lineColor) {
  return {
    animationDuration: 260,
    grid: { left: 40, right: 14, top: 25, bottom: 28 },
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: labels,
      axisLine: { lineStyle: { color: "#6a7f8a" } },
      axisLabel: { color: "#49606d" },
    },
    yAxis: {
      type: "value",
      min: 0,
      max: 100,
      splitLine: { lineStyle: { color: "rgba(49, 82, 101, 0.15)" } },
      axisLabel: { color: "#49606d", formatter: "{value}%" },
    },
    tooltip: {
      trigger: "axis",
      valueFormatter: (value) => `${toFiniteNumber(value).toFixed(1)}%`,
    },
    series: [
      {
        name: seriesName,
        type: "line",
        smooth: true,
        showSymbol: false,
        data: [],
        lineStyle: { width: 3, color: lineColor },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: `${lineColor}99` },
            { offset: 1, color: `${lineColor}10` },
          ]),
        },
      },
    ],
  };
}

cpuChart.setOption(getLineChartOption("CPU", "#da6a2a"));
memoryChart.setOption(getLineChartOption("内存", "#25707a"));

function setConnectionState(label, stateClass) {
  statusText.textContent = label;
  statusDot.className = `status-dot ${stateClass}`;
}

function applyCardState(element, percent) {
  element.classList.remove("state-ok", "state-warn", "state-danger");
  if (percent >= DANGER_THRESHOLD) {
    element.classList.add("state-danger");
    return;
  }
  if (percent >= WARNING_THRESHOLD) {
    element.classList.add("state-warn");
    return;
  }
  element.classList.add("state-ok");
}

function pushSeries(label, cpuPercent, memPercent) {
  labels.push(label);
  cpuSeries.push(cpuPercent);
  memorySeries.push(memPercent);

  if (labels.length > MAX_POINTS) {
    labels.shift();
    cpuSeries.shift();
    memorySeries.shift();
  }
}

function renderCharts() {
  cpuChart.setOption({
    xAxis: { data: labels },
    series: [{ data: cpuSeries }],
  });
  memoryChart.setOption({
    xAxis: { data: labels },
    series: [{ data: memorySeries }],
  });
}

function formatProcessName(name, pid) {
  const normalizedName = String(name || "未知进程").trim() || "未知进程";
  return `${normalizedName} (${pid})`;
}

function setAlertMessage(message, isAlert = false) {
  alertLog.textContent = message;
  alertLog.classList.toggle("has-alert", isAlert);
}

function renderPlaceholder(tbody, message) {
  tbody.textContent = "";
  const row = document.createElement("tr");
  row.className = "is-placeholder";
  const cell = document.createElement("td");
  cell.colSpan = 4;
  cell.textContent = message;
  row.append(cell);
  tbody.append(row);
}

function renderCpuProcesses(processes) {
  if (!Array.isArray(processes) || processes.length === 0) {
    renderPlaceholder(cpuProcessBody, "暂无进程数据");
    return;
  }

  cpuProcessBody.textContent = "";
  processes.slice(0, MAX_PROCESS_ROWS).forEach((process, index) => {
    const row = document.createElement("tr");

    const rank = document.createElement("td");
    rank.textContent = String(index + 1);

    const name = document.createElement("td");
    name.className = "process-name";
    name.textContent = formatProcessName(process.name, toFiniteNumber(process.pid));

    const cpu = document.createElement("td");
    cpu.textContent = `${toFiniteNumber(process.cpu_percent).toFixed(1)}%`;

    const memory = document.createElement("td");
    memory.textContent = `${toFiniteNumber(process.memory_percent).toFixed(1)}%`;

    row.append(rank, name, cpu, memory);
    cpuProcessBody.append(row);
  });
}

function renderMemoryProcesses(processes) {
  if (!Array.isArray(processes) || processes.length === 0) {
    renderPlaceholder(memoryProcessBody, "暂无进程数据");
    return;
  }

  memoryProcessBody.textContent = "";
  processes.slice(0, MAX_PROCESS_ROWS).forEach((process, index) => {
    const row = document.createElement("tr");

    const rank = document.createElement("td");
    rank.textContent = String(index + 1);

    const name = document.createElement("td");
    name.className = "process-name";
    name.textContent = formatProcessName(process.name, toFiniteNumber(process.pid));

    const memory = document.createElement("td");
    memory.textContent = `${toFiniteNumber(process.memory_percent).toFixed(1)}%`;

    const rss = document.createElement("td");
    rss.textContent = `${toFiniteNumber(process.memory_mb).toFixed(1)} MB`;

    row.append(rank, name, memory, rss);
    memoryProcessBody.append(row);
  });
}

let audioContext;

function playAlertTone() {
  if (!alertConfig.soundEnabled) {
    return;
  }

  const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextConstructor) {
    return;
  }

  try {
    audioContext = audioContext || new AudioContextConstructor();
    if (audioContext.state === "suspended") {
      audioContext.resume().catch(() => undefined);
    }

    const start = audioContext.currentTime;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();

    oscillator.type = "triangle";
    oscillator.frequency.setValueAtTime(780, start);
    oscillator.frequency.exponentialRampToValueAtTime(540, start + 0.2);

    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.16, start + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.24);

    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.24);
  } catch {
    return;
  }
}

function sendBrowserNotification(title, body) {
  if (!alertConfig.browserNotifyEnabled) {
    return;
  }
  if (!("Notification" in window)) {
    setAlertMessage("当前浏览器不支持通知。");
    return;
  }
  if (Notification.permission === "granted") {
    new Notification(title, { body });
  }
}

function fireAlert(metricName, currentValue, threshold) {
  const message = addAlertHistory(metricName, currentValue, threshold);
  setAlertMessage(message, true);
  playAlertTone();
  sendBrowserNotification("系统脉搏告警", message);
}

function evaluateAlerts(cpuPercent, memoryPercent) {
  const now = Date.now();

  if (cpuPercent >= alertConfig.cpuThreshold) {
    const canAlertCpu =
      !alertState.cpuTriggered && now - alertState.lastCpuAlertAt >= ALERT_COOLDOWN_MS;
    if (canAlertCpu) {
      alertState.lastCpuAlertAt = now;
      alertState.cpuTriggered = true;
      fireAlert("CPU", cpuPercent, alertConfig.cpuThreshold);
    }
  } else {
    alertState.cpuTriggered = false;
  }

  if (memoryPercent >= alertConfig.memoryThreshold) {
    const canAlertMemory =
      !alertState.memoryTriggered && now - alertState.lastMemoryAlertAt >= ALERT_COOLDOWN_MS;
    if (canAlertMemory) {
      alertState.lastMemoryAlertAt = now;
      alertState.memoryTriggered = true;
      fireAlert("内存", memoryPercent, alertConfig.memoryThreshold);
    }
  } else {
    alertState.memoryTriggered = false;
  }
}

function updateDashboard(payload) {
  const cpuPercent = toFiniteNumber(payload.cpu_percent);
  const memPercent = toFiniteNumber(payload.mem_percent);
  const usedMemory = toFiniteNumber(payload.mem_used_gb);
  const totalMemory = toFiniteNumber(payload.mem_total_gb);

  cpuValue.textContent = `${cpuPercent.toFixed(1)}%`;
  memoryValue.textContent = `${memPercent.toFixed(1)}%`;
  memoryFootprint.textContent = `${usedMemory.toFixed(2)} / ${totalMemory.toFixed(2)} GB`;

  cpuMeter.style.width = `${clampPercent(cpuPercent)}%`;
  memoryMeter.style.width = `${clampPercent(memPercent)}%`;

  applyCardState(cpuCard, cpuPercent);
  applyCardState(memoryCard, memPercent);

  const timestamp = toFiniteNumber(payload.ts, Math.floor(Date.now() / 1000));
  const now = new Date(timestamp * 1000);
  const label = now.toLocaleTimeString([], { minute: "2-digit", second: "2-digit" });
  lastUpdate.textContent = now.toLocaleTimeString();

  pushSeries(label, cpuPercent, memPercent);
  renderCharts();

  renderCpuProcesses(payload.top_cpu_processes);
  renderMemoryProcesses(payload.top_memory_processes);

  evaluateAlerts(cpuPercent, memPercent);
}

async function requestNotificationPermission() {
  if (!("Notification" in window)) {
    setAlertMessage("当前浏览器不支持通知。");
    return;
  }

  const permission = await Notification.requestPermission();
  if (permission === "granted") {
    browserNotifyToggle.checked = true;
    alertConfig.browserNotifyEnabled = true;
    persistAlertConfig();
    setAlertMessage("浏览器通知权限已开启。");
    return;
  }

  browserNotifyToggle.checked = false;
  alertConfig.browserNotifyEnabled = false;
  persistAlertConfig();
  setAlertMessage("浏览器通知权限未开启。");
}

function initializeAlertControls() {
  const storedConfig = readAlertConfigFromStorage();
  if (storedConfig) {
    alertConfig.cpuThreshold = storedConfig.cpuThreshold;
    alertConfig.memoryThreshold = storedConfig.memoryThreshold;
    alertConfig.soundEnabled = storedConfig.soundEnabled;
    alertConfig.browserNotifyEnabled = storedConfig.browserNotifyEnabled;
  }

  cpuThresholdInput.value = String(alertConfig.cpuThreshold);
  memoryThresholdInput.value = String(alertConfig.memoryThreshold);
  soundToggle.checked = alertConfig.soundEnabled;
  browserNotifyToggle.checked = alertConfig.browserNotifyEnabled;

  cpuThresholdInput.addEventListener("change", () => {
    alertConfig.cpuThreshold = parseThreshold(cpuThresholdInput.value, alertConfig.cpuThreshold);
    cpuThresholdInput.value = String(alertConfig.cpuThreshold);
    persistAlertConfig();
    setAlertMessage(`CPU 告警阈值已设置为 ${alertConfig.cpuThreshold}%。`);
  });

  memoryThresholdInput.addEventListener("change", () => {
    alertConfig.memoryThreshold = parseThreshold(
      memoryThresholdInput.value,
      alertConfig.memoryThreshold,
    );
    memoryThresholdInput.value = String(alertConfig.memoryThreshold);
    persistAlertConfig();
    setAlertMessage(`内存告警阈值已设置为 ${alertConfig.memoryThreshold}%。`);
  });

  soundToggle.addEventListener("change", () => {
    alertConfig.soundEnabled = soundToggle.checked;
    persistAlertConfig();
    setAlertMessage(
      alertConfig.soundEnabled ? "声音告警已开启。" : "声音告警已关闭。",
    );
  });

  browserNotifyToggle.addEventListener("change", () => {
    alertConfig.browserNotifyEnabled = browserNotifyToggle.checked;
    if (
      alertConfig.browserNotifyEnabled &&
      "Notification" in window &&
      Notification.permission !== "granted"
    ) {
      browserNotifyToggle.checked = false;
      alertConfig.browserNotifyEnabled = false;
      persistAlertConfig();
      setAlertMessage("请先点击“开启通知权限”，再启用浏览器通知。", true);
      return;
    }
    persistAlertConfig();
    setAlertMessage(
      alertConfig.browserNotifyEnabled
        ? "浏览器通知已开启。"
        : "浏览器通知已关闭。",
    );
  });

  enableNotificationButton.addEventListener("click", requestNotificationPermission);

  if (!("Notification" in window)) {
    enableNotificationButton.disabled = true;
    browserNotifyToggle.disabled = true;
    browserNotifyToggle.checked = false;
    alertConfig.browserNotifyEnabled = false;
    persistAlertConfig();
  }
}

let socket;
let reconnectTimer;
let reconnectDelay = 1500;

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connectSocket();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
}

function connectSocket() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const socketUrl = `${protocol}://${window.location.host}/ws/metrics`;

  setConnectionState("连接中", "is-pending");
  socket = new WebSocket(socketUrl);

  socket.onopen = () => {
    reconnectDelay = 1500;
    setConnectionState("实时中", "is-online");
  };

  socket.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      updateDashboard(payload);
    } catch {
      setConnectionState("数据异常", "is-offline");
    }
  };

  socket.onerror = () => {
    socket.close();
  };

  socket.onclose = () => {
    setConnectionState("重连中", "is-pending");
    scheduleReconnect();
  };
}

async function loadInitialSnapshot() {
  try {
    const response = await fetch("/api/metrics");
    if (!response.ok) {
      return;
    }
    const payload = await response.json();
    updateDashboard(payload);
  } catch {
    return;
  }
}

window.addEventListener("pointerdown", () => {
  if (audioContext && audioContext.state === "suspended") {
    audioContext.resume().catch(() => undefined);
  }
});

window.addEventListener("resize", () => {
  cpuChart.resize();
  memoryChart.resize();
});

initializeAlertControls();
initializeHistoryControls();
loadInitialSnapshot().finally(() => {
  connectSocket();
});
