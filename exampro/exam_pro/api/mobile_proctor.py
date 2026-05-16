# exampro/exam_pro/api/mobile_proctor.py
import base64
import uuid
from datetime import datetime, timedelta

import frappe
from frappe import _

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

DISCONNECT_TIMEOUT_SECONDS = 5
VIOLATION_COOLDOWN_SECONDS = 3


def _get_submission_by_token(token, allow_submitted=False):
    """Return Exam Submission name for a valid token, or raise."""
    if not token:
        frappe.throw(_("Missing session token."), frappe.AuthenticationError)

    result = frappe.db.get_value(
        "Exam Submission",
        {"mobile_session_token": token},
        ["name", "status"],
        as_dict=True,
    )
    if not result:
        frappe.throw(_("Invalid or expired session token."), frappe.AuthenticationError)

    allowed = ("Registered", "Started")
    if allow_submitted:
        allowed = ("Registered", "Started", "Submitted")

    if result.status not in allowed:
        frappe.throw(_("Invalid or expired session token."), frappe.AuthenticationError)

    return result.name, result.status


def _get_s3_client_and_bucket():
    """Reuse existing S3 setup from exam_submission module."""
    from exampro.exam_pro.doctype.exam_submission.exam_submission import get_s3_client

    settings = frappe.get_single("Exam Settings")
    return get_s3_client(), settings.s3_bucket


def _upload_mobile_snapshot(exam_submission, base64_data, violation_type, ts):
    """Upload JPEG to S3 and return the object key (not presigned URL)."""
    from exampro.exam_pro.doctype.exam_submission.exam_submission import (
        _upload_base64_snapshot,
    )

    s3_client, bucket = _get_s3_client_and_bucket()
    suffix = f"violations/{violation_type}_{ts}_mobile.jpg"
    _upload_base64_snapshot(s3_client, bucket, exam_submission, base64_data, suffix)
    return f"{exam_submission}/{suffix}"


def _insert_violation(exam_submission, candidate, violation_type, mobile_key):
    """Insert an Exam Messages record for a mobile camera violation."""
    labels = {
        "mobile_noface": "Mobile camera: No face detected",
        "mobile_multiplefaces": "Mobile camera: Multiple faces detected",
        "mobile_disconnect": "Mobile camera: Disconnected",
        "mobile_device_detected": "Mobile camera: Another device visible",
    }
    frappe.get_doc(
        {
            "doctype": "Exam Messages",
            "exam_submission": exam_submission,
            "timestamp": frappe.utils.now(),
            "from": "System",
            "from_user": candidate,
            "message": labels.get(violation_type, violation_type),
            "type_of_message": "Warning",
            "warning_type": violation_type,
            "mobile_snapshot_key": mobile_key,
        }
    ).insert(ignore_permissions=True)
    frappe.db.commit()


_FACE_DETECTOR = None  # cached across calls within one worker process
_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_detector/"
    "blaze_face_short_range/float16/latest/blaze_face_short_range.tflite"
)


def _get_model_path():
    """Return a persistent path for the MediaPipe model inside the bench sites dir."""
    import os
    models_dir = os.path.join(frappe.utils.get_bench_path(), "sites", "mediapipe_models")
    os.makedirs(models_dir, exist_ok=True)
    return os.path.join(models_dir, "blaze_face_short_range.tflite")


def _get_face_detector():
    """Return a cached mediapipe FaceDetector (Tasks API, mediapipe 0.10+)."""
    global _FACE_DETECTOR
    if _FACE_DETECTOR is not None:
        return _FACE_DETECTOR

    import os
    import urllib.request
    import mediapipe as mp
    from mediapipe.tasks.python import vision as mp_vision
    from mediapipe.tasks.python.core import base_options as mp_base

    model_path = _get_model_path()
    if not os.path.exists(model_path):
        try:
            urllib.request.urlretrieve(_MODEL_URL, model_path)
        except Exception as e:
            frappe.log_error(
                f"Failed to download MediaPipe face detection model from {_MODEL_URL}\n"
                f"Error: {e}\n"
                "Fix: ensure the bench server has internet access, or manually place the "
                f".tflite file at {model_path}",
                "Mobile Proctor: Model Download Failed",
            )
            raise

    options = mp_vision.FaceDetectorOptions(
        base_options=mp_base.BaseOptions(model_asset_path=model_path),
        min_detection_confidence=0.5,
        running_mode=mp_vision.RunningMode.IMAGE,
    )
    _FACE_DETECTOR = mp_vision.FaceDetector.create_from_options(options)
    return _FACE_DETECTOR


def _analyze_frame(jpeg_bytes):
    """
    Run face detection on a JPEG frame using mediapipe 0.10+ Tasks API.
    Returns 'mobile_noface', 'mobile_multiplefaces', or None (no violation).
    """
    import cv2
    import numpy as np
    import mediapipe as mp

    img = cv2.imdecode(np.frombuffer(jpeg_bytes, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        return None

    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    detector = _get_face_detector()
    mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
    result = detector.detect(mp_img)
    face_count = len(result.detections) if result.detections else 0

    if face_count == 0:
        return "mobile_noface"
    if face_count > 1:
        return "mobile_multiplefaces"
    return None


def _should_log_violation(exam_submission, violation_type):
    """
    Enforce 3-second cooldown: return True only if the same violation
    was not already logged in the last VIOLATION_COOLDOWN_SECONDS seconds.
    """
    cutoff = frappe.utils.add_to_date(
        frappe.utils.now_datetime(), seconds=-VIOLATION_COOLDOWN_SECONDS
    )
    recent = frappe.db.count(
        "Exam Messages",
        filters={
            "exam_submission": exam_submission,
            "warning_type": violation_type,
            "timestamp": [">", cutoff],
        },
    )
    return recent == 0


# ---------------------------------------------------------------------------
# Public API endpoints
# ---------------------------------------------------------------------------


@frappe.whitelist(allow_guest=True)
def validate_mobile_token(token):
    """
    Called by mobile page on load to confirm the token is valid.
    Returns exam_submission name and exam title.
    """
    name, _status = _get_submission_by_token(token)
    exam = frappe.db.get_value("Exam Submission", name, "exam")
    exam_title = frappe.db.get_value("Exam", exam, "title")
    return {"valid": True, "exam_submission": name, "exam_title": exam_title}


@frappe.whitelist(allow_guest=True)
def receive_frame(token, frame_data):
    """
    Called every 1 second by mobile page.
    Validates token, runs MediaPipe, logs violations, updates heartbeat.
    """
    name, status = _get_submission_by_token(token, allow_submitted=True)

    # Exam already submitted — tell mobile to stop streaming
    if status == "Submitted":
        return {"status": "exam_ended"}

    # Update heartbeat and mark Connected
    frappe.db.set_value(
        "Exam Submission",
        name,
        {
            "mobile_last_seen": frappe.utils.now_datetime(),
            "mobile_camera_status": "Connected",
        },
        update_modified=False,
    )
    frappe.db.commit()

    # Decode frame
    try:
        if "," in frame_data:
            frame_data = frame_data.split(",", 1)[1]
        jpeg_bytes = base64.b64decode(frame_data)
    except Exception:
        return {"status": "ok", "violation": None}

    # Run AI analysis (silently skip if mediapipe/cv2 not installed)
    try:
        violation = _analyze_frame(jpeg_bytes)
    except ImportError as e:
        # Only log once — this fires every second otherwise
        frappe.log_error(
            f"MediaPipe/cv2 not installed on server — face detection disabled.\n{e}\n"
            "Install with: pip install mediapipe opencv-python-headless",
            "Mobile Proctor: Missing Dependencies",
        )
        violation = None
    except Exception as e:
        frappe.log_error(frappe.get_traceback(), "Mobile Proctor: _analyze_frame Error")
        violation = None

    if violation and _should_log_violation(name, violation):
        candidate = frappe.db.get_value("Exam Submission", name, "candidate")
        ts = datetime.utcnow().strftime("%Y%m%d_%H%M%S_%f")
        try:
            mobile_key = _upload_mobile_snapshot(name, frame_data, violation, ts)
        except Exception:
            frappe.log_error(
                frappe.get_traceback(),
                "Mobile Proctor: S3 Snapshot Upload Failed",
            )
            mobile_key = None
        _insert_violation(name, candidate, violation, mobile_key)

    return {"status": "ok", "violation": violation}


@frappe.whitelist()
def get_mobile_status(exam_submission):
    """
    Called by exam page every 3s to check mobile camera status.
    Also returns grace_period so exam page knows the countdown duration.
    """
    doc = frappe.db.get_value(
        "Exam Submission",
        exam_submission,
        ["mobile_camera_status", "exam"],
        as_dict=True,
    )
    grace_period = frappe.db.get_value("Exam", doc.exam, "mobile_grace_period") or 60
    return {
        "status": doc.mobile_camera_status,
        "grace_period": grace_period,
    }


@frappe.whitelist()
def generate_mobile_token(exam_submission):
    """
    Called when exam page loads (if mobile proctoring enabled).
    Generates a fresh UUID token, stores it, returns the full QR URL.
    """
    candidate = frappe.db.get_value("Exam Submission", exam_submission, "candidate")
    if frappe.session.user != candidate:
        frappe.throw(_("Permission denied."), frappe.PermissionError)

    token = uuid.uuid4().hex
    frappe.db.set_value(
        "Exam Submission",
        exam_submission,
        {
            "mobile_session_token": token,
            "mobile_camera_status": "Pending",
        },
        update_modified=False,
    )
    frappe.db.commit()

    # Prefer the explicitly configured host_name so QR codes don't include
    # the local dev port (e.g. :8000). frappe.utils.get_url() uses the
    # incoming request's Host header, which is localhost:8000 when accessed
    # locally — unusable when scanned on a phone.
    site_url = frappe.conf.get("host_name") or frappe.utils.get_url()
    qr_url = f"{site_url}/mobile-proctor?token={token}"
    return {"token": token, "qr_url": qr_url}


# ---------------------------------------------------------------------------
# Scheduler job — runs every ~60 seconds via "all" hook
# ---------------------------------------------------------------------------


def check_mobile_heartbeats():
    """
    Detect disconnected mobile cameras.
    Marks Exam Submissions as Disconnected if no frame received in 5s.
    """
    cutoff = frappe.utils.add_to_date(
        frappe.utils.now_datetime(), seconds=-DISCONNECT_TIMEOUT_SECONDS
    )

    stale = frappe.db.get_all(
        "Exam Submission",
        filters={
            "mobile_camera_status": "Connected",
            "mobile_last_seen": ["<", cutoff],
            "status": "Started",
        },
        fields=["name", "candidate"],
    )

    for row in stale:
        frappe.db.set_value(
            "Exam Submission",
            row.name,
            "mobile_camera_status",
            "Disconnected",
            update_modified=False,
        )
        _insert_violation(row.name, row.candidate, "mobile_disconnect", None)

    if stale:
        frappe.db.commit()


# ---------------------------------------------------------------------------
# Debug helper (remove after debugging)
# ---------------------------------------------------------------------------

def debug_mobile_status():
    """Run via: bench --site <site> execute exampro.exam_pro.api.mobile_proctor.debug_mobile_status"""

    # 1. Mobile violation messages
    msgs = frappe.db.sql("""
        SELECT name, warning_type, mobile_snapshot_key, creation
        FROM `tabExam Messages`
        WHERE warning_type LIKE 'mobile%%'
        ORDER BY creation DESC LIMIT 10
    """, as_dict=True)
    print(f"\n=== Mobile Violations in DB: {len(msgs)} ===")
    for m in msgs:
        print(f"  {m.creation} | {m.warning_type} | key={m.mobile_snapshot_key}")

    # 2. Check columns exist
    snap_col = frappe.db.sql("SHOW COLUMNS FROM `tabExam Messages` LIKE 'mobile_snapshot_key'")
    sub_cols = frappe.db.sql(
        "SHOW COLUMNS FROM `tabExam Submission` WHERE Field IN "
        "('mobile_session_token','mobile_camera_status','mobile_last_seen')"
    )
    print(f"\n=== Schema: mobile_snapshot_key exists={bool(snap_col)}, "
          f"submission cols={[c[0] for c in sub_cols]} ===")

    # 3. Recent submissions with mobile data
    subs = frappe.db.sql("""
        SELECT name, status, mobile_camera_status, mobile_last_seen
        FROM `tabExam Submission`
        WHERE mobile_camera_status IS NOT NULL AND mobile_camera_status != ''
        ORDER BY modified DESC LIMIT 5
    """, as_dict=True)
    print(f"\n=== Recent Submissions with Mobile Data ===")
    for s in subs:
        print(f"  {s.name} | status={s.status} | cam={s.mobile_camera_status} | last_seen={s.mobile_last_seen}")

    # 4. Test mediapipe (Tasks API — 0.10+)
    print("\n=== MediaPipe Test ===")
    try:
        import cv2
        import mediapipe as mp
        import numpy as np
        print(f"  cv2={cv2.__version__}, mediapipe={mp.__version__}")
        import os
        model_path = _get_model_path()
        print(f"  model file path={model_path}, exists={os.path.exists(model_path)}")
        # Force re-create detector to test end-to-end
        global _FACE_DETECTOR
        _FACE_DETECTOR = None
        det = _get_face_detector()
        black = np.zeros((100, 100, 3), dtype=np.uint8)
        mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=black)
        res = det.detect(mp_img)
        fc = len(res.detections) if res.detections else 0
        print(f"  Black image face count={fc} (expected 0) — MediaPipe Tasks API working OK")
    except Exception as e:
        print(f"  ERROR: {e}")

    # 5. S3 config
    print("\n=== S3 Config ===")
    try:
        settings = frappe.get_single("Exam Settings")
        print(f"  bucket={settings.s3_bucket}")
        has_key = bool(getattr(settings, 'aws_key', None))
        print(f"  has_access_key={has_key}")
        s3 = get_s3_client_for_debug()
        if s3:
            print("  S3 client created OK")
    except Exception as e:
        print(f"  S3 ERROR: {e}")


def get_s3_client_for_debug():
    from exampro.exam_pro.doctype.exam_submission.exam_submission import get_s3_client
    try:
        return get_s3_client()
    except Exception as e:
        print(f"  get_s3_client failed: {e}")
        return None
