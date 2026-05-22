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
    try {
      this._screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: 'monitor',   // hints browser to show "Entire Screen" first
          width:          { ideal: 1920 },
          height:         { ideal: 1080 },
          frameRate:      { ideal: 15 }, // higher fps = more timely snapshots
        },
        audio: false,
      });

      // Build a hidden <video> that stays connected to the stream.
      // Capturing a frame later is then just canvas.drawImage(this._screenVideo).
      this._screenVideo = document.createElement('video');
      this._screenVideo.srcObject   = this._screenStream;
      this._screenVideo.muted       = true;
      this._screenVideo.playsInline = true;
      // Keep it in the DOM but completely invisible
      this._screenVideo.style.cssText =
        'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;pointer-events:none;';
      document.body.appendChild(this._screenVideo);
      await this._screenVideo.play();

      // If the candidate stops sharing manually (clicks "Stop sharing"), clean up
      this._screenStream.getVideoTracks()[0].addEventListener('ended', () => {
        console.warn('[ViolationSnapshot] Screen share stopped by candidate.');
        this._teardownScreenStream();
      });

      console.log('[ViolationSnapshot] Screen share granted — full screen capture active.');
      if (this.options.onScreenShareGranted) this.options.onScreenShareGranted();
      return true;

    } catch (err) {
      // NotAllowedError = candidate clicked Cancel in the browser dialog
      console.warn('[ViolationSnapshot] Screen share denied or cancelled:', err.message);
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
    const webcamSnapshot = this._captureWebcamSync();
    this._lastCaptureTime[violationType] = Date.now();

    const screenDelay = opts.screenDelay || 0;

    const doUpload = () => {
      // Capture screen now (either immediately or after the delay).
      const screenSnapshot = this._captureScreenSync();

      if (!webcamSnapshot && !screenSnapshot) {
        console.warn('[ViolationSnapshot] Both snapshots null, nothing to upload.');
        return;
      }

      // Upload in the background — don't block the caller.
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

    if (screenDelay > 0) {
      setTimeout(doUpload, screenDelay);
    } else {
      doUpload();
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
