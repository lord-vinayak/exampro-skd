var hiddenTime = 0;
var visibleTime = 0;
var examOverview;
var currentQuestion;
var detector;
var gazer;
var lastNoFaceAlertTime = 0;
var noFaceAlertCooldown = 5000;
var lastWebcamErrorTime = 0;
var webcamErrorCooldown = 5000;
var recordingInitialized = false;
var submitAnswerTimeout;
var isSubmittingAnswer = false;
var pendingNavigation = false;
var faceCurrentlyVisible = false;
var noFaceTerminationTimer = null;
var noFaceCountdownInterval = null;
var NO_FACE_GRACE_SECONDS = 60;

// ── VIOLATION SNAPSHOTS ───────────────────────────────────────────────────────
// Initialised inside startRecording() once the webcam stream is live.
var violationSnapshots = null;
// ─────────────────────────────────────────────────────────────────────────────

// ── AUDIO VAD MONITORING ─────────────────────────────────────────────────────
// Initialised when audio monitoring is enabled on the exam.
var audioVAD = null;
// ─────────────────────────────────────────────────────────────────────────────

function showNotification(message, type = 'info') {
    if (typeof toastr !== 'undefined') {
        switch (type) {
            case 'warning': toastr.warning(message); break;
            case 'error':   toastr.error(message);   break;
            case 'success': toastr.success(message); break;
            default:        toastr.info(message);
        }
    } else {
        console.log(`[${type.toUpperCase()}] ${message}`);
        const notification = document.createElement('div');
        notification.style.cssText = `
            position:fixed;top:20px;right:20px;
            background:${type==='error'?'#f44336':type==='warning'?'#ff9800':'#2196f3'};
            color:white;padding:12px 20px;border-radius:4px;z-index:10000;
            font-size:14px;max-width:300px;box-shadow:0 2px 10px rgba(0,0,0,0.2);`;
        notification.textContent = message;
        document.body.appendChild(notification);
        setTimeout(() => { if (notification.parentNode) notification.parentNode.removeChild(notification); }, 5000);
    }
}

// ── FIX BUG 3: Screen-share overlay ──────────────────────────────────────────
// Problem: startExam() calls location.reload() after the exam starts.
// After reload, status is "Started" so startExam() is never called again,
// meaning requestScreenCapture() is never called again, so _screenStream is
// always null and every screen snapshot is empty.
//
// Fix: when the page loads in "Started" state (i.e. after the reload),
// show a full-screen overlay that requires the candidate to click a button.
// That click IS a user gesture, so getDisplayMedia() can be called from it.
// The overlay must be dismissed before the candidate can interact with the exam.
function showScreenShareOverlay() {
    // Don't show if video proctoring is off or overlay already exists
    if (!exam.enable_video_proctoring) return;
    if (document.getElementById('screenShareOverlay')) return;

    // Platform detection — drives both the overlay copy and the proceed logic.
    const isAndroid = /android/i.test(navigator.userAgent);
    const isIOS     = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const isMobile  = isAndroid || isIOS;

    // ── KEY PLATFORM FACT (verified against caniuse, May 2026) ────────────────
    // getDisplayMedia (OS screen capture) is NOT implemented in ANY mobile
    // browser — Chrome for Android 148, Firefox Android 150 and Samsung Internet
    // all report it unsupported. Mobile browsers do not expose Android's
    // MediaProjection API to JavaScript, so the native "share whole screen"
    // picker can never be triggered from a web page.
    //
    // Therefore on mobile we do NOT attempt screen share. Instead each violation
    // captures TWO things at the violation instant:
    //   1. the front-camera frame (synchronous, zero delay), and
    //   2. the exam BROWSER WINDOW rendered via html2canvas (what's on the page).
    // Both are handled automatically inside ViolationSnapshotManager.capture().
    //
    // Only desktop browsers with getDisplayMedia get the OS screen-share flow.
    const willAttemptScreenShare = !isMobile && !!(
        navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function'
    );

    const overlay = document.createElement('div');
    overlay.id = 'screenShareOverlay';
    overlay.style.cssText = `
        position:fixed;inset:0;z-index:99999;
        background:rgba(15,15,15,0.92);
        display:flex;align-items:center;justify-content:center;
        font-family:inherit;`;

    if (willAttemptScreenShare) {
        // Android Chrome labels the picker option "Screen" (not "Entire Screen").
        const instruction = isAndroid
            ? `When the screen-picker appears, tap <strong>"Screen"</strong> to share your entire phone screen, then tap <em>Start now</em>.`
            : `When the browser dialog appears, select <strong>"Entire Screen"</strong> and click <em>Share</em>.`;

        overlay.innerHTML = `
            <div style="background:#fff;border-radius:12px;padding:40px 48px;max-width:480px;
                        width:90%;text-align:center;box-shadow:0 8px 40px rgba(0,0,0,0.4);">
                <div style="font-size:48px;margin-bottom:16px;">🖥️</div>
                <h3 style="margin:0 0 12px;font-size:1.4rem;color:#1a1a1a;">Screen Monitoring Required</h3>
                <p style="margin:0 0 24px;color:#555;line-height:1.6;">
                    This exam requires screen monitoring. ${instruction}
                </p>
                <button id="screenShareBtn"
                    style="background:#1a73e8;color:#fff;border:none;border-radius:8px;
                           padding:14px 32px;font-size:1rem;cursor:pointer;width:100%;
                           font-weight:600;transition:background 0.2s;">
                    Enable Screen Monitoring
                </button>
                <p data-screen-share-note style="margin:16px 0 0;font-size:0.8rem;color:#999;">
                    The exam cannot proceed without screen sharing.
                </p>
            </div>`;
    } else {
        // Mobile devices (Android/iOS). The OS screen cannot be captured from a
        // mobile browser, so we don't ask for screen share. Proctoring still runs:
        // every violation instantly captures the front camera AND a snapshot of
        // the exam page (browser window) — no extra permission needed.
        overlay.innerHTML = `
            <div style="background:#fff;border-radius:12px;padding:40px 48px;max-width:480px;
                        width:90%;text-align:center;box-shadow:0 8px 40px rgba(0,0,0,0.4);">
                <div style="font-size:48px;margin-bottom:16px;">📱</div>
                <h3 style="margin:0 0 12px;font-size:1.4rem;color:#1a1a1a;">Proctoring Active</h3>
                <p style="margin:0 0 24px;color:#555;line-height:1.6;">
                    This exam is monitored on your phone. If a violation is detected,
                    your <strong>front camera</strong> and the <strong>exam screen</strong>
                    are captured instantly. Keep this tab open and stay in view of the camera.
                </p>
                <button id="screenShareBtn"
                    style="background:#1a73e8;color:#fff;border:none;border-radius:8px;
                           padding:14px 32px;font-size:1rem;cursor:pointer;width:100%;
                           font-weight:600;transition:background 0.2s;">
                    Continue to Exam
                </button>
            </div>`;
    }

    document.body.appendChild(overlay);

    // Button click = user gesture → getDisplayMedia / getUserMedia can be called here
    document.getElementById('screenShareBtn').addEventListener('click', async function () {
        this.disabled = true;
        this.textContent = 'Please wait…';

        let granted = false;
        let failReason = '';  // tracks WHY screen capture failed — shown to user

        if (willAttemptScreenShare) {
            if (!violationSnapshots) {
                // ViolationSnapshotManager wasn't created — webcam likely failed.
                console.warn('[ScreenShare] violationSnapshots not initialised — webcam may have been denied.');
                const note = overlay.querySelector('[data-screen-share-note]');
                if (note) {
                    note.style.color = '#d32f2f';
                    note.textContent = 'Camera is not active. Please allow camera access and refresh the page.';
                }
                this.disabled = false;
                this.textContent = 'Enable Screen Monitoring';
                return;
            }

            // ── Comprehensive pre-flight diagnostics ─────────────────────────────
            //
            // KEY INSIGHT: window.isSecureContext is NOT a reliable proxy for whether
            // getDisplayMedia is available on Android Chrome.
            //   • http://localhost → isSecureContext = TRUE (W3C spec exception) but
            //     Android Chrome still does NOT expose getDisplayMedia on http:// URLs.
            //   • Only location.protocol === 'https:' reliably indicates the API will work.
            //
            // We therefore check API availability first, then diagnose WHY it's missing.
            const _ua = navigator.userAgent;
            const _isFirefox  = /firefox|fxios/i.test(_ua);
            const _isWebView  = /android/i.test(_ua) && /wv\b/i.test(_ua);
            const _isHttps    = location.protocol === 'https:';
            const _hasGDM     = typeof navigator.mediaDevices?.getDisplayMedia === 'function';

            // Log the complete diagnostic state — visible in DevTools / ADB logcat.
            console.log('[ScreenShare] Pre-flight diagnostics:', {
                url:              location.href,
                protocol:         location.protocol,
                isHttps:          _isHttps,
                isSecureContext:  window.isSecureContext,
                hasGetDisplayMedia: _hasGDM,
                mediaDevices:     !!navigator.mediaDevices,
                isAndroid,
                isFirefox:        _isFirefox,
                isWebView:        _isWebView,
                userAgent:        _ua,
            });

            if (!_hasGDM) {
                // API is missing — determine the specific reason so we can show an
                // actionable message (not just a generic "unsupported browser" note).
                if (_isFirefox) {
                    // Firefox on Android does not implement getDisplayMedia at all.
                    failReason = 'browser_firefox';
                    console.warn('[ScreenShare] Firefox detected — getDisplayMedia not supported.');
                } else if (_isWebView) {
                    // Android in-app browser / Chrome Custom Tab / WebView.
                    failReason = 'browser_webview';
                    console.warn('[ScreenShare] Android WebView detected — getDisplayMedia not available.');
                } else if (!_isHttps) {
                    // http:// URL — this covers BOTH the obvious case (192.168.x.x) AND
                    // the subtle case (http://localhost) where isSecureContext is true but
                    // Android Chrome still hides getDisplayMedia because the scheme is http.
                    failReason = 'insecure_context';
                    console.error('[ScreenShare] HTTP detected (protocol:', location.protocol,
                        ') — getDisplayMedia requires https://. isSecureContext was:',
                        window.isSecureContext, '— this can be true on localhost over HTTP,',
                        'which is why we check protocol directly.');
                } else {
                    // HTTPS + not Firefox + not WebView, but still no getDisplayMedia.
                    // Could be: Android OS version < 10, Samsung/MIUI browser, Permissions-Policy header.
                    failReason = 'api_unavailable';
                    console.warn('[ScreenShare] getDisplayMedia absent on HTTPS. Possible causes:',
                        'Android < 10, non-Chromium browser, or Permissions-Policy restriction.');
                }
            } else {
                // API present — attempt the actual capture.
                // requestScreenCapture() always resolves true/false, never throws.
                granted = await violationSnapshots.requestScreenCapture();
                if (!granted) failReason = 'user_cancelled';
            }
        } else {
            console.log('[ScreenShare] Skipping screen capture — not supported on this browser.');
        }

        // Request microphone permission in the same user-gesture if audio monitoring is enabled
        if (exam.enable_audio_monitoring && !audioVAD) {
            try {
                audioVAD = new AudioVADManager({
                    examSubmission: exam['exam_submission'],
                    rmsThreshold:   0.05,
                    windowMs:       30000,
                });
                const micGranted = await audioVAD.requestMicPermission();
                if (micGranted) {
                    audioVAD.start();
                    console.log('[Proctoring] Audio monitoring active.');
                } else {
                    console.warn('[Proctoring] Microphone permission denied — audio monitoring disabled.');
                    audioVAD = null;
                }
            } catch (e) {
                console.error('[Proctoring] Could not initialise AudioVADManager:', e);
                audioVAD = null;
            }
        }

        // ── Decide whether to proceed ─────────────────────────────────────────
        //   • Screen share active (any platform)        → proceed
        //   • iOS / unsupported browser                 → proceed (skip snapshots)
        //   • Desktop + user cancelled                  → block, show "Try Again"
        //   • Android + technical failure (HTTP / API)  → show diagnostic, offer "Continue Anyway"
        //   • Android + user cancelled picker           → show "Try Again" with option to continue

        if (granted || !willAttemptScreenShare) {
            overlay.remove();
            activateDetector();
            return;
        }

        // Screen share was attempted but failed. Show the reason.
        const note = overlay.querySelector('[data-screen-share-note]');

        if (failReason === 'browser_firefox') {
            // Firefox on Android — getDisplayMedia is not implemented at all.
            if (note) {
                note.style.color = '#d32f2f';
                note.innerHTML =
                    '⚠️ Firefox does not support screen sharing on Android. ' +
                    'Please open this exam in <strong>Chrome (version 116 or later)</strong> ' +
                    'to enable screen monitoring.';
            }
            this.textContent = 'Continue Without Screen Monitoring';
            this.disabled = false;
            this.addEventListener('click', () => { overlay.remove(); activateDetector(); }, { once: true });

        } else if (failReason === 'browser_webview') {
            // In-app browser / WebView — doesn't have getDisplayMedia.
            if (note) {
                note.style.color = '#d32f2f';
                note.innerHTML =
                    '⚠️ Screen sharing is not available in this in-app browser. ' +
                    'Please open this exam directly in the <strong>Chrome app</strong> ' +
                    '(not from inside another app like Gmail, WhatsApp, etc.).';
            }
            this.textContent = 'Continue Without Screen Monitoring';
            this.disabled = false;
            this.addEventListener('click', () => { overlay.remove(); activateDetector(); }, { once: true });

        } else if (failReason === 'insecure_context') {
            // HTTP URL — this covers both http://192.168.x.x AND http://localhost on Android.
            // The picker will NEVER appear regardless of retries on http://.
            if (note) {
                note.style.color = '#d32f2f';
                note.innerHTML =
                    '⚠️ Screen monitoring requires <strong>HTTPS</strong>. ' +
                    'This exam is currently served over HTTP (' + location.protocol + '//' + location.host + '). ' +
                    'Webcam proctoring remains active. Contact your administrator to enable HTTPS.';
            }
            this.textContent = 'Continue Without Screen Monitoring';
            this.disabled = false;
            this.addEventListener('click', () => { overlay.remove(); activateDetector(); }, { once: true });

        } else if (failReason === 'api_unavailable') {
            // HTTPS + recognised browser but getDisplayMedia still absent.
            // Possible: Android OS < 10, Permissions-Policy header blocking display-capture,
            // or a browser fork that doesn't implement the API.
            if (note) {
                note.style.color = '#d32f2f';
                note.innerHTML =
                    '⚠️ Screen monitoring is unavailable on this device. ' +
                    'Possible causes: Android version below 10, a browser that does not support ' +
                    'screen sharing, or a server configuration issue. ' +
                    'Webcam proctoring remains active.';
            }
            this.textContent = 'Continue Without Screen Monitoring';
            this.disabled = false;
            this.addEventListener('click', () => { overlay.remove(); activateDetector(); }, { once: true });

        } else if (isAndroid && failReason === 'user_cancelled') {
            // Android user dismissed the picker — offer retry or continue.
            if (note) {
                note.style.color = '#e65100';
                note.innerHTML =
                    'Screen sharing was not enabled. Tap <strong>"Try Again"</strong> and select ' +
                    '<strong>"Screen"</strong> → <strong>"Start now"</strong>, or continue without it.';
            }
            this.textContent = 'Try Again';
            this.disabled = false;
            // Add a secondary "Continue Anyway" link
            if (!overlay.querySelector('[data-continue-anyway]')) {
                const continueLink = document.createElement('p');
                continueLink.setAttribute('data-continue-anyway', '1');
                continueLink.style.cssText = 'margin:12px 0 0;font-size:0.85rem;';
                continueLink.innerHTML =
                    '<a href="#" style="color:#555;" id="continueAnywayLink">Continue without screen monitoring</a>';
                this.parentNode.appendChild(continueLink);
                document.getElementById('continueAnywayLink').addEventListener('click', (e) => {
                    e.preventDefault();
                    overlay.remove();
                    activateDetector();
                });
            }

        } else {
            // Desktop: user cancelled — keep requiring screen share.
            this.disabled = false;
            this.textContent = 'Try Again';
            if (note) {
                note.style.color = '#d32f2f';
                note.textContent = 'Screen sharing is required. Please click "Try Again" and select "Entire Screen".';
            }
        }
    });
}
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lightweight overlay for exams that have audio monitoring but NOT video
 * proctoring (so the screen-share overlay is never shown).
 * The candidate must click a button — providing the user-gesture needed
 * by getUserMedia — before the exam proceeds.
 */
function showAudioPermissionOverlay() {
    if (document.getElementById('audioPermissionOverlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'audioPermissionOverlay';
    overlay.style.cssText = `
        position:fixed;inset:0;z-index:99999;
        background:rgba(15,15,15,0.92);
        display:flex;align-items:center;justify-content:center;
        font-family:inherit;`;

    overlay.innerHTML = `
        <div style="background:#fff;border-radius:12px;padding:40px 48px;max-width:460px;
                    width:90%;text-align:center;box-shadow:0 8px 40px rgba(0,0,0,0.4);">
            <div style="font-size:48px;margin-bottom:16px;">🎙️</div>
            <h3 style="margin:0 0 12px;font-size:1.4rem;color:#1a1a1a;">Microphone Monitoring Required</h3>
            <p style="margin:0 0 24px;color:#555;line-height:1.6;">
                This exam monitors the environment for noise. Please allow microphone access when prompted.
            </p>
            <button id="audioPermissionBtn"
                style="background:#1a73e8;color:#fff;border:none;border-radius:8px;
                       padding:14px 32px;font-size:1rem;cursor:pointer;width:100%;
                       font-weight:600;transition:background 0.2s;">
                Enable Audio Monitoring
            </button>
            <p id="audioPermissionNote" style="margin:16px 0 0;font-size:0.8rem;color:#999;">
                The exam requires microphone access to continue.
            </p>
        </div>`;

    document.body.appendChild(overlay);

    document.getElementById('audioPermissionBtn').addEventListener('click', async function () {
        this.disabled = true;
        this.textContent = 'Waiting for permission…';

        try {
            audioVAD = new AudioVADManager({
                examSubmission: exam['exam_submission'],
                rmsThreshold:   0.05,
                windowMs:       30000,
            });
            const micGranted = await audioVAD.requestMicPermission();
            if (micGranted) {
                audioVAD.start();
                console.log('[Proctoring] Audio monitoring active (overlay dismissed).');
                overlay.remove();
            } else {
                audioVAD = null;
                this.disabled = false;
                this.textContent = 'Try Again';
                const note = document.getElementById('audioPermissionNote');
                note.style.color = '#d32f2f';
                note.textContent = 'Microphone access is required. Please click "Try Again" and allow access.';
            }
        } catch (e) {
            console.error('[AudioVAD] Permission overlay error:', e);
            audioVAD = null;
            this.disabled = false;
            this.textContent = 'Try Again';
        }
    });
}

// ── AUDIO VAD MANAGER ────────────────────────────────────────────────────────
/**
 * AudioVADManager
 *
 * Continuously monitors the microphone using the Web Audio API.
 * Audio is split into fixed 30-second windows. For each window:
 *   - If the peak RMS amplitude exceeded the threshold → upload the 30s
 *     audio clip to S3 via save_audio_clip and log a noise_detected violation.
 *   - Otherwise → discard the clip silently.
 *
 * No visual indicator is shown to the candidate.
 *
 * USAGE:
 *   1. Call requestMicPermission() inside a user-gesture handler.
 *   2. Call start() to begin window-based monitoring.
 *   3. Call stop() when the exam ends.
 */
class AudioVADManager {
    /**
     * @param {Object} options
     * @param {string} options.examSubmission   Frappe Exam Submission doc name (required)
     * @param {number} [options.rmsThreshold]   RMS amplitude threshold (0–1 scale). Default 0.05.
     * @param {number} [options.windowMs]       Window length in milliseconds. Default 30000 (30s).
     */
    constructor(options = {}) {
        if (!options.examSubmission) {
            throw new Error('[AudioVAD] examSubmission is required.');
        }
        this.examSubmission  = options.examSubmission;
        this.rmsThreshold    = options.rmsThreshold || 0.05;
        this.windowMs        = options.windowMs     || 30000;

        this._stream         = null;   // MediaStream from getUserMedia
        this._audioCtx       = null;   // AudioContext
        this._analyser       = null;   // AnalyserNode for RMS sampling
        this._recorder       = null;   // MediaRecorder for current window
        this._chunks         = [];     // audio chunks collected this window
        this._windowIndex    = 0;      // sequential window counter
        this._noiseInWindow  = false;  // was noise detected in current window?
        this._running        = false;
        this._windowTimer    = null;
        this._rmsTimer       = null;
    }

    /** Request microphone permission. Must be called inside a user-gesture. */
    async requestMicPermission() {
        try {
            this._stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            console.log('[AudioVAD] Microphone permission granted.');
            return true;
        } catch (err) {
            console.warn('[AudioVAD] Microphone permission denied or unavailable:', err.message);
            return false;
        }
    }

    /** Returns true if mic permission has been granted. */
    hasMicPermission() {
        return this._stream !== null && this._stream.active;
    }

    /** Begin 30-second window monitoring. Call after requestMicPermission() succeeds. */
    start() {
        if (!this.hasMicPermission()) {
            console.warn('[AudioVAD] Cannot start — mic permission not granted.');
            return;
        }
        if (this._running) return;
        this._running = true;

        // Set up Web Audio AnalyserNode for RMS sampling
        this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const source   = this._audioCtx.createMediaStreamSource(this._stream);
        this._analyser = this._audioCtx.createAnalyser();
        this._analyser.fftSize = 256;
        source.connect(this._analyser);

        console.log('[AudioVAD] Monitoring started. Window: ' + (this.windowMs / 1000) + 's, threshold: ' + this.rmsThreshold);
        this._startWindow();
    }

    /** Stop monitoring and release the microphone. */
    stop() {
        this._running = false;
        clearTimeout(this._windowTimer);
        clearInterval(this._rmsTimer);

        if (this._recorder && this._recorder.state !== 'inactive') {
            try { this._recorder.stop(); } catch (_) {}
        }
        if (this._audioCtx) {
            try { this._audioCtx.close(); } catch (_) {}
            this._audioCtx = null;
        }
        if (this._stream) {
            this._stream.getTracks().forEach(t => t.stop());
            this._stream = null;
        }
        console.log('[AudioVAD] Monitoring stopped.');
    }

    // -------------------------------------------------------------------------
    // Private
    // -------------------------------------------------------------------------

    _startWindow() {
        if (!this._running) return;

        this._chunks        = [];
        this._noiseInWindow = false;

        // Start recording the window
        try {
            this._recorder = new MediaRecorder(this._stream, { mimeType: 'audio/webm' });
        } catch (_) {
            // Fallback: let browser pick codec
            this._recorder = new MediaRecorder(this._stream);
        }
        this._recorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) this._chunks.push(e.data);
        };
        this._recorder.start(1000); // collect chunks every 1s

        // Poll RMS every 500ms during the window
        const dataArr = new Float32Array(this._analyser.fftSize);
        this._rmsTimer = setInterval(() => {
            this._analyser.getFloatTimeDomainData(dataArr);
            let sum = 0;
            for (let i = 0; i < dataArr.length; i++) sum += dataArr[i] * dataArr[i];
            const rms = Math.sqrt(sum / dataArr.length);
            if (rms > this.rmsThreshold) {
                this._noiseInWindow = true;
            }
        }, 500);

        // At the end of the window: evaluate and upload if noisy
        this._windowTimer = setTimeout(() => {
            this._endWindow();
        }, this.windowMs);
    }

    _endWindow() {
        clearInterval(this._rmsTimer);

        const windowIdx    = this._windowIndex;
        const wasNoisy     = this._noiseInWindow;
        this._windowIndex += 1;

        if (this._recorder && this._recorder.state !== 'inactive') {
            this._recorder.onstop = () => {
                if (wasNoisy) {
                    const blob = new Blob(this._chunks, { type: 'audio/webm' });
                    this._uploadClip(blob, windowIdx);
                } else {
                    console.log(`[AudioVAD] Window ${windowIdx}: quiet — discarded.`);
                }
                this._chunks = [];
                // Start the next window
                if (this._running) this._startWindow();
            };
            this._recorder.stop();
        } else {
            if (this._running) this._startWindow();
        }
    }

    _uploadClip(blob, windowIdx) {
        const reader = new FileReader();
        reader.onloadend = () => {
            const base64data = reader.result; // includes data-URI prefix
            const windowNum  = windowIdx + 1;
            const desc       = `Noise detected in 30-second window #${windowNum} (threshold: ${this.rmsThreshold})`;

            frappe.call({
                method: 'exampro.exam_pro.doctype.exam_submission.exam_submission.save_audio_clip',
                type:   'POST',
                args: {
                    exam_submission: this.examSubmission,
                    audio_data:      base64data,
                    window_index:    windowIdx,
                    description:     desc,
                },
                callback: (r) => {
                    if (r && r.message && r.message.status === 'success') {
                        console.log(`[AudioVAD] Window ${windowIdx}: noisy — clip uploaded successfully.`);
                    } else {
                        console.warn(`[AudioVAD] Window ${windowIdx}: upload returned unexpected response.`, r);
                    }
                },
                error: (err) => {
                    console.error(`[AudioVAD] Window ${windowIdx}: upload failed.`, err);
                },
            });
        };
        reader.readAsDataURL(blob);
    }
}
// ─────────────────────────────────────────────────────────────────────────────

function updateTimer() {
    if (!examEnded) {
        var remainingTime = new Date(exam.end_time) - new Date().getTime();
        if (remainingTime <= 0) {
            document.getElementById("exam-timer").innerHTML = "00:00";
            examAlert("Time's Up!", "Your exam time has expired. Click OK to proceed.");
            endExam(true);
            return;
        }
        var minutes = Math.floor((remainingTime % (1000 * 60 * 60)) / (1000 * 60));
        var seconds = Math.floor((remainingTime % (1000 * 60)) / 1000);
        if (remainingTime > (1000 * 60 * 60)) {
            var hours = Math.floor(remainingTime / (1000 * 60 * 60));
            $(".timer").text(`${hours.toString().padStart(2,'0')}:${minutes.toString().padStart(2,'0')}:${seconds.toString().padStart(2,'0')}`);
        } else {
            $(".timer").text(`${minutes.toString().padStart(2,'0')}:${seconds.toString().padStart(2,'0')}`);
        }
        setTimeout(updateTimer, 1000);
    }
}

const answrdCheck = `<i class="bi bi-check-circle"></i>`;
const answrLater  = `<i class="bi bi-clock-history"></i>`;
var examEnded  = false;
var currentQsNo = 1;
let recorder;
let stream;
let recordingStream;
let recordingInterval;

function sendVideoBlob(blob) {
    let xhr = new XMLHttpRequest();
    const unixTimestamp = Math.floor(Date.now() / 1000);
    xhr.open('POST', '/api/method/exampro.exam_pro.doctype.exam_submission.exam_submission.upload_video', true);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader('X-Frappe-CSRF-Token', frappe.csrf_token);
    let form_data = new FormData();
    form_data.append('file', blob, unixTimestamp + ".webm");
    form_data.append('exam_submission', exam["exam_submission"]);
    xhr.send(form_data);
}

function startRecording() {
    if (recordingInitialized) {
        console.log('Recording already initialized');
        return;
    }
    recordingInitialized = true;

    navigator.mediaDevices.getUserMedia({ audio: false, video: true })
        .then(function (mediaStream) {
            stream = mediaStream;
            recordingStream = stream.clone();

            stream.getTracks().forEach(track => {
                track.addEventListener('ended', function () {
                    const currentTime = Date.now();
                    if (currentTime - lastWebcamErrorTime > webcamErrorCooldown) {
                        console.error('Webcam was disabled or stopped');
                        sendMessage('Webcam was disabled or stopped', 'Warning', 'nowebcam');
                        lastWebcamErrorTime = currentTime;
                        showNotification('Webcam was disabled or stopped. Please fix the issue.', 'error');
                    }
                });
            });

            const videoElement = document.getElementById('webcam-stream');
            videoElement.srcObject  = stream;
            videoElement.muted      = true;
            videoElement.playsInline = true;

            const playVideo = () => {
                videoElement.play().catch(error => {
                    console.warn('Video autoplay prevented:', error);
                });
            };
            playVideo();

            const startVideoOnInteraction = () => {
                playVideo();
                document.removeEventListener('click',   startVideoOnInteraction);
                document.removeEventListener('keydown', startVideoOnInteraction);
            };
            document.addEventListener('click',   startVideoOnInteraction, { once: true });
            document.addEventListener('keydown', startVideoOnInteraction, { once: true });

            // ── Initialise ViolationSnapshotManager ───────────────────────────
            // Must come AFTER the video element has the stream attached so that
            // _captureWebcam() can draw from a live frame.
            if (exam.enable_video_proctoring && !violationSnapshots) {
                try {
                    violationSnapshots = new ViolationSnapshotManager({
                        examSubmission:      exam['exam_submission'],
                        webcamElementId:     'webcam-stream',
                        onSnapshotCaptured:  (type, urls) => {
                            console.log(`[Proctoring] Snapshot saved — type: ${type}`, urls);
                        },
                        onSnapshotError:     (type, err) => {
                            console.warn(`[Proctoring] Snapshot failed — type: ${type}`, err);
                        },
                        onScreenShareGranted: () => {
                            console.log('[Proctoring] Screen share active.');
                        },
                        onScreenShareDenied: () => {
                            console.warn('[Proctoring] Screen share denied.');
                        },
                    });
                } catch (e) {
                    console.error('[Proctoring] Could not initialise ViolationSnapshotManager:', e);
                    violationSnapshots = null;
                }
            }

            // ── FIX BUG 3: Show screen-share overlay on "Started" page load ──
            // When the page reloads after startExam(), status is "Started".
            // startExam() is never called again, so requestScreenCapture() would
            // never be invoked. The overlay forces a user-gesture click here.
            if (exam.enable_video_proctoring && exam.submission_status === 'Started') {
                // Small delay so the webcam feed renders first — better UX
                setTimeout(showScreenShareOverlay, 800);
            }
            // ─────────────────────────────────────────────────────────────────

            // Initialise Gazer
            if (exam.enable_video_proctoring && !gazer) {
                try {
                    gazer = new Gazer("webcam-stream", {
                        postTrackingDataInterval: 15,
                        showFaceRectangle: false,
                        showGazeVector:    false,
                        showEyePoints:     false,
                        enableLogs:        false,

                        onFaceDetected: (faces) => {
                            const currentTime = Date.now();
                            if (faces.length === 1) {
                                faceCurrentlyVisible = true;
                                cancelNoFaceCountdown();

                            } else if (faces.length === 0) {
                                faceCurrentlyVisible = false;

                                // ── FIX BUG 5: snapshot guard is separate from alert cooldown ──
                                // Previously both shared lastNoFaceAlertTime, causing snapshots
                                // to be silently skipped whenever the alert cooldown was active.
                                if (violationSnapshots && exam.submission_status === 'Started' && !examEnded) {
                                    violationSnapshots.capture('noface', 'No face detected in webcam.');
                                }

                                if (exam.submission_status === "Started" && !examEnded) {
                                    startNoFaceCountdown();
                                }

                            } else {
                                // faces.length > 1 — multiple people
                                faceCurrentlyVisible = true;
                                cancelNoFaceCountdown();

                                if (violationSnapshots && exam.submission_status === 'Started' && !examEnded) {
                                    violationSnapshots.capture(
                                        'multiplefaces',
                                        `${faces.length} faces detected in webcam.`
                                    );
                                }
                            }
                        },

                        onPostTrackingData: (trackingData) => {
                            if (exam.submission_status !== "Started") return;
                            frappe.call({
                                method: "exampro.exam_pro.doctype.exam_submission.exam_submission.post_tracking_info",
                                type: "POST",
                                args: {
                                    'info': JSON.stringify({
                                        'exam_submission':     exam["exam_submission"],
                                        'faceCountChanges':    trackingData.faceCountChanges,
                                        'totalAwayTime':       trackingData.totalAwayTime,
                                        'totalDistractedTime': trackingData.totalDistractedTime,
                                        'retinaLocations':     trackingData.retinaLocations || []
                                    })
                                },
                                callback: (data) => {},
                                error:    (error) => { console.error("Failed to send tracking data:", error); }
                            });
                        },

                        onError: (error) => {
                            console.error("Gazer error:", error);
                        }
                    });

                    gazer.setPerformanceMode('low');
                    gazer.setSensitivityMode('relaxed');

                    if (exam.submission_status === "Started" || exam.submission_status === "Registered") {
                        gazer.start();
                    }
                } catch (error) {
                    console.error("Failed to initialize gazer:", error);
                    gazer = null;
                }
            }

            if (exam["submission_status"] === "Started") {
                // Pick the best supported mimeType for this browser.
                // iOS Safari supports only video/mp4; desktop Chrome/Firefox prefer video/webm.
                // Passing an unsupported mimeType to RecordRTC / MediaRecorder throws on iOS.
                const _videoTypes = [
                    'video/webm;codecs=vp9',
                    'video/webm;codecs=vp8',
                    'video/webm',
                    'video/mp4',
                ];
                const _supportedVideoMime = (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported)
                    ? (_videoTypes.find(t => MediaRecorder.isTypeSupported(t)) || '')
                    : '';

                recorder = RecordRTC(recordingStream, {
                    type:             'video',
                    mimeType:         _supportedVideoMime || 'video/webm',
                    videoBitsPerSecond: 8000,
                    disableLogs:       true
                });
                recorder.startRecording();

                recordingInterval = setInterval(function () {
                    recorder.stopRecording(function () {
                        let blob = recorder.getBlob();
                        sendVideoBlob(blob);
                        recorder = RecordRTC(recordingStream, { type: 'video', disableLogs: true });
                        recorder.startRecording();
                    });
                }, 10000);
            }
        })
        .catch(function (error) {
            console.error('Webcam detection error:', error);
            const currentTime = Date.now();
            if (currentTime - lastWebcamErrorTime > webcamErrorCooldown) {
                sendMessage('Webcam was not detected', 'Warning', 'nowebcam');
                lastWebcamErrorTime = currentTime;
                showNotification('No webcam detected. Please check your camera permissions.', 'error');
            }
            recordingInitialized = false;
        });
}

function stopRecording() {
    clearInterval(recordingInterval);
    if (recorder) {
        recorder.stopRecording(function () {
            if (stream)          stream.getTracks().forEach(t => t.stop());
            if (recordingStream) recordingStream.getTracks().forEach(t => t.stop());
        });
    } else {
        if (stream)          stream.getTracks().forEach(t => t.stop());
        if (recordingStream) recordingStream.getTracks().forEach(t => t.stop());
    }
    recordingInitialized = false;
}

function activateDetector() {
    if (!detector) {
        detector = new InactivityDetector({
            warningThreshold: 1,

            // Fires the instant the page is hidden / window loses focus.
            // Webcam is grabbed synchronously right now. Screen capture is
            // delayed 200ms so the screen stream updates to show the switched-to
            // app/tab rather than the exam page (which is still rendering).
            onInactivityStart: () => {
                if (exam.submission_status !== 'Started' || examEnded) return;
                if (violationSnapshots) {
                    violationSnapshots.capture(
                        'tabchange',
                        'Candidate switched away from the exam tab or window.',
                        { screenDelay: 200 }
                    );
                } else {
                    // No snapshot manager (video proctoring off or screen share not yet
                    // granted) — still record the violation as a warning message.
                    frappe.call({
                        method: 'exampro.exam_pro.doctype.exam_submission.exam_submission.post_exam_message',
                        args: {
                            exam_submission: exam.exam_submission,
                            message: 'Candidate switched away from the exam tab or window.',
                            type_of_message: 'Warning',
                            warning_type: 'tabchange',
                        },
                    });
                }
            },

            onInactive: (inactiveStr, secondsInactive) => {
                tabChangeStr = `Tab changed detected for ${secondsInactive} seconds.`;
                console.log(tabChangeStr);

                // Secondary capture on return — records the moment of return.
                // No screenDelay needed here: candidate is back on the exam tab.
                if (violationSnapshots && exam.submission_status === 'Started' && !examEnded) {
                    violationSnapshots.capture(
                        'tabchange',
                        `Candidate was away for ${secondsInactive}s. Reason: ${inactiveStr}`
                    );
                }
            },

            onActive: () => {
                console.log("User active again");
            },

            onMonitorChange: (lastScreens, currentScreens) => {
                monitorChangeStr = `Monitor changed from ${lastScreens} to ${currentScreens}`;
                console.log(monitorChangeStr);

                if (violationSnapshots && exam.submission_status === 'Started' && !examEnded) {
                    violationSnapshots.capture(
                        'monitorchange',
                        `Monitor configuration changed: ${lastScreens} → ${currentScreens}.`
                    );
                }
            }
        });
        detector.init();
    }
}

frappe.ready(() => {
    updateOverviewMap();

    document.addEventListener('contextmenu', e => e.preventDefault());
    document.addEventListener('selectstart', e => e.preventDefault());
    document.addEventListener('copy',        e => e.preventDefault());

    document.addEventListener('keydown', function (e) {
        if (e.key === 'PrintScreen')                         { e.preventDefault(); alert('Screenshots are disabled!'); }
        if (e.ctrlKey && e.shiftKey && e.key === 'S')        { e.preventDefault(); alert('Screenshots are disabled!'); }
        if (e.metaKey && e.shiftKey && e.key === '4')        { e.preventDefault(); alert('Screenshots are disabled!'); }
        if (e.ctrlKey && e.key === 'P')                      { e.preventDefault(); alert('Printing is disabled!'); }
    });

    if (exam["submission_status"] === "Registered") {
        $("#quiz-btn").text("Start exam");
        $("#quiz-btn").show();
        $("#quiz-message").hide();
        $("#quiz-btn").click((e) => {
            e.preventDefault();
            startExam();
        });
    } else {
        $('#submitTopBtn').show();
        $("#quiz-form").removeClass("hide");
        getQuestion(exam["current_qs"]);
    }

    if (exam.submission_status === "Started" || exam.submission_status === "Registered") {
        if (exam.enable_video_proctoring) {
            startRecording();
        }
    }

    if (exam.submission_status === "Started") {
        window.examStarted = true;
        window.addEventListener('beforeunload', function (e) {
            // Log it if needed, but snapshots aren't possible here.
            // sendMessage("Window closed", "Warning", "tabchange");
        });
        var $navbar = $('.navbar');
        if (!$navbar.hasClass('hidden')) $navbar.addClass('hidden');
        updateTimer();

        // Only activate detector immediately if video proctoring is OFF.
        // If ON, it will be activated after screen share is granted in showScreenShareOverlay.
        if (!exam.enable_video_proctoring) {
            activateDetector();

            // If audio monitoring is enabled but there's no screen-share overlay
            // (video proctoring is off), request mic via a lightweight overlay.
            if (exam.enable_audio_monitoring && !audioVAD) {
                showAudioPermissionOverlay();
            }
        }
    }

    // Initialise mobile camera proctoring (no-op if not enabled on the exam doc)
    if (exam["exam_submission"]) {
        initMobileCameraSection(exam["exam_submission"]);
    }

    $("#nextQs").click((e) => { e.preventDefault(); submitAnswer(true); });
    $("#finish").click((e)  => { e.preventDefault(); submitAnswer(true); });
    $("#submitTopBtn").click((e) => { e.preventDefault(); showSubmitConfirmPage(); });

    setInterval(function () { updateMessages(exam["exam_submission"]); }, 3000);

    $(document).on('change', 'input[name^="qs_"]', function () { submitAnswer(); });

    $(document).on('change', '#markedForLater', function () {
        if (currentQuestion && currentQuestion["type"] == "Choices") submitAnswer();
    });

    setInterval(function () {
        $(".chat-time").each(function () {
            var ts = $(this).data("timestamp");
            $(this).text(timeAgo(ts));
        });
    }, 60000);
});


function updateOverviewMap() {
    frappe.call({
        method: "exampro.exam_pro.doctype.exam_submission.exam_submission.exam_overview",
        args: { "exam_submission": exam.exam_submission },
        success: (data) => {
            examOverview = data.message;
            if (currentQuestion) {
                if (currentQuestion["no"] === examOverview["total_questions"]) {
                    $('#nextQs').hide(); $('#finish').show();
                } else {
                    $('#nextQs').show(); $('#finish').hide();
                }
                document.getElementById("answeredCount").innerHTML     = data.message.total_answered.toString().padStart(2,'0');
                document.getElementById("markedForLaterCount").innerHTML = data.message.total_marked_for_later.toString().padStart(2,'0');
            }
            $("#question-length").text(data.message.total_questions);

            if (data.message.total_questions != 0) $("#button-grid").html('');

            for (let i = 1; i <= data.message.total_questions; i++) {
                let btnCls     = "btn btn-sm btn-outline-secondary d-flex align-items-center justify-content-between rounded-pill";
                let circleColor = "text-grey";

                if (data.message.submitted[i] && data.message.submitted[i].marked_for_later) {
                    circleColor = "text-warning";
                } else if (data.message.submitted[i] && data.message.submitted[i].answer) {
                    circleColor = "text-info";
                }

                if (currentQuestion && i === currentQuestion["no"]) {
                    btnCls      = "btn btn-sm btn-outline-dark d-flex align-items-center justify-content-between rounded-pill current-question-btn";
                    circleColor = "text-grey";
                }

                const button = $("<button></button>");
                button.addClass(btnCls).attr("id", "button-" + i);
                button.html(`<i class="bi bi-circle-fill ${circleColor}"></i><span class="fw-bold text-dark">${i}</span>`);
                $("#button-grid").append(button);
                button.click((e) => { navigateToQuestion(i); });
            }
        },
    });
}

function navigateToQuestion(qsno) {
    clearTimeout(submitAnswerTimeout);

    if (currentQuestion && currentQuestion["type"] !== "Choices") {
        let textContent = $("#examTextInput").find("textarea").val();
        let mrkForLtr   = $("#markedForLater").prop('checked');

        if ((textContent && textContent.trim() !== "") || mrkForLtr) {
            frappe.call({
                method: "exampro.exam_pro.doctype.exam_submission.exam_submission.submit_question_response",
                type:   "POST",
                async:  false,
                args: {
                    'exam_submission': exam["exam_submission"],
                    'qs_name':  currentQuestion["name"],
                    'qs_no':    currentQuestion["no"],
                    'answer':   textContent,
                    'markdflater': mrkForLtr ? 1 : 0,
                },
                callback: (data) => { getQuestion(qsno); },
                error:    (error) => { console.error("Error submitting answer before navigation:", error); getQuestion(qsno); }
            });
        } else {
            getQuestion(qsno);
        }
    } else if (currentQuestion && currentQuestion["type"] == "Choices") {
        submitAnswer(false);
        getQuestion(qsno);
    } else {
        getQuestion(qsno);
    }
}

function getImageSrc(imageData) {
    if (!imageData) return null;
    try {
        if (imageData.startsWith('data:')) return imageData;
        if (imageData.match(/^[A-Za-z0-9+/=]+$/)) { atob(imageData); return `data:image/jpeg;base64,${imageData}`; }
        return imageData;
    } catch (error) {
        console.warn('Invalid image data:', error); return null;
    }
}

function displayQuestion(current_qs) {
    currentQuestion = {
        "exam":              exam.name,
        "no":                current_qs.qs_no,
        "name":              current_qs.name,
        "key":               exam.name + "_question_" + current_qs.qs_no,
        "multiple":          current_qs.multiple,
        "type":              current_qs.type,
        "question":          current_qs.question,
        "description_image": current_qs.description_image,
        "option_1":          current_qs.option_1,
        "option_2":          current_qs.option_2,
        "option_3":          current_qs.option_3,
        "option_4":          current_qs.option_4,
        "option_1_image":    current_qs.option_1_image,
        "option_2_image":    current_qs.option_2_image,
        "option_3_image":    current_qs.option_3_image,
        "option_4_image":    current_qs.option_4_image,
        "answer":            current_qs.answer || '',
        "marked_for_later":  current_qs.marked_for_later
    };

    $("#quiz-form").removeClass("hide");
    $("#current-question").text(currentQuestion["no"]);
    $('#markedForLater').prop("checked", false);

    $('#question').attr({
        'data-name':  currentQuestion["name"],
        'data-type':  currentQuestion["type"],
        'data-multi': currentQuestion["multiple"]
    });

    let instruction;
    if      (currentQuestion["type"] == "Choices" && currentQuestion["multiple"]) instruction = "Choose all answers that apply";
    else if (currentQuestion["type"] == "Choices")                                instruction = "Choose one answer";
    else                                                                           instruction = "Enter the correct answer";

    $('#question-number').html(`<span class="question-number-text">Question ${currentQuestion["no"]}</span> <span class="question-instruction">${instruction}</span>`);
    $('#current-question-number').text(`Question ${currentQuestion["no"]}`);

    $('#question-text').html('');
    let qHtml = `<div class="question-content"><div class="question-text-content">${currentQuestion["question"]}</div>`;
    if (currentQuestion["description_image"]) {
        const src = getImageSrc(currentQuestion["description_image"]);
        if (src) qHtml += `<div class="question-description-image mt-3"><img src="${src}" class="img-fluid" alt="Question image" style="max-width:70%;height:auto;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.1);" onerror="this.style.display='none'"></div>`;
    }
    qHtml += `</div>`;
    $('#question-text').append(qHtml);

    if (currentQuestion["type"] === "Choices") {
        let valuesToMatch = currentQuestion["answer"].split(',');
        $('#choices').show(); $('#text-input').hide();

        let options = {
            "option_1": currentQuestion["option_1"],
            "option_2": currentQuestion["option_2"],
            "option_3": currentQuestion["option_3"],
            "option_4": currentQuestion["option_4"],
        };
        let choicesHtml = '';

        $.each(options, function (key, value) {
            if (value) {
                let inputType   = currentQuestion["multiple"] ? 'checkbox' : 'radio';
                let explanation = current_qs[`explanation_${key}`];
                let explanationHtml = explanation ? `<small class="explanation ml-10">${explanation}</small>` : '';
                let checked = valuesToMatch.includes(key.split("_")[1]) ? "checked" : '';
                let optImg  = currentQuestion[key + "_image"];
                let optImgHtml = '';
                if (optImg) {
                    const src = getImageSrc(optImg);
                    if (src) optImgHtml = `<div class="option-image mt-2"><img src="${src}" class="img-fluid" alt="Option image" style="max-width:200px;height:auto;border-radius:6px;" onerror="this.style.display='none'"></div>`;
                }
                choicesHtml += `
                    <label for="option_${currentQuestion["key"]}_${key}" class="w-100 mb-0" style="cursor:pointer;">
                        <div class="option-item ${checked ? 'selected' : ''}" style="border:1px solid #dee2e6;border-radius:8px;padding:12px;margin-bottom:8px;transition:all 0.2s ease;">
                            <div class="d-flex align-items-start">
                                <input class="option me-2 mt-1" value="${key}" type="${inputType}" name="qs_${currentQuestion["key"]}" ${checked} id="option_${currentQuestion["key"]}_${key}" style="margin-top:2px;">
                                <div class="option-content flex-grow-1">
                                    <div class="option-text mb-0">${value}</div>
                                    ${optImgHtml}
                                    ${explanationHtml}
                                </div>
                            </div>
                        </div>
                    </label>`;
            }
        });

        if (currentQuestion["marked_for_later"]) $('#markedForLater').prop("checked", true);
        $('#examTextInput').hide();
        $('#choices').html('').append(choicesHtml);

        $('.option').on('change', function () {
            if (currentQuestion["multiple"]) {
                const oi = $(this).closest('.option-item');
                if ($(this).is(':checked')) {
                    oi.addClass('selected').css({'background-color':'#e3f2fd','border-color':'#2196f3','box-shadow':'0 2px 8px rgba(33,150,243,0.2)'});
                } else {
                    oi.removeClass('selected').css({'background-color':'','border-color':'#dee2e6','box-shadow':'0 1px 4px rgba(0,0,0,0.1)'});
                }
            } else {
                $('.option-item').removeClass('selected').css({'background-color':'','border-color':'#dee2e6','box-shadow':'0 1px 4px rgba(0,0,0,0.1)'});
                $(this).closest('.option-item').addClass('selected').css({'background-color':'#e3f2fd','border-color':'#2196f3','box-shadow':'0 2px 8px rgba(33,150,243,0.2)'});
            }
        });

        $('.option:checked').each(function () {
            $(this).closest('.option-item').addClass('selected').css({'background-color':'#e3f2fd','border-color':'#2196f3','box-shadow':'0 2px 8px rgba(33,150,243,0.2)'});
        });

        $('.option-item').hover(
            function () { if (!$(this).hasClass('selected')) $(this).css({'background-color':'#f8f9fa','border-color':'#adb5bd'}); },
            function () { if (!$(this).hasClass('selected')) $(this).css({'background-color':'','border-color':'#dee2e6'}); }
        );

    } else {
        $('#choices').hide(); $('#examTextInput').show();
        $("#examTextInput").find("textarea").val(currentQuestion["answer"]);
        if (currentQuestion["marked_for_later"]) $('#markedForLater').prop("checked", true);
    }
}

function sendMessage(message, messageType, warningType) {
    if (currentQsNo > 1) {
        frappe.call({
            method: "exampro.exam_pro.doctype.exam_submission.exam_submission.post_exam_message",
            type: "POST",
            args: {
                'exam_submission': exam["exam_submission"],
                'message':         message,
                'type_of_message': messageType,
                'warning_type':    warningType,
                'from':            "Candidate"
            },
            callback: (data) => { console.log(data); },
        });
    }
}

function sendChatMessage() {
    var message = $('#chat-input').val().trim();
    if (message) {
        frappe.call({
            method: "exampro.exam_pro.doctype.exam_submission.exam_submission.post_exam_message",
            type: "POST",
            args: {
                'exam_submission': exam["exam_submission"],
                'message':         message,
                'type_of_message': 'General',
                'warning_type':    '',
            },
            callback: (data) => { $('#chat-input').val(''); updateMessages(exam.exam_submission); },
        });
    }
}

function startNoFaceCountdown() {
    if (noFaceTerminationTimer) return;
    let secondsLeft = NO_FACE_GRACE_SECONDS;
    showNoFaceCountdownBanner(secondsLeft);
    noFaceCountdownInterval = setInterval(() => {
        secondsLeft -= 1;
        if (secondsLeft >= 0) showNoFaceCountdownBanner(secondsLeft);
    }, 1000);
    noFaceTerminationTimer = setTimeout(() => {
        clearInterval(noFaceCountdownInterval);
        noFaceCountdownInterval = null;
        noFaceTerminationTimer  = null;
        terminateForNoFace();
    }, NO_FACE_GRACE_SECONDS * 1000);
}

function cancelNoFaceCountdown() {
    if (noFaceTerminationTimer)  { clearTimeout(noFaceTerminationTimer);   noFaceTerminationTimer  = null; }
    if (noFaceCountdownInterval) { clearInterval(noFaceCountdownInterval); noFaceCountdownInterval = null; }
    hideNoFaceCountdownBanner();
}

function showNoFaceCountdownBanner(secondsLeft) {
    const banner = document.getElementById('noFaceBanner');
    if (!banner) return;
    banner.style.display = 'block';
    const countdownEl = document.getElementById('noFaceCountdown');
    if (countdownEl) countdownEl.textContent = secondsLeft;
}

function hideNoFaceCountdownBanner() {
    const banner = document.getElementById('noFaceBanner');
    if (banner) banner.style.display = 'none';
}

function terminateForNoFace() {
    if (examEnded) return;
    examEnded = true;
    cancelNoFaceCountdown();

    const snapshotPromise = violationSnapshots
        ? violationSnapshots.capture('noface', 'Exam terminated: face not visible to camera for 60 seconds.')
        : Promise.resolve();

    const terminatePromise = new Promise((resolve) => {
        frappe.call({
            method: "exampro.exam_pro.doctype.exam_submission.exam_submission.post_exam_message",
            type: "POST",
            args: {
                'exam_submission': exam["exam_submission"],
                'message':         'Exam terminated: face not visible to camera for 60 seconds.',
                'type_of_message': 'Critical',
                'warning_type':    'nofacetimeout',
            },
            callback: resolve,
            error: (error) => { console.error("Failed to post nofacetimeout:", error); resolve(); }
        });
    });

    const timeout = new Promise((resolve) => setTimeout(resolve, 5000));
    Promise.race([Promise.all([snapshotPromise, terminatePromise]), timeout]).finally(() => {
        stopRecording();
        if (detector)           detector.destroy();
        if (violationSnapshots) violationSnapshots.destroy();
        if (audioVAD)           audioVAD.stop();
        window.location.href = "/exam/" + exam.exam_submission;
    });
}

function endExam(isAutoSubmit) {
    if (!examEnded) {
        frappe.call({
            method: "exampro.exam_pro.doctype.exam_submission.exam_submission.end_exam",
            type: "POST",
            args: { "exam_submission": exam["exam_submission"] },
            callback: (data) => {
                examEnded = true;
                stopRecording();
                if (detector)           detector.destroy();
                if (violationSnapshots) violationSnapshots.destroy();
                if (isAutoSubmit) {
                    window.location.href = "/exam?auto_submitted=1&submission=" + encodeURIComponent(exam.exam_submission);
                } else {
                    window.location.href = "/exam/" + exam.exam_submission;
                }
            }
        });
    }
}

// ── startExam ──────────────────────────────────────────────────────────────────
// "Registered" path: call the API to mark the exam Started, then reload.
// Do NOT request screen share here — location.reload() destroys any stream
// obtained at this point, so it would be wasted work that also triggers a
// spurious violation (window loses focus during the browser permission dialog).
// The full-screen overlay shown after reload (in showScreenShareOverlay, called
// from startRecording when status === 'Started') handles screen share correctly
// with a single, clean user-gesture click.
async function startExam() {
    if (typeof checkMediaPermissionsBeforeStart === 'function' && !checkMediaPermissionsBeforeStart()) return;

    frappe.call({
        method: "exampro.exam_pro.doctype.exam_submission.exam_submission.start_exam",
        type: "POST",
        args: { "exam_submission": exam["exam_submission"] },
        callback: (data) => {
            if (data.message && data.message.end_time) {
                exam.end_time = data.message.end_time;
            }
            $("#quiz-form").removeClass("hide");
            location.reload();
        }
    });
}

function getQuestion(qsno) {
    clearTimeout(submitAnswerTimeout);
    frappe.call({
        method: "exampro.exam_pro.doctype.exam_submission.exam_submission.get_question",
        type: "POST",
        args: { "exam_submission": exam["exam_submission"], "qsno": qsno },
        callback: (data) => {
            $("#exam-summary").addClass("hide");
            $("#quiz-form").removeClass("hide");
            displayQuestion(data.message);
            currentQsNo = data.message.qs_no;
            updateOverviewMap();
        }
    });
}

function showSubmitConfirmPage() {
    clearTimeout(submitAnswerTimeout);
    if (currentQuestion && currentQuestion["type"] == "Choices") submitAnswer(false);

    frappe.call({
        method: "exampro.exam_pro.doctype.exam_submission.exam_submission.exam_overview",
        args:   { "exam_submission": exam.exam_submission },
        async:  false,
        success: (data) => {
            examOverview = data.message;
            $("#exam-summary").removeClass("hide");
            $("#quiz-form").addClass("hide");
            $("#quiz-title").html();
            $('#quiz-box').removeClass("text-center");
            let messageHtml = `
                <div class="d-flex justify-content-center">
                <div class="card" style="max-width:30rem;">
                    <div class="card-body">
                    <div class="d-flex align-items-center mb-3">
                        <i class="bi bi-clock me-2"></i>
                        <h6 class="mb-0">Time Remaining: <span class="ml-10 timer">--:--</span></h6>
                    </div>
                    <ul class="list-group list-group-flush">
                        <li class="list-group-item d-flex justify-content-between align-items-center">
                            <span class="mr-10">Total Questions</span><span>${examOverview.total_questions}</span>
                        </li>
                        <li class="list-group-item d-flex justify-content-between align-items-center">
                            <span class="mr-10">Total Answered</span><span>${examOverview.total_answered}</span>
                        </li>
                        <li class="list-group-item d-flex justify-content-between align-items-center">
                            <span class="mr-10">Marked for Review</span><span>${examOverview.total_marked_for_later}</span>
                        </li>
                    </ul>
                    </div>
                    <div class="card-footer">
                    <button class="btn btn-primary w-100" id="quizSubmit" onClick=endExam();>Submit Exam</button>
                    </div>
                </div>
                </div>`;
            $("#quiz-box").html(messageHtml);
        }
    });
}

function submitAnswer(loadNext) {
    if (isSubmittingAnswer) {
        if (loadNext) pendingNavigation = true;
        return;
    }

    let answer;
    var mrkForLtr = $("#markedForLater").prop('checked') ? 1 : 0;

    if (currentQuestion["type"] == "Choices") {
        let checkedValues = [];
        $("[name='" + "qs_" + currentQuestion["key"] + "']:checked").each(function () {
            const numericValue = $(this).val().split("_")[1];
            checkedValues.push(numericValue);
        });
        answer = checkedValues.join(",");
    } else {
        answer = $("#examTextInput").find("textarea").val();
        if (!loadNext && !mrkForLtr) return;
        if (loadNext && !mrkForLtr && (!answer || answer.trim() === "")) {
            if (currentQuestion["no"] < examOverview["total_questions"]) {
                getQuestion(currentQuestion["no"] + 1);
                updateOverviewMap();
            } else {
                showSubmitConfirmPage();
            }
            return;
        }
    }

    isSubmittingAnswer = true;
    frappe.call({
        method: "exampro.exam_pro.doctype.exam_submission.exam_submission.submit_question_response",
        type: "POST",
        args: {
            'exam_submission': exam["exam_submission"],
            'qs_name':    currentQuestion["name"],
            'qs_no':      currentQuestion["no"],
            'answer':     answer,
            'markdflater': mrkForLtr,
        },
        callback: (data) => {
            isSubmittingAnswer = false;
            const shouldNavigate   = loadNext || pendingNavigation;
            pendingNavigation      = false;
            const userStillOnSavedQs = currentQuestion && currentQuestion["no"] === data.message.qs_no;

            if (shouldNavigate && userStillOnSavedQs) {
                if (data.message.qs_no < examOverview["total_questions"]) {
                    getQuestion(data.message.qs_no + 1);
                    updateOverviewMap();
                } else {
                    showSubmitConfirmPage();
                }
            }
        },
        error: (error) => {
            console.error("Error submitting answer:", error);
            isSubmittingAnswer = false;
            if (loadNext || pendingNavigation) {
                pendingNavigation = false;
                showNotification("Could not save your answer. Please try again.", "error");
            }
        }
    });
}

// ─── Mobile Camera Proctoring ──────────────────────────────────────────────

var mobileProctoringEnabled = false;
var mobileCameraConnected = false;
var mobileStatusInterval = null;
var mobileGracePeriodTimer = null;
var mobileGracePeriodSeconds = 60;

// Block the Start Exam button until mobile camera is connected
function blockStartExamButton() {
  var btn = document.getElementById('quiz-btn');
  if (!btn) return;
  btn.disabled = true;
  btn.title = 'Connect your mobile camera first';
  btn.style.opacity = '0.5';
  btn.style.cursor = 'not-allowed';
}

function unblockStartExamButton() {
  var btn = document.getElementById('quiz-btn');
  if (!btn) return;
  btn.disabled = false;
  btn.title = '';
  btn.style.opacity = '';
  btn.style.cursor = '';
}

// Show a full-screen blocking modal with the QR code
function showMobileQRModal(qrUrl) {
  if (document.getElementById('mobile-qr-modal')) return; // already shown

  var modal = document.createElement('div');
  modal.id = 'mobile-qr-modal';
  modal.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:10000',
    'background:rgba(0,0,0,0.88)',
    'display:flex',
    'align-items:center',
    'justify-content:center',
  ].join(';');

  modal.innerHTML = [
    '<div style="background:#fff;border-radius:12px;padding:2rem 2.5rem;max-width:420px;width:90%;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,0.4);">',
      '<h4 style="margin-top:0;margin-bottom:0.5rem;">📱 Connect Mobile Camera</h4>',
      '<p style="color:#555;font-size:0.9rem;margin-bottom:1rem;">',
        'Scan this QR code with your phone to set up the auxiliary camera.<br>',
        '<strong>The exam will unlock once your phone is connected.</strong>',
      '</p>',
      '<div id="mobile-qr-container" style="display:inline-block;padding:8px;border:1px solid #ddd;border-radius:8px;background:#fff;"></div>',
      '<div style="margin-top:0.75rem;font-size:0.78rem;color:#888;">',
        'Or open: <a id="mobile-qr-link" href="' + qrUrl + '" target="_blank" style="color:#0070f3;word-break:break-all;">' + qrUrl + '</a>',
      '</div>',
      '<div id="mobile-modal-status" style="margin-top:1rem;padding:0.5rem 1rem;border-radius:6px;background:#fff3cd;color:#856404;font-weight:500;">',
        '🔴 Waiting for mobile connection…',
      '</div>',
    '</div>',
  ].join('');

  document.body.appendChild(modal);

  // Render QR using qrcodejs (synchronous constructor)
  var container = document.getElementById('mobile-qr-container');
  if (container && typeof QRCode !== 'undefined') {
    new QRCode(container, {
      text: qrUrl,
      width: 200,
      height: 200,
      correctLevel: QRCode.CorrectLevel.M,
    });
  } else {
    console.warn('[Mobile] QRCode library not available yet');
    // Retry once after a short delay in case the CDN script is still loading
    setTimeout(function() {
      var c2 = document.getElementById('mobile-qr-container');
      if (c2 && typeof QRCode !== 'undefined' && !c2.querySelector('canvas,img')) {
        new QRCode(c2, { text: qrUrl, width: 200, height: 200, correctLevel: QRCode.CorrectLevel.M });
      }
    }, 1500);
  }
}

function closeMobileQRModal() {
  var modal = document.getElementById('mobile-qr-modal');
  if (modal) modal.remove();
}

function updateMobileModalStatus(status) {
  var el = document.getElementById('mobile-modal-status');
  if (!el) return;
  if (status === 'Connected') {
    el.style.background = '#d1e7dd';
    el.style.color = '#0a3622';
    el.textContent = '🟢 Mobile camera connected! Starting exam…';
  } else if (status === 'Disconnected') {
    el.style.background = '#f8d7da';
    el.style.color = '#842029';
    el.textContent = '⚠️ Connection lost. Reconnect your phone.';
  }
}

async function initMobileCameraSection(examSubmission) {
  // exam global is injected by Jinja: var exam = {{ exam | tojson }}
  // enable_mobile_proctoring and mobile_grace_period are included via index.py
  if (!exam || !exam.enable_mobile_proctoring) return;

  mobileProctoringEnabled = true;
  mobileGracePeriodSeconds = exam.mobile_grace_period || 60;
  window.currentExamSubmission = examSubmission;

  // If exam is already started (resumed session), just start polling — no QR needed
  if (exam.submission_status === 'Started') {
    mobileStatusInterval = setInterval(checkMobileStatus, 3000);
    checkMobileStatus();
    return;
  }

  // Exam not started yet ("Registered"): show QR modal + block Start button
  try {
    var result = await frappe.call({
      method: 'exampro.exam_pro.api.mobile_proctor.generate_mobile_token',
      args: { exam_submission: examSubmission },
    });

    if (!result || !result.message || !result.message.qr_url) {
      console.warn('[Mobile] generate_mobile_token returned unexpected response', result);
      return;
    }

    var qrUrl = result.message.qr_url;
    console.log('[MobileDebug] QR URL:', qrUrl);

    showMobileQRModal(qrUrl);
    blockStartExamButton();

    // Start polling for connection status
    mobileStatusInterval = setInterval(checkMobileStatus, 3000);
    checkMobileStatus();

  } catch (e) {
    console.warn('[Mobile] Camera init failed:', e);
  }
}

function updateMobileBadge(status) {
  var badge = document.getElementById('mobile-status-badge');
  var dot = document.getElementById('mobile-badge-dot');
  var text = document.getElementById('mobile-badge-text');
  if (!badge || !dot || !text) return;

  var colours = { Connected: '#28a745', Disconnected: '#dc3545', Pending: '#6c757d' };
  dot.style.background = colours[status] || colours.Pending;
  text.textContent = '📱 ' + (status || 'Mobile');
}

async function checkMobileStatus() {
  var examSubmission = window.currentExamSubmission;
  if (!examSubmission) return;

  try {
    var result = await frappe.call({
      method: 'exampro.exam_pro.api.mobile_proctor.get_mobile_status',
      args: { exam_submission: examSubmission },
    });

    if (!result || !result.message) return;
    var status = result.message.status;
    var grace_period = result.message.grace_period;
    if (grace_period) mobileGracePeriodSeconds = grace_period;

    updateMobileBadge(status);

    if (status === 'Connected') {
      mobileCameraConnected = true;

      if (!window.examStarted) {
        // Pre-exam: show connected state in modal, then unlock Start button
        updateMobileModalStatus('Connected');
        setTimeout(function() {
          closeMobileQRModal();
          unblockStartExamButton();
        }, 1200);
        // Keep polling — page will reload when exam starts, restarting the interval
        clearInterval(mobileStatusInterval);
        mobileStatusInterval = null;
      } else {
        // During exam: hide disconnect overlay if it was showing
        hideMobileDisconnectOverlay();
      }

    } else if (status === 'Disconnected') {
      mobileCameraConnected = false;
      if (window.examStarted) {
        showMobileDisconnectOverlay();
      } else {
        updateMobileModalStatus('Disconnected');
      }
    }
  } catch (e) {
    console.warn('[Mobile] Status check failed:', e);
  }
}

function showMobileDisconnectOverlay() {
  if (document.getElementById('mobile-disconnect-overlay')) return;

  var overlay = document.createElement('div');
  overlay.id = 'mobile-disconnect-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;flex-direction:column;color:#fff;text-align:center;padding:2rem;';

  overlay.innerHTML = '<h3>⚠️ Mobile Camera Disconnected</h3>' +
    '<p>Please reconnect your phone camera.<br>The exam will resume automatically.</p>' +
    '<div style="font-size:3rem;font-weight:bold;" id="grace-countdown">' + mobileGracePeriodSeconds + '</div>' +
    '<p style="color:#aaa;">seconds remaining</p>';
  document.body.appendChild(overlay);

  var remaining = mobileGracePeriodSeconds;
  mobileGracePeriodTimer = setInterval(function() {
    remaining--;
    var el = document.getElementById('grace-countdown');
    if (el) el.textContent = remaining;
    if (remaining <= 0) {
      clearInterval(mobileGracePeriodTimer);
      if (typeof submitExam === 'function') submitExam('Terminated');
    }
  }, 1000);
}

function hideMobileDisconnectOverlay() {
  var overlay = document.getElementById('mobile-disconnect-overlay');
  if (overlay) overlay.remove();
  if (mobileGracePeriodTimer) {
    clearInterval(mobileGracePeriodTimer);
    mobileGracePeriodTimer = null;
  }
}
