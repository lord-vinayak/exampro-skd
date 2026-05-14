// exampro/public/js/mobile-proctor.js
'use strict';

(function () {
  const TOKEN = window.MOBILE_TOKEN || '';
  const API_BASE = '/api/method/exampro.exam_pro.api.mobile_proctor';
  const FRAME_INTERVAL_MS = 1000;
  const JPEG_QUALITY = 0.6;
  const MAX_CONSECUTIVE_ERRORS = 3;

  const videoEl = document.getElementById('mobile-video');
  const canvasEl = document.getElementById('mobile-canvas');
  const statusBadge = document.getElementById('status-badge');
  const examTitleEl = document.getElementById('exam-title');
  const errorBox = document.getElementById('error-box');
  const wakeLockWarning = document.getElementById('wakelock-warning');

  let wakeLock = null;
  let frameInterval = null;
  let consecutiveErrors = 0;

  function setStatus(text, colour) {
    statusBadge.innerHTML =
      `<span class="badge bg-${colour}" style="font-size:1rem;padding:0.5rem 1rem;">${text}</span>`;
  }

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.style.display = '';
    setStatus('❌ Error', 'danger');
  }

  async function callApi(method, params) {
    const url = `${API_BASE}.${method}`;
    const body = new URLSearchParams(params);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Frappe-CSRF-Token': 'Guest' },
      body,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return json.message;
  }

  async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) {
      wakeLockWarning.style.display = '';
      return;
    }
    try {
      wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) {
      wakeLockWarning.style.display = '';
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') acquireWakeLock();
  });

  async function startCamera() {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    videoEl.srcObject = stream;
    await new Promise((res) => { videoEl.onloadedmetadata = res; });
    canvasEl.width = videoEl.videoWidth;
    canvasEl.height = videoEl.videoHeight;
  }

  function captureJpeg() {
    const ctx = canvasEl.getContext('2d');
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(videoEl, -canvasEl.width, 0, canvasEl.width, canvasEl.height);
    ctx.restore();
    return canvasEl.toDataURL('image/jpeg', JPEG_QUALITY);
  }

  async function sendFrame() {
    try {
      const frameData = captureJpeg();
      const result = await callApi('receive_frame', { token: TOKEN, frame_data: frameData });

      consecutiveErrors = 0;
      setStatus('🟢 Connected — streaming to proctor', 'success');

      if (result && result.status === 'exam_ended') {
        clearInterval(frameInterval);
        setStatus('✅ Exam ended', 'secondary');
        errorBox.textContent = 'The exam has ended. You may close this page.';
        errorBox.style.display = '';
      }
    } catch (e) {
      consecutiveErrors++;
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        setStatus('🔴 Connection lost — retrying...', 'danger');
      }
    }
  }

  async function init() {
    if (!TOKEN) {
      showError('No session token found. Please scan the QR code again.');
      return;
    }

    setStatus('⏳ Validating session...', 'secondary');

    try {
      const info = await callApi('validate_mobile_token', { token: TOKEN });
      examTitleEl.textContent = info.exam_title || '';
    } catch (e) {
      showError('Invalid or expired session token. Please scan the QR code again.');
      return;
    }

    setStatus('⏳ Requesting camera access...', 'secondary');

    try {
      await startCamera();
    } catch (e) {
      showError(
        'Camera access denied. Please allow camera access in your browser settings and reload this page.'
      );
      return;
    }

    await acquireWakeLock();

    setStatus('🟢 Connected — streaming to proctor', 'success');
    frameInterval = setInterval(sendFrame, FRAME_INTERVAL_MS);
  }

  init();
})();
