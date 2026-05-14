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


def _get_submission_by_token(token):
    """Return Exam Submission name for a valid token, or raise."""
    if not token:
        frappe.throw(_("Missing session token."), frappe.AuthenticationError)

    name = frappe.db.get_value(
        "Exam Submission",
        {"mobile_session_token": token, "status": "Started"},
        "name",
    )
    if not name:
        frappe.throw(_("Invalid or expired session token."), frappe.AuthenticationError)
    return name


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
    suffix = f"mobile_violations/{violation_type}_{ts}.jpg"
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


def _analyze_frame(jpeg_bytes):
    """
    Run MediaPipe face detection on a JPEG frame.
    Returns violation type string or None if no violation.
    """
    import cv2
    import mediapipe as mp
    import numpy as np

    mp_face = mp.solutions.face_detection

    img = cv2.imdecode(np.frombuffer(jpeg_bytes, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        return None

    with mp_face.FaceDetection(model_selection=0, min_detection_confidence=0.5) as detector:
        results = detector.process(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))

    face_count = len(results.detections) if results.detections else 0

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
    name = _get_submission_by_token(token)
    exam = frappe.db.get_value("Exam Submission", name, "exam")
    exam_title = frappe.db.get_value("Exam", exam, "title")
    return {"valid": True, "exam_submission": name, "exam_title": exam_title}


@frappe.whitelist(allow_guest=True)
def receive_frame(token, frame_data):
    """
    Called every 1 second by mobile page.
    Validates token, runs MediaPipe, logs violations, updates heartbeat.
    """
    name = _get_submission_by_token(token)

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

    # Run AI analysis
    violation = _analyze_frame(jpeg_bytes)

    if violation and _should_log_violation(name, violation):
        candidate = frappe.db.get_value("Exam Submission", name, "candidate")
        ts = datetime.utcnow().strftime("%Y%m%d_%H%M%S_%f")
        try:
            mobile_key = _upload_mobile_snapshot(name, frame_data, violation, ts)
        except Exception:
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

    site_url = frappe.utils.get_url()
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
