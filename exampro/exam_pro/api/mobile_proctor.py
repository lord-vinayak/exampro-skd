# exampro/exam_pro/api/mobile_proctor.py
"""
Mobile camera proctoring — frame collection only.

During the exam the mobile page sends one JPEG frame every 10 seconds.
This module stores each frame to S3 and updates the heartbeat.
No real-time AI analysis is performed here; that runs post-exam via
exampro.exam_pro.api.mobile_analysis.
"""
import base64
import uuid
import io
from datetime import datetime

import frappe
from frappe import _

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DISCONNECT_TIMEOUT_SECONDS = 15   # mark Disconnected if no frame for 15s
FRAME_PREFIX = "mobile_frames"     # S3 sub-folder inside submission prefix


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_submission_by_token(token, allow_submitted=False):
    """Return (name, status) for a valid token, or raise."""
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


def _store_frame_to_s3(exam_submission, base64_data, frame_seq):
    """Upload a single mobile frame to S3. Returns S3 key or None on failure."""
    from exampro.exam_pro.doctype.exam_submission.exam_submission import get_s3_client

    try:
        settings = frappe.get_single("Exam Settings")
        s3_client = get_s3_client()

        if "," in base64_data:
            base64_data = base64_data.split(",", 1)[1]

        image_bytes = base64.b64decode(base64_data)
        ts = datetime.utcnow().strftime("%Y%m%d_%H%M%S_%f")
        key = f"{exam_submission}/{FRAME_PREFIX}/{frame_seq:06d}_{ts}.jpg"

        s3_client.upload_fileobj(
            io.BytesIO(image_bytes),
            settings.s3_bucket,
            key,
            ExtraArgs={"ContentType": "image/jpeg"},
        )
        return key
    except Exception as e:
        frappe.log_error(
            f"Mobile frame upload failed — submission={exam_submission}, seq={frame_seq}: {e}",
            "Mobile Proctor: Frame Upload",
        )
        return None


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
def receive_frame(token, frame_data, frame_seq=0):
    """
    Called every 10 seconds by the mobile page.
    Stores the frame to S3, updates heartbeat. No AI analysis here.
    """
    name, status = _get_submission_by_token(token, allow_submitted=True)

    # Exam already submitted — tell mobile to stop streaming
    if status == "Submitted":
        return {"status": "exam_ended"}

    # Update heartbeat and mark Connected
    frame_seq = int(frame_seq or 0)
    current_count = frappe.db.get_value("Exam Submission", name, "mobile_frame_count") or 0

    frappe.db.set_value(
        "Exam Submission",
        name,
        {
            "mobile_last_seen": frappe.utils.now_datetime(),
            "mobile_camera_status": "Connected",
            "mobile_frame_count": current_count + 1,
        },
        update_modified=False,
    )
    frappe.db.commit()

    # Store frame to S3 (fire and forget — failure is logged but not fatal)
    if frame_data:
        _store_frame_to_s3(name, frame_data, frame_seq if frame_seq else current_count + 1)

    return {"status": "ok"}


@frappe.whitelist()
def get_mobile_status(exam_submission):
    """
    Called by exam page every 3s to check mobile camera status.
    Returns status and grace_period.
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
            "mobile_frame_count": 0,
        },
        update_modified=False,
    )
    frappe.db.commit()

    site_url = frappe.utils.get_url()
    qr_url = f"{site_url}/mobile-proctor?token={token}"
    return {"token": token, "qr_url": qr_url}


@frappe.whitelist(allow_guest=True)
def check_snapshot_request(token):
    """
    Polled by the mobile phone every 2 seconds.
    Returns whether an instant snapshot is needed and which violation to link it to.
    """
    name, _status = _get_submission_by_token(token)
    result = frappe.db.get_value(
        "Exam Submission",
        name,
        ["mobile_snapshot_requested", "mobile_snapshot_violation_ref"],
        as_dict=True,
    )
    return {
        "snapshot_requested": bool(result.mobile_snapshot_requested),
        "violation_ref": result.mobile_snapshot_violation_ref or "",
    }


@frappe.whitelist(allow_guest=True)
def receive_instant_snapshot(token, frame_data, violation_ref=""):
    """
    Called by mobile when check_snapshot_request returns snapshot_requested=true.
    Stores the frame to S3 and links it to the violation Exam Messages record.
    """
    name, _status = _get_submission_by_token(token)

    key = _store_instant_frame(name, frame_data, violation_ref)

    if key and violation_ref:
        try:
            frappe.db.set_value(
                "Exam Messages",
                violation_ref,
                "mobile_snapshot_key",
                key,
                update_modified=False,
            )
        except Exception as e:
            frappe.log_error(
                f"Failed to link instant snapshot to violation {violation_ref}: {e}",
                "Mobile Proctor: Instant Snapshot",
            )

    # Clear the pending request flag regardless of success
    frappe.db.set_value(
        "Exam Submission",
        name,
        {
            "mobile_snapshot_requested": 0,
            "mobile_snapshot_violation_ref": "",
        },
        update_modified=False,
    )
    frappe.db.commit()

    return {"status": "ok", "key": key or ""}


def _store_instant_frame(exam_submission, base64_data, violation_ref):
    """Store an instant (on-demand) mobile snapshot to S3."""
    from exampro.exam_pro.doctype.exam_submission.exam_submission import get_s3_client

    try:
        settings = frappe.get_single("Exam Settings")
        s3_client = get_s3_client()

        if "," in base64_data:
            base64_data = base64_data.split(",", 1)[1]

        image_bytes = base64.b64decode(base64_data)
        ts = datetime.utcnow().strftime("%Y%m%d_%H%M%S_%f")
        safe_ref = (violation_ref or "unknown").replace("/", "_")
        key = f"{exam_submission}/instant_snapshots/{safe_ref}_{ts}.jpg"

        s3_client.upload_fileobj(
            io.BytesIO(image_bytes),
            settings.s3_bucket,
            key,
            ExtraArgs={"ContentType": "image/jpeg"},
        )
        return key
    except Exception as e:
        frappe.log_error(
            f"Instant snapshot upload failed for {exam_submission}: {e}",
            "Mobile Proctor: Instant Snapshot",
        )
        return None


@frappe.whitelist(allow_guest=True)
def upload_room_scan(token):
    """
    Called after the candidate records the 15s room scan video.
    Expects the video file in request.files['file'].
    Stores to S3 as {submission}/room_scan.webm and saves the key.
    """
    name, status = _get_submission_by_token(token)

    if "file" not in frappe.request.files:
        frappe.throw(_("No file uploaded."))

    file = frappe.request.files["file"]
    if not file or file.filename == "":
        frappe.throw(_("No file uploaded."))

    try:
        from exampro.exam_pro.doctype.exam_submission.exam_submission import get_s3_client
        settings = frappe.get_single("Exam Settings")
        s3_client = get_s3_client()

        ext = file.filename.rsplit(".", 1)[-1].lower() if "." in file.filename else "webm"
        key = f"{name}/room_scan.{ext}"

        s3_client.upload_fileobj(
            file,
            settings.s3_bucket,
            key,
            ExtraArgs={"ContentType": file.content_type or "video/webm"},
        )

        frappe.db.set_value(
            "Exam Submission",
            name,
            "room_scan_key",
            key,
            update_modified=False,
        )
        frappe.db.commit()

        return {"status": "ok", "key": key}
    except Exception as e:
        frappe.log_error(frappe.get_traceback(), "Mobile Proctor: Room Scan Upload")
        frappe.throw(_("Room scan upload failed: {0}").format(str(e)))


# ---------------------------------------------------------------------------
# Scheduler job — runs every ~60 seconds via "all" hook
# ---------------------------------------------------------------------------

def check_mobile_heartbeats():
    """
    Detect disconnected mobile cameras.
    Marks Exam Submissions as Disconnected if no frame received within timeout.
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
        # Insert a disconnect warning message
        try:
            frappe.get_doc({
                "doctype": "Exam Messages",
                "exam_submission": row.name,
                "timestamp": frappe.utils.now(),
                "from": "System",
                "from_user": row.candidate,
                "message": "Mobile camera: Disconnected",
                "type_of_message": "Warning",
                "warning_type": "mobile_disconnect",
                "mobile_snapshot_key": None,
            }).insert(ignore_permissions=True)
        except Exception as e:
            frappe.log_error(
                f"Failed to insert disconnect warning for {row.name}: {e}",
                "Mobile Proctor: Heartbeat",
            )

    if stale:
        frappe.db.commit()
