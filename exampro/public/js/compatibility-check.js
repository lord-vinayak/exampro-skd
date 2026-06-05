// Pre-exam system compatibility check.
// Runs on window load when exam status is "Registered".
// Sets global mediaPermissionsGranted + mediaStream consumed by exam-index.js / examform.js.

(function () {
    if (typeof exam === "undefined" || exam.submission_status !== "Registered") return;

    // ── check results store ────────────────────────────────────────────────────
    const results = {};

    // ── blocking check names (webcam/mic conditionally added below) ────────────
    const blockingChecks = new Set();

    if (exam.enable_video_proctoring) {
        blockingChecks.add("webcam");
        blockingChecks.add("microphone");
    } else if (exam.enable_audio_monitoring) {
        blockingChecks.add("microphone");
    }

    // ── check definitions ──────────────────────────────────────────────────────
    // Each entry: { label, icon, run: async fn → {passed, message, detail?} }
    function buildChecks() {
        const checks = [];

        if (exam.enable_video_proctoring || exam.enable_audio_monitoring) {
            if (exam.enable_video_proctoring) {
                checks.push({
                    name: "webcam",
                    label: "Webcam",
                    icon: "bi-camera-video",
                    run: runWebcamCheck,
                });
            }
            checks.push({
                name: "microphone",
                label: "Microphone",
                icon: "bi-mic",
                run: runMicrophoneCheck,
            });
        }

        checks.push({ name: "browser",     label: "Browser Version", icon: "bi-browser-chrome", run: runBrowserCheck });
        checks.push({ name: "os",          label: "Operating System", icon: "bi-pc-display",     run: runOSCheck });
        checks.push({ name: "javascript",  label: "JavaScript",       icon: "bi-code-slash",     run: runJSCheck });
        checks.push({ name: "cookies",     label: "Cookies",          icon: "bi-cookie",         run: runCookiesCheck });
        checks.push({ name: "bandwidth",   label: "Network Speed",    icon: "bi-wifi",           run: runBandwidthCheck });

        return checks;
    }

    // ── individual check implementations ──────────────────────────────────────

    async function runWebcamCheck() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            return { passed: false, message: "Not supported in this browser" };
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            // Hand stream + flag to examform.js globals
            window.mediaPermissionsGranted = true;
            window.mediaStream = stream;

            // Feed to webcam video element if present
            const videoEl = document.getElementById("webcam-stream");
            if (videoEl) videoEl.srcObject = stream;

            return { passed: true, message: "Available" };
        } catch (e) {
            window.mediaPermissionsGranted = false;
            const msg = e.name === "NotAllowedError"
                ? "Permission denied — click Allow when prompted"
                : e.name === "NotFoundError"
                ? "No camera found"
                : "Could not access camera";
            return { passed: false, message: msg };
        }
    }

    async function runMicrophoneCheck() {
        // If webcam check already granted both (video+audio together), reuse result
        if (window.mediaPermissionsGranted && window.mediaStream) {
            const hasAudio = window.mediaStream.getAudioTracks().length > 0;
            return { passed: hasAudio, message: hasAudio ? "Available" : "No microphone found" };
        }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            return { passed: false, message: "Not supported in this browser" };
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach(t => t.stop());
            return { passed: true, message: "Available" };
        } catch (e) {
            const msg = e.name === "NotAllowedError"
                ? "Permission denied — click Allow when prompted"
                : e.name === "NotFoundError"
                ? "No microphone found"
                : "Could not access microphone";
            return { passed: false, message: msg };
        }
    }

    function runBrowserCheck() {
        const ua = navigator.userAgent;
        const browsers = [
            { name: "Edge",    re: /Edg\/(\d+)/,                 min: 90 },
            { name: "Chrome",  re: /Chrome\/(\d+)/,              min: 90 },
            { name: "Firefox", re: /Firefox\/(\d+)/,             min: 88 },
            { name: "Safari",  re: /Version\/(\d+).*Safari/,     min: 14 },
        ];
        for (const b of browsers) {
            const m = ua.match(b.re);
            if (m) {
                const v = parseInt(m[1]);
                const passed = v >= b.min;
                return {
                    passed,
                    message: passed
                        ? `${b.name} ${v} (supported)`
                        : `${b.name} ${v} — update to ${b.name} ${b.min}+`,
                };
            }
        }
        return { passed: false, message: "Unrecognised browser — use Chrome, Firefox, Edge, or Safari" };
    }

    function runOSCheck() {
        const ua = navigator.userAgent;
        let os = "Unknown";
        if (/Windows NT 10/.test(ua))       os = "Windows 10/11";
        else if (/Windows NT/.test(ua))     os = "Windows";
        else if (/Mac OS X/.test(ua))       os = "macOS";
        else if (/Android/.test(ua))        os = "Android";
        else if (/iPhone|iPad/.test(ua))    os = "iOS";
        else if (/Linux/.test(ua))          os = "Linux";
        // OS is always informational — never blocks
        return { passed: true, message: os };
    }

    function runJSCheck() {
        // If this code runs, JS is enabled
        return { passed: true, message: "Enabled" };
    }

    function runCookiesCheck() {
        const enabled = navigator.cookieEnabled;
        return { passed: enabled, message: enabled ? "Enabled" : "Disabled — enable cookies in browser settings" };
    }

    async function runBandwidthCheck() {
        const MIN_KBPS = 250;
        try {
            const url = `/assets/exampro/js/examform.js?_=${Date.now()}`;
            const t0 = performance.now();
            const resp = await fetch(url, { cache: "no-store" });
            if (!resp.ok) throw new Error("fetch failed");
            const blob = await resp.blob();
            const ms = performance.now() - t0;
            const kbps = Math.round((blob.size * 8) / ms);
            const passed = kbps >= MIN_KBPS;
            return {
                passed,
                message: passed
                    ? `${kbps} kbps (OK)`
                    : `${kbps} kbps — below ${MIN_KBPS} kbps minimum`,
            };
        } catch {
            return { passed: false, message: "Could not measure — check your connection" };
        }
    }

    // ── UI rendering ───────────────────────────────────────────────────────────

    function renderRow(check) {
        return `
<div class="compat-row d-flex align-items-center py-2 border-bottom" id="compat-row-${check.name}">
  <span class="compat-icon me-3" style="min-width:28px; font-size:1.1rem;">
    <span class="spinner-border spinner-border-sm text-secondary" role="status"></span>
  </span>
  <span class="me-2" style="min-width:28px; font-size:1rem; color:#6c757d;">
    <i class="bi ${check.icon}"></i>
  </span>
  <span class="flex-grow-1 fw-semibold" style="font-size:0.93rem;">${check.label}</span>
  <span class="compat-message text-muted me-3" style="font-size:0.85rem;"></span>
  <span class="compat-retry-wrap"></span>
</div>`;
    }

    function updateRow(name, result, isBlocking) {
        const row = document.getElementById(`compat-row-${name}`);
        if (!row) return;

        const iconEl = row.querySelector(".compat-icon");
        const msgEl  = row.querySelector(".compat-message");
        const retryWrap = row.querySelector(".compat-retry-wrap");

        if (result.passed) {
            iconEl.innerHTML = `<i class="bi bi-check-circle-fill text-success" style="font-size:1.1rem;"></i>`;
            msgEl.textContent = result.message;
            msgEl.className = "compat-message text-success me-3";
            retryWrap.innerHTML = "";
        } else if (isBlocking) {
            iconEl.innerHTML = `<i class="bi bi-x-circle-fill text-danger" style="font-size:1.1rem;"></i>`;
            msgEl.textContent = result.message;
            msgEl.className = "compat-message text-danger me-3";
            retryWrap.innerHTML = `
<button class="btn btn-sm btn-outline-danger compat-retry-btn"
  onclick="window._compatRetry('${name}')" style="font-size:0.78rem; padding:2px 8px;">
  Try Again
</button>`;
        } else {
            iconEl.innerHTML = `<i class="bi bi-exclamation-circle-fill text-warning" style="font-size:1.1rem;"></i>`;
            msgEl.textContent = result.message;
            msgEl.className = "compat-message text-warning me-3";
            retryWrap.innerHTML = `
<button class="btn btn-sm btn-outline-warning compat-retry-btn"
  onclick="window._compatRetry('${name}')" style="font-size:0.78rem; padding:2px 8px;">
  Try Again
</button>`;
        }
    }

    function setOverallBadge(state) {
        const badge = document.getElementById("compat-overall-badge");
        if (!badge) return;
        if (state === "checking") {
            badge.className = "badge bg-secondary";
            badge.textContent = "Checking…";
        } else if (state === "ready") {
            badge.className = "badge bg-success";
            badge.textContent = "Ready";
        } else {
            badge.className = "badge bg-danger";
            badge.textContent = "Action Required";
        }
    }

    // ── blocking gate ──────────────────────────────────────────────────────────

    function evaluateBlockingChecks() {
        if (blockingChecks.size === 0) {
            enableStartButton();
            return;
        }
        const allPassed = [...blockingChecks].every(n => results[n] && results[n].passed);
        if (allPassed) {
            enableStartButton();
            setOverallBadge("ready");
        } else {
            disableStartButton();
            setOverallBadge("error");
        }
    }

    function enableStartButton() {
        const btn = document.getElementById("quiz-btn");
        if (btn) btn.disabled = false;
    }

    function disableStartButton() {
        const btn = document.getElementById("quiz-btn");
        if (btn) btn.disabled = true;
    }

    // ── save results to backend ────────────────────────────────────────────────

    function saveCompatibilityLog() {
        if (!exam.exam_submission) return;
        const log = {
            timestamp: new Date().toISOString(),
            browser:   results.browser   || null,
            os:        results.os        || null,
            javascript: results.javascript || null,
            cookies:   results.cookies   || null,
            webcam:    results.webcam    || null,
            microphone: results.microphone || null,
            bandwidth_kbps: results.bandwidth ? parseInt((results.bandwidth.message || "0").match(/\d+/) || 0) : null,
            bandwidth_passed: results.bandwidth ? results.bandwidth.passed : null,
            all_blocking_passed: [...blockingChecks].every(n => results[n] && results[n].passed),
        };
        frappe.call({
            method: "exampro.exam_pro.doctype.exam_submission.exam_submission.save_compatibility_log",
            args: { exam_submission: exam.exam_submission, log: JSON.stringify(log) },
        });
    }

    // ── retry a single check ───────────────────────────────────────────────────

    window._compatRetry = async function (name) {
        const check = window._compatChecks.find(c => c.name === name);
        if (!check) return;

        const row = document.getElementById(`compat-row-${name}`);
        if (row) {
            row.querySelector(".compat-icon").innerHTML =
                `<span class="spinner-border spinner-border-sm text-secondary" role="status"></span>`;
            const retryWrap = row.querySelector(".compat-retry-wrap");
            if (retryWrap) retryWrap.innerHTML = "";
        }

        const result = await check.run();
        results[name] = result;
        updateRow(name, result, blockingChecks.has(name));
        evaluateBlockingChecks();

        // Re-save after retry
        saveCompatibilityLog();
    };

    // ── main entry point ───────────────────────────────────────────────────────

    async function runCompatibilityChecks() {
        const container = document.getElementById("compat-check-body");
        if (!container) return;

        const checks = buildChecks();
        window._compatChecks = checks;

        // Render all rows with spinners
        container.innerHTML = checks.map(renderRow).join("");
        setOverallBadge("checking");

        // Run all checks concurrently
        const promises = checks.map(async (check) => {
            const result = await check.run();
            results[check.name] = result;
            updateRow(check.name, result, blockingChecks.has(check.name));
        });

        await Promise.all(promises);

        evaluateBlockingChecks();

        // Set overall badge for non-blocking warnings
        const badge = document.getElementById("compat-overall-badge");
        if (badge && badge.textContent === "Checking…") {
            setOverallBadge("ready");
        }

        saveCompatibilityLog();
    }

    window.addEventListener("load", function () {
        runCompatibilityChecks();
    });
})();
