/**
 * ViolationSnapshotManager
 *
 * Captures webcam + REAL FULL SCREEN snapshots on exam violations.
 *
 * Screen capture uses the browser's getDisplayMedia API — the same one used
 * by screen recorders. This captures EVERYTHING on the screen: other browser
 * tabs, other applications, the desktop — exactly what the candidate sees.
 *
 * HOW IT WORKS:
 *   1. Call requestScreenCapture() once when the exam starts (must be called
 *      from a user-gesture, e.g. the "Start Exam" button click).
 *   2. The browser shows a one-time "Share your screen" dialog. The candidate
 *      must pick "Entire Screen" for full coverage.
 *   3. After that, every violation silently grabs a frame from that live
 *      stream — no further prompts needed.
 *
 * IMPORTANT: requestScreenCapture() MUST be called inside a click handler
 * (user gesture). It will silently fail if called outside one.
 */

class ViolationSnapshotManager {
  /**
   * @param {Object}   options
   * @param {string}   options.examSubmission        Frappe Exam Submission doc name (required)
   * @param {string}  [options.webcamElementId]      ID of the <video> element (default: 'webcam-stream')
   * @param {number}  [options.cooldownMs]           Min ms between captures per violation type (default: 5000)
   * @param {Function}[options.onScreenShareGranted] Called when screen share permission is granted
   * @param {Function}[options.onScreenShareDenied]  Called when screen share permission is denied/cancelled
   * @param {Function}[options.onSnapshotCaptured]   Called after successful upload: (violationType, urls)
   * @param {Function}[options.onSnapshotError]      Called on failure: (violationType, error)
   */
  constructor(options = {}) {
    if (!options.examSubmission) {
      throw new Error('[ViolationSnapshot] examSubmission is required.');
    }

    this.options = {
      webcamElementId:      'webcam-stream',
      cooldownMs:           3000,
      onScreenShareGranted: null,
      onScreenShareDenied:  null,
      onSnapshotCaptured:   null,
      onSnapshotError:      null,
      ...options,
    };

    // The MediaStream from getDisplayMedia — held open for the exam duration
    this._screenStream = null;

    // Hidden <video> element used to read frames from the screen stream
    this._screenVideo = null;

    // Per-violation-type last capture timestamp for cooldown enforcement
    this._lastCaptureTime = {};
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Request screen share permission from the browser.
   *
   * MUST be called inside a user-gesture handler (button click).
   * Shows the browser's native "Choose what to share" dialog.
   * Guide the candidate to select "Entire Screen" for full coverage.
   *
   * @returns {Promise<boolean>} true if permission granted, false if denied
   */
  async requestScreenCapture() {
    if (!navigator.mediaDevices) {
      console.warn('[ViolationSnapshot] navigator.mediaDevices unavailable. Screen capture disabled.');
      return false;
    }

    // ── API availability gate (check this FIRST) ─────────────────────────────
    // Use optional chaining so a null navigator.mediaDevices doesn't throw.
    // We check the API directly rather than relying on window.isSecureContext
    // because isSecureContext is misleading on Android Chrome:
    //   http://localhost → isSecureContext = TRUE (W3C exception) but Android
    //   Chrome still does NOT expose getDisplayMedia on http:// URLs.
    // Checking location.protocol gives the ground truth.
    if (typeof navigator.mediaDevices?.getDisplayMedia !== 'function') {
      const isHttp = location.protocol !== 'https:';
      const isFirefox = /firefox|fxios/i.test(navigator.userAgent);
      const isWebView = /android/i.test(navigator.userAgent) && /wv\b/i.test(navigator.userAgent);

      let reason = 'getDisplayMedia is not available.';
      if (isFirefox)      reason = 'Firefox does not support getDisplayMedia on Android.';
      else if (isWebView) reason = 'Android WebView does not support getDisplayMedia.';
      else if (isHttp)    reason = 'getDisplayMedia requires HTTPS (current protocol: ' + location.protocol + '). ' +
                                   'Note: http://localhost reports isSecureContext=true but Android Chrome ' +
                                   'still requires https:// for screen capture.';

      const err = new TypeError('[ViolationSnapshot] ' + reason);
      err.name = isHttp ? 'InsecureContextError' : 'NotSupportedError';
      console.warn('[ViolationSnapshot]', reason,
        '| protocol:', location.protocol,
        '| isSecureContext:', window.isSecureContext,
        '| ua:', navigator.userAgent);
      if (this.options.onScreenShareDenied) this.options.onScreenShareDenied(err);
      return false;
    }

    try {
      // On Android Chrome the screen is portrait (~1080×2400).
      // Passing landscape-fixed width/height ideals (1920×1080) can cause the
      // stream to be delivered at unexpected dimensions or be rejected entirely.
      // Detect mobile and omit fixed size constraints so the browser picks the
      // native screen resolution.
      const isMobile = /android|iphone|ipad|ipod/i.test(navigator.userAgent);

      // ── CRITICAL: do NOT use displaySurface: 'monitor' (bare string) ──────────
      // A bare string value in a MediaTrackConstraints dict is treated as an
      // *exact/required* constraint. On Android Chrome the runtime cannot guarantee
      // a 'monitor' surface BEFORE the picker dialog opens (the OS permission is
      // resolved inside the dialog), so Chrome throws OverconstrainedError or
      // NotSupportedError immediately — the picker never appears.
      //
      // Solution: use { ideal: 'monitor' } — a preference/hint that tells Chrome
      // to show the "Screen" option first, but falls back gracefully to whatever
      // surfaces are available rather than failing hard.
      this._screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: isMobile ? {
          displaySurface: { ideal: 'monitor' },
          frameRate:      { ideal: 10 },
        } : {
          displaySurface: { ideal: 'monitor' },
          width:          { ideal: 1920 },
          height:         { ideal: 1080 },
          frameRate:      { ideal: 15 },
        },
        audio: false,
      });

      // Build a hidden <video> that stays connected to the stream.
      // Capturing a frame later is then just canvas.drawImage(this._screenVideo).
      this._screenVideo = document.createElement('video');
      this._screenVideo.srcObject   = this._screenStream;
      this._screenVideo.muted       = true;
      this._screenVideo.playsInline = true;
      this._screenVideo.autoplay    = true;
      // Keep it in the DOM but completely invisible.
      // NOTE: do NOT use 1×1px — Chrome on Android aborts play() on elements
      // it considers "too small to be meaningful". 4×4px avoids that heuristic
      // while remaining visually invisible.
      this._screenVideo.style.cssText =
        'position:fixed;top:-9999px;left:-9999px;width:4px;height:4px;opacity:0;pointer-events:none;';
      document.body.appendChild(this._screenVideo);

      // ── CRITICAL: do NOT await play() inside the try/catch ──────────────────
      // On Android Chrome, returning from the native OS screen-picker can cause
      // play() to throw AbortError even though the stream is perfectly valid.
      // If play() failure were inside the outer try/catch it would call
      // _teardownScreenStream() and destroy the stream we just obtained.
      // Instead: fire-and-forget. autoplay=true handles actual playback;
      // we only log the error and never let it kill the stream.
      this._screenVideo.play().catch(err => {
        console.warn('[ViolationSnapshot] play() non-fatal (autoplay will handle it):', err.name, err.message);
      });

      // If the candidate stops sharing manually (clicks "Stop sharing"), clean up
      this._screenStream.getVideoTracks()[0].addEventListener('ended', () => {
        console.warn('[ViolationSnapshot] Screen share stopped by candidate.');
        this._teardownScreenStream();
      });

      console.log('[ViolationSnapshot] Screen share granted — full screen capture active.');
      if (this.options.onScreenShareGranted) this.options.onScreenShareGranted();
      return true;

    } catch (err) {
      // Known error names and what they mean:
      //   NotAllowedError        — user cancelled the picker dialog
      //   NotSupportedError      — browser/OS doesn't support the requested capture
      //   OverconstrainedError   — a hard constraint (e.g. exact displaySurface) can't be met
      //   InvalidStateError      — called outside a secure context or wrong document state
      //   TypeError              — getDisplayMedia not a function (shouldn't reach here after pre-flight)
      //   AbortError             — OS aborted the request (e.g. another app grabbed the projection token)
      console.warn(
        '[ViolationSnapshot] getDisplayMedia failed.',
        'name:', err.name,
        '| message:', err.message,
        '| constraint:', err.constraint || '(none)',
        '| protocol:', location.protocol,
        '| ua:', navigator.userAgent
      );
      this._teardownScreenStream();
      if (this.options.onScreenShareDenied) this.options.onScreenShareDenied(err);
      return false;
    }
  }

  /**
   * Returns true if a live screen share stream is active and capturable.
   */
  isScreenShareActive() {
    return (
      this._screenStream !== null &&
      this._screenStream.active &&
      this._screenStream.getVideoTracks().length > 0 &&
      this._screenStream.getVideoTracks()[0].readyState === 'live'
    );
  }

  /**
   * Capture webcam + full screen for a violation and upload to backend.
   *
   * @param {string} violationType  'tabchange' | 'multiplefaces' | 'noface' |
   *                                'gazeaway'  | 'monitorchange' | 'appswitch'
   * @param {string} [description]  Human-readable detail shown to the proctor
   * @param {Object} [opts]
   * @param {number} [opts.screenDelay=0]  ms to wait before capturing the screen frame.
   *   Pass ~200 for tab-switch violations so the screen stream has time to update
   *   and show the switched-to app rather than the exam tab.
   */
  capture(violationType, description = '', opts = {}) {
    if (!this._canCapture(violationType)) {
      console.log(`[ViolationSnapshot] Cooldown active for "${violationType}", skipping.`);
      return;
    }

    // Always grab webcam synchronously RIGHT NOW — reflects the exact violation moment.
    // This is the INSTANT anchor: even when the "screen" frame resolves slightly
    // later (mobile window render), this front-camera frame is taken with zero
    // delay and zero polling — exactly at the moment the violation fired.
    const webcamSnapshot = this._captureWebcamSync();
    this._lastCaptureTime[violationType] = Date.now();

    // Background upload helper — fired once the screen/window frame is ready.
    const finishUpload = (screenSnapshot) => {
      if (!webcamSnapshot && !screenSnapshot) {
        console.warn('[ViolationSnapshot] Both snapshots null, nothing to upload.');
        return;
      }
      this._upload(violationType, description, webcamSnapshot, screenSnapshot)
        .then((result) => {
          if (result && this.options.onSnapshotCaptured) {
            this.options.onSnapshotCaptured(violationType, result.snapshot_urls || {});
          }
        })
        .catch((err) => {
          console.error(`[ViolationSnapshot] Upload failed for "${violationType}":`, err);
          if (this.options.onSnapshotError) this.options.onSnapshotError(violationType, err);
        });
    };

    if (this.isScreenShareActive()) {
      // ── Desktop path ──────────────────────────────────────────────────────
      // A live getDisplayMedia stream exists — grab a frame from it. The optional
      // screenDelay lets the OS paint the switched-to app before we capture.
      const screenDelay = opts.screenDelay || 0;
      const grab = () => finishUpload(this._captureScreenSync());
      if (screenDelay > 0) setTimeout(grab, screenDelay);
      else grab();

    } else if (this._canCaptureWindow()) {
      // ── Mobile path ───────────────────────────────────────────────────────
      // Mobile browsers cannot capture the OS screen (getDisplayMedia is absent),
      // so we render the EXAM BROWSER WINDOW (the visible viewport) to an image
      // with html2canvas. This is async; the webcam frame above already froze the
      // violation instant, so the moment is preserved even though this resolves a
      // few hundred ms later. The rendered exam window is what the candidate sees.
      this._captureWindowAsync()
        .then((windowSnapshot) => finishUpload(windowSnapshot))
        .catch((err) => {
          console.warn('[ViolationSnapshot] Window capture failed, uploading webcam only:', err);
          finishUpload(null);
        });

    } else {
      // No screen capture available at all → webcam-only upload.
      finishUpload(null);
    }
  }

  /**
   * Stop the screen share stream and remove the hidden video element.
   * Call this when the exam ends.
   */
  destroy() {
    this._teardownScreenStream();
  }

  resetCooldown(violationType) {
    delete this._lastCaptureTime[violationType];
  }

  resetAllCooldowns() {
    this._lastCaptureTime = {};
  }

  _fitSize(width, height, maxWidth, maxHeight) {
    const ratio = Math.min(maxWidth / width, maxHeight / height, 1);
    return {
      width:  Math.max(1, Math.round(width * ratio)),
      height: Math.max(1, Math.round(height * ratio)),
    };
  }

  // ---------------------------------------------------------------------------
  // Private: capture helpers
  // ---------------------------------------------------------------------------

  /**
   * Synchronously capture a JPEG frame from the webcam video element.
   * Called at violation time so the frame is from the exact moment.
   */
  _captureWebcamSync() {
    const video = document.getElementById(this.options.webcamElementId);
    if (!video || video.readyState < 2) return null;

    try {
      const size = this._fitSize(video.videoWidth || 640, video.videoHeight || 480, 640, 480);
      const canvas = document.createElement('canvas');
      canvas.width  = size.width;
      canvas.height = size.height;

      const ctx = canvas.getContext('2d');
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      return canvas.toDataURL('image/jpeg', 0.65);
    } catch (err) {
      console.error('[ViolationSnapshot] Webcam capture error:', err);
      return null;
    }
  }

  /**
   * Synchronously capture the current screen frame from the display media stream.
   * Because we run at 15 fps the frame is at most ~67 ms old — effectively instant.
   */
  _captureScreenSync() {
    if (!this.isScreenShareActive() || !this._screenVideo || this._screenVideo.readyState < 2) {
      return null;
    }

    try {
      const size = this._fitSize(
        this._screenVideo.videoWidth  || 1920,
        this._screenVideo.videoHeight || 1080,
        1280,
        720
      );
      const canvas = document.createElement('canvas');
      canvas.width  = size.width;
      canvas.height = size.height;

      canvas.getContext('2d').drawImage(this._screenVideo, 0, 0, canvas.width, canvas.height);

      return canvas.toDataURL('image/jpeg', 0.55);
    } catch (err) {
      console.error('[ViolationSnapshot] Screen capture error:', err);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: mobile browser-window capture (html2canvas)
  // ---------------------------------------------------------------------------

  /**
   * True when the html2canvas library is loaded and we can render the exam
   * browser window to an image. Used as the mobile fallback for the "screen"
   * snapshot, since getDisplayMedia is unavailable on every mobile browser.
   */
  _canCaptureWindow() {
    return typeof window !== 'undefined' && typeof window.html2canvas === 'function';
  }

  /**
   * Render the visible exam browser window (the current viewport) to a JPEG.
   *
   * This is the mobile equivalent of a "screen" snapshot: a browser cannot see
   * outside its own window on a phone, so we capture exactly what is rendered in
   * the exam tab — the questions, options, timer and any in-page state — at the
   * violation moment.
   *
   * @returns {Promise<string|null>} JPEG data URL, or null on failure.
   */
  async _captureWindowAsync() {
    if (!this._canCaptureWindow()) return null;

    try {
      const vw = window.innerWidth  || document.documentElement.clientWidth  || 360;
      const vh = window.innerHeight || document.documentElement.clientHeight || 640;

      // Downscale so the longest side is ~1280px — keeps the upload small while
      // staying legible. scale < 1 renders the DOM at a lower resolution.
      const scale = Math.min(1, 1280 / Math.max(vw, vh));

      const canvas = await window.html2canvas(document.documentElement, {
        x:               window.scrollX,
        y:               window.scrollY,
        width:           vw,
        height:          vh,
        scale:           scale,
        logging:         false,
        useCORS:         true,
        backgroundColor: '#ffffff',
        // Skip elements we never want in the shot (hidden capture helpers, overlays).
        ignoreElements:  (el) => el.hasAttribute && el.hasAttribute('data-vs-ignore'),
      });

      return canvas.toDataURL('image/jpeg', 0.6);
    } catch (err) {
      console.error('[ViolationSnapshot] Window capture (html2canvas) error:', err);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: upload
  // ---------------------------------------------------------------------------

  async _upload(violationType, description, webcamSnapshot, screenSnapshot) {
    const uploadOnce = (payload) => new Promise((resolve, reject) => {
      frappe.call({
        method: 'exampro.exam_pro.doctype.exam_submission.exam_submission.save_violation_snapshot',
        type: 'POST',
        args: {
          exam_submission: this.options.examSubmission,
          violation_type:  violationType,
          description:     description,
          webcam_snapshot: payload.webcamSnapshot || '',
          screen_snapshot: payload.screenSnapshot || '',
        },
        error:    (err) => { console.error('[ViolationSnapshot] Upload error:', err); reject(err); },
        callback: (r)   => { resolve(r && r.message ? r.message : null); },
      });
    });

    try {
      return await uploadOnce({ webcamSnapshot, screenSnapshot });
    } catch (err) {
      if (!webcamSnapshot || !screenSnapshot) throw err;

      console.warn('[ViolationSnapshot] Combined upload failed; retrying webcam and screen separately.', err);
      const [webcamResult, screenResult] = await Promise.allSettled([
        uploadOnce({ webcamSnapshot, screenSnapshot: '' }),
        uploadOnce({ webcamSnapshot: '', screenSnapshot }),
      ]);

      if (webcamResult.status === 'rejected' && screenResult.status === 'rejected') {
        throw err;
      }

      return {
        status: 'success',
        snapshot_urls: {
          ...(webcamResult.status === 'fulfilled' && webcamResult.value ? webcamResult.value.snapshot_urls : {}),
          ...(screenResult.status === 'fulfilled' && screenResult.value ? screenResult.value.snapshot_urls : {}),
        },
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Private: cleanup
  // ---------------------------------------------------------------------------

  _teardownScreenStream() {
    if (this._screenStream) {
      this._screenStream.getTracks().forEach(t => t.stop());
      this._screenStream = null;
    }
    if (this._screenVideo) {
      this._screenVideo.srcObject = null;
      if (this._screenVideo.parentNode) {
        this._screenVideo.parentNode.removeChild(this._screenVideo);
      }
      this._screenVideo = null;
    }
  }

  _canCapture(violationType) {
    const last = this._lastCaptureTime[violationType] || 0;
    return Date.now() - last >= this.options.cooldownMs;
  }
}

if (typeof window !== 'undefined') {
  window.ViolationSnapshotManager = ViolationSnapshotManager;
}
