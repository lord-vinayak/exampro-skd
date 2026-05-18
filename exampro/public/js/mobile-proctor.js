// exampro/public/js/mobile-proctor.js
'use strict';

(function () {
  const TOKEN = window.MOBILE_TOKEN || '';
  const API_BASE = '/api/method/exampro.exam_pro.api.mobile_proctor';
  const FRAME_INTERVAL_MS = 10000;   // 1 frame every 10 seconds
  const JPEG_QUALITY = 0.7;
  const MAX_CONSECUTIVE_ERRORS = 5;

  const videoEl     = document.getElementById('mobile-video');
  const canvasEl    = document.getElementById('mobile-canvas');
  const statusBadge = document.getElementById('status-badge');
  const examTitleEl = document.getElementById('exam-title');
  const errorBox    = document.getElementById('error-box');
  const wakeLockWarning = document.getElementById('wakelock-warning');

  let wakeLock = null;
  let frameInterval = null;
  let consecutiveErrors = 0;
  let frameSeq = 0;

  // ---------------------------------------------------------------------------
  // Status helpers
  // ---------------------------------------------------------------------------

  function setStatus(text, colour) {
    statusBadge.innerHTML =
      `<span class="badge bg-${colour}" style="font-size:1rem;padding:0.5rem 1rem;">${text}</span>`;
  }

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.style.display = '';
    setStatus('❌ Error', 'danger');
  }

  // ---------------------------------------------------------------------------
  // API call helper
  // ---------------------------------------------------------------------------

  async function callApi(method, params) {
    const url = `${API_BASE}.${method}`;
    const body = new URLSearchParams(params);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Frappe-CSRF-Token': 'Guest',
      },
      body,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return json.message;
  }

  // ---------------------------------------------------------------------------
  // Wake lock
  // ---------------------------------------------------------------------------

  async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) {
      if (wakeLockWarning) wakeLockWarning.style.display = '';
      return;
    }
    try {
      wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) {
      if (wakeLockWarning) wakeLockWarning.style.display = '';
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') acquireWakeLock();
  });

  // ---------------------------------------------------------------------------
  // Camera
  // ---------------------------------------------------------------------------

  async function startCamera() {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    videoEl.srcObject = stream;
    await new Promise((res) => { videoEl.onloadedmetadata = res; });
    canvasEl.width  = videoEl.videoWidth;
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

  // ---------------------------------------------------------------------------
  // Frame sending
  // ---------------------------------------------------------------------------

  async function sendFrame() {
    try {
      const frameData = captureJpeg();
      frameSeq += 1;
      const result = await callApi('receive_frame', {
        token: TOKEN,
        frame_data: frameData,
        frame_seq: frameSeq,
      });

      consecutiveErrors = 0;
      setStatus('🟢 Connected — streaming to proctor', 'success');

      if (result && result.status === 'exam_ended') {
        clearInterval(frameInterval);
        setStatus('✅ Exam ended', 'secondary');
        if (errorBox) {
          errorBox.textContent = 'The exam has ended. You may close this page.';
          errorBox.style.display = '';
        }
      }
    } catch (e) {
      consecutiveErrors++;
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        setStatus('🔴 Connection lost — retrying...', 'danger');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Room scan (if required)
  // ---------------------------------------------------------------------------

  async function handleRoomScan() {
    const roomScanSection = document.getElementById('room-scan-section');
    if (!roomScanSection) return;   // not required for this exam

    return new Promise((resolve) => {
      const recordBtn  = document.getElementById('room-scan-record-btn');
      const uploadBtn  = document.getElementById('room-scan-upload-btn');
      const statusEl   = document.getElementById('room-scan-status');
      const previewEl  = document.getElementById('room-scan-preview');

      let mediaRecorder = null;
      let recordedChunks = [];
      let recordingTimeout = null;

      roomScanSection.style.display = '';

      recordBtn.addEventListener('click', async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
          previewEl.srcObject = stream;
          previewEl.style.display = '';

          recordedChunks = [];
          const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
            ? 'video/webm;codecs=vp9'
            : 'video/webm';
          mediaRecorder = new MediaRecorder(stream, { mimeType });

          mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) recordedChunks.push(e.data);
          };

          mediaRecorder.onstop = () => {
            stream.getTracks().forEach(t => t.stop());
            previewEl.style.display = 'none';
            uploadBtn.disabled = false;
            statusEl.textContent = '✅ Recording complete. Click Upload to submit.';
          };

          mediaRecorder.start(200);   // collect data every 200ms
          recordBtn.disabled = true;
          statusEl.textContent = '🔴 Recording... (15 seconds)';

          // Auto-stop after 15s
          recordingTimeout = setTimeout(() => {
            if (mediaRecorder && mediaRecorder.state !== 'inactive') {
              mediaRecorder.stop();
            }
          }, 15000);

        } catch (e) {
          statusEl.textContent = '❌ Camera access denied. Please allow camera access.';
        }
      });

      uploadBtn.addEventListener('click', async () => {
        if (!recordedChunks.length) return;
        uploadBtn.disabled = true;
        statusEl.textContent = '⏳ Uploading room scan...';

        try {
          const blob = new Blob(recordedChunks, { type: 'video/webm' });
          const formData = new FormData();
          formData.append('file', blob, 'room_scan.webm');
          formData.append('token', TOKEN);

          const res = await fetch(`${API_BASE}.upload_room_scan`, {
            method: 'POST',
            headers: { 'X-Frappe-CSRF-Token': 'Guest' },
            body: formData,
          });

          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          statusEl.textContent = '✅ Room scan uploaded successfully.';
          roomScanSection.style.display = 'none';
          resolve();   // proceed to camera streaming
        } catch (e) {
          statusEl.textContent = `❌ Upload failed: ${e.message}. Please try again.`;
          uploadBtn.disabled = false;
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Main init
  // ---------------------------------------------------------------------------

  async function init() {
    if (!TOKEN) {
      showError('No session token found. Please scan the QR code again.');
      return;
    }

    setStatus('⏳ Validating session...', 'secondary');

    let examInfo;
    try {
      examInfo = await callApi('validate_mobile_token', { token: TOKEN });
      if (examTitleEl) examTitleEl.textContent = examInfo.exam_title || '';
    } catch (e) {
      showError('Invalid or expired session token. Please scan the QR code again.');
      return;
    }

    // Room scan (if section is present, the exam requires it)
    const roomScanSection = document.getElementById('room-scan-section');
    if (roomScanSection) {
      setStatus('📷 Please complete the room scan first.', 'warning');
      await handleRoomScan();
    }

    setStatus('⏳ Requesting camera access...', 'secondary');

    try {
      await startCamera();
    } catch (e) {
      showError(
        'Camera access denied. Please allow camera access in your browser settings and reload.'
      );
      return;
    }

    await acquireWakeLock();

    setStatus('🟢 Connected — streaming to proctor', 'success');
    frameInterval = setInterval(sendFrame, FRAME_INTERVAL_MS);

    // Send first frame immediately
    sendFrame();
  }

  init();
})();
